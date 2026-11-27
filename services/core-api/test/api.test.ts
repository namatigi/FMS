import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { FastifyInstance } from 'fastify';
import { makeApp, seedTelemetry, login, token, get, send, ST, PASSWORD, PARTNER_KEY } from './helpers.js';
import { totpAt } from '../src/lib/crypto.js';

let app: FastifyInstance;
const T: Record<string, string> = {};

before(async () => {
  app = await makeApp();
  await seedTelemetry(app);
  for (const [k, email] of Object.entries({
    admin: 'admin@fms.local', owner: 'owner@zambezi.local', manager: 'manager@zambezi.local',
    erb: 'erb@erb.local', erbcop: 'erb.cop@erb.local', zra: 'zra@zra.local',
  })) T[k] = await token(app, email);
});
after(async () => {
  await app.close();
});

const codes = (items: Array<{ code: string }>) => items.map((s) => s.code).sort();

describe('auth', () => {
  test('login returns contract shape', async () => {
    const r = await login(app, 'owner@zambezi.local');
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.ok(b.access_token && b.refresh_token);
    assert.equal(b.expires_in, 900);
    assert.deepEqual(Object.keys(b.user).sort(), ['company_id', 'email', 'full_name', 'id', 'province_id', 'role']);
    assert.equal(b.user.role, 'owner');
  });

  test('wrong password -> 401 error envelope', async () => {
    const r = await login(app, 'owner@zambezi.local', 'nope-nope');
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error.code, 'invalid_credentials');
  });

  test('refresh rotates; reuse of old token revokes family; logout revokes', async () => {
    const first = (await login(app, 'manager@zambezi.local')).json();
    const r1 = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token: first.refresh_token } });
    assert.equal(r1.statusCode, 200);
    const second = r1.json();
    assert.notEqual(second.refresh_token, first.refresh_token);
    assert.equal(second.user.email, 'manager@zambezi.local');
    // reuse old -> 401 and family revoked
    const reuse = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token: first.refresh_token } });
    assert.equal(reuse.statusCode, 401);
    const afterReuse = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token: second.refresh_token } });
    assert.equal(afterReuse.statusCode, 401);

    const fresh = (await login(app, 'manager@zambezi.local')).json();
    const lo = await send(app, fresh.access_token, 'POST', '/api/v1/auth/logout', { refresh_token: fresh.refresh_token });
    assert.equal(lo.statusCode, 200);
    const r2 = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token: fresh.refresh_token } });
    assert.equal(r2.statusCode, 401);
  });

  test('/me', async () => {
    const r = await get(app, T.manager!, '/api/v1/me');
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().role, 'manager');
    assert.deepEqual(r.json().station_ids, [ST.LUS]);
    assert.equal((await app.inject({ url: '/api/v1/me' })).statusCode, 401);
    assert.equal((await get(app, 'garbage.token.here', '/api/v1/me')).statusCode, 401);
  });

  test('lockout after 5 failures within 15 min', async () => {
    const c = await send(app, T.admin!, 'POST', '/api/v1/admin/users', {
      email: 'lock@test.local', full_name: 'Lock Test', password: 'SomePassword123', role: 'zra_auditor',
    });
    assert.equal(c.statusCode, 201, c.body);
    for (let i = 0; i < 5; i++) assert.equal((await login(app, 'lock@test.local', 'wrong-password')).statusCode, 401);
    const locked = await login(app, 'lock@test.local', 'SomePassword123');
    assert.equal(locked.statusCode, 429);
    assert.equal(locked.json().error.code, 'account_locked');
    const { rows } = await app.db.primary.query(`SELECT count(*)::int n FROM fms.audit_log WHERE action = 'auth.login_failed' AND details->>'email' = 'lock@test.local'`);
    assert.ok(rows[0].n >= 5);
  });

  test('TOTP MFA enrolment and login', async () => {
    const enr = await send(app, T.erb!, 'POST', '/api/v1/auth/mfa/enroll');
    assert.equal(enr.statusCode, 200);
    const { secret, otpauth_url } = enr.json();
    assert.match(otpauth_url, /^otpauth:\/\/totp\//);
    const now = Math.floor(Date.now() / 1000);
    assert.equal((await send(app, T.erb!, 'POST', '/api/v1/auth/mfa/verify', { code: '000000' === totpAt(secret, now) ? '111111' : '000000' })).statusCode, 400);
    assert.equal((await send(app, T.erb!, 'POST', '/api/v1/auth/mfa/verify', { code: totpAt(secret, now) })).statusCode, 200);
    const noCode = await login(app, 'erb@erb.local');
    assert.equal(noCode.statusCode, 401);
    assert.equal(noCode.json().error.code, 'mfa_required');
    const ok = await login(app, 'erb@erb.local', PASSWORD, { totp_code: totpAt(secret, Math.floor(Date.now() / 1000)) });
    assert.equal(ok.statusCode, 200);
    assert.equal((await send(app, T.erb!, 'POST', '/api/v1/auth/mfa/disable', { code: totpAt(secret, Math.floor(Date.now() / 1000)) })).statusCode, 200);
    assert.equal((await login(app, 'erb@erb.local')).statusCode, 200);
    // owners cannot enrol
    assert.equal((await send(app, T.owner!, 'POST', '/api/v1/auth/mfa/enroll')).statusCode, 403);
  });
});

describe('scoping matrix', () => {
  test('station lists per role', async () => {
    const list = async (t: string) => codes((await get(app, t, '/api/v1/stations')).json().items);
    assert.deepEqual(await list(T.owner!), ['CEN-0001', 'LUS-0001']);
    assert.deepEqual(await list(T.manager!), ['LUS-0001']);
    assert.deepEqual(await list(T.erbcop!), ['COP-0001']);
    assert.deepEqual(await list(T.erb!), ['CEN-0001', 'COP-0001', 'LUS-0001', 'SOU-0001']);
    assert.deepEqual(await list(T.zra!), ['CEN-0001', 'COP-0001', 'LUS-0001', 'SOU-0001']);
    assert.deepEqual(await list(T.admin!), ['CEN-0001', 'COP-0001', 'LUS-0001', 'SOU-0001']);
  });

  test('out-of-scope station ids are 404 (not 403)', async () => {
    for (const [tok, id] of [[T.manager!, ST.CEN], [T.owner!, ST.COP], [T.erbcop!, ST.LUS]] as const) {
      for (const sfx of ['', '/tanks', '/transactions', '/sales/summary', '/deliveries', '/reconciliation']) {
        const r = await get(app, tok, `/api/v1/stations/${id}${sfx}`);
        assert.equal(r.statusCode, 404, `${sfx} ${r.body}`);
        assert.equal(r.json().error.code, 'not_found');
      }
    }
    assert.equal((await get(app, T.owner!, `/api/v1/stations/not-a-uuid`)).statusCode, 404);
    assert.equal((await get(app, T.manager!, `/api/v1/alerts?station_id=${ST.COP}`)).statusCode, 404);
    assert.equal((await get(app, T.manager!, `/api/v1/stations/${ST.LUS}`)).statusCode, 200);
  });

  test('alerts and fiscal receipts are scoped', async () => {
    const m = (await get(app, T.manager!, '/api/v1/alerts')).json().items;
    assert.ok(m.length >= 1 && m.every((a: { station_id: string }) => a.station_id === ST.LUS));
    const cop = (await get(app, T.erbcop!, '/api/v1/alerts?status=all')).json().items;
    assert.ok(cop.every((a: { station_id: string }) => a.station_id === ST.COP));
    const fr = (await get(app, T.zra!, '/api/v1/fiscal/receipts')).json();
    assert.ok(fr.items.length >= 5);
    const own = (await get(app, T.owner!, `/api/v1/fiscal/receipts?station_id=${ST.LUS}`)).json();
    assert.ok(own.items.length >= 5);
  });

  test('alert ack: in scope ok, out of scope 404, regulator 403', async () => {
    const lus = (await get(app, T.manager!, '/api/v1/alerts')).json().items[0];
    const cop = (await get(app, T.admin!, `/api/v1/alerts?station_id=${ST.COP}`)).json().items[0];
    assert.equal((await send(app, T.manager!, 'POST', `/api/v1/alerts/${cop.id}/ack`, {})).statusCode, 404);
    assert.equal((await send(app, T.erb!, 'POST', `/api/v1/alerts/${lus.id}/ack`, {})).statusCode, 403);
    const r = await send(app, T.manager!, 'POST', `/api/v1/alerts/${lus.id}/ack`, {});
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().status, 'acknowledged');
  });

  test('delivery reconciliation PATCH', async () => {
    const d = (await get(app, T.manager!, `/api/v1/stations/${ST.LUS}/deliveries`)).json().items[0];
    const dc = (await get(app, T.admin!, `/api/v1/stations/${ST.COP}/deliveries`)).json().items[0];
    const ok = await send(app, T.manager!, 'PATCH', `/api/v1/deliveries/${d.id}`, { delivery_note_no: 'DN-1', supplier: 'Test Supplier', invoiced_volume_l: 20100 });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().invoiced_volume_l, 20100);
    assert.equal((await send(app, T.manager!, 'PATCH', `/api/v1/deliveries/${dc.id}`, { supplier: 'Test X' })).statusCode, 404);
    assert.equal((await send(app, T.zra!, 'PATCH', `/api/v1/deliveries/${d.id}`, { supplier: 'Test X' })).statusCode, 403);
  });
});

describe('stations data', () => {
  test('tanks include days_of_cover', async () => {
    const r = await get(app, T.owner!, `/api/v1/stations/${ST.LUS}/tanks`);
    assert.equal(r.statusCode, 200);
    const tanks = r.json();
    assert.ok(Array.isArray(tanks));
    const t1 = tanks.find((t: { tank_no: number }) => t.tank_no === 1);
    assert.equal(t1.product_volume_l, 5000);
    assert.equal(t1.fill_pct, 16.7);
    assert.equal(t1.avg_daily_sales_l, 2000);
    assert.equal(t1.days_of_cover, 2.5);
  });

  test('transactions keyset pagination', async () => {
    const seen = new Set<number>();
    let cursor: string | null = null;
    let pages = 0;
    let lastTs = Infinity;
    do {
      const url: string = `/api/v1/stations/${ST.LUS}/transactions?limit=50${cursor ? `&cursor=${cursor}` : ''}`;
      const b: { items: Array<{ id: number; ended_at: string }>; next_cursor: string | null } = (await get(app, T.manager!, url)).json();
      for (const tx of b.items) {
        assert.ok(!seen.has(tx.id), 'duplicate row across pages');
        seen.add(tx.id);
        const ts = Date.parse(tx.ended_at);
        assert.ok(ts <= lastTs, 'not sorted desc');
        lastTs = ts;
      }
      cursor = b.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.equal(seen.size, 120);
    const one = (await get(app, T.manager!, `/api/v1/stations/${ST.LUS}/transactions?pump_no=1&limit=500`)).json();
    assert.equal(one.items.length, 60);
    assert.deepEqual(Object.keys(one.items[0]).filter((k) => ['id', 'ended_at', 'pump_no', 'nozzle_no', 'product_code', 'volume_l', 'price', 'amount', 'tag', 'fiscal_status', 'zra_rcpt_no'].includes(k)).length, 11);
    assert.equal((await get(app, T.manager!, `/api/v1/stations/${ST.LUS}/transactions?cursor=bogus`)).statusCode, 400);
  });

  test('sales summary groups', async () => {
    const from = new Date(Date.now() - 6 * 3600e3).toISOString();
    for (const g of ['hour', 'day', 'product', 'pump']) {
      const r = await get(app, T.owner!, `/api/v1/stations/${ST.LUS}/sales/summary?group=${g}&from=${encodeURIComponent(from)}`);
      assert.equal(r.statusCode, 200, r.body);
      const rows = r.json();
      const total = rows.reduce((a: number, x: { tx_count: number }) => a + x.tx_count, 0);
      assert.equal(total, 120, g);
      if (g === 'pump') assert.ok(rows.every((x: { pump_no: number }) => typeof x.pump_no === 'number'));
      if (g === 'day') assert.match(rows[0].bucket, /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('dashboard overview', async () => {
    const b = (await get(app, T.owner!, '/api/v1/dashboard/overview')).json();
    assert.equal(b.stations_total, 2);
    assert.equal(b.stations_online, 1);
    assert.equal(b.stations_offline, 1);
    assert.ok(b.sales_today.tx_count > 0 && b.sales_today.volume_l > 0);
    assert.ok(b.low_stock_tanks.some((t: { station_id: string; tank_no: number }) => t.station_id === ST.LUS && t.tank_no === 1));
    assert.ok(b.by_product.find((p: { product_code: string }) => p.product_code === 'PETROL').stock_l === 5000);
  });

  test('reconciliation rows', async () => {
    const b = (await get(app, T.owner!, `/api/v1/stations/${ST.LUS}/reconciliation`)).json();
    assert.equal(b.items.length, 6);
  });
});

describe('prices', () => {
  test('above ERB cap is rejected', async () => {
    const r = await send(app, T.owner!, 'PUT', `/api/v1/stations/${ST.LUS}/prices`, { prices: [{ pts_grade_id: 1, price: 40.0 }] });
    assert.equal(r.statusCode, 422);
    assert.equal(r.json().error.code, 'price_above_cap');
  });

  test('valid price creates edge_command job + price_change + grade update', async () => {
    const r = await send(app, T.owner!, 'PUT', `/api/v1/stations/${ST.LUS}/prices`, { prices: [{ pts_grade_id: 1, price: 31.99 }, { pts_grade_id: 2, price: 30.1 }] });
    assert.equal(r.statusCode, 200, r.body);
    const b = r.json();
    const { rows } = await app.db.primary.query(`SELECT payload FROM fms.jobs WHERE id = $1 AND kind = 'edge_command'`, [b.job_id]);
    assert.equal(rows[0].payload.station_id, ST.LUS);
    assert.equal(rows[0].payload.command.type, 'set_prices');
    assert.equal(rows[0].payload.command.id, b.command_id);
    assert.deepEqual(rows[0].payload.command.prices, [{ pts_grade_id: 1, price: 31.99 }, { pts_grade_id: 2, price: 30.1 }]);
    const g = await app.db.primary.query(`SELECT price FROM fms.fuel_grades WHERE station_id = $1 AND pts_grade_id = 1`, [ST.LUS]);
    assert.equal(g.rows[0].price, 31.99);
    const pc = await app.db.primary.query(`SELECT count(*)::int n FROM fms.price_changes WHERE station_id = $1 AND kind = 'station'`, [ST.LUS]);
    assert.equal(pc.rows[0].n, 2);
    const au = await app.db.primary.query(`SELECT count(*)::int n FROM fms.audit_log WHERE action = 'price.station_set' AND entity_id = $1`, [ST.LUS]);
    assert.ok(au.rows[0].n >= 1);
  });

  test('role and scope rules for PUT prices', async () => {
    assert.equal((await send(app, T.manager!, 'PUT', `/api/v1/stations/${ST.LUS}/prices`, { prices: [{ pts_grade_id: 1, price: 30 }] })).statusCode, 403);
    assert.equal((await send(app, T.owner!, 'PUT', `/api/v1/stations/${ST.COP}/prices`, { prices: [{ pts_grade_id: 1, price: 30 }] })).statusCode, 404);
    assert.equal((await send(app, T.owner!, 'PUT', `/api/v1/stations/${ST.LUS}/prices`, { prices: [{ pts_grade_id: 99, price: 30 }] })).statusCode, 422);
  });

  test('province-specific cap overrides national; only erb_national may set caps', async () => {
    assert.equal((await send(app, T.erbcop!, 'POST', '/api/v1/regulator/prices', { product_code: 'PETROL', province_id: 2, price: 31 })).statusCode, 403);
    const c = await send(app, T.erb!, 'POST', '/api/v1/regulator/prices', { product_code: 'PETROL', province_id: 5, price: 31.5, effective_at: new Date(Date.now() - 1000).toISOString() });
    assert.equal(c.statusCode, 201, c.body);
    const r = await send(app, T.owner!, 'PUT', `/api/v1/stations/${ST.LUS}/prices`, { prices: [{ pts_grade_id: 1, price: 31.99 }] });
    assert.equal(r.statusCode, 422);
    // CEN-0001 (province 1) still uses national cap 32.15
    assert.equal((await send(app, T.owner!, 'PUT', `/api/v1/stations/${ST.CEN}/prices`, { prices: [{ pts_grade_id: 1, price: 31.99 }] })).statusCode, 200);
    const caps = (await get(app, T.erb!, '/api/v1/regulator/prices')).json().items;
    assert.ok(caps.some((x: { province_id: number | null; price: number }) => x.province_id === 5 && x.price === 31.5));
    const copCaps = (await get(app, T.erbcop!, '/api/v1/regulator/prices')).json().items;
    assert.ok(copCaps.every((x: { province_id: number | null }) => x.province_id === null || x.province_id === 2));
  });
});

describe('regulator', () => {
  test('overview with telemetry (national)', async () => {
    const r = await get(app, T.erb!, '/api/v1/regulator/overview');
    assert.equal(r.statusCode, 200);
    const b = r.json();
    const petrol = b.by_product.find((x: { product_code: string }) => x.product_code === 'PETROL');
    assert.equal(petrol.stock_l, 25000);
    assert.equal(petrol.capacity_l, 120000);
    assert.ok(petrol.sales_24h_l > 0);
    assert.equal(petrol.days_of_cover, 6.3); // 25000 / (2000 + 2000)
    assert.equal(b.stations.total, 4);
    assert.equal(b.stations.online, 1);
    assert.ok(b.alerts_open >= 1);
    assert.equal((await get(app, T.owner!, '/api/v1/regulator/overview')).statusCode, 403);
    assert.equal((await get(app, T.zra!, '/api/v1/regulator/overview')).statusCode, 403);
  });

  test('erb_provincial is forced to Copperbelt', async () => {
    const o = (await get(app, T.erbcop!, '/api/v1/regulator/overview?province_id=5')).json();
    assert.equal(o.province_id, 2);
    assert.equal(o.stations.total, 1);
    assert.equal(o.by_product.find((x: { product_code: string }) => x.product_code === 'PETROL').stock_l, 20000);
    const prov = (await get(app, T.erbcop!, '/api/v1/regulator/provinces')).json();
    assert.deepEqual(prov.map((p: { province_id: number }) => p.province_id), [2]);
    assert.equal((await get(app, T.erbcop!, '/api/v1/regulator/provinces/5/stations')).statusCode, 404);
    const st = (await get(app, T.erbcop!, '/api/v1/regulator/provinces/2/stations')).json();
    assert.deepEqual(st.map((s: { code: string }) => s.code), ['COP-0001']);
    assert.ok(Array.isArray(st[0].stock) && Array.isArray(st[0].last_price));
    const daily = (await get(app, T.erbcop!, '/api/v1/regulator/sales/daily?province_id=5')).json().items;
    assert.ok(daily.length > 0 && daily.every((d: { province_id: number }) => d.province_id === 2));
    const stock = (await get(app, T.erbcop!, '/api/v1/regulator/stock')).json().items;
    assert.ok(stock.every((d: { province_id: number }) => d.province_id === 2));
    const comp = (await get(app, T.erbcop!, '/api/v1/regulator/compliance')).json();
    for (const k of ['price_violations', 'offline_stations', 'variance_anomalies', 'fiscal_failures']) assert.ok(Array.isArray(comp[k]), k);
    assert.ok(comp.offline_stations.every((s: { province_id: number }) => s.province_id === 2));
    const nat = (await get(app, T.erb!, '/api/v1/regulator/provinces')).json();
    assert.equal(nat.length, 10);
  });

  test('compliance national', async () => {
    const c = (await get(app, T.erb!, '/api/v1/regulator/compliance')).json();
    assert.ok(c.variance_anomalies.some((v: { kind: string; product_code: string }) => v.kind === 'stock_variance' && v.product_code === 'DIESEL'));
    assert.ok(c.fiscal_failures.some((f: { station_id: string; failed: number }) => f.station_id === ST.LUS && f.failed > 0));
    assert.ok(c.offline_stations.some((s: { station_id: string }) => s.station_id === ST.SOU));
  });

  test('export csv and json are audited', async () => {
    const d = new Date(Date.now() + 2 * 3600e3 - 86400e3).toISOString().slice(0, 10);
    const csv = await get(app, T.erb!, `/api/v1/regulator/export?date=${d}&format=csv`);
    assert.equal(csv.statusCode, 200);
    assert.match(String(csv.headers['content-type']), /text\/csv/);
    const lines = csv.body.trim().split(/\r\n/);
    assert.match(lines[0]!, /^business_date,province,station_code/);
    assert.equal(lines.length, 1 + 4);
    const js = (await get(app, T.erbcop!, `/api/v1/regulator/export?date=${d}&format=json`)).json();
    assert.equal(js.province_id, 2);
    assert.equal(js.items.length, 2);
    const { rows } = await app.db.primary.query(`SELECT count(*)::int n FROM fms.audit_log WHERE action = 'regulator.export'`);
    assert.ok(rows[0].n >= 2);
  });
});

describe('admin', () => {
  test('CRUD company + station, users never expose hashes, api key returned once', async () => {
    const c = await send(app, T.admin!, 'POST', '/api/v1/admin/companies', { name: 'Test Co', zra_tpin: `T${Date.now()}` });
    assert.equal(c.statusCode, 201, c.body);
    const id = c.json().id;
    const u = await send(app, T.admin!, 'PATCH', `/api/v1/admin/companies/${id}`, { contact_phone: '+260' });
    assert.equal(u.json().contact_phone, '+260');
    assert.equal((await get(app, T.admin!, `/api/v1/admin/companies/${id}`)).statusCode, 200);
    assert.equal((await send(app, T.admin!, 'DELETE', `/api/v1/admin/companies/${id}`)).statusCode, 204);
    assert.equal((await get(app, T.admin!, `/api/v1/admin/companies/${id}`)).statusCode, 404);
    assert.equal((await get(app, T.owner!, '/api/v1/admin/companies')).statusCode, 403);

    const users = (await get(app, T.admin!, '/api/v1/admin/users')).json().items;
    assert.ok(users.length >= 6 && users.every((x: Record<string, unknown>) => !('password_hash' in x) && !('mfa_secret' in x)));
    const bad = await send(app, T.admin!, 'POST', '/api/v1/admin/users', { email: 'x@test.local', full_name: 'x', password: 'SomePassword123', role: 'owner' });
    assert.equal(bad.statusCode, 400);

    const gw = await send(app, T.admin!, 'POST', '/api/v1/admin/gateways', { station_id: ST.SOU, gateway_code: `GW-TEST-${Date.now()}` });
    assert.equal(gw.statusCode, 201, gw.body);
    assert.match(gw.json().api_key, /^[A-Za-z0-9_-]{8}\./);
    const gwGet = (await get(app, T.admin!, `/api/v1/admin/gateways/${gw.json().id}`)).json();
    assert.ok(!('api_key' in gwGet) && !('api_key_hash' in gwGet));
    await send(app, T.admin!, 'DELETE', `/api/v1/admin/gateways/${gw.json().id}`);

    const dup = await send(app, T.admin!, 'POST', '/api/v1/admin/tanks', { station_id: ST.LUS, tank_no: 1, product_code: 'PETROL', capacity_l: 1000 });
    assert.equal(dup.statusCode, 409);
  });
});

describe('partner API', () => {
  test('key auth', async () => {
    assert.equal((await app.inject({ url: '/api/partner/v1/stations' })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/partner/v1/stations', headers: { 'x-api-key': 'erbdemo1.wrong' } })).statusCode, 401);
    const r = await app.inject({ url: '/api/partner/v1/stations', headers: { 'x-api-key': PARTNER_KEY } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().items.length, 4);
    for (const p of ['stock', 'sales/daily', 'prices', 'alerts']) {
      const x = await app.inject({ url: `/api/partner/v1/${p}`, headers: { 'x-api-key': PARTNER_KEY } });
      assert.equal(x.statusCode, 200, p);
      assert.ok(Array.isArray(x.json().items), p);
    }
  });

  test('scopes, province limit and per-client rate limit', async () => {
    const c = await send(app, T.admin!, 'POST', '/api/v1/admin/api-clients', {
      name: 'Copperbelt council', organisation: 'Test Org', scopes: ['stations:read'], province_id: 2, rate_limit_rpm: 3,
    });
    assert.equal(c.statusCode, 201, c.body);
    const key = c.json().api_key as string;
    assert.ok(key);
    const h = { 'x-api-key': key };
    const s = await app.inject({ url: '/api/partner/v1/stations', headers: h });
    assert.equal(s.statusCode, 200);
    assert.deepEqual(codes(s.json().items), ['COP-0001']);
    const st = await app.inject({ url: '/api/partner/v1/stock', headers: h });
    assert.equal(st.statusCode, 403);
    const third = await app.inject({ url: '/api/partner/v1/stations', headers: h });
    assert.equal(third.statusCode, 200);
    const fourth = await app.inject({ url: '/api/partner/v1/stations', headers: h });
    assert.equal(fourth.statusCode, 429);
    assert.equal(fourth.json().error.code, 'rate_limited');
  });
});

describe('platform', () => {
  test('OpenAPI is generated', async () => {
    const r = await app.inject({ url: '/api/docs/json' });
    assert.equal(r.statusCode, 200);
    const spec = r.json();
    assert.equal(spec.openapi, '3.0.3');
    for (const p of ['/api/v1/auth/login', '/api/v1/stations/{id}/transactions', '/api/v1/regulator/overview', '/api/v1/admin/users', '/api/partner/v1/stations', '/api/v1/stream']) {
      assert.ok(spec.paths[p], p);
    }
  });

  test('health, readiness and metrics', async () => {
    assert.equal((await app.inject({ url: '/healthz' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/readyz' })).statusCode, 200);
    const m = await app.inject({ url: '/metrics' });
    assert.match(m.body, /http_request_duration_seconds/);
  });

  test('unknown route -> error envelope', async () => {
    const r = await app.inject({ url: '/api/v1/nope' });
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error.code, 'not_found');
  });

  test('SSE stream pushes snapshot and new sales', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const got: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/v1/stream?station_id=${ST.LUS}&token=${T.manager}`, (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(String(res.headers['content-type']), /text\/event-stream/);
        let buf = '';
        let inserted = false;
        res.on('data', async (chunk) => {
          buf += chunk.toString();
          if (!inserted && buf.includes('event: tank_latest')) {
            inserted = true;
            await app.db.primary.query(`INSERT INTO fms.pump_transactions (station_id, pts_id, pts_transaction_no, pump_no, nozzle_no, product_code, ended_at, volume_l, price, amount)
                                        VALUES ($1, 'TEST-CORE', 9999, 2, 1, 'PETROL', now(), 10, 31.85, 318.5)`, [ST.LUS]);
          }
          if (buf.includes('event: sales')) {
            got.push(...buf.split('\n').filter((l) => l.startsWith('event: ')));
            req.destroy();
            resolve();
          }
        });
      });
      req.on('error', (e) => (got.length ? resolve() : reject(e)));
      setTimeout(() => reject(new Error('SSE timeout: ' + got.join(','))), 8000);
    });
    assert.ok(got.includes('event: ready'));
    assert.ok(got.includes('event: tank_latest'));
    assert.ok(got.includes('event: sales'));
    const oos = await get(app, T.manager!, `/api/v1/stream?station_id=${ST.COP}`);
    assert.equal(oos.statusCode, 404);
  });
});
