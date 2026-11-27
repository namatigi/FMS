import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/healthz', { schema: { hide: true } }, async () => ({ status: 'ok' }));

  app.get('/readyz', { schema: { hide: true } }, async (_req, reply) => {
    try {
      await app.db.primary.query('SELECT 1');
      if (app.db.ro !== app.db.primary) await app.db.ro.query('SELECT 1');
      return { status: 'ready' };
    } catch (e) {
      return reply.status(503).send({ error: { code: 'not_ready', message: (e as Error).message } });
    }
  });

  app.get('/metrics', { schema: { hide: true } }, async (_req, reply) => {
    reply.header('Content-Type', app.metrics.registry.contentType);
    return app.metrics.registry.metrics();
  });
};

export default healthRoutes;
