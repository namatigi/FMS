# @fms/zra-client

This package is the client for ZRA Smart Invoice through the **VSDC** (Virtual Sales Data Controller) REST API. It also ships an in-process **mock VSDC** for development, docker-compose and tests.

> **Verify before go-live.** Every protocol assumption lives in `src/spec.ts` (`VSDC_SPEC`): endpoint paths, result codes, payment and sale codes, VAT categories and rates, and the time zone. Check them against the current official ZRA VSDC specification and the ZRA sandbox (DESIGN.md §12 item 2).

## API

```ts
import { ZraVsdcClient, buildInvoiceNo, startMockVsdc } from '@fms/zra-client';

const zra = new ZraVsdcClient({ baseUrl, tpin, bhfId, deviceSerial, timeoutMs: 15000, vatRates: { A: 16 } });
await zra.initialize();                    // POST /initializer/selectInitInfo {tpin,bhfId,dvcSrlNo}
await zra.saveItem({ itemCd, itemClsCd, itemNm, ... });         // POST /items/saveItem
await zra.saveStockItems({ ... });          // POST /stock/saveStockItems
await zra.saveStockMaster({ ... });         // POST /stockMaster/saveStockMaster
const sig = await zra.signSale(req);        // POST /trnsSales/saveSales → FiscalSignature
await zra.health();                         // { ok, detail }

buildInvoiceNo({ stationCode: 'CEN-0001', pumpNo: 1, ptsTransactionNo: 4711, endedAt }); // CEN-0001-P1-4711-20261127101530
```

### How `signSale` maps a sale

`signSale` takes a `FiscalSaleRequest` from `@fms/shared` and sends it as `trnsSales/saveSales`:
- `tpin` and `bhfId` come from the request, falling back to the client's own values. `cisInvcNo` is `invoice_no` and `orgInvcNo` is `0`.
- `salesTyCd` is `N`, `rcptTyCd` is `S` and `salesSttsCd` is `02`.
- `pmtTyCd` comes from `payment_type`: cash `01`, credit `02`, card `05`, mobile money `06`, other `08`.
- `cfmDt` (yyyyMMddHHmmss) and `salesDt` (yyyyMMdd) are in Africa/Lusaka time.
- Prices are **tax-inclusive**. For each VAT category, `taxblAmtX = round2(total / (1 + rate))` and `taxAmtX = total − taxable`. The per-category fields are `taxblAmtX`, `taxRtX` and `taxAmtX` for X in A, B, C1, C2, C3, D, E and RVAT. The totals are `totTaxblAmt`, `totTaxAmt` and `totAmt`.
- Each entry in `itemList` carries `itemSeq`, `itemCd`, `itemClsCd`, `itemNm`, `qtyUnitCd 'LTR'`, `qty`, `prc`, `splyAmt`, `dcRt`, `dcAmt`, `vatCatCd`, `vatTaxblAmt`, `vatAmt` and `totAmt`.

### Errors

The client always throws a `FiscalError`, with `retryable` and `code` set:

| Situation | retryable |
|---|---|
| `resultCd` `000` | success |
| duplicate (`994`) with receipt data | success, so retries are idempotent |
| duplicate with no data | no (`VSDC_DUPLICATE_NO_DATA`), needs manual retrieval |
| timeout, network error, HTTP 5xx, 408 or 429, and VSDC codes `891`–`894`, `899`, `999` | yes |
| any other `resultCd` (validation, device, TPIN) | no |

## Mock VSDC

```ts
const mock = await startMockVsdc({ port: 18200 });   // { url, port, close(), fail(mode, n), reset(), state() }
```

The mock behaves like this:
- Receipt numbers are sequential per TPIN and branch. Signatures and internal data are an HMAC of the invoice, so they are deterministic.
- It is idempotent on `cisInvcNo`. A repeated invoice returns `994` together with the original receipt.
- It runs basic payload validation and answers `910` when that fails.
- **Failure injection:**
  - Over HTTP: `GET /__mock/fail?mode=timeout|5xx|reject|duplicate_nodata|vsdc_error&count=N`. `count=0` means fail forever, and `mode=none` clears it.
  - From the CLI: the `MOCK_VSDC_FAIL_MODE` and `MOCK_VSDC_FAIL_COUNT` env vars.
  - A `timeout` on saveSales *commits the receipt first*, so it simulates a lost response.
- The control endpoints are `GET /__mock/state`, `POST /__mock/reset` and `GET /healthz`.

To run it from the CLI or as a container (docker-compose), use `node bin/mock-vsdc.js`. The environment variables are:
- `PORT` (default 8200)
- `HOST` (default 0.0.0.0)
- `MOCK_VSDC_SIGNING_KEY`
- `MOCK_VSDC_FAIL_MODE` and `MOCK_VSDC_FAIL_COUNT`

## Build and test

```bash
npm install && npm test     # tsc + node --test (mock on port 18200; override with MOCK_VSDC_TEST_PORT)
```
