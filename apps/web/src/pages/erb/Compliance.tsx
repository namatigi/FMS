import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { Badge, Card, PageHeader, QueryView } from '../../components/ui';
import { AutoTable } from '../../components/AutoTable';
import { ProvinceSelect, useProvinceScope } from './common';
import type { Compliance as C } from '../../types';

const SECTIONS: { key: keyof C; title: string; desc: string; preferred: string[] }[] = [
  { key: 'price_violations', title: 'Price violations', desc: 'Pump prices above the ERB cap in force', preferred: ['station_code', 'code', 'station_name', 'name', 'product_code', 'price', 'cap_price', 'erb_cap', 'excess'] },
  { key: 'offline_stations', title: 'Offline stations', desc: 'No data received for more than 24 hours', preferred: ['station_code', 'code', 'station_name', 'name', 'province_id', 'connectivity', 'last_seen_at', 'controller_last_seen_at'] },
  { key: 'variance_anomalies', title: 'Stock variance anomalies', desc: 'Possible leakage, theft or meter faults', preferred: ['station_code', 'code', 'station_name', 'name', 'business_date', 'product_code', 'variance_l', 'variance_pct'] },
  { key: 'fiscal_failures', title: 'Fiscalisation failures', desc: 'Sales not signed by ZRA VSDC', preferred: ['station_code', 'code', 'station_name', 'name', 'failed', 'pending', 'count', 'last_error'] },
];

export default function Compliance() {
  const scope = useProvinceScope();
  const q = useQuery({ queryKey: ['regulator', 'compliance', scope.provinceId], queryFn: () => api.regCompliance({ province_id: scope.provinceId || undefined }) });
  return (
    <>
      <PageHeader title="Compliance" subtitle="Regulatory exceptions requiring follow-up" actions={<ProvinceSelect scope={scope} />} />
      <QueryView q={q} isEmpty={() => false} loadingRows={4}>
        {(d) => (
          <div className="stack">
            {SECTIONS.map((s) => {
              const rows = (d[s.key] ?? []) as Record<string, unknown>[];
              return (
                <Card key={s.key} title={<>{s.title} <Badge tone={rows.length ? 'bad' : 'good'}>{rows.length}</Badge></>} subtitle={s.desc}>
                  <AutoTable rows={rows} caption={s.title} emptyTitle={`No ${s.title.toLowerCase()}`} preferred={s.preferred} />
                </Card>
              );
            })}
          </div>
        )}
      </QueryView>
    </>
  );
}
