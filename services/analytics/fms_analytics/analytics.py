"""Analytics computations backed by the read-only database."""

from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd

from .auth import Principal
from .cache import TTLCache
from .config import business_today
from .db import Database
from .errors import ApiError
from .forecasting import forecast_payload, prepare_series
from .metrics import FORECAST_CACHE, FORECAST_FIT_SECONDS
from .risk import days_of_cover, r, reserve_risk, station_risk

DEMAND_WINDOW_DAYS = 14
DEMAND_FALLBACK_DAYS = 7
ANOMALY_Z = 3.5
ANOMALY_BASELINE_DAYS = 60
MIN_BASELINE_POINTS = 7
LOCAL_TZ = "Africa/Lusaka"


# ----------------------------------------------------------------- demand forecast
async def demand_forecast(
    db: Database,
    cache: TTLCache,
    province_id: int | None,
    product_code: str | None,
    horizon_days: int,
    history_days: int,
) -> dict[str, Any]:
    today = business_today()
    key = ("demand", province_id, product_code, horizon_days, history_days, today)
    cached = cache.get(key)
    if cached is not None:
        FORECAST_CACHE.labels(result="hit").inc()
        return cached
    FORECAST_CACHE.labels(result="miss").inc()

    where = ["business_date < %(today)s", "business_date >= %(start)s"]
    params: dict[str, Any] = {"today": today, "start": today - timedelta(days=400)}
    if province_id is not None:
        where.append("province_id = %(province_id)s")
        params["province_id"] = province_id
    if product_code:
        where.append("product_code = %(product_code)s")
        params["product_code"] = product_code
    rows = await db.fetch_all(
        f"""SELECT business_date AS d, sum(sales_volume_l) AS v
            FROM fms.daily_station_product WHERE {" AND ".join(where)}
            GROUP BY business_date ORDER BY business_date""",
        params,
    )
    series = prepare_series([(row["d"], float(row["v"] or 0)) for row in rows])
    t0 = time.perf_counter()
    payload = await asyncio.to_thread(forecast_payload, series, horizon_days, history_days)
    FORECAST_FIT_SECONDS.labels(model=payload["model"]).observe(time.perf_counter() - t0)
    cache.set(key, payload)
    return payload


# ---------------------------------------------------------------------- stock-out
async def station_in_scope(db: Database, p: Principal, station_id: str) -> bool:
    if p.role in {"platform_admin", "erb_national"}:
        row = await db.fetch_one("SELECT 1 AS ok FROM fms.stations WHERE id = %s", (station_id,))
    elif p.role == "erb_provincial":
        row = await db.fetch_one(
            "SELECT 1 AS ok FROM fms.stations WHERE id = %s AND province_id = %s", (station_id, p.province_id)
        )
    elif p.role == "owner":
        row = await db.fetch_one(
            "SELECT 1 AS ok FROM fms.stations WHERE id = %s AND company_id::text = %s",
            (station_id, p.company_id or ""),
        )
    elif p.role == "manager":
        row = await db.fetch_one(
            "SELECT 1 AS ok FROM fms.user_station_access WHERE station_id = %s AND user_id::text = %s",
            (station_id, p.sub),
        )
    else:
        row = None
    return row is not None


async def stockout(
    db: Database,
    p: Principal,
    province_id: int | None,
    product_code: str | None,
    station_id: str | None,
) -> list[dict[str, Any]]:
    today = business_today()
    if station_id is not None and not await station_in_scope(db, p, station_id):
        raise ApiError(403, "forbidden", "Station is outside your scope")

    where = ["ss.product_volume_l IS NOT NULL"]
    params: dict[str, Any] = {
        "today": today,
        "d14": today - timedelta(days=DEMAND_WINDOW_DAYS),
        "d7": today - timedelta(days=DEMAND_FALLBACK_DAYS),
    }
    if province_id is not None:
        where.append("ss.province_id = %(province_id)s")
        params["province_id"] = province_id
    if product_code:
        where.append("ss.product_code = %(product_code)s")
        params["product_code"] = product_code
    if station_id:
        where.append("ss.station_id = %(station_id)s")
        params["station_id"] = station_id
    if p.role == "owner":
        where.append("ss.company_id::text = %(company_id)s")
        params["company_id"] = p.company_id or ""
    elif p.role == "manager":
        where.append(
            "ss.station_id IN (SELECT station_id FROM fms.user_station_access WHERE user_id::text = %(sub)s)"
        )
        params["sub"] = p.sub

    rows = await db.fetch_all(
        f"""
        WITH sales AS (
            SELECT station_id, product_code,
                   avg(sales_volume_l)                                  AS a14,
                   count(*)                                             AS n14,
                   avg(sales_volume_l) FILTER (WHERE business_date >= %(d7)s) AS a7
            FROM fms.daily_station_product
            WHERE business_date >= %(d14)s AND business_date < %(today)s
            GROUP BY station_id, product_code)
        SELECT ss.station_id::text AS station_id, ss.station_name, ss.station_code, ss.province_id,
               ss.product_code, ss.product_volume_l AS stock_l, ss.capacity_l,
               ss.latest_reading_at, s.a14, s.n14, s.a7
        FROM fms.v_station_stock ss
        LEFT JOIN sales s ON s.station_id = ss.station_id AND s.product_code = ss.product_code
        WHERE {" AND ".join(where)}
        """,
        params,
    )
    out: list[dict[str, Any]] = []
    for row in rows:
        if row["n14"] and row["n14"] >= DEMAND_FALLBACK_DAYS:
            avg = row["a14"]
        else:
            avg = row["a7"] if row["a7"] is not None else row["a14"]
        stock = float(row["stock_l"])
        doc = days_of_cover(stock, avg)
        out.append(
            {
                "station_id": row["station_id"],
                "station_name": row["station_name"],
                "station_code": row["station_code"],
                "province_id": row["province_id"],
                "product_code": row["product_code"],
                "stock_l": r(stock),
                "capacity_l": r(row["capacity_l"]),
                "avg_daily_sales_l": r(avg),
                "days_of_cover": r(doc, 2),
                "predicted_stockout_date": (today + timedelta(days=int(doc))).isoformat()
                if doc is not None
                else None,
                "risk": station_risk(doc),
            }
        )
    out.sort(key=lambda x: (x["days_of_cover"] is None, x["days_of_cover"] or 0, x["station_name"]))
    return out


# ------------------------------------------------------------------ national reserve
async def national_reserve(db: Database, province_id: int | None) -> dict[str, Any]:
    today = business_today()
    prov_filter = "" if province_id is None else "AND province_id = %(province_id)s"
    params: dict[str, Any] = {
        "today": today,
        "start": today - timedelta(days=DEMAND_WINDOW_DAYS),
        "province_id": province_id,
    }
    stock_rows, demand_rows, depot_rows, provinces = await asyncio.gather(
        db.fetch_all(
            f"""SELECT province_id, province_name, product_code, stations, capacity_l,
                       coalesce(product_volume_l, 0) AS stock_l, latest_reading_at
                FROM fms.v_province_stock WHERE true {prov_filter}""",
            params,
        ),
        db.fetch_all(
            f"""SELECT province_id, product_code, sum(sales_volume_l) AS total_l,
                       count(DISTINCT business_date) AS days
                FROM fms.daily_station_product
                WHERE business_date >= %(start)s AND business_date < %(today)s {prov_filter}
                GROUP BY province_id, product_code""",
            params,
        ),
        db.fetch_all(
            f"""SELECT * FROM (
                    SELECT DISTINCT ON (depot_name, product_code)
                           depot_name, product_code, province_id, volume_l, capacity_l, is_strategic, as_of
                    FROM fms.depot_stock
                    ORDER BY depot_name, product_code, as_of DESC) x
                WHERE true {"" if province_id is None else "AND province_id = %(province_id)s"}""",
            params,
        ),
        db.fetch_all("SELECT id, name FROM fms.provinces ORDER BY id"),
    )
    pname = {row["id"]: row["name"] for row in provinces}

    def blank() -> dict[str, Any]:
        return {
            "stations": 0,
            "station_stock_l": 0.0,
            "depot_stock_l": 0.0,
            "capacity_l": 0.0,
            "demand_l": 0.0,
            "days": 0,
        }

    cells: dict[str, dict[int | None, dict[str, Any]]] = defaultdict(lambda: defaultdict(blank))
    latest: datetime | None = None
    for row in stock_rows:
        c = cells[row["product_code"]][row["province_id"]]
        c["stations"] = int(row["stations"])
        c["station_stock_l"] += float(row["stock_l"] or 0)
        c["capacity_l"] += float(row["capacity_l"] or 0)
        if row["latest_reading_at"] and (latest is None or row["latest_reading_at"] > latest):
            latest = row["latest_reading_at"]
    for row in demand_rows:
        c = cells[row["product_code"]][row["province_id"]]
        c["demand_l"] += float(row["total_l"] or 0)
        c["days"] = max(c["days"], int(row["days"]))
    depots: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in depot_rows:
        c = cells[row["product_code"]][row["province_id"]]
        c["depot_stock_l"] += float(row["volume_l"] or 0)
        c["capacity_l"] += float(row["capacity_l"] or 0)
        depots[row["product_code"]].append(
            {
                "depot_name": row["depot_name"],
                "province_id": row["province_id"],
                "volume_l": r(row["volume_l"]),
                "capacity_l": r(row["capacity_l"]),
                "is_strategic": row["is_strategic"],
                "as_of": row["as_of"].isoformat(),
            }
        )

    by_product = []
    for product in sorted(cells):
        provs = cells[product]
        nat_days = max((c["days"] for c in provs.values()), default=0)
        by_province = []
        tot = blank()
        for pid, c in sorted(provs.items(), key=lambda kv: (kv[0] is None, kv[0] or 0)):
            for k in ("stations", "station_stock_l", "depot_stock_l", "capacity_l", "demand_l"):
                tot[k] += c[k]
            if pid is None:
                continue  # national (unattributed) depot stock: only in the product total
            avg = c["demand_l"] / c["days"] if c["days"] else None
            stock = c["station_stock_l"] + c["depot_stock_l"]
            doc = days_of_cover(stock, avg)
            by_province.append(
                {
                    "province_id": pid,
                    "province_name": pname.get(pid),
                    "stations": c["stations"],
                    "stock_l": r(stock),
                    "station_stock_l": r(c["station_stock_l"]),
                    "depot_stock_l": r(c["depot_stock_l"]),
                    "capacity_l": r(c["capacity_l"]),
                    "avg_daily_demand_l": r(avg),
                    "days_of_cover": r(doc, 2),
                    "risk": reserve_risk(doc),
                }
            )
        avg_nat = tot["demand_l"] / nat_days if nat_days else None
        stock_nat = tot["station_stock_l"] + tot["depot_stock_l"]
        doc_nat = days_of_cover(stock_nat, avg_nat)
        by_product.append(
            {
                "product_code": product,
                "stock_l": r(stock_nat),
                "station_stock_l": r(tot["station_stock_l"]),
                "depot_stock_l": r(tot["depot_stock_l"]),
                "capacity_l": r(tot["capacity_l"]),
                "avg_daily_demand_l": r(avg_nat),
                "days_of_cover": r(doc_nat, 2),
                "risk": reserve_risk(doc_nat),
                "stations": tot["stations"],
                "by_province": by_province,
                "depots": depots.get(product, []),
            }
        )
    return {
        "as_of": datetime.now(UTC).isoformat(timespec="seconds"),
        "stock_as_of": latest.isoformat() if latest else None,
        "demand_window_days": DEMAND_WINDOW_DAYS,
        "province_id": province_id,
        "by_product": by_product,
    }


# ------------------------------------------------------------------------ anomalies
def robust_z(values: np.ndarray) -> np.ndarray:
    med = np.median(values)
    mad = np.median(np.abs(values - med))
    if mad > 1e-12:
        return 0.6745 * (values - med) / mad
    mean_ad = np.mean(np.abs(values - med))
    if mean_ad > 1e-12:
        return (values - med) / (1.2533 * mean_ad)
    return np.zeros_like(values)


def _variance_from_alert(data: dict[str, Any] | None) -> float | None:
    if not isinstance(data, dict):
        return None
    # ingest-api writes TotalizerMismatch data as {expected, actual, unaccounted_l}
    for key in ("unaccounted_l", "variance_l", "gap_l", "missing_l", "difference_l", "diff_l", "mismatch_l"):
        v = data.get(key)
        if isinstance(v, int | float):
            return float(v)
    return None


async def anomalies(db: Database, province_id: int | None, start: date, end: date) -> list[dict[str, Any]]:
    params: dict[str, Any] = {
        "from": start,
        "to": end,
        "base_from": start - timedelta(days=ANOMALY_BASELINE_DAYS),
        "province_id": province_id,
        "tz": LOCAL_TZ,
    }
    prov_d = "" if province_id is None else "AND d.province_id = %(province_id)s"
    prov_s = "" if province_id is None else "AND s.province_id = %(province_id)s"
    var_rows, tot_rows, price_rows = await asyncio.gather(
        db.fetch_all(
            f"""SELECT d.station_id::text AS station_id, s.name AS station_name, d.province_id,
                       d.business_date, d.product_code, d.variance_l, d.sales_volume_l
                FROM fms.daily_station_product d JOIN fms.stations s ON s.id = d.station_id
                WHERE d.business_date BETWEEN %(base_from)s AND %(to)s
                  AND d.variance_l IS NOT NULL AND d.sales_volume_l > 0 {prov_d}""",
            params,
        ),
        db.fetch_all(
            f"""SELECT a.id, a.station_id::text AS station_id, s.name AS station_name, s.province_id,
                       (a.occurred_at AT TIME ZONE %(tz)s)::date AS business_date,
                       a.occurred_at, a.device_type, a.device_no, a.severity, a.message, a.data,
                       coalesce(a.data->>'product_code', a.data->>'productCode') AS product_code
                FROM fms.alerts a JOIN fms.stations s ON s.id = a.station_id
                WHERE a.code = 'TotalizerMismatch'
                  AND a.occurred_at >= (%(from)s::date::timestamp AT TIME ZONE %(tz)s)
                  AND a.occurred_at <  ((%(to)s::date + 1)::timestamp AT TIME ZONE %(tz)s) {prov_s}""",
            params,
        ),
        db.fetch_all(
            f"""SELECT d.station_id::text AS station_id, s.name AS station_name, d.province_id,
                       d.business_date, d.product_code, d.avg_price, d.sales_volume_l,
                       cap.price AS cap_price, cap.province_id AS cap_province_id
                FROM fms.daily_station_product d
                JOIN fms.stations s ON s.id = d.station_id
                JOIN LATERAL (
                    SELECT pc.price, pc.province_id FROM fms.price_changes pc
                    WHERE pc.kind = 'erb_cap' AND pc.station_id IS NULL
                      AND pc.product_code = d.product_code
                      AND (pc.province_id = d.province_id OR pc.province_id IS NULL)
                      AND pc.effective_at < ((d.business_date + 1)::timestamp AT TIME ZONE %(tz)s)
                    ORDER BY (pc.province_id IS NULL), pc.effective_at DESC
                    LIMIT 1) cap ON true
                WHERE d.business_date BETWEEN %(from)s AND %(to)s
                  AND d.avg_price IS NOT NULL AND d.avg_price > cap.price + 0.005 {prov_d}""",
            params,
        ),
    )

    out: list[dict[str, Any]] = []
    if var_rows:
        df = pd.DataFrame(var_rows)
        df["variance_pct"] = df["variance_l"].astype(float) / df["sales_volume_l"].astype(float) * 100
        for _, g in df.groupby(["station_id", "product_code"], sort=False):
            if len(g) < MIN_BASELINE_POINTS:
                continue
            z = robust_z(g["variance_pct"].to_numpy(dtype=float))
            for (_, row), zi in zip(g.iterrows(), z, strict=True):
                if abs(zi) > ANOMALY_Z and start <= row["business_date"] <= end:
                    out.append(
                        {
                            "station_id": row["station_id"],
                            "station_name": row["station_name"],
                            "province_id": int(row["province_id"]),
                            "business_date": row["business_date"].isoformat(),
                            "product_code": row["product_code"],
                            "variance_l": r(row["variance_l"], 3),
                            "variance_pct": r(row["variance_pct"], 3),
                            "zscore": r(float(zi), 2),
                            "kind": "stock_loss",
                        }
                    )
    for row in tot_rows:
        out.append(
            {
                "station_id": row["station_id"],
                "station_name": row["station_name"],
                "province_id": row["province_id"],
                "business_date": row["business_date"].isoformat(),
                "product_code": row["product_code"],
                "variance_l": r(_variance_from_alert(row["data"]), 3),
                "variance_pct": None,
                "zscore": None,
                "kind": "totalizer",
                "details": {
                    "alert_id": row["id"],
                    "occurred_at": row["occurred_at"].isoformat(),
                    "pump_no": row["device_no"],
                    "severity": row["severity"],
                    "message": row["message"],
                },
            }
        )
    for row in price_rows:
        avg_price, cap = float(row["avg_price"]), float(row["cap_price"])
        out.append(
            {
                "station_id": row["station_id"],
                "station_name": row["station_name"],
                "province_id": row["province_id"],
                "business_date": row["business_date"].isoformat(),
                "product_code": row["product_code"],
                "variance_l": None,
                "variance_pct": r((avg_price - cap) / cap * 100, 3),
                "zscore": None,
                "kind": "price",
                "details": {
                    "avg_price": avg_price,
                    "cap_price": cap,
                    "cap_scope": "province" if row["cap_province_id"] is not None else "national",
                    "overcharge_zmw": round((avg_price - cap) * float(row["sales_volume_l"] or 0), 2),
                },
            }
        )
    out.sort(key=lambda x: (x["business_date"], x["kind"], x["station_id"]), reverse=True)
    return out
