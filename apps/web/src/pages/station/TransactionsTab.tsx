import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { formatDateTime, formatLitres, formatZMW, lusakaDate, lusakaDayEndISO, lusakaDayStartISO } from '../../lib/format';
import { downloadBlob, toCsv } from '../../lib/csv';
import { productLabel, type Transaction } from '../../types';
import { Card, DateRange, Field, FiscalBadge, QueryView } from '../../components/ui';
import { DataTable } from '../../components/DataTable';

const PAGE_SIZES = [25, 50, 100, 200];

export default function TransactionsTab({ stationId, stationCode }: { stationId: string; stationCode?: string }) {
  const [range, setRange] = useState({ from: lusakaDate(-1), to: lusakaDate(0) });
  const [pump, setPump] = useState('');
  const [limit, setLimit] = useState(50);
  // cursor stack: [undefined, c1, c2, …] → current page = last
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const reset = () => setCursors([undefined]);

  const q = useQuery({
    queryKey: ['transactions', stationId, range, pump, limit, cursor],
    queryFn: () =>
      api.transactions(stationId, { from: lusakaDayStartISO(range.from), to: lusakaDayEndISO(range.to), pump_no: pump || undefined, limit, cursor }),
    placeholderData: (p) => p,
  });

  const exportCsv = (rows: Transaction[]) => {
    const csv = toCsv(rows as unknown as Record<string, unknown>[], [
      { key: 'ended_at', label: 'ended_at' },
      { key: 'pump_no', label: 'pump_no' },
      { key: 'nozzle_no', label: 'nozzle_no' },
      { key: 'product_code', label: 'product_code' },
      { key: 'volume_l', label: 'volume_l' },
      { key: 'price', label: 'price_zmw' },
      { key: 'amount', label: 'amount_zmw' },
      { key: 'tag', label: 'tag' },
      { key: 'fiscal_status', label: 'fiscal_status' },
      { key: 'zra_rcpt_no', label: 'zra_rcpt_no' },
    ]);
    downloadBlob(csv, `transactions_${stationCode ?? stationId}_${range.from}_${range.to}_p${cursors.length}.csv`);
  };

  return (
    <Card>
      <div className="toolbar">
        <DateRange from={range.from} to={range.to} onChange={(from, to) => { setRange({ from, to }); reset(); }} />
        <Field label="Pump">
          {(id) => <input id={id} type="number" min={1} max={50} value={pump} placeholder="All" onChange={(e) => { setPump(e.target.value); reset(); }} style={{ width: 90 }} />}
        </Field>
        <Field label="Rows">
          {(id) => (
            <select id={id} value={limit} onChange={(e) => { setLimit(Number(e.target.value)); reset(); }}>
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
        </Field>
        <div className="spacer" />
        <button type="button" className="btn" disabled={!q.data?.items?.length} onClick={() => q.data && exportCsv(q.data.items)}>
          Export CSV (current view)
        </button>
      </div>
      <QueryView q={q} isEmpty={() => false}>
        {(page) => (
          <>
            <DataTable
              dense
              caption="Transactions"
              rows={page.items ?? []}
              rowKey={(r) => String(r.id)}
              emptyTitle="No transactions"
              emptyText="No sales recorded in this period."
              columns={[
                { key: 'ended_at', header: 'Time', render: (r) => formatDateTime(r.ended_at) },
                { key: 'pump_no', header: 'Pump', align: 'right' },
                { key: 'nozzle_no', header: 'Nozzle', align: 'right' },
                { key: 'product_code', header: 'Product', render: (r) => productLabel(r.product_code) },
                { key: 'volume_l', header: 'Volume', align: 'right', render: (r) => formatLitres(r.volume_l, 2) },
                { key: 'price', header: 'Price/L', align: 'right', render: (r) => formatZMW(r.price) },
                { key: 'amount', header: 'Amount', align: 'right', render: (r) => formatZMW(r.amount) },
                { key: 'tag', header: 'Tag', render: (r) => r.tag ?? '—' },
                { key: 'fiscal_status', header: 'Fiscal', render: (r) => <FiscalBadge value={r.fiscal_status} /> },
                { key: 'zra_rcpt_no', header: 'ZRA receipt', render: (r) => <span className="mono">{r.zra_rcpt_no ?? '—'}</span> },
              ]}
            />
            <div className="pager">
              <span className="muted">Page {cursors.length}{q.isFetching ? ' · loading…' : ''}</span>
              <button type="button" className="btn btn-sm" disabled={cursors.length <= 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
                ← Previous
              </button>
              <button type="button" className="btn btn-sm" disabled={!page.next_cursor} onClick={() => setCursors((c) => [...c, page.next_cursor ?? undefined])}>
                Next →
              </button>
            </div>
          </>
        )}
      </QueryView>
    </Card>
  );
}
