import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api/endpoints';
import { formatDate, formatLitres, formatLitresCompact, formatNumber, formatTime, formatZMW, formatZMWCompact, lusakaDate, lusakaDayEndISO, lusakaDayStartISO, num } from '../../lib/format';
import { productLabel, type SalesBucket } from '../../types';
import { productColor, SERIES } from '../../lib/theme';
import { Card, DateRange, Empty, Kpi, QueryView, Segmented } from '../../components/ui';
import { DataTable } from '../../components/DataTable';

type Group = 'hour' | 'day' | 'product' | 'pump';
type Metric = 'volume_l' | 'amount';

export function bucketLabel(bucket: string, group: Group): string {
  if (group === 'hour') {
    // core-api: UTC ISO timestamp of the Lusaka hour start
    if (/^\d{1,2}$/.test(bucket)) return `${bucket.padStart(2, '0')}:00`;
    return `${formatDate(bucket).slice(0, 6)} ${formatTime(bucket)}`;
  }
  if (group === 'day') return formatDate(bucket.slice(0, 10));
  if (group === 'product') return productLabel(bucket);
  return `Pump ${bucket}`;
}

/** Pivot buckets to chart rows: one row per bucket, one numeric key per product. */
function pivot(rows: SalesBucket[], group: Group, metric: Metric) {
  const map = new Map<string, Record<string, number | string>>();
  const series = new Set<string>();
  for (const r of rows) {
    const key = group === 'pump' ? String(r.pump_no ?? r.bucket) : group === 'product' ? String(r.product_code ?? r.bucket) : r.bucket;
    const s = group === 'product' ? 'total' : r.product_code ?? 'total';
    series.add(s);
    const row = map.get(key) ?? { bucket: key, label: bucketLabel(key, group) };
    row[s] = num(row[s]) + num(r[metric]);
    map.set(key, row);
  }
  const data = [...map.values()].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket), undefined, { numeric: true }));
  return { data, series: [...series] };
}

export default function SalesTab({ stationId }: { stationId: string }) {
  const [range, setRange] = useState({ from: lusakaDate(-6), to: lusakaDate(0) });
  const [group, setGroup] = useState<Group>('day');
  const [metric, setMetric] = useState<Metric>('volume_l');
  const q = useQuery({
    queryKey: ['sales', stationId, range, group],
    queryFn: () => api.salesSummary(stationId, { from: lusakaDayStartISO(range.from), to: lusakaDayEndISO(range.to), group }),
    placeholderData: (p) => p,
  });
  const totals = useMemo(() => {
    const rows = q.data ?? [];
    return rows.reduce((a, r) => ({ v: a.v + num(r.volume_l), m: a.m + num(r.amount), n: a.n + num(r.tx_count) }), { v: 0, m: 0, n: 0 });
  }, [q.data]);
  const fmt = metric === 'amount' ? formatZMW : (v: unknown) => formatLitres(v);
  const fmtC = metric === 'amount' ? formatZMWCompact : formatLitresCompact;

  return (
    <>
      <div className="toolbar">
        <DateRange from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
        <Segmented label="Group by" value={group} onChange={setGroup} options={[{ value: 'hour', label: 'Hour' }, { value: 'day', label: 'Day' }, { value: 'product', label: 'Product' }, { value: 'pump', label: 'Pump' }]} />
        <Segmented label="Metric" value={metric} onChange={setMetric} options={[{ value: 'volume_l', label: 'Litres' }, { value: 'amount', label: 'ZMW' }]} />
      </div>
      <QueryView q={q} empty={<Empty title="No sales in this period" />}>
        {(rows) => {
          const { data, series } = pivot(rows, group, metric);
          return (
            <>
              <div className="kpi-grid kpi-grid-3">
                <Kpi label="Volume" value={formatLitresCompact(totals.v)} sub={formatLitres(totals.v)} />
                <Kpi label="Amount" value={formatZMWCompact(totals.m)} sub={formatZMW(totals.m)} />
                <Kpi label="Transactions" value={formatNumber(totals.n)} />
              </div>
              <Card title={`Sales by ${group}`}>
                <div className="chart" style={{ height: 300 }}>
                  <ResponsiveContainer>
                    <BarChart data={data} margin={{ left: 8, right: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                      <XAxis dataKey="label" tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                      <YAxis tickFormatter={(v) => fmtC(v)} tick={{ fill: 'var(--muted)', fontSize: 12 }} width={80} />
                      <Tooltip formatter={(v: number) => fmt(v)} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
                      {series.length > 1 && <Legend />}
                      {series.map((s, i) => (
                        <Bar key={s} dataKey={s} name={s === 'total' ? (metric === 'amount' ? 'Amount' : 'Volume') : productLabel(s)} stackId="a" fill={s === 'total' ? SERIES[0] : productColor(s) ?? SERIES[i]} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
              <Card title="Detail">
                <DataTable
                  dense
                  caption="Sales detail"
                  rows={rows}
                  rowKey={(r, i) => `${r.bucket}-${r.product_code}-${r.pump_no}-${i}`}
                  columns={[
                    { key: 'bucket', header: group === 'pump' ? 'Pump' : 'Bucket', render: (r) => bucketLabel(group === 'pump' ? String(r.pump_no ?? r.bucket) : r.bucket, group) },
                    ...(group !== 'product' ? [{ key: 'product_code', header: 'Product', render: (r: SalesBucket) => (r.product_code ? productLabel(r.product_code) : '—') }] : []),
                    { key: 'volume_l', header: 'Volume', align: 'right', render: (r) => formatLitres(r.volume_l, 1) },
                    { key: 'amount', header: 'Amount', align: 'right', render: (r) => formatZMW(r.amount) },
                    { key: 'tx_count', header: 'Tx', align: 'right', render: (r) => formatNumber(r.tx_count) },
                  ]}
                />
              </Card>
            </>
          );
        }}
      </QueryView>
    </>
  );
}
