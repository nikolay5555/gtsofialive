const assert = require('node:assert/strict');
const {
  normalizeRouteRef,
  determineRouteType,
  determineRouteColor
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

// The static GTFS feed still labels replacement buses with trolley blue.
// Their displayed colors must follow the normalized mode, not route_color.
for (const routeRef of ['60', '73', '74', '123', 'E186', '288', '801', '84', '184']) {
  const type = determineRouteType(routeRef, '11');
  assert.equal(determineRouteColor(routeRef, type, '27AAE1'), '#BE1E2D', `${routeRef} pill and polyline must be bus red`);
}
assert.equal(determineRouteColor('4', 'trolley', '27AAE1'), '#27AAE1', 'real trolley lines remain blue');
assert.equal(determineRouteColor('5', 'tram', 'BE1E2D'), '#F7941D', 'tram lines use the tram palette');
assert.equal(determineRouteColor('M1', 'metro', 'EB2227'), '#EB2227', 'metro keeps its feed line color');
assert.equal(determineRouteColor('N1', 'bus', '000000'), '#000000', 'night buses keep their black color');
assert.equal(determineRouteColor('60', 'bus', '27AAE1', '123456'), '#123456', 'explicit route color overrides remain supported');

console.log('route-type-utils: all tests passed');
