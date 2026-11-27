import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

const cfg = loadConfig();
const pool = createPool(cfg);
const { app } = buildApp({ cfg, db: pool });

pool.on('error', (err) => app.log.error({ err }, 'idle pg client error'));

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down: draining in-flight requests');
  const timer = setTimeout(() => {
    app.log.error('shutdown timeout exceeded, exiting');
    process.exit(1);
  }, cfg.shutdownTimeoutMs);
  timer.unref();
  try {
    await app.close(); // stops accepting, waits for in-flight requests (replies are sent only after commit)
    await pool.end();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: cfg.port, host: cfg.host });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
