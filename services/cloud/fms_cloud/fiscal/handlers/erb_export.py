"""`erb_export`: daily per-station return for the Energy Regulation Board.
payload: {date: 'YYYY-MM-DD', province_id: number | null}   (null = national)

Reads fms.daily_station_product, writes CSV + JSON to object storage at
  erb/daily/<date>/<PROVINCE_CODE|NATIONAL>.{csv,json}
then enqueues a `webhook` job with event 'daily_summary'.
Waits (retryable) while rollup jobs for that date are still pending.
"""

from __future__ import annotations

import datetime as dt
import re
from typing import Any

from fms_cloud.common.jsonutil import iso

from ..core import JobError, num, permanent, req
from ..jscompat import is_integer, js_dumps, js_number, js_round, js_str
from .base import HandlerContext, JobHandler

ERB_COLUMNS = (
    "business_date",
    "province_id",
    "province_name",
    "station_code",
    "station_name",
    "company_name",
    "erb_licence_no",
    "product_code",
    "opening_stock_l",
    "deliveries_l",
    "sales_volume_l",
    "sales_amount",
    "tx_count",
    "closing_stock_l",
    "variance_l",
    "avg_price",
)
NUMERIC_COLS = {
    "opening_stock_l",
    "deliveries_l",
    "sales_volume_l",
    "sales_amount",
    "tx_count",
    "closing_stock_l",
    "variance_l",
    "avg_price",
}

_NEEDS_QUOTE = re.compile(r'[",\r\n]')


def csv_cell(v: Any) -> str:
    if v is None:
        return ""
    s = js_str(v)
    return '"' + s.replace('"', '""') + '"' if _NEEDS_QUOTE.search(s) else s


def to_csv(rows: list[dict[str, Any]], cols: tuple[str, ...] | list[str]) -> str:
    return "\r\n".join([",".join(cols), *[",".join(csv_cell(r.get(c)) for c in cols) for r in rows]]) + "\r\n"


def _round(n: float, d: int) -> float:
    return js_round(n * 10**d) / 10**d


def handle(ctx: HandlerContext) -> None:
    payload = ctx.job.payload if isinstance(ctx.job.payload, dict) else {}
    date = req.date(payload, "date")
    raw_prov = payload.get("province_id")
    province_id = None if raw_prov is None else js_number(raw_prov)
    if province_id is not None and not is_integer(province_id):
        raise permanent("payload.province_id must be an integer or null", "BAD_PAYLOAD")
    if province_id is not None:
        province_id = int(province_id)

    scope = "NATIONAL"
    province_name = None
    if province_id is not None:
        p = ctx.db.one("SELECT code, name FROM fms.provinces WHERE id = $1", [province_id])
        if not p:
            raise permanent(f"province {province_id} not found", "BAD_PAYLOAD")
        scope = p["code"]
        province_name = p["name"]

    pending = ctx.db.one(
        """SELECT count(*)::text AS n FROM fms.jobs j
         JOIN fms.stations s ON s.id::text = j.payload->>'station_id'
        WHERE j.kind = 'rollup' AND j.status IN ('queued','running') AND j.payload->>'business_date' = $1
          AND ($2::smallint IS NULL OR s.province_id = $2)""",
        [date, province_id],
    )
    n_pending = pending["n"] if pending else "0"
    if int(n_pending) > 0:
        raise JobError(f"waiting for {n_pending} rollup job(s) for {date}", True, "ROLLUP_PENDING")

    rows = ctx.db.query(
        """SELECT d.business_date::text AS business_date, d.province_id, p.name AS province_name, s.id AS station_id,
              s.code AS station_code, s.name AS station_name, c.name AS company_name, s.erb_licence_no, d.product_code,
              d.opening_stock_l, d.deliveries_l, d.sales_volume_l, d.sales_amount, d.tx_count, d.closing_stock_l,
              d.variance_l, d.avg_price
         FROM fms.daily_station_product d
         JOIN fms.stations s  ON s.id = d.station_id
         JOIN fms.companies c ON c.id = s.company_id
         JOIN fms.provinces p ON p.id = d.province_id
        WHERE d.business_date = $1::date AND ($2::smallint IS NULL OR d.province_id = $2)
        ORDER BY d.province_id, s.code, d.product_code""",
        [date, province_id],
    )
    records = [{c: (num(r[c]) if c in NUMERIC_COLS else r[c]) for c in ERB_COLUMNS} for r in rows]

    totals: dict[str, dict[str, Any]] = {}
    for r in records:
        k = js_str(r["product_code"])
        t = totals.get(k) or {
            "product_code": k,
            "sales_volume_l": 0,
            "sales_amount": 0,
            "deliveries_l": 0,
            "closing_stock_l": 0,
            "stations": 0,
        }
        t["sales_volume_l"] += js_number(r["sales_volume_l"] if r["sales_volume_l"] is not None else 0)
        t["sales_amount"] += js_number(r["sales_amount"] if r["sales_amount"] is not None else 0)
        t["deliveries_l"] += js_number(r["deliveries_l"] if r["deliveries_l"] is not None else 0)
        t["closing_stock_l"] += js_number(r["closing_stock_l"] if r["closing_stock_l"] is not None else 0)
        t["stations"] += 1
        totals[k] = t
    by_product = [
        {
            **t,
            "sales_volume_l": _round(t["sales_volume_l"], 3),
            "sales_amount": _round(t["sales_amount"], 2),
            "deliveries_l": _round(t["deliveries_l"], 3),
            "closing_stock_l": _round(t["closing_stock_l"], 3),
        }
        for t in totals.values()
    ]
    station_count = len({r["station_id"] for r in rows})

    key = f"erb/daily/{date}/{scope}"
    generated_at = iso(dt.datetime.now(dt.UTC))
    csv = ctx.storage.put(f"{key}.csv", to_csv(records, ERB_COLUMNS), "text/csv")
    json_file = ctx.storage.put(
        f"{key}.json",
        js_dumps(
            {
                "date": date,
                "province_id": province_id,
                "province_name": province_name,
                "generated_at": generated_at,
                "station_count": station_count,
                "totals": by_product,
                "rows": records,
            },
            indent=2,
        ),
        "application/json",
    )

    ctx.queue.enqueue(
        kind="webhook",
        payload={
            "event": "daily_summary",
            "data": {
                "date": date,
                "province_id": province_id,
                "province_name": province_name,
                "station_count": station_count,
                "totals": by_product,
                "files": {"csv": csv["uri"], "json": json_file["uri"]},
                "generated_at": generated_at,
            },
        },
        dedupe_key=f"webhook:daily_summary:{date}:{scope}",
    )
    ctx.log.info("ERB daily return exported", date=date, scope=scope, rows=len(records), stations=station_count, csv=csv["uri"])


erb_export_handler = JobHandler(kind="erb_export", handle=handle)
