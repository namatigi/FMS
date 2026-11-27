/**
 * Reusable SQL fragments. All take a `scopedStations` sub-select that must
 * already be restricted by stationScope().
 */

/** Start of "today" in Africa/Lusaka as timestamptz. */
export const LUSAKA_TODAY_START = `(date_trunc('day', now() AT TIME ZONE 'Africa/Lusaka') AT TIME ZONE 'Africa/Lusaka')`;
export const LUSAKA_TODAY = `(now() AT TIME ZONE 'Africa/Lusaka')::date`;

/**
 * CTE body producing (station_id, product_code, avg_daily_l): average daily sales
 * over the last 7 complete days from daily_station_product; falls back to
 * pump_transactions over the last 7×24h when no roll-ups exist.
 */
export function avgDailySalesCte(scopedStations: string): string {
  return `
  avg_dsp AS (
    SELECT station_id, product_code, sum(sales_volume_l) AS vol, count(DISTINCT business_date) AS days
      FROM fms.daily_station_product
     WHERE station_id IN (${scopedStations})
       AND business_date >= ${LUSAKA_TODAY} - 7 AND business_date < ${LUSAKA_TODAY}
     GROUP BY 1, 2),
  avg_ptx AS (
    SELECT station_id, product_code, sum(volume_l) AS vol
      FROM fms.pump_transactions
     WHERE station_id IN (${scopedStations}) AND ended_at >= now() - interval '7 days' AND product_code IS NOT NULL
     GROUP BY 1, 2),
  avg_sales AS (
    SELECT station_id, product_code,
           CASE WHEN d.days > 0 AND d.vol > 0 THEN d.vol / d.days ELSE coalesce(x.vol, 0) / 7.0 END AS avg_daily_l
      FROM avg_dsp d FULL JOIN avg_ptx x USING (station_id, product_code))`;
}

export const round = (n: number | null | undefined, dp = 3): number | null =>
  n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp;

export const daysOfCover = (stock: number | null | undefined, avg: number | null | undefined): number | null =>
  stock == null || !avg || avg <= 0 ? null : round(stock / avg, 1);
