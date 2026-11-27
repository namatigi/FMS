/**
 * End-to-end: PTS-2 simulator -> real HTTP listener (18100) -> local DB -> fiscal pipeline (fake VSDC)
 * -> printer -> outbox -> fake cloud ingest (18181). Local UI on 18101.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PtsControllerSim, drain, runSimulators } from '@fms/pts-simulator';
import type { Gateway } from '../app.js';
import type { FakeFiscalClient, MemoryReceiptPrinter } from '../fiscal/factory.js';
import { count, ensureTestDb, newGateway, PTS_ID, PTS_SECRET, startFakeCloud, waitFor, type FakeCloud } from './helpers.js';

let gw: Gateway;
let cloud: FakeCloud;
let fiscal: FakeFiscalClient;
let printer: MemoryReceiptPrinter;

before(async () => {
  await ensureTestDb();
  cloud = await startFakeCloud();
  ({ gw, fiscal, printer } = await newGateway({ SYNC_INTERVAL_MS: '200', HEARTBEAT_INTERVAL_MS: '1000' }));
  await gw.start();
});
after(async () => {
  await gw.stop();
  await cloud.close();
});

test('simulator -> gateway -> fiscal -> cloud: all rows stored, fiscalised, outbox drained', async () => {
  const sim = new PtsControllerSim({ ptsId: PTS_ID, pumps: 4, tanks: 2, rate: 3, seed: 2026, statusIntervalS: 1, faultInject: 0.05 });
  const upload = { url: 'http://127.0.0.1:18100/jsonPTS', secret: PTS_SECRET };
  const run = runSimulators([{ sim, upload }], { tickMs: 250, uploadMs: 200 });
  await new Promise((r) => setTimeout(r, 4000));
  await run.stop();
  await drain(sim, upload);
  assert.equal(sim.pending, 0, 'every packet confirmed by the gateway');
  assert.ok(sim.stats.transactions >= 5, `simulated ${sim.stats.transactions} transactions`);

  // every simulated sale is stored exactly once
  assert.equal(await count(gw, 'SELECT count(*) n FROM edge.transactions'), sim.stats.transactions);
  assert.equal(await count(gw, 'SELECT count(*) n FROM edge.tank_measurements'), sim.stats.tankMeasurements);
  assert.equal(await count(gw, 'SELECT count(*) n FROM edge.tank_latest'), 2);

  // fiscal pipeline completes for all of them
  await waitFor(async () => (await count(gw, `SELECT count(*) n FROM edge.fiscal_receipts WHERE status='printed'`)) === sim.stats.transactions, 15_000);
  assert.equal(fiscal.signed.size, sim.stats.transactions);
  assert.equal(printer.printed.length, sim.stats.transactions);

  // outbox drained to the fake cloud (heartbeats keep arriving, so wait for an empty backlog)
  await waitFor(async () => (await count(gw, `SELECT count(*) n FROM edge.outbox WHERE sent_at IS NULL`)) === 0, 15_000);
  const txInCloud = [...cloud.store.keys()].filter((k) => k.startsWith('tx:')).length;
  assert.equal(txInCloud, sim.stats.transactions);
  const printedInCloud = [...cloud.store.keys()].filter((k) => k.startsWith('fr:') && k.endsWith(':printed')).length;
  assert.equal(printedInCloud, sim.stats.transactions);
  assert.ok([...cloud.acceptedSeqs.values()].every((v) => v === 1), 'no duplicate deliveries');
  assert.ok(cloud.batches.some((b) => b.records.some((r) => r.kind === 'heartbeat')), 'heartbeat sent');

  // injected manual-mode jumps raised local TotalizerMismatch alerts
  if (sim.stats.faultsInjected > 0) {
    assert.ok(await count(gw, `SELECT count(*) n FROM edge.alerts WHERE code='TotalizerMismatch'`) > 0);
  }

  // local UI
  const status = await fetch('http://127.0.0.1:18101/api/status').then((r) => r.json()) as {
    controllers: Array<{ pts_id: string; online: boolean }>; backlog: { fiscal_pending: number }; cloud: { connected: boolean };
  };
  assert.equal(status.controllers[0].pts_id, PTS_ID);
  assert.equal(status.controllers[0].online, true);
  assert.equal(status.backlog.fiscal_pending, 0);
  assert.equal(status.cloud.connected, true);
  const html = await fetch('http://127.0.0.1:18101/').then((r) => r.text());
  assert.match(html, /Last transactions/);
  assert.match(html, /Reprint/);
  const metrics = await fetch('http://127.0.0.1:18101/metrics').then((r) => r.text());
  assert.match(metrics, /edge_outbox_backlog\{state="unsent"/);
  assert.match(metrics, /edge_pts_packets_total/);
  assert.equal((await fetch('http://127.0.0.1:18101/readyz')).status, 200);
});
