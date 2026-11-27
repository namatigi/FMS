/** `rollup` — recompute one station-day read model. payload: { station_id, business_date } */
import { req, withTx } from '../core.js';
import type { JobHandler } from './types.js';

export const rollupHandler: JobHandler = {
  kind: 'rollup',
  async handle(ctx) {
    const stationId = req.uuid(ctx.job.payload, 'station_id');
    const date = req.date(ctx.job.payload, 'business_date');
    await withTx(ctx.db, async (c) => {
      // fms.rollup_station_day references its tables unqualified and has no SET search_path
      // attribute (db/migrations/003_views.sql), so pin the search_path for this transaction.
      await c.query('SET LOCAL search_path = fms, public');
      await c.query('SELECT fms.rollup_station_day($1::uuid, $2::date)', [stationId, date]);
    });
    ctx.log.debug({ station_id: stationId, business_date: date }, 'station-day rolled up');
  },
};
