"""Worker primitives (services/fiscal-worker/src/core.ts): job errors, backoff, payload
validation, zoned dates, a pino-like structured logger and a small thread pool."""

from __future__ import annotations

import datetime as dt
import logging
import queue as _queue
import random
import re
import threading
from collections.abc import Callable
from concurrent.futures import Future
from typing import Any
from zoneinfo import ZoneInfo

from .jscompat import is_integer, js_dumps, js_number, js_round, parse_date

# ------------------------------------------------------------------ errors


class JobError(Exception):
    """Error carrying an explicit retry decision for the job runner."""

    def __init__(self, message: str, retryable: bool, code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.retryable = retryable
        self.code = code


def permanent(message: str, code: str | None = None) -> JobError:
    """Non-retryable: the job is dead-lettered immediately."""
    return JobError(message, False, code)


def is_retryable(err: BaseException) -> bool:
    """Errors exposing a boolean `retryable` (JobError, FiscalError) are honoured; anything else is retried."""
    r = getattr(err, "retryable", None)
    return r if isinstance(r, bool) else True


def error_message(err: BaseException | Any) -> str:
    if isinstance(err, BaseException):
        msg = getattr(err, "message", None)
        if not isinstance(msg, str):
            msg = str(err) or type(err).__name__
        code = getattr(err, "code", None)
        if code is None:  # database errors: SQLSTATE, like node-postgres err.code
            cause = err.__cause__ or err
            code = getattr(cause, "sqlstate", None)
        return f"{msg} [{code}]" if code else msg
    return str(err)


def backoff_ms(attempt: int, base_ms: float, max_ms: float, rand: Callable[[], float] = random.random) -> float:
    """Exponential backoff with "equal jitter": half of the delay fixed, half random, capped at max_ms. attempt is 1-based."""
    exp = min(max_ms, base_ms * 2 ** max(0, attempt - 1))
    return js_round(exp / 2 + (rand() * exp) / 2)


# ------------------------------------------------------- payload validation

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


class req:
    """Small payload validation helpers (raise non-retryable errors)."""

    @staticmethod
    def str(o: dict[str, Any], k: str) -> str:
        v = o.get(k) if isinstance(o, dict) else None
        if not isinstance(v, str) or not v:
            raise permanent(f"payload.{k} must be a non-empty string", "BAD_PAYLOAD")
        return v

    @staticmethod
    def int(o: dict[str, Any], k: str) -> int:
        v = o.get(k) if isinstance(o, dict) else None
        if isinstance(v, str):
            v = js_number(v)
        if isinstance(v, bool) or not is_integer(v):
            raise permanent(f"payload.{k} must be an integer", "BAD_PAYLOAD")
        return int(v)

    @staticmethod
    def date(o: dict[str, Any], k: str) -> str:
        v = req.str(o, k)
        if not _DATE.fullmatch(v):
            raise permanent(f"payload.{k} must be YYYY-MM-DD", "BAD_PAYLOAD")
        return v

    @staticmethod
    def uuid(o: dict[str, Any], k: str) -> str:
        v = req.str(o, k)
        if not _UUID.fullmatch(v):
            raise permanent(f"payload.{k} must be a UUID", "BAD_PAYLOAD")
        return v

    @staticmethod
    def timestamp(o: dict[str, Any], k: str) -> str:
        v = req.str(o, k)
        if parse_date(v) is None:
            raise permanent(f"payload.{k} must be an ISO-8601 timestamp", "BAD_PAYLOAD")
        return v


def num(v: Any) -> float | None:
    return None if v is None else js_number(v)


# ------------------------------------------------------------------- dates


def zoned_now(time_zone: str, at: dt.datetime | None = None) -> dict[str, Any]:
    """Local calendar date (YYYY-MM-DD) and time of an instant in a time zone."""
    at = at or dt.datetime.now(dt.UTC)
    z = at.astimezone(ZoneInfo(time_zone))
    return {"date": z.date().isoformat(), "hour": z.hour, "minute": z.minute}


def add_days(date: str, days: int) -> str:
    return (dt.date.fromisoformat(date) + dt.timedelta(days=days)).isoformat()


# ----------------------------------------------------------------- logging

_RESERVED = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {"message", "asctime"}


class Log:
    """pino-style logger: log.info("msg", key=value), log.child(job_id=...)."""

    def __init__(self, logger: logging.Logger | str = "fms.fiscal_worker", bindings: dict[str, Any] | None = None) -> None:
        self._logger = logging.getLogger(logger) if isinstance(logger, str) else logger
        self.bindings = dict(bindings or {})

    def child(self, **bindings: Any) -> Log:
        return Log(self._logger, {**self.bindings, **bindings})

    def _emit(self, level: int, msg: str, fields: dict[str, Any]) -> None:
        if not self._logger.isEnabledFor(level):
            return
        extra = {}
        for k, v in {**self.bindings, **fields}.items():
            extra[f"{k}_" if k in _RESERVED else k] = _loggable(v)
        self._logger.log(level, msg, extra=extra)

    def debug(self, msg: str, **f: Any) -> None:
        self._emit(logging.DEBUG, msg, f)

    def info(self, msg: str, **f: Any) -> None:
        self._emit(logging.INFO, msg, f)

    def warn(self, msg: str, **f: Any) -> None:
        self._emit(logging.WARNING, msg, f)

    warning = warn

    def error(self, msg: str, **f: Any) -> None:
        self._emit(logging.ERROR, msg, f)

    def fatal(self, msg: str, **f: Any) -> None:
        self._emit(logging.CRITICAL, msg, f)


def _loggable(v: Any) -> Any:
    if isinstance(v, (dt.datetime, dt.date)):
        from fms_cloud.common.jsonutil import iso

        return iso(v)
    if isinstance(v, (dict, list)):
        try:
            import json

            return json.loads(js_dumps(v))
        except Exception:  # noqa: BLE001
            return str(v)
    return v


# ------------------------------------------------------------- thread pool


class ThreadPool:
    """Cached pool of daemon threads (grows on demand, idle threads exit after idle_s).

    Threads keep their Django database connection between tasks and close it when they
    exit. Daemon threads never block process exit (like process.exit() in node).
    """

    def __init__(self, name: str, idle_s: float = 60.0) -> None:
        self._name = name
        self._idle_s = idle_s
        self._q: _queue.SimpleQueue = _queue.SimpleQueue()
        self._lock = threading.Lock()
        self._idle = 0
        self._seq = 0

    def submit(self, fn: Callable[..., Any], *args: Any) -> Future:
        f: Future = Future()
        with self._lock:
            if self._idle > 0:
                self._idle -= 1
            else:
                self._seq += 1
                threading.Thread(target=self._run, name=f"{self._name}-{self._seq}", daemon=True).start()
        self._q.put((f, fn, args))
        return f

    def _run(self) -> None:
        from django.db import close_old_connections, connections

        try:
            first = True
            while True:
                if not first:
                    with self._lock:
                        self._idle += 1
                first = False
                while True:
                    try:
                        item = self._q.get(timeout=self._idle_s)
                        break
                    except _queue.Empty:
                        with self._lock:
                            if self._idle > 0:
                                self._idle -= 1
                                return
                f, fn, args = item
                if not f.set_running_or_notify_cancel():
                    continue
                close_old_connections()
                try:
                    f.set_result(fn(*args))
                except BaseException as e:  # noqa: BLE001
                    f.set_exception(e)
        finally:
            connections.close_all()
