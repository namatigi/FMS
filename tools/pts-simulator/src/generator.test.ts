import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PtsControllerSim, incrementPtsId, ptsLocalTime } from './generator.js';

const PTS = '003B00265030500420303531';

function run(sim: PtsControllerSim, seconds: number, start = Date.UTC(2026, 10, 27, 8, 0, 0)) {
  const all = [];
  for (let i = 0; i < seconds; i++) {
    sim.tick(start + i * 1000);
    const req = sim.takeRequest(10_000);
    if (req) {
      all.push(...req.Packets);
      sim.confirm({ Packets: req.Packets.map((p) => ({ Id: p.Id, Error: false })) });
    }
  }
  return all;
}

test('helpers', () => {
  assert.equal(incrementPtsId(PTS, 1), '003B00265030500420303532');
  assert.equal(ptsLocalTime(Date.UTC(2026, 10, 27, 8, 1, 30)), '2026-11-27T10:01:30');
});

test('transactions have monotonic totalisers and transaction numbers, tanks draw down', () => {
  const sim = new PtsControllerSim({ ptsId: PTS, pumps: 4, tanks: 2, rate: 2, seed: 42, refillBelow: 0 });
  const before = sim.tankVolumes();
  const packets = run(sim, 120);
  const tx = packets.filter((p) => p.Type === 'UploadPumpTransaction').map((p) => p.Data as Record<string, number>);
  assert.ok(tx.length > 50, `expected many transactions, got ${tx.length}`);
  const lastTotal = new Map<string, number>();
  const lastNo = new Map<number, number>();
  let sold = 0;
  for (const t of tx) {
    const key = `${t.Pump}:${t.Nozzle}`;
    const prev = lastTotal.get(key);
    if (prev !== undefined) assert.ok(Math.abs(prev + t.Volume - t.TotalVolume) < 0.02, 'totaliser continuity');
    lastTotal.set(key, t.TotalVolume);
    const pn = lastNo.get(t.Pump);
    if (pn !== undefined) assert.equal(t.Transaction, pn + 1);
    lastNo.set(t.Pump, t.Transaction);
    assert.ok(Math.abs(t.Amount - Math.round(t.Volume * t.Price * 100) / 100) < 0.011);
    sold += t.Volume;
  }
  const after = sim.tankVolumes();
  const drop = before.reduce((s, b, i) => s + b.volume - after[i].volume, 0);
  assert.ok(Math.abs(drop - sold) < 1, `tank drop ${drop} vs sold ${sold}`);
  assert.ok(packets.some((p) => p.Type === 'UploadTankMeasurement'));
  assert.ok(packets.some((p) => p.Type === 'UploadStatus'));
});

test('pump outages are temporary and never leave the station without pumps for long', () => {
  // Very frequent outages of 5-10 s, so a 10-minute run exercises many of them.
  const sim = new PtsControllerSim({
    ptsId: PTS, pumps: 4, tanks: 2, rate: 1, seed: 7, alertProbability: 0.3, pumpOutageMinS: 5, pumpOutageMaxS: 10,
  });
  const start = Date.UTC(2026, 10, 27, 8, 0, 0);
  const packets = run(sim, 600, start);
  const events = packets
    .filter((p) => p.Type === 'UploadAlertRecord' && String((p.Data as Record<string, unknown>).Type).startsWith('Pump'))
    .map((p) => p.Data as { DeviceNumber: number; Type: string; DateTime: string });
  assert.ok(events.filter((e) => e.Type === 'PumpOffline').length > 20, 'expected many outages');
  const offlineSince = new Map<number, number>();
  for (const e of events) {
    const at = Date.parse(e.DateTime + 'Z') - 2 * 3600_000; // PTS local time (UTC+2) -> UTC
    if (e.Type === 'PumpOffline') {
      assert.ok(!offlineSince.has(e.DeviceNumber), `pump ${e.DeviceNumber} went offline twice without coming back`);
      offlineSince.set(e.DeviceNumber, at);
    } else {
      const since = offlineSince.get(e.DeviceNumber);
      assert.ok(since !== undefined, `pump ${e.DeviceNumber} came online without having gone offline`);
      assert.ok(at - since <= 11_000, `pump ${e.DeviceNumber} was offline ${(at - since) / 1000}s (max 10s + 1 tick)`);
      offlineSince.delete(e.DeviceNumber);
    }
  }
  // Sales keep flowing across pumps instead of collapsing onto one.
  const pumpsWithSales = new Set(
    packets.filter((p) => p.Type === 'UploadPumpTransaction').map((p) => (p.Data as { Pump: number }).Pump),
  );
  assert.equal(pumpsWithSales.size, 4);
});

test('fault injection breaks totaliser continuity', () => {
  const sim = new PtsControllerSim({ ptsId: PTS, rate: 2, seed: 7, faultInject: 0.5 });
  const tx = run(sim, 60).filter((p) => p.Type === 'UploadPumpTransaction').map((p) => p.Data as Record<string, number>);
  const last = new Map<string, number>();
  let gaps = 0;
  for (const t of tx) {
    const key = `${t.Pump}:${t.Nozzle}`;
    const prev = last.get(key);
    if (prev !== undefined && t.TotalVolume - t.Volume - prev > 0.5) gaps++;
    last.set(key, t.TotalVolume);
  }
  assert.ok(sim.stats.faultsInjected > 0 && gaps > 0);
});

test('low tank triggers delivery and alarm', () => {
  const sim = new PtsControllerSim({
    ptsId: PTS, rate: 0, seed: 1, tankConfigs: [{ no: 1, gradeId: 1, capacityL: 30000, initialL: 2500 }],
  });
  const packets = run(sim, 5);
  assert.ok(packets.some((p) => p.Type === 'UploadInTankDelivery'));
  assert.ok(packets.some((p) => p.Type === 'UploadAlertRecord' && (p.Data as { Type: string }).Type === 'CriticalLowProduct'));
});

test('unconfirmed packets are kept and resent with the same Id', () => {
  const sim = new PtsControllerSim({ ptsId: PTS, rate: 1, seed: 3 });
  sim.tick(Date.UTC(2026, 10, 27, 8, 0, 0));
  const r1 = sim.takeRequest()!;
  sim.confirm(null); // server down
  const r2 = sim.takeRequest()!;
  assert.deepEqual(r2.Packets.map((p) => p.Id), r1.Packets.map((p) => p.Id));
  sim.confirm({ Packets: [{ Id: r1.Packets[0].Id, Error: false }, ...r1.Packets.slice(1).map((p) => ({ Id: p.Id, Error: true }))] });
  const r3 = sim.takeRequest();
  assert.equal(r3?.Packets[0].Id ?? null, r1.Packets[1]?.Id ?? null);
  assert.ok(sim.stats.packetsResent > 0);
});
