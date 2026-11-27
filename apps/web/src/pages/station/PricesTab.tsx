import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { ApiError, errorMessage } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { formatZMW, num } from '../../lib/format';
import { productLabel, type CapPrice, type StationDetail } from '../../types';
import { Badge, Card, Empty, Loading } from '../../components/ui';

/** Applicable ERB cap: province-specific beats national; latest effective_at not in the future. */
export function capFor(caps: CapPrice[], product: string, provinceId: number | null | undefined, now = Date.now()): number | null {
  const valid = caps.filter((c) => c.product_code === product && new Date(c.effective_at).getTime() <= now);
  const pick = (list: CapPrice[]) => list.sort((a, b) => b.effective_at.localeCompare(a.effective_at))[0];
  const prov = pick(valid.filter((c) => c.province_id != null && c.province_id === provinceId));
  const nat = pick(valid.filter((c) => c.province_id == null));
  const c = prov ?? nat;
  return c ? num(c.price) : null;
}

type GradeWithCap = StationDetail['fuel_grades'][number] & { erb_cap?: number | null; cap_price?: number | null };

export default function PricesTab({ station }: { station: StationDetail | undefined }) {
  const { hasRole } = useAuth();
  const canEdit = hasRole('owner', 'platform_admin');
  const qc = useQueryClient();
  // ERB caps: core-api may embed them per grade; otherwise try the regulator endpoint (may be 403 for owners).
  const capsQ = useQuery({ queryKey: ['regulator', 'prices'], queryFn: api.regPrices, retry: false, staleTime: 300_000 });
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [effective, setEffective] = useState('');
  const [ok, setOk] = useState<string | null>(null);

  const grades = (station?.fuel_grades ?? []) as GradeWithCap[];
  useEffect(() => {
    setDraft(Object.fromEntries(grades.map((g) => [g.pts_grade_id, String(num(g.price).toFixed(2))])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station?.id, JSON.stringify(grades.map((g) => [g.pts_grade_id, g.price]))]);

  const caps = useMemo(() => {
    const m: Record<number, number | null> = {};
    for (const g of grades) {
      const embedded = g.erb_cap ?? g.cap_price;
      m[g.pts_grade_id] = embedded != null ? num(embedded) : capFor(capsQ.data ?? [], g.product_code, station?.province_id);
    }
    return m;
  }, [grades, capsQ.data, station?.province_id]);

  const errors = useMemo(() => {
    const e: Record<number, string | null> = {};
    for (const g of grades) {
      const v = draft[g.pts_grade_id];
      const n = Number(v);
      if (v === '' || !Number.isFinite(n) || n <= 0) e[g.pts_grade_id] = 'Enter a price above 0';
      else if (caps[g.pts_grade_id] != null && n > (caps[g.pts_grade_id] as number)) e[g.pts_grade_id] = `Above ERB cap ${formatZMW(caps[g.pts_grade_id])}`;
      else e[g.pts_grade_id] = null;
    }
    return e;
  }, [draft, grades, caps]);

  const changed = grades.filter((g) => Number(draft[g.pts_grade_id]) !== num(g.price));
  const m = useMutation({
    mutationFn: () =>
      api.setPrices(station!.id, {
        prices: changed.map((g) => ({ pts_grade_id: g.pts_grade_id, price: Number(draft[g.pts_grade_id]) })),
        effective_at: effective ? new Date(effective + ':00+02:00').toISOString() : undefined,
      }),
    onSuccess: () => {
      setOk('Prices submitted. The station gateway will apply them on its next sync.');
      qc.invalidateQueries({ queryKey: ['station', station!.id] });
    },
  });

  if (!station) return <Loading />;
  if (!grades.length) return <Empty title="No fuel grades configured" />;

  return (
    <Card title="Pump prices" subtitle={canEdit ? 'Prices are validated against the ERB cap for this product and province.' : 'Read-only: only the owner can change prices.'}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          setOk(null);
          m.mutate();
        }}
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Grade</th>
                <th scope="col">Product</th>
                <th scope="col" className="ta-right">Current</th>
                <th scope="col" className="ta-right">ERB cap</th>
                <th scope="col">New price (ZMW/L)</th>
              </tr>
            </thead>
            <tbody>
              {grades.map((g) => {
                const err = errors[g.pts_grade_id];
                const cap = caps[g.pts_grade_id];
                return (
                  <tr key={g.pts_grade_id}>
                    <td>
                      {g.name} <span className="muted">#{g.pts_grade_id}</span>
                    </td>
                    <td>{productLabel(g.product_code)}</td>
                    <td className="ta-right">{formatZMW(g.price)}</td>
                    <td className="ta-right">{cap != null ? formatZMW(cap) : <Badge>not available</Badge>}</td>
                    <td>
                      <input
                        aria-label={`New price for ${g.name}`}
                        aria-invalid={!!err}
                        inputMode="decimal"
                        disabled={!canEdit}
                        value={draft[g.pts_grade_id] ?? ''}
                        onChange={(e) => setDraft((d) => ({ ...d, [g.pts_grade_id]: e.target.value }))}
                        style={{ width: 120 }}
                      />
                      {err && <div className="error-text">{err}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {canEdit && (
          <div className="form-row">
            <label>
              Effective at (Lusaka time, optional)
              <input type="datetime-local" value={effective} onChange={(e) => setEffective(e.target.value)} />
            </label>
            <div className="spacer" />
            <button type="submit" className="btn btn-primary" disabled={m.isPending || !changed.length || Object.values(errors).some(Boolean)}>
              {m.isPending ? 'Submitting…' : `Submit ${changed.length || ''} price change${changed.length === 1 ? '' : 's'}`}
            </button>
          </div>
        )}
        {m.isError && (
          <div className="alert alert-error" role="alert">
            <strong>{m.error instanceof ApiError && m.error.code ? `${m.error.code}: ` : ''}</strong>
            {errorMessage(m.error)}
          </div>
        )}
        {ok && <div className="alert alert-ok" role="status">{ok}</div>}
      </form>
    </Card>
  );
}
