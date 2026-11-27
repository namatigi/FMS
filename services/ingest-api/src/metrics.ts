import client from 'prom-client';

export function createMetrics() {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry, prefix: 'fms_ingest_' });
  const records = new client.Counter({
    name: 'fms_ingest_records_total',
    help: 'Records processed, by kind, source and result (inserted|duplicate|ignored|rejected)',
    labelNames: ['kind', 'source', 'result'] as const,
    registers: [registry],
  });
  const batchLatency = new client.Histogram({
    name: 'fms_ingest_batch_duration_seconds',
    help: 'End-to-end request processing time (auth + DB transaction)',
    labelNames: ['route', 'outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const batchSize = new client.Histogram({
    name: 'fms_ingest_batch_records',
    help: 'Records per request',
    labelNames: ['route'] as const,
    buckets: [1, 5, 10, 50, 100, 250, 500, 1000, 2500, 5000],
    registers: [registry],
  });
  const rejects = new client.Counter({
    name: 'fms_ingest_rejects_total',
    help: 'Rejected requests or records by reason',
    labelNames: ['route', 'reason'] as const,
    registers: [registry],
  });
  const alerts = new client.Counter({
    name: 'fms_ingest_alerts_raised_total',
    help: 'Alerts inserted by ingest, by code and severity',
    labelNames: ['code', 'severity'] as const,
    registers: [registry],
  });
  return { registry, records, batchLatency, batchSize, rejects, alerts };
}
export type Metrics = ReturnType<typeof createMetrics>;
