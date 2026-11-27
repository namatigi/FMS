import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { formatDateTime, formatZMW } from '../../lib/format';
import { PROVINCES, productLabel, provinceName } from '../../types';
import { Card, Empty, Field, PageHeader, QueryView } from '../../components/ui';
import { DataTable } from '../../components/DataTable';
import { ProductSelect } from './common';

function nowLocalInput() {
  // datetime-local value in Lusaka time (UTC+2)
  const d = new Date(Date.now() + 2 * 3600_000);
  return d.toISOString().slice(0, 16);
}

export default function CapPrices() {
  const { hasRole } = useAuth();
  const canEdit = hasRole('erb_national');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['regulator', 'prices'], queryFn: api.regPrices });
  const [form, setForm] = useState({ product_code: 'PETROL', province_id: '', price: '', effective_at: nowLocalInput() });
  const [ok, setOk] = useState<string | null>(null);
  const priceNum = Number(form.price);
  const invalid = form.price === '' || !Number.isFinite(priceNum) || priceNum <= 0;
  const m = useMutation({
    mutationFn: () =>
      api.regSetPrice({
        product_code: form.product_code,
        province_id: form.province_id ? Number(form.province_id) : null,
        price: priceNum,
        effective_at: new Date(`${form.effective_at}:00+02:00`).toISOString(),
      }),
    onSuccess: () => {
      setOk(`Cap for ${productLabel(form.product_code)} (${form.province_id ? provinceName(Number(form.province_id)) : 'national'}) set to ${formatZMW(priceNum)}.`);
      setForm((f) => ({ ...f, price: '' }));
      qc.invalidateQueries({ queryKey: ['regulator', 'prices'] });
    },
  });
  return (
    <>
      <PageHeader title="ERB cap prices" subtitle="Maximum pump prices currently in force (ZMW per litre)" />
      <div className={canEdit ? 'grid-2 grid-wide-left' : ''}>
        <Card title="Caps in force">
          <QueryView q={q} empty={<Empty title="No cap prices set" />}>
            {(rows) => (
              <DataTable
                caption="ERB cap prices"
                rows={rows}
                rowKey={(r, i) => `${r.id ?? i}`}
                columns={[
                  { key: 'product_code', header: 'Product', render: (r) => productLabel(r.product_code) },
                  { key: 'province_id', header: 'Scope', render: (r) => (r.province_id == null ? 'National' : provinceName(r.province_id)) },
                  { key: 'price', header: 'Cap (ZMW/L)', align: 'right', render: (r) => <strong>{formatZMW(r.price)}</strong> },
                  { key: 'effective_at', header: 'Effective from', render: (r) => formatDateTime(r.effective_at) },
                ]}
              />
            )}
          </QueryView>
        </Card>
        {canEdit && (
          <Card title="Set a new cap">
            <form className="form" onSubmit={(e) => { e.preventDefault(); setOk(null); m.mutate(); }}>
              <ProductSelect value={form.product_code} onChange={(v) => setForm((f) => ({ ...f, product_code: v }))} allowAll={false} />
              <Field label="Scope">
                {(id) => (
                  <select id={id} value={form.province_id} onChange={(e) => setForm((f) => ({ ...f, province_id: e.target.value }))}>
                    <option value="">National (all provinces)</option>
                    {PROVINCES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                )}
              </Field>
              <Field label="Cap price (ZMW/L)" error={form.price !== '' && invalid ? 'Enter a price above 0' : null}>
                {(id) => <input id={id} inputMode="decimal" value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} required />}
              </Field>
              <Field label="Effective at (Lusaka time)">
                {(id) => <input id={id} type="datetime-local" value={form.effective_at} onChange={(e) => setForm((f) => ({ ...f, effective_at: e.target.value }))} required />}
              </Field>
              <button type="submit" className="btn btn-primary" disabled={invalid || m.isPending}>{m.isPending ? 'Saving…' : 'Publish cap'}</button>
              {m.isError && <div className="alert alert-error" role="alert">{errorMessage(m.error)}</div>}
              {ok && <div className="alert alert-ok" role="status">{ok}</div>}
            </form>
          </Card>
        )}
      </div>
    </>
  );
}
