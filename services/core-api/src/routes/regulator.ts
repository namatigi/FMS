import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { requireUser, requireRoles, REGULATOR_ROLES } from '../lib/auth.js';
import { Params } from '../lib/sql.js';
import { stationScope, regulatorProvince, type Principal } from '../lib/scope.js';
import { avgDailySalesCte, daysOfCover, round } from '../lib/queries.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../errors.js';
import type { Queryable } from '../lib/types.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const provinceQ = z.coerce.number().int().min(1).max(99).optional();

/** Scoped station sub-select (id, province_id) honouring role scope + forced province. */
export function scopedStationsSql(pr: Principal, p: Params, province: number | null): string {
  const where = [stationScope(pr, p)];
  if (province != null) where.push(`s.province_id = ${p.add(province)}`);
  return `SELECT s.id, s.province_id FROM fms.stations s WHERE ${where.join(' AND ')}`;
}

/** Product position (stock, capacity, 24h sales, avg daily sales) nationally or by province. */
export async function productPosition(db: Queryable, pr: Principal, province: number | null, byProvince: boolean) {
  const p = new Params();
  const sc = scopedStationsSql(pr, p, province);
  const g = byProvince ? 'province_id, ' : '';
  const gb = byProvince ? '1, 2' : '1';
  const { rows } = await db.query(
    `WITH sc AS (${sc}),
     ${avgDailySalesCte('SELECT id FROM sc')},
     stock AS (
       SELECT ${byProvince ? 'ss.province_id, ' : ''}ss.product_code, sum(ss.product_volume_l) AS stock_l, sum(ss.capacity_l) AS capacity_l
         FROM fms.v_station_stock ss WHERE ss.station_id IN (SELECT id FROM sc) GROUP BY ${gb}),
     s24 AS (
       SELECT ${byProvince ? 'sc.province_id, ' : ''}pt.product_code, sum(pt.volume_l) AS sales_24h_l
         FROM fms.pump_transactions pt JOIN sc ON sc.id = pt.station_id
        WHERE pt.ended_at >= now() - interval '24 hours' AND pt.product_code IS NOT NULL GROUP BY ${gb}),
     av AS (
       SELECT ${byProvince ? 'sc.province_id, ' : ''}a.product_code, sum(a.avg_daily_l) AS avg_daily_l
         FROM avg_sales a JOIN sc ON sc.id = a.station_id GROUP BY ${gb})
     SELECT ${g}product_code, coalesce(stock.stock_l, 0) AS stock_l, coalesce(stock.capacity_l, 0) AS capacity_l,
            coalesce(s24.sales_24h_l, 0) AS sales_24h_l, coalesce(av.avg_daily_l, 0) AS avg_daily_l
       FROM stock FULL JOIN s24 USING (${g}product_code) FULL JOIN av USING (${g}product_code)
      ORDER BY ${g}product_code`,
    p.values,
  );
  return rows.map((r) => ({
    ...(byProvince ? { province_id: r.province_id as number } : {}),
    product_code: r.product_code as string,
    stock_l: round(r.stock_l) ?? 0,
    capacity_l: round(r.capacity_l) ?? 0,
    sales_24h_l: round(r.sales_24h_l) ?? 0,
    avg_daily_sales_l: round(r.avg_daily_l) ?? 0,
    days_of_cover: daysOfCover(r.stock_l, r.avg_daily_l),
  }));
}

/** ERB caps in force now: province-specific rows plus national rows (province_id NULL). */
export async function capsInForce(db: Queryable, province: number | null) {
  const p = new Params();
  const provFilter = province != null ? `AND (pc.province_id IS NULL OR pc.province_id = ${p.add(province)})` : '';
  const { rows } = await db.query(
    `SELECT DISTINCT ON (pc.product_code, pc.province_id)
            pc.id, pc.product_code, pr.name AS product_name, pc.province_id, pv.name AS province_name, pc.price, pc.effective_at, pc.created_at
       FROM fms.price_changes pc
       JOIN fms.products pr ON pr.code = pc.product_code
       LEFT JOIN fms.provinces pv ON pv.id = pc.province_id
      WHERE pc.kind = 'erb_cap' AND pc.effective_at <= now() ${provFilter}
      ORDER BY pc.product_code, pc.province_id NULLS FIRST, pc.effective_at DESC, pc.id DESC`,
    p.values,
  );
  return rows;
}

/** SQL for the cap applicable to a station/product (province-specific overrides national). */
const CAP_FOR = (stationAlias: string, productExpr: string) => `(
  SELECT c.price FROM fms.price_changes c
   WHERE c.kind = 'erb_cap' AND c.product_code = ${productExpr} AND c.effective_at <= now()
     AND (c.province_id = ${stationAlias}.province_id OR c.province_id IS NULL)
   ORDER BY (c.province_id IS NULL), c.effective_at DESC, c.id DESC LIMIT 1)`;

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const regulatorRoutes: FastifyPluginAsyncZod = async (app) => {
  const ro = app.db.ro;
  app.addHook('preHandler', requireUser(REGULATOR_ROLES));
  const prov = (req: FastifyRequest, requested?: number | null) => regulatorProvince(req.principal, requested ?? null);

  app.get('/overview', { schema: { tags: ['regulator'], summary: 'National (or own-province) fuel position', querystring: z.object({ province_id: provinceQ }) } }, async (req) => {
    const province = prov(req, req.query.province_id);
    const p = new Params();
    const sc = scopedStationsSql(req.principal, p, province);
    const p2 = new Params();
    const sc2 = scopedStationsSql(req.principal, p2, province);
    const [by_product, st, al] = await Promise.all([
      productPosition(ro, req.principal, province, false),
      ro.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE h.connectivity = 'online')::int AS online
           FROM fms.v_station_health h WHERE h.station_id IN (SELECT id FROM (${sc}) x)`,
        p.values,
      ),
      ro.query(
        `SELECT count(*)::int AS n FROM fms.alerts WHERE acknowledged_at IS NULL AND station_id IN (SELECT id FROM (${sc2}) x)`,
        p2.values,
      ),
    ]);
    const total = st.rows[0]?.total ?? 0, online = st.rows[0]?.online ?? 0;
    return { province_id: province, by_product, stations: { total, online, offline: total - online }, alerts_open: al.rows[0]?.n ?? 0 };
  });

  app.get('/provinces', { schema: { tags: ['regulator'], summary: 'Per-province position (array)' } }, async (req) => {
    const province = prov(req, null);
    const p = new Params();
    const sc = scopedStationsSql(req.principal, p, province);
    const p2 = new Params();
    const provFilter = province != null ? `WHERE pv.id = ${p2.add(province)}` : '';
    const [pos, counts, provinces] = await Promise.all([
      productPosition(ro, req.principal, province, true),
      ro.query(
        `SELECT x.province_id, count(*)::int AS stations, count(*) FILTER (WHERE h.connectivity = 'online')::int AS online
           FROM (${sc}) x JOIN fms.v_station_health h ON h.station_id = x.id GROUP BY x.province_id`,
        p.values,
      ),
      ro.query(`SELECT pv.id, pv.name FROM fms.provinces pv ${provFilter} ORDER BY pv.id`, p2.values),
    ]);
    const cnt = new Map(counts.rows.map((r) => [r.province_id, r]));
    return provinces.rows.map((pv) => ({
      province_id: pv.id,
      province_name: pv.name,
      stations: cnt.get(pv.id)?.stations ?? 0,
      online: cnt.get(pv.id)?.online ?? 0,
      by_product: pos.filter((x) => x.province_id === pv.id).map(({ province_id: _p, ...rest }) => rest),
    }));
  });

  app.get(
    '/provinces/:id/stations',
    { schema: { tags: ['regulator'], summary: 'Stations of a province with stock and prices (array)', params: z.object({ id: z.coerce.number().int() }) } },
    async (req) => {
      const forced = prov(req, req.params.id);
      if (forced !== req.params.id) throw notFound('province');
      const p = new Params();
      const sc = scopedStationsSql(req.principal, p, req.params.id);
      const { rows } = await ro.query(
        `SELECT s.id AS station_id, s.code, s.name, c.name AS company_name, h.connectivity, h.controller_last_seen_at, s.status,
                coalesce((SELECT json_agg(json_build_object('product_code', ss.product_code, 'stock_l', ss.product_volume_l,
                                   'capacity_l', ss.capacity_l, 'latest_reading_at', ss.latest_reading_at) ORDER BY ss.product_code)
                            FROM fms.v_station_stock ss WHERE ss.station_id = s.id), '[]') AS stock,
                coalesce((SELECT json_agg(json_build_object('product_code', g.product_code, 'price', g.price) ORDER BY g.product_code)
                            FROM (SELECT product_code, max(price) AS price FROM fms.fuel_grades WHERE station_id = s.id GROUP BY product_code) g), '[]') AS last_price
           FROM fms.stations s
           JOIN fms.companies c ON c.id = s.company_id
           JOIN fms.v_station_health h ON h.station_id = s.id
          WHERE s.id IN (SELECT id FROM (${sc}) x)
          ORDER BY s.code`,
        p.values,
      );
      // json_agg returns NUMERIC as JSON numbers already
      return rows;
    },
  );

  app.get(
    '/sales/daily',
    {
      schema: {
        tags: ['regulator'],
        summary: 'Daily sales per province × product (v_province_daily shape)',
        querystring: z.object({ from: isoDate.optional(), to: isoDate.optional(), province_id: provinceQ, product_code: z.string().optional() }),
      },
    },
    async (req) => {
      const q = req.query;
      const province = prov(req, q.province_id);
      const p = new Params();
      const sc = scopedStationsSql(req.principal, p, province);
      const where = [`d.station_id IN (SELECT id FROM (${sc}) x)`];
      where.push(q.from ? `d.business_date >= ${p.add(q.from)}::date` : `d.business_date >= (now() AT TIME ZONE 'Africa/Lusaka')::date - 30`);
      if (q.to) where.push(`d.business_date <= ${p.add(q.to)}::date`);
      if (q.product_code) where.push(`d.product_code = ${p.add(q.product_code)}`);
      // Same columns as fms.v_province_daily, computed over scoped stations.
      const { rows } = await ro.query(
        `SELECT d.province_id, d.business_date, d.product_code,
                count(DISTINCT d.station_id)::int AS reporting_stations,
                sum(d.sales_volume_l) AS sales_volume_l, sum(d.sales_amount) AS sales_amount, sum(d.deliveries_l) AS deliveries_l,
                sum(d.closing_stock_l) AS closing_stock_l, sum(d.variance_l) AS variance_l,
                CASE WHEN sum(d.sales_volume_l) > 0 THEN round(sum(d.sales_amount) / sum(d.sales_volume_l), 2) END AS avg_price
           FROM fms.daily_station_product d
          WHERE ${where.join(' AND ')}
          GROUP BY d.province_id, d.business_date, d.product_code
          ORDER BY d.business_date, d.province_id, d.product_code`,
        p.values,
      );
      return { items: rows, next_cursor: null };
    },
  );

  app.get(
    '/stock',
    { schema: { tags: ['regulator'], summary: 'Stock per province × product (v_province_stock shape)', querystring: z.object({ province_id: provinceQ }) } },
    async (req) => {
      const province = prov(req, req.query.province_id);
      const p = new Params();
      const sc = scopedStationsSql(req.principal, p, province);
      const { rows } = await ro.query(
        `SELECT pv.id AS province_id, pv.name AS province_name, ss.product_code,
                count(DISTINCT ss.station_id)::int AS stations, sum(ss.capacity_l) AS capacity_l,
                sum(ss.product_volume_l) AS product_volume_l, max(ss.latest_reading_at) AS latest_reading_at
           FROM fms.v_station_stock ss JOIN fms.provinces pv ON pv.id = ss.province_id
          WHERE ss.station_id IN (SELECT id FROM (${sc}) x)
          GROUP BY pv.id, pv.name, ss.product_code
          ORDER BY pv.id, ss.product_code`,
        p.values,
      );
      return { items: rows, next_cursor: null };
    },
  );

  app.get(
    '/compliance',
    { schema: { tags: ['regulator'], summary: 'Price violations, offline stations, variance anomalies, fiscal failures', querystring: z.object({ province_id: provinceQ }) } },
    async (req) => {
      const province = prov(req, req.query.province_id);
      const q = (fn: (sc: string, p: Params) => string) => {
        const p = new Params();
        const sc = scopedStationsSql(req.principal, p, province);
        return ro.query(fn(`SELECT id FROM (${sc}) x`, p), p.values);
      };
      const [pv, off, va, ff] = await Promise.all([
        q((sc) => `
          SELECT * FROM (
            SELECT s.id AS station_id, s.code, s.name, s.province_id, g.pts_grade_id, g.product_code, g.price, ${CAP_FOR('s', 'g.product_code')} AS cap
              FROM fms.fuel_grades g JOIN fms.stations s ON s.id = g.station_id
             WHERE s.id IN (${sc})) x
           WHERE cap IS NOT NULL AND price > cap
           ORDER BY code, pts_grade_id`),
        q((sc) => `
          SELECT h.station_id, h.code, h.name, h.province_id, h.connectivity,
                 h.controller_last_seen_at, h.gateway_last_seen_at,
                 greatest(h.controller_last_seen_at, h.gateway_last_seen_at) AS last_seen_at
            FROM fms.v_station_health h JOIN fms.stations s ON s.id = h.station_id
           WHERE h.station_id IN (${sc}) AND s.status = 'active'
             AND (greatest(h.controller_last_seen_at, h.gateway_last_seen_at) IS NULL
                  OR greatest(h.controller_last_seen_at, h.gateway_last_seen_at) < now() - interval '24 hours')
           ORDER BY last_seen_at NULLS FIRST, h.code`),
        q((sc) => `
          SELECT * FROM (
            SELECT 'stock_variance' AS kind, d.station_id, s.code, s.name, s.province_id, d.business_date, d.product_code,
                   d.variance_l, CASE WHEN d.sales_volume_l > 0 THEN round(100 * d.variance_l / d.sales_volume_l, 3) END AS variance_pct,
                   d.sales_volume_l, NULL::text AS alert_code, NULL::bigint AS alert_id
              FROM fms.daily_station_product d JOIN fms.stations s ON s.id = d.station_id
             WHERE d.station_id IN (${sc}) AND d.business_date >= (now() AT TIME ZONE 'Africa/Lusaka')::date - 7
               AND d.variance_l IS NOT NULL AND abs(d.variance_l) > greatest(50, 0.005 * d.sales_volume_l)
            UNION ALL
            SELECT 'totalizer', a.station_id, s.code, s.name, s.province_id, (a.occurred_at AT TIME ZONE 'Africa/Lusaka')::date,
                   NULL, NULL, NULL, NULL, a.code, a.id
              FROM fms.alerts a JOIN fms.stations s ON s.id = a.station_id
             WHERE a.station_id IN (${sc}) AND a.code IN ('TotalizerMismatch', 'StockVariance') AND a.occurred_at >= now() - interval '7 days'
          ) x ORDER BY business_date DESC, code`),
        q((sc) => `
          SELECT s.id AS station_id, s.code, s.name, s.province_id,
                 count(*) FILTER (WHERE pt.fiscal_status = 'failed')::int AS failed,
                 count(*) FILTER (WHERE pt.fiscal_status = 'pending' AND pt.ended_at < now() - interval '1 hour')::int AS pending_over_1h,
                 min(pt.ended_at) AS oldest_unsigned_at
            FROM fms.pump_transactions pt JOIN fms.stations s ON s.id = pt.station_id
           WHERE pt.station_id IN (${sc}) AND pt.ended_at >= now() - interval '7 days'
             AND (pt.fiscal_status = 'failed' OR (pt.fiscal_status = 'pending' AND pt.ended_at < now() - interval '1 hour'))
           GROUP BY s.id, s.code, s.name, s.province_id
           ORDER BY failed DESC, pending_over_1h DESC`),
      ]);
      return { province_id: province, price_violations: pv.rows, offline_stations: off.rows, variance_anomalies: va.rows, fiscal_failures: ff.rows };
    },
  );

  app.get('/prices', { schema: { tags: ['regulator'], summary: 'ERB cap prices currently in force' } }, async (req) => {
    return { items: await capsInForce(ro, prov(req, null)), next_cursor: null };
  });

  app.post(
    '/prices',
    {
      preHandler: requireRoles('erb_national'),
      schema: {
        tags: ['regulator'],
        summary: 'Publish an ERB cap price (erb_national only)',
        body: z.object({
          product_code: z.string().min(1).max(20),
          province_id: z.number().int().min(1).max(99).nullable().default(null),
          price: z.number().positive().max(10000),
          effective_at: z.string().datetime({ offset: true }).optional(),
        }),
      },
    },
    async (req, reply) => {
      const b = req.body;
      const { rows } = await app.db.primary.query(
        `INSERT INTO fms.price_changes (product_code, province_id, price, kind, effective_at, created_by)
         VALUES ($1, $2, $3, 'erb_cap', coalesce($4::timestamptz, now()), $5)
         RETURNING id, product_code, province_id, price, kind, effective_at, created_by, created_at`,
        [b.product_code, b.province_id, b.price, b.effective_at ?? null, req.principal.id],
      );
      await audit(app.db.primary, req, { action: 'price.erb_cap_set', entity: 'price_change', entity_id: rows[0].id, details: { ...b } });
      return reply.status(201).send(rows[0]);
    },
  );

  app.get(
    '/export',
    {
      schema: {
        tags: ['regulator'],
        summary: 'Daily per-station return for ERB (csv|json)',
        querystring: z.object({ date: isoDate.optional(), province_id: provinceQ, format: z.enum(['csv', 'json']).default('csv') }),
      },
    },
    async (req, reply) => {
      const q = req.query;
      const province = prov(req, q.province_id);
      const p = new Params();
      const sc = scopedStationsSql(req.principal, p, province);
      const dateExpr = q.date ? `${p.add(q.date)}::date` : `((now() AT TIME ZONE 'Africa/Lusaka')::date - 1)`;
      const { rows } = await ro.query(
        `SELECT to_char(${dateExpr}, 'YYYY-MM-DD') AS business_date, pv.name AS province, s.code AS station_code, s.name AS station_name,
                s.erb_licence_no, c.name AS company, c.erb_licence_no AS company_licence_no, d.product_code,
                d.opening_stock_l, d.deliveries_l, d.sales_volume_l, d.sales_amount, d.tx_count, d.closing_stock_l,
                d.variance_l, d.avg_price
           FROM fms.daily_station_product d
           JOIN fms.stations s ON s.id = d.station_id
           JOIN fms.companies c ON c.id = s.company_id
           JOIN fms.provinces pv ON pv.id = s.province_id
          WHERE d.business_date = ${dateExpr} AND d.station_id IN (SELECT id FROM (${sc}) x)
          ORDER BY pv.id, s.code, d.product_code`,
        p.values,
      );
      const date = q.date ?? (rows[0]?.business_date as string | undefined) ?? new Date(Date.now() + 2 * 3600e3 - 86400e3).toISOString().slice(0, 10);
      await audit(app.db.primary, req, { action: 'regulator.export', entity: 'export', details: { date, province_id: province, format: q.format, rows: rows.length } });
      const name = `erb-return-${date}${province != null ? `-p${province}` : ''}`;
      if (q.format === 'json') {
        reply.header('Content-Disposition', `attachment; filename="${name}.json"`);
        return { date, province_id: province, items: rows };
      }
      const cols = ['business_date', 'province', 'station_code', 'station_name', 'erb_licence_no', 'company', 'company_licence_no', 'product_code',
        'opening_stock_l', 'deliveries_l', 'sales_volume_l', 'sales_amount', 'tx_count', 'closing_stock_l', 'variance_l', 'avg_price'];
      const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(','))].join('\r\n') + '\r\n';
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${name}.csv"`);
      return reply.send(csv);
    },
  );
};

export default regulatorRoutes;
