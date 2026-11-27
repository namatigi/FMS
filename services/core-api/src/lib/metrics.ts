import client from 'prom-client';

export function createMetrics() {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service: 'core-api' });
  client.collectDefaultMetrics({ register: registry });
  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const logins = new client.Counter({
    name: 'fms_core_logins_total',
    help: 'Login attempts by outcome',
    labelNames: ['outcome'],
    registers: [registry],
  });
  const sseClients = new client.Gauge({
    name: 'fms_core_sse_clients',
    help: 'Open Server-Sent Events streams',
    registers: [registry],
  });
  const partnerRequests = new client.Counter({
    name: 'fms_core_partner_requests_total',
    help: 'Partner API requests by client prefix',
    labelNames: ['client'],
    registers: [registry],
  });
  return { registry, httpDuration, logins, sseClients, partnerRequests };
}

export type Metrics = ReturnType<typeof createMetrics>;
