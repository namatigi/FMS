"""Normalised telemetry records (port of packages/shared/src/records.ts).

The canonical shape after a PTS-2 jsonPTS packet has been parsed:
  PTS-2 --jsonPTS--> edge-gateway --EdgeBatch(records)--> ingest-api --> Postgres
  PTS-2 --jsonPTS--> ingest-api (direct mode, same normaliser)        --> Postgres
Field names are snake_case and map 1:1 onto columns in db/migrations/002_telemetry.sql.
Timestamps are ISO-8601 strings WITH offset; after validation they are UTC with ms ('...Z').

A record is a plain dict ``{"kind": <RecordKind>, "data": {...}}``. The TypedDicts below document
the data shapes; nothing enforces them at runtime (validate.py does).

Edge -> cloud sync contract:
  POST {INGEST_URL}/v1/edge/batches
  Authorization: Bearer <gateway API key>
  X-Gateway-Code: <edge_gateways.gateway_code>
  Content-Encoding: gzip (optional)
  EdgeBatch = {gateway_code, station_code, batch_id, sent_at, records: [{seq, kind, data}]}
Response 200: EdgeBatchResponse = {batch_id, accepted: [seq], rejected: [{seq, error, retryable}], commands: [EdgeCommand]}
Records are idempotent on natural keys, so the gateway may resend any record any number of times.
Commands are at-least-once: redelivered until the gateway's 'received' command_ack arrives.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

RecordKind = Literal[
    "pump_transaction",
    "tank_measurement",
    "tank_delivery",
    "alert",
    "status",
    "fiscal_receipt",
    "heartbeat",
    "command_ack",
]

RECORD_KINDS: frozenset[str] = frozenset(
    ["pump_transaction", "tank_measurement", "tank_delivery", "alert", "status", "fiscal_receipt", "heartbeat", "command_ack"]
)

AlertSeverity = Literal["info", "warning", "critical"]
DeviceType = Literal["controller", "pump", "probe", "tank", "priceboard", "reader", "gateway", "system"]
CommandAckStatus = Literal["received", "applied", "partial", "failed"]


class PumpTransactionRecord(TypedDict):
    pts_id: str
    pts_transaction_no: int
    pump_no: int
    nozzle_no: int
    pts_grade_id: int | None
    grade_name: str | None
    started_at: str | None
    ended_at: str
    volume_l: float
    tc_volume_l: float | None
    price: float
    amount: float
    total_volume_l: float | None
    total_amount: float | None
    tag: str | None
    pts_user_id: int | None


class TankMeasurementRecord(TypedDict):
    pts_id: str
    tank_no: int
    measured_at: str
    pts_grade_id: int | None
    probe_status: str | None
    alarms: list[str]
    product_height_mm: float | None
    water_height_mm: float | None
    temperature_c: float | None
    product_volume_l: float | None
    water_volume_l: float | None
    ullage_l: float | None
    tc_volume_l: float | None
    density_kg_m3: float | None
    mass_kg: float | None


class TankDeliveryRecord(TypedDict):
    pts_id: str
    tank_no: int
    pts_grade_id: int | None
    started_at: str
    ended_at: str
    start_volume_l: float | None
    end_volume_l: float | None
    start_tc_volume_l: float | None
    end_tc_volume_l: float | None
    start_height_mm: float | None
    end_height_mm: float | None
    start_water_mm: float | None
    end_water_mm: float | None
    start_temperature_c: float | None
    end_temperature_c: float | None
    start_density_kg_m3: float | None
    end_density_kg_m3: float | None


class _AlertBase(TypedDict):
    pts_id: str | None
    occurred_at: str
    device_type: DeviceType
    device_no: int | None
    code: str
    severity: AlertSeverity
    message: str | None


class AlertRecord(_AlertBase, total=False):
    data: dict[str, Any] | None


class StatusRecord(TypedDict):
    pts_id: str
    reported_at: str
    status: dict[str, Any]  # raw PTS-2 status payload, stored as controllers.last_status


class FiscalReceiptRecord(TypedDict):
    pump_no: int
    pts_transaction_no: int
    tx_ended_at: str
    invoice_no: str
    status: Literal["pending", "signed", "failed", "printed"]
    zra_rcpt_no: str | None
    zra_tot_rcpt_no: str | None
    zra_internal_data: str | None
    zra_signature: str | None
    zra_sdc_id: str | None
    zra_mrc_no: str | None
    zra_qr_url: str | None
    zra_signed_at: str | None
    printed_at: str | None
    attempts: int
    last_error: str | None


class GatewayHeartbeatRecord(TypedDict):
    gateway_version: str
    backlog: int
    fiscal_backlog: int
    controllers_online: list[str]
    disk_free_mb: float | None
    uptime_s: float


class CommandAckRecord(TypedDict):
    command_id: str
    status: CommandAckStatus
    at: str
    result: Any


class TelemetryRecord(TypedDict):
    kind: RecordKind
    data: dict[str, Any]


class EdgeBatchRejection(TypedDict):
    seq: int
    error: str
    retryable: bool


class EdgeBatchResponse(TypedDict):
    batch_id: str
    accepted: list[int]
    rejected: list[EdgeBatchRejection]
    commands: list[dict[str, Any]]
