"""Persistence rules: totaliser continuity, low stock, rollup scheduling (port of services/ingest-api/test/rules.test.ts)."""

from __future__ import annotations

import datetime as dt
import itertools

from fms_cloud.common.db import tx
from fms_cloud.common.jsonutil import iso
from fms_cloud.ingest.jsutil import parse_iso

from .ingest_helpers import EDGE_URL, Fixture, create_fixture_station, edge_batch, edge_headers, now_utc, post, pump_tx, tank_measurement

_seq = itertools.count(1)


def send(client, f: Fixture, records):
    res = post(client, EDGE_URL, edge_batch(f, [{"seq": next(_seq), **r} for r in records]), headers=edge_headers(f))
    assert res.status_code == 200, res.content
    assert res.json()["rejected"] == []
    return res.json()


def minutes_from(t0: dt.datetime):
    return lambda m: iso(t0 + dt.timedelta(minutes=m))


def test_totaliser_continuity_raises_totalizer_mismatch(ingest_client, db):
    f = create_fixture_station(db, "edge")
    at = minutes_from(now_utc() - dt.timedelta(hours=3))
    send(
        ingest_client,
        f,
        [
            pump_tx(f.ptsId, ended_at=at(0), volume_l=10, amount=318.5, total_volume_l=1000),
            pump_tx(f.ptsId, ended_at=at(10), volume_l=20, amount=637, total_volume_l=1025),  # 5 L unaccounted
        ],
    )
    send(ingest_client, f, [pump_tx(f.ptsId, ended_at=at(20), volume_l=5, amount=159.25, total_volume_l=1030.2)])  # 0.2 L ok
    # a different nozzle has its own totaliser
    send(ingest_client, f, [pump_tx(f.ptsId, ended_at=at(30), nozzle_no=2, pts_grade_id=2, volume_l=5, amount=150, total_volume_l=500)])

    rows = db.query(
        "SELECT code, severity, device_type, device_no, data, occurred_at, message FROM fms.alerts WHERE station_id = $1", [f.stationId]
    )
    assert len(rows) == 1
    assert rows[0]["code"] == "TotalizerMismatch"
    assert rows[0]["severity"] == "critical"
    assert rows[0]["device_type"] == "pump"
    assert rows[0]["device_no"] == 1
    assert rows[0]["data"]["expected"] == 1020
    assert rows[0]["data"]["actual"] == 1025
    assert rows[0]["data"]["unaccounted_l"] == 5
    assert rows[0]["message"] == "Pump 1 nozzle 1: 5 L dispensed without a recorded sale"
    assert iso(rows[0]["occurred_at"]) == at(10)
    jobs = db.query(
        "SELECT kind FROM fms.jobs WHERE payload->>'station_id' = $1 AND kind IN ('notify','webhook') ORDER BY kind", [f.stationId]
    )
    assert [r["kind"] for r in jobs] == ["notify", "webhook"]


def test_low_stock_alert_and_webhook_only_when_crossing_below_low_level(ingest_client, db):
    f = create_fixture_station(db, "edge")  # tank 1 PETROL low_level_l = 6000
    at = minutes_from(now_utc() - dt.timedelta(hours=2))
    send(ingest_client, f, [tank_measurement(f.ptsId, measured_at=at(0), product_volume_l=10000)])
    send(ingest_client, f, [tank_measurement(f.ptsId, measured_at=at(10), product_volume_l=5500)])  # crosses
    send(ingest_client, f, [tank_measurement(f.ptsId, measured_at=at(20), product_volume_l=5000)])  # still low, no new alert
    # an out-of-order older reading does not move tank_latest backwards
    send(ingest_client, f, [tank_measurement(f.ptsId, measured_at=at(5), product_volume_l=9000)])

    al = db.query("SELECT id, code, severity, data, message FROM fms.alerts WHERE station_id = $1", [f.stationId])
    assert len(al) == 1
    assert al[0]["code"] == "LowStock"
    assert al[0]["severity"] == "warning"
    assert al[0]["data"]["product_volume_l"] == 5500
    assert al[0]["data"]["low_level_l"] == 6000
    assert al[0]["message"] == "Tank 1 (PETROL) below reorder level: 5500 L < 6000 L"
    wh = db.query("SELECT payload FROM fms.jobs WHERE kind = 'webhook' AND payload->>'station_id' = $1", [f.stationId])
    assert len(wh) == 1
    assert wh[0]["payload"]["event"] == "stock_low"
    assert wh[0]["payload"]["province_id"] == 5
    tl = db.query("SELECT product_volume_l, measured_at FROM fms.tank_latest WHERE station_id = $1 AND tank_no = 1", [f.stationId])
    assert tl[0]["product_volume_l"] == 5000
    assert iso(tl[0]["measured_at"]) == at(20)
    # refill above the threshold, then drop again -> a second LowStock
    send(ingest_client, f, [tank_measurement(f.ptsId, measured_at=at(30), product_volume_l=25000)])
    send(ingest_client, f, [tank_measurement(f.ptsId, measured_at=at(40), product_volume_l=5900)])
    n = db.scalar("SELECT count(*)::int n FROM fms.alerts WHERE station_id = $1 AND code = 'LowStock'", [f.stationId])
    assert n == 2


def test_rollup_job_enqueued_debounced_rearm_and_daily_station_product(ingest_client, db):
    f = create_fixture_station(db, "edge")
    D = "2026-11-20"  # station-local business date (Africa/Lusaka, UTC+2)

    def local(s: str) -> str:
        return iso(parse_iso(f"{s}+02:00"))

    res = send(
        ingest_client,
        f,
        [
            tank_measurement(f.ptsId, measured_at=local("2026-11-19T23:00:00"), product_volume_l=20000),  # opening
            pump_tx(f.ptsId, ended_at=local(f"{D}T08:00:00"), volume_l=100, amount=3185),
            pump_tx(f.ptsId, ended_at=local(f"{D}T12:00:00"), volume_l=50, amount=1592.5),
            pump_tx(f.ptsId, ended_at=local(f"{D}T00:30:00"), volume_l=25, amount=796.25),  # 22:30Z on the 19th = local D
            pump_tx(f.ptsId, ended_at=local("2026-11-21T00:10:00"), volume_l=999, amount=31818.15),  # next day
            {
                "kind": "tank_delivery",
                "data": {
                    "pts_id": f.ptsId,
                    "tank_no": 1,
                    "pts_grade_id": 1,
                    "started_at": local(f"{D}T14:00:00"),
                    "ended_at": local(f"{D}T14:40:00"),
                    "start_volume_l": 19825,
                    "end_volume_l": 29825,
                    "start_tc_volume_l": None,
                    "end_tc_volume_l": None,
                    "start_height_mm": None,
                    "end_height_mm": None,
                    "start_water_mm": None,
                    "end_water_mm": None,
                    "start_temperature_c": None,
                    "end_temperature_c": None,
                    "start_density_kg_m3": None,
                    "end_density_kg_m3": None,
                },
            },
            tank_measurement(f.ptsId, measured_at=local(f"{D}T23:30:00"), product_volume_l=29800),  # closing
        ],
    )
    assert len(res["accepted"]) == 7

    job = db.query(
        "SELECT kind, status, payload, run_at > now() AS debounced FROM fms.jobs WHERE dedupe_key = $1", [f"rollup:{f.stationId}:{D}"]
    )
    assert len(job) == 1
    assert job[0]["status"] == "queued"
    assert job[0]["debounced"] is True
    assert job[0]["payload"] == {"station_id": f.stationId, "business_date": D}
    for d in ("2026-11-19", "2026-11-21"):
        j = db.query("SELECT 1 FROM fms.jobs WHERE dedupe_key = $1", [f"rollup:{f.stationId}:{d}"])
        assert len(j) == 1, f"rollup for {d}"

    # NOTE: fms.rollup_station_day uses unqualified table names and has no SET search_path,
    # so callers must run it with search_path = fms (reported as a schema issue).
    with tx() as c:
        c.execute("SET LOCAL search_path = fms, public")
        c.query("SELECT fms.rollup_station_day($1, $2::date)", [f.stationId, D])
    rows = db.query(
        """SELECT product_code, province_id, sales_volume_l, sales_amount, tx_count, opening_stock_l, closing_stock_l,
              deliveries_l, variance_l, avg_price
         FROM fms.daily_station_product WHERE station_id = $1 AND business_date = $2 ORDER BY product_code""",
        [f.stationId, D],
    )
    assert rows == [
        {
            "product_code": "DIESEL", "province_id": 5, "sales_volume_l": 0, "sales_amount": 0, "tx_count": 0,
            "opening_stock_l": None, "closing_stock_l": None, "deliveries_l": 0, "variance_l": None, "avg_price": None,
        },
        {
            "product_code": "PETROL", "province_id": 5, "sales_volume_l": 175, "sales_amount": 5573.75, "tx_count": 3,
            "opening_stock_l": 20000, "closing_stock_l": 29800, "deliveries_l": 10000, "variance_l": 25, "avg_price": 31.85,
        },
    ]  # fmt: skip

    # job finished -> new data for that day re-arms it (dedupe_key is unique forever)
    db.execute("UPDATE fms.jobs SET status = 'done', attempts = 1 WHERE dedupe_key = $1", [f"rollup:{f.stationId}:{D}"])
    send(ingest_client, f, [pump_tx(f.ptsId, ended_at=local(f"{D}T18:00:00"), volume_l=10, amount=318.5)])
    j2 = db.one("SELECT status, attempts FROM fms.jobs WHERE dedupe_key = $1", [f"rollup:{f.stationId}:{D}"])
    assert j2 == {"status": "queued", "attempts": 0}
