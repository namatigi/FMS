import { VSDC_SPEC } from './spec.js';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of an instant in the given IANA time zone. */
export function zonedParts(at: Date | string, timeZone = VSDC_SPEC.timeZone) {
  const d = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid date: ${String(at)}`);
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(d)) parts[p.type] = p.value;
  return { y: parts.year!, M: parts.month!, d: parts.day!, H: parts.hour!, m: parts.minute!, s: parts.second! };
}

/** yyyyMMddHHmmss in the station time zone (default Africa/Lusaka). */
export function formatVsdcDateTime(at: Date | string, timeZone = VSDC_SPEC.timeZone): string {
  const p = zonedParts(at, timeZone);
  return `${p.y}${p.M}${p.d}${p.H}${p.m}${p.s}`;
}

/** yyyyMMdd in the station time zone (default Africa/Lusaka). */
export function formatVsdcDate(at: Date | string, timeZone = VSDC_SPEC.timeZone): string {
  const p = zonedParts(at, timeZone);
  return `${p.y}${p.M}${p.d}`;
}

/** Parse a VSDC yyyyMMddHHmmss timestamp (Lusaka local time) into an ISO-8601 string with offset. */
export function parseVsdcDateTime(s: string | null | undefined, offset = VSDC_SPEC.utcOffset): string | null {
  if (!s || !/^\d{14}$/.test(s)) return null;
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}${offset}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

export interface InvoiceNoParts {
  stationCode: string;
  pumpNo: number;
  ptsTransactionNo: number;
  endedAt: Date | string;
  timeZone?: string;
}

/**
 * Deterministic invoice number (DESIGN.md §7):
 *   <station_code>-P<pump>-<pts_transaction_no>-<yyyyMMddHHmmss of ended_at, station-local>
 * Used as cisInvcNo by every fiscalisation path (edge and cloud) so retries never double-sign.
 */
export function buildInvoiceNo(p: InvoiceNoParts): string {
  return `${p.stationCode}-P${p.pumpNo}-${p.ptsTransactionNo}-${formatVsdcDateTime(p.endedAt, p.timeZone ?? VSDC_SPEC.timeZone)}`;
}
