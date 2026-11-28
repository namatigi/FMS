# FMS cloud services on Django (`services/cloud`)

The three cloud services, in Python on Django. They replaced the original TypeScript services, which were
removed from the repo (they remain in git history):

| Role (`FMS_SERVICE`) | Replaced | What it serves |
|---|---|---|
| `core` | `services/core-api` | `/api/v1/...` (owner, manager, ERB, ZRA, admin), `/api/partner/v1/...`, `/api/docs` |
| `ingest` | `services/ingest-api` | `/ingest/pts` (PTS-2 jsonPTS uploads), `/ingest/v1/edge/...` (edge gateway batches) |
| `worker` | `services/fiscal-worker` | `manage.py fms_worker`: job queue (fiscalise, rollup, webhook, notify, erb_export) and scheduler |

All three keep the **same API contracts, database, environment variables and ports** as the TypeScript
services did (`docs/api/CONTRACTS.md`; the generated OpenAPI document is served at `/api/openapi.json`).
The web app, mobile app, edge gateways and analytics service talk to them unchanged.

## Stack

- Django 5.1 with **Django Ninja** for the HTTP API: routers, pydantic request validation and the
  generated OpenAPI/Swagger at `/api/docs`.
- PostgreSQL through Django's psycopg 3 backend. The `fms` schema is owned by `db/migrations` (plain SQL).
  There are **no Django models or Django migrations** for it; services query it with SQL.
- gunicorn (`gthread`) in containers, `prometheus-client` for `/metrics`, `httpx` for outbound HTTP.

## Layout

```
fms_cloud/
  settings.py            FMS_SERVICE picks the URL conf; DATABASE_URL / DATABASE_URL_RO
  common/                shared by all roles
    db.py                primary / ro() / tx(): raw SQL with node-style $1 placeholders
    jsonutil.py          json_response(), iso(): JavaScript-compatible JSON
    errors.py            HttpError + helpers -> {"error": {"code", "message"}}
    crypto.py            scrypt passwords, HS256 JWT, TOTP, API keys, HMAC / webhook signatures
    sqlutil.py           Params, cursors, is_uuid, round_, days_of_cover, Lusaka-day SQL fragments
    middleware.py        request id, security headers, CORS, metrics, JSON errors
    ratelimit.py         FixedWindow / TokenBucket (in-process)
    health.py            /healthz /readyz /metrics
    sqlmigrate.py        apply a directory of .sql files once (advisory lock)
  core/                  core API: api.py (NinjaAPI), routes/*.py, scope.py, auth.py, audit.py, sql/
  ingest/                ingest API: urls.py + modules
  fiscal/                worker: management/commands/fms_worker.py + modules, zra/ (VSDC client)
tests/                   pytest against a real PostgreSQL (see tests/conftest.py)
```

## Porting conventions

These keep the Django services interchangeable with the TypeScript ones.

1. **Same contract.** Same paths, methods, status codes, JSON field names, error codes and messages,
   pagination cursors, headers. When the TypeScript code and `docs/api/CONTRACTS.md` disagree, the code wins.
2. **SQL is copied, not rewritten.** `common/db.py` accepts node-postgres SQL as is: `$1`, `$2` placeholders
   (a value can be reused), literal `%` is fine. `db.query()` returns a list of dicts, `one()`, `scalar()`,
   `execute()` (rowcount). NUMERIC comes back as int/float, DATE as `'YYYY-MM-DD'`, json/jsonb parsed,
   uuid as str, TIMESTAMPTZ as aware datetime. Use `with tx() as c:` for BEGIN/COMMIT, and `ro()` wherever
   the TypeScript used `db.ro`.
3. **JSON output.** Return dicts/lists from Ninja views, or `json_response()`. Datetimes render like
   `Date.toISOString()` (`2026-11-27T08:15:30.123Z`). Where TypeScript called `toIso()` or returned a `Date`,
   just return the datetime.
4. **Validation.** Port zod schemas to pydantic models (`ninja.Schema`), with the same limits, defaults,
   enums and coercion. Invalid input -> 400 `validation_error`. Ninja `ValidationError` is already mapped
   in `core/api.py`; outside Ninja, raise `HttpError(400, 'validation_error', ...)`.
5. **Auth.** Core routes call `require_user(request, roles)` first, just as the Fastify `preHandler` did.
   Scoping always goes through `core/scope.py` (`station_scope`, `station_id_scope`, `assert_station_in_scope`,
   `regulator_province`). An out-of-scope station is 404, never 403.
6. **Errors.** Raise `fms_cloud.common.errors.HttpError` (or `not_found()`, `forbidden()` ...). Postgres
   constraint errors are mapped like core-api did (23505 -> 409 conflict, ...).
7. **Config** reads the same environment variables with the same defaults.
8. **Tests.** Port the TypeScript tests for each area to pytest under `tests/<area>/` and keep their
   assertions. Run them with `TEST_DB_NAME=<your own name> .venv/Scripts/python -m pytest tests/<area>`.

## Running locally

```powershell
py -3.12 -m venv .venv; .venv\Scripts\pip install -r requirements-dev.txt
$env:DATABASE_URL="postgres://fms:fms-dev-password@localhost:15432/fms"; $env:FMS_SERVICE="core"
.venv\Scripts\python manage.py fms_core_migrate
.venv\Scripts\python manage.py runserver 8080 --noreload
```

Tests need a PostgreSQL 16 superuser URL (default: the compose `pg-primary` on port 15432):

```powershell
.venv\Scripts\python -m pytest
```

In Docker the image is `services/cloud/Dockerfile`. `deploy/docker-compose.yml` runs it three times as
`core-api`, `ingest-api` and `fiscal-worker`, and the Kubernetes manifests do the same with `FMS_SERVICE`.
