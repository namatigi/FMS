import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { jsonPtsReply, safeEqualHex, sha256Hex, verifyPtsSignature } from '@fms/shared';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { handleEdgeBatch, handlePtsUpload, TransientError } from './ingest.js';
import { createMetrics, type Metrics } from './metrics.js';
import { RateLimiter } from './ratelimit.js';
import { RefData } from './refdata.js';

export interface AppDeps {
  cfg: Config;
  db: Db;
}

export interface App {
  app: FastifyInstance;
  metrics: Metrics;
  ref: RefData;
}

function apiError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function buildApp({ cfg, db }: AppDeps): App {
  const app = Fastify({
    logger: { level: cfg.logLevel, redact: ['req.headers.authorization', 'req.headers["x-pts-signature"]'] },
    bodyLimit: cfg.bodyLimitBytes,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: true,
  });
  const metrics = createMetrics();
  const ref = new RefData(db, cfg.cacheTtlMs);
  const limiter = new RateLimiter(cfg.rateLimitRps, cfg.rateLimitBurst);
  const deps = () => ({ cfg, db, ref, metrics, log: app.log });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    metrics.rejects.inc({ route: req.routeOptions?.url ?? 'unknown', reason: status === 413 ? 'body_too_large' : `http_${status}` });
    if (req.url.startsWith('/ingest/pts')) {
      return reply.code(status).send(jsonPtsReply([{ id: 0, ok: false, message: err.message }]));
    }
    return apiError(reply, status, err.code ?? 'error', status >= 500 ? 'internal error' : err.message);
  });

  // ------------------------------------------------------------------ health / metrics
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await db.query('SELECT 1');
      return { status: 'ready' };
    } catch (err) {
      return reply.code(503).send({ status: 'unavailable', error: (err as Error).message });
    }
  });
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  // ------------------------------------------------------------------ direct jsonPTS (raw body for HMAC)
  app.register(async (inst) => {
    inst.removeAllContentTypeParsers();
    inst.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    inst.post('/ingest/pts', async (req, reply) => {
      const t0 = process.hrtime.bigint();
      const finish = (outcome: string) =>
        metrics.batchLatency.observe({ route: 'pts', outcome }, Number(process.hrtime.bigint() - t0) / 1e9);
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let body: { PtsId?: unknown; Packets?: unknown };
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        metrics.rejects.inc({ route: 'pts', reason: 'invalid_json' });
        finish('bad_request');
        return reply.code(400).send(jsonPtsReply([{ id: 0, ok: false, message: 'Invalid JSON' }]));
      }
      const packets = Array.isArray(body?.Packets) ? (body.Packets as unknown[]) : null;
      const unauthorized = (message: string) => {
        finish('unauthorized');
        return reply.code(401).send({
          Protocol: 'jsonPTS',
          Packets: (packets ?? [{}]).map((p, i) => ({
            Id: typeof (p as { Id?: unknown })?.Id === 'number' ? (p as { Id: number }).Id : i,
            Type: typeof (p as { Type?: unknown })?.Type === 'string' ? (p as { Type: string }).Type : undefined,
            Error: true,
            Code: 401,
            Message: message,
          })),
        });
      };
      if (!packets) {
        metrics.rejects.inc({ route: 'pts', reason: 'invalid_request' });
        finish('bad_request');
        return reply.code(400).send(jsonPtsReply([{ id: 0, ok: false, message: 'Packets array required' }]));
      }
      const ptsId = (typeof body.PtsId === 'string' && body.PtsId) || header(req, 'x-pts-id');
      if (!ptsId) {
        metrics.rejects.inc({ route: 'pts', reason: 'unknown_controller' });
        return unauthorized('Unauthorized: PtsId missing');
      }
      const ctl = await ref.controllers.get(ptsId);
      if (!ctl) {
        metrics.rejects.inc({ route: 'pts', reason: 'unknown_controller' });
        return unauthorized('Unauthorized: unknown controller');
      }
      const sig = header(req, 'x-pts-signature')?.replace(/^sha256=/i, '').trim();
      if (!verifyPtsSignature(ctl.hmac_secret, raw, sig)) {
        metrics.rejects.inc({ route: 'pts', reason: 'bad_signature' });
        req.log.warn({ ptsId }, 'bad PTS signature');
        return unauthorized('Unauthorized: bad signature');
      }
      const wait = limiter.take(`pts:${ptsId}`);
      if (wait > 0) {
        metrics.rejects.inc({ route: 'pts', reason: 'rate_limited' });
        finish('rate_limited');
        return reply
          .code(429)
          .header('retry-after', String(wait))
          .send(jsonPtsReply(packets.map((p, i) => ({ id: (p as { Id?: number })?.Id ?? i, ok: false, message: 'Rate limited' }))));
      }
      const station = await ref.stations.get(ctl.station_id);
      if (!station) return unauthorized('Unauthorized: controller has no station');
      metrics.batchSize.observe({ route: 'pts' }, packets.length);
      const out = await handlePtsUpload(deps(), station, ptsId, packets);
      finish(out.status === 200 ? 'ok' : 'unavailable');
      if (out.status === 503) reply.header('retry-after', '5');
      return reply.code(out.status).send(out.body);
    });
  });

  // ------------------------------------------------------------------ edge batches
  app.post(
    '/ingest/v1/edge/batches',
    {
      preParsing: async (req, _reply, payload) => {
        const enc = (header(req, 'content-encoding') ?? 'identity').toLowerCase();
        if (enc === 'identity') return payload;
        if (enc !== 'gzip') {
          const e = new Error(`unsupported content-encoding ${enc}`) as Error & { statusCode: number; code: string };
          e.statusCode = 415;
          e.code = 'unsupported_encoding';
          throw e;
        }
        // bodyLimit then applies to the decompressed stream (zip-bomb safe)
        delete req.headers['content-length'];
        const gz = createGunzip();
        (payload as Readable).on('error', (e) => gz.destroy(e));
        return (payload as Readable).pipe(gz);
      },
    },
    async (req, reply) => {
      const t0 = process.hrtime.bigint();
      const finish = (outcome: string) =>
        metrics.batchLatency.observe({ route: 'edge', outcome }, Number(process.hrtime.bigint() - t0) / 1e9);
      const code = header(req, 'x-gateway-code');
      const auth = header(req, 'authorization');
      const key = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
      if (!code || !key) {
        metrics.rejects.inc({ route: 'edge', reason: 'unauthorized' });
        finish('unauthorized');
        return apiError(reply, 401, 'unauthorized', 'Bearer key and X-Gateway-Code required');
      }
      const wait = limiter.take(`gw:${code}`);
      if (wait > 0) {
        metrics.rejects.inc({ route: 'edge', reason: 'rate_limited' });
        finish('rate_limited');
        return reply.code(429).header('retry-after', String(wait)).send({ error: { code: 'rate_limited', message: 'slow down' } });
      }
      const gw = await ref.gateways.get(code);
      if (!gw || !safeEqualHex(sha256Hex(key), gw.api_key_hash)) {
        metrics.rejects.inc({ route: 'edge', reason: 'unauthorized' });
        finish('unauthorized');
        return apiError(reply, 401, 'unauthorized', 'invalid gateway credentials');
      }
      const station = await ref.stations.get(gw.station_id);
      if (!station) return apiError(reply, 403, 'forbidden', 'gateway station not found');
      const body = req.body as { gateway_code?: unknown; station_code?: unknown; batch_id?: unknown; records?: unknown } | null;
      if (!body || typeof body !== 'object' || !Array.isArray(body.records)) {
        metrics.rejects.inc({ route: 'edge', reason: 'invalid_request' });
        finish('bad_request');
        return apiError(reply, 400, 'invalid_batch', 'EdgeBatch with records[] required');
      }
      if (body.gateway_code !== undefined && body.gateway_code !== code) {
        finish('forbidden');
        return apiError(reply, 403, 'forbidden', 'gateway_code does not match X-Gateway-Code');
      }
      if (body.station_code !== station.code) {
        metrics.rejects.inc({ route: 'edge', reason: 'station_mismatch' });
        finish('forbidden');
        return apiError(reply, 403, 'station_mismatch', `gateway ${code} is registered for station ${station.code}`);
      }
      if (body.records.length > cfg.maxRecordsPerBatch) {
        metrics.rejects.inc({ route: 'edge', reason: 'too_many_records' });
        finish('bad_request');
        return apiError(reply, 413, 'too_many_records', `max ${cfg.maxRecordsPerBatch} records per batch`);
      }
      metrics.batchSize.observe({ route: 'edge' }, body.records.length);
      try {
        const res = await handleEdgeBatch(
          deps(),
          gw,
          station,
          { batch_id: typeof body.batch_id === 'string' ? body.batch_id : '', records: body.records },
          body,
        );
        finish('ok');
        return res;
      } catch (err) {
        if (err instanceof TransientError) {
          metrics.rejects.inc({ route: 'edge', reason: 'db_unavailable' });
          finish('unavailable');
          return reply.code(503).header('retry-after', '5').send({ error: { code: 'unavailable', message: 'database unavailable, retry' } });
        }
        throw err;
      }
    },
  );

  return { app, metrics, ref };
}
