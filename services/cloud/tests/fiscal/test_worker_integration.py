"""Port of services/fiscal-worker/src/test/integration.test.ts: real PostgreSQL and the mock VSDC."""

from __future__ import annotations

import dataclasses
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import threading
import time

import httpx
import pytest

from fms_cloud.fiscal.app import create_app
from fms_cloud.fiscal.core import Log
from fms_cloud.fiscal.httpserver import HttpDeps, start_http_server
from fms_cloud.fiscal.jscompat import js_dumps
from fms_cloud.fiscal.scheduler import Scheduler, SchedulerDeps
from fms_cloud.fiscal.zra import format_vsdc_datetime

CEN = "aaaaaaaa-0000-0000-0000-000000000002"  # CEN-0001, direct mode (see conftest.py)
LUS = "aaaaaaaa-0000-0000-0000-000000000001"  # LUS-0001, edge mode
LUS_PTS = "003B00265030500420303531"

SILENT = Log("fms.fiscal_worker.test")


@pytest.fixture
def jobs_of(q):
    return lambda kind: q("SELECT * FROM fms.jobs WHERE kind = $1 ORDER BY id", [kind])


@pytest.fixture
def tx_state(q):
    return lambda txno: q("SELECT fiscal_status FROM fms.pump_transactions WHERE pts_transaction_no = $1", [txno])[0]


@pytest.fixture
def receipt(q):
    def _r(txno):
        rows = q("SELECT * FROM fms.fiscal_receipts WHERE pts_transaction_no = $1", [txno])
        return rows[0] if rows else None

    return _r


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


# -------------------------------------------------------------------- fiscalise


def test_signs_direct_mode_sale_and_stores_receipt(app, cfg, vsdc, insert_tx, receipt, tx_state, jobs_of):
    tx = insert_tx()
    app.deps.queue.enqueue(
        kind="fiscalise", payload=tx["payload"], dedupe_key=f"fiscalise:{CEN}:1:{tx['txno']}:{tx['payload']['ended_at']}"
    )
    assert app.worker.run_once() == 1

    r = receipt(tx["txno"])
    assert r
    assert r["status"] == "signed"
    assert r["fiscalised_by"] == "cloud"
    assert r["invoice_no"] == f"CEN-0001-P1-{tx['txno']}-{format_vsdc_datetime(tx['ended_at'])}"
    assert r["zra_rcpt_no"] == "1"
    assert re.fullmatch(r"[0-9A-F-]{19}", r["zra_signature"])
    assert r["zra_sdc_id"] and r["zra_mrc_no"] and r["zra_qr_url"] and r["zra_internal_data"] and r["zra_signed_at"]
    assert tx_state(tx["txno"])["fiscal_status"] == "signed"
    assert jobs_of("fiscalise")[0]["status"] == "done"

    # VSDC payload: tpin from company, branch from station, tax-inclusive VAT
    assert len(vsdc.state()["receipts"]) == 1
    req_json = r["request"]["sale"]
    assert req_json["tpin"] == "1000000001"
    assert req_json["branch_id"] == "001"

    # receipt archive written via the fiscal-printer file driver
    assert os.path.exists(os.path.join(cfg.zra.receipt_archive_dir, f"{r['invoice_no']}.txt"))

    # a duplicate job is a no-op (already signed) and does not hit the VSDC again
    app.deps.queue.enqueue(kind="fiscalise", payload=tx["payload"])
    assert app.worker.run_once() == 1
    assert vsdc.state()["requests"]["/trnsSales/saveSales"] == 1


def test_retries_with_backoff_on_vsdc_5xx(app, vsdc, insert_tx, receipt, jobs_of, q):
    tx = insert_tx()
    vsdc.fail("5xx", 1)
    app.deps.queue.enqueue(kind="fiscalise", payload=tx["payload"])
    app.worker.run_once()

    job = jobs_of("fiscalise")[0]
    assert job["status"] == "queued"
    assert job["attempts"] == 1
    assert job["run_at"] > _now() + dt.timedelta(seconds=20), "run_at pushed out by backoff"
    assert re.search(r"HTTP 503", job["last_error"])
    r1 = receipt(tx["txno"])
    assert r1["status"] == "pending"
    assert re.search(r"503", r1["last_error"])

    q("UPDATE fms.jobs SET run_at = now()")
    app.worker.run_once()
    assert jobs_of("fiscalise")[0]["status"] == "done"
    r2 = receipt(tx["txno"])
    assert r2["status"] == "signed"
    assert r2["attempts"] == 2
    assert r2["invoice_no"] == r1["invoice_no"], "same invoice number on retry"


def test_recovers_receipt_signed_before_client_timeout(app, cfg, vsdc, insert_tx, receipt, jobs_of, q):
    tx = insert_tx()
    short_cfg = dataclasses.replace(cfg, zra=dataclasses.replace(cfg.zra, timeout_ms=300))
    short = create_app(short_cfg, SILENT, queue=app.deps.queue, metrics=app.deps.metrics)
    vsdc.fail("timeout", 1)
    app.deps.queue.enqueue(kind="fiscalise", payload=tx["payload"])
    short.worker.run_once()
    assert jobs_of("fiscalise")[0]["status"] == "queued"
    q("UPDATE fms.jobs SET run_at = now()")
    app.worker.run_once()
    r = receipt(tx["txno"])
    assert r["status"] == "signed"
    assert r["zra_rcpt_no"] == "1"
    assert len(vsdc.state()["receipts"]) == 1


def test_dead_letters_non_retryable_rejection(app, vsdc, insert_tx, receipt, tx_state, jobs_of):
    tx = insert_tx()
    vsdc.fail("reject", 1)
    app.deps.queue.enqueue(kind="fiscalise", payload=tx["payload"])
    app.worker.run_once()
    job = jobs_of("fiscalise")[0]
    assert job["status"] == "dead"
    assert re.search(r"910", job["last_error"])
    assert receipt(tx["txno"])["status"] == "failed"
    assert tx_state(tx["txno"])["fiscal_status"] == "failed"


def test_dead_letters_after_max_attempts(app, vsdc, insert_tx, tx_state, jobs_of, q):
    tx = insert_tx()
    vsdc.fail("5xx", 0)  # fail forever
    try:
        app.deps.queue.enqueue(kind="fiscalise", payload=tx["payload"], max_attempts=2)
        app.worker.run_once()
        q("UPDATE fms.jobs SET run_at = now()")
        app.worker.run_once()
        assert jobs_of("fiscalise")[0]["status"] == "dead"
        assert tx_state(tx["txno"])["fiscal_status"] == "failed"
    finally:
        vsdc.fail(None)


def test_skips_transaction_edge_already_signed(app, vsdc, insert_tx, receipt, tx_state, jobs_of, q):
    tx = insert_tx(station=LUS, pts=LUS_PTS)
    q(
        """INSERT INTO fms.fiscal_receipts (station_id, pump_no, pts_transaction_no, tx_ended_at, invoice_no, status, fiscalised_by, zra_rcpt_no)
       VALUES ($1, 1, $2, $3, 'EDGE-INV-1', 'signed', 'edge', '99')""",
        [LUS, tx["txno"], tx["ended_at"]],
    )
    app.deps.queue.enqueue(kind="fiscalise", payload=tx["payload"])
    app.worker.run_once()
    assert jobs_of("fiscalise")[0]["status"] == "done"
    assert vsdc.state()["requests"].get("/trnsSales/saveSales", 0) == 0
    assert tx_state(tx["txno"])["fiscal_status"] == "signed"
    assert receipt(tx["txno"])["zra_rcpt_no"] == "99"


# ------------------------------------------------------------------------ queue


def test_recovers_expired_leases(app, q, jobs_of):
    q(
        "INSERT INTO fms.jobs (kind, payload, status, locked_by, locked_at, attempts) VALUES ('rollup', '{}', 'running', 'crashed', now() - interval '1 hour', 1)"
    )
    q(
        "INSERT INTO fms.jobs (kind, payload, status, locked_by, locked_at, attempts, max_attempts) VALUES ('rollup', '{}', 'running', 'crashed', now() - interval '1 hour', 3, 3)"
    )
    requeued, dead = app.deps.queue.recover_expired_leases(10)
    assert requeued == 1
    assert len(dead) == 1
    assert [j["status"] for j in jobs_of("rollup")] == ["queued", "dead"]


def test_does_not_hand_same_job_to_two_concurrent_claimers(app):
    from django.db import connections

    for i in range(20):
        app.deps.queue.enqueue(kind="notify", payload={"i": i})
    results: dict[str, list] = {}
    barrier = threading.Barrier(2)

    def claim(name: str) -> None:
        try:
            barrier.wait()
            results[name] = app.deps.queue.claim(["notify"], 15, name)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=claim, args=(n,)) for n in ("w-a", "w-b")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    ids = [j.id for j in results["w-a"] + results["w-b"]]
    assert len(ids) == 20
    assert len(set(ids)) == 20


# ----------------------------------------------------------------------- rollup


def test_rolls_up_station_day(app, insert_tx, q, jobs_of):
    insert_tx(ended_at=dt.datetime(2026, 11, 20, 8, 0, tzinfo=dt.UTC), volume=10, amount=318.5)  # 10:00 Lusaka
    insert_tx(ended_at=dt.datetime(2026, 11, 20, 9, 0, tzinfo=dt.UTC), volume=20, amount=637)
    app.deps.queue.enqueue(kind="rollup", payload={"station_id": CEN, "business_date": "2026-11-20"}, dedupe_key=f"rollup:{CEN}:2026-11-20")
    app.worker.run_once()
    rows = q(
        "SELECT * FROM fms.daily_station_product WHERE station_id = $1 AND business_date = '2026-11-20' AND product_code = 'PETROL'", [CEN]
    )
    assert rows
    row = rows[0]
    assert row["sales_volume_l"] == 30
    assert row["sales_amount"] == 955.5
    assert row["tx_count"] == 2
    assert row["avg_price"] == 31.85
    assert row["province_id"] == 1
    assert jobs_of("rollup")[0]["status"] == "done"


# ------------------------------------------------------------ webhook + erb_export


def _subscribe(q, prefix: str, province_id, events: list[str], secret: str, url: str) -> None:
    c = q(
        """INSERT INTO fms.api_clients (name, organisation, key_prefix, key_hash, scopes, province_id)
       VALUES ($1, 'Test', $1, 'x', ARRAY['sales:read'], $2) RETURNING id""",
        [prefix, province_id],
    )[0]
    q("INSERT INTO fms.webhook_subscriptions (api_client_id, url, events, secret) VALUES ($1, $2, $3, $4)", [c["id"], url, events, secret])


def _verify(sig_header: str, secret: str, body: str) -> None:
    m = re.fullmatch(r"t=(\d+),v1=([0-9a-f]{64})", sig_header)
    assert m, f"bad signature header {sig_header}"
    assert m.group(2) == hmac.new(secret.encode(), f"{m.group(1)}.{body}".encode(), hashlib.sha256).hexdigest()
    assert abs(time.time() - int(m.group(1))) < 300


def test_fans_out_to_in_scope_subscriptions_signed_and_retries_non_2xx(app, hook, q, jobs_of):
    _subscribe(q, "testnat1", None, ["daily_summary", "critical_alert"], "nat-secret", hook.url)
    _subscribe(q, "testcop1", 2, ["daily_summary"], "cop-secret", hook.url)  # Copperbelt-only client
    _subscribe(q, "testcen1", 1, ["stock_low"], "cen-secret", hook.url)  # other event

    hook.fail_next = 1
    app.deps.queue.enqueue(kind="webhook", payload={"event": "daily_summary", "data": {"province_id": 1, "date": "2026-11-20"}})
    app.worker.drain()
    assert len(hook.received) == 1, "only the national client is in scope"
    children = [j for j in jobs_of("webhook") if j["payload"].get("subscription_id")]
    assert len(children) == 1
    assert children[0]["status"] == "queued", "non-2xx -> retry"
    assert re.search(r"HTTP 500", children[0]["last_error"])

    q("UPDATE fms.jobs SET run_at = now()")
    app.worker.drain()
    assert len(hook.received) == 2
    last = hook.received[1]
    _verify(last["headers"]["x-fms-signature"], "nat-secret", last["body"])
    assert last["headers"]["x-fms-event"] == "daily_summary"
    body = json.loads(last["body"])
    assert body["event"] == "daily_summary"
    assert body["data"] == {"province_id": 1, "date": "2026-11-20"}
    assert body["id"] == hook.received[0]["headers"]["x-fms-delivery"], "stable delivery id across retries"
    assert all(j["status"] == "done" for j in jobs_of("webhook"))

    # station-scoped event resolves the province from the station (CEN -> 1): Copperbelt client excluded
    hook.received.clear()
    app.deps.queue.enqueue(kind="webhook", payload={"event": "daily_summary", "data": {"station_id": CEN}})
    app.worker.drain()
    assert len(hook.received) == 1
    _verify(hook.received[0]["headers"]["x-fms-signature"], "nat-secret", hook.received[0]["body"])


def test_exports_erb_daily_return_and_enqueues_daily_summary(app, cfg, hook, insert_tx, q, jobs_of):
    _subscribe(q, "testnat2", None, ["daily_summary"], "nat2-secret", hook.url)
    insert_tx(ended_at=dt.datetime(2026, 11, 20, 8, 0, tzinfo=dt.UTC), volume=10, amount=318.5)
    # A rollup for that date still running elsewhere -> the export waits (retryable).
    q(
        "INSERT INTO fms.jobs (kind, payload, status, locked_by, locked_at) VALUES ('rollup', $1, 'running', 'other-worker', now())",
        [js_dumps({"station_id": CEN, "business_date": "2026-11-20"})],
    )
    app.deps.queue.enqueue(kind="erb_export", payload={"date": "2026-11-20", "province_id": 1})
    app.worker.run_once()
    waiting = jobs_of("erb_export")[0]
    assert waiting["status"] == "queued"
    assert re.search(r"waiting for 1 rollup", waiting["last_error"])

    q("DELETE FROM fms.jobs WHERE locked_by = 'other-worker'")
    app.deps.queue.enqueue(kind="rollup", payload={"station_id": CEN, "business_date": "2026-11-20"})
    app.worker.run_once(1)  # rollup (earlier run_at than the deferred export)
    q("UPDATE fms.jobs SET run_at = now()")
    app.worker.drain()

    d = os.path.join(cfg.export_dir, "erb", "daily", "2026-11-20")
    with open(os.path.join(d, "CEN.csv"), "rb") as f:
        csv = f.read().decode("utf-8")
    lines = csv.strip().split("\r\n")
    assert re.match(r"^business_date,province_id,province_name,station_code", lines[0])
    petrol = next((ln for ln in lines if "CEN-0001" in ln and "PETROL" in ln), None)
    assert petrol, csv
    assert re.search(r",PETROL,,0,10,318\.5,1,,,31\.85$", petrol)
    with open(os.path.join(d, "CEN.json"), encoding="utf-8") as f:
        j = json.load(f)
    assert j["station_count"] == 1
    assert next(t for t in j["totals"] if t["product_code"] == "PETROL")["sales_volume_l"] == 10

    exp = jobs_of("erb_export")[0]
    assert exp["status"] == "done"
    summary = next((jb for jb in jobs_of("webhook") if jb["dedupe_key"] == "webhook:daily_summary:2026-11-20:CEN"), None)
    assert summary
    assert len(hook.received) == 1
    body = json.loads(hook.received[0]["body"])
    assert body["event"] == "daily_summary"
    assert body["data"]["station_count"] == 1
    _verify(hook.received[0]["headers"]["x-fms-signature"], "nat2-secret", hook.received[0]["body"])


# -------------------------------------------------------------------- scheduler


def test_sweeps_pending_sales_into_fiscalise_jobs(app, insert_tx, tx_state, jobs_of):
    direct = insert_tx(received_ago_min=10)
    insert_tx(received_ago_min=0)  # too fresh
    insert_tx(station=LUS, pts=LUS_PTS, received_ago_min=10)  # edge, inside fallback window
    edge_old = insert_tx(station=LUS, pts=LUS_PTS, received_ago_min=120)
    r = app.scheduler.sweep_fiscal()
    assert r["enqueued"] == 2
    keys = sorted(j["dedupe_key"] for j in jobs_of("fiscalise"))
    assert keys == sorted(
        [
            f"fiscalise:{CEN}:1:{direct['txno']}:{direct['payload']['ended_at']}",
            f"fiscalise:{LUS}:1:{edge_old['txno']}:{edge_old['payload']['ended_at']}",
        ]
    )
    assert app.scheduler.sweep_fiscal()["enqueued"] == 0, "dedupe"
    app.worker.drain()
    assert tx_state(direct["txno"])["fiscal_status"] == "signed", (
        jobs_of("fiscalise"),
        app.deps.db.query("SELECT * FROM fms.fiscal_receipts"),
    )
    assert tx_state(edge_old["txno"])["fiscal_status"] == "signed"


def test_raises_one_gateway_offline_alert_per_outage(app, q, jobs_of):
    q("UPDATE fms.edge_gateways SET last_seen_at = now() - interval '1 hour' WHERE gateway_code = 'GW-LUS-0001'")
    try:
        assert app.scheduler.check_gateways()["alerts"] == 1
        assert app.scheduler.check_gateways()["alerts"] == 0
        a = q("SELECT * FROM fms.alerts WHERE code = 'GatewayOffline'")[0]
        assert a["severity"] == "critical"
        assert a["device_type"] == "gateway"
        assert len(jobs_of("notify")) == 1
        assert len(jobs_of("webhook")) == 1
        app.worker.drain()
        assert all(j["status"] == "done" for j in jobs_of("notify"))
    finally:
        q("UPDATE fms.edge_gateways SET last_seen_at = NULL")


def test_expires_unacknowledged_edge_commands_once(app, q):
    q(
        """INSERT INTO fms.edge_commands (id, station_id, type, command, status, expires_at) VALUES
         ('t-exp-1', $1, 'set_prices', '{"id":"t-exp-1","type":"set_prices","prices":[]}', 'delivered', now() - interval '1 minute'),
         ('t-exp-2', $1, 'reload_config', '{"id":"t-exp-2","type":"reload_config"}', 'received', now() - interval '1 minute'),
         ('t-exp-3', $1, 'reload_config', '{"id":"t-exp-3","type":"reload_config"}', 'queued', now() + interval '1 day')""",
        [LUS],
    )
    try:
        assert app.scheduler.expire_commands() == {"expired": 1}
        assert app.scheduler.expire_commands() == {"expired": 0}
        st = q("SELECT id, status FROM fms.edge_commands WHERE id LIKE 't-exp-%' ORDER BY id")
        assert [r["status"] for r in st] == ["expired", "received", "queued"], "acknowledged and unexpired commands untouched"
        al = q("SELECT data FROM fms.alerts WHERE code = 'CommandExpired'")
        assert [a["data"]["command_id"] for a in al] == ["t-exp-1"]
    finally:
        q("DELETE FROM fms.edge_commands WHERE id LIKE 't-exp-%'")
        q("DELETE FROM fms.alerts WHERE code = 'CommandExpired'")


def test_schedules_daily_rollups_and_erb_exports_idempotently(app):
    assert app.scheduler.schedule_daily("2026-11-26") == {"rollups": 4, "exports": 11}
    assert app.scheduler.schedule_daily("2026-11-26") == {"rollups": 0, "exports": 0}
    app.scheduler.ensure_partitions()


def test_elects_single_leader_with_advisory_lock(app, cfg):
    def mk() -> Scheduler:
        c = dataclasses.replace(cfg, scheduler=dataclasses.replace(cfg.scheduler, lock_key=990_001))
        return Scheduler(SchedulerDeps(queue=app.deps.queue, config=c, log=SILENT, metrics=app.deps.metrics))

    s1, s2 = mk(), mk()
    try:
        s1.tick()
        s2.tick()
        assert s1.is_leader is True
        assert s2.is_leader is False
        s1.stop()
        s2.tick()
        assert s2.is_leader is True
    finally:
        s1.stop()
        s2.stop()


# ------------------------------------------------------------------------- http


def test_serves_healthz_readyz_and_metrics(app):
    server = start_http_server(
        0, HttpDeps(metrics=app.deps.metrics, log=SILENT, is_alive=lambda: True, info=lambda: {"worker_id": "test"}), "127.0.0.1"
    )
    try:
        base = f"http://127.0.0.1:{server.port}"
        h = httpx.get(f"{base}/healthz")
        assert h.status_code == 200
        assert h.json() == {"status": "ok", "worker_id": "test"}
        assert httpx.get(f"{base}/readyz").status_code == 200
        m = httpx.get(f"{base}/metrics").text
        assert re.search(r"fms_worker_jobs_processed_total", m)
        assert re.search(r"fms_worker_queue_depth", m)
        assert httpx.get(f"{base}/nope").status_code == 404
    finally:
        server.close()


# --------------------------------------------------------------- worker loop


def test_background_loop_processes_jobs_and_stops_gracefully(app, cfg, insert_tx, tx_state, jobs_of):
    """Not in the TypeScript suite: exercises start()/stop() (threads, concurrency, graceful shutdown)."""
    loop_cfg = dataclasses.replace(cfg, poll_interval_ms=50, concurrency=3, batch_size=2)
    a = create_app(loop_cfg, SILENT, queue=app.deps.queue, metrics=app.deps.metrics)
    txs = [insert_tx() for _ in range(5)]
    for t in txs:
        app.deps.queue.enqueue(kind="fiscalise", payload=t["payload"])
    a.worker.start()
    try:
        deadline = time.time() + 20
        while time.time() < deadline and not all(j["status"] == "done" for j in jobs_of("fiscalise")):
            time.sleep(0.1)
        assert a.worker.running
    finally:
        a.worker.stop(grace_ms=5000)
    assert not a.worker.running
    assert [j["status"] for j in jobs_of("fiscalise")] == ["done"] * 5
    assert all(tx_state(t["txno"])["fiscal_status"] == "signed" for t in txs)


def test_job_timeout_fails_the_job_and_frees_the_slot(app, cfg, jobs_of):
    from fms_cloud.fiscal.handlers.base import JobHandler

    release = threading.Event()
    slow = JobHandler(kind="notify", handle=lambda ctx: release.wait(10))
    a = create_app(dataclasses.replace(cfg, job_timeout_ms=200), SILENT, queue=app.deps.queue, metrics=app.deps.metrics, handlers=[slow])
    try:
        app.deps.queue.enqueue(kind="notify", payload={})
        t0 = time.time()
        assert a.worker.run_once() == 1
        assert time.time() - t0 < 5
        job = jobs_of("notify")[0]
        assert job["status"] == "queued"
        assert job["last_error"] == "job timed out after 200 ms"
    finally:
        release.set()
