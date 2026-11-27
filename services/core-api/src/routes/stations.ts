import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { EdgeCommand } from '@fms/shared';
import { requireUser, requireRoles } from '../lib/auth.js';
import { Params, encodeCursor, decodeCursor } from '../lib/sql.js';
import { stationScope, stationIdScope, assertStationInScope } from '../lib/scope.js';
import { avgDailySalesCte, daysOfCover, round, LUSAKA_TODAY_START } from '../lib/queries.js';
import { audit } from '../lib/audit.js';
import { withTx } from '../db.js';
import { badRequest, notFound, unprocessable } from '../errors.js';
import type { Queryable } from '../lib/types.js';

const idParam = z.object({ id: z.string() });
const isoDateTime = z.string().datetime({ offset: true });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const limitQ = (def: number, max: number) => z.coerce.number().int().min(1).max(max).default(def);

export const STATION_COLUMNS = `
  s.id, s.code, s.name, s.company_id, c.name AS company_name, s.province_id, p.name AS province_name,
  s.district, s.town, s.latitude, s.longitude, s.status, h.connectivity, h.controller_last_seen_at`;
export const STATION_FROM = `
  fms.stations s
  JOIN fms.companies c ON c.id = s.company_id
  JOIN fms.provinces p ON p.id = s.province_id
  JOIN fms.v_station_health h ON h.station_id = s.id`;

/** Tank state with days_of_cover for one station. */
export async function stationTanks(db: Queryable, stationId: string) {
  const p = new Params([stationId]);
  const { rows } = await db.query(
    `WITH ${avgDailySalesCte('SELECT $1::uuid')},
     prod_cap AS (SELECT product_code, sum(capacity_l) AS cap FROM fms.tanks WHERE station_id = $1 GROUP BY product_code)
     SELECT t.tank_no, t.product_code, t.capacity_l, tl.product_volume_l, tl.ullage_l, tl.water_height_mm, tl.temperature_c,
            round(100 * tl.product_volume_l / nullif(t.capacity_l, 0), 1) AS fill_pct,
            tl.measured_at, tl.probe_status, coalesce(tl.alarms, '{}') AS alarms,
            -- product-level average, apportioned to tanks of that product by capacity share
            coalesce(a.avg_daily_l * t.capacity_l / nullif(pc.cap, 0), 0) AS avg_daily_sales_l,
            t.low_level_l
       FROM fms.tanks t
       LEFT JOIN fms.tank_latest tl ON tl.station_id = t.station_id AND tl.tank_no = t.tank_no
       LEFT JOIN avg_sales a ON a.station_id = t.station_id AND a.product_code = t.product_code
       LEFT JOIN prod_cap pc ON pc.product_code = t.product_code
      WHERE t.station_id = $1
      ORDER BY t.tank_no`,
    p.values,
  );
  return rows.map((r) => ({
    ...r,
    avg_daily_sales_l: round(r.avg_daily_sales_l),
    days_of_cover: daysOfCover(r.product_volume_l, r.avg_daily_sales_l),
  }));
}

const stationRoutes: FastifyPluginAsyncZod = async (app) => {
  const ro = app.db.ro;
  const primary = app.db.primary;
  app.addHook('preHandler', requireUser());

  // ---------------------------------------------------------------- list
  app.get(
    '/stations',
    {
      schema: {
        tags: ['stations'],
        summary: 'Stations visible to the caller',
        querystring: z.object({
          province_id: z.coerce.number().int().optional(),
          company_id: z.string().uuid().optional(),
          q: z.string().max(100).optional(),
          status: z.string().optional(),
          limit: limitQ(200, 1000),
          cursor: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const p = new Params();
      const where = [stationScope(req.principal, p)];
      if (q.province_id != null) where.push(`s.province_id = ${p.add(q.province_id)}`);
      if (q.company_id) where.push(`s.company_id = ${p.add(q.company_id)}`);
      if (q.status) where.push(`s.status = ${p.add(q.status)}`);
      if (q.q) {
        const like = p.add(`%${q.q.replace(/[%_\\]/g, (m) => '\\' + m)}%`);
        where.push(`(s.code ILIKE ${like} OR s.name ILIKE ${like} OR s.town ILIKE ${like} OR s.district ILIKE ${like})`);
      }
      const cur = decodeCursor(q.cursor);
      if (cur) where.push(`s.code > ${p.add(String(cur[0]))}`);
      const { rows } = await ro.query(
        `SELECT ${STATION_COLUMNS} FROM ${STATION_FROM} WHERE ${where.join(' AND ')} ORDER BY s.code LIMIT ${q.limit + 1}`,
        p.values,
      );
      const more = rows.length > q.limit;
      const items = rows.slice(0, q.limit);
      return { items, next_cursor: more ? encodeCursor([items[items.length - 1]!.code]) : null };
    },
  );

  // ---------------------------------------------------------------- detail
  app.get('/stations/:id', { schema: { tags: ['stations'], summary: 'Station detail', params: idParam } }, async (req) => {
    await assertStationInScope(ro, req.principal, req.params.id);
    const id = req.params.id;
    const [st, tanks, grades, nozzles, health] = await Promise.all([
      ro.query(
        `SELECT ${STATION_COLUMNS}, s.address, s.timezone, s.erb_licence_no, s.zra_branch_id, s.connection_mode, s.created_at
           FROM ${STATION_FROM} WHERE s.id = $1`,
        [id],
      ),
      stationTanks(ro, id),
      ro.query(
        `SELECT id, pts_grade_id, name, product_code, zra_item_code, price FROM fms.fuel_grades WHERE station_id = $1 ORDER BY pts_grade_id`,
        [id],
      ),
      ro.query(
        `SELECT n.id, n.pump_no, n.nozzle_no, fg.pts_grade_id, fg.product_code, t.tank_no
           FROM fms.nozzles n LEFT JOIN fms.fuel_grades fg ON fg.id = n.fuel_grade_id LEFT JOIN fms.tanks t ON t.id = n.tank_id
          WHERE n.station_id = $1 ORDER BY n.pump_no, n.nozzle_no`,
        [id],
      ),
      ro.query(
        `SELECT h.connectivity, h.controller_last_seen_at, h.gateway_last_seen_at, h.gateway_backlog,
                (SELECT count(*)::int FROM fms.alerts a WHERE a.station_id = $1 AND a.acknowledged_at IS NULL) AS open_alerts,
                (SELECT count(*)::int FROM fms.pump_transactions pt WHERE pt.station_id = $1 AND pt.fiscal_status IN ('pending','failed')
                   AND pt.ended_at >= now() - interval '30 days') AS fiscal_backlog,
                (SELECT json_agg(json_build_object('pts_id', c.pts_id, 'firmware', c.firmware, 'last_seen_at', c.last_seen_at) ORDER BY c.pts_id)
                   FROM fms.controllers c WHERE c.station_id = $1) AS controllers,
                (SELECT json_agg(json_build_object('gateway_code', g.gateway_code, 'role', g.role, 'version', g.version,
                                                   'last_seen_at', g.last_seen_at, 'last_backlog', g.last_backlog) ORDER BY g.gateway_code)
                   FROM fms.edge_gateways g WHERE g.station_id = $1) AS gateways
           FROM fms.v_station_health h WHERE h.station_id = $1`,
        [id],
      ),
    ]);
    const h = health.rows[0] ?? {};
    return {
      ...st.rows[0],
      tanks,
      fuel_grades: grades.rows,
      nozzles: nozzles.rows,
      health: { ...h, controllers: h.controllers ?? [], gateways: h.gateways ?? [] },
    };
  });

  // ---------------------------------------------------------------- tanks
  app.get('/stations/:id/tanks', { schema: { tags: ['stations'], summary: 'Live tank state with days of cover (array)', params: idParam } }, async (req) => {
    await assertStationInScope(ro, req.principal, req.params.id);
    return stationTanks(ro, req.params.id);
  });

  // ---------------------------------------------------------------- transactions (keyset)
  app.get(
    '/stations/:id/transactions',
    {
      schema: {
        tags: ['stations'],
        summary: 'Pump transactions, newest first, keyset-paginated',
        params: idParam,
        querystring: z.object({
          from: isoDateTime.optional(),
          to: isoDateTime.optional(),
          pump_no: z.coerce.number().int().optional(),
          product_code: z.string().optional(),
          fiscal_status: z.enum(['pending', 'signed', 'failed', 'exempt']).optional(),
          limit: limitQ(50, 500),
          cursor: z.string().optional(),
        }),
      },
    },
    async (req) => {
      await assertStationInScope(ro, req.principal, req.params.id);
      const q = req.query;
      const p = new Params([req.params.id]);
      const where = ['pt.station_id = $1'];
      if (q.from) where.push(`pt.ended_at >= ${p.add(q.from)}::timestamptz`);
      if (q.to) where.push(`pt.ended_at < ${p.add(q.to)}::timestamptz`);
      if (q.pump_no != null) where.push(`pt.pump_no = ${p.add(q.pump_no)}`);
      if (q.product_code) where.push(`pt.product_code = ${p.add(q.product_code)}`);
      if (q.fiscal_status) where.push(`pt.fiscal_status = ${p.add(q.fiscal_status)}`);
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        if (!c || c.length !== 2) throw badRequest('invalid cursor', 'invalid_cursor');
        where.push(`(pt.ended_at, pt.id) < (${p.add(String(c[0]))}::timestamptz, ${p.add(Number(c[1]))}::bigint)`);
      }
      const { rows } = await ro.query(
        `SELECT pt.id, pt.ended_at, pt.pump_no, pt.nozzle_no, pt.product_code, pt.volume_l, pt.price, pt.amount, pt.tag,
                pt.fiscal_status, fr.zra_rcpt_no, pt.pts_transaction_no, pt.tank_no,
                to_char(pt.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _k
           FROM fms.pump_transactions pt
           LEFT JOIN fms.fiscal_receipts fr ON fr.station_id = pt.station_id AND fr.pump_no = pt.pump_no
                 AND fr.pts_transaction_no = pt.pts_transaction_no AND fr.tx_ended_at = pt.ended_at
          WHERE ${where.join(' AND ')}
          ORDER BY pt.ended_at DESC, pt.id DESC
          LIMIT ${q.limit + 1}`,
        p.values,
      );
      const more = rows.length > q.limit;
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(({ _k, ...r }) => r),
        next_cursor: more && last ? encodeCursor([last._k, last.id]) : null,
      };
    },
  );

  // ---------------------------------------------------------------- sales summary
  app.get(
    '/stations/:id/sales/summary',
    {
      schema: {
        tags: ['stations'],
        summary: 'Sales grouped by hour|day|product|pump (Africa/Lusaka buckets; array)',
        params: idParam,
        querystring: z.object({
          from: isoDateTime.optional(),
          to: isoDateTime.optional(),
          group: z.enum(['hour', 'day', 'product', 'pump']).default('hour'),
        }),
      },
    },
    async (req) => {
      const st = await assertStationInScope(ro, req.principal, req.params.id);
      const q = req.query;
      const p = new Params([req.params.id]);
      const from = q.from ? `${p.add(q.from)}::timestamptz` : LUSAKA_TODAY_START;
      const to = q.to ? `${p.add(q.to)}::timestamptz` : 'now() + interval \'1 second\'';
      // Only bind the timezone when the bucket expression uses it.
      const tzOf = () => p.add(st.timezone || 'Africa/Lusaka');
      let bucket: string, groupBy: string, extra = '';
      switch (q.group) {
        case 'hour':
          bucket = `date_trunc('hour', pt.ended_at, ${tzOf()})`; groupBy = '1, 2'; break;
        case 'day':
          bucket = `to_char(pt.ended_at AT TIME ZONE ${tzOf()}, 'YYYY-MM-DD')`; groupBy = '1, 2'; break;
        case 'product':
          bucket = `pt.product_code`; groupBy = '1, 2'; break;
        case 'pump':
          bucket = `pt.pump_no::text`; extra = ', pt.pump_no'; groupBy = '1, 2, pump_no'; break;
      }
      const { rows } = await ro.query(
        `SELECT ${bucket} AS bucket, pt.product_code${extra},
                sum(pt.volume_l) AS volume_l, sum(pt.amount) AS amount, count(*)::int AS tx_count
           FROM fms.pump_transactions pt
          WHERE pt.station_id = $1 AND pt.ended_at >= ${from} AND pt.ended_at < ${to}
          GROUP BY ${groupBy}
          ORDER BY ${q.group === 'pump' ? 'pump_no, 2' : '1, 2'}`,
        p.values,
      );
      return rows.map((r) => ({
        ...r,
        bucket: r.bucket instanceof Date ? r.bucket.toISOString() : r.bucket,
        volume_l: round(r.volume_l),
        amount: round(r.amount, 2),
      }));
    },
  );

  // ---------------------------------------------------------------- deliveries
  app.get(
    '/stations/:id/deliveries',
    {
      schema: {
        tags: ['stations'],
        summary: 'In-tank deliveries',
        params: idParam,
        querystring: z.object({ from: isoDateTime.optional(), to: isoDateTime.optional(), limit: limitQ(100, 500), cursor: z.string().optional() }),
      },
    },
    async (req) => {
      await assertStationInScope(ro, req.principal, req.params.id);
      const q = req.query;
      const p = new Params([req.params.id]);
      const where = ['d.station_id = $1'];
      if (q.from) where.push(`d.ended_at >= ${p.add(q.from)}::timestamptz`);
      if (q.to) where.push(`d.ended_at < ${p.add(q.to)}::timestamptz`);
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        if (!c || c.length !== 2) throw badRequest('invalid cursor', 'invalid_cursor');
        where.push(`(d.ended_at, d.id) < (${p.add(String(c[0]))}::timestamptz, ${p.add(Number(c[1]))}::bigint)`);
      }
      const { rows } = await ro.query(
        `SELECT d.id, d.station_id, d.tank_no, d.product_code, d.started_at, d.ended_at, d.start_volume_l, d.end_volume_l,
                d.received_volume_l, d.start_tc_volume_l, d.end_tc_volume_l, d.start_height_mm, d.end_height_mm,
                d.start_water_mm, d.end_water_mm, d.start_temperature_c, d.end_temperature_c,
                d.delivery_note_no, d.supplier, d.invoiced_volume_l,
                CASE WHEN d.invoiced_volume_l IS NOT NULL THEN d.received_volume_l - d.invoiced_volume_l END AS shortfall_l,
                d.received_at,
                to_char(d.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _k
           FROM fms.tank_deliveries d WHERE ${where.join(' AND ')}
          ORDER BY d.ended_at DESC, d.id DESC LIMIT ${q.limit + 1}`,
        p.values,
      );
      const more = rows.length > q.limit;
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return { items: page.map(({ _k, ...r }) => r), next_cursor: more && last ? encodeCursor([last._k, last.id]) : null };
    },
  );

  app.get(
    '/stations/:id/commands',
    {
      schema: {
        tags: ['stations'],
        summary: 'Commands sent to the station edge gateway (e.g. price updates) and their acknowledgement status',
        params: idParam,
        querystring: z.object({
          status: z.enum(['queued', 'delivered', 'received', 'applied', 'partial', 'failed', 'expired', 'cancelled']).optional(),
          limit: limitQ(50, 200),
          cursor: z.string().optional(),
        }),
      },
    },
    async (req) => {
      await assertStationInScope(ro, req.principal, req.params.id);
      const q = req.query;
      const p = new Params([req.params.id]);
      const where = ['e.station_id = $1'];
      if (q.status) where.push(`e.status = ${p.add(q.status)}`);
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        if (!c || c.length !== 2) throw badRequest('invalid cursor', 'invalid_cursor');
        where.push(`(e.created_at, e.id) < (${p.add(String(c[0]))}::timestamptz, ${p.add(String(c[1]))})`);
      }
      const { rows } = await ro.query(
        `SELECT e.id, e.type, e.status, e.command, e.created_at, u.full_name AS created_by_name,
                e.delivery_count, e.first_delivered_at, e.last_delivered_at, e.delivered_via,
                e.received_at, e.completed_at, e.expires_at, e.result,
                to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _k
           FROM fms.edge_commands e LEFT JOIN fms.users u ON u.id = e.created_by
          WHERE ${where.join(' AND ')}
          ORDER BY e.created_at DESC, e.id DESC LIMIT ${q.limit + 1}`,
        p.values,
      );
      const more = rows.length > q.limit;
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return { items: page.map(({ _k, ...r }) => r), next_cursor: more && last ? encodeCursor([last._k, last.id]) : null };
    },
  );

  app.patch(
    '/deliveries/:id',
    {
      preHandler: requireRoles('owner', 'manager', 'platform_admin'),
      schema: {
        tags: ['stations'],
        summary: 'Reconcile a delivery with its paperwork (owner, manager)',
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: z
          .object({
            delivery_note_no: z.string().max(100).nullable().optional(),
            supplier: z.string().max(200).nullable().optional(),
            invoiced_volume_l: z.number().nonnegative().max(1e7).nullable().optional(),
          })
          .refine((b) => Object.keys(b).length > 0, 'at least one field is required'),
      },
    },
    async (req) => {
      const b = req.body;
      return withTx(primary, async (c) => {
        const p = new Params([req.params.id]);
        const sets: string[] = [];
        for (const k of ['delivery_note_no', 'supplier', 'invoiced_volume_l'] as const) {
          if (k in b) sets.push(`${k} = ${p.add(b[k] ?? null)}`);
        }
        const { rows } = await c.query(
          `UPDATE fms.tank_deliveries SET ${sets.join(', ')}
            WHERE id = $1 AND ${stationIdScope(req.principal, p)}
            RETURNING id, station_id, tank_no, product_code, started_at, ended_at, received_volume_l, delivery_note_no, supplier, invoiced_volume_l`,
          p.values,
        );
        if (!rows[0]) throw notFound('delivery');
        await audit(c, req, { action: 'delivery.update', entity: 'tank_delivery', entity_id: req.params.id, details: { changes: b, station_id: rows[0].station_id } });
        return rows[0];
      });
    },
  );

  // ---------------------------------------------------------------- reconciliation
  app.get(
    '/stations/:id/reconciliation',
    {
      schema: {
        tags: ['stations'],
        summary: 'daily_station_product rows (book vs. physical stock)',
        params: idParam,
        querystring: z.object({ from: isoDate.optional(), to: isoDate.optional() }),
      },
    },
    async (req) => {
      await assertStationInScope(ro, req.principal, req.params.id);
      const p = new Params([req.params.id]);
      const from = req.query.from ? `${p.add(req.query.from)}::date` : `((now() AT TIME ZONE 'Africa/Lusaka')::date - 30)`;
      const to = req.query.to ? `${p.add(req.query.to)}::date` : `(now() AT TIME ZONE 'Africa/Lusaka')::date`;
      const { rows } = await ro.query(
        `SELECT station_id, business_date, product_code, province_id, sales_volume_l, sales_amount, tx_count,
                opening_stock_l, closing_stock_l, deliveries_l, variance_l,
                CASE WHEN sales_volume_l > 0 AND variance_l IS NOT NULL THEN round(100 * variance_l / sales_volume_l, 3) END AS variance_pct,
                avg_price, computed_at
           FROM fms.daily_station_product
          WHERE station_id = $1 AND business_date >= ${from} AND business_date <= ${to}
          ORDER BY business_date DESC, product_code`,
        p.values,
      );
      return { items: rows, next_cursor: null };
    },
  );

  // ---------------------------------------------------------------- prices
  app.put(
    '/stations/:id/prices',
    {
      preHandler: requireRoles('owner', 'platform_admin'),
      schema: {
        tags: ['stations'],
        summary: 'Set pump prices (validated against ERB cap); queues an edge set_prices command',
        params: idParam,
        body: z.object({
          prices: z
            .array(z.object({ pts_grade_id: z.number().int().min(0), price: z.number().positive().max(10000) }))
            .min(1)
            .max(50),
          effective_at: isoDateTime.optional(),
        }),
      },
    },
    async (req, reply) => {
      const st = await assertStationInScope(primary, req.principal, req.params.id);
      const { prices } = req.body;
      const ids = prices.map((x) => x.pts_grade_id);
      if (new Set(ids).size !== ids.length) throw badRequest('duplicate pts_grade_id');
      const effectiveAt = req.body.effective_at ? new Date(req.body.effective_at) : new Date();

      const result = await withTx(primary, async (c) => {
        const { rows: grades } = await c.query<{ id: string; pts_grade_id: number; product_code: string; price: number }>(
          `SELECT id, pts_grade_id, product_code, price FROM fms.fuel_grades WHERE station_id = $1 AND pts_grade_id = ANY($2::int[]) FOR UPDATE`,
          [st.id, ids],
        );
        const byId = new Map(grades.map((g) => [g.pts_grade_id, g]));
        const missing = ids.filter((i) => !byId.has(i));
        if (missing.length) throw unprocessable(`unknown pts_grade_id(s): ${missing.join(', ')}`, 'unknown_grade');

        const products = [...new Set(grades.map((g) => g.product_code))];
        const { rows: caps } = await c.query<{ product_code: string; price: number; province_id: number | null }>(
          `SELECT DISTINCT ON (product_code) product_code, price, province_id
             FROM fms.price_changes
            WHERE kind = 'erb_cap' AND product_code = ANY($1::text[]) AND (province_id = $2 OR province_id IS NULL)
              AND effective_at <= greatest(now(), $3::timestamptz)
            ORDER BY product_code, (province_id IS NULL), effective_at DESC, id DESC`,
          [products, st.province_id, effectiveAt.toISOString()],
        );
        const capBy = new Map(caps.map((x) => [x.product_code, x.price]));
        const violations = prices
          .map((x) => ({ ...x, product_code: byId.get(x.pts_grade_id)!.product_code, cap: capBy.get(byId.get(x.pts_grade_id)!.product_code) }))
          .filter((x) => x.cap != null && x.price > x.cap!);
        if (violations.length) {
          await audit(primary, req, {
            action: 'price.rejected_above_cap',
            entity: 'station',
            entity_id: st.id,
            details: { violations },
          });
          throw unprocessable(
            violations.map((v) => `${v.product_code} price ${v.price} exceeds ERB cap ${v.cap}`).join('; '),
            'price_above_cap',
          );
        }

        const out: Array<{ pts_grade_id: number; product_code: string; price: number; previous_price: number; cap: number | null }> = [];
        for (const x of prices) {
          const g = byId.get(x.pts_grade_id)!;
          await c.query(
            `INSERT INTO fms.price_changes (product_code, station_id, province_id, price, kind, effective_at, created_by)
             VALUES ($1, $2, $3, $4, 'station', $5, $6)`,
            [g.product_code, st.id, st.province_id, x.price, effectiveAt.toISOString(), req.principal.id],
          );
          await c.query(`UPDATE fms.fuel_grades SET price = $2 WHERE id = $1`, [g.id, x.price]);
          out.push({ pts_grade_id: x.pts_grade_id, product_code: g.product_code, price: x.price, previous_price: g.price, cap: capBy.get(g.product_code) ?? null });
        }
        const command: EdgeCommand = { id: randomUUID(), type: 'set_prices', prices: prices.map((x) => ({ pts_grade_id: x.pts_grade_id, price: x.price })), effective_at: effectiveAt.toISOString() };
        // Delivered to the station's edge gateway with acknowledgement (see db/migrations/005_edge_commands.sql).
        await c.query(
          `INSERT INTO fms.edge_commands (id, station_id, type, command, created_by) VALUES ($1, $2, 'set_prices', $3, $4)`,
          [command.id, st.id, JSON.stringify(command), req.principal.id],
        );
        await audit(c, req, {
          action: 'price.station_set',
          entity: 'station',
          entity_id: st.id,
          details: { prices: out, effective_at: command.effective_at, command_id: command.id },
        });
        return { station_id: st.id, effective_at: command.effective_at, command_id: command.id, command_status: 'queued', prices: out };
      });
      return reply.status(200).send(result);
    },
  );
};

export default stationRoutes;
