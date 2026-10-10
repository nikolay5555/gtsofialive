(() => {
  'use strict';

  const CONFIG = window.GTSOFIA_LIVEMAP_CONFIG || {};
  const SOFIA_CENTER = CONFIG.mapCenter || [42.6977, 23.3219];
  const SOFIA_ZOOM = CONFIG.mapZoom || 13;
  const STALE_AFTER = CONFIG.refreshStaleAfterMs || 120000;
  const RECONNECT_DELAY = CONFIG.reconnectDelayMs || 2500;
  const TYPE_NAMES = { bus: 'Автобус', tram: 'Трамвай', trolley: 'Тролей', metro: 'Метро', other: 'Транспорт' };
  const TYPE_COLORS = { bus: '#be1e2d', tram: '#d97706', trolley: '#2563eb', metro: '#7c3aed', other: '#111827' };

  const state = {
    map: null,
    lightTiles: null,
    darkTiles: null,
    activeTiles: null,
    routeLayer: null,
    stopLayer: null,
    vehicleLayer: null,
    data: null,
    routes: [],
    routesById: new Map(),
    routesByRef: new Map(),
    stops: [],
    stopsByKey: new Map(),
    vehicles: new Map(),
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
    toastTimer: null
  };

  const $ = (id) => document.getElementById(id);
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const hasFinite = (value) => value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value));

  function normaliseRef(value) {
    return String(value ?? '').trim().replace(/\s+/g, '').toUpperCase();
  }

  function routeType(route) {
    if (!route) return 'other';
    const routeId = String(route.route_id ?? '');
    const shortName = String(route.route_short_name ?? '');
    const override = (state.data?.lineOverrides || []).find((item) =>
      String(item.cgm_id ?? '') === routeId ||
      (!item.cgm_id && normaliseRef(item.route_ref) === normaliseRef(shortName))
    );
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
    const override = (state.data?.lineOverrides || []).find((item) =>
      String(item.cgm_id ?? '') === String(route.route_id ?? '') ||
      (!item.cgm_id && normaliseRef(item.route_ref) === normaliseRef(route.route_short_name))
    );
    let ref = String(override?.route_ref || route.route_short_name || '').trim();
    const number = ref.replace(/[a-zа-я]/gi, '');
    if (/^E/i.test(ref)) ref = number;
    else if (/^N/i.test(ref)) ref = `N${number}`;
    else if (/^Y/i.test(ref)) ref = `У${number}`;
    return ref;
  }

  function routeColor(route, ref, type) {
    const routeId = String(route?.route_id ?? '');
    const override = (state.data?.lineOverrides || []).find((item) => String(item.cgm_id ?? '') === routeId);
    if (override?.color) return String(override.color).startsWith('#') ? String(override.color) : `#${override.color}`;
    if (String(ref || '').toUpperCase().startsWith('N')) return '#374151';
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

  function routeForVehicle(raw) {
    const routeId = String(raw.cgm_route_id ?? raw.route_id ?? raw.routeId ?? '');
    const byId = state.routesById.get(routeId);
    if (byId) return byId;
    const override = (state.data?.lineOverrides || []).find((item) => String(item.cgm_id ?? '') === routeId);
    if (override?.route_ref) {
      const options = state.routesByRef.get(normaliseRef(override.route_ref));
      if (options?.length) return options[0];
    }
    const ref = normaliseRef(raw.route_ref ?? raw.routeRef ?? raw.line ?? '');
    const byRef = state.routesByRef.get(ref);
    return byRef?.[0] || null;
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
    const candidate = String(rawType ?? '').trim().toLowerCase();
    const routeId = String(raw.cgm_route_id ?? raw.route_id ?? raw.routeId ?? '');
    const override = (state.data?.lineOverrides || []).find((item) => String(item.cgm_id ?? '') === routeId);
    const refUpper = String(ref || '').trim().toUpperCase();
    const inventoryValue = raw.inv_number ?? raw.inventory_number ?? raw.full_inv_number ?? '';
    const inventoryNumber = Number.parseInt(String(inventoryValue).split('/')[0], 10);

    let type = 'other';
    if (override?.type) {
      type = String(override.type).toLowerCase();
      if (type === 'trolleybus') type = 'trolley';
    } else if (['bus', 'tram', 'trolley', 'trolleybus', 'metro'].includes(candidate)) {
      type = candidate === 'trolleybus' ? 'trolley' : candidate;
    } else if (candidate === '0' || candidate === '3' || candidate === '11' || candidate === '1') {
      type = ({ '0': 'tram', '1': 'metro', '3': 'bus', '11': 'trolley' })[candidate];
    } else if (candidate.includes('tram') || candidate.includes('трам')) {
      type = 'tram';
    } else if (candidate.includes('trolley') || candidate.includes('трол')) {
      type = 'trolley';
    } else if (candidate.includes('bus') || candidate.includes('автоб')) {
      type = 'bus';
    } else {
      type = routeType(route);
    }

    // If the route lookup was not possible, the CGM route ID still reveals the
    // original family (A = bus, TM = tram, TB = trolley). Overrides above win.
    if (type === 'other') {
      if (/^TM/i.test(routeId)) type = 'tram';
      else if (/^TB/i.test(routeId)) type = 'trolley';
      else if (/^A/i.test(routeId)) type = 'bus';
      else if (/^[NTУY]/i.test(refUpper) || /[TТ]М?$/.test(refUpper)) type = 'bus';
    }

    // Some lines are historically reported as trolleybuses, but are operated
    // as replacement buses in the live feed. Mirror the reference app's rule.
    const fakeTrolleyRoutes = new Set(['60', '73', '74', '123', '288', '801']);
    if (type === 'trolley' && (fakeTrolleyRoutes.has(refUpper) || (Number.isFinite(inventoryNumber) && inventoryNumber >= 5000 && inventoryNumber < 6000))) {
      type = 'bus';
    }
    return ['bus', 'tram', 'trolley', 'metro'].includes(type) ? type : 'other';
  }

  function timestampSeconds(value) {
    if (!hasFinite(value)) return Date.now() / 1000;
    const parsed = Number(value);
    return parsed > 100000000000 ? parsed / 1000 : parsed;
  }

  function normaliseVehicle(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const coords = toCoordinates(raw.coords ?? raw.coordinates ?? raw.position ?? raw.location);
    if (!coords || Math.abs(coords[0]) > 90 || Math.abs(coords[1]) > 180) return null;

    const route = routeForVehicle(raw);
    const routeId = String(raw.cgm_route_id ?? raw.route_id ?? raw.routeId ?? '');
    const override = (state.data?.lineOverrides || []).find((item) => String(item.cgm_id ?? '') === routeId);
    let ref = String(raw.route_ref ?? raw.routeRef ?? raw.line ?? routeRef(route) ?? '').trim();
    if (/^(null|undefined)$/i.test(ref)) ref = '';
    if (override?.route_ref && !raw.route_ref && !raw.routeRef && !raw.line) ref = String(override.route_ref);

    const type = normaliseType(raw.type ?? raw.vehicle_type, ref, route, raw);
    const rawId = raw.cgm_id ?? raw.vehicle_id ?? raw.id ?? raw.inv_number ?? raw.inventory_number;
    if (rawId === undefined || rawId === null || String(rawId).trim() === '') return null;

    const speed = hasFinite(raw.speed) ? Number(raw.speed) : (hasFinite(raw.speed_kmh) ? Number(raw.speed_kmh) : null);
    const timestampRaw = raw.timestamp ?? raw.updated_at ?? raw.updatedAt ?? raw.time;
    const timestamp = hasFinite(timestampRaw) ? timestampSeconds(timestampRaw) : null;
    const normalizedRef = normaliseRef(ref);
    const color = routeColor(route, normalizedRef, type);
    const inventoryRaw = raw.full_inv_number ?? raw.inv_number ?? raw.inventory_number;
    const inventory = inventoryRaw === null || inventoryRaw === undefined || String(inventoryRaw).trim() === '' ? null : String(inventoryRaw);
    const shortInventoryRaw = raw.inv_number ?? raw.inventory_number ?? raw.full_inv_number;
    const shortInventory = shortInventoryRaw === null || shortInventoryRaw === undefined || String(shortInventoryRaw).trim() === '' ? null : String(shortInventoryRaw);
    const rawNextStop = raw.next_stop ?? raw.nextStop ?? raw.destination_stop ?? raw.destination_stop_code ?? raw.stop_code ?? null;
    const destinationText = raw.trip_headsign ?? raw.destination ?? raw.headsign ?? '';
    let modelName = null;
    const modelApi = window.GTSOFIA_VEHICLE_MODELS;
    if (modelApi && shortInventory && ['bus', 'tram', 'trolley'].includes(type)) {
      try {
        modelName = modelApi.get_vehicle_model_name({ type, inv_number: shortInventory, cgm_id: String(raw.cgm_id ?? rawId) }) || null;
      } catch (error) {
        console.warn('Не успяхме да определим модела на превозното средство:', error);
      }
    }

    return {
      id: String(rawId),
      cgmId: String(raw.cgm_id ?? rawId),
      routeId,
      routeRef: ref,
      normalizedRef,
      type,
      inventory,
      shortInventory,
      coords,
      speed,
      timestamp,
      car: raw.car ?? null,
      destination: String(destinationText ?? '').trim(),
      nextStopRef: rawNextStop === null || rawNextStop === undefined || String(rawNextStop).trim() === '' ? null : String(rawNextStop).trim(),
      occupancy: raw.occupancy ?? null,
      scheduledTime: raw.scheduled_time ?? null,
      delay: hasFinite(raw.delay) ? Number(raw.delay) : null,
      bearing: hasFinite(raw.bearing) ? Number(raw.bearing) : null,
      color,
      modelName,
      lastSeenAt: Date.now(),
      marker: null,
      raw
    };
  }

  function mergeVehicleSnapshot(previous, incoming, now) {
    if (!previous) {
      incoming.timestamp = incoming.timestamp ?? now / 1000;
      incoming.bearing = incoming.bearing ?? 0;
      incoming.inventory = incoming.inventory ?? incoming.id;
      incoming.shortInventory = incoming.shortInventory ?? incoming.inventory;
      return incoming;
    }

    const [oldLat, oldLon] = previous.coords;
    const [newLat, newLon] = incoming.coords;
    const merged = { ...previous, ...incoming };
    const preserveWhenMissing = [
      'cgmId', 'routeId', 'routeRef', 'normalizedRef', 'inventory',
      'shortInventory', 'speed', 'timestamp', 'car', 'destination',
      'nextStopRef', 'occupancy', 'scheduledTime', 'delay', 'bearing',
      'color', 'modelName'
    ];
    for (const key of preserveWhenMissing) {
      const value = incoming[key];
      if (value === null || value === undefined || value === '') merged[key] = previous[key];
    }
    // Partial feed messages sometimes omit route type/model data or only carry
    // a vehicle ID. Never let those placeholders erase previously resolved info.
    if (incoming.type === 'other' && previous.type && previous.type !== 'other') merged.type = previous.type;
    if (incoming.modelName === 'Неизвестен модел' || incoming.modelName === null) merged.modelName = previous.modelName;
    if (incoming.inventory === null) merged.inventory = previous.inventory;
    if (incoming.shortInventory === null) merged.shortInventory = previous.shortInventory;
    if ((incoming.type === 'other' || !incoming.routeId) && previous.color) merged.color = previous.color;
    if (merged.inventory === null || merged.inventory === undefined || merged.inventory === '') merged.inventory = incoming.id;
    if (merged.shortInventory === null || merged.shortInventory === undefined || merged.shortInventory === '') merged.shortInventory = merged.inventory;
    if (!merged.bearing && (oldLat !== newLat || oldLon !== newLon)) {
      merged.bearing = calculateBearing(previous.coords, incoming.coords);
    }
    merged.marker = previous.marker;
    merged.lastSeenAt = now;
    return merged;
  }

  function stopCodeKey(value) {
    const text = String(value ?? '').trim();
    return /^\d+$/.test(text) ? text.padStart(4, '0') : text.toUpperCase();
  }

  function resolveNextStop(vehicle) {
    const ref = String(vehicle.nextStopRef ?? '').trim();
    if (ref) {
      const stop = state.stopsByKey.get(ref) || state.stopsByKey.get(stopCodeKey(ref));
      if (stop) return `${stop.name} [${String(stop.code).padStart(4, '0')}]`;
      if (/^\d{3,5}$/.test(ref)) return `Спирка [${stopCodeKey(ref)}]`;
    }
    return vehicle.destination || 'Няма данни за следваща спирка';
  }

  function transportIconPath(type, ref) {
    if (type === 'bus' && String(ref || '').toUpperCase().startsWith('N')) return 'assets/icons/night-bus.svg';
    const icons = { bus: 'bus.svg', tram: 'tram.svg', trolley: 'trolley.svg', metro: 'metro.svg', other: 'bus.svg' };
    return `assets/icons/${icons[type] || icons.other}`;
  }

  function lineIdentityMarkup(ref, type, color, compact = false) {
    const line = ref || '—';
    const metroClass = type === 'metro' ? ' metro' : '';
    return `<span class="line-identity${compact ? ' compact' : ''}"><span class="line-identity-icon"><img src="${transportIconPath(type, ref)}" alt="" aria-hidden="true"></span><span class="line-identity-pill${metroClass}" style="--line-color:${escapeHTML(color || TYPE_COLORS[type] || TYPE_COLORS.other)}">${escapeHTML(line)}</span></span>`;
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
    const dot = $('header-live-dot');
    dot.classList.toggle('is-live', status === 'connected');
    dot.classList.toggle('is-error', status === 'error');
    $('header-live-label').textContent = status === 'connected' ? 'На живо' : status === 'error' ? 'Няма връзка' : status === 'connecting' ? 'Свързване…' : 'Изчакване…';
    $('connection-icon').classList.toggle('connected', status === 'connected');
    $('connection-icon').classList.toggle('error', status === 'error');
    $('connection-title').textContent = status === 'connected' ? 'Връзката е активна' : status === 'error' ? 'Източникът не отговаря' : 'Свързване с данните';
    $('connection-description').textContent = details || (status === 'connected' ? `${CONFIG.sources?.[state.source]?.label || 'ЦГМ'} · поток на живо` : status === 'error' ? 'Ще опитаме да се свържем отново' : 'Изчакване на данни от ЦГМ');
  }

  function initMap() {
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
    state.vehicleLayer = L.layerGroup().addTo(state.map);
    state.map.on('moveend zoomend', () => {
      renderStops();
      updateVehicleMarkers();
    });
    setTimeout(() => state.map.invalidateSize(), 50);
  }

  async function loadMapData() {
    try {
      const response = await fetch('./data/transport-map.json', { cache: 'force-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state.data = data;
      const routesWithLiveGeometry = (data.routes || []).filter((route) => {
        if (!['0', '3', '11'].includes(String(route.route_type))) return false;
        const directions = Object.values(data.directions?.[route.route_id] || {});
        return directions.some((direction) => Array.isArray(data.shapes?.[direction.shape_id]) && data.shapes[direction.shape_id].length >= 2);
      });
      state.routes = routesWithLiveGeometry;
      state.routesById = new Map(state.routes.map((route) => [String(route.route_id), route]));
      state.routesByRef = new Map();
      state.routes.forEach((route) => {
        const ref = normaliseRef(routeRef(route));
        if (!ref) return;
        if (!state.routesByRef.has(ref)) state.routesByRef.set(ref, []);
        state.routesByRef.get(ref).push(route);
      });
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
      populateLineFilter();
      $('static-data-date').textContent = data.updatedAt ? `CGM GTFS · ${data.updatedAt}` : 'CGM Sofia · GTFS';
      renderRoute();
      renderStops();
      return true;
    } catch (error) {
      console.error('Неуспешно зареждане на картографските данни:', error);
      showToast('Не успяхме да заредим статичните GTFS данни. Стартирай проекта през локален уеб сървър.', 6500);
      return false;
    }
  }

  function populateLineFilter() {
    const select = $('line-filter');
    select.replaceChildren(new Option('Всички линии', 'all'));
    const unique = [...state.routesByRef.entries()].sort(([a], [b]) => a.localeCompare(b, 'bg', { numeric: true }));
    unique.forEach(([ref, routes]) => {
      const types = [...new Set(routes.map((route) => routeType(route)))];
      const typeLabel = types.map((type) => TYPE_NAMES[type] || TYPE_NAMES.other).join(' / ');
      select.add(new Option(`${ref} · ${typeLabel}`, ref));
    });
  }

  function getVehicleColor(vehicle) {
    if (vehicle.color) return vehicle.color;
    const route = vehicle.routeId ? state.routesById.get(vehicle.routeId) : state.routesByRef.get(vehicle.normalizedRef)?.[0];
    return routeColor(route, vehicle.routeRef, vehicle.type);
  }

  function vehicleIcon(vehicle) {
    const color = getVehicleColor(vehicle);
    const label = vehicle.routeRef || (vehicle.type === 'bus' ? 'А' : vehicle.type === 'tram' ? 'ТМ' : 'ТБ');
    const age = Date.now() / 1000 - vehicle.timestamp;
    const inactiveClass = age > 60 ? ' inactive' : '';
    const bearing = Number.isFinite(vehicle.bearing) ? vehicle.bearing : 0;
    return L.divIcon({
      className: 'vehicle-marker-wrap',
      html: `<span class="vehicle-pin${inactiveClass}" style="--line-color:${escapeHTML(color)};--bearing:${bearing}deg"><span class="vehicle-label">${escapeHTML(label)}</span></span>`,
      iconSize: [31, 34], iconAnchor: [15, 17], popupAnchor: [0, -15]
    });
  }

  function vehiclePopup(vehicle) {
    const typeLabel = TYPE_NAMES[vehicle.type] || TYPE_NAMES.other;
    const line = vehicle.routeRef || 'Без линия';
    const destination = resolveNextStop(vehicle);
    const speed = vehicle.speed === null ? '—' : `${Math.max(0, Math.round(vehicle.speed))} km/h`;
    const delay = delayView(vehicle);
    const model = vehicle.modelName && vehicle.modelName !== 'Неизвестен модел' ? vehicle.modelName : 'Моделът не е разпознат';
    const car = vehicle.car !== null && vehicle.car !== undefined && String(vehicle.car).trim() !== '' ? ` · кола ${vehicle.car}` : '';
    return `<div class="vehicle-popup" style="--line-color:${escapeHTML(getVehicleColor(vehicle))}">
      <div class="vehicle-popup-top">
        ${lineIdentityMarkup(line, vehicle.type, getVehicleColor(vehicle))}
        <div class="vehicle-popup-heading"><strong>${escapeHTML(vehicle.inventory)}</strong><small>${escapeHTML(model)}</small><small>${escapeHTML(typeLabel + car)}</small></div>
      </div>
      <div class="vehicle-popup-destination"><span>Следваща спирка</span><strong>${escapeHTML(destination)}</strong></div>
      <div class="vehicle-popup-grid">
        <div class="vehicle-popup-item"><span>Скорост</span><strong>${escapeHTML(speed)}</strong></div>
        <div class="vehicle-popup-item"><span>Закъснение</span><strong>${escapeHTML(delay.label)}</strong></div>
        <div class="vehicle-popup-item"><span>Последен сигнал</span><strong>${escapeHTML(timeAgo(vehicle.timestamp))}</strong></div>
        <div class="vehicle-popup-item"><span>Обновено в</span><strong>${escapeHTML(fmtTime(vehicle.timestamp))}</strong></div>
      </div>
    </div>`;
  }

  function vehicleMatches(vehicle) {
    if (state.selectedType !== 'all' && vehicle.type !== state.selectedType) return false;
    if (state.selectedRoute !== 'all' && vehicle.normalizedRef !== state.selectedRoute) return false;
    const query = state.query.trim().toLocaleLowerCase('bg-BG');
    if (query) {
      const haystack = [vehicle.routeRef, vehicle.inventory, vehicle.shortInventory, vehicle.destination, resolveNextStop(vehicle), TYPE_NAMES[vehicle.type], vehicle.modelName].join(' ').toLocaleLowerCase('bg-BG');
      if (!haystack.includes(query)) return false;
    }
    return true;
  }

  function getFilteredVehicles() {
    return [...state.vehicles.values()].filter((vehicle) => Date.now() - vehicle.lastSeenAt < STALE_AFTER && vehicleMatches(vehicle));
  }

  function cmpVehicles(a, b) {
    const lineCompare = String(a.routeRef || '~~~').localeCompare(String(b.routeRef || '~~~'), 'bg', { numeric: true });
    if (lineCompare) return lineCompare;
    return String(a.inventory).localeCompare(String(b.inventory), 'bg', { numeric: true });
  }

  function updateStats() {
    const active = [...state.vehicles.values()].filter((vehicle) => Date.now() - vehicle.lastSeenAt < STALE_AFTER);
    $('stat-bus').textContent = active.filter((vehicle) => vehicle.type === 'bus').length;
    $('stat-tram').textContent = active.filter((vehicle) => vehicle.type === 'tram').length;
    $('stat-trolley').textContent = active.filter((vehicle) => vehicle.type === 'trolley').length;
  }

  function renderVehicleList() {
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
    const now = Date.now();
    state.vehicles.forEach((vehicle, id) => {
      if (now - vehicle.lastSeenAt >= STALE_AFTER || !vehicleMatches(vehicle)) {
        if (vehicle.marker && state.vehicleLayer.hasLayer(vehicle.marker)) state.vehicleLayer.removeLayer(vehicle.marker);
        return;
      }
      if (!vehicle.marker) {
        vehicle.marker = L.marker(vehicle.coords, { icon: vehicleIcon(vehicle), riseOnHover: true, keyboard: true, title: `Линия ${vehicle.routeRef || '—'} · инв. № ${vehicle.inventory}` });
        vehicle.marker.bindPopup(() => vehiclePopup(vehicle), { closeButton: true, maxWidth: 300, minWidth: 230 });
        vehicle.marker.on('click', () => { state.selectedVehicleId = id; });
      } else {
        vehicle.marker.setLatLng(vehicle.coords);
        vehicle.marker.setIcon(vehicleIcon(vehicle));
        if (vehicle.marker.isPopupOpen()) vehicle.marker.setPopupContent(vehiclePopup(vehicle));
      }
      if (bounds.contains(vehicle.coords)) {
        if (!state.vehicleLayer.hasLayer(vehicle.marker)) vehicle.marker.addTo(state.vehicleLayer);
      } else if (state.vehicleLayer.hasLayer(vehicle.marker)) {
        state.vehicleLayer.removeLayer(vehicle.marker);
      }
    });
  }

  function renderRoute(fit = false) {
    if (!state.routeLayer || !state.data) return;
    state.routeLayer.clearLayers();
    const selectedRef = state.selectedRoute;
    if (!state.showRoute || selectedRef === 'all') return;
    const routes = state.routesByRef.get(selectedRef) || [];
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
    if (state.selectedRoute !== 'all') {
      allowed = new Set();
      (state.routesByRef.get(state.selectedRoute) || []).forEach((route) => {
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
    if (!state.lastSnapshotAt) return;
    $('last-updated').textContent = `Обновено ${fmtTime(state.lastSnapshotAt / 1000)}`;
  }

  function receiveSnapshot(payload) {
    let vehicles;
    if (Array.isArray(payload)) vehicles = payload;
    else if (payload && Array.isArray(payload.vehicles)) vehicles = payload.vehicles;
    else if (payload && Array.isArray(payload.data)) vehicles = payload.data;
    else if (payload && typeof payload === 'object') vehicles = [payload];
    else return;

    const now = Date.now();
    for (const raw of vehicles) {
      const incoming = normaliseVehicle(raw);
      if (!incoming) continue;
      const previous = state.vehicles.get(incoming.id);
      const vehicle = mergeVehicleSnapshot(previous, incoming, now);
      state.vehicles.set(vehicle.id, vehicle);
    }
    state.lastSnapshotAt = now;
    for (const [id, vehicle] of state.vehicles.entries()) {
      if (now - vehicle.lastSeenAt > STALE_AFTER) {
        if (vehicle.marker && state.vehicleLayer.hasLayer(vehicle.marker)) state.vehicleLayer.removeLayer(vehicle.marker);
        state.vehicles.delete(id);
      }
    }
    setConnection('connected', `${CONFIG.sources?.[state.source]?.label || 'ЦГМ'} · ${state.vehicles.size} превозни средства`);
    updateLastUpdated();
    updateStats();
    updateVehicleMarkers();
    renderVehicleList();
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

  function connectSocket() {
    if (!window.WebSocket) {
      setConnection('error', 'Браузърът не поддържа WebSocket.');
      return;
    }
    const sourceConfig = CONFIG.sources?.[state.source];
    if (!sourceConfig?.url) {
      setConnection('error', 'Не е конфигуриран live източник.');
      return;
    }
    clearTimeout(state.reconnectTimer);
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
          console.warn('Неразпознато live съобщение:', error);
        }
      };
      socket.onerror = () => {
        if (generation === state.socketGeneration) setConnection('connecting', 'Временно прекъсване на потока');
      };
      socket.onclose = () => {
        if (generation !== state.socketGeneration) return;
        setConnection('error', 'Ще опитаме повторно автоматично');
        state.reconnectTimer = setTimeout(() => {
          if (generation === state.socketGeneration) connectSocket();
        }, RECONNECT_DELAY);
      };
    } catch (error) {
      console.error('Неуспешна WebSocket връзка:', error);
      setConnection('error', 'Неуспешна връзка. Повторен опит след малко.');
      state.reconnectTimer = setTimeout(connectSocket, RECONNECT_DELAY);
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
      $('line-filter').value = 'all';
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
    $('search-input').addEventListener('input', (event) => {
      state.query = event.target.value;
      updateVehicleMarkers();
      renderVehicleList();
    });
    $('type-filter').addEventListener('change', (event) => {
      state.selectedType = event.target.value;
      updateVehicleMarkers();
      renderVehicleList();
    });
    $('line-filter').addEventListener('change', (event) => {
      state.selectedRoute = event.target.value;
      renderRoute(true);
      renderStops();
      updateVehicleMarkers();
      renderVehicleList();
    });
    $('clear-filters').addEventListener('click', () => {
      state.selectedType = 'all';
      state.selectedRoute = 'all';
      state.query = '';
      $('type-filter').value = 'all';
      $('line-filter').value = 'all';
      $('search-input').value = '';
      renderRoute();
      renderStops();
      updateVehicleMarkers();
      renderVehicleList();
    });
    $('stops-toggle').addEventListener('change', (event) => {
      state.showStops = event.target.checked;
      if (state.showStops && state.map && state.map.getZoom() < 14) {
        showToast('Приближи картата до ниво 14 или повече, за да видиш спирките.', 3200);
      }
      renderStops();
    });
    $('route-toggle').addEventListener('change', (event) => {
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
    $('reconnect-button').addEventListener('click', () => connectSocket());
    $('source-filter').addEventListener('change', (event) => {
      state.source = event.target.value;
      state.vehicles.clear();
      state.vehicleLayer?.clearLayers();
      state.lastSnapshotAt = null;
      $('last-updated').textContent = 'Изчакване на първи ъпдейт';
      updateStats();
      renderVehicleList();
      connectSocket();
    });
    $('settings-button').addEventListener('click', () => {
      const panel = $('settings-panel');
      panel.hidden = !panel.hidden;
    });
    $('theme-toggle').addEventListener('click', () => setTheme(!document.body.classList.contains('dark-theme')));
    $('locate-button').addEventListener('click', () => {
      if (!navigator.geolocation) { showToast('Браузърът не поддържа геолокация.'); return; }
      navigator.geolocation.getCurrentPosition((position) => {
        const coords = [position.coords.latitude, position.coords.longitude];
        if (state.userMarker) state.userMarker.setLatLng(coords);
        else state.userMarker = L.circleMarker(coords, { radius: 7, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(state.map).bindPopup('Твоето местоположение');
        state.map.flyTo(coords, 16, { duration: .6 });
      }, () => showToast('Няма достъп до местоположението. Провери разрешенията на браузъра.'), { enableHighAccuracy: true, timeout: 8000 });
    });
    $('reset-map-button').addEventListener('click', () => state.map?.flyTo(SOFIA_CENTER, SOFIA_ZOOM, { duration: .5 }));
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        $('search-input').focus();
      }
      if (event.key === 'Escape') $('search-input').blur();
    });
    window.addEventListener('resize', () => state.map?.invalidateSize());
    setInterval(() => {
      updateLastUpdated();
      updateStats();
      renderVehicleList();
      state.vehicles.forEach((vehicle, id) => {
        if (Date.now() - vehicle.lastSeenAt > STALE_AFTER) {
          if (vehicle.marker && state.vehicleLayer?.hasLayer(vehicle.marker)) state.vehicleLayer.removeLayer(vehicle.marker);
          state.vehicles.delete(id);
        }
      });
      updateVehicleMarkers();
    }, 15000);
  }

  async function init() {
    initMap();
    bindUI();
    await loadMapData();
    // Live data can still be available even if the static route dataset fails to load.
    connectSocket();
  }

  window.addEventListener('DOMContentLoaded', init, { once: true });
})();
