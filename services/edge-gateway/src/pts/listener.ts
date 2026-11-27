/**
 * PTS-2 upload listener: POST /jsonPTS (alias /ingest/pts).
 *
 * The PTS-2 is an HTTP client that uploads jsonPTS requests carrying one or more packets and marks
 * a record "uploaded" only when the server confirms that packet. Therefore each packet is
 * normalised and stored (table + outbox) in its own DB transaction, and only after COMMIT is it
 * confirmed with Error=false. Anything else (malformed, DB down) is answered Error=true and the
 * controller re-sends it later. Re-sent packets are idempotent (natural-key ON CONFLICT DO NOTHING).
 */
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  JsonPtsMappingError,
  jsonPtsReply,
  normalizeJsonPtsPacket,
  verifyPtsSignature,
  type JsonPtsPacket,
} from '@fms/shared';
import type { Logger } from 'pino';
import type { GatewayConfig } from '../config.js';
import { withTx, type Pool } from '../db.js';
import type { Metrics } from '../metrics.js';
import { persistRecord } from '../store.js';

export interface ListenerDeps {
  pool: Pool;
  cfg: GatewayConfig;
  log: Logger;
  metrics: Metrics;
  stationCode: () => string;
  onStored?: (kind: string, info: { fiscalReceiptId?: number }) => void;
}

type PacketResult = { id: number; type?: string; ok: boolean; message?: string };

function errorReply(message: string, packets: unknown) {
  const list = Array.isArray(packets) ? (packets as JsonPtsPacket[]) : [];
  return {
    ...jsonPtsReply(list.map((p) => ({ id: typeof p?.Id === 'number' ? p.Id : 0, type: p?.Type, ok: false, message }))),
    Error: true,
    Message: message,
  };
}

export function buildPtsListener(deps: ListenerDeps): FastifyInstance {
  const { pool, cfg, metrics } = deps;
  const app = Fastify({ loggerInstance: deps.log.child({ component: 'pts-listener' }, { level: deps.log.levelVal > 40 ? deps.log.level : 'warn' }) as unknown as FastifyBaseLogger, bodyLimit: cfg.pts.bodyLimit });

  // Keep the raw body: the signature is an HMAC of the exact bytes the controller sent.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const secrets = new Map(cfg.controllers.map((c) => [c.pts_id.toUpperCase(), c.secret]));

  const handler = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
    let body: { PtsId?: unknown; Packets?: unknown } | null;
    try {
      body = JSON.parse(raw.toString('utf8')) as typeof body;
    } catch {
      metrics.ptsRequests.inc({ result: 'bad_json' });
      return reply.code(400).send(errorReply('invalid JSON', []));
    }
    if (!body || typeof body !== 'object') {
      metrics.ptsRequests.inc({ result: 'bad_request' });
      return reply.code(400).send(errorReply('invalid jsonPTS request', []));
    }
    const headerId = req.headers['x-pts-id'];
    const ptsId = String((typeof body.PtsId === 'string' && body.PtsId) || (Array.isArray(headerId) ? headerId[0] : headerId) || '').toUpperCase();
    if (!ptsId) {
      metrics.ptsRequests.inc({ result: 'no_pts_id' });
      return reply.code(400).send(errorReply('missing PtsId', body.Packets));
    }
    const known = secrets.has(ptsId);
    if (!known && !cfg.pts.allowUnknown) {
      metrics.ptsRequests.inc({ result: 'unknown_controller' });
      req.log.warn({ pts_id: ptsId }, 'upload from unknown controller rejected');
      return reply.code(403).send(errorReply('unknown controller', body.Packets));
    }
    const sigHeader = req.headers['x-pts-signature'];
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!verifyPtsSignature(secrets.get(ptsId) ?? null, raw, sig)) {
      metrics.ptsRequests.inc({ result: 'bad_signature' });
      req.log.warn({ pts_id: ptsId }, 'invalid X-Pts-Signature');
      return reply.code(401).send(errorReply('invalid signature', body.Packets));
    }
    if (!Array.isArray(body.Packets)) {
      metrics.ptsRequests.inc({ result: 'bad_request' });
      return reply.code(400).send(errorReply('Packets must be an array', []));
    }

    const results: PacketResult[] = [];
    let ok = 0;
    let bad = 0;
    for (const p of body.Packets as JsonPtsPacket[]) {
      const id = typeof p?.Id === 'number' ? p.Id : Number(p?.Id ?? 0);
      const type = typeof p?.Type === 'string' ? p.Type : undefined;
      try {
        if (!p || typeof p !== 'object') throw new JsonPtsMappingError('packet must be an object');
        const rec = normalizeJsonPtsPacket(ptsId, p);
        if (rec) {
          const res = await withTx(pool, (c) => persistRecord(c, rec, { stationCode: deps.stationCode(), statusSyncMs: cfg.cloud.statusSyncMs }));
          if (res.inserted) deps.onStored?.(rec.kind, { fiscalReceiptId: res.fiscalReceiptId });
          metrics.ptsPackets.inc({ type: type ?? 'unknown', result: res.inserted ? 'stored' : 'duplicate' });
        } else {
          metrics.ptsPackets.inc({ type: type ?? 'unknown', result: 'ignored' });
        }
        results.push({ id, type, ok: true });
        ok++;
      } catch (e) {
        bad++;
        if (e instanceof JsonPtsMappingError) {
          metrics.ptsPackets.inc({ type: type ?? 'unknown', result: 'malformed' });
          req.log.warn({ pts_id: ptsId, packet_id: id, type, err: e.message }, 'malformed jsonPTS packet');
          results.push({ id, type, ok: false, message: e.message });
        } else {
          metrics.ptsPackets.inc({ type: type ?? 'unknown', result: 'error' });
          req.log.error({ pts_id: ptsId, packet_id: id, type, err: e }, 'failed to store jsonPTS packet');
          results.push({ id, type, ok: false, message: 'storage error, retry later' });
        }
      }
    }
    await pool.query(
      `INSERT INTO edge.controllers (pts_id, last_seen_at, packets_ok, packets_error) VALUES ($1, now(), $2, $3)
       ON CONFLICT (pts_id) DO UPDATE SET last_seen_at = now(), packets_ok = edge.controllers.packets_ok + $2,
         packets_error = edge.controllers.packets_error + $3`,
      [ptsId, ok, bad],
    ).catch((e) => req.log.warn({ err: e }, 'controller bookkeeping failed'));
    metrics.ptsRequests.inc({ result: 'ok' });
    return reply.code(200).send(jsonPtsReply(results));
  };

  app.post('/jsonPTS', handler);
  app.post('/jsonPTS/*', handler); // controllers may use per-type URIs, e.g. /jsonPTS/transactions
  app.post('/ingest/pts', handler);
  app.get('/healthz', async () => ({ ok: true }));
  return app;
}
