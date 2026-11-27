import {
  formatDaysOfCover,
  formatLitres,
  formatNumber,
  formatRelative,
  formatTimeHHMM,
  formatZmw,
  formatZmwCompact,
  humanizeCode,
  lusakaDayRange,
  offlineMessage,
  toNum,
} from '../src/lib/format';
import { validatePrice } from '../src/screens/PricesScreen';
import { capFor } from '../src/api/queries';

describe('formatZmw', () => {
  it('formats kwacha with grouping and 2 decimals', () => {
    expect(formatZmw(1234.56)).toBe('K 1,234.56');
    expect(formatZmw(0)).toBe('K 0.00');
    expect(formatZmw(1234567.891)).toBe('K 1,234,567.89');
    expect(formatZmw(31.85)).toBe('K 31.85');
  });
  it('handles negatives, strings and nulls', () => {
    expect(formatZmw(-5)).toBe('-K 5.00');
    expect(formatZmw('29.95')).toBe('K 29.95');
    expect(formatZmw(null)).toBe('—');
    expect(formatZmw(undefined)).toBe('—');
    expect(formatZmw('abc')).toBe('—');
    expect(formatZmw(-0.001)).toBe('K 0.00');
  });
  it('compacts large values', () => {
    expect(formatZmwCompact(1_234_567)).toBe('K 1.23M');
    expect(formatZmwCompact(45_600)).toBe('K 45.6k');
    expect(formatZmwCompact(999)).toBe('K 999.00');
  });
});

describe('numbers & litres', () => {
  it('groups thousands', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(-1234.5, 1)).toBe('-1,234.5');
    expect(formatLitres(12345.6)).toBe('12,346 L');
    expect(formatLitres(40.123, 2)).toBe('40.12 L');
  });
  it('toNum coerces safely', () => {
    expect(toNum('12.5')).toBe(12.5);
    expect(toNum('')).toBeNull();
    expect(toNum(NaN)).toBeNull();
  });
  it('days of cover', () => {
    expect(formatDaysOfCover(0.4)).toBe('< 1 day');
    expect(formatDaysOfCover(4.25)).toBe('4.3 days');
    expect(formatDaysOfCover(250)).toBe('99+ days');
    expect(formatDaysOfCover(null)).toBe('—');
  });
});

describe('time', () => {
  it('HH:MM in device time', () => {
    const d = new Date(2026, 10, 27, 9, 5);
    expect(formatTimeHHMM(d)).toBe('09:05');
    expect(offlineMessage(d.getTime())).toBe('Offline — showing data from 09:05');
    expect(offlineMessage(undefined)).toBe('Offline — no cached data yet');
  });
  it('relative', () => {
    const now = new Date('2026-11-27T12:00:00Z');
    expect(formatRelative('2026-11-27T11:59:50Z', now)).toBe('just now');
    expect(formatRelative('2026-11-27T11:55:00Z', now)).toBe('5 min ago');
    expect(formatRelative('2026-11-27T09:00:00Z', now)).toBe('3 h ago');
    expect(formatRelative('2026-11-24T12:00:00Z', now)).toBe('3 d ago');
    expect(formatRelative(null, now)).toBe('never');
  });
  it('Lusaka day range is UTC+2', () => {
    // 23:30 UTC on 27 Nov is 01:30 on 28 Nov in Lusaka
    expect(lusakaDayRange(new Date('2026-11-27T23:30:00Z'))).toEqual({
      from: '2026-11-28T00:00:00+02:00',
      to: '2026-11-29T00:00:00+02:00',
      date: '2026-11-28',
    });
    expect(lusakaDayRange(new Date('2026-12-31T10:00:00Z')).to).toBe('2027-01-01T00:00:00+02:00');
  });
});

describe('misc', () => {
  it('humanizes alert codes', () => {
    expect(humanizeCode('TotalizerMismatch')).toBe('Totalizer mismatch');
    expect(humanizeCode('HIGH_WATER')).toBe('High water');
  });
  it('validates prices against ERB cap', () => {
    expect(validatePrice('31.85', 32.15)).toBeNull();
    expect(validatePrice('32.50', 32.15)).toBe('Above ERB cap of K 32.15');
    expect(validatePrice('abc', null)).toMatch(/number/);
    expect(validatePrice('31.855', null)).toMatch(/2 decimals/);
    expect(validatePrice('0', null)).toMatch(/greater than zero/);
    expect(validatePrice('', null)).toBe('Enter a price');
  });
  it('picks province cap over national cap', () => {
    const caps = [
      { product_code: 'PETROL', province_id: null, price: 32.15, effective_at: '' },
      { product_code: 'PETROL', province_id: 2, price: 32.6, effective_at: '' },
    ];
    expect(capFor(caps, 'PETROL', 2)).toBe(32.6);
    expect(capFor(caps, 'PETROL', 5)).toBe(32.15);
    expect(capFor(caps, 'DIESEL', 5)).toBeNull();
  });
});
