import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { formatDays, formatLitres, formatNumber, formatPct, num } from '../../lib/format';
import { productLabel, type Tank } from '../../types';
import { productColor } from '../../lib/theme';
import { Badge, Empty, Freshness, QueryView } from '../../components/ui';

const ALARM_LABELS: Record<string, string> = {
  CriticalHighProduct: 'Critical high',
  HighProduct: 'High product',
  LowProduct: 'Low product',
  CriticalLowProduct: 'Critical low',
  HighWater: 'High water',
  TankLeakage: 'Leak suspected',
};

export function TankGauge({ t }: { t: Tank }) {
  const cap = num(t.capacity_l);
  const vol = num(t.product_volume_l);
  const pct = t.fill_pct != null ? num(t.fill_pct) : cap ? (vol / cap) * 100 : 0;
  // Water band: approximate visual height (mm → % of a ~2.5 m tank), clamped for visibility.
  const waterPct = Math.min(15, Math.max(0, num(t.water_height_mm) / 25));
  const alarms = t.alarms ?? [];
  const critical = alarms.some((a) => a.startsWith('Critical') || a === 'TankLeakage');
  const doc = t.days_of_cover;
  const docTone = doc == null ? 'neutral' : doc < 2 ? 'bad' : doc < 5 ? 'warn' : 'good';
  const probeOk = !t.probe_status || t.probe_status === 'OK';

  return (
    <article className={`tank ${critical ? 'tank-critical' : ''}`} aria-label={`Tank ${t.tank_no} ${productLabel(t.product_code)}`}>
      <header className="tank-head">
        <div>
          <strong>Tank {t.tank_no}</strong> <span className="prod"><i style={{ background: productColor(t.product_code) }} />{productLabel(t.product_code)}</span>
        </div>
        {!probeOk && <Badge tone="bad">Probe {t.probe_status}</Badge>}
      </header>
      <div className="tank-body">
        <div className="tank-vessel" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={`Fill ${formatPct(pct, 0)}`}>
          <div className="tank-product" style={{ height: `${Math.min(100, pct)}%`, background: productColor(t.product_code) }} />
          {waterPct > 0 && <div className="tank-water" style={{ height: `${waterPct}%` }} title={`Water ${formatNumber(t.water_height_mm)} mm`} />}
          <div className="tank-mark" style={{ bottom: '20%' }} title="Reorder level (20%)" />
          <span className="tank-pct">{formatPct(pct, 0)}</span>
        </div>
        <dl className="tank-stats">
          <dt>Volume</dt>
          <dd>{formatLitres(t.product_volume_l)}</dd>
          <dt>Capacity</dt>
          <dd>{formatLitres(t.capacity_l)}</dd>
          <dt>Ullage</dt>
          <dd>{formatLitres(t.ullage_l)}</dd>
          <dt>Water</dt>
          <dd className={num(t.water_height_mm) > 30 ? 'text-bad' : ''}>{formatNumber(t.water_height_mm, 0)} mm</dd>
          <dt>Temperature</dt>
          <dd>{t.temperature_c == null ? '—' : `${formatNumber(t.temperature_c, 1)} °C`}</dd>
          <dt>Avg daily sales</dt>
          <dd>{formatLitres(t.avg_daily_sales_l)}</dd>
          <dt>Days of cover</dt>
          <dd>
            <Badge tone={docTone}>{formatDays(doc)}</Badge>
          </dd>
        </dl>
      </div>
      <footer className="tank-foot">
        <div className="alarm-list">
          {alarms.length ? alarms.map((a) => <Badge key={a} tone={a.startsWith('Critical') || a === 'TankLeakage' ? 'bad' : 'warn'}>{ALARM_LABELS[a] ?? a}</Badge>) : <span className="muted">No alarms</span>}
        </div>
        <Freshness at={t.measured_at} />
      </footer>
    </article>
  );
}

export default function TanksTab({ stationId, refetchInterval }: { stationId: string; refetchInterval: number }) {
  const q = useQuery({ queryKey: ['tanks', stationId], queryFn: () => api.tanks(stationId), refetchInterval });
  return (
    <QueryView q={q} empty={<Empty title="No tanks configured" />}>
      {(tanks) => (
        <div className="tank-grid">
          {[...tanks].sort((a, b) => a.tank_no - b.tank_no).map((t) => (
            <TankGauge key={t.tank_no} t={t} />
          ))}
        </div>
      )}
    </QueryView>
  );
}
