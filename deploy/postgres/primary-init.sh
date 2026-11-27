#!/bin/sh
# Runs once, on first start of the primary (docker-entrypoint-initdb.d).
# Creates the streaming-replication role, a physical replication slot for the
# replica, and allows replication connections from the compose network.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${REPLICATION_USER}') THEN
      CREATE ROLE ${REPLICATION_USER} WITH REPLICATION LOGIN PASSWORD '${REPLICATION_PASSWORD}';
    END IF;
  END
  \$\$;
  SELECT pg_create_physical_replication_slot('replica1')
  WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'replica1');
EOSQL

echo "host replication ${REPLICATION_USER} 0.0.0.0/0 scram-sha-256" >> "$PGDATA/pg_hba.conf"
