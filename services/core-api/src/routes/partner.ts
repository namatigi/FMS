import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { sha256Hex, safeEqualHex } from '@fms/shared';
import { Params, encodeCursor, decodeCursor } from '../lib/sql.js';
import { stationScope, stationIdScope, assertStationInScope, type Principal } from '../lib/scope.js';
import { capsInForce } from './regulator.js';
import { STATION_COLUMNS, STATION_FROM } from './stations.js';
import { ALERT_COLUMNS } from './alerts.js';
import { forbidden, unauthorized, badRequest } from '../errors.js';

type ApiClientPrincipal = Extract<Principal, { kind: 'api_client' }>;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** Small in-process cache so key lookups don't hit the DB on every request. */
const cache = new Map<string, { at: number; client: ApiClientPrincipal & { hash: string; active: boolean } }>();
const CACHE_MS = 30_000;

const partnerRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.db;

  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (req.method === 'OPTIONS') return;
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || !key.includes('.')) throw unauthorized('X-API-Key header required', 'invalid_api_key');
    const prefix = key.slice(0, key.indexOf('.'));
    let entry = cache.get(prefix);
    if (!entry || Date.now() - entry.at > CACHE_MS) {
      const { rows } = await db.primary.query(
        `SELECT id, name, key_hash, scopes, province_id, company_id, rate_limit_rpm, is_active FROM fms.api_clients WHERE key_prefix = $1`,
        [prefix],
      );
      const r = rows[0];
      if (!r) {
        cache.delete(prefix);
        throw unauthorized('invalid API key', 'invalid_api_key');
      }
      entry = {
        at: Date.now(),
        client: {
          kind: 'api_client', id: r.id, name: r.name, scopes: r.scopes ?? [], province_id: r.province_id, company_id: r.company_id,
          rate_limit_rpm: r.rate_limit_rpm, hash: r.key_hash, active: r.is_active,
        },
      };
      cache.set(prefix, entry);
    }
    const c = entry.client;
    if (!c.active || !safeEqualHex(sha256Hex(key), c.hash)) throw unauthorized('invalid API key', 'invalid_api_key');
    const { hash: _h, active: _a, ...principal } = c;
    req.principal = principal;
    app.metrics.partnerRequests.labels(prefix).inc();
  });

  // Per-client limit = api_clients.rate_limit_rpm.
  app.addHook(
    'preHandler',
    app.rateLimit({
      timeWindow: '1 minute',
      keyGenerator: (req) => `partner:${req.principal?.id ?? req.ip}`,
      max: (req) => (req.principal?.kind === 'api_client' ? req.principal.rate_limit_rpm : 60),
    }),
  );

  const need = (scope: string) => async (req: FastifyRequest) => {
    const p = req.principal as ApiClientPrincipal;
    if (!p.scopes.includes(scope)) throw forbidden(`API key lacks scope ${scope}`);
  };
  const security = [{ apiKey: [] }];

  app.get(
    '/stations',
    {
      preHandler: need('stations:read'),
      schema: {
        tags: ['partner'], security, summary: 'Stations visible to the client',
        querystring: z.object({ province_id: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(1000).default(500), cursor: z.string().optional() }),
      },
    },
    async (req) => {
      const q = req.query;
      const p = new Params();
      const where = [stationScope(req.principal, p)];
      if (q.province_id != null) where.push(`s.province_id = ${p.add(q.province_id)}`);
      const cur = decodeCursor(q.cursor);
      if (cur) where.push(`s.code > ${p.add(String(cur[0]))}`);
      const { rows } = await db.ro.query(
        `SELECT ${STATION_COLUMNS}, s.erb_licence_no FROM ${STATION_FROM} WHERE ${where.join(' AND ')} ORDER BY s.code LIMIT ${q.limit + 1}`,
        p.values,
      );
      const more = rows.length > q.limit;
      const items = rows.slice(0, q.limit);
      return { items, next_cursor: more ? encodeCursor([items[items.length - 1].code]) : null };
    },
  );

  app.get(
    '/stock',
    {
      preHandler: need('stock:read'),
      schema: { tags: ['partner'], security, summary: 'Live stock per station × product', querystring: z.object({ province_id: z.coerce.number().int().optional(), product_code: z.string().optional() }) },
    },
    async (req) => {
      const p = new Params();
      const where = [stationScope(req.principal, p)];
      if (req.query.province_id != null) where.push(`s.province_id = ${p.add(req.query.province_id)}`);
      if (req.query.product_code) where.push(`ss.product_code = ${p.add(req.query.product_code)}`);
      const { rows } = await db.ro.query(
        `SELECT ss.station_id, ss.station_code, ss.station_name, ss.province_id, ss.company_id, ss.product_code, ss.tank_count,
                ss.capacity_l, ss.product_volume_l, ss.ullage_l, ss.latest_reading_at
           FROM fms.v_station_stock ss JOIN fms.stations s ON s.id = ss.station_id
          WHERE ${where.join(' AND ')} ORDER BY ss.station_code, ss.product_code`,
        p.values,
      );
      return { items: rows, next_cursor: null };
    },
  );

  app.get(
    '/sales/daily',
    {
      preHandler: need('sales:read'),
      schema: {
        tags: ['partner'], security, summary: 'Daily sales per station × product',
        querystring: z.object({ from: isoDate.optional(), to: isoDate.optional(), province_id: z.coerce.number().int().optional(), product_code: z.string().optional(), station_id: z.string().optional() }),
      },
    },
    async (req) => {
      const q = req.query;
      if (q.station_id) await assertStationInScope(db.ro, req.principal, q.station_id);
      const p = new Params();
      const where = [stationIdScope(req.principal, p, 'd.station_id')];
      where.push(q.from ? `d.business_date >= ${p.add(q.from)}::date` : `d.business_date >= (now() AT TIME ZONE 'Africa/Lusaka')::date - 30`);
      if (q.to) where.push(`d.business_date <= ${p.add(q.to)}::date`);
      if (q.province_id != null) where.push(`d.province_id = ${p.add(q.province_id)}`);
      if (q.product_code) where.push(`d.product_code = ${p.add(q.product_code)}`);
      if (q.station_id) where.push(`d.station_id = ${p.add(q.station_id)}`);
      const { rows } = await db.ro.query(
        `SELECT d.station_id, s.code AS station_code, d.province_id, d.business_date, d.product_code, d.sales_volume_l, d.sales_amount,
                d.tx_count, d.opening_stock_l, d.closing_stock_l, d.deliveries_l, d.variance_l, d.avg_price
           FROM fms.daily_station_product d JOIN fms.stations s ON s.id = d.station_id
          WHERE ${where.join(' AND ')}
          ORDER BY d.business_date, s.code, d.product_code LIMIT 50000`,
        p.values,
      );
      return { items: rows, next_cursor: null };
    },
  );

  app.get(
    '/prices',
    {
      preHandler: need('prices:read'),
      schema: { tags: ['partner'], security, summary: 'ERB caps in force (kind=erb_cap, default) or current station pump prices (kind=station)', querystring: z.object({ kind: z.enum(['erb_cap', 'station']).default('erb_cap') }) },
    },
    async (req) => {
      const pr = req.principal as ApiClientPrincipal;
      if (req.query.kind === 'erb_cap') return { items: await capsInForce(db.ro, pr.province_id), next_cursor: null };
      const p = new Params();
      const { rows } = await db.ro.query(
        `SELECT s.id AS station_id, s.code AS station_code, s.province_id, g.pts_grade_id, g.name AS grade_name, g.product_code, g.price
           FROM fms.fuel_grades g JOIN fms.stations s ON s.id = g.station_id
          WHERE ${stationScope(pr, p)} ORDER BY s.code, g.pts_grade_id`,
        p.values,
      );
      return { items: rows, next_cursor: null };
    },
  );

  app.get(
    '/alerts',
    {
      preHandler: need('alerts:read'),
      schema: {
        tags: ['partner'], security, summary: 'Alerts visible to the client',
        querystring: z.object({
          status: z.enum(['open', 'all']).default('open'), severity: z.enum(['info', 'warning', 'critical']).optional(),
          since: z.string().datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200), cursor: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const p = new Params();
      const where = [stationScope(req.principal, p)];
      if (q.status === 'open') where.push('a.acknowledged_at IS NULL');
      if (q.severity) where.push(`a.severity = ${p.add(q.severity)}`);
      if (q.since) where.push(`a.occurred_at >= ${p.add(q.since)}::timestamptz`);
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        if (!c || c.length !== 2) throw badRequest('invalid cursor', 'invalid_cursor');
        where.push(`(a.occurred_at, a.id) < (${p.add(String(c[0]))}::timestamptz, ${p.add(Number(c[1]))}::bigint)`);
      }
      const { rows } = await db.ro.query(
        `SELECT ${ALERT_COLUMNS}, to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _k
           FROM fms.alerts a JOIN fms.stations s ON s.id = a.station_id
          WHERE ${where.join(' AND ')} ORDER BY a.occurred_at DESC, a.id DESC LIMIT ${q.limit + 1}`,
        p.values,
      );
      const more = rows.length > q.limit;
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return { items: page.map(({ _k, acknowledged_by: _b, ...r }) => r), next_cursor: more && last ? encodeCursor([last._k, last.id]) : null };
    },
  );
};

export default partnerRoutes;
