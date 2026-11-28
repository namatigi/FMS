"""Apply a directory of *.sql files once each, serialised by an advisory lock.

Same tracking tables as the node services (e.g. fms.core_api_migrations), so a
database migrated by either implementation is recognised by the other.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from django.db import connections


def run_sql_migrations(
    directory: Path, table: str, lock_key: int, log: Callable[[str], None] = lambda m: None, alias: str = "default"
) -> list[str]:
    applied: list[str] = []
    dj = connections[alias]
    dj.ensure_connection()
    raw = dj.connection  # psycopg.Connection in autocommit mode (Django's default)
    with raw.cursor() as cur:
        cur.execute("SELECT pg_advisory_lock(%s)", [lock_key])
        try:
            cur.execute(f"CREATE TABLE IF NOT EXISTS {table} (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())")
            cur.execute(f"SELECT name FROM {table}")
            done = {r[0] for r in cur.fetchall()}
            for f in sorted(p for p in directory.iterdir() if p.suffix == ".sql"):
                if f.name in done:
                    continue
                with raw.transaction():
                    # No parameters: the file may contain % signs and $$ bodies.
                    cur.execute(f.read_text(encoding="utf-8").encode())
                    cur.execute(f"INSERT INTO {table}(name) VALUES (%s)", [f.name])
                applied.append(f.name)
                log(f"applied migration {f.name}")
        finally:
            cur.execute("SELECT pg_advisory_unlock(%s)", [lock_key])
    return applied
