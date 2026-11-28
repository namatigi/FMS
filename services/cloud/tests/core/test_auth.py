"""Port of the 'auth' describe block of services/core-api/test/api.test.ts."""

from __future__ import annotations

import time

import pytest
from conftest import PASSWORD, ST
from helpers import get, seed_telemetry, send, tokens

from fms_cloud.common.crypto import totp_at


@pytest.fixture(scope="module")
def T():
    seed_telemetry()
    return tokens()


def login(client, email: str, password: str = PASSWORD, **extra):
    return client.post("/api/v1/auth/login", {"email": email, "password": password, **extra}, content_type="application/json")


def refresh(client, token: str):
    return client.post("/api/v1/auth/refresh", {"refresh_token": token}, content_type="application/json")


def test_login_returns_contract_shape(core_client, T):
    r = login(core_client, "owner@zambezi.local")
    assert r.status_code == 200
    b = r.json()
    assert b["access_token"] and b["refresh_token"]
    assert b["expires_in"] == 900
    assert b["token_type"] == "Bearer"
    assert sorted(b["user"].keys()) == ["company_id", "email", "full_name", "id", "province_id", "role"]
    assert b["user"]["role"] == "owner"


def test_wrong_password_401_error_envelope(core_client, T):
    r = login(core_client, "owner@zambezi.local", "nope-nope")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "invalid_credentials"


def test_refresh_rotates_reuse_revokes_family_logout_revokes(core_client, T):
    first = login(core_client, "manager@zambezi.local").json()
    r1 = refresh(core_client, first["refresh_token"])
    assert r1.status_code == 200
    second = r1.json()
    assert second["refresh_token"] != first["refresh_token"]
    assert second["user"]["email"] == "manager@zambezi.local"
    # reuse old -> 401 and family revoked
    reuse = refresh(core_client, first["refresh_token"])
    assert reuse.status_code == 401
    after_reuse = refresh(core_client, second["refresh_token"])
    assert after_reuse.status_code == 401

    fresh = login(core_client, "manager@zambezi.local").json()
    lo = send(core_client, fresh["access_token"], "POST", "/api/v1/auth/logout", {"refresh_token": fresh["refresh_token"]})
    assert lo.status_code == 200
    r2 = refresh(core_client, fresh["refresh_token"])
    assert r2.status_code == 401


def test_me(core_client, T):
    r = get(core_client, T["manager"], "/api/v1/me")
    assert r.status_code == 200
    assert r.json()["role"] == "manager"
    assert r.json()["station_ids"] == [ST["LUS"]]
    assert core_client.get("/api/v1/me").status_code == 401
    assert get(core_client, "garbage.token.here", "/api/v1/me").status_code == 401


def test_lockout_after_5_failures_within_15_min(core_client, db, T):
    c = send(
        core_client,
        T["admin"],
        "POST",
        "/api/v1/admin/users",
        {"email": "lock@test.local", "full_name": "Lock Test", "password": "SomePassword123", "role": "zra_auditor"},
    )
    assert c.status_code == 201, c.content
    for _ in range(5):
        assert login(core_client, "lock@test.local", "wrong-password").status_code == 401
    locked = login(core_client, "lock@test.local", "SomePassword123")
    assert locked.status_code == 429
    assert locked.json()["error"]["code"] == "account_locked"
    n = db.scalar("SELECT count(*)::int n FROM fms.audit_log WHERE action = 'auth.login_failed' AND details->>'email' = 'lock@test.local'")
    assert n >= 5


def test_totp_mfa_enrolment_and_login(core_client, T):
    enr = send(core_client, T["erb"], "POST", "/api/v1/auth/mfa/enroll")
    assert enr.status_code == 200
    secret, url = enr.json()["secret"], enr.json()["otpauth_url"]
    assert url.startswith("otpauth://totp/")
    now = int(time.time())
    wrong = "111111" if totp_at(secret, now) == "000000" else "000000"
    assert send(core_client, T["erb"], "POST", "/api/v1/auth/mfa/verify", {"code": wrong}).status_code == 400
    assert send(core_client, T["erb"], "POST", "/api/v1/auth/mfa/verify", {"code": totp_at(secret, now)}).status_code == 200
    no_code = login(core_client, "erb@erb.local")
    assert no_code.status_code == 401
    assert no_code.json()["error"]["code"] == "mfa_required"
    ok = login(core_client, "erb@erb.local", PASSWORD, totp_code=totp_at(secret, int(time.time())))
    assert ok.status_code == 200
    assert send(core_client, T["erb"], "POST", "/api/v1/auth/mfa/disable", {"code": totp_at(secret, int(time.time()))}).status_code == 200
    assert login(core_client, "erb@erb.local").status_code == 200
    # owners cannot enrol
    assert send(core_client, T["owner"], "POST", "/api/v1/auth/mfa/enroll").status_code == 403
