import type { TelemetryRecord, RecordKind } from '@fms/shared';

export class RecordValidationError extends Error {}

type Obj = Record<string, unknown>;

const KINDS: ReadonlySet<RecordKind> = new Set<RecordKind>([
  'pump_transaction',
  'tank_measurement',
  'tank_delivery',
  'alert',
  'status',
  'fiscal_receipt',
  'heartbeat',
  'command_ack',
]);

const ACK_STATUSES = new Set(['received', 'applied', 'partial', 'failed']);

const INT32_MAX = 2147483647;

function fail(msg: string): never {
  throw new RecordValidationError(msg);
}
function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function reqInt(d: Obj, k: string, min = 0): number {
  const v = d[k];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > INT32_MAX) fail(`${k} must be an integer >= ${min}`);
  return v;
}
function optInt(d: Obj, k: string): number | null {
  const v = d[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > INT32_MAX) fail(`${k} must be an integer`);
  return v;
}
function reqNum(d: Obj, k: string): number {
  const v = d[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${k} must be a number`);
  return v;
}
function optNum(d: Obj, k: string): number | null {
  const v = d[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${k} must be a number`);
  return v;
}
function optStr(d: Obj, k: string): string | null {
  const v = d[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') fail(`${k} must be a string`);
  return v;
}
function reqStr(d: Obj, k: string): string {
  const v = d[k];
  if (typeof v !== 'string' || v === '') fail(`${k} must be a non-empty string`);
  return v;
}
const OFFSET_RE = /([zZ]|[+-]\d{2}:?\d{2})$/;
function iso(v: unknown, k: string): string {
  if (typeof v !== 'string') fail(`${k} must be an ISO-8601 timestamp`);
  // Contract: timestamps carry an explicit offset (naive local times are ambiguous).
  if (!OFFSET_RE.test(v)) fail(`${k} must include a UTC offset`);
  const t = Date.parse(v);
  if (Number.isNaN(t)) fail(`${k} must be an ISO-8601 timestamp`);
  return new Date(t).toISOString();
}
function reqIso(d: Obj, k: string): string {
  return iso(d[k], k);
}
function optIso(d: Obj, k: string): string | null {
  const v = d[k];
  if (v === undefined || v === null) return null;
  return iso(v, k);
}

/**
 * Validate and canonicalise a telemetry record (timestamps become UTC ISO with ms).
 * Used for both edge records and normalised jsonPTS packets, so the SQL layer can trust types.
 */
export function validateRecord(input: unknown): TelemetryRecord {
  if (!isObj(input)) fail('record must be an object');
  const kind = input.kind as RecordKind;
  if (!KINDS.has(kind)) fail(`unknown record kind ${String(input.kind)}`);
  const d = input.data;
  if (!isObj(d)) fail('record.data must be an object');
  switch (kind) {
    case 'pump_transaction':
      return {
        kind,
        data: {
          pts_id: reqStr(d, 'pts_id'),
          pts_transaction_no: reqInt(d, 'pts_transaction_no'),
          pump_no: reqInt(d, 'pump_no', 1),
          nozzle_no: reqInt(d, 'nozzle_no', 1),
          pts_grade_id: optInt(d, 'pts_grade_id'),
          grade_name: optStr(d, 'grade_name'),
          started_at: optIso(d, 'started_at'),
          ended_at: reqIso(d, 'ended_at'),
          volume_l: reqNum(d, 'volume_l'),
          tc_volume_l: optNum(d, 'tc_volume_l'),
          price: reqNum(d, 'price'),
          amount: reqNum(d, 'amount'),
          total_volume_l: optNum(d, 'total_volume_l'),
          total_amount: optNum(d, 'total_amount'),
          tag: optStr(d, 'tag'),
          pts_user_id: optInt(d, 'pts_user_id'),
        },
      };
    case 'tank_measurement': {
      const alarms = d.alarms ?? [];
      if (!Array.isArray(alarms) || !alarms.every((a) => typeof a === 'string')) fail('alarms must be string[]');
      return {
        kind,
        data: {
          pts_id: reqStr(d, 'pts_id'),
          tank_no: reqInt(d, 'tank_no', 1),
          measured_at: reqIso(d, 'measured_at'),
          pts_grade_id: optInt(d, 'pts_grade_id'),
          probe_status: optStr(d, 'probe_status'),
          alarms: alarms as string[],
          product_height_mm: optNum(d, 'product_height_mm'),
          water_height_mm: optNum(d, 'water_height_mm'),
          temperature_c: optNum(d, 'temperature_c'),
          product_volume_l: optNum(d, 'product_volume_l'),
          water_volume_l: optNum(d, 'water_volume_l'),
          ullage_l: optNum(d, 'ullage_l'),
          tc_volume_l: optNum(d, 'tc_volume_l'),
          density_kg_m3: optNum(d, 'density_kg_m3'),
          mass_kg: optNum(d, 'mass_kg'),
        },
      };
    }
    case 'tank_delivery':
      return {
        kind,
        data: {
          pts_id: reqStr(d, 'pts_id'),
          tank_no: reqInt(d, 'tank_no', 1),
          pts_grade_id: optInt(d, 'pts_grade_id'),
          started_at: reqIso(d, 'started_at'),
          ended_at: reqIso(d, 'ended_at'),
          start_volume_l: optNum(d, 'start_volume_l'),
          end_volume_l: optNum(d, 'end_volume_l'),
          start_tc_volume_l: optNum(d, 'start_tc_volume_l'),
          end_tc_volume_l: optNum(d, 'end_tc_volume_l'),
          start_height_mm: optNum(d, 'start_height_mm'),
          end_height_mm: optNum(d, 'end_height_mm'),
          start_water_mm: optNum(d, 'start_water_mm'),
          end_water_mm: optNum(d, 'end_water_mm'),
          start_temperature_c: optNum(d, 'start_temperature_c'),
          end_temperature_c: optNum(d, 'end_temperature_c'),
          start_density_kg_m3: optNum(d, 'start_density_kg_m3'),
          end_density_kg_m3: optNum(d, 'end_density_kg_m3'),
        },
      };
    case 'alert': {
      const severity = d.severity;
      if (severity !== 'info' && severity !== 'warning' && severity !== 'critical') fail('severity must be info|warning|critical');
      const data = d.data;
      if (data !== undefined && data !== null && !isObj(data)) fail('alert.data must be an object');
      return {
        kind,
        data: {
          pts_id: optStr(d, 'pts_id'),
          occurred_at: reqIso(d, 'occurred_at'),
          device_type: reqStr(d, 'device_type') as never,
          device_no: optInt(d, 'device_no'),
          code: reqStr(d, 'code'),
          severity,
          message: optStr(d, 'message'),
          data: (data ?? undefined) as Obj | undefined,
        },
      };
    }
    case 'status': {
      if (!isObj(d.status)) fail('status.status must be an object');
      return {
        kind,
        data: { pts_id: reqStr(d, 'pts_id'), reported_at: optIso(d, 'reported_at') ?? new Date().toISOString(), status: d.status },
      };
    }
    case 'fiscal_receipt': {
      const status = d.status;
      if (status !== 'pending' && status !== 'signed' && status !== 'failed' && status !== 'printed')
        fail('status must be pending|signed|failed|printed');
      return {
        kind,
        data: {
          pump_no: reqInt(d, 'pump_no', 1),
          pts_transaction_no: reqInt(d, 'pts_transaction_no'),
          tx_ended_at: reqIso(d, 'tx_ended_at'),
          invoice_no: reqStr(d, 'invoice_no'),
          status,
          zra_rcpt_no: optStr(d, 'zra_rcpt_no'),
          zra_tot_rcpt_no: optStr(d, 'zra_tot_rcpt_no'),
          zra_internal_data: optStr(d, 'zra_internal_data'),
          zra_signature: optStr(d, 'zra_signature'),
          zra_sdc_id: optStr(d, 'zra_sdc_id'),
          zra_mrc_no: optStr(d, 'zra_mrc_no'),
          zra_qr_url: optStr(d, 'zra_qr_url'),
          zra_signed_at: optIso(d, 'zra_signed_at'),
          printed_at: optIso(d, 'printed_at'),
          attempts: optInt(d, 'attempts') ?? 0,
          last_error: optStr(d, 'last_error'),
        },
      };
    }
    case 'heartbeat': {
      const co = d.controllers_online ?? [];
      if (!Array.isArray(co)) fail('controllers_online must be string[]');
      return {
        kind,
        data: {
          gateway_version: optStr(d, 'gateway_version') ?? 'unknown',
          backlog: optInt(d, 'backlog') ?? 0,
          fiscal_backlog: optInt(d, 'fiscal_backlog') ?? 0,
          controllers_online: co.map(String),
          disk_free_mb: optNum(d, 'disk_free_mb'),
          uptime_s: optNum(d, 'uptime_s') ?? 0,
        },
      };
    }
    case 'command_ack': {
      const status = reqStr(d, 'status');
      if (!ACK_STATUSES.has(status)) fail('status must be received|applied|partial|failed');
      return {
        kind,
        data: {
          command_id: reqStr(d, 'command_id'),
          status: status as 'received' | 'applied' | 'partial' | 'failed',
          at: reqIso(d, 'at'),
          result: d.result ?? null,
        },
      };
    }
  }
}

/** pts_id a record refers to (null for gateway-level records). */
export function recordPtsId(r: TelemetryRecord): string | null {
  switch (r.kind) {
    case 'fiscal_receipt':
    case 'heartbeat':
    case 'command_ack':
      return null;
    default:
      return r.data.pts_id;
  }
}
