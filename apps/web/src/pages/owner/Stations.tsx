import { lazy, Suspense, useDeferredValue, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { PROVINCES } from '../../types';
import { timeAgo } from '../../lib/format';
import { Card, ConnectivityBadge, Field, Loading, PageHeader, QueryView, Segmented } from '../../components/ui';
import { DataTable } from '../../components/DataTable';

const StationMap = lazy(() => import('../../components/StationMap'));

export default function Stations({ defaultView = 'list' }: { defaultView?: 'list' | 'map' }) {
  const { user } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q);
  const [province, setProvince] = useState('');
  const [conn, setConn] = useState('');
  const [view, setView] = useState<'list' | 'map'>(defaultView);

  const query = useQuery({
    queryKey: ['stations', { q: dq, province }],
    queryFn: () => api.stations({ q: dq || undefined, province_id: province || undefined }),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

  const rows = useMemo(() => (query.data ?? []).filter((s) => !conn || s.connectivity === conn), [query.data, conn]);
  const counts = useMemo(() => {
    const c = { online: 0, degraded: 0, offline: 0 } as Record<string, number>;
    (query.data ?? []).forEach((s) => (c[s.connectivity] = (c[s.connectivity] ?? 0) + 1));
    return c;
  }, [query.data]);

  return (
    <>
      <PageHeader
        title="Stations"
        subtitle={query.data ? `${query.data.length} stations · ${counts.online ?? 0} online · ${counts.degraded ?? 0} degraded · ${counts.offline ?? 0} offline` : undefined}
        actions={<Segmented label="View" value={view} onChange={setView} options={[{ value: 'list', label: 'List' }, { value: 'map', label: 'Map' }]} />}
      />
      <Card>
        <div className="filters">
          <Field label="Search">
            {(id) => <input id={id} type="search" placeholder="Name, code or town" value={q} onChange={(e) => setQ(e.target.value)} />}
          </Field>
          {user?.role !== 'manager' && (
            <Field label="Province">
              {(id) => (
                <select id={id} value={province} onChange={(e) => setProvince(e.target.value)}>
                  <option value="">All provinces</option>
                  {PROVINCES.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <Field label="Connectivity">
            {(id) => (
              <select id={id} value={conn} onChange={(e) => setConn(e.target.value)}>
                <option value="">Any</option>
                <option value="online">Online</option>
                <option value="degraded">Degraded</option>
                <option value="offline">Offline</option>
              </select>
            )}
          </Field>
        </div>
        <QueryView q={query} isEmpty={() => false}>
          {() =>
            view === 'map' ? (
              <Suspense fallback={<Loading label="Loading map…" />}>
                <StationMap stations={rows} />
              </Suspense>
            ) : (
              <DataTable
                caption="Stations"
                rows={rows}
                rowKey={(r) => r.id}
                emptyTitle="No stations match"
                emptyText="Try clearing the filters."
                onRowClick={(r) => nav(`/stations/${r.id}`)}
                columns={[
                  { key: 'code', header: 'Code' },
                  { key: 'name', header: 'Name', render: (r) => <Link to={`/stations/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.name}</Link> },
                  { key: 'company_name', header: 'Company' },
                  { key: 'province_name', header: 'Province' },
                  { key: 'town', header: 'Town', render: (r) => r.town ?? r.district ?? '—' },
                  { key: 'connectivity', header: 'Connectivity', render: (r) => <ConnectivityBadge value={r.connectivity} /> },
                  { key: 'controller_last_seen_at', header: 'Last seen', render: (r) => <span title={r.controller_last_seen_at ?? ''}>{timeAgo(r.controller_last_seen_at)}</span> },
                ]}
              />
            )
          }
        </QueryView>
      </Card>
    </>
  );
}
