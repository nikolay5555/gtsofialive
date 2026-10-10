/*
 * Live feed endpoints currently used by the reference implementation.
 * Configure your own compatible WebSocket endpoint here if needed.
 * Expected message: JSON array of vehicles, each with `coords: [lat, lon]`.
 */
window.GTSOFIA_LIVEMAP_CONFIG = {
  sources: {
    gtfs: {
      label: 'ЦГМ · GTFS',
      url: 'wss://sofiatraffic-proxy.onrender.com/v2/livemap/'
    },
    avl: {
      label: 'ЦГМ · AVL',
      url: 'wss://sofiatraffic-proxy.onrender.com/livemap/'
    }
  },
  refreshStaleAfterMs: 120_000,
  reconnectDelayMs: 2_500,
  mapCenter: [42.6977, 23.3219],
  mapZoom: 13
};
