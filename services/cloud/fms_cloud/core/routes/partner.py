"""Port of services/core-api/src/routes/partner.ts (mounted under /api/partner/v1).

Authentication is an X-API-Key header checked against fms.api_clients (prefix lookup,
sha256 compare). Each client has scopes, optional province/company limits (applied by
core.scope) and its own per-minute rate limit (api_clients.rate_limit_rpm).
"""

from __future__ import annotations

import threading
import time
from typing import Any, Literal

from django.http import HttpRequest
from ninja import Query, Router, Schema
from ninja.security import APIKeyHeader
from pydantic import Field

from ...common.crypto import safe_equal_hex, sha256_hex
from ...common.db import primary, ro
from ...common.errors import HttpError, bad_request, forbidden, unauthorized
from ...common.ratelimit import FixedWindow
from ...common.sqlutil import Params, decode_cursor, encode_cursor
from ..auth import client_ip
from ..metrics import PARTNER_REQUESTS
from ..scope import Principal, assert_station_in_scope, station_id_scope, station_scope
from .alerts import ALERT_COLUMNS
from .regulator import caps_in_force
from .stations import STATION_COLUMNS, STATION_FROM, CoerceInt, IsoDate, IsoDateTime

# Small in-process cache so key lookups don't hit the DB on every request.
CACHE_S = 30.0
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_cache_lock = threading.Lock()


class apiKey(APIKeyHeader):
    """X-API-Key auth. Runs before request validation, like the Fastify onRequest hook."""

    param_name = "X-API-Key"

    def authenticate(self, request: HttpRequest, key: str | None) -> Principal:
        if not isinstance(key, str) or "." not in key:
            raise unauthorized("X-API-Key header required", "invalid_api_key")
        prefix = key[: key.index(".")]
        with _cache_lock:
            entry = _cache.get(prefix)
        if not entry or time.monotonic() - entry[0] > CACHE_S:
            r = primary.one(
                "SELECT id, name, key_hash, scopes, province_id, company_id, rate_limit_rpm, is_active FROM fms.api_clients WHERE key_prefix = $1",
                [prefix],
            )
            if not r:
                with _cache_lock:
                    _cache.pop(prefix, None)
                raise unauthorized("invalid API key", "invalid_api_key")
            entry = (time.monotonic(), r)
            with _cache_lock:
                _cache[prefix] = entry
        c = entry[1]
        if not c["is_active"] or not safe_equal_hex(sha256_hex(key), c["key_hash"]):
            raise unauthorized("invalid API key", "invalid_api_key")
        pr = Principal(
            kind="api_client",
            id=c["id"],
            name=c["name"],
            scopes=list(c["scopes"] or []),
            province_id=c["province_id"],
            company_id=c["company_id"],
            rate_limit_rpm=c["rate_limit_rpm"],
        )
        request.principal = pr
        PARTNER_REQUESTS.labels(prefix).inc()
        return pr


router = Router(tags=["partner"], auth=apiKey())

# Per-client limit = api_clients.rate_limit_rpm (one fixed window per client).
_limiters: dict[str, FixedWindow] = {}
_limiters_lock = threading.Lock()


def _rate_limit(request: HttpRequest) -> None:
    pr: Principal | None = getattr(request, "principal", None)
    is_client = pr is not None and pr.kind == "api_client"
    key = f"partner:{pr.id if is_client else client_ip(request)}"
    limit = pr.rate_limit_rpm if is_client else 60
    with _limiters_lock:
        lim = _limiters.get(key)
        if lim is None or lim.limit != limit:
            lim = _limiters[key] = FixedWindow(limit, 60)
    ok, retry = lim.allow(key)
    if not ok:
        raise HttpError(429, "rate_limited", "rate limit exceeded, retry in 1 minute", headers={"Retry-After": str(retry)})


def _need(request: HttpRequest, scope: str) -> Principal:
    """preHandler order as in core-api: the rate-limit hook first, then the scope check."""
    _rate_limit(request)
    pr: Principal = request.principal
    if scope not in pr.scopes:
        raise forbidden(f"API key lacks scope {scope}")
    return pr


# ------------------------------------------------------------------ schemas
class StationsQuery(Schema):
    province_id: CoerceInt | None = None
    limit: CoerceInt = Field(500, ge=1, le=1000)
    cursor: str | None = None


class StockQuery(Schema):
    province_id: CoerceInt | None = None
    product_code: str | None = None


class SalesDailyQuery(Schema):
    from_: IsoDate | None = Field(None, alias="from")
    to: IsoDate | None = None
    province_id: CoerceInt | None = None
    product_code: str | None = None
    station_id: str | None = None


class PricesQuery(Schema):
    kind: Literal["erb_cap", "station"] = "erb_cap"


class AlertsQuery(Schema):
    status: Literal["open", "all"] = "open"
    severity: Literal["info", "warning", "critical"] | None = None
    since: IsoDateTime | None = None
    limit: CoerceInt = Field(200, ge=1, le=1000)
    cursor: str | None = None


# ------------------------------------------------------------------ routes
@router.get("/stations", summary="Stations visible to the client")
def stations(request: HttpRequest, q: Query[StationsQuery]):
    pr = _need(request, "stations:read")
    p = Params()
    where = [station_scope(pr, p)]
    if q.province_id is not None:
        where.append(f"s.province_id = {p.add(q.province_id)}")
    cur = decode_cursor(q.cursor)
    if cur:
        where.append(f"s.code > {p.add(str(cur[0]))}")
    rows = ro().query(
        f"SELECT {STATION_COLUMNS}, s.erb_licence_no FROM {STATION_FROM} WHERE {' AND '.join(where)} ORDER BY s.code LIMIT {q.limit + 1}",
        p.values,
    )
    more = len(rows) > q.limit
    items = rows[: q.limit]
    return {"items": items, "next_cursor": encode_cursor([items[-1]["code"]]) if more else None}


@router.get("/stock", summary="Live stock per station × product")
def stock(request: HttpRequest, q: Query[StockQuery]):
    pr = _need(request, "stock:read")
    p = Params()
    where = [station_scope(pr, p)]
    if q.province_id is not None:
        where.append(f"s.province_id = {p.add(q.province_id)}")
    if q.product_code:
        where.append(f"ss.product_code = {p.add(q.product_code)}")
    rows = ro().query(
        f"""SELECT ss.station_id, ss.station_code, ss.station_name, ss.province_id, ss.company_id, ss.product_code, ss.tank_count,
                ss.capacity_l, ss.product_volume_l, ss.ullage_l, ss.latest_reading_at
           FROM fms.v_station_stock ss JOIN fms.stations s ON s.id = ss.station_id
          WHERE {" AND ".join(where)} ORDER BY ss.station_code, ss.product_code""",
        p.values,
    )
    return {"items": rows, "next_cursor": None}


@router.get("/sales/daily", summary="Daily sales per station × product")
def sales_daily(request: HttpRequest, q: Query[SalesDailyQuery]):
    pr = _need(request, "sales:read")
    db = ro()
    if q.station_id:
        assert_station_in_scope(db, pr, q.station_id)
    p = Params()
    where = [station_id_scope(pr, p, "d.station_id")]
    where.append(
        f"d.business_date >= {p.add(q.from_)}::date" if q.from_ else "d.business_date >= (now() AT TIME ZONE 'Africa/Lusaka')::date - 30"
    )
    if q.to:
        where.append(f"d.business_date <= {p.add(q.to)}::date")
    if q.province_id is not None:
        where.append(f"d.province_id = {p.add(q.province_id)}")
    if q.product_code:
        where.append(f"d.product_code = {p.add(q.product_code)}")
    if q.station_id:
        where.append(f"d.station_id = {p.add(q.station_id)}")
    rows = db.query(
        f"""SELECT d.station_id, s.code AS station_code, d.province_id, d.business_date, d.product_code, d.sales_volume_l, d.sales_amount,
                d.tx_count, d.opening_stock_l, d.closing_stock_l, d.deliveries_l, d.variance_l, d.avg_price
           FROM fms.daily_station_product d JOIN fms.stations s ON s.id = d.station_id
          WHERE {" AND ".join(where)}
          ORDER BY d.business_date, s.code, d.product_code LIMIT 50000""",
        p.values,
    )
    return {"items": rows, "next_cursor": None}


@router.get("/prices", summary="ERB caps in force (kind=erb_cap, default) or current station pump prices (kind=station)")
def prices(request: HttpRequest, q: Query[PricesQuery]):
    pr = _need(request, "prices:read")
    db = ro()
    if q.kind == "erb_cap":
        return {"items": caps_in_force(db, pr.province_id), "next_cursor": None}
    p = Params()
    rows = db.query(
        f"""SELECT s.id AS station_id, s.code AS station_code, s.province_id, g.pts_grade_id, g.name AS grade_name, g.product_code, g.price
           FROM fms.fuel_grades g JOIN fms.stations s ON s.id = g.station_id
          WHERE {station_scope(pr, p)} ORDER BY s.code, g.pts_grade_id""",
        p.values,
    )
    return {"items": rows, "next_cursor": None}


def _js_number(v: Any) -> Any:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return float("nan")
    return int(f) if f.is_integer() else f


@router.get("/alerts", summary="Alerts visible to the client")
def alerts(request: HttpRequest, q: Query[AlertsQuery]):
    pr = _need(request, "alerts:read")
    p = Params()
    where = [station_scope(pr, p)]
    if q.status == "open":
        where.append("a.acknowledged_at IS NULL")
    if q.severity:
        where.append(f"a.severity = {p.add(q.severity)}")
    if q.since:
        where.append(f"a.occurred_at >= {p.add(q.since)}::timestamptz")
    if q.cursor:
        c = decode_cursor(q.cursor)
        if not c or len(c) != 2:
            raise bad_request("invalid cursor", "invalid_cursor")
        where.append(f"(a.occurred_at, a.id) < ({p.add(str(c[0]))}::timestamptz, {p.add(_js_number(c[1]))}::bigint)")
    rows = ro().query(
        f"""SELECT {ALERT_COLUMNS}, to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _k
           FROM fms.alerts a JOIN fms.stations s ON s.id = a.station_id
          WHERE {" AND ".join(where)} ORDER BY a.occurred_at DESC, a.id DESC LIMIT {q.limit + 1}""",
        p.values,
    )
    more = len(rows) > q.limit
    page = rows[: q.limit]
    last = page[-1] if page else None
    items = [{k: v for k, v in r.items() if k not in ("_k", "acknowledged_by")} for r in page]
    return {"items": items, "next_cursor": encode_cursor([last["_k"], last["id"]]) if more and last else None}
