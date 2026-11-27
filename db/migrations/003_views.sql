-- =====================================================================
-- Read models for dashboards, ERB regulator and partner API.
-- =====================================================================
SET search_path = fms, public;

-- Live stock per station × product (sum of tanks).
CREATE OR REPLACE VIEW v_station_stock AS
SELECT s.id                AS station_id,
       s.code              AS station_code,
       s.name              AS station_name,
       s.company_id,
       s.province_id,
       t.product_code,
       count(*)                                  AS tank_count,
       sum(t.capacity_l)                         AS capacity_l,
       sum(tl.product_volume_l)                  AS product_volume_l,
       sum(tl.ullage_l)                          AS ullage_l,
       min(tl.measured_at)                       AS oldest_reading_at,
       max(tl.measured_at)                       AS latest_reading_at
FROM stations s
JOIN tanks t           ON t.station_id = s.id
LEFT JOIN tank_latest tl ON tl.station_id = t.station_id AND tl.tank_no = t.tank_no
GROUP BY s.id, s.code, s.name, s.company_id, s.province_id, t.product_code;

-- National / provincial fuel position (ERB).
CREATE OR REPLACE VIEW v_province_stock AS
SELECT p.id   AS province_id,
       p.name AS province_name,
       ss.product_code,
       count(DISTINCT ss.station_id)  AS stations,
       sum(ss.capacity_l)             AS capacity_l,
       sum(ss.product_volume_l)       AS product_volume_l,
       max(ss.latest_reading_at)      AS latest_reading_at
FROM provinces p
JOIN v_station_stock ss ON ss.province_id = p.id
GROUP BY p.id, p.name, ss.product_code;

-- Daily sales per province × product (ERB).
CREATE OR REPLACE VIEW v_province_daily AS
SELECT d.province_id,
       d.business_date,
       d.product_code,
       count(DISTINCT d.station_id) AS reporting_stations,
       sum(d.sales_volume_l)        AS sales_volume_l,
       sum(d.sales_amount)          AS sales_amount,
       sum(d.deliveries_l)          AS deliveries_l,
       sum(d.closing_stock_l)       AS closing_stock_l,
       sum(d.variance_l)            AS variance_l,
       CASE WHEN sum(d.sales_volume_l) > 0
            THEN round(sum(d.sales_amount) / sum(d.sales_volume_l), 2) END AS avg_price
FROM daily_station_product d
GROUP BY d.province_id, d.business_date, d.product_code;

-- Station connectivity health (for "is data trustworthy?" and downtime SLAs).
CREATE OR REPLACE VIEW v_station_health AS
SELECT s.id AS station_id, s.code, s.name, s.province_id, s.company_id,
       max(c.last_seen_at)  AS controller_last_seen_at,
       max(g.last_seen_at)  AS gateway_last_seen_at,
       max(g.last_backlog)  AS gateway_backlog,
       CASE
         WHEN greatest(max(c.last_seen_at), max(g.last_seen_at)) > now() - interval '5 minutes'  THEN 'online'
         WHEN greatest(max(c.last_seen_at), max(g.last_seen_at)) > now() - interval '1 hour'     THEN 'degraded'
         ELSE 'offline'
       END AS connectivity
FROM stations s
LEFT JOIN controllers c   ON c.station_id = s.id
LEFT JOIN edge_gateways g ON g.station_id = s.id
GROUP BY s.id, s.code, s.name, s.province_id, s.company_id;

-- ---------------------------------------------------------------------
-- Daily roll-up: recompute one station-day (idempotent). Business day is
-- the station-local calendar day.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rollup_station_day(p_station UUID, p_date DATE)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    tz      TEXT;
    prov    SMALLINT;
    d_start TIMESTAMPTZ;
    d_end   TIMESTAMPTZ;
BEGIN
    SELECT timezone, province_id INTO tz, prov FROM stations WHERE id = p_station;
    d_start := (p_date::timestamp AT TIME ZONE tz);
    d_end   := ((p_date + 1)::timestamp AT TIME ZONE tz);

    INSERT INTO daily_station_product AS d
        (station_id, business_date, product_code, province_id,
         sales_volume_l, sales_amount, tx_count, opening_stock_l, closing_stock_l,
         deliveries_l, variance_l, avg_price, computed_at)
    SELECT p_station, p_date, pc.product_code, prov,
           coalesce(s.vol, 0), coalesce(s.amt, 0), coalesce(s.cnt, 0),
           o.stock, c.stock, coalesce(dl.vol, 0),
           CASE WHEN o.stock IS NOT NULL AND c.stock IS NOT NULL
                THEN (o.stock + coalesce(dl.vol,0) - coalesce(s.vol,0)) - c.stock END,
           CASE WHEN coalesce(s.vol,0) > 0 THEN round(s.amt / s.vol, 2) END,
           now()
    FROM (SELECT DISTINCT product_code FROM tanks WHERE station_id = p_station) pc
    LEFT JOIN LATERAL (
        SELECT sum(volume_l) vol, sum(amount) amt, count(*) cnt
        FROM pump_transactions
        WHERE station_id = p_station AND product_code = pc.product_code
          AND ended_at >= d_start AND ended_at < d_end) s ON true
    LEFT JOIN LATERAL (
        SELECT sum(x.v) stock FROM (
            SELECT DISTINCT ON (m.tank_no) m.product_volume_l v
            FROM tank_measurements m JOIN tanks t ON t.station_id = m.station_id AND t.tank_no = m.tank_no
            WHERE m.station_id = p_station AND t.product_code = pc.product_code AND m.measured_at < d_start
              AND m.measured_at >= d_start - interval '7 days'
            ORDER BY m.tank_no, m.measured_at DESC) x) o ON true
    LEFT JOIN LATERAL (
        SELECT sum(x.v) stock FROM (
            SELECT DISTINCT ON (m.tank_no) m.product_volume_l v
            FROM tank_measurements m JOIN tanks t ON t.station_id = m.station_id AND t.tank_no = m.tank_no
            WHERE m.station_id = p_station AND t.product_code = pc.product_code AND m.measured_at < d_end
              AND m.measured_at >= d_end - interval '7 days'
            ORDER BY m.tank_no, m.measured_at DESC) x) c ON true
    LEFT JOIN LATERAL (
        SELECT sum(received_volume_l) vol FROM tank_deliveries td
        JOIN tanks t ON t.station_id = td.station_id AND t.tank_no = td.tank_no
        WHERE td.station_id = p_station AND t.product_code = pc.product_code
          AND td.ended_at >= d_start AND td.ended_at < d_end) dl ON true
    ON CONFLICT (station_id, business_date, product_code) DO UPDATE SET
        sales_volume_l = EXCLUDED.sales_volume_l, sales_amount = EXCLUDED.sales_amount,
        tx_count = EXCLUDED.tx_count, opening_stock_l = EXCLUDED.opening_stock_l,
        closing_stock_l = EXCLUDED.closing_stock_l, deliveries_l = EXCLUDED.deliveries_l,
        variance_l = EXCLUDED.variance_l, avg_price = EXCLUDED.avg_price, computed_at = now();
END $$;
