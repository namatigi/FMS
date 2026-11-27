/**
 * Request-level orchestration: auth, normalisation/validation, one-transaction persistence,
 * per-item fallback when the set-based transaction fails on a single bad row.
 */
import {
  JsonPtsMappingError,
  jsonPtsReply,
  normalizeJsonPtsPacket,
  type EdgeBatchResponse,
  type EdgeCommand,
  type JsonPtsPacket,
  type JsonPtsResponse,
  type TelemetryRecord,
} from '@fms/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import { isTransientDbError, withTx, type Db, type Tx } from './db.js';
import type { Metrics } from './metrics.js';
import { Persister, takeEdgeCommands, type Outcome, type PersistCtx, type PersistItem } from './persist.js';
import type { GatewayRef, RefData, StationRef } from './refdata.js';
import { RecordValidationError, recordPtsId, validateRecord } from './validate.js';

export class TransientError extends Error {}

interface Deps {
  cfg: Config;
  db: Db;
  ref: RefData;
  metrics: Metrics;
  log: FastifyBaseLogger;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Persist items in one transaction (plus `extra` work in the same transaction). If the set-based
 * statement fails for a non-transient reason (one bad row poisons the whole statement), each item
 * is retried in its own transaction so only the culprit is rejected.
 */
async function persistWithFallback<E>(
  d: Deps,
  ctx: PersistCtx,
  items: PersistItem[],
  extra: (c: Tx, items: PersistItem[]) => Promise<E>,
  extraSingle: (c: Tx, item: PersistItem) => Promise<void>,
): Promise<{ outcome: Map<number, Outcome>; failed: Map<number, { error: string; retryable: boolean }>; extra: E | null }> {
  const failed = new Map<number, { error: string; retryable: boolean }>();
  try {
    const out = await withTx(d.db, async (c) => {
      const r = await new Persister(c, ctx).run(items);
      const e = await extra(c, items);
      return { r, e };
    });
    countAlerts(d, out.r.alerts);
    return { outcome: out.r.outcome, failed, extra: out.e };
  } catch (err) {
    if (isTransientDbError(err)) throw new TransientError(errMsg(err));
    d.log.warn({ err: errMsg(err), items: items.length }, 'batch transaction failed, falling back to per-record');
  }
  const outcome = new Map<number, Outcome>();
  for (const it of items) {
    try {
      const r = await withTx(d.db, async (c) => {
        const res = await new Persister(c, ctx).run([it]);
        await extraSingle(c, it);
        return res;
      });
      countAlerts(d, r.alerts);
      outcome.set(it.key, r.outcome.get(it.key) ?? 'ignored');
    } catch (err) {
      const transient = isTransientDbError(err);
      failed.set(it.key, { error: `db: ${errMsg(err)}`, retryable: transient });
    }
  }
  return { outcome, failed, extra: null };
}

function countAlerts(d: Deps, alerts: Array<{ code: string; severity: string }>) {
  for (const a of alerts) d.metrics.alerts.inc({ code: a.code, severity: a.severity });
}

// =====================================================================================
// Direct jsonPTS
// =====================================================================================
export interface PtsOutcome {
  status: number;
  body: JsonPtsResponse;
}

export async function handlePtsUpload(
  d: Deps,
  station: StationRef,
  ptsId: string,
  packets: unknown[],
): Promise<PtsOutcome> {
  type Res = { id: number; type?: string; ok: boolean; message?: string };
  const results: Res[] = [];
  const items: PersistItem[] = [];
  const raw: Array<{ k: number; t: string; p: unknown }> = [];

  packets.forEach((p, idx) => {
    const pk = p as Partial<JsonPtsPacket> | null;
    const id = typeof pk?.Id === 'number' ? pk.Id : idx;
    const type = typeof pk?.Type === 'string' ? pk.Type : undefined;
    results.push({ id, type, ok: false, message: 'Error' });
    raw.push({ k: idx, t: type ?? 'Unknown', p: p ?? null });
    if (!pk || typeof pk !== 'object' || typeof pk.Type !== 'string') {
      results[idx]!.message = 'Malformed packet';
      d.metrics.records.inc({ kind: 'unknown', source: 'pts_direct', result: 'rejected' });
      return;
    }
    try {
      const rec = normalizeJsonPtsPacket(ptsId, pk as JsonPtsPacket, station.tzOffset);
      if (rec === null) {
        results[idx]!.ok = true; // accepted, archived raw only (GPS, configuration)
        d.metrics.records.inc({ kind: pk.Type, source: 'pts_direct', result: 'ignored' });
        return;
      }
      items.push({ key: idx, rec: validateRecord(rec), station });
    } catch (err) {
      if (err instanceof JsonPtsMappingError || err instanceof RecordValidationError) {
        results[idx]!.message = err.message;
        d.metrics.records.inc({ kind: pk.Type, source: 'pts_direct', result: 'rejected' });
        d.metrics.rejects.inc({ route: 'pts', reason: 'malformed_packet' });
        return;
      }
      throw err;
    }
  });

  const ctx: PersistCtx = { source: 'pts_direct', rollupDelayS: d.cfg.rollupDelayS, touchControllers: [ptsId] };
  const archive = async (c: Tx, rows: typeof raw) => {
    if (!rows.length) return;
    await c.query(
      `INSERT INTO fms.ingest_raw (source, pts_id, station_id, packet_type, payload)
       SELECT 'pts_direct', $1, $2, r.t, r.p FROM json_to_recordset($3::json) AS r(k int, t text, p jsonb)`,
      [ptsId, station.id, JSON.stringify(rows)],
    );
  };
  const rawByKey = new Map(raw.map((r) => [r.k, r]));
  const rawWithoutItems = raw.filter((r) => !items.some((i) => i.key === r.k));

  let outcome: Map<number, Outcome>;
  let failed: Map<number, { error: string; retryable: boolean }>;
  try {
    ({ outcome, failed } = await persistWithFallback(
      d,
      ctx,
      items,
      (c) => archive(c, raw),
      (c, it) => archive(c, [rawByKey.get(it.key)!]),
    ));
  } catch (err) {
    if (err instanceof TransientError) {
      d.metrics.rejects.inc({ route: 'pts', reason: 'db_unavailable' });
      return {
        status: 503,
        body: jsonPtsReply(results.map((r) => ({ ...r, ok: false, message: 'Temporarily unavailable, retry' }))),
      };
    }
    throw err;
  }
  if (failed.size) {
    // fallback mode: archive the packets that were not persisted individually (ignored/malformed)
    await withTx(d.db, (c) => archive(c, rawWithoutItems)).catch((e) => d.log.error({ err: errMsg(e) }, 'raw archive failed'));
  }
  for (const it of items) {
    const f = failed.get(it.key);
    const r = results[it.key]!;
    if (f) {
      r.message = f.error;
      d.metrics.records.inc({ kind: it.rec.kind, source: 'pts_direct', result: 'rejected' });
    } else {
      r.ok = true;
      d.metrics.records.inc({ kind: it.rec.kind, source: 'pts_direct', result: outcome.get(it.key) ?? 'ignored' });
    }
  }
  return { status: 200, body: jsonPtsReply(results) };
}

// =====================================================================================
// Edge batches
// =====================================================================================
export async function handleEdgeBatch(
  d: Deps,
  gw: GatewayRef,
  station: StationRef,
  batch: { batch_id: string; records: unknown[] },
  rawBatch: unknown,
): Promise<EdgeBatchResponse> {
  const accepted: number[] = [];
  const rejected: EdgeBatchResponse['rejected'] = [];
  const items: PersistItem[] = [];
  const seqOf = new Map<number, number>();

  for (let idx = 0; idx < batch.records.length; idx++) {
    const r = batch.records[idx] as { seq?: unknown; kind?: unknown } | null;
    const seq = r && typeof r === 'object' ? r.seq : undefined;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) {
      // without a seq the gateway cannot correlate; nothing to report back for it
      d.metrics.rejects.inc({ route: 'edge', reason: 'missing_seq' });
      continue;
    }
    let rec: TelemetryRecord;
    try {
      rec = validateRecord(r);
    } catch (err) {
      rejected.push({ seq, error: errMsg(err), retryable: false });
      d.metrics.records.inc({ kind: String(r?.kind ?? 'unknown'), source: 'edge', result: 'rejected' });
      d.metrics.rejects.inc({ route: 'edge', reason: 'invalid_record' });
      continue;
    }
    const ptsId = recordPtsId(rec);
    if (ptsId !== null) {
      const ctl = await d.ref.controllers.get(ptsId);
      if (!ctl) {
        // retryable: the controller may simply not be registered in the cloud yet
        rejected.push({ seq, error: `unknown controller ${ptsId}`, retryable: true });
        d.metrics.rejects.inc({ route: 'edge', reason: 'unknown_controller' });
        continue;
      }
      if (ctl.station_id !== gw.station_id) {
        rejected.push({ seq, error: `controller ${ptsId} does not belong to station ${station.code}`, retryable: false });
        d.metrics.rejects.inc({ route: 'edge', reason: 'station_mismatch' });
        continue;
      }
    }
    seqOf.set(idx, seq);
    items.push({ key: idx, rec, station });
  }

  const ctx: PersistCtx = { source: 'edge', gatewayId: gw.id, rollupDelayS: d.cfg.rollupDelayS };
  const extra = async (c: Tx): Promise<EdgeCommand[]> => {
    if (d.cfg.archiveEdgeBatches) {
      await c.query(
        `INSERT INTO fms.ingest_raw (source, gateway_code, station_id, packet_type, payload) VALUES ('edge', $1, $2, 'EdgeBatch', $3::jsonb)`,
        [gw.gateway_code, station.id, JSON.stringify(rawBatch)],
      );
    }
    return (await takeEdgeCommands(c, station.id, gw.gateway_code, d.cfg.maxCommandsPerResponse)) as EdgeCommand[];
  };
  // ensure the heartbeat/last_seen update runs even for batches with zero valid records
  const res = await persistWithFallback(d, ctx, items, extra, async () => {});
  let commands = res.extra;
  if (commands === null) {
    commands = await withTx(d.db, (c) => extra(c)).catch(() => [] as EdgeCommand[]);
  }
  for (const it of items) {
    const seq = seqOf.get(it.key)!;
    const f = res.failed.get(it.key);
    if (f) {
      rejected.push({ seq, ...f });
      d.metrics.records.inc({ kind: it.rec.kind, source: 'edge', result: 'rejected' });
    } else {
      accepted.push(seq);
      d.metrics.records.inc({ kind: it.rec.kind, source: 'edge', result: res.outcome.get(it.key) ?? 'ignored' });
    }
  }
  return { batch_id: batch.batch_id, accepted, rejected, commands };
}
