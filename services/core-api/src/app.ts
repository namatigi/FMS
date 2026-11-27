import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  hasZodFastifySchemaValidationErrors,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { createDb, type Db } from './db.js';
import { HttpError } from './errors.js';
import { createMetrics, type Metrics } from './lib/metrics.js';
import type { Principal } from './lib/scope.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import stationRoutes from './routes/stations.js';
import alertRoutes from './routes/alerts.js';
import fiscalRoutes from './routes/fiscal.js';
import regulatorRoutes from './routes/regulator.js';
import adminRoutes from './routes/admin.js';
import partnerRoutes from './routes/partner.js';
import streamRoutes from './routes/stream.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    metrics: Metrics;
    /** Called on shutdown to end open SSE streams. */
    sseClosers: Set<() => void>;
  }
  interface FastifyRequest {
    principal: Principal;
  }
}

export interface BuildOptions {
  config: Config;
  db?: Db;
  logger?: boolean | object;
}

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const { config } = opts;
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : (opts.logger as object | undefined) ?? {
            level: config.logLevel,
            redact: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie'],
            serializers: {
              req(req: { method: string; url: string; id: string }) {
                // Never log ?token= used by EventSource auth.
                return { method: req.method, url: req.url.replace(/([?&]token=)[^&]*/g, '$1[REDACTED]'), id: req.id };
              },
            },
          },
    genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    ajv: undefined,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('config', config);
  app.decorate('db', opts.db ?? createDb(config.databaseUrl, config.databaseUrlRo));
  app.decorate('metrics', createMetrics());
  app.decorate('sseClosers', new Set<() => void>());
  app.decorateRequest('principal', null as never);

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-API-Key', 'X-Request-Id'],
  });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: ctx.statusCode,
      error: { code: 'rate_limited', message: `rate limit exceeded, retry in ${ctx.after}` },
    }),
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'FMS core-api',
        description: 'National Fuel Monitoring System (Zambia) — owner/manager, ERB regulator, admin and partner APIs.',
        version: '0.1.0',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  // ---- metrics
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unmatched';
    app.metrics.httpDuration.labels(req.method, route, String(reply.statusCode)).observe(reply.elapsedTime / 1000);
  });

  // ---- errors
  app.setErrorHandler((err: FastifyError & { error?: { code: string; message: string }; code?: string }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const msg = err.validation
        .map((v) => `${v.instancePath || err.validationContext || ''} ${v.message ?? ''}`.trim())
        .join('; ');
      return reply.status(400).send({ error: { code: 'validation_error', message: msg || 'invalid request' } });
    }
    if (err.validation) {
      return reply.status(400).send({ error: { code: 'validation_error', message: err.message } });
    }
    if (err.error && typeof err.error === 'object' && err.error.code) {
      return reply.status(err.statusCode ?? 429).send({ error: err.error });
    }
    const pgCode = (err as { code?: string }).code;
    switch (pgCode) {
      case '23505':
        return reply.status(409).send({ error: { code: 'conflict', message: 'a record with the same unique key already exists' } });
      case '23503':
        return reply.status(409).send({ error: { code: 'conflict', message: 'referenced record missing or record still referenced' } });
      case '23514':
      case '23502':
      case '22P02':
      case '22007':
      case '22008':
      case '22003':
        return reply.status(400).send({ error: { code: 'bad_request', message: 'invalid value: ' + err.message } });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: (err.code ?? 'bad_request').toLowerCase(), message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'internal server error' } });
  });
  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: 'not_found', message: `route ${req.method} ${req.url.split('?')[0]} not found` } });
  });

  // ---- routes
  await app.register(healthRoutes);
  await app.register(
    async (v1) => {
      v1.addHook('onRequest', v1.rateLimit({ max: config.rateLimitRpm, timeWindow: '1 minute' }));
      await v1.register(authRoutes);
      await v1.register(dashboardRoutes);
      await v1.register(stationRoutes);
      await v1.register(alertRoutes);
      await v1.register(fiscalRoutes);
      await v1.register(streamRoutes);
      await v1.register(regulatorRoutes, { prefix: '/regulator' });
      await v1.register(adminRoutes, { prefix: '/admin' });
    },
    { prefix: '/api/v1' },
  );
  await app.register(partnerRoutes, { prefix: '/api/partner/v1' });

  app.addHook('onClose', async () => {
    for (const close of app.sseClosers) close();
    await app.db.close();
  });

  return app;
}
