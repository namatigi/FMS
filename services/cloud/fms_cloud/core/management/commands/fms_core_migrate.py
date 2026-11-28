"""Apply core-api's own SQL migrations (fms_cloud/core/sql), tracked in fms.core_api_migrations."""

from pathlib import Path

from django.core.management.base import BaseCommand

from fms_cloud.common.sqlmigrate import run_sql_migrations

SQL_DIR = Path(__file__).resolve().parents[2] / "sql"
LOCK = 727273  # same advisory lock as services/core-api/src/db.ts


class Command(BaseCommand):
    help = "Apply core-api SQL migrations (idempotent)."

    def handle(self, *args, **opts):
        applied = run_sql_migrations(SQL_DIR, "fms.core_api_migrations", LOCK, log=lambda m: self.stdout.write(m))
        self.stdout.write(f"core migrations: {len(applied)} applied")
