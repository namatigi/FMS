# core-api

Fastify + TypeScript service for the National Fuel Monitoring System. It handles
auth (JWT + rotating refresh tokens + optional TOTP), the owner/manager API, the
ERB regulator API, admin CRUD, the partner API (X-API-Key) and an SSE live stream.
The spec it implements is `docs/api/CONTRACTS.md`.

## Run

```bash
cd services/core-api
npm install
cp .env.example .env        # then set DATABASE_URL / JWT_SECRET
npm run dev                 # tsx watch, or: npm run build && npm start
```

On startup the service applies `migrations/*.sql`, serialised by
`pg_advisory_lock(727273)` and tracked in `fms.core_api_migrations`. The base
schema must already exist (`node db/migrate.mjs` from the repo root).

| Path | What |
|---|---|
| `/api/v1/*` | user API (Bearer JWT) |
| `/api/partner/v1/*` | partner API (`X-API-Key`) |
| `/api/docs` | Swagger UI; `/api/docs/json` is the OpenAPI 3 document |
| `/healthz`, `/readyz`, `/metrics` | liveness, DB readiness, Prometheus metrics |

`npm run openapi` writes `openapi.json` without needing a database.

## Environment

See `.env.example`. The main variables are `DATABASE_URL`, `DATABASE_URL_RO`
(read replica for dashboards, regulator, partner and SSE reads; falls back to
the primary), `JWT_SECRET`, `PORT`, `LOG_LEVEL`, `CORS_ORIGINS`,
`RATE_LIMIT_RPM`, `LOGIN_RATE_LIMIT_RPM`, `STREAM_POLL_MS` and `RUN_MIGRATIONS`.

## Design notes

- **Scoping.** `src/lib/scope.ts` `stationScope()` is the single function that
  produces the SQL predicate for the caller:
  - `platform_admin`, `erb_national` and `zra_auditor` see all stations.
  - `owner` sees stations of its company.
  - `manager` sees stations listed in `user_station_access`.
  - `erb_provincial` sees stations in its province.
  - API clients are limited by their province and company.

  A station id outside the caller's scope returns 404. Regulator endpoints force
  `erb_provincial` to its own province, whatever `province_id` it asks for.
- **Auth.**
  - Passwords are checked with scrypt (`scrypt$N$r$p$salt$key`) using a
    constant-time compare. Unknown emails are checked against a dummy hash.
  - Lockout: after 5 failed attempts within 15 minutes, login returns
    `429 account_locked`.
  - Refresh tokens are opaque and stored as sha256 hashes. Each refresh rotates
    the token. Reusing an old token revokes the whole token family.
- **MFA (TOTP, RFC 6238).** Available to `platform_admin` and the `erb_*` roles.
  - Enrol with `POST /auth/mfa/enroll`, which returns `{secret, otpauth_url}`.
  - Confirm with `POST /auth/mfa/verify {code}`.
  - Disable with `POST /auth/mfa/disable {code}`.
  - Once MFA is enabled, `POST /auth/login` also needs `totp_code`. Without it,
    login returns `401 mfa_required`.
- **Prices.** `PUT /stations/:id/prices` checks each price against the ERB cap in
  force; a province-specific cap overrides the national one. In one transaction
  it then:
  - inserts `price_changes` with `kind='station'`
  - updates `fuel_grades.price`
  - inserts an `fms.edge_commands` row (`set_prices`, status `queued`)
  - writes an audit row

  The response carries `command_id` and `command_status`. Follow delivery and
  station acknowledgement with `GET /stations/:id/commands?status=`: `queued` →
  `delivered` → `received` → `applied` | `partial` | `failed`, or `expired`.
- **Days of cover** is stock divided by average daily sales. The average comes
  from the last 7 complete days in `daily_station_product`. If there are no
  roll-ups, it falls back to `pump_transactions` over the last 7×24 h divided
  by 7. For each tank, the product average is split across tanks by capacity
  share.
- **SSE** (`GET /api/v1/stream?station_id=&token=`) polls the read pool every
  `STREAM_POLL_MS`, with a 15 s overlap window and de-duplication. It installs
  no triggers on tables other services own. Events:
  - `ready`
  - `tank_latest {items}`, which is also sent as a snapshot on connect
  - `sales {items}`
  - `alert {items}`
  - a `: keepalive` comment on every poll
- **Audit.** These all write `fms.audit_log` rows:
  - logins: success, failure, lockout, refresh reuse, logout
  - every write: deliveries, alert acks, prices, ERB caps, admin CRUD and key rotations
  - exports
- **Rate limits.**
  - Per IP on `/api/v1` (`RATE_LIMIT_RPM`), and tighter on login and refresh.
  - Per partner client, using `api_clients.rate_limit_rpm`.
  - The limit store is in memory, per instance. Behind N replicas the effective
    limit is N×. Use a Redis store for a strict global limit.

## Schema additions (`migrations/100_core_api.sql`)

- `fms.refresh_tokens`, `fms.login_attempts`, `fms.mfa_enrolments`
- Read-path indexes on `pump_transactions`, `alerts`, `fiscal_receipts`,
  `tank_deliveries`, `price_changes`, `daily_station_product`, `audit_log`,
  `users` and `user_station_access`

## Tests

The tests need the test Postgres described in the repo, with database
`fms_core` migrated and seeded:

```bash
npm test                      # node:test via tsx, using fastify.inject
TEST_DATABASE_URL=postgres://... npm test
BASE_URL=http://localhost:18080 npm run smoke   # smoke-test a running server
```

## Docker

```bash
docker build -f services/core-api/Dockerfile -t fms/core-api .   # from repo root
```
