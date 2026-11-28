"""JSON rendering that matches the node services byte-for-byte where it matters.

- datetimes -> ISO-8601 UTC with milliseconds and 'Z' (Date.toISOString())
- dates     -> 'YYYY-MM-DD'
- Decimal   -> number, UUID -> string
"""

from __future__ import annotations

import datetime as dt
import json
import uuid
from decimal import Decimal
from typing import Any

from django.http import HttpResponse


def iso(value: Any) -> str | None:
    """Render a timestamp like JavaScript's Date.toISOString(); pass strings through."""
    if value is None:
        return None
    if isinstance(value, dt.datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=dt.UTC)
        v = value.astimezone(dt.UTC)
        return v.strftime("%Y-%m-%dT%H:%M:%S.") + f"{v.microsecond // 1000:03d}Z"
    if isinstance(value, dt.date):
        return value.isoformat()
    return str(value)


def default(o: Any) -> Any:
    if isinstance(o, (dt.datetime, dt.date)):
        return iso(o)
    if isinstance(o, Decimal):
        f = float(o)
        return int(f) if f.is_integer() else f
    if isinstance(o, uuid.UUID):
        return str(o)
    if isinstance(o, (set, frozenset, tuple)):
        return list(o)
    if hasattr(o, "model_dump"):
        return o.model_dump(mode="json")
    raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")


def dumps(data: Any) -> str:
    return json.dumps(data, default=default, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def json_response(data: Any, status: int = 200, headers: dict[str, str] | None = None) -> HttpResponse:
    resp = HttpResponse(dumps(data), status=status, content_type="application/json; charset=utf-8")
    for k, v in (headers or {}).items():
        resp[k] = v
    return resp
