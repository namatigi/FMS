#!/bin/sh
# Hot-standby replica for the local HA demo. On first start it clones the
# primary with pg_basebackup (-R writes primary_conninfo + standby.signal) and
# then runs as a streaming replica using slot "replica1".
set -eu

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
PRIMARY_HOST="${PRIMARY_HOST:-pg-primary}"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "replica: waiting for primary ${PRIMARY_HOST}..."
  until pg_isready -h "$PRIMARY_HOST" -p 5432 -q; do sleep 1; done
  rm -rf "${PGDATA:?}"/* 2>/dev/null || true
  export PGPASSWORD="$REPLICATION_PASSWORD"
  # The slot is created by primary-init.sh; retry until it exists.
  until pg_basebackup -h "$PRIMARY_HOST" -U "$REPLICATION_USER" -D "$PGDATA" \
        -X stream -R -S replica1 -P; do
    echo "replica: pg_basebackup failed, retrying in 3s"
    rm -rf "${PGDATA:?}"/* 2>/dev/null || true
    sleep 3
  done
  chmod 0700 "$PGDATA"
fi

# A hot standby must allow at least as many connections (and WAL senders /
# replication slots) as the primary, or recovery aborts at start-up. Keep these
# in step with the pg-primary command in docker-compose.yml.
exec postgres -c hot_standby=on -c hot_standby_feedback=on \
  -c max_standby_streaming_delay=30s -c shared_preload_libraries=pg_stat_statements \
  -c max_connections="${PG_MAX_CONNECTIONS:-300}" \
  -c max_wal_senders=10 -c max_replication_slots=10
