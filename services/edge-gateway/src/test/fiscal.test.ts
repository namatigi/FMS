import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { FiscalError } from '@fms/shared';
import type { Gateway } from '../app.js';
import { FakeFiscalClient, MemoryReceiptPrinter } from '../fiscal/factory.js';
import { invoiceNo, lusakaStamp } from '../fiscal/invoice.js';
import { backoffMs, FiscalPipeline } from '../fiscal/pipeline.js';
import { count, ensureTestDb, newGateway, ptsBody, pumpTx, signedHeaders, truncateAll, waitFor } from './helpers.js';

let gw: Gateway;
let fiscal: FakeFiscalClient;
let printer: MemoryReceiptPrinter;

before(async () => {
  await ensureTestDb();
  ({ gw, fiscal, printer } = await newGateway({ FISCAL_CONCURRENCY: '8' }));
});
after(async () => {
  await gw.stop();
});
beforeEach(async () => {
  await truncateAll(gw.pool);
  fiscal.failWith = null;
  fiscal.calls = 0;
  printer.failWith = null;
  printer.printed.length = 0;
});

async function upload(packets: ReturnType<typeof pumpTx>[]) {
  const body = ptsBody(packets);
  const r = await gw.ptsServer.inject({ method: 'POST', url: '/jsonPTS', payload: body, headers: signedHeaders(body) });
  assert.equal(r.statusCode, 200);
}

async function drainPipeline(p: FiscalPipeline = gw.pipeline, rounds = 50) {
  for (let i = 0; i < rounds; i++) {
    const n = await p.runOnce();
    const due = await count(gw, `SELECT count(*) n FROM edge.fiscal_receipts WHERE status IN ('pending','signed')`);
    if (n === 0 && due === 0) return;
    if (n === 0) await new Promise((r) => setTimeout(r, 40));
  }
}

async function fiscalOutboxStatuses(): Promise<string[]> {
  const r = await gw.pool.query(`SELECT data->>'status' s FROM edge.outbox WHERE kind = 'fiscal_receipt' ORDER BY seq`);
  return r.rows.map((x) => x.s);
}

test('invoice number is deterministic, Lusaka local time', () => {
  assert.equal(lusakaStamp('2026-11-27T08:01:30.000Z'), '20261127100130');
  assert.equal(invoiceNo('LUS-0001', 3, 1234, '2026-11-27T08:01:30.000Z'), 'LUS-0001-P3-1234-20261127100130');
  assert.equal(lusakaStamp('2026-12-31T23:30:00Z'), '20270101013000');
});

test('backoff is exponential and capped at 5 minutes', () => {
  assert.equal(backoffMs(1, 2000, 300_000), 2000);
  assert.equal(backoffMs(2, 2000, 300_000), 4000);
  assert.equal(backoffMs(5, 2000, 300_000), 32000);
  assert.equal(backoffMs(20, 2000, 300_000), 300_000);
});

test('success: signed by fake VSDC, printed, every state change in outbox', async () => {
  const p = pumpTx();
  await upload([p]);
  await drainPipeline();
  const r = await gw.pool.query(`SELECT f.*, t.fiscal_status FROM edge.fiscal_receipts f JOIN edge.transactions t ON t.id = f.transaction_id`);
  assert.equal(r.rows[0].status, 'printed');
  assert.equal(r.rows[0].fiscal_status, 'printed');
  assert.ok(r.rows[0].zra_signature);
  assert.ok(r.rows[0].printed_at);
  assert.equal(fiscal.calls, 1);
  assert.equal(printer.printed.length, 1);
  const doc = printer.printed[0];
  assert.equal(doc.invoice_no, r.rows[0].invoice_no);
  assert.equal(doc.lines[0].item_code, 'ZM1NTLTR0000001');
  assert.equal(doc.lines[0].qty, 20.5);
  assert.equal(doc.total, 652.93);
  assert.equal(doc.vat_total, Math.round((652.93 * 16) / 116 * 100) / 100);
  assert.deepEqual(await fiscalOutboxStatuses(), ['pending', 'signed', 'printed']);
});

test('retryable errors back off and then succeed', async () => {
  fiscal.failWith = (_req, call) => (call <= 2 ? new FiscalError('VSDC timeout', true, 'TIMEOUT') : null);
  await upload([pumpTx()]);
  await gw.pipeline.runOnce();
  let row = (await gw.pool.query(`SELECT status, attempts, last_error, next_attempt_at > now() AS deferred FROM edge.fiscal_receipts`)).rows[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, 'VSDC timeout');
  assert.equal(row.deferred, true);
  // not due yet -> nothing claimed
  assert.equal(await gw.pipeline.runOnce(), 0);
  await drainPipeline();
  row = (await gw.pool.query(`SELECT status, attempts, last_error FROM edge.fiscal_receipts`)).rows[0];
  assert.equal(row.status, 'printed');
  assert.equal(row.attempts, 3);
  assert.equal(row.last_error, null);
  assert.equal(fiscal.calls, 3);
  assert.deepEqual(await fiscalOutboxStatuses(), ['pending', 'signed', 'printed']);
});

test('unknown (non-FiscalError) errors are treated as retryable', async () => {
  fiscal.failWith = (_req, call) => (call === 1 ? new Error('ECONNREFUSED') : null);
  await upload([pumpTx()]);
  await drainPipeline();
  assert.equal((await gw.pool.query(`SELECT status FROM edge.fiscal_receipts`)).rows[0].status, 'printed');
});

test('non-retryable error marks failed, raises alert, refiscalise requeues', async () => {
  fiscal.failWith = () => new FiscalError('invalid item code', false, 'E_ITEM');
  await upload([pumpTx()]);
  await drainPipeline();
  const row = (await gw.pool.query(`SELECT f.id, f.status, f.last_error_code, t.fiscal_status FROM edge.fiscal_receipts f JOIN edge.transactions t ON t.id=f.transaction_id`)).rows[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.fiscal_status, 'failed');
  assert.equal(row.last_error_code, 'E_ITEM');
  assert.equal(fiscal.calls, 1);
  assert.equal(await count(gw, `SELECT count(*) n FROM edge.alerts WHERE code='FiscalisationFailed' AND severity='critical'`), 1);
  assert.equal(await count(gw, `SELECT count(*) n FROM edge.outbox WHERE kind='alert' AND data->>'code'='FiscalisationFailed'`), 1);
  assert.deepEqual(await fiscalOutboxStatuses(), ['pending', 'failed']);
  // failed receipts are not retried automatically
  assert.equal(await gw.pipeline.runOnce(), 0);

  // cloud refiscalise command resets it; then it succeeds
  fiscal.failWith = null;
  const tx = (await gw.pool.query(`SELECT pump_no, pts_transaction_no, ended_at FROM edge.transactions`)).rows[0];
  await gw.commands.receive([{ id: 'cmd-refisc-1', type: 'refiscalise', pump_no: tx.pump_no, pts_transaction_no: tx.pts_transaction_no, tx_ended_at: new Date(tx.ended_at).toISOString() }]);
  await drainPipeline();
  assert.equal((await gw.pool.query(`SELECT status FROM edge.fiscal_receipts`)).rows[0].status, 'printed');
  const cmd = (await gw.pool.query(`SELECT status FROM edge.commands_applied WHERE id='cmd-refisc-1'`)).rows[0];
  assert.equal(cmd.status, 'applied');
});

test('print failure keeps receipt signed and retries printing only', async () => {
  let failNext = true;
  printer.failWith = () => {
    if (!failNext) return null;
    failNext = false;
    return new Error('paper out');
  };
  await upload([pumpTx()]);
  await gw.pipeline.runOnce();
  let row = (await gw.pool.query(`SELECT status, print_attempts, last_error_code FROM edge.fiscal_receipts`)).rows[0];
  assert.equal(row.status, 'signed');
  assert.equal(row.last_error_code, 'PRINT');
  await drainPipeline();
  row = (await gw.pool.query(`SELECT status, print_attempts FROM edge.fiscal_receipts`)).rows[0];
  assert.equal(row.status, 'printed');
  assert.equal(fiscal.calls, 1, 'not re-signed');
  assert.equal(printer.printed.length, 1);
});

test('missing ZRA item mapping is retryable with a config alert', async () => {
  await upload([pumpTx({ FuelGradeId: 9, FuelGradeName: 'Kerosene' })]);
  await gw.pipeline.runOnce();
  const row = (await gw.pool.query(`SELECT status, last_error_code FROM edge.fiscal_receipts`)).rows[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.last_error_code, 'CONFIG');
  assert.equal(fiscal.calls, 0);
  assert.equal(await count(gw, `SELECT count(*) n FROM edge.alerts WHERE code='FiscalConfigMissing'`), 1);
});

test('concurrent workers (SKIP LOCKED) sign every receipt exactly once', async () => {
  const packets = Array.from({ length: 40 }, (_, i) => pumpTx({ Pump: (i % 4) + 1 }));
  await upload(packets);
  const second = new FiscalPipeline(gw.pool, gw.cfg, gw.config, fiscal, printer, gw.log, gw.metrics);
  const third = new FiscalPipeline(gw.pool, gw.cfg, gw.config, fiscal, printer, gw.log, gw.metrics);
  await Promise.all([drainPipeline(gw.pipeline), drainPipeline(second), drainPipeline(third)]);
  assert.equal(await count(gw, `SELECT count(*) n FROM edge.fiscal_receipts WHERE status='printed'`), 40);
  assert.equal(fiscal.calls, 40);
  assert.equal(printer.printed.length, 40);
  assert.equal(new Set(printer.printed.map((d) => d.invoice_no)).size, 40);
});

test('pipeline survives restart: expired lease is reclaimed', async () => {
  await upload([pumpTx()]);
  // simulate a crash after claiming: lease set, process died
  await gw.pool.query(`UPDATE edge.fiscal_receipts SET lease_until = now() + interval '1 hour'`);
  assert.equal(await gw.pipeline.runOnce(), 0);
  await gw.pool.query(`UPDATE edge.fiscal_receipts SET lease_until = now() - interval '1 second'`);
  await drainPipeline();
  assert.equal((await gw.pool.query(`SELECT status FROM edge.fiscal_receipts`)).rows[0].status, 'printed');
});

test('reprint endpoint on the local UI', async () => {
  await upload([pumpTx()]);
  await drainPipeline();
  const id = (await gw.pool.query(`SELECT id FROM edge.fiscal_receipts`)).rows[0].id;
  const r = await gw.uiServer.inject({ method: 'POST', url: `/api/fiscal/${id}/reprint` });
  assert.equal(r.statusCode, 200);
  assert.equal(printer.printed.length, 2);
  assert.equal(printer.printed[0].signature.signature, printer.printed[1].signature.signature);
  assert.equal((await gw.pool.query(`SELECT reprint_count FROM edge.fiscal_receipts`)).rows[0].reprint_count, 1);
  const missing = await gw.uiServer.inject({ method: 'POST', url: `/api/fiscal/999999/reprint` });
  assert.equal(missing.statusCode, 404);
});

test('worker loop picks up new sales automatically (kick)', async () => {
  gw.pipeline.start();
  try {
    await upload([pumpTx(), pumpTx()]);
    await waitFor(async () => (await count(gw, `SELECT count(*) n FROM edge.fiscal_receipts WHERE status='printed'`)) === 2, 5000);
  } finally {
    await gw.pipeline.stop();
  }
});
