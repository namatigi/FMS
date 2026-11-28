"""JavaScript number / string / JSON semantics the fiscal code depends on.

ZRA payloads, invoice numbers, webhook bodies and export files must be byte-compatible
with the TypeScript worker and edge gateways, so the few JS behaviours that differ from
Python are reproduced here:

- Math.round (half towards +infinity), Number.prototype.toFixed (half away from zero on
  the exact binary value);
- JSON.stringify number rendering (652.0 -> 652, NaN/Infinity -> null);
- String(value) / template-literal rendering of numbers, null and booleans;
- Number(value) coercion;
- sequential float addition (Python 3.12's sum() uses compensated summation, JS does not).
"""

from __future__ import annotations

import datetime as dt
import json
import math
import re
from collections.abc import Iterable
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

EPSILON = 2.220446049250313e-16  # Number.EPSILON

_DEC_RE = re.compile(r"[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_JS_WS = " \t\n\r\x0b\x0c                 　﻿"


def js_round(x: float) -> float:
    """Math.round: nearest integer, halves rounded towards +infinity."""
    if isinstance(x, int) and not isinstance(x, bool):
        return x
    if math.isnan(x) or math.isinf(x):
        return x
    r = math.floor(x)
    if x - r >= 0.5:
        r += 1
    return r


def js_sum(values: Iterable[float], start: float = 0) -> float:
    """values.reduce((s, v) => s + v, start) with plain IEEE additions."""
    s = start
    for v in values:
        s = s + v
    return s


def to_fixed(n: float, digits: int) -> str:
    """Number.prototype.toFixed."""
    if math.isnan(n):
        return "NaN"
    if abs(n) >= 1e21:
        return js_str(n)
    if n == 0:
        n = 0.0  # (-0).toFixed() has no sign
    q = Decimal(n).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
    return f"{q:f}"


def _num_str(f: float) -> str:
    if math.isnan(f):
        return "NaN"
    if math.isinf(f):
        return "Infinity" if f > 0 else "-Infinity"
    if f == int(f) and abs(f) < 1e21:
        return str(int(f))
    r = repr(f)
    if "e" in r:  # Python 1e-07 / 1e+22 -> JavaScript 1e-7 / 1e+22
        mant, exp = r.split("e")
        sign = "-" if exp.startswith("-") else "+"
        r = f"{mant}e{sign}{int(exp.lstrip('+-'))}"
    return r


def js_str(v: Any) -> str:
    """String(v) for the value types that occur in payloads."""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return _num_str(v)
    if isinstance(v, str):
        return v
    if isinstance(v, (list, tuple)):
        return ",".join("" if x is None else js_str(x) for x in v)
    if isinstance(v, dict):
        return "[object Object]"
    if isinstance(v, dt.datetime):
        return v.isoformat()
    return str(v)


def js_truthy(v: Any) -> bool:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return not (v == 0 or math.isnan(v))
    return not (v is None or v is False or v == "")


def js_number(v: Any) -> float:
    """Number(v). Integral results are returned as int (JavaScript has one number type)."""
    if v is None:
        return 0
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        s = v.strip(_JS_WS)
        if s == "":
            return 0
        low = s.lower()
        try:
            if low.startswith("0x"):
                return int(s, 16)
            if low.startswith("0o"):
                return int(s, 8)
            if low.startswith("0b"):
                return int(s, 2)
        except ValueError:
            return math.nan
        if s in ("Infinity", "+Infinity"):
            return math.inf
        if s == "-Infinity":
            return -math.inf
        if not _DEC_RE.fullmatch(s):
            return math.nan
        f = float(s)
        return int(f) if f.is_integer() and abs(f) < 2**53 else f
    if isinstance(v, (list, tuple)):
        if len(v) == 0:
            return 0
        if len(v) == 1:
            return js_number(js_str(v[0]))
        return math.nan
    return math.nan


def is_finite(n: Any) -> bool:
    return isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n)


def is_integer(n: Any) -> bool:
    """Number.isInteger."""
    return is_finite(n) and float(n).is_integer()


def _normalise(o: Any) -> Any:
    if isinstance(o, float):
        if math.isnan(o) or math.isinf(o):
            return None
        if o.is_integer() and abs(o) < 1e21:
            return int(o)
        return o
    if isinstance(o, dict):
        return {str(k): _normalise(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_normalise(v) for v in o]
    if isinstance(o, dt.datetime):
        from fms_cloud.common.jsonutil import iso

        return iso(o)
    if isinstance(o, Decimal):
        return _normalise(float(o))
    return o


def js_dumps(o: Any, indent: int | None = None) -> str:
    """JSON.stringify(o) / JSON.stringify(o, null, indent)."""
    if indent is None:
        return json.dumps(_normalise(o), ensure_ascii=False, separators=(",", ":"), default=str)
    return json.dumps(_normalise(o), ensure_ascii=False, indent=indent, default=str)


def parse_date(s: Any) -> dt.datetime | None:
    """new Date(s) for ISO-8601 strings (naive values are taken as UTC); None when invalid."""
    if isinstance(s, dt.datetime):
        return s if s.tzinfo else s.replace(tzinfo=dt.UTC)
    if not isinstance(s, str) or not s:
        return None
    try:
        d = dt.datetime.fromisoformat(s.strip())
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=dt.UTC)


def coalesce(*values: Any) -> Any:
    """a ?? b ?? c"""
    for v in values:
        if v is not None:
            return v
    return None
