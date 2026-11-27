import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface Metrics {
  registry: Registry;
  ptsPackets: Counter<'type' | 'result'>;
  ptsRequests: Counter<'result'>;
  fiscalResults: Counter<'result'>;
  fiscalLatency: Histogram<string>;
  printResults: Counter<'result'>;
  syncBatches: Counter<'result'>;
  syncRecords: Counter<'result'>;
  commands: Counter<'type' | 'result'>;
  haActive: Gauge<string>;
  cloudConnected: Gauge<string>;
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'edge-gateway' });
  collectDefaultMetrics({ register: registry });
  const r = [registry];
  return {
    registry,
    ptsPackets: new Counter({ name: 'edge_pts_packets_total', help: 'jsonPTS packets processed', labelNames: ['type', 'result'], registers: r }),
    ptsRequests: new Counter({ name: 'edge_pts_requests_total', help: 'jsonPTS HTTP requests', labelNames: ['result'], registers: r }),
    fiscalResults: new Counter({ name: 'edge_fiscal_sign_total', help: 'ZRA signSale outcomes', labelNames: ['result'], registers: r }),
    fiscalLatency: new Histogram({ name: 'edge_fiscal_sign_seconds', help: 'ZRA signSale latency', buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30], registers: r }),
    printResults: new Counter({ name: 'edge_receipt_print_total', help: 'Receipt print outcomes', labelNames: ['result'], registers: r }),
    syncBatches: new Counter({ name: 'edge_sync_batches_total', help: 'Cloud sync batches', labelNames: ['result'], registers: r }),
    syncRecords: new Counter({ name: 'edge_sync_records_total', help: 'Cloud sync records', labelNames: ['result'], registers: r }),
    commands: new Counter({ name: 'edge_commands_total', help: 'Cloud commands processed', labelNames: ['type', 'result'], registers: r }),
    haActive: new Gauge({ name: 'edge_ha_active', help: '1 when this instance is active (holds the VIP)', registers: r }),
    cloudConnected: new Gauge({ name: 'edge_cloud_connected', help: '1 when the last sync attempt succeeded', registers: r }),
  };
}
