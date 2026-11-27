# FMS edge gateway (`services/edge-gateway`)

The edge gateway runs at each filling station, on a mini-PC with a local PostgreSQL and a UPS.

```
PTS-2 --jsonPTS (HMAC)--> [listener :8100] --1 DB tx--> edge.* tables + edge.outbox --> reply OK
                                                  |
                            fiscal pipeline: pending -> ZRA VSDC signSale -> signed -> print -> printed
                                                  |
                            sync loop: outbox --gzip EdgeBatch--> ${CLOUD_INGEST_URL}/ingest/v1/edge/batches
                                                  <-- accepted / rejected seqs + EdgeCommands (set_prices, ...)
                            local UI :8101  (/ , /api/*, /healthz, /readyz, /metrics)
```

## Entry points

| File | Purpose |
|---|---|
| `src/main.ts` | Process entry: loads env config, starts everything, shuts down gracefully on SIGINT/SIGTERM. |
| `src/app.ts` | `createGateway(cfg, deps)`: the composition root. Tests use it to inject a fake fiscal client and printer. |
| `src/pts/listener.ts` | `POST /jsonPTS`, `/jsonPTS/*` and `/ingest/pts`. Reads the raw body, verifies `X-Pts-Signature`, then stores each packet in its own DB transaction before confirming it. |
| `src/store.ts` | Local writes (table + outbox in the same transaction) and the local totaliser-mismatch alert. |
| `src/fiscal/pipeline.ts` | SKIP LOCKED + lease worker. Uses exponential backoff (5 min cap). Non-retryable errors set the receipt to `failed` and raise an alert. Handles reprint and requeue. |
| `src/fiscal/factory.ts` | Dynamic `import('@fms/zra-client')` and `import('@fms/fiscal-printer')` with fallbacks: an unavailable fiscal client (sales stay pending) and a console printer. `FakeFiscalClient` is for tests and demos. |
| `src/fiscal/invoice.ts` | Deterministic invoice number `<station>-P<pump>-<txno>-<yyyyMMddHHmmss Lusaka>`. |
| `src/sync/sync.ts` | Outbox to cloud batches: at most 500 records and at most 1 MB, gzip, Bearer key + `X-Gateway-Code`. Backoff with jitter. Sends a heartbeat every 30 s. |
| `src/sync/commands.ts` | `set_prices` (sent to the PTS-2, scheduled by `effective_at`, retried while the PTS-2 is unreachable), `refiscalise` and `reload_config`. Idempotent through `edge.commands_applied`. |
| `src/pts/control.ts` | `PtsControlClient`: jsonPTS requests to the controller's web server. **All request names are in `PTS_CONTROL_PROTOCOL` (VERIFY).** |
| `src/ha.ts` | Active/standby detection (`HA_MODE`). See `deploy/REDUNDANCY.md`. |
| `src/ui/server.ts` | Server-rendered status page, JSON API and Prometheus metrics. |
| `migrations/*.sql` | Schema `edge`. Applied automatically on start under an advisory lock. |

## Local store (schema `edge`)

The schema has these tables:
- `transactions`, unique on (pts_id, pump, txno, ended_at)
- `tank_measurements` and `tank_latest`
- `deliveries`
- `alerts`
- `fiscal_receipts`
- `outbox` (seq, kind, data, created_at, sent_at, attempts, last_error, parked_at)
- `commands_applied`
- `config` (station info)
- `fuel_grades` (PTS grade to ZRA item code, name, VAT category and rate, price)
- `controllers` (last seen and last status)

Housekeeping:
- Sent outbox rows are pruned after `OUTBOX_RETENTION_DAYS` (30). Unsent rows are never deleted.
- PTS-2 status arrives every second. It is kept locally and forwarded at most once every `STATUS_SYNC_INTERVAL_MS`.
- Tank-alarm alerts and the totaliser check are kept locally only. The cloud derives the same alerts from the forwarded records, so this avoids double alerts.

## Fiscal receipt states

```
pending --signSale ok--> signed --print ok--> printed
   |  retryable error: attempts+1, next_attempt_at = now + min(5 min, base*2^n)
   +--non-retryable--> failed (+ critical alert FiscalisationFailed) --refiscalise / UI Retry--> pending
zero-volume sale: transaction.fiscal_status = exempt, no receipt
```

Every status change writes a `fiscal_receipt` record to the outbox. A print failure keeps the
receipt `signed` and retries the print only; the sale is never re-signed. Reprint is available at
`POST /api/fiscal/:id/reprint` and as a button on the UI.

## Configuration

See `.env.example`, where every variable is documented. The essentials:
- `DATABASE_URL`
- `EDGE_PTS_PORT` (8100) and `EDGE_UI_PORT` (8101)
- `STATION_CODE`, `STATION_NAME`, `ZRA_TPIN`, `ZRA_BHF_ID`
- `PTS_ID` and `PTS_SECRET` (or `PTS_CONTROLLERS` JSON), and `PTS_CONTROL_URL`, `PTS_CONTROL_USER`, `PTS_CONTROL_PASSWORD`
- `FISCAL_DRIVER=zra|fake|disabled`, `ZRA_VSDC_URL`, `ZRA_DEVICE_SERIAL`
- `PRINTER_DRIVER=console|none|file|escpos-tcp|escpos-serial` (plus host, port, path, baud)
- `CLOUD_INGEST_URL`, `GATEWAY_CODE`, `GATEWAY_KEY`
- `HA_MODE=always|vip|file|standby`, `HA_VIP`

On the PTS-2, under Configuration > Settings > REMOTE SERVER SETTINGS:
- Server IP: the gateway IP, or the VIP for a redundant pair
- Port: 8100
- URI for every upload type: `jsonPTS`
- Secret key: the same value as `PTS_SECRET`
- Upload status period: 1 to 5 s

## Run (development)

```bash
cd packages/shared && npm install && npm run build
cd tools/pts-simulator && npm install && npm run build
cd services/edge-gateway && npm install && npm run build
cp .env.example .env    # adjust DATABASE_URL; FISCAL_DRIVER=fake if no mock VSDC is running
set -a; . ./.env; set +a; npm start
# in another shell: simulate the station's PTS-2
node ../../tools/pts-simulator/dist/cli.js --url http://localhost:8100/jsonPTS \
  --pts-id 003B00265030500420303531 --secret devsecret-lus-0001 --pumps 4 --tanks 2 --rate 0.5
# open http://localhost:8101/
```

## Tests

```bash
npm test     # tsc + node --test (files run serially; they share ports and the test DB)
```

The tests need Postgres on `localhost:55432` (user `postgres`, trust auth). They create and use
the `fms_edge_test` database and recreate the `edge` schema for each file. Ports used: 18100 (PTS
listener), 18101 (UI) and 18181 (fake cloud ingest). They do not depend on
`@fms/zra-client` or `@fms/fiscal-printer`, because the tests inject `FakeFiscalClient` and
`MemoryReceiptPrinter`. The test files are:
- `listener.test.ts`: signature ok, bad and tampered; X-Pts-Id; unknown controller; idempotent resubmission; malformed packets; GPS/config ignored; zero-volume exempt; totaliser alert.
- `fiscal.test.ts`: success; retryable then success; non-retryable then failed, alert and refiscalise; print retry; config missing; 3 concurrent workers; lease recovery; reprint.
- `sync.test.ts`: accept; byte-limit split; partial reject with park and unpark; outage and connection drops then recovery with no loss or duplicates; heartbeat; set_prices, reload and unknown command, plus idempotency; scheduled and retried prices; standby; retention.
- `e2e.test.ts`: the simulator runs over real HTTP into the gateway, through the fake VSDC and the fake cloud. It asserts DB rows, that everything is printed, that the outbox is drained, and checks the UI and metrics.

## Station install (systemd)

1. Install Node 20 and PostgreSQL 16. Then create the role and database:
   `createuser fms_edge -P && createdb -O fms_edge fms_edge`.
2. Copy the repo layout to `/opt/fms`. `packages/shared`, `packages/zra-client` and
   `packages/fiscal-printer` must be built, because `file:` dependencies are symlinks. Then run
   `npm ci && npm run build && npm prune --omit=dev` in `/opt/fms/services/edge-gateway`.
3. Run `useradd -r -s /usr/sbin/nologin fms`. Put the env file at `/etc/fms/edge-gateway.env` with
   mode 0640 and owner `root:fms`.
4. `cp deploy/fms-edge-gateway.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now fms-edge-gateway`
5. Check it with `journalctl -u fms-edge-gateway -f` and `curl localhost:8101/readyz`.
6. Optional standby: see `deploy/REDUNDANCY.md` and `deploy/keepalived.conf.example`.

## Docker

```bash
docker build -f services/edge-gateway/Dockerfile -t fms/edge-gateway .   # from the REPO ROOT
docker run --env-file services/edge-gateway/.env -p 8100:8100 -p 8101:8101 fms/edge-gateway
```

## Assumptions to verify (DESIGN §12)

- **jsonPTS control requests** (`src/pts/control.ts`, `PTS_CONTROL_PROTOCOL`):
  - Prices are updated by reading `GetFuelGradesConfiguration` and writing back `SetFuelGradesConfiguration` with `FuelGrades[{Id, Name, Price, ...}]`. The alternative is the price-only `SetFuelGradesPrices`.
  - The endpoint is `/jsonPTS` with basic auth (DIP-2 ON). Digest auth is not implemented.
- **Upload fields** follow `@fms/shared` `normalizeJsonPtsPacket`.
- **VAT:** category `A` at 16 % for fuel by default. It can be set per grade.
- **Timestamps:** PTS-2 timestamps have 1 s resolution. A second tank measurement in the same second is treated as a duplicate.
