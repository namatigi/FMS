import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { formatDays, formatLitres, formatLitresCompact, formatPct, formatZMW, num } from '../../lib/format';
import { PRODUCT_CODES, PROVINCES, productLabel, provinceName, type RegProvince, type RegProvinceStation } from '../../types';
import { Card, ConnectivityBadge, Empty, FillBar, PageHeader, QueryView, RiskBadge, riskTone } from '../../components/ui';
import { DataTable } from '../../components/DataTable';
import { docRisk } from './common';

/** Approximate geographic layout of Zambia's provinces as a tile grid (col,row). */
const TILE_POS: Record<number, [number, number]> = {
  8: [1, 2], // North-Western
  2: [2, 2], // Copperbelt
  4: [3, 1], // Luapula
  7: [4, 1], // Northern
  6: [5, 2], // Muchinga
  10: [1, 3], // Western
  1: [3, 3], // Central
  3: [5, 3], // Eastern
  9: [2, 4], // Southern
  5: [4, 4], // Lusaka
};

function worstRisk(p: RegProvince) {
  const order = { high: 3, medium: 2, low: 1, 'n/a': 0 } as const;
  return (p.by_product ?? []).map((b) => docRisk(b.days_of_cover)).reduce<keyof typeof order>((a, r) => (order[r] > order[a] ? r : a), 'n/a');
}

export function ProvinceTiles({ provinces }: { provinces: RegProvince[] }) {
  const byId = new Map(provinces.map((p) => [p.province_id, p]));
  return (
    <div className="province-grid" role="list">
      {PROVINCES.map((meta) => {
        const p = byId.get(meta.id);
        const [col, row] = TILE_POS[meta.id];
        const risk = p ? worstRisk(p) : 'n/a';
        return (
          <Link key={meta.id} role="listitem" to={`/erb/provinces/${meta.id}`} className={`ptile ptile-${riskTone(risk)}`} style={{ gridColumn: col, gridRow: row }} aria-label={`${meta.name}: ${p ? `${p.online} of ${p.stations} online, ${risk} risk` : 'no data'}`}>
            <div className="ptile-head">
              <strong>{meta.name}</strong>
              <RiskBadge value={risk} />
            </div>
            {p ? (
              <>
                <div className="ptile-sub">{p.online}/{p.stations} online</div>
                <ul className="ptile-products">
                  {(p.by_product ?? []).filter((b) => num(b.capacity_l) > 0).map((b) => (
                    <li key={b.product_code}>
                      <span>{productLabel(b.product_code)}</span>
                      <span className={`text-${riskTone(docRisk(b.days_of_cover))}`}>{formatDays(b.days_of_cover)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="ptile-sub muted">No stations</div>
            )}
          </Link>
        );
      })}
    </div>
  );
}

export default function Provinces() {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['regulator', 'provinces'], queryFn: api.regProvinces, refetchInterval: 60_000 });
  if (user?.role === 'erb_provincial' && user.province_id) return <Navigate to={`/erb/provinces/${user.province_id}`} replace />;
  return (
    <>
      <PageHeader title="Provinces" subtitle="Colour shows the worst days-of-cover risk across products. Select a province to drill in." />
      <QueryView q={q} empty={<Empty title="No province data" />}>
        {(rows) => (
          <div className="grid-2 grid-wide-left">
            <Card title="Province map">
              <ProvinceTiles provinces={rows} />
            </Card>
            <Card title="Province summary">
              <DataTable
                dense
                caption="Province summary"
                rows={rows}
                rowKey={(r) => r.province_id}
                columns={[
                  { key: 'province_name', header: 'Province', render: (r) => <Link to={`/erb/provinces/${r.province_id}`}>{r.province_name}</Link> },
                  { key: 'stations', header: 'Stations', align: 'right' },
                  { key: 'online', header: 'Online', align: 'right' },
                  ...PRODUCT_CODES.filter((pc) => rows.some((r) => r.by_product?.some((b) => b.product_code === pc && num(b.capacity_l) > 0))).map((pc) => ({
                    key: pc,
                    header: `${productLabel(pc)} DoC`,
                    align: 'right' as const,
                    sortValue: (r: RegProvince) => r.by_product?.find((b) => b.product_code === pc)?.days_of_cover ?? null,
                    render: (r: RegProvince) => {
                      const b = r.by_product?.find((x) => x.product_code === pc);
                      return b ? <span className={`text-${riskTone(docRisk(b.days_of_cover))}`}>{formatDays(b.days_of_cover)}</span> : '—';
                    },
                  })),
                ]}
              />
            </Card>
          </div>
        )}
      </QueryView>
    </>
  );
}

export function ProvinceStations() {
  const { id } = useParams();
  const { user } = useAuth();
  const pid = Number(id);
  const q = useQuery({ queryKey: ['regulator', 'province', pid], queryFn: () => api.regProvinceStations(pid), refetchInterval: 60_000 });
  if (user?.role === 'erb_provincial' && user.province_id !== pid) return <Navigate to={`/erb/provinces/${user.province_id}`} replace />;
  const products = PRODUCT_CODES.filter((pc) => (q.data ?? []).some((s) => s.stock?.some((x) => x.product_code === pc)));
  return (
    <>
      <PageHeader
        title={`${provinceName(pid)} province`}
        subtitle={user?.role !== 'erb_provincial' ? <Link to="/erb/provinces">← All provinces</Link> : undefined}
      />
      <Card title="Stations">
        <QueryView q={q} empty={<Empty title="No stations in this province" />}>
          {(rows) => (
            <DataTable
              dense
              caption={`Stations in ${provinceName(pid)}`}
              rows={rows}
              rowKey={(r) => r.station_id}
              columns={[
                { key: 'code', header: 'Code', render: (r) => <Link to={`/stations/${r.station_id}`}>{r.code}</Link> },
                { key: 'name', header: 'Station', render: (r) => <Link to={`/stations/${r.station_id}`}>{r.name}</Link> },
                { key: 'company_name', header: 'Company' },
                { key: 'connectivity', header: 'Connectivity', render: (r) => <ConnectivityBadge value={r.connectivity} /> },
                ...products.map((pc) => ({
                  key: `stock_${pc}`,
                  header: `${productLabel(pc)} stock`,
                  sortValue: (r: RegProvinceStation) => r.stock?.find((x) => x.product_code === pc)?.stock_l ?? null,
                  render: (r: RegProvinceStation) => {
                    const s = r.stock?.find((x) => x.product_code === pc);
                    if (!s) return '—';
                    const pct = num(s.capacity_l) ? (num(s.stock_l) / num(s.capacity_l)) * 100 : 0;
                    return (
                      <div className="fill-cell" title={`${formatLitres(s.stock_l)} of ${formatLitres(s.capacity_l)}`}>
                        <FillBar pct={pct} />
                        <span>{formatLitresCompact(s.stock_l)} · {formatPct(pct, 0)}</span>
                      </div>
                    );
                  },
                })),
                ...products.map((pc) => ({
                  key: `price_${pc}`,
                  header: `${productLabel(pc)} price`,
                  align: 'right' as const,
                  sortValue: (r: RegProvinceStation) => r.last_price?.find((x) => x.product_code === pc)?.price ?? null,
                  render: (r: RegProvinceStation) => formatZMW(r.last_price?.find((x) => x.product_code === pc)?.price),
                })),
              ]}
            />
          )}
        </QueryView>
      </Card>
    </>
  );
}
