#!/bin/sh
# Start one FMS cloud role: FMS_SERVICE=core | ingest | worker.
set -eu

case "${FMS_SERVICE:-core}" in
  core)
    if [ "${RUN_MIGRATIONS:-true}" != "false" ]; then
      python manage.py fms_core_migrate
    fi
    exec gunicorn fms_cloud.wsgi -c gunicorn.conf.py
    ;;
  ingest)
    exec gunicorn fms_cloud.wsgi -c gunicorn.conf.py
    ;;
  worker)
    exec python manage.py fms_worker
    ;;
  *)
    echo "FMS_SERVICE must be core, ingest or worker" >&2
    exit 64
    ;;
esac
