/**
 * `erb_export` — daily per-station return for the Energy Regulation Board.
 * payload: { date: 'YYYY-MM-DD', province_id: number | null }   (null = national)
 *
 * Reads fms.daily_station_product, writes CSV + JSON to object storage at
 *   erb/daily/<date>/<PROVINCE_CODE|NATIONAL>.{csv,json}
 * then enqueues a `webhook` job with event 'daily_summary'.
 * Waits (retryable) while rollup jobs for that date are still pending.
 */
import { JobError, num, permanent, req } from '../core.js';
import type { JobHandler } from './types.js';

export const ERB_COLUMNS = [
  'business_date', 'province_id', 'province_name', 'station_code', 'station_name', 'company_name', 'erb_licence_no',
  'product_code', 'opening_stock_l', 'deliveries_l', 'sales_volume_l', 'sales_amount', 'tx_count', 'closing_stock_l',
  'variance_l', 'avg_price',
] as const;
const NUMERIC_COLS = new Set(['opening_stock_l', 'deliveries_l', 'sales_volume_l', 'sales_amount', 'tx_count', 'closing_stock_l', 'variance_l', 'avg_price']);

type Row = Record<(typeof ERB_COLUMNS)[number], string | number | null> & { station_id: string };

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Array<Record<string, unknown>>, cols: readonly string[]): string {
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

export const erbExportHandler: JobHandler = {
  kind: 'erb_export',
  async handle(ctx) {
    const date = req.date(ctx.job.payload, 'date');
    const rawProv = ctx.job.payload.province_id;
    const provinceId = rawProv === null || rawProv === undefined ? null : Number(rawProv);
    if (provinceId !== null && !Number.isInteger(provinceId)) throw permanent('payload.province_id must be an integer or null', 'BAD_PAYLOAD');

    let scope = 'NATIONAL';
    let provinceName: string | null = null;
    if (provinceId !== null) {
      const p = await ctx.db.query<{ code: string; name: string }>('SELECT code, name FROM fms.provinces WHERE id = $1', [provinceId]);
      if (!p.rows[0]) throw permanent(`province ${provinceId} not found`, 'BAD_PAYLOAD');
      scope = p.rows[0].code;
      provinceName = p.rows[0].name;
    }

    const pending = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM fms.jobs j
         JOIN fms.stations s ON s.id::text = j.payload->>'station_id'
        WHERE j.kind = 'rollup' AND j.status IN ('queued','running') AND j.payload->>'business_date' = $1
          AND ($2::smallint IS NULL OR s.province_id = $2)`,
      [date, provinceId],
    );
    if (Number(pending.rows[0]?.n ?? 0) > 0) throw new JobError(`waiting for ${pending.rows[0]!.n} rollup job(s) for ${date}`, true, 'ROLLUP_PENDING');

    const { rows } = await ctx.db.query<Row>(
      `SELECT d.business_date::text AS business_date, d.province_id, p.name AS province_name, s.id AS station_id,
              s.code AS station_code, s.name AS station_name, c.name AS company_name, s.erb_licence_no, d.product_code,
              d.opening_stock_l, d.deliveries_l, d.sales_volume_l, d.sales_amount, d.tx_count, d.closing_stock_l,
              d.variance_l, d.avg_price
         FROM fms.daily_station_product d
         JOIN fms.stations s  ON s.id = d.station_id
         JOIN fms.companies c ON c.id = s.company_id
         JOIN fms.provinces p ON p.id = d.province_id
        WHERE d.business_date = $1::date AND ($2::smallint IS NULL OR d.province_id = $2)
        ORDER BY d.province_id, s.code, d.product_code`,
      [date, provinceId],
    );
    const records = rows.map((r) => {
      const o: Record<string, unknown> = {};
      for (const c of ERB_COLUMNS) o[c] = NUMERIC_COLS.has(c) ? num(r[c]) : r[c];
      return o;
    });

    const totals = new Map<string, { product_code: string; sales_volume_l: number; sales_amount: number; deliveries_l: number; closing_stock_l: number; stations: number }>();
    for (const r of records) {
      const k = String(r.product_code);
      const t = totals.get(k) ?? { product_code: k, sales_volume_l: 0, sales_amount: 0, deliveries_l: 0, closing_stock_l: 0, stations: 0 };
      t.sales_volume_l += Number(r.sales_volume_l ?? 0);
      t.sales_amount += Number(r.sales_amount ?? 0);
      t.deliveries_l += Number(r.deliveries_l ?? 0);
      t.closing_stock_l += Number(r.closing_stock_l ?? 0);
      t.stations += 1;
      totals.set(k, t);
    }
    const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
    const byProduct = [...totals.values()].map((t) => ({
      ...t, sales_volume_l: round(t.sales_volume_l, 3), sales_amount: round(t.sales_amount, 2), deliveries_l: round(t.deliveries_l, 3), closing_stock_l: round(t.closing_stock_l, 3),
    }));
    const stationCount = new Set(rows.map((r) => r.station_id)).size;

    const key = `erb/daily/${date}/${scope}`;
    const generatedAt = new Date().toISOString();
    const csv = await ctx.storage.put(`${key}.csv`, toCsv(records, ERB_COLUMNS), 'text/csv');
    const json = await ctx.storage.put(
      `${key}.json`,
      JSON.stringify({ date, province_id: provinceId, province_name: provinceName, generated_at: generatedAt, station_count: stationCount, totals: byProduct, rows: records }, null, 2),
      'application/json',
    );

    await ctx.queue.enqueue({
      kind: 'webhook',
      payload: {
        event: 'daily_summary',
        data: { date, province_id: provinceId, province_name: provinceName, station_count: stationCount, totals: byProduct, files: { csv: csv.uri, json: json.uri }, generated_at: generatedAt },
      },
      dedupeKey: `webhook:daily_summary:${date}:${scope}`,
    });
    ctx.log.info({ date, scope, rows: records.length, stations: stationCount, csv: csv.uri }, 'ERB daily return exported');
  },
};
