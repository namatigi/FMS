import { NavLink, Navigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { ConnectivityBadge, ErrorState, Freshness, Loading, PageHeader } from '../../components/ui';
import { LiveIndicator } from '../owner/Dashboard';
import { useLiveUpdates } from '../../lib/live';
import TanksTab from './TanksTab';
import SalesTab from './SalesTab';
import TransactionsTab from './TransactionsTab';
import DeliveriesTab from './DeliveriesTab';
import ReconciliationTab from './ReconciliationTab';
import PricesTab from './PricesTab';
import AlertsTab from './AlertsTab';
import type { UserRole } from '../../types';

const OWN: UserRole[] = ['owner', 'manager', 'platform_admin'];
const OWN_ERB: UserRole[] = [...OWN, 'erb_national', 'erb_provincial'];
const TABS: { id: string; label: string; roles?: UserRole[] }[] = [
  { id: 'tanks', label: 'Tanks', roles: OWN_ERB },
  { id: 'sales', label: 'Sales' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'deliveries', label: 'Deliveries', roles: OWN_ERB },
  { id: 'reconciliation', label: 'Reconciliation', roles: OWN_ERB },
  { id: 'prices', label: 'Prices', roles: OWN },
  { id: 'alerts', label: 'Alerts', roles: OWN_ERB },
];

export default function StationDetail() {
  const { id = '', tab } = useParams();
  const { user } = useAuth();
  const live = useLiveUpdates([['station', id], ['tanks', id], ['alerts'], ['transactions', id]], id);
  const q = useQuery({ queryKey: ['station', id], queryFn: () => api.station(id), refetchInterval: live.refetchInterval });
  const tabs = TABS.filter((t) => !t.roles || (user && t.roles.includes(user.role)));
  if (!tab) return <Navigate to={tabs[0].id} replace />;
  if (!tabs.some((t) => t.id === tab)) return <Navigate to={`/stations/${id}/${tabs[0].id}`} replace />;

  const s = q.data;
  const lastSeen = s?.health?.controller_last_seen_at ?? s?.controller_last_seen_at ?? s?.health?.gateway_last_seen_at;
  return (
    <>
      {q.isPending ? (
        <Loading label="Loading station…" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} title="Could not load station" />
      ) : (
        <PageHeader
          title={
            <>
              {s!.name} <span className="muted code">{s!.code}</span>
            </>
          }
          subtitle={
            <span className="meta-row">
              <span>{s!.company_name}</span>
              <span>
                {[s!.town, s!.district, s!.province_name].filter(Boolean).join(', ')}
              </span>
              <ConnectivityBadge value={s!.health?.connectivity ?? s!.connectivity} />
              <Freshness at={lastSeen} label="Last data" />
              {s!.health?.gateway_backlog ? <span className="badge badge-warn">Gateway backlog: {s!.health.gateway_backlog}</span> : null}
            </span>
          }
          actions={<LiveIndicator mode={live.mode} updatedAt={q.dataUpdatedAt} />}
        />
      )}
      <nav className="tabs" aria-label="Station sections">
        {tabs.map((t) => (
          <NavLink key={t.id} to={`/stations/${id}/${t.id}`} className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <div className="tab-panel">
        {tab === 'tanks' && <TanksTab stationId={id} refetchInterval={live.refetchInterval} />}
        {tab === 'sales' && <SalesTab stationId={id} />}
        {tab === 'transactions' && <TransactionsTab stationId={id} stationCode={s?.code} />}
        {tab === 'deliveries' && <DeliveriesTab stationId={id} />}
        {tab === 'reconciliation' && <ReconciliationTab stationId={id} />}
        {tab === 'prices' && <PricesTab station={s} />}
        {tab === 'alerts' && <AlertsTab stationId={id} />}
      </div>
    </>
  );
}
