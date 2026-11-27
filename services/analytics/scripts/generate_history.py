"""Synthetic history generator for the analytics service (DEV / TEST DATABASES ONLY).

Creates ~180 days of realistic ``fms.daily_station_product`` history (weekly seasonality, trend,
month-end peaks, noise, a delivery/stock simulation with normal book losses), monthly ERB caps
(national + a Lusaka PETROL override), ``tank_latest`` rows, depot stock and a handful of
injected anomalies (stock variance, totaliser mismatch alerts, prices above cap).

It also adds 3 synthetic stations per province (codes ``SYN-<PROV>-NN``) owned by the seeded
companies so national / provincial analytics are meaningful.

Usage:
    python scripts/generate_history.py --dsn postgres://postgres@localhost:55432/fms_analytics
    (or DATABASE_URL env), [--days 180] [--seed 42] [--json-out injected.json]

Re-running is idempotent: generated rows are replaced.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import psycopg

SERVICE_ROOT = Path(__file__).resolve().parent.parent
NS = uuid.UUID("5a1d0c3e-7f0b-4c55-9d9e-6a6e1f000000")
MARKER = uuid.UUID("00000000-0000-0000-0000-00000000a11a")  # price_changes.created_by for generated caps
COMPANIES = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"]
PROVINCE_SCALE = {1: 0.9, 2: 1.5, 3: 0.8, 4: 0.6, 5: 1.8, 6: 0.55, 7: 0.65, 8: 0.9, 9: 1.0, 10: 0.55}
TOWNS = {
    1: ["Kabwe", "Kapiri Mposhi", "Mkushi"],
    2: ["Ndola", "Kitwe", "Chingola"],
    3: ["Chipata", "Petauke", "Katete"],
    4: ["Mansa", "Kawambwa", "Samfya"],
    5: ["Lusaka", "Chongwe", "Kafue"],
    6: ["Chinsali", "Mpika", "Nakonde"],
    7: ["Kasama", "Mbala", "Mpulungu"],
    8: ["Solwezi", "Kalumbila", "Mwinilunga"],
    9: ["Livingstone", "Choma", "Mazabuka"],
    10: ["Mongu", "Senanga", "Kaoma"],
}
BASE_DEMAND = {"PETROL": 5000.0, "DIESEL": 6500.0, "KEROSENE": 600.0}
CAPACITY = {"PETROL": 30000.0, "DIESEL": 40000.0, "KEROSENE": 10000.0}
# Caps in force from 2026-11-01 are in the seed; earlier months are generated around them.
NOV_CAPS = {"PETROL": 32.15, "DIESEL": 30.29, "KEROSENE": 26.80}
LUSAKA_PETROL_PREMIUM = 0.20
WEEKDAY = [0.98, 0.96, 0.97, 1.00, 1.12, 1.10, 0.87]  # Mon..Sun
LUSAKA_TZ_OFFSET = timedelta(hours=2)


def today_local() -> date:
    return (datetime.now(UTC) + LUSAKA_TZ_OFFSET).date()


def month_starts(start: date, end: date) -> list[date]:
    out, m = [], date(start.year, start.month, 1)
    while m <= end:
        out.append(m)
        m = date(m.year + (m.month // 12), m.month % 12 + 1, 1)
    return out


def demand_multiplier(d: date, t: int) -> float:
    m = WEEKDAY[d.weekday()] * (1 + 0.0006 * t)
    nxt = d + timedelta(days=1)
    if nxt.month != d.month or (d + timedelta(days=2)).month != d.month or d.day == 1:
        m *= 1.10  # month-end pay-day peak (last 2 days + 1st)
    return m


def ensure_stations(cur: psycopg.Cursor, rng: random.Random) -> None:
    cur.execute("SELECT id, code FROM fms.provinces ORDER BY id")
    for pid, pcode in cur.fetchall():
        for i in range(3):
            code = f"SYN-{pcode}-{i + 1:02d}"
            sid = uuid.uuid5(NS, code)
            town = TOWNS[pid][i]
            cur.execute(
                """INSERT INTO fms.stations (id, company_id, code, name, province_id, district, town, status,
                                             connection_mode)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, 'active', 'edge')
                   ON CONFLICT (code) DO NOTHING""",
                (sid, COMPANIES[(pid + i) % 2], code, f"Synthetic {town} {i + 1}", pid, town, town),
            )
            products = ["PETROL", "DIESEL"] + (["KEROSENE"] if i == 0 else [])
            for no, prod in enumerate(products, start=1):
                cur.execute(
                    """INSERT INTO fms.tanks (station_id, tank_no, product_code, capacity_l, low_level_l)
                       VALUES (%s, %s, %s, %s, %s) ON CONFLICT (station_id, tank_no) DO NOTHING""",
                    (sid, no, prod, CAPACITY[prod], CAPACITY[prod] * 0.2),
                )


def generate_caps(cur: psycopg.Cursor, start: date, rng: random.Random) -> dict[tuple[str, int | None], list]:
    """Returns {(product, province_or_None): [(effective_date, price), ...]} ascending."""
    cur.execute("DELETE FROM fms.price_changes WHERE created_by = %s", (MARKER,))
    nov = date(2026, 11, 1)
    months = [m for m in month_starts(start, today_local()) if m < nov]
    caps: dict[tuple[str, int | None], list] = {}
    for prod, nov_price in NOV_CAPS.items():
        price = nov_price
        hist = []
        for m in reversed(months):  # walk backwards from the seeded November cap
            price = round(price - rng.uniform(-0.6, 0.6), 2)
            hist.append((m, price))
        hist.reverse()
        for m, p in hist:
            cur.execute(
                """INSERT INTO fms.price_changes (product_code, price, kind, effective_at, created_by)
                   VALUES (%s, %s, 'erb_cap', %s, %s)""",
                (prod, p, datetime(m.year, m.month, 1, tzinfo=UTC) - LUSAKA_TZ_OFFSET, MARKER),
            )
        caps[(prod, None)] = [*hist, (nov, nov_price)]
    lus = []
    for m, p in caps[("PETROL", None)]:
        lp = round(p + LUSAKA_PETROL_PREMIUM, 2)
        lus.append((m, lp))
        cur.execute(
            """INSERT INTO fms.price_changes
                   (product_code, province_id, price, kind, effective_at, created_by)
               VALUES ('PETROL', 5, %s, 'erb_cap', %s, %s)""",
            (lp, datetime(m.year, m.month, 1, tzinfo=UTC) - LUSAKA_TZ_OFFSET, MARKER),
        )
    caps[("PETROL", 5)] = lus
    return caps


def cap_on(caps: dict, prod: str, d: date) -> float | None:
    hist = caps.get((prod, None))
    if not hist:
        return None
    val = None
    for m, p in hist:
        if m <= d:
            val = p
    return val


def generate(dsn: str, days: int = 180, seed: int = 42) -> dict[str, Any]:
    rng = random.Random(seed)
    today = today_local()
    start = today - timedelta(days=days)
    injected: dict[str, Any] = {"stock_loss": [], "totalizer": [], "price": [], "low_stock": []}

    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute((SERVICE_ROOT / "migrations" / "200_analytics.sql").read_text(encoding="utf-8"))
        ensure_stations(cur, rng)
        caps = generate_caps(cur, start, rng)

        cur.execute(
            """SELECT s.id, s.code, s.province_id, t.tank_no, t.product_code, t.capacity_l
               FROM fms.stations s JOIN fms.tanks t ON t.station_id = s.id
               ORDER BY s.code, t.tank_no"""
        )
        tanks = cur.fetchall()
        cur.execute("DELETE FROM fms.daily_station_product")

        series_keys = [(sid, prod) for sid, _, _, _, prod, _ in tanks]
        window = [today - timedelta(days=k) for k in range(2, 29)]
        loss_picks = set()
        while len(loss_picks) < 5:
            sid, prod = rng.choice(series_keys)
            loss_picks.add((sid, prod, rng.choice(window)))
        price_picks = set()
        while len(price_picks) < 3:
            sid, prod = rng.choice([k for k in series_keys if k[1] in ("PETROL", "DIESEL")])
            d = rng.choice(window)
            if (sid, prod, d) not in loss_picks:
                price_picks.add((sid, prod, d))

        rows: list[tuple] = []
        latest: list[tuple] = []
        for sid, code, prov, tank_no, prod, cap in tanks:
            cap = float(cap)
            base = BASE_DEMAND[prod] * PROVINCE_SCALE[prov] * rng.uniform(0.7, 1.3)
            offset = rng.uniform(0.05, 0.40)
            stock = cap * rng.uniform(0.5, 0.9)
            last_sales: list[float] = []
            for t in range(days):
                d = start + timedelta(days=t)
                opening = stock
                sales = base * demand_multiplier(d, t) * math.exp(rng.gauss(0, 0.06))
                delivered = 0.0
                if opening < 0.35 * cap:
                    delivered = round((0.9 * cap - opening) / 1000) * 1000
                sales = min(sales, opening + delivered)
                loss = sales * rng.gauss(0.002, 0.0015)
                if (sid, prod, d) in loss_picks:
                    loss = sales * rng.uniform(0.04, 0.08)
                    injected["stock_loss"].append(
                        {"station_id": str(sid), "product_code": prod, "business_date": d.isoformat()}
                    )
                closing = max(opening + delivered - sales - loss, 0.0)
                variance = (opening + delivered - sales) - closing
                national_cap = cap_on(caps, prod, d)
                if national_cap is None:
                    price = round(31.0 + rng.uniform(-0.3, 0.3), 2)
                elif prov == 5 and prod == "PETROL":
                    price = round(national_cap + 0.10, 2)  # above national, below the Lusaka override
                else:
                    price = round(national_cap - offset, 2)
                if (sid, prod, d) in price_picks and national_cap is not None:
                    price = round(national_cap + LUSAKA_PETROL_PREMIUM + rng.uniform(0.5, 1.5), 2)
                    injected["price"].append(
                        {"station_id": str(sid), "product_code": prod, "business_date": d.isoformat()}
                    )
                rows.append(
                    (
                        sid,
                        d,
                        prod,
                        prov,
                        round(sales, 3),
                        round(sales * price, 2),
                        max(int(sales / 28), 1),
                        round(opening, 3),
                        round(closing, 3),
                        delivered,
                        round(variance, 3),
                        price,
                    )
                )
                stock = closing
                last_sales.append(sales)
            avg14 = sum(last_sales[-14:]) / 14
            vol = max(stock - avg14 * rng.uniform(0.1, 0.6), 0.0)
            latest.append([sid, tank_no, prod, cap, vol, avg14, code])

        # Force a few clearly low-stock station tanks so stock-out risk bands are exercised.
        for i, item in enumerate(rng.sample(latest, 8)):
            item[4] = item[5] * (rng.uniform(0.4, 1.6) if i < 4 else rng.uniform(2.5, 4.5))
            injected["low_stock"].append(
                {"station_id": str(item[0]), "product_code": item[2], "band": "high" if i < 4 else "medium"}
            )

        with cur.copy(
            """COPY fms.daily_station_product (station_id, business_date, product_code, province_id,
                   sales_volume_l, sales_amount, tx_count, opening_stock_l, closing_stock_l,
                   deliveries_l, variance_l, avg_price) FROM STDIN"""
        ) as cp:
            for row in rows:
                cp.write_row(row)

        now = datetime.now(UTC)
        for sid, tank_no, prod, cap, vol, _, _ in latest:
            cur.execute(
                """INSERT INTO fms.tank_latest (station_id, tank_no, measured_at, product_code, probe_status,
                        alarms, product_height_mm, water_height_mm, temperature_c, product_volume_l,
                        water_volume_l, ullage_l, tc_volume_l)
                   VALUES (%s, %s, %s, %s, 'OK', '{}', %s, 0, 24.5, %s, 0, %s, %s)
                   ON CONFLICT (station_id, tank_no) DO UPDATE SET
                        measured_at = EXCLUDED.measured_at, product_code = EXCLUDED.product_code,
                        product_height_mm = EXCLUDED.product_height_mm,
                        product_volume_l = EXCLUDED.product_volume_l, ullage_l = EXCLUDED.ullage_l,
                        tc_volume_l = EXCLUDED.tc_volume_l, probe_status = 'OK'""",
                (
                    sid,
                    tank_no,
                    now - timedelta(minutes=rng.uniform(1, 10)),
                    prod,
                    round(vol / cap * 2500, 1),
                    round(vol, 3),
                    round(cap - vol, 3),
                    round(vol * 0.995, 3),
                ),
            )

        cur.execute("DELETE FROM fms.alerts WHERE code = 'TotalizerMismatch' AND data->>'synthetic' = 'true'")
        station_ids = sorted({str(t[0]) for t in tanks})
        for k in range(3):
            sid = rng.choice(station_ids)
            d = rng.choice(window)
            occurred = datetime(d.year, d.month, d.day, 14, 10 + k, tzinfo=UTC)  # 16:1x local
            gap = round(rng.uniform(40, 250), 1)
            cur.execute(
                """INSERT INTO fms.alerts (station_id, occurred_at, device_type, device_no, code, severity,
                                           message, data)
                   VALUES (%s, %s, 'pump', 1, 'TotalizerMismatch', 'critical', %s, %s)
                   ON CONFLICT DO NOTHING""",
                (
                    sid,
                    occurred,
                    f"Totaliser jumped {gap} L more than recorded sales (possible manual mode)",
                    json.dumps({"synthetic": True, "nozzle_no": 1, "product_code": "PETROL", "gap_l": gap}),
                ),
            )
            injected["totalizer"].append({"station_id": sid, "business_date": d.isoformat()})

        cur.execute("DELETE FROM fms.depot_stock WHERE source = 'synthetic'")
        as_of = now - timedelta(hours=3)
        for name, prov, prod, vol, capv, strategic in [
            ("TAZAMA Ndola Terminal", 2, "DIESEL", 900_000, 2_000_000, False),
            ("TAZAMA Ndola Terminal", 2, "PETROL", 500_000, 1_500_000, False),
            ("Lusaka Fuel Depot", 5, "PETROL", 400_000, 1_000_000, False),
            ("Lusaka Fuel Depot", 5, "DIESEL", 500_000, 1_200_000, False),
            ("National Strategic Reserve", None, "DIESEL", 600_000, 1_000_000, True),
        ]:
            cur.execute(
                """INSERT INTO fms.depot_stock (product_code, depot_name, province_id, volume_l, capacity_l,
                                                is_strategic, as_of, source)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, 'synthetic')""",
                (prod, name, prov, vol, capv, strategic, as_of),
            )
        conn.commit()
    injected["rows"] = len(rows)
    injected["stations"] = len({t[0] for t in tanks})
    injected["start"], injected["end"] = start.isoformat(), (today - timedelta(days=1)).isoformat()
    return injected


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--json-out", type=Path)
    args = ap.parse_args(argv)
    if not args.dsn:
        print("--dsn or DATABASE_URL is required", file=sys.stderr)
        return 2
    info = generate(args.dsn, args.days, args.seed)
    text = json.dumps(info, indent=2)
    if args.json_out:
        args.json_out.write_text(text, encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
