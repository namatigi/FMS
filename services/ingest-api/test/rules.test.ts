import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createFixtureStation, edgeBatch, edgeHeaders, pumpTx, setup, tankMeasurement, type Fixture } from './helpers.js';

const ctx = setup();
after(() => ctx.close());

let seq = 1;
async function send(f: Fixture, records: Array<Record<string, unknown>>) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/ingest/v1/edge/batches',
    headers: edgeHeaders(f),
    payload: JSON.stringify(edgeBatch(f, records.map((r) => ({ seq: seq++, ...r })))),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().rejected, []);
  return res.json();
}

describe('persistence rules', () => {
  before(() => ctx.app.ready());

  test('totaliser continuity: TotalizerMismatch critical alert with expected/actual/unaccounted', async () => {
    const f = await createFixtureStation(ctx.pool, 'edge');
    const t0 = Date.now() - 3 * 3600_000;
    const at = (m: number) => new Date(t0 + m * 60_000).toISOString();
    await send(f, [
      pumpTx(f.ptsId, { ended_at: at(0), volume_l: 10, amount: 318.5, total_volume_l: 1000 }),
      pumpTx(f.ptsId, { ended_at: at(10), volume_l: 20, amount: 637, total_volume_l: 1025 }), // 5 L unaccounted
    ]);
    await send(f, [pumpTx(f.ptsId, { ended_at: at(20), volume_l: 5, amount: 159.25, total_volume_l: 1030.2 })]); // 0.2 L ok
    // a different nozzle has its own totaliser
    await send(f, [pumpTx(f.ptsId, { ended_at: at(30), nozzle_no: 2, pts_grade_id: 2, volume_l: 5, amount: 150, total_volume_l: 500 })]);

    const { rows } = await ctx.pool.query(`SELECT code, severity, device_type, device_no, data, occurred_at FROM fms.alerts WHERE station_id = $1`, [f.stationId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].code, 'TotalizerMismatch');
    assert.equal(rows[0].severity, 'critical');
    assert.equal(rows[0].device_type, 'pump');
    assert.equal(rows[0].device_no, 1);
    assert.equal(rows[0].data.expected, 1020);
    assert.equal(rows[0].data.actual, 1025);
    assert.equal(rows[0].data.unaccounted_l, 5);
    assert.equal(new Date(rows[0].occurred_at).toISOString(), at(10));
    const jobs = await ctx.pool.query(`SELECT kind FROM fms.jobs WHERE payload->>'station_id' = $1 AND kind IN ('notify','webhook') ORDER BY kind`, [f.stationId]);
    assert.deepEqual(jobs.rows.map((r) => r.kind), ['notify', 'webhook']);
  });

  test('low stock: alert + stock_low webhook only when crossing below low_level_l', async () => {
    const f = await createFixtureStation(ctx.pool, 'edge'); // tank 1 PETROL low_level_l = 6000
    const t0 = Date.now() - 2 * 3600_000;
    const at = (m: number) => new Date(t0 + m * 60_000).toISOString();
    await send(f, [tankMeasurement(f.ptsId, { measured_at: at(0), product_volume_l: 10000 })]);
    await send(f, [tankMeasurement(f.ptsId, { measured_at: at(10), product_volume_l: 5500 })]); // crosses
    await send(f, [tankMeasurement(f.ptsId, { measured_at: at(20), product_volume_l: 5000 })]); // still low, no new alert
    // an out-of-order older reading does not move tank_latest backwards
    await send(f, [tankMeasurement(f.ptsId, { measured_at: at(5), product_volume_l: 9000 })]);

    const al = await ctx.pool.query(`SELECT id, code, severity, data FROM fms.alerts WHERE station_id = $1`, [f.stationId]);
    assert.equal(al.rows.length, 1);
    assert.equal(al.rows[0].code, 'LowStock');
    assert.equal(al.rows[0].severity, 'warning');
    assert.equal(al.rows[0].data.product_volume_l, 5500);
    assert.equal(al.rows[0].data.low_level_l, 6000);
    const wh = await ctx.pool.query(`SELECT payload FROM fms.jobs WHERE kind = 'webhook' AND payload->>'station_id' = $1`, [f.stationId]);
    assert.equal(wh.rows.length, 1);
    assert.equal(wh.rows[0].payload.event, 'stock_low');
    assert.equal(wh.rows[0].payload.province_id, 5);
    const tl = await ctx.pool.query(`SELECT product_volume_l, measured_at FROM fms.tank_latest WHERE station_id = $1 AND tank_no = 1`, [f.stationId]);
    assert.equal(tl.rows[0].product_volume_l, 5000);
    assert.equal(new Date(tl.rows[0].measured_at).toISOString(), at(20));
    // refill above the threshold, then drop again -> a second LowStock
    await send(f, [tankMeasurement(f.ptsId, { measured_at: at(30), product_volume_l: 25000 })]);
    await send(f, [tankMeasurement(f.ptsId, { measured_at: at(40), product_volume_l: 5900 })]);
    const al2 = await ctx.pool.query(`SELECT count(*)::int n FROM fms.alerts WHERE station_id = $1 AND code = 'LowStock'`, [f.stationId]);
    assert.equal(al2.rows[0].n, 2);
  });

  test('rollup job enqueued (debounced re-arm) and rollup_station_day yields correct daily_station_product', async () => {
    const f = await createFixtureStation(ctx.pool, 'edge');
    const D = '2026-11-20'; // station-local business date (Africa/Lusaka, UTC+2)
    const local = (s: string) => new Date(`${s}+02:00`).toISOString();
    const res = await send(f, [
      tankMeasurement(f.ptsId, { measured_at: local('2026-11-19T23:00:00'), product_volume_l: 20000 }), // opening
      pumpTx(f.ptsId, { ended_at: local(`${D}T08:00:00`), volume_l: 100, amount: 3185 }),
      pumpTx(f.ptsId, { ended_at: local(`${D}T12:00:00`), volume_l: 50, amount: 1592.5 }),
      pumpTx(f.ptsId, { ended_at: local(`${D}T00:30:00`), volume_l: 25, amount: 796.25 }), // 22:30Z on the 19th = local D
      pumpTx(f.ptsId, { ended_at: local('2026-11-21T00:10:00'), volume_l: 999, amount: 31818.15 }), // next day
      {
        kind: 'tank_delivery',
        data: {
          pts_id: f.ptsId, tank_no: 1, pts_grade_id: 1,
          started_at: local(`${D}T14:00:00`), ended_at: local(`${D}T14:40:00`),
          start_volume_l: 19825, end_volume_l: 29825,
          start_tc_volume_l: null, end_tc_volume_l: null, start_height_mm: null, end_height_mm: null,
          start_water_mm: null, end_water_mm: null, start_temperature_c: null, end_temperature_c: null,
          start_density_kg_m3: null, end_density_kg_m3: null,
        },
      },
      tankMeasurement(f.ptsId, { measured_at: local(`${D}T23:30:00`), product_volume_l: 29800 }), // closing
    ]);
    assert.equal(res.accepted.length, 7);

    const job = await ctx.pool.query(`SELECT kind, status, payload, run_at > now() AS debounced FROM fms.jobs WHERE dedupe_key = $1`, [`rollup:${f.stationId}:${D}`]);
    assert.equal(job.rows.length, 1);
    assert.equal(job.rows[0].status, 'queued');
    assert.equal(job.rows[0].debounced, true);
    assert.deepEqual(job.rows[0].payload, { station_id: f.stationId, business_date: D });
    for (const d of ['2026-11-19', '2026-11-21']) {
      const j = await ctx.pool.query(`SELECT 1 FROM fms.jobs WHERE dedupe_key = $1`, [`rollup:${f.stationId}:${d}`]);
      assert.equal(j.rows.length, 1, `rollup for ${d}`);
    }

    // NOTE: fms.rollup_station_day uses unqualified table names and has no SET search_path,
    // so callers must run it with search_path = fms (reported as a schema issue).
    const c = await ctx.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL search_path = fms, public');
      await c.query(`SELECT fms.rollup_station_day($1, $2::date)`, [f.stationId, D]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const { rows } = await ctx.pool.query(
      `SELECT product_code, province_id, sales_volume_l, sales_amount, tx_count, opening_stock_l, closing_stock_l,
              deliveries_l, variance_l, avg_price
         FROM fms.daily_station_product WHERE station_id = $1 AND business_date = $2 ORDER BY product_code`,
      [f.stationId, D],
    );
    assert.deepEqual(rows, [
      { product_code: 'DIESEL', province_id: 5, sales_volume_l: 0, sales_amount: 0, tx_count: 0, opening_stock_l: null, closing_stock_l: null, deliveries_l: 0, variance_l: null, avg_price: null },
      { product_code: 'PETROL', province_id: 5, sales_volume_l: 175, sales_amount: 5573.75, tx_count: 3, opening_stock_l: 20000, closing_stock_l: 29800, deliveries_l: 10000, variance_l: 25, avg_price: 31.85 },
    ]);

    // job finished -> new data for that day re-arms it (dedupe_key is unique forever)
    await ctx.pool.query(`UPDATE fms.jobs SET status = 'done', attempts = 1 WHERE dedupe_key = $1`, [`rollup:${f.stationId}:${D}`]);
    await send(f, [pumpTx(f.ptsId, { ended_at: local(`${D}T18:00:00`), volume_l: 10, amount: 318.5 })]);
    const j2 = await ctx.pool.query(`SELECT status, attempts FROM fms.jobs WHERE dedupe_key = $1`, [`rollup:${f.stationId}:${D}`]);
    assert.deepEqual(j2.rows[0], { status: 'queued', attempts: 0 });
  });
});
