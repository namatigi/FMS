/**
 * Set-based persistence of normalised telemetry records.
 *
 * All records of one request are written in ONE transaction, with one multi-row
 * statement per table (json_to_recordset), so a 500-record batch costs ~10-15
 * round trips instead of ~500+. Every write is idempotent on the table's
 * natural key, so the PTS-2 / edge gateway may resend anything any number of times.
 */
import {
  alarmsToAlerts,
  type AlertRecord,
  type FiscalReceiptRecord,
  type GatewayHeartbeatRecord,
  type PumpTransactionRecord,
  type StatusRecord,
  type TankDeliveryRecord,
  type TankMeasurementRecord,
  type TelemetryRecord,
} from '@fms/shared';
import type { Tx } from './db.js';
import { localDate, type StationRef } from './refdata.js';

export type Outcome = 'inserted' | 'duplicate' | 'ignored';

export interface PersistItem {
  /** caller-defined key (edge: record index; jsonPTS: packet index) */
  key: number;
  rec: TelemetryRecord;
  station: StationRef;
}

export interface PersistCtx {
  source: 'pts_direct' | 'edge';
  gatewayId?: string;
  rollupDelayS: number;
  /** pts_ids whose controllers.last_seen_at should be touched (direct mode) */
  touchControllers?: string[];
}

export interface RaisedAlert {
  id: number;
  code: string;
  severity: string;
}

export interface PersistResult {
  outcome: Map<number, Outcome>;
  alerts: RaisedAlert[];
  jobs: number;
}

interface JobRow {
  kind: string;
  payload: Record<string, unknown>;
  dedupe_key: string;
}

interface PendingAlert {
  station: StationRef;
  rec: AlertRecord;
  /** item key when the alert came in as an `alert` record */
  key?: number;
  /** extra webhook to emit when newly inserted (non-critical alerts, e.g. stock_low) */
  webhookEvent?: string;
}

const ms = (iso: string | Date) => (typeof iso === 'string' ? new Date(iso) : iso).toISOString();
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Pick only the first occurrence of each natural key (multi-row upserts cannot touch a row twice). */
function dedupe<T>(xs: T[], key: (x: T) => string): { uniq: T[]; dupOf: Map<T, T> } {
  const seen = new Map<string, T>();
  const uniq: T[] = [];
  const dupOf = new Map<T, T>();
  for (const x of xs) {
    const k = key(x);
    const first = seen.get(k);
    if (first) dupOf.set(x, first);
    else {
      seen.set(k, x);
      uniq.push(x);
    }
  }
  return { uniq, dupOf };
}

export class Persister {
  private outcome = new Map<number, Outcome>();
  private alerts: PendingAlert[] = [];
  private jobs: JobRow[] = [];
  private rollups = new Map<string, { station_id: string; business_date: string }>();
  private raised: RaisedAlert[] = [];

  constructor(private c: Tx, private ctx: PersistCtx) {}

  async run(items: PersistItem[]): Promise<PersistResult> {
    const by = <K extends TelemetryRecord['kind']>(k: K) =>
      items.filter((i) => i.rec.kind === k) as Array<PersistItem & { rec: Extract<TelemetryRecord, { kind: K }> }>;

    await this.pumpTransactions(by('pump_transaction'));
    await this.tankMeasurements(by('tank_measurement'));
    await this.tankDeliveries(by('tank_delivery'));
    for (const it of by('alert')) this.alerts.push({ station: it.station, rec: it.rec.data, key: it.key });
    await this.insertAlerts();
    await this.statuses(by('status'));
    await this.heartbeats(by('heartbeat'));
    await this.fiscalReceipts(by('fiscal_receipt'));
    await this.insertJobs();
    await this.enqueueRollups();
    return { outcome: this.outcome, alerts: this.raised, jobs: this.jobs.length };
  }

  private addRollup(st: StationRef, at: string) {
    const d = localDate(at, st.timezone);
    const k = `rollup:${st.id}:${d}`;
    if (!this.rollups.has(k)) this.rollups.set(k, { station_id: st.id, business_date: d });
  }

  // ---------------------------------------------------------------- pump transactions
  private async pumpTransactions(items: Array<PersistItem & { rec: { kind: 'pump_transaction'; data: PumpTransactionRecord } }>) {
    if (!items.length) return;
    const key = (st: string, pump: number, txno: number, ended: string) => `${st}|${pump}|${txno}|${ended}`;
    const { uniq, dupOf } = dedupe(items, (i) => key(i.station.id, i.rec.data.pump_no, i.rec.data.pts_transaction_no, i.rec.data.ended_at));
    const rows = uniq.map((i) => {
      const t = i.rec.data;
      const st = i.station;
      const nz = st.nozzles.get(`${t.pump_no}:${t.nozzle_no}`);
      const product = (t.pts_grade_id !== null ? st.grades.get(t.pts_grade_id) : undefined) ?? nz?.product_code ?? null;
      return {
        station_id: st.id,
        pts_id: t.pts_id,
        pts_transaction_no: t.pts_transaction_no,
        pump_no: t.pump_no,
        nozzle_no: t.nozzle_no,
        pts_grade_id: t.pts_grade_id,
        product_code: product,
        tank_no: nz?.tank_no ?? null,
        started_at: t.started_at,
        ended_at: t.ended_at,
        volume_l: t.volume_l,
        tc_volume_l: t.tc_volume_l,
        price: t.price,
        amount: t.amount,
        total_volume_l: t.total_volume_l,
        total_amount: t.total_amount,
        tag: t.tag,
        pts_user_id: t.pts_user_id,
        source: this.ctx.source,
      };
    });
    // fiscal_status is pre-set when the edge synced the receipt before the sale (out-of-order batches).
    const res = await this.c.query<{ station_id: string; pump_no: number; pts_transaction_no: number; ended_at: Date }>(
      `INSERT INTO fms.pump_transactions
         (station_id, pts_id, pts_transaction_no, pump_no, nozzle_no, pts_grade_id, product_code, tank_no,
          started_at, ended_at, volume_l, tc_volume_l, price, amount, total_volume_l, total_amount, tag,
          pts_user_id, source, fiscal_status)
       SELECT r.station_id, r.pts_id, r.pts_transaction_no, r.pump_no, r.nozzle_no, r.pts_grade_id, r.product_code, r.tank_no,
              r.started_at, r.ended_at, r.volume_l, r.tc_volume_l, r.price, r.amount, r.total_volume_l, r.total_amount, r.tag,
              r.pts_user_id, r.source,
              coalesce((SELECT CASE WHEN f.status IN ('signed','printed') THEN 'signed'
                                    WHEN f.status = 'failed' THEN 'failed' ELSE 'pending' END
                          FROM fms.fiscal_receipts f
                         WHERE f.station_id = r.station_id AND f.pump_no = r.pump_no
                           AND f.pts_transaction_no = r.pts_transaction_no AND f.tx_ended_at = r.ended_at), 'pending')
         FROM json_to_recordset($1::json) AS r(
              station_id uuid, pts_id text, pts_transaction_no int, pump_no int, nozzle_no int, pts_grade_id int,
              product_code text, tank_no int, started_at timestamptz, ended_at timestamptz, volume_l numeric,
              tc_volume_l numeric, price numeric, amount numeric, total_volume_l numeric, total_amount numeric,
              tag text, pts_user_id int, source text)
       ON CONFLICT DO NOTHING
       RETURNING station_id, pump_no, pts_transaction_no, ended_at`,
      [JSON.stringify(rows)],
    );
    const inserted = new Set(res.rows.map((r) => key(r.station_id, r.pump_no, r.pts_transaction_no, ms(r.ended_at))));
    const fresh: typeof uniq = [];
    for (const i of uniq) {
      const t = i.rec.data;
      const isNew = inserted.has(key(i.station.id, t.pump_no, t.pts_transaction_no, t.ended_at));
      this.outcome.set(i.key, isNew ? 'inserted' : 'duplicate');
      if (isNew) fresh.push(i);
    }
    for (const [dup] of dupOf) this.outcome.set(dup.key, 'duplicate');

    for (const i of fresh) {
      const t = i.rec.data;
      this.addRollup(i.station, t.ended_at);
      if (i.station.connection_mode === 'direct') {
        this.jobs.push({
          kind: 'fiscalise',
          dedupe_key: `fiscalise:${i.station.id}:${t.pump_no}:${t.pts_transaction_no}:${t.ended_at}`,
          payload: {
            station_id: i.station.id,
            pump_no: t.pump_no,
            nozzle_no: t.nozzle_no,
            pts_transaction_no: t.pts_transaction_no,
            ended_at: t.ended_at,
          },
        });
      }
    }
    await this.totaliserCheck(fresh);
  }

  /**
   * Totaliser continuity: unaccounted = (total_now - total_prev) - volume. > 0.5 L means fuel left the
   * nozzle without a recorded sale (e.g. manual mode). Previous = latest earlier sale on the same
   * station/pump/nozzle with a totaliser value (may be in this same batch: rows are already inserted).
   */
  private async totaliserCheck(fresh: Array<PersistItem & { rec: { kind: 'pump_transaction'; data: PumpTransactionRecord } }>) {
    const withTotals = fresh.filter((i) => i.rec.data.total_volume_l !== null);
    if (!withTotals.length) return;
    const rows = withTotals.map((i, k) => ({
      k,
      station_id: i.station.id,
      pump_no: i.rec.data.pump_no,
      nozzle_no: i.rec.data.nozzle_no,
      ended_at: i.rec.data.ended_at,
    }));
    const res = await this.c.query<{ k: number; prev_total: number }>(
      `SELECT r.k, p.total_volume_l AS prev_total
         FROM json_to_recordset($1::json) AS r(k int, station_id uuid, pump_no int, nozzle_no int, ended_at timestamptz)
         CROSS JOIN LATERAL (
              SELECT t.total_volume_l FROM fms.pump_transactions t
               WHERE t.station_id = r.station_id AND t.pump_no = r.pump_no AND t.nozzle_no = r.nozzle_no
                 AND t.ended_at < r.ended_at AND t.total_volume_l IS NOT NULL
               ORDER BY t.ended_at DESC LIMIT 1) p`,
      [JSON.stringify(rows)],
    );
    for (const r of res.rows) {
      const i = withTotals[r.k]!;
      const t = i.rec.data;
      const prev = Number(r.prev_total);
      const actual = t.total_volume_l as number;
      const expected = round3(prev + t.volume_l);
      const unaccounted = round3(actual - prev - t.volume_l);
      if (unaccounted > 0.5) {
        this.alerts.push({
          station: i.station,
          rec: {
            pts_id: t.pts_id,
            occurred_at: t.ended_at,
            device_type: 'pump',
            device_no: t.pump_no,
            code: 'TotalizerMismatch',
            severity: 'critical',
            message: `Pump ${t.pump_no} nozzle ${t.nozzle_no}: ${unaccounted} L dispensed without a recorded sale`,
            data: {
              expected,
              actual,
              unaccounted_l: unaccounted,
              previous_total_l: prev,
              nozzle_no: t.nozzle_no,
              pts_transaction_no: t.pts_transaction_no,
              product_code:
                (t.pts_grade_id !== null ? i.station.grades.get(t.pts_grade_id) : undefined) ?? null,
            },
          },
        });
      }
    }
  }

  // ---------------------------------------------------------------- tank measurements
  private async tankMeasurements(items: Array<PersistItem & { rec: { kind: 'tank_measurement'; data: TankMeasurementRecord } }>) {
    if (!items.length) return;
    const key = (st: string, tank: number, at: string) => `${st}|${tank}|${at}`;
    const { uniq, dupOf } = dedupe(items, (i) => key(i.station.id, i.rec.data.tank_no, i.rec.data.measured_at));
    const rows = uniq.map((i) => {
      const m = i.rec.data;
      return {
        station_id: i.station.id,
        tank_no: m.tank_no,
        measured_at: m.measured_at,
        product_code: i.station.tanks.get(m.tank_no)?.product_code ?? null,
        probe_status: m.probe_status,
        alarms: m.alarms,
        product_height_mm: m.product_height_mm,
        water_height_mm: m.water_height_mm,
        temperature_c: m.temperature_c,
        product_volume_l: m.product_volume_l,
        water_volume_l: m.water_volume_l,
        ullage_l: m.ullage_l,
        tc_volume_l: m.tc_volume_l,
        density_kg_m3: m.density_kg_m3,
        mass_kg: m.mass_kg,
      };
    });
    const res = await this.c.query<{ station_id: string; tank_no: number; measured_at: Date }>(
      `INSERT INTO fms.tank_measurements
         (station_id, tank_no, measured_at, product_code, probe_status, alarms, product_height_mm, water_height_mm,
          temperature_c, product_volume_l, water_volume_l, ullage_l, tc_volume_l, density_kg_m3, mass_kg)
       SELECT r.station_id, r.tank_no, r.measured_at, r.product_code, r.probe_status, r.alarms, r.product_height_mm,
              r.water_height_mm, r.temperature_c, r.product_volume_l, r.water_volume_l, r.ullage_l, r.tc_volume_l,
              r.density_kg_m3, r.mass_kg
         FROM json_to_recordset($1::json) AS r(
              station_id uuid, tank_no int, measured_at timestamptz, product_code text, probe_status text, alarms text[],
              product_height_mm numeric, water_height_mm numeric, temperature_c numeric, product_volume_l numeric,
              water_volume_l numeric, ullage_l numeric, tc_volume_l numeric, density_kg_m3 numeric, mass_kg numeric)
       ON CONFLICT DO NOTHING
       RETURNING station_id, tank_no, measured_at`,
      [JSON.stringify(rows)],
    );
    const inserted = new Set(res.rows.map((r) => key(r.station_id, r.tank_no, ms(r.measured_at))));
    const fresh: Array<{ item: (typeof uniq)[number]; row: (typeof rows)[number] }> = [];
    uniq.forEach((i, idx) => {
      const isNew = inserted.has(key(i.station.id, i.rec.data.tank_no, i.rec.data.measured_at));
      this.outcome.set(i.key, isNew ? 'inserted' : 'duplicate');
      if (isNew) fresh.push({ item: i, row: rows[idx]! });
    });
    for (const [dup] of dupOf) this.outcome.set(dup.key, 'duplicate');
    if (!fresh.length) return;

    // Rollups: the measurement sets that day's closing stock and the next day's opening stock.
    for (const f of fresh) {
      const st = f.item.station;
      this.addRollup(st, f.row.measured_at);
      const nextDay = new Date(Date.parse(f.row.measured_at) + 24 * 3600 * 1000).toISOString();
      if (localDate(nextDay, st.timezone) <= localDate(new Date(), st.timezone)) this.addRollup(st, nextDay);
    }

    // Group per tank (ascending time) and fetch the current tank_latest rows.
    const groups = new Map<string, typeof fresh>();
    for (const f of fresh) {
      const k = `${f.row.station_id}|${f.row.tank_no}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push(f);
    }
    for (const g of groups.values()) g.sort((a, b) => a.row.measured_at.localeCompare(b.row.measured_at));
    const tanks = [...groups.values()].map((g) => ({ station_id: g[0]!.row.station_id, tank_no: g[0]!.row.tank_no }));
    const oldRes = await this.c.query<{ station_id: string; tank_no: number; measured_at: Date; product_volume_l: number | null; alarms: string[] | null }>(
      `SELECT tl.station_id, tl.tank_no, tl.measured_at, tl.product_volume_l, tl.alarms
         FROM fms.tank_latest tl
         JOIN json_to_recordset($1::json) AS r(station_id uuid, tank_no int)
           ON tl.station_id = r.station_id AND tl.tank_no = r.tank_no`,
      [JSON.stringify(tanks)],
    );
    const old = new Map(oldRes.rows.map((r) => [`${r.station_id}|${r.tank_no}`, r]));

    const latest: Array<(typeof rows)[number]> = [];
    for (const [k, g] of groups) {
      const prev = old.get(k);
      const st = g[0]!.item.station;
      // Alarm onset: raise an alert only when a flag appears that the previous reading did not have.
      let prevAlarms = new Set(prev?.alarms ?? []);
      for (const f of g) {
        for (const a of alarmsToAlerts(f.item.rec.data)) {
          if (!prevAlarms.has(a.code)) this.alerts.push({ station: st, rec: a });
        }
        prevAlarms = new Set(f.item.rec.data.alarms);
      }
      const newest = g[g.length - 1]!.row;
      const isNewer = !prev || prev.measured_at.getTime() < Date.parse(newest.measured_at);
      if (!isNewer) continue;
      latest.push(newest);
      // Low stock: crossing from >= low_level_l (or unknown) to below it.
      const tank = st.tanks.get(newest.tank_no);
      const low = tank?.low_level_l ?? null;
      const vol = newest.product_volume_l;
      const prevVol = prev?.product_volume_l === null || prev?.product_volume_l === undefined ? null : Number(prev.product_volume_l);
      if (low !== null && vol !== null && vol < low && (prevVol === null || prevVol >= low)) {
        this.alerts.push({
          station: st,
          webhookEvent: 'stock_low',
          rec: {
            pts_id: g[0]!.item.rec.data.pts_id,
            occurred_at: newest.measured_at,
            device_type: 'tank',
            device_no: newest.tank_no,
            code: 'LowStock',
            severity: 'warning',
            message: `Tank ${newest.tank_no} (${tank?.product_code ?? '?'}) below reorder level: ${vol} L < ${low} L`,
            data: {
              tank_no: newest.tank_no,
              product_code: tank?.product_code ?? null,
              product_volume_l: vol,
              low_level_l: low,
              capacity_l: tank?.capacity_l ?? null,
              previous_volume_l: prevVol,
            },
          },
        });
      }
    }
    if (!latest.length) return;
    latest.sort((a, b) => (a.station_id + a.tank_no).localeCompare(b.station_id + b.tank_no)); // stable lock order
    await this.c.query(
      `INSERT INTO fms.tank_latest AS tl
         (station_id, tank_no, measured_at, product_code, probe_status, alarms, product_height_mm, water_height_mm,
          temperature_c, product_volume_l, water_volume_l, ullage_l, tc_volume_l)
       SELECT r.station_id, r.tank_no, r.measured_at, r.product_code, r.probe_status, r.alarms, r.product_height_mm,
              r.water_height_mm, r.temperature_c, r.product_volume_l, r.water_volume_l, r.ullage_l, r.tc_volume_l
         FROM json_to_recordset($1::json) AS r(
              station_id uuid, tank_no int, measured_at timestamptz, product_code text, probe_status text, alarms text[],
              product_height_mm numeric, water_height_mm numeric, temperature_c numeric, product_volume_l numeric,
              water_volume_l numeric, ullage_l numeric, tc_volume_l numeric)
       ON CONFLICT (station_id, tank_no) DO UPDATE SET
              measured_at = EXCLUDED.measured_at, product_code = EXCLUDED.product_code,
              probe_status = EXCLUDED.probe_status, alarms = EXCLUDED.alarms,
              product_height_mm = EXCLUDED.product_height_mm, water_height_mm = EXCLUDED.water_height_mm,
              temperature_c = EXCLUDED.temperature_c, product_volume_l = EXCLUDED.product_volume_l,
              water_volume_l = EXCLUDED.water_volume_l, ullage_l = EXCLUDED.ullage_l, tc_volume_l = EXCLUDED.tc_volume_l
        WHERE tl.measured_at < EXCLUDED.measured_at`,
      [JSON.stringify(latest)],
    );
  }

  // ---------------------------------------------------------------- deliveries
  private async tankDeliveries(items: Array<PersistItem & { rec: { kind: 'tank_delivery'; data: TankDeliveryRecord } }>) {
    if (!items.length) return;
    const key = (st: string, tank: number, at: string) => `${st}|${tank}|${at}`;
    const { uniq, dupOf } = dedupe(items, (i) => key(i.station.id, i.rec.data.tank_no, i.rec.data.started_at));
    const rows = uniq.map((i) => {
      const d = i.rec.data;
      return {
        station_id: i.station.id,
        tank_no: d.tank_no,
        product_code: i.station.tanks.get(d.tank_no)?.product_code ?? null,
        started_at: d.started_at,
        ended_at: d.ended_at,
        start_volume_l: d.start_volume_l,
        end_volume_l: d.end_volume_l,
        start_tc_volume_l: d.start_tc_volume_l,
        end_tc_volume_l: d.end_tc_volume_l,
        start_height_mm: d.start_height_mm,
        end_height_mm: d.end_height_mm,
        start_water_mm: d.start_water_mm,
        end_water_mm: d.end_water_mm,
        start_temperature_c: d.start_temperature_c,
        end_temperature_c: d.end_temperature_c,
        start_density_kg_m3: d.start_density_kg_m3,
        end_density_kg_m3: d.end_density_kg_m3,
      };
    });
    const res = await this.c.query<{ station_id: string; tank_no: number; started_at: Date }>(
      `INSERT INTO fms.tank_deliveries
         (station_id, tank_no, product_code, started_at, ended_at, start_volume_l, end_volume_l, start_tc_volume_l,
          end_tc_volume_l, start_height_mm, end_height_mm, start_water_mm, end_water_mm, start_temperature_c,
          end_temperature_c, start_density_kg_m3, end_density_kg_m3)
       SELECT r.station_id, r.tank_no, r.product_code, r.started_at, r.ended_at, r.start_volume_l, r.end_volume_l,
              r.start_tc_volume_l, r.end_tc_volume_l, r.start_height_mm, r.end_height_mm, r.start_water_mm, r.end_water_mm,
              r.start_temperature_c, r.end_temperature_c, r.start_density_kg_m3, r.end_density_kg_m3
         FROM json_to_recordset($1::json) AS r(
              station_id uuid, tank_no int, product_code text, started_at timestamptz, ended_at timestamptz,
              start_volume_l numeric, end_volume_l numeric, start_tc_volume_l numeric, end_tc_volume_l numeric,
              start_height_mm numeric, end_height_mm numeric, start_water_mm numeric, end_water_mm numeric,
              start_temperature_c numeric, end_temperature_c numeric, start_density_kg_m3 numeric, end_density_kg_m3 numeric)
       ON CONFLICT DO NOTHING
       RETURNING station_id, tank_no, started_at`,
      [JSON.stringify(rows)],
    );
    const inserted = new Set(res.rows.map((r) => key(r.station_id, r.tank_no, ms(r.started_at))));
    for (const i of uniq) {
      const isNew = inserted.has(key(i.station.id, i.rec.data.tank_no, i.rec.data.started_at));
      this.outcome.set(i.key, isNew ? 'inserted' : 'duplicate');
      if (isNew) this.addRollup(i.station, i.rec.data.ended_at);
    }
    for (const [dup] of dupOf) this.outcome.set(dup.key, 'duplicate');
  }

  // ---------------------------------------------------------------- alerts
  private async insertAlerts() {
    if (!this.alerts.length) return;
    const key = (st: string, at: string, dt: string, dn: number | null, code: string) => `${st}|${at}|${dt}|${dn ?? ''}|${code}`;
    const { uniq, dupOf } = dedupe(this.alerts, (a) =>
      key(a.station.id, ms(a.rec.occurred_at), a.rec.device_type, a.rec.device_no, a.rec.code),
    );
    const rows = uniq.map((a) => ({
      station_id: a.station.id,
      occurred_at: ms(a.rec.occurred_at),
      device_type: a.rec.device_type,
      device_no: a.rec.device_no,
      code: a.rec.code,
      severity: a.rec.severity,
      message: a.rec.message,
      data: a.rec.data ?? null,
    }));
    // NOT EXISTS covers device_no IS NULL, which the UNIQUE constraint treats as distinct.
    const res = await this.c.query<{ id: number; station_id: string; occurred_at: Date; device_type: string; device_no: number | null; code: string }>(
      `INSERT INTO fms.alerts (station_id, occurred_at, device_type, device_no, code, severity, message, data)
       SELECT r.station_id, r.occurred_at, r.device_type, r.device_no, r.code, r.severity, r.message, r.data
         FROM json_to_recordset($1::json) AS r(
              station_id uuid, occurred_at timestamptz, device_type text, device_no int, code text,
              severity text, message text, data jsonb)
        WHERE NOT EXISTS (SELECT 1 FROM fms.alerts a
                           WHERE a.station_id = r.station_id AND a.occurred_at = r.occurred_at
                             AND a.device_type = r.device_type AND a.device_no IS NOT DISTINCT FROM r.device_no
                             AND a.code = r.code)
       ON CONFLICT DO NOTHING
       RETURNING id, station_id, occurred_at, device_type, device_no, code`,
      [JSON.stringify(rows)],
    );
    const ids = new Map(res.rows.map((r) => [key(r.station_id, ms(r.occurred_at), r.device_type, r.device_no, r.code), r.id]));
    for (const a of uniq) {
      const id = ids.get(key(a.station.id, ms(a.rec.occurred_at), a.rec.device_type, a.rec.device_no, a.rec.code));
      if (a.key !== undefined) this.outcome.set(a.key, id !== undefined ? 'inserted' : 'duplicate');
      if (id === undefined) continue;
      this.raised.push({ id, code: a.rec.code, severity: a.rec.severity });
      const st = a.station;
      const alert = {
        id,
        station_id: st.id,
        station_code: st.code,
        occurred_at: ms(a.rec.occurred_at),
        device_type: a.rec.device_type,
        device_no: a.rec.device_no,
        code: a.rec.code,
        severity: a.rec.severity,
        message: a.rec.message,
        data: a.rec.data ?? null,
      };
      const base = { station_id: st.id, station_code: st.code, province_id: st.province_id, company_id: st.company_id };
      if (a.rec.severity === 'critical') {
        this.jobs.push({ kind: 'notify', dedupe_key: `notify:alert:${id}`, payload: { ...base, alert_id: id, alert } });
        this.jobs.push({
          kind: 'webhook',
          dedupe_key: `webhook:critical_alert:${id}`,
          payload: { ...base, event: 'critical_alert', alert_id: id, data: alert },
        });
      }
      if (a.webhookEvent) {
        this.jobs.push({
          kind: 'webhook',
          dedupe_key: `webhook:${a.webhookEvent}:${id}`,
          payload: { ...base, event: a.webhookEvent, alert_id: id, data: alert },
        });
      }
    }
    for (const [dup] of dupOf) if (dup.key !== undefined) this.outcome.set(dup.key, 'duplicate');
  }

  // ---------------------------------------------------------------- status / heartbeat
  private async statuses(items: Array<PersistItem & { rec: { kind: 'status'; data: StatusRecord } }>) {
    const latest = new Map<string, StatusRecord>();
    for (const i of items) {
      const cur = latest.get(i.rec.data.pts_id);
      if (!cur || cur.reported_at <= i.rec.data.reported_at) latest.set(i.rec.data.pts_id, i.rec.data);
      this.outcome.set(i.key, 'inserted');
    }
    const touch = new Set(this.ctx.touchControllers ?? []);
    for (const k of latest.keys()) touch.delete(k);
    const rows = [
      ...[...latest.values()].map((s) => ({ pts_id: s.pts_id, status: s.status })),
      ...[...touch].map((p) => ({ pts_id: p, status: null })),
    ].sort((a, b) => a.pts_id.localeCompare(b.pts_id));
    if (!rows.length) return;
    await this.c.query(
      `UPDATE fms.controllers c
          SET last_seen_at = now(), last_status = coalesce(r.status, c.last_status)
         FROM json_to_recordset($1::json) AS r(pts_id text, status jsonb)
        WHERE c.pts_id = r.pts_id`,
      [JSON.stringify(rows)],
    );
  }

  private async heartbeats(items: Array<PersistItem & { rec: { kind: 'heartbeat'; data: GatewayHeartbeatRecord } }>) {
    if (!this.ctx.gatewayId) {
      for (const i of items) this.outcome.set(i.key, 'ignored');
      return;
    }
    const hb = items.length ? items[items.length - 1]!.rec.data : null;
    for (const i of items) this.outcome.set(i.key, 'inserted');
    // Any authenticated batch proves the gateway is alive; heartbeats also carry backlog/version.
    await this.c.query(
      `UPDATE fms.edge_gateways
          SET last_seen_at = now(),
              last_backlog = coalesce($2::int, last_backlog),
              version = coalesce($3::text, version)
        WHERE id = $1`,
      [this.ctx.gatewayId, hb?.backlog ?? null, hb?.gateway_version ?? null],
    );
  }

  // ---------------------------------------------------------------- fiscal receipts
  private async fiscalReceipts(items: Array<PersistItem & { rec: { kind: 'fiscal_receipt'; data: FiscalReceiptRecord } }>) {
    if (!items.length) return;
    const key = (st: string, pump: number, txno: number, at: string) => `${st}|${pump}|${txno}|${at}`;
    // Last one wins within a batch (later outbox entries carry the more advanced status).
    const lastByKey = new Map<string, (typeof items)[number]>();
    for (const i of items) lastByKey.set(key(i.station.id, i.rec.data.pump_no, i.rec.data.pts_transaction_no, i.rec.data.tx_ended_at), i);
    const uniq = [...lastByKey.values()];
    const rows = uniq.map((i) => ({ station_id: i.station.id, ...i.rec.data }));
    const res = await this.c.query<{ station_id: string; pump_no: number; pts_transaction_no: number; tx_ended_at: Date; status: string; inserted: boolean }>(
      `INSERT INTO fms.fiscal_receipts AS f
         (station_id, pump_no, pts_transaction_no, tx_ended_at, invoice_no, status, fiscalised_by, zra_rcpt_no,
          zra_tot_rcpt_no, zra_internal_data, zra_signature, zra_sdc_id, zra_mrc_no, zra_qr_url, zra_signed_at,
          printed_at, attempts, last_error)
       SELECT r.station_id, r.pump_no, r.pts_transaction_no, r.tx_ended_at, r.invoice_no, r.status, 'edge', r.zra_rcpt_no,
              r.zra_tot_rcpt_no, r.zra_internal_data, r.zra_signature, r.zra_sdc_id, r.zra_mrc_no, r.zra_qr_url,
              r.zra_signed_at, r.printed_at, r.attempts, r.last_error
         FROM json_to_recordset($1::json) AS r(
              station_id uuid, pump_no int, pts_transaction_no int, tx_ended_at timestamptz, invoice_no text, status text,
              zra_rcpt_no text, zra_tot_rcpt_no text, zra_internal_data text, zra_signature text, zra_sdc_id text,
              zra_mrc_no text, zra_qr_url text, zra_signed_at timestamptz, printed_at timestamptz, attempts int,
              last_error text)
        ORDER BY r.station_id, r.pump_no, r.pts_transaction_no, r.tx_ended_at
       ON CONFLICT (station_id, pump_no, pts_transaction_no, tx_ended_at) DO UPDATE SET
              invoice_no = EXCLUDED.invoice_no, status = EXCLUDED.status,
              zra_rcpt_no = coalesce(EXCLUDED.zra_rcpt_no, f.zra_rcpt_no),
              zra_tot_rcpt_no = coalesce(EXCLUDED.zra_tot_rcpt_no, f.zra_tot_rcpt_no),
              zra_internal_data = coalesce(EXCLUDED.zra_internal_data, f.zra_internal_data),
              zra_signature = coalesce(EXCLUDED.zra_signature, f.zra_signature),
              zra_sdc_id = coalesce(EXCLUDED.zra_sdc_id, f.zra_sdc_id),
              zra_mrc_no = coalesce(EXCLUDED.zra_mrc_no, f.zra_mrc_no),
              zra_qr_url = coalesce(EXCLUDED.zra_qr_url, f.zra_qr_url),
              zra_signed_at = coalesce(EXCLUDED.zra_signed_at, f.zra_signed_at),
              printed_at = coalesce(EXCLUDED.printed_at, f.printed_at),
              attempts = greatest(EXCLUDED.attempts, f.attempts),
              last_error = EXCLUDED.last_error
        -- never regress a signed/printed receipt because an older outbox entry was resent
        WHERE NOT (f.status IN ('signed','printed') AND EXCLUDED.status IN ('pending','failed'))
          AND NOT (f.status = 'printed' AND EXCLUDED.status = 'signed')
       RETURNING station_id, pump_no, pts_transaction_no, tx_ended_at, status, (xmax = 0) AS inserted`,
      [JSON.stringify(rows)],
    );
    const changed = new Map(res.rows.map((r) => [key(r.station_id, r.pump_no, r.pts_transaction_no, ms(r.tx_ended_at)), r]));
    for (const i of items) {
      const r = changed.get(key(i.station.id, i.rec.data.pump_no, i.rec.data.pts_transaction_no, i.rec.data.tx_ended_at));
      this.outcome.set(i.key, r?.inserted ? 'inserted' : 'duplicate');
    }
    const upd = res.rows
      .filter((r) => r.status !== 'pending')
      .map((r) => ({ station_id: r.station_id, pump_no: r.pump_no, pts_transaction_no: r.pts_transaction_no, ended_at: ms(r.tx_ended_at), status: r.status }));
    if (!upd.length) return;
    await this.c.query(
      `UPDATE fms.pump_transactions t
          SET fiscal_status = CASE WHEN r.status IN ('signed','printed') THEN 'signed' ELSE 'failed' END
         FROM json_to_recordset($1::json) AS r(station_id uuid, pump_no int, pts_transaction_no int, ended_at timestamptz, status text)
        WHERE t.station_id = r.station_id AND t.pump_no = r.pump_no AND t.pts_transaction_no = r.pts_transaction_no
          AND t.ended_at = r.ended_at AND t.fiscal_status NOT IN ('signed','exempt')`,
      [JSON.stringify(upd)],
    );
  }

  // ---------------------------------------------------------------- jobs
  private async insertJobs() {
    if (!this.jobs.length) return;
    const rows = [...this.jobs].sort((a, b) => a.dedupe_key.localeCompare(b.dedupe_key));
    await this.c.query(
      `INSERT INTO fms.jobs (kind, payload, dedupe_key)
       SELECT r.kind, r.payload, r.dedupe_key
         FROM json_to_recordset($1::json) AS r(kind text, payload jsonb, dedupe_key text)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [JSON.stringify(rows)],
    );
  }

  /**
   * jobs.dedupe_key is unique forever, so a finished rollup is re-armed (debounced) instead of inserted again.
   * A rollup currently 'running' is left alone (see README: lost-update window).
   */
  private async enqueueRollups() {
    if (!this.rollups.size) return;
    const rows = [...this.rollups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dedupe_key, p]) => ({ dedupe_key, payload: p }));
    await this.c.query(
      `INSERT INTO fms.jobs AS j (kind, payload, dedupe_key, run_at)
       SELECT 'rollup', r.payload, r.dedupe_key, now() + make_interval(secs => $2::int)
         FROM json_to_recordset($1::json) AS r(dedupe_key text, payload jsonb)
       ON CONFLICT (dedupe_key) DO UPDATE
          SET status = 'queued', run_at = now() + make_interval(secs => $2::int), attempts = 0,
              locked_by = NULL, locked_at = NULL, last_error = NULL
        WHERE j.status IN ('done','dead')`,
      [JSON.stringify(rows), this.ctx.rollupDelayS],
    );
  }
}

/** Deliver queued edge commands for a station (jobs kind 'edge_command'); marks them done (at-least-once). */
export async function takeEdgeCommands(c: Tx, stationId: string, gatewayCode: string, limit: number) {
  if (limit <= 0) return [];
  const res = await c.query<{ id: number; payload: { station_id: string; command: Record<string, unknown> } }>(
    `WITH picked AS (
        SELECT id FROM fms.jobs
         WHERE kind = 'edge_command' AND status = 'queued' AND run_at <= now()
           AND payload->>'station_id' = $1
         ORDER BY id
         LIMIT $2
         FOR UPDATE SKIP LOCKED)
     UPDATE fms.jobs j
        SET status = 'done', locked_by = $3, locked_at = now(), attempts = j.attempts + 1
       FROM picked WHERE j.id = picked.id
     RETURNING j.id, j.payload`,
    [stationId, limit, `ingest:${gatewayCode}`],
  );
  return res.rows
    .sort((a, b) => a.id - b.id)
    .map((r) => ({ ...(r.payload.command ?? {}), id: String(r.payload.command?.id ?? r.id) }));
}
