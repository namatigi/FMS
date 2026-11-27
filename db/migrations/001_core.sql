-- =====================================================================
-- FMS central database — core schema (PostgreSQL 16)
-- Owned by: platform team. All cloud services share this schema.
-- Conventions:
--   * Volumes in litres, NUMERIC(14,3). Money in ZMW, NUMERIC(14,2).
--   * All timestamps are TIMESTAMPTZ. Station-local times from PTS-2 are
--     converted using stations.timezone (default Africa/Lusaka, UTC+2).
--   * High-volume telemetry tables are range-partitioned by month.
--   * Idempotency: every telemetry table has a natural unique key so that
--     retried uploads (PTS-2 / edge gateway store-and-forward) are no-ops.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS fms;
SET search_path = fms, public;

-- ---------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------
CREATE TABLE provinces (
    id          SMALLINT PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL UNIQUE
);

INSERT INTO provinces (id, code, name) VALUES
    (1,  'CEN', 'Central'),
    (2,  'COP', 'Copperbelt'),
    (3,  'EAS', 'Eastern'),
    (4,  'LUA', 'Luapula'),
    (5,  'LUS', 'Lusaka'),
    (6,  'MUC', 'Muchinga'),
    (7,  'NOR', 'Northern'),
    (8,  'NWE', 'North-Western'),
    (9,  'SOU', 'Southern'),
    (10, 'WES', 'Western');

-- National product catalogue (ERB product classes).
CREATE TABLE products (
    code              TEXT PRIMARY KEY,            -- PETROL, DIESEL, KEROSENE, JETA1, LPG
    name              TEXT NOT NULL,
    zra_item_class_cd TEXT,                        -- ZRA Smart Invoice item classification
    zra_vat_cat_cd    TEXT NOT NULL DEFAULT 'A',   -- ZRA VAT category code (configure per ZRA rules)
    density_ref_kg_l  NUMERIC(6,4)
);

INSERT INTO products (code, name, density_ref_kg_l) VALUES
    ('PETROL',   'Unleaded Petrol (ULP)',   0.7400),
    ('DIESEL',   'Low Sulphur Gasoil (LSD)', 0.8400),
    ('KEROSENE', 'Kerosene',                0.8000),
    ('JETA1',    'Jet A-1',                 0.8000),
    ('LPG',      'Liquefied Petroleum Gas', 0.5400);

-- ---------------------------------------------------------------------
-- Organisations & sites
-- ---------------------------------------------------------------------
CREATE TABLE companies (                          -- Oil Marketing Companies / station owners
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    zra_tpin        TEXT UNIQUE,                   -- ZRA Taxpayer Identification Number
    erb_licence_no  TEXT,
    contact_email   CITEXT,
    contact_phone   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id),
    code            TEXT NOT NULL UNIQUE,          -- human code, e.g. LUS-0001
    name            TEXT NOT NULL,
    province_id     SMALLINT NOT NULL REFERENCES provinces(id),
    district        TEXT,
    town            TEXT,
    address         TEXT,
    latitude        NUMERIC(9,6),
    longitude       NUMERIC(9,6),
    timezone        TEXT NOT NULL DEFAULT 'Africa/Lusaka',
    erb_licence_no  TEXT,
    zra_branch_id   TEXT NOT NULL DEFAULT '000',   -- ZRA "bhfId"
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed','commissioning')),
    connection_mode TEXT NOT NULL DEFAULT 'edge'   CHECK (connection_mode IN ('edge','direct')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stations_province_idx ON stations(province_id);
CREATE INDEX stations_company_idx  ON stations(company_id);

-- PTS-2 forecourt controllers (one or more per station).
CREATE TABLE controllers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id      UUID NOT NULL REFERENCES stations(id),
    pts_id          TEXT NOT NULL UNIQUE,          -- 24-hex unique board id, e.g. 003B00265030500420303531
    hmac_secret     TEXT,                          -- "Secret key" configured in PTS-2 REMOTE SERVER SETTINGS (encrypt at rest in prod)
    firmware        TEXT,
    last_seen_at    TIMESTAMPTZ,
    last_status     JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Station edge gateways (industrial PC / mini-server at the station).
CREATE TABLE edge_gateways (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id      UUID NOT NULL REFERENCES stations(id),
    gateway_code    TEXT NOT NULL UNIQUE,
    api_key_hash    TEXT NOT NULL,                 -- sha256 hex of the gateway API key
    role            TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary','standby')),
    version         TEXT,
    last_seen_at    TIMESTAMPTZ,
    last_backlog    INTEGER,                       -- unsent records reported in last heartbeat
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tanks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id      UUID NOT NULL REFERENCES stations(id),
    tank_no         INTEGER NOT NULL,              -- PTS-2 tank number (1..50)
    product_code    TEXT NOT NULL REFERENCES products(code),
    capacity_l      NUMERIC(14,3) NOT NULL,
    low_level_l     NUMERIC(14,3),                 -- reorder threshold
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (station_id, tank_no)
);

CREATE TABLE fuel_grades (                         -- station-level fuel grade as configured in PTS-2
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id      UUID NOT NULL REFERENCES stations(id),
    pts_grade_id    INTEGER NOT NULL,              -- PTS-2 FuelGradeId
    name            TEXT NOT NULL,
    product_code    TEXT NOT NULL REFERENCES products(code),
    zra_item_code   TEXT,                          -- item code registered with ZRA (saveItem)
    price           NUMERIC(10,2) NOT NULL,        -- current pump price ZMW/L
    UNIQUE (station_id, pts_grade_id)
);

CREATE TABLE nozzles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id      UUID NOT NULL REFERENCES stations(id),
    pump_no         INTEGER NOT NULL,
    nozzle_no       INTEGER NOT NULL,
    fuel_grade_id   UUID REFERENCES fuel_grades(id),
    tank_id         UUID REFERENCES tanks(id),
    UNIQUE (station_id, pump_no, nozzle_no)
);

-- Price history: ERB cap prices (station_id NULL, per province or national) and station prices.
CREATE TABLE price_changes (
    id              BIGSERIAL PRIMARY KEY,
    product_code    TEXT NOT NULL REFERENCES products(code),
    station_id      UUID REFERENCES stations(id),
    province_id     SMALLINT REFERENCES provinces(id),
    price           NUMERIC(10,2) NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('erb_cap','station')),
    effective_at    TIMESTAMPTZ NOT NULL,
    created_by      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX price_changes_lookup_idx ON price_changes(product_code, effective_at DESC);

-- ---------------------------------------------------------------------
-- Identity & access
-- ---------------------------------------------------------------------
-- Roles:
--   platform_admin  – operator of the FMS
--   owner           – company owner; sees all company stations
--   manager         – station manager; sees stations in user_station_access
--   erb_national    – Energy Regulation Board, all provinces
--   erb_provincial  – ERB, one province (users.province_id)
--   zra_auditor     – ZRA read-only access to fiscal data
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           CITEXT NOT NULL UNIQUE,
    full_name       TEXT NOT NULL,
    phone           TEXT,
    password_hash   TEXT NOT NULL,                 -- scrypt/argon2 encoded string
    role            TEXT NOT NULL CHECK (role IN ('platform_admin','owner','manager','erb_national','erb_provincial','zra_auditor')),
    company_id      UUID REFERENCES companies(id),
    province_id     SMALLINT REFERENCES provinces(id),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    mfa_secret      TEXT,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_station_access (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    station_id      UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, station_id)
);

-- Machine clients of the partner API (other authorities, OMC ERPs, banks, insurers…).
CREATE TABLE api_clients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    organisation    TEXT NOT NULL,
    key_prefix      TEXT NOT NULL UNIQUE,          -- first 8 chars, shown in UI
    key_hash        TEXT NOT NULL,                 -- sha256 hex of full key
    scopes          TEXT[] NOT NULL,               -- e.g. {stations:read,sales:read,stock:read,prices:read}
    province_id     SMALLINT REFERENCES provinces(id), -- NULL = national
    company_id      UUID REFERENCES companies(id),     -- NULL = not company-scoped
    rate_limit_rpm  INTEGER NOT NULL DEFAULT 600,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Outbound webhooks (push model for ERB / other authorities).
CREATE TABLE webhook_subscriptions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_client_id   UUID NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
    url             TEXT NOT NULL,
    events          TEXT[] NOT NULL,               -- e.g. {daily_summary,critical_alert,stock_low}
    secret          TEXT NOT NULL,                 -- HMAC-SHA256 signing secret
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_type      TEXT NOT NULL,                 -- user | api_client | system | gateway
    actor_id        TEXT,
    action          TEXT NOT NULL,
    entity          TEXT,
    entity_id       TEXT,
    details         JSONB
);
CREATE INDEX audit_log_time_idx ON audit_log(occurred_at DESC);
