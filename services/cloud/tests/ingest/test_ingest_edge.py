"""POST /ingest/v1/edge/batches (port of services/ingest-api/test/edge.test.ts)."""

from __future__ import annotations

import pytest

from fms_cloud.common.jsonutil import iso

from .ingest_helpers import (
    EDGE_URL,
    LUS,
    Fixture,
    create_fixture_station,
    edge_batch,
    edge_headers,
    gz,
    iso_ago,
    now_utc,
    post,
    pump_tx,
    tank_measurement,
)


def send(client, f: Fixture, records, gzip: bool = False, headers: dict[str, str] | None = None):
    batch = edge_batch(f, records)
    h = {**edge_headers(f), **(headers or {})}
    if gzip:
        h["content-encoding"] = "gzip"
    return post(client, EDGE_URL, gz(batch) if gzip else batch, headers=h)


@pytest.fixture
def f(db) -> Fixture:
    return create_fixture_station(db, "edge")


def test_health_readiness_and_metrics(ingest_client):
    assert ingest_client.get("/healthz").status_code == 200
    assert ingest_client.get("/readyz").status_code == 200
    m = ingest_client.get("/metrics")
    assert m.status_code == 200
    body = m.content.decode()
    assert "fms_ingest_records_total" in body or "fms_ingest_batch_duration_seconds" in body


def test_auth_seed_key_works_bad_missing_and_wrong_station_rejected(ingest_client, f):
    ok = send(ingest_client, LUS, [{"seq": 1, **pump_tx(LUS.ptsId)}])
    assert ok.status_code == 200, ok.content
    assert ok.json()["accepted"] == [1]

    bad = send(ingest_client, f.but(gwKey="nope"), [])
    assert bad.status_code == 401
    missing = post(ingest_client, EDGE_URL, edge_batch(f, []))
    assert missing.status_code == 401
    wrong_station = send(ingest_client, f.but(code="LUS-0001"), [])
    assert wrong_station.status_code == 403
    # a record from a controller of another station is rejected (non-retryable)
    foreign = send(ingest_client, f, [{"seq": 9, **pump_tx(LUS.ptsId)}])
    assert foreign.status_code == 200
    assert foreign.json()["rejected"][0]["seq"] == 9
    assert foreign.json()["rejected"][0]["retryable"] is False


def test_all_record_kinds_persisted_and_resend_is_idempotent(ingest_client, db, f):
    ended = iso_ago(3600_000)
    tx = pump_tx(f.ptsId, ended_at=ended, pump_no=2, nozzle_no=2, pts_grade_id=2, volume_l=40, price=29.95, amount=1198)
    tx_no = tx["data"]["pts_transaction_no"]
    measured_at = iso_ago(1800_000)
    records = [
        {"seq": 101, **tx},
        {"seq": 102, **tank_measurement(f.ptsId, tank_no=2, measured_at=measured_at, product_volume_l=30000, alarms=["HighWater"])},
        {
            "seq": 103,
            "kind": "tank_delivery",
            "data": {
                "pts_id": f.ptsId,
                "tank_no": 2,
                "pts_grade_id": 2,
                "started_at": iso_ago(7200_000),
                "ended_at": iso_ago(6600_000),
                "start_volume_l": 12000,
                "end_volume_l": 30000,
                "start_tc_volume_l": None,
                "end_tc_volume_l": None,
                "start_height_mm": 500,
                "end_height_mm": 1400,
                "start_water_mm": 2,
                "end_water_mm": 3,
                "start_temperature_c": 24,
                "end_temperature_c": 22,
                "start_density_kg_m3": 840,
                "end_density_kg_m3": 838,
            },
        },
        {
            "seq": 104,
            "kind": "alert",
            "data": {
                "pts_id": f.ptsId,
                "occurred_at": iso_ago(600_000),
                "device_type": "controller",
                "device_no": None,
                "code": "PowerLoss",
                "severity": "critical",
                "message": "Mains power lost",
            },
        },
        {
            "seq": 105,
            "kind": "status",
            "data": {"pts_id": f.ptsId, "reported_at": iso(now_utc()), "status": {"Pumps": [{"Id": 1, "Status": "Idle"}]}},
        },
        {
            "seq": 106,
            "kind": "fiscal_receipt",
            "data": {
                "pump_no": 2,
                "pts_transaction_no": tx_no,
                "tx_ended_at": ended,
                "invoice_no": f"INV-{tx_no}",
                "status": "signed",
                "zra_rcpt_no": "123",
                "zra_tot_rcpt_no": "456",
                "zra_internal_data": "INTDATA",
                "zra_signature": "SIG",
                "zra_sdc_id": "SDC1",
                "zra_mrc_no": "MRC1",
                "zra_qr_url": "https://example/qr",
                "zra_signed_at": iso(now_utc()),
                "printed_at": None,
                "attempts": 1,
                "last_error": None,
            },
        },
        {
            "seq": 107,
            "kind": "heartbeat",
            "data": {
                "gateway_version": "1.2.3",
                "backlog": 42,
                "fiscal_backlog": 1,
                "controllers_online": [f.ptsId],
                "disk_free_mb": 1000,
                "uptime_s": 99,
            },
        },
    ]
    res = send(ingest_client, f, records)
    assert res.status_code == 200, res.content
    body = res.json()
    assert sorted(body["accepted"]) == [101, 102, 103, 104, 105, 106, 107]
    assert body["rejected"] == []

    def q(sql, p=None):
        return db.query(sql, [f.stationId] if p is None else p)

    t = q(
        "SELECT product_code, tank_no, fiscal_status, source FROM fms.pump_transactions WHERE station_id = $1 AND pts_transaction_no = $2",
        [f.stationId, tx_no],
    )
    assert t == [{"product_code": "DIESEL", "tank_no": 2, "fiscal_status": "signed", "source": "edge"}]
    tl = q("SELECT product_code, product_volume_l, alarms FROM fms.tank_latest WHERE station_id = $1 AND tank_no = 2")
    assert tl == [{"product_code": "DIESEL", "product_volume_l": 30000, "alarms": ["HighWater"]}]
    dl = q("SELECT product_code, received_volume_l FROM fms.tank_deliveries WHERE station_id = $1")
    assert dl == [{"product_code": "DIESEL", "received_volume_l": 18000}]
    al = q("SELECT code, severity FROM fms.alerts WHERE station_id = $1 ORDER BY code")
    assert al == [{"code": "HighWater", "severity": "warning"}, {"code": "PowerLoss", "severity": "critical"}]
    jobs = q(
        """SELECT kind, payload->>'event' AS event, (payload->>'province_id')::int AS province_id FROM fms.jobs
            WHERE payload->>'station_id' = $1::text AND kind IN ('notify','webhook') ORDER BY kind"""
    )
    assert jobs == [
        {"kind": "notify", "event": None, "province_id": 5},
        {"kind": "webhook", "event": "critical_alert", "province_id": 5},
    ]
    ctl = q("SELECT last_status FROM fms.controllers WHERE station_id = $1")
    assert ctl[0]["last_status"] == {"Pumps": [{"Id": 1, "Status": "Idle"}]}
    gw = q("SELECT version, last_backlog, last_seen_at IS NOT NULL AS seen FROM fms.edge_gateways WHERE station_id = $1")
    assert gw == [{"version": "1.2.3", "last_backlog": 42, "seen": True}]
    fr = q("SELECT status, fiscalised_by, zra_rcpt_no FROM fms.fiscal_receipts WHERE station_id = $1")
    assert fr == [{"status": "signed", "fiscalised_by": "edge", "zra_rcpt_no": "123"}]
    roll = q("SELECT count(*)::int n FROM fms.jobs WHERE kind = 'rollup' AND dedupe_key LIKE 'rollup:' || $1::text || ':%'")
    assert roll[0]["n"] >= 1
    # edge-mode stations never get cloud fiscalise jobs
    assert q("SELECT count(*)::int n FROM fms.jobs WHERE kind = 'fiscalise' AND payload->>'station_id' = $1::text")[0]["n"] == 0

    # ---- resend exactly the same records (at-least-once delivery) -> all accepted, nothing duplicated
    again = send(ingest_client, f, records)
    assert again.status_code == 200
    assert sorted(again.json()["accepted"]) == [101, 102, 103, 104, 105, 106, 107]
    assert q("SELECT count(*)::int n FROM fms.pump_transactions WHERE station_id = $1")[0]["n"] == 1
    assert q("SELECT count(*)::int n FROM fms.alerts WHERE station_id = $1")[0]["n"] == 2
    assert q("SELECT count(*)::int n FROM fms.tank_deliveries WHERE station_id = $1")[0]["n"] == 1
    assert q("SELECT count(*)::int n FROM fms.fiscal_receipts WHERE station_id = $1")[0]["n"] == 1
    assert q("SELECT count(*)::int n FROM fms.jobs WHERE kind IN ('notify','webhook') AND payload->>'station_id' = $1::text")[0]["n"] == 2


def test_gzip_body_is_accepted(ingest_client, db, f):
    tx = pump_tx(f.ptsId)
    res = send(ingest_client, f, [{"seq": 201, **tx}], gzip=True)
    assert res.status_code == 200, res.content
    assert res.json()["accepted"] == [201]
    n = db.scalar(
        "SELECT count(*)::int n FROM fms.pump_transactions WHERE station_id = $1 AND pts_transaction_no = $2",
        [f.stationId, tx["data"]["pts_transaction_no"]],
    )
    assert n == 1
    bad_enc = send(ingest_client, f, [], headers={"content-encoding": "br"})
    assert bad_enc.status_code == 415


def test_invalid_records_rejected_individually_duplicate_seqs_accepted(ingest_client, f):
    tx = pump_tx(f.ptsId)
    res = send(
        ingest_client,
        f,
        [
            {"seq": 301, **tx},
            {"seq": 301, **tx},
            {"seq": 302, "kind": "pump_transaction", "data": {"pts_id": f.ptsId, "pump_no": "x"}},
            {"seq": 303, "kind": "teleport", "data": {}},
            {"seq": 304, **pump_tx(f.ptsId, ended_at="2026-11-27T10:00:00")},  # no offset
        ],
    )
    assert res.status_code == 200
    b = res.json()
    assert b["accepted"] == [301, 301]
    assert sorted(r["seq"] for r in b["rejected"]) == [302, 303, 304]
    assert all(r["retryable"] is False for r in b["rejected"])


def test_edge_commands_delivered_redelivered_until_acked_then_forward_only(ingest_client, db, f):
    db.execute(
        """INSERT INTO fms.edge_commands (id, station_id, type, command, created_at) VALUES
         ('cmd-a', $1, 'reload_config', jsonb_build_object('id', 'cmd-a', 'type', 'reload_config'), now() - interval '2 s'),
         ('cmd-b', $1, 'set_prices', jsonb_build_object('id', 'cmd-b', 'type', 'set_prices',
             'prices', jsonb_build_array(jsonb_build_object('pts_grade_id', 1, 'price', 31.5)), 'effective_at', '2026-12-01T00:00:00+02:00'), now() - interval '1 s'),
         ('cmd-x', $1, 'reload_config', jsonb_build_object('id', 'cmd-x', 'type', 'reload_config'), now() - interval '3 s')""",
        [f.stationId],
    )
    db.execute("UPDATE fms.edge_commands SET expires_at = now() - interval '1 s' WHERE id = 'cmd-x'")

    def status():
        return {r["id"]: r["status"] for r in db.query("SELECT id, status FROM fms.edge_commands WHERE station_id = $1", [f.stationId])}

    hb = {"gateway_version": "1.2.4", "backlog": 0, "fiscal_backlog": 0, "controllers_online": [], "disk_free_mb": None, "uptime_s": 1}
    r1 = send(ingest_client, f, [{"seq": 401, "kind": "heartbeat", "data": hb}])
    assert r1.status_code == 200
    cmds = r1.json()["commands"]
    assert [c["id"] for c in cmds] == ["cmd-a", "cmd-b"], "expired command is not delivered"
    assert cmds[1]["type"] == "set_prices"
    assert cmds[1]["prices"] == [{"pts_grade_id": 1, "price": 31.5}]
    assert status() == {"cmd-a": "delivered", "cmd-b": "delivered", "cmd-x": "queued"}

    # Within the redelivery window nothing is resent.
    assert send(ingest_client, f, []).json()["commands"] == []

    # Response "lost": no ack arrives; once the window passes the commands are redelivered.
    db.execute("UPDATE fms.edge_commands SET last_delivered_at = now() - interval '1 hour' WHERE station_id = $1", [f.stationId])
    r3 = send(ingest_client, f, [])
    assert [c["id"] for c in r3.json()["commands"]] == ["cmd-a", "cmd-b"]

    # Acks: cmd-a applied (received + applied in one batch), cmd-b received then failed; unknown id ignored.
    at = "2026-11-27T10:00:00+02:00"

    def ack(seq, cid, st, at_=at, result=None):
        return {"seq": seq, "kind": "command_ack", "data": {"command_id": cid, "status": st, "at": at_, "result": result}}

    r4 = send(
        ingest_client,
        f,
        [
            ack(410, "cmd-a", "received"),
            ack(411, "cmd-b", "received"),
            ack(412, "cmd-a", "applied", "2026-11-27T10:00:01+02:00", {"ok": True}),
            ack(413, "nope", "applied"),
            ack(414, "cmd-b", "bogus"),
        ],
    )
    assert r4.status_code == 200
    assert sorted(r4.json()["accepted"]) == [410, 411, 412, 413]
    assert [r["seq"] for r in r4.json()["rejected"]] == [414]
    assert status() == {"cmd-a": "applied", "cmd-b": "received", "cmd-x": "queued"}

    # A received command is never redelivered, even after the window.
    db.execute("UPDATE fms.edge_commands SET last_delivered_at = now() - interval '1 hour' WHERE station_id = $1", [f.stationId])
    assert send(ingest_client, f, []).json()["commands"] == []

    # Late/duplicate 'received' does not downgrade; 'failed' raises a CommandFailed alert.
    send(
        ingest_client,
        f,
        [
            ack(420, "cmd-a", "received"),
            ack(421, "cmd-b", "failed", "2026-11-27T10:05:00+02:00", {"error": "controller rejected price"}),
        ],
    )
    assert status() == {"cmd-a": "applied", "cmd-b": "failed", "cmd-x": "queued"}
    row = db.one(
        """SELECT e.result, e.received_at IS NOT NULL AS rec, e.completed_at IS NOT NULL AS done,
              (SELECT count(*)::int FROM fms.alerts a WHERE a.station_id = e.station_id AND a.code = 'CommandFailed') AS alerts
         FROM fms.edge_commands e WHERE e.id = 'cmd-b'"""
    )
    assert row == {"result": {"error": "controller rejected price"}, "rec": True, "done": True, "alerts": 1}


# ---------------------------------------------------------------- request handling (Fastify behaviours, not in the TS suite)


def test_request_errors_413_415_400(ingest_client, f, configure_ingest):
    configure_ingest(rate_limit_rps=0, max_records_per_batch=2, body_limit_bytes=4096)
    many = send(ingest_client, f, [{"seq": i, **pump_tx(f.ptsId)} for i in range(3)])
    assert many.status_code == 413
    assert many.json() == {"error": {"code": "too_many_records", "message": "max 2 records per batch"}}

    big = post(ingest_client, EDGE_URL, "x" * 5000, headers=edge_headers(f))
    assert big.status_code == 413
    assert big.json()["error"]["message"] == "Request body is too large"
    # the limit applies to the decompressed gzip stream
    bomb = post(ingest_client, EDGE_URL, gz({"pad": "0" * 100_000}), headers={**edge_headers(f), "content-encoding": "gzip"})
    assert bomb.status_code == 413

    not_gzip = post(ingest_client, EDGE_URL, b"plain", headers={**edge_headers(f), "content-encoding": "gzip"})
    assert not_gzip.status_code == 400
    media = post(ingest_client, EDGE_URL, "<x/>", headers=edge_headers(f), content_type="application/xml")
    assert media.status_code == 415
    bad_json = post(ingest_client, EDGE_URL, "{nope", headers=edge_headers(f))
    assert bad_json.status_code == 400
    assert bad_json.json()["error"]["code"] == "FST_ERR_CTP_INVALID_JSON_BODY"
    no_records = post(ingest_client, EDGE_URL, {"station_code": f.code}, headers=edge_headers(f))
    assert no_records.status_code == 400
    assert no_records.json()["error"]["code"] == "invalid_batch"
    gw_mismatch = post(ingest_client, EDGE_URL, {**edge_batch(f, []), "gateway_code": "GW-OTHER"}, headers=edge_headers(f))
    assert gw_mismatch.status_code == 403
    assert ingest_client.get(EDGE_URL).status_code == 404


def test_rate_limited_with_retry_after(ingest_client, f, configure_ingest):
    configure_ingest(rate_limit_rps=1, rate_limit_burst=1)
    assert send(ingest_client, f, []).status_code == 200
    r = send(ingest_client, f, [])
    assert r.status_code == 429
    assert r["Retry-After"] == "1"
    assert r.json() == {"error": {"code": "rate_limited", "message": "slow down"}}


def test_db_failure_on_one_record_falls_back_to_per_record(ingest_client, db, f):
    good = pump_tx(f.ptsId)
    res = send(ingest_client, f, [{"seq": 501, **good}, {"seq": 502, **pump_tx(f.ptsId, volume_l=1e15)}])  # NUMERIC(14,3) overflow
    assert res.status_code == 200, res.content
    b = res.json()
    assert b["accepted"] == [501]
    assert [r["seq"] for r in b["rejected"]] == [502]
    assert b["rejected"][0]["error"].startswith("db: ")
    assert b["rejected"][0]["retryable"] is False
    n = db.scalar("SELECT count(*)::int FROM fms.pump_transactions WHERE station_id = $1", [f.stationId])
    assert n == 1
