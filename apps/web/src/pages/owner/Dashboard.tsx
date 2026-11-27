import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api/endpoints';
import { useLiveUpdates } from '../../lib/live';
import { formatLitres, formatLitresCompact, formatNumber, formatPct, formatZMW, formatZMWCompact, num } from '../../lib/format';
import { productLabel } from '../../types';
import { productColor } from '../../lib/theme';
import { Badge, Card, FillBar, Freshness, Kpi, PageHeader, QueryView, Empty } from '../../components/ui';
import { DataTable } from '../../components/DataTable';

export function LiveIndicator({ mode, updatedAt }: { mode: string; updatedAt?: number }) {
  return (
    <span className="live-ind" aria-live="polite">
      {mode === 'live' ? <Badge tone="good">● Live</Badge> : mode === 'polling' ? <Badge tone="info">Auto-refresh 15 s</Badge> : <Badge>Connecting…</Badge>}
      {updatedAt ? <Freshness at={new Date(updatedAt).toISOString()} label="Updated" /> : null}
    </span>
  );
}

export default function Dashboard() {
  const live = useLiveUpdates([['dashboard'], ['alerts']]);
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.dashboard(), refetchInterval: live.refetchInterval });

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Today's sales, stock position and alerts across your stations" actions={<LiveIndicator mode={live.mode} updatedAt={q.dataUpdatedAt} />} />
      <QueryView q={q} isEmpty={() => false} loadingRows={4}>
        {(d) => {
          const products = (d.by_product ?? []).map((p) => ({
            ...p,
            name: productLabel(p.product_code),
            stock_l: num(p.stock_l),
            ullage: Math.max(0, num(p.capacity_l) - num(p.stock_l)),
            sales_today_l: num(p.sales_today_l),
          }));
          const critical = num(d.open_alerts?.critical);
          const warning = num(d.open_alerts?.warning);
          return (
            <>
              <div className="kpi-grid">
                <Kpi label="Sales today (volume)" value={formatLitresCompact(d.sales_today?.volume_l)} sub={formatLitres(d.sales_today?.volume_l)} />
                <Kpi label="Sales today (amount)" value={formatZMWCompact(d.sales_today?.amount)} sub={formatZMW(d.sales_today?.amount)} />
                <Kpi label="Transactions today" value={formatNumber(d.sales_today?.tx_count)} />
                <Kpi
                  label="Stations online"
                  value={`${formatNumber(d.stations_online)} / ${formatNumber(d.stations_total)}`}
                  sub={num(d.stations_offline) > 0 ? `${d.stations_offline} offline` : 'All reporting'}
                  tone={num(d.stations_offline) > 0 ? 'warn' : 'good'}
                />
                <Kpi
                  label="Open alerts"
                  value={formatNumber(critical + warning)}
                  sub={
                    <Link to="/alerts">
                      {critical} critical · {warning} warning
                    </Link>
                  }
                  tone={critical > 0 ? 'bad' : warning > 0 ? 'warn' : 'good'}
                />
              </div>

              <div className="grid-2">
                <Card title="Sales today by product">
                  {products.length ? (
                    <>
                      <div className="chart" style={{ height: 240 }}>
                        <ResponsiveContainer>
                          <BarChart data={products} margin={{ left: 8, right: 8 }}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                            <XAxis dataKey="name" tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                            <YAxis tickFormatter={(v) => formatLitresCompact(v)} tick={{ fill: 'var(--muted)', fontSize: 12 }} width={70} />
                            <Tooltip formatter={(v: number) => formatLitres(v)} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
                            <Bar dataKey="sales_today_l" name="Volume sold" fill="#2563eb" radius={[4, 4, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                      <DataTable
                        dense
                        caption="Sales today by product"
                        rows={products}
                        rowKey={(r) => r.product_code}
                        columns={[
                          { key: 'name', header: 'Product', render: (r) => <span className="prod"><i style={{ background: productColor(r.product_code) }} />{r.name}</span> },
                          { key: 'sales_today_l', header: 'Volume', align: 'right', render: (r) => formatLitres(r.sales_today_l) },
                          { key: 'sales_today_amount', header: 'Amount', align: 'right', render: (r) => formatZMW(r.sales_today_amount) },
                        ]}
                      />
                    </>
                  ) : (
                    <Empty title="No sales yet today" />
                  )}
                </Card>
                <Card title="Stock position by product">
                  {products.length ? (
                    <div className="chart" style={{ height: 240 }}>
                      <ResponsiveContainer>
                        <BarChart data={products} layout="vertical" margin={{ left: 8, right: 16 }}>
                          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" />
                          <XAxis type="number" tickFormatter={(v) => formatLitresCompact(v)} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                          <YAxis type="category" dataKey="name" width={70} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                          <Tooltip formatter={(v: number) => formatLitres(v)} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
                          <Legend />
                          <Bar dataKey="stock_l" name="In stock" stackId="s" fill="#16a34a" />
                          <Bar dataKey="ullage" name="Ullage" stackId="s" fill="#94a3b8" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <Empty title="No tank data" />
                  )}
                </Card>
              </div>

              <Card title="Low-stock tanks" subtitle="Tanks below their reorder level">
                <DataTable
                  caption="Low-stock tanks"
                  rows={d.low_stock_tanks ?? []}
                  rowKey={(r) => `${r.station_id}-${r.tank_no}`}
                  emptyTitle="No low-stock tanks"
                  emptyText="All tanks are above their reorder level."
                  columns={[
                    { key: 'station_name', header: 'Station', render: (r) => <Link to={`/stations/${r.station_id}/tanks`}>{r.station_name}</Link> },
                    { key: 'tank_no', header: 'Tank', align: 'right' },
                    { key: 'product_code', header: 'Product', render: (r) => productLabel(r.product_code) },
                    { key: 'product_volume_l', header: 'Volume', align: 'right', render: (r) => formatLitres(r.product_volume_l) },
                    { key: 'capacity_l', header: 'Capacity', align: 'right', render: (r) => formatLitres(r.capacity_l) },
                    { key: 'fill_pct', header: 'Fill', render: (r) => <div className="fill-cell"><FillBar pct={num(r.fill_pct)} /><span>{formatPct(r.fill_pct, 0)}</span></div> },
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
