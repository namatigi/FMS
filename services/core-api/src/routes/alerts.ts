import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireUser, requireRoles } from '../lib/auth.js';
import { Params, encodeCursor, decodeCursor } from '../lib/sql.js';
import { stationScope, assertStationInScope } from '../lib/scope.js';
import { audit } from '../lib/audit.js';
import { withTx } from '../db.js';
import { badRequest, notFound } from '../errors.js';

export const ALERT_COLUMNS = `a.id, a.station_id, s.code AS station_code, s.name AS station_name, s.province_id,
  a.occurred_at, a.device_type, a.device_no, a.code, a.severity, a.message, a.data,
  a.acknowledged_at, a.acknowledged_by, a.received_at,
  CASE WHEN a.acknowledged_at IS NULL THEN 'open' ELSE 'acknowledged' END AS status`;

const alertRoutes: FastifyPluginAsyncZod = async (app) => {
  const ro = app.db.ro;
  app.addHook('preHandler', requireUser());

  app.get(
    '/alerts',
    {
      schema: {
        tags: ['alerts'],
        summary: 'Alerts in scope (default: open only), newest first',
        querystring: z.object({
          station_id: z.string().optional(),
          status: z.enum(['open', 'all', 'acknowledged']).default('open'),
          severity: z.enum(['info', 'warning', 'critical']).optional(),
          from: z.string().datetime({ offset: true }).optional(),
          to: z.string().datetime({ offset: true }).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          cursor: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      if (q.station_id) await assertStationInScope(ro, req.principal, q.station_id);
      const p = new Params();
      const where = [stationScope(req.principal, p)];
      if (q.station_id) where.push(`a.station_id = ${p.add(q.station_id)}`);
      if (q.status === 'open') where.push('a.acknowledged_at IS NULL');
      if (q.status === 'acknowledged') where.push('a.acknowledged_at IS NOT NULL');
      if (q.severity) where.push(`a.severity = ${p.add(q.severity)}`);
      if (q.from) where.push(`a.occurred_at >= ${p.add(q.from)}::timestamptz`);
      if (q.to) where.push(`a.occurred_at < ${p.add(q.to)}::timestamptz`);
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        if (!c || c.length !== 2) throw badRequest('invalid cursor', 'invalid_cursor');
        where.push(`(a.occurred_at, a.id) < (${p.add(String(c[0]))}::timestamptz, ${p.add(Number(c[1]))}::bigint)`);
      }
      const { rows } = await ro.query(
        `SELECT ${ALERT_COLUMNS}, to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _k
           FROM fms.alerts a JOIN fms.stations s ON s.id = a.station_id
          WHERE ${where.join(' AND ')}
          ORDER BY a.occurred_at DESC, a.id DESC LIMIT ${q.limit + 1}`,
        p.values,
      );
      const more = rows.length > q.limit;
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return { items: page.map(({ _k, ...r }) => r), next_cursor: more && last ? encodeCursor([last._k, last.id]) : null };
    },
  );

  app.post(
    '/alerts/:id/ack',
    {
      preHandler: requireRoles('platform_admin', 'owner', 'manager'),
      schema: {
        tags: ['alerts'],
        summary: 'Acknowledge an alert',
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: z.object({ note: z.string().max(1000).optional() }).optional(),
      },
    },
    async (req) => {
      return withTx(app.db.primary, async (c) => {
        const p = new Params([req.params.id, req.principal.id]);
        const { rows } = await c.query(
          `UPDATE fms.alerts a SET acknowledged_at = coalesce(a.acknowledged_at, now()), acknowledged_by = coalesce(a.acknowledged_by, $2::uuid)
             FROM fms.stations s
            WHERE a.id = $1 AND s.id = a.station_id AND ${stationScope(req.principal, p)}
            RETURNING ${ALERT_COLUMNS}`,
          p.values,
        );
        if (!rows[0]) throw notFound('alert');
        await audit(c, req, { action: 'alert.ack', entity: 'alert', entity_id: req.params.id, details: { station_id: rows[0].station_id, note: req.body?.note ?? null } });
        return rows[0];
      });
    },
  );
};

export default alertRoutes;
