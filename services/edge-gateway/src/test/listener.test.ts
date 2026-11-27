import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { count, ensureTestDb, newGateway, PTS_ID, ptsBody, pumpTx, signedHeaders, truncateAll } from './helpers.js';
import type { Gateway } from '../app.js';

let gw: Gateway;

before(async () => {
  await ensureTestDb();
  ({ gw } = await newGateway());
});
after(async () => {
  await gw.stop();
});
beforeEach(async () => {
  await truncateAll(gw.pool);
});

async function post(body: string, headers: Record<string, string>, url = '/jsonPTS') {
  const res = await gw.ptsServer.inject({ method: 'POST', url, payload: body, headers });
  return { status: res.statusCode, json: res.json() as { Error?: boolean; Message?: string; Packets: Array<{ Id: number; Error: boolean; Message: string }> } };
}

test('valid signature: packet stored with outbox + pending fiscal receipt, replied OK', async () => {
  const p = pumpTx();
  const body = ptsBody([p]);
  const r = await post(body, signedHeaders(body));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.Packets.map((x) => [x.Id, x.Error, x.Message]), [[p.Id, false, 'OK']]);
  assert.equal(await count(gw, 'SELECT count(*) n FROM edge.transactions'), 1);
  assert.equal(await count(gw, `SELECT count(*) n FROM edge.outbox WHERE kind='pump_transaction'`), 1);
  assert.equal(await count(gw, `SELECT count(*) n FROM edge.outbox WHERE kind='fiscal_receipt'`), 1);
  const inv = await gw.pool.query(`SELECT invoice_no, status FROM edge.fiscal_receipts`);
  // 10:mm:ss Lusaka local time; invoice uses the local wall-clock stamp
  assert.match(inv.rows[0].invoice_no, new RegExp(`^LUS-0001-P3-${p.Data.Transaction}-20261127${String(p.Data.DateTime).slice(11).replace(/:/g, '')}$`));
  assert.equal(inv.rows[0].status, 'pending');
});

test('bad or missing signature is rejected and nothing is stored', async () => {
  const body = ptsBody([pumpTx()]);
  const bad = await post(body, { ...signedHeaders(body, 'wrong-secret') });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.Packets[0].Error, true);
  const missing = await post(body, { 'content-type': 'application/json' });
  assert.equal(missing.status, 401);
  // body tampered after signing
  const tampered = body.replace('"Volume":20.5', '"Volume":2.5');
  const t = await post(tampered, signedHeaders(body));
  assert.equal(t.status, 401);
  assert.equal(await count(gw, 'SELECT count(*) n FROM edge.transactions'), 0);
  assert.equal(await count(gw, 'SELECT count(*) n FROM edge.outbox'), 0);
});

test('controller identified by X-Pts-Id header; unknown controller is refused', async () => {
  const p = pumpTx();
  const body = JSON.stringify({ Protocol: 'jsonPTS', Packets: [p] });
  const r = await post(body, { ...signedHeaders(body), 'x-pts-id': PTS_ID });
  assert.equal(r.status, 200);
  assert.equal(r.json.Packets[0].Error, false);
  const other = ptsBody([pumpTx()], '003B00265030500420309999');
  const u = await post(other, signedHeaders(other));
  assert.equal(u.status, 403);
});

test('idempotent resubmission: same packets re-sent are confirmed but stored once', async () => {
  const packets = [pumpTx(), pumpTx(), {
    Id: 77, Type: 'UploadTankMeasurement',
    Data: { DateTime: '2026-11-27T10:05:00', Tank: 1, FuelGradeId: 1, ProductHeight: 1200, ProductVolume: 15000.5, ProductUllage: 15000, Temperature: 24.1, WaterHeight: 8, Alarms: [] },
  }];
  const body = ptsBody(packets);
  for (let i = 0; i < 3; i++) {
    const r = await post(body, signedHeaders(body), i === 1 ? '/ingest/pts' : '/jsonPTS');
    assert.equal(r.status, 200);
    assert.ok(r.json.Packets.every((x) => x.Error === false));
  }
  assert.equal(await count(gw, 'SELECT count(*) n FROM edge.transactions'), 2);
  assert.equal(await count(gw, 'SELECT count(*) n FROM edge.tank_measurements'), 1);
  assert.equal(await count(gw, 'SELECT count(*) n FROM edge.fiscal_receipts'), 2);
  assert.equal(await count(gw, 'SELECT count(*) n FROM edge.outbox'), 5); // 2 tx + 2 fiscal + 1 tank
  assert.equal(await count(gw, 'SELECT count(*) n FROM edge.tank_latest'), 1);
});

test('malformed packet -> Error=true for that packet only; GPS/config ignored with OK; unknown type error', async () => {
  const good = pumpTx();
  const packets = [
    good,
    { Id: 501, Type: 'UploadPumpTransaction', Data: { Pump: 1 } },
    { Id: 502, Type: 'UploadGpsRecord', Data: { Latitude: 1 } },
    { Id: 503, Type: 'UploadConfiguration', Data: {} },
    { Id: 504, Type: 'Bogus' },
    { Id: 505, Type: 'UploadStatus', Data: { Pumps: [] } },
  ];
  const body = ptsBody(packets);
  const r = await post(body, signedHeaders(body));
  assert.equal(r.status, 200);
  const byId = new Map(r.json.Packets.map((p) => [p.Id, p]));
  assert.equal(byId.get(good.Id)!.Error, false);
  assert.equal(byId.get(501)!.Error, true);
  assert.match(byId.get(501)!.Message, /missing/);
  assert.equal(byId.get(502)!.Error, false);
  assert.equal(byId.get(503)!.Error, false);
  assert.equal(byId.get(504)!.Error, true);
  assert.equal(byId.get(505)!.Error, false);
  assert.equal(await count(gw, 'SELECT count(*) n FROM edge.transactions'), 1);
  assert.equal(await count(gw, `SELECT count(*) n FROM edge.controllers WHERE last_status IS NOT NULL`), 1);
});

test('invalid JSON -> 400 with Error', async () => {
  const body = '{"Protocol":"jsonPTS", Packets: [';
  const r = await post(body, signedHeaders(body));
  assert.equal(r.status, 400);
  assert.equal(r.json.Error, true);
});

test('zero-volume transaction is stored as exempt without a fiscal receipt', async () => {
  const p = pumpTx({ Volume: 0, Amount: 0 });
  const body = ptsBody([p]);
  const r = await post(body, signedHeaders(body));
  assert.equal(r.json.Packets[0].Error, false);
  const t = await gw.pool.query(`SELECT fiscal_status FROM edge.transactions`);
  assert.equal(t.rows[0].fiscal_status, 'exempt');
  assert.equal(await count(gw, 'SELECT count(*) n FROM edge.fiscal_receipts'), 0);
});

test('totaliser jump raises a local TotalizerMismatch alert; tank alarms become local alerts', async () => {
  const a = pumpTx({ Pump: 1, TotalVolume: 5000 });
  const b = pumpTx({ Pump: 1, TotalVolume: 5000 + 20.5 + 40 }); // 40 L dispensed in manual mode
  const m = { Id: 900, Type: 'UploadTankMeasurement', Data: { DateTime: '2026-11-27T11:00:00', Tank: 2, ProductVolume: 3000, Alarms: ['CriticalLowProduct'] } };
  const body = ptsBody([a, b, m]);
  await post(body, signedHeaders(body));
  const al = await gw.pool.query(`SELECT code, severity FROM edge.alerts ORDER BY code`);
  assert.deepEqual(al.rows.map((x) => [x.code, x.severity]), [['CriticalLowProduct', 'critical'], ['TotalizerMismatch', 'critical']]);
});
