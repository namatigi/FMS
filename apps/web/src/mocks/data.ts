/* Deterministic fixture generator matching docs/api/CONTRACTS.md shapes. */
import { PROVINCES, type Alert, type CapPrice, type Delivery, type FiscalReceipt, type ReconRow, type Station, type Tank, type Transaction, type User, type UserRole } from '../types';

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const DAY = 86400000;
/** Lusaka-midnight (UTC+2) epoch ms for "today minus n days". */
export function dayStart(offset = 0, now = Date.now()) {
  const lusaka = new Date(now + 2 * 3600_000);
  const d = Date.UTC(lusaka.getUTCFullYear(), lusaka.getUTCMonth(), lusaka.getUTCDate()) - 2 * 3600_000;
  return d + offset * DAY;
}
export const isoDate = (ms: number) => new Date(ms + 2 * 3600_000).toISOString().slice(0, 10);

export const COMPANIES = [
  { id: '11111111-1111-1111-1111-111111111111', name: 'Zambezi Petroleum Ltd', zra_tpin: '1000000001', erb_licence_no: 'ERB/OMC/001', contact_email: 'ops@zambezi.example', contact_phone: '+260211000001' },
  { id: '22222222-2222-2222-2222-222222222222', name: 'Copper Fuels Ltd', zra_tpin: '1000000002', erb_licence_no: 'ERB/OMC/002', contact_email: 'ops@copperfuels.example', contact_phone: '+260212000002' },
  { id: '33333333-3333-3333-3333-333333333333', name: 'Kafue Energy Ltd', zra_tpin: '1000000003', erb_licence_no: 'ERB/OMC/003', contact_email: 'ops@kafue.example', contact_phone: '+260213000003' },
];

type Conn = 'online' | 'degraded' | 'offline';
const S: [string, string, number, string, string, number, number, number, Conn][] = [
  // code, name, companyIdx, district, town, province, lat, lng, connectivity
  ['LUS-0001', 'Zambezi Cairo Road', 0, 'Lusaka', 'Lusaka', 5, -15.4167, 28.2833, 'online'],
  ['CEN-0001', 'Zambezi Kabwe North', 0, 'Kabwe', 'Kabwe', 1, -14.4469, 28.4464, 'online'],
  ['COP-0001', 'Copper Fuels Kitwe', 1, 'Kitwe', 'Kitwe', 2, -12.8024, 28.2132, 'online'],
  ['SOU-0001', 'Copper Fuels Livingstone', 1, 'Livingstone', 'Livingstone', 9, -17.8419, 25.8543, 'degraded'],
  ['LUS-0002', 'Zambezi Great East Road', 0, 'Lusaka', 'Lusaka', 5, -15.3958, 28.3365, 'online'],
  ['COP-0002', 'Copper Fuels Ndola Broadway', 1, 'Ndola', 'Ndola', 2, -12.9587, 28.6366, 'offline'],
  ['EAS-0001', 'Kafue Energy Chipata', 2, 'Chipata', 'Chipata', 3, -13.6333, 32.65, 'online'],
  ['NOR-0001', 'Kafue Energy Kasama', 2, 'Kasama', 'Kasama', 7, -10.2129, 31.1808, 'online'],
  ['NWE-0001', 'Copper Fuels Solwezi', 1, 'Solwezi', 'Solwezi', 8, -12.1688, 26.3894, 'online'],
  ['WES-0001', 'Kafue Energy Mongu', 2, 'Mongu', 'Mongu', 10, -15.2484, 23.1274, 'offline'],
  ['LUA-0001', 'Zambezi Mansa', 0, 'Mansa', 'Mansa', 4, -11.1996, 28.8943, 'online'],
  ['MUC-0001', 'Kafue Energy Chinsali', 2, 'Chinsali', 'Chinsali', 6, -10.5414, 32.0816, 'degraded'],
  ['SOU-0002', 'Zambezi Choma', 0, 'Choma', 'Choma', 9, -16.8065, 26.9531, 'online'],
  ['COP-0003', 'Copper Fuels Chingola', 1, 'Chingola', 'Chingola', 2, -12.5289, 27.8536, 'online'],
];

const now0 = Date.now();
const lastSeen: Record<Conn, number> = { online: 20_000, degraded: 25 * 60_000, offline: 30 * 3600_000 };

export const STATIONS: (Station & { connection_mode: string; erb_licence_no: string; zra_branch_id: string })[] = S.map((s, i) => {
  const c = COMPANIES[s[2]];
  return {
    id: `aaaaaaaa-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
    code: s[0], name: s[1], company_id: c.id, company_name: c.name, province_id: s[5],
    province_name: PROVINCES.find((p) => p.id === s[5])!.name,
    district: s[3], town: s[4], latitude: s[6], longitude: s[7], status: 'active', connectivity: s[8],
    controller_last_seen_at: new Date(now0 - lastSeen[s[8]] - i * 3000).toISOString(),
    connection_mode: i % 2 ? 'direct' : 'edge', erb_licence_no: `ERB/RS/${1001 + i}`, zra_branch_id: '000',
  };
});

export const CAPS: CapPrice[] = [
  { id: 1, product_code: 'PETROL', province_id: null, price: 32.15, effective_at: '2026-11-01T00:00:00+02:00' },
  { id: 2, product_code: 'DIESEL', province_id: null, price: 30.29, effective_at: '2026-11-01T00:00:00+02:00' },
  { id: 3, product_code: 'KEROSENE', province_id: null, price: 26.8, effective_at: '2026-11-01T00:00:00+02:00' },
  { id: 4, product_code: 'PETROL', province_id: 10, price: 33.05, effective_at: '2026-11-01T00:00:00+02:00' },
];

export const GRADES = (stationIdx: number) => [
  { id: `fg-${stationIdx}-1`, pts_grade_id: 1, name: 'Unleaded Petrol', product_code: 'PETROL', zra_item_code: 'ZM1NTLTR0000001', price: stationIdx === 6 ? 32.4 : 31.85, station_id: STATIONS[stationIdx].id },
  { id: `fg-${stationIdx}-2`, pts_grade_id: 2, name: 'Diesel LSD', product_code: 'DIESEL', zra_item_code: 'ZM1NTLTR0000002', price: 29.95, station_id: STATIONS[stationIdx].id },
  ...(stationIdx % 4 === 0 ? [{ id: `fg-${stationIdx}-3`, pts_grade_id: 3, name: 'Illuminating Kerosene', product_code: 'KEROSENE', zra_item_code: 'ZM1NTLTR0000003', price: 26.5, station_id: STATIONS[stationIdx].id }] : []),
];

const tankCache = new Map<string, Tank[]>();
export function tanksFor(stationId: string): Tank[] {
  const idx = STATIONS.findIndex((s) => s.id === stationId);
  if (idx < 0) return [];
  if (tankCache.has(stationId)) return tankCache.get(stationId)!;
  const r = rng(idx + 11);
  const st = STATIONS[idx];
  const spec: [number, string, number][] = [[1, 'PETROL', 30000], [2, 'DIESEL', 40000]];
  if (idx % 4 === 0) spec.push([3, 'KEROSENE', 15000]);
  const tanks = spec.map(([no, p, cap]) => {
    let fill = 0.25 + r() * 0.65;
    if (idx === 2 && no === 1) fill = 0.12; // low stock
    if (idx === 9 && no === 2) fill = 0.08;
    if (idx === 7 && no === 1) fill = 0.17;
    if (idx === 4 && no === 1) fill = 0.14;
    const vol = round(cap * fill, 1);
    const avg = round(cap * (0.06 + r() * 0.08), 0);
    const alarms: string[] = [];
    if (fill < 0.1) alarms.push('CriticalLowProduct');
    else if (fill < 0.2) alarms.push('LowProduct');
    const water = idx === 4 && no === 2 ? 42 : round(r() * 12, 0);
    if (water > 30) alarms.push('HighWater');
    return {
      tank_no: no, product_code: p, capacity_l: cap, product_volume_l: vol, ullage_l: round(cap * 0.95 - vol, 1),
      water_height_mm: water, temperature_c: round(22 + r() * 8, 1), fill_pct: round(fill * 100, 1),
      measured_at: new Date(new Date(st.controller_last_seen_at!).getTime() - 5000).toISOString(),
      probe_status: idx === 11 && no === 2 ? 'Error' : 'OK', alarms, avg_daily_sales_l: avg, days_of_cover: round(vol / avg, 1),
    } satisfies Tank;
  });
  tankCache.set(stationId, tanks);
  return tanks;
}

const txCache = new Map<string, Transaction[]>();
/** ~14 days of transactions (newest first). */
export function transactionsFor(stationId: string): Transaction[] {
  if (txCache.has(stationId)) return txCache.get(stationId)!;
  const idx = STATIONS.findIndex((s) => s.id === stationId);
  if (idx < 0) return [];
  const r = rng(idx * 97 + 3);
  const grades = GRADES(idx);
  const out: Transaction[] = [];
  const end = Date.now() - (STATIONS[idx].connectivity === 'offline' ? 30 * 3600_000 : 60_000);
  let t = end;
  const start = dayStart(-14);
  let n = 0;
  while (t > start) {
    const hour = new Date(t + 2 * 3600_000).getUTCHours();
    const busy = hour >= 6 && hour <= 20 ? 1 : 0.25;
    t -= (4 + r() * 10) * 60_000 / busy;
    const g = grades[r() < 0.55 ? 0 : r() < 0.9 || grades.length < 3 ? 1 : 2];
    const vol = round(5 + r() * (g.product_code === 'DIESEL' ? 120 : 45), 2);
    const status = r() < 0.94 ? 'signed' : r() < 0.6 ? 'pending' : 'failed';
    n++;
    out.push({
      id: `${idx}-${n}`, ended_at: new Date(t).toISOString(), pump_no: 1 + Math.floor(r() * 2), nozzle_no: g.pts_grade_id,
      product_code: g.product_code, volume_l: vol, price: g.price, amount: round(vol * g.price, 2),
      tag: r() < 0.2 ? `TAG${1000 + Math.floor(r() * 50)}` : null, fiscal_status: status,
      zra_rcpt_no: status === 'signed' ? String(100000 + idx * 10000 + n) : null,
    });
  }
  txCache.set(stationId, out);
  return out;
}

export function receiptsFor(stationId: string): FiscalReceipt[] {
  const st = STATIONS.find((s) => s.id === stationId)!;
  return transactionsFor(stationId).map((t, i) => ({
    id: `r-${t.id}`, station_id: stationId, station_name: st.name, pump_no: t.pump_no, pts_transaction_no: 5000 + i,
    tx_ended_at: t.ended_at,
    invoice_no: `${st.code}-P${t.pump_no}-${5000 + i}-${t.ended_at.replace(/\D/g, '').slice(0, 14)}`,
    status: t.fiscal_status === 'signed' ? (i % 3 ? 'printed' : 'signed') : t.fiscal_status,
    fiscalised_by: st.connection_mode === 'edge' ? 'edge' : 'cloud', zra_rcpt_no: t.zra_rcpt_no,
    zra_sdc_id: t.zra_rcpt_no ? `SDC0100${String(STATIONS.indexOf(st)).padStart(4, '0')}` : null,
    zra_mrc_no: t.zra_rcpt_no ? `WIS0100${String(STATIONS.indexOf(st)).padStart(4, '0')}` : null,
    zra_qr_url: t.zra_rcpt_no ? `https://vsdc.zra.org.zm/verify?rcpt=${t.zra_rcpt_no}` : null,
    zra_signed_at: t.zra_rcpt_no ? new Date(new Date(t.ended_at).getTime() + 1800).toISOString() : null,
    attempts: t.fiscal_status === 'signed' ? 1 : t.fiscal_status === 'failed' ? 6 : 2,
    last_error: t.fiscal_status === 'failed' ? 'VSDC timeout (resultCd 999)' : null,
    amount: t.amount, volume_l: t.volume_l, product_code: t.product_code,
  }));
}

export function deliveriesFor(stationId: string): Delivery[] {
  const idx = STATIONS.findIndex((s) => s.id === stationId);
  const r = rng(idx * 7 + 1);
  const out: Delivery[] = [];
  for (let d = 1; d < 30; d += 3 + Math.floor(r() * 3)) {
    const tank = r() < 0.5 ? 1 : 2;
    const start = dayStart(-d) + (8 + r() * 6) * 3600_000;
    const startVol = round(4000 + r() * 5000, 1);
    const recv = round(15000 + r() * 12000, 1);
    const inv = d > 3 ? round(recv * (1 + (r() - 0.6) * 0.015), 0) : null;
    out.push({
      id: idx * 1000 + d, station_id: stationId, tank_no: tank, product_code: tank === 1 ? 'PETROL' : 'DIESEL',
      started_at: new Date(start).toISOString(), ended_at: new Date(start + 40 * 60_000).toISOString(),
      start_volume_l: startVol, end_volume_l: round(startVol + recv, 1), received_volume_l: recv,
      delivery_note_no: inv ? `DN-${24000 + idx * 100 + d}` : null, supplier: inv ? (r() < 0.5 ? 'TAZAMA / Indeni' : 'Puma Energy Depot Ndola') : null,
      invoiced_volume_l: inv,
    });
  }
  return out;
}

export function reconFor(stationId: string, from: string, to: string): ReconRow[] {
  const idx = STATIONS.findIndex((s) => s.id === stationId);
  const r = rng(idx * 31 + 5);
  const tanks = tanksFor(stationId);
  const tx = transactionsFor(stationId);
  const dels = deliveriesFor(stationId);
  const rows: ReconRow[] = [];
  for (let d = 0; d > -30; d--) {
    const date = isoDate(dayStart(d));
    if (date < from || date > to) continue;
    for (const t of tanks) {
      const sod = dayStart(d);
      const sales = tx.filter((x) => x.product_code === t.product_code && new Date(x.ended_at).getTime() >= sod && new Date(x.ended_at).getTime() < sod + DAY);
      const vol = round(sales.reduce((a, x) => a + x.volume_l, 0), 1);
      const amt = round(sales.reduce((a, x) => a + x.amount, 0), 2);
      const del = round(dels.filter((x) => x.product_code === t.product_code && isoDate(new Date(x.ended_at).getTime()) === date).reduce((a, x) => a + (x.received_volume_l ?? 0), 0), 1);
      const opening = round(t.capacity_l * (0.35 + r() * 0.4), 1);
      let variance = round(vol * (r() - 0.45) * 0.008, 1);
      if (idx === 5 && d === -2 && t.product_code === 'DIESEL') variance = round(vol * 0.034, 1);
      if (idx === 0 && d === -4 && t.product_code === 'PETROL') variance = round(vol * 0.012, 1);
      rows.push({
        station_id: stationId, business_date: date, product_code: t.product_code, province_id: STATIONS[idx].province_id,
        sales_volume_l: vol, sales_amount: amt, tx_count: sales.length, opening_stock_l: opening, deliveries_l: del,
        closing_stock_l: d === 0 ? null : round(opening + del - vol - variance, 1), variance_l: d === 0 ? null : variance,
        avg_price: vol ? round(amt / vol, 2) : null,
      });
    }
  }
  return rows;
}

const ALERT_DEFS: [number, string, string, Alert['severity'], string, number][] = [
  [2, 'tank', 'LowProduct', 'warning', 'Tank 1 Petrol below reorder level', 40],
  [9, 'tank', 'CriticalLowProduct', 'critical', 'Tank 2 Diesel critically low', 95],
  [5, 'controller', 'ControllerOffline', 'critical', 'No data from PTS-2 for 30 h', 1800],
  [4, 'tank', 'HighWater', 'warning', 'Water 42 mm in tank 2', 120],
  [0, 'pump', 'TotalizerMismatch', 'critical', 'Pump 2 nozzle 1 totaliser gap 14.2 L (possible manual mode)', 300],
  [0, 'system', 'StockVariance', 'warning', 'Petrol variance 1.2% on business day −4', 4000],
  [11, 'probe', 'ProbeError', 'warning', 'Tank 2 probe error', 60],
  [3, 'gateway', 'GatewayBacklog', 'warning', 'Edge gateway backlog 214 records', 25],
  [7, 'tank', 'LowProduct', 'warning', 'Tank 1 Petrol below reorder level', 200],
  [1, 'pump', 'PumpOffline', 'info', 'Pump 2 offline 4 min (recovered)', 3000],
];
export const ALERTS: Alert[] = ALERT_DEFS.map(([si, dev, code, sev, msg, minsAgo], i) => ({
  id: i + 1, station_id: STATIONS[si].id, station_name: STATIONS[si].name, occurred_at: new Date(now0 - minsAgo * 60_000).toISOString(),
  device_type: dev, device_no: dev === 'tank' || dev === 'pump' || dev === 'probe' ? 1 + (i % 2) : null, code, severity: sev, message: msg,
  acknowledged_at: i === 9 ? new Date(now0 - 2900 * 60_000).toISOString() : null,
}));

export interface MockUser extends User {
  password: string;
}
export const USERS: MockUser[] = [
  { id: 'u-admin', email: 'admin@fms.local', full_name: 'Platform Admin', role: 'platform_admin', company_id: null, province_id: null, password: 'ChangeMe123!' },
  { id: 'u-owner', email: 'owner@zambezi.local', full_name: 'Zambezi Owner', role: 'owner', company_id: COMPANIES[0].id, province_id: null, password: 'ChangeMe123!' },
  { id: 'u-manager', email: 'manager@zambezi.local', full_name: 'Cairo Road Manager', role: 'manager', company_id: COMPANIES[0].id, province_id: null, password: 'ChangeMe123!' },
  { id: 'u-erb', email: 'erb@erb.local', full_name: 'ERB National Analyst', role: 'erb_national', company_id: null, province_id: null, password: 'ChangeMe123!' },
  { id: 'u-erbcop', email: 'erb.cop@erb.local', full_name: 'ERB Copperbelt Officer', role: 'erb_provincial', company_id: null, province_id: 2, password: 'ChangeMe123!' },
  { id: 'u-zra', email: 'zra@zra.local', full_name: 'ZRA Auditor', role: 'zra_auditor', company_id: null, province_id: null, password: 'ChangeMe123!' },
];
export const MANAGER_STATIONS: Record<string, string[]> = { 'u-manager': [STATIONS[0].id] };

/** Stations visible to a user (mirrors the server-side scoping table in CONTRACTS.md). */
export function visibleStations(u: User) {
  const role: UserRole = u.role;
  if (role === 'owner') return STATIONS.filter((s) => s.company_id === u.company_id);
  if (role === 'manager') return STATIONS.filter((s) => MANAGER_STATIONS[u.id]?.includes(s.id));
  if (role === 'erb_provincial') return STATIONS.filter((s) => s.province_id === u.province_id);
  return STATIONS;
}

export const r01 = rng;
