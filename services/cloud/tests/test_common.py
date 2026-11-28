"""Foundation checks: crypto interop with the node services, SQL placeholder rewriting, JSON rendering."""

import datetime as dt

from fms_cloud.common import crypto
from fms_cloud.common.db import convert_sql
from fms_cloud.common.jsonutil import dumps, iso
from fms_cloud.common.sqlutil import decode_cursor, encode_cursor, round_


def test_seed_password_hash_verifies():
    # db/seed/001_demo.sql hash, produced by node's crypto.scrypt
    h = "scrypt$16384$8$1$w7vXiGeMVRNXTVyw+ec+QA==$vroHQeQLZHrHADYdk9MAwvlI7W9dX1d00faizG29Pajs3P+cr0UxH21raUzaW694nYo+s7oy7PM3G+7ByUg2Iw=="
    assert crypto.verify_password("ChangeMe123!", h)
    assert not crypto.verify_password("wrong", h)
    assert not crypto.verify_password("x", None)
    assert crypto.verify_password("pw-1", crypto.hash_password("pw-1"))


def test_jwt_roundtrip_and_expiry():
    tok = crypto.sign_jwt({"sub": "u1", "role": "owner"}, "s" * 20, 60, now=1000)
    assert crypto.verify_jwt(tok, "s" * 20, now=1000)["sub"] == "u1"
    assert crypto.verify_jwt(tok, "s" * 20, now=1061) is None
    assert crypto.verify_jwt(tok, "t" * 20, now=1000) is None


def test_totp_rfc6238_vector():
    # RFC 6238 SHA1 secret "12345678901234567890", T=59 -> 94287082 (8 digits) -> 287082 (6)
    import base64

    secret = base64.b32encode(b"12345678901234567890").decode()
    assert crypto.totp_at(secret, 59) == "287082"
    assert crypto.verify_totp(secret, "287082", now=59)


def test_webhook_and_pts_signatures():
    assert crypto.sign_webhook("k", "{}", 1700000000).startswith("t=1700000000,v1=")
    sig = crypto.hmac_sha256_hex("s3cret", b'{"a":1}')
    assert crypto.verify_pts_signature("s3cret", b'{"a":1}', sig)
    assert crypto.verify_pts_signature("s3cret", b'{"a":1}', sig.upper())
    assert not crypto.verify_pts_signature("s3cret", b'{"a":1}', None)
    assert crypto.verify_pts_signature(None, b"x", None)


def test_sql_placeholders():
    assert convert_sql("a = $1 AND b = $1 OR c LIKE 'x%' AND d = $12") == "a = %(p1)s AND b = %(p1)s OR c LIKE 'x%%' AND d = %(p12)s"


def test_json_rendering_matches_javascript():
    t = dt.datetime(2026, 11, 27, 8, 15, 30, 123456, tzinfo=dt.UTC)
    assert iso(t) == "2026-11-27T08:15:30.123Z"
    assert dumps({"t": t, "d": dt.date(2026, 1, 2), "n": 5.0}) == '{"t":"2026-11-27T08:15:30.123Z","d":"2026-01-02","n":5.0}'
    assert round_(2.345, 2) == 2.35 and round_(-0.5, 0) == 0 and round_(None) is None


def test_cursor_roundtrip_is_node_compatible():
    # Buffer.from(JSON.stringify(['2026-01-01T00:00:00.000Z', 5])).toString('base64url')
    c = encode_cursor(["2026-01-01T00:00:00.000Z", 5])
    assert c == "WyIyMDI2LTAxLTAxVDAwOjAwOjAwLjAwMFoiLDVd"
    assert decode_cursor(c) == ["2026-01-01T00:00:00.000Z", 5]
    assert decode_cursor("!!") is None


def test_db_rows_are_normalised(db):
    row = db.one(
        "SELECT 1.50::numeric AS n, 7::bigint AS b, '2026-01-02'::date AS d, '{\"a\":1}'::jsonb AS j, gen_random_uuid() AS u, $1::int AS p",
        [3],
    )
    assert (
        row["n"] == 1.5
        and row["b"] == 7
        and row["d"] == "2026-01-02"
        and row["j"] == {"a": 1}
        and isinstance(row["u"], str)
        and row["p"] == 3
    )


def test_health(core_client):
    assert core_client.get("/healthz").json() == {"status": "ok"}
    assert core_client.get("/readyz").json() == {"status": "ready"}
    r = core_client.get("/api/v1/nope")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
