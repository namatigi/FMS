import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireUser } from '../lib/auth.js';
import { Params } from '../lib/sql.js';
import { stationIdScope, assertStationInScope, type Principal } from '../lib/scope.js';

/**
 * GET /api/v1/stream?station_id=&token=
 *
 * Server-Sent Events for live dashboards. Implementation: polling the read
 * pool every STREAM_POLL_MS (default 5 s) — no triggers are installed on
 * tables owned by other services. Each tick queries rows newer than the
 * previous tick (with a 15 s overlap window + de-duplication so rows from
 * late-committing transactions are not missed).
 *
 * Events (data is JSON):
 *   event: tank_latest  data: {items:[tank_latest rows]}      (also sent once on connect as a snapshot)
 *   event: sales        data: {items:[pump transaction rows]}
 *   event: alert        data: {items:[alert rows]}
 *   event: ready        data: {station_id, poll_ms}
 * A `: keepalive` comment is written every tick.
 */
const OVERLAP_SEC = 15;

const streamRoutes: FastifyPluginAsyncZod = async (app) => {
  const ro = app.db.ro;

  app.get(
    '/stream',
    {
      preHandler: requireUser(undefined, { allowQueryToken: true }),
      schema: {
        tags: ['stream'],
        summary: 'Server-Sent Events: tank_latest / sales / alert (auth via Bearer header or ?token=)',
        querystring: z.object({ station_id: z.string().optional(), token: z.string().optional() }),
      },
    },
    async (req, reply) => {
      const pr: Principal = req.principal;
      const stationId = req.query.station_id;
      if (stationId) await assertStationInScope(ro, pr, stationId);

      const filter = (p: Params, col: string) =>
        stationId ? `${col} = ${p.add(stationId)}` : stationIdScope(pr, p, col);

      reply.hijack();
      const raw = reply.raw;
      for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) raw.setHeader(k, v as string);
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (event: string, data: unknown) => {
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const seen = new Map<string, number>(); // key -> epoch ms first seen
      let since: Date = new Date();
      let closed = false;
      let busy = false;

      const fresh = <T extends Record<string, unknown>>(rows: T[], key: (r: T) => string) =>
        rows.filter((r) => {
          const k = key(r);
          if (seen.has(k)) return false;
          seen.set(k, Date.now());
          return true;
        });

      const tick = async (initial = false) => {
        if (closed || busy) return;
        busy = true;
        try {
          const { rows: nowRows } = await ro.query<{ now: Date }>('SELECT now() AS now');
          const from = new Date(since.getTime() - OVERLAP_SEC * 1000).toISOString();

          const p1 = new Params();
          const tanks = await ro.query(
            `SELECT station_id, tank_no, measured_at, product_code, probe_status, alarms, product_height_mm, water_height_mm,
                    temperature_c, product_volume_l, water_volume_l, ullage_l, tc_volume_l
               FROM fms.tank_latest WHERE ${filter(p1, 'station_id')}
               ${initial ? '' : `AND measured_at > ${p1.add(from)}::timestamptz`}
              ORDER BY station_id, tank_no LIMIT 2000`,
            p1.values,
          );
          const t = initial ? tanks.rows : fresh(tanks.rows, (r) => `t:${r.station_id}:${r.tank_no}:${(r.measured_at as Date).getTime()}`);
          if (initial) for (const r of tanks.rows) seen.set(`t:${r.station_id}:${r.tank_no}:${(r.measured_at as Date).getTime()}`, Date.now());
          if (t.length) send('tank_latest', { items: t });

          if (!initial) {
            const p2 = new Params();
            const sales = await ro.query(
              `SELECT id, station_id, ended_at, pump_no, nozzle_no, product_code, volume_l, price, amount, tag, fiscal_status
                 FROM fms.pump_transactions
                WHERE ${filter(p2, 'station_id')} AND received_at > ${p2.add(from)}::timestamptz
                  AND ended_at > now() - interval '2 days'
                ORDER BY received_at LIMIT 1000`,
              p2.values,
            );
            const s = fresh(sales.rows, (r) => `s:${r.id}`);
            if (s.length) send('sales', { items: s });

            const p3 = new Params();
            const alerts = await ro.query(
              `SELECT id, station_id, occurred_at, device_type, device_no, code, severity, message, data, acknowledged_at
                 FROM fms.alerts WHERE ${filter(p3, 'station_id')} AND received_at > ${p3.add(from)}::timestamptz
                ORDER BY received_at LIMIT 500`,
              p3.values,
            );
            const a = fresh(alerts.rows, (r) => `a:${r.id}`);
            if (a.length) send('alert', { items: a });
          }

          since = nowRows[0]!.now;
          const cutoff = Date.now() - (OVERLAP_SEC + 60) * 1000;
          for (const [k, v] of seen) if (v < cutoff) seen.delete(k);
          raw.write(': keepalive\n\n');
        } catch (e) {
          req.log.warn({ err: e }, 'sse poll failed');
        } finally {
          busy = false;
        }
      };

      const timer = setInterval(() => void tick(), app.config.streamPollMs);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        app.sseClosers.delete(close);
        app.metrics.sseClients.dec();
        raw.end();
      };
      app.sseClosers.add(close);
      app.metrics.sseClients.inc();
      req.raw.on('close', close);
      raw.on('error', close);

      send('ready', { station_id: stationId ?? null, poll_ms: app.config.streamPollMs });
      await tick(true);
    },
  );
};

export default streamRoutes;
