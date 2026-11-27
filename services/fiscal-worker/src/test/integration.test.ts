/**
 * Integration tests: real PostgreSQL (fms schema + demo seed) and the in-process mock VSDC.
 *   TEST_DATABASE_URL (default postgres://postgres@localhost:55432/fms_workers)
 *   MOCK_VSDC_TEST_PORT (default 18200), METRICS_TEST_PORT (default 19464)
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { formatVsdcDateTime, startMockVsdc, type MockVsdcHandle } from '@fms/zra-client';
import { createApp, type App } from '../app.js';
import { loadConfig, type WorkerConfig } from '../config.js';
import { backoffMs, createLogger } from '../core.js';
import { startHttpServer } from '../http.js';
import { Scheduler } from '../scheduler.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:55432/fms_workers';
const VSDC_PORT = Number(process.env.MOCK_VSDC_TEST_PORT ?? 18200);
const METRICS_PORT = Number(process.env.METRICS_TEST_PORT ?? 19464);
const CEN = 'aaaaaaaa-0000-0000-0000-000000000002'; // CEN-0001, direct mode, branch 001
const LUS = 'aaaaaaaa-0000-0000-0000-000000000001'; // LUS-0001, edge mode
const CEN_PTS = '003B00265030500420303532';
const LUS_PTS = '003B00265030500420303531';

let mock: MockVsdcHandle;
let app: App;
let cfg: WorkerConfig;
let tmp: string;
let txSeq = (Date.now() % 100000) * 10;

const q = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  app.deps.db.query<T>(sql, params).then((r) => r.rows);

async function insertTx(opts: { station?: string; pts?: string; endedAt?: Date; receivedAgoMin?: number; volume?: number; amount?: number } = {}) {
  const txno = ++txSeq;
  const endedAt = opts.endedAt ?? new Date(Math.floor(Date.now() / 1000) * 1000 - 5 * 60_000);
  await q(
    `INSERT INTO fms.pump_transactions (station_id, pts_id, pts_transaction_no, pump_no, nozzle_no, pts_grade_id, product_code, tank_no,
                                        ended_at, volume_l, price, amount, source, received_at)
     VALUES ($1, $2, $3, 1, 1, 1, 'PETROL', 1, $4, $5, 31.85, $6, 'pts_direct', now() - make_interval(mins => $7))`,
    [opts.station ?? CEN, opts.pts ?? CEN_PTS, txno, endedAt, opts.volume ?? 20.5, opts.amount ?? 652.93, opts.receivedAgoMin ?? 0],
  );
  return { txno, endedAt, payload: { station_id: opts.station ?? CEN, pump_no: 1, pts_transaction_no: txno, ended_at: endedAt.toISOString() } };
}

const txState = (txno: number) =>
  q<{ fiscal_status: string }>('SELECT fiscal_status FROM fms.pump_transactions WHERE pts_transaction_no = $1', [txno]).then((r) => r[0]!);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const receipt = (txno: number) => q<Record<string, any>>('SELECT * FROM fms.fiscal_receipts WHERE pts_transaction_no = $1', [txno]).then((r) => r[0]);
const jobsOf = (kind: string) => q<{ id: string; status: string; attempts: number; run_at: Date; last_error: string | null; payload: Record<string, unknown>; dedupe_key: string }>(
  'SELECT * FROM fms.jobs WHERE kind = $1 ORDER BY id', [kind]);

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'fms-worker-test-'));
  mock = await startMockVsdc({ port: VSDC_PORT });
  cfg = loadConfig({
    DATABASE_URL: DB,
    ZRA_VSDC_URL: mock.url,
    ZRA_DEVICE_SERIAL: 'DVC-CLOUD-TEST',
    ZRA_TIMEOUT_MS: '5000',
    LOG_LEVEL: 'silent',
    WORKER_ID: 'test-worker-1',
    EXPORT_DIR: join(tmp, 'exports'),
    RECEIPT_ARCHIVE_DIR: join(tmp, 'receipts'),
    JOB_BACKOFF_BASE_MS: '60000',
  });
  app = createApp(cfg, createLogger('silent'));
});

after(async () => {
  await app.deps.db.end();
  await mock.close();
  await rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  mock.reset();
  await q('DELETE FROM fms.jobs');
  await q('DELETE FROM fms.fiscal_receipts');
  await q('DELETE FROM fms.pump_transactions');
  await q('DELETE FROM fms.daily_station_product');
  await q(`DELETE FROM fms.alerts WHERE code = 'GatewayOffline'`);
  await q(`DELETE FROM fms.api_clients WHERE key_prefix LIKE 'test%'`);
});

describe('backoff', () => {
  it('grows exponentially with jitter and is capped', () => {
    assert.equal(backoffMs(1, 1000, 60_000, () => 0), 500);
    assert.equal(backoffMs(1, 1000, 60_000, () => 1), 1000);
    assert.equal(backoffMs(4, 1000, 60_000, () => 1), 8000);
    assert.equal(backoffMs(30, 1000, 60_000, () => 1), 60_000);
  });
});

describe('fiscalise', () => {
  it('signs a direct-mode sale through the VSDC and stores the receipt', async () => {
    const tx = await insertTx();
    await app.deps.queue.enqueue({ kind: 'fiscalise', payload: tx.payload, dedupeKey: `fiscalise:${CEN}:1:${tx.txno}:${tx.payload.ended_at}` });
    assert.equal(await app.worker.runOnce(), 1);

    const r = await receipt(tx.txno);
    assert.ok(r);
    assert.equal(r.status, 'signed');
    assert.equal(r.fiscalised_by, 'cloud');
    assert.equal(r.invoice_no, `CEN-0001-P1-${tx.txno}-${formatVsdcDateTime(tx.endedAt)}`);
    assert.equal(r.zra_rcpt_no, '1');
    assert.match(r.zra_signature, /^[0-9A-F-]{19}$/);
    assert.ok(r.zra_sdc_id && r.zra_mrc_no && r.zra_qr_url && r.zra_internal_data && r.zra_signed_at);
    assert.equal((await txState(tx.txno)).fiscal_status, 'signed');
    assert.equal((await jobsOf('fiscalise'))[0]!.status, 'done');

    // VSDC payload: tpin from company, branch from station, tax-inclusive VAT
    const sale = Object.values(mock.state().receipts);
    assert.equal(sale.length, 1);
    const reqJson = r.request.sale as { tpin: string; branch_id: string };
    assert.equal(reqJson.tpin, '1000000001');
    assert.equal(reqJson.branch_id, '001');

    // receipt archive written via fiscal-printer
    assert.ok(existsSync(join(cfg.zra.receiptArchiveDir!, `${r.invoice_no}.txt`)));

    // a duplicate job is a no-op (already signed) and does not hit the VSDC again
    await app.deps.queue.enqueue({ kind: 'fiscalise', payload: tx.payload });
    assert.equal(await app.worker.runOnce(), 1);
    assert.equal(mock.state().requests['/trnsSales/saveSales'], 1);
  });

  it('retries with backoff on VSDC 5xx and succeeds on the next attempt', async () => {
    const tx = await insertTx();
    mock.fail('5xx', 1);
    await app.deps.queue.enqueue({ kind: 'fiscalise', payload: tx.payload });
    await app.worker.runOnce();

    const [job] = await jobsOf('fiscalise');
    assert.equal(job!.status, 'queued');
    assert.equal(job!.attempts, 1);
    assert.ok(job!.run_at.getTime() > Date.now() + 20_000, 'run_at pushed out by backoff');
    assert.match(job!.last_error!, /HTTP 503/);
    const r1 = await receipt(tx.txno);
    assert.equal(r1!.status, 'pending');
    assert.match(r1!.last_error!, /503/);

    await q('UPDATE fms.jobs SET run_at = now()');
    await app.worker.runOnce();
    assert.equal((await jobsOf('fiscalise'))[0]!.status, 'done');
    const r2 = await receipt(tx.txno);
    assert.equal(r2!.status, 'signed');
    assert.equal(r2!.attempts, 2);
    assert.equal(r2!.invoice_no, r1!.invoice_no, 'same invoice number on retry');
  });

  it('recovers a receipt the VSDC signed before a client timeout (idempotent invoice)', async () => {
    const tx = await insertTx();
    const short = createApp({ ...cfg, zra: { ...cfg.zra, timeoutMs: 300 } }, createLogger('silent'), { db: app.deps.db, queue: app.deps.queue, metrics: app.deps.metrics });
    mock.fail('timeout', 1);
    await app.deps.queue.enqueue({ kind: 'fiscalise', payload: tx.payload });
    await short.worker.runOnce();
    assert.equal((await jobsOf('fiscalise'))[0]!.status, 'queued');
    await q('UPDATE fms.jobs SET run_at = now()');
    await app.worker.runOnce();
    const r = await receipt(tx.txno);
    assert.equal(r!.status, 'signed');
    assert.equal(r!.zra_rcpt_no, '1');
    assert.equal(Object.keys(mock.state().receipts).length, 1);
  });

  it('dead-letters a non-retryable VSDC rejection and marks the sale failed', async () => {
    const tx = await insertTx();
    mock.fail('reject', 1);
    await app.deps.queue.enqueue({ kind: 'fiscalise', payload: tx.payload });
    await app.worker.runOnce();
    const [job] = await jobsOf('fiscalise');
    assert.equal(job!.status, 'dead');
    assert.match(job!.last_error!, /910/);
    assert.equal((await receipt(tx.txno))!.status, 'failed');
    assert.equal((await txState(tx.txno)).fiscal_status, 'failed');
  });

  it('dead-letters after max_attempts', async () => {
    const tx = await insertTx();
    mock.fail('5xx', 0); // fail forever
    await app.deps.queue.enqueue({ kind: 'fiscalise', payload: tx.payload, maxAttempts: 2 });
    await app.worker.runOnce();
    await q('UPDATE fms.jobs SET run_at = now()');
    await app.worker.runOnce();
    assert.equal((await jobsOf('fiscalise'))[0]!.status, 'dead');
    assert.equal((await txState(tx.txno)).fiscal_status, 'failed');
    mock.fail(null);
  });

  it('skips a transaction the edge already signed', async () => {
    const tx = await insertTx({ station: LUS, pts: LUS_PTS });
    await q(
      `INSERT INTO fms.fiscal_receipts (station_id, pump_no, pts_transaction_no, tx_ended_at, invoice_no, status, fiscalised_by, zra_rcpt_no)
       VALUES ($1, 1, $2, $3, 'EDGE-INV-1', 'signed', 'edge', '99')`,
      [LUS, tx.txno, tx.endedAt],
    );
    await app.deps.queue.enqueue({ kind: 'fiscalise', payload: tx.payload });
    await app.worker.runOnce();
    assert.equal((await jobsOf('fiscalise'))[0]!.status, 'done');
    assert.equal(mock.state().requests['/trnsSales/saveSales'] ?? 0, 0);
    assert.equal((await txState(tx.txno)).fiscal_status, 'signed');
    assert.equal((await receipt(tx.txno))!.zra_rcpt_no, '99');
  });
});

describe('queue', () => {
  it('recovers expired leases', async () => {
    await q(`INSERT INTO fms.jobs (kind, payload, status, locked_by, locked_at, attempts) VALUES ('rollup', '{}', 'running', 'crashed', now() - interval '1 hour', 1)`);
    await q(`INSERT INTO fms.jobs (kind, payload, status, locked_by, locked_at, attempts, max_attempts) VALUES ('rollup', '{}', 'running', 'crashed', now() - interval '1 hour', 3, 3)`);
    const r = await app.deps.queue.recoverExpiredLeases(10);
    assert.equal(r.requeued, 1);
    assert.equal(r.dead.length, 1);
    const rows = await jobsOf('rollup');
    assert.deepEqual(rows.map((j) => j.status), ['queued', 'dead']);
  });

  it('does not hand the same job to two concurrent claimers', async () => {
    for (let i = 0; i < 20; i++) await app.deps.queue.enqueue({ kind: 'notify', payload: { i } });
    const [a, b] = await Promise.all([app.deps.queue.claim(['notify'], 15, 'w-a'), app.deps.queue.claim(['notify'], 15, 'w-b')]);
    const ids = [...a, ...b].map((j) => j.id);
    assert.equal(ids.length, 20);
    assert.equal(new Set(ids).size, 20);
  });
});

describe('rollup', () => {
  it('rolls up a station-day via fms.rollup_station_day', async () => {
    const endedAt = new Date('2026-11-20T08:00:00Z'); // 10:00 Lusaka
    await insertTx({ endedAt, volume: 10, amount: 318.5 });
    await insertTx({ endedAt: new Date('2026-11-20T09:00:00Z'), volume: 20, amount: 637 });
    await app.deps.queue.enqueue({ kind: 'rollup', payload: { station_id: CEN, business_date: '2026-11-20' }, dedupeKey: `rollup:${CEN}:2026-11-20` });
    await app.worker.runOnce();
    const [row] = await q<{ sales_volume_l: string; sales_amount: string; tx_count: number; avg_price: string; province_id: number }>(
      `SELECT * FROM fms.daily_station_product WHERE station_id = $1 AND business_date = '2026-11-20' AND product_code = 'PETROL'`, [CEN]);
    assert.ok(row);
    assert.equal(Number(row.sales_volume_l), 30);
    assert.equal(Number(row.sales_amount), 955.5);
    assert.equal(row.tx_count, 2);
    assert.equal(Number(row.avg_price), 31.85);
    assert.equal(row.province_id, 1);
    assert.equal((await jobsOf('rollup'))[0]!.status, 'done');
  });
});

describe('webhook + erb_export', () => {
  let server: Server;
  let url: string;
  const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
  let failNext = 0;

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        if (failNext > 0) {
          failNext--;
          res.writeHead(500).end('boom');
        } else res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    received.length = 0;
    failNext = 0;
  });

  async function subscribe(prefix: string, provinceId: number | null, events: string[], secret: string) {
    const [c] = await q<{ id: string }>(
      `INSERT INTO fms.api_clients (name, organisation, key_prefix, key_hash, scopes, province_id)
       VALUES ($1, 'Test', $1, 'x', ARRAY['sales:read'], $2) RETURNING id`, [prefix, provinceId]);
    await q(`INSERT INTO fms.webhook_subscriptions (api_client_id, url, events, secret) VALUES ($1, $2, $3, $4)`, [c!.id, url, events, secret]);
  }

  function verify(sigHeader: string, secret: string, body: string) {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sigHeader);
    assert.ok(m, `bad signature header ${sigHeader}`);
    assert.equal(m[2], createHmac('sha256', secret).update(`${m[1]}.${body}`).digest('hex'));
    assert.ok(Math.abs(Date.now() / 1000 - Number(m[1])) < 300);
  }

  it('fans out to in-scope subscriptions with a valid signature and retries non-2xx', async () => {
    await subscribe('testnat1', null, ['daily_summary', 'critical_alert'], 'nat-secret');
    await subscribe('testcop1', 2, ['daily_summary'], 'cop-secret'); // Copperbelt-only client
    await subscribe('testcen1', 1, ['stock_low'], 'cen-secret'); // other event

    failNext = 1;
    await app.deps.queue.enqueue({ kind: 'webhook', payload: { event: 'daily_summary', data: { province_id: 1, date: '2026-11-20' } } });
    await app.worker.drain();
    assert.equal(received.length, 1, 'only the national client is in scope');
    const children = (await jobsOf('webhook')).filter((j) => j.payload.subscription_id);
    assert.equal(children.length, 1);
    assert.equal(children[0]!.status, 'queued', 'non-2xx → retry');
    assert.match(children[0]!.last_error!, /HTTP 500/);

    await q('UPDATE fms.jobs SET run_at = now()');
    await app.worker.drain();
    assert.equal(received.length, 2);
    const last = received[1]!;
    verify(String(last.headers['x-fms-signature']), 'nat-secret', last.body);
    assert.equal(last.headers['x-fms-event'], 'daily_summary');
    const body = JSON.parse(last.body);
    assert.equal(body.event, 'daily_summary');
    assert.deepEqual(body.data, { province_id: 1, date: '2026-11-20' });
    assert.equal(body.id, received[0]!.headers['x-fms-delivery'], 'stable delivery id across retries');
    assert.ok((await jobsOf('webhook')).every((j) => j.status === 'done'));

    // station-scoped event resolves the province from the station (CEN → 1): Copperbelt client excluded
    received.length = 0;
    await app.deps.queue.enqueue({ kind: 'webhook', payload: { event: 'daily_summary', data: { station_id: CEN } } });
    await app.worker.drain();
    assert.equal(received.length, 1);
    verify(String(received[0]!.headers['x-fms-signature']), 'nat-secret', received[0]!.body);
  });

  it('exports the ERB daily return (CSV + JSON) and enqueues daily_summary', async () => {
    await subscribe('testnat2', null, ['daily_summary'], 'nat2-secret');
    await insertTx({ endedAt: new Date('2026-11-20T08:00:00Z'), volume: 10, amount: 318.5 });
    // A rollup for that date still running elsewhere → the export waits (retryable).
    await q(`INSERT INTO fms.jobs (kind, payload, status, locked_by, locked_at) VALUES ('rollup', $1, 'running', 'other-worker', now())`,
      [JSON.stringify({ station_id: CEN, business_date: '2026-11-20' })]);
    await app.deps.queue.enqueue({ kind: 'erb_export', payload: { date: '2026-11-20', province_id: 1 } });
    await app.worker.runOnce();
    const waiting = (await jobsOf('erb_export'))[0]!;
    assert.equal(waiting.status, 'queued');
    assert.match(waiting.last_error!, /waiting for 1 rollup/);

    await q(`DELETE FROM fms.jobs WHERE locked_by = 'other-worker'`);
    await app.deps.queue.enqueue({ kind: 'rollup', payload: { station_id: CEN, business_date: '2026-11-20' } });
    await app.worker.runOnce(1); // rollup (earlier run_at than the deferred export)
    await q('UPDATE fms.jobs SET run_at = now()');
    await app.worker.drain();

    const dir = join(cfg.exportDir, 'erb', 'daily', '2026-11-20');
    const csv = await readFile(join(dir, 'CEN.csv'), 'utf8');
    const lines = csv.trim().split('\r\n');
    assert.match(lines[0]!, /^business_date,province_id,province_name,station_code/);
    const petrol = lines.find((l) => l.includes('CEN-0001') && l.includes('PETROL'));
    assert.ok(petrol, csv);
    assert.match(petrol, /,PETROL,,0,10,318\.5,1,,,31\.85$/);
    const json = JSON.parse(await readFile(join(dir, 'CEN.json'), 'utf8'));
    assert.equal(json.station_count, 1);
    assert.deepEqual(json.totals.find((t: { product_code: string }) => t.product_code === 'PETROL').sales_volume_l, 10);

    const exp = (await jobsOf('erb_export'))[0]!;
    assert.equal(exp.status, 'done');
    const summary = (await jobsOf('webhook')).find((j) => j.dedupe_key === 'webhook:daily_summary:2026-11-20:CEN');
    assert.ok(summary);
    assert.equal(received.length, 1);
    const body = JSON.parse(received[0]!.body);
    assert.equal(body.event, 'daily_summary');
    assert.equal(body.data.station_count, 1);
    verify(String(received[0]!.headers['x-fms-signature']), 'nat2-secret', received[0]!.body);
  });
});

describe('scheduler', () => {
  it('sweeps pending direct-mode sales into fiscalise jobs (edge-mode only after fallback window)', async () => {
    const direct = await insertTx({ receivedAgoMin: 10 });
    await insertTx({ receivedAgoMin: 0 }); // too fresh
    await insertTx({ station: LUS, pts: LUS_PTS, receivedAgoMin: 10 }); // edge, inside fallback window
    const edgeOld = await insertTx({ station: LUS, pts: LUS_PTS, receivedAgoMin: 120 });
    const r = await app.scheduler.sweepFiscal();
    assert.equal(r.enqueued, 2);
    const keys = (await jobsOf('fiscalise')).map((j) => j.dedupe_key).sort();
    assert.deepEqual(keys, [
      `fiscalise:${CEN}:1:${direct.txno}:${direct.payload.ended_at}`,
      `fiscalise:${LUS}:1:${edgeOld.txno}:${edgeOld.payload.ended_at}`,
    ].sort());
    assert.equal((await app.scheduler.sweepFiscal()).enqueued, 0, 'dedupe');
    await app.worker.drain();
    assert.equal((await txState(direct.txno)).fiscal_status, 'signed');
    assert.equal((await txState(edgeOld.txno)).fiscal_status, 'signed');
  });

  it('raises one GatewayOffline alert per outage and fans out notify + webhook', async () => {
    await q(`UPDATE fms.edge_gateways SET last_seen_at = now() - interval '1 hour' WHERE gateway_code = 'GW-LUS-0001'`);
    try {
      assert.equal((await app.scheduler.checkGateways()).alerts, 1);
      assert.equal((await app.scheduler.checkGateways()).alerts, 0);
      const [a] = await q<{ severity: string; device_type: string }>(`SELECT * FROM fms.alerts WHERE code = 'GatewayOffline'`);
      assert.equal(a!.severity, 'critical');
      assert.equal(a!.device_type, 'gateway');
      assert.equal((await jobsOf('notify')).length, 1);
      assert.equal((await jobsOf('webhook')).length, 1);
      await app.worker.drain();
      assert.ok((await jobsOf('notify')).every((j) => j.status === 'done'));
    } finally {
      await q(`UPDATE fms.edge_gateways SET last_seen_at = NULL`);
    }
  });

  it('expires unacknowledged edge commands once and raises CommandExpired', async () => {
    await q(
      `INSERT INTO fms.edge_commands (id, station_id, type, command, status, expires_at) VALUES
         ('t-exp-1', $1, 'set_prices', '{"id":"t-exp-1","type":"set_prices","prices":[]}', 'delivered', now() - interval '1 minute'),
         ('t-exp-2', $1, 'reload_config', '{"id":"t-exp-2","type":"reload_config"}', 'received', now() - interval '1 minute'),
         ('t-exp-3', $1, 'reload_config', '{"id":"t-exp-3","type":"reload_config"}', 'queued', now() + interval '1 day')`,
      [LUS],
    );
    try {
      assert.deepEqual(await app.scheduler.expireCommands(), { expired: 1 });
      assert.deepEqual(await app.scheduler.expireCommands(), { expired: 0 });
      const st = await q<{ id: string; status: string }>(`SELECT id, status FROM fms.edge_commands WHERE id LIKE 't-exp-%' ORDER BY id`);
      assert.deepEqual(st.map((r) => r.status), ['expired', 'received', 'queued'], 'acknowledged and unexpired commands untouched');
      const al = await q<{ data: { command_id: string } }>(`SELECT data FROM fms.alerts WHERE code = 'CommandExpired'`);
      assert.deepEqual(al.map((a) => a.data.command_id), ['t-exp-1']);
    } finally {
      await q(`DELETE FROM fms.edge_commands WHERE id LIKE 't-exp-%'`);
      await q(`DELETE FROM fms.alerts WHERE code = 'CommandExpired'`);
    }
  });

  it('schedules daily rollups and ERB exports idempotently', async () => {
    const r1 = await app.scheduler.scheduleDaily('2026-11-26');
    assert.deepEqual(r1, { rollups: 4, exports: 11 });
    assert.deepEqual(await app.scheduler.scheduleDaily('2026-11-26'), { rollups: 0, exports: 0 });
    await app.scheduler.ensurePartitions();
  });

  it('elects a single leader with pg_try_advisory_lock', async () => {
    const mk = () => new Scheduler({ db: app.deps.db, queue: app.deps.queue, config: { ...cfg, scheduler: { ...cfg.scheduler, lockKey: 990_001 } }, log: createLogger('silent'), metrics: app.deps.metrics });
    const s1 = mk();
    const s2 = mk();
    try {
      await s1.tick();
      await s2.tick();
      assert.equal(s1.isLeader, true);
      assert.equal(s2.isLeader, false);
      await s1.stop();
      await s2.tick();
      assert.equal(s2.isLeader, true);
    } finally {
      await s1.stop();
      await s2.stop();
    }
  });
});

describe('http', () => {
  it('serves /healthz, /readyz and /metrics', async () => {
    const server = await startHttpServer(METRICS_PORT, {
      db: app.deps.db, metrics: app.deps.metrics, log: createLogger('silent'), isAlive: () => true, info: () => ({ worker_id: 'test' }),
    }, '127.0.0.1');
    try {
      const base = `http://127.0.0.1:${METRICS_PORT}`;
      assert.equal((await fetch(`${base}/healthz`)).status, 200);
      assert.equal((await fetch(`${base}/readyz`)).status, 200);
      const m = await (await fetch(`${base}/metrics`)).text();
      assert.match(m, /fms_worker_jobs_processed_total/);
      assert.match(m, /fms_worker_queue_depth/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
