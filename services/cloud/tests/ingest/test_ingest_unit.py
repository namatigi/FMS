"""Unit tests without HTTP (port of services/ingest-api/test/unit.test.ts and packages/shared/src/jsonpts.test.ts)."""

from __future__ import annotations

import types

import pytest

from fms_cloud.common import ratelimit as common_ratelimit
from fms_cloud.common.crypto import hmac_sha256_hex, sign_webhook, verify_pts_signature
from fms_cloud.ingest.jsonpts import JsonPtsMappingError, alarms_to_alerts, jsonpts_reply, normalize_jsonpts_packet, pts_time
from fms_cloud.ingest.jsutil import dumps, js_number, js_string, loads
from fms_cloud.ingest.ratelimit import RateLimiter
from fms_cloud.ingest.refdata import TtlCache, local_date, tz_offset_of
from fms_cloud.ingest.validate import RecordValidationError, validate_record

PTS = "003B00265030500420303531"


# ---------------------------------------------------------------- services/ingest-api/test/unit.test.ts


def test_token_bucket_allows_burst_then_throttles_and_refills(monkeypatch):
    now = [0.0]
    monkeypatch.setattr(common_ratelimit, "time", types.SimpleNamespace(monotonic=lambda: now[0]))
    rl = RateLimiter(2, 3)
    assert rl.take("a") == 0
    assert rl.take("a") == 0
    assert rl.take("a") == 0
    assert rl.take("a") > 0
    assert rl.take("b") == 0  # separate key
    now[0] += 0.5  # +1 token
    assert rl.take("a") == 0
    assert rl.take("a") > 0
    assert RateLimiter(0, 0).take("x") == 0  # disabled


def test_africa_lusaka_offset_and_local_business_date():
    assert tz_offset_of("Africa/Lusaka") == "+02:00"
    assert local_date("2026-11-19T22:30:00.000Z", "Africa/Lusaka") == "2026-11-20"
    assert local_date("2026-11-19T21:59:59.000Z", "Africa/Lusaka") == "2026-11-19"


def test_validate_record_canonicalises_timestamps_and_rejects_bad_input():
    r = validate_record(
        {
            "kind": "alert",
            "data": {
                "pts_id": None,
                "occurred_at": "2026-11-27T10:00:00+02:00",
                "device_type": "gateway",
                "device_no": None,
                "code": "X",
                "severity": "info",
                "message": None,
            },
        }
    )
    assert r["kind"] == "alert" and r["data"]["occurred_at"] == "2026-11-27T08:00:00.000Z"
    with pytest.raises(RecordValidationError):
        validate_record({"kind": "alert", "data": {"occurred_at": "x"}})
    with pytest.raises(RecordValidationError):
        validate_record({"kind": "pump_transaction", "data": {"pts_id": "a", "pts_transaction_no": 1.5}})
    with pytest.raises(RecordValidationError):
        validate_record(None)


def test_validate_record_messages_match_typescript():
    def msg(rec):
        with pytest.raises(RecordValidationError) as e:
            validate_record(rec)
        return str(e.value)

    assert msg({"kind": "teleport", "data": {}}) == "unknown record kind teleport"
    assert msg({"data": {}}) == "unknown record kind undefined"
    assert msg({"kind": "status", "data": 1}) == "record.data must be an object"
    assert msg({"kind": "pump_transaction", "data": {"pts_id": "a", "pump_no": "x"}}) == "pts_transaction_no must be an integer >= 0"
    tx = {"pts_id": "a", "pts_transaction_no": 1, "pump_no": 1, "nozzle_no": 1, "volume_l": 1, "price": 1, "amount": 1}
    assert msg({"kind": "pump_transaction", "data": {**tx, "ended_at": "2026-11-27T10:00:00"}}) == "ended_at must include a UTC offset"
    assert msg({"kind": "pump_transaction", "data": {**tx, "ended_at": "garbage+02:00"}}) == "ended_at must be an ISO-8601 timestamp"
    # JSON numbers have one type: 3.0 is the integer 3
    ok = validate_record({"kind": "pump_transaction", "data": {**tx, "pump_no": 3.0, "ended_at": "2026-11-27T10:00:00.1234+0200"}})
    assert ok["data"]["pump_no"] == 3 and isinstance(ok["data"]["pump_no"], int)
    assert ok["data"]["ended_at"] == "2026-11-27T08:00:00.123Z"


def test_ttl_cache_negative_caching_and_inflight():
    calls = []
    now = [0.0]

    def load(k):
        calls.append(k)
        return None if k == "missing" else k.upper()

    c = TtlCache(1000, 100, load, clock=lambda: now[0])
    assert c.get("a") == "A" and c.get("a") == "A"
    assert c.get("missing") is None and c.get("missing") is None
    assert calls == ["a", "missing"]
    now[0] += 0.2  # negative entry expired, positive still valid
    c.get("a")
    c.get("missing")
    assert calls == ["a", "missing", "missing"]


def test_js_semantics_helpers():
    assert js_number(" 12 ") == 12 and js_number("0x10") == 16 and js_number("") == 0 and js_number([5]) == 5
    assert js_string(3.0) == "3" and js_string(20.5) == "20.5" and js_string(None) == "null"
    assert dumps({"a": 20.0, "b": [1.5]}) == '{"a":20,"b":[1.5]}'
    with pytest.raises(ValueError):
        loads('{"a": NaN}')
    with pytest.raises(ValueError):
        loads('{"__proto__": {"x": 1}}')


# ---------------------------------------------------------------- packages/shared/src/jsonpts.test.ts


def test_pts_time_converts_lusaka_local_time_to_utc():
    assert pts_time("2026-11-27T10:15:30") == "2026-11-27T08:15:30.000Z"
    assert pts_time("2026-11-27 10:15:30") == "2026-11-27T08:15:30.000Z"
    assert pts_time("2026-11-27T10:15:30Z") == "2026-11-27T10:15:30.000Z"
    assert pts_time("") is None


def test_upload_pump_transaction_is_normalised():
    r = normalize_jsonpts_packet(
        PTS,
        {
            "Id": 1,
            "Type": "UploadPumpTransaction",
            "Data": {
                "DateTimeStart": "2026-11-27T10:00:00",
                "DateTime": "2026-11-27T10:01:30",
                "Pump": 3,
                "Nozzle": 1,
                "FuelGradeId": 1,
                "FuelGradeName": "Petrol",
                "Transaction": 1234,
                "Volume": 20.5,
                "TCVolume": 20.31,
                "Price": 31.85,
                "Amount": 652.93,
                "TotalVolume": 123456.78,
                "TotalAmount": 3500000.5,
                "Tag": "",
                "UserId": 1,
            },
        },
    )
    assert r and r["kind"] == "pump_transaction"
    assert r["data"]["pump_no"] == 3
    assert r["data"]["pts_transaction_no"] == 1234
    assert r["data"]["ended_at"] == "2026-11-27T08:01:30.000Z"
    assert r["data"]["tag"] is None
    assert r["data"]["total_volume_l"] == 123456.78


def test_tolerates_lower_case_keys_and_string_numbers():
    r = normalize_jsonpts_packet(
        PTS,
        {
            "Id": 2,
            "Type": "UploadTankMeasurement",
            "Data": {"datetime": "2026-11-27T10:00:00", "tank": "2", "productvolume": "15000.5", "Alarms": ["HighWater"]},
        },
    )
    assert r and r["kind"] == "tank_measurement"
    assert r["data"]["tank_no"] == 2
    assert r["data"]["product_volume_l"] == 15000.5
    alerts = alarms_to_alerts(r["data"])
    assert len(alerts) == 1
    assert alerts[0]["severity"] == "warning"
    assert alerts[0]["message"] == "Tank 2: HighWater"


def test_in_tank_delivery_accepts_nested_and_flat_formats():
    nested = normalize_jsonpts_packet(
        PTS,
        {
            "Id": 3,
            "Type": "UploadInTankDelivery",
            "Data": {
                "Tank": 1,
                "StartMeasurement": {"DateTime": "2026-11-27T09:00:00", "ProductVolume": 5000},
                "EndMeasurement": {"DateTime": "2026-11-27T09:40:00", "ProductVolume": 20000},
            },
        },
    )
    flat = normalize_jsonpts_packet(
        PTS,
        {
            "Id": 4,
            "Type": "UploadInTankDelivery",
            "Data": {
                "Tank": 1,
                "StartDateTime": "2026-11-27T09:00:00",
                "EndDateTime": "2026-11-27T09:40:00",
                "StartProductVolume": 5000,
                "EndProductVolume": 20000,
            },
        },
    )
    for r in (nested, flat):
        assert r and r["kind"] == "tank_delivery"
        assert r["data"]["start_volume_l"] == 5000
        assert r["data"]["end_volume_l"] == 20000
        assert r["data"]["started_at"] == "2026-11-27T07:00:00.000Z"


def test_malformed_and_unknown_packets_raise_gps_config_ignored():
    with pytest.raises(JsonPtsMappingError):
        normalize_jsonpts_packet(PTS, {"Id": 5, "Type": "UploadPumpTransaction", "Data": {"Pump": 1}})
    with pytest.raises(JsonPtsMappingError):
        normalize_jsonpts_packet(PTS, {"Id": 6, "Type": "Bogus"})
    assert normalize_jsonpts_packet(PTS, {"Id": 7, "Type": "UploadGpsRecord", "Data": {}}) is None


def test_alert_record_severity_mapping():
    r = normalize_jsonpts_packet(
        PTS,
        {
            "Id": 8,
            "Type": "UploadAlertRecord",
            "Data": {"DateTime": "2026-11-27T10:00:00", "Type": "PumpOffline", "DeviceType": "Pump", "DeviceNumber": 2},
        },
    )
    assert r["data"]["severity"] == "warning" and r["data"]["device_type"] == "pump" and r["data"]["device_no"] == 2
    r = normalize_jsonpts_packet(
        PTS, {"Id": 9, "Type": "UploadAlertRecord", "Data": {"DateTime": "2026-11-27T10:00:00", "Code": "PowerLoss", "DeviceType": "x"}}
    )
    assert r["data"]["severity"] == "critical" and r["data"]["device_type"] == "controller"


def test_reply_and_signatures():
    reply = jsonpts_reply([{"id": 1, "ok": True}, {"id": 2, "ok": False, "message": "bad"}])
    assert [[p["Id"], p["Error"], p["Message"]] for p in reply["Packets"]] == [[1, False, "OK"], [2, True, "bad"]]
    assert "Type" not in reply["Packets"][0]
    body = '{"Protocol":"jsonPTS"}'
    assert verify_pts_signature("s3cret", body, hmac_sha256_hex("s3cret", body))
    assert not verify_pts_signature("s3cret", body, hmac_sha256_hex("other", body))
    assert not verify_pts_signature("s3cret", body, None)
    import re

    assert re.fullmatch(r"t=1700000000,v1=[0-9a-f]{64}", sign_webhook("k", "{}", 1700000000))
