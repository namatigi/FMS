/**
 * Composition root: wires DB, listener, fiscal pipeline, cloud sync, commands, HA and UI.
 * createGateway() is used by main.ts and by the tests (which inject fakes).
 */
import type { FastifyInstance } from 'fastify';
import type { FiscalClient, ReceiptPrinter } from '@fms/shared';
import type { Logger } from 'pino';
import type { GatewayConfig } from './config.js';
import { ConfigStore } from './configStore.js';
import { createPool, migrate, type Pool } from './db.js';
import { createFiscalClient, createReceiptPrinter } from './fiscal/factory.js';
import { FiscalPipeline } from './fiscal/pipeline.js';
import { HaMonitor } from './ha.js';
import { createLogger } from './logger.js';
import { createMetrics, type Metrics } from './metrics.js';
import { PtsControlClient } from './pts/control.js';
import { buildPtsListener } from './pts/listener.js';
import { RetentionJob } from './retention.js';
import { CommandProcessor } from './sync/commands.js';
import { SyncLoop } from './sync/sync.js';
import { buildUiServer } from './ui/server.js';

export interface GatewayDeps {
  log?: Logger;
  fiscalClient?: FiscalClient;
  printer?: ReceiptPrinter;
  fetchImpl?: typeof fetch;
  controlClientFor?: (ptsId: string) => PtsControlClient | null;
}

export interface Gateway {
  cfg: GatewayConfig;
  pool: Pool;
  log: Logger;
  metrics: Metrics;
  config: ConfigStore;
  pipeline: FiscalPipeline;
  sync: SyncLoop;
  commands: CommandProcessor;
  ha: HaMonitor;
  retention: RetentionJob;
  fiscalClient: FiscalClient;
  printer: ReceiptPrinter;
  ptsServer: FastifyInstance;
  uiServer: FastifyInstance;
  /** Start background workers (fiscal, sync, retention, HA). listen() opens the ports. */
  start(opts?: { listen?: boolean; workers?: boolean }): Promise<void>;
  stop(): Promise<void>;
}

export async function createGateway(cfg: GatewayConfig, deps: GatewayDeps = {}): Promise<Gateway> {
  const log = deps.log ?? createLogger(cfg.logLevel);
  const pool = createPool(cfg.databaseUrl);
  await migrate(pool, log);
  const metrics = createMetrics();
  const config = new ConfigStore(pool, cfg);
  await config.init();
  const fiscalClient = deps.fiscalClient ?? (await createFiscalClient(cfg, log));
  const printer = deps.printer ?? (await createReceiptPrinter(cfg.printer, log));
  const ha = new HaMonitor(cfg.ha, log);
  const isActive = () => ha.isActive();
  const pipeline = new FiscalPipeline(pool, cfg, config, fiscalClient, printer, log.child({ component: 'fiscal' }), metrics, isActive);
  const commands = new CommandProcessor(pool, cfg, config, pipeline, log.child({ component: 'commands' }), metrics, deps.controlClientFor);
  const onlineControllers = async () =>
    (await pool.query<{ pts_id: string }>(`SELECT pts_id FROM edge.controllers WHERE last_seen_at > now() - interval '60 seconds' ORDER BY pts_id`)).rows.map((r) => r.pts_id);
  const sync = new SyncLoop(pool, cfg, log.child({ component: 'sync' }), metrics, commands, isActive, onlineControllers, deps.fetchImpl);
  const retention = new RetentionJob(pool, cfg.retention.outboxDays, cfg.retention.intervalMs, log.child({ component: 'retention' }));
  const ptsServer = buildPtsListener({
    pool, cfg, log, metrics,
    stationCode: () => config.station.code,
    onStored: (kind, info) => {
      if (info.fiscalReceiptId) pipeline.kick();
      sync.kick();
    },
  });
  const startedAt = Date.now();
  const uiServer = buildUiServer({ pool, cfg, log, metrics, config, pipeline, sync, ha, fiscalClient, printer, startedAt });

  ha.onChange((active) => {
    if (active) {
      pipeline.kick();
      sync.kick();
    }
  });

  let workersStarted = false;
  let listening = false;
  return {
    cfg, pool, log, metrics, config, pipeline, sync, commands, ha, retention, fiscalClient, printer, ptsServer, uiServer,
    async start(opts = {}) {
      await ha.start();
      if (opts.workers !== false) {
        pipeline.start();
        sync.start();
        commands.start();
        retention.start();
        workersStarted = true;
      }
      if (opts.listen !== false) {
        await ptsServer.listen({ host: cfg.pts.host, port: cfg.pts.port });
        await uiServer.listen({ host: cfg.ui.host, port: cfg.ui.port });
        listening = true;
      }
      log.info({ pts_port: cfg.pts.port, ui_port: cfg.ui.port, station: config.station.code, ha: cfg.ha.mode, active: ha.isActive(),
        fiscal: cfg.fiscal.driver, cloud: cfg.cloud.ingestUrl }, 'edge gateway started');
    },
    async stop() {
      // Stop accepting uploads first (PTS-2 keeps unconfirmed records), then drain workers.
      if (listening) {
        await ptsServer.close().catch(() => undefined);
        await uiServer.close().catch(() => undefined);
      }
      ha.stop();
      if (workersStarted) {
        retention.stop();
        await pipeline.stop();
        await sync.stop();
        await commands.stop();
      }
      await pool.end();
      log.info('edge gateway stopped');
    },
  };
}
