(function (root) {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 120_000;
  const MIN_RESUME_MOVEMENT_METERS = 4;

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
    const h = Math.sin(dPhi / 2) ** 2 +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  }

  function lastLiveAtMs(vehicle) {
    if (!vehicle) return NaN;
    const liveAt = vehicle.lastLiveAt;
    if (liveAt !== null && liveAt !== undefined && liveAt !== '' && Number.isFinite(Number(liveAt))) {
      return Number(liveAt);
    }
    const seenAt = vehicle.lastSeenAt;
    if (seenAt !== null && seenAt !== undefined && seenAt !== '' && Number.isFinite(Number(seenAt))) {
      return Number(seenAt);
    }
    const timestamp = vehicle.timestamp;
    return timestamp !== null && timestamp !== undefined && timestamp !== '' && Number.isFinite(Number(timestamp))
      ? Number(timestamp) * 1000
      : NaN;
  }

  function isVehicleFresh(vehicle, now = Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS) {
    const lastLiveAt = lastLiveAtMs(vehicle);
    return Number.isFinite(lastLiveAt) && now - lastLiveAt <= timeoutMs;
  }

  function isTimedOut(previous, now, timeoutMs) {
    if (!previous) return false;
    if (previous.hidden === true && previous.hiddenReason !== 'composed') return true;
    return !isVehicleFresh(previous, now, timeoutMs);
  }

  /**
   * The reference map applies each incoming vehicle record directly to its
   * cache entry. This mirrors that "last snapshot wins" behavior while keeping
   * the 120-second expiry. A timed-out vehicle can resume at a changed position
   * even when the upstream timestamp is absent or has not been refreshed.
   */
  function assessIncomingVehicle(previous, incoming, now = Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS) {
    const previousTimedOut = isTimedOut(previous, now, timeoutMs);
    const hasSourceTimestamp = incoming?.hasSourceTimestamp === true &&
      Number.isFinite(Number(incoming.timestamp));
    const sourceTimestamp = hasSourceTimestamp ? Number(incoming.timestamp) : null;
    const sourceAgeMs = hasSourceTimestamp ? now - sourceTimestamp * 1000 : 0;
    const sourceIsStale = hasSourceTimestamp && sourceAgeMs > timeoutMs;

    if (sourceIsStale) {
      const movedMeters = previous
        ? distanceMeters(previous.coords, incoming.coords)
        : 0;

      // Do not resurrect a vehicle from a repeated stale record at the same
      // location. But if it has actually moved after timing out, accept that
      // position as the start of a new tracking session.
      const canResumeAfterTimeout = previousTimedOut && movedMeters >= MIN_RESUME_MOVEMENT_METERS;
      const canContinueReceiptClock = previous?.usesReceiptClock === true &&
        movedMeters >= MIN_RESUME_MOVEMENT_METERS;

      if (!canResumeAfterTimeout && !canContinueReceiptClock) {
        return {
          accept: false,
          resetMotion: false,
          refreshAt: null,
          reason: 'stale-source-snapshot'
        };
      }

      return {
        accept: true,
        resetMotion: canResumeAfterTimeout,
        refreshAt: now,
        useReceiptTimestamp: true,
        reason: canResumeAfterTimeout ? 'resumed-with-new-position' : 'position-updated-on-receipt-clock'
      };
    }

    return {
      accept: true,
      resetMotion: previousTimedOut,
      refreshAt: hasSourceTimestamp ? Math.min(now, sourceTimestamp * 1000) : now,
      useReceiptTimestamp: !hasSourceTimestamp,
      reason: previousTimedOut ? 'resumed-after-timeout' : 'current-snapshot'
    };
  }

  const api = { distanceMeters, isVehicleFresh, assessIncomingVehicle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.GTSOFIA_VEHICLE_SESSION = api;
})(typeof window !== 'undefined' ? window : globalThis);
