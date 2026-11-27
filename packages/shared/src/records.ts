/**
 * Normalised telemetry records — the canonical shape used everywhere after
 * the PTS-2 jsonPTS packet has been parsed:
 *   PTS-2 ──jsonPTS──► edge-gateway ──EdgeBatch(records)──► ingest-api ──► Postgres
 *   PTS-2 ──jsonPTS──► ingest-api (direct mode, same normaliser)        ──► Postgres
 * Field names are snake_case and map 1:1 onto columns in db/migrations/002_telemetry.sql.
 * All timestamps are ISO-8601 strings WITH offset (e.g. 2026-11-27T10:15:30+02:00).
 */

export interface PumpTransactionRecord {
  pts_id: string;
  pts_transaction_no: number;
  pump_no: number;
  nozzle_no: number;
  pts_grade_id: number | null;
  grade_name: string | null;
  started_at: string | null;
  ended_at: string;
  volume_l: number;
  tc_volume_l: number | null;
  price: number;
  amount: number;
  total_volume_l: number | null;
  total_amount: number | null;
  tag: string | null;
  pts_user_id: number | null;
}

export interface TankMeasurementRecord {
  pts_id: string;
  tank_no: number;
  measured_at: string;
  pts_grade_id: number | null;
  probe_status: string | null;
  alarms: string[];
  product_height_mm: number | null;
  water_height_mm: number | null;
  temperature_c: number | null;
  product_volume_l: number | null;
  water_volume_l: number | null;
  ullage_l: number | null;
  tc_volume_l: number | null;
  density_kg_m3: number | null;
  mass_kg: number | null;
}

export interface TankDeliveryRecord {
  pts_id: string;
  tank_no: number;
  pts_grade_id: number | null;
  started_at: string;
  ended_at: string;
  start_volume_l: number | null;
  end_volume_l: number | null;
  start_tc_volume_l: number | null;
  end_tc_volume_l: number | null;
  start_height_mm: number | null;
  end_height_mm: number | null;
  start_water_mm: number | null;
  end_water_mm: number | null;
  start_temperature_c: number | null;
  end_temperature_c: number | null;
  start_density_kg_m3: number | null;
  end_density_kg_m3: number | null;
}

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertRecord {
  pts_id: string | null;
  occurred_at: string;
  device_type: 'controller' | 'pump' | 'probe' | 'tank' | 'priceboard' | 'reader' | 'gateway' | 'system';
  device_no: number | null;
  code: string;
  severity: AlertSeverity;
  message: string | null;
  data?: Record<string, unknown>;
}

export interface StatusRecord {
  pts_id: string;
  reported_at: string;
  /** Raw PTS-2 status payload (pumps, probes, controller). Stored as JSONB in controllers.last_status. */
  status: Record<string, unknown>;
}

/** Receipt produced by ZRA Smart Invoice (VSDC) — synced from edge so the cloud has the fiscal trail. */
export interface FiscalReceiptRecord {
  pump_no: number;
  pts_transaction_no: number;
  tx_ended_at: string;
  invoice_no: string;
  status: 'pending' | 'signed' | 'failed' | 'printed';
  zra_rcpt_no: string | null;
  zra_tot_rcpt_no: string | null;
  zra_internal_data: string | null;
  zra_signature: string | null;
  zra_sdc_id: string | null;
  zra_mrc_no: string | null;
  zra_qr_url: string | null;
  zra_signed_at: string | null;
  printed_at: string | null;
  attempts: number;
  last_error: string | null;
}

export interface GatewayHeartbeatRecord {
  gateway_version: string;
  backlog: number;               // records not yet acknowledged by the cloud
  fiscal_backlog: number;        // transactions not yet signed by ZRA
  controllers_online: string[];  // pts_ids heard from in the last 60 s
  disk_free_mb: number | null;
  uptime_s: number;
}

/**
 * Gateway acknowledgement of a cloud EdgeCommand, sent through the durable outbox.
 * 'received' is sent as soon as the command is stored at the edge (stops redelivery);
 * a terminal status follows once it has been applied (or given up on).
 */
export interface CommandAckRecord {
  command_id: string;
  status: 'received' | 'applied' | 'partial' | 'failed';
  at: string;                    // ISO-8601 time of this state at the edge
  result: unknown;               // outcome detail (per-controller results, error)
}

export type RecordKind =
  | 'pump_transaction'
  | 'tank_measurement'
  | 'tank_delivery'
  | 'alert'
  | 'status'
  | 'fiscal_receipt'
  | 'heartbeat'
  | 'command_ack';

export type TelemetryRecord =
  | { kind: 'pump_transaction'; data: PumpTransactionRecord }
  | { kind: 'tank_measurement'; data: TankMeasurementRecord }
  | { kind: 'tank_delivery'; data: TankDeliveryRecord }
  | { kind: 'alert'; data: AlertRecord }
  | { kind: 'status'; data: StatusRecord }
  | { kind: 'fiscal_receipt'; data: FiscalReceiptRecord }
  | { kind: 'heartbeat'; data: GatewayHeartbeatRecord }
  | { kind: 'command_ack'; data: CommandAckRecord };

/**
 * Edge → cloud sync contract.
 *   POST {INGEST_URL}/v1/edge/batches
 *   Authorization: Bearer <gateway API key>
 *   X-Gateway-Code: <edge_gateways.gateway_code>
 *   Content-Encoding: gzip (optional)
 * Response 200: EdgeBatchResponse. Records are idempotent on natural keys, so the
 * gateway may resend any record any number of times (at-least-once delivery).
 */
export interface EdgeBatch {
  gateway_code: string;
  station_code: string;
  batch_id: string;              // UUID, for tracing
  sent_at: string;
  records: Array<TelemetryRecord & { seq: number }>; // seq = edge outbox id
}

export interface EdgeBatchResponse {
  batch_id: string;
  accepted: number[];            // seqs persisted (or already present)
  rejected: Array<{ seq: number; error: string; retryable: boolean }>;
  /**
   * Commands for the station (e.g. price update), delivered piggy-back from fms.edge_commands.
   * At-least-once: redelivered until the gateway's 'received' command_ack arrives, so the
   * gateway must apply them idempotently by id.
   */
  commands: EdgeCommand[];
}

export type EdgeCommand =
  | { id: string; type: 'set_prices'; prices: Array<{ pts_grade_id: number; price: number }>; effective_at: string }
  | { id: string; type: 'refiscalise'; pump_no: number; pts_transaction_no: number; tx_ended_at: string }
  | { id: string; type: 'reload_config' };
