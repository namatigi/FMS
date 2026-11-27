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

exec postgres -c hot_standby=on -c hot_standby_feedback=on \
  -c max_standby_streaming_delay=30s -c shared_preload_libraries=pg_stat_statements
