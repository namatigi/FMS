"""Port of the 'partner API' describe block of services/core-api/test/api.test.ts."""

from __future__ import annotations

import pytest
from conftest import PARTNER_KEY
from helpers import seed_telemetry, send, tokens


@pytest.fixture(scope="module")
def T():
    seed_telemetry()
    return tokens()


def codes(items):
    return sorted(s["code"] for s in items)


def key(k: str) -> dict[str, str]:
    return {"HTTP_X_API_KEY": k}


def test_key_auth(core_client, T):
    assert core_client.get("/api/partner/v1/stations").status_code == 401
    assert core_client.get("/api/partner/v1/stations", **key("erbdemo1.wrong")).status_code == 401
    r = core_client.get("/api/partner/v1/stations", **key(PARTNER_KEY))
    assert r.status_code == 200
    assert len(r.json()["items"]) == 4
    for p in ["stock", "sales/daily", "prices", "alerts"]:
        x = core_client.get(f"/api/partner/v1/{p}", **key(PARTNER_KEY))
        assert x.status_code == 200, p
        assert isinstance(x.json()["items"], list), p


def test_scopes_province_limit_and_per_client_rate_limit(core_client, T):
    c = send(
        core_client,
        T["admin"],
        "POST",
        "/api/v1/admin/api-clients",
        {"name": "Copperbelt council", "organisation": "Test Org", "scopes": ["stations:read"], "province_id": 2, "rate_limit_rpm": 3},
    )
    assert c.status_code == 201, c.content
    k = c.json()["api_key"]
    assert k
    h = key(k)
    s = core_client.get("/api/partner/v1/stations", **h)
    assert s.status_code == 200
    assert codes(s.json()["items"]) == ["COP-0001"]
    st = core_client.get("/api/partner/v1/stock", **h)
    assert st.status_code == 403
    third = core_client.get("/api/partner/v1/stations", **h)
    assert third.status_code == 200
    fourth = core_client.get("/api/partner/v1/stations", **h)
    assert fourth.status_code == 429
    assert fourth.json()["error"]["code"] == "rate_limited"
