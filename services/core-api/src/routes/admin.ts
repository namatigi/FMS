import { z, type ZodObject, type ZodRawShape } from 'zod';
import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { generateApiKey } from '@fms/shared';
import { requireUser } from '../lib/auth.js';
import { hashPassword } from '../lib/crypto.js';
import { Params, encodeCursor, decodeCursor, isUuid } from '../lib/sql.js';
import { audit } from '../lib/audit.js';
import { withTx } from '../db.js';
import { badRequest, notFound } from '../errors.js';

const uuid = z.string().uuid();
const optStr = (max = 200) => z.string().max(max).nullable().optional();
const ROLES = ['platform_admin', 'owner', 'manager', 'erb_national', 'erb_provincial', 'zra_auditor'] as const;
const PARTNER_SCOPES = ['stations:read', 'stock:read', 'sales:read', 'prices:read', 'alerts:read'] as const;
const WEBHOOK_EVENTS = ['daily_summary', 'critical_alert', 'stock_low'] as const;

interface Resource {
  name: string;           // path segment
  table: string;          // fms.<table>
  entity: string;         // audit entity
  select: string;         // select list over alias t
  orderBy: string;
  create: ZodObject<ZodRawShape>;
  update: ZodObject<ZodRawShape>;
  filters: string[];      // equality filters allowed in querystring
  /** Map validated input to DB columns (e.g. hash password, drop virtual fields). */
  toColumns?: (input: Record<string, unknown>, mode: 'create' | 'update') => Promise<Record<string, unknown>>;
  /** Extra writes in the same transaction (e.g. user_station_access). */
  afterWrite?: (c: pg.PoolClient, id: string, input: Record<string, unknown>) => Promise<void>;
  /** Generated values returned only from POST (keys/secrets). */
  generate?: () => { columns: Record<string, unknown>; reveal: Record<string, unknown> };
  validate?: (merged: Record<string, unknown>) => void;
  /** Redact secrets in audit details. */
  redact?: string[];
}

const resources: Resource[] = [
  {
    name: 'companies', table: 'companies', entity: 'company',
    select: 't.id, t.name, t.zra_tpin, t.erb_licence_no, t.contact_email::text AS contact_email, t.contact_phone, t.created_at',
    orderBy: 't.name, t.id',
    create: z.object({ name: z.string().min(1).max(200), zra_tpin: optStr(20), erb_licence_no: optStr(), contact_email: z.string().email().nullable().optional(), contact_phone: optStr(40) }),
    update: z.object({ name: z.string().min(1).max(200).optional(), zra_tpin: optStr(20), erb_licence_no: optStr(), contact_email: z.string().email().nullable().optional(), contact_phone: optStr(40) }),
    filters: [],
  },
  {
    name: 'stations', table: 'stations', entity: 'station',
    select: `t.id, t.company_id, t.code, t.name, t.province_id, t.district, t.town, t.address, t.latitude, t.longitude, t.timezone,
             t.erb_licence_no, t.zra_branch_id, t.status, t.connection_mode, t.created_at`,
    orderBy: 't.code, t.id',
    create: z.object({
      company_id: uuid, code: z.string().min(1).max(40), name: z.string().min(1).max(200), province_id: z.number().int().min(1).max(10),
      district: optStr(), town: optStr(), address: optStr(500), latitude: z.number().min(-90).max(90).nullable().optional(),
      longitude: z.number().min(-180).max(180).nullable().optional(), timezone: z.string().max(64).optional(), erb_licence_no: optStr(),
      zra_branch_id: z.string().max(10).optional(), status: z.enum(['active', 'suspended', 'closed', 'commissioning']).optional(),
      connection_mode: z.enum(['edge', 'direct']).optional(),
    }),
    update: z.object({
      company_id: uuid.optional(), code: z.string().min(1).max(40).optional(), name: z.string().min(1).max(200).optional(),
      province_id: z.number().int().min(1).max(10).optional(), district: optStr(), town: optStr(), address: optStr(500),
      latitude: z.number().min(-90).max(90).nullable().optional(), longitude: z.number().min(-180).max(180).nullable().optional(),
      timezone: z.string().max(64).optional(), erb_licence_no: optStr(), zra_branch_id: z.string().max(10).optional(),
      status: z.enum(['active', 'suspended', 'closed', 'commissioning']).optional(), connection_mode: z.enum(['edge', 'direct']).optional(),
    }),
    filters: ['company_id', 'province_id', 'status'],
  },
  {
    name: 'tanks', table: 'tanks', entity: 'tank',
    select: 't.id, t.station_id, t.tank_no, t.product_code, t.capacity_l, t.low_level_l, t.created_at',
    orderBy: 't.station_id, t.tank_no',
    create: z.object({ station_id: uuid, tank_no: z.number().int().min(1).max(50), product_code: z.string().min(1), capacity_l: z.number().positive(), low_level_l: z.number().nonnegative().nullable().optional() }),
    update: z.object({ tank_no: z.number().int().min(1).max(50).optional(), product_code: z.string().min(1).optional(), capacity_l: z.number().positive().optional(), low_level_l: z.number().nonnegative().nullable().optional() }),
    filters: ['station_id'],
  },
  {
    name: 'fuel_grades', table: 'fuel_grades', entity: 'fuel_grade',
    select: 't.id, t.station_id, t.pts_grade_id, t.name, t.product_code, t.zra_item_code, t.price',
    orderBy: 't.station_id, t.pts_grade_id',
    create: z.object({ station_id: uuid, pts_grade_id: z.number().int().min(0), name: z.string().min(1).max(100), product_code: z.string().min(1), zra_item_code: optStr(50), price: z.number().positive() }),
    update: z.object({ pts_grade_id: z.number().int().min(0).optional(), name: z.string().min(1).max(100).optional(), product_code: z.string().min(1).optional(), zra_item_code: optStr(50), price: z.number().positive().optional() }),
    filters: ['station_id'],
  },
  {
    name: 'nozzles', table: 'nozzles', entity: 'nozzle',
    select: 't.id, t.station_id, t.pump_no, t.nozzle_no, t.fuel_grade_id, t.tank_id',
    orderBy: 't.station_id, t.pump_no, t.nozzle_no',
    create: z.object({ station_id: uuid, pump_no: z.number().int().min(1).max(50), nozzle_no: z.number().int().min(1).max(10), fuel_grade_id: uuid.nullable().optional(), tank_id: uuid.nullable().optional() }),
    update: z.object({ pump_no: z.number().int().min(1).max(50).optional(), nozzle_no: z.number().int().min(1).max(10).optional(), fuel_grade_id: uuid.nullable().optional(), tank_id: uuid.nullable().optional() }),
    filters: ['station_id'],
  },
  {
    name: 'controllers', table: 'controllers', entity: 'controller',
    select: 't.id, t.station_id, t.pts_id, (t.hmac_secret IS NOT NULL) AS has_hmac_secret, t.firmware, t.last_seen_at, t.last_status, t.created_at',
    orderBy: 't.pts_id',
    create: z.object({ station_id: uuid, pts_id: z.string().min(1).max(64), hmac_secret: optStr(200), firmware: optStr(100) }),
    update: z.object({ station_id: uuid.optional(), pts_id: z.string().min(1).max(64).optional(), hmac_secret: optStr(200), firmware: optStr(100) }),
    filters: ['station_id'],
    redact: ['hmac_secret'],
  },
  {
    name: 'users', table: 'users', entity: 'user',
    select: `t.id, t.email::text AS email, t.full_name, t.phone, t.role, t.company_id, t.province_id, t.is_active,
             (t.mfa_secret IS NOT NULL) AS mfa_enabled, t.last_login_at, t.created_at,
             coalesce((SELECT array_agg(usa.station_id) FROM fms.user_station_access usa WHERE usa.user_id = t.id), '{}') AS station_ids`,
    orderBy: 't.email, t.id',
    create: z.object({
      email: z.string().email().max(320), full_name: z.string().min(1).max(200), phone: optStr(40), password: z.string().min(10).max(200),
      role: z.enum(ROLES), company_id: uuid.nullable().optional(), province_id: z.number().int().min(1).max(10).nullable().optional(),
      is_active: z.boolean().optional(), station_ids: z.array(uuid).optional(),
    }),
    update: z.object({
      email: z.string().email().max(320).optional(), full_name: z.string().min(1).max(200).optional(), phone: optStr(40),
      password: z.string().min(10).max(200).optional(), role: z.enum(ROLES).optional(), company_id: uuid.nullable().optional(),
      province_id: z.number().int().min(1).max(10).nullable().optional(), is_active: z.boolean().optional(),
      station_ids: z.array(uuid).optional(), reset_mfa: z.boolean().optional(),
    }),
    filters: ['role', 'company_id', 'province_id'],
    redact: ['password'],
    async toColumns(input) {
      const { password, station_ids: _s, reset_mfa, ...rest } = input;
      const cols: Record<string, unknown> = { ...rest };
      if (typeof cols.email === 'string') cols.email = (cols.email as string).toLowerCase();
      if (typeof password === 'string') cols.password_hash = await hashPassword(password);
      if (reset_mfa) cols.mfa_secret = null;
      return cols;
    },
    validate(m) {
      if ((m.role === 'owner' || m.role === 'manager') && !m.company_id) throw badRequest(`role ${m.role} requires company_id`);
      if (m.role === 'erb_provincial' && m.province_id == null) throw badRequest('role erb_provincial requires province_id');
    },
    async afterWrite(c, id, input) {
      if (!Array.isArray(input.station_ids)) return;
      await c.query('DELETE FROM fms.user_station_access WHERE user_id = $1', [id]);
      if (input.station_ids.length) {
        await c.query(
          'INSERT INTO fms.user_station_access (user_id, station_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING',
          [id, input.station_ids],
        );
      }
    },
  },
  {
    name: 'api-clients', table: 'api_clients', entity: 'api_client',
    select: 't.id, t.name, t.organisation, t.key_prefix, t.scopes, t.province_id, t.company_id, t.rate_limit_rpm, t.is_active, t.created_at',
    orderBy: 't.name, t.id',
    create: z.object({
      name: z.string().min(1).max(200), organisation: z.string().min(1).max(200), scopes: z.array(z.enum(PARTNER_SCOPES)).min(1),
      province_id: z.number().int().min(1).max(10).nullable().optional(), company_id: uuid.nullable().optional(),
      rate_limit_rpm: z.number().int().min(1).max(100000).optional(), is_active: z.boolean().optional(),
    }),
    update: z.object({
      name: z.string().min(1).max(200).optional(), organisation: z.string().min(1).max(200).optional(), scopes: z.array(z.enum(PARTNER_SCOPES)).min(1).optional(),
      province_id: z.number().int().min(1).max(10).nullable().optional(), company_id: uuid.nullable().optional(),
      rate_limit_rpm: z.number().int().min(1).max(100000).optional(), is_active: z.boolean().optional(),
    }),
    filters: ['province_id', 'company_id'],
    generate() {
      const k = generateApiKey();
      return { columns: { key_prefix: k.prefix, key_hash: k.hash }, reveal: { api_key: k.key } };
    },
  },
  {
    name: 'gateways', table: 'edge_gateways', entity: 'edge_gateway',
    select: 't.id, t.station_id, t.gateway_code, t.role, t.version, t.last_seen_at, t.last_backlog, t.created_at',
    orderBy: 't.gateway_code',
    create: z.object({ station_id: uuid, gateway_code: z.string().min(1).max(64), role: z.enum(['primary', 'standby']).optional() }),
    update: z.object({ station_id: uuid.optional(), gateway_code: z.string().min(1).max(64).optional(), role: z.enum(['primary', 'standby']).optional() }),
    filters: ['station_id'],
    generate() {
      const k = generateApiKey();
      return { columns: { api_key_hash: k.hash }, reveal: { api_key: k.key } };
    },
  },
  {
    name: 'webhooks', table: 'webhook_subscriptions', entity: 'webhook_subscription',
    select: 't.id, t.api_client_id, t.url, t.events, t.is_active, t.created_at',
    orderBy: 't.created_at DESC, t.id',
    create: z.object({ api_client_id: uuid, url: z.string().url().max(2000).refine((u) => /^https?:\/\//.test(u), 'http(s) URL required'), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1), is_active: z.boolean().optional() }),
    update: z.object({ url: z.string().url().max(2000).optional(), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(), is_active: z.boolean().optional() }),
    filters: ['api_client_id'],
    generate() {
      const secret = randomBytes(32).toString('base64url');
      return { columns: { secret }, reveal: { secret } };
    },
  },
];

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`);
  return s;
};

function redactDetails(r: Resource, input: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...input };
  for (const k of r.redact ?? []) if (k in out) out[k] = '[redacted]';
  return out;
}

const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.db;
  app.addHook('preHandler', requireUser(['platform_admin']));

  for (const r of resources) {
    const tags = ['admin'];
    const fetchOne = async (q: { query: pg.PoolClient['query'] } | pg.Pool, id: string) => {
      const { rows } = await (q as pg.Pool).query(`SELECT ${r.select} FROM fms.${r.table} t WHERE t.id = $1`, [id]);
      return rows[0];
    };
    const queryShape: ZodRawShape = { limit: z.coerce.number().int().min(1).max(1000).default(200), cursor: z.string().optional() };
    for (const f of r.filters) queryShape[f] = z.string().optional();

    app.get(`/${r.name}`, { schema: { tags, summary: `List ${r.name}`, querystring: z.object(queryShape) } }, async (req) => {
      const q = req.query as Record<string, string | number | undefined>;
      const p = new Params();
      const where: string[] = ['TRUE'];
      for (const f of r.filters) if (q[f] != null && q[f] !== '') where.push(`t.${ident(f)}::text = ${p.add(String(q[f]))}`);
      const offset = Number(decodeCursor(q.cursor as string | undefined)?.[0] ?? 0) || 0;
      const limit = Number(q.limit);
      const { rows } = await db.ro.query(
        `SELECT ${r.select} FROM fms.${r.table} t WHERE ${where.join(' AND ')} ORDER BY ${r.orderBy} LIMIT ${limit + 1} OFFSET ${offset}`,
        p.values,
      );
      const more = rows.length > limit;
      return { items: rows.slice(0, limit), next_cursor: more ? encodeCursor([offset + limit]) : null };
    });

    app.get(`/${r.name}/:id`, { schema: { tags, summary: `Get one of ${r.name}`, params: z.object({ id: z.string() }) } }, async (req) => {
      if (!isUuid(req.params.id)) throw notFound(r.entity);
      const row = await fetchOne(db.primary, req.params.id);
      if (!row) throw notFound(r.entity);
      return row;
    });

    app.post(`/${r.name}`, { schema: { tags, summary: `Create ${r.entity}${r.generate ? ' (secret returned once)' : ''}`, body: r.create } }, async (req, reply) => {
      const input = req.body as Record<string, unknown>;
      r.validate?.(input);
      const cols = r.toColumns ? await r.toColumns(input, 'create') : { ...input };
      const gen = r.generate?.();
      Object.assign(cols, gen?.columns ?? {});
      const keys = Object.keys(cols).filter((k) => cols[k] !== undefined);
      const p = new Params();
      const placeholders = keys.map((k) => p.add(cols[k]));
      const out = await withTx(db.primary, async (c) => {
        const { rows } = await c.query(
          `INSERT INTO fms.${r.table} (${keys.map(ident).join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
          p.values,
        );
        const id = rows[0].id as string;
        await r.afterWrite?.(c, id, input);
        await audit(c, req as FastifyRequest, { action: `admin.${r.entity}.create`, entity: r.entity, entity_id: id, details: redactDetails(r, input) });
        const { rows: full } = await c.query(`SELECT ${r.select} FROM fms.${r.table} t WHERE t.id = $1`, [id]);
        return full[0];
      });
      return reply.status(201).send({ ...out, ...(gen?.reveal ?? {}) });
    });

    app.patch(`/${r.name}/:id`, { schema: { tags, summary: `Update ${r.entity}`, params: z.object({ id: z.string() }), body: r.update } }, async (req) => {
      if (!isUuid(req.params.id)) throw notFound(r.entity);
      const input = req.body as Record<string, unknown>;
      if (Object.keys(input).length === 0) throw badRequest('empty update');
      return withTx(db.primary, async (c) => {
        const { rows: cur } = await c.query(`SELECT * FROM fms.${r.table} WHERE id = $1 FOR UPDATE`, [req.params.id]);
        if (!cur[0]) throw notFound(r.entity);
        r.validate?.({ ...cur[0], ...input });
        const cols = r.toColumns ? await r.toColumns(input, 'update') : { ...input };
        const keys = Object.keys(cols).filter((k) => cols[k] !== undefined);
        if (keys.length) {
          const p = new Params([req.params.id]);
          await c.query(`UPDATE fms.${r.table} SET ${keys.map((k) => `${ident(k)} = ${p.add(cols[k])}`).join(', ')} WHERE id = $1`, p.values);
        }
        await r.afterWrite?.(c, req.params.id, input);
        await audit(c, req as FastifyRequest, { action: `admin.${r.entity}.update`, entity: r.entity, entity_id: req.params.id, details: redactDetails(r, input) });
        const { rows } = await c.query(`SELECT ${r.select} FROM fms.${r.table} t WHERE t.id = $1`, [req.params.id]);
        return rows[0];
      });
    });

    app.delete(`/${r.name}/:id`, { schema: { tags, summary: `Delete ${r.entity}`, params: z.object({ id: z.string() }) } }, async (req, reply) => {
      if (!isUuid(req.params.id)) throw notFound(r.entity);
      await withTx(db.primary, async (c) => {
        const { rowCount } = await c.query(`DELETE FROM fms.${r.table} WHERE id = $1`, [req.params.id]);
        if (!rowCount) throw notFound(r.entity);
        await audit(c, req as FastifyRequest, { action: `admin.${r.entity}.delete`, entity: r.entity, entity_id: req.params.id });
      });
      return reply.status(204).send();
    });

    if (r.generate) {
      app.post(`/${r.name}/:id/rotate`, { schema: { tags, summary: `Rotate ${r.entity} secret (returned once)`, params: z.object({ id: z.string() }) } }, async (req) => {
        if (!isUuid(req.params.id)) throw notFound(r.entity);
        const gen = r.generate!();
        const keys = Object.keys(gen.columns);
        const p = new Params([req.params.id]);
        return withTx(db.primary, async (c) => {
          const { rowCount } = await c.query(`UPDATE fms.${r.table} SET ${keys.map((k) => `${ident(k)} = ${p.add(gen.columns[k])}`).join(', ')} WHERE id = $1`, p.values);
          if (!rowCount) throw notFound(r.entity);
          await audit(c, req as FastifyRequest, { action: `admin.${r.entity}.rotate_secret`, entity: r.entity, entity_id: req.params.id });
          const { rows } = await c.query(`SELECT ${r.select} FROM fms.${r.table} t WHERE t.id = $1`, [req.params.id]);
          return { ...rows[0], ...gen.reveal };
        });
      });
    }
  }

  // Audit log viewer.
  app.get(
    '/audit-log',
    {
      schema: {
        tags: ['admin'],
        summary: 'Audit log, newest first',
        querystring: z.object({ action: z.string().optional(), actor_id: z.string().optional(), entity: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200), cursor: z.string().optional() }),
      },
    },
    async (req) => {
      const q = req.query;
      const p = new Params();
      const where = ['TRUE'];
      if (q.action) where.push(`action = ${p.add(q.action)}`);
      if (q.actor_id) where.push(`actor_id = ${p.add(q.actor_id)}`);
      if (q.entity) where.push(`entity = ${p.add(q.entity)}`);
      const c = decodeCursor(q.cursor);
      if (c) where.push(`id < ${p.add(Number(c[0]))}`);
      const { rows } = await db.ro.query(`SELECT * FROM fms.audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${q.limit + 1}`, p.values);
      const more = rows.length > q.limit;
      const items = rows.slice(0, q.limit);
      return { items, next_cursor: more ? encodeCursor([items[items.length - 1].id]) : null };
    },
  );
};

export default adminRoutes;
