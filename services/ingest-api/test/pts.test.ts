import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hmacSha256Hex } from '@fms/shared';
import { ptsLocal, randomRecent, randomTxNo, SEED, setup } from './helpers.js';

const ctx = setup();
after(() => ctx.close());

function txPacket(id: number, o: Record<string, unknown> = {}) {
  const end = randomRecent();
  return {
    Id: id,
    Type: 'UploadPumpTransaction',
    Data: {
      Pump: 1,
      Nozzle: 1,
      FuelGradeId: 1,
      FuelGradeName: 'Unleaded Petrol',
      Transaction: randomTxNo(),
      DateTimeStart: ptsLocal(new Date(end.getTime() - 60_000)),
      DateTime: ptsLocal(end),
      Volume: 25.5,
      TCVolume: 25.3,
      Price: 31.85,
      Amount: 812.18,
      Tag: null,
      ...o,
    },
  };
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return ctx.app.inject({ method: 'POST', url: '/ingest/pts', payload, headers: { 'content-type': 'application/json', ...headers } });
}

async function countTx(stationId: string, txNo: number) {
  const { rows } = await ctx.pool.query(
    'SELECT count(*)::int n FROM fms.pump_transactions WHERE station_id = $1 AND pts_transaction_no = $2',
    [stationId, txNo],
  );
  return rows[0].n as number;
}

describe('POST /ingest/pts (direct jsonPTS)', () => {
  before(async () => {
    await ctx.app.ready();
  });

  test('signed upload from LUS-0001 is persisted, archived and replied OK', async () => {
    const pk = txPacket(1);
    const raw = JSON.stringify({ Protocol: 'jsonPTS', PtsId: SEED.lus.ptsId, Packets: [pk] });
    const res = await post(raw, { 'x-pts-signature': hmacSha256Hex(SEED.lus.secret, raw) });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.deepEqual(body.Packets, [{ Id: 1, Type: 'UploadPumpTransaction', Error: false, Message: 'OK' }]);
    const txNo = pk.Data.Transaction as number;
    const { rows } = await ctx.pool.query(
      `SELECT product_code, tank_no, volume_l, source, ended_at FROM fms.pump_transactions WHERE station_id = $1 AND pts_transaction_no = $2`,
      [SEED.lus.stationId, txNo],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].product_code, 'PETROL');
    assert.equal(rows[0].tank_no, 1);
    assert.equal(rows[0].volume_l, 25.5);
    assert.equal(rows[0].source, 'pts_direct');
    // local time +02:00 converted to UTC
    assert.equal(new Date(rows[0].ended_at).toISOString().slice(0, 19), new Date(Date.parse(pk.Data.DateTime + '+02:00')).toISOString().slice(0, 19));
    const rawRows = await ctx.pool.query(
      `SELECT count(*)::int n FROM fms.ingest_raw WHERE source = 'pts_direct' AND pts_id = $1 AND payload->'Data'->>'Transaction' = $2`,
      [SEED.lus.ptsId, String(txNo)],
    );
    assert.equal(rawRows.rows[0].n, 1);
    const ctl = await ctx.pool.query(`SELECT last_seen_at > now() - interval '1 minute' AS fresh FROM fms.controllers WHERE pts_id = $1`, [SEED.lus.ptsId]);
    assert.equal(ctl.rows[0].fresh, true);
    // LUS-0001 is an edge-mode station: the edge fiscalises, so no cloud fiscalise job.
    const jobs = await ctx.pool.query(`SELECT count(*)::int n FROM fms.jobs WHERE kind = 'fiscalise' AND payload->>'pts_transaction_no' = $1`, [String(txNo)]);
    assert.equal(jobs.rows[0].n, 0);
  });

  test('bad signature is rejected with a 401 jsonPTS error and nothing is stored', async () => {
    const pk = txPacket(7);
    const raw = JSON.stringify({ Protocol: 'jsonPTS', PtsId: SEED.lus.ptsId, Packets: [pk] });
    const res = await post(raw, { 'x-pts-signature': hmacSha256Hex('wrong-secret', raw) });
    assert.equal(res.statusCode, 401);
    const p = res.json().Packets[0];
    assert.equal(p.Id, 7);
    assert.equal(p.Error, true);
    assert.equal(p.Code, 401);
    assert.equal(await countTx(SEED.lus.stationId, pk.Data.Transaction as number), 0);
    // missing signature on a controller with a secret is also rejected
    const res2 = await post(raw);
    assert.equal(res2.statusCode, 401);
  });

  test('unknown controller is rejected', async () => {
    const res = await post({ Protocol: 'jsonPTS', PtsId: '00000000000000000000DEAD', Packets: [txPacket(1)] });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().Packets[0].Error, true);
    assert.match(res.json().Packets[0].Message, /unknown controller/);
  });

  test('controller identified by X-Pts-Id header; duplicate resend is idempotent and still OK', async () => {
    const pk = txPacket(3);
    const body = { Protocol: 'jsonPTS', Packets: [pk] };
    const r1 = await post(body, { 'x-pts-id': SEED.cen.ptsId });
    const r2 = await post(body, { 'x-pts-id': SEED.cen.ptsId });
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 200);
    assert.equal(r1.json().Packets[0].Message, 'OK');
    assert.equal(r2.json().Packets[0].Message, 'OK');
    assert.equal(await countTx(SEED.cen.stationId, pk.Data.Transaction as number), 1);
  });

  test('direct-mode station (CEN-0001) enqueues one fiscalise job per new sale', async () => {
    const pk = txPacket(1, { Pump: 2, Nozzle: 2, FuelGradeId: 2, Price: 29.95, Amount: 763.73 });
    const body = { Protocol: 'jsonPTS', PtsId: SEED.cen.ptsId, Packets: [pk] };
    assert.equal((await post(body)).statusCode, 200);
    assert.equal((await post(body)).statusCode, 200);
    const endedIso = new Date(Date.parse(pk.Data.DateTime + '+02:00')).toISOString();
    const key = `fiscalise:${SEED.cen.stationId}:2:${pk.Data.Transaction}:${endedIso}`;
    const { rows } = await ctx.pool.query(`SELECT kind, status, payload FROM fms.jobs WHERE dedupe_key = $1`, [key]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'queued');
    assert.equal(rows[0].payload.pts_transaction_no, pk.Data.Transaction);
    const tx = await ctx.pool.query(
      `SELECT product_code, tank_no FROM fms.pump_transactions WHERE station_id = $1 AND pts_transaction_no = $2`,
      [SEED.cen.stationId, pk.Data.Transaction],
    );
    assert.deepEqual(tx.rows[0], { product_code: 'DIESEL', tank_no: 2 });
    // a rollup job exists for the station-day
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lusaka' }).format(new Date(endedIso));
    const r = await ctx.pool.query(`SELECT status FROM fms.jobs WHERE dedupe_key = $1`, [`rollup:${SEED.cen.stationId}:${day}`]);
    assert.equal(r.rows.length, 1);
  });

  test('malformed packets fail individually; good packets in the same request are committed', async () => {
    const good = txPacket(1);
    const body = {
      Protocol: 'jsonPTS',
      PtsId: SEED.cen.ptsId,
      Packets: [
        good,
        { Id: 2, Type: 'UploadPumpTransaction', Data: { Pump: 1 } },
        { Id: 3, Type: 'UploadSomethingElse', Data: {} },
        { Id: 4, Type: 'UploadGpsRecord', Data: { Latitude: -15.4 } },
        { Id: 5, Type: 'UploadStatus', Data: { Pumps: [{ Id: 1, Status: 'Idle' }] } },
      ],
    };
    const res = await post(body);
    assert.equal(res.statusCode, 200);
    const p = res.json().Packets;
    assert.equal(p[0].Error, false);
    assert.equal(p[1].Error, true);
    assert.match(p[1].Message, /Transaction|Nozzle|DateTime|Volume/);
    assert.equal(p[2].Error, true);
    assert.match(p[2].Message, /unsupported/);
    assert.equal(p[3].Error, false); // GPS accepted, stored raw only
    assert.equal(p[4].Error, false);
    assert.equal(await countTx(SEED.cen.stationId, good.Data.Transaction as number), 1);
    const st = await ctx.pool.query(`SELECT last_status FROM fms.controllers WHERE pts_id = $1`, [SEED.cen.ptsId]);
    assert.deepEqual(st.rows[0].last_status, { Pumps: [{ Id: 1, Status: 'Idle' }] });
  });

  test('invalid JSON → 400', async () => {
    const res = await post('{not json', { 'x-pts-id': SEED.cen.ptsId });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().Protocol, 'jsonPTS');
  });
});
