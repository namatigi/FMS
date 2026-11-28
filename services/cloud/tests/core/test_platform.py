"""Port of the 'platform' describe block of services/core-api/test/api.test.ts.

The OpenAPI document is served by Django Ninja at /api/openapi.json (core-api: /api/docs/json).
"""

from __future__ import annotations

import time

import pytest
from conftest import ST
from helpers import db, get, seed_telemetry, tokens


@pytest.fixture(scope="module")
def T():
    seed_telemetry()
    return tokens()


def test_openapi_is_generated(core_client, T):
    r = core_client.get("/api/openapi.json")
    assert r.status_code == 200
    spec = r.json()
    assert spec["openapi"].startswith("3.")  # core-api: '3.0.3' (@fastify/swagger); Ninja generates 3.1
    for p in [
        "/api/v1/auth/login",
        "/api/v1/stations/{id}/transactions",
        "/api/v1/regulator/overview",
        "/api/v1/admin/users",
        "/api/partner/v1/stations",
        "/api/v1/stream",
    ]:
        assert p in spec["paths"], p
    assert core_client.get("/api/docs").status_code == 200


def test_health_readiness_and_metrics(core_client, T):
    assert core_client.get("/healthz").status_code == 200
    assert core_client.get("/readyz").status_code == 200
    m = core_client.get("/metrics")
    assert b"http_request_duration_seconds" in m.content


def test_unknown_route_error_envelope(core_client, T):
    r = core_client.get("/api/v1/nope")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


def test_sse_stream_pushes_snapshot_and_new_sales(core_client, T):
    r = core_client.get(f"/api/v1/stream?station_id={ST['LUS']}&token={T['manager']}")
    assert r.status_code == 200
    assert "text/event-stream" in r["Content-Type"]
    got: list[str] = []
    buf = ""
    inserted = False
    deadline = time.monotonic() + 8
    try:
        for chunk in r.streaming_content:
            buf += chunk.decode()
            if not inserted and "event: tank_latest" in buf:
                inserted = True
                db.execute(
                    """INSERT INTO fms.pump_transactions (station_id, pts_id, pts_transaction_no, pump_no, nozzle_no, product_code, ended_at, volume_l, price, amount)
                       VALUES ($1, 'TEST-CORE', 9999, 2, 1, 'PETROL', now(), 10, 31.85, 318.5)""",
                    [ST["LUS"]],
                )
            if "event: sales" in buf:
                got = [ln for ln in buf.split("\n") if ln.startswith("event: ")]
                break
            assert time.monotonic() < deadline, f"SSE timeout: {buf!r}"
    finally:
        r.close()  # GeneratorExit -> the stream generator ends
    assert "event: ready" in got
    assert "event: tank_latest" in got
    assert "event: sales" in got
    oos = get(core_client, T["manager"], f"/api/v1/stream?station_id={ST['COP']}")
    assert oos.status_code == 404


def test_sse_generator_releases_client_gauge_on_close(core_client, T):
    from fms_cloud.core.metrics import SSE_CLIENTS

    before = SSE_CLIENTS._value.get()
    r = core_client.get(f"/api/v1/stream?station_id={ST['LUS']}", HTTP_AUTHORIZATION=f"Bearer {T['manager']}")
    it = iter(r.streaming_content)
    assert next(it).startswith(b"event: ready")
    assert SSE_CLIENTS._value.get() == before + 1
    r.close()
    assert SSE_CLIENTS._value.get() == before
