(() => {
  'use strict';

  const CONFIG = window.GTSOFIA_LIVEMAP_CONFIG || {};
  const SOFIA_CENTER = CONFIG.mapCenter || [42.6977, 23.3219];
  const SOFIA_ZOOM = CONFIG.mapZoom || 13;
  const STALE_AFTER = CONFIG.refreshStaleAfterMs || 120_000;
  const STALE_AFTER_SECONDS = STALE_AFTER / 1000;
  const RECONNECT_DELAY = CONFIG.reconnectDelayMs || 2500;
  const MIN_ACTIVE_SPEED = Number(CONFIG.minActiveSpeed) || 3;
  const TYPE_NAMES = { bus: 'Автобус', tram: 'Трамвай', trolley: 'Тролей', metro: 'Метро', other: 'Транспорт' };
  const TYPE_COLORS = { bus: '#BE1E2D', tram: '#F7941D', trolley: '#27AAE1', metro: '#1C75BC', other: '#111827' };
  const METRO_LINE_COLORS = { M1: '#EB2227', M2: '#1C75BC', M3: '#39B54A', M4: '#FFDE17' };
  const FAKE_TROLLEY_ROUTES = new Set(['60', '73', '74', '123', '288', '801']);

  const state = {
    map: null,
    lightTiles: null,
    darkTiles: null,
    activeTiles: null,
    routeLayer: null,
    selectedVehicleRouteLayer: null,
    stopLayer: null,
    vehicleLayer: null,
    data: null,
    routes: [],
    selectableRoutes: [],
    routesById: new Map(),
    routesByLooseId: new Map(),
    routesByCgmId: new Map(),
    routesByRef: new Map(),
    lineFilterItems: [],
    overridesByCgmId: new Map(),
    overridesByRouteRef: new Map(),
    stops: [],
    stopsByKey: new Map(),
    vehicles: new Map(),
    tramCompositions: [],
    expectedModelRules: [],
    depotRules: [],
    socket: null,
    socketGeneration: 0,
    reconnectTimer: null,
    source: 'gtfs',
    view: 'vehicles',
    selectedType: 'all',
    selectedRoute: 'all',
    query: '',
    showStops: false,
    showRoute: true,
    userMarker: null,
    lastSnapshotAt: null,
    renderFrame: null,
    vehicleAnimationFrame: null,
    selectedVehicleId: null,
    selectedVehicleRouteSignature: null,
    toastTimer: null
  };

  const $ = (id) => document.getElementById(id);
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const hasFinite = (value) => value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value));
  const cleanValue = (value) => {
    if (value === null || value === undefined) return '';
    const text = String(value).trim();
    return /^(null|undefined|n\/a)$/i.test(text) ? '' : text;
  };
  const firstClean = (...values) => {
    for (const value of values) {
      const cleaned = cleanValue(value);
      if (cleaned) return cleaned;
    }
    return '';
  };
  const hasOwnAny = (object, keys) => keys.some((key) => Object.prototype.hasOwnProperty.call(object || {}, key));
  const lineOverrides = () => state.data?.lineOverrides || [];
  const getOverride = (routeId) => state.overridesByCgmId.get(String(routeId ?? '')) || null;

  function normaliseRef(value) {
    return String(value ?? '').trim().replace(/\s+/g, '').toUpperCase();
  }

  function routeType(route) {
    if (!route) return 'other';
    const routeId = String(route.route_id ?? '');
    const shortName = String(route.route_short_name ?? '');
    const override = getOverride(routeId) || state.overridesByRouteRef?.get(normaliseRef(shortName));
    if (override?.type) return String(override.type).toLowerCase() === 'trolleybus' ? 'trolley' : String(override.type).toLowerCase();
    switch (String(route.route_type)) {
      case '0': return 'tram';
      case '1': return 'metro';
      case '3': return 'bus';
      case '11': return 'trolley';
      default: return 'other';
    }
  }

  function routeRef(route) {
    if (!route) return '';
    const override = getOverride(route.route_id) || state.overridesByRouteRef?.get(normaliseRef(route.route_short_name));
    let ref = String(override?.route_ref || route.route_short_name || '').trim();
    const number = ref.replace(/[a-zа-я]/gi, '');
    if (/^E/i.test(ref)) ref = number;
    else if (/^N/i.test(ref)) ref = `N${number}`;
    else if (/^Y/i.test(ref)) ref = `У${number}`;
    return ref;
  }

  function routeColor(route, ref, type) {
    const routeId = String(route?.route_id ?? '');
    const override = getOverride(routeId) || state.overridesByRouteRef?.get(normaliseRef(ref));
    if (String(ref || '').toUpperCase().startsWith('N')) return '#000000';
    if (override?.color) return String(override.color).startsWith('#') ? String(override.color) : `#${override.color}`;
    const metroColor = METRO_LINE_COLORS[normaliseRef(ref)];
    if (normaliseTransportType(type) === 'metro' && metroColor) return metroColor;
    // Match the line-color rules used by GTSofia: when an override masks the
    // source mode (for example, a temporary bus replacing a trolley), use the
    // displayed mode's color instead of the original GTFS color.
    if (!override?.type && route?.route_color) {
      const source = String(route.route_color).trim();
      if (/^[0-9a-f]{6}$/i.test(source)) return `#${source}`;
      if (/^#[0-9a-f]{6}$/i.test(source)) return source;
    }
    const palette = { bus: '#BE1E2D', tram: '#F7941D', trolley: '#27AAE1', metro: '#1C75BC', other: '#111827' };
    return palette[type] || palette.other;
  }

  function routeForVehicleColor(vehicle) {
    const direct = vehicle?.gtfsRouteId
      ? state.routesById.get(String(vehicle.gtfsRouteId))
      : null;
    if (direct) return direct;
    const options = vehicle?.normalizedRef
      ? (state.routesByRef.get(normaliseRef(vehicle.normalizedRef)) || [])
      : [];
    return options.find((route) => routeType(route) === vehicle.type) || (options.length === 1 ? options[0] : null);
  }

  function vehicleRouteColor(vehicle) {
    return routeColor(routeForVehicleColor(vehicle), vehicle?.routeRef, vehicle?.type || 'other');
  }

  function catalogRouteForVehicle(raw) {
    const cgmIds = [
      raw?.cgm_route_id,
      raw?.cgmRouteId,
      raw?.route?.cgm_route_id,
      raw?.route?.cgmRouteId
    ];
    for (const value of cgmIds) {
      const id = cleanValue(value);
      if (id && state.routesByCgmId.has(id)) return state.routesByCgmId.get(id);
    }

    // Some proxy snapshots use routeId/route_id for a CGM ID instead of
    // exposing cgm_route_id. Only use the catalog fallback if it is not a
    // route ID already found in the local GTFS routes table.
    const possibleId = firstClean(raw?.gtfs_route_id, raw?.gtfsRouteId,
      raw?.route_id, raw?.routeId, raw?.route?.route_id);
    if (possibleId && !state.routesById.has(possibleId)) {
      return state.routesByCgmId.get(possibleId) || null;
    }
    return null;
  }

  function prepareGTFSRecord(raw) {
    if (!raw || typeof raw !== 'object') return raw;
    const vehicle = { ...raw };
    const catalogRoute = catalogRouteForVehicle(vehicle);

    // The reference GTFS handler first resolves route_ref and type from cgm_route_id.
    const rawRef = firstClean(vehicle.route_ref, vehicle.routeRef, vehicle.route_short_name,
      vehicle.routeShortName, vehicle.line, vehicle.line_number, vehicle.lineNumber,
      vehicle.route?.route_short_name);
    if (!rawRef && catalogRoute?.route_ref) vehicle.route_ref = catalogRoute.route_ref;

    const rawType = firstClean(vehicle.type, vehicle.vehicle_type, vehicle.vehicleType,
      vehicle.transport_type, vehicle.transportType, vehicle.category,
      vehicle.route_type, vehicle.routeType, vehicle.route?.route_type, vehicle.route?.type);
    if (!rawType && catalogRoute?.type) vehicle.type = catalogRoute.type;

    const ref = firstClean(vehicle.route_ref, vehicle.routeRef, vehicle.route_short_name,
      vehicle.routeShortName, vehicle.line, vehicle.line_number, vehicle.lineNumber);
    const type = normaliseTransportType(firstClean(vehicle.type, vehicle.vehicle_type,
      vehicle.vehicleType, vehicle.transport_type, vehicle.transportType, vehicle.category,
      vehicle.route_type, vehicle.routeType, vehicle.route?.route_type, vehicle.route?.type,
      catalogRoute?.type));
    // Temporary timetable labels ending in TM/TБ are bus lines in the reference feed.
    if (type !== 'bus' && ref && /(TM|ТМ|TB|ТБ)$/i.test(ref)) vehicle.type = 'bus';

    const inventory = firstClean(vehicle.inv_number, vehicle.inventory_number,
      vehicle.inventoryNumber, vehicle.full_inv_number, vehicle.fullInventoryNumber);
    const inventoryNumber = Number.parseInt(inventory.split(/[+/]/)[0], 10);
    if (type === 'trolley' && (FAKE_TROLLEY_ROUTES.has(normaliseRef(ref)) ||
        (Number.isFinite(inventoryNumber) && inventoryNumber >= 5000 && inventoryNumber < 6000))) {
      vehicle.type = 'bus';
    }
    return vehicle;
  }

  function routeForVehicle(raw) {
    const directId = firstClean(raw?.gtfs_route_id, raw?.gtfsRouteId,
      raw?.route_id, raw?.routeId, raw?.route?.route_id);
    const direct = directId ? state.routesById.get(directId) : null;
    if (direct) return direct;

    const catalogRoute = catalogRouteForVehicle(raw);
    const ref = firstClean(raw?.route_ref, raw?.routeRef, raw?.route_short_name,
      raw?.routeShortName, raw?.line, raw?.line_number, raw?.lineNumber,
      raw?.route?.route_short_name, catalogRoute?.route_ref);
    if (!ref) return null;
    const options = state.routesByRef.get(normaliseRef(ref)) || [];
    const type = firstClean(raw?.type, catalogRoute?.type);
    if (type) {
      const typed = options.find((route) => routeType(route) === normaliseTransportType(type));
      if (typed) return typed;
    }
    return options.length === 1 ? options[0] : null;
  }

  function normaliseTransportType(value) {
    const type = cleanValue(value).toLowerCase();
    if (type === 'trolleybus') return 'trolley';
    if (type === '0') return 'tram';
    if (type === '1') return 'metro';
    if (type === '3') return 'bus';
    if (type === '11') return 'trolley';
    return type;
  }

  function toCoordinates(value) {
    if (Array.isArray(value) && value.length >= 2 && hasFinite(value[0]) && hasFinite(value[1])) {
      return [Number(value[0]), Number(value[1])];
    }
    if (value && typeof value === 'object') {
      const lat = value.lat ?? value.latitude;
      const lon = value.lon ?? value.lng ?? value.longitude;
      if (hasFinite(lat) && hasFinite(lon)) return [Number(lat), Number(lon)];
    }
    return null;
  }

  function normaliseType(rawType, ref, route, raw = {}) {
    const candidate = firstClean(rawType, raw.vehicle_type, raw.vehicleType, raw.transport_type, raw.transportType, raw.category, raw.route_type, raw.routeType).toLowerCase();
    const routeId = firstClean(raw.cgm_route_id, raw.cgmRouteId, raw.route_id, raw.routeId, raw.route?.route_id);
    const override = getOverride(routeId) || state.overridesByRouteRef?.get(normaliseRef(ref));
    const refUpper = cleanValue(ref).toUpperCase();
    const inventoryValue = firstClean(raw.inv_number, raw.inventory_number, raw.full_inv_number, raw.inventoryNumber);
    const inventoryNumber = Number.parseInt(String(inventoryValue).split(/[+/]/)[0], 10);
    let type = 'other';

    const overrideType = cleanValue(override?.type).toLowerCase();
    if (['bus', 'tram', 'trolley', 'trolleybus', 'metro'].includes(overrideType)) {
      type = overrideType === 'trolleybus' ? 'trolley' : overrideType;
    } else if (['bus', 'tram', 'trolley', 'trolleybus', 'metro'].includes(candidate)) {
      type = candidate === 'trolleybus' ? 'trolley' : candidate;
    } else if (/^(0|1|3|11)$/.test(candidate)) {
      type = ({ '0': 'tram', '1': 'metro', '3': 'bus', '11': 'trolley' })[candidate];
    } else if (/tram|трам/i.test(candidate)) {
      type = 'tram';
    } else if (/trolley|трол/i.test(candidate)) {
      type = 'trolley';
    } else if (/bus|автоб/i.test(candidate)) {
      type = 'bus';
    } else {
      type = routeType(route);
    }

    // Prefer route metadata whenever it exists, but recover mode from CGM IDs
    // when a route is missing from the static geometry subset.
    if (type === 'other') {
      if (/^TM/i.test(routeId)) type = 'tram';
      else if (/^TB/i.test(routeId)) type = 'trolley';
      else if (/^A/i.test(routeId)) type = 'bus';
      else if (/^N/i.test(refUpper)) type = 'bus';
      else if (/(TM|ТМ)$/i.test(refUpper)) type = 'bus';
      else if (/(TB|ТБ)$/i.test(refUpper)) type = 'bus';
      else if (/^(bus|tram|trolley|trolleybus|metro)$/i.test(cleanValue(raw.type))) type = cleanValue(raw.type).toLowerCase().replace('trolleybus', 'trolley');
    }

    // Timetable route labels ending in TM/TБ are special bus labels (e.g. 3ТМ).
    if (type !== 'tram' && /(TM|ТМ|TB|ТБ)$/i.test(refUpper)) type = 'bus';
    if (type === 'trolley' && (FAKE_TROLLEY_ROUTES.has(refUpper) || (Number.isFinite(inventoryNumber) && inventoryNumber >= 5000 && inventoryNumber < 6000))) type = 'bus';
    return ['bus', 'tram', 'trolley', 'metro'].includes(type) ? type : 'other';
  }

  function timestampSeconds(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
      const parsedDate = Date.parse(value);
      const seconds = Number.isFinite(parsedDate) ? parsedDate / 1000 : null;
      return seconds !== null && seconds >= 1_000_000_000 && seconds <= 10_000_000_000 ? seconds : null;
    }
    if (!hasFinite(value)) return null;
    let parsed = Number(value);
    if (parsed > 100_000_000_000) parsed /= 1000;
    // Ignore non-epoch values rather than making a stale vehicle look freshly updated.
    if (parsed < 1_000_000_000 || parsed > 10_000_000_000) return null;
    return parsed;
  }

  function normaliseVehicle(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const coords = [raw.coords, raw.coordinates, raw.position, raw.location,
      raw.lat !== undefined ? { lat: raw.lat, lon: raw.lon ?? raw.lng ?? raw.longitude } : null]
      .map(toCoordinates).find(Boolean) || null;
    if (!coords || Math.abs(coords[0]) > 90 || Math.abs(coords[1]) > 180) return null;

    const routeId = firstClean(raw.cgm_route_id, raw.cgmRouteId, raw.route_id, raw.routeId,
      raw.gtfs_route_id, raw.gtfsRouteId, raw.route?.route_id);
    const catalogRoute = catalogRouteForVehicle(raw);
    const route = routeForVehicle(raw);
    const rawId = firstClean(raw.cgm_id, raw.vehicle_id, raw.vehicleId, raw.id, raw.inv_number, raw.inventory_number, raw.full_inv_number);
    if (!rawId) return null;
    const routeIdFields = ['cgm_route_id', 'cgmRouteId', 'route_id', 'routeId', 'gtfs_route_id', 'gtfsRouteId'];
    const routeRefFields = ['route_ref', 'routeRef', 'route_short_name', 'routeShortName', 'line', 'line_number', 'lineNumber'];
    const vehicleTypeFields = ['type', 'vehicle_type', 'vehicleType', 'transport_type', 'transportType', 'category', 'route_type', 'routeType'];
    const destinationStopFields = ['destination_stop', 'destinationStop', 'destination_stop_code', 'destinationStopCode'];
    const nextStopFields = ['next_stop', 'nextStop', 'next_stop_code', 'nextStopCode'];
    const destinationFields = ['trip_headsign', 'tripHeadsign', 'destination', 'headsign'];
    const hasRouteIdField = hasOwnAny(raw, routeIdFields) || hasOwnAny(raw.route, ['route_id', 'gtfs_route_id']);
    const hasRouteRefField = hasOwnAny(raw, routeRefFields) || hasOwnAny(raw.route, ['route_short_name']);
    const hasRouteAssignmentField = hasRouteIdField || hasRouteRefField;
    const hasTypeField = hasOwnAny(raw, vehicleTypeFields) || hasOwnAny(raw.route, ['route_type']);
    const hasDestinationStopField = hasOwnAny(raw, destinationStopFields);
    const hasNextStopField = hasOwnAny(raw, nextStopFields);
    const directionIdFields = ['direction_id', 'directionId', 'direction_key', 'directionKey', 'route_direction_id', 'routeDirectionId'];
    const hasDirectionIdField = hasOwnAny(raw, directionIdFields) || /^D\d+$/i.test(cleanValue(raw.direction));
    const hasDestinationField = hasOwnAny(raw, destinationFields) || (Object.prototype.hasOwnProperty.call(raw, 'direction') && !/^D\d+$/i.test(cleanValue(raw.direction)));
    const idBasedInventory = /^\d{3,6}$/.test(rawId) ? rawId : null;
    const override = getOverride(routeId);
    const explicitRef = firstClean(raw.route_ref, raw.routeRef, raw.route_short_name, raw.routeShortName, raw.line, raw.line_number, raw.lineNumber, raw.route?.route_short_name);
    let ref = explicitRef || cleanValue(catalogRoute?.route_ref) || cleanValue(routeRef(route)) || cleanValue(override?.route_ref);
    if (!ref && routeId) {
      const fallbackRoute = state.routesById.get(routeId);
      if (fallbackRoute) ref = cleanValue(routeRef(fallbackRoute));
    }
    // An explicitly supplied but empty route assignment means the vehicle is
    // no longer serving a public line. A snapshot that omits route fields is
    // different: it is merely partial and should not erase the cached route.
    const hasExplicitNoRoute = hasRouteAssignmentField && !ref && !catalogRoute && !route;
    let type = normaliseType(firstClean(raw.type, raw.vehicle_type, raw.vehicleType, raw.transport_type, raw.transportType, raw.route_type, raw.routeType, catalogRoute?.type), ref, route, raw);
    if (type === 'other' && window.GTSOFIA_VEHICLE_MODELS?.get_vehicle_type_by_inventory) {
      const guessedType = window.GTSOFIA_VEHICLE_MODELS.get_vehicle_type_by_inventory({
        inv_number: firstClean(raw.inv_number, raw.inventory_number, raw.inventoryNumber, raw.full_inv_number, raw.fullInventoryNumber, idBasedInventory),
        cgm_id: firstClean(raw.cgm_id, raw.vehicle_id, raw.vehicleId, raw.id, rawId)
      });
      if (guessedType) type = guessedType;
    }
    const speedVal = raw.speed ?? raw.speed_kmh ?? raw.speedKmh;
    const speed = hasFinite(speedVal) ? Number(speedVal) : null;
    const timestampRaw = raw.timestamp ?? raw.updated_at ?? raw.updatedAt ?? raw.time ?? raw.last_update ?? raw.lastUpdate;
    const parsedTimestamp = timestampSeconds(timestampRaw);
    const timestamp = parsedTimestamp;
    const normalizedRef = normaliseRef(ref);
    const color = normalizedRef ? routeColor(route, normalizedRef, type) : (TYPE_COLORS[type] || TYPE_COLORS.other);
    const inventoryRaw = firstClean(raw.full_inv_number, raw.fullInventoryNumber, raw.inv_number, raw.inventory_number, raw.inventoryNumber, idBasedInventory);
    const inventory = inventoryRaw === null || inventoryRaw === undefined || cleanValue(inventoryRaw) === '' ? null : String(inventoryRaw);
    const shortInventoryRaw = firstClean(raw.inv_number, raw.inventory_number, raw.inventoryNumber, raw.full_inv_number, raw.fullInventoryNumber, idBasedInventory);
    const shortInventory = shortInventoryRaw === null || shortInventoryRaw === undefined || cleanValue(shortInventoryRaw) === '' ? null : String(shortInventoryRaw);
    const rawDestinationStop = firstClean(...destinationStopFields.map((field) => raw[field])) || null;
    const rawNextStop = firstClean(...nextStopFields.map((field) => raw[field])) || null;
    const directDirectionText = cleanValue(raw.direction);
    const destinationText = firstClean(raw.trip_headsign, raw.tripHeadsign, raw.destination, raw.headsign,
      (/^D\d+$/i.test(directDirectionText) ? '' : directDirectionText));
    const rawDirectionId = firstClean(raw.direction_id, raw.directionId, raw.direction_key, raw.directionKey, raw.route_direction_id, raw.routeDirectionId,
      /^D\d+$/i.test(directDirectionText) ? directDirectionText : '');
    let modelName = null;
    const modelApi = window.GTSOFIA_VEHICLE_MODELS;
    if (modelApi && shortInventory && ['bus', 'tram', 'trolley'].includes(type)) {
      try {
        modelName = modelApi.get_vehicle_model_name({ type, inv_number: shortInventory, cgm_id: firstClean(raw.cgm_id, raw.vehicle_id, raw.vehicleId, raw.id, rawId) }) || null;
        if (modelName === 'Неизвестен модел') modelName = null;
      } catch (error) {
        console.warn('Не успяхме да определим модела на превозното средство:', error);
      }
    }

    return {
      id: String(rawId),
      cgmId: firstClean(raw.cgm_id, raw.vehicle_id, raw.vehicleId, raw.id, rawId),
      routeId,
      gtfsRouteId: route?.route_id ? String(route.route_id) : '',
      routeRef: ref,
      normalizedRef,
      type,
      inventory,
      shortInventory,
      coords,
      speed,
      timestamp,
      hasSourceTimestamp: parsedTimestamp !== null,
      car: raw.car ?? null,
      destination: String(destinationText ?? '').trim(),
      destinationStopRef: rawDestinationStop,
      directionId: cleanValue(rawDirectionId || (/^D\d+$/i.test(cleanValue(raw.direction)) ? raw.direction : '')),
      nextStopRef: rawNextStop === null || rawNextStop === undefined || cleanValue(rawNextStop) === '' ? null : cleanValue(rawNextStop),
      occupancy: raw.occupancy ?? null,
      scheduledTime: raw.scheduled_time ?? raw.scheduledTime ?? null,
      delay: hasFinite(raw.delay) ? Number(raw.delay) : null,
      bearing: hasFinite(raw.bearing) ? Number(raw.bearing) : null,
      color,
      modelName,
      hasRouteIdField,
      hasRouteRefField,
      hasRouteAssignmentField,
      hasExplicitNoRoute,
      assignedToRoute: Boolean(ref),
      hasTypeField,
      hasDestinationStopField,
      hasNextStopField,
      hasDestinationField,
      hasDirectionIdField,
      lastSeenAt: Date.now(),
      marker: null,
      raw
    };
  }

  function distanceMetersBetween(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return Infinity;
    const rad = Math.PI / 180;
    const lat1 = Number(a[0]) * rad;
    const lat2 = Number(b[0]) * rad;
    const dLat = (Number(b[0]) - Number(a[0])) * rad;
    const dLon = (Number(b[1]) - Number(a[1])) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  }

  function vehicleDisplayCoords(vehicle, now = Date.now()) {
    const target = vehicle?.motionTo || vehicle?.coords;
    const from = vehicle?.motionFrom || vehicle?.displayCoords || target;
    if (!Array.isArray(target) || !Array.isArray(from)) return target || from || [0, 0];
    const duration = Number(vehicle.motionDuration) || 0;
    if (duration <= 0) return [Number(target[0]), Number(target[1])];
    const progress = Math.max(0, Math.min(1, (now - Number(vehicle.motionStartedAt || now)) / duration));
    // Smoothstep interpolation removes abrupt starts/stops between live snapshots.
    const eased = progress * progress * (3 - 2 * progress);
    return [
      Number(from[0]) + (Number(target[0]) - Number(from[0])) * eased,
      Number(from[1]) + (Number(target[1]) - Number(from[1])) * eased
    ];
  }

  function scheduleVehicleAnimation() {
    if (state.vehicleAnimationFrame !== null || typeof requestAnimationFrame !== 'function') return;
    state.vehicleAnimationFrame = requestAnimationFrame(animateVehiclePositions);
  }

  function animateVehiclePositions() {
    state.vehicleAnimationFrame = null;
    const now = Date.now();
    let hasMoreMovement = false;
    for (const vehicle of state.vehicles.values()) {
      if (!(Number(vehicle.motionDuration) > 0)) continue;
      // Animate only markers currently rendered on the map. Off-screen/filtered
      // vehicles snap to their latest coordinates and do not cost a frame loop.
      if (!vehicle.marker || !state.vehicleLayer?.hasLayer(vehicle.marker)) {
        vehicle.displayCoords = [...(vehicle.motionTo || vehicle.coords)];
        vehicle.motionFrom = [...vehicle.displayCoords];
        vehicle.motionDuration = 0;
        if (vehicle.marker) vehicle.marker.setLatLng(vehicle.displayCoords);
        continue;
      }
      const position = vehicleDisplayCoords(vehicle, now);
      vehicle.displayCoords = position;
      if (vehicle.marker) {
        const old = vehicle.marker.getLatLng();
        if (Math.abs(old.lat - position[0]) > 0.0000001 || Math.abs(old.lng - position[1]) > 0.0000001) {
          vehicle.marker.setLatLng(position);
        }
      }
      if (now - Number(vehicle.motionStartedAt || now) >= Number(vehicle.motionDuration)) {
        vehicle.displayCoords = [...(vehicle.motionTo || vehicle.coords)];
        vehicle.motionFrom = [...vehicle.displayCoords];
        vehicle.motionDuration = 0;
      } else {
        hasMoreMovement = true;
      }
    }
    if (hasMoreMovement) state.vehicleAnimationFrame = requestAnimationFrame(animateVehiclePositions);
  }

  function mergeVehicleSnapshot(previous, incoming, now) {
    if (!previous) {
      incoming.timestamp = incoming.timestamp ?? now / 1000;
      incoming.bearing = incoming.bearing ?? 0;
      incoming.inventory = incoming.inventory ?? null;
      incoming.shortInventory = incoming.shortInventory ?? incoming.inventory;
      incoming.displayCoords = [...incoming.coords];
      incoming.motionFrom = [...incoming.coords];
      incoming.motionTo = [...incoming.coords];
      incoming.motionStartedAt = now;
      incoming.motionDuration = 0;
      return incoming;
    }

    const [oldLat, oldLon] = previous.coords;
    const [newLat, newLon] = incoming.coords;
    let visualStart = previous.displayCoords || vehicleDisplayCoords(previous, now);
    if (previous.marker && state.vehicleLayer?.hasLayer(previous.marker)) {
      try {
        const current = previous.marker.getLatLng();
        visualStart = [current.lat, current.lng];
      } catch (_) { /* retain last interpolated position */ }
    }

    const merged = { ...previous, ...incoming };
    const routeChanged = Boolean(
      (incoming.hasRouteRefField && incoming.normalizedRef && previous.normalizedRef && incoming.normalizedRef !== previous.normalizedRef) ||
      (incoming.hasRouteIdField && incoming.routeId && previous.routeId && incoming.routeId !== previous.routeId)
    );
    const clearRouteAssignment = Boolean(
      incoming.hasExplicitNoRoute || (routeChanged && !cleanValue(incoming.routeRef))
    );

    const preserveWhenMissing = [
      'cgmId', 'inventory', 'shortInventory', 'speed', 'timestamp', 'car',
      'occupancy', 'scheduledTime', 'delay', 'bearing', 'hasSourceTimestamp', 'modelName'
    ];
    for (const key of preserveWhenMissing) {
      const value = incoming[key];
      if (value === null || value === undefined || value === '') merged[key] = previous[key];
    }

    if (clearRouteAssignment) {
      // Do not keep a stale line/destination when the feed explicitly removes
      // the route assignment or changes to an unresolved route.
      merged.routeRef = '';
      merged.normalizedRef = '';
      merged.gtfsRouteId = '';
      merged.assignedToRoute = false;
      merged.destination = '';
      merged.destinationStopRef = null;
      merged.nextStopRef = null;
      merged.directionId = '';
      if (incoming.hasExplicitNoRoute) merged.routeId = '';
    } else {
      if (!cleanValue(incoming.routeId)) merged.routeId = previous.routeId;
      if (!cleanValue(incoming.gtfsRouteId)) merged.gtfsRouteId = routeChanged ? '' : previous.gtfsRouteId;

      if (!cleanValue(incoming.routeRef)) {
        if (routeChanged) {
          merged.routeRef = '';
          merged.normalizedRef = '';
          merged.gtfsRouteId = cleanValue(incoming.gtfsRouteId) || '';
          merged.assignedToRoute = false;
        } else {
          merged.routeRef = previous.routeRef || '';
          merged.normalizedRef = previous.normalizedRef || '';
          merged.gtfsRouteId = previous.gtfsRouteId || merged.gtfsRouteId || '';
          merged.assignedToRoute = Boolean(previous.assignedToRoute && cleanValue(merged.routeRef));
        }
      } else {
        merged.assignedToRoute = true;
      }

      // Empty/null fields fluctuate in partial GTFS snapshots. Preserve the
      // last useful value while the vehicle remains on the same route; clear
      // those fields when a real route change is detected.
      if (!cleanValue(incoming.destination)) merged.destination = routeChanged ? '' : previous.destination;
      if (!cleanValue(incoming.destinationStopRef)) merged.destinationStopRef = routeChanged ? null : previous.destinationStopRef;
      if (!cleanValue(incoming.nextStopRef)) merged.nextStopRef = routeChanged ? null : previous.nextStopRef;
      if (!cleanValue(incoming.directionId)) merged.directionId = routeChanged ? '' : previous.directionId;
    }

    // Partial feed messages can omit type/model. Do not erase resolved metadata
    // unless the route or route assignment genuinely changed.
    if (incoming.type === 'other' && previous.type && previous.type !== 'other' &&
        !routeChanged && !incoming.hasExplicitNoRoute) {
      merged.type = previous.type;
    }
    const identityChanged = Boolean(incoming.inventory && previous.inventory && incoming.inventory !== previous.inventory);
    if ((incoming.modelName === 'Неизвестен модел' || incoming.modelName === null) && !identityChanged) merged.modelName = previous.modelName;
    if (!incoming.hasSourceTimestamp && previous.hasSourceTimestamp) {
      merged.timestamp = previous.timestamp;
      merged.hasSourceTimestamp = true;
    }
    if (incoming.inventory === null) merged.inventory = previous.inventory;
    if (incoming.shortInventory === null) merged.shortInventory = previous.shortInventory;

    // Recompute color from the merged route + mode. Never carry the fallback
    // #111827 forward merely because one snapshot omitted/emptied its metadata.
    merged.color = vehicleRouteColor(merged);

    if (Number(merged.speed) >= MIN_ACTIVE_SPEED) {
      merged.bearing = oldLat === newLat && oldLon === newLon ? 0 : calculateBearing(previous.coords, incoming.coords);
    } else {
      merged.bearing = 0;
    }

    const distance = distanceMetersBetween(visualStart, incoming.coords);
    merged.motionFrom = [...visualStart];
    merged.motionTo = [...incoming.coords];
    merged.motionStartedAt = now;
    merged.motionDuration = distance >= 3 && distance <= 650
      ? Math.round(Math.max(500, Math.min(1400, 420 + distance * 1.55)))
      : 0;
    merged.displayCoords = merged.motionDuration ? [...visualStart] : [...incoming.coords];
    if (merged.motionDuration === 0) merged.motionFrom = [...incoming.coords];

    if (merged.inventory === null || merged.inventory === undefined || merged.inventory === '') merged.inventory = null;
    if (merged.shortInventory === null || merged.shortInventory === undefined || merged.shortInventory === '') merged.shortInventory = merged.inventory;
    merged.marker = previous.marker;
    merged.hidden = false;
    merged.lastSeenAt = now;
    Object.assign(previous, merged);
    return previous;
  }

  function stopCodeKey(value) {
    const text = String(value ?? '').trim();
    return /^\d+$/.test(text) ? text.padStart(4, '0') : text.toUpperCase();
  }

  function stopByReference(value) {
    const ref = cleanValue(value);
    if (!ref) return null;
    return state.stopsByKey.get(ref) || state.stopsByKey.get(stopCodeKey(ref)) || null;
  }

  function resolveNextStop(vehicle) {
    const ref = cleanValue(vehicle.nextStopRef);
    if (ref) {
      const stop = stopByReference(ref);
      if (stop) return `${stop.name} [${String(stop.code).padStart(4, '0')}]`;
      if (/^\\d{3,5}$/.test(ref)) return `Спирка [${stopCodeKey(ref)}]`;
    }
    return 'Няма данни за следваща спирка';
  }

  function normaliseDirectionText(value) {
    return String(value ?? '').trim().toLocaleLowerCase('bg-BG').replace(/[\s.,;:()\[\]{}'"–—-]+/g, ' ');
  }

  function directionStopMatches(ref, patternStop) {
    const a = cleanValue(ref);
    const rawStop = patternStop && typeof patternStop === 'object'
      ? firstClean(patternStop.stop_code, patternStop.stop_id, patternStop.stopCode, patternStop.stopId, patternStop.code, patternStop.id)
      : patternStop;
    const b = cleanValue(rawStop);
    if (!a || !b) return false;
    if (stopCodeKey(a) === stopCodeKey(b)) return true;
    const stopA = stopByReference(a);
    const stopB = stopByReference(b);
    if (stopA && stopB && String(stopA.id) === String(stopB.id)) return true;
    if (stopA && (String(stopA.id) === b || stopCodeKey(stopA.code) === stopCodeKey(b))) return true;
    if (stopB && (String(stopB.id) === a || stopCodeKey(stopB.code) === stopCodeKey(a))) return true;
    return false;
  }

  function pointToShapeMetrics(coords, shape, bearing) {
    const lat0 = Number(coords?.[0]);
    const lon0 = Number(coords?.[1]);
    if (!Number.isFinite(lat0) || !Number.isFinite(lon0) || !Array.isArray(shape) || shape.length < 2) {
      return { distance: 1e9, bearingDelta: 180 };
    }
    const xScale = 111320 * Math.cos(lat0 * Math.PI / 180);
    const yScale = 110540;
    const projected = shape.map((point) => ({
      x: (Number(point.lon) - lon0) * xScale,
      y: (Number(point.lat) - lat0) * yScale
    })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    let minSq = Infinity;
    let segmentBearing = null;
    for (let i = 0; i < projected.length - 1; i++) {
      const a = projected[i], b = projected[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      const t = lenSq ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lenSq)) : 0;
      const qx = a.x + t * dx, qy = a.y + t * dy;
      const sq = qx * qx + qy * qy;
      if (sq < minSq) {
        minSq = sq;
        segmentBearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
      }
    }
    let bearingDelta = 0;
    if (Number.isFinite(bearing) && bearing > 0 && segmentBearing !== null) {
      const delta = Math.abs((bearing - segmentBearing + 360) % 360);
      bearingDelta = Math.min(delta, 360 - delta);
    }
    return { distance: Math.sqrt(minSq), bearingDelta };
  }

  function getVehicleRouteDirection(vehicle) {
    if (!state.data || !vehicle) return null;
    const direct = vehicle.gtfsRouteId ? state.routesById.get(String(vehicle.gtfsRouteId)) : null;
    const sameRef = vehicle.normalizedRef ? (state.routesByRef.get(vehicle.normalizedRef) || []) : [];
    const candidates = [];
    const seenRoutes = new Set();
    const tryAddRoute = (route) => {
      if (!route || seenRoutes.has(String(route.route_id))) return;
      seenRoutes.add(String(route.route_id));
      const directions = state.data.directions?.[route.route_id] || {};
      Object.entries(directions).forEach(([key, direction]) => {
        const shape = state.data.shapes?.[direction.shape_id];
        if (!Array.isArray(shape) || shape.length < 2) return;
        candidates.push({ route, key: String(key), direction, shape });
      });
    };
    tryAddRoute(direct);
    // If the live feed does not identify the mode, consider all routes with this
    // public line number; position, destination and terminal-stop evidence below
    // can still disambiguate the correct route and geometry.
    const routeOptions = vehicle.type === 'other'
      ? sameRef
      : sameRef.filter((route) => routeType(route) === vehicle.type || routeType(route) === 'other');
    routeOptions.forEach(tryAddRoute);
    if (!candidates.length) return null;

    // A retained direction ID is only strong evidence while the current snapshot
    // actually supplied that field; otherwise use fresh destination/position cues.
    const dirToken = vehicle.hasDirectionIdField ? normaliseRef(vehicle.directionId) : '';
    const destinationText = normaliseDirectionText(vehicle.destination);
    const destinationRef = cleanValue(vehicle.destinationStopRef);
    let best = null;
    let bestScore = Infinity;
    for (const candidate of candidates) {
      const { route, key, direction, shape } = candidate;
      let score = 0;
      if (vehicle.gtfsRouteId && String(route.route_id) !== String(vehicle.gtfsRouteId)) score += 80;

      // Some live sources send direction keys such as D1/D2. Only trust exact
      // key matches; plain numeric values are ambiguous between source schemas.
      if (dirToken && normaliseRef(key) === dirToken) score -= 7500;

      const heading = normaliseDirectionText(direction.destination || direction.headsign);
      if (destinationText && heading) {
        if (destinationText === heading) score -= 10000;
        else if (destinationText.length > 3 && (heading.includes(destinationText) || destinationText.includes(heading))) score -= 4000;
      }

      const pattern = Array.isArray(direction.pattern) ? direction.pattern : [];
      if (destinationRef && pattern.length) {
        const startsAtDestination = directionStopMatches(destinationRef, pattern[0]);
        const endsAtDestination = directionStopMatches(destinationRef, pattern[pattern.length - 1]);
        if (endsAtDestination) score -= 12_000;
        else if (startsAtDestination) score += 12_000;
        else if (pattern.some((stop) => directionStopMatches(destinationRef, stop))) score -= 250;
      }

      const metrics = pointToShapeMetrics(vehicle.coords, shape, vehicle.bearing);
      score += metrics.distance;
      // Heading helps distinguish two directions sharing the same street/shape.
      if (Number.isFinite(vehicle.bearing) && vehicle.bearing > 0) score += metrics.bearingDelta * 2.2;
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return best;
  }

  function resolveVehicleDestination(vehicle) {
    // Match Dimitar's GTFS popup: destination_stop -> stop.code -> names.bg.
    const destinationStop = stopByReference(vehicle.destinationStopRef);
    if (destinationStop?.name) return destinationStop.name;

    const directText = cleanValue(vehicle.destination);
    if (directText && !/^\\d{3,5}$/.test(directText)) return directText;

    const selected = getVehicleRouteDirection(vehicle);
    const destination = selected?.direction?.destination || selected?.direction?.headsign;
    if (destination) return String(destination);

    const pattern = selected?.direction?.pattern;
    if (Array.isArray(pattern) && pattern.length) {
      const terminal = stopByReference(pattern[pattern.length - 1]);
      if (terminal?.name) return terminal.name;
    }
    return 'Няма данни за дестинацията';
  }

  function transportIconPath(type, ref) {
    if (type === 'bus' && String(ref || '').toUpperCase().startsWith('N')) return 'assets/icons/night-bus.svg';
    const icons = { bus: 'bus.svg', tram: 'tram.svg', trolley: 'trolley.svg', metro: 'metro.svg', other: 'bus.svg' };
    return `assets/icons/${icons[type] || icons.other}`;
  }

  function lineIdentityMarkup(ref, type, color, compact = false) {
    const line = ref || '—';
    const metroClass = type === 'metro' ? ' metro' : '';
    const textColor = type === 'metro' && normaliseRef(ref) === 'M4' ? '#111827' : '#ffffff';
    return `<span class="line-identity${compact ? ' compact' : ''}"><span class="line-identity-icon"><img src="${transportIconPath(type, ref)}" alt="" aria-hidden="true"></span><span class="line-identity-pill${metroClass}" style="--line-color:${escapeHTML(color || TYPE_COLORS[type] || TYPE_COLORS.other)};--line-text-color:${textColor}">${escapeHTML(line)}</span></span>`;
  }

  function calcDelay(vehicle) {
    if (vehicle.delay !== null && Number.isFinite(vehicle.delay)) return Math.round(vehicle.delay);
    const scheduled = vehicle.scheduledTime;
    if (scheduled === null || scheduled === undefined) return null;
    let scheduledMinutes = null;
    if (typeof scheduled === 'string' && scheduled.includes(':')) {
      const parts = scheduled.split(':').map(Number);
      if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) scheduledMinutes = parts[0] * 60 + parts[1];
    } else if (hasFinite(scheduled)) {
      const number = Number(scheduled);
      scheduledMinutes = number % 1440; // feed values are minutes since midnight
    }
    if (scheduledMinutes === null) return null;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
    let delay = ((hour * 60 + minute) - scheduledMinutes) % 1440;
    if (delay > 720) delay -= 1440;
    if (delay < -720) delay += 1440;
    return delay;
  }

  function delayView(vehicle) {
    const delay = calcDelay(vehicle);
    if (delay === null) return { label: 'Няма данни', className: '' };
    if (delay > 3) return { label: `+${delay} мин.`, className: 'late' };
    if (delay < -2) return { label: `${delay} мин.`, className: 'early' };
    return { label: 'Навреме', className: 'ontime' };
  }

  function timeAgo(timestamp) {
    const diff = Math.max(0, Math.round(Date.now() / 1000 - timestamp));
    if (diff < 10) return 'току-що';
    if (diff < 60) return `преди ${diff} сек.`;
    if (diff < 3600) return `преди ${Math.floor(diff / 60)} мин.`;
    return `преди ${Math.floor(diff / 3600)} ч.`;
  }

  function fmtTime(timestamp) {
    if (!timestamp || !Number.isFinite(timestamp)) return '—';
    return new Intl.DateTimeFormat('bg-BG', { timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(timestamp * 1000));
  }

  function showToast(message, delay = 3000) {
    const toast = $('map-toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toast.hidden = true; }, delay);
  }

  function setConnection(status, details = '') {
    document.body.dataset.connection = status;
    const dot = $('header-live-dot');
    const label = $('header-live-label');
    const icon = $('connection-icon');
    const title = $('connection-title');
    const description = $('connection-description');
    if (dot) { dot.classList.toggle('is-live', status === 'connected'); dot.classList.toggle('is-error', status === 'error'); }
    if (label) label.textContent = status === 'connected' ? 'На живо' : status === 'error' ? 'Няма връзка' : status === 'connecting' ? 'Свързване…' : 'Изчакване…';
    if (icon) { icon.classList.toggle('connected', status === 'connected'); icon.classList.toggle('error', status === 'error'); }
    if (title) title.textContent = status === 'connected' ? 'Връзката е активна' : status === 'error' ? 'Източникът не отговаря' : 'Свързване с данните';
    if (description) description.textContent = details || (status === 'connected' ? `${CONFIG.sources?.[state.source]?.label || 'ЦГМ'} · поток на живо` : status === 'error' ? 'Ще опитаме да се свържем отново' : 'Изчакване на данни от ЦГМ');
  }

  function installVehiclePopupStyles() {
    if (document.getElementById('gtsofia-popup-v11')) return;
    const style = document.createElement('style');
    style.id = 'gtsofia-popup-v11';
    style.textContent = `
      /* A compact side bubble leaves the selected GTFS polyline visible. */
      .gts-vehicle-leaflet-popup .leaflet-popup-content-wrapper {
        position: relative;
        padding: 0 !important;
        border: 1px solid #dfe5ec;
        border-radius: 16px !important;
        overflow: visible !important;
        background: #fff;
        box-shadow: 0 14px 36px rgba(15, 23, 42, .20) !important;
      }
      .gts-vehicle-leaflet-popup .leaflet-popup-content-wrapper::after {
        content: "";
        position: absolute;
        left: 13px;
        bottom: -8px;
        width: 0;
        height: 0;
        border-left: 8px solid transparent;
        border-right: 8px solid transparent;
        border-top: 9px solid #fff;
        pointer-events: none;
      }
      .gts-vehicle-leaflet-popup .leaflet-popup-tip-container {
        display: none !important;
      }
      .gts-vehicle-leaflet-popup .leaflet-popup-content {
        width: min(300px, calc(100vw - 42px)) !important;
        max-width: calc(100vw - 42px) !important;
        margin: 6px !important;
        box-sizing: border-box;
        font-family: "Sofia Sans", sans-serif;
      }
      .gts-vehicle-leaflet-popup .leaflet-popup-close-button {
        z-index: 3;
        top: 1px !important;
        right: 1px !important;
        width: 22px !important;
        height: 22px !important;
        border-radius: 50%;
        color: #64748b !important;
        font-size: 18px !important;
        line-height: 21px !important;
        text-align: center;
      }
      .gts-vehicle-leaflet-popup .leaflet-popup-close-button:hover {
        color: #0f172a !important;
        background: #f1f5f9;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        align-items: stretch;
        gap: 5px;
        width: 100%;
        min-width: 0;
        padding: 0;
        color: #0f172a;
        overflow-wrap: break-word;
        word-break: normal;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-top {
        grid-column: 1 / -1;
        display: flex;
        flex-direction: row;
        align-items: center !important;
        gap: 7px;
        min-width: 0;
        margin: 0;
        padding: 0 20px 5px 0;
        border-bottom: 1px solid #e8edf3;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-line {
        display: flex;
        align-items: center;
        flex: 0 0 auto;
        min-width: 0;
        padding-right: 0;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-top .line-identity {
        display: inline-flex;
        align-items: center;
        justify-content: flex-start;
        flex: 0 0 auto;
        gap: 3px;
        margin: 0;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-top .line-identity-icon,
      .gts-vehicle-leaflet-popup .vehicle-popup-top .line-identity-icon img {
        display: block;
        width: 23px;
        height: 23px;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-top .line-identity-icon {
        flex: 0 0 23px;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-top .line-identity-pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 25px;
        min-width: 35px;
        width: auto;
        padding: 0 5px;
        border-radius: 6px;
        font-size: 13px;
        line-height: 1;
        font-weight: 800;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-top .line-identity-pill.metro {
        width: 25px;
        min-width: 25px;
        padding: 0;
        border-radius: 50%;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-heading {
        display: flex;
        flex: 1 1 auto;
        align-items: center;
        width: auto;
        min-width: 0;
        margin: 0;
        padding: 0;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-destination-line {
        display: flex;
        align-items: center !important;
        justify-content: flex-start;
        gap: 4px;
        min-width: 0;
        width: 100%;
        margin: 0;
        padding: 0;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-destination-line img {
        display: block;
        position: static;
        width: 11px;
        height: 13px;
        flex: 0 0 11px;
        margin: 0 !important;
        object-fit: contain;
        align-self: center;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-destination-line strong {
        display: block;
        flex: 1 1 auto;
        min-width: 0;
        margin: 0;
        padding: 0;
        color: #172033;
        font-size: 13px;
        font-weight: 750;
        line-height: 1.18;
        overflow-wrap: anywhere;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-destination,
      .gts-vehicle-leaflet-popup .vehicle-popup-model {
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: stretch;
        gap: 2px;
        min-width: 0;
        min-height: 43px;
        margin: 0;
        padding: 5px 7px;
        box-sizing: border-box;
        border: 1px solid #e1e7ef;
        border-radius: 8px;
        background: #f7f9fc;
        color: #0f172a;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-destination span,
      .gts-vehicle-leaflet-popup .vehicle-popup-model span,
      .gts-vehicle-leaflet-popup .vehicle-popup-item span {
        display: block;
        margin: 0;
        color: #586579;
        font-size: 10px;
        font-weight: 600;
        line-height: 1.15;
        letter-spacing: 0;
        text-transform: none;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-destination {
        grid-column: 1 / -1;
        width: 100%;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-destination strong,
      .gts-vehicle-leaflet-popup .vehicle-popup-model strong {
        display: block;
        margin: 0;
        color: #111827;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.25;
        overflow-wrap: break-word;
        word-break: normal;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-destination-line strong {
        overflow-wrap: break-word;
        word-break: normal;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-grid {
        grid-column: 1 / -1;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        align-items: stretch;
        gap: 5px;
        min-width: 0;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-item {
        display: flex;
        flex-direction: column;
        justify-content: center;
        min-width: 0;
        min-height: 35px;
        margin: 0;
        padding: 4px 7px;
        border: 1px solid #e1e7ef;
        border-radius: 8px;
        background: #fff;
        color: #111827;
        overflow-wrap: anywhere;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-item strong {
        display: block;
        margin: 2px 0 0;
        color: #111827;
        font-size: 12px;
        font-weight: 750;
        line-height: 1.15;
        overflow-wrap: anywhere;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-item.late strong { color: #b42318; }
      .gts-vehicle-leaflet-popup .vehicle-popup-item.early strong { color: #a15c07; }

      body.dark-theme .gts-vehicle-leaflet-popup .leaflet-popup-content-wrapper {
        border-color: #334155;
        background: #111827;
      }
      body.dark-theme .gts-vehicle-leaflet-popup .leaflet-popup-content-wrapper::after {
        border-top-color: #111827;
      }
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup { color: #f8fafc; }
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-top { border-bottom-color: #334155; }
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-destination,
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-model,
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-item {
        border-color: #334155;
        background: #1e293b;
      }
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-destination span,
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-model span,
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-item span { color: #b8c4d6; }
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-destination strong,
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-model strong,
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-item strong,
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-destination-line strong { color: #f8fafc; }

      @media (max-width: 480px) {
        .gts-vehicle-leaflet-popup .leaflet-popup-content {
          width: min(270px, calc(100vw - 42px)) !important;
          max-width: calc(100vw - 42px) !important;
          margin: 6px !important;
        }
        .gts-vehicle-leaflet-popup .vehicle-popup { gap: 4px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-top { gap: 5px; padding-bottom: 4px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-top .line-identity-icon,
        .gts-vehicle-leaflet-popup .vehicle-popup-top .line-identity-icon img {
          width: 21px;
          height: 21px;
        }
        .gts-vehicle-leaflet-popup .vehicle-popup-top .line-identity-icon { flex-basis: 21px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-top .line-identity-pill {
          height: 23px;
          min-width: 32px;
          padding: 0 4px;
          font-size: 12px;
        }
        .gts-vehicle-leaflet-popup .vehicle-popup-top .line-identity-pill.metro {
          width: 23px;
          min-width: 23px;
        }
        .gts-vehicle-leaflet-popup .vehicle-popup-destination-line { gap: 3px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-destination-line img {
          width: 10px;
          height: 12px;
          flex-basis: 10px;
        }
        .gts-vehicle-leaflet-popup .vehicle-popup-destination-line strong { font-size: 12px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-destination,
        .gts-vehicle-leaflet-popup .vehicle-popup-model {
          min-height: 41px;
          padding: 4px 6px;
        }
        .gts-vehicle-leaflet-popup .vehicle-popup-destination span,
        .gts-vehicle-leaflet-popup .vehicle-popup-model span,
        .gts-vehicle-leaflet-popup .vehicle-popup-item span { font-size: 9px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-destination strong,
        .gts-vehicle-leaflet-popup .vehicle-popup-model strong,
        .gts-vehicle-leaflet-popup .vehicle-popup-item strong { font-size: 11px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-item {
          min-height: 32px;
          padding: 4px 6px;
        }
      }

      /* Modern vehicle details card: clearer hierarchy, generous spacing, same data. */
      .gts-vehicle-leaflet-popup .vehicle-popup-card {
        display: flex;
        flex-direction: column;
        gap: 7px;
        width: 100%;
        min-width: 0;
        padding: 2px;
        color: #172033;
        font-family: "Sofia Sans", sans-serif;
        overflow-wrap: anywhere;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 0;
        padding: 0 20px 7px 0;
        border-bottom: 1px solid #e8edf4;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-route {
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        flex-wrap: wrap;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-route .line-identity { gap: 4px; }
      .gts-vehicle-leaflet-popup .vehicle-popup-route .line-identity-icon,
      .gts-vehicle-leaflet-popup .vehicle-popup-route .line-identity-icon img {
        width: 27px;
        height: 27px;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-route .line-identity-icon { flex-basis: 27px; }
      .gts-vehicle-leaflet-popup .vehicle-popup-route .line-identity-pill {
        width: auto;
        min-width: 36px;
        height: 28px;
        padding: 0 7px;
        border-radius: 6px;
        font-size: 14px;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-inventory-group {
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        gap: 5px;
        min-width: 0;
        margin-left: auto;
        flex: 0 0 auto;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-inventory {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        min-width: 0;
        min-height: 23px;
        padding: 2px 7px;
        border: 1px solid #e4eaf2;
        border-radius: 7px;
        color: #526176;
        background: #f7f9fc;
        font-size: 10px;
        font-weight: 700;
        line-height: 1.15;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-card-label,
      .gts-vehicle-leaflet-popup .vehicle-popup-metric span {
        color: #64748b;
        font-size: 9px;
        font-weight: 700;
        line-height: 1.2;
        letter-spacing: .035em;
        text-transform: uppercase;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-inventory strong {
        color: inherit;
        font-size: inherit;
        font-weight: inherit;
        line-height: inherit;
        overflow-wrap: anywhere;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-destination-card {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
        padding: 8px 9px;
        border: 1px solid #e3eaf3;
        border-radius: 11px;
        background: #f4f7fb;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-card-label {
        display: flex;
        align-items: center;
        gap: 5px;
        letter-spacing: .025em;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-card-label img {
        width: 11px;
        height: 13px;
        flex: 0 0 11px;
        object-fit: contain;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-destination-card > strong {
        color: #172033;
        font-size: 14px;
        font-weight: 800;
        line-height: 1.25;
        overflow-wrap: anywhere;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-details-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 6px;
        min-width: 0;
        align-items: stretch;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-details-grid > .vehicle-popup-next-stop,
      .gts-vehicle-leaflet-popup .vehicle-popup-details-grid > .vehicle-popup-model-card {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
        padding: 7px 8px;
        border: 1px solid #e8edf4;
        border-radius: 10px;
        background: #fff;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-label-symbol {
        display: inline-grid;
        place-items: center;
        width: 13px;
        height: 13px;
        border-radius: 50%;
        background: #e9eef5;
        color: #526176;
        font-size: 11px;
        line-height: 1;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-next-stop > strong,
      .gts-vehicle-leaflet-popup .vehicle-popup-model-card > strong {
        color: #172033;
        font-size: 11px;
        font-weight: 750;
        line-height: 1.3;
        overflow-wrap: anywhere;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-metrics {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 6px;
        min-width: 0;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-metric {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 3px;
        min-width: 0;
        min-height: 39px;
        padding: 6px 8px;
        border: 1px solid #e8edf4;
        border-radius: 10px;
        background: #fff;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-metric strong {
        color: #172033;
        font-size: 12px;
        font-weight: 800;
        line-height: 1.15;
        overflow-wrap: anywhere;
      }
      .gts-vehicle-leaflet-popup .vehicle-popup-metric.late strong { color: #b42318; }
      .gts-vehicle-leaflet-popup .vehicle-popup-metric.early strong { color: #a15c07; }
      .gts-vehicle-leaflet-popup .vehicle-popup-last-signal { grid-column: auto; min-height: 39px; }
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-card-head { border-bottom-color: #334155; }
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-inventory {
        border-color: #475569;
        background: #1e293b;
        color: #cbd5e1;
      }
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-inventory strong,
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-destination-card > strong,
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-next-stop > strong,
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-model-card > strong,
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-metric strong { color: #f8fafc; }
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-inventory span,
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-card-label,
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-metric span { color: #a9b8cb; }
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-destination-card,
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-next-stop,
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-model-card,
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-metric {
        border-color: #334155;
        background: #1e293b;
      }
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-popup-destination-card { background: #172438; }
      .gts-vehicle-leaflet-popup .vehicle-unexpected-warning-trigger {
        position: relative;
        display: inline-grid;
        place-items: center;
        flex: 0 0 23px;
        width: 23px;
        height: 23px;
        margin: 0;
        padding: 0;
        border: 1px solid #f1d16b;
        border-radius: 7px;
        background: #ffec9e;
        color: #805b08;
        font: inherit;
        font-size: 13px;
        font-weight: 800;
        line-height: 1;
        cursor: help;
        -webkit-tap-highlight-color: transparent;
      }
      .gts-vehicle-leaflet-popup .vehicle-unexpected-warning-trigger::after {
        content: attr(data-tooltip);
        position: absolute;
        top: calc(100% + 7px);
        right: 0;
        z-index: 2000;
        width: max-content;
        max-width: min(230px, calc(100vw - 54px));
        padding: 7px 9px;
        border: 1px solid #f1d16b;
        border-radius: 8px;
        background: #fff7d6;
        color: #805b08;
        box-shadow: 0 6px 16px rgba(68, 50, 9, .18);
        font-size: 11px;
        font-weight: 800;
        line-height: 1.25;
        text-align: left;
        white-space: normal;
        overflow-wrap: anywhere;
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transform: translateY(-3px);
        transition: opacity .12s ease, transform .12s ease, visibility .12s ease;
      }
      .gts-vehicle-leaflet-popup .vehicle-unexpected-warning-trigger:hover::after,
      .gts-vehicle-leaflet-popup .vehicle-unexpected-warning-trigger:focus-visible::after,
      .gts-vehicle-leaflet-popup .vehicle-unexpected-warning-trigger[aria-expanded="true"]::after {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
      }
      .gts-vehicle-leaflet-popup .vehicle-unexpected-warning-trigger:hover,
      .gts-vehicle-leaflet-popup .vehicle-unexpected-warning-trigger:focus-visible {
        outline: none;
        filter: brightness(.98);
        box-shadow: 0 0 0 2px rgba(241, 209, 107, .28);
      }
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-unexpected-warning-trigger {
        border-color: #7d6726;
        background: #554519;
        color: #fde68a;
      }
      body.dark-theme .gts-vehicle-leaflet-popup .vehicle-unexpected-warning-trigger::after {
        border-color: #7d6726;
        background: #3b3218;
        color: #fde68a;
        box-shadow: 0 6px 16px rgba(0, 0, 0, .35);
      }
      @media (prefers-reduced-motion: reduce) {
        .gts-vehicle-leaflet-popup .vehicle-unexpected-warning-trigger::after {
          transition: none;
        }
      }
      @media (max-width: 480px) {
        .gts-vehicle-leaflet-popup .vehicle-unexpected-warning-trigger { flex-basis: 22px; width: 22px; height: 22px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-card { gap: 7px; padding: 2px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-card-head { gap: 5px; padding-bottom: 8px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-route .line-identity-icon,
        .gts-vehicle-leaflet-popup .vehicle-popup-route .line-identity-icon img { width: 23px; height: 23px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-route .line-identity-icon { flex-basis: 23px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-route .line-identity-pill { min-width: 31px; height: 25px; font-size: 12px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-inventory { min-height: 22px; padding: 2px 6px; font-size: 9px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-destination-card { padding: 8px 9px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-destination-card > strong { font-size: 13px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-details-grid { gap: 5px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-details-grid > .vehicle-popup-next-stop,
        .gts-vehicle-leaflet-popup .vehicle-popup-details-grid > .vehicle-popup-model-card { padding: 6px 7px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-metric { min-height: 36px; padding: 5px 7px; }
        .gts-vehicle-leaflet-popup .vehicle-popup-last-signal { min-height: 36px; }
      }

    `;
    document.head.appendChild(style);
  }


  function initMap() {
    installVehiclePopupStyles();
    if (!window.L) {
      setConnection('error', 'Картата не се зареди. Провери интернет връзката.');
      return;
    }
    state.map = L.map('map', { center: SOFIA_CENTER, zoom: SOFIA_ZOOM, zoomControl: false, minZoom: 10, preferCanvas: true });
    state.lightTiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    });
    state.darkTiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 20,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    });
    state.activeTiles = state.lightTiles.addTo(state.map);
    L.control.zoom({ position: 'topright' }).addTo(state.map);
    state.routeLayer = L.layerGroup().addTo(state.map);
    state.stopLayer = L.layerGroup().addTo(state.map);
    state.selectedVehicleRouteLayer = L.layerGroup().addTo(state.map);
    state.vehicleLayer = L.layerGroup().addTo(state.map);
    state.map.on('moveend zoomend', () => {
      renderStops();
      updateVehicleMarkers();
    });
    setTimeout(() => state.map.invalidateSize(), 50);
  }

  async function loadMapData() {
    try {
      const response = await fetch('./data/transport-map.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state.data = data;
      const allRoutes = data.routes || [];
      // Keep EVERY route for live vehicle recognition. Only restrict the user-facing
      // line picker to the routes that have usable shapes in this compact map dataset.
      state.routes = allRoutes;
      state.selectableRoutes = allRoutes.filter((route) => {
        if (!['0', '1', '3', '11'].includes(String(route.route_type))) return false;
        const directions = Object.values(data.directions?.[route.route_id] || {});
        return directions.some((direction) => Array.isArray(data.shapes?.[direction.shape_id]) && data.shapes[direction.shape_id].length >= 2);
      });
      state.routesById = new Map(state.routes.map((route) => [String(route.route_id), route]));
      state.routesByLooseId = new Map(state.routes.map((route) => [String(route.route_id ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase(), route]));
      state.overridesByCgmId = new Map((data.lineOverrides || []).filter((item) => item.cgm_id).map((item) => [String(item.cgm_id), item]));
      state.overridesByRouteRef = new Map((data.lineOverrides || []).filter((item) => !item.cgm_id && item.route_ref).map((item) => [normaliseRef(item.route_ref), item]));
      state.routesByRef = new Map();
      state.routes.forEach((route) => {
        const ref = normaliseRef(routeRef(route));
        if (!ref) return;
        if (!state.routesByRef.has(ref)) state.routesByRef.set(ref, []);
        state.routesByRef.get(ref).push(route);
      });
      // Use the exact route metadata source used by the reference GTFS map.
      // A synchronized local copy remains the fallback if GitHub is unavailable.
      let routeCatalog = null;
      try {
        const remoteCatalogUrl = CONFIG.routeCatalogUrl ||
          'https://raw.githubusercontent.com/Dimitar5555/sofiatraffic-schedules/master/data/routes.json';
        const remoteResponse = await fetch(remoteCatalogUrl, { cache: 'no-cache' });
        if (remoteResponse.ok) {
          const candidate = await remoteResponse.json();
          if (Array.isArray(candidate) && candidate.some((item) => item?.cgm_id && item?.route_ref && item?.type)) {
            routeCatalog = candidate;
          }
        }
      } catch (error) {
        console.warn('Не е достъпен онлайн GTFS каталогът; използваме локалното копие.', error);
      }
      if (!routeCatalog) {
        const fallbackResponse = await fetch('./data/route-catalog.json', { cache: 'no-cache' });
        if (!fallbackResponse.ok) throw new Error(`HTTP ${fallbackResponse.status} loading route catalog fallback`);
        routeCatalog = await fallbackResponse.json();
      }
      if (!Array.isArray(routeCatalog)) throw new Error('Невалиден GTFS route catalog');
      // The reference live map excludes metro from its route lookup; keep the
      // same ground-transport scope (bus, tram, trolley) here as well.
      state.routesByCgmId = new Map(routeCatalog
        .filter((item) => item?.cgm_id && item?.route_ref && item?.type && String(item.type).toLowerCase() !== 'metro')
        .map((item) => [String(item.cgm_id), item]));

      // Optional enhancement used by the reference GTFS cache to show paired
      // trams as one vehicle. The main map must still work if this file is unavailable.
      try {
        const compositionResponse = await fetch('./data/tram-compositions.json', { cache: 'no-cache' });
        if (compositionResponse.ok) {
          const compositions = await compositionResponse.json();
          if (Array.isArray(compositions)) {
            state.tramCompositions = compositions.filter((pair) =>
              Array.isArray(pair) && pair.length === 2 &&
              pair.every((number) => Number.isInteger(Number(number)) && Number(number) > 0)
            ).map((pair) => pair.map(Number));
          }
        }
      } catch (error) {
        console.warn('Не успяхме да заредим справочника за трамвайни композиции.', error);
      }

      // Optional expected-vehicle metadata from the reference project. If unavailable,
      // the map stays operational and only the unexpected-vehicle warning is omitted.
      try {
        const [expectedResponse, depotResponse] = await Promise.all([
          fetch('./data/expected-models.json', { cache: 'no-cache' }),
          fetch('./data/depot-rules.json', { cache: 'no-cache' })
        ]);
        if (!expectedResponse.ok || !depotResponse.ok) throw new Error('Expected-model metadata is unavailable');
        const [expectedData, depotData] = await Promise.all([expectedResponse.json(), depotResponse.json()]);
        if (!Array.isArray(expectedData.rules) || !Array.isArray(depotData.depots)) {
          throw new Error('Invalid expected-model metadata');
        }
        state.expectedModelRules = expectedData.rules;
        state.depotRules = depotData.depots;
      } catch (error) {
        state.expectedModelRules = [];
        state.depotRules = [];
        console.warn('Не успяхме да заредим правилата за необичайни превозни средства.', error);
      }

      state.stops = (data.stops || []).map((stop) => ({
        id: String(stop.stop_id ?? stop.stop_code ?? ''),
        code: String(stop.stop_code ?? stop.stop_id ?? ''),
        name: String(stop.stop_name ?? 'Спирка'),
        lat: Number(stop.stop_lat), lon: Number(stop.stop_lon)
      })).filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon) && stop.lat !== 0 && stop.lon !== 0);
      state.stopsByKey = new Map();
      state.stops.forEach((stop) => {
        for (const key of [stop.id, stop.code, stopCodeKey(stop.id), stopCodeKey(stop.code)]) {
          if (key && !state.stopsByKey.has(String(key))) state.stopsByKey.set(String(key), stop);
        }
      });

      // Use the same Bulgarian stop names as Dimitar's destination-stop lookup.
      const stopCatalogResponse = await fetch('./data/stop-catalog.json', { cache: 'no-cache' });
      if (!stopCatalogResponse.ok) throw new Error(`HTTP ${stopCatalogResponse.status} loading stop catalog`);
      const stopCatalog = await stopCatalogResponse.json();
      for (const item of stopCatalog) {
        if (!item?.code || !item?.name) continue;
        const code = String(item.code);
        const coords = Array.isArray(item.coords) ? item.coords : [0, 0];
        const stop = { id: code, code, name: item.name, lat: Number(coords[0]) || 0, lon: Number(coords[1]) || 0 };
        state.stopsByKey.set(code, stop);
        state.stopsByKey.set(stopCodeKey(code), stop);
      }
      populateLineFilter();
      if ($('static-data-date')) $('static-data-date').textContent = data.updatedAt ? `CGM GTFS · ${data.updatedAt}` : 'CGM Sofia · GTFS';
      renderRoute();
      renderStops();
      return true;
    } catch (error) {
      console.error('Неуспешно зареждане на картографските данни:', error);
      showToast('Не успяхме да заредим статичните GTFS данни. Стартирай проекта през локален уеб сървър.', 6500);
      return false;
    }
  }

  function selectedRouteParts() {
    if (state.selectedRoute === 'all') return null;
    const separator = state.selectedRoute.indexOf('::');
    if (separator < 0) return { ref: state.selectedRoute, type: null };
    return {
      ref: state.selectedRoute.slice(separator + 2),
      type: state.selectedRoute.slice(0, separator)
    };
  }

  function lineFilterValue(ref, type) {
    return `${type}::${normaliseRef(ref)}`;
  }

  function linePickerGroup(item) {
    if (item.type === 'metro') return 'metro';
    if (item.type === 'tram') return 'tram';
    if (item.type === 'trolley') return 'trolley';
    if (item.type === 'bus' && /^N/i.test(item.ref)) return 'night';
    if (item.type === 'bus') return 'bus';
    return null;
  }

  function closeLinePicker(focusTrigger = false) {
    const trigger = $('line-filter-trigger');
    const menu = $('line-filter-menu');
    if (menu) menu.hidden = true;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger) trigger?.focus();
  }

  function syncLinePickerSelection() {
    const current = $('line-filter-current');
    const trigger = $('line-filter-trigger');
    const menu = $('line-filter-menu');
    if (!current || !trigger) return;

    const item = state.lineFilterItems.find((candidate) => candidate.value === state.selectedRoute);
    if (item) {
      current.innerHTML = lineIdentityMarkup(item.ref, item.type, item.color, true);
      trigger.setAttribute('aria-label', `Избрана линия ${item.ref}, ${TYPE_NAMES[item.type] || TYPE_NAMES.other}`);
    } else {
      current.textContent = 'Всички линии';
      trigger.setAttribute('aria-label', 'Линия: всички линии');
    }
    menu?.querySelectorAll('.line-picker-option').forEach((option) => {
      option.setAttribute('aria-selected', String(option.dataset.routeValue === state.selectedRoute));
    });
  }

  function applyLinePickerValue(value) {
    state.selectedRoute = value;
    syncLinePickerSelection();
    closeLinePicker();
    state.routeLayer?.clearLayers();
    clearSelectedVehicleRoute();
    state.selectedVehicleId = null;
    renderStops();
    updateVehicleMarkers();
    renderVehicleList();
  }

  function populateLineFilter() {
    const menu = $('line-filter-menu');
    if (!menu) return;
    menu.replaceChildren();

    const selectableByIdentity = new Map();
    state.selectableRoutes.forEach((route) => {
      const ref = normaliseRef(routeRef(route));
      const type = routeType(route);
      if (!ref || !['bus', 'tram', 'trolley'].includes(type)) return;
      const value = lineFilterValue(ref, type);
      if (!selectableByIdentity.has(value)) {
        selectableByIdentity.set(value, { value, ref, type, route, color: routeColor(route, ref, type) });
      }
    });

    // This live map intentionally lists only modes with realtime surface vehicles.
    const groupOrder = ['tram', 'trolley', 'bus', 'night'];
    const groupTitles = {
      tram: 'Трамвайни линии',
      trolley: 'Тролейбусни линии',
      bus: 'Автобусни линии',
      night: 'Нощни линии'
    };
    state.lineFilterItems = [...selectableByIdentity.values()]
      .map((item) => ({ ...item, group: linePickerGroup(item) }))
      .filter((item) => item.group)
      .sort((a, b) =>
        groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) ||
        a.ref.localeCompare(b.ref, 'bg', { numeric: true })
      );

    if (state.selectedRoute !== 'all' && !state.lineFilterItems.some((item) => item.value === state.selectedRoute)) {
      state.selectedRoute = 'all';
    }

    const addOption = (item) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'line-picker-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(item.value === state.selectedRoute));
      option.dataset.routeValue = item.value;
      if (item.value === 'all') {
        option.classList.add('line-picker-all');
        option.textContent = 'Всички линии';
        option.setAttribute('aria-label', 'Всички линии');
      } else {
        option.innerHTML = lineIdentityMarkup(item.ref, item.type, item.color, true);
        option.setAttribute('aria-label', `Линия ${item.ref}, ${TYPE_NAMES[item.type] || TYPE_NAMES.other}`);
        option.title = `${item.ref} · ${TYPE_NAMES[item.type] || TYPE_NAMES.other}`;
      }
      menu.appendChild(option);
    };

    addOption({ value: 'all' });
    groupOrder.forEach((group) => {
      const items = state.lineFilterItems.filter((item) => item.group === group);
      if (!items.length) return;
      const heading = document.createElement('div');
      heading.className = 'line-picker-group-label';
      heading.setAttribute('role', 'presentation');
      heading.textContent = groupTitles[group];
      menu.appendChild(heading);
      items.forEach(addOption);
    });
    syncLinePickerSelection();
  }

  function getVehicleColor(vehicle) {
    if (!cleanValue(vehicle.routeRef)) return TYPE_COLORS[vehicle.type] || TYPE_COLORS.other;
    if (vehicle.color) return vehicle.color;
    const route = vehicle.routeId ? state.routesById.get(vehicle.routeId) : state.routesByRef.get(vehicle.normalizedRef)?.[0];
    return routeColor(route, vehicle.routeRef, vehicle.type);
  }

  function vehicleIcon(vehicle) {
    const color = getVehicleColor(vehicle);
    const label = vehicle.routeRef || '—';
    const age = Date.now() / 1000 - (vehicle.timestamp || 0);
    const inactiveClass = age > 60 ? ' inactive' : '';
    const bearing = Number.isFinite(vehicle.bearing) ? vehicle.bearing : 0;
    return L.divIcon({
      className: 'vehicle-marker-wrap',
      html: `<span class="vehicle-pin${inactiveClass}" style="--line-color:${escapeHTML(color)};--bearing:${bearing}deg"><span class="vehicle-label">${escapeHTML(label)}</span></span>`,
      iconSize: [31, 34], iconAnchor: [15, 17], popupAnchor: [0, -15]
    });
  }

  function displayInventoryNumber(value) {
    const text = cleanValue(value);
    if (/^\d{5,6}$/.test(text) && Number(text) > 9999) return String(Number(text) / 10);
    return text || '—';
  }

  function depotForExpectedVehicle(vehicle, inventoryValue) {
    const inventoryText = cleanValue(inventoryValue);
    if (!inventoryText) return null;
    const inventoryNumber = Number(inventoryText.split('/')[0]);
    if (!Number.isFinite(inventoryNumber)) return null;
    const cgmId = String(vehicle.cgmId ?? vehicle.raw?.cgm_id ?? '');

    for (const depot of state.depotRules) {
      const typeMatches = typeof depot.type === 'string'
        ? depot.type === vehicle.type
        : Array.isArray(depot.type) && depot.type.includes(vehicle.type);
      if (!typeMatches) continue;
      if (depot.cgm_id_prefix && !cgmId.startsWith(depot.cgm_id_prefix)) continue;

      for (const rawRange of depot.inv_number_ranges || []) {
        let range = rawRange;
        if (Array.isArray(rawRange) && typeof rawRange[0] === 'string' && rawRange[0] === vehicle.type) {
          range = rawRange[1];
        }
        if (Array.isArray(range)) {
          const lower = Number(range[0]);
          const upper = Number(range[1]);
          if (Number.isFinite(lower) && Number.isFinite(upper) && lower <= inventoryNumber && inventoryNumber <= upper) {
            return depot;
          }
        } else if (Number(range) === inventoryNumber) {
          return depot;
        }
      }
    }
    return null;
  }

  function isVehicleExpectedOnLine(vehicle) {
    if (!state.expectedModelRules.length || !state.depotRules.length) return true;
    const lineRef = normaliseRef(vehicle.routeRef);
    const line = state.expectedModelRules.find((rule) =>
      rule.type === vehicle.type && normaliseRef(rule.route_ref) === lineRef
    );
    // Lines without a published expectation are not flagged.
    if (!line) return true;

    const inventory = cleanValue(vehicle.shortInventory || vehicle.inventory);
    const modelApi = window.GTSOFIA_VEHICLE_MODELS;
    if (!inventory || !modelApi?.get_vehicle_model) return true;

    let model;
    try {
      model = modelApi.get_vehicle_model({
        ...(vehicle.raw || {}),
        type: vehicle.type,
        inv_number: inventory,
        cgm_id: String(vehicle.cgmId ?? vehicle.raw?.cgm_id ?? '')
      });
    } catch (error) {
      console.warn('Не успяхме да определим модела при проверката на линията.', error);
      return true;
    }
    const depot = depotForExpectedVehicle(vehicle, inventory);
    // Avoid a false warning when the model or depot cannot be identified.
    if (!model || !depot) return true;

    const carriages = inventory.includes('/') ? inventory.split('/').length : 1;
    return (line.models || []).some((expected) => {
      if (expected.model_id) {
        const expectedCarriages = expected.expected_carriages ?? expected.carriages;
        return expected.model_id === model.id &&
          expected.depot_id === depot.id &&
          (expectedCarriages === undefined || Number(expectedCarriages) === carriages);
      }
      return expected.depot_id === depot.id &&
        expected.is_bendy === (model.is_bendy ?? false);
    });
  }
  function vehiclePopup(vehicle) {
    const line = vehicle.routeRef || '—';
    const destination = resolveVehicleDestination(vehicle);
    const nextStop = resolveNextStop(vehicle);
    const speed = vehicle.speed === null ? '—' : `${Math.max(0, Math.round(vehicle.speed))} km/h`;
    const model = vehicle.modelName || 'Моделът не е разпознат';
    const inventory = displayInventoryNumber(vehicle.inventory || vehicle.shortInventory);
    const isUnexpected = !isVehicleExpectedOnLine(vehicle);
    return `<div class="vehicle-popup-card" style="--line-color:${escapeHTML(getVehicleColor(vehicle))}">
      <div class="vehicle-popup-card-head">
        <div class="vehicle-popup-route">${lineIdentityMarkup(line, vehicle.type, getVehicleColor(vehicle))}</div>
        <div class="vehicle-popup-inventory-group">
          <div class="vehicle-popup-inventory"><strong>${escapeHTML(inventory)}</strong></div>
          ${isUnexpected ? `<button type="button" class="vehicle-unexpected-warning-trigger" data-tooltip="Необичайно превозно средство" aria-label="Необичайно превозно средство" aria-expanded="false">⚠</button>` : ''}
        </div>
      </div>
      <div class="vehicle-popup-destination-card">
        <span class="vehicle-popup-card-label"><img src="./assets/icons/destinationarrow.svg" alt="" aria-hidden="true">Дестинация</span>
        <strong>${escapeHTML(destination)}</strong>
      </div>
      <div class="vehicle-popup-details-grid">
        <div class="vehicle-popup-next-stop">
          <span class="vehicle-popup-card-label"><span class="vehicle-popup-label-symbol" aria-hidden="true">⌖</span>Следваща спирка</span>
          <strong>${escapeHTML(nextStop)}</strong>
        </div>
        <div class="vehicle-popup-model-card">
          <span class="vehicle-popup-card-label">Марка / модел</span>
          <strong>${escapeHTML(model)}</strong>
        </div>
      </div>
      <div class="vehicle-popup-metrics">
        <div class="vehicle-popup-metric"><span>Скорост</span><strong>${escapeHTML(speed)}</strong></div>
        <div class="vehicle-popup-metric vehicle-popup-last-signal"><span>Последно обновяване</span><strong>${escapeHTML(timeAgo(vehicle.timestamp))}</strong></div>
      </div>
    </div>`;
  }

  function vehicleMatches(vehicle) {
    if (state.selectedType !== 'all' && vehicle.type !== state.selectedType) return false;
    const selectedRoute = selectedRouteParts();
    if (selectedRoute && vehicle.normalizedRef !== selectedRoute.ref) return false;
    if (selectedRoute?.type && vehicle.type !== selectedRoute.type) return false;
    const query = state.query.trim().toLocaleLowerCase('bg-BG');
    if (query) {
      const haystack = [vehicle.routeRef, vehicle.inventory, vehicle.shortInventory, vehicle.destination, resolveNextStop(vehicle), TYPE_NAMES[vehicle.type], vehicle.modelName].join(' ').toLocaleLowerCase('bg-BG');
      if (!haystack.includes(query)) return false;
    }
    return true;
  }

  function isVehicleFresh(vehicle, nowSeconds = Date.now() / 1000) {
    const signalTime = Number(vehicle?.timestamp);
    if (!Number.isFinite(signalTime)) return false;
    return nowSeconds - signalTime <= STALE_AFTER_SECONDS;
  }

  function isVehicleOnActiveRoute(vehicle) {
    return Boolean(
      vehicle &&
      vehicle.assignedToRoute &&
      cleanValue(vehicle.routeRef) &&
      normaliseRef(vehicle.routeRef) &&
      ['bus', 'tram', 'trolley', 'metro'].includes(vehicle.type)
    );
  }

  function getFilteredVehicles() {
    const nowSeconds = Date.now() / 1000;
    return [...state.vehicles.values()].filter((vehicle) =>
      !vehicle.hidden &&
      isVehicleFresh(vehicle, nowSeconds) &&
      isVehicleOnActiveRoute(vehicle) &&
      vehicleMatches(vehicle)
    );
  }

  function cmpVehicles(a, b) {
    const lineCompare = String(a.routeRef || '~~~').localeCompare(String(b.routeRef || '~~~'), 'bg', { numeric: true });
    if (lineCompare) return lineCompare;
    return String(a.inventory).localeCompare(String(b.inventory), 'bg', { numeric: true });
  }

  function updateStats() {
    if (!$('stat-bus') && !$('stat-tram') && !$('stat-trolley')) return;
    const active = [...state.vehicles.values()].filter((vehicle) =>
      !vehicle.hidden && isVehicleFresh(vehicle) && isVehicleOnActiveRoute(vehicle)
    );
    if ($('stat-bus')) $('stat-bus').textContent = active.filter((vehicle) => vehicle.type === 'bus').length;
    if ($('stat-tram')) $('stat-tram').textContent = active.filter((vehicle) => vehicle.type === 'tram').length;
    if ($('stat-trolley')) $('stat-trolley').textContent = active.filter((vehicle) => vehicle.type === 'trolley').length;
  }

  function renderVehicleList() {
    if (!$('vehicle-list')) return;
    const active = getFilteredVehicles();
    let vehicles = active.slice();
    const list = $('vehicle-list');
    const isDelayView = state.view === 'delays';
    $('results-heading').textContent = isDelayView ? 'Закъснения' : 'Превозни средства';
    $('results-subtitle').textContent = isDelayView ? 'Оценка спрямо разписанието' : 'Избери превозно средство на картата';
    if (isDelayView) {
      vehicles = vehicles.filter((vehicle) => calcDelay(vehicle) !== null).sort((a, b) => (calcDelay(b) ?? 0) - (calcDelay(a) ?? 0));
    } else {
      vehicles.sort(cmpVehicles);
    }
    $('result-count').textContent = String(vehicles.length);
    if (!vehicles.length) {
      const title = state.vehicles.size === 0 ? 'Изчакваме първите позиции' : isDelayView ? 'Няма данни за закъсненията' : 'Няма съвпадения';
      const description = state.vehicles.size === 0
        ? 'Когато връзката се активира, тук ще се появят превозните средства.'
        : isDelayView
          ? 'Източникът може да не подава разписание за всяко превозно средство.'
          : 'Промени търсенето или изчисти филтрите.';
      list.innerHTML = `<div class="empty-state"><span class="empty-state-icon">⌁</span><strong>${escapeHTML(title)}</strong><p>${escapeHTML(description)}</p></div>`;
      return;
    }
    const fragment = document.createDocumentFragment();
    vehicles.slice(0, 180).forEach((vehicle) => {
      const delay = delayView(vehicle);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'vehicle-row';
      row.dataset.vehicleId = vehicle.id;
      const subtitle = resolveNextStop(vehicle) !== 'Няма данни за следваща спирка' ? resolveNextStop(vehicle) : (TYPE_NAMES[vehicle.type] || TYPE_NAMES.other);
      const meta = isDelayView
        ? `<span class="delay-pill ${delay.className}">${escapeHTML(delay.label)}</span><span class="vehicle-updated">${escapeHTML(timeAgo(vehicle.timestamp))}</span>`
        : `<span class="vehicle-speed">${vehicle.speed === null ? '—' : `${Math.max(0, Math.round(vehicle.speed))} km/h`}</span><span class="vehicle-updated">${escapeHTML(timeAgo(vehicle.timestamp))}</span>`;
      row.innerHTML = `${lineIdentityMarkup(vehicle.routeRef, vehicle.type, getVehicleColor(vehicle), true)}
        <span class="vehicle-row-main"><span class="vehicle-row-title">${escapeHTML(vehicle.inventory)}</span><span class="vehicle-row-subtitle">${escapeHTML(subtitle)}</span></span>
        <span class="vehicle-row-meta">${meta}</span>`;
      row.addEventListener('click', () => focusVehicle(vehicle.id));
      fragment.appendChild(row);
    });
    list.replaceChildren(fragment);
  }

  function updateVehicleMarkers() {
    if (!state.map || !window.L) return;
    const bounds = state.map.getBounds();
    const nowSeconds = Date.now() / 1000;
    state.vehicles.forEach((vehicle, id) => {
      const fresh = isVehicleFresh(vehicle, nowSeconds);
      if (!fresh || vehicle.hidden || !isVehicleOnActiveRoute(vehicle) || !vehicleMatches(vehicle)) {
        if (vehicle.marker && state.vehicleLayer.hasLayer(vehicle.marker)) state.vehicleLayer.removeLayer(vehicle.marker);
        return;
      }
      // Do not instantiate thousands of off-screen markers. This also reduces the
      // amount of work needed for high-frequency full snapshots.
      if (!bounds.contains(vehicle.coords) && !vehicle.marker) return;
      const displayCoords = vehicleDisplayCoords(vehicle);
      vehicle.displayCoords = displayCoords;
      if (!vehicle.marker) {
        vehicle.marker = L.marker(displayCoords, { icon: vehicleIcon(vehicle), riseOnHover: true, keyboard: true, title: `Линия ${vehicle.routeRef || '—'} · инв. № ${vehicle.inventory || vehicle.id}` });
        const isNarrowViewport = (window.innerWidth || 1024) <= 480;
        const availableWidth = Math.max(220, (window.innerWidth || 1024) - 24);
        const availableHeight = Math.max(200, (window.innerHeight || 768) - 40);
        vehicle.marker.bindPopup(() => {
          const currentVehicle = state.vehicles.get(String(id)) || vehicle;
          return vehiclePopup(currentVehicle);
        }, {
          closeButton: true,
          maxWidth: Math.min(isNarrowViewport ? 280 : 320, availableWidth),
          minWidth: Math.min(isNarrowViewport ? 260 : 300, availableWidth),
          maxHeight: availableHeight,
          autoPan: true,
          keepInView: true,
          autoPanPaddingTopLeft: [12, 12],
          autoPanPaddingBottomRight: [12, 12],
          offset: [isNarrowViewport ? 122 : 135, -3],
          className: 'gts-vehicle-leaflet-popup'
        });
        vehicle.marker.on('click', () => {
          const currentVehicle = state.vehicles.get(String(id)) || vehicle;
          state.selectedVehicleId = String(id);
          const targetZoom = Math.max(15, Math.min(state.map.getZoom(), 16));
          state.map.flyTo(currentVehicle.coords, targetZoom, { duration: .55 });
          renderSelectedVehicleRoute(currentVehicle, true);
        });
        vehicle.marker.on('popupopen', () => {
          const currentVehicle = state.vehicles.get(String(id)) || vehicle;
          currentVehicle._popupHTML = vehiclePopup(currentVehicle);
          currentVehicle._lastPopupRefreshAt = Date.now();
        });
        vehicle.marker.on('popupclose', () => {
          if (String(state.selectedVehicleId) === String(id)) {
            state.selectedVehicleId = null;
            clearSelectedVehicleRoute();
          }
        });
        vehicle._iconSignature = vehicleIconSignature(vehicle);
      } else {
        const oldCoords = vehicle.marker.getLatLng();
        if (Math.abs(oldCoords.lat - displayCoords[0]) > 0.0000001 || Math.abs(oldCoords.lng - displayCoords[1]) > 0.0000001) vehicle.marker.setLatLng(displayCoords);
        const signature = vehicleIconSignature(vehicle);
        if (vehicle._iconSignature !== signature) {
          vehicle.marker.setIcon(vehicleIcon(vehicle));
          vehicle._iconSignature = signature;
        }
        const popup = vehicle.marker.getPopup();
        if (vehicle.marker.isPopupOpen() && popup) {
          const content = vehiclePopup(vehicle);
          const now = Date.now();
          if (vehicle._popupHTML !== content && now - (vehicle._lastPopupRefreshAt || 0) >= 1200) {
            vehicle.marker.setPopupContent(content);
            vehicle._popupHTML = content;
            vehicle._lastPopupRefreshAt = now;
          }
        }
      }
      if (bounds.contains(vehicle.coords)) {
        if (!state.vehicleLayer.hasLayer(vehicle.marker)) vehicle.marker.addTo(state.vehicleLayer);
      } else if (state.vehicleLayer.hasLayer(vehicle.marker)) {
        state.vehicleLayer.removeLayer(vehicle.marker);
      }
    });
    scheduleVehicleAnimation();
  }

  function vehicleIconSignature(vehicle) {
    const ageMinutes = Math.floor(Date.now() / 1000 - (vehicle.timestamp || 0)) / 60;
    return [vehicle.routeRef, vehicle.type, getVehicleColor(vehicle), vehicle.bearing, ageMinutes >= 1 ? 'inactive' : 'fresh'].join('|');
  }

  function clearSelectedVehicleRoute() {
    state.selectedVehicleRouteLayer?.clearLayers();
    state.selectedVehicleRouteSignature = null;
  }

  function renderSelectedVehicleRoute(vehicle, notifyMissing = true) {
    if (!state.selectedVehicleRouteLayer || !state.data || !vehicle) return;
    const currentVehicle = state.vehicles.get(String(vehicle.id)) || vehicle;
    const selected = getVehicleRouteDirection(currentVehicle);
    const shape = selected?.shape;
    const color = getVehicleColor(currentVehicle);
    if (!Array.isArray(shape) || shape.length < 2) {
      // Never leave a stale geometry visible after its direction can no longer be resolved.
      const missingSignature = ['missing', currentVehicle.id, currentVehicle.normalizedRef,
        currentVehicle.type, currentVehicle.directionId, currentVehicle.destinationStopRef,
        currentVehicle.destination].join('|');
      if (state.selectedVehicleRouteSignature !== missingSignature) {
        state.selectedVehicleRouteLayer.clearLayers();
        state.selectedVehicleRouteSignature = missingSignature;
      }
      if (notifyMissing) showToast('Не намерих геометрия за текущото направление на превозното средство.');
      return;
    }
    const signature = [currentVehicle.id, selected.route?.route_id, selected.key,
      selected.direction?.shape_id, color].join('|');
    if (signature === state.selectedVehicleRouteSignature) return;
    const points = shape.map((point) => [Number(point.lat), Number(point.lon)])
      .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
    state.selectedVehicleRouteLayer.clearLayers();
    if (points.length < 2) {
      state.selectedVehicleRouteSignature = `invalid|${signature}`;
      if (notifyMissing) showToast('Не намерих геометрия за текущото направление на превозното средство.');
      return;
    }
    L.polyline(points, {
      color,
      weight: 5,
      opacity: 1,
      fillOpacity: 0,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false,
      className: 'selected-vehicle-route'
    }).addTo(state.selectedVehicleRouteLayer);
    state.selectedVehicleRouteSignature = signature;
    // Keep map framing unchanged so the line does not pull the selected vehicle away
    // from the user's current view. Only one direction is ever drawn for this vehicle.
  }

  function refreshSelectedVehicleRoute() {
    if (state.selectedVehicleId === null || state.selectedVehicleId === undefined) return;
    const vehicle = state.vehicles.get(String(state.selectedVehicleId));
    if (!vehicle || !isVehicleFresh(vehicle)) {
      state.selectedVehicleId = null;
      clearSelectedVehicleRoute();
      return;
    }
    renderSelectedVehicleRoute(vehicle, false);
  }

  function renderRoute(fit = false) {
    if (!state.routeLayer || !state.data) return;
    state.routeLayer.clearLayers();
    const selected = selectedRouteParts();
    if (!state.showRoute || !selected) return;
    const selectedRef = selected.ref;
    const routes = (state.routesByRef.get(selectedRef) || []).filter((route) =>
      !selected.type || routeType(route) === selected.type
    );
    const lines = [];
    routes.forEach((route) => {
      const directions = state.data.directions?.[route.route_id] || {};
      Object.values(directions).forEach((direction) => {
        const shape = state.data.shapes?.[direction.shape_id];
        if (!Array.isArray(shape) || shape.length < 2) return;
        const points = shape.map((point) => [Number(point.lat), Number(point.lon)]).filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
        if (points.length < 2) return;
        const color = routeColor(route, selectedRef, routeType(route));
        const line = L.polyline(points, { color, weight: 6, opacity: .9, lineCap: 'round', lineJoin: 'round' });
        line.bindTooltip(`${escapeHTML(selectedRef)} · ${escapeHTML(direction.destination || direction.headsign || '')}`, { sticky: true, direction: 'top' });
        line.addTo(state.routeLayer);
        lines.push(line);
      });
    });
    if (fit && lines.length) {
      const group = L.featureGroup(lines);
      state.map.fitBounds(group.getBounds().pad(.09), { maxZoom: 15, animate: true });
    } else if (lines.length === 0) {
      showToast('Няма геометрия за избраната линия в наличните данни.');
    }
  }

  function visibleStops() {
    if (!state.map || !state.data || !state.showStops || state.map.getZoom() < 14) return [];
    const bounds = state.map.getBounds();
    let allowed = null;
    const selected = selectedRouteParts();
    if (selected) {
      allowed = new Set();
      (state.routesByRef.get(selected.ref) || [])
        .filter((route) => !selected.type || routeType(route) === selected.type)
        .forEach((route) => {
        Object.values(state.data.directions?.[route.route_id] || {}).forEach((direction) => {
          (direction.stops || []).forEach((stop) => allowed.add(String(stop.stop_id ?? stop.id ?? '')));
          (direction.pattern || []).forEach((id) => allowed.add(String(id)));
        });
      });
    }
    return state.stops.filter((stop) => bounds.contains([stop.lat, stop.lon]) && (!allowed || allowed.has(stop.id)));
  }

  function renderStops() {
    if (!state.stopLayer || !state.map) return;
    state.stopLayer.clearLayers();
    if (!state.showStops || state.map.getZoom() < 14) return;
    const stops = visibleStops();
    const renderer = L.canvas({ padding: .5 });
    stops.slice(0, 900).forEach((stop) => {
      const marker = L.circleMarker([stop.lat, stop.lon], { radius: state.map.getZoom() >= 16 ? 4 : 3, color: '#ffffff', weight: 1.5, fillColor: '#111827', fillOpacity: .92, renderer });
      marker.bindPopup(`<div class="stop-popup"><strong>${escapeHTML(stop.name)}</strong><small>Код на спирката: ${escapeHTML(stop.code)}</small></div>`, { maxWidth: 220 });
      marker.bindTooltip(stop.name, { direction: 'top', offset: [0, -4] });
      marker.addTo(state.stopLayer);
    });
    if (stops.length > 900) showToast('Показани са първите 900 спирки във видимата област.', 2600);
  }

  function updateLastUpdated() {
    if (!state.lastSnapshotAt || !$('last-updated')) return;
    $('last-updated').textContent = `Обновено ${fmtTime(state.lastSnapshotAt / 1000)}`;
  }

  function singleTramInventory(vehicle) {
    const inventory = cleanValue(vehicle?.shortInventory || vehicle?.inventory);
    if (!inventory || /[+/]/.test(inventory)) return null;
    const number = Number.parseInt(inventory, 10);
    return Number.isFinite(number) ? number : null;
  }

  function findSingleTramByInventory(inventoryNumber) {
    for (const vehicle of state.vehicles.values()) {
      if (vehicle.type !== 'tram' || !isVehicleOnActiveRoute(vehicle)) continue;
      if (singleTramInventory(vehicle) === inventoryNumber) return vehicle;
    }
    return null;
  }

  function hideComposedTramUnit(vehicle) {
    if (!vehicle) return;
    vehicle.hidden = true;
    if (vehicle.marker && state.vehicleLayer?.hasLayer(vehicle.marker)) {
      state.vehicleLayer.removeLayer(vehicle.marker);
    }
    vehicle.marker = null;
    if (String(state.selectedVehicleId) === String(vehicle.id)) {
      state.selectedVehicleId = null;
      clearSelectedVehicleRoute();
    }
  }

  function applyGTFSTramCompositions() {
    for (const [firstNumber, secondNumber] of state.tramCompositions) {
      const first = findSingleTramByInventory(firstNumber);
      const second = findSingleTramByInventory(secondNumber);
      const compositionId = `composition_${firstNumber}_${secondNumber}`;
      const compositionRef = `${firstNumber}/${String(secondNumber % 100).padStart(2, '0')}`;
      const existing = state.vehicles.get(compositionId);

      // In GTFS mode the first wagon is sufficient, matching the reference app.
      if (!first) {
        if (second) second.hidden = false;
        if (existing) existing.hidden = true;
        continue;
      }

      const marker = existing?.marker || null;
      const combined = {
        ...first,
        id: compositionId,
        cgmId: compositionId,
        inventory: compositionRef,
        shortInventory: compositionRef,
        hidden: false,
        marker,
        raw: {
          ...(first.raw || {}),
          cgm_id: compositionId,
          inv_number: compositionRef,
          full_inv_number: `${firstNumber}+${secondNumber}`,
          type: 'tram',
          route_ref: first.routeRef
        },
        // Keep the composition's position and animation in sync with its first wagon.
        coords: [...first.coords],
        displayCoords: [...(first.displayCoords || first.coords)],
        motionFrom: [...(first.motionFrom || first.coords)],
        motionTo: [...(first.motionTo || first.coords)]
      };
      if (existing) Object.assign(existing, combined);
      else state.vehicles.set(compositionId, combined);

      hideComposedTramUnit(first);
      hideComposedTramUnit(second);
    }
  }

  function receiveSnapshot(payload) {
    let vehicles;
    if (Array.isArray(payload)) vehicles = payload;
    else if (payload && Array.isArray(payload.vehicles)) vehicles = payload.vehicles;
    else if (payload && Array.isArray(payload.data)) vehicles = payload.data;
    else if (payload && typeof payload === 'object') vehicles = [payload];
    else return;

    const now = Date.now();
    const nowSeconds = now / 1000;
    for (const raw of vehicles) {
      const incoming = normaliseVehicle(prepareGTFSRecord(raw));
      if (!incoming) continue;
      const previous = state.vehicles.get(incoming.id);
      // Do not create a new marker from an untimestamped record, but permit a
      // partial update for a vehicle already known from a timestamped snapshot.
      if (!incoming.hasSourceTimestamp && !previous) continue;
      // A stale source timestamp is authoritative: do not refresh an old vehicle
      // just because the proxy keeps repeating that same old record.
      if (incoming.hasSourceTimestamp && nowSeconds - incoming.timestamp > STALE_AFTER_SECONDS) {
        continue;
      }
      let vehicle = mergeVehicleSnapshot(previous, incoming, now);
      // If the feed omits vehicle mode but the line is known, infer it from the
      // best-matching GTFS direction instead of leaving the marker as "other".
      if (vehicle.type === 'other' && vehicle.normalizedRef && state.data) {
        const matchedDirection = getVehicleRouteDirection(vehicle);
        const inferredType = matchedDirection ? routeType(matchedDirection.route) : 'other';
        if (['bus', 'tram', 'trolley'].includes(inferredType)) {
          const inferredRef = vehicle.routeRef || routeRef(matchedDirection.route);
          Object.assign(vehicle, {
            type: inferredType,
            gtfsRouteId: vehicle.gtfsRouteId || String(matchedDirection.route.route_id || ''),
            routeRef: inferredRef,
            normalizedRef: normaliseRef(inferredRef),
            color: routeColor(matchedDirection.route, inferredRef, inferredType)
          });
          vehicle.marker = previous?.marker || vehicle.marker;
        }
      }
      state.vehicles.set(vehicle.id, vehicle);
    }
    applyGTFSTramCompositions();
    state.lastSnapshotAt = now;
    for (const [id, vehicle] of state.vehicles.entries()) {
      if (!isVehicleFresh(vehicle, nowSeconds) || !isVehicleOnActiveRoute(vehicle)) {
        if (vehicle.marker && state.vehicleLayer.hasLayer(vehicle.marker)) state.vehicleLayer.removeLayer(vehicle.marker);
        const wasVisible = !vehicle.hidden;
        vehicle.marker = null;
        vehicle.hidden = true;
        if (wasVisible && String(state.selectedVehicleId) === String(id)) {
          state.selectedVehicleId = null;
          clearSelectedVehicleRoute();
        }
      }
    }
    const activeCount = [...state.vehicles.values()].filter((vehicle) =>
      !vehicle.hidden && isVehicleFresh(vehicle, nowSeconds) && isVehicleOnActiveRoute(vehicle)
    ).length;
    setConnection('connected', `${CONFIG.sources?.[state.source]?.label || 'ЦГМ'} · ${activeCount} превозни средства`);
    scheduleRender();
  }

  function scheduleRender() {
    if (state.renderFrame !== null) return;
    state.renderFrame = requestAnimationFrame(() => {
      state.renderFrame = null;
      updateLastUpdated();
      updateStats();
      updateVehicleMarkers();
      refreshSelectedVehicleRoute();
      // The filter-only sidebar intentionally contains no vehicle list.
      renderVehicleList();
    });
  }

  function calculateBearing(from, to) {
    if (!from || !to || from[0] === to[0] && from[1] === to[1]) return 0;
    const rad = Math.PI / 180;
    const lat1 = from[0] * rad;
    const lat2 = to[0] * rad;
    const dLon = (to[1] - from[1]) * rad;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function scheduleSocketReconnect(generation, message) {
    if (generation !== state.socketGeneration || state.reconnectTimer !== null) return;
    setConnection('error', message || 'Ще опитаме повторно автоматично');
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (generation === state.socketGeneration) connectSocket();
    }, RECONNECT_DELAY);
  }

  function connectSocket() {
    if (!window.WebSocket) {
      setConnection('error', 'Браузърът не поддържа WebSocket.');
      return;
    }
    // This app deliberately uses the same GTFS endpoint as the reference map.
    const sourceConfig = CONFIG.sources?.gtfs;
    if (!sourceConfig?.url) {
      setConnection('error', 'Не е конфигуриран GTFS WebSocket източник.');
      return;
    }

    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    const generation = ++state.socketGeneration;
    if (state.socket) {
      const previous = state.socket;
      previous.onclose = null;
      previous.onerror = null;
      previous.onmessage = null;
      previous.close();
      state.socket = null;
    }

    setConnection('connecting', `Източник: ${sourceConfig.label}`);
    try {
      const socket = new WebSocket(sourceConfig.url);
      state.socket = socket;
      socket.onopen = () => {
        if (generation !== state.socketGeneration) return;
        setConnection('connected', `Връзка с ${sourceConfig.label} · изчакване на позиции`);
      };
      socket.onmessage = (event) => {
        if (generation !== state.socketGeneration) return;
        try {
          receiveSnapshot(JSON.parse(event.data));
        } catch (error) {
          console.warn('Неразпознато GTFS live съобщение:', error);
        }
      };
      socket.onerror = () => {
        if (generation !== state.socketGeneration) return;
        scheduleSocketReconnect(generation, 'Временно прекъсване на GTFS потока');
      };
      socket.onclose = () => {
        if (generation !== state.socketGeneration) return;
        scheduleSocketReconnect(generation, 'GTFS връзката прекъсна; ще опитаме повторно');
      };
    } catch (error) {
      console.error('Неуспешна GTFS WebSocket връзка:', error);
      scheduleSocketReconnect(generation, 'Неуспешна GTFS връзка. Повторен опит след малко.');
    }
  }

  function focusVehicle(id) {
    const vehicle = state.vehicles.get(String(id));
    if (!vehicle || !state.map) return;
    if (!vehicleMatches(vehicle)) {
      state.selectedType = 'all';
      state.selectedRoute = 'all';
      state.query = '';
      $('type-filter').value = 'all';
      syncLinePickerSelection();
      $('search-input').value = '';
    }
    updateVehicleMarkers();
    const marker = vehicle.marker;
    state.map.flyTo(vehicle.coords, Math.max(state.map.getZoom(), 16), { duration: .6 });
    setTimeout(() => { if (marker) marker.openPopup(); }, 650);
  }

  function setTheme(dark) {
    document.body.classList.toggle('dark-theme', dark);
    $('theme-toggle').textContent = dark ? 'Включи светла тема' : 'Включи тъмна тема';
    if (state.map && state.activeTiles) {
      state.map.removeLayer(state.activeTiles);
      state.activeTiles = dark ? state.darkTiles : state.lightTiles;
      state.activeTiles.addTo(state.map);
    }
  }

  function bindUI() {
    $('search-input')?.addEventListener('input', (event) => {
      state.query = event.target.value;
      clearSelectedVehicleRoute();
      state.selectedVehicleId = null;
      updateVehicleMarkers();
      renderVehicleList();
    });
    $('type-filter')?.addEventListener('change', (event) => {
      state.selectedType = event.target.value;
      clearSelectedVehicleRoute();
      state.selectedVehicleId = null;
      updateVehicleMarkers();
      renderVehicleList();
    });
    const linePickerTrigger = $('line-filter-trigger');
    const linePickerMenu = $('line-filter-menu');
    linePickerTrigger?.addEventListener('click', () => {
      const open = linePickerMenu?.hidden !== false;
      if (linePickerMenu) linePickerMenu.hidden = !open;
      linePickerTrigger.setAttribute('aria-expanded', String(open));
    });
    linePickerTrigger?.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (linePickerMenu) linePickerMenu.hidden = false;
        linePickerTrigger.setAttribute('aria-expanded', 'true');
        const options = [...(linePickerMenu?.querySelectorAll('.line-picker-option') || [])];
        (event.key === 'ArrowUp' ? options.at(-1) : options[0])?.focus();
      }
    });
    linePickerMenu?.addEventListener('click', (event) => {
      const option = event.target.closest('.line-picker-option');
      if (!option) return;
      applyLinePickerValue(option.dataset.routeValue || 'all');
    });
    linePickerMenu?.addEventListener('keydown', (event) => {
      const options = [...linePickerMenu.querySelectorAll('.line-picker-option')];
      const currentIndex = options.indexOf(document.activeElement);
      let next = null;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeLinePicker(true);
        return;
      }
      if (event.key === 'ArrowDown') next = options[Math.min(options.length - 1, currentIndex + 1)];
      else if (event.key === 'ArrowUp') next = options[Math.max(0, currentIndex - 1)];
      else if (event.key === 'Home') next = options[0];
      else if (event.key === 'End') next = options.at(-1);
      if (next) {
        event.preventDefault();
        next.focus();
      }
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.line-picker')) closeLinePicker();
    });
    // Capture clicks before Leaflet stops popup events, allowing the warning tooltip
    // to toggle on touch devices as well as by mouse hover or keyboard focus.
    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('.vehicle-unexpected-warning-trigger');
      const openWarnings = document.querySelectorAll('.vehicle-unexpected-warning-trigger[aria-expanded="true"]');
      if (!trigger) {
        openWarnings.forEach((button) => button.setAttribute('aria-expanded', 'false'));
        return;
      }
      event.preventDefault();
      openWarnings.forEach((button) => {
        if (button !== trigger) button.setAttribute('aria-expanded', 'false');
      });
      const shouldOpen = trigger.getAttribute('aria-expanded') !== 'true';
      trigger.setAttribute('aria-expanded', String(shouldOpen));
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      document.querySelectorAll('.vehicle-unexpected-warning-trigger[aria-expanded="true"]').forEach((button) => {
        button.setAttribute('aria-expanded', 'false');
        button.blur();
      });
    }, true);
    $('clear-filters')?.addEventListener('click', () => {
      state.selectedType = 'all';
      state.selectedRoute = 'all';
      state.query = '';
      if ($('type-filter')) $('type-filter').value = 'all';
      syncLinePickerSelection();
      if ($('search-input')) $('search-input').value = '';
      clearSelectedVehicleRoute();
      state.selectedVehicleId = null;
      state.routeLayer?.clearLayers();
      renderRoute();
      renderStops();
      updateVehicleMarkers();
      renderVehicleList();
    });
    $('stops-toggle')?.addEventListener('change', (event) => {
      state.showStops = event.target.checked;
      if (state.showStops && state.map && state.map.getZoom() < 14) showToast('Приближи картата до ниво 14 или повече, за да видиш спирките.', 3200);
      renderStops();
    });
    $('route-toggle')?.addEventListener('change', (event) => {
      state.showRoute = event.target.checked;
      if (state.selectedRoute === 'all' && state.showRoute) showToast('Избери линия, за да видиш маршрута ѝ.');
      renderRoute();
    });
    document.querySelectorAll('.list-tab').forEach((button) => {
      button.addEventListener('click', () => {
        state.view = button.dataset.view;
        document.querySelectorAll('.list-tab').forEach((tab) => {
          const active = tab === button;
          tab.classList.toggle('active', active);
          tab.setAttribute('aria-selected', String(active));
        });
        renderVehicleList();
      });
    });
    $('reconnect-button')?.addEventListener('click', () => connectSocket());
    state.source = 'gtfs';
    const sourceFilter = $('source-filter');
    if (sourceFilter) {
      sourceFilter.value = 'gtfs';
      sourceFilter.closest('.filter-section, .filter-row, label')?.setAttribute('hidden', '');
    }
    $('settings-button')?.addEventListener('click', () => {
      const panel = $('settings-panel');
      if (panel) panel.hidden = !panel.hidden;
    });
    $('theme-toggle')?.addEventListener('click', () => setTheme(!document.body.classList.contains('dark-theme')));
    $('locate-button')?.addEventListener('click', locateUser);
    $('reset-map-button')?.addEventListener('click', () => state.map?.flyTo(SOFIA_CENTER, SOFIA_ZOOM, { duration: .5 }));
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && $('search-input')) {
        event.preventDefault(); $('search-input').focus();
      }
      if (event.key === 'Escape' && $('search-input')) $('search-input').blur();
    });
    window.addEventListener('resize', () => state.map?.invalidateSize());
    setInterval(() => {
      const nowSeconds = Date.now() / 1000;
      let removed = false;
      for (const [id, vehicle] of state.vehicles.entries()) {
        if (isVehicleFresh(vehicle, nowSeconds) || vehicle.hidden) continue;
        if (vehicle.marker && state.vehicleLayer?.hasLayer(vehicle.marker)) state.vehicleLayer.removeLayer(vehicle.marker);
        vehicle.marker = null;
        vehicle.hidden = true;
        if (String(state.selectedVehicleId) === String(id)) {
          state.selectedVehicleId = null;
          clearSelectedVehicleRoute();
        }
        removed = true;
      }
      if (removed) scheduleRender();
    }, 1_000);
  }

  function locateUser() {
    if (!navigator.geolocation) { showToast('Браузърът не поддържа геолокация.'); return; }
    navigator.geolocation.getCurrentPosition((position) => {
      const coords = [position.coords.latitude, position.coords.longitude];
      if (state.userMarker) state.userMarker.setLatLng(coords);
      else state.userMarker = L.circleMarker(coords, { radius: 7, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(state.map).bindPopup('Твоето местоположение');
      state.map.flyTo(coords, 16, { duration: .6 });
    }, () => showToast('Няма достъп до местоположението. Провери разрешенията на браузъра.'), { enableHighAccuracy: true, timeout: 8000 });
  }

  async function init() {
    initMap();
    bindUI();
    const loaded = await loadMapData();
    if (!loaded) {
      setConnection('error', 'GTFS картографските данни не се заредиха; live свързването е спряно.');
      return;
    }
    connectSocket();
  }

  window.addEventListener('DOMContentLoaded', init, { once: true });
})();
