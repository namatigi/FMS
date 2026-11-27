# FMS service contracts (source of truth for all teams)

Every cloud service shares PostgreSQL schema `fms` (see `db/migrations`). Every TypeScript service depends on `@fms/shared` (`packages/shared`, linked with `"@fms/shared": "file:../../packages/shared"`).

## Ports and routing

| Component | Port | Public path (behind reverse proxy) |
|---|---|---|
| core-api (TypeScript/Fastify) | 8080 | `/api/v1/*`, `/api/partner/v1/*` |
| ingest-api (TypeScript/Fastify) | 8081 | `/ingest/*` |
| analytics (Python/FastAPI) | 8090 | `/analytics/v1/*` |
| fiscal-worker (TypeScript) | metrics on 9464 | none |
| web app (React/Vite) | 5173 (dev) | `/` |
| edge-gateway (TypeScript, at each station) | 8100: PTS-2 upload listener; 8101: local admin UI | not public |
| mock ZRA VSDC (dev only) | 8200 | none |

### Common environment variables

`DATABASE_URL`, `DATABASE_URL_RO` (read replica, optional), `JWT_SECRET`, `LOG_LEVEL`, `PORT`.

### Health and metrics

Every service exposes:
- `GET /healthz` (liveness)
- `GET /readyz` (readiness, checks the database)
- `GET /metrics` (Prometheus text format)

## Authentication

- **Users:** JWT (HS256, `JWT_SECRET`), issued by core-api. Claims are defined in `FmsJwtClaims` in `@fms/shared`. Send it as `Authorization: Bearer <token>`. Access tokens expire after 15 minutes. Refresh tokens last 30 days and are opaque, stored hashed.
- **Partner API:** `X-API-Key: <prefix>.<secret>`. The key is looked up by prefix in `fms.api_clients`, and its sha256 must match `key_hash`. Access is limited by the client's scopes, province and company.
- **Edge gateways:** `Authorization: Bearer <gateway key>` plus `X-Gateway-Code`. The key's sha256 is stored in `edge_gateways.api_key_hash`.
- **PTS-2 in direct mode:** `POST /ingest/pts` with a jsonPTS body. The controller is identified by the body's `PtsId` or the `X-Pts-Id` header. If `controllers.hmac_secret` is set, the signature header `X-Pts-Signature` (HMAC-SHA256 of the raw body) is verified.

### Role scoping (enforced server-side on every query)

| Role | Sees |
|---|---|
| platform_admin | everything |
| owner | stations where `company_id` = the claim's company |
| manager | stations listed in `user_station_access` |
| erb_national | all stations, read-only, plus regulator endpoints |
| erb_provincial | stations where `province_id` = the claim's province, plus regulator endpoints scoped to that province |
| zra_auditor | fiscal receipts and sales, read-only, all stations |

## ingest-api (port 8081)

- `POST /ingest/pts` takes a jsonPTS request and replies with a jsonPTS response (`jsonPtsReply`). Each packet is stored raw in `ingest_raw` and normalised with `normalizeJsonPtsPacket`, then persisted idempotently. A packet must be replied `OK` only after its commit, because the PTS-2 re-sends anything not confirmed.
- `POST /ingest/v1/edge/batches` takes an `EdgeBatch` and returns an `EdgeBatchResponse`. Pending commands for the station are piggy-backed in the response.
- **Persistence rules:**
  - pump_transaction:
    - Resolve `station_id` from the controller.
    - Resolve `product_code` from `fuel_grades`, and `tank_no` from `nozzles`.
    - Write with `ON CONFLICT DO NOTHING`.
    - In direct mode (no edge), enqueue a `jobs(kind='fiscalise')` row with dedupe_key `fiscalise:<station>:<pump>:<txno>:<ended_at>`.
    - Check totaliser continuity: if the previous `total_volume_l` for the same pump and nozzle, plus this sale's volume, is less than this `total_volume_l` minus 0.5 L, raise a `TotalizerMismatch` alert (critical), meaning possible manual-mode theft.
  - tank_measurement: insert, and upsert `tank_latest` if newer. Alarms become alerts through `alarmsToAlerts`.
  - tank_delivery: insert `ON CONFLICT DO NOTHING`.
  - alert: insert `ON CONFLICT DO NOTHING`. Critical alerts enqueue `jobs(kind='notify')` and `jobs(kind='webhook')`.
  - status: update `controllers.last_status` and `last_seen_at`.
  - heartbeat: update `edge_gateways.last_seen_at`, `last_backlog` and `version`.
  - fiscal_receipt: upsert `fiscal_receipts` by natural key, and set `pump_transactions.fiscal_status`.
  - Every accepted write to a station-day enqueues `jobs(kind='rollup', dedupe_key='rollup:<station>:<date>')`. The rollup is performed by `fms.rollup_station_day`.

## core-api (port 8080), base `/api/v1`

The JSON is in snake_case. List endpoints return `{ "items": [...], "next_cursor": string|null }` unless stated otherwise. Errors use `{ "error": { "code": string, "message": string } }`. Timestamps are ISO-8601 and amounts are JSON numbers.

### Auth

- `POST /auth/login` takes `{email, password}` and returns `{access_token, refresh_token, expires_in, user:{id,email,full_name,role,company_id,province_id}}`.
- `POST /auth/refresh` takes `{refresh_token}` and returns the same shape.
- `POST /auth/logout`
- `GET /me`

### Dashboard (scoped to the caller)

`GET /dashboard/overview` returns:

```
{ stations_total, stations_online, stations_offline,
  sales_today: { volume_l, amount, tx_count },
  by_product: [{ product_code, sales_today_l, sales_today_amount, stock_l, capacity_l }],
  low_stock_tanks: [{ station_id, station_name, tank_no, product_code, product_volume_l, capacity_l, fill_pct }],
  open_alerts: { critical, warning } }
```

### Stations

- `GET /stations?province_id=&company_id=&q=` returns items of `{id, code, name, company_id, company_name, province_id, province_name, district, town, latitude, longitude, status, connectivity, controller_last_seen_at}`.
- `GET /stations/:id` returns the station plus `{tanks:[...], fuel_grades:[...], nozzles:[...], health:{...}}`.
- `GET /stations/:id/tanks` returns `[{tank_no, product_code, capacity_l, product_volume_l, ullage_l, water_height_mm, temperature_c, fill_pct, measured_at, probe_status, alarms, avg_daily_sales_l, days_of_cover}]`.
- `GET /stations/:id/transactions?from=&to=&pump_no=&limit=&cursor=` returns items of `{id, ended_at, pump_no, nozzle_no, product_code, volume_l, price, amount, tag, fiscal_status, zra_rcpt_no}`.
- `GET /stations/:id/sales/summary?from=&to=&group=hour|day|product|pump` returns `[{bucket, product_code, pump_no?, volume_l, amount, tx_count}]`.
- `GET /stations/:id/deliveries?from=&to=`
- `PATCH /deliveries/:id` takes `{delivery_note_no, supplier, invoiced_volume_l}`. Allowed for owner and manager.
- `GET /stations/:id/reconciliation?from=&to=` returns `daily_station_product` rows.
- `PUT /stations/:id/prices` takes `{prices:[{pts_grade_id, price}], effective_at?}`. Allowed for owner and platform_admin. It is rejected when a price is above the ERB cap for that product and province. It queues an edge `set_prices` command.

### Alerts

- `GET /alerts?station_id=&status=open|all&severity=`
- `POST /alerts/:id/ack`

### Fiscal

`GET /fiscal/receipts?station_id=&status=&from=&to=`

### Regulator (roles: erb_national, erb_provincial, platform_admin), base `/api/v1/regulator`

- `GET /overview` returns:
  ```
  { by_product:[{product_code, stock_l, capacity_l, sales_24h_l, days_of_cover}],
    stations:{total, online, offline}, alerts_open }
  ```
- `GET /provinces` returns `[{province_id, province_name, stations, online, by_product:[{product_code, stock_l, capacity_l, sales_24h_l, days_of_cover}]}]`.
- `GET /provinces/:id/stations` returns `[{station_id, code, name, company_name, connectivity, stock:[{product_code, stock_l, capacity_l}], last_price:[{product_code, price}]}]`.
- `GET /sales/daily?from=&to=&province_id=&product_code=` returns `v_province_daily` rows.
- `GET /stock?province_id=` returns `v_province_stock` rows.
- `GET /compliance?province_id=` returns `{price_violations:[...], offline_stations:[...], variance_anomalies:[...], fiscal_failures:[...]}`.
- `GET /prices` returns the ERB cap prices currently in force. `POST /prices` takes `{product_code, province_id|null, price, effective_at}` and is allowed for erb_national only.
- `GET /export?date=&province_id=&format=csv|json` returns a daily per-station return for ERB.

### Admin (platform_admin), base `/api/v1/admin`

- CRUD for `companies`, `stations`, `tanks`, `fuel_grades`, `nozzles`, `controllers`, `users` and `api-clients`.
- `POST /gateways` returns the gateway API key once.
- `POST /api-clients` returns the API key once.
- `POST /webhooks`

### Partner API, base `/api/partner/v1` (X-API-Key)

- `GET /stations`
- `GET /stock`
- `GET /sales/daily`
- `GET /prices`
- `GET /alerts`

All of these are limited by the client's scopes, province and company. Webhooks carry the header `X-FMS-Signature: t=..,v1=..` (`signWebhook`). Events are `daily_summary`, `critical_alert` and `stock_low`.

## analytics (Python, port 8090), base `/analytics/v1`

It uses the same JWT; regulator roles are required except where noted.

- `GET /forecast/demand?province_id=&product_code=&horizon_days=14` returns `{history:[{date,value}], forecast:[{date,value,lower,upper}], model, mape}`.
- `GET /forecast/stockout?province_id=&product_code=` returns `[{station_id, station_name, product_code, stock_l, avg_daily_sales_l, days_of_cover, predicted_stockout_date, risk:"high"|"medium"|"low"}]`. Owners may call it for their own stations through the `station_id=` filter.
- `GET /reserve/national` returns `{as_of, by_product:[{product_code, stock_l, capacity_l, avg_daily_demand_l, days_of_cover, risk, by_province:[...]}]}`.
- `GET /anomalies?province_id=&from=&to=` returns `[{station_id, business_date, product_code, variance_l, variance_pct, zscore, kind:"stock_loss"|"totalizer"|"price"}]`.
- `POST /pricing/simulate` takes `{product_code, fob_usd_per_mt?, fx_rate?, freight?, taxes?, margins?, ...}` and returns `{indicative_price, breakdown:[...], model}`.
- `GET /models` returns the registered custom AI models.
- `POST /models/{name}/predict` takes `{inputs:{...}}` and returns `{outputs:{...}, model, version}`. It is the plug-in point for custom AI models.

## Edge gateway → ZRA VSDC

See `packages/zra-client`. Configure it with `ZRA_VSDC_URL`, `ZRA_TPIN`, `ZRA_BHF_ID` and `ZRA_DEVICE_SERIAL`.
