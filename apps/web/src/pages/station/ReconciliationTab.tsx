import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { formatDate, formatLitres, formatPct, formatZMW, lusakaDate, num, variancePct } from '../../lib/format';
import { downloadBlob, toCsv } from '../../lib/csv';
import { productLabel, type ReconRow } from '../../types';
import { Card, DateRange, Empty, QueryView } from '../../components/ui';
import { DataTable } from '../../components/DataTable';

/** Variance thresholds (% of sales): > 0.5% warning, > 1% critical. Positive variance = loss. */
export function varianceLevel(pct: number | null): 'ok' | 'warn' | 'bad' {
  if (pct == null) return 'ok';
  const a = Math.abs(pct);
  return a > 1 ? 'bad' : a > 0.5 ? 'warn' : 'ok';
}

export default function ReconciliationTab({ stationId }: { stationId: string }) {
  const [range, setRange] = useState({ from: lusakaDate(-13), to: lusakaDate(0) });
  const q = useQuery({
    queryKey: ['recon', stationId, range],
    queryFn: () => api.reconciliation(stationId, { from: range.from, to: range.to }),
  });
  return (
    <Card
      title="Daily stock reconciliation"
      subtitle="Variance = (opening + deliveries − sales) − closing. Positive = loss. Highlighted above 0.5% of sales."
      actions={
        <button type="button" className="btn btn-sm" disabled={!q.data?.length} onClick={() => q.data && downloadBlob(toCsv(q.data as unknown as Record<string, unknown>[]), `reconciliation_${range.from}_${range.to}.csv`)}>
          Export CSV
        </button>
      }
    >
      <div className="toolbar">
        <DateRange from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
      </div>
      <QueryView q={q} empty={<Empty title="No reconciliation data" >Daily roll-ups appear after the first full business day.</Empty>}>
        {(rows) => (
          <DataTable
            dense
            caption="Reconciliation"
            rows={[...rows].sort((a, b) => b.business_date.localeCompare(a.business_date) || a.product_code.localeCompare(b.product_code))}
            rowKey={(r) => `${r.business_date}-${r.product_code}`}
            rowClassName={(r) => {
              const l = varianceLevel(variancePct(r.variance_l, r.sales_volume_l));
              return l === 'bad' ? 'row-bad' : l === 'warn' ? 'row-warn' : undefined;
            }}
            columns={[
              { key: 'business_date', header: 'Date', render: (r) => formatDate(r.business_date) },
              { key: 'product_code', header: 'Product', render: (r) => productLabel(r.product_code) },
              { key: 'opening_stock_l', header: 'Opening', align: 'right', render: (r) => formatLitres(r.opening_stock_l) },
              { key: 'deliveries_l', header: 'Deliveries', align: 'right', render: (r) => formatLitres(r.deliveries_l) },
              { key: 'sales_volume_l', header: 'Sales', align: 'right', render: (r) => formatLitres(r.sales_volume_l) },
              { key: 'closing_stock_l', header: 'Closing', align: 'right', render: (r) => formatLitres(r.closing_stock_l) },
              { key: 'variance_l', header: 'Variance', align: 'right', render: (r) => <strong>{formatLitres(r.variance_l, 1)}</strong> },
              {
                key: 'variance_pct', header: 'Variance %', align: 'right', sortValue: (r: ReconRow) => variancePct(r.variance_l, r.sales_volume_l),
                render: (r) => {
                  const p = variancePct(r.variance_l, r.sales_volume_l);
                  const l = varianceLevel(p);
                  return <span className={l === 'bad' ? 'text-bad' : l === 'warn' ? 'text-warn' : ''}>{formatPct(p, 2)}</span>;
                },
              },
              { key: 'sales_amount', header: 'Sales (ZMW)', align: 'right', render: (r) => formatZMW(r.sales_amount) },
              { key: 'tx_count', header: 'Tx', align: 'right', render: (r) => num(r.tx_count) },
            ]}
          />
        )}
      </QueryView>
    </Card>
  );
}
