import { describe, expect, it } from 'vitest';
import {
  formatDate, formatDateTime, formatLitres, formatLitresCompact, formatPct, formatZMW, formatZMWCompact, freshness, lusakaDate,
  lusakaDayStartISO, timeAgo, variancePct,
} from './format';
import { toCsv } from './csv';
import { capFor } from '../pages/station/PricesTab';
import { varianceLevel } from '../pages/station/ReconciliationTab';
import { deliveryDiff } from '../pages/station/DeliveriesTab';
import { waterfall } from '../pages/erb/Forecasts';
import { extractSecret, toPayload, validate, entityById } from '../pages/admin/entities';

describe('currency & volume formatters', () => {
  it('formats ZMW as "K 1,234.56"', () => {
    expect(formatZMW(1234.56)).toBe('K 1,234.56');
    expect(formatZMW(0)).toBe('K 0.00');
    expect(formatZMW(-12.5)).toBe('-K 12.50');
    expect(formatZMW('31.85')).toBe('K 31.85'); // Postgres NUMERIC as string
    expect(formatZMW(null)).toBe('—');
    expect(formatZMW(undefined)).toBe('—');
  });
  it('compacts large ZMW amounts', () => {
    expect(formatZMWCompact(2_345_678)).toBe('K 2.35M');
    expect(formatZMWCompact(456_700)).toBe('K 456.7k');
    expect(formatZMWCompact(950)).toBe('K 950.00');
  });
  it('formats litres', () => {
    expect(formatLitres(12345.6)).toBe('12,346 L');
    expect(formatLitres(12.345, 2)).toBe('12.35 L');
    expect(formatLitresCompact(1_250_000)).toBe('1.25 ML');
    expect(formatLitresCompact(45_600)).toBe('45.6 kL');
    expect(formatPct(12.345, 1)).toBe('12.3%');
  });
});

describe('time in Africa/Lusaka', () => {
  it('renders timestamps in UTC+2', () => {
    expect(formatDateTime('2026-11-27T10:05:00Z')).toBe('27 Nov 2026, 12:05');
    // just before midnight UTC is next day in Lusaka
    expect(formatDate('2026-11-27T23:30:00Z')).toBe('28 Nov 2026');
    // business dates are not shifted
    expect(formatDate('2026-11-27')).toBe('27 Nov 2026');
  });
  it('computes Lusaka business dates', () => {
    expect(lusakaDate(0, new Date('2026-11-27T22:30:00Z'))).toBe('2026-11-28');
    expect(lusakaDayStartISO('2026-11-28')).toBe('2026-11-27T22:00:00.000Z');
  });
  it('describes freshness', () => {
    const now = Date.parse('2026-11-27T12:00:00Z');
    expect(timeAgo('2026-11-27T11:57:00Z', now)).toBe('3 min ago');
    expect(timeAgo('2026-11-27T11:59:50Z', now)).toBe('just now');
    expect(timeAgo('2026-11-27T09:00:00Z', now)).toBe('3 h ago');
    expect(timeAgo(null, now)).toBe('never');
    expect(freshness('2026-11-27T11:58:00Z', now)).toBe('fresh');
    expect(freshness('2026-11-27T11:30:00Z', now)).toBe('stale');
    expect(freshness('2026-11-27T08:00:00Z', now)).toBe('old');
  });
});

describe('domain helpers', () => {
  it('computes variance % and level', () => {
    expect(variancePct(12, 1000)).toBeCloseTo(1.2);
    expect(variancePct(5, 0)).toBeNull();
    expect(varianceLevel(0.3)).toBe('ok');
    expect(varianceLevel(-0.7)).toBe('warn');
    expect(varianceLevel(1.5)).toBe('bad');
  });
  it('computes received vs invoiced delivery difference', () => {
    const d = deliveryDiff({ start_volume_l: 1000, end_volume_l: 20900, received_volume_l: null, invoiced_volume_l: 20000 });
    expect(d.received).toBe(19900);
    expect(d.diff).toBe(-100);
    expect(d.pct).toBeCloseTo(-0.5);
  });
  it('picks the applicable ERB cap (province beats national, ignores future)', () => {
    const caps = [
      { product_code: 'PETROL', province_id: null, price: 32.15, effective_at: '2026-11-01T00:00:00+02:00' },
      { product_code: 'PETROL', province_id: 10, price: 33.05, effective_at: '2026-11-01T00:00:00+02:00' },
      { product_code: 'PETROL', province_id: null, price: 40, effective_at: '2099-01-01T00:00:00+02:00' },
    ];
    const now = Date.parse('2026-11-27T00:00:00Z');
    expect(capFor(caps, 'PETROL', 5, now)).toBe(32.15);
    expect(capFor(caps, 'PETROL', 10, now)).toBe(33.05);
    expect(capFor(caps, 'DIESEL', 5, now)).toBeNull();
  });
  it('builds a pricing waterfall', () => {
    const w = waterfall([{ component: 'FOB', zmw_per_l: 20 }, { component: 'Tax', value: 7 }, { component: 'Rebate', amount: -2 }], 25);
    expect(w.map((r) => [r.base, r.delta])).toEqual([[0, 20], [20, 7], [25, 2], [0, 25]]);
  });
  it('escapes CSV', () => {
    expect(toCsv([{ a: 'x,y', b: 'say "hi"', c: null }])).toBe('a,b,c\r\n"x,y","say ""hi""",\r\n');
  });
});

describe('admin entity forms', () => {
  const users = entityById('users')!;
  it('applies role-dependent fields', () => {
    const p = toPayload(users, { email: 'a@b.zm', full_name: 'A', role: 'erb_provincial', province_id: '2', company_id: 'x', password: 'longenoughpw', is_active: true, station_ids: ['s1'] }, true);
    expect(p.province_id).toBe(2);
    expect(p.company_id).toBeNull();
    expect(p).not.toHaveProperty('station_ids');
    expect(p.password).toBe('longenoughpw');
    const e = validate(users, { email: 'bad', full_name: '', role: 'owner', company_id: '', password: 'short' }, true);
    expect(e).toMatchObject({ email: 'Invalid email', full_name: 'Required', company_id: 'Required', password: 'At least 10 characters' });
  });
  it('extracts one-time secrets', () => {
    expect(extractSecret({ id: 1, api_key: 'abc.def' })).toEqual({ label: 'api_key', value: 'abc.def' });
    expect(extractSecret({ id: 1 })).toBeNull();
  });
});
