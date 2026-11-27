import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimiter } from '../src/ratelimit.js';
import { localDate, tzOffsetOf } from '../src/refdata.js';
import { RecordValidationError, validateRecord } from '../src/validate.js';

test('token bucket allows burst then throttles and refills', () => {
  let now = 0;
  const rl = new RateLimiter(2, 3, () => now);
  assert.equal(rl.take('a'), 0);
  assert.equal(rl.take('a'), 0);
  assert.equal(rl.take('a'), 0);
  assert.ok(rl.take('a') > 0);
  assert.equal(rl.take('b'), 0); // separate key
  now += 500; // +1 token
  assert.equal(rl.take('a'), 0);
  assert.ok(rl.take('a') > 0);
  assert.equal(new RateLimiter(0, 0).take('x'), 0); // disabled
});

test('Africa/Lusaka offset and local business date', () => {
  assert.equal(tzOffsetOf('Africa/Lusaka'), '+02:00');
  assert.equal(localDate('2026-11-19T22:30:00.000Z', 'Africa/Lusaka'), '2026-11-20');
  assert.equal(localDate('2026-11-19T21:59:59.000Z', 'Africa/Lusaka'), '2026-11-19');
});

test('validateRecord canonicalises timestamps and rejects bad input', () => {
  const r = validateRecord({
    kind: 'alert',
    data: { pts_id: null, occurred_at: '2026-11-27T10:00:00+02:00', device_type: 'gateway', device_no: null, code: 'X', severity: 'info', message: null },
  });
  assert.equal(r.kind === 'alert' && r.data.occurred_at, '2026-11-27T08:00:00.000Z');
  assert.throws(() => validateRecord({ kind: 'alert', data: { occurred_at: 'x' } }), RecordValidationError);
  assert.throws(() => validateRecord({ kind: 'pump_transaction', data: { pts_id: 'a', pts_transaction_no: 1.5 } }), RecordValidationError);
  assert.throws(() => validateRecord(null), RecordValidationError);
});
