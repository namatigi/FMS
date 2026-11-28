"""jsonPTS (Technotrade PTS-2) upload protocol: reply builder and packet normaliser.

Port of packages/shared/src/jsonpts.ts. Source: "PTS-2 forecourt controller technical guide" R12,
section COMMUNICATION TO REMOTE SERVER (pages 110-117). The PTS-2 POSTs JSON requests
{"Protocol": "jsonPTS", "PtsId": ..., "Packets": [{"Id", "Type", "Data"}]} to the configured URI.
The normaliser is deliberately tolerant (alternative casings, string numbers, missing optional
fields) and every raw packet is also stored in fms.ingest_raw so it can be re-processed.

VERIFY AGAINST THE jsonPTS SPEC BEFORE GO-LIVE (see docs/DESIGN.md section 12).
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable
from typing import Any

from .jsutil import _JS_WS, js_number, js_string, now_iso, parse_iso, to_iso

JSONPTS_UPLOAD_TYPES = (
    "UploadPumpTransaction",
    "UploadTankMeasurement",
    "UploadInTankDelivery",
    "UploadAlertRecord",
    "UploadGpsRecord",
    "UploadStatus",
    "UploadConfiguration",
)


class JsonPtsMappingError(Exception):
    """A packet that cannot be mapped (reply Error=true; the PTS-2 retries it)."""

    @property
    def message(self) -> str:
        return str(self)


def jsonpts_reply(results: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Server reply. Only packets confirmed OK are marked uploaded by the PTS-2; others are retried.

    results: [{"id", "type"?, "ok", "message"?}]. A missing/None type is omitted, like JSON.stringify
    drops undefined.
    """
    packets = []
    for r in results:
        p: dict[str, Any] = {"Id": r["id"]}
        if r.get("type") is not None:
            p["Type"] = r["type"]
        p["Error"] = not r["ok"]
        p["Message"] = "OK" if r["ok"] else (r.get("message") if r.get("message") is not None else "Error")
        packets.append(p)
    return {"Protocol": "jsonPTS", "Packets": packets}


# ---------------------------------------------------------------------------- helpers


def pick(o: Any, *keys: str) -> Any:
    """Case-insensitive lookup over several candidate keys (exact match first). None when absent."""
    if not isinstance(o, dict):
        return None
    for k in keys:
        if k in o:
            return o[k]
    lower = {k.lower(): k for k in o}
    for k in keys:
        real = lower.get(k.lower())
        if real is not None:
            return o[real]
    return None


def num(v: Any) -> int | float | None:
    if v is None or (isinstance(v, str) and v == ""):
        return None
    n = js_number(v)
    return n if math.isfinite(n) else None


def _req_num(v: Any, field: str) -> int | float:
    n = num(v)
    if n is None:
        raise JsonPtsMappingError(f"missing/invalid numeric field {field}")
    return n


def text(v: Any) -> str | None:
    if v is None:
        return None
    s = js_string(v).strip(_JS_WS)
    return None if s == "" else s


_HAS_OFFSET = re.compile(r"(?:[zZ]|[+-][0-9]{2}:?[0-9]{2})\Z")


def pts_time(v: Any, tz_offset: str = "+02:00") -> str | None:
    """PTS-2 local wall-clock time ("2026-11-27T10:15:30", no offset) -> UTC ISO with ms.

    Zambia (Africa/Lusaka) is UTC+02:00 all year, no DST. Values that already carry an offset are
    converted as is. Invalid values -> None (the TypeScript code threw a RangeError for an invalid
    value that carried an offset; here it is a mapping error like any other invalid time).
    """
    s = text(v)
    if not s:
        return None
    iso = s if "T" in s else s.replace(" ", "T", 1)
    if _HAS_OFFSET.search(iso):
        d = parse_iso(iso)
    else:
        d = parse_iso(f"{iso}{tz_offset}")
    return to_iso(d) if d is not None else None


def _req_time(v: Any, field: str, tz: str) -> str:
    t = pts_time(v, tz)
    if not t:
        raise JsonPtsMappingError(f"missing/invalid datetime field {field}")
    return t


ALARM_SEVERITY: dict[str, str] = {
    "CriticalHighProduct": "critical",
    "CriticalLowProduct": "critical",
    "TankLeakage": "critical",
    "PowerLoss": "critical",
    "HighProduct": "warning",
    "LowProduct": "warning",
    "HighWater": "warning",
}

_DEVICE_TYPES = ("pump", "probe", "tank", "priceboard", "reader", "controller")
_OFFLINE_OR_ERROR = re.compile(r"offline|error", re.IGNORECASE)


# ---------------------------------------------------------------------------- normaliser


def normalize_jsonpts_packet(pts_id: str, p: dict[str, Any], tz: str = "+02:00") -> dict[str, Any] | None:
    """Convert one jsonPTS upload packet into a normalised record {"kind", "data"}.

    Returns None for packet types that are accepted and only archived (GPS, configuration).
    Raises JsonPtsMappingError when a packet is malformed.
    """
    d = p.get("Data")
    if d is None:
        d = {}
    t = p.get("Type")
    if t == "UploadPumpTransaction":
        return {
            "kind": "pump_transaction",
            "data": {
                "pts_id": pts_id,
                "pts_transaction_no": _req_num(pick(d, "Transaction", "TransactionId"), "Transaction"),
                "pump_no": _req_num(pick(d, "Pump"), "Pump"),
                "nozzle_no": _req_num(pick(d, "Nozzle"), "Nozzle"),
                "pts_grade_id": num(pick(d, "FuelGradeId")),
                "grade_name": text(pick(d, "FuelGradeName")),
                "started_at": pts_time(pick(d, "DateTimeStart"), tz),
                "ended_at": _req_time(pick(d, "DateTime", "DateTimeEnd"), "DateTime", tz),
                "volume_l": _req_num(pick(d, "Volume"), "Volume"),
                "tc_volume_l": num(pick(d, "TCVolume")),
                "price": _req_num(pick(d, "Price"), "Price"),
                "amount": _req_num(pick(d, "Amount"), "Amount"),
                "total_volume_l": num(pick(d, "TotalVolume")),
                "total_amount": num(pick(d, "TotalAmount")),
                "tag": text(pick(d, "Tag")),
                "pts_user_id": num(pick(d, "UserId")),
            },
        }
    if t == "UploadTankMeasurement":
        alarms_raw = pick(d, "Alarms")
        return {
            "kind": "tank_measurement",
            "data": {
                "pts_id": pts_id,
                "tank_no": _req_num(pick(d, "Tank"), "Tank"),
                "measured_at": _req_time(pick(d, "DateTime"), "DateTime", tz),
                "pts_grade_id": num(pick(d, "FuelGradeId")),
                "probe_status": text(pick(d, "Status")),
                "alarms": [js_string(a) for a in alarms_raw] if isinstance(alarms_raw, list) else [],
                "product_height_mm": num(pick(d, "ProductHeight")),
                "water_height_mm": num(pick(d, "WaterHeight")),
                "temperature_c": num(pick(d, "Temperature")),
                "product_volume_l": num(pick(d, "ProductVolume")),
                "water_volume_l": num(pick(d, "WaterVolume")),
                "ullage_l": num(pick(d, "ProductUllage", "Ullage")),
                "tc_volume_l": num(pick(d, "ProductTCVolume")),
                "density_kg_m3": num(pick(d, "ProductDensity")),
                "mass_kg": num(pick(d, "ProductMass")),
            },
        }
    if t == "UploadInTankDelivery":
        # Start/end values may come as nested objects or as flat Start*/End* fields.
        start = pick(d, "StartMeasurement", "Start")
        end = pick(d, "EndMeasurement", "End")
        start = {} if start is None else start
        end = {} if end is None else end

        def se(o: Any, flat_prefix: str, key: str) -> int | float | None:
            v = pick(o, key)
            return num(v if v is not None else pick(d, f"{flat_prefix}{key}"))

        def coalesce(a: Any, b: Any) -> Any:
            return a if a is not None else b

        return {
            "kind": "tank_delivery",
            "data": {
                "pts_id": pts_id,
                "tank_no": _req_num(pick(d, "Tank"), "Tank"),
                "pts_grade_id": num(pick(d, "FuelGradeId")),
                "started_at": _req_time(coalesce(pick(start, "DateTime"), pick(d, "StartDateTime", "DateTimeStart")), "StartDateTime", tz),
                "ended_at": _req_time(coalesce(pick(end, "DateTime"), pick(d, "EndDateTime", "DateTime")), "EndDateTime", tz),
                "start_volume_l": se(start, "Start", "ProductVolume"),
                "end_volume_l": se(end, "End", "ProductVolume"),
                "start_tc_volume_l": se(start, "Start", "ProductTCVolume"),
                "end_tc_volume_l": se(end, "End", "ProductTCVolume"),
                "start_height_mm": se(start, "Start", "ProductHeight"),
                "end_height_mm": se(end, "End", "ProductHeight"),
                "start_water_mm": se(start, "Start", "WaterHeight"),
                "end_water_mm": se(end, "End", "WaterHeight"),
                "start_temperature_c": se(start, "Start", "Temperature"),
                "end_temperature_c": se(end, "End", "Temperature"),
                "start_density_kg_m3": se(start, "Start", "ProductDensity"),
                "end_density_kg_m3": se(end, "End", "ProductDensity"),
            },
        }
    if t == "UploadAlertRecord":
        code = text(pick(d, "Type", "Code", "AlertType")) or "Unknown"
        device_type = (text(pick(d, "DeviceType")) or "controller").lower()
        sev = ALARM_SEVERITY.get(code) or ("warning" if _OFFLINE_OR_ERROR.search(code) else "info")
        return {
            "kind": "alert",
            "data": {
                "pts_id": pts_id,
                "occurred_at": _req_time(pick(d, "DateTime"), "DateTime", tz),
                "device_type": device_type if device_type in _DEVICE_TYPES else "controller",
                "device_no": num(pick(d, "DeviceNumber", "Number")),
                "code": code,
                "severity": sev,
                "message": text(pick(d, "Message", "Description")),
                "data": d,
            },
        }
    if t == "UploadStatus":
        return {"kind": "status", "data": {"pts_id": pts_id, "reported_at": now_iso(), "status": d}}
    if t in ("UploadGpsRecord", "UploadConfiguration"):
        return None  # accepted, stored raw only (GPS tracking of tankers is phase 2)
    raise JsonPtsMappingError(f"unsupported packet type {js_string(t)}")


def alarms_to_alerts(m: dict[str, Any]) -> list[dict[str, Any]]:
    """Alerts derived from tank alarm flags on a measurement (PTS-2 reports them inline)."""
    return [
        {
            "pts_id": m["pts_id"],
            "occurred_at": m["measured_at"],
            "device_type": "tank",
            "device_no": m["tank_no"],
            "code": a,
            "severity": ALARM_SEVERITY.get(a, "warning"),
            "message": f"Tank {m['tank_no']}: {a}",
        }
        for a in m["alarms"]
    ]
