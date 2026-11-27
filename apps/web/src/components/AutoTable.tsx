import type { ReactNode } from 'react';
import { DataTable, type Column } from './DataTable';
import { formatDate, formatDateTime, formatLitres, formatNumber, formatPct, formatZMW, humanize, timeAgo } from '../lib/format';
import { productLabel, provinceName } from '../types';
import { Badge, ConnectivityBadge, FiscalBadge } from './ui';

/** Render a value by key-name convention (used for loosely specified rows, e.g. compliance lists). */
export function autoFormat(key: string, v: unknown): ReactNode {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return <code className="mono">{JSON.stringify(v)}</code>;
  if (key === 'product_code') return productLabel(String(v));
  if (key === 'province_id') return provinceName(Number(v));
  if (key === 'connectivity') return <ConnectivityBadge value={String(v)} />;
  if (key === 'fiscal_status' || (key === 'status' && ['pending', 'signed', 'failed', 'printed'].includes(String(v)))) return <FiscalBadge value={String(v)} />;
  if (key === 'severity' || key === 'risk' || key === 'kind') return <Badge tone={v === 'high' || v === 'critical' ? 'bad' : v === 'medium' || v === 'warning' ? 'warn' : 'neutral'}>{String(v)}</Badge>;
  if (/last_seen|_seen_at/.test(key)) return <span title={formatDateTime(v)}>{timeAgo(v)}</span>;
  if (/(_at|_time)$/.test(key)) return formatDateTime(v);
  if (/date$/.test(key)) return formatDate(String(v).slice(0, 10));
  if (/_pct$|percent/.test(key)) return formatPct(v, 2);
  if (/_l$/.test(key)) return formatLitres(v, 1);
  if (/(price|amount|cap|_zmw)$/.test(key) || /^(price|cap|erb_cap|amount)/.test(key)) return formatZMW(v);
  if (typeof v === 'number') return formatNumber(v, Number.isInteger(v) ? 0 : 2);
  return String(v);
}

const HIDE = new Set(['id', 'station_id', 'company_id']);

export function AutoTable({ rows, caption, emptyTitle, preferred = [] }: { rows: Record<string, unknown>[]; caption: string; emptyTitle?: string; preferred?: string[] }) {
  const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r)))).filter((k) => !HIDE.has(k) || (k === 'station_id' && !rows.some((r) => r.station_name || r.name)));
  keys.sort((a, b) => {
    const ia = preferred.indexOf(a);
    const ib = preferred.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const cols: Column<Record<string, unknown>>[] = keys.map((k) => ({
    key: k,
    header: humanize(k),
    align: rows.some((r) => typeof r[k] === 'number') ? 'right' : undefined,
    render: (r) => autoFormat(k, r[k]),
  }));
  return <DataTable dense caption={caption} rows={rows} columns={cols} rowKey={(r, i) => String(r.id ?? i)} emptyTitle={emptyTitle} />;
}
