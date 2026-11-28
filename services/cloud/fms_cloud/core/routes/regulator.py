"""Port of services/core-api/src/routes/regulator.ts (mounted under /api/v1/regulator)."""

from __future__ import annotations

import datetime as dt
import re
from collections.abc import Callable
from typing import Any, Literal

from django.http import HttpRequest, HttpResponse
from ninja import Query, Router, Schema
from pydantic import Field

from ...common.db import Conn, primary, ro
from ...common.errors import not_found
from ...common.jsonutil import iso, json_response
from ...common.sqlutil import Params, avg_daily_sales_cte, days_of_cover, round_
from ..audit import audit
from ..auth import REGULATOR_ROLES, require_roles, require_user
from ..scope import Principal, regulator_province, station_scope
from .stations import CoerceInt, IsoDate, IsoDateTime, JsonInt, JsonNum, js_num, js_str, path_int

router = Router(tags=["regulator"])

ProvinceQ = CoerceInt | None


def _province_field():
    return Field(None, ge=1, le=99)


def scoped_stations_sql(pr: Principal, p: Params, province: int | None) -> str:
    """Scoped station sub-select (id, province_id) honouring role scope + forced province."""
    where = [station_scope(pr, p)]
    if province is not None:
        where.append(f"s.province_id = {p.add(province)}")
    return f"SELECT s.id, s.province_id FROM fms.stations s WHERE {' AND '.join(where)}"


def product_position(db: Conn, pr: Principal, province: int | None, by_province: bool) -> list[dict[str, Any]]:
    """Product position (stock, capacity, 24h sales, avg daily sales) nationally or by province."""
    p = Params()
    sc = scoped_stations_sql(pr, p, province)
    g = "province_id, " if by_province else ""
    gb = "1, 2" if by_province else "1"
    rows = db.query(
        f"""WITH sc AS ({sc}),
     {avg_daily_sales_cte("SELECT id FROM sc")},
     stock AS (
       SELECT {"ss.province_id, " if by_province else ""}ss.product_code, sum(ss.product_volume_l) AS stock_l, sum(ss.capacity_l) AS capacity_l
         FROM fms.v_station_stock ss WHERE ss.station_id IN (SELECT id FROM sc) GROUP BY {gb}),
     s24 AS (
       SELECT {"sc.province_id, " if by_province else ""}pt.product_code, sum(pt.volume_l) AS sales_24h_l
         FROM fms.pump_transactions pt JOIN sc ON sc.id = pt.station_id
        WHERE pt.ended_at >= now() - interval '24 hours' AND pt.product_code IS NOT NULL GROUP BY {gb}),
     av AS (
       SELECT {"sc.province_id, " if by_province else ""}a.product_code, sum(a.avg_daily_l) AS avg_daily_l
         FROM avg_sales a JOIN sc ON sc.id = a.station_id GROUP BY {gb})
     SELECT {g}product_code, coalesce(stock.stock_l, 0) AS stock_l, coalesce(stock.capacity_l, 0) AS capacity_l,
            coalesce(s24.sales_24h_l, 0) AS sales_24h_l, coalesce(av.avg_daily_l, 0) AS avg_daily_l
       FROM stock FULL JOIN s24 USING ({g}product_code) FULL JOIN av USING ({g}product_code)
      ORDER BY {g}product_code""",
        p.values,
    )
    out = []
    for r in rows:
        item: dict[str, Any] = {"province_id": r["province_id"]} if by_province else {}
        item.update(
            {
                "product_code": r["product_code"],
                "stock_l": round_(r["stock_l"]) or 0,
                "capacity_l": round_(r["capacity_l"]) or 0,
                "sales_24h_l": round_(r["sales_24h_l"]) or 0,
                "avg_daily_sales_l": round_(r["avg_daily_l"]) or 0,
                "days_of_cover": days_of_cover(r["stock_l"], r["avg_daily_l"]),
            }
        )
        out.append(item)
    return out


def caps_in_force(db: Conn, province: int | None) -> list[dict[str, Any]]:
    """ERB caps in force now: province-specific rows plus national rows (province_id NULL)."""
    p = Params()
    prov_filter = f"AND (pc.province_id IS NULL OR pc.province_id = {p.add(province)})" if province is not None else ""
    return db.query(
        f"""SELECT DISTINCT ON (pc.product_code, pc.province_id)
            pc.id, pc.product_code, pr.name AS product_name, pc.province_id, pv.name AS province_name, pc.price, pc.effective_at, pc.created_at
       FROM fms.price_changes pc
       JOIN fms.products pr ON pr.code = pc.product_code
       LEFT JOIN fms.provinces pv ON pv.id = pc.province_id
      WHERE pc.kind = 'erb_cap' AND pc.effective_at <= now() {prov_filter}
      ORDER BY pc.product_code, pc.province_id NULLS FIRST, pc.effective_at DESC, pc.id DESC""",
        p.values,
    )


def cap_for(station_alias: str, product_expr: str) -> str:
    """SQL for the cap applicable to a station/product (province-specific overrides national)."""
    return f"""(
  SELECT c.price FROM fms.price_changes c
   WHERE c.kind = 'erb_cap' AND c.product_code = {product_expr} AND c.effective_at <= now()
     AND (c.province_id = {station_alias}.province_id OR c.province_id IS NULL)
   ORDER BY (c.province_id IS NULL), c.effective_at DESC, c.id DESC LIMIT 1)"""


_CSV_SPECIAL = re.compile(r'[",\r\n]')


def csv_escape(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, (dt.datetime, dt.date)):
        s = iso(v) or ""
    elif isinstance(v, (int, float, bool)):
        s = js_str(v)
    else:
        s = str(v)
    return '"' + s.replace('"', '""') + '"' if _CSV_SPECIAL.search(s) else s


def _auth(request: HttpRequest) -> Principal:
    return require_user(request, REGULATOR_ROLES)


def _prov(pr: Principal, requested: int | None = None) -> int | None:
    return regulator_province(pr, requested)


# ------------------------------------------------------------ schemas


class ProvinceQuery(Schema):
    province_id: ProvinceQ = _province_field()


class SalesDailyQuery(Schema):
    from_: IsoDate | None = Field(None, alias="from")
    to: IsoDate | None = None
    province_id: ProvinceQ = _province_field()
    product_code: str | None = None


class CapBody(Schema):
    product_code: str = Field(..., min_length=1, max_length=20)
    province_id: JsonInt | None = Field(None, ge=1, le=99)
    price: JsonNum = Field(..., gt=0, le=10000)
    effective_at: IsoDateTime | None = None


class ExportQuery(Schema):
    date: IsoDate | None = None
    province_id: ProvinceQ = _province_field()
    format: Literal["csv", "json"] = "csv"


# ------------------------------------------------------------ routes


@router.get("/overview", summary="National (or own-province) fuel position")
def overview(request: HttpRequest, q: Query[ProvinceQuery]):
    pr = _auth(request)
    db = ro()
    province = _prov(pr, q.province_id)
    p = Params()
    sc = scoped_stations_sql(pr, p, province)
    p2 = Params()
    sc2 = scoped_stations_sql(pr, p2, province)
    by_product = product_position(db, pr, province, False)
    st = db.query(
        f"""SELECT count(*)::int AS total, count(*) FILTER (WHERE h.connectivity = 'online')::int AS online
           FROM fms.v_station_health h WHERE h.station_id IN (SELECT id FROM ({sc}) x)""",
        p.values,
    )
    al = db.query(
        f"SELECT count(*)::int AS n FROM fms.alerts WHERE acknowledged_at IS NULL AND station_id IN (SELECT id FROM ({sc2}) x)",
        p2.values,
    )
    total = st[0]["total"] if st else 0
    online = st[0]["online"] if st else 0
    return {
        "province_id": province,
        "by_product": by_product,
        "stations": {"total": total, "online": online, "offline": total - online},
        "alerts_open": al[0]["n"] if al else 0,
    }


@router.get("/provinces", summary="Per-province position (array)")
def provinces(request: HttpRequest):
    pr = _auth(request)
    db = ro()
    province = _prov(pr, None)
    p = Params()
    sc = scoped_stations_sql(pr, p, province)
    p2 = Params()
    prov_filter = f"WHERE pv.id = {p2.add(province)}" if province is not None else ""
    pos = product_position(db, pr, province, True)
    counts = db.query(
        f"""SELECT x.province_id, count(*)::int AS stations, count(*) FILTER (WHERE h.connectivity = 'online')::int AS online
           FROM ({sc}) x JOIN fms.v_station_health h ON h.station_id = x.id GROUP BY x.province_id""",
        p.values,
    )
    provs = db.query(f"SELECT pv.id, pv.name FROM fms.provinces pv {prov_filter} ORDER BY pv.id", p2.values)
    cnt = {r["province_id"]: r for r in counts}
    return [
        {
            "province_id": pv["id"],
            "province_name": pv["name"],
            "stations": cnt[pv["id"]]["stations"] if pv["id"] in cnt else 0,
            "online": cnt[pv["id"]]["online"] if pv["id"] in cnt else 0,
            "by_product": [{k: v for k, v in x.items() if k != "province_id"} for x in pos if x["province_id"] == pv["id"]],
        }
        for pv in provs
    ]


@router.get("/provinces/{id}/stations", summary="Stations of a province with stock and prices (array)")
def province_stations(request: HttpRequest, id: str):
    province_id = path_int(id, positive=False)
    pr = _auth(request)
    forced = _prov(pr, province_id)
    if forced != province_id:
        raise not_found("province")
    p = Params()
    sc = scoped_stations_sql(pr, p, province_id)
    # json_agg returns NUMERIC as JSON numbers already
    return ro().query(
        f"""SELECT s.id AS station_id, s.code, s.name, c.name AS company_name, h.connectivity, h.controller_last_seen_at, s.status,
                coalesce((SELECT json_agg(json_build_object('product_code', ss.product_code, 'stock_l', ss.product_volume_l,
                                   'capacity_l', ss.capacity_l, 'latest_reading_at', ss.latest_reading_at) ORDER BY ss.product_code)
                            FROM fms.v_station_stock ss WHERE ss.station_id = s.id), '[]') AS stock,
                coalesce((SELECT json_agg(json_build_object('product_code', g.product_code, 'price', g.price) ORDER BY g.product_code)
                            FROM (SELECT product_code, max(price) AS price FROM fms.fuel_grades WHERE station_id = s.id GROUP BY product_code) g), '[]') AS last_price
           FROM fms.stations s
           JOIN fms.companies c ON c.id = s.company_id
           JOIN fms.v_station_health h ON h.station_id = s.id
          WHERE s.id IN (SELECT id FROM ({sc}) x)
          ORDER BY s.code""",
        p.values,
    )


@router.get("/sales/daily", summary="Daily sales per province × product (v_province_daily shape)")
def sales_daily(request: HttpRequest, q: Query[SalesDailyQuery]):
    pr = _auth(request)
    province = _prov(pr, q.province_id)
    p = Params()
    sc = scoped_stations_sql(pr, p, province)
    where = [f"d.station_id IN (SELECT id FROM ({sc}) x)"]
    where.append(
        f"d.business_date >= {p.add(q.from_)}::date" if q.from_ else "d.business_date >= (now() AT TIME ZONE 'Africa/Lusaka')::date - 30"
    )
    if q.to:
        where.append(f"d.business_date <= {p.add(q.to)}::date")
    if q.product_code:
        where.append(f"d.product_code = {p.add(q.product_code)}")
    # Same columns as fms.v_province_daily, computed over scoped stations.
    rows = ro().query(
        f"""SELECT d.province_id, d.business_date, d.product_code,
                count(DISTINCT d.station_id)::int AS reporting_stations,
                sum(d.sales_volume_l) AS sales_volume_l, sum(d.sales_amount) AS sales_amount, sum(d.deliveries_l) AS deliveries_l,
                sum(d.closing_stock_l) AS closing_stock_l, sum(d.variance_l) AS variance_l,
                CASE WHEN sum(d.sales_volume_l) > 0 THEN round(sum(d.sales_amount) / sum(d.sales_volume_l), 2) END AS avg_price
           FROM fms.daily_station_product d
          WHERE {" AND ".join(where)}
          GROUP BY d.province_id, d.business_date, d.product_code
          ORDER BY d.business_date, d.province_id, d.product_code""",
        p.values,
    )
    return {"items": rows, "next_cursor": None}


@router.get("/stock", summary="Stock per province × product (v_province_stock shape)")
def stock(request: HttpRequest, q: Query[ProvinceQuery]):
    pr = _auth(request)
    province = _prov(pr, q.province_id)
    p = Params()
    sc = scoped_stations_sql(pr, p, province)
    rows = ro().query(
        f"""SELECT pv.id AS province_id, pv.name AS province_name, ss.product_code,
                count(DISTINCT ss.station_id)::int AS stations, sum(ss.capacity_l) AS capacity_l,
                sum(ss.product_volume_l) AS product_volume_l, max(ss.latest_reading_at) AS latest_reading_at
           FROM fms.v_station_stock ss JOIN fms.provinces pv ON pv.id = ss.province_id
          WHERE ss.station_id IN (SELECT id FROM ({sc}) x)
          GROUP BY pv.id, pv.name, ss.product_code
          ORDER BY pv.id, ss.product_code""",
        p.values,
    )
    return {"items": rows, "next_cursor": None}


@router.get("/compliance", summary="Price violations, offline stations, variance anomalies, fiscal failures")
def compliance(request: HttpRequest, q: Query[ProvinceQuery]):
    pr = _auth(request)
    db = ro()
    province = _prov(pr, q.province_id)

    def run(fn: Callable[[str], str]) -> list[dict[str, Any]]:
        p = Params()
        sc = scoped_stations_sql(pr, p, province)
        return db.query(fn(f"SELECT id FROM ({sc}) x"), p.values)

    pv = run(
        lambda sc: (
            f"""
          SELECT * FROM (
            SELECT s.id AS station_id, s.code, s.name, s.province_id, g.pts_grade_id, g.product_code, g.price, {cap_for("s", "g.product_code")} AS cap
              FROM fms.fuel_grades g JOIN fms.stations s ON s.id = g.station_id
             WHERE s.id IN ({sc})) x
           WHERE cap IS NOT NULL AND price > cap
           ORDER BY code, pts_grade_id"""
        )
    )
    off = run(
        lambda sc: (
            f"""
          SELECT h.station_id, h.code, h.name, h.province_id, h.connectivity,
                 h.controller_last_seen_at, h.gateway_last_seen_at,
                 greatest(h.controller_last_seen_at, h.gateway_last_seen_at) AS last_seen_at
            FROM fms.v_station_health h JOIN fms.stations s ON s.id = h.station_id
           WHERE h.station_id IN ({sc}) AND s.status = 'active'
             AND (greatest(h.controller_last_seen_at, h.gateway_last_seen_at) IS NULL
                  OR greatest(h.controller_last_seen_at, h.gateway_last_seen_at) < now() - interval '24 hours')
           ORDER BY last_seen_at NULLS FIRST, h.code"""
        )
    )
    va = run(
        lambda sc: (
            f"""
          SELECT * FROM (
            SELECT 'stock_variance' AS kind, d.station_id, s.code, s.name, s.province_id, d.business_date, d.product_code,
                   d.variance_l, CASE WHEN d.sales_volume_l > 0 THEN round(100 * d.variance_l / d.sales_volume_l, 3) END AS variance_pct,
                   d.sales_volume_l, NULL::text AS alert_code, NULL::bigint AS alert_id
              FROM fms.daily_station_product d JOIN fms.stations s ON s.id = d.station_id
             WHERE d.station_id IN ({sc}) AND d.business_date >= (now() AT TIME ZONE 'Africa/Lusaka')::date - 7
               AND d.variance_l IS NOT NULL AND abs(d.variance_l) > greatest(50, 0.005 * d.sales_volume_l)
            UNION ALL
            SELECT 'totalizer', a.station_id, s.code, s.name, s.province_id, (a.occurred_at AT TIME ZONE 'Africa/Lusaka')::date,
                   NULL, NULL, NULL, NULL, a.code, a.id
              FROM fms.alerts a JOIN fms.stations s ON s.id = a.station_id
             WHERE a.station_id IN ({sc}) AND a.code IN ('TotalizerMismatch', 'StockVariance') AND a.occurred_at >= now() - interval '7 days'
          ) x ORDER BY business_date DESC, code"""
        )
    )
    ff = run(
        lambda sc: (
            f"""
          SELECT s.id AS station_id, s.code, s.name, s.province_id,
                 count(*) FILTER (WHERE pt.fiscal_status = 'failed')::int AS failed,
                 count(*) FILTER (WHERE pt.fiscal_status = 'pending' AND pt.ended_at < now() - interval '1 hour')::int AS pending_over_1h,
                 min(pt.ended_at) AS oldest_unsigned_at
            FROM fms.pump_transactions pt JOIN fms.stations s ON s.id = pt.station_id
           WHERE pt.station_id IN ({sc}) AND pt.ended_at >= now() - interval '7 days'
             AND (pt.fiscal_status = 'failed' OR (pt.fiscal_status = 'pending' AND pt.ended_at < now() - interval '1 hour'))
           GROUP BY s.id, s.code, s.name, s.province_id
           ORDER BY failed DESC, pending_over_1h DESC"""
        )
    )
    return {"province_id": province, "price_violations": pv, "offline_stations": off, "variance_anomalies": va, "fiscal_failures": ff}


@router.get("/prices", summary="ERB cap prices currently in force")
def list_caps(request: HttpRequest):
    pr = _auth(request)
    return {"items": caps_in_force(ro(), _prov(pr, None)), "next_cursor": None}


@router.post("/prices", summary="Publish an ERB cap price (erb_national only)")
def publish_cap(request: HttpRequest, body: CapBody):
    pr = _auth(request)
    require_roles(request, "erb_national")
    b: dict[str, Any] = {"product_code": body.product_code, "province_id": body.province_id, "price": js_num(body.price)}
    if body.effective_at is not None:
        b["effective_at"] = body.effective_at
    rows = primary.query(
        """INSERT INTO fms.price_changes (product_code, province_id, price, kind, effective_at, created_by)
         VALUES ($1, $2, $3, 'erb_cap', coalesce($4::timestamptz, now()), $5)
         RETURNING id, product_code, province_id, price, kind, effective_at, created_by, created_at""",
        [b["product_code"], b["province_id"], b["price"], body.effective_at, pr.id],
    )
    audit(primary, request, "price.erb_cap_set", entity="price_change", entity_id=rows[0]["id"], details=dict(b))
    return json_response(rows[0], status=201)


@router.get("/export", summary="Daily per-station return for ERB (csv|json)")
def export(request: HttpRequest, q: Query[ExportQuery]):
    pr = _auth(request)
    province = _prov(pr, q.province_id)
    p = Params()
    sc = scoped_stations_sql(pr, p, province)
    date_expr = f"{p.add(q.date)}::date" if q.date else "((now() AT TIME ZONE 'Africa/Lusaka')::date - 1)"
    rows = ro().query(
        f"""SELECT to_char({date_expr}, 'YYYY-MM-DD') AS business_date, pv.name AS province, s.code AS station_code, s.name AS station_name,
                s.erb_licence_no, c.name AS company, c.erb_licence_no AS company_licence_no, d.product_code,
                d.opening_stock_l, d.deliveries_l, d.sales_volume_l, d.sales_amount, d.tx_count, d.closing_stock_l,
                d.variance_l, d.avg_price
           FROM fms.daily_station_product d
           JOIN fms.stations s ON s.id = d.station_id
           JOIN fms.companies c ON c.id = s.company_id
           JOIN fms.provinces pv ON pv.id = s.province_id
          WHERE d.business_date = {date_expr} AND d.station_id IN (SELECT id FROM ({sc}) x)
          ORDER BY pv.id, s.code, d.product_code""",
        p.values,
    )
    date = (
        q.date
        or (rows[0]["business_date"] if rows else None)
        or (dt.datetime.now(dt.UTC) + dt.timedelta(hours=2) - dt.timedelta(days=1)).date().isoformat()
    )
    audit(
        primary,
        request,
        "regulator.export",
        entity="export",
        details={"date": date, "province_id": province, "format": q.format, "rows": len(rows)},
    )
    name = f"erb-return-{date}{f'-p{province}' if province is not None else ''}"
    if q.format == "json":
        return json_response(
            {"date": date, "province_id": province, "items": rows},
            headers={"Content-Disposition": f'attachment; filename="{name}.json"'},
        )
    cols = [
        "business_date", "province", "station_code", "station_name", "erb_licence_no", "company", "company_licence_no", "product_code",
        "opening_stock_l", "deliveries_l", "sales_volume_l", "sales_amount", "tx_count", "closing_stock_l", "variance_l", "avg_price",
    ]  # fmt: skip
    csv = "\r\n".join([",".join(cols), *(",".join(csv_escape(r.get(c)) for c in cols) for r in rows)]) + "\r\n"
    resp = HttpResponse(csv, content_type="text/csv; charset=utf-8")
    resp["Content-Disposition"] = f'attachment; filename="{name}.csv"'
    return resp
