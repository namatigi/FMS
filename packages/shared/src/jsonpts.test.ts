import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJsonPtsPacket, ptsTime, jsonPtsReply, alarmsToAlerts, JsonPtsMappingError } from './jsonpts.js';
import { verifyPtsSignature, hmacSha256Hex, signWebhook } from './security.js';

const PTS = '003B00265030500420303531';

test('ptsTime converts Lusaka local time to UTC', () => {
  assert.equal(ptsTime('2026-11-27T10:15:30'), '2026-11-27T08:15:30.000Z');
  assert.equal(ptsTime('2026-11-27 10:15:30'), '2026-11-27T08:15:30.000Z');
  assert.equal(ptsTime('2026-11-27T10:15:30Z'), '2026-11-27T10:15:30.000Z');
  assert.equal(ptsTime(''), null);
});

test('UploadPumpTransaction is normalised', () => {
  const r = normalizeJsonPtsPacket(PTS, {
    Id: 1,
    Type: 'UploadPumpTransaction',
    Data: {
      DateTimeStart: '2026-11-27T10:00:00', DateTime: '2026-11-27T10:01:30', Pump: 3, Nozzle: 1,
      FuelGradeId: 1, FuelGradeName: 'Petrol', Transaction: 1234, Volume: 20.5, TCVolume: 20.31,
      Price: 31.85, Amount: 652.93, TotalVolume: 123456.78, TotalAmount: 3500000.5, Tag: '', UserId: 1,
    },
  });
  assert.ok(r && r.kind === 'pump_transaction');
  assert.equal(r.data.pump_no, 3);
  assert.equal(r.data.pts_transaction_no, 1234);
  assert.equal(r.data.ended_at, '2026-11-27T08:01:30.000Z');
  assert.equal(r.data.tag, null);
  assert.equal(r.data.total_volume_l, 123456.78);
});

test('tolerates lower-case keys and string numbers', () => {
  const r = normalizeJsonPtsPacket(PTS, {
    Id: 2, Type: 'UploadTankMeasurement',
    Data: { datetime: '2026-11-27T10:00:00', tank: '2', productvolume: '15000.5', Alarms: ['HighWater'] },
  });
  assert.ok(r && r.kind === 'tank_measurement');
  assert.equal(r.data.tank_no, 2);
  assert.equal(r.data.product_volume_l, 15000.5);
  const alerts = alarmsToAlerts(r.data);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'warning');
});

test('in-tank delivery accepts nested and flat formats', () => {
  const nested = normalizeJsonPtsPacket(PTS, {
    Id: 3, Type: 'UploadInTankDelivery',
    Data: { Tank: 1, StartMeasurement: { DateTime: '2026-11-27T09:00:00', ProductVolume: 5000 },
            EndMeasurement: { DateTime: '2026-11-27T09:40:00', ProductVolume: 20000 } },
  });
  const flat = normalizeJsonPtsPacket(PTS, {
    Id: 4, Type: 'UploadInTankDelivery',
    Data: { Tank: 1, StartDateTime: '2026-11-27T09:00:00', EndDateTime: '2026-11-27T09:40:00',
            StartProductVolume: 5000, EndProductVolume: 20000 },
  });
  for (const r of [nested, flat]) {
    assert.ok(r && r.kind === 'tank_delivery');
    assert.equal(r.data.start_volume_l, 5000);
    assert.equal(r.data.end_volume_l, 20000);
    assert.equal(r.data.started_at, '2026-11-27T07:00:00.000Z');
  }
});

test('malformed and unknown packets throw; GPS/config are ignored', () => {
  assert.throws(() => normalizeJsonPtsPacket(PTS, { Id: 5, Type: 'UploadPumpTransaction', Data: { Pump: 1 } }), JsonPtsMappingError);
  assert.throws(() => normalizeJsonPtsPacket(PTS, { Id: 6, Type: 'Bogus' }), JsonPtsMappingError);
  assert.equal(normalizeJsonPtsPacket(PTS, { Id: 7, Type: 'UploadGpsRecord', Data: {} }), null);
});

test('reply and signatures', () => {
  const reply = jsonPtsReply([{ id: 1, ok: true }, { id: 2, ok: false, message: 'bad' }]);
  assert.deepEqual(reply.Packets.map((p) => [p.Id, p.Error, p.Message]), [[1, false, 'OK'], [2, true, 'bad']]);
  const body = '{"Protocol":"jsonPTS"}';
  assert.ok(verifyPtsSignature('s3cret', body, hmacSha256Hex('s3cret', body)));
  assert.ok(!verifyPtsSignature('s3cret', body, hmacSha256Hex('other', body)));
  assert.ok(!verifyPtsSignature('s3cret', body, undefined));
  assert.match(signWebhook('k', '{}', 1700000000), /^t=1700000000,v1=[0-9a-f]{64}$/);
});
