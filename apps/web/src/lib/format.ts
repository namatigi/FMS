export const TZ = 'Africa/Lusaka';

const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const DASH = '—';

function toNum(n: unknown): number | null {
  if (typeof n === 'number') return Number.isFinite(n) ? n : null;
  if (typeof n === 'string' && n.trim() !== '' && Number.isFinite(Number(n))) return Number(n);
  return null;
}
/** Coerce API numerics (which may arrive as strings from Postgres NUMERIC) to numbers; null-safe. */
export function num(v: unknown): number {
  return toNum(v) ?? 0;
}
export function numOrNull(v: unknown): number | null {
  return toNum(v);
}

/** ZMW currency: "K 1,234.56" (negative: "-K 1,234.56"). */
export function formatZMW(v: unknown): string {
  const n = toNum(v);
  if (n === null) return DASH;
  const s = `K ${nf2.format(Math.abs(n))}`;
  return n < 0 ? `-${s}` : s;
}

/** Compact ZMW for KPI tiles: K 1.23M, K 456.7k. */
export function formatZMWCompact(v: unknown): string {
  const n = toNum(v);
  if (n === null) return DASH;
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}K ${nf2.format(a / 1e9)}bn`;
  if (a >= 1e6) return `${sign}K ${nf2.format(a / 1e6)}M`;
  if (a >= 1e5) return `${sign}K ${nf1.format(a / 1e3)}k`;
  return formatZMW(n);
}

export function formatNumber(v: unknown, decimals = 0): string {
  const n = toNum(v);
  if (n === null) return DASH;
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);
}

/** Litres: "12,345 L". */
export function formatLitres(v: unknown, decimals = 0): string {
  const n = toNum(v);
  if (n === null) return DASH;
  return `${formatNumber(n, decimals)} L`;
}

/** Compact litres: 1.23 ML, 45.6 kL, 999 L. */
export function formatLitresCompact(v: unknown): string {
  const n = toNum(v);
  if (n === null) return DASH;
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e6) return `${sign}${nf2.format(a / 1e6)} ML`;
  if (a >= 1e4) return `${sign}${nf1.format(a / 1e3)} kL`;
  return formatLitres(n);
}

export function formatPct(v: unknown, decimals = 1): string {
  const n = toNum(v);
  if (n === null) return DASH;
  return `${formatNumber(n, decimals)}%`;
}

export function formatDays(v: unknown): string {
  const n = toNum(v);
  if (n === null) return DASH;
  return `${nf1.format(n)} d`;
}

const dtFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const dFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: 'short', day: '2-digit' });
const tFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function toDate(v: unknown): Date | null {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "27 Nov 2026, 14:05" in Africa/Lusaka. */
export function formatDateTime(v: unknown): string {
  const d = toDate(v);
  return d ? dtFmt.format(d) : DASH;
}

/** Date in Lusaka. Date-only strings (YYYY-MM-DD) are business dates and are not shifted. */
export function formatDate(v: unknown): string {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return dFmt.format(new Date(Date.UTC(y, m - 1, d, 12)));
  }
  const d = toDate(v);
  return d ? dFmt.format(d) : DASH;
}

export function formatTime(v: unknown): string {
  const d = toDate(v);
  return d ? tFmt.format(d) : DASH;
}

/** "just now", "3 min ago", "2 h ago", "4 d ago". */
export function timeAgo(v: unknown, now: number = Date.now()): string {
  const d = toDate(v);
  if (!d) return 'never';
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Freshness of a reading: fresh < 5 min, stale < 60 min, otherwise old. */
export function freshness(v: unknown, now: number = Date.now()): 'fresh' | 'stale' | 'old' {
  const d = toDate(v);
  if (!d) return 'old';
  const m = (now - d.getTime()) / 60000;
  if (m < 5) return 'fresh';
  if (m < 60) return 'stale';
  return 'old';
}

/** YYYY-MM-DD for "today" in Africa/Lusaka, optionally offset by days. */
export function lusakaDate(offsetDays = 0, now: Date = new Date()): string {
  const d = new Date(now.getTime() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Lusaka is UTC+2 year-round (no DST). Converts a business date to an ISO instant range. */
export function lusakaDayStartISO(date: string): string {
  return new Date(`${date}T00:00:00+02:00`).toISOString();
}
export function lusakaDayEndISO(date: string): string {
  return new Date(new Date(`${date}T00:00:00+02:00`).getTime() + 86400000).toISOString();
}

/** Variance as a % of sales volume (null when not computable). */
export function variancePct(variance: unknown, sales: unknown): number | null {
  const v = toNum(variance);
  const s = toNum(sales);
  if (v === null || s === null || s === 0) return null;
  return (v / s) * 100;
}

/** Human label from snake_case / camelCase keys. */
export function humanize(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\b(l)\b/g, '(L)')
    .replace(/^./, (c) => c.toUpperCase());
}
