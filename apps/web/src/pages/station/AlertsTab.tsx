import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { formatDateTime, timeAgo } from '../../lib/format';
import type { Alert } from '../../types';
import { Badge, Card, Field, PageHeader, QueryView, Segmented, SeverityBadge } from '../../components/ui';
import { DataTable } from '../../components/DataTable';

export function AlertsTable({ stationId, showStation }: { stationId?: string; showStation?: boolean }) {
  const { hasRole } = useAuth();
  const canAck = hasRole('owner', 'manager', 'platform_admin');
  const qc = useQueryClient();
  const [status, setStatus] = useState<'open' | 'acknowledged' | 'all'>('open');
  const [severity, setSeverity] = useState('');
  const q = useQuery({
    queryKey: ['alerts', { stationId, status, severity }],
    queryFn: () => api.alerts({ station_id: stationId, status, severity: severity || undefined }),
    refetchInterval: 15_000,
  });
  const ack = useMutation({
    mutationFn: (id: Alert['id']) => api.ackAlert(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  return (
    <Card>
      <div className="toolbar">
        <Segmented label="Status" value={status} onChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'acknowledged', label: 'Acknowledged' }, { value: 'all', label: 'All' }]} />
        <Field label="Severity">
          {(id) => (
            <select id={id} value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">Any</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
          )}
        </Field>
      </div>
      {ack.isError && <div className="alert alert-error" role="alert">{errorMessage(ack.error)}</div>}
      <QueryView q={q} isEmpty={() => false}>
        {(rows) => (
          <DataTable
            caption="Alerts"
            rows={rows}
            rowKey={(r) => String(r.id)}
            emptyTitle={status === 'open' ? 'No open alerts' : status === 'acknowledged' ? 'No acknowledged alerts' : 'No alerts'}
            rowClassName={(r) => (r.severity === 'critical' && !r.acknowledged_at ? 'row-bad' : undefined)}
            columns={[
              { key: 'occurred_at', header: 'When', render: (r) => <span title={formatDateTime(r.occurred_at)}>{timeAgo(r.occurred_at)}</span> },
              { key: 'severity', header: 'Severity', render: (r) => <SeverityBadge value={r.severity} /> },
              ...(showStation ? [{ key: 'station_name', header: 'Station', render: (r: Alert) => <Link to={`/stations/${r.station_id}/alerts`}>{r.station_name ?? r.station_id}</Link> }] : []),
              { key: 'code', header: 'Code', render: (r) => <span className="mono">{r.code}</span> },
              { key: 'device', header: 'Device', render: (r) => `${r.device_type}${r.device_no != null ? ` #${r.device_no}` : ''}` },
              { key: 'message', header: 'Message', render: (r) => r.message ?? '—' },
              {
                key: 'ack', header: 'Status', sortable: false,
                render: (r) =>
                  r.acknowledged_at ? (
                    <Badge tone="good" title={formatDateTime(r.acknowledged_at)}>acknowledged</Badge>
                  ) : canAck ? (
                    <button type="button" className="btn btn-sm" disabled={ack.isPending && ack.variables === r.id} onClick={() => ack.mutate(r.id)}>
                      Acknowledge
                    </button>
                  ) : (
                    <Badge tone="warn">open</Badge>
                  ),
              },
            ]}
          />
        )}
      </QueryView>
    </Card>
  );
}

export default function AlertsTab({ stationId }: { stationId: string }) {
  return <AlertsTable stationId={stationId} />;
}

export function AlertsPage() {
  return (
    <>
      <PageHeader title="Alerts" subtitle="Alerts from all your stations" />
      <AlertsTable showStation />
    </>
  );
}
