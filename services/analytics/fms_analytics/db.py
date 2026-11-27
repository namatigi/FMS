"""Database access: async read-only pool + start-up migration."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.numeric import FloatLoader
from psycopg_pool import AsyncConnectionPool

from .config import SERVICE_ROOT, Settings

log = logging.getLogger("fms_analytics.db")

MIGRATION_LOCK_KEY = 727_200


async def _configure(conn: psycopg.AsyncConnection[Any]) -> None:
    # NUMERIC -> float (analytics does not need Decimal precision; keeps JSON simple).
    conn.adapters.register_loader("numeric", FloatLoader)


class Database:
    """Read-only access to the FMS schema (DATABASE_URL_RO, falling back to DATABASE_URL)."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        options = f"-c default_transaction_read_only=on -c statement_timeout={settings.statement_timeout_ms}"
        self.pool: AsyncConnectionPool = AsyncConnectionPool(
            settings.database_url_ro,
            min_size=settings.db_pool_min,
            max_size=settings.db_pool_max,
            kwargs={"autocommit": True, "row_factory": dict_row, "options": options},
            configure=_configure,
            open=False,
            name="analytics-ro",
        )

    async def open(self) -> None:
        await self.pool.open(wait=False)

    async def close(self) -> None:
        await self.pool.close()

    async def fetch_all(self, sql: str, params: Sequence[Any] | dict[str, Any] | None = None) -> list[dict]:
        async with self.pool.connection() as conn, conn.cursor() as cur:
            await cur.execute(sql, params)
            return list(await cur.fetchall())

    async def fetch_one(self, sql: str, params: Sequence[Any] | dict[str, Any] | None = None) -> dict | None:
        rows = await self.fetch_all(sql, params)
        return rows[0] if rows else None

    async def ping(self, timeout_s: float = 2.0) -> bool:
        try:
            async with asyncio.timeout(timeout_s):
                row = await self.fetch_one("SELECT 1 AS ok")
            return bool(row and row["ok"] == 1)
        except Exception:  # noqa: BLE001
            return False


class ReadOnlyDB:
    """Read-only DB accessor handed to custom Python models.

    * ``await db.afetch_all(sql, params)`` from async model functions.
    * ``db.fetch_all(sql, params)`` from sync model functions (they run in a worker
      thread; the query is executed on the service event loop).
    Connections are in ``default_transaction_read_only`` mode, so writes fail.
    """

    def __init__(self, database: Database, loop: asyncio.AbstractEventLoop) -> None:
        self._db = database
        self._loop = loop

    async def afetch_all(self, sql: str, params: Sequence[Any] | dict[str, Any] | None = None) -> list[dict]:
        return await self._db.fetch_all(sql, params)

    def fetch_all(
        self, sql: str, params: Sequence[Any] | dict[str, Any] | None = None, timeout_s: float = 30.0
    ) -> list[dict]:
        fut = asyncio.run_coroutine_threadsafe(self._db.fetch_all(sql, params), self._loop)
        return fut.result(timeout=timeout_s)


async def apply_migrations(settings: Settings) -> None:
    """Apply services/analytics/migrations/*.sql (idempotent SQL) with the RW URL."""
    mig_dir = SERVICE_ROOT / "migrations"
    files = sorted(mig_dir.glob("*.sql"))
    if not files:
        return
    async with await psycopg.AsyncConnection.connect(settings.database_url, autocommit=True) as conn:
        await conn.execute("SELECT pg_advisory_lock(%s)", (MIGRATION_LOCK_KEY,))
        try:
            for f in files:
                await conn.execute(f.read_text(encoding="utf-8"))  # type: ignore[arg-type]
                log.info("migration applied", extra={"file": f.name})
        finally:
            await conn.execute("SELECT pg_advisory_unlock(%s)", (MIGRATION_LOCK_KEY,))
