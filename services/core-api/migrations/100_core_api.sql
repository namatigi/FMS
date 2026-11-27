-- =====================================================================
-- core-api owned schema additions (applied by core-api at startup under
-- pg_advisory_lock; tracked in fms.core_api_migrations).
-- Additive only: does not alter tables owned by db/migrations.
-- =====================================================================
SET search_path = fms, public;

-- Opaque refresh tokens (stored as sha256 hex). Rotation: each refresh
-- revokes the presented token and issues a new one in the same family.
-- Re-use of a revoked token revokes the whole family (token theft).
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family_id     UUID NOT NULL,
    token_hash    TEXT NOT NULL UNIQUE,
    issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    revoked_at    TIMESTAMPTZ,
    replaced_by   UUID,
    user_agent    TEXT,
    ip            TEXT
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx   ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens (family_id);

-- Login attempts for lockout (5 failures per email within 15 minutes).
CREATE TABLE IF NOT EXISTS login_attempts (
    id            BIGSERIAL PRIMARY KEY,
    email         CITEXT NOT NULL,
    ip            TEXT,
    success       BOOLEAN NOT NULL,
    reason        TEXT,
    attempted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_email_time_idx ON login_attempts (email, attempted_at DESC);

-- Pending TOTP enrolments (secret moves to users.mfa_secret on confirm).
CREATE TABLE IF NOT EXISTS mfa_enrolments (
    user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret        TEXT NOT NULL,                 -- base32
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Read-path indexes used by core-api.
CREATE INDEX IF NOT EXISTS pump_tx_station_keyset_idx    ON pump_transactions (station_id, ended_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS pump_tx_received_idx          ON pump_transactions (received_at);
CREATE INDEX IF NOT EXISTS alerts_time_idx               ON alerts (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS alerts_received_idx           ON alerts (received_at);
CREATE INDEX IF NOT EXISTS fiscal_receipts_station_time_idx ON fiscal_receipts (station_id, tx_ended_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS fiscal_receipts_status_idx    ON fiscal_receipts (status) WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS tank_deliveries_station_time_idx ON tank_deliveries (station_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS price_changes_cap_idx         ON price_changes (kind, product_code, province_id, effective_at DESC);
CREATE INDEX IF NOT EXISTS dsp_date_idx                  ON daily_station_product (business_date);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx           ON audit_log (actor_type, actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS users_company_idx             ON users (company_id);
CREATE INDEX IF NOT EXISTS user_station_access_station_idx ON user_station_access (station_id);
