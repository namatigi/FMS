import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { formatDateTime, formatLitres, formatPct, lusakaDate, lusakaDayEndISO, lusakaDayStartISO, num } from '../../lib/format';
import { productLabel, type Delivery } from '../../types';
import { Card, DateRange, Empty, Field, Modal, QueryView } from '../../components/ui';
import { DataTable } from '../../components/DataTable';

export function deliveryDiff(d: Pick<Delivery, 'received_volume_l' | 'start_volume_l' | 'end_volume_l' | 'invoiced_volume_l'>) {
  const received = d.received_volume_l ?? (d.end_volume_l != null && d.start_volume_l != null ? num(d.end_volume_l) - num(d.start_volume_l) : null);
  if (received == null || d.invoiced_volume_l == null) return { received, diff: null, pct: null };
  const diff = num(received) - num(d.invoiced_volume_l);
  const pct = num(d.invoiced_volume_l) ? (diff / num(d.invoiced_volume_l)) * 100 : null;
  return { received, diff, pct };
}

function EditDelivery({ d, onClose }: { d: Delivery; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState(d.delivery_note_no ?? '');
  const [supplier, setSupplier] = useState(d.supplier ?? '');
  const [inv, setInv] = useState(d.invoiced_volume_l == null ? '' : String(d.invoiced_volume_l));
  const invalid = inv !== '' && (!Number.isFinite(Number(inv)) || Number(inv) < 0);
  const m = useMutation({
    mutationFn: () =>
      api.updateDelivery(d.id, { delivery_note_no: note.trim() || null, supplier: supplier.trim() || null, invoiced_volume_l: inv === '' ? null : Number(inv) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deliveries', d.station_id] });
      onClose();
    },
  });
  const preview = deliveryDiff({ ...d, invoiced_volume_l: inv === '' || invalid ? null : Number(inv) });
  return (
    <Modal
      title={`Delivery · Tank ${d.tank_no} · ${formatDateTime(d.ended_at)}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="delivery-form" className="btn btn-primary" disabled={m.isPending || invalid}>
            {m.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="delivery-form" className="form" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Delivery note number">{(id) => <input id={id} value={note} onChange={(e) => setNote(e.target.value)} maxLength={64} />}</Field>
        <Field label="Supplier">{(id) => <input id={id} value={supplier} onChange={(e) => setSupplier(e.target.value)} maxLength={120} />}</Field>
        <Field label="Invoiced volume (L)" error={invalid ? 'Enter a non-negative number' : null}>
          {(id) => <input id={id} inputMode="decimal" value={inv} onChange={(e) => setInv(e.target.value)} />}
        </Field>
        <p className="muted">
          Received by ATG: <strong>{formatLitres(preview.received)}</strong>
          {preview.diff != null && (
            <>
              {' '}· difference <strong className={Math.abs(num(preview.pct)) > 0.5 ? 'text-bad' : ''}>{formatLitres(preview.diff)} ({formatPct(preview.pct, 2)})</strong>
            </>
          )}
        </p>
        {m.isError && <div className="alert alert-error" role="alert">{errorMessage(m.error)}</div>}
      </form>
    </Modal>
  );
}

export default function DeliveriesTab({ stationId }: { stationId: string }) {
  const { hasRole } = useAuth();
  const canEdit = hasRole('owner', 'manager', 'platform_admin');
  const [range, setRange] = useState({ from: lusakaDate(-29), to: lusakaDate(0) });
  const [editing, setEditing] = useState<Delivery | null>(null);
  const q = useQuery({
    queryKey: ['deliveries', stationId, range],
    queryFn: () => api.deliveries(stationId, { from: lusakaDayStartISO(range.from), to: lusakaDayEndISO(range.to) }),
  });
  return (
    <Card>
      <div className="toolbar">
        <DateRange from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
      </div>
      <QueryView q={q} empty={<Empty title="No deliveries in this period" />}>
        {(rows) => (
          <DataTable
            caption="Deliveries"
            rows={rows}
            rowKey={(r) => String(r.id)}
            rowClassName={(r) => (Math.abs(num(deliveryDiff(r).pct)) > 0.5 ? 'row-warn' : undefined)}
            columns={[
              { key: 'ended_at', header: 'Completed', render: (r) => formatDateTime(r.ended_at) },
              { key: 'tank_no', header: 'Tank', align: 'right' },
              { key: 'product_code', header: 'Product', render: (r) => (r.product_code ? productLabel(r.product_code) : '—') },
              { key: 'received_volume_l', header: 'Received (ATG)', align: 'right', render: (r) => formatLitres(deliveryDiff(r).received) },
              { key: 'invoiced_volume_l', header: 'Invoiced', align: 'right', render: (r) => formatLitres(r.invoiced_volume_l) },
              {
                key: 'diff', header: 'Difference', align: 'right', sortValue: (r) => deliveryDiff(r).diff,
                render: (r) => {
                  const { diff, pct } = deliveryDiff(r);
                  if (diff == null) return <span className="muted">—</span>;
                  return <span className={diff < 0 ? 'text-bad' : 'text-good'}>{formatLitres(diff)} ({formatPct(pct, 2)})</span>;
                },
              },
              { key: 'delivery_note_no', header: 'Delivery note', render: (r) => r.delivery_note_no ?? <span className="muted">missing</span> },
              { key: 'supplier', header: 'Supplier', render: (r) => r.supplier ?? '—' },
              ...(canEdit
                ? [{ key: 'edit', header: '', sortable: false, render: (r: Delivery) => <button type="button" className="btn btn-sm" onClick={() => setEditing(r)}>Edit</button> }]
                : []),
            ]}
          />
        )}
      </QueryView>
      {editing && <EditDelivery d={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}
