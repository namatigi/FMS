"""Raw-SQL access to the fms schema.

The TypeScript services used hand-written SQL with $1, $2 placeholders. To keep
the port faithful, this module accepts exactly that style:

    rows = db.query("SELECT ... WHERE id = $1 AND x = $2", [a, b])

$n placeholders are rewritten to psycopg named parameters (%(p1)s) so one value
can be referenced several times, and literal % signs are escaped. Write SQL as
you would for node-postgres.

Row values are normalised like the node services did:
  NUMERIC -> float, BIGINT -> int, DATE -> 'YYYY-MM-DD' string,
  json/jsonb -> parsed Python objects, uuid -> str.
TIMESTAMPTZ values stay as aware datetimes; fms_cloud.common.jsonutil renders
them as ISO-8601 UTC with milliseconds and a trailing Z (JavaScript's
Date.toISOString), which is what the API contracts specify.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from decimal import Decimal
from functools import lru_cache
from typing import Any

from django.conf import settings
from django.db import connections, transaction

_PLACEHOLDER = re.compile(r"\$(\d+)")

# PostgreSQL type OIDs we post-process.
_JSON_OIDS = {114, 3802}


@lru_cache(maxsize=4096)
def convert_sql(sql: str) -> str:
    """'$1' -> '%(p1)s', '%' -> '%%'. Cached: the same SQL strings recur."""
    return _PLACEHOLDER.sub(lambda m: f"%(p{m.group(1)})s", sql.replace("%", "%%"))


def _params(values: Sequence[Any] | None) -> dict[str, Any]:
    if not values:
        return {}
    out: dict[str, Any] = {}
    for i, v in enumerate(values, start=1):
        out[f"p{i}"] = _adapt(v)
    return out


def _adapt(v: Any) -> Any:
    # node-postgres serialised plain objects/arrays-of-objects for json columns
    # when callers passed JSON.stringify(...) strings; dicts are adapted the same way.
    if isinstance(v, dict):
        return json.dumps(v, default=_json_default)
    return v


def _json_default(o: Any) -> Any:
    if isinstance(o, Decimal):
        return float(o)
    if isinstance(o, (dt.datetime, dt.date)):
        return o.isoformat()
    if isinstance(o, uuid.UUID):
        return str(o)
    raise TypeError(f"not JSON serialisable: {type(o).__name__}")


def _convert(value: Any, oid: int | None) -> Any:
    if value is None:
        return None
    if oid in _JSON_OIDS and isinstance(value, (str, bytes)):
        return json.loads(value)
    if isinstance(value, Decimal):
        # JavaScript has one number type: 5000 and 5000.0 serialise the same. Keep
        # integral NUMERICs as int so JSON output matches the node services.
        f = float(value)
        return int(f) if f.is_integer() and abs(f) < 2**53 else f
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, dt.date) and not isinstance(value, dt.datetime):
        return value.isoformat()
    return value


def ro_alias() -> str:
    return settings.RO_ALIAS


class Conn:
    """Thin wrapper over one Django connection alias."""

    def __init__(self, alias: str = "default") -> None:
        self.alias = alias

    def _run(self, sql: str, values: Sequence[Any] | None):
        cur = connections[self.alias].cursor()
        cur.execute(convert_sql(sql), _params(values))
        return cur

    def query(self, sql: str, values: Sequence[Any] | None = None) -> list[dict[str, Any]]:
        """Run a statement and return all rows as dicts ([] for statements without a result)."""
        with self._run(sql, values) as cur:
            if cur.description is None:
                return []
            cols = [(d.name, d.type_code) for d in cur.description]
            return [{name: _convert(v, oid) for (name, oid), v in zip(cols, row)} for row in cur.fetchall()]

    def one(self, sql: str, values: Sequence[Any] | None = None) -> dict[str, Any] | None:
        rows = self.query(sql, values)
        return rows[0] if rows else None

    def scalar(self, sql: str, values: Sequence[Any] | None = None) -> Any:
        row = self.one(sql, values)
        return next(iter(row.values())) if row else None

    def execute(self, sql: str, values: Sequence[Any] | None = None) -> int:
        """Run a statement and return its rowcount."""
        with self._run(sql, values) as cur:
            return cur.rowcount


primary = Conn("default")


def ro() -> Conn:
    """Read connection (DATABASE_URL_RO, falls back to the primary)."""
    return Conn(ro_alias())


@contextmanager
def tx(alias: str = "default") -> Iterator[Conn]:
    """BEGIN ... COMMIT on the primary (ROLLBACK on exception). Nested use creates a savepoint."""
    with transaction.atomic(using=alias):
        yield Conn(alias)


def ping(alias: str = "default") -> None:
    Conn(alias).query("SELECT 1")
