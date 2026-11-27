from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from fms_analytics.registry import ModelRegistry

SIM = "/analytics/v1/pricing/simulate"


# ----------------------------------------------------------------------- pricing
def test_pricing_default_breakdown(client, auth):
    r = client.post(SIM, json={"product_code": "PETROL"}, headers=auth())
    assert r.status_code == 200, r.text
    body = r.json()
    assert {"indicative_price", "breakdown", "model"} <= set(body)
    assert body["model"] == "erb_cost_buildup_v1" and body["illustrative"] is True
    total = sum(x["zmw_per_l"] for x in body["breakdown"])
    assert body["indicative_price"] == pytest.approx(total, abs=0.01)
    names = {x["component"] for x in body["breakdown"]}
    assert {
        "fob",
        "freight",
        "insurance",
        "excise_duty",
        "fuel_levy",
        "strategic_reserve_fund",
        "road_levy",
        "vat",
        "omc_margin",
        "dealer_margin",
    } <= names
    assert 20 < body["indicative_price"] < 45
    # custom `pricing` model registered in config/models.yaml -> its prediction is included
    cm = body["custom_model"]
    assert cm["model"] == "pricing" and "predicted_price" in cm["outputs"]


def test_pricing_overrides(client, auth):
    base = client.post(SIM, json={"product_code": "DIESEL"}, headers=auth()).json()
    hi_fx = client.post(SIM, json={"product_code": "DIESEL", "fx_rate": 30.0}, headers=auth()).json()
    assert hi_fx["indicative_price"] > base["indicative_price"]
    custom = client.post(
        SIM,
        json={
            "product_code": "DIESEL",
            "fob_usd_per_mt": 700,
            "freight": 80,
            "taxes": {"excise_duty": 0, "carbon_levy": 0.25, "customs_duty": {"type": "pct", "value": 0}},
            "margins": {"omc_margin": 2.0},
            "vat_pct": 0,
        },
        headers=auth(),
    ).json()
    comp = {x["component"]: x["zmw_per_l"] for x in custom["breakdown"]}
    assert comp["excise_duty"] == 0 and comp["carbon_levy"] == 0.25 and comp["omc_margin"] == 2.0
    assert comp["vat"] == 0 and comp["customs_duty"] == 0
    assert custom["assumptions"]["fob_usd_per_mt"] == 700


def test_pricing_validation(client, auth):
    assert client.post(SIM, json={"product_code": "UNOBTAINIUM"}, headers=auth()).status_code == 400
    assert client.post(SIM, json={"fx_rate": 27}, headers=auth()).status_code == 422
    r = client.post(SIM, json={"product_code": "PETROL", "fx_rate": -1}, headers=auth())
    assert r.status_code == 422


# ---------------------------------------------------------------------- registry
def test_list_models(client, auth):
    body = client.get("/analytics/v1/models", headers=auth()).json()
    models = {m["name"]: m for m in body["items"]}
    assert models["reserve_risk"]["status"] == "ready" and models["reserve_risk"]["type"] == "python"
    assert models["pricing"]["status"] == "ready"
    assert models["demand_mlflow"]["status"] == "disabled" and models["demand_mlflow"]["type"] == "http"
    assert "headers" not in models["demand_mlflow"]


def test_reserve_risk_from_db_and_inputs(client, auth):
    r = client.post("/analytics/v1/models/reserve_risk/predict", json={"inputs": {}}, headers=auth())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model"] == "reserve_risk" and body["version"] == "1.0.0"
    prods = {p["product_code"]: p for p in body["outputs"]["products"]}
    assert {"PETROL", "DIESEL"} <= set(prods)
    for p in prods.values():
        assert 0 <= p["stockout_probability"] <= 1
    low = client.post(
        "/analytics/v1/models/reserve_risk/predict",
        json={"inputs": {"product_code": "PETROL", "days_of_cover": 1.0, "demand_cv": 0.2}},
        headers=auth(),
    ).json()["outputs"]["products"][0]
    high = client.post(
        "/analytics/v1/models/reserve_risk/predict",
        json={"inputs": {"product_code": "PETROL", "days_of_cover": 35.0, "demand_cv": 0.2}},
        headers=auth(),
    ).json()["outputs"]["products"][0]
    assert low["stockout_probability"] > 0.8 > 0.2 > high["stockout_probability"]
    assert low["risk"] == "high" and high["risk"] == "low"


def test_pricing_model_predict(client, auth):
    r = client.post(
        "/analytics/v1/models/pricing/predict",
        json={"inputs": {"product_code": "DIESEL", "horizon_days": 14}},
        headers=auth(),
    )
    assert r.status_code == 200
    out = r.json()["outputs"]
    assert out["product_code"] == "DIESEL" and 20 < out["predicted_price"] < 45 and out["n_obs"] > 100


def test_registry_errors(client, auth):
    h = auth()
    assert client.post("/analytics/v1/models/nope/predict", json={"inputs": {}}, headers=h).status_code == 404
    r = client.post("/analytics/v1/models/demand_mlflow/predict", json={"inputs": {}}, headers=h)
    assert r.status_code == 409 and r.json()["error"]["code"] == "model_disabled"
    r = client.post("/analytics/v1/models/pricing/predict", json={"inputs": {}}, headers=h)
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_inputs"
    r = client.post("/analytics/v1/models/pricing/predict", json={"inputs": {"product_code": 5}}, headers=h)
    assert r.status_code == 422


@pytest.fixture()
def reg(client):
    registry = client.app.state.registry
    added: list[str] = []

    def _add(name: str, spec: dict):
        added.append(name)
        return registry.register(name, spec)

    yield _add
    for n in added:
        registry.models.pop(n, None)


def test_python_models_sync_async_ctx(client, auth, reg):
    reg("t_echo", {"type": "python", "entrypoint": "model_fixtures:echo", "version": "9"})
    reg("t_echo2", {"type": "python", "entrypoint": "model_fixtures:echo_no_ctx"})
    reg("t_async", {"type": "python", "entrypoint": "model_fixtures:async_echo"})
    r = client.post("/analytics/v1/models/t_echo/predict", json={"inputs": {"a": 1}}, headers=auth()).json()
    assert r == {
        "outputs": {"echo": {"a": 1}, "provinces": 10, "model": "t_echo"},
        "model": "t_echo",
        "version": "9",
    }
    r = client.post("/analytics/v1/models/t_echo2/predict", json={"inputs": {"b": 1, "a": 2}}, headers=auth())
    assert r.json()["outputs"] == {"keys": ["a", "b"]}
    r = client.post("/analytics/v1/models/t_async/predict", json={"inputs": {"x": "y"}}, headers=auth())
    assert r.json()["outputs"] == {"one": 1, "x": "y"}


def test_python_model_failures(client, auth, reg):
    reg("t_slow", {"type": "python", "entrypoint": "model_fixtures:slow", "timeout_s": 0.3})
    reg("t_slow_async", {"type": "python", "entrypoint": "model_fixtures:slow_async", "timeout_s": 0.3})
    reg("t_bad", {"type": "python", "entrypoint": "model_fixtures:bad_output"})
    reg("t_boom", {"type": "python", "entrypoint": "model_fixtures:boom"})
    reg("t_write", {"type": "python", "entrypoint": "model_fixtures:try_write"})
    reg("t_missing", {"type": "python", "entrypoint": "model_fixtures:does_not_exist"})
    h = auth()
    t0 = time.monotonic()
    r = client.post("/analytics/v1/models/t_slow/predict", json={"inputs": {"sleep_s": 1.5}}, headers=h)
    assert r.status_code == 504 and r.json()["error"]["code"] == "model_timeout"
    assert time.monotonic() - t0 < 1.4
    r = client.post("/analytics/v1/models/t_slow_async/predict", json={"inputs": {"sleep_s": 5}}, headers=h)
    assert r.status_code == 504
    assert (
        client.post("/analytics/v1/models/t_bad/predict", json={"inputs": {}}, headers=h).status_code == 502
    )
    r = client.post("/analytics/v1/models/t_boom/predict", json={"inputs": {}}, headers=h)
    assert r.status_code == 502 and "kaboom" in r.json()["error"]["message"]
    r = client.post("/analytics/v1/models/t_write/predict", json={"inputs": {}}, headers=h)
    assert r.status_code == 502 and "read-only" in r.json()["error"]["message"]
    r = client.post("/analytics/v1/models/t_missing/predict", json={"inputs": {}}, headers=h)
    assert r.status_code == 503
    metrics = client.get("/metrics").text
    assert 'analytics_model_predictions_total{model="t_slow",outcome="timeout"}' in metrics


# ----------------------------------------------------------------- http models
class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        if self.path == "/slow":
            time.sleep(1.5)
        if self.path == "/fail":
            self.send_response(500)
            self.end_headers()
            return
        if self.path == "/mlflow":
            payload = {"predictions": [len(body["inputs"])]}
        else:
            payload = {"outputs": {"received": body["inputs"], "auth": self.headers.get("authorization")}}
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture(scope="module")
def http_server() -> Iterator[str]:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def test_http_models(client, auth, reg, http_server, monkeypatch):
    monkeypatch.setenv("T_MODEL_TOKEN", "s3cret")
    reg(
        "t_http",
        {
            "type": "http",
            "url": f"{http_server}/predict",
            "version": "2",
            "headers": {"Authorization": "Bearer ${T_MODEL_TOKEN}"},
            "timeout_s": 3,
        },
    )
    reg("t_mlflow", {"type": "http", "url": f"{http_server}/mlflow"})
    reg("t_http_slow", {"type": "http", "url": f"{http_server}/slow", "timeout_s": 0.3})
    reg("t_http_fail", {"type": "http", "url": f"{http_server}/fail"})
    h = auth()
    r = client.post("/analytics/v1/models/t_http/predict", json={"inputs": {"q": [1, 2]}}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json() == {
        "outputs": {"received": {"q": [1, 2]}, "auth": "Bearer s3cret"},
        "model": "t_http",
        "version": "2",
    }
    r = client.post("/analytics/v1/models/t_mlflow/predict", json={"inputs": {"a": 1, "b": 2}}, headers=h)
    assert r.json()["outputs"] == {"predictions": [2]}
    r = client.post("/analytics/v1/models/t_http_slow/predict", json={"inputs": {}}, headers=h)
    assert r.status_code == 504
    r = client.post("/analytics/v1/models/t_http_fail/predict", json={"inputs": {}}, headers=h)
    assert r.status_code == 502


def test_invalid_specs_reported():
    reg = ModelRegistry()
    reg.load_dict(
        {
            "models": {
                "no_entry": {"type": "python"},
                "bad_url": {"type": "http", "url": "ftp://x"},
                "Bad Name": {"type": "python", "entrypoint": "a:b"},
                "unknown_key": {"type": "python", "entrypoint": "model_fixtures:echo", "colour": "red"},
            }
        }
    )
    assert all(m.status == "error" for m in reg.models.values())
