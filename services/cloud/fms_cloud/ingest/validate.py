"""Record validation and canonicalisation (port of services/ingest-api/src/validate.ts).

Used for both edge records and normalised jsonPTS packets, so the SQL layer can trust types:
integers are Python ints, timestamps are UTC ISO strings with milliseconds.
"""

from __future__ import annotations

import re
from typing import Any, NoReturn

from .jsutil import MISSING, is_finite, is_integer, js_string, now_iso, num_out, parse_iso, to_iso
from .records import RECORD_KINDS

ACK_STATUSES = frozenset(["received", "applied", "partial", "failed"])
INT32_MAX = 2147483647


class RecordValidationError(Exception):
    @property
    def message(self) -> str:
        return str(self)


def _fail(msg: str) -> NoReturn:
    raise RecordValidationError(msg)


def _get(d: dict, k: str) -> Any:
    return d.get(k, MISSING)


def _dflt(v: Any, default: Any) -> Any:
    """v ?? default"""
    return default if v is None else v


def _absent(v: Any) -> bool:
    return v is MISSING or v is None


def _req_int(d: dict, k: str, lo: int = 0) -> int:
    v = _get(d, k)
    if not is_integer(v) or v < lo or v > INT32_MAX:
        _fail(f"{k} must be an integer >= {lo}")
    return int(v)


def _opt_int(d: dict, k: str) -> int | None:
    v = _get(d, k)
    if _absent(v):
        return None
    if not is_integer(v) or abs(v) > INT32_MAX:
        _fail(f"{k} must be an integer")
    return int(v)


def _req_num(d: dict, k: str) -> int | float:
    v = _get(d, k)
    if not is_finite(v):
        _fail(f"{k} must be a number")
    return num_out(v)


def _opt_num(d: dict, k: str) -> int | float | None:
    v = _get(d, k)
    if _absent(v):
        return None
    if not is_finite(v):
        _fail(f"{k} must be a number")
    return num_out(v)


def _opt_str(d: dict, k: str) -> str | None:
    v = _get(d, k)
    if _absent(v):
        return None
    if not isinstance(v, str):
        _fail(f"{k} must be a string")
    return v


def _req_str(d: dict, k: str) -> str:
    v = _get(d, k)
    if not isinstance(v, str) or v == "":
        _fail(f"{k} must be a non-empty string")
    return v


# Contract: timestamps carry an explicit offset (naive local times are ambiguous).
_OFFSET_RE = re.compile(r"(?:[zZ]|[+-][0-9]{2}:?[0-9]{2})\Z")


def _iso(v: Any, k: str) -> str:
    if not isinstance(v, str):
        _fail(f"{k} must be an ISO-8601 timestamp")
    if not _OFFSET_RE.search(v):
        _fail(f"{k} must include a UTC offset")
    t = parse_iso(v)
    if t is None:
        _fail(f"{k} must be an ISO-8601 timestamp")
    return to_iso(t)


def _req_iso(d: dict, k: str) -> str:
    return _iso(_get(d, k), k)


def _opt_iso(d: dict, k: str) -> str | None:
    v = _get(d, k)
    if _absent(v):
        return None
    return _iso(v, k)


def validate_record(inp: Any) -> dict[str, Any]:
    """Validate and canonicalise a telemetry record. Raises RecordValidationError."""
    if not isinstance(inp, dict):
        _fail("record must be an object")
    kind = _get(inp, "kind")
    if not isinstance(kind, str) or kind not in RECORD_KINDS:
        _fail(f"unknown record kind {js_string(kind)}")
    d = _get(inp, "data")
    if not isinstance(d, dict):
        _fail("record.data must be an object")

    if kind == "pump_transaction":
        data = {
            "pts_id": _req_str(d, "pts_id"),
            "pts_transaction_no": _req_int(d, "pts_transaction_no"),
            "pump_no": _req_int(d, "pump_no", 1),
            "nozzle_no": _req_int(d, "nozzle_no", 1),
            "pts_grade_id": _opt_int(d, "pts_grade_id"),
            "grade_name": _opt_str(d, "grade_name"),
            "started_at": _opt_iso(d, "started_at"),
            "ended_at": _req_iso(d, "ended_at"),
            "volume_l": _req_num(d, "volume_l"),
            "tc_volume_l": _opt_num(d, "tc_volume_l"),
            "price": _req_num(d, "price"),
            "amount": _req_num(d, "amount"),
            "total_volume_l": _opt_num(d, "total_volume_l"),
            "total_amount": _opt_num(d, "total_amount"),
            "tag": _opt_str(d, "tag"),
            "pts_user_id": _opt_int(d, "pts_user_id"),
        }
    elif kind == "tank_measurement":
        alarms = d.get("alarms")
        if alarms is None:
            alarms = []
        if not isinstance(alarms, list) or not all(isinstance(a, str) for a in alarms):
            _fail("alarms must be string[]")
        data = {
            "pts_id": _req_str(d, "pts_id"),
            "tank_no": _req_int(d, "tank_no", 1),
            "measured_at": _req_iso(d, "measured_at"),
            "pts_grade_id": _opt_int(d, "pts_grade_id"),
            "probe_status": _opt_str(d, "probe_status"),
            "alarms": list(alarms),
            "product_height_mm": _opt_num(d, "product_height_mm"),
            "water_height_mm": _opt_num(d, "water_height_mm"),
            "temperature_c": _opt_num(d, "temperature_c"),
            "product_volume_l": _opt_num(d, "product_volume_l"),
            "water_volume_l": _opt_num(d, "water_volume_l"),
            "ullage_l": _opt_num(d, "ullage_l"),
            "tc_volume_l": _opt_num(d, "tc_volume_l"),
            "density_kg_m3": _opt_num(d, "density_kg_m3"),
            "mass_kg": _opt_num(d, "mass_kg"),
        }
    elif kind == "tank_delivery":
        data = {
            "pts_id": _req_str(d, "pts_id"),
            "tank_no": _req_int(d, "tank_no", 1),
            "pts_grade_id": _opt_int(d, "pts_grade_id"),
            "started_at": _req_iso(d, "started_at"),
            "ended_at": _req_iso(d, "ended_at"),
            **{
                k: _opt_num(d, k)
                for k in (
                    "start_volume_l",
                    "end_volume_l",
                    "start_tc_volume_l",
                    "end_tc_volume_l",
                    "start_height_mm",
                    "end_height_mm",
                    "start_water_mm",
                    "end_water_mm",
                    "start_temperature_c",
                    "end_temperature_c",
                    "start_density_kg_m3",
                    "end_density_kg_m3",
                )
            },
        }
    elif kind == "alert":
        severity = _get(d, "severity")
        if severity not in ("info", "warning", "critical"):
            _fail("severity must be info|warning|critical")
        extra = _get(d, "data")
        if not _absent(extra) and not isinstance(extra, dict):
            _fail("alert.data must be an object")
        data = {
            "pts_id": _opt_str(d, "pts_id"),
            "occurred_at": _req_iso(d, "occurred_at"),
            "device_type": _req_str(d, "device_type"),
            "device_no": _opt_int(d, "device_no"),
            "code": _req_str(d, "code"),
            "severity": severity,
            "message": _opt_str(d, "message"),
        }
        if not _absent(extra):
            data["data"] = extra
    elif kind == "status":
        if not isinstance(_get(d, "status"), dict):
            _fail("status.status must be an object")
        pts_id = _req_str(d, "pts_id")
        reported = _opt_iso(d, "reported_at")
        data = {"pts_id": pts_id, "reported_at": reported if reported is not None else now_iso(), "status": d["status"]}
    elif kind == "fiscal_receipt":
        status = _get(d, "status")
        if status not in ("pending", "signed", "failed", "printed"):
            _fail("status must be pending|signed|failed|printed")
        data = {
            "pump_no": _req_int(d, "pump_no", 1),
            "pts_transaction_no": _req_int(d, "pts_transaction_no"),
            "tx_ended_at": _req_iso(d, "tx_ended_at"),
            "invoice_no": _req_str(d, "invoice_no"),
            "status": status,
            "zra_rcpt_no": _opt_str(d, "zra_rcpt_no"),
            "zra_tot_rcpt_no": _opt_str(d, "zra_tot_rcpt_no"),
            "zra_internal_data": _opt_str(d, "zra_internal_data"),
            "zra_signature": _opt_str(d, "zra_signature"),
            "zra_sdc_id": _opt_str(d, "zra_sdc_id"),
            "zra_mrc_no": _opt_str(d, "zra_mrc_no"),
            "zra_qr_url": _opt_str(d, "zra_qr_url"),
            "zra_signed_at": _opt_iso(d, "zra_signed_at"),
            "printed_at": _opt_iso(d, "printed_at"),
            "attempts": _dflt(_opt_int(d, "attempts"), 0),
            "last_error": _opt_str(d, "last_error"),
        }
    elif kind == "heartbeat":
        co = d.get("controllers_online")
        if co is None:
            co = []
        if not isinstance(co, list):
            _fail("controllers_online must be string[]")
        data = {
            "gateway_version": _dflt(_opt_str(d, "gateway_version"), "unknown"),
            "backlog": _dflt(_opt_int(d, "backlog"), 0),
            "fiscal_backlog": _dflt(_opt_int(d, "fiscal_backlog"), 0),
            "controllers_online": [js_string(x) for x in co],
            "disk_free_mb": _opt_num(d, "disk_free_mb"),
            "uptime_s": _dflt(_opt_num(d, "uptime_s"), 0),
        }
    else:  # command_ack
        status = _req_str(d, "status")
        if status not in ACK_STATUSES:
            _fail("status must be received|applied|partial|failed")
        result = d.get("result")
        data = {
            "command_id": _req_str(d, "command_id"),
            "status": status,
            "at": _req_iso(d, "at"),
            "result": result,
        }
    return {"kind": kind, "data": data}


def record_pts_id(r: dict[str, Any]) -> str | None:
    """pts_id a record refers to (None for gateway-level records)."""
    if r["kind"] in ("fiscal_receipt", "heartbeat", "command_ack"):
        return None
    return r["data"].get("pts_id")
