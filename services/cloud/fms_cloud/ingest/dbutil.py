"""Transactions and transient-error classification (port of services/ingest-api/src/db.ts)."""

from __future__ import annotations

import re
from collections.abc import Callable

from django.db import InterfaceError, OperationalError, transaction

from fms_cloud.common.db import Conn

_CONN_MSG = re.compile(r"ECONN|ETIMEDOUT|EPIPE|timeout|Connection terminated", re.IGNORECASE)


def sqlstate(err: BaseException | None) -> str | None:
    seen = 0
    while err is not None and seen < 5:
        code = getattr(err, "sqlstate", None) or getattr(getattr(err, "diag", None), "sqlstate", None)
        if isinstance(code, str) and code:
            return code
        err = err.__cause__ or err.__context__
        seen += 1
    return None


def is_transient_db_error(err: BaseException) -> bool:
    """SQLSTATEs that indicate a transient condition: retry later, do not treat the data as bad."""
    code = sqlstate(err)
    if not code:
        # connection-level errors carry no SQLSTATE
        if isinstance(err, (OperationalError, InterfaceError)):
            return True
        return bool(_CONN_MSG.search(str(err)))
    return (
        code.startswith(("08", "40", "53", "57")) or code == "55P03"  # lock_not_available
    )


def is_retryable_tx_error(err: BaseException) -> bool:
    return sqlstate(err) in ("40P01", "40001")


def with_tx[T](fn: Callable[[Conn], T], alias: str = "default") -> T:
    """Run fn inside a transaction; retries deadlock/serialization failures (up to 3 attempts, like withTx)."""
    attempt = 0
    while True:
        try:
            with transaction.atomic(using=alias):
                return fn(Conn(alias))
        except Exception as err:
            if attempt < 2 and is_retryable_tx_error(err):
                attempt += 1
                continue
            raise
