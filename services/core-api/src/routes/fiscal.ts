import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireUser } from '../lib/auth.js';
import { Params, encodeCursor, decodeCursor } from '../lib/sql.js';
import { stationScope, assertStationInScope } from '../lib/scope.js';
import { badRequest } from '../errors.js';

const fiscalRoutes: FastifyPluginAsyncZod = async (app) => {
  const ro = app.db.ro;

  app.get(
    '/fiscal/receipts',
    {
      preHandler: requireUser(['platform_admin', 'owner', 'manager', 'zra_auditor', 'erb_national', 'erb_provincial']),
      schema: {
        tags: ['fiscal'],
        summary: 'ZRA Smart Invoice fiscal receipts, newest first',
        querystring: z.object({
          station_id: z.string().optional(),
          status: z.enum(['pending', 'signed', 'failed', 'printed']).optional(),
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
      if (q.station_id) where.push(`f.station_id = ${p.add(q.station_id)}`);
      if (q.status) where.push(`f.status = ${p.add(q.status)}`);
      if (q.from) where.push(`f.tx_ended_at >= ${p.add(q.from)}::timestamptz`);
      if (q.to) where.push(`f.tx_ended_at < ${p.add(q.to)}::timestamptz`);
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        if (!c || c.length !== 2) throw badRequest('invalid cursor', 'invalid_cursor');
        where.push(`(f.tx_ended_at, f.id) < (${p.add(String(c[0]))}::timestamptz, ${p.add(Number(c[1]))}::bigint)`);
      }
      const { rows } = await ro.query(
        `SELECT f.id, f.station_id, s.code AS station_code, s.name AS station_name, f.pump_no, f.pts_transaction_no, f.tx_ended_at,
                f.invoice_no, f.status, f.fiscalised_by, f.zra_rcpt_no, f.zra_tot_rcpt_no, f.zra_internal_data, f.zra_signature,
                f.zra_sdc_id, f.zra_mrc_no, f.zra_qr_url, f.zra_signed_at, f.printed_at, f.attempts, f.last_error, f.created_at,
                pt.volume_l, pt.amount, pt.product_code,
                to_char(f.tx_ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _k
           FROM fms.fiscal_receipts f
           JOIN fms.stations s ON s.id = f.station_id
           LEFT JOIN fms.pump_transactions pt ON pt.station_id = f.station_id AND pt.pump_no = f.pump_no
                 AND pt.pts_transaction_no = f.pts_transaction_no AND pt.ended_at = f.tx_ended_at
          WHERE ${where.join(' AND ')}
          ORDER BY f.tx_ended_at DESC, f.id DESC LIMIT ${q.limit + 1}`,
        p.values,
      );
      const more = rows.length > q.limit;
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return { items: page.map(({ _k, ...r }) => r), next_cursor: more && last ? encodeCursor([last._k, last.id]) : null };
    },
  );
};

export default fiscalRoutes;
