import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  createFixtureStation,
  edgeBatch,
  edgeHeaders,
  gz,
  pumpTx,
  SEED,
  setup,
  tankMeasurement,
  type Fixture,
} from './helpers.js';

const ctx = setup();
after(() => ctx.close());

const URL = '/ingest/v1/edge/batches';

async function send(f: Fixture | typeof SEED.lus | { gw: string; gwKey: string; code: string }, records: Array<Record<string, unknown>>, opts: { gzip?: boolean; headers?: Record<string, string> } = {}) {
  const batch = edgeBatch(f, records);
  const headers: Record<string, string> = { ...edgeHeaders(f), ...(opts.headers ?? {}) };
  if (opts.gzip) headers['content-encoding'] = 'gzip';
  return ctx.app.inject({ method: 'POST', url: URL, headers, payload: opts.gzip ? gz(batch) : JSON.stringify(batch) });
}

describe('POST /ingest/v1/edge/batches', () => {
  let f: Fixture;
  before(async () => {
    await ctx.app.ready();
    f = await createFixtureStation(ctx.pool, 'edge');
  });

  test('health, readiness and metrics endpoints', async () => {
    assert.equal((await ctx.app.inject('/healthz')).statusCode, 200);
    assert.equal((await ctx.app.inject('/readyz')).statusCode, 200);
    const m = await ctx.app.inject('/metrics');
    assert.equal(m.statusCode, 200);
    assert.match(m.body, /fms_ingest_records_total|fms_ingest_batch_duration_seconds/);
  });

  test('auth: seed gateway key works; bad key, missing key and wrong station are rejected', async () => {
    const ok = await send(SEED.lus, [{ seq: 1, ...pumpTx(SEED.lus.ptsId) }]);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual(ok.json().accepted, [1]);

    const bad = await send({ ...f, gwKey: 'nope' }, []);
    assert.equal(bad.statusCode, 401);
    const missing = await ctx.app.inject({ method: 'POST', url: URL, payload: edgeBatch(f, []) });
    assert.equal(missing.statusCode, 401);
    const wrongStation = await send({ ...f, code: 'LUS-0001' }, []);
    assert.equal(wrongStation.statusCode, 403);
    // a record from a controller of another station is rejected (non-retryable)
    const foreign = await send(f, [{ seq: 9, ...pumpTx(SEED.lus.ptsId) }]);
    assert.equal(foreign.statusCode, 200);
    assert.equal(foreign.json().rejected[0].seq, 9);
    assert.equal(foreign.json().rejected[0].retryable, false);
  });

  test('all record kinds are persisted; resend of the same seqs is accepted idempotently', async () => {
    const ended = new Date(Date.now() - 3600_000).toISOString();
    const tx = pumpTx(f.ptsId, { ended_at: ended, pump_no: 2, nozzle_no: 2, pts_grade_id: 2, volume_l: 40, price: 29.95, amount: 1198 });
    const txNo = (tx.data as { pts_transaction_no: number }).pts_transaction_no;
    const measuredAt = new Date(Date.now() - 1800_000).toISOString();
    const records = [
      { seq: 101, ...tx },
      { seq: 102, ...tankMeasurement(f.ptsId, { tank_no: 2, measured_at: measuredAt, product_volume_l: 30000, alarms: ['HighWater'] }) },
      {
        seq: 103,
        kind: 'tank_delivery',
        data: {
          pts_id: f.ptsId, tank_no: 2, pts_grade_id: 2,
          started_at: new Date(Date.now() - 7200_000).toISOString(), ended_at: new Date(Date.now() - 6600_000).toISOString(),
          start_volume_l: 12000, end_volume_l: 30000, start_tc_volume_l: null, end_tc_volume_l: null,
          start_height_mm: 500, end_height_mm: 1400, start_water_mm: 2, end_water_mm: 3,
          start_temperature_c: 24, end_temperature_c: 22, start_density_kg_m3: 840, end_density_kg_m3: 838,
        },
      },
      {
        seq: 104,
        kind: 'alert',
        data: { pts_id: f.ptsId, occurred_at: new Date(Date.now() - 600_000).toISOString(), device_type: 'controller', device_no: null, code: 'PowerLoss', severity: 'critical', message: 'Mains power lost' },
      },
      { seq: 105, kind: 'status', data: { pts_id: f.ptsId, reported_at: new Date().toISOString(), status: { Pumps: [{ Id: 1, Status: 'Idle' }] } } },
      {
        seq: 106,
        kind: 'fiscal_receipt',
        data: {
          pump_no: 2, pts_transaction_no: txNo, tx_ended_at: ended, invoice_no: `INV-${txNo}`, status: 'signed',
          zra_rcpt_no: '123', zra_tot_rcpt_no: '456', zra_internal_data: 'INTDATA', zra_signature: 'SIG', zra_sdc_id: 'SDC1',
          zra_mrc_no: 'MRC1', zra_qr_url: 'https://example/qr', zra_signed_at: new Date().toISOString(), printed_at: null, attempts: 1, last_error: null,
        },
      },
      { seq: 107, kind: 'heartbeat', data: { gateway_version: '1.2.3', backlog: 42, fiscal_backlog: 1, controllers_online: [f.ptsId], disk_free_mb: 1000, uptime_s: 99 } },
    ];
    const res = await send(f, records);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.deepEqual(body.accepted.sort(), [101, 102, 103, 104, 105, 106, 107]);
    assert.deepEqual(body.rejected, []);

    const q = async (sql: string, p: unknown[] = [f.stationId]) => (await ctx.pool.query(sql, p)).rows;
    const t = await q(`SELECT product_code, tank_no, fiscal_status, source FROM fms.pump_transactions WHERE station_id = $1 AND pts_transaction_no = $2`, [f.stationId, txNo]);
    assert.deepEqual(t, [{ product_code: 'DIESEL', tank_no: 2, fiscal_status: 'signed', source: 'edge' }]);
    const tl = await q(`SELECT product_code, product_volume_l, alarms FROM fms.tank_latest WHERE station_id = $1 AND tank_no = 2`);
    assert.deepEqual(tl, [{ product_code: 'DIESEL', product_volume_l: 30000, alarms: ['HighWater'] }]);
    const del = await q(`SELECT product_code, received_volume_l FROM fms.tank_deliveries WHERE station_id = $1`);
    assert.deepEqual(del, [{ product_code: 'DIESEL', received_volume_l: 18000 }]);
    const al = await q(`SELECT code, severity FROM fms.alerts WHERE station_id = $1 ORDER BY code`);
    assert.deepEqual(al, [{ code: 'HighWater', severity: 'warning' }, { code: 'PowerLoss', severity: 'critical' }]);
    const jobs = await q(`SELECT kind, payload->>'event' AS event, (payload->>'province_id')::int AS province_id FROM fms.jobs WHERE payload->>'station_id' = $1::text AND kind IN ('notify','webhook') ORDER BY kind`);
    assert.deepEqual(jobs, [
      { kind: 'notify', event: null, province_id: 5 },
      { kind: 'webhook', event: 'critical_alert', province_id: 5 },
    ]);
    const ctl = await q(`SELECT last_status FROM fms.controllers WHERE station_id = $1`);
    assert.deepEqual(ctl[0].last_status, { Pumps: [{ Id: 1, Status: 'Idle' }] });
    const gw = await q(`SELECT version, last_backlog, last_seen_at IS NOT NULL AS seen FROM fms.edge_gateways WHERE station_id = $1`);
    assert.deepEqual(gw, [{ version: '1.2.3', last_backlog: 42, seen: true }]);
    const fr = await q(`SELECT status, fiscalised_by, zra_rcpt_no FROM fms.fiscal_receipts WHERE station_id = $1`);
    assert.deepEqual(fr, [{ status: 'signed', fiscalised_by: 'edge', zra_rcpt_no: '123' }]);
    const roll = await q(`SELECT count(*)::int n FROM fms.jobs WHERE kind = 'rollup' AND dedupe_key LIKE 'rollup:' || $1::text || ':%'`);
    assert.ok(roll[0].n >= 1);
    // edge-mode stations never get cloud fiscalise jobs
    assert.equal((await q(`SELECT count(*)::int n FROM fms.jobs WHERE kind = 'fiscalise' AND payload->>'station_id' = $1::text`))[0].n, 0);

    // ---- resend exactly the same records (at-least-once delivery) -> all accepted, nothing duplicated
    const again = await send(f, records);
    assert.equal(again.statusCode, 200);
    assert.deepEqual(again.json().accepted.sort(), [101, 102, 103, 104, 105, 106, 107]);
    assert.equal((await q(`SELECT count(*)::int n FROM fms.pump_transactions WHERE station_id = $1`))[0].n, 1);
    assert.equal((await q(`SELECT count(*)::int n FROM fms.alerts WHERE station_id = $1`))[0].n, 2);
    assert.equal((await q(`SELECT count(*)::int n FROM fms.tank_deliveries WHERE station_id = $1`))[0].n, 1);
    assert.equal((await q(`SELECT count(*)::int n FROM fms.fiscal_receipts WHERE station_id = $1`))[0].n, 1);
    assert.equal((await q(`SELECT count(*)::int n FROM fms.jobs WHERE kind IN ('notify','webhook') AND payload->>'station_id' = $1::text`))[0].n, 2);
  });

  test('gzip body is accepted', async () => {
    const tx = pumpTx(f.ptsId);
    const res = await send(f, [{ seq: 201, ...tx }], { gzip: true });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().accepted, [201]);
    const { rows } = await ctx.pool.query(`SELECT count(*)::int n FROM fms.pump_transactions WHERE station_id = $1 AND pts_transaction_no = $2`, [f.stationId, (tx.data as { pts_transaction_no: number }).pts_transaction_no]);
    assert.equal(rows[0].n, 1);
    const badEnc = await send(f, [], { headers: { 'content-encoding': 'br' } });
    assert.equal(badEnc.statusCode, 415);
  });

  test('invalid records are rejected individually (non-retryable); duplicate seqs within a batch accepted', async () => {
    const tx = pumpTx(f.ptsId);
    const res = await send(f, [
      { seq: 301, ...tx },
      { seq: 301, ...tx },
      { seq: 302, kind: 'pump_transaction', data: { pts_id: f.ptsId, pump_no: 'x' } },
      { seq: 303, kind: 'teleport', data: {} },
      { seq: 304, ...pumpTx(f.ptsId, { ended_at: '2026-11-27T10:00:00' }) }, // no offset
    ]);
    assert.equal(res.statusCode, 200);
    const b = res.json();
    assert.deepEqual(b.accepted, [301, 301]);
    assert.deepEqual(b.rejected.map((r: { seq: number }) => r.seq).sort(), [302, 303, 304]);
    assert.ok(b.rejected.every((r: { retryable: boolean }) => r.retryable === false));
  });

  test('edge commands: delivered, redelivered until acked, then acked forward-only', async () => {
    await ctx.pool.query(
      `INSERT INTO fms.edge_commands (id, station_id, type, command, created_at) VALUES
         ('cmd-a', $1, 'reload_config', jsonb_build_object('id', 'cmd-a', 'type', 'reload_config'), now() - interval '2 s'),
         ('cmd-b', $1, 'set_prices', jsonb_build_object('id', 'cmd-b', 'type', 'set_prices',
             'prices', jsonb_build_array(jsonb_build_object('pts_grade_id', 1, 'price', 31.5)), 'effective_at', '2026-12-01T00:00:00+02:00'), now() - interval '1 s'),
         ('cmd-x', $1, 'reload_config', jsonb_build_object('id', 'cmd-x', 'type', 'reload_config'), now() - interval '3 s')`,
      [f.stationId],
    );
    await ctx.pool.query(`UPDATE fms.edge_commands SET expires_at = now() - interval '1 s' WHERE id = 'cmd-x'`);
    const status = async () =>
      Object.fromEntries((await ctx.pool.query(`SELECT id, status FROM fms.edge_commands WHERE station_id = $1`, [f.stationId])).rows.map((r) => [r.id, r.status]));

    const r1 = await send(f, [{ seq: 401, kind: 'heartbeat', data: { gateway_version: '1.2.4', backlog: 0, fiscal_backlog: 0, controllers_online: [], disk_free_mb: null, uptime_s: 1 } }]);
    assert.equal(r1.statusCode, 200);
    const cmds = r1.json().commands;
    assert.deepEqual(cmds.map((c: { id: string }) => c.id), ['cmd-a', 'cmd-b'], 'expired command is not delivered');
    assert.equal(cmds[1].type, 'set_prices');
    assert.deepEqual(cmds[1].prices, [{ pts_grade_id: 1, price: 31.5 }]);
    assert.deepEqual(await status(), { 'cmd-a': 'delivered', 'cmd-b': 'delivered', 'cmd-x': 'queued' });

    // Within the redelivery window nothing is resent.
    assert.deepEqual((await send(f, [])).json().commands, []);

    // Response "lost": no ack arrives; once the window passes the commands are redelivered.
    await ctx.pool.query(`UPDATE fms.edge_commands SET last_delivered_at = now() - interval '1 hour' WHERE station_id = $1`, [f.stationId]);
    const r3 = await send(f, []);
    assert.deepEqual(r3.json().commands.map((c: { id: string }) => c.id), ['cmd-a', 'cmd-b']);

    // Acks: cmd-a applied (received + applied in one batch), cmd-b received then failed; unknown id ignored.
    const at = '2026-11-27T10:00:00+02:00';
    const r4 = await send(f, [
      { seq: 410, kind: 'command_ack', data: { command_id: 'cmd-a', status: 'received', at, result: null } },
      { seq: 411, kind: 'command_ack', data: { command_id: 'cmd-b', status: 'received', at, result: null } },
      { seq: 412, kind: 'command_ack', data: { command_id: 'cmd-a', status: 'applied', at: '2026-11-27T10:00:01+02:00', result: { ok: true } } },
      { seq: 413, kind: 'command_ack', data: { command_id: 'nope', status: 'applied', at, result: null } },
      { seq: 414, kind: 'command_ack', data: { command_id: 'cmd-b', status: 'bogus', at, result: null } },
    ]);
    assert.equal(r4.statusCode, 200);
    assert.deepEqual(r4.json().accepted.sort(), [410, 411, 412, 413]);
    assert.deepEqual(r4.json().rejected.map((r: { seq: number }) => r.seq), [414]);
    assert.deepEqual(await status(), { 'cmd-a': 'applied', 'cmd-b': 'received', 'cmd-x': 'queued' });

    // A received command is never redelivered, even after the window.
    await ctx.pool.query(`UPDATE fms.edge_commands SET last_delivered_at = now() - interval '1 hour' WHERE station_id = $1`, [f.stationId]);
    assert.deepEqual((await send(f, [])).json().commands, []);

    // Late/duplicate 'received' does not downgrade; 'failed' raises a CommandFailed alert.
    await send(f, [
      { seq: 420, kind: 'command_ack', data: { command_id: 'cmd-a', status: 'received', at, result: null } },
      { seq: 421, kind: 'command_ack', data: { command_id: 'cmd-b', status: 'failed', at: '2026-11-27T10:05:00+02:00', result: { error: 'controller rejected price' } } },
    ]);
    assert.deepEqual(await status(), { 'cmd-a': 'applied', 'cmd-b': 'failed', 'cmd-x': 'queued' });
    const { rows } = await ctx.pool.query(
      `SELECT e.result, e.received_at IS NOT NULL AS rec, e.completed_at IS NOT NULL AS done,
              (SELECT count(*)::int FROM fms.alerts a WHERE a.station_id = e.station_id AND a.code = 'CommandFailed') AS alerts
         FROM fms.edge_commands e WHERE e.id = 'cmd-b'`,
    );
    assert.deepEqual(rows[0], { result: { error: 'controller rejected price' }, rec: true, done: true, alerts: 1 });
  });
});
