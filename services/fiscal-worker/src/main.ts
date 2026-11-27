#!/usr/bin/env node
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger, errorMessage } from './core.js';
import { startHttpServer } from './http.js';

const config = loadConfig();
const log = createLogger(config.logLevel, { worker_id: config.workerId });

async function main() {
  const { deps, worker, scheduler } = createApp(config, log);
  const startedAt = new Date();

  const server = await startHttpServer(config.metricsPort, {
    db: deps.db,
    metrics: deps.metrics,
    log,
    // Alive while the poll loop iterates (allow for one long poll/backoff cycle).
    isAlive: () => worker.running && Date.now() - worker.lastLoopAt < Math.max(60_000, config.pollIntervalMs * 10),
    info: () => ({ worker_id: config.workerId, kinds: worker.kinds, scheduler_leader: scheduler.isLeader, started_at: startedAt.toISOString() }),
  });
  log.info({ port: config.metricsPort }, 'health/metrics server listening');

  worker.start();
  if (config.scheduler.enabled) scheduler.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      log.error('forced exit after shutdown timeout');
      process.exit(1);
    }, config.shutdownGraceMs + 10_000);
    force.unref();
    try {
      await scheduler.stop();
      await worker.stop();
      await new Promise<void>((r) => server.close(() => r()));
      await deps.db.end();
      log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error({ err: errorMessage(err) }, 'unhandled rejection'));
}

main().catch((err) => {
  log.fatal({ err: errorMessage(err) }, 'failed to start');
  process.exit(1);
});
