"""VSDC time formatting and invoice numbers (packages/zra-client/src/time.ts)."""

from __future__ import annotations

import datetime as dt
import re
from functools import lru_cache
from zoneinfo import ZoneInfo

from ..jscompat import js_str, parse_date
from .spec import VSDC_SPEC

_VSDC_DT = re.compile(r"[0-9]{14}")


@lru_cache(maxsize=64)
def _zone(name: str) -> ZoneInfo:
    return ZoneInfo(name)


def zoned_parts(at: dt.datetime | str, time_zone: str = VSDC_SPEC.timeZone) -> dict[str, str]:
    """Wall-clock parts of an instant in the given IANA time zone."""
    d = parse_date(at)
    if d is None:
        raise ValueError(f"Invalid date: {at}")
    z = d.astimezone(_zone(time_zone))
    return {
        "y": f"{z.year:04d}",
        "M": f"{z.month:02d}",
        "d": f"{z.day:02d}",
        "H": f"{z.hour:02d}",
        "m": f"{z.minute:02d}",
        "s": f"{z.second:02d}",
    }


def format_vsdc_datetime(at: dt.datetime | str, time_zone: str = VSDC_SPEC.timeZone) -> str:
    """yyyyMMddHHmmss in the station time zone (default Africa/Lusaka)."""
    p = zoned_parts(at, time_zone)
    return f"{p['y']}{p['M']}{p['d']}{p['H']}{p['m']}{p['s']}"


def format_vsdc_date(at: dt.datetime | str, time_zone: str = VSDC_SPEC.timeZone) -> str:
    """yyyyMMdd in the station time zone (default Africa/Lusaka)."""
    p = zoned_parts(at, time_zone)
    return f"{p['y']}{p['M']}{p['d']}"


def parse_vsdc_datetime(s: str | None, offset: str = VSDC_SPEC.utcOffset) -> str | None:
    """Parse a VSDC yyyyMMddHHmmss timestamp (Lusaka local time) into an ISO-8601 string with offset."""
    if not s or not isinstance(s, str) or not _VSDC_DT.fullmatch(s):
        return None
    iso = f"{s[0:4]}-{s[4:6]}-{s[6:8]}T{s[8:10]}:{s[10:12]}:{s[12:14]}{offset}"
    try:
        dt.datetime.fromisoformat(iso)
    except ValueError:
        return None
    return iso


def build_invoice_no(
    station_code: str, pump_no: int, pts_transaction_no: int, ended_at: dt.datetime | str, time_zone: str | None = None
) -> str:
    """Deterministic invoice number (DESIGN.md section 7):
        <station_code>-P<pump>-<pts_transaction_no>-<yyyyMMddHHmmss of ended_at, station-local>
    Used as cisInvcNo by every fiscalisation path (edge and cloud) so retries never double-sign.
    """
    tz = VSDC_SPEC.timeZone if time_zone is None else time_zone
    return f"{station_code}-P{js_str(pump_no)}-{js_str(pts_transaction_no)}-{format_vsdc_datetime(ended_at, tz)}"
