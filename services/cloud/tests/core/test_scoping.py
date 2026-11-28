"""Port of the 'scoping matrix' describe block of services/core-api/test/api.test.ts."""

from __future__ import annotations

import pytest
from conftest import ST
from helpers import get, seed_telemetry, send, tokens


@pytest.fixture(scope="module")
def T():
    seed_telemetry()
    return tokens()


def codes(items):
    return sorted(s["code"] for s in items)


def test_station_lists_per_role(core_client, T):
    def lst(t):
        return codes(get(core_client, t, "/api/v1/stations").json()["items"])

    every = ["CEN-0001", "COP-0001", "LUS-0001", "SOU-0001"]
    assert lst(T["owner"]) == ["CEN-0001", "LUS-0001"]
    assert lst(T["manager"]) == ["LUS-0001"]
    assert lst(T["erbcop"]) == ["COP-0001"]
    assert lst(T["erb"]) == every
    assert lst(T["zra"]) == every
    assert lst(T["admin"]) == every


def test_out_of_scope_station_ids_are_404(core_client, T):
    for tok, sid in [(T["manager"], ST["CEN"]), (T["owner"], ST["COP"]), (T["erbcop"], ST["LUS"])]:
        for sfx in ["", "/tanks", "/transactions", "/sales/summary", "/deliveries", "/reconciliation"]:
            r = get(core_client, tok, f"/api/v1/stations/{sid}{sfx}")
            assert r.status_code == 404, f"{sfx} {r.content!r}"
            assert r.json()["error"]["code"] == "not_found"
    assert get(core_client, T["owner"], "/api/v1/stations/not-a-uuid").status_code == 404
    assert get(core_client, T["manager"], f"/api/v1/alerts?station_id={ST['COP']}").status_code == 404
    assert get(core_client, T["manager"], f"/api/v1/stations/{ST['LUS']}").status_code == 200


def test_alerts_and_fiscal_receipts_are_scoped(core_client, T):
    m = get(core_client, T["manager"], "/api/v1/alerts").json()["items"]
    assert len(m) >= 1 and all(a["station_id"] == ST["LUS"] for a in m)
    cop = get(core_client, T["erbcop"], "/api/v1/alerts?status=all").json()["items"]
    assert all(a["station_id"] == ST["COP"] for a in cop)
    fr = get(core_client, T["zra"], "/api/v1/fiscal/receipts").json()
    assert len(fr["items"]) >= 5
    own = get(core_client, T["owner"], f"/api/v1/fiscal/receipts?station_id={ST['LUS']}").json()
    assert len(own["items"]) >= 5


def test_alert_ack_scope_and_roles(core_client, T):
    lus = get(core_client, T["manager"], "/api/v1/alerts").json()["items"][0]
    cop = get(core_client, T["admin"], f"/api/v1/alerts?station_id={ST['COP']}").json()["items"][0]
    assert send(core_client, T["manager"], "POST", f"/api/v1/alerts/{cop['id']}/ack", {}).status_code == 404
    assert send(core_client, T["erb"], "POST", f"/api/v1/alerts/{lus['id']}/ack", {}).status_code == 403
    r = send(core_client, T["manager"], "POST", f"/api/v1/alerts/{lus['id']}/ack", {})
    assert r.status_code == 200
    assert r.json()["status"] == "acknowledged"


def test_delivery_reconciliation_patch(core_client, T):
    d = get(core_client, T["manager"], f"/api/v1/stations/{ST['LUS']}/deliveries").json()["items"][0]
    dc = get(core_client, T["admin"], f"/api/v1/stations/{ST['COP']}/deliveries").json()["items"][0]
    body = {"delivery_note_no": "DN-1", "supplier": "Test Supplier", "invoiced_volume_l": 20100}
    ok = send(core_client, T["manager"], "PATCH", f"/api/v1/deliveries/{d['id']}", body)
    assert ok.status_code == 200, ok.content
    assert ok.json()["invoiced_volume_l"] == 20100
    assert send(core_client, T["manager"], "PATCH", f"/api/v1/deliveries/{dc['id']}", {"supplier": "Test X"}).status_code == 404
    assert send(core_client, T["zra"], "PATCH", f"/api/v1/deliveries/{d['id']}", {"supplier": "Test X"}).status_code == 403
