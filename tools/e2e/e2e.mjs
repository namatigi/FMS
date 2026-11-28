#!/usr/bin/env node
/**
 * End-to-end test of the whole FMS pipeline on one machine (no Docker needed).
 *
 *   PTS-2 simulator ─jsonPTS─► edge-gateway ─ZRA─► mock VSDC
 *                                   └─EdgeBatch─► ingest-api ─► Postgres ◄─ core-api / analytics / fiscal-worker
 *   PTS-2 simulator ─jsonPTS (direct mode)──────► ingest-api ─► fiscal-worker ─ZRA─► mock VSDC
 *
 * Prereqs: all services built (dist/), analytics venv at services/analytics/.venv,
 * a Postgres you can create databases on (PG_ADMIN_URL, default postgres://postgres@localhost:55432).
 *
 *   node tools/e2e/e2e.mjs [--duration 45] [--impl ts|django]
 *
 * --impl django (or E2E_IMPL=django) runs ingest-api, core-api and fiscal-worker from
 * the Django implementation in services/cloud (venv at services/cloud/.venv) instead
 * of the TypeScript builds. Everything else, and every check, stays the same.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ADMIN = process.env.PG_ADMIN_URL ?? 'postgres://postgres@localhost:55432';
const CLOUD_DB = `${ADMIN}/fms_e2e`;
const EDGE_DB = `${ADMIN}/fms_e2e_edge`;
const DURATION = process.argv.includes('--duration') ? Number(process.argv[process.argv.indexOf('--duration') + 1]) : 40;
if (!Number.isFinite(DURATION) || DURATION <= 0) throw new Error('--duration must be a positive number of seconds');
const IMPL = (process.argv.includes('--impl') ? process.argv[process.argv.indexOf('--impl') + 1] : process.env.E2E_IMPL) || 'ts';
if (!['ts', 'django'].includes(IMPL)) throw new Error(`--impl must be ts or django (got ${IMPL})`);
const LOGS = process.env.E2E_LOG_DIR ?? join(ROOT, 'tools/e2e/logs');
const JWT_SECRET = 'e2e-jwt-secret-please-change-0123456789';
const P = { vsdc: 28200, ingest: 28081, core: 28080, worker: 29464, edgePts: 28100, edgeUi: 28101, analytics: 28090 };

mkdirSync(LOGS, { recursive: true });
const procs = [];
const results = [];

function start(name, cmd, args, env, cwd = ROOT) {
  const out = createWriteStream(join(LOGS, `${name}.log`));
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.on('exit', (code) => { if (!child.killed && code !== 0) console.log(`  ! ${name} exited with ${code} (see ${name}.log)`); });
  procs.push({ name, child });
  return child;
}

async function waitHealthy(name, url, timeoutMs = 60_000, anyResponse = false) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok || anyResponse) { console.log(`  ✓ ${name} healthy`); return; } } catch {}
    await sleep(500);
  }
  throw new Error(`${name} not healthy at ${url}`);
}

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function api(path, { token, method = 'GET', body, headers = {}, port = P.core } = {}) {
  const r = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
const login = async (email) => (await api('/api/v1/auth/login', { method: 'POST', body: { email, password: 'ChangeMe123!' } })).json.access_token;

async function recreateDb(url) {
  const name = url.split('/').pop();
  const c = new pg.Client({ connectionString: `${ADMIN}/postgres` });
  await c.connect();
  await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [name]);
  await c.query(`DROP DATABASE IF EXISTS ${name}`);
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
}

function runNode(args, env) {
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit' });
    c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${args.join(' ')} exited ${code}`))));
  });
}

async function main() {
  console.log('1. Databases');
  await recreateDb(CLOUD_DB);
  await recreateDb(EDGE_DB);
  await runNode(['db/migrate.mjs', '--seed'], { DATABASE_URL: CLOUD_DB });

  console.log('2. Services');
  const node = process.execPath;
  const common = { DATABASE_URL: CLOUD_DB, JWT_SECRET, LOG_LEVEL: 'info', NODE_ENV: 'production' };
  start('mock-vsdc', node, ['packages/zra-client/bin/mock-vsdc.js'], { PORT: P.vsdc });
  const workerEnv = {
    ...common, METRICS_PORT: P.worker, ZRA_VSDC_URL: `http://localhost:${P.vsdc}`, WORKER_POLL_INTERVAL_MS: 500,
    SCHEDULER_TICK_MS: 5000, FISCAL_SWEEP_INTERVAL_MS: 10000, EXPORT_DIR: join(LOGS, 'exports'),
  };
  console.log(`   cloud services: ${IMPL === 'django' ? 'Django (services/cloud)' : 'TypeScript'}`);
  if (IMPL === 'django') {
    const cloud = join(ROOT, 'services/cloud');
    const dpy = join(cloud, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (!existsSync(dpy)) throw new Error(`no Django venv at ${dpy}`);
    const dj = { ...common, PYTHONUNBUFFERED: '1', DJANGO_SETTINGS_MODULE: 'fms_cloud.settings' };
    await new Promise((res, rej) => {
      const c = spawn(dpy, ['manage.py', 'fms_core_migrate'], { cwd: cloud, env: { ...process.env, ...dj, FMS_SERVICE: 'core' }, stdio: 'inherit' });
      c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`fms_core_migrate exited ${code}`))));
    });
    // runserver is Django's threaded development server: fine for a single-machine test.
    start('ingest-api', dpy, ['manage.py', 'runserver', `127.0.0.1:${P.ingest}`, '--noreload'], { ...dj, FMS_SERVICE: 'ingest', RATE_LIMIT_RPS: 0 }, cloud);
    start('core-api', dpy, ['manage.py', 'runserver', `127.0.0.1:${P.core}`, '--noreload'], { ...dj, FMS_SERVICE: 'core' }, cloud);
    start('fiscal-worker', dpy, ['manage.py', 'fms_worker'], { ...workerEnv, ...dj, FMS_SERVICE: 'worker' }, cloud);
  } else {
    start('ingest-api', node, ['services/ingest-api/dist/server.js'], { ...common, PORT: P.ingest, RATE_LIMIT_RPS: 0 });
    start('core-api', node, ['services/core-api/dist/server.js'], { ...common, PORT: P.core });
    start('fiscal-worker', node, ['services/fiscal-worker/dist/main.js'], workerEnv);
  }
  start('edge-gateway', node, ['services/edge-gateway/dist/main.js'], {
    DATABASE_URL: EDGE_DB, LOG_LEVEL: 'info', EDGE_PTS_PORT: P.edgePts, EDGE_UI_PORT: P.edgeUi,
    STATION_CODE: 'LUS-0001', STATION_NAME: 'Zambezi Cairo Road', GATEWAY_CODE: 'GW-LUS-0001',
    GATEWAY_KEY: 'gwLUS001.dev-gateway-key-lus-0001', PTS_ID: '003B00265030500420303531', PTS_SECRET: 'devsecret-lus-0001',
    PTS_CONTROL_URL: 'http://127.0.0.1:9/jsonPTS', CLOUD_INGEST_URL: `http://localhost:${P.ingest}`, SYNC_INTERVAL_MS: 1000,
    FISCAL_DRIVER: 'zra', ZRA_VSDC_URL: `http://localhost:${P.vsdc}`, ZRA_TPIN: '1000000001', ZRA_BHF_ID: '000',
    ZRA_DEVICE_SERIAL: 'EDGE-LUS-0001', PRINTER_DRIVER: 'file', PRINTER_DIR: join(LOGS, 'receipts'), HA_MODE: 'always',
  });
  const py = join(ROOT, 'services/analytics/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const haveAnalytics = existsSync(py);
  if (haveAnalytics) start('analytics', py, ['-m', 'fms_analytics'], { ...common, PORT: P.analytics }, join(ROOT, 'services/analytics'));

  await waitHealthy('mock-vsdc', `http://localhost:${P.vsdc}/`, 30_000, true); // mock has no health route; any reply = up
  await waitHealthy('ingest-api', `http://localhost:${P.ingest}/readyz`);
  await waitHealthy('core-api', `http://localhost:${P.core}/readyz`);
  await waitHealthy('fiscal-worker', `http://localhost:${P.worker}/healthz`);
  await waitHealthy('edge-gateway', `http://localhost:${P.edgeUi}/readyz`);
  // Cold start loads pandas/statsmodels/scikit-learn and the model registry: ~2 min on a slow Windows box.
  if (haveAnalytics) await waitHealthy('analytics', `http://localhost:${P.analytics}/readyz`, 300_000);

  console.log(`3. Simulating PTS-2 controllers for ${DURATION}s`);
  const simEdge = start('sim-edge-LUS-0001', node, ['tools/pts-simulator/dist/cli.js',
    '--url', `http://localhost:${P.edgePts}/jsonPTS`, '--pts-id', '003B00265030500420303531', '--secret', 'devsecret-lus-0001',
    '--pumps', '2', '--tanks', '2', '--rate', '1', '--duration', String(DURATION), '--fault-inject', '--fault-rate', '0.25', '--seed', '7', '--quiet'], {});
  const simDirect = start('sim-direct-CEN-0001', node, ['tools/pts-simulator/dist/cli.js',
    '--url', `http://localhost:${P.ingest}/ingest/pts`, '--pts-id', '003B00265030500420303532',
    '--pumps', '2', '--tanks', '2', '--rate', '0.5', '--duration', String(DURATION), '--seed', '11', '--quiet'], {});
  await Promise.all([simEdge, simDirect].map((c) => new Promise((r) => c.on('exit', r))));

  // Owner changes a price mid-run → edge command path.
  const owner = await login('owner@zambezi.local');
  const LUS = 'aaaaaaaa-0000-0000-0000-000000000001';
  const priceOk = await api(`/api/v1/stations/${LUS}/prices`, { token: owner, method: 'PUT', body: { prices: [{ pts_grade_id: 1, price: 32.0 }] } });
  const priceBad = await api(`/api/v1/stations/${LUS}/prices`, { token: owner, method: 'PUT', body: { prices: [{ pts_grade_id: 1, price: 99.0 }] } });

  console.log('4. Draining (sync + fiscalisation)');
  const cloud = new pg.Client({ connectionString: CLOUD_DB }); await cloud.connect();
  const edge = new pg.Client({ connectionString: EDGE_DB }); await edge.connect();
  for (let i = 0; i < 40; i++) {
    const b = (await edge.query(`SELECT count(*)::int n FROM edge.outbox WHERE sent_at IS NULL`)).rows[0].n;
    const f = (await cloud.query(`SELECT count(*)::int n FROM fms.pump_transactions WHERE fiscal_status <> 'signed' AND volume_l > 0`)).rows[0].n;
    if (b === 0 && f === 0) break;
    await sleep(1000);
  }
  // Commands piggy-back on the next edge→cloud exchange (at the latest the 30 s heartbeat);
  // the gateway's 'received' ack comes back through its outbox on the following sync.
  for (let i = 0; i < 60; i++) {
    const r = (await cloud.query(`SELECT status FROM fms.edge_commands WHERE id = $1`, [priceOk.json.command_id])).rows[0];
    if (r && !['queued', 'delivered'].includes(r.status)) break;
    await sleep(1000);
  }
  // The command round trip queues new outbox records at the edge (its ack, late receipts):
  // let them sync before the outbox is asserted empty.
  for (let i = 0; i < 15; i++) {
    if ((await edge.query(`SELECT count(*)::int n FROM edge.outbox WHERE sent_at IS NULL`)).rows[0].n === 0) break;
    await sleep(1000);
  }
  await cloud.query(`SELECT fms.rollup_station_day(id, (now() AT TIME ZONE 'Africa/Lusaka')::date) FROM fms.stations`);

  console.log('5. Assertions');
  const q = async (sql, params) => (await cloud.query(sql, params)).rows;
  const [lus] = await q(`SELECT count(*)::int n, count(*) FILTER (WHERE fiscal_status='signed')::int s FROM fms.pump_transactions WHERE station_id=$1 AND volume_l>0`, [LUS]);
  check('edge station sales reached cloud', lus.n > 10, `${lus.n} tx`);
  check('edge sales fiscalised by ZRA at the edge', lus.s === lus.n, `${lus.s}/${lus.n} signed`);
  const [edgeRcpt] = await q(`SELECT count(*)::int n FROM fms.fiscal_receipts WHERE station_id=$1 AND fiscalised_by='edge' AND zra_signature IS NOT NULL`, [LUS]);
  check('edge fiscal receipts (ZRA signature) synced to cloud', edgeRcpt.n === lus.s, `${edgeRcpt.n}`);
  const [cen] = await q(`SELECT count(*)::int n, count(*) FILTER (WHERE fiscal_status='signed')::int s FROM fms.pump_transactions WHERE station_id='aaaaaaaa-0000-0000-0000-000000000002' AND volume_l>0`);
  check('direct-mode station sales ingested', cen.n > 3, `${cen.n} tx`);
  check('direct-mode sales fiscalised by cloud worker', cen.s === cen.n, `${cen.s}/${cen.n} signed`);
  const [dup] = await q(`SELECT count(*)::int n FROM (SELECT invoice_no FROM fms.fiscal_receipts GROUP BY station_id, invoice_no HAVING count(*)>1) x`);
  check('no duplicate invoices', dup.n === 0);
  const tanks = await q(`SELECT station_id, count(*)::int n FROM fms.tank_latest GROUP BY station_id`);
  check('live tank levels for both stations', tanks.length === 2, tanks.map((t) => t.n).join(','));
  const [tot] = await q(`SELECT count(*)::int n FROM fms.alerts WHERE code='TotalizerMismatch'`);
  check('manual-mode theft detected (TotalizerMismatch alerts)', tot.n > 0, `${tot.n}`);
  const [backlog] = (await edge.query(`SELECT count(*)::int n FROM edge.outbox WHERE sent_at IS NULL`)).rows;
  check('edge outbox fully drained', backlog.n === 0, `${backlog.n} pending`);
  const [gw] = await q(`SELECT last_seen_at FROM fms.edge_gateways WHERE gateway_code='GW-LUS-0001'`);
  check('edge heartbeat received', !!gw.last_seen_at);
  const [roll] = await q(`SELECT coalesce(sum(sales_volume_l),0)::float v FROM fms.daily_station_product WHERE station_id=$1`, [LUS]);
  check('daily roll-up computed', roll.v > 0, `${roll.v.toFixed(1)} L`);

  check('owner price update accepted', priceOk.status === 200, `${priceOk.status}`);
  check('price above ERB cap rejected', priceBad.status === 422, `${priceBad.status}`);
  // The harness PTS-2 control URL is unreachable on purpose, so the gateway keeps the price command
  // scheduled for retry: the cloud must see it as 'received' (acked), not stuck in 'delivered'.
  const [cmd] = await q(`SELECT status, delivery_count, received_at FROM fms.edge_commands WHERE id = $1`, [priceOk.json?.command_id]);
  check('price command delivered and acknowledged by edge (received)', cmd?.status === 'received' && !!cmd.received_at, `${cmd?.status}, ${cmd?.delivery_count} deliveries`);
  const [edgeCmd] = (await edge.query(`SELECT status, attempts FROM edge.commands_applied WHERE id = $1`, [priceOk.json?.command_id])).rows;
  check('edge keeps price command scheduled while PTS-2 is unreachable', edgeCmd?.status === 'scheduled', `${edgeCmd?.status}, ${edgeCmd?.attempts} attempts`);
  const cmdApi = await api(`/api/v1/stations/${LUS}/commands`, { token: owner });
  check('owner sees command status via API', cmdApi.status === 200 && cmdApi.json.items[0]?.status === 'received', cmdApi.json?.items?.[0]?.status);

  const dash = await api('/api/v1/dashboard/overview', { token: owner });
  check('owner dashboard shows today\'s sales', dash.status === 200 && dash.json.sales_today.tx_count > 0, `${dash.json?.sales_today?.tx_count} tx`);
  const txs = await api(`/api/v1/stations/${LUS}/transactions?limit=5`, { token: owner });
  check('owner transactions list with ZRA receipt numbers', txs.status === 200 && txs.json.items.every((t) => t.zra_rcpt_no), `${txs.json?.items?.length} rows`);
  const mgr = await login('manager@zambezi.local');
  const mgrCen = await api('/api/v1/stations/aaaaaaaa-0000-0000-0000-000000000002', { token: mgr });
  check('manager cannot see another station (404)', mgrCen.status === 404);
  const erb = await login('erb@erb.local');
  const ov = await api('/api/v1/regulator/overview', { token: erb });
  check('ERB national overview', ov.status === 200 && ov.json.by_product.length > 0, ov.json?.by_product?.map((p) => `${p.product_code}:${Math.round(p.stock_l)}L`).join(' '));
  const erbCop = await login('erb.cop@erb.local');
  const provs = await api('/api/v1/regulator/provinces', { token: erbCop });
  check('ERB provincial officer sees only own province', provs.status === 200 && provs.json.length === 1 && provs.json[0].province_id === 2);
  const partner = await api('/api/partner/v1/stock', { headers: { 'x-api-key': 'erbdemo1.dev-partner-key-erb' } });
  check('partner API (authorities) stock feed', partner.status === 200, `${partner.json?.items?.length} rows`);
  if (haveAnalytics) {
    const res = await api('/analytics/v1/reserve/national', { token: erb, port: P.analytics });
    check('analytics national reserve', res.status === 200 && res.json.by_product?.length > 0, res.json?.by_product?.map((p) => `${p.product_code}:${p.days_of_cover ?? '-'}d`).join(' '));
    const so = await api(`/analytics/v1/forecast/stockout?station_id=${LUS}`, { token: owner, port: P.analytics });
    check('analytics stock-out prediction for owner', so.status === 200, `${Array.isArray(so.json) ? so.json.length : '?'} rows`);
  }
  await cloud.end(); await edge.end();
}

try {
  await main();
} catch (e) {
  console.error('E2E error:', e);
  results.push({ name: 'harness', ok: false });
} finally {
  for (const { child } of procs) if (child.exitCode === null) child.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed. Logs: ${LOGS}`);
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 1000);
}
