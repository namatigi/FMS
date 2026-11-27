# @fms/fiscal-worker

A job worker over `fms.jobs` that can run as many replicas as needed. It handles cloud ZRA fiscalisation, signed webhooks, daily roll-ups, ERB exports and alert notifications, and runs a leader-elected scheduler.

## How it works

- **Claiming jobs.** A worker claims jobs with `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n) RETURNING *`. The claim sets `status='running'`, `locked_by` and `locked_at`, and adds one to `attempts`.
- **Leases.** Every replica re-queues `running` jobs whose `locked_at` is older than `JOB_LEASE_TIMEOUT_MINUTES`. If such a job has already used all its attempts, it is dead-lettered instead.
- **Retries.** A failed job goes back to `queued`, with `run_at = now() + backoff`. The backoff is `base·2^(attempt-1)` with equal jitter, capped at `JOB_BACKOFF_MAX_MS`.
- **Dead letters.** These errors set a job to `status='dead'`, write an error log line (`job dead-lettered`) and call the handler's `onDead` hook:
  - a non-retryable error (`retryable === false`, such as a ZRA validation rejection or a bad payload)
  - reaching `max_attempts`

  A `fiscalise` job that dies marks the receipt and the transaction `failed`.

| kind | payload | what it does |
|---|---|---|
| `fiscalise` | `{station_id, pump_no, pts_transaction_no, ended_at}` | It loads the transaction, the station's TPIN and branch, and the grade's ZRA item code. It builds the invoice number `<code>-P<pump>-<txno>-<yyyyMMddHHmmss Lusaka>` and upserts `fiscal_receipts` (`fiscalised_by='cloud'`; an existing row keeps its invoice_no). It then calls `ZraVsdcClient.signSale` and stores the signature, which sets `pump_transactions.fiscal_status='signed'`. It skips the sale if the receipt is already signed or printed. |
| `rollup` | `{station_id, business_date}` | `SELECT fms.rollup_station_day($1,$2)` |
| `webhook` | `{event, data, subscription_id?}` | Without `subscription_id`, it creates one child job per active, in-scope subscription. Scope covers the province and company, resolved from `data.province_id` or `data.station_id`. With `subscription_id`, it sends a `POST` with `X-FMS-Signature` from `signWebhook`, plus `X-FMS-Event` and `X-FMS-Delivery`. Any response other than 2xx is retried. |
| `notify` | `{station_id, alert}` | Sends the alert through every configured notifier to the company contact, the owners and the station managers. The log channel is always on. SMTP and FCM are stubs. SMS posts JSON to `SMS_GATEWAY_URL`. |
| `erb_export` | `{date, province_id\|null}` | Writes a CSV and a JSON file per station-product row of `daily_station_product` to `EXPORT_DIR/erb/daily/<date>/<PROV|NATIONAL>.*`. It waits while rollups for that date are pending, then enqueues the `webhook` `daily_summary` job. |

**Scheduler.** Only the replica holding `pg_try_advisory_lock(SCHEDULER_LOCK_KEY)` on its dedicated connection acts as scheduler. It runs these tasks:
- **Hourly:** `fms.ensure_partitions(1,3)`, and a prune of `done` jobs older than 14 days.
- **Daily at 00:15 Africa/Lusaka:** for yesterday, `rollup` for every station and `erb_export` for each of the 10 provinces plus national. It catches up after a restart, using dedupe keys `rollup-final:*` and `erb_export:*`.
- **Every 5 minutes:**
  - The fiscal sweep: sales still `pending` are enqueued for `fiscalise` after 2 minutes at direct-mode stations, or after `FISCAL_CLOUD_FALLBACK_MINUTES` at edge-mode stations. It uses dedupe key `fiscalise:<station>:<pump>:<txno>:<ended_at ISO ms UTC>` with `ON CONFLICT DO NOTHING`.
  - A `GatewayOffline` alert (`device_type 'gateway'`) for each edge gateway not seen for 15 minutes, raised once per outage. Critical alerts also enqueue `notify` and `webhook` `critical_alert` jobs.

**HTTP** (`METRICS_PORT`, default 9464):
- `/healthz`: whether the poll loop is alive
- `/readyz`: whether the database is reachable
- `/metrics`: prom-client metrics, including `fms_worker_jobs_processed_total`, `fms_worker_job_duration_seconds`, `fms_worker_queue_depth`, `fms_worker_scheduler_leader`, `fms_fiscal_cloud_receipts_total` and `fms_webhook_deliveries_total`

**Shutdown.** On SIGTERM or SIGINT the worker stops claiming and the scheduler releases its lock. In-flight jobs get up to `SHUTDOWN_GRACE_MS` to finish, then the pool closes.

## Run

```bash
# build the dependencies first (each package is standalone)
(cd ../../packages/shared && npm i && npm run build)
(cd ../../packages/zra-client && npm i && npm run build)
(cd ../../packages/fiscal-printer && npm i && npm run build)
npm i && npm run build
cp .env.example .env   # edit; export the variables
node dist/main.js
```

Every setting is documented in `.env.example`. With `WORKER_KINDS` you can split replicas by job kind, for example a pool that only runs fiscalisation.

## Docker

The build context is the **repo root**:

```bash
docker build -f services/fiscal-worker/Dockerfile -t fms/fiscal-worker .
docker run --rm -e DATABASE_URL=... -e ZRA_VSDC_URL=http://mock-vsdc:8200 -p 9464:9464 fms/fiscal-worker
# the same image provides the mock VSDC for docker-compose:
docker run --rm -p 8200:8200 fms/fiscal-worker node packages/zra-client/bin/mock-vsdc.js
```

## Tests

The integration tests need Postgres with the `fms` schema and the demo seed, and they start the mock VSDC on port 18200:

```bash
createdb -h localhost -p 55432 -U postgres fms_workers
DATABASE_URL=postgres://postgres@localhost:55432/fms_workers node ../../db/migrate.mjs --seed
TEST_DATABASE_URL=postgres://postgres@localhost:55432/fms_workers npm test
```

The tests **delete** rows from `jobs`, `pump_transactions`, `fiscal_receipts` and `daily_station_product` in that database. Never point them at a shared database.
