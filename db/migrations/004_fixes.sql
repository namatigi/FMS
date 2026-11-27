-- =====================================================================
-- 004: fixes raised during integration review
--  * functions callable without search_path=fms
--  * alerts dedupe with NULL device_no
--  * indexes for totaliser continuity checks and edge command lookup
-- =====================================================================
SET search_path = fms, public;

ALTER FUNCTION fms.rollup_station_day(UUID, DATE) SET search_path = fms, public;
ALTER FUNCTION fms.ensure_partitions(INT, INT)    SET search_path = fms, public;

-- NULL device_no must not defeat the dedupe key (PostgreSQL 15+).
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_station_id_occurred_at_device_type_device_no_code_key;
DELETE FROM alerts a USING alerts b
 WHERE a.id > b.id AND a.station_id = b.station_id AND a.occurred_at = b.occurred_at
   AND a.device_type = b.device_type AND a.device_no IS NOT DISTINCT FROM b.device_no AND a.code = b.code;
ALTER TABLE alerts ADD CONSTRAINT alerts_dedupe_key
    UNIQUE NULLS NOT DISTINCT (station_id, occurred_at, device_type, device_no, code);

CREATE INDEX IF NOT EXISTS pump_tx_totaliser_idx
    ON pump_transactions (station_id, pump_no, nozzle_no, ended_at DESC);

CREATE INDEX IF NOT EXISTS jobs_edge_command_idx
    ON jobs ((payload->>'station_id')) WHERE kind = 'edge_command' AND status = 'queued';
