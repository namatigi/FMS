/**
 * Formatting helpers. Implemented by hand (no Intl) so output is identical on
 * Hermes, JSC, web and in Jest.
 */

export type Numeric = number | string | null | undefined;

/** Coerce API numerics (JSON numbers, or NUMERIC-as-string defensively) to number | null. */
export function toNum(v: Numeric): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 1234567.891 -> "1,234,567.89" (decimals = 2). */
export function formatNumber(v: Numeric, decimals = 0): string {
  const n = toNum(v);
  if (n === null) return '—';
  const neg = n < 0;
  const fixed = Math.abs(n).toFixed(decimals);
  const [int, frac] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const out = frac !== undefined ? `${grouped}.${frac}` : grouped;
  // Avoid "-0.00"
  return neg && Number(fixed) !== 0 ? `-${out}` : out;
}

/** Zambian Kwacha: 1234.5 -> "K 1,234.50"; -5 -> "-K 5.00". */
export function formatZmw(v: Numeric): string {
  const n = toNum(v);
  if (n === null) return '—';
  const body = formatNumber(Math.abs(n), 2);
  return n < 0 && body !== '0.00' ? `-K ${body}` : `K ${body}`;
}

/** Compact Kwacha for tiles: 1_234_567 -> "K 1.23M", 45_600 -> "K 45.6k". */
export function formatZmwCompact(v: Numeric): string {
  const n = toNum(v);
  if (n === null) return '—';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1_000_000) return `${sign}K ${trimZeros((a / 1_000_000).toFixed(2))}M`;
  if (a >= 10_000) return `${sign}K ${trimZeros((a / 1_000).toFixed(1))}k`;
  return formatZmw(n);
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Litres: 12345.6 -> "12,346 L" (decimals default 0). */
export function formatLitres(v: Numeric, decimals = 0): string {
  const n = toNum(v);
  if (n === null) return '—';
  return `${formatNumber(n, decimals)} L`;
}

export function formatPct(v: Numeric, decimals = 0): string {
  const n = toNum(v);
  if (n === null) return '—';
  return `${n.toFixed(decimals)}%`;
}

export function formatTemp(v: Numeric): string {
  const n = toNum(v);
  return n === null ? '—' : `${n.toFixed(1)} °C`;
}

export function formatMm(v: Numeric): string {
  const n = toNum(v);
  return n === null ? '—' : `${formatNumber(n, 0)} mm`;
}

export function formatDaysOfCover(v: Numeric): string {
  const n = toNum(v);
  if (n === null) return '—';
  if (n < 1) return '< 1 day';
  if (n >= 99) return '99+ days';
  return `${n.toFixed(1)} days`;
}

const pad = (n: number) => String(n).padStart(2, '0');

function toDate(d: Date | string | number | null | undefined): Date | null {
  if (d === null || d === undefined) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Device-local 24h clock "HH:MM". */
export function formatTimeHHMM(d: Date | string | number | null | undefined): string {
  const date = toDate(d);
  return date ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : '—';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "27 Nov 14:05" */
export function formatDateTime(d: Date | string | number | null | undefined): string {
  const date = toDate(d);
  if (!date) return '—';
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${formatTimeHHMM(date)}`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" */
export function formatRelative(d: Date | string | number | null | undefined, now: Date = new Date()): string {
  const date = toDate(d);
  if (!date) return 'never';
  const s = Math.round((now.getTime() - date.getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Banner text when serving cached data. */
export function offlineMessage(updatedAt: number | Date | null | undefined): string {
  if (!updatedAt) return 'Offline — no cached data yet';
  return `Offline — showing data from ${formatTimeHHMM(updatedAt)}`;
}

export const PRODUCT_LABELS: Record<string, string> = {
  PETROL: 'Petrol',
  DIESEL: 'Diesel',
  KEROSENE: 'Kerosene',
  JETA1: 'Jet A-1',
  LPG: 'LPG',
};

export function productLabel(code: string | null | undefined): string {
  if (!code) return 'Unknown';
  return PRODUCT_LABELS[code] ?? code;
}

/** Split a camel/Pascal alert code into words: "TankLeakage" -> "Tank leakage". */
export function humanizeCode(code: string): string {
  const words = code.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/**
 * Start and end of "today" in Zambia (Africa/Lusaka, UTC+2, no DST) as ISO strings
 * with offset, for `from=`/`to=` query params.
 */
export function lusakaDayRange(now: Date = new Date()): { from: string; to: string; date: string } {
  const shifted = new Date(now.getTime() + 2 * 3600_000);
  const y = shifted.getUTCFullYear();
  const mo = pad(shifted.getUTCMonth() + 1);
  const da = pad(shifted.getUTCDate());
  const date = `${y}-${mo}-${da}`;
  const next = new Date(Date.UTC(y, shifted.getUTCMonth(), shifted.getUTCDate() + 1));
  const nextDate = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
  return { from: `${date}T00:00:00+02:00`, to: `${nextDate}T00:00:00+02:00`, date };
}

/** Clamp to [0,100]. */
export function clampPct(v: Numeric): number {
  const n = toNum(v);
  if (n === null) return 0;
  return Math.max(0, Math.min(100, n));
}
