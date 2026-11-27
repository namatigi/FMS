import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Gateway } from '../app.js';
import { PtsControlClient } from '../pts/control.js';
import { pruneOutbox } from '../retention.js';
import { count, ensureTestDb, newGateway, ptsBody, pumpTx, signedHeaders, startFakeCloud, truncateAll, waitFor, type FakeCloud } from './helpers.js';

let gw: Gateway;
let cloud: FakeCloud;
const ptsCalls: Array<{ url: string; body: { Packets: Array<{ Type: string; Data?: Record<string, unknown> }> } }> = [];
let ptsDown = false;

// Fake PTS-2 web server (fetch stub) for set_prices.
const fakePtsFetch: typeof fetch = async (input, init) => {
  if (ptsDown) throw new Error('connect ECONNREFUSED');
  const body = JSON.parse(String(init?.body));
  ptsCalls.push({ url: String(input), body });
  const p = body.Packets[0];
  const data = p.Type === 'GetFuelGradesConfiguration'
    ? { FuelGrades: [{ Id: 1, Name: 'Unleaded Petrol', Price: 31.85, ExpansionCoefficient: 0.0012 }, { Id: 2, Name: 'Diesel LSD', Price: 29.95 }] }
    : undefined;
  return new Response(JSON.stringify({ Protocol: 'jsonPTS', Packets: [{ Id: p.Id, Type: p.Type, Error: false, Message: 'OK', Data: data }] }), { status: 200 });
};

before(async () => {
  await ensureTestDb();
  cloud = await startFakeCloud();
  ({ gw } = await newGateway({ SYNC_BATCH_MAX_RECORDS: '25' }, {
    controlClientFor: (id) => new PtsControlClient({ pts_id: id, secret: null, control_url: 'http://192.168.1.117', control_user: 'admin', control_password: 'admin' }, gw.log, 1000, fakePtsFetch),
  }));
});
after(async () => {
  await gw.stop();
  await cloud.close();
});
beforeEach(async () => {
  await truncateAll(gw.pool);
  cloud.mode = 'ok';
  cloud.reject = null;
  cloud.batches.length = 0;
  cloud.acceptedSeqs.clear();
  cloud.store.clear();
  cloud.pendingCommands.length = 0;
  ptsCalls.length = 0;
  ptsDown = false;
  gw.sync.state.consecutiveFailures = 0;
});

async function upload(n: number) {
  const packets = Array.from({ length: n }, () => pumpTx());
  const body = ptsBody(packets);
  const r = await gw.ptsServer.inject({ method: 'POST', url: '/jsonPTS', payload: body, headers: signedHeaders(body) });
  assert.equal(r.statusCode, 200);
  return packets;
}

async function drainSync(maxRounds = 100) {
  for (let i = 0; i < maxRounds; i++) {
    const r = await gw.sync.syncOnce();
    if (r.sent === 0) return;
  }
}

const unsent = () => count(gw, `SELECT count(*) n FROM edge.outbox WHERE sent_at IS NULL AND parked_at IS NULL`);

test('accept: outbox drained in seq order in batches of <= max records, gzip + auth headers', async () => {
  await upload(30); // 30 tx + 30 fiscal_receipt pending = 60 records
  await drainSync();
  assert.equal(await unsent(), 0);
  assert.equal(cloud.acceptedSeqs.size, 60);
  assert.ok(cloud.batches.length >= 3);
  assert.ok(cloud.batches.every((b) => b.records.length <= 25 && b.gateway_code === 'GW-LUS-0001' && b.station_code === 'LUS-0001'));
  assert.ok(cloud.gzipped >= 3);
  const seqs = cloud.batches.flatMap((b) => b.records.map((r) => r.seq));
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.ok([...cloud.acceptedSeqs.values()].every((v) => v === 1), 'no duplicates');
});

test('byte limit splits batches', async () => {
  gw.cfg.cloud.batchMaxBytes = 2000;
  try {
    await upload(10);
    await drainSync();
    assert.equal(await unsent(), 0);
    assert.ok(cloud.batches.length >= 5, `batches ${cloud.batches.length}`);
  } finally {
    gw.cfg.cloud.batchMaxBytes = 1024 * 1024;
  }
});

test('partial reject: non-retryable parked, retryable resent until accepted', async () => {
  await upload(5);
  const seqs = (await gw.pool.query(`SELECT seq FROM edge.outbox ORDER BY seq`)).rows.map((r) => Number(r.seq));
  const bad = seqs[1];
  const flaky = seqs[3];
  cloud.reject = (rec, seen) => {
    if (rec.seq === bad) return { error: 'unknown nozzle', retryable: false };
    if (rec.seq === flaky && seen < 2) return { error: 'db busy', retryable: true };
    return null;
  };
  await drainSync();
  await new Promise((r) => setTimeout(r, 10));
  await drainSync();
  const parked = (await gw.pool.query(`SELECT seq, last_error FROM edge.outbox WHERE parked_at IS NOT NULL`)).rows;
  assert.deepEqual(parked.map((r) => Number(r.seq)), [bad]);
  assert.equal(parked[0].last_error, 'unknown nozzle');
  assert.equal(await unsent(), 0);
  assert.equal(cloud.acceptedSeqs.get(flaky), 1);
  assert.equal(cloud.acceptedSeqs.size, seqs.length - 1);
  // operator un-parks via UI -> resent
  cloud.reject = null;
  const r = await gw.uiServer.inject({ method: 'POST', url: '/api/outbox/unpark' });
  assert.equal(r.json().requeued, 1);
  await drainSync();
  assert.equal(cloud.acceptedSeqs.get(bad), 1);
});

test('outage then recovery: no loss, no duplicates (sync loop with backoff)', async () => {
  cloud.mode = 'down';
  gw.sync.start();
  try {
    const sent = await upload(20);
    await waitFor(() => gw.sync.state.consecutiveFailures >= 2, 5000);
    assert.equal(gw.sync.state.connected, false);
    assert.match(gw.sync.state.lastError ?? '', /503/);
    // connection drops mid-request too
    cloud.mode = 'drop';
    await upload(5);
    await waitFor(() => gw.sync.state.consecutiveFailures >= 3, 5000);
    assert.equal(cloud.acceptedSeqs.size, 0);
    cloud.mode = 'ok';
    const total = await count(gw, 'SELECT count(*) n FROM edge.outbox');
    await waitFor(async () => (await unsent()) === 0, 10_000);
    assert.equal(cloud.acceptedSeqs.size, total);
    assert.ok([...cloud.acceptedSeqs.values()].every((v) => v === 1), 'each seq accepted once');
    const txKeys = [...cloud.store.keys()].filter((k) => k.startsWith('tx:'));
    assert.equal(txKeys.length, sent.length + 5);
    assert.equal(gw.sync.state.connected, true);
    const attempts = (await gw.pool.query(`SELECT max(attempts) m FROM edge.outbox`)).rows[0].m;
    assert.ok(attempts >= 1);
  } finally {
    await gw.sync.stop();
  }
});

test('resending after a lost response is harmless (idempotent cloud keys)', async () => {
  await upload(3);
  // cloud persists but the gateway never sees the response -> it resends
  const rows = (await gw.pool.query(`SELECT seq, kind, data FROM edge.outbox ORDER BY seq`)).rows;
  for (const r of rows) cloud.store.set(`${r.kind}:${r.seq}`, r);
  await drainSync();
  const keys = [...cloud.store.keys()].filter((k) => k.startsWith('tx:'));
  assert.equal(keys.length, 3);
});

test('heartbeat replaces older unsent heartbeat and carries backlog counts', async () => {
  await upload(2);
  await gw.sync.emitHeartbeat();
  await gw.sync.emitHeartbeat();
  const hb = (await gw.pool.query(`SELECT data FROM edge.outbox WHERE kind='heartbeat'`)).rows;
  assert.equal(hb.length, 1);
  assert.equal(hb[0].data.backlog, 5); // 2 tx + 2 fiscal + the previous (replaced) heartbeat
  assert.equal(hb[0].data.fiscal_backlog, 2);
  assert.deepEqual(hb[0].data.controllers_online, ['003B00265030500420303531']);
  assert.ok(typeof hb[0].data.uptime_s === 'number');
});

test('commands: set_prices forwarded to PTS-2 and idempotent by id; reload_config; unknown type', async () => {
  cloud.pendingCommands.push(
    { id: 'cmd-price-1', type: 'set_prices', prices: [{ pts_grade_id: 1, price: 32.1 }], effective_at: new Date(Date.now() - 1000).toISOString() },
    { id: 'cmd-reload-1', type: 'reload_config' },
    { id: 'cmd-x', type: 'explode' } as never,
  );
  await upload(1);
  await drainSync();
  const cmds = (await gw.pool.query(`SELECT id, status FROM edge.commands_applied ORDER BY id`)).rows;
  assert.deepEqual(cmds.map((c) => [c.id, c.status]), [['cmd-price-1', 'applied'], ['cmd-reload-1', 'applied'], ['cmd-x', 'failed']]);
  assert.deepEqual(ptsCalls.map((c) => c.body.Packets[0].Type), ['GetFuelGradesConfiguration', 'SetFuelGradesConfiguration']);
  assert.equal(ptsCalls[0].url, 'http://192.168.1.117/jsonPTS');
  const set = ptsCalls[1].body.Packets[0].Data as { FuelGrades: Array<{ Id: number; Price: number; ExpansionCoefficient?: number }> };
  assert.deepEqual(set.FuelGrades.find((g) => g.Id === 1), { Id: 1, Name: 'Unleaded Petrol', Price: 32.1, ExpansionCoefficient: 0.0012 });
  assert.equal(gw.config.grade(1)?.price, 32.1);

  // acks go through the outbox: 'received' on store, then the final state, in that order
  const acks = async () =>
    (await gw.pool.query(`SELECT data FROM edge.outbox WHERE kind='command_ack' ORDER BY seq`)).rows.map(
      (r) => `${r.data.command_id}:${r.data.status}`,
    );
  const first = await acks();
  for (const [id, final] of [['cmd-price-1', 'applied'], ['cmd-reload-1', 'applied'], ['cmd-x', 'failed']]) {
    assert.ok(first.indexOf(`${id}:received`) >= 0 && first.indexOf(`${id}:received`) < first.indexOf(`${id}:${final}`), `${id} acks: ${first}`);
  }
  const failedAck = (await gw.pool.query(`SELECT data FROM edge.outbox WHERE kind='command_ack' AND data->>'command_id'='cmd-x' AND data->>'status'='failed'`)).rows[0];
  assert.match(String(failedAck.data.result.error), /unknown command type/);
  assert.equal((await gw.pool.query(`SELECT count(*)::int n FROM edge.outbox WHERE kind='command_ack' AND sent_at IS NULL`)).rows[0].n, 0, 'acks synced');

  // the same command delivered again is ignored, but its current state is re-acked
  cloud.pendingCommands.push({ id: 'cmd-price-1', type: 'set_prices', prices: [{ pts_grade_id: 1, price: 99 }], effective_at: new Date().toISOString() });
  await upload(1);
  await drainSync();
  assert.equal(ptsCalls.length, 2);
  assert.equal(gw.config.grade(1)?.price, 32.1);
  const after = await acks();
  assert.equal(after.length, first.length + 1);
  assert.equal(after.at(-1), 'cmd-price-1:applied');
});

test('set_prices scheduled for the future and retried while the PTS-2 is unreachable', async () => {
  await gw.commands.receive([{ id: 'cmd-future', type: 'set_prices', prices: [{ pts_grade_id: 2, price: 30.5 }], effective_at: new Date(Date.now() + 3600_000).toISOString() }]);
  assert.equal((await gw.pool.query(`SELECT status FROM edge.commands_applied WHERE id='cmd-future'`)).rows[0].status, 'scheduled');
  assert.equal(ptsCalls.length, 0);

  ptsDown = true;
  await gw.commands.receive([{ id: 'cmd-now', type: 'set_prices', prices: [{ pts_grade_id: 2, price: 30.1 }], effective_at: new Date().toISOString() }]);
  let row = (await gw.pool.query(`SELECT status, attempts, due_at > now() AS later FROM edge.commands_applied WHERE id='cmd-now'`)).rows[0];
  assert.deepEqual([row.status, row.attempts, row.later], ['scheduled', 1, true]);
  ptsDown = false;
  await gw.pool.query(`UPDATE edge.commands_applied SET due_at = now() WHERE id='cmd-now'`);
  await gw.commands.runDue();
  row = (await gw.pool.query(`SELECT status FROM edge.commands_applied WHERE id='cmd-now'`)).rows[0];
  assert.equal(row.status, 'applied');
  assert.equal(gw.config.grade(2)?.price, 30.1);
});

test('standby instance does not sync', async () => {
  await upload(2);
  const original = gw.ha.isActive.bind(gw.ha);
  (gw.ha as unknown as { isActive: () => boolean }).isActive = () => false;
  try {
    await gw.sync.emitHeartbeat(); // ignored when standby
    assert.equal(await count(gw, `SELECT count(*) n FROM edge.outbox WHERE kind='heartbeat'`), 0);
  } finally {
    (gw.ha as unknown as { isActive: () => boolean }).isActive = original;
  }
});

test('retention prunes only sent rows older than the window', async () => {
  await upload(2);
  await drainSync();
  await upload(1);
  await gw.pool.query(`UPDATE edge.outbox SET sent_at = now() - interval '31 days' WHERE sent_at IS NOT NULL`);
  const deleted = await pruneOutbox(gw.pool, 30);
  assert.equal(deleted, 4);
  assert.equal(await count(gw, 'SELECT count(*) n FROM edge.outbox'), 2);
});
