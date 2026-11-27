#!/usr/bin/env node
// API smoke test against a running core-api.
// Usage: BASE_URL=http://localhost:8080 node scripts/smoke.mjs
const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'ChangeMe123!';
const PARTNER_KEY = process.env.SMOKE_PARTNER_KEY ?? 'erbdemo1.dev-partner-key-erb';
let failed = 0;

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
}

const health = await call('GET', '/healthz');
check('GET /healthz', health.status === 200);
check('GET /readyz', (await call('GET', '/readyz')).status === 200);

const tokens = {};
for (const email of ['admin@fms.local', 'owner@zambezi.local', 'manager@zambezi.local', 'erb@erb.local', 'erb.cop@erb.local', 'zra@zra.local']) {
  const r = await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
  check(`login ${email}`, r.status === 200, r.status !== 200 ? JSON.stringify(r.json) : '');
  tokens[email.split('@')[0]] = r.json.access_token;
}
const { owner, manager, erb, admin } = tokens;
const cop = tokens['erb.cop'];

const me = await call('GET', '/api/v1/me', { token: owner });
check('GET /me', me.status === 200 && me.json.role === 'owner');

const st = await call('GET', '/api/v1/stations', { token: owner });
check('owner GET /stations', st.status === 200 && Array.isArray(st.json.items), `${st.json.items?.length} stations`);
const mst = await call('GET', '/api/v1/stations', { token: manager });
check('manager sees 1 station', mst.json.items?.length === 1);
const sid = mst.json.items?.[0]?.id;

for (const p of ['', '/tanks', '/transactions?limit=5', '/sales/summary?group=hour', '/deliveries', '/reconciliation']) {
  const r = await call('GET', `/api/v1/stations/${sid}${p}`, { token: manager });
  check(`GET /stations/:id${p}`, r.status === 200);
}
check('GET /dashboard/overview', (await call('GET', '/api/v1/dashboard/overview', { token: owner })).status === 200);
check('GET /alerts', (await call('GET', '/api/v1/alerts?status=all', { token: owner })).status === 200);
check('GET /fiscal/receipts', (await call('GET', '/api/v1/fiscal/receipts', { token: tokens.zra })).status === 200);

const reject = await call('PUT', `/api/v1/stations/${sid}/prices`, { token: owner, body: { prices: [{ pts_grade_id: 1, price: 999 }] } });
check('PUT prices above cap -> 422', reject.status === 422);

for (const p of ['/overview', '/provinces', '/sales/daily', '/stock', '/compliance', '/prices', '/export?format=json']) {
  const r = await call('GET', `/api/v1/regulator${p}`, { token: erb });
  check(`GET /regulator${p}`, r.status === 200);
}
const ov = await call('GET', '/api/v1/regulator/overview?province_id=5', { token: cop });
check('erb_provincial forced to own province', ov.json.province_id === 2);
check('owner forbidden on regulator', (await call('GET', '/api/v1/regulator/overview', { token: owner })).status === 403);
check('admin GET /admin/users', (await call('GET', '/api/v1/admin/users', { token: admin })).status === 200);

for (const p of ['stations', 'stock', 'sales/daily', 'prices', 'alerts']) {
  const r = await call('GET', `/api/partner/v1/${p}`, { headers: { 'x-api-key': PARTNER_KEY } });
  check(`partner GET /${p}`, r.status === 200);
}
check('partner without key -> 401', (await call('GET', '/api/partner/v1/stations')).status === 401);
check('OpenAPI /api/docs/json', (await call('GET', '/api/docs/json')).status === 200);
const metrics = await fetch(BASE + '/metrics');
check('GET /metrics', metrics.status === 200);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
