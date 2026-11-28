"""Port of the 'stations data' describe block of services/core-api/test/api.test.ts."""

from __future__ import annotations

import datetime as dt
import re
from urllib.parse import quote

import pytest
from conftest import ST
from helpers import get, seed_telemetry, tokens


@pytest.fixture(scope="module")
def T():
    seed_telemetry()
    return tokens()


def _ts(s: str) -> float:
    return dt.datetime.fromisoformat(s).timestamp()


def test_tanks_include_days_of_cover(core_client, T):
    r = get(core_client, T["owner"], f"/api/v1/stations/{ST['LUS']}/tanks")
    assert r.status_code == 200
    tanks = r.json()
    assert isinstance(tanks, list)
    t1 = next(t for t in tanks if t["tank_no"] == 1)
    assert t1["product_volume_l"] == 5000
    assert t1["fill_pct"] == 16.7
    assert t1["avg_daily_sales_l"] == 2000
    assert t1["days_of_cover"] == 2.5


def test_transactions_keyset_pagination(core_client, T):
    seen: set[int] = set()
    cursor = None
    pages = 0
    last_ts = float("inf")
    while True:
        url = f"/api/v1/stations/{ST['LUS']}/transactions?limit=50" + (f"&cursor={cursor}" if cursor else "")
        b = get(core_client, T["manager"], url).json()
        for t in b["items"]:
            assert t["id"] not in seen, "duplicate row across pages"
            seen.add(t["id"])
            ts = _ts(t["ended_at"])
            assert ts <= last_ts, "not sorted desc"
            last_ts = ts
        cursor = b["next_cursor"]
        pages += 1
        if not (cursor and pages < 10):
            break
    assert pages == 3
    assert len(seen) == 120
    one = get(core_client, T["manager"], f"/api/v1/stations/{ST['LUS']}/transactions?pump_no=1&limit=500").json()
    assert len(one["items"]) == 60
    keys = ["id", "ended_at", "pump_no", "nozzle_no", "product_code", "volume_l", "price", "amount", "tag", "fiscal_status", "zra_rcpt_no"]
    assert len([k for k in one["items"][0] if k in keys]) == 11
    assert get(core_client, T["manager"], f"/api/v1/stations/{ST['LUS']}/transactions?cursor=bogus").status_code == 400


def test_sales_summary_groups(core_client, T):
    t = dt.datetime.now(dt.UTC) - dt.timedelta(hours=6)
    frm = t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"
    for g in ["hour", "day", "product", "pump"]:
        r = get(core_client, T["owner"], f"/api/v1/stations/{ST['LUS']}/sales/summary?group={g}&from={quote(frm, safe='')}")
        assert r.status_code == 200, r.content
        rows = r.json()
        assert sum(x["tx_count"] for x in rows) == 120, g
        if g == "pump":
            assert all(isinstance(x["pump_no"], int) for x in rows)
        if g == "day":
            assert re.match(r"^\d{4}-\d{2}-\d{2}$", rows[0]["bucket"])


def test_dashboard_overview(core_client, T):
    b = get(core_client, T["owner"], "/api/v1/dashboard/overview").json()
    assert b["stations_total"] == 2
    assert b["stations_online"] == 1
    assert b["stations_offline"] == 1
    assert b["sales_today"]["tx_count"] > 0 and b["sales_today"]["volume_l"] > 0
    assert any(t["station_id"] == ST["LUS"] and t["tank_no"] == 1 for t in b["low_stock_tanks"])
    assert next(p for p in b["by_product"] if p["product_code"] == "PETROL")["stock_l"] == 5000


def test_reconciliation_rows(core_client, T):
    b = get(core_client, T["owner"], f"/api/v1/stations/{ST['LUS']}/reconciliation").json()
    assert len(b["items"]) == 6
