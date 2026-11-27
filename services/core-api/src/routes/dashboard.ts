import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireUser } from '../lib/auth.js';
import { Params } from '../lib/sql.js';
import { stationScope } from '../lib/scope.js';
import { LUSAKA_TODAY_START, round } from '../lib/queries.js';

const dashboardRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/dashboard/overview',
    { preHandler: requireUser(), schema: { tags: ['dashboard'], summary: 'Overview KPIs scoped to the caller' } },
    async (req) => {
      const ro = app.db.ro;
      // Each query gets its own Params so placeholders are never left unused.
      const mk = () => {
        const p = new Params();
        return {
          p,
          get pred() { return stationScope(req.principal, p); },
          get scoped() { return `SELECT s.id FROM fms.stations s WHERE ${stationScope(req.principal, p)}`; },
        };
      };

      const a = mk();
      const counts = ro.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE h.connectivity = 'online')::int AS online
           FROM fms.stations s JOIN fms.v_station_health h ON h.station_id = s.id WHERE ${a.pred}`,
        a.p.values,
      );
      const b = mk();
      const sales = ro.query(
        `SELECT product_code, sum(volume_l) AS volume_l, sum(amount) AS amount, count(*)::int AS tx_count
           FROM fms.pump_transactions WHERE ended_at >= ${LUSAKA_TODAY_START} AND station_id IN (${b.scoped})
          GROUP BY product_code`,
        b.p.values,
      );
      const c = mk();
      const stock = ro.query(
        `SELECT product_code, sum(product_volume_l) AS stock_l, sum(capacity_l) AS capacity_l
           FROM fms.v_station_stock WHERE station_id IN (${c.scoped}) GROUP BY product_code`,
        c.p.values,
      );
      const d = mk();
      const low = ro.query(
        `SELECT s.id AS station_id, s.name AS station_name, t.tank_no, t.product_code, tl.product_volume_l, t.capacity_l,
                round(100 * tl.product_volume_l / nullif(t.capacity_l, 0), 1) AS fill_pct
           FROM fms.tanks t JOIN fms.stations s ON s.id = t.station_id
           JOIN fms.tank_latest tl ON tl.station_id = t.station_id AND tl.tank_no = t.tank_no
          WHERE ${d.pred} AND tl.product_volume_l <= coalesce(t.low_level_l, t.capacity_l * 0.2)
          ORDER BY fill_pct ASC NULLS LAST LIMIT 100`,
        d.p.values,
      );
      const e = mk();
      const alerts = ro.query(
        `SELECT count(*) FILTER (WHERE severity = 'critical')::int AS critical, count(*) FILTER (WHERE severity = 'warning')::int AS warning
           FROM fms.alerts WHERE acknowledged_at IS NULL AND station_id IN (${e.scoped})`,
        e.p.values,
      );
      const [cr, sr, st, lr, ar] = await Promise.all([counts, sales, stock, low, alerts]);

      const products = new Map<string, { product_code: string; sales_today_l: number; sales_today_amount: number; stock_l: number; capacity_l: number }>();
      const get = (code: string) => {
        let v = products.get(code);
        if (!v) products.set(code, (v = { product_code: code, sales_today_l: 0, sales_today_amount: 0, stock_l: 0, capacity_l: 0 }));
        return v;
      };
      let vol = 0, amt = 0, n = 0;
      for (const r of sr.rows) {
        vol += r.volume_l ?? 0; amt += r.amount ?? 0; n += r.tx_count;
        if (!r.product_code) continue;
        const v = get(r.product_code);
        v.sales_today_l = round(r.volume_l) ?? 0;
        v.sales_today_amount = round(r.amount, 2) ?? 0;
      }
      for (const r of st.rows) {
        const v = get(r.product_code);
        v.stock_l = round(r.stock_l) ?? 0;
        v.capacity_l = round(r.capacity_l) ?? 0;
      }
      const total = cr.rows[0]?.total ?? 0;
      const online = cr.rows[0]?.online ?? 0;
      return {
        stations_total: total,
        stations_online: online,
        stations_offline: total - online,
        sales_today: { volume_l: round(vol) ?? 0, amount: round(amt, 2) ?? 0, tx_count: n },
        by_product: [...products.values()].sort((x, y) => x.product_code.localeCompare(y.product_code)),
        low_stock_tanks: lr.rows,
        open_alerts: { critical: ar.rows[0]?.critical ?? 0, warning: ar.rows[0]?.warning ?? 0 },
      };
    },
  );
};

export default dashboardRoutes;
