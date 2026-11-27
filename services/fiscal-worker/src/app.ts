import type pg from 'pg';
import type { FiscalClient } from '@fms/shared';
import { createPrinter } from '@fms/fiscal-printer';
import { ZraVsdcClient } from '@fms/zra-client';
import type { WorkerConfig } from './config.js';
import { createPool, permanent, type Logger } from './core.js';
import { ALL_HANDLERS } from './handlers/index.js';
import type { JobHandler, WorkerDeps } from './handlers/types.js';
import { createMetrics } from './metrics.js';
import { notifiersFromConfig } from './notifiers.js';
import { JobQueue } from './queue.js';
import { Scheduler } from './scheduler.js';
import { LocalDirStorage } from './storage.js';
import { Worker } from './worker.js';

/**
 * VSDC client per seller TPIN + branch. Device/URL come from ZRA_VSDC_DEVICES["<tpin>:<bhfId>"]
 * or fall back to ZRA_VSDC_URL / ZRA_DEVICE_SERIAL.
 */
export function fiscalClientFactory(cfg: WorkerConfig, fetchImpl?: typeof fetch): (tpin: string, bhfId: string) => FiscalClient {
  const cache = new Map<string, FiscalClient>();
  return (tpin, bhfId) => {
    const key = `${tpin}:${bhfId}`;
    let c = cache.get(key);
    if (!c) {
      const dev = cfg.zra.devices[key];
      const baseUrl = dev?.baseUrl ?? cfg.zra.defaultBaseUrl;
      if (!baseUrl) throw permanent(`No VSDC configured for ${key} (set ZRA_VSDC_URL or ZRA_VSDC_DEVICES)`, 'NO_VSDC');
      c = new ZraVsdcClient({
        baseUrl,
        tpin,
        bhfId,
        deviceSerial: dev?.deviceSerial ?? cfg.zra.defaultDeviceSerial,
        cmcKey: dev?.cmcKey,
        timeoutMs: cfg.zra.timeoutMs,
        vatRates: cfg.zra.vatRates,
        fetchImpl: fetchImpl ? (u, i) => fetchImpl(u, i) : undefined,
      });
      cache.set(key, c);
    }
    return c;
  };
}

export interface App {
  deps: WorkerDeps;
  worker: Worker;
  scheduler: Scheduler;
}

export function createApp(config: WorkerConfig, log: Logger, overrides: Partial<WorkerDeps> & { handlers?: JobHandler[]; db?: pg.Pool } = {}): App {
  const db = overrides.db ?? createPool(config.databaseUrl, config.dbPoolMax);
  db.on('error', (err) => log.error({ err: err.message }, 'idle database client error'));
  const queue = overrides.queue ?? new JobQueue(db, { backoffBaseMs: config.backoffBaseMs, backoffMaxMs: config.backoffMaxMs });
  const metrics = overrides.metrics ?? createMetrics(() => queue.depth());
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const deps: WorkerDeps = {
    db,
    queue,
    config,
    log,
    metrics,
    fetchImpl,
    fiscalClientFor: overrides.fiscalClientFor ?? fiscalClientFactory(config),
    notifiers: overrides.notifiers ?? notifiersFromConfig(config, log, fetchImpl),
    storage: overrides.storage ?? new LocalDirStorage(config.exportDir),
    receiptArchive: overrides.receiptArchive ?? (config.zra.receiptArchiveDir ? createPrinter({ driver: 'file', dir: config.zra.receiptArchiveDir }) : null),
  };
  const worker = new Worker(deps, overrides.handlers ?? ALL_HANDLERS);
  const scheduler = new Scheduler({ db, queue, config, log, metrics });
  return { deps, worker, scheduler };
}
