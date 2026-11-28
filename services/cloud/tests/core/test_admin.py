"""Port of the 'admin' describe block of services/core-api/test/api.test.ts."""

from __future__ import annotations

import re
import time

import pytest
from conftest import ST
from helpers import get, seed_telemetry, send, tokens


@pytest.fixture(scope="module")
def T():
    seed_telemetry()
    return tokens()


def test_crud_company_station_users_never_expose_hashes_api_key_returned_once(core_client, T):
    adm = T["admin"]
    c = send(core_client, adm, "POST", "/api/v1/admin/companies", {"name": "Test Co", "zra_tpin": f"T{int(time.time() * 1000)}"})
    assert c.status_code == 201, c.content
    id_ = c.json()["id"]
    u = send(core_client, adm, "PATCH", f"/api/v1/admin/companies/{id_}", {"contact_phone": "+260"})
    assert u.json()["contact_phone"] == "+260"
    assert get(core_client, adm, f"/api/v1/admin/companies/{id_}").status_code == 200
    assert send(core_client, adm, "DELETE", f"/api/v1/admin/companies/{id_}").status_code == 204
    assert get(core_client, adm, f"/api/v1/admin/companies/{id_}").status_code == 404
    assert get(core_client, T["owner"], "/api/v1/admin/companies").status_code == 403

    users = get(core_client, adm, "/api/v1/admin/users").json()["items"]
    assert len(users) >= 6 and all("password_hash" not in x and "mfa_secret" not in x for x in users)
    bad = send(
        core_client,
        adm,
        "POST",
        "/api/v1/admin/users",
        {"email": "x@test.local", "full_name": "x", "password": "SomePassword123", "role": "owner"},
    )
    assert bad.status_code == 400

    gw = send(
        core_client, adm, "POST", "/api/v1/admin/gateways", {"station_id": ST["SOU"], "gateway_code": f"GW-TEST-{int(time.time() * 1000)}"}
    )
    assert gw.status_code == 201, gw.content
    assert re.match(r"^[A-Za-z0-9_-]{8}\.", gw.json()["api_key"])
    gw_get = get(core_client, adm, f"/api/v1/admin/gateways/{gw.json()['id']}").json()
    assert "api_key" not in gw_get and "api_key_hash" not in gw_get
    send(core_client, adm, "DELETE", f"/api/v1/admin/gateways/{gw.json()['id']}")

    dup = send(
        core_client,
        adm,
        "POST",
        "/api/v1/admin/tanks",
        {"station_id": ST["LUS"], "tank_no": 1, "product_code": "PETROL", "capacity_l": 1000},
    )
    assert dup.status_code == 409
