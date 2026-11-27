/**
 * jsonPTS (Technotrade PTS-2) upload protocol — types and normaliser.
 *
 * Source: "PTS-2 forecourt controller technical guide" R12, section
 * COMMUNICATION TO REMOTE SERVER (pages 110-117). The PTS-2 acts as an HTTP
 * client and POSTs JSON requests to the configured URI; each request carries
 * one or more packets. The full field list is in Technotrade's separate
 * "jsonPTS communication protocol specification for PTS-2 controller", which is
 * NOT in this repository. Field names below follow the published jsonPTS
 * conventions; the normaliser is deliberately tolerant (accepts alternative
 * casings / missing optional fields) and every raw packet is also stored in
 * fms.ingest_raw so it can be re-processed if a mapping needs correcting.
 *
 * VERIFY AGAINST THE jsonPTS SPEC BEFORE GO-LIVE (see docs/DESIGN.md §12).
 */
import type {
  AlertRecord,
  PumpTransactionRecord,
  StatusRecord,
  TankDeliveryRecord,
  TankMeasurementRecord,
  TelemetryRecord,
} from './records.js';

export const JSONPTS_UPLOAD_TYPES = [
  'UploadPumpTransaction',
  'UploadTankMeasurement',
  'UploadInTankDelivery',
  'UploadAlertRecord',
  'UploadGpsRecord',
  'UploadStatus',
  'UploadConfiguration',
] as const;
export type JsonPtsUploadType = (typeof JSONPTS_UPLOAD_TYPES)[number];

export interface JsonPtsPacket {
  Id: number;
  Type: string;
  Data?: Record<string, unknown>;
}

export interface JsonPtsRequest {
  Protocol: 'jsonPTS';
  PtsId?: string;
  Packets: JsonPtsPacket[];
}

export interface JsonPtsResponsePacket {
  Id: number;
  Type?: string;
  Error?: boolean;
  Code?: number;
  Message: string;
}

export interface JsonPtsResponse {
  Protocol: 'jsonPTS';
  Packets: JsonPtsResponsePacket[];
}

/** Build the server reply. Only packets confirmed OK are marked uploaded by the PTS-2; others are retried. */
export function jsonPtsReply(results: Array<{ id: number; type?: string; ok: boolean; message?: string }>): JsonPtsResponse {
  return {
    Protocol: 'jsonPTS',
    Packets: results.map((r) => ({
      Id: r.id,
      Type: r.type,
      Error: !r.ok,
      Message: r.ok ? 'OK' : (r.message ?? 'Error'),
    })),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
type Obj = Record<string, unknown>;

/** Case-insensitive lookup over several candidate keys. */
function pick(o: Obj | undefined, ...keys: string[]): unknown {
  if (!o) return undefined;
  for (const k of keys) {
    if (k in o) return o[k];
  }
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lower.get(k.toLowerCase());
    if (real !== undefined) return o[real];
  }
  return undefined;
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function reqNum(v: unknown, field: string): number {
  const n = num(v);
  if (n === null) throw new JsonPtsMappingError(`missing/invalid numeric field ${field}`);
  return n;
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * PTS-2 sends local wall-clock time without offset ("2026-11-27T10:15:30").
 * Zambia (Africa/Lusaka) is UTC+02:00 all year, no DST.
 */
export function ptsTime(v: unknown, tzOffset = '+02:00'): string | null {
  const s = str(v);
  if (!s) return null;
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)) return new Date(iso).toISOString();
  const d = new Date(`${iso}${tzOffset}`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function reqTime(v: unknown, field: string, tz: string): string {
  const t = ptsTime(v, tz);
  if (!t) throw new JsonPtsMappingError(`missing/invalid datetime field ${field}`);
  return t;
}

export class JsonPtsMappingError extends Error {}

const ALARM_SEVERITY: Record<string, 'warning' | 'critical'> = {
  CriticalHighProduct: 'critical',
  CriticalLowProduct: 'critical',
  TankLeakage: 'critical',
  PowerLoss: 'critical',
  HighProduct: 'warning',
  LowProduct: 'warning',
  HighWater: 'warning',
};

// ---------------------------------------------------------------------------
// normaliser
// ---------------------------------------------------------------------------
/**
 * Convert one jsonPTS upload packet into a normalised record.
 * Returns null for packet types we accept-and-ignore (GPS, configuration).
 * Throws JsonPtsMappingError when a packet is malformed (reply Error=true; PTS-2 will retry).
 */
export function normalizeJsonPtsPacket(ptsId: string, p: JsonPtsPacket, tz = '+02:00'): TelemetryRecord | null {
  const d = (p.Data ?? {}) as Obj;
  switch (p.Type) {
    case 'UploadPumpTransaction': {
      const rec: PumpTransactionRecord = {
        pts_id: ptsId,
        pts_transaction_no: reqNum(pick(d, 'Transaction', 'TransactionId'), 'Transaction'),
        pump_no: reqNum(pick(d, 'Pump'), 'Pump'),
        nozzle_no: reqNum(pick(d, 'Nozzle'), 'Nozzle'),
        pts_grade_id: num(pick(d, 'FuelGradeId')),
        grade_name: str(pick(d, 'FuelGradeName')),
        started_at: ptsTime(pick(d, 'DateTimeStart'), tz),
        ended_at: reqTime(pick(d, 'DateTime', 'DateTimeEnd'), 'DateTime', tz),
        volume_l: reqNum(pick(d, 'Volume'), 'Volume'),
        tc_volume_l: num(pick(d, 'TCVolume')),
        price: reqNum(pick(d, 'Price'), 'Price'),
        amount: reqNum(pick(d, 'Amount'), 'Amount'),
        total_volume_l: num(pick(d, 'TotalVolume')),
        total_amount: num(pick(d, 'TotalAmount')),
        tag: str(pick(d, 'Tag')),
        pts_user_id: num(pick(d, 'UserId')),
      };
      return { kind: 'pump_transaction', data: rec };
    }
    case 'UploadTankMeasurement': {
      const alarmsRaw = pick(d, 'Alarms');
      const rec: TankMeasurementRecord = {
        pts_id: ptsId,
        tank_no: reqNum(pick(d, 'Tank'), 'Tank'),
        measured_at: reqTime(pick(d, 'DateTime'), 'DateTime', tz),
        pts_grade_id: num(pick(d, 'FuelGradeId')),
        probe_status: str(pick(d, 'Status')),
        alarms: Array.isArray(alarmsRaw) ? alarmsRaw.map(String) : [],
        product_height_mm: num(pick(d, 'ProductHeight')),
        water_height_mm: num(pick(d, 'WaterHeight')),
        temperature_c: num(pick(d, 'Temperature')),
        product_volume_l: num(pick(d, 'ProductVolume')),
        water_volume_l: num(pick(d, 'WaterVolume')),
        ullage_l: num(pick(d, 'ProductUllage', 'Ullage')),
        tc_volume_l: num(pick(d, 'ProductTCVolume')),
        density_kg_m3: num(pick(d, 'ProductDensity')),
        mass_kg: num(pick(d, 'ProductMass')),
      };
      return { kind: 'tank_measurement', data: rec };
    }
    case 'UploadInTankDelivery': {
      // Start/end values may come as nested objects or as flat Start*/End* fields.
      const start = (pick(d, 'StartMeasurement', 'Start') as Obj | undefined) ?? {};
      const end = (pick(d, 'EndMeasurement', 'End') as Obj | undefined) ?? {};
      const se = (o: Obj, flatPrefix: 'Start' | 'End', key: string) => num(pick(o, key) ?? pick(d, `${flatPrefix}${key}`));
      const rec: TankDeliveryRecord = {
        pts_id: ptsId,
        tank_no: reqNum(pick(d, 'Tank'), 'Tank'),
        pts_grade_id: num(pick(d, 'FuelGradeId')),
        started_at: reqTime(pick(start, 'DateTime') ?? pick(d, 'StartDateTime', 'DateTimeStart'), 'StartDateTime', tz),
        ended_at: reqTime(pick(end, 'DateTime') ?? pick(d, 'EndDateTime', 'DateTime'), 'EndDateTime', tz),
        start_volume_l: se(start, 'Start', 'ProductVolume'),
        end_volume_l: se(end, 'End', 'ProductVolume'),
        start_tc_volume_l: se(start, 'Start', 'ProductTCVolume'),
        end_tc_volume_l: se(end, 'End', 'ProductTCVolume'),
        start_height_mm: se(start, 'Start', 'ProductHeight'),
        end_height_mm: se(end, 'End', 'ProductHeight'),
        start_water_mm: se(start, 'Start', 'WaterHeight'),
        end_water_mm: se(end, 'End', 'WaterHeight'),
        start_temperature_c: se(start, 'Start', 'Temperature'),
        end_temperature_c: se(end, 'End', 'Temperature'),
        start_density_kg_m3: se(start, 'Start', 'ProductDensity'),
        end_density_kg_m3: se(end, 'End', 'ProductDensity'),
      };
      return { kind: 'tank_delivery', data: rec };
    }
    case 'UploadAlertRecord': {
      const code = str(pick(d, 'Type', 'Code', 'AlertType')) ?? 'Unknown';
      const deviceType = (str(pick(d, 'DeviceType')) ?? 'controller').toLowerCase();
      const rec: AlertRecord = {
        pts_id: ptsId,
        occurred_at: reqTime(pick(d, 'DateTime'), 'DateTime', tz),
        device_type: (['pump', 'probe', 'tank', 'priceboard', 'reader', 'controller'].includes(deviceType)
          ? deviceType
          : 'controller') as AlertRecord['device_type'],
        device_no: num(pick(d, 'DeviceNumber', 'Number')),
        code,
        severity: ALARM_SEVERITY[code] ?? (/offline|error/i.test(code) ? 'warning' : 'info'),
        message: str(pick(d, 'Message', 'Description')),
        data: d,
      };
      return { kind: 'alert', data: rec };
    }
    case 'UploadStatus': {
      const rec: StatusRecord = { pts_id: ptsId, reported_at: new Date().toISOString(), status: d };
      return { kind: 'status', data: rec };
    }
    case 'UploadGpsRecord':
    case 'UploadConfiguration':
      return null; // accepted, stored raw only (GPS tracking of tankers is phase 2)
    default:
      throw new JsonPtsMappingError(`unsupported packet type ${p.Type}`);
  }
}

/** Alerts derived from tank alarm flags on a measurement (PTS-2 reports them inline). */
export function alarmsToAlerts(m: TankMeasurementRecord): AlertRecord[] {
  return m.alarms.map((a) => ({
    pts_id: m.pts_id,
    occurred_at: m.measured_at,
    device_type: 'tank',
    device_no: m.tank_no,
    code: a,
    severity: ALARM_SEVERITY[a] ?? 'warning',
    message: `Tank ${m.tank_no}: ${a}`,
  }));
}
