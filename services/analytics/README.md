# FMS analytics service

Python 3.12 / FastAPI service for the ERB regulator analytics described in `docs/DESIGN.md` §9 and
`docs/api/CONTRACTS.md` (section *analytics*). Base path `/analytics/v1`, default port 8090.

| Endpoint | Roles | Notes |
|---|---|---|
| `GET /forecast/demand?province_id=&product_code=&horizon_days=14[&history_days=90]` | regulator | Daily province (or national) × product sales. Holt-Winters additive (damped trend, weekly seasonality) when ≥ 28 days, seasonal-naive when 7–27 days, mean below that. 80 % intervals from 400 simulated paths. `mape` = % error of a 14-day holdout backtest. Cached in memory for 10 min (`FORECAST_CACHE_TTL_S`). Without `product_code`, all products are summed. Today's (partial) business day is excluded. |
| `GET /forecast/stockout?province_id=&product_code=&station_id=` | regulator, owner, manager | Stock from `v_station_stock`. `avg_daily_sales_l` is the mean of the last 14 days, or the last 7 days when fewer than 7 days of data exist. Risk: high < 2 days, medium < 5, low otherwise. Owners and managers see only stations in their scope, and an out-of-scope `station_id` returns 403. Tanks with no reading are omitted. |
| `GET /reserve/national[?province_id=]` | regulator | Station stock plus the latest `fms.depot_stock` snapshot per depot × product. Demand is the 14-day average. Risk: critical < 3 days, high < 7, medium < 15, low otherwise. Includes `by_province` and `depots`. |
| `GET /anomalies?province_id=&from=&to=` | regulator | Kinds: `stock_loss` (robust z-score, median/MAD, of `variance_l / sales_volume_l` per station × product with a 60-day baseline; flagged when \|z\| > 3.5), `totalizer` (`alerts.code='TotalizerMismatch'`) and `price` (`avg_price` above the ERB cap; a province cap overrides the national one). The default window is the last 30 days. |
| `POST /pricing/simulate` | regulator | Cost build-up from FOB USD/MT to ZMW/L: freight, insurance, FX, duties and levies, margins, then VAT. Defaults are in `config/pricing_defaults.yaml` (**illustrative, not official**). When a `pricing` model is registered, its output is added as `custom_model`. |
| `GET /models`, `POST /models/{name}/predict` | regulator | Custom AI model registry (see below). |
| `GET /healthz`, `/readyz`, `/metrics` | none | Liveness, a DB readiness check and Prometheus metrics. |

Rules that apply to every endpoint:
- **erb_provincial:** always forced to the province in its token; any `province_id` in the request is ignored.
- **Errors:** returned as `{"error":{"code","message"}}`.
- **JWT:** HS256 with `JWT_SECRET`, using the `FmsJwtClaims` claims.

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | – | RW URL. Used only to apply `migrations/200_analytics.sql` at start-up. |
| `DATABASE_URL_RO` | `DATABASE_URL` | Every query goes here. Sessions run `default_transaction_read_only=on`. |
| `JWT_SECRET` | – | Required. |
| `PORT` / `WEB_CONCURRENCY` | 8090 / 1 (2 in Docker) | uvicorn port and worker count. |
| `LOG_LEVEL` | INFO | Logs are structured JSON on stdout. |
| `MODELS_CONFIG` | `config/models.yaml` | YAML or JSON. |
| `MODELS_PYTHONPATH` | – | Extra import paths for model code (`/models` in Docker). |
| `PRICING_CONFIG` | `config/pricing_defaults.yaml` | |
| `ANALYTICS_APPLY_MIGRATIONS` | true | Set to false for read-only credentials. |
| `FORECAST_CACHE_TTL_S`, `DB_POOL_MIN/MAX`, `DB_STATEMENT_TIMEOUT_MS` | 600, 1/10, 30000 | |

## Run locally

```powershell
cd services/analytics
python -m venv .venv; .venv\Scripts\pip install -r requirements-dev.txt
$env:DATABASE_URL="postgres://postgres@localhost:55432/fms_analytics"; $env:JWT_SECRET="dev"
.venv\Scripts\python scripts\generate_history.py          # synthetic data (dev/test DBs only!)
$env:PORT="18090"; .venv\Scripts\python -m fms_analytics
.venv\Scripts\python -m pytest                             # tests use TEST_DATABASE_URL (default: the URL above)
```

To run it in Docker: `docker build -t fms-analytics services/analytics`, then
`docker run -e DATABASE_URL=... -e JWT_SECRET=... -p 8090:8090 fms-analytics`.

`scripts/generate_history.py` writes the following synthetic data:
- 3 synthetic stations per province.
- 180 days of `daily_station_product`. The series has weekly seasonality, a trend, month-end peaks and noise, plus a simulated delivery and stock book with small normal losses.
- Monthly ERB caps, national plus a Lusaka PETROL override.
- `tank_latest` rows, a few of them forced low.
- Depot stock.
- Injected anomalies: 5 stock losses, 3 totaliser alerts and 3 price-cap breaches.

It prints the injected items as JSON.

## Bring your own model

The government's data-science team can add a reserve, pricing or demand model **without changing platform code**. Each model is one entry in `MODELS_CONFIG`.

### 1. A Python model (in-process)

```python
# /models/erb_models/reserve_v2.py   (mounted into the container; MODELS_PYTHONPATH=/models)
def predict(inputs: dict, ctx) -> dict:
    # ctx.name, ctx.version, ctx.options (from config), ctx.logger
    # ctx.db.fetch_all(sql, params) -> list[dict]   (read-only; async models: await ctx.db.afetch_all)
    rows = ctx.db.fetch_all(
        "SELECT product_code, sum(product_volume_l) v FROM fms.v_station_stock GROUP BY 1"
    )
    return {"by_product": {r["product_code"]: r["v"] for r in rows}}
```

```yaml
models:
  reserve_v2:
    type: python
    entrypoint: erb_models.reserve_v2:predict   # module:function, sync or async
    version: "2.0.0"
    timeout_s: 15
    options: {threshold: 0.3}                   # passed as ctx.options
    input_schema:                               # optional validation
      required: [product_code]
      properties: {product_code: {type: string, enum: [PETROL, DIESEL]}}
```

How the function is called:
- **Signature:** the function is called as `fn(inputs)` or `fn(inputs, ctx)`, depending on how many positional parameters it takes.
- **Threading:** sync functions run in a worker thread.
- **Inputs and outputs:** inputs and outputs must be JSON objects, and numpy scalars and arrays are converted.
- **Loading:** heavy artefacts (pickles, ONNX, joblib) should be loaded once at module import or lazily behind a lock. `example_models/reserve_risk.py` shows the lazy pattern.

### 2. A model served elsewhere (HTTP: MLflow, BentoML, KServe, R Plumber and others)

```yaml
models:
  demand_mlflow:
    type: http
    url: https://models.erb.gov.zm/demand/invocations
    headers: {Authorization: "Bearer ${ERB_MODEL_TOKEN}"}   # ${ENV} expanded at call time
    timeout_s: 5
    version: "mlflow-run-42"
```

How the call works:
- **Request:** the service sends `POST {"inputs": {...}}`.
- **Response:** the server answers either `{"outputs": {...}}` or MLflow's `{"predictions": [...]}`, which is returned as `{"outputs":{"predictions":[...]}}`.
- **Header secrets:** secrets in headers are never returned by `GET /models`.

### 3. Call it

```
POST /analytics/v1/models/reserve_v2/predict   {"inputs": {"product_code": "DIESEL"}}
→ {"outputs": {...}, "model": "reserve_v2", "version": "2.0.0"}
```

Error codes:

| Code | Status |
|---|---|
| `model_not_found` | 404 |
| `model_disabled` | 409 |
| `invalid_inputs` | 422 |
| `model_error` | 502 (raised, non-JSON, or non-object output) |
| `model_unavailable` | 503 (failed to import) |
| `model_timeout` | 504 |

How to monitor models:
- **Status:** `GET /models` shows each model's status: `ready`, `disabled` or `error` with the reason.
- **Metrics:** `analytics_model_predictions_total{model,outcome}` and `analytics_model_prediction_seconds{model}`.
- **Logs:** every call is logged as JSON with its model, version, outcome and duration.

A model registered under the name **`pricing`** is automatically added to `POST /pricing/simulate`.

The shipped examples are:
- `reserve_risk`: gradient boosting trained on Monte-Carlo demand-versus-cover simulations, giving the stock-out probability per product.
- `pricing`: a linear trend of the national volume-weighted pump price.
- `demand_mlflow`: a disabled HTTP entry, included for documentation.
