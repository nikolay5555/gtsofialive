const assert = require('node:assert/strict');
const {
  normalizeRouteRef,
  determineRouteType
} = require('../src/route-type-utils');

assert.equal(normalizeRouteRef('E186'), '186');
assert.equal(normalizeRouteRef('Е186'), '186');
assert.equal(normalizeRouteRef('N1'), 'N1');
assert.equal(normalizeRouteRef('Y1'), 'У1');
assert.equal(normalizeRouteRef('3TM'), '3ТМ');
assert.equal(normalizeRouteRef('1Tb'), '1ТБ');

// All GTFS routes of type 11 numbered 50+ are buses in the main GTSofia app.
for (const routeRef of ['60', '73', '74', '123', 'E186', '288', '801', '84', '184']) {
  assert.equal(determineRouteType(routeRef, '11'), 'bus', `${routeRef} must be a bus`);
}

// Actual trolleybus lines remain trolleybuses.
for (const routeRef of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '11']) {
  assert.equal(determineRouteType(routeRef, '11'), 'trolley', `${routeRef} must remain a trolleybus`);
}

// Preserve non-trolley GTFS modes and special replacement labels.
assert.equal(determineRouteType('5', '0'), 'tram');
assert.equal(determineRouteType('M1', '1'), 'metro');
assert.equal(determineRouteType('M3', '3'), 'bus');
assert.equal(determineRouteType('3ТМ', '11'), 'bus');
assert.equal(determineRouteType('12ТБ', '11'), 'bus');

console.log('route-type-utils: all tests passed');
