# ingest-api

Stateless, horizontally scaled ingest for the FMS. It accepts:

| Route | Caller | Auth |
|---|---|---|
| `POST /ingest/pts` | PTS-2 controllers in direct mode (or as a fallback upload target) | controller looked up by body `PtsId` or `X-Pts-Id`. `X-Pts-Signature` is the HMAC-SHA256 of the raw body, checked when `controllers.hmac_secret` is set |
| `POST /ingest/v1/edge/batches` | station edge gateways (`EdgeBatch`, optionally `Content-Encoding: gzip`) | `Authorization: Bearer <key>` + `X-Gateway-Code`. sha256(key) must equal `edge_gateways.api_key_hash` and `station_code` must be that gateway's station |
| `GET /healthz`, `GET /readyz` (DB ping), `GET /metrics` | ops | none |

## Run

```bash
npm install
cp .env.example .env            # set DATABASE_URL etc.
npm run build && npm start      # or: npm run dev
```

Docker (build context = repo root): `docker build -f services/ingest-api/Dockerfile -t fms/ingest-api .`

### Environment

See `.env.example`. The main variables are `DATABASE_URL`, `PORT` (8081), `LOG_LEVEL`, `PG_POOL_MAX`, `PG_STATEMENT_TIMEOUT_MS`, `BODY_LIMIT_BYTES` (5 MB, applied after gunzip), `MAX_RECORDS_PER_BATCH`, `CACHE_TTL_MS` (60 s), `RATE_LIMIT_RPS`/`RATE_LIMIT_BURST` (per gateway or controller, per instance; `0` disables), `ROLLUP_DELAY_S`, `MAX_COMMANDS_PER_RESPONSE`, `ARCHIVE_EDGE_BATCHES` and `SHUTDOWN_TIMEOUT_MS`.

## Behaviour

### Request handling and persistence

- **One transaction per request.** Every table gets one multi-row statement (`json_to_recordset`), so a 100-record batch costs about 10 round trips.
- **Replies are sent only after COMMIT.** The PTS-2 re-sends anything it did not see `OK` for, and the gateway re-sends anything not in `accepted`.
- **Per-record isolation.** Records are validated first, and invalid ones are rejected individually (`retryable:false`). If the set-based transaction still fails on a non-transient DB error, every record is retried in its own transaction, so only the culprit is rejected.
- **Transient DB errors.** These are connection errors, deadlocks, `statement_timeout` and similar. They return `503` with `Retry-After`; jsonPTS gets all packets `Error:true`.
- **Identity checks.** A record with an unknown `pts_id` is rejected with `retryable:true`, because the controller may not be registered yet. A controller that belongs to another station is rejected with `retryable:false`.
- **Archiving.** Direct jsonPTS packets are archived one row per packet in `fms.ingest_raw` (`source='pts_direct'`) in the same transaction, malformed packets included. Edge batches are archived only when `ARCHIVE_EDGE_BATCHES=true`, because the edge keeps its own outbox.

### Persistence rules (beyond `docs/api/CONTRACTS.md`)

- **Product and tank lookup.** `product_code` comes from `fuel_grades(station, pts_grade_id)`, then falls back to the nozzle's grade. `tank_no` comes from `nozzles`.
- **Totaliser check.** For each new sale, `unaccounted = (total - prev_total) - volume`, where `prev` is the latest earlier sale on the same station/pump/nozzle that has a totaliser value. If it is above 0.5 L, a `TotalizerMismatch` critical alert is raised with data `{expected, actual, unaccounted_l, ...}`.
- **Tank alarms.** `alarmsToAlerts` is applied with *onset* detection: an alert is raised only when the flag was not on the previous reading. Without this, a standing `HighWater` would raise an alert on every measurement.
- **Low stock.** When the newest reading crosses from at or above `tanks.low_level_l` (or unknown) to below it, ingest raises a `LowStock` warning alert and a `webhook` job with event `stock_low`.
- **`tank_latest`.** It is updated only by newer readings, so out-of-order resends never move it backwards.
- **Fiscal receipts.** These are upserted by natural key with `fiscalised_by='edge'`. A signed or printed receipt is never regressed by an older resend. `pump_transactions.fiscal_status` becomes `signed` (or `failed`). If the receipt arrives before its sale, the sale is inserted with the correct status.
- **Alerts.** Alerts are de-duplicated with `NOT EXISTS ... device_no IS NOT DISTINCT FROM` as well as `ON CONFLICT`, because the UNIQUE key treats NULL `device_no` as distinct.
- **Gateway liveness.** Every authenticated batch updates `edge_gateways.last_seen_at`. Heartbeats also set `last_backlog` and `version`. Direct uploads update `controllers.last_seen_at`.

### Jobs written

| kind | dedupe_key | payload |
|---|---|---|
| `fiscalise` (direct-mode stations only) | `fiscalise:<station>:<pump>:<txno>:<ended_at ISO UTC ms>` | `{station_id, pump_no, nozzle_no, pts_transaction_no, ended_at}` |
| `rollup` | `rollup:<station>:<YYYY-MM-DD Africa/Lusaka>` | `{station_id, business_date}` |
| `notify` (critical alerts) | `notify:alert:<alert_id>` | `{station_id, station_code, province_id, company_id, alert_id, alert}` |
| `webhook` | `webhook:critical_alert:<id>`, `webhook:stock_low:<id>` | `{event, station_id, station_code, province_id, company_id, alert_id, data}` |

`jobs.dedupe_key` is unique forever, so rollups are *re-armed* rather than inserted again: `ON CONFLICT DO UPDATE SET status='queued', run_at=now()+ROLLUP_DELAY_S, attempts=0 WHERE status IN ('done','dead')`. A new measurement also re-arms the *next* day when that day is already in the past, because it is the next day's opening stock.

There is one known window. If a rollup is `running` while new data arrives, it is not re-armed and may miss that data until the next write to that day.

### Edge commands (piggy-back, acknowledged)

Commands live in `fms.edge_commands` (`db/migrations/005_edge_commands.sql`); core-api inserts them (e.g. `PUT /stations/:id/prices`).

- **Delivery.** Each batch response includes up to `MAX_COMMANDS_PER_RESPONSE` commands for the gateway's station:
  - `queued` ones
  - `delivered` ones with no `received` ack after `COMMAND_REDELIVER_S` (default 120 s)

  They are claimed with `FOR UPDATE SKIP LOCKED` in the batch transaction and marked `delivered`, with `delivery_count`, `last_delivered_at` and `delivered_via` updated. Expired commands are never sent.
- **Acknowledgement.** The gateway sends `command_ack` records (`received`, then `applied` / `partial` / `failed`) through its durable outbox.
  - Status only moves forward (`fms.edge_command_rank`), so re-sent acks are harmless.
  - `received` stops redelivery.
  - `failed` or `partial` raises a `CommandFailed` / `CommandPartiallyApplied` alert.
  - Acks for unknown ids are accepted and ignored.
- **Guarantee.** A lost HTTP response just means the command is sent again after the timeout. The gateway applies commands idempotently by id and re-acks its current state.
- **Expiry.** fiscal-worker marks commands still `queued`/`delivered` after `expires_at` (default 7 days) as `expired` and raises `CommandExpired`.
- **Re-send.** To re-send a command, set its status back to `queued`.

## Tests

The tests need a migrated and seeded database (they create throw-away fixture stations):

```powershell
& "C:\Program Files\PostgreSQL\16\bin\createdb.exe" -h localhost -p 55432 -U postgres fms_ingest
$env:DATABASE_URL="postgres://postgres@localhost:55432/fms_ingest"; node ../../db/migrate.mjs --seed
npm test
```

## Load test

```powershell
$env:RATE_LIMIT_RPS="0"; $env:PORT="18081"; npm start         # terminal 1
npx tsx scripts/load.ts --batches 400 --concurrency 16 --records 100 --stations 20   # terminal 2
```
