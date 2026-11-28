import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { formatLitres, formatNumber, formatZMW } from '../../lib/format';
import { productColor } from '../../lib/theme';
import { productLabel, type Pump, type PumpNozzle } from '../../types';
import { Badge, Empty, Freshness, QueryView, type Tone } from '../../components/ui';

const STATUS: Record<string, { tone: Tone; label: string }> = {
  idle: { tone: 'good', label: 'Idle' },
  filling: { tone: 'info', label: 'Filling' },
  offline: { tone: 'bad', label: 'Offline' },
  unknown: { tone: 'neutral', label: 'Status unknown' },
};

export function PumpStatusBadge({ status }: { status?: string }) {
  const s = STATUS[status ?? 'unknown'] ?? { tone: 'warn' as Tone, label: status!.charAt(0).toUpperCase() + status!.slice(1) };
  return (
    <Badge tone={s.tone} title={status === 'unknown' ? 'The forecourt controller has not reported pump states in the last 5 minutes' : `Pump state reported by the forecourt controller`}>
      {s.label}
    </Badge>
  );
}

/** Fuel dispenser illustration with the pump number on its display and one holster per nozzle. */
export function PumpIllustration({ pump }: { pump: Pump }) {
  const nozzles = [...pump.nozzles].sort((a, b) => a.nozzle_no - b.nozzle_no);
  const slots = Math.max(1, nozzles.length);
  return (
    <svg className="pump-art" viewBox="0 0 96 150" role="img" aria-label={`Pump ${pump.pump_no} with ${nozzles.length} nozzle${nozzles.length === 1 ? '' : 's'}`}>
      {/* canopy cap and body */}
      <rect x="10" y="4" width="76" height="12" rx="4" className="pump-art-cap" />
      <rect x="14" y="16" width="68" height="120" rx="6" className="pump-art-body" />
      {/* display with the pump number */}
      <rect x="22" y="24" width="52" height="30" rx="4" className="pump-art-screen" />
      <text x="48" y="46" textAnchor="middle" className="pump-art-number">
        {pump.pump_no}
      </text>
      {/* one holster per nozzle, coloured by product */}
      {nozzles.map((n, i) => {
        const w = 52 / slots;
        const x = 22 + i * w + w / 2;
        return (
          <g key={n.nozzle_no}>
            <rect x={x - 6} y="66" width="12" height="30" rx="3" fill={productColor(n.product_code)} />
            <text x={x} y="108" textAnchor="middle" className="pump-art-nozzle">
              {n.nozzle_no}
            </text>
          </g>
        );
      })}
      {/* hose and plinth */}
      <path d="M82 70 q 12 10 6 40" className="pump-art-hose" />
      <rect x="6" y="136" width="84" height="10" rx="3" className="pump-art-base" />
    </svg>
  );
}

function NozzleRow({ n }: { n: PumpNozzle }) {
  return (
    <tr>
      <td>
        <span className="prod">
          <i style={{ background: productColor(n.product_code) }} />
          {n.nozzle_no}
        </span>
      </td>
      <td>
        {n.grade_name ?? (n.product_code ? productLabel(n.product_code) : '—')}
        {n.tank_no != null && <div className="muted small">Tank {n.tank_no}</div>}
      </td>
      <td className="num">{n.total_volume_l == null ? '—' : `${formatNumber(n.total_volume_l, 2)} L`}</td>
      <td className="num">{formatZMW(n.total_amount)}</td>
      <td className="num">{formatLitres(n.today_volume_l)}</td>
    </tr>
  );
}

export function PumpCard({ pump }: { pump: Pump }) {
  const nozzles = [...pump.nozzles].sort((a, b) => a.nozzle_no - b.nozzle_no);
  const tanks = [...new Set(nozzles.map((n) => n.tank_no).filter((t): t is number => t != null))].sort((a, b) => a - b);
  return (
    <article className={`pump ${pump.status === 'offline' ? 'pump-offline' : ''}`} aria-label={`Pump ${pump.pump_no}`}>
      <header className="pump-head">
        <span className="pump-head-meta">
          <strong>Pump {pump.pump_no}</strong>
          <PumpStatusBadge status={pump.status} />
        </span>
        <span className="pump-head-meta">
          {tanks.length > 0 && <span className="muted">Tank{tanks.length > 1 ? 's' : ''} {tanks.join(', ')}</span>}
          {!pump.configured && (
            <Badge tone="warn" title="This pump sent sales but is not in the station's nozzle configuration">
              Not configured
            </Badge>
          )}
        </span>
      </header>
      <div className="pump-body">
        <PumpIllustration pump={pump} />
        <div className="pump-detail">
          <table className="pump-totals" aria-label={`Pump ${pump.pump_no} totalizers`}>
            <thead>
              <tr>
                <th scope="col">Nozzle</th>
                <th scope="col">Grade</th>
                <th scope="col" className="num">Volume totalizer</th>
                <th scope="col" className="num">Amount totalizer</th>
                <th scope="col" className="num">Today</th>
              </tr>
            </thead>
            <tbody>
              {nozzles.map((n) => (
                <NozzleRow key={n.nozzle_no} n={n} />
              ))}
            </tbody>
          </table>
          <dl className="mini-dl pump-today">
            <dt>Sales today</dt>
            <dd>
              {formatLitres(pump.today_volume_l)} · {formatZMW(pump.today_amount)} · {formatNumber(pump.today_tx)} tx
            </dd>
          </dl>
        </div>
      </div>
      <footer className="pump-foot">
        <span className="muted small">Totalizers as reported with each nozzle's latest sale</span>
        <Freshness at={pump.last_sale_at} label="Last sale" />
      </footer>
    </article>
  );
}

export default function PumpsTab({ stationId, refetchInterval }: { stationId: string; refetchInterval: number }) {
  const q = useQuery({ queryKey: ['pumps', stationId], queryFn: () => api.pumps(stationId), refetchInterval });
  return (
    <QueryView q={q} empty={<Empty title="No pumps configured">No pump has reported a sale yet.</Empty>}>
      {(pumps) => (
        <div className="pump-grid">
          {[...pumps]
            .sort((a, b) => a.pump_no - b.pump_no)
            .map((p) => (
              <PumpCard key={p.pump_no} pump={p} />
            ))}
        </div>
      )}
    </QueryView>
  );
}
