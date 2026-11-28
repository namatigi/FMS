"""Port of services/core-api/src/routes/stations.ts.

Also holds the small zod-compatible validation types (CoerceInt, JsonInt, JsonNum,
IsoDateTime, IsoDate, ...) that the other data routes (alerts, fiscal, regulator) reuse.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import re
import uuid
from typing import Annotated, Any, Literal

from django.http import HttpRequest
from ninja import Query, Router, Schema
from ninja.errors import ValidationError as NinjaValidationError
from pydantic import AfterValidator, BaseModel, BeforeValidator, Field, TypeAdapter, model_validator
from pydantic import ValidationError as PydanticValidationError

from ...common.db import Conn, primary, ro, tx
from ...common.errors import bad_request, not_found, unprocessable
from ...common.jsonutil import iso
from ...common.sqlutil import (
    LUSAKA_TODAY_START,
    Params,
    avg_daily_sales_cte,
    days_of_cover,
    decode_cursor,
    encode_cursor,
    round_,
)
from ..audit import audit
from ..auth import require_roles, require_user
from ..scope import assert_station_in_scope, station_id_scope, station_scope

router = Router(tags=["stations"])


# ------------------------------------------------------------ zod-compatible validation types


def js_number(v: Any) -> Any:
    """z.coerce.number(): JavaScript Number(v) for query-string values ('' -> 0, '1.0' -> 1)."""
    if isinstance(v, str):
        s = v.strip()
        if s == "":
            return 0
        if "_" in s:
            return float("nan")
        try:
            f = float(s)
        except ValueError:
            return float("nan")
        return int(f) if f.is_integer() else f
    return v


def _json_number(v: Any) -> Any:
    """z.number(): a JSON number only (no strings, no booleans)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError("Expected number")  # noqa: TRY004 - pydantic only converts ValueError
    if isinstance(v, float) and v.is_integer() and math.isfinite(v):
        return int(v)
    return v


_DATE_SRC = (
    r"((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])"
    r"|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))"
).replace(r"\d", "[0-9]")
# z.string().datetime({ offset: true })
_DATETIME_RE = re.compile(rf"^{_DATE_SRC}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?(Z|([+-][0-9]{{2}}:?[0-9]{{2}}))$")
_DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
_ZOD_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _check_datetime(v: str) -> str:
    if not _DATETIME_RE.match(v):
        raise ValueError("Invalid datetime")
    return v


def _check_date(v: str) -> str:
    if not _DATE_RE.match(v):
        raise ValueError("expected YYYY-MM-DD")
    return v


def _check_uuid(v: str) -> str:
    if not _ZOD_UUID_RE.match(v):
        raise ValueError("Invalid uuid")
    return v


CoerceInt = Annotated[int, BeforeValidator(js_number)]
JsonInt = Annotated[int, BeforeValidator(_json_number)]
JsonNum = Annotated[float, BeforeValidator(_json_number)]
IsoDateTime = Annotated[str, AfterValidator(_check_datetime)]
IsoDate = Annotated[str, AfterValidator(_check_date)]
UuidStr = Annotated[str, AfterValidator(_check_uuid)]


def validation_error(exc: PydanticValidationError, where: str) -> NinjaValidationError:
    errs = []
    for e in exc.errors(include_url=False, include_context=False):
        e = dict(e)
        e["loc"] = (where, *e.get("loc", ()))
        errs.append(e)
    return NinjaValidationError(errs)


_POS_INT = TypeAdapter(Annotated[int, BeforeValidator(js_number), Field(gt=0)])
_INT = TypeAdapter(Annotated[int, BeforeValidator(js_number)])


def path_int(value: str, positive: bool = True) -> int:
    """z.coerce.number().int()[.positive()] for a path parameter (400 validation_error when invalid)."""
    try:
        return (_POS_INT if positive else _INT).validate_python(value)
    except PydanticValidationError as e:
        raise validation_error(e, "id") from None


def parse_optional_body(request: HttpRequest, model: type[BaseModel]) -> BaseModel | None:
    """zod `.optional()` body: no body -> None, otherwise validated against `model`."""
    raw = request.body
    if not raw or not raw.strip():
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        raise bad_request("Body is not valid JSON", "bad_request") from None
    if data is None:
        return None
    try:
        return model.model_validate(data)
    except PydanticValidationError as e:
        raise validation_error(e, "body") from None


def js_num(v: Any) -> Any:
    """Integral floats as int, so JSON output matches JavaScript numbers (30 not 30.0)."""
    if isinstance(v, float) and v.is_integer() and abs(v) < 2**53:
        return int(v)
    return v


def js_str(v: Any) -> str:
    """JavaScript String(v) for values that came out of a decoded cursor."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        if math.isnan(v):
            return "NaN"
        if math.isinf(v):
            return "Infinity" if v > 0 else "-Infinity"
        return str(js_num(v))
    if isinstance(v, list):
        return ",".join("" if x is None else js_str(x) for x in v)
    if isinstance(v, dict):
        return "[object Object]"
    return str(v)


def js_number_param(v: Any) -> str:
    """`Number(v)` bound as a query parameter (node-postgres sends String(number))."""
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return js_str(float(v)) if isinstance(v, float) else str(v)
    if v is None:
        return "0"
    if isinstance(v, str):
        n = js_number(v)
        return js_str(float(n)) if isinstance(n, float) else str(n)
    return "NaN"


def keyset_cursor(cursor: str | None, p: Params, sql: str, id_cast: str = "bigint", id_as_number: bool = True) -> str | None:
    """`(ts, id) < (...)` predicate for an opaque [timestamp, id] cursor, or 400 invalid_cursor."""
    if not cursor:
        return None
    c = decode_cursor(cursor)
    if not c or len(c) != 2:
        raise bad_request("invalid cursor", "invalid_cursor")
    second = js_number_param(c[1]) if id_as_number else js_str(c[1])
    cast = f"::{id_cast}" if id_cast else ""
    return f"{sql} < ({p.add(js_str(c[0]))}::timestamptz, {p.add(second)}{cast})"


def page_of(rows: list[dict[str, Any]], limit: int, key: str = "_k") -> dict[str, Any]:
    more = len(rows) > limit
    page = rows[:limit]
    last = page[-1] if page else None
    items = [{k: v for k, v in r.items() if k != key} for r in page]
    return {"items": items, "next_cursor": encode_cursor([last[key], last["id"]]) if more and last else None}


# ------------------------------------------------------------ shared SQL

STATION_COLUMNS = """
  s.id, s.code, s.name, s.company_id, c.name AS company_name, s.province_id, p.name AS province_name,
  s.district, s.town, s.latitude, s.longitude, s.status, h.connectivity, h.controller_last_seen_at"""
STATION_FROM = """
  fms.stations s
  JOIN fms.companies c ON c.id = s.company_id
  JOIN fms.provinces p ON p.id = s.province_id
  JOIN fms.v_station_health h ON h.station_id = s.id"""


def station_tanks(db: Conn, station_id: str) -> list[dict[str, Any]]:
    """Tank state with days_of_cover for one station."""
    p = Params([station_id])
    rows = db.query(
        f"""WITH {avg_daily_sales_cte("SELECT $1::uuid")},
     prod_cap AS (SELECT product_code, sum(capacity_l) AS cap FROM fms.tanks WHERE station_id = $1 GROUP BY product_code)
     SELECT t.tank_no, t.product_code, t.capacity_l, tl.product_volume_l, tl.ullage_l, tl.water_height_mm, tl.temperature_c,
            round(100 * tl.product_volume_l / nullif(t.capacity_l, 0), 1) AS fill_pct,
            tl.measured_at, tl.probe_status, coalesce(tl.alarms, '{{}}') AS alarms,
            -- product-level average, apportioned to tanks of that product by capacity share
            coalesce(a.avg_daily_l * t.capacity_l / nullif(pc.cap, 0), 0) AS avg_daily_sales_l,
            t.low_level_l
       FROM fms.tanks t
       LEFT JOIN fms.tank_latest tl ON tl.station_id = t.station_id AND tl.tank_no = t.tank_no
       LEFT JOIN avg_sales a ON a.station_id = t.station_id AND a.product_code = t.product_code
       LEFT JOIN prod_cap pc ON pc.product_code = t.product_code
      WHERE t.station_id = $1
      ORDER BY t.tank_no""",
        p.values,
    )
    return [
        {
            **r,
            "avg_daily_sales_l": round_(r["avg_daily_sales_l"]),
            "days_of_cover": days_of_cover(r["product_volume_l"], r["avg_daily_sales_l"]),
        }
        for r in rows
    ]


def station_pumps(db: Conn, station_id: str) -> list[dict[str, Any]]:
    """Pumps with their nozzles and electronic totalisers.

    PTS-2 reports the nozzle's non-resettable volume and amount totalisers with every sale
    (pump_transactions.total_volume_l / total_amount), so the current totaliser is the one on
    the nozzle's latest sale. Pumps come from the nozzle configuration plus any pump/nozzle that
    sold in the last 30 days (configured=false flags the latter).
    """
    rows = db.query(
        f"""WITH configured AS (
       SELECT n.pump_no, n.nozzle_no, fg.pts_grade_id, fg.name AS grade_name, fg.product_code, fg.price, t.tank_no
         FROM fms.nozzles n
         LEFT JOIN fms.fuel_grades fg ON fg.id = n.fuel_grade_id
         LEFT JOIN fms.tanks t ON t.id = n.tank_id
        WHERE n.station_id = $1),
     seen AS (
       SELECT DISTINCT pump_no, nozzle_no FROM fms.pump_transactions
        WHERE station_id = $1 AND ended_at >= now() - interval '30 days'),
     keys AS (SELECT pump_no, nozzle_no FROM configured UNION SELECT pump_no, nozzle_no FROM seen),
     today AS (
       SELECT pump_no, nozzle_no, sum(volume_l) AS vol, sum(amount) AS amt, count(*) AS n
         FROM fms.pump_transactions
        WHERE station_id = $1 AND ended_at >= {LUSAKA_TODAY_START}
        GROUP BY 1, 2)
     SELECT k.pump_no, k.nozzle_no, (c.pump_no IS NOT NULL) AS configured,
            c.pts_grade_id, c.grade_name,
            coalesce(c.product_code, lt.product_code) AS product_code,
            coalesce(c.tank_no, lt.tank_no) AS tank_no,
            coalesce(c.price, lt.price) AS price,
            lt.total_volume_l, lt.total_amount, lt.ended_at AS last_sale_at,
            coalesce(td.vol, 0) AS today_volume_l, coalesce(td.amt, 0) AS today_amount, coalesce(td.n, 0) AS today_tx
       FROM keys k
       LEFT JOIN configured c USING (pump_no, nozzle_no)
       LEFT JOIN LATERAL (
         SELECT x.product_code, x.tank_no, x.price, x.total_volume_l, x.total_amount, x.ended_at
           FROM fms.pump_transactions x
          WHERE x.station_id = $1 AND x.pump_no = k.pump_no AND x.nozzle_no = k.nozzle_no
          ORDER BY x.ended_at DESC
          LIMIT 1) lt ON TRUE
       LEFT JOIN today td USING (pump_no, nozzle_no)
      ORDER BY k.pump_no, k.nozzle_no""",
        [station_id],
    )
    pumps: dict[int, dict[str, Any]] = {}
    for r in rows:
        p = pumps.setdefault(
            r["pump_no"],
            {
                "pump_no": r["pump_no"],
                "configured": False,
                "last_sale_at": None,
                "today_volume_l": 0,
                "today_amount": 0,
                "today_tx": 0,
                "nozzles": [],
            },
        )
        p["configured"] = p["configured"] or r["configured"]
        if r["last_sale_at"] and (p["last_sale_at"] is None or r["last_sale_at"] > p["last_sale_at"]):
            p["last_sale_at"] = r["last_sale_at"]
        p["today_volume_l"] = round_(p["today_volume_l"] + r["today_volume_l"])
        p["today_amount"] = round_(p["today_amount"] + r["today_amount"], 2)
        p["today_tx"] += r["today_tx"]
        p["nozzles"].append({k: v for k, v in r.items() if k != "pump_no"})
    return list(pumps.values())


# ------------------------------------------------------------ schemas


def _limit(default: int, maximum: int):
    return Field(default, ge=1, le=maximum)


class StationsQuery(Schema):
    province_id: CoerceInt | None = None
    company_id: UuidStr | None = None
    q: str | None = Field(None, max_length=100)
    status: str | None = None
    limit: CoerceInt = _limit(200, 1000)
    cursor: str | None = None


class TransactionsQuery(Schema):
    from_: IsoDateTime | None = Field(None, alias="from")
    to: IsoDateTime | None = None
    pump_no: CoerceInt | None = None
    product_code: str | None = None
    fiscal_status: Literal["pending", "signed", "failed", "exempt"] | None = None
    limit: CoerceInt = _limit(50, 500)
    cursor: str | None = None


class SalesSummaryQuery(Schema):
    from_: IsoDateTime | None = Field(None, alias="from")
    to: IsoDateTime | None = None
    group: Literal["hour", "day", "product", "pump"] = "hour"


class DeliveriesQuery(Schema):
    from_: IsoDateTime | None = Field(None, alias="from")
    to: IsoDateTime | None = None
    limit: CoerceInt = _limit(100, 500)
    cursor: str | None = None


class CommandsQuery(Schema):
    status: Literal["queued", "delivered", "received", "applied", "partial", "failed", "expired", "cancelled"] | None = None
    limit: CoerceInt = _limit(50, 200)
    cursor: str | None = None


class ReconciliationQuery(Schema):
    from_: IsoDate | None = Field(None, alias="from")
    to: IsoDate | None = None


class DeliveryPatch(Schema):
    delivery_note_no: str | None = Field(None, max_length=100)
    supplier: str | None = Field(None, max_length=200)
    invoiced_volume_l: JsonNum | None = Field(None, ge=0, le=1e7)

    @model_validator(mode="after")
    def _at_least_one(self):
        if not self.model_fields_set:
            raise ValueError("at least one field is required")
        return self


class PriceItem(Schema):
    pts_grade_id: JsonInt = Field(..., ge=0)
    price: JsonNum = Field(..., gt=0, le=10000)


class PricesBody(Schema):
    prices: list[PriceItem] = Field(..., min_length=1, max_length=50)
    effective_at: IsoDateTime | None = None


# ------------------------------------------------------------ list


@router.get("/stations", summary="Stations visible to the caller")
def list_stations(request: HttpRequest, q: Query[StationsQuery]):
    pr = require_user(request)
    p = Params()
    where = [station_scope(pr, p)]
    if q.province_id is not None:
        where.append(f"s.province_id = {p.add(q.province_id)}")
    if q.company_id:
        where.append(f"s.company_id = {p.add(q.company_id)}")
    if q.status:
        where.append(f"s.status = {p.add(q.status)}")
    if q.q:
        like = p.add("%" + re.sub(r"[%_\\]", lambda m: "\\" + m.group(0), q.q) + "%")
        where.append(f"(s.code ILIKE {like} OR s.name ILIKE {like} OR s.town ILIKE {like} OR s.district ILIKE {like})")
    cur = decode_cursor(q.cursor)
    if cur is not None:  # an empty array is truthy in JavaScript
        where.append(f"s.code > {p.add(js_str(cur[0]) if cur else 'undefined')}")
    rows = ro().query(
        f"SELECT {STATION_COLUMNS} FROM {STATION_FROM} WHERE {' AND '.join(where)} ORDER BY s.code LIMIT {q.limit + 1}",
        p.values,
    )
    more = len(rows) > q.limit
    items = rows[: q.limit]
    return {"items": items, "next_cursor": encode_cursor([items[-1]["code"]]) if more else None}


# ------------------------------------------------------------ detail


@router.get("/stations/{id}", summary="Station detail")
def station_detail(request: HttpRequest, id: str):
    pr = require_user(request)
    db = ro()
    assert_station_in_scope(db, pr, id)
    st = db.query(
        f"""SELECT {STATION_COLUMNS}, s.address, s.timezone, s.erb_licence_no, s.zra_branch_id, s.connection_mode, s.created_at
           FROM {STATION_FROM} WHERE s.id = $1""",
        [id],
    )
    tanks = station_tanks(db, id)
    grades = db.query(
        "SELECT id, pts_grade_id, name, product_code, zra_item_code, price FROM fms.fuel_grades WHERE station_id = $1 ORDER BY pts_grade_id",
        [id],
    )
    nozzles = db.query(
        """SELECT n.id, n.pump_no, n.nozzle_no, fg.pts_grade_id, fg.product_code, t.tank_no
           FROM fms.nozzles n LEFT JOIN fms.fuel_grades fg ON fg.id = n.fuel_grade_id LEFT JOIN fms.tanks t ON t.id = n.tank_id
          WHERE n.station_id = $1 ORDER BY n.pump_no, n.nozzle_no""",
        [id],
    )
    health = db.query(
        """SELECT h.connectivity, h.controller_last_seen_at, h.gateway_last_seen_at, h.gateway_backlog,
                (SELECT count(*)::int FROM fms.alerts a WHERE a.station_id = $1 AND a.acknowledged_at IS NULL) AS open_alerts,
                (SELECT count(*)::int FROM fms.pump_transactions pt WHERE pt.station_id = $1 AND pt.fiscal_status IN ('pending','failed')
                   AND pt.ended_at >= now() - interval '30 days') AS fiscal_backlog,
                (SELECT json_agg(json_build_object('pts_id', c.pts_id, 'firmware', c.firmware, 'last_seen_at', c.last_seen_at) ORDER BY c.pts_id)
                   FROM fms.controllers c WHERE c.station_id = $1) AS controllers,
                (SELECT json_agg(json_build_object('gateway_code', g.gateway_code, 'role', g.role, 'version', g.version,
                                                   'last_seen_at', g.last_seen_at, 'last_backlog', g.last_backlog) ORDER BY g.gateway_code)
                   FROM fms.edge_gateways g WHERE g.station_id = $1) AS gateways
           FROM fms.v_station_health h WHERE h.station_id = $1""",
        [id],
    )
    h = health[0] if health else {}
    return {
        **(st[0] if st else {}),
        "tanks": tanks,
        "fuel_grades": grades,
        "nozzles": nozzles,
        "health": {**h, "controllers": h.get("controllers") or [], "gateways": h.get("gateways") or []},
    }


# ------------------------------------------------------------ tanks


@router.get("/stations/{id}/tanks", summary="Live tank state with days of cover (array)")
def station_tanks_route(request: HttpRequest, id: str):
    pr = require_user(request)
    db = ro()
    assert_station_in_scope(db, pr, id)
    return station_tanks(db, id)


@router.get("/stations/{id}/pumps", summary="Pumps with nozzles, electronic totalisers (from the latest sale) and today's sales (array)")
def station_pumps_route(request: HttpRequest, id: str):
    pr = require_user(request)
    db = ro()
    assert_station_in_scope(db, pr, id)
    return station_pumps(db, id)


# ------------------------------------------------------------ transactions (keyset)


@router.get("/stations/{id}/transactions", summary="Pump transactions, newest first, keyset-paginated")
def station_transactions(request: HttpRequest, id: str, q: Query[TransactionsQuery]):
    pr = require_user(request)
    db = ro()
    assert_station_in_scope(db, pr, id)
    p = Params([id])
    where = ["pt.station_id = $1"]
    if q.from_:
        where.append(f"pt.ended_at >= {p.add(q.from_)}::timestamptz")
    if q.to:
        where.append(f"pt.ended_at < {p.add(q.to)}::timestamptz")
    if q.pump_no is not None:
        where.append(f"pt.pump_no = {p.add(q.pump_no)}")
    if q.product_code:
        where.append(f"pt.product_code = {p.add(q.product_code)}")
    if q.fiscal_status:
        where.append(f"pt.fiscal_status = {p.add(q.fiscal_status)}")
    kc = keyset_cursor(q.cursor, p, "(pt.ended_at, pt.id)")
    if kc:
        where.append(kc)
    rows = db.query(
        f"""SELECT pt.id, pt.ended_at, pt.pump_no, pt.nozzle_no, pt.product_code, pt.volume_l, pt.price, pt.amount, pt.tag,
                pt.fiscal_status, fr.zra_rcpt_no, pt.pts_transaction_no, pt.tank_no,
                to_char(pt.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _k
           FROM fms.pump_transactions pt
           LEFT JOIN fms.fiscal_receipts fr ON fr.station_id = pt.station_id AND fr.pump_no = pt.pump_no
                 AND fr.pts_transaction_no = pt.pts_transaction_no AND fr.tx_ended_at = pt.ended_at
          WHERE {" AND ".join(where)}
          ORDER BY pt.ended_at DESC, pt.id DESC
          LIMIT {q.limit + 1}""",
        p.values,
    )
    return page_of(rows, q.limit)


# ------------------------------------------------------------ sales summary


@router.get("/stations/{id}/sales/summary", summary="Sales grouped by hour|day|product|pump (Africa/Lusaka buckets; array)")
def station_sales_summary(request: HttpRequest, id: str, q: Query[SalesSummaryQuery]):
    pr = require_user(request)
    db = ro()
    st = assert_station_in_scope(db, pr, id)
    p = Params([id])
    frm = f"{p.add(q.from_)}::timestamptz" if q.from_ else LUSAKA_TODAY_START
    to = f"{p.add(q.to)}::timestamptz" if q.to else "now() + interval '1 second'"

    # Only bind the timezone when the bucket expression uses it.
    def tz_of() -> str:
        return p.add(st.get("timezone") or "Africa/Lusaka")

    extra = ""
    if q.group == "hour":
        bucket, group_by = f"date_trunc('hour', pt.ended_at, {tz_of()})", "1, 2"
    elif q.group == "day":
        bucket, group_by = f"to_char(pt.ended_at AT TIME ZONE {tz_of()}, 'YYYY-MM-DD')", "1, 2"
    elif q.group == "product":
        bucket, group_by = "pt.product_code", "1, 2"
    else:
        bucket, extra, group_by = "pt.pump_no::text", ", pt.pump_no", "1, 2, pump_no"
    rows = db.query(
        f"""SELECT {bucket} AS bucket, pt.product_code{extra},
                sum(pt.volume_l) AS volume_l, sum(pt.amount) AS amount, count(*)::int AS tx_count
           FROM fms.pump_transactions pt
          WHERE pt.station_id = $1 AND pt.ended_at >= {frm} AND pt.ended_at < {to}
          GROUP BY {group_by}
          ORDER BY {"pump_no, 2" if q.group == "pump" else "1, 2"}""",
        p.values,
    )
    return [
        {
            **r,
            "bucket": iso(r["bucket"]) if isinstance(r["bucket"], dt.datetime) else r["bucket"],
            "volume_l": round_(r["volume_l"]),
            "amount": round_(r["amount"], 2),
        }
        for r in rows
    ]


# ------------------------------------------------------------ deliveries


@router.get("/stations/{id}/deliveries", summary="In-tank deliveries")
def station_deliveries(request: HttpRequest, id: str, q: Query[DeliveriesQuery]):
    pr = require_user(request)
    db = ro()
    assert_station_in_scope(db, pr, id)
    p = Params([id])
    where = ["d.station_id = $1"]
    if q.from_:
        where.append(f"d.ended_at >= {p.add(q.from_)}::timestamptz")
    if q.to:
        where.append(f"d.ended_at < {p.add(q.to)}::timestamptz")
    kc = keyset_cursor(q.cursor, p, "(d.ended_at, d.id)")
    if kc:
        where.append(kc)
    rows = db.query(
        f"""SELECT d.id, d.station_id, d.tank_no, d.product_code, d.started_at, d.ended_at, d.start_volume_l, d.end_volume_l,
                d.received_volume_l, d.start_tc_volume_l, d.end_tc_volume_l, d.start_height_mm, d.end_height_mm,
                d.start_water_mm, d.end_water_mm, d.start_temperature_c, d.end_temperature_c,
                d.delivery_note_no, d.supplier, d.invoiced_volume_l,
                CASE WHEN d.invoiced_volume_l IS NOT NULL THEN d.received_volume_l - d.invoiced_volume_l END AS shortfall_l,
                d.received_at,
                to_char(d.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _k
           FROM fms.tank_deliveries d WHERE {" AND ".join(where)}
          ORDER BY d.ended_at DESC, d.id DESC LIMIT {q.limit + 1}""",
        p.values,
    )
    return page_of(rows, q.limit)


@router.get(
    "/stations/{id}/commands",
    summary="Commands sent to the station edge gateway (e.g. price updates) and their acknowledgement status",
)
def station_commands(request: HttpRequest, id: str, q: Query[CommandsQuery]):
    pr = require_user(request)
    db = ro()
    assert_station_in_scope(db, pr, id)
    p = Params([id])
    where = ["e.station_id = $1"]
    if q.status:
        where.append(f"e.status = {p.add(q.status)}")
    kc = keyset_cursor(q.cursor, p, "(e.created_at, e.id)", id_cast="", id_as_number=False)
    if kc:
        where.append(kc)
    rows = db.query(
        f"""SELECT e.id, e.type, e.status, e.command, e.created_at, u.full_name AS created_by_name,
                e.delivery_count, e.first_delivered_at, e.last_delivered_at, e.delivered_via,
                e.received_at, e.completed_at, e.expires_at, e.result,
                to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _k
           FROM fms.edge_commands e LEFT JOIN fms.users u ON u.id = e.created_by
          WHERE {" AND ".join(where)}
          ORDER BY e.created_at DESC, e.id DESC LIMIT {q.limit + 1}""",
        p.values,
    )
    return page_of(rows, q.limit)


@router.patch("/deliveries/{id}", summary="Reconcile a delivery with its paperwork (owner, manager)")
def patch_delivery(request: HttpRequest, id: str, body: DeliveryPatch):
    delivery_id = path_int(id)  # params are validated before the auth preHandler, as in Fastify
    pr = require_user(request)
    require_roles(request, "owner", "manager", "platform_admin")
    b = body.model_dump(include=body.model_fields_set)
    changes = {k: js_num(v) for k, v in b.items()}
    with tx() as c:
        p = Params([delivery_id])
        sets = [f"{k} = {p.add(changes[k])}" for k in ("delivery_note_no", "supplier", "invoiced_volume_l") if k in changes]
        rows = c.query(
            f"""UPDATE fms.tank_deliveries SET {", ".join(sets)}
            WHERE id = $1 AND {station_id_scope(pr, p)}
            RETURNING id, station_id, tank_no, product_code, started_at, ended_at, received_volume_l, delivery_note_no, supplier, invoiced_volume_l""",
            p.values,
        )
        if not rows:
            raise not_found("delivery")
        audit(
            c,
            request,
            "delivery.update",
            entity="tank_delivery",
            entity_id=delivery_id,
            details={"changes": changes, "station_id": rows[0]["station_id"]},
        )
        return rows[0]


# ------------------------------------------------------------ reconciliation


@router.get("/stations/{id}/reconciliation", summary="daily_station_product rows (book vs. physical stock)")
def station_reconciliation(request: HttpRequest, id: str, q: Query[ReconciliationQuery]):
    pr = require_user(request)
    db = ro()
    assert_station_in_scope(db, pr, id)
    p = Params([id])
    frm = f"{p.add(q.from_)}::date" if q.from_ else "((now() AT TIME ZONE 'Africa/Lusaka')::date - 30)"
    to = f"{p.add(q.to)}::date" if q.to else "(now() AT TIME ZONE 'Africa/Lusaka')::date"
    rows = db.query(
        f"""SELECT station_id, business_date, product_code, province_id, sales_volume_l, sales_amount, tx_count,
                opening_stock_l, closing_stock_l, deliveries_l, variance_l,
                CASE WHEN sales_volume_l > 0 AND variance_l IS NOT NULL THEN round(100 * variance_l / sales_volume_l, 3) END AS variance_pct,
                avg_price, computed_at
           FROM fms.daily_station_product
          WHERE station_id = $1 AND business_date >= {frm} AND business_date <= {to}
          ORDER BY business_date DESC, product_code""",
        p.values,
    )
    return {"items": rows, "next_cursor": None}


# ------------------------------------------------------------ prices


class _AboveCap(Exception):
    def __init__(self, violations: list[dict[str, Any]]) -> None:
        super().__init__("price above cap")
        self.violations = violations


def _parse_ts(s: str) -> dt.datetime:
    """new Date(iso) for strings that passed IsoDateTime (offset may lack the colon)."""
    m = re.match(r"^(.*?)([+-])(\d{2})(\d{2})$", s)
    if m and "T" in m.group(1):
        s = f"{m.group(1)}{m.group(2)}{m.group(3)}:{m.group(4)}"
    v = dt.datetime.fromisoformat(s)
    return v.replace(microsecond=v.microsecond // 1000 * 1000)


@router.put("/stations/{id}/prices", summary="Set pump prices (validated against ERB cap); queues an edge set_prices command")
def put_prices(request: HttpRequest, id: str, body: PricesBody):
    pr = require_user(request)
    require_roles(request, "owner", "platform_admin")
    st = assert_station_in_scope(primary, pr, id)
    prices = [{"pts_grade_id": x.pts_grade_id, "price": js_num(x.price)} for x in body.prices]
    ids = [x["pts_grade_id"] for x in prices]
    if len(set(ids)) != len(ids):
        raise bad_request("duplicate pts_grade_id")
    effective_at = iso(_parse_ts(body.effective_at) if body.effective_at else dt.datetime.now(dt.UTC))

    try:
        with tx() as c:
            grades = c.query(
                "SELECT id, pts_grade_id, product_code, price FROM fms.fuel_grades WHERE station_id = $1 AND pts_grade_id = ANY($2::int[]) FOR UPDATE",
                [st["id"], ids],
            )
            by_id = {g["pts_grade_id"]: g for g in grades}
            missing = [i for i in ids if i not in by_id]
            if missing:
                raise unprocessable(f"unknown pts_grade_id(s): {', '.join(str(i) for i in missing)}", "unknown_grade")

            products = list(dict.fromkeys(g["product_code"] for g in grades))
            caps = c.query(
                """SELECT DISTINCT ON (product_code) product_code, price, province_id
             FROM fms.price_changes
            WHERE kind = 'erb_cap' AND product_code = ANY($1::text[]) AND (province_id = $2 OR province_id IS NULL)
              AND effective_at <= greatest(now(), $3::timestamptz)
            ORDER BY product_code, (province_id IS NULL), effective_at DESC, id DESC""",
                [products, st["province_id"], effective_at],
            )
            cap_by = {x["product_code"]: x["price"] for x in caps}
            violations = []
            for x in prices:
                code = by_id[x["pts_grade_id"]]["product_code"]
                cap = cap_by.get(code)
                if cap is not None and x["price"] > cap:
                    violations.append({**x, "product_code": code, "cap": cap})
            if violations:
                # Raised out of the transaction: the TS service wrote this audit row on a separate
                # pool connection, so it survives the rollback. Written after the rollback below.
                raise _AboveCap(violations)

            out = []
            for x in prices:
                g = by_id[x["pts_grade_id"]]
                c.execute(
                    """INSERT INTO fms.price_changes (product_code, station_id, province_id, price, kind, effective_at, created_by)
             VALUES ($1, $2, $3, $4, 'station', $5, $6)""",
                    [g["product_code"], st["id"], st["province_id"], x["price"], effective_at, pr.id],
                )
                c.execute("UPDATE fms.fuel_grades SET price = $2 WHERE id = $1", [g["id"], x["price"]])
                out.append(
                    {
                        "pts_grade_id": x["pts_grade_id"],
                        "product_code": g["product_code"],
                        "price": x["price"],
                        "previous_price": g["price"],
                        "cap": cap_by.get(g["product_code"]),
                    }
                )
            command = {"id": str(uuid.uuid4()), "type": "set_prices", "prices": prices, "effective_at": effective_at}
            # Delivered to the station's edge gateway with acknowledgement (see db/migrations/005_edge_commands.sql).
            c.execute(
                "INSERT INTO fms.edge_commands (id, station_id, type, command, created_by) VALUES ($1, $2, 'set_prices', $3, $4)",
                [command["id"], st["id"], json.dumps(command, separators=(",", ":")), pr.id],
            )
            audit(
                c,
                request,
                "price.station_set",
                entity="station",
                entity_id=st["id"],
                details={"prices": out, "effective_at": command["effective_at"], "command_id": command["id"]},
            )
            return {
                "station_id": st["id"],
                "effective_at": command["effective_at"],
                "command_id": command["id"],
                "command_status": "queued",
                "prices": out,
            }
    except _AboveCap as e:
        audit(primary, request, "price.rejected_above_cap", entity="station", entity_id=st["id"], details={"violations": e.violations})
        raise unprocessable(
            "; ".join(f"{v['product_code']} price {js_str(v['price'])} exceeds ERB cap {js_str(v['cap'])}" for v in e.violations),
            "price_above_cap",
        ) from None


__all__ = [
    "STATION_COLUMNS",
    "STATION_FROM",
    "CoerceInt",
    "IsoDate",
    "IsoDateTime",
    "JsonInt",
    "JsonNum",
    "UuidStr",
    "router",
    "station_tanks",
]
