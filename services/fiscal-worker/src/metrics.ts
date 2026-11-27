import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface Metrics {
  registry: Registry;
  jobsProcessed: Counter<'kind' | 'outcome'>;
  jobDuration: Histogram<'kind'>;
  jobsInflight: Gauge<'kind'>;
  queueDepth: Gauge<'kind' | 'status'>;
  schedulerLeader: Gauge;
  schedulerRuns: Counter<'task' | 'outcome'>;
  fiscalSigned: Counter<'result'>;
  webhookDeliveries: Counter<'event' | 'outcome'>;
  notifications: Counter<'channel' | 'outcome'>;
  leaseRecoveries: Counter<'outcome'>;
}

export function createMetrics(depthCollector?: () => Promise<Array<{ kind: string; status: string; count: number }>>): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'fiscal-worker' });
  collectDefaultMetrics({ register: registry });

  const queueDepth = new Gauge({
    name: 'fms_worker_queue_depth',
    help: 'Jobs in fms.jobs by kind and status (queued/running/dead)',
    labelNames: ['kind', 'status'] as const,
    registers: [registry],
    async collect() {
      if (!depthCollector) return;
      try {
        const rows = await depthCollector();
        this.reset();
        for (const r of rows) this.set({ kind: r.kind, status: r.status }, r.count);
      } catch {
        /* DB unavailable: keep last values */
      }
    },
  });

  return {
    registry,
    queueDepth,
    jobsProcessed: new Counter({ name: 'fms_worker_jobs_processed_total', help: 'Jobs processed by outcome (done/retry/dead/lost)', labelNames: ['kind', 'outcome'] as const, registers: [registry] }),
    jobDuration: new Histogram({ name: 'fms_worker_job_duration_seconds', help: 'Job handler duration', labelNames: ['kind'] as const, buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120], registers: [registry] }),
    jobsInflight: new Gauge({ name: 'fms_worker_jobs_inflight', help: 'Jobs currently executing in this replica', labelNames: ['kind'] as const, registers: [registry] }),
    schedulerLeader: new Gauge({ name: 'fms_worker_scheduler_leader', help: '1 if this replica holds the scheduler advisory lock', registers: [registry] }),
    schedulerRuns: new Counter({ name: 'fms_worker_scheduler_runs_total', help: 'Scheduler task runs', labelNames: ['task', 'outcome'] as const, registers: [registry] }),
    fiscalSigned: new Counter({ name: 'fms_fiscal_cloud_receipts_total', help: 'Cloud fiscalisation results (signed/skipped/failed)', labelNames: ['result'] as const, registers: [registry] }),
    webhookDeliveries: new Counter({ name: 'fms_webhook_deliveries_total', help: 'Webhook delivery attempts', labelNames: ['event', 'outcome'] as const, registers: [registry] }),
    notifications: new Counter({ name: 'fms_notifications_total', help: 'Notifications sent per channel', labelNames: ['channel', 'outcome'] as const, registers: [registry] }),
    leaseRecoveries: new Counter({ name: 'fms_worker_lease_recoveries_total', help: 'Expired job leases recovered', labelNames: ['outcome'] as const, registers: [registry] }),
  };
}
