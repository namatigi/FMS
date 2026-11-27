import { http, HttpResponse, delay, type PathParams } from 'msw';
import { PRODUCT_CODES, PROVINCES, type DashboardOverview, type User } from '../types';
import {
  ALERTS, CAPS, COMPANIES, GRADES, MANAGER_STATIONS, STATIONS, USERS, dayStart, deliveriesFor, isoDate, r01, receiptsFor,
  reconFor, tanksFor, transactionsFor, visibleStations,
} from './data';

const A = '*/api/v1';
const N = '*/analytics/v1';
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const DAY = 86400000;
const LAT = import.meta.env.MODE === 'test' ? 0 : 120;

// ---------------------------------------------------------------- auth ----
const sessions = new Map<string, { user: User; exp: number }>();
const refreshTokens = new Map<string, string>(); // refresh → user id
let seq = 0;

function issue(user: User) {
  const access = `mock-access.${user.role}.${++seq}.${Date.now()}`;
  const refresh = `mock-refresh.${user.id}.${seq}.${Math.random().toString(36).slice(2)}`;
  sessions.set(access, { user, exp: Date.now() + 15 * 60_000 });
  refreshTokens.set(refresh, user.id);
  return { access_token: access, refresh_token: refresh, expires_in: 900, user };
}
const pub = (u: (typeof USERS)[number]): User => ({ id: u.id, email: u.email, full_name: u.full_name, role: u.role, company_id: u.company_id, province_id: u.province_id });

const err = (status: number, code: string, message: string) => HttpResponse.json({ error: { code, message } }, { status });

function authed(request: Request): User | null {
  const h = request.headers.get('authorization') ?? '';
  const tok = h.replace(/^Bearer\s+/i, '');
  const s = sessions.get(tok);
  if (!s || s.exp < Date.now()) return null;
  return s.user;
}

type Handler = (args: { request: Request; params: PathParams; user: User; url: URL }) => Response | Promise<Response>;
function guard(roles: User['role'][] | null, fn: Handler) {
  return async ({ request, params }: { request: Request; params: PathParams }) => {
    await delay(LAT);
    const user = authed(request);
    if (!user) return err(401, 'unauthorized', 'Access token missing or expired');
    if (roles && !roles.includes(user.role)) return err(403, 'forbidden', 'Your role cannot access this resource');
    return fn({ request, params, user, url: new URL(request.url) });
  };
}
const OWN: User['role'][] = ['owner', 'manager', 'platform_admin'];
const REG: User['role'][] = ['erb_national', 'erb_provincial', 'platform_admin'];

function stationOr404(user: User, id: string) {
  return visibleStations(user).find((s) => s.id === id) ?? (user.role === 'zra_auditor' ? STATIONS.find((s) => s.id === id) : undefined);
}
function inRange(iso: string, from: string | null, to: string | null) {
  const t = new Date(iso).getTime();
  if (from && t < new Date(from.length === 10 ? `${from}T00:00:00+02:00` : from).getTime()) return false;
  if (to && t >= (to.length === 10 ? new Date(`${to}T00:00:00+02:00`).getTime() + DAY : new Date(to).getTime())) return false;
  return true;
}

function scopedProvince(user: User, url: URL): number | null {
  if (user.role === 'erb_provincial') return user.province_id;
  const p = url.searchParams.get('province_id');
  return p ? Number(p) : null;
}

// ------------------------------------------------------- regulator calc ----
function productAgg(stations: typeof STATIONS) {
  return PRODUCT_CODES.map((pc) => {
    let stock = 0, cap = 0, sales = 0;
    for (const s of stations) for (const t of tanksFor(s.id)) if (t.product_code === pc) {
      stock += t.product_volume_l ?? 0;
      cap += t.capacity_l;
      sales += t.avg_daily_sales_l ?? 0;
    }
    return { product_code: pc, stock_l: round(stock, 0), capacity_l: cap, sales_24h_l: round(sales, 0), days_of_cover: sales ? round(stock / sales, 1) : null };
  }).filter((p) => p.capacity_l > 0);
}

function dailyRows(provinceId: number | null, product: string | null, from: string, to: string) {
  const rows = [];
  const r = r01(42);
  for (let d = -60; d <= 0; d++) {
    const date = isoDate(dayStart(d));
    const dow = new Date(dayStart(d) + 2 * 3600_000).getUTCDay();
    for (const p of PROVINCES) {
      if (provinceId && p.id !== provinceId) continue;
      const st = STATIONS.filter((s) => s.province_id === p.id);
      if (!st.length) continue;
      for (const pc of ['PETROL', 'DIESEL', 'KEROSENE']) {
        const base = (pc === 'PETROL' ? 3800 : pc === 'DIESEL' ? 5200 : 400) * st.length;
        const v = base * (1 + 0.12 * Math.sin((d / 7) * 2 * Math.PI) + (dow === 5 || dow === 6 ? 0.15 : 0) + (r() - 0.5) * 0.12 + d * -0.001);
        if (date < from || date > to || (product && pc !== product)) continue;
        if (pc === 'KEROSENE' && !st.some((s) => tanksFor(s.id).some((t) => t.product_code === 'KEROSENE'))) continue;
        const price = pc === 'PETROL' ? 31.9 : pc === 'DIESEL' ? 29.95 : 26.5;
        rows.push({
          province_id: p.id, business_date: date, product_code: pc, reporting_stations: st.length, sales_volume_l: round(v, 0),
          sales_amount: round(v * price, 2), deliveries_l: r() < 0.3 ? round(18000 * st.length * r(), 0) : 0,
          closing_stock_l: round(base * 6 * (0.7 + r() * 0.6), 0), variance_l: round(v * (r() - 0.45) * 0.006, 1), avg_price: price,
        });
      }
    }
  }
  return rows;
}

// --------------------------------------------------------------- admin ----
const admin: Record<string, Record<string, unknown>[]> = {
  companies: COMPANIES.map((c) => ({ ...c, created_at: '2026-01-10T08:00:00Z' })),
  stations: STATIONS.map(({ connectivity: _c, controller_last_seen_at: _l, company_name: _n, province_name: _p, ...s }) => s),
  tanks: STATIONS.flatMap((s) => tanksFor(s.id).map((t) => ({ id: `tank-${s.id}-${t.tank_no}`, station_id: s.id, tank_no: t.tank_no, product_code: t.product_code, capacity_l: t.capacity_l, low_level_l: t.capacity_l * 0.2 }))),
  fuel_grades: STATIONS.flatMap((_s, i) => GRADES(i)),
  nozzles: STATIONS.flatMap((s, i) => [1, 2].flatMap((pump) => [1, 2].map((nz) => ({ id: `nz-${i}-${pump}-${nz}`, station_id: s.id, pump_no: pump, nozzle_no: nz, fuel_grade_id: `fg-${i}-${nz}`, tank_id: `tank-${s.id}-${nz}` })))),
  controllers: STATIONS.map((s, i) => ({ id: `ctl-${i}`, station_id: s.id, pts_id: `003B0026503050042030353${i.toString(16).toUpperCase()}`.slice(0, 24), firmware: '2026-04-10', last_seen_at: s.controller_last_seen_at })),
  users: USERS.map(({ password: _p, ...u }) => ({ ...u, is_active: true, last_login_at: new Date(Date.now() - 3600_000).toISOString(), station_ids: MANAGER_STATIONS[u.id] ?? [] })),
  gateways: [
    { id: 'gw-1', station_id: STATIONS[0].id, gateway_code: 'GW-LUS-0001', role: 'primary', version: '0.1.0', last_seen_at: new Date(Date.now() - 15_000).toISOString(), last_backlog: 0 },
    { id: 'gw-2', station_id: STATIONS[2].id, gateway_code: 'GW-COP-0001', role: 'primary', version: '0.1.0', last_seen_at: new Date(Date.now() - 40_000).toISOString(), last_backlog: 3 },
  ],
  'api-clients': [{ id: 'ac-1', name: 'ERB data exchange (demo)', organisation: 'Energy Regulation Board', key_prefix: 'erbdemo1', scopes: ['stations:read', 'stock:read', 'sales:read', 'prices:read', 'alerts:read'], province_id: null, company_id: null, rate_limit_rpm: 600, is_active: true }],
  'audit-log': [
    { id: 3, occurred_at: new Date(Date.now() - 600_000).toISOString(), actor_type: 'user', actor_id: 'u-owner', action: 'station.prices_set', entity: 'station', entity_id: STATIONS[0].id, details: { prices: [{ pts_grade_id: 1, price: 31.85 }] } },
    { id: 2, occurred_at: new Date(Date.now() - 3600_000).toISOString(), actor_type: 'user', actor_id: 'u-erb', action: 'regulator.export', entity: 'export', entity_id: null, details: { format: 'csv' } },
    { id: 1, occurred_at: new Date(Date.now() - 7200_000).toISOString(), actor_type: 'user', actor_id: 'u-admin', action: 'auth.login', entity: 'user', entity_id: 'u-admin', details: { mfa: false } },
  ],
  webhooks: [{ id: 'wh-1', api_client_id: 'ac-1', url: 'https://erb.example.gov.zm/fms/webhook', events: ['daily_summary', 'critical_alert'], is_active: true }],
};
const randKey = (prefix: string) => `${prefix}.${Array.from({ length: 32 }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]).join('')}`;

// ------------------------------------------------------------ handlers ----
export const handlers = [
  http.post(`${A}/auth/login`, async ({ request }) => {
    await delay(LAT);
    const body = (await request.json()) as { email?: string; password?: string };
    const u = USERS.find((x) => x.email.toLowerCase() === String(body.email ?? '').toLowerCase());
    if (!u || u.password !== body.password) return err(401, 'invalid_credentials', 'Invalid email or password');
    return HttpResponse.json(issue(pub(u)));
  }),
  http.post(`${A}/auth/refresh`, async ({ request }) => {
    const body = (await request.json()) as { refresh_token?: string };
    // Mock state lives in page memory, so after a reload fall back to the user id embedded in the token.
    const rt = String(body.refresh_token);
    const uid = refreshTokens.get(rt) ?? (/^mock-refresh\.([^.]+)\./.exec(rt)?.[1] ?? null);
    const u = USERS.find((x) => x.id === uid);
    if (!u) return err(401, 'invalid_refresh', 'Refresh token invalid or expired');
    refreshTokens.delete(String(body.refresh_token)); // rotate
    return HttpResponse.json(issue(pub(u)));
  }),
  http.post(`${A}/auth/logout`, async ({ request }) => {
    const tok = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    sessions.delete(tok);
    return HttpResponse.json({ success: true });
  }),
  http.get(`${A}/me`, guard(null, ({ user }) => HttpResponse.json({ ...user, mfa_enabled: mfaUsers.has(user.id) }))),
  // Mock TOTP: any enrolment accepts the code 123456.
  http.post(`${A}/auth/mfa/enroll`, guard(REG, ({ user }) => HttpResponse.json({ secret: 'JBSWY3DPEHPK3PXP', otpauth_url: `otpauth://totp/FMS%20Zambia:${encodeURIComponent(user.email)}?secret=JBSWY3DPEHPK3PXP&issuer=FMS%20Zambia` }))),
  http.post(`${A}/auth/mfa/verify`, guard(REG, async ({ user, request }) => {
    const b = (await request.json()) as { code?: string };
    if (b.code !== '123456') return err(400, 'invalid_mfa_code', 'invalid TOTP code');
    mfaUsers.add(user.id);
    return HttpResponse.json({ mfa_enabled: true });
  })),
  http.post(`${A}/auth/mfa/disable`, guard(REG, async ({ user, request }) => {
    const b = (await request.json()) as { code?: string };
    if (b.code !== '123456') return err(400, 'invalid_mfa_code', 'invalid TOTP code');
    mfaUsers.delete(user.id);
    return HttpResponse.json({ mfa_enabled: false });
  })),
  http.get(`${A}/stream`, () => err(404, 'not_found', 'SSE not available in mock mode')),

  // ---- owner / manager ----
  http.get(`${A}/dashboard/overview`, guard(OWN, ({ user }) => {
    const st = visibleStations(user);
    const sod = dayStart(0);
    let vol = 0, amt = 0, n = 0;
    const byP: Record<string, { v: number; a: number }> = {};
    for (const s of st) for (const t of transactionsFor(s.id)) {
      if (new Date(t.ended_at).getTime() < sod) break;
      vol += t.volume_l; amt += t.amount; n++;
      byP[t.product_code] = { v: (byP[t.product_code]?.v ?? 0) + t.volume_l, a: (byP[t.product_code]?.a ?? 0) + t.amount };
    }
    const agg = productAgg(st);
    const low = st.flatMap((s) => tanksFor(s.id).filter((t) => (t.fill_pct ?? 100) < 20).map((t) => ({ station_id: s.id, station_name: s.name, tank_no: t.tank_no, product_code: t.product_code, product_volume_l: t.product_volume_l!, capacity_l: t.capacity_l, fill_pct: t.fill_pct! })));
    const ids = new Set(st.map((s) => s.id));
    const open = ALERTS.filter((a) => ids.has(a.station_id) && !a.acknowledged_at);
    const res: DashboardOverview = {
      stations_total: st.length, stations_online: st.filter((s) => s.connectivity === 'online').length, stations_offline: st.filter((s) => s.connectivity === 'offline').length,
      sales_today: { volume_l: round(vol, 1), amount: round(amt), tx_count: n },
      by_product: agg.map((p) => ({ product_code: p.product_code, sales_today_l: round(byP[p.product_code]?.v ?? 0, 1), sales_today_amount: round(byP[p.product_code]?.a ?? 0), stock_l: p.stock_l, capacity_l: p.capacity_l })),
      low_stock_tanks: low,
      open_alerts: { critical: open.filter((a) => a.severity === 'critical').length, warning: open.filter((a) => a.severity === 'warning').length },
    };
    return HttpResponse.json(res);
  })),
  http.get(`${A}/stations`, guard(null, ({ user, url }) => {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const p = url.searchParams.get('province_id');
    const c = url.searchParams.get('company_id');
    const items = (user.role === 'zra_auditor' ? STATIONS : visibleStations(user))
      .filter((s) => !q || `${s.name} ${s.code} ${s.town}`.toLowerCase().includes(q))
      .filter((s) => !p || s.province_id === Number(p))
      .filter((s) => !c || s.company_id === c)
      .map(({ connection_mode: _m, erb_licence_no: _e, zra_branch_id: _z, ...s }) => s);
    return HttpResponse.json({ items, next_cursor: null });
  })),
  http.get(`${A}/stations/:id`, guard(null, ({ user, params }) => {
    const s = stationOr404(user, String(params.id));
    if (!s) return err(404, 'not_found', 'Station not found');
    const idx = STATIONS.indexOf(s);
    return HttpResponse.json({
      ...s, tanks: tanksFor(s.id), fuel_grades: GRADES(idx).map(({ station_id: _s, ...g }) => g),
      nozzles: (admin.nozzles as { station_id: string }[]).filter((n) => n.station_id === s.id),
      health: { controller_last_seen_at: s.controller_last_seen_at, gateway_last_seen_at: s.connection_mode === 'edge' ? s.controller_last_seen_at : null, gateway_backlog: idx === 3 ? 214 : 0, connectivity: s.connectivity },
    });
  })),
  http.get(`${A}/stations/:id/tanks`, guard(null, ({ user, params }) => {
    const s = stationOr404(user, String(params.id));
    if (!s) return err(404, 'not_found', 'Station not found');
    return HttpResponse.json(tanksFor(s.id));
  })),
  http.get(`${A}/stations/:id/transactions`, guard(null, ({ user, params, url }) => {
    const s = stationOr404(user, String(params.id));
    if (!s) return err(404, 'not_found', 'Station not found');
    const pump = url.searchParams.get('pump_no');
    const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 50));
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    const all = transactionsFor(s.id).filter((t) => inRange(t.ended_at, url.searchParams.get('from'), url.searchParams.get('to')) && (!pump || t.pump_no === Number(pump)));
    const items = all.slice(offset, offset + limit);
    return HttpResponse.json({ items, next_cursor: offset + limit < all.length ? String(offset + limit) : null });
  })),
  http.get(`${A}/stations/:id/sales/summary`, guard(null, ({ user, params, url }) => {
    const s = stationOr404(user, String(params.id));
    if (!s) return err(404, 'not_found', 'Station not found');
    const group = url.searchParams.get('group') ?? 'day';
    const m = new Map<string, { bucket: string; product_code: string | null; pump_no?: number; volume_l: number; amount: number; tx_count: number }>();
    for (const t of transactionsFor(s.id)) {
      if (!inRange(t.ended_at, url.searchParams.get('from'), url.searchParams.get('to'))) continue;
      const lt = new Date(new Date(t.ended_at).getTime() + 2 * 3600_000);
      let bucket: string, key: string;
      let pc: string | null = t.product_code;
      let pump: number | undefined;
      if (group === 'hour') { bucket = new Date(Math.floor(lt.getTime() / 3600_000) * 3600_000 - 2 * 3600_000).toISOString(); key = `${bucket}|${pc}`; }
      else if (group === 'product') { bucket = t.product_code; key = bucket; }
      else if (group === 'pump') { pump = t.pump_no; bucket = String(t.pump_no); key = `${bucket}|${pc}`; }
      else { bucket = lt.toISOString().slice(0, 10); key = `${bucket}|${pc}`; }
      if (group === 'product') pc = t.product_code;
      const cur = m.get(key) ?? { bucket, product_code: pc, ...(pump ? { pump_no: pump } : {}), volume_l: 0, amount: 0, tx_count: 0 };
      cur.volume_l = round(cur.volume_l + t.volume_l, 2);
      cur.amount = round(cur.amount + t.amount, 2);
      cur.tx_count++;
      m.set(key, cur);
    }
    return HttpResponse.json([...m.values()]);
  })),
  http.get(`${A}/stations/:id/deliveries`, guard(null, ({ user, params, url }) => {
    const s = stationOr404(user, String(params.id));
    if (!s) return err(404, 'not_found', 'Station not found');
    const items = deliveriesFor(s.id).filter((d) => inRange(d.ended_at, url.searchParams.get('from'), url.searchParams.get('to'))).map((d) => ({ ...d, ...(deliveryEdits.get(String(d.id)) ?? {}) }));
    return HttpResponse.json({ items, next_cursor: null });
  })),
  http.patch(`${A}/deliveries/:id`, guard(['owner', 'manager', 'platform_admin'], async ({ request, params }) => {
    const body = (await request.json()) as Record<string, unknown>;
    deliveryEdits.set(String(params.id), body);
    return HttpResponse.json({ id: params.id, ...body });
  })),
  http.get(`${A}/stations/:id/reconciliation`, guard(null, ({ user, params, url }) => {
    const s = stationOr404(user, String(params.id));
    if (!s) return err(404, 'not_found', 'Station not found');
    return HttpResponse.json({ items: reconFor(s.id, url.searchParams.get('from') ?? isoDate(dayStart(-13)), url.searchParams.get('to') ?? isoDate(dayStart(0))), next_cursor: null });
  })),
  http.put(`${A}/stations/:id/prices`, guard(['owner', 'platform_admin'], async ({ request, params, user }) => {
    const s = stationOr404(user, String(params.id));
    if (!s) return err(404, 'not_found', 'Station not found');
    const body = (await request.json()) as { prices: { pts_grade_id: number; price: number }[] };
    const grades = GRADES(STATIONS.indexOf(s));
    for (const p of body.prices ?? []) {
      const g = grades.find((x) => x.pts_grade_id === p.pts_grade_id);
      if (!g) return err(400, 'unknown_grade', `Unknown fuel grade ${p.pts_grade_id}`);
      const cap = CAPS.filter((c) => c.product_code === g.product_code && (c.province_id === s.province_id || c.province_id == null)).sort((a, b) => (b.province_id ?? 0) - (a.province_id ?? 0))[0];
      if (cap && p.price > cap.price) return err(422, 'price_above_cap', `${g.name}: K ${p.price.toFixed(2)} exceeds the ERB cap of K ${cap.price.toFixed(2)} for ${s.province_name}`);
    }
    const effective_at = (body as { effective_at?: string }).effective_at ?? new Date().toISOString();
    return HttpResponse.json({ station_id: s.id, effective_at, command_id: `cmd-${Date.now()}`, job_id: Date.now(), prices: body.prices });
  })),

  http.get(`${A}/alerts`, guard(null, ({ user, url }) => {
    const ids = new Set(visibleStations(user).map((s) => s.id));
    const sid = url.searchParams.get('station_id');
    const status = url.searchParams.get('status') ?? 'open';
    const sev = url.searchParams.get('severity');
    const items = ALERTS.filter((a) => ids.has(a.station_id) && (!sid || a.station_id === sid) && (status === 'all' || (status === 'acknowledged' ? !!a.acknowledged_at : !a.acknowledged_at)) && (!sev || a.severity === sev));
    return HttpResponse.json({ items, next_cursor: null });
  })),
  http.post(`${A}/alerts/:id/ack`, guard(OWN, ({ params, user }) => {
    const a = ALERTS.find((x) => String(x.id) === String(params.id));
    if (!a) return err(404, 'not_found', 'Alert not found');
    a.acknowledged_at = new Date().toISOString();
    return HttpResponse.json({ ...a, acknowledged_by: user.id });
  })),
  http.get(`${A}/fiscal/receipts`, guard(['zra_auditor', 'platform_admin', 'owner', 'manager'], ({ url, user }) => {
    const sid = url.searchParams.get('station_id');
    const status = url.searchParams.get('status');
    const st = (user.role === 'zra_auditor' ? STATIONS : visibleStations(user)).filter((s) => !sid || s.id === sid);
    const items = st.flatMap((s) => receiptsFor(s.id))
      .filter((r) => inRange(r.tx_ended_at, url.searchParams.get('from'), url.searchParams.get('to')) && (!status || r.status === status))
      .sort((a, b) => b.tx_ended_at.localeCompare(a.tx_ended_at))
      .slice(0, 500);
    return HttpResponse.json({ items, next_cursor: null });
  })),

  // ---- regulator ----
  http.get(`${A}/regulator/overview`, guard(REG, ({ user, url }) => {
    const p = scopedProvince(user, url);
    const st = STATIONS.filter((s) => !p || s.province_id === p);
    const ids = new Set(st.map((s) => s.id));
    return HttpResponse.json({
      by_product: productAgg(st),
      stations: { total: st.length, online: st.filter((s) => s.connectivity === 'online').length, offline: st.filter((s) => s.connectivity === 'offline').length },
      alerts_open: ALERTS.filter((a) => ids.has(a.station_id) && !a.acknowledged_at).length,
    });
  })),
  http.get(`${A}/regulator/provinces`, guard(REG, ({ user }) => {
    return HttpResponse.json(
      PROVINCES.filter((p) => user.role !== 'erb_provincial' || p.id === user.province_id).map((p) => {
        const st = STATIONS.filter((s) => s.province_id === p.id);
        return { province_id: p.id, province_name: p.name, stations: st.length, online: st.filter((s) => s.connectivity === 'online').length, by_product: productAgg(st) };
      }),
    );
  })),
  http.get(`${A}/regulator/provinces/:id/stations`, guard(REG, ({ user, params }) => {
    const pid = Number(params.id);
    if (user.role === 'erb_provincial' && user.province_id !== pid) return err(403, 'forbidden', 'Outside your province');
    return HttpResponse.json(
      STATIONS.filter((s) => s.province_id === pid).map((s) => {
        const tanks = tanksFor(s.id);
        const prods = [...new Set(tanks.map((t) => t.product_code))];
        return {
          station_id: s.id, code: s.code, name: s.name, company_name: s.company_name, connectivity: s.connectivity,
          stock: prods.map((pc) => ({ product_code: pc, stock_l: round(tanks.filter((t) => t.product_code === pc).reduce((a, t) => a + (t.product_volume_l ?? 0), 0), 0), capacity_l: tanks.filter((t) => t.product_code === pc).reduce((a, t) => a + t.capacity_l, 0) })),
          last_price: GRADES(STATIONS.indexOf(s)).map((g) => ({ product_code: g.product_code, price: g.price })),
        };
      }),
    );
  })),
  http.get(`${A}/regulator/sales/daily`, guard(REG, ({ user, url }) => {
    const from = url.searchParams.get('from') ?? isoDate(dayStart(-29));
    const to = url.searchParams.get('to') ?? isoDate(dayStart(0));
    return HttpResponse.json({ items: dailyRows(scopedProvince(user, url), url.searchParams.get('product_code'), from, to), next_cursor: null });
  })),
  http.get(`${A}/regulator/compliance`, guard(REG, ({ user, url }) => {
    const p = scopedProvince(user, url);
    const st = STATIONS.filter((s) => !p || s.province_id === p);
    const pv = st.flatMap((s) => GRADES(STATIONS.indexOf(s)).flatMap((g) => {
      const cap = CAPS.filter((c) => c.product_code === g.product_code && (c.province_id == null || c.province_id === s.province_id)).sort((a, b) => (b.province_id ?? 0) - (a.province_id ?? 0))[0];
      return cap && g.price > cap.price ? [{ station_id: s.id, station_code: s.code, station_name: s.name, product_code: g.product_code, price: g.price, cap_price: cap.price, excess_zmw: round(g.price - cap.price), observed_at: new Date().toISOString() }] : [];
    }));
    const off = st.filter((s) => s.connectivity === 'offline').map((s) => ({ station_id: s.id, station_code: s.code, station_name: s.name, province_id: s.province_id, last_seen_at: s.controller_last_seen_at, hours_offline: round((Date.now() - new Date(s.controller_last_seen_at!).getTime()) / 3600_000, 1) }));
    const va = st.flatMap((s) => reconFor(s.id, isoDate(dayStart(-13)), isoDate(dayStart(0))).filter((r) => r.variance_l != null && r.sales_volume_l > 0 && Math.abs(r.variance_l / r.sales_volume_l) > 0.01).map((r) => ({ station_id: s.id, station_code: s.code, station_name: s.name, business_date: r.business_date, product_code: r.product_code, variance_l: r.variance_l, variance_pct: round((r.variance_l! / r.sales_volume_l) * 100, 2) })));
    const ff = st.map((s) => {
      const rc = receiptsFor(s.id).filter((r) => new Date(r.tx_ended_at).getTime() > Date.now() - DAY);
      return { station_id: s.id, station_code: s.code, station_name: s.name, failed: rc.filter((r) => r.status === 'failed').length, pending_over_1h: rc.filter((r) => r.status === 'pending' && new Date(r.tx_ended_at).getTime() < Date.now() - 3600_000).length, last_error: rc.find((r) => r.last_error)?.last_error ?? null };
    }).filter((x) => x.failed > 0);
    return HttpResponse.json({ price_violations: pv, offline_stations: off, variance_anomalies: va, fiscal_failures: ff });
  })),
  http.get(`${A}/regulator/stock`, guard(REG, ({ user, url }) => {
    const p = scopedProvince(user, url);
    return HttpResponse.json({ next_cursor: null, items: PROVINCES.filter((x) => !p || x.id === p).flatMap((pr) => productAgg(STATIONS.filter((s) => s.province_id === pr.id)).map((a) => ({ province_id: pr.id, province_name: pr.name, product_code: a.product_code, capacity_l: a.capacity_l, product_volume_l: a.stock_l }))) });
  })),
  http.get(`${A}/regulator/prices`, guard(null, () => HttpResponse.json({ items: CAPS, next_cursor: null }))),
  http.post(`${A}/regulator/prices`, guard(['erb_national'], async ({ request }) => {
    const b = (await request.json()) as { product_code: string; province_id: number | null; price: number; effective_at: string };
    if (!(b.price > 0)) return err(400, 'invalid_price', 'Price must be positive');
    const existing = CAPS.findIndex((c) => c.product_code === b.product_code && c.province_id === b.province_id);
    const row = { id: Date.now(), ...b, effective_at: b.effective_at ?? new Date().toISOString() };
    if (existing >= 0) CAPS.splice(existing, 1, row);
    else CAPS.push(row);
    return HttpResponse.json(row, { status: 201 });
  })),
  http.get(`${A}/regulator/export`, guard(REG, ({ user, url }) => {
    const p = scopedProvince(user, url);
    const date = url.searchParams.get('date') ?? isoDate(dayStart(-1));
    const rows = STATIONS.filter((s) => !p || s.province_id === p).flatMap((s) => reconFor(s.id, date, date).map((r) => ({ business_date: date, station_code: s.code, station_name: s.name, province: s.province_name, company: s.company_name, product_code: r.product_code, opening_stock_l: r.opening_stock_l, deliveries_l: r.deliveries_l, sales_volume_l: r.sales_volume_l, sales_amount: r.sales_amount, closing_stock_l: r.closing_stock_l, variance_l: r.variance_l, avg_price: r.avg_price })));
    if (url.searchParams.get('format') === 'json') return HttpResponse.json({ date, province_id: p, rows });
    const cols = Object.keys(rows[0] ?? { business_date: '' });
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => JSON.stringify((r as Record<string, unknown>)[c] ?? '')).join(','))].join('\r\n');
    return new HttpResponse(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="erb_${date}.csv"` } });
  })),

  // ---- analytics ----
  http.get(`${N}/forecast/demand`, guard(REG, ({ user, url }) => {
    const p = scopedProvince(user, url);
    const pc = url.searchParams.get('product_code') ?? 'PETROL';
    const h = Number(url.searchParams.get('horizon_days') ?? 14);
    const hist = new Map<string, number>();
    for (const r of dailyRows(p, pc, isoDate(dayStart(-60)), isoDate(dayStart(-1)))) hist.set(r.business_date, (hist.get(r.business_date) ?? 0) + r.sales_volume_l);
    const history = [...hist.entries()].sort().map(([date, value]) => ({ date, value }));
    const last7 = history.slice(-7).map((x) => x.value);
    const forecast = Array.from({ length: h }, (_, i) => {
      const v = last7[i % 7] ?? 0;
      const w = v * (0.06 + i * 0.008);
      return { date: isoDate(dayStart(i)), value: round(v, 0), lower: round(v - 1.64 * w, 0), upper: round(v + 1.64 * w, 0) };
    });
    return HttpResponse.json({ history, forecast, model: 'holt_winters_weekly', mape: 0.062 });
  })),
  http.get(`${N}/forecast/stockout`, guard(['erb_national', 'erb_provincial', 'platform_admin', 'owner', 'manager'], ({ user, url }) => {
    const p = scopedProvince(user, url);
    const pc = url.searchParams.get('product_code');
    const sid = url.searchParams.get('station_id');
    const st = (REG.includes(user.role) ? STATIONS : visibleStations(user)).filter((s) => (!p || s.province_id === p) && (!sid || s.id === sid));
    return HttpResponse.json(st.flatMap((s) => tanksFor(s.id).filter((t) => !pc || t.product_code === pc).map((t) => {
      const doc = t.days_of_cover ?? 0;
      return { station_id: s.id, station_name: s.name, product_code: t.product_code, stock_l: t.product_volume_l, avg_daily_sales_l: t.avg_daily_sales_l, days_of_cover: doc, predicted_stockout_date: isoDate(Date.now() + doc * DAY), risk: doc < 2 ? 'high' : doc < 5 ? 'medium' : 'low' };
    })));
  })),
  http.get(`${N}/reserve/national`, guard(REG, ({ user }) => {
    const st = user.role === 'erb_provincial' ? STATIONS.filter((s) => s.province_id === user.province_id) : STATIONS;
    const risk = (d: number | null) => (d == null ? 'low' : d < 7 ? 'high' : d < 15 ? 'medium' : 'low');
    // Include depot stock (data feed) so national cover is realistic.
    const depot: Record<string, number> = { PETROL: 9_800_000, DIESEL: 15_400_000, KEROSENE: 1_100_000 };
    const nationalDemand: Record<string, number> = { PETROL: 1_150_000, DIESEL: 1_620_000, KEROSENE: 95_000 };
    return HttpResponse.json({
      as_of: new Date().toISOString(),
      by_product: productAgg(st).map((a) => {
        const stock = a.stock_l + (user.role === 'erb_provincial' ? 0 : depot[a.product_code] ?? 0);
        const dem = user.role === 'erb_provincial' ? a.sales_24h_l : nationalDemand[a.product_code] ?? a.sales_24h_l;
        const doc = dem ? round(stock / dem, 1) : null;
        return {
          product_code: a.product_code, stock_l: round(stock, 0), capacity_l: a.capacity_l + (depot[a.product_code] ?? 0) * 1.6, avg_daily_demand_l: dem, days_of_cover: doc, risk: risk(doc),
          by_province: PROVINCES.map((pr) => {
            const pa = productAgg(STATIONS.filter((s) => s.province_id === pr.id)).find((x) => x.product_code === a.product_code);
            return pa ? { province_id: pr.id, province_name: pr.name, stock_l: pa.stock_l, avg_daily_demand_l: pa.sales_24h_l, days_of_cover: pa.days_of_cover, risk: risk(pa.days_of_cover) } : null;
          }).filter(Boolean),
        };
      }),
    });
  })),
  http.get(`${N}/anomalies`, guard(REG, ({ user, url }) => {
    const p = scopedProvince(user, url);
    const from = url.searchParams.get('from') ?? isoDate(dayStart(-29));
    const to = url.searchParams.get('to') ?? isoDate(dayStart(0));
    const out = STATIONS.filter((s) => !p || s.province_id === p).flatMap((s) => reconFor(s.id, from, to).filter((r) => r.variance_l != null && r.sales_volume_l > 0 && Math.abs(r.variance_l / r.sales_volume_l) > 0.009).map((r) => {
      const pct = (r.variance_l! / r.sales_volume_l) * 100;
      return { station_id: s.id, station_name: s.name, business_date: r.business_date, product_code: r.product_code, variance_l: r.variance_l, variance_pct: round(pct, 2), zscore: round(pct / 0.25, 2), kind: 'stock_loss' };
    }));
    out.push({ station_id: STATIONS[0].id, station_name: STATIONS[0].name, business_date: isoDate(dayStart(-1)), product_code: 'PETROL', variance_l: 14.2, variance_pct: null as unknown as number, zscore: null as unknown as number, kind: 'totalizer' });
    if (!p || p === 3) out.push({ station_id: STATIONS[6].id, station_name: STATIONS[6].name, business_date: isoDate(dayStart(0)), product_code: 'PETROL', variance_l: null as unknown as number, variance_pct: 0.78, zscore: 3.4, kind: 'price' });
    return HttpResponse.json(out);
  })),
  http.post(`${N}/pricing/simulate`, guard(REG, async ({ request }) => {
    const b = (await request.json()) as Record<string, number | string | undefined>;
    const density = b.product_code === 'DIESEL' ? 0.845 : b.product_code === 'KEROSENE' ? 0.8 : 0.745;
    const fx = Number(b.fx_rate ?? 27.1);
    const fob = (Number(b.fob_usd_per_mt ?? 780) * fx * density) / 1000;
    const freight = (Number(b.freight ?? 95) * fx * density) / 1000;
    const taxes = b.taxes != null ? Number(b.taxes) : 6.92;
    const margins = b.margins != null ? Number(b.margins) : 3.1;
    const breakdown = [
      { component: 'FOB product cost', zmw_per_l: round(fob) },
      { component: 'Freight & insurance', zmw_per_l: round(freight) },
      { component: 'Storage & handling', zmw_per_l: 0.62 },
      { component: 'Strategic reserve levy', zmw_per_l: 0.35 },
      { component: 'Taxes & duties', zmw_per_l: round(taxes) },
      { component: 'OMC & dealer margins', zmw_per_l: round(margins) },
    ];
    const total = round(breakdown.reduce((a, x) => a + x.zmw_per_l, 0));
    return HttpResponse.json({ indicative_price: total, breakdown, model: 'erb_cost_build_up_v1' });
  })),
  http.get(`${N}/models`, guard(REG, () => HttpResponse.json({ next_cursor: null, items: [
    { name: 'reserve_policy_v2', kind: 'python', version: '2.1.0', description: 'Ministry of Energy strategic reserve days-of-cover target model', example_inputs: { product_code: 'DIESEL', current_stock_l: 16200000, daily_demand_l: 1620000, lead_time_days: 21 } },
    { name: 'erb_price_forecast', kind: 'http', version: '0.4.2', description: 'MLflow-served monthly cap price forecast', example_inputs: { product_code: 'PETROL', brent_usd: 78.4, fx_rate: 27.1, months_ahead: 3 } },
  ] }))),
  http.post(`${N}/models/:name/predict`, guard(REG, async ({ request, params }) => {
    const b = (await request.json()) as { inputs?: Record<string, number> };
    const i = b.inputs ?? {};
    if (params.name === 'reserve_policy_v2') {
      const doc = Number(i.current_stock_l ?? 0) / Math.max(1, Number(i.daily_demand_l ?? 1));
      return HttpResponse.json({ outputs: { days_of_cover: round(doc, 1), target_days: 30, shortfall_l: round(Math.max(0, (30 - doc) * Number(i.daily_demand_l ?? 0)), 0), recommendation: doc < 30 ? 'Order additional imports' : 'Adequate' }, model: params.name, version: '2.1.0' });
    }
    return HttpResponse.json({ outputs: { forecast: [32.2, 32.6, 33.1].map((x) => round(x * (Number(i.fx_rate ?? 27.1) / 27.1))), unit: 'ZMW/L' }, model: params.name, version: '0.4.2' });
  })),

  // ---- admin ----
  http.get(`${A}/admin/:entity`, guard(['platform_admin'], ({ params }) => {
    const list = admin[String(params.entity)];
    if (!list) return err(404, 'not_found', 'Unknown resource');
    return HttpResponse.json({ items: list, next_cursor: null });
  })),
  http.post(`${A}/admin/:entity`, guard(['platform_admin'], async ({ params, request }) => {
    const e = String(params.entity);
    const list = admin[e];
    if (!list) return err(404, 'not_found', 'Unknown resource');
    const body = (await request.json()) as Record<string, unknown>;
    const row: Record<string, unknown> = { id: `${e}-${Date.now()}`, ...body, created_at: new Date().toISOString() };
    delete row.password;
    let secret: Record<string, string> = {};
    if (e === 'gateways') secret = { api_key: randKey(String(body.gateway_code ?? 'gw').replace(/\W/g, '').slice(0, 8)) };
    if (e === 'api-clients') {
      const k = randKey(Math.random().toString(36).slice(2, 10));
      row.key_prefix = k.split('.')[0];
      secret = { api_key: k };
    }
    if (e === 'webhooks') secret = { secret: randKey('whsec') };
    list.push(row);
    return HttpResponse.json({ ...row, ...secret }, { status: 201 });
  })),
  http.post(`${A}/admin/:entity/:id/rotate`, guard(['platform_admin'], ({ params }) => {
    const e = String(params.entity);
    const row = admin[e]?.find((r) => String(r.id) === String(params.id));
    if (!row || !['gateways', 'api-clients', 'webhooks'].includes(e)) return err(404, 'not_found', 'Not found');
    if (e === 'webhooks') return HttpResponse.json({ ...row, secret: randKey('whsec') });
    const k = randKey(e === 'gateways' ? String(row.gateway_code).replace(/\W/g, '').slice(0, 8) : Math.random().toString(36).slice(2, 10));
    if (e === 'api-clients') row.key_prefix = k.split('.')[0];
    return HttpResponse.json({ ...row, api_key: k });
  })),
  http.patch(`${A}/admin/:entity/:id`, guard(['platform_admin'], async ({ params, request }) => {
    const list = admin[String(params.entity)];
    const row = list?.find((r) => String(r.id) === String(params.id));
    if (!row) return err(404, 'not_found', 'Not found');
    Object.assign(row, (await request.json()) as Record<string, unknown>);
    return HttpResponse.json(row);
  })),
  http.delete(`${A}/admin/:entity/:id`, guard(['platform_admin'], ({ params }) => {
    const list = admin[String(params.entity)];
    const i = list?.findIndex((r) => String(r.id) === String(params.id)) ?? -1;
    if (i < 0) return err(404, 'not_found', 'Not found');
    list.splice(i, 1);
    return new HttpResponse(null, { status: 204 });
  })),
];

const deliveryEdits = new Map<string, Record<string, unknown>>();
const mfaUsers = new Set<string>();

/** Test helper: invalidate all access tokens (forces refresh flow). */
export function expireAllAccessTokens() {
  for (const v of sessions.values()) v.exp = 0;
}
