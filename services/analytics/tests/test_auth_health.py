from __future__ import annotations

import pytest
from conftest import make_token

REGULATOR_GETS = [
    "/analytics/v1/forecast/demand",
    "/analytics/v1/reserve/national",
    "/analytics/v1/anomalies",
    "/analytics/v1/models",
]


def test_health_ready_metrics(client):
    assert client.get("/healthz").json() == {"status": "ok"}
    r = client.get("/readyz")
    assert r.status_code == 200 and r.json()["database"] == "ok"
    client.get("/analytics/v1/models")  # generate a labelled request
    m = client.get("/metrics")
    assert m.status_code == 200
    assert "analytics_http_requests_total" in m.text


@pytest.mark.parametrize("path", [*REGULATOR_GETS, "/analytics/v1/forecast/stockout"])
def test_missing_token_401(client, path):
    r = client.get(path)
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthorized"


def test_bad_and_expired_tokens(client):
    bad = make_token("erb_national", secret="wrong-secret")
    r = client.get("/analytics/v1/models", headers={"Authorization": f"Bearer {bad}"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_token"
    expired = make_token("erb_national", exp_in=-120)
    r = client.get("/analytics/v1/models", headers={"Authorization": f"Bearer {expired}"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "token_expired"


@pytest.mark.parametrize("role", ["owner", "manager", "zra_auditor"])
@pytest.mark.parametrize("path", REGULATOR_GETS)
def test_non_regulators_forbidden(client, auth, role, path):
    r = client.get(path, headers=auth(role, company_id="11111111-1111-1111-1111-111111111111"))
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "forbidden"


def test_non_regulator_cannot_simulate_or_predict(client, auth):
    h = auth("owner", company_id="11111111-1111-1111-1111-111111111111")
    assert (
        client.post("/analytics/v1/pricing/simulate", json={"product_code": "PETROL"}, headers=h).status_code
        == 403
    )
    assert (
        client.post("/analytics/v1/models/pricing/predict", json={"inputs": {}}, headers=h).status_code == 403
    )


def test_zra_auditor_cannot_stockout(client, auth):
    assert client.get("/analytics/v1/forecast/stockout", headers=auth("zra_auditor")).status_code == 403


@pytest.mark.parametrize("role", ["erb_national", "platform_admin"])
def test_regulators_allowed(client, auth, role):
    assert client.get("/analytics/v1/models", headers=auth(role)).status_code == 200
