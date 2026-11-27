-- =====================================================================
-- Analytics service migration (owned by services/analytics).
-- Applied idempotently at service start-up (ANALYTICS_APPLY_MIGRATIONS=true)
-- using DATABASE_URL (the read-write URL). Safe to run repeatedly.
-- =====================================================================
SET search_path = fms, public;

-- Depot / strategic stock feed (terminals, TAZAMA, ERB strategic reserve,
-- OMC bulk depots). One row per snapshot; the latest snapshot per
-- (depot_name, product_code) is included in GET /analytics/v1/reserve/national.
-- province_id NULL = national strategic stock not attributed to a province.
CREATE TABLE IF NOT EXISTS fms.depot_stock (
    id            BIGSERIAL PRIMARY KEY,
    product_code  TEXT NOT NULL REFERENCES fms.products(code),
    depot_name    TEXT NOT NULL,
    province_id   SMALLINT REFERENCES fms.provinces(id),
    volume_l      NUMERIC(16,3) NOT NULL CHECK (volume_l >= 0),
    capacity_l    NUMERIC(16,3),
    is_strategic  BOOLEAN NOT NULL DEFAULT false,
    as_of         TIMESTAMPTZ NOT NULL DEFAULT now(),
    source        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (depot_name, product_code, as_of)
);
CREATE INDEX IF NOT EXISTS depot_stock_latest_idx
    ON fms.depot_stock (depot_name, product_code, as_of DESC);
