-- =====================================================================
-- 005: cloud → station commands with acknowledgement.
--
-- Lifecycle (status only moves forward, see fms.edge_command_rank):
--   queued ──(returned in an EdgeBatchResponse)──► delivered
--   delivered ──(gateway outbox ack 'received')──► received
--   received ──(gateway outbox ack)──► applied | partial | failed
--   queued/delivered past expires_at ──(fiscal-worker sweep)──► expired
-- A 'delivered' command without a 'received' ack is redelivered after the
-- ingest-api COMMAND_REDELIVER_S timeout (lost HTTP response, gateway crash).
-- The gateway applies commands idempotently by id, so redelivery is safe.
-- Acks travel through the gateway's durable outbox, so they survive outages.
-- =====================================================================
SET search_path = fms, public;

CREATE TABLE edge_commands (
    id                  TEXT PRIMARY KEY,               -- EdgeCommand.id (uuid from core-api)
    station_id          UUID NOT NULL REFERENCES stations(id),
    type                TEXT NOT NULL CHECK (type IN ('set_prices','refiscalise','reload_config')),
    command             JSONB NOT NULL,                 -- full EdgeCommand exactly as delivered
    status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','delivered','received','applied','partial','failed','expired','cancelled')),
    created_by          UUID,                           -- users.id
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    not_before          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
    delivery_count      INTEGER NOT NULL DEFAULT 0,
    first_delivered_at  TIMESTAMPTZ,
    last_delivered_at   TIMESTAMPTZ,
    delivered_via       TEXT,                           -- edge_gateways.gateway_code
    received_at         TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    result              JSONB,                          -- gateway-reported outcome detail
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX edge_commands_pending_idx ON edge_commands (station_id, created_at) WHERE status IN ('queued','delivered');
CREATE INDEX edge_commands_station_idx ON edge_commands (station_id, created_at DESC);

-- Forward-only ordering of statuses (terminal acks may still land on an expired command).
CREATE OR REPLACE FUNCTION edge_command_rank(s TEXT) RETURNS INT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE s
        WHEN 'queued'    THEN 0
        WHEN 'delivered' THEN 1
        WHEN 'expired'   THEN 2
        WHEN 'received'  THEN 3
        WHEN 'applied'   THEN 4
        WHEN 'partial'   THEN 4
        WHEN 'failed'    THEN 4
        WHEN 'cancelled' THEN 5
        ELSE 0 END
$$;

-- Carry over commands that were still waiting in the old jobs-based queue.
INSERT INTO edge_commands (id, station_id, type, command, created_at)
SELECT payload->'command'->>'id', (payload->>'station_id')::uuid, payload->'command'->>'type', payload->'command', created_at
  FROM jobs
 WHERE kind = 'edge_command' AND status = 'queued'
   AND payload->'command'->>'id' IS NOT NULL
   AND payload->'command'->>'type' IN ('set_prices','refiscalise','reload_config')
ON CONFLICT (id) DO NOTHING;

UPDATE jobs SET status = 'done', last_error = 'migrated to fms.edge_commands'
 WHERE kind = 'edge_command' AND status = 'queued';

DROP INDEX IF EXISTS jobs_edge_command_idx;
