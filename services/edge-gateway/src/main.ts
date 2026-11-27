#!/usr/bin/env node
import { createGateway } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const cfg = loadConfig();
const log = createLogger(cfg.logLevel);

async function main() {
  const gw = await createGateway(cfg, { log });
  await gw.start();
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      log.error('graceful shutdown timed out');
      process.exit(1);
    }, 20_000);
    force.unref();
    try {
      await gw.stop();
      process.exit(0);
    } catch (e) {
      log.error({ err: e }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  log.fatal({ err: e }, 'edge gateway failed to start');
  process.exit(1);
});
