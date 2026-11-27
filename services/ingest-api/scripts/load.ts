/**
 * Quick load test for POST /ingest/v1/edge/batches.
 *
 *   DATABASE_URL=postgres://postgres@localhost:55432/fms_ingest \
 *   INGEST_URL=http://localhost:18081 \
 *   npx tsx scripts/load.ts --batches 400 --concurrency 16 --records 100 --stations 20 [--gzip]
 *
 * Creates `--stations` throw-away fixture stations (each with its own gateway key) directly in the
 * database, then sends `--batches` EdgeBatches (80% pump transactions, 20% tank measurements)
 * with `--concurrency` requests in flight and prints throughput and latency percentiles.
 * Run the server with RATE_LIMIT_RPS=0 (or a high limit), otherwise the per-gateway bucket throttles.
 */
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { createFixtureStation, pumpTx, tankMeasurement, type Fixture } from '../test/helpers.js';

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
}
const BATCHES = arg('batches', 400);
const CONCURRENCY = arg('concurrency', 16);
const RECORDS = arg('records', 100);
const STATIONS = arg('stations', 20);
const GZIP = process.argv.includes('--gzip');
const URL = `${process.env.INGEST_URL ?? 'http://localhost:18081'}/ingest/v1/edge/batches`;
const DB = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:55432/fms_ingest';

const pool = new pg.Pool({ connectionString: DB, max: 2 });
const fixtures: Fixture[] = [];
for (let i = 0; i < STATIONS; i++) fixtures.push(await createFixtureStation(pool, i % 4 === 0 ? 'direct' : 'edge'));
await pool.end();

const state = fixtures.map(() => ({ seq: 1, t: Date.now() - 10 * 86400_000, total: 100000 }));

function makeBatch(si: number) {
  const f = fixtures[si]!;
  const s = state[si]!;
  const records = [];
  for (let i = 0; i < RECORDS; i++) {
    s.t += 7000;
    const at = new Date(s.t).toISOString();
    if (i % 5 === 4) {
      records.push({ seq: s.seq++, ...tankMeasurement(f.ptsId, { measured_at: at, tank_no: 1 + (i % 2), product_volume_l: 15000 - (s.seq % 1000) }) });
    } else {
      const vol = 20 + (i % 7);
      s.total += vol;
      records.push({ seq: s.seq++, ...pumpTx(f.ptsId, { ended_at: at, pump_no: 1 + (i % 2), volume_l: vol, amount: vol * 31.85, total_volume_l: null }) });
    }
  }
  return { headers: { gw: f.gw, key: f.gwKey }, body: { gateway_code: f.gw, station_code: f.code, batch_id: randomUUID(), sent_at: new Date().toISOString(), records } };
}

const lat: number[] = [];
let accepted = 0;
let rejected = 0;
let errors = 0;
let next = 0;

async function worker() {
  while (true) {
    const n = next++;
    if (n >= BATCHES) return;
    const b = makeBatch(n % STATIONS);
    const json = JSON.stringify(b.body);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${b.headers.key}`,
      'x-gateway-code': b.headers.gw,
    };
    let payload: string | Uint8Array = json;
    if (GZIP) {
      payload = new Uint8Array(gzipSync(json));
      headers['content-encoding'] = 'gzip';
    }
    const t0 = performance.now();
    try {
      const res = await fetch(URL, { method: 'POST', headers, body: payload as BodyInit });
      const out = (await res.json()) as { accepted?: number[]; rejected?: unknown[] };
      lat.push(performance.now() - t0);
      if (res.status !== 200) {
        errors++;
        if (errors < 5) console.error(res.status, out);
        continue;
      }
      accepted += out.accepted?.length ?? 0;
      rejected += out.rejected?.length ?? 0;
    } catch (e) {
      errors++;
      if (errors < 5) console.error(e);
    }
  }
}

const start = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const secs = (performance.now() - start) / 1000;
lat.sort((a, b) => a - b);
const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]?.toFixed(1);
console.log(
  JSON.stringify(
    {
      batches: BATCHES, records_per_batch: RECORDS, concurrency: CONCURRENCY, stations: STATIONS, gzip: GZIP,
      seconds: Number(secs.toFixed(2)),
      records_accepted: accepted, records_rejected: rejected, http_errors: errors,
      records_per_s: Math.round(accepted / secs),
      batches_per_s: Number((BATCHES / secs).toFixed(1)),
      latency_ms: { p50: p(0.5), p95: p(0.95), p99: p(0.99), max: lat[lat.length - 1]?.toFixed(1) },
    },
    null,
    2,
  ),
);
