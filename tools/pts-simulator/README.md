# PTS-2 controller simulator (`tools/pts-simulator`)

This tool simulates one or more Technotrade PTS-2 forecourt controllers uploading jsonPTS to a
remote server. The target can be the edge gateway or the cloud ingest-api in direct mode.

Each simulated controller does the following:

- **`UploadPumpTransaction`:** one sequence of transaction numbers per pump. The per-nozzle totalisers are monotonic and never reset. `Amount` is `Volume × Price`, with the price taken from the grade config. The tag is optional.
- **`UploadTankMeasurement`:** sent on each change in product height, at most once per tank per second. Tank drawdown matches the sales. It also models temperature drift, slow water ingress and alarms (LowProduct, CriticalLowProduct, HighProduct and HighWater).
- **`UploadInTankDelivery`:** when a tank drops below 25 %, it is refilled to 90 % and the start and end measurements are uploaded.
- **`UploadAlertRecord`:** probe alarms when they become active, and occasional pump outages: an online pump goes offline (`PumpOffline`) and comes back after 1 to 10 minutes (`PumpOnline`; library options `alertProbability`, `pumpOutageMinS`, `pumpOutageMaxS`).
- **`UploadStatus`:** sent every `--status-interval` seconds.
- **Signing:** the body is signed with `X-Pts-Signature = HMAC-SHA256(secret, raw body)` when a secret is given. `X-Pts-Id` is always sent.
- **Retries like the real controller:** packets stay queued until the server answers `Error=false` for that packet `Id`. Anything else is re-sent with the same Id and data, and the uploader backs off while the server is unreachable.
- **Fault injection:** `--fault-inject` (with `--fault-rate`, default 0.02) simulates manual-mode dispensing. The totaliser and tank move by 10 to 50 L without a registered transaction, which is the theft pattern the FMS detects.

## CLI

```bash
npm install && npm run build
node dist/cli.js --url http://localhost:18100/jsonPTS --pts-id 003B00265030500420303531 \
     --secret devsecret-lus-0001 --pumps 4 --tanks 2 --rate 2
# 50 controllers with incrementing PTS ids (load test against the cloud ingest-api)
node dist/cli.js --url http://localhost:8081/ingest/pts --controllers 50 --rate 0.2 --duration 60
# per-controller settings
node dist/cli.js --station-map stations.json --fault-inject
```

`--rate` is the average number of pump transactions per second per controller (Poisson). Other
options are `--status-interval`, `--upload-interval`, `--duration`, `--seed` (deterministic),
`--basic-auth user:pass` and `--quiet`. Run `--help` for the full list. It prints a summary on exit
(Ctrl+C).

The `--station-map` file is a JSON array:

```json
[
  { "pts_id": "003B00265030500420303531", "secret": "devsecret-lus-0001", "url": "http://localhost:8100/jsonPTS",
    "pumps": 4, "tanks": 2, "rate": 1,
    "grades": [{ "id": 1, "name": "Unleaded Petrol", "price": 31.85 }, { "id": 2, "name": "Diesel LSD", "price": 29.95 }],
    "tanks_config": [{ "no": 1, "gradeId": 1, "capacityL": 30000 }, { "no": 2, "gradeId": 2, "capacityL": 40000 }] },
  { "pts_id": "003B00265030500420303533", "url": "http://localhost:8081/ingest/pts" }
]
```

## 200-station fleet (load test and demo)

`make sim-fleet` loads [fleet/stations-200.sql](fleet/stations-200.sql) into the running stack and starts the
`pts-fleet` compose service (profile `fleet`). The SQL adds 200 direct-mode stations across all ten
provinces, weighted roughly by population (Lusaka 50, Copperbelt 40, Central, Eastern and Southern 20 each,
the rest 10 each), owned by five companies. Each has one signed controller (secret `devsecret-sim`), two
tanks and two pumps with two nozzles, matching the demo seed. The script is idempotent and is never applied
by `migrate --seed`. Dev only: do not load it into a real database.

`pts-fleet` uploads straight to `ingest-api`, so these stations bypass the edge gateway and print no ZRA
receipts. Defaults: 0.02 transactions per second per station (nominally 4 a second in total), status every 30 s,
fault injection on. Set `FLEET_RATE`, `FLEET_SIZE` (at most 200, the stations the SQL creates) or
`FLEET_EXTRA_ARGS` in the environment to change them. `make sim-fleet-stop` stops the simulator; the stations stay and show as offline after 5 minutes.

Without make (PowerShell, from the repo root):

```powershell
Get-Content tools/pts-simulator/fleet/stations-200.sql | docker compose -f deploy/docker-compose.yml exec -T pg-primary sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose -f deploy/docker-compose.yml --profile fleet up -d pts-fleet
```

## Library (tests and load tests)

```ts
import { PtsControllerSim, uploadOnce, drain, runSimulators } from '@fms/pts-simulator';

const sim = new PtsControllerSim({ ptsId: '003B00265030500420303531', pumps: 4, tanks: 2, rate: 2, seed: 1 });
sim.tick(Date.now());                    // advance the simulation (pass simulated time for fast tests)
const req = sim.takeRequest();           // { Protocol:'jsonPTS', PtsId, Packets:[...] } (oldest unconfirmed)
sim.confirm(responseJson);               // drops packets acknowledged with Error=false
await drain(sim, { url, secret });       // upload until the queue is empty
const run = runSimulators([{ sim, upload: { url, secret } }], { tickMs: 1000 }); await run.stop();
```

`sim.stats` counts transactions, volume, deliveries, alerts, injected faults, and confirmed and
re-sent packets. Tests: `npm test`.

The field names follow the jsonPTS conventions used by `packages/shared/src/jsonpts.ts`. Verify them
against Technotrade's jsonPTS specification (DESIGN §12).
