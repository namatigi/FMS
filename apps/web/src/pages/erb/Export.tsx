import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { downloadBlob } from '../../lib/csv';
import { lusakaDate } from '../../lib/format';
import { Card, Field, PageHeader, Segmented } from '../../components/ui';
import { ProvinceSelect, useProvinceScope } from './common';

export default function Export() {
  const scope = useProvinceScope();
  const [date, setDate] = useState(lusakaDate(-1));
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [done, setDone] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      const res = await api.regExport({ date, province_id: scope.provinceId || undefined, format });
      const blob = await res.blob();
      const name = `erb_daily_return_${date}_${scope.provinceId ? `p${scope.provinceId}` : 'national'}.${format}`;
      downloadBlob(blob, name);
      return name;
    },
    onSuccess: (n) => setDone(`Downloaded ${n}`),
  });
  return (
    <>
      <PageHeader title="Export daily return" subtitle="Per-station daily return for ERB (stock, sales, deliveries, prices)" />
      <Card>
        <form className="form form-narrow" onSubmit={(e) => { e.preventDefault(); setDone(null); m.mutate(); }}>
          <Field label="Business date">{(id) => <input id={id} type="date" value={date} max={lusakaDate(0)} onChange={(e) => setDate(e.target.value)} required />}</Field>
          <ProvinceSelect scope={scope} />
          <div className="field">
            <span className="label">Format</span>
            <Segmented label="Format" value={format} onChange={setFormat} options={[{ value: 'csv', label: 'CSV' }, { value: 'json', label: 'JSON' }]} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={m.isPending || !date}>{m.isPending ? 'Preparing…' : 'Download'}</button>
          {m.isError && <div className="alert alert-error" role="alert">{errorMessage(m.error)}</div>}
          {done && <div className="alert alert-ok" role="status">{done}</div>}
        </form>
      </Card>
    </>
  );
}
