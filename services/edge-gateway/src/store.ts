/**
 * Local store writes. Every telemetry record is written to its table AND to the outbox in the same
 * database transaction, so a record is either fully stored-and-queued-for-cloud or not at all.
 */
import {
  alarmsToAlerts,
  type AlertRecord,
  type FiscalReceiptRecord,
  type PumpTransactionRecord,
  type TelemetryRecord,
} from '@fms/shared';
import type { PoolClient } from './db.js';
import { invoiceNo } from './fiscal/invoice.js';

export async function enqueueOutbox(c: PoolClient, rec: TelemetryRecord): Promise<number> {
  const r = await c.query<{ seq: number }>('INSERT INTO edge.outbox(kind, data) VALUES ($1, $2) RETURNING seq', [rec.kind, JSON.stringify(rec.data)]);
  return r.rows[0].seq;
}

export interface PersistResult {
  /** false when the record already existed (idempotent resubmission). */
  inserted: boolean;
  transactionId?: number;
  fiscalReceiptId?: number;
}

export interface PersistContext {
  stationCode: string;
  statusSyncMs: number;
}

/** Insert an alert (idempotent on natural key). Returns true if new. */
export async function insertAlert(c: PoolClient, a: AlertRecord, source: 'pts' | 'tank_alarm' | 'gateway', outbox: boolean): Promise<boolean> {
  const r = await c.query(
    `INSERT INTO edge.alerts (pts_id, occurred_at, device_type, device_no, code, severity, message, source, record)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
    [a.pts_id, a.occurred_at, a.device_type, a.device_no, a.code, a.severity, a.message, source, JSON.stringify(a)],
  );
  const inserted = (r.rowCount ?? 0) > 0;
  if (inserted && outbox) await enqueueOutbox(c, { kind: 'alert', data: a });
  return inserted;
}

export interface FiscalRowForRecord {
  invoice_no: string;
  status: FiscalReceiptRecord['status'];
  zra_rcpt_no: string | null;
  zra_tot_rcpt_no: string | null;
  zra_internal_data: string | null;
  zra_signature: string | null;
  zra_sdc_id: string | null;
  zra_mrc_no: string | null;
  zra_qr_url: string | null;
  zra_signed_at: Date | string | null;
  printed_at: Date | string | null;
  attempts: number;
  last_error: string | null;
  pump_no: number;
  pts_transaction_no: number;
  ended_at: Date | string;
}

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

export function toFiscalRecord(r: FiscalRowForRecord): FiscalReceiptRecord {
  return {
    pump_no: r.pump_no,
    pts_transaction_no: r.pts_transaction_no,
    tx_ended_at: iso(r.ended_at)!,
    invoice_no: r.invoice_no,
    status: r.status,
    zra_rcpt_no: r.zra_rcpt_no,
    zra_tot_rcpt_no: r.zra_tot_rcpt_no,
    zra_internal_data: r.zra_internal_data,
    zra_signature: r.zra_signature,
    zra_sdc_id: r.zra_sdc_id,
    zra_mrc_no: r.zra_mrc_no,
    zra_qr_url: r.zra_qr_url,
    zra_signed_at: iso(r.zra_signed_at),
    printed_at: iso(r.printed_at),
    attempts: r.attempts,
    last_error: r.last_error,
  };
}

export const FISCAL_RECORD_SQL = `
  SELECT f.invoice_no, f.status, f.zra_rcpt_no, f.zra_tot_rcpt_no, f.zra_internal_data, f.zra_signature,
         f.zra_sdc_id, f.zra_mrc_no, f.zra_qr_url, f.zra_signed_at, f.printed_at, f.attempts, f.last_error,
         t.pump_no, t.pts_transaction_no, t.ended_at
    FROM edge.fiscal_receipts f JOIN edge.transactions t ON t.id = f.transaction_id
   WHERE f.id = $1`;

/** Queue the current state of a fiscal receipt for the cloud (call after every state change). */
export async function outboxFiscalReceipt(c: PoolClient, receiptId: number): Promise<void> {
  const r = await c.query<FiscalRowForRecord>(FISCAL_RECORD_SQL, [receiptId]);
  if (r.rows[0]) await enqueueOutbox(c, { kind: 'fiscal_receipt', data: toFiscalRecord(r.rows[0]) });
}

async function persistPumpTransaction(c: PoolClient, t: PumpTransactionRecord, ctx: PersistContext): Promise<PersistResult> {
  // Totaliser continuity on the previous sale of the same nozzle (local alert, cloud also checks).
  const prev = await c.query<{ total_volume_l: number | null }>(
    `SELECT total_volume_l FROM edge.transactions WHERE pts_id=$1 AND pump_no=$2 AND nozzle_no=$3 AND ended_at < $4
      ORDER BY ended_at DESC LIMIT 1`,
    [t.pts_id, t.pump_no, t.nozzle_no, t.ended_at],
  );
  const exempt = !(t.volume_l > 0);
  const ins = await c.query<{ id: number }>(
    `INSERT INTO edge.transactions (pts_id, pump_no, nozzle_no, pts_transaction_no, pts_grade_id, grade_name, started_at, ended_at,
        volume_l, tc_volume_l, price, amount, total_volume_l, total_amount, tag, pts_user_id, fiscal_status, record)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (pts_id, pump_no, pts_transaction_no, ended_at) DO NOTHING RETURNING id`,
    [t.pts_id, t.pump_no, t.nozzle_no, t.pts_transaction_no, t.pts_grade_id, t.grade_name, t.started_at, t.ended_at,
      t.volume_l, t.tc_volume_l, t.price, t.amount, t.total_volume_l, t.total_amount, t.tag, t.pts_user_id,
      exempt ? 'exempt' : 'pending', JSON.stringify(t)],
  );
  if (!ins.rows[0]) return { inserted: false };
  const transactionId = ins.rows[0].id;
  await enqueueOutbox(c, { kind: 'pump_transaction', data: t });

  const pv = prev.rows[0]?.total_volume_l;
  if (pv != null && t.total_volume_l != null && pv + t.volume_l < t.total_volume_l - 0.5) {
    const gap = Math.round((t.total_volume_l - pv - t.volume_l) * 100) / 100;
    await insertAlert(c, {
      pts_id: t.pts_id, occurred_at: t.ended_at, device_type: 'pump', device_no: t.pump_no, code: 'TotalizerMismatch',
      severity: 'critical', message: `Pump ${t.pump_no} nozzle ${t.nozzle_no}: totaliser advanced ${gap} L more than registered sales (possible manual-mode dispensing)`,
      data: { nozzle_no: t.nozzle_no, previous_total_l: pv, total_l: t.total_volume_l, volume_l: t.volume_l, gap_l: gap },
    }, 'gateway', false); // cloud ingest raises its own TotalizerMismatch from the transaction stream
  }

  if (exempt) return { inserted: true, transactionId };
  const inv = invoiceNo(ctx.stationCode, t.pump_no, t.pts_transaction_no, t.ended_at);
  const fr = await c.query<{ id: number }>(
    `INSERT INTO edge.fiscal_receipts (transaction_id, invoice_no, status) VALUES ($1, $2, 'pending')
     ON CONFLICT (invoice_no) DO NOTHING RETURNING id`,
    [transactionId, inv],
  );
  if (fr.rows[0]) {
    await outboxFiscalReceipt(c, fr.rows[0].id);
    return { inserted: true, transactionId, fiscalReceiptId: fr.rows[0].id };
  }
  return { inserted: true, transactionId };
}

/** Persist one normalised record + outbox entry. Caller provides the transaction. */
export async function persistRecord(c: PoolClient, rec: TelemetryRecord, ctx: PersistContext): Promise<PersistResult> {
  switch (rec.kind) {
    case 'pump_transaction':
      return persistPumpTransaction(c, rec.data, ctx);
    case 'tank_measurement': {
      const m = rec.data;
      const ins = await c.query(
        `INSERT INTO edge.tank_measurements (pts_id, tank_no, measured_at, pts_grade_id, probe_status, alarms, product_height_mm,
            water_height_mm, temperature_c, product_volume_l, water_volume_l, ullage_l, tc_volume_l, density_kg_m3, mass_kg, record)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (pts_id, tank_no, measured_at) DO NOTHING RETURNING id`,
        [m.pts_id, m.tank_no, m.measured_at, m.pts_grade_id, m.probe_status, m.alarms, m.product_height_mm, m.water_height_mm,
          m.temperature_c, m.product_volume_l, m.water_volume_l, m.ullage_l, m.tc_volume_l, m.density_kg_m3, m.mass_kg, JSON.stringify(m)],
      );
      if (!ins.rowCount) return { inserted: false };
      await c.query(
        `INSERT INTO edge.tank_latest (pts_id, tank_no, measured_at, pts_grade_id, probe_status, alarms, product_height_mm,
            water_height_mm, temperature_c, product_volume_l, ullage_l)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (pts_id, tank_no) DO UPDATE SET measured_at=EXCLUDED.measured_at, pts_grade_id=EXCLUDED.pts_grade_id,
            probe_status=EXCLUDED.probe_status, alarms=EXCLUDED.alarms, product_height_mm=EXCLUDED.product_height_mm,
            water_height_mm=EXCLUDED.water_height_mm, temperature_c=EXCLUDED.temperature_c,
            product_volume_l=EXCLUDED.product_volume_l, ullage_l=EXCLUDED.ullage_l
         WHERE edge.tank_latest.measured_at < EXCLUDED.measured_at`,
        [m.pts_id, m.tank_no, m.measured_at, m.pts_grade_id, m.probe_status, m.alarms, m.product_height_mm, m.water_height_mm,
          m.temperature_c, m.product_volume_l, m.ullage_l],
      );
      // Local copy of alarm alerts; the cloud derives the same alerts from the measurement (alarmsToAlerts).
      for (const a of alarmsToAlerts(m)) await insertAlert(c, a, 'tank_alarm', false);
      await enqueueOutbox(c, rec);
      return { inserted: true };
    }
    case 'tank_delivery': {
      const d = rec.data;
      const ins = await c.query(
        `INSERT INTO edge.deliveries (pts_id, tank_no, started_at, ended_at, start_volume_l, end_volume_l, record)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (pts_id, tank_no, started_at) DO NOTHING RETURNING id`,
        [d.pts_id, d.tank_no, d.started_at, d.ended_at, d.start_volume_l, d.end_volume_l, JSON.stringify(d)],
      );
      if (!ins.rowCount) return { inserted: false };
      await enqueueOutbox(c, rec);
      return { inserted: true };
    }
    case 'alert':
      return { inserted: await insertAlert(c, rec.data, 'pts', true) };
    case 'status': {
      // PTS-2 sends status every second: keep the latest locally, forward at most every statusSyncMs.
      const s = rec.data;
      const r = await c.query<{ forward: boolean }>(
        `INSERT INTO edge.controllers (pts_id, last_seen_at, last_status, last_status_at)
         VALUES ($1, now(), $2, now())
         ON CONFLICT (pts_id) DO UPDATE SET last_seen_at = now(), last_status = EXCLUDED.last_status, last_status_at = now()
         RETURNING (last_status_synced_at IS NULL OR last_status_synced_at < now() - make_interval(secs => $3::double precision / 1000)) AS forward`,
        [s.pts_id, JSON.stringify(s.status), ctx.statusSyncMs],
      );
      if (r.rows[0]?.forward) {
        await c.query('UPDATE edge.controllers SET last_status_synced_at = now() WHERE pts_id = $1', [s.pts_id]);
        await enqueueOutbox(c, rec);
      }
      return { inserted: true };
    }
    case 'fiscal_receipt':
    case 'heartbeat':
      await enqueueOutbox(c, rec);
      return { inserted: true };
  }
}
