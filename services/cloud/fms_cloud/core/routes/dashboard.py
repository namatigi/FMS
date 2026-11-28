"""Port of services/core-api/src/routes/dashboard.ts."""

from __future__ import annotations

from django.http import HttpRequest
from ninja import Router

from ...common.db import ro
from ...common.sqlutil import LUSAKA_TODAY_START, Params, round_
from ..auth import require_user
from ..scope import station_scope

router = Router(tags=["dashboard"])


@router.get("/dashboard/overview", summary="Overview KPIs scoped to the caller")
def overview(request: HttpRequest):
    pr = require_user(request)
    db = ro()

    # Each query gets its own Params so placeholders are never left unused.
    def pred() -> tuple[Params, str]:
        p = Params()
        return p, station_scope(pr, p)

    def scoped() -> tuple[Params, str]:
        p = Params()
        return p, f"SELECT s.id FROM fms.stations s WHERE {station_scope(pr, p)}"

    a, a_pred = pred()
    cr = db.query(
        f"""SELECT count(*)::int AS total, count(*) FILTER (WHERE h.connectivity = 'online')::int AS online
           FROM fms.stations s JOIN fms.v_station_health h ON h.station_id = s.id WHERE {a_pred}""",
        a.values,
    )
    b, b_sc = scoped()
    sr = db.query(
        f"""SELECT product_code, sum(volume_l) AS volume_l, sum(amount) AS amount, count(*)::int AS tx_count
           FROM fms.pump_transactions WHERE ended_at >= {LUSAKA_TODAY_START} AND station_id IN ({b_sc})
          GROUP BY product_code""",
        b.values,
    )
    c, c_sc = scoped()
    st = db.query(
        f"""SELECT product_code, sum(product_volume_l) AS stock_l, sum(capacity_l) AS capacity_l
           FROM fms.v_station_stock WHERE station_id IN ({c_sc}) GROUP BY product_code""",
        c.values,
    )
    d, d_pred = pred()
    lr = db.query(
        f"""SELECT s.id AS station_id, s.name AS station_name, t.tank_no, t.product_code, tl.product_volume_l, t.capacity_l,
                round(100 * tl.product_volume_l / nullif(t.capacity_l, 0), 1) AS fill_pct
           FROM fms.tanks t JOIN fms.stations s ON s.id = t.station_id
           JOIN fms.tank_latest tl ON tl.station_id = t.station_id AND tl.tank_no = t.tank_no
          WHERE {d_pred} AND tl.product_volume_l <= coalesce(t.low_level_l, t.capacity_l * 0.2)
          ORDER BY fill_pct ASC NULLS LAST LIMIT 100""",
        d.values,
    )
    e, e_sc = scoped()
    ar = db.query(
        f"""SELECT count(*) FILTER (WHERE severity = 'critical')::int AS critical, count(*) FILTER (WHERE severity = 'warning')::int AS warning
           FROM fms.alerts WHERE acknowledged_at IS NULL AND station_id IN ({e_sc})""",
        e.values,
    )

    products: dict[str, dict] = {}

    def get(code: str) -> dict:
        if code not in products:
            products[code] = {"product_code": code, "sales_today_l": 0, "sales_today_amount": 0, "stock_l": 0, "capacity_l": 0}
        return products[code]

    vol = amt = n = 0
    for r in sr:
        vol += r["volume_l"] or 0
        amt += r["amount"] or 0
        n += r["tx_count"]
        if not r["product_code"]:
            continue
        v = get(r["product_code"])
        v["sales_today_l"] = round_(r["volume_l"]) or 0
        v["sales_today_amount"] = round_(r["amount"], 2) or 0
    for r in st:
        v = get(r["product_code"])
        v["stock_l"] = round_(r["stock_l"]) or 0
        v["capacity_l"] = round_(r["capacity_l"]) or 0
    total = cr[0]["total"] if cr else 0
    online = cr[0]["online"] if cr else 0
    return {
        "stations_total": total,
        "stations_online": online,
        "stations_offline": total - online,
        "sales_today": {"volume_l": round_(vol) or 0, "amount": round_(amt, 2) or 0, "tx_count": n},
        "by_product": sorted(products.values(), key=lambda x: x["product_code"]),
        "low_stock_tanks": lr,
        "open_alerts": {"critical": ar[0]["critical"] if ar else 0, "warning": ar[0]["warning"] if ar else 0},
    }
