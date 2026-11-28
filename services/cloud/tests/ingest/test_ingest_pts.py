"""POST /ingest/pts, direct jsonPTS (port of services/ingest-api/test/pts.test.ts)."""

from __future__ import annotations

import datetime as dt
import json

from fms_cloud.common.crypto import hmac_sha256_hex
from fms_cloud.common.jsonutil import iso
from fms_cloud.ingest.jsutil import parse_iso
from fms_cloud.ingest.refdata import local_date

from .ingest_helpers import PTS_URL, SEED, post, pts_local, random_recent, random_tx_no

LUS = SEED["lus"]
CEN = SEED["cen"]


def tx_packet(pid: int, **o):
    end = random_recent()
    return {
        "Id": pid,
        "Type": "UploadPumpTransaction",
        "Data": {
            "Pump": 1,
            "Nozzle": 1,
            "FuelGradeId": 1,
            "FuelGradeName": "Unleaded Petrol",
            "Transaction": random_tx_no(),
            "DateTimeStart": pts_local(end - dt.timedelta(seconds=60)),
            "DateTime": pts_local(end),
            "Volume": 25.5,
            "TCVolume": 25.3,
            "Price": 31.85,
            "Amount": 812.18,
            "Tag": None,
            **o,
        },
    }


def count_tx(db, station_id: str, tx_no: int) -> int:
    return db.scalar(
        "SELECT count(*)::int n FROM fms.pump_transactions WHERE station_id = $1 AND pts_transaction_no = $2", [station_id, tx_no]
    )


def local_to_utc_iso(local: str) -> str:
    return iso(parse_iso(local + "+02:00"))


def test_signed_upload_is_persisted_archived_and_replied_ok(ingest_client, db):
    pk = tx_packet(1)
    raw = json.dumps({"Protocol": "jsonPTS", "PtsId": LUS["ptsId"], "Packets": [pk]})
    res = post(ingest_client, PTS_URL, raw, headers={"x-pts-signature": hmac_sha256_hex(LUS["secret"], raw)})
    assert res.status_code == 200, res.content
    assert res.json()["Packets"] == [{"Id": 1, "Type": "UploadPumpTransaction", "Error": False, "Message": "OK"}]
    tx_no = pk["Data"]["Transaction"]
    rows = db.query(
        "SELECT product_code, tank_no, volume_l, source, ended_at FROM fms.pump_transactions WHERE station_id = $1 AND pts_transaction_no = $2",
        [LUS["stationId"], tx_no],
    )
    assert len(rows) == 1
    assert rows[0]["product_code"] == "PETROL"
    assert rows[0]["tank_no"] == 1
    assert rows[0]["volume_l"] == 25.5
    assert rows[0]["source"] == "pts_direct"
    # local time +02:00 converted to UTC
    assert iso(rows[0]["ended_at"])[:19] == local_to_utc_iso(pk["Data"]["DateTime"])[:19]
    n = db.scalar(
        "SELECT count(*)::int n FROM fms.ingest_raw WHERE source = 'pts_direct' AND pts_id = $1 AND payload->'Data'->>'Transaction' = $2",
        [LUS["ptsId"], str(tx_no)],
    )
    assert n == 1
    fresh = db.scalar("SELECT last_seen_at > now() - interval '1 minute' AS fresh FROM fms.controllers WHERE pts_id = $1", [LUS["ptsId"]])
    assert fresh is True
    # LUS-0001 is an edge-mode station: the edge fiscalises, so no cloud fiscalise job.
    jobs = db.scalar("SELECT count(*)::int n FROM fms.jobs WHERE kind = 'fiscalise' AND payload->>'pts_transaction_no' = $1", [str(tx_no)])
    assert jobs == 0


def test_bad_signature_rejected_with_401_jsonpts_error_and_nothing_stored(ingest_client, db):
    pk = tx_packet(7)
    raw = json.dumps({"Protocol": "jsonPTS", "PtsId": LUS["ptsId"], "Packets": [pk]})
    res = post(ingest_client, PTS_URL, raw, headers={"x-pts-signature": hmac_sha256_hex("wrong-secret", raw)})
    assert res.status_code == 401
    p = res.json()["Packets"][0]
    assert p["Id"] == 7
    assert p["Error"] is True
    assert p["Code"] == 401
    assert count_tx(db, LUS["stationId"], pk["Data"]["Transaction"]) == 0
    # missing signature on a controller with a secret is also rejected
    res2 = post(ingest_client, PTS_URL, raw)
    assert res2.status_code == 401


def test_unknown_controller_is_rejected(ingest_client):
    res = post(ingest_client, PTS_URL, {"Protocol": "jsonPTS", "PtsId": "00000000000000000000DEAD", "Packets": [tx_packet(1)]})
    assert res.status_code == 401
    assert res.json()["Packets"][0]["Error"] is True
    assert "unknown controller" in res.json()["Packets"][0]["Message"]


def test_controller_by_x_pts_id_header_duplicate_resend_idempotent(ingest_client, db):
    pk = tx_packet(3)
    body = {"Protocol": "jsonPTS", "Packets": [pk]}
    r1 = post(ingest_client, PTS_URL, body, headers={"x-pts-id": CEN["ptsId"]})
    r2 = post(ingest_client, PTS_URL, body, headers={"x-pts-id": CEN["ptsId"]})
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["Packets"][0]["Message"] == "OK"
    assert r2.json()["Packets"][0]["Message"] == "OK"
    assert count_tx(db, CEN["stationId"], pk["Data"]["Transaction"]) == 1


def test_direct_mode_station_enqueues_one_fiscalise_job_per_new_sale(ingest_client, db):
    pk = tx_packet(1, Pump=2, Nozzle=2, FuelGradeId=2, Price=29.95, Amount=763.73)
    body = {"Protocol": "jsonPTS", "PtsId": CEN["ptsId"], "Packets": [pk]}
    assert post(ingest_client, PTS_URL, body).status_code == 200
    assert post(ingest_client, PTS_URL, body).status_code == 200
    ended_iso = local_to_utc_iso(pk["Data"]["DateTime"])
    key = f"fiscalise:{CEN['stationId']}:2:{pk['Data']['Transaction']}:{ended_iso}"
    rows = db.query("SELECT kind, status, payload FROM fms.jobs WHERE dedupe_key = $1", [key])
    assert len(rows) == 1
    assert rows[0]["status"] == "queued"
    assert rows[0]["payload"]["pts_transaction_no"] == pk["Data"]["Transaction"]
    tx = db.query(
        "SELECT product_code, tank_no FROM fms.pump_transactions WHERE station_id = $1 AND pts_transaction_no = $2",
        [CEN["stationId"], pk["Data"]["Transaction"]],
    )
    assert tx[0] == {"product_code": "DIESEL", "tank_no": 2}
    # a rollup job exists for the station-day
    day = local_date(ended_iso, "Africa/Lusaka")
    r = db.query("SELECT status FROM fms.jobs WHERE dedupe_key = $1", [f"rollup:{CEN['stationId']}:{day}"])
    assert len(r) == 1


def test_malformed_packets_fail_individually_good_ones_committed(ingest_client, db):
    good = tx_packet(1)
    body = {
        "Protocol": "jsonPTS",
        "PtsId": CEN["ptsId"],
        "Packets": [
            good,
            {"Id": 2, "Type": "UploadPumpTransaction", "Data": {"Pump": 1}},
            {"Id": 3, "Type": "UploadSomethingElse", "Data": {}},
            {"Id": 4, "Type": "UploadGpsRecord", "Data": {"Latitude": -15.4}},
            {"Id": 5, "Type": "UploadStatus", "Data": {"Pumps": [{"Id": 1, "Status": "Idle"}]}},
        ],
    }
    res = post(ingest_client, PTS_URL, body)
    assert res.status_code == 200
    p = res.json()["Packets"]
    assert p[0]["Error"] is False
    assert p[1]["Error"] is True
    assert any(w in p[1]["Message"] for w in ("Transaction", "Nozzle", "DateTime", "Volume"))
    assert p[2]["Error"] is True
    assert "unsupported" in p[2]["Message"]
    assert p[3]["Error"] is False  # GPS accepted, stored raw only
    assert p[4]["Error"] is False
    assert count_tx(db, CEN["stationId"], good["Data"]["Transaction"]) == 1
    st = db.scalar("SELECT last_status FROM fms.controllers WHERE pts_id = $1", [CEN["ptsId"]])
    assert st == {"Pumps": [{"Id": 1, "Status": "Idle"}]}


def test_invalid_json_400(ingest_client):
    res = post(ingest_client, PTS_URL, "{not json", headers={"x-pts-id": CEN["ptsId"]})
    assert res.status_code == 400
    assert res.json()["Protocol"] == "jsonPTS"


# ---------------------------------------------------------------- not in the TS suite


def test_packets_required_rate_limit_and_body_limit(ingest_client, configure_ingest):
    res = post(ingest_client, PTS_URL, {"Protocol": "jsonPTS", "PtsId": CEN["ptsId"]})
    assert res.status_code == 400
    assert res.json() == {"Protocol": "jsonPTS", "Packets": [{"Id": 0, "Error": True, "Message": "Packets array required"}]}

    missing = post(ingest_client, PTS_URL, {"Protocol": "jsonPTS", "Packets": [{"Id": 4, "Type": "UploadStatus"}, None]})
    assert missing.status_code == 401
    assert missing.json()["Packets"] == [
        {"Id": 4, "Type": "UploadStatus", "Error": True, "Code": 401, "Message": "Unauthorized: PtsId missing"},
        {"Id": 1, "Error": True, "Code": 401, "Message": "Unauthorized: PtsId missing"},
    ]

    configure_ingest(rate_limit_rps=1, rate_limit_burst=1, body_limit_bytes=2048)
    body = {"Protocol": "jsonPTS", "PtsId": CEN["ptsId"], "Packets": [{"Id": 9, "Type": "UploadGpsRecord", "Data": {}}]}
    assert post(ingest_client, PTS_URL, body).status_code == 200
    limited = post(ingest_client, PTS_URL, body)
    assert limited.status_code == 429
    assert limited["Retry-After"] == "1"
    assert limited.json()["Packets"] == [{"Id": 9, "Error": True, "Message": "Rate limited"}]

    big = post(ingest_client, PTS_URL, "x" * 3000)
    assert big.status_code == 413
    assert big.json() == {"Protocol": "jsonPTS", "Packets": [{"Id": 0, "Error": True, "Message": "Request body is too large"}]}
