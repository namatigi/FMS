"""Port of the 'regulator' describe block of services/core-api/test/api.test.ts."""

from __future__ import annotations

import datetime as dt

import pytest
from conftest import ST
from helpers import get, seed_telemetry, tokens


@pytest.fixture(scope="module")
def T():
    seed_telemetry()
    return tokens()


def test_overview_national(core_client, T):
    r = get(core_client, T["erb"], "/api/v1/regulator/overview")
    assert r.status_code == 200
    b = r.json()
    petrol = next(x for x in b["by_product"] if x["product_code"] == "PETROL")
    assert petrol["stock_l"] == 25000
    assert petrol["capacity_l"] == 120000
    assert petrol["sales_24h_l"] > 0
    assert petrol["days_of_cover"] == 6.3  # 25000 / (2000 + 2000)
    assert b["stations"]["total"] == 4
    assert b["stations"]["online"] == 1
    assert b["alerts_open"] >= 1
    assert get(core_client, T["owner"], "/api/v1/regulator/overview").status_code == 403
    assert get(core_client, T["zra"], "/api/v1/regulator/overview").status_code == 403


def test_erb_provincial_forced_to_copperbelt(core_client, T):
    o = get(core_client, T["erbcop"], "/api/v1/regulator/overview?province_id=5").json()
    assert o["province_id"] == 2
    assert o["stations"]["total"] == 1
    assert next(x for x in o["by_product"] if x["product_code"] == "PETROL")["stock_l"] == 20000
    prov = get(core_client, T["erbcop"], "/api/v1/regulator/provinces").json()
    assert [p["province_id"] for p in prov] == [2]
    assert get(core_client, T["erbcop"], "/api/v1/regulator/provinces/5/stations").status_code == 404
    st = get(core_client, T["erbcop"], "/api/v1/regulator/provinces/2/stations").json()
    assert [s["code"] for s in st] == ["COP-0001"]
    assert isinstance(st[0]["stock"], list) and isinstance(st[0]["last_price"], list)
    daily = get(core_client, T["erbcop"], "/api/v1/regulator/sales/daily?province_id=5").json()["items"]
    assert len(daily) > 0 and all(d["province_id"] == 2 for d in daily)
    stock = get(core_client, T["erbcop"], "/api/v1/regulator/stock").json()["items"]
    assert all(d["province_id"] == 2 for d in stock)
    comp = get(core_client, T["erbcop"], "/api/v1/regulator/compliance").json()
    for k in ["price_violations", "offline_stations", "variance_anomalies", "fiscal_failures"]:
        assert isinstance(comp[k], list), k
    assert all(s["province_id"] == 2 for s in comp["offline_stations"])
    nat = get(core_client, T["erb"], "/api/v1/regulator/provinces").json()
    assert len(nat) == 10


def test_compliance_national(core_client, T):
    c = get(core_client, T["erb"], "/api/v1/regulator/compliance").json()
    assert any(v["kind"] == "stock_variance" and v["product_code"] == "DIESEL" for v in c["variance_anomalies"])
    assert any(f["station_id"] == ST["LUS"] and f["failed"] > 0 for f in c["fiscal_failures"])
    assert any(s["station_id"] == ST["SOU"] for s in c["offline_stations"])


def test_export_csv_and_json_are_audited(core_client, db, T):
    d = (dt.datetime.now(dt.UTC) + dt.timedelta(hours=2) - dt.timedelta(days=1)).date().isoformat()
    csv = get(core_client, T["erb"], f"/api/v1/regulator/export?date={d}&format=csv")
    assert csv.status_code == 200
    assert "text/csv" in csv["Content-Type"]
    lines = csv.content.decode().strip().split("\r\n")
    assert lines[0].startswith("business_date,province,station_code")
    assert len(lines) == 1 + 4
    js = get(core_client, T["erbcop"], f"/api/v1/regulator/export?date={d}&format=json").json()
    assert js["province_id"] == 2
    assert len(js["items"]) == 2
    rows = db.query("SELECT count(*)::int n FROM fms.audit_log WHERE action = 'regulator.export'")
    assert rows[0]["n"] >= 2
