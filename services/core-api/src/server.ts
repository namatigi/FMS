import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { runMigrations } from './db.js';

const config = loadConfig();
const app = await buildApp({ config });

if (config.runMigrations) {
  try {
    await runMigrations(app.db.primary, (m) => app.log.info(m));
  } catch (err) {
    app.log.fatal({ err }, 'core-api migrations failed');
    await app.close();
    process.exit(1);
  }
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => {
    app.log.error('forced exit after 15s');
    process.exit(1);
  }, 15_000);
  force.unref();
  try {
    await app.close(); // stops accepting, drains in-flight, closes SSE streams and DB pools
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => app.log.error({ err }, 'unhandled rejection'));

await app.listen({ port: config.port, host: config.host });
