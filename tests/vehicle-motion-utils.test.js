const assert = require('node:assert/strict');
const { validateVehiclePosition, shouldResetVehiclePosition, distanceMeters } = require('../src/vehicle-motion-utils');

const now = 1_800_000_000_000;
const base = {
  id: 'tram-1',
  type: 'tram',
  coords: [42.6977, 23.3219],
  timestamp: now / 1000,
  positionTimestamp: now / 1000,
  hasSourceTimestamp: true,
  lastSeenAt: now,
  speed: 25,
  bearing: 90
};

function atEastMeters(origin, meters) {
  return [origin[0], origin[1] + meters / (111320 * Math.cos(origin[0] * Math.PI / 180))];
}

// A delayed older packet must not move a vehicle back to a previous location.
{
  const previous = { ...base, coords: atEastMeters(base.coords, 60), timestamp: base.timestamp + 8, positionTimestamp: base.positionTimestamp + 8 };
  const stale = { ...base, timestamp: base.timestamp + 3 };
  const result = validateVehiclePosition(previous, stale, now + 8_000);
  assert.equal(result.accept, false);
  assert.equal(result.reason, 'out-of-order-timestamp');
}

// A location jump that would require an impossible speed is rejected.
{
  const jump = { ...base, coords: atEastMeters(base.coords, 220), timestamp: base.timestamp + 2 };
  const result = validateVehiclePosition(base, jump, now + 2_000);
  assert.equal(result.accept, false);
  assert.equal(result.reason, 'implausible-position-jump');
}

// A large jump backwards against the reported direction is rejected.
{
  const previous = { ...base, coords: atEastMeters(base.coords, 45), timestamp: base.timestamp + 2, positionTimestamp: base.positionTimestamp + 2, bearing: 90 };
  const reverse = { ...base, coords: base.coords, timestamp: base.timestamp + 4, bearing: 90, speed: 25 };
  const result = validateVehiclePosition(previous, reverse, now + 4_000);
  assert.equal(result.accept, false);
  assert.equal(result.reason, 'position-opposes-reported-heading');
}

// A small stationary GPS drift refreshes the record but retains the old point.
{
  const drift = { ...base, coords: atEastMeters(base.coords, 2), timestamp: base.timestamp + 1 };
  const result = validateVehiclePosition(base, drift, now + 1_000);
  assert.equal(result.accept, true);
  assert.equal(result.preserveCoords, true);
  assert.equal(result.preservePositionTimestamp, true);
}


// If the current feed omits bearing, the last accepted course still protects
// against a sudden rollback while the vehicle is moving.
{
  const previous = { ...base, coords: atEastMeters(base.coords, 45), timestamp: base.timestamp + 2, positionTimestamp: base.positionTimestamp + 2, bearing: 90 };
  const reverseWithoutBearing = { ...base, coords: base.coords, timestamp: base.timestamp + 4, bearing: null, speed: 25 };
  const result = validateVehiclePosition(previous, reverseWithoutBearing, now + 4_000);
  assert.equal(result.accept, false);
  assert.equal(result.reason, 'position-opposes-reported-heading');
}

// A normal short movement in the reported direction is accepted.
{
  const forward = { ...base, coords: atEastMeters(base.coords, 20), timestamp: base.timestamp + 2, bearing: 90 };
  const result = validateVehiclePosition(base, forward, now + 2_000);
  assert.equal(result.accept, true);
  assert.equal(result.preserveCoords, false);
}

// Metro uses a higher plausible speed allowance than surface transport.
{
  const metro = { ...base, type: 'metro', coords: atEastMeters(base.coords, 90), timestamp: base.timestamp + 2, bearing: 90 };
  const result = validateVehiclePosition(base, metro, now + 2_000);
  assert.equal(result.accept, true);
}


// After the 120-second timeout, the next fresh packet starts a new tracking
// session and must not be rejected against the previous position or heading.
{
  const stale = {
    ...base,
    timestamp: base.timestamp - 121,
    positionTimestamp: base.positionTimestamp - 121,
    lastSeenAt: now - 121_000,
    hidden: true,
    hiddenReason: 'timeout'
  };
  const resumed = {
    ...base,
    coords: atEastMeters(base.coords, 500),
    timestamp: base.timestamp + 1,
    positionTimestamp: base.positionTimestamp + 1,
    bearing: 270
  };
  assert.equal(shouldResetVehiclePosition(stale, now, 120_000), true);
  const result = validateVehiclePosition(stale, resumed, now, { staleAfterMs: 120_000 });
  assert.equal(result.accept, true);
  assert.equal(result.resetMotion, true);
  assert.equal(result.reason, 'resumed-after-timeout');
}

// The timeout cleanup may run just before a new packet arrives. Its hidden
// marker is enough to reset the position session, even at the threshold edge.
{
  const hidden = { ...base, hidden: true, hiddenReason: 'timeout' };
  assert.equal(shouldResetVehiclePosition(hidden, now, 120_000), true);
  const resumed = { ...base, coords: atEastMeters(base.coords, 350), timestamp: base.timestamp + 1 };
  const result = validateVehiclePosition(hidden, resumed, now, { staleAfterMs: 120_000 });
  assert.equal(result.accept, true);
  assert.equal(result.resetMotion, true);
}

// Coupled tram wagons are intentionally hidden and must keep normal movement
// validation while their feed timestamps remain fresh.
{
  const composed = { ...base, hidden: true, hiddenReason: 'composed' };
  assert.equal(shouldResetVehiclePosition(composed, now + 2_000, 120_000), false);
  const next = { ...base, coords: atEastMeters(base.coords, 20), timestamp: base.timestamp + 2 };
  const result = validateVehiclePosition(composed, next, now + 2_000, { staleAfterMs: 120_000 });
  assert.equal(result.accept, true);
  assert.equal(result.resetMotion, undefined);
}

assert.ok(distanceMeters(base.coords, atEastMeters(base.coords, 20)) > 19);
console.log('vehicle-motion-utils: all tests passed');
