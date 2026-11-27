# Zambia National Fuel Monitoring System (FMS)

The FMS gives real-time monitoring of every filling station in Zambia:
- dispenser sales and ATG tank levels, collected by Technotrade **PTS-2** controllers
- every sale fiscalised through **ZRA Smart Invoice (VSDC)**, with signed receipts printed at the station
- web and mobile dashboards for owners and managers
- provincial and national analytics for the **ERB**, with forecasting and custom AI models
- partner APIs and webhooks for other authorities

Everything is stored in **PostgreSQL**.

- Design and architecture: [docs/DESIGN.md](docs/DESIGN.md)
- Service contracts: [docs/api/CONTRACTS.md](docs/api/CONTRACTS.md)
- Operations runbook: [deploy/README.md](deploy/README.md)

| Path | What |
|---|---|
| `db/` | Schema migrations, demo seed and migration runner (`node db/migrate.mjs [--seed]`) |
| `packages/shared` | jsonPTS normaliser, edge-to-cloud contracts, fiscal interfaces, security helpers |
| `packages/zra-client` | ZRA VSDC client and mock VSDC |
| `packages/fiscal-printer` | ESC/POS receipt printing with the ZRA QR code; fiscal-device plug-ins |
| `services/edge-gateway` | Runs at each station: PTS-2 listener, local outbox, ZRA signing and printing, cloud sync |
| `services/ingest-api` | Cloud ingestion from edge gateways and direct PTS-2 uploads |
| `services/core-api` | Auth, RBAC, owner and manager API, ERB regulator API, partner API, admin |
| `services/fiscal-worker` | Job workers: cloud fiscalisation, roll-ups, webhooks, ERB exports, scheduler |
| `services/analytics` | Python: forecasts, stock-out, national reserve, anomalies, pricing, AI model registry |
| `apps/web` | React portal: owners, ERB, ZRA, admin (installable PWA) |
| `apps/mobile` | Expo / React Native app for owners and managers |
| `tools/pts-simulator` | PTS-2 controller simulator for testing and load |
| `tools/e2e` | End-to-end test harness for the whole pipeline |
| `deploy/` | Docker Compose, Kubernetes (CloudNativePG HA), station install kit, monitoring |

## Quick start

With Docker:

```powershell
docker compose -f deploy/docker-compose.yml --profile edge up -d --build
```

Without Docker:
1. Build each package. Run `npm install` then `npm run build` in each directory, starting with `packages/shared`.
2. Run the end-to-end test against a local Postgres:

```powershell
$env:PG_ADMIN_URL="postgres://postgres@localhost:5432"; node tools/e2e/e2e.mjs
```

The demo users are in `db/seed/001_demo.sql`; their password is `ChangeMe123!`, for development only.
