"""Reference data cache: controllers, gateways, stations (port of services/ingest-api/src/refdata.ts).

TtlCache is thread-safe (gunicorn gthread workers share one cache per process): a lock guards the
map, and concurrent misses for the same key wait on a single in-flight load instead of all hitting
the database. Misses are cached briefly (negative TTL) so unknown keys do not hammer Postgres.
"""

from __future__ import annotations

import datetime as dt
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fms_cloud.common.db import Conn, primary

from .jsutil import parse_iso


class TtlCache[V]:
    """Small TTL cache with in-flight de-duplication and short negative caching."""

    def __init__(self, ttl_ms: float, negative_ttl_ms: float, load: Callable[[str], V | None], clock: Callable[[], float] = time.monotonic):
        self.ttl_s = ttl_ms / 1000
        self.negative_ttl_s = negative_ttl_ms / 1000
        self._load = load
        self._clock = clock
        self._lock = threading.Lock()
        self._map: dict[str, tuple[V | None, float]] = {}
        self._inflight: dict[str, Future] = {}

    def get(self, key: str) -> V | None:
        with self._lock:
            hit = self._map.get(key)
            if hit is not None and hit[1] > self._clock():
                return hit[0]
            fut = self._inflight.get(key)
            owner = fut is None
            if owner:
                fut = Future()
                self._inflight[key] = fut
        if not owner:
            return fut.result()
        try:
            v = self._load(key)
        except BaseException as e:
            with self._lock:
                self._inflight.pop(key, None)
            fut.set_exception(e)
            raise
        with self._lock:
            self._map[key] = (v, self._clock() + (self.negative_ttl_s if v is None else self.ttl_s))
            if len(self._map) > 50_000:
                self._map.clear()
            self._inflight.pop(key, None)
        fut.set_result(v)
        return v

    def clear(self) -> None:
        with self._lock:
            self._map.clear()


@dataclass(frozen=True)
class ControllerRef:
    id: str
    pts_id: str
    station_id: str
    hmac_secret: str | None


@dataclass(frozen=True)
class GatewayRef:
    id: str
    gateway_code: str
    station_id: str
    api_key_hash: str


@dataclass(frozen=True)
class TankRef:
    product_code: str
    low_level_l: float | None
    capacity_l: float


@dataclass(frozen=True)
class NozzleRef:
    tank_no: int | None
    product_code: str | None


@dataclass(frozen=True)
class StationRef:
    id: str
    code: str
    timezone: str
    tz_offset: str  # "+02:00" style offset used for PTS-2 local timestamps
    province_id: int
    company_id: str
    connection_mode: str  # 'edge' | 'direct'
    grades: dict[int, str] = field(default_factory=dict)  # pts_grade_id -> product_code
    nozzles: dict[str, NozzleRef] = field(default_factory=dict)  # "pump:nozzle"
    tanks: dict[int, TankRef] = field(default_factory=dict)


# Fixed offsets for when the platform has no IANA database (Windows without the tzdata package).
_FALLBACK_OFFSETS_H = {"Africa/Lusaka": 2, "Africa/Harare": 2, "Africa/Maputo": 2, "Africa/Johannesburg": 2, "UTC": 0, "Etc/UTC": 0}


@lru_cache(maxsize=64)
def _zone(name: str) -> dt.tzinfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        # tzOffsetOf fell back to +02:00 (Zambia) when the zone was unknown
        return dt.timezone(dt.timedelta(hours=_FALLBACK_OFFSETS_H.get(name, 2)))


def tz_offset_of(timezone: str, at: dt.datetime | None = None) -> str:
    """Current UTC offset of an IANA zone as "+HH:MM" (Zambia has no DST, but stay generic)."""
    at = at or dt.datetime.now(dt.UTC)
    off = at.astimezone(_zone(timezone)).utcoffset() or dt.timedelta(0)
    minutes = int(off.total_seconds() // 60)
    sign = "+" if minutes >= 0 else "-"
    minutes = abs(minutes)
    return f"{sign}{minutes // 60:02d}:{minutes % 60:02d}"


def local_date(at: str | dt.datetime, timezone: str) -> str:
    """Station-local calendar date (YYYY-MM-DD) of an instant."""
    d = parse_iso(at) if isinstance(at, str) else at
    if d is None:
        raise ValueError("Invalid time value")
    return d.astimezone(_zone(timezone)).date().isoformat()


_STATION_SQL = """SELECT s.id, s.code, s.timezone, s.province_id, s.company_id, s.connection_mode,
              (SELECT coalesce(json_agg(json_build_object('g', g.pts_grade_id, 'p', g.product_code)), '[]')
                 FROM fms.fuel_grades g WHERE g.station_id = s.id) AS grades,
              (SELECT coalesce(json_agg(json_build_object('pump', n.pump_no, 'nozzle', n.nozzle_no,
                        'tank', t.tank_no, 'p', coalesce(g.product_code, t.product_code))), '[]')
                 FROM fms.nozzles n
                 LEFT JOIN fms.fuel_grades g ON g.id = n.fuel_grade_id
                 LEFT JOIN fms.tanks t ON t.id = n.tank_id
                WHERE n.station_id = s.id) AS nozzles,
              (SELECT coalesce(json_agg(json_build_object('tank', t.tank_no, 'p', t.product_code,
                        'low', t.low_level_l, 'cap', t.capacity_l)), '[]')
                 FROM fms.tanks t WHERE t.station_id = s.id) AS tanks
         FROM fms.stations s WHERE s.id = $1"""


class RefData:
    def __init__(self, ttl_ms: float, db: Conn = primary) -> None:
        self.db = db
        neg = min(ttl_ms, 5000)
        self.controllers: TtlCache[ControllerRef] = TtlCache(ttl_ms, neg, self._load_controller)
        self.gateways: TtlCache[GatewayRef] = TtlCache(ttl_ms, neg, self._load_gateway)
        self.stations: TtlCache[StationRef] = TtlCache(ttl_ms, neg, self._load_station)

    def _load_controller(self, pts_id: str) -> ControllerRef | None:
        r = self.db.one("SELECT id, pts_id, station_id, hmac_secret FROM fms.controllers WHERE pts_id = $1", [pts_id])
        return ControllerRef(**r) if r else None

    def _load_gateway(self, code: str) -> GatewayRef | None:
        r = self.db.one(
            "SELECT id, gateway_code, station_id, api_key_hash FROM fms.edge_gateways WHERE gateway_code = $1",
            [code],
        )
        return GatewayRef(**r) if r else None

    def _load_station(self, station_id: str) -> StationRef | None:
        r: dict[str, Any] | None = self.db.one(_STATION_SQL, [station_id])
        if not r:
            return None
        return StationRef(
            id=r["id"],
            code=r["code"],
            timezone=r["timezone"],
            tz_offset=tz_offset_of(r["timezone"]),
            province_id=r["province_id"],
            company_id=r["company_id"],
            connection_mode=r["connection_mode"],
            grades={x["g"]: x["p"] for x in r["grades"]},
            nozzles={f"{x['pump']}:{x['nozzle']}": NozzleRef(tank_no=x["tank"], product_code=x["p"]) for x in r["nozzles"]},
            tanks={
                x["tank"]: TankRef(
                    product_code=x["p"],
                    low_level_l=None if x["low"] is None else x["low"],
                    capacity_l=x["cap"],
                )
                for x in r["tanks"]
            },
        )

    def clear(self) -> None:
        self.controllers.clear()
        self.gateways.clear()
        self.stations.clear()
