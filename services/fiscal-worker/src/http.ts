import { createServer, type Server } from 'node:http';
import type pg from 'pg';
import type { Logger } from './core.js';
import type { Metrics } from './metrics.js';

export interface HttpDeps {
  db: pg.Pool;
  metrics: Metrics;
  log: Logger;
  /** Liveness probe: false when the worker loop is stuck / stopped. */
  isAlive: () => boolean;
  info: () => Record<string, unknown>;
}

/** /healthz (liveness), /readyz (DB reachable), /metrics (Prometheus). */
export function startHttpServer(port: number, deps: HttpDeps, host = '0.0.0.0'): Promise<Server> {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (path === '/healthz') {
        const alive = deps.isAlive();
        return json(alive ? 200 : 503, { status: alive ? 'ok' : 'unhealthy', ...deps.info() });
      }
      if (path === '/readyz') {
        try {
          await Promise.race([deps.db.query('SELECT 1'), new Promise((_, r) => setTimeout(() => r(new Error('db timeout')), 3000))]);
          return json(200, { status: 'ready' });
        } catch (err) {
          return json(503, { status: 'not_ready', error: (err as Error).message });
        }
      }
      if (path === '/metrics') {
        const body = await deps.metrics.registry.metrics();
        res.writeHead(200, { 'content-type': deps.metrics.registry.contentType });
        return res.end(body);
      }
      json(404, { error: { code: 'not_found', message: 'not found' } });
    } catch (err) {
      deps.log.error({ err: (err as Error).message }, 'http handler error');
      json(500, { error: { code: 'internal', message: 'internal error' } });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
