"""JavaScript value semantics the ingest port relies on.

The TypeScript service ran on JSON.parse / Number() / String() / Date.parse; the edge
gateway and PTS-2 controllers depend on the exact results, so these helpers reproduce them:

- JSON numbers have one type: 3.0 is the integer 3 (``js_norm`` folds integral floats to int).
- ``js_number`` is ``Number(v)``, ``js_string`` is ``String(v)``.
- ``parse_iso`` / ``to_iso`` are ``Date.parse`` / ``Date.prototype.toISOString`` (millisecond precision, UTC 'Z').
- ``loads`` rejects NaN/Infinity (not JSON) and proto-poisoning keys like Fastify's secure-json-parse.
- ``dumps`` is ``JSON.stringify`` for SQL parameters (json_to_recordset).
"""

from __future__ import annotations

import datetime as dt
import json
import math
import re
from typing import Any

from fms_cloud.common.jsonutil import iso as _iso

MAX_SAFE_INTEGER = 2**53 - 1


class _Missing:
    def __repr__(self) -> str:
        return "undefined"


MISSING: Any = _Missing()


def is_number(v: Any) -> bool:
    """typeof v === 'number' (bool is not a number in JavaScript)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def is_finite(v: Any) -> bool:
    return is_number(v) and math.isfinite(v)


def is_integer(v: Any) -> bool:
    """Number.isInteger(v)."""
    if not is_number(v):
        return False
    return isinstance(v, int) or (math.isfinite(v) and float(v).is_integer())


def is_safe_integer(v: Any) -> bool:
    return is_integer(v) and abs(v) <= MAX_SAFE_INTEGER


def num_out(v: float) -> float | int:
    """A JS number as Python: integral values become int (so f-strings / JSON print '3', not '3.0')."""
    if isinstance(v, float) and v.is_integer() and abs(v) <= MAX_SAFE_INTEGER:
        return int(v)
    return v


def js_norm(o: Any) -> Any:
    """Recursively fold integral floats to int (JSON.stringify(3.0) === '3')."""
    if isinstance(o, float):
        return num_out(o)
    if isinstance(o, dict):
        return {k: js_norm(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [js_norm(v) for v in o]
    return o


_JS_WS = " \t\n\v\f\r                 　﻿"
_DEC = re.compile(r"[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)", re.ASCII)


def js_number(v: Any) -> float | int:
    """Number(v); NaN for anything that does not convert."""
    if v is None:
        return 0
    if isinstance(v, bool):
        return 1 if v else 0
    if is_number(v):
        return num_out(v)
    if isinstance(v, str):
        s = v.strip(_JS_WS)
        if s == "":
            return 0
        low = s.lower()
        for prefix, base in (("0x", 16), ("0o", 8), ("0b", 2)):
            if low.startswith(prefix):
                try:
                    return int(s[2:], base)
                except ValueError:
                    return math.nan
        if not _DEC.fullmatch(s):
            return math.nan
        try:
            return num_out(float(s))
        except ValueError:
            return math.nan
    if isinstance(v, list):
        return js_number(js_string(v))
    return math.nan


def _js_float_str(f: float) -> str:
    if math.isnan(f):
        return "NaN"
    if math.isinf(f):
        return "Infinity" if f > 0 else "-Infinity"
    if f.is_integer() and abs(f) < 1e21:
        return str(int(f))
    r = repr(f)
    if "e" in r:  # JS: 1e-7, 1.5e+21
        mant, exp = r.split("e")
        e = int(exp)
        return f"{mant}e{'+' if e > 0 else '-'}{abs(e)}"
    return r


def js_string(v: Any) -> str:
    """String(v)."""
    if v is MISSING:
        return "undefined"
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return _js_float_str(v)
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return ",".join("" if x is None or x is MISSING else js_string(x) for x in v)
    if isinstance(v, dict):
        return "[object Object]"
    return str(v)


# ------------------------------------------------------------------ JSON


def _reject_constant(name: str) -> Any:
    raise ValueError(f"Unexpected token {name} in JSON")


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    d: dict[str, Any] = {}
    for k, v in pairs:
        if k == "__proto__":
            raise ValueError("Object contains forbidden prototype property")
        if k == "constructor" and isinstance(v, dict) and "prototype" in v:
            raise ValueError("Object contains forbidden prototype property")
        d[k] = v
    return d


def loads(text: str) -> Any:
    """JSON.parse (via secure-json-parse): no NaN/Infinity, no __proto__ / constructor.prototype keys."""
    return json.loads(text, parse_constant=_reject_constant, object_pairs_hook=_pairs)


def dumps(o: Any) -> str:
    """JSON.stringify for SQL parameters."""
    return json.dumps(js_norm(o), ensure_ascii=False, separators=(",", ":"), allow_nan=False, default=_default)


def _default(o: Any) -> Any:
    if isinstance(o, (dt.datetime, dt.date)):
        return to_iso(o)
    raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")


# ------------------------------------------------------------------ dates


def parse_iso(s: str) -> dt.datetime | None:
    """Date.parse for ISO-8601 strings: aware UTC datetime truncated to milliseconds, None if invalid.

    Strings without an offset are not expected here (callers check the offset first); if one gets
    through it is read as UTC, which is what Date.parse does for date-only forms.
    """
    if not isinstance(s, str):
        return None
    t = s.strip()
    if t.endswith(("z", "Z")):
        t = t[:-1] + "+00:00"
    try:
        d = dt.datetime.fromisoformat(t)
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.UTC)
    try:
        d = d.astimezone(dt.UTC)
    except (OverflowError, ValueError):
        return None
    return d.replace(microsecond=(d.microsecond // 1000) * 1000)


def to_iso(d: dt.datetime | str) -> str:
    """Date.prototype.toISOString(): 2026-11-27T08:15:30.123Z. Strings are parsed first."""
    if isinstance(d, str):
        p = parse_iso(d)
        if p is None:
            raise ValueError("Invalid time value")
        d = p
    return _iso(d)  # type: ignore[return-value]


def now_iso() -> str:
    return to_iso(dt.datetime.now(dt.UTC))
