-- =====================================================================
-- Edge gateway local store (schema "edge"), one database per station gateway.
-- Applied automatically on start (src/db.ts) under a Postgres advisory lock.
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS edge;
SET search_path = edge, public;

-- Key/value configuration: 'station' (code, name, address, tpin, bhf_id), 'fuel_grades_version' ...
CREATE TABLE config (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fuel grade -> ZRA item mapping (source: EDGE_CONFIG_FILE / cloud reload_config / set_prices).
CREATE TABLE fuel_grades (
    pts_grade_id        INTEGER PRIMARY KEY,
    name                TEXT NOT NULL,
    product_code        TEXT,
    zra_item_code       TEXT,
    zra_item_class_code TEXT,
    zra_item_name       TEXT,
    vat_category        TEXT NOT NULL DEFAULT 'A',
    vat_rate_pct        NUMERIC(5,2) NOT NULL DEFAULT 16,
    price               NUMERIC(10,2),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- PTS-2 controllers heard on the LAN (secrets are configured via env, not stored here).
CREATE TABLE controllers (
    pts_id          TEXT PRIMARY KEY,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ,
    last_status     JSONB,
    last_status_at  TIMESTAMPTZ,
    last_status_synced_at TIMESTAMPTZ,
    packets_ok      BIGINT NOT NULL DEFAULT 0,
    packets_error   BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE transactions (
    id                  BIGSERIAL PRIMARY KEY,
    pts_id              TEXT NOT NULL,
    pump_no             INTEGER NOT NULL,
    nozzle_no           INTEGER NOT NULL,
    pts_transaction_no  INTEGER NOT NULL,
    pts_grade_id        INTEGER,
    grade_name          TEXT,
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ NOT NULL,
    volume_l            NUMERIC(12,3) NOT NULL,
    tc_volume_l         NUMERIC(12,3),
    price               NUMERIC(10,3) NOT NULL,
    amount              NUMERIC(14,2) NOT NULL,
    total_volume_l      NUMERIC(16,3),
    total_amount        NUMERIC(18,2),
    tag                 TEXT,
    pts_user_id         INTEGER,
    fiscal_status       TEXT NOT NULL DEFAULT 'pending'
                        CHECK (fiscal_status IN ('pending','signed','printed','failed','exempt')),
    record              JSONB NOT NULL,          -- normalised PumpTransactionRecord
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (pts_id, pump_no, pts_transaction_no, ended_at)
);
CREATE INDEX transactions_ended_idx ON transactions (ended_at DESC);
CREATE INDEX transactions_pump_nozzle_idx ON transactions (pts_id, pump_no, nozzle_no, ended_at DESC);

CREATE TABLE tank_measurements (
    id                  BIGSERIAL PRIMARY KEY,
    pts_id              TEXT NOT NULL,
    tank_no             INTEGER NOT NULL,
    measured_at         TIMESTAMPTZ NOT NULL,
    pts_grade_id        INTEGER,
    probe_status        TEXT,
    alarms              TEXT[] NOT NULL DEFAULT '{}',
    product_height_mm   NUMERIC(10,1),
    water_height_mm     NUMERIC(10,1),
    temperature_c       NUMERIC(6,2),
    product_volume_l    NUMERIC(12,2),
    water_volume_l      NUMERIC(12,2),
    ullage_l            NUMERIC(12,2),
    tc_volume_l         NUMERIC(12,2),
    density_kg_m3       NUMERIC(8,2),
    mass_kg             NUMERIC(14,2),
    record              JSONB NOT NULL,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (pts_id, tank_no, measured_at)
);

CREATE TABLE tank_latest (
    pts_id              TEXT NOT NULL,
    tank_no             INTEGER NOT NULL,
    measured_at         TIMESTAMPTZ NOT NULL,
    pts_grade_id        INTEGER,
    probe_status        TEXT,
    alarms              TEXT[] NOT NULL DEFAULT '{}',
    product_height_mm   NUMERIC(10,1),
    water_height_mm     NUMERIC(10,1),
    temperature_c       NUMERIC(6,2),
    product_volume_l    NUMERIC(12,2),
    ullage_l            NUMERIC(12,2),
    PRIMARY KEY (pts_id, tank_no)
);

CREATE TABLE deliveries (
    id                  BIGSERIAL PRIMARY KEY,
    pts_id              TEXT NOT NULL,
    tank_no             INTEGER NOT NULL,
    started_at          TIMESTAMPTZ NOT NULL,
    ended_at            TIMESTAMPTZ NOT NULL,
    start_volume_l      NUMERIC(12,2),
    end_volume_l        NUMERIC(12,2),
    record              JSONB NOT NULL,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (pts_id, tank_no, started_at)
);

CREATE TABLE alerts (
    id              BIGSERIAL PRIMARY KEY,
    pts_id          TEXT,
    occurred_at     TIMESTAMPTZ NOT NULL,
    device_type     TEXT NOT NULL,
    device_no       INTEGER,
    code            TEXT NOT NULL,
    severity        TEXT NOT NULL,
    message         TEXT,
    source          TEXT NOT NULL DEFAULT 'pts',   -- pts | tank_alarm | gateway
    record          JSONB NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX alerts_natural_uq ON alerts (COALESCE(pts_id, ''), occurred_at, device_type, COALESCE(device_no, -1), code);
CREATE INDEX alerts_occurred_idx ON alerts (occurred_at DESC);

-- One fiscal receipt per (non-zero) pump transaction. State machine:
--   pending --signSale ok--> signed --print ok--> printed
--   pending --non-retryable--> failed     (refiscalise command / UI resets to pending)
CREATE TABLE fiscal_receipts (
    id                  BIGSERIAL PRIMARY KEY,
    transaction_id      BIGINT NOT NULL UNIQUE REFERENCES transactions(id),
    invoice_no          TEXT NOT NULL UNIQUE,
    status              TEXT NOT NULL CHECK (status IN ('pending','signed','printed','failed')),
    attempts            INTEGER NOT NULL DEFAULT 0,
    print_attempts      INTEGER NOT NULL DEFAULT 0,
    reprint_count       INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until         TIMESTAMPTZ,
    last_error          TEXT,
    last_error_code     TEXT,
    zra_rcpt_no         TEXT,
    zra_tot_rcpt_no     TEXT,
    zra_internal_data   TEXT,
    zra_signature       TEXT,
    zra_sdc_id          TEXT,
    zra_mrc_no          TEXT,
    zra_qr_url          TEXT,
    zra_signed_at       TIMESTAMPTZ,
    printed_at          TIMESTAMPTZ,
    request             JSONB,
    response            JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fiscal_receipts_due_idx ON fiscal_receipts (next_attempt_at) WHERE status IN ('pending','signed');

-- Durable outbox to the cloud. data = TelemetryRecord ({kind, data}). At-least-once delivery.
CREATE TABLE outbox (
    seq         BIGSERIAL PRIMARY KEY,
    kind        TEXT NOT NULL,
    data        JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at     TIMESTAMPTZ,
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    parked_at   TIMESTAMPTZ                -- rejected non-retryable by the cloud; needs operator attention
);
CREATE INDEX outbox_unsent_idx ON outbox (seq) WHERE sent_at IS NULL AND parked_at IS NULL;
CREATE INDEX outbox_sent_idx ON outbox (sent_at) WHERE sent_at IS NOT NULL;

-- Cloud commands, idempotent by command id.
CREATE TABLE commands_applied (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    payload     JSONB NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('applied','failed','scheduled','partial')),
    result      JSONB,
    due_at      TIMESTAMPTZ,
    attempts    INTEGER NOT NULL DEFAULT 0,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at  TIMESTAMPTZ
);
