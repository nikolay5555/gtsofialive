const assert = require('node:assert/strict');
const {
  isVehicleFresh,
  assessIncomingVehicle,
  distanceMeters
} = require('../src/vehicle-session-utils');

const now = 1_800_000_000_000;
const timeout = 120_000;
const baseCoords = [42.6977, 23.3219];

function eastMeters(origin, meters) {
  return [
    origin[0],
    origin[1] + meters / (111320 * Math.cos(origin[0] * Math.PI / 180))
  ];
}

function vehicle(overrides = {}) {
  return {
    id: 'tram-1',
    type: 'tram',
    coords: baseCoords,
    timestamp: now / 1000,
    hasSourceTimestamp: true,
    lastSeenAt: now,
    lastLiveAt: now,
    hidden: false,
    hiddenReason: null,
    ...overrides
  };
}

// The 120-second timeout is still enforced from the last live evidence.
{
  const stale = vehicle({ lastLiveAt: now - timeout - 1, hidden: true, hiddenReason: 'timeout' });
  assert.equal(isVehicleFresh(stale, now, timeout), false);
  assert.equal(isVehicleFresh(vehicle(), now, timeout), true);
}

// A fresh timestamp from the upstream feed reactivates the same cached vehicle.
{
  const previous = vehicle({ lastLiveAt: now - timeout - 1, hidden: true, hiddenReason: 'timeout' });
  const incoming = vehicle({ coords: eastMeters(baseCoords, 250), timestamp: now / 1000 + 1 });
  const result = assessIncomingVehicle(previous, incoming, now, timeout);
  assert.equal(result.accept, true);
  assert.equal(result.resetMotion, true);
  assert.equal(result.reason, 'resumed-after-timeout');
}

// If the source timestamp is stale but the vehicle has moved since timeout,
// accept the new position and switch to a local receipt clock for this session.
{
  const previous = vehicle({
    timestamp: now / 1000 - 180,
    lastLiveAt: now - timeout - 1,
    hidden: true,
    hiddenReason: 'timeout'
  });
  const incoming = vehicle({
    coords: eastMeters(baseCoords, 320),
    timestamp: now / 1000 - 180
  });
  const result = assessIncomingVehicle(previous, incoming, now, timeout);
  assert.equal(result.accept, true);
  assert.equal(result.resetMotion, true);
  assert.equal(result.useReceiptTimestamp, true);
  assert.equal(result.refreshAt, now);
}

// A repeated stale packet at the old location must not resurrect the vehicle.
{
  const previous = vehicle({
    timestamp: now / 1000 - 180,
    lastLiveAt: now - timeout - 1,
    hidden: true,
    hiddenReason: 'timeout'
  });
  const incoming = vehicle({ timestamp: now / 1000 - 180 });
  const result = assessIncomingVehicle(previous, incoming, now, timeout);
  assert.equal(result.accept, false);
  assert.equal(result.reason, 'stale-source-snapshot');
}

// Once in receipt-clock mode, meaningful position updates keep tracking even
// if the source timestamp field remains stale; no new packet means timeout.
{
  const previous = vehicle({
    usesReceiptClock: true,
    timestamp: now / 1000 - 180,
    lastLiveAt: now - 10_000
  });
  const incoming = vehicle({
    coords: eastMeters(baseCoords, 18),
    timestamp: now / 1000 - 180
  });
  const result = assessIncomingVehicle(previous, incoming, now, timeout);
  assert.equal(result.accept, true);
  assert.equal(result.resetMotion, false);
  assert.equal(result.useReceiptTimestamp, true);
  assert.equal(result.refreshAt, now);
}

// Records without a source timestamp use arrival time, as the reference map
// effectively does when it directly overwrites a cache entry.
{
  const incoming = vehicle({ hasSourceTimestamp: false, timestamp: null });
  const result = assessIncomingVehicle(null, incoming, now, timeout);
  assert.equal(result.accept, true);
  assert.equal(result.useReceiptTimestamp, true);
  assert.equal(result.refreshAt, now);
}

// Intentionally hidden composed tram units are not treated as timed out.
{
  const composed = vehicle({ hidden: true, hiddenReason: 'composed' });
  const result = assessIncomingVehicle(composed, vehicle({ coords: eastMeters(baseCoords, 10) }), now, timeout);
  assert.equal(result.accept, true);
  assert.equal(result.resetMotion, false);
}

assert.ok(distanceMeters(baseCoords, eastMeters(baseCoords, 20)) > 19);
console.log('vehicle-session-utils: all tests passed');
