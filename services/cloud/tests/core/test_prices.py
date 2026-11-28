"""Port of the 'prices' describe block of services/core-api/test/api.test.ts."""

from __future__ import annotations

import datetime as dt

import pytest
from conftest import ST
from helpers import get, seed_telemetry, send, tokens


@pytest.fixture(scope="module")
def T():
    seed_telemetry()
    return tokens()


def _iso(d: dt.datetime) -> str:
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def _put(client, tok, station, prices):
    return send(client, tok, "PUT", f"/api/v1/stations/{station}/prices", {"prices": prices})


def test_above_erb_cap_is_rejected(core_client, T):
    r = _put(core_client, T["owner"], ST["LUS"], [{"pts_grade_id": 1, "price": 40.0}])
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "price_above_cap"


def test_valid_price_queues_edge_command(core_client, db, T):
    r = _put(core_client, T["owner"], ST["LUS"], [{"pts_grade_id": 1, "price": 31.99}, {"pts_grade_id": 2, "price": 30.1}])
    assert r.status_code == 200, r.content
    b = r.json()
    assert b["command_status"] == "queued"
    rows = db.query("SELECT station_id, type, status, command, created_by FROM fms.edge_commands WHERE id = $1", [b["command_id"]])
    assert rows[0]["station_id"] == ST["LUS"]
    assert rows[0]["type"] == "set_prices"
    assert rows[0]["status"] == "queued"
    assert rows[0]["created_by"]
    assert rows[0]["command"]["id"] == b["command_id"]
    assert rows[0]["command"]["prices"] == [{"pts_grade_id": 1, "price": 31.99}, {"pts_grade_id": 2, "price": 30.1}]
    lst = send(core_client, T["owner"], "GET", f"/api/v1/stations/{ST['LUS']}/commands")
    assert lst.status_code == 200, lst.content
    assert lst.json()["items"][0]["id"] == b["command_id"]
    assert lst.json()["items"][0]["created_by_name"] == "Zambezi Owner"
    filtered = send(core_client, T["owner"], "GET", f"/api/v1/stations/{ST['LUS']}/commands?status=applied")
    assert filtered.json()["items"] == []
    out = send(core_client, T["owner"], "GET", f"/api/v1/stations/{ST['COP']}/commands")
    assert out.status_code == 404, "other company station is out of scope"
    g = db.query("SELECT price FROM fms.fuel_grades WHERE station_id = $1 AND pts_grade_id = 1", [ST["LUS"]])
    assert g[0]["price"] == 31.99
    pc = db.query("SELECT count(*)::int n FROM fms.price_changes WHERE station_id = $1 AND kind = 'station'", [ST["LUS"]])
    assert pc[0]["n"] == 2
    au = db.query("SELECT count(*)::int n FROM fms.audit_log WHERE action = 'price.station_set' AND entity_id = $1", [ST["LUS"]])
    assert au[0]["n"] >= 1


def test_role_and_scope_rules_for_put_prices(core_client, T):
    assert _put(core_client, T["manager"], ST["LUS"], [{"pts_grade_id": 1, "price": 30}]).status_code == 403
    assert _put(core_client, T["owner"], ST["COP"], [{"pts_grade_id": 1, "price": 30}]).status_code == 404
    assert _put(core_client, T["owner"], ST["LUS"], [{"pts_grade_id": 99, "price": 30}]).status_code == 422


def test_province_cap_overrides_national(core_client, T):
    r = send(core_client, T["erbcop"], "POST", "/api/v1/regulator/prices", {"product_code": "PETROL", "province_id": 2, "price": 31})
    assert r.status_code == 403
    # TS used now - 1s; 10s tolerates host/Postgres-container clock skew (the cap must be in force by DB now()).
    eff = _iso(dt.datetime.now(dt.UTC) - dt.timedelta(seconds=10))
    cap = {"product_code": "PETROL", "province_id": 5, "price": 31.5, "effective_at": eff}
    c = send(core_client, T["erb"], "POST", "/api/v1/regulator/prices", cap)
    assert c.status_code == 201, c.content
    assert _put(core_client, T["owner"], ST["LUS"], [{"pts_grade_id": 1, "price": 31.99}]).status_code == 422
    # CEN-0001 (province 1) still uses national cap 32.15
    assert _put(core_client, T["owner"], ST["CEN"], [{"pts_grade_id": 1, "price": 31.99}]).status_code == 200
    caps = get(core_client, T["erb"], "/api/v1/regulator/prices").json()["items"]
    assert any(x["province_id"] == 5 and x["price"] == 31.5 for x in caps)
    cop_caps = get(core_client, T["erbcop"], "/api/v1/regulator/prices").json()["items"]
    assert all(x["province_id"] is None or x["province_id"] == 2 for x in cop_caps)
