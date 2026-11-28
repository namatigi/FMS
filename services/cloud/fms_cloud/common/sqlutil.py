"""Helpers for hand-built SQL (port of core-api src/lib/sql.ts)."""

from __future__ import annotations

import json
import math
import re
from typing import Any

from .crypto import b64u, b64u_decode


class Params:
    """Positional parameter collector. add() returns the next $n placeholder (see common.db)."""

    def __init__(self, initial: list[Any] | None = None) -> None:
        self.values: list[Any] = list(initial or [])

    def add(self, v: Any) -> str:
        self.values.append(v)
        return f"${len(self.values)}"


def encode_cursor(parts: list[str | int | float]) -> str:
    # JSON.stringify has no spaces; keep identical so cursors are interchangeable.
    return b64u(json.dumps(parts, separators=(",", ":"), default=str))


def decode_cursor(c: str | None) -> list[Any] | None:
    if not c:
        return None
    try:
        v = json.loads(b64u_decode(c).decode())
    except ValueError:  # bad base64, UTF-8 or JSON
        return None
    return v if isinstance(v, list) else None


_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def is_uuid(s: Any) -> bool:
    return isinstance(s, str) and bool(_UUID_RE.match(s))


def round_(n: float | None, dp: int = 3) -> float | int | None:
    """JS Math.round(n * 10**dp) / 10**dp, None for missing/non-finite."""
    if n is None:
        return None
    try:
        f = float(n)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None

    r = math.floor(f * 10**dp + 0.5) / 10**dp
    return int(r) if r.is_integer() else r


def days_of_cover(stock: float | None, avg: float | None) -> float | None:
    if stock is None or not avg or avg <= 0:
        return None
    return round_(stock / avg, 1)


# Reusable SQL fragments (core-api src/lib/queries.ts).
LUSAKA_TODAY_START = "(date_trunc('day', now() AT TIME ZONE 'Africa/Lusaka') AT TIME ZONE 'Africa/Lusaka')"
LUSAKA_TODAY = "(now() AT TIME ZONE 'Africa/Lusaka')::date"


def avg_daily_sales_cte(scoped_stations: str) -> str:
    """CTE body producing (station_id, product_code, avg_daily_l); see queries.ts."""
    return f"""
  avg_dsp AS (
    SELECT station_id, product_code, sum(sales_volume_l) AS vol, count(DISTINCT business_date) AS days
      FROM fms.daily_station_product
     WHERE station_id IN ({scoped_stations})
       AND business_date >= {LUSAKA_TODAY} - 7 AND business_date < {LUSAKA_TODAY}
     GROUP BY 1, 2),
  avg_ptx AS (
    SELECT station_id, product_code, sum(volume_l) AS vol
      FROM fms.pump_transactions
     WHERE station_id IN ({scoped_stations}) AND ended_at >= now() - interval '7 days' AND product_code IS NOT NULL
     GROUP BY 1, 2),
  avg_sales AS (
    SELECT station_id, product_code,
           CASE WHEN d.days > 0 AND d.vol > 0 THEN d.vol / d.days ELSE coalesce(x.vol, 0) / 7.0 END AS avg_daily_l
      FROM avg_dsp d FULL JOIN avg_ptx x USING (station_id, product_code))"""
