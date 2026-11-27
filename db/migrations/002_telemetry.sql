-- =====================================================================
-- Telemetry: pump sales, tank measurements, deliveries, alerts, fiscal.
-- Partitioned monthly. Partitions are created by fms.ensure_partitions().
-- =====================================================================
SET search_path = fms, public;

-- Raw inbound packets (audit + replay). Kept 90 days (drop old partitions).
CREATE TABLE ingest_raw (
    id              BIGSERIAL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    source          TEXT NOT NULL CHECK (source IN ('pts_direct','edge')),
    pts_id          TEXT,
    gateway_code    TEXT,
    station_id      UUID,
    packet_type     TEXT NOT NULL,
    payload         JSONB NOT NULL,
    PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);

-- One row per completed dispenser sale (PTS-2 UploadPumpTransaction).
CREATE TABLE pump_transactions (
    id                  BIGSERIAL,
    station_id          UUID NOT NULL,
    pts_id              TEXT NOT NULL,
    pts_transaction_no  INTEGER NOT NULL,          -- PTS-2 "Transaction" (wraps; unique together with pump + ended_at)
    pump_no             INTEGER NOT NULL,
    nozzle_no           INTEGER NOT NULL,
    pts_grade_id        INTEGER,
    product_code        TEXT,                      -- resolved via fuel_grades
    tank_no             INTEGER,                   -- resolved via nozzles
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ NOT NULL,
    volume_l            NUMERIC(14,3) NOT NULL,
    tc_volume_l         NUMERIC(14,3),             -- temperature-compensated (15 °C)
    price               NUMERIC(10,2) NOT NULL,
    amount              NUMERIC(14,2) NOT NULL,
    total_volume_l      NUMERIC(16,3),             -- pump volume totaliser after sale (non-resettable)
    total_amount        NUMERIC(18,2),
    tag                 TEXT,                      -- attendant/customer RFID tag
    pts_user_id         INTEGER,                   -- management system that authorised the pump
    source              TEXT NOT NULL DEFAULT 'edge',
    fiscal_status       TEXT NOT NULL DEFAULT 'pending' CHECK (fiscal_status IN ('pending','signed','failed','exempt')),
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, ended_at),
    UNIQUE (station_id, pump_no, pts_transaction_no, ended_at)
) PARTITION BY RANGE (ended_at);
CREATE INDEX pump_tx_station_time_idx ON pump_transactions (station_id, ended_at DESC);
CREATE INDEX pump_tx_fiscal_pending_idx ON pump_transactions (fiscal_status) WHERE fiscal_status IN ('pending','failed');

-- Tank measurement on each detected product-height change (UploadTankMeasurement).
CREATE TABLE tank_measurements (
    station_id          UUID NOT NULL,
    tank_no             INTEGER NOT NULL,
    measured_at         TIMESTAMPTZ NOT NULL,
    product_code        TEXT,
    probe_status        TEXT,                      -- OK | Error | Offline
    alarms              TEXT[],                    -- CriticalHighProduct, HighProduct, LowProduct, CriticalLowProduct, HighWater
    product_height_mm   NUMERIC(10,2),
    water_height_mm     NUMERIC(10,2),
    temperature_c       NUMERIC(6,2),
    product_volume_l    NUMERIC(14,3),
    water_volume_l      NUMERIC(14,3),
    ullage_l            NUMERIC(14,3),
    tc_volume_l         NUMERIC(14,3),
    density_kg_m3       NUMERIC(8,2),
    mass_kg             NUMERIC(14,3),
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (station_id, tank_no, measured_at)
) PARTITION BY RANGE (measured_at);

-- Latest reading per tank (upserted by ingest; powers live dashboards & national stock).
CREATE TABLE tank_latest (
    station_id          UUID NOT NULL REFERENCES stations(id),
    tank_no             INTEGER NOT NULL,
    measured_at         TIMESTAMPTZ NOT NULL,
    product_code        TEXT,
    probe_status        TEXT,
    alarms              TEXT[],
    product_height_mm   NUMERIC(10,2),
    water_height_mm     NUMERIC(10,2),
    temperature_c       NUMERIC(6,2),
    product_volume_l    NUMERIC(14,3),
    water_volume_l      NUMERIC(14,3),
    ullage_l            NUMERIC(14,3),
    tc_volume_l         NUMERIC(14,3),
    PRIMARY KEY (station_id, tank_no)
);

-- In-tank deliveries detected by PTS-2 (UploadInTankDelivery).
CREATE TABLE tank_deliveries (
    id                    BIGSERIAL PRIMARY KEY,
    station_id            UUID NOT NULL REFERENCES stations(id),
    tank_no               INTEGER NOT NULL,
    product_code          TEXT,
    started_at            TIMESTAMPTZ NOT NULL,
    ended_at              TIMESTAMPTZ NOT NULL,
    start_volume_l        NUMERIC(14,3),
    end_volume_l          NUMERIC(14,3),
    start_tc_volume_l     NUMERIC(14,3),
    end_tc_volume_l       NUMERIC(14,3),
    start_height_mm       NUMERIC(10,2),
    end_height_mm         NUMERIC(10,2),
    start_water_mm        NUMERIC(10,2),
    end_water_mm          NUMERIC(10,2),
    start_temperature_c   NUMERIC(6,2),
    end_temperature_c     NUMERIC(6,2),
    start_density_kg_m3   NUMERIC(8,2),
    end_density_kg_m3     NUMERIC(8,2),
    received_volume_l     NUMERIC(14,3) GENERATED ALWAYS AS (end_volume_l - start_volume_l) STORED,
    -- Manual reconciliation with paperwork (entered by manager)
    delivery_note_no      TEXT,
    supplier              TEXT,
    invoiced_volume_l     NUMERIC(14,3),
    received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (station_id, tank_no, started_at)
);

CREATE TABLE alerts (
    id              BIGSERIAL PRIMARY KEY,
    station_id      UUID NOT NULL REFERENCES stations(id),
    occurred_at     TIMESTAMPTZ NOT NULL,
    device_type     TEXT NOT NULL,                 -- controller | pump | probe | tank | priceboard | reader | gateway | system
    device_no       INTEGER,
    code            TEXT NOT NULL,                 -- e.g. PumpOffline, ProbeError, TankLeakage, HighWater, PowerLoss, LowBattery, TotalizerMismatch, StockVariance
    severity        TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
    message         TEXT,
    data            JSONB,
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by UUID,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (station_id, occurred_at, device_type, device_no, code)
);
CREATE INDEX alerts_open_idx ON alerts (station_id, occurred_at DESC) WHERE acknowledged_at IS NULL;

-- ZRA Smart Invoice (VSDC) fiscal receipts — one per pump transaction.
CREATE TABLE fiscal_receipts (
    id                  BIGSERIAL PRIMARY KEY,
    station_id          UUID NOT NULL REFERENCES stations(id),
    pump_no             INTEGER NOT NULL,
    pts_transaction_no  INTEGER NOT NULL,
    tx_ended_at         TIMESTAMPTZ NOT NULL,
    invoice_no          TEXT NOT NULL,             -- our invoice number sent as cisInvcNo
    status              TEXT NOT NULL CHECK (status IN ('pending','signed','failed','printed')),
    fiscalised_by       TEXT NOT NULL DEFAULT 'edge' CHECK (fiscalised_by IN ('edge','cloud')),
    zra_rcpt_no         TEXT,
    zra_tot_rcpt_no     TEXT,
    zra_internal_data   TEXT,
    zra_signature       TEXT,
    zra_sdc_id          TEXT,
    zra_mrc_no          TEXT,
    zra_qr_url          TEXT,
    zra_signed_at       TIMESTAMPTZ,
    printed_at          TIMESTAMPTZ,
    attempts            INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT,
    request             JSONB,
    response            JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (station_id, pump_no, pts_transaction_no, tx_ended_at),
    UNIQUE (station_id, invoice_no)
);

-- Daily roll-up per station × product (feeds owner reports, ERB analytics & forecasting).
CREATE TABLE daily_station_product (
    station_id          UUID NOT NULL REFERENCES stations(id),
    business_date       DATE NOT NULL,
    product_code        TEXT NOT NULL REFERENCES products(code),
    province_id         SMALLINT NOT NULL,
    sales_volume_l      NUMERIC(16,3) NOT NULL DEFAULT 0,
    sales_amount        NUMERIC(18,2) NOT NULL DEFAULT 0,
    tx_count            INTEGER NOT NULL DEFAULT 0,
    opening_stock_l     NUMERIC(16,3),
    closing_stock_l     NUMERIC(16,3),
    deliveries_l        NUMERIC(16,3) NOT NULL DEFAULT 0,
    -- book stock variance: (opening + deliveries - sales) - closing ; positive = loss
    variance_l          NUMERIC(16,3),
    avg_price           NUMERIC(10,2),
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (station_id, business_date, product_code)
);
CREATE INDEX dsp_province_date_idx ON daily_station_product (province_id, business_date);

-- Generic durable job queue (workers use FOR UPDATE SKIP LOCKED). Used for
-- cloud fiscalisation fallback, webhooks, roll-ups, exports, notifications.
CREATE TABLE jobs (
    id              BIGSERIAL PRIMARY KEY,
    kind            TEXT NOT NULL,                 -- fiscalise | webhook | rollup | erb_export | notify
    payload         JSONB NOT NULL,
    dedupe_key      TEXT UNIQUE,
    status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','dead')),
    run_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 20,
    locked_by       TEXT,
    locked_at       TIMESTAMPTZ,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs (kind, run_at) WHERE status = 'queued';

-- ---------------------------------------------------------------------
-- Partition management
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ensure_partitions(months_back INT DEFAULT 1, months_ahead INT DEFAULT 3)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    t   TEXT;
    m   DATE;
    nm  TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['ingest_raw','pump_transactions','tank_measurements'] LOOP
        FOR i IN -months_back..months_ahead LOOP
            m  := (date_trunc('month', now()) + make_interval(months => i))::date;
            nm := format('%s_%s', t, to_char(m, 'YYYYMM'));
            IF to_regclass(format('fms.%I', nm)) IS NULL THEN
                EXECUTE format('CREATE TABLE fms.%I PARTITION OF fms.%I FOR VALUES FROM (%L) TO (%L)',
                               nm, t, m, (m + interval '1 month')::date);
            END IF;
        END LOOP;
        -- default partition catches late/early data (e.g. bad controller clocks)
        IF to_regclass(format('fms.%I', t || '_default')) IS NULL THEN
            EXECUTE format('CREATE TABLE fms.%I PARTITION OF fms.%I DEFAULT', t || '_default', t);
        END IF;
    END LOOP;
END $$;

SELECT ensure_partitions(12, 3);
