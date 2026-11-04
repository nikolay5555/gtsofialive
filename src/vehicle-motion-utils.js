(function (root) {
  'use strict';

  const MAX_SPEED_MPS = {
    bus: 30,
    tram: 24,
    trolley: 24,
    metro: 38,
    other: 30
  };
  const MIN_MOVEMENT_METERS = 4;
  const MAX_HEADING_DIFFERENCE = 140;
  const DEFAULT_STALE_AFTER_MS = 120_000;

  function distanceMeters(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return Infinity;
    const lat1 = Number(a[0]);
    const lon1 = Number(a[1]);
    const lat2 = Number(b[0]);
    const lon2 = Number(b[1]);
    if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;

    const rad = Math.PI / 180;
    const phi1 = lat1 * rad;
    const phi2 = lat2 * rad;
    const dPhi = (lat2 - lat1) * rad;
    const dLambda = (lon2 - lon1) * rad;
    const h = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  }

  function bearingBetween(a, b) {
    const rad = Math.PI / 180;
    const lat1 = Number(a[0]) * rad;
    const lat2 = Number(b[0]) * rad;
    const dLon = (Number(b[1]) - Number(a[1])) * rad;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function angleDifference(a, b) {
    return Math.abs(((Number(a) - Number(b) + 540) % 360) - 180);
  }

  /**
   * A vehicle that has timed out starts a new position session. Its next valid
   * live coordinate must not be compared with old coordinates, timestamps or
   * heading data, otherwise the normal anti-jitter filters can reject it forever.
   * Composed tram units are hidden intentionally and are not considered inactive
   * unless their source timestamp has also expired.
   */
  function shouldResetVehiclePosition(previous, now = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS) {
    if (!previous) return false;
    if (previous.hidden === true && previous.hiddenReason !== 'composed') return true;
    const timestamp = Number(previous.timestamp);
    if (!Number.isFinite(timestamp)) return true;
    return (now / 1000 - timestamp) > (Number(staleAfterMs) / 1000);
  }

  /**
   * Checks whether a live position is safe to apply.
   *
   * Older/outlier positions are rejected completely. Tiny GPS drift is accepted
   * as a live update, but the previous coordinates are retained so a stopped
   * vehicle does not visibly shake around one point.
   */
  function validateVehiclePosition(previous, incoming, now = Date.now(), options = {}) {
    if (!previous || !incoming) return { accept: true, preserveCoords: false };

    const staleAfterMs = Number.isFinite(Number(options.staleAfterMs))
      ? Number(options.staleAfterMs)
      : DEFAULT_STALE_AFTER_MS;
    if (shouldResetVehiclePosition(previous, now, staleAfterMs)) {
      return {
        accept: true,
        preserveCoords: false,
        resetMotion: true,
        reason: 'resumed-after-timeout'
      };
    }

    const previousCoords = previous.coords;
    const incomingCoords = incoming.coords;
    if (!Array.isArray(previousCoords) || !Array.isArray(incomingCoords)) {
      return { accept: true, preserveCoords: false };
    }

    const previousTimestamp = Number(previous.positionTimestamp ?? previous.timestamp);
    const incomingTimestamp = Number(incoming.timestamp);
    const hasPreviousTimestamp = previous.hasSourceTimestamp && Number.isFinite(previousTimestamp);
    const hasIncomingTimestamp = incoming.hasSourceTimestamp && Number.isFinite(incomingTimestamp);

    if (hasPreviousTimestamp && hasIncomingTimestamp && incomingTimestamp < previousTimestamp - 0.25) {
      return { accept: false, reason: 'out-of-order-timestamp' };
    }

    const distance = distanceMeters(previousCoords, incomingCoords);
    if (!Number.isFinite(distance)) return { accept: false, reason: 'invalid-distance' };

    // Do not animate GPS noise. Retain the last accepted position while still
    // allowing the rest of the live vehicle record to refresh.
    if (distance < MIN_MOVEMENT_METERS) {
      return {
        accept: true,
        preserveCoords: true,
        preservePositionTimestamp: true,
        reason: 'gps-drift'
      };
    }

    const wallElapsed = Math.max(0, (now - Number(previous.lastSeenAt || now)) / 1000);
    const sourceElapsed = hasPreviousTimestamp && hasIncomingTimestamp
      ? incomingTimestamp - previousTimestamp
      : 0;
    const elapsed = Math.max(0.25, sourceElapsed > 0 ? sourceElapsed : wallElapsed);
    const vehicleType = String(incoming.type || previous.type || 'other').toLowerCase();
    const maxSpeed = MAX_SPEED_MPS[vehicleType] || MAX_SPEED_MPS.other;
    // Small allowance covers normal GPS accuracy and differences between the
    // feed timestamp and the instant at which the packet reaches the browser.
    const maxPlausibleDistance = 18 + maxSpeed * elapsed;

    if (distance > maxPlausibleDistance) {
      return {
        accept: false,
        reason: 'implausible-position-jump',
        distance,
        elapsed,
        maxPlausibleDistance
      };
    }

    const speedKmh = Number(incoming.speed ?? previous.speed);
    const incomingBearing = incoming.bearing;
    const hasIncomingBearing = incomingBearing !== null && incomingBearing !== undefined &&
      Number.isFinite(Number(incomingBearing));
    // Some realtime records omit bearing. In that case, use the last accepted
    // course as a conservative reference to catch a sudden GPS rollback.
    const previousBearing = previous.bearing;
    const hasPreviousBearing = previousBearing !== null && previousBearing !== undefined &&
      Number.isFinite(Number(previousBearing));
    const headingReference = hasIncomingBearing ? Number(incomingBearing)
      : (hasPreviousBearing ? Number(previousBearing) : null);
    const movingAtRoadSpeed = (Number.isFinite(speedKmh) && speedKmh >= 8) ||
      (Number.isFinite(Number(previous.speed)) && Number(previous.speed) >= 8);

    if (distance >= 25 && movingAtRoadSpeed && headingReference !== null) {
      const movementBearing = bearingBetween(previousCoords, incomingCoords);
      if (angleDifference(movementBearing, headingReference) > MAX_HEADING_DIFFERENCE) {
        return {
          accept: false,
          reason: 'position-opposes-reported-heading',
          distance,
          movementBearing,
          reportedBearing: headingReference
        };
      }
    }

    return { accept: true, preserveCoords: false };
  }

  const api = { distanceMeters, shouldResetVehiclePosition, validateVehiclePosition };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.GTSOFIA_VEHICLE_MOTION = api;
})(typeof window !== 'undefined' ? window : globalThis);
