import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api/endpoints';
import { formatDate, formatLitres, formatLitresCompact, formatZMW, formatZMWCompact, lusakaDate, num } from '../../lib/format';
import { productLabel, provinceName, type ProvinceDailyRow } from '../../types';
import { productColor, SERIES } from '../../lib/theme';
import { Card, DateRange, Empty, PageHeader, QueryView, Segmented } from '../../components/ui';
import { DataTable } from '../../components/DataTable';
import { ProductSelect, ProvinceSelect, useProvinceScope } from './common';

type SplitBy = 'product' | 'province';
type Metric = 'sales_volume_l' | 'sales_amount';

export default function SalesTrends() {
  const scope = useProvinceScope();
  const [product, setProduct] = useState('');
  const [range, setRange] = useState({ from: lusakaDate(-29), to: lusakaDate(0) });
  const [split, setSplit] = useState<SplitBy>('product');
  const [metric, setMetric] = useState<Metric>('sales_volume_l');
  const q = useQuery({
    queryKey: ['regulator', 'sales', scope.provinceId, product, range],
    queryFn: () => api.regSalesDaily({ from: range.from, to: range.to, province_id: scope.provinceId || undefined, product_code: product || undefined }),
    placeholderData: (p) => p,
  });

  const effectiveSplit: SplitBy = scope.provinceId ? 'product' : split;
  const chart = useMemo(() => {
    const rows = q.data ?? [];
    const by = new Map<string, Record<string, number | string>>();
    const series = new Set<string>();
    for (const r of rows) {
      const s = effectiveSplit === 'product' ? r.product_code : String(r.province_id);
      series.add(s);
      const d = String(r.business_date).slice(0, 10);
      const row = by.get(d) ?? { date: d };
      row[s] = num(row[s]) + num(r[metric]);
      by.set(d, row);
    }
    return { data: [...by.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))), series: [...series].sort() };
  }, [q.data, effectiveSplit, metric]);
  const fmt = metric === 'sales_amount' ? formatZMW : (v: unknown) => formatLitres(v);
  const fmtC = metric === 'sales_amount' ? formatZMWCompact : formatLitresCompact;

  return (
    <>
      <PageHeader title="Sales trends" subtitle="Daily sales by province and product (station-local business days)" />
      <Card>
        <div className="toolbar">
          <ProvinceSelect scope={scope} />
          <ProductSelect value={product} onChange={setProduct} />
          <DateRange from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
          {!scope.provinceId && <Segmented label="Split by" value={split} onChange={setSplit} options={[{ value: 'product', label: 'By product' }, { value: 'province', label: 'By province' }]} />}
          <Segmented label="Metric" value={metric} onChange={setMetric} options={[{ value: 'sales_volume_l', label: 'Litres' }, { value: 'sales_amount', label: 'ZMW' }]} />
        </div>
        <QueryView q={q} empty={<Empty title="No sales data for this selection" />}>
          {(rows) => (
            <>
              <div className="chart" style={{ height: 340 }}>
                <ResponsiveContainer>
                  <LineChart data={chart.data} margin={{ left: 8, right: 16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="date" tickFormatter={(d) => formatDate(d).slice(0, 6)} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                    <YAxis tickFormatter={(v) => fmtC(v)} width={80} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                    <Tooltip labelFormatter={(d) => formatDate(d)} formatter={(v: number) => fmt(v)} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
                    <Legend />
                    {chart.series.map((s, i) => (
                      <Line
                        key={s}
                        type="monotone"
                        dataKey={s}
                        name={effectiveSplit === 'product' ? productLabel(s) : provinceName(Number(s))}
                        stroke={effectiveSplit === 'product' ? productColor(s) : SERIES[i % SERIES.length]}
                        strokeWidth={2}
                        dot={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <details className="details">
                <summary>Show data table ({rows.length} rows)</summary>
                <DataTable
                  dense
                  caption="Daily sales"
                  rows={rows}
                  rowKey={(r: ProvinceDailyRow, i) => `${r.province_id}-${r.business_date}-${r.product_code}-${i}`}
                  columns={[
                    { key: 'business_date', header: 'Date', render: (r) => formatDate(String(r.business_date).slice(0, 10)) },
                    { key: 'province_id', header: 'Province', render: (r) => provinceName(r.province_id) },
                    { key: 'product_code', header: 'Product', render: (r) => productLabel(r.product_code) },
                    { key: 'reporting_stations', header: 'Stations', align: 'right' },
                    { key: 'sales_volume_l', header: 'Volume', align: 'right', render: (r) => formatLitres(r.sales_volume_l) },
                    { key: 'sales_amount', header: 'Amount', align: 'right', render: (r) => formatZMW(r.sales_amount) },
                    { key: 'avg_price', header: 'Avg price', align: 'right', render: (r) => formatZMW(r.avg_price) },
                    { key: 'deliveries_l', header: 'Deliveries', align: 'right', render: (r) => formatLitres(r.deliveries_l) },
                    { key: 'variance_l', header: 'Variance', align: 'right', render: (r) => formatLitres(r.variance_l) },
                  ]}
                />
              </details>
            </>
          )}
        </QueryView>
      </Card>
    </>
  );
}
