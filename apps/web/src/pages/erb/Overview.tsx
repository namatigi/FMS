import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/endpoints';
import { formatDays, formatLitres, formatLitresCompact, formatNumber, formatPct, num } from '../../lib/format';
import { productLabel } from '../../types';
import { productColor } from '../../lib/theme';
import { Card, FillBar, Kpi, PageHeader, QueryView, RiskBadge, riskTone, Empty, Freshness } from '../../components/ui';
import { docRisk, useProvinceScope } from './common';

export default function ErbOverview() {
  const scope = useProvinceScope();
  const q = useQuery({ queryKey: ['regulator', 'overview', scope.provinceId], queryFn: () => api.regOverview({ province_id: scope.provinceId || undefined }), refetchInterval: 60_000 });
  const comp = useQuery({ queryKey: ['regulator', 'compliance', scope.provinceId], queryFn: () => api.regCompliance({ province_id: scope.provinceId || undefined }), refetchInterval: 120_000 });
  const so = useQuery({ queryKey: ['analytics', 'stockout', scope.provinceId, ''], queryFn: () => api.stockout({ province_id: scope.provinceId || undefined }), retry: 1 });

  const highRisk = (so.data ?? []).filter((r) => r.risk === 'high').length;
  const c = comp.data;
  return (
    <>
      <PageHeader
        title={scope.locked ? `${scope.label} overview` : 'National fuel position'}
        subtitle="Stock, days of cover and station connectivity"
        actions={<Freshness at={q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toISOString() : null} label="Updated" />}
      />
      <QueryView q={q} isEmpty={() => false} loadingRows={4}>
        {(d) => (
          <>
            <div className="kpi-grid">
              <Kpi label="Stations reporting" value={`${formatNumber(d.stations?.online)} / ${formatNumber(d.stations?.total)}`} sub={`${formatNumber(d.stations?.offline)} offline`} tone={num(d.stations?.offline) > 0 ? 'warn' : 'good'} />
              <Kpi label="Open alerts" value={formatNumber(d.alerts_open)} tone={num(d.alerts_open) > 0 ? 'warn' : 'good'} />
              <Kpi label="Stations at high stock-out risk" value={so.isPending ? '…' : so.isError ? '—' : formatNumber(highRisk)} tone={highRisk > 0 ? 'bad' : 'good'} sub={<Link to="/erb/forecasts">Forecasts →</Link>} />
              <Kpi
                label="Compliance issues"
                value={c ? formatNumber(c.price_violations.length + c.offline_stations.length + c.variance_anomalies.length + c.fiscal_failures.length) : '…'}
                sub={c ? <Link to="/erb/compliance">{c.price_violations.length} price · {c.variance_anomalies.length} variance · {c.fiscal_failures.length} fiscal</Link> : undefined}
                tone={c && c.price_violations.length + c.variance_anomalies.length > 0 ? 'bad' : 'good'}
              />
            </div>
            <Card title="Stock and days of cover by product">
              {d.by_product?.length ? (
                <div className="product-cards">
                  {d.by_product.map((p) => {
                    const fill = num(p.capacity_l) ? (num(p.stock_l) / num(p.capacity_l)) * 100 : 0;
                    const risk = docRisk(p.days_of_cover);
                    return (
                      <div key={p.product_code} className={`pcard pcard-${riskTone(risk)}`}>
                        <div className="pcard-head">
                          <span className="prod"><i style={{ background: productColor(p.product_code) }} />{productLabel(p.product_code)}</span>
                          <RiskBadge value={risk} />
                        </div>
                        <div className="pcard-big">{formatDays(p.days_of_cover)}</div>
                        <div className="muted">days of cover</div>
                        <FillBar pct={fill} />
                        <dl className="mini-dl">
                          <dt>Stock</dt><dd>{formatLitresCompact(p.stock_l)}</dd>
                          <dt>Capacity</dt><dd>{formatLitresCompact(p.capacity_l)}</dd>
                          <dt>Fill</dt><dd>{formatPct(fill, 0)}</dd>
                          <dt>Sales 24 h</dt><dd title={formatLitres(p.sales_24h_l)}>{formatLitresCompact(p.sales_24h_l)}</dd>
                        </dl>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <Empty title="No stock data" />
              )}
            </Card>
          </>
        )}
      </QueryView>
    </>
  );
}
