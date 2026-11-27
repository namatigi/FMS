import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { asItems } from '../../api/client';
import { formatDateTime, formatLitres, formatZMW, lusakaDate, lusakaDayEndISO, lusakaDayStartISO } from '../../lib/format';
import { downloadBlob, toCsv } from '../../lib/csv';
import { productLabel, type FiscalReceipt } from '../../types';
import { Badge, Card, DateRange, Field, FiscalBadge, Kpi, PageHeader, QueryView } from '../../components/ui';
import { DataTable } from '../../components/DataTable';
import TransactionsTab from '../station/TransactionsTab';

function StationPicker({ value, onChange, allowAll = true }: { value: string; onChange: (v: string) => void; allowAll?: boolean }) {
  const q = useQuery({ queryKey: ['stations', 'all'], queryFn: () => api.stations(), staleTime: 300_000 });
  return (
    <Field label="Station">
      {(id) => (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={q.isPending}>
          {allowAll ? <option value="">All stations</option> : <option value="">Select a station…</option>}
          {(q.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} · {s.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export default function Receipts() {
  const [station, setStation] = useState('');
  const [status, setStatus] = useState('');
  const [range, setRange] = useState({ from: lusakaDate(-1), to: lusakaDate(0) });
  const q = useQuery({
    queryKey: ['fiscal', station, status, range],
    queryFn: async () =>
      asItems<FiscalReceipt>(await api.receipts({ station_id: station || undefined, status: status || undefined, from: lusakaDayStartISO(range.from), to: lusakaDayEndISO(range.to) })),
    placeholderData: (p) => p,
  });
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    (q.data ?? []).forEach((r) => (c[r.status] = (c[r.status] ?? 0) + 1));
    return c;
  }, [q.data]);
  return (
    <>
      <PageHeader title="Fiscal receipts" subtitle="ZRA Smart Invoice (VSDC) signing status for every sale" />
      <Card>
        <div className="toolbar">
          <StationPicker value={station} onChange={setStation} />
          <Field label="Status">
            {(id) => (
              <select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Any</option>
                <option value="signed">Signed</option>
                <option value="printed">Printed</option>
                <option value="pending">Pending</option>
                <option value="failed">Failed</option>
              </select>
            )}
          </Field>
          <DateRange from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
          <div className="spacer" />
          <button type="button" className="btn" disabled={!q.data?.length} onClick={() => q.data && downloadBlob(toCsv(q.data as unknown as Record<string, unknown>[]), `fiscal_receipts_${range.from}_${range.to}.csv`)}>
            Export CSV
          </button>
        </div>
        {q.data && (
          <div className="kpi-grid kpi-grid-4">
            <Kpi label="Receipts" value={q.data.length} />
            <Kpi label="Signed / printed" value={(counts.signed ?? 0) + (counts.printed ?? 0)} tone="good" />
            <Kpi label="Pending" value={counts.pending ?? 0} tone={counts.pending ? 'warn' : 'good'} />
            <Kpi label="Failed" value={counts.failed ?? 0} tone={counts.failed ? 'bad' : 'good'} />
          </div>
        )}
        <QueryView q={q} isEmpty={() => false}>
          {(rows) => (
            <DataTable
              dense
              caption="Fiscal receipts"
              rows={rows}
              rowKey={(r) => String(r.id)}
              emptyTitle="No receipts match"
              rowClassName={(r) => (r.status === 'failed' ? 'row-bad' : undefined)}
              columns={[
                { key: 'tx_ended_at', header: 'Sale time', render: (r) => formatDateTime(r.tx_ended_at) },
                { key: 'station_name', header: 'Station', render: (r) => r.station_name ?? r.station_id.slice(0, 8) },
                { key: 'invoice_no', header: 'Invoice no', render: (r) => <span className="mono small">{r.invoice_no}</span> },
                { key: 'product_code', header: 'Product', render: (r) => (r.product_code ? productLabel(r.product_code) : '—') },
                { key: 'volume_l', header: 'Volume', align: 'right', render: (r) => formatLitres(r.volume_l, 2) },
                { key: 'amount', header: 'Amount', align: 'right', render: (r) => formatZMW(r.amount) },
                { key: 'status', header: 'Status', render: (r) => <FiscalBadge value={r.status} /> },
                { key: 'fiscalised_by', header: 'By', render: (r) => <Badge>{r.fiscalised_by}</Badge> },
                { key: 'zra_rcpt_no', header: 'ZRA receipt', render: (r) => <span className="mono">{r.zra_rcpt_no ?? '—'}</span> },
                { key: 'zra_sdc_id', header: 'SDC ID', render: (r) => <span className="mono small">{r.zra_sdc_id ?? '—'}</span> },
                { key: 'zra_signed_at', header: 'Signed', render: (r) => formatDateTime(r.zra_signed_at) },
                { key: 'attempts', header: 'Attempts', align: 'right' },
                {
                  key: 'last_error', header: 'Last error / QR', sortable: false,
                  render: (r) => r.last_error ? <span className="text-bad small">{r.last_error}</span> : r.zra_qr_url ? <a href={r.zra_qr_url} target="_blank" rel="noreferrer noopener">Verify</a> : '—',
                },
              ]}
            />
          )}
        </QueryView>
      </Card>
    </>
  );
}

export function ZraTransactions() {
  const [station, setStation] = useState('');
  return (
    <>
      <PageHeader title="Transactions" subtitle="Pump sales with fiscal status, per station" />
      <Card>
        <div className="toolbar">
          <StationPicker value={station} onChange={setStation} allowAll={false} />
        </div>
      </Card>
      {station ? <TransactionsTab key={station} stationId={station} /> : null}
    </>
  );
}
