/* GTFS-only live source. AVL is intentionally disabled. */
window.GTSOFIA_LIVEMAP_CONFIG = {
  sources: {
    gtfs: {
      label: 'ЦГМ · GTFS',
      url: 'wss://sofiatraffic-proxy.onrender.com/v2/livemap/'
    }
  },
  refreshStaleAfterMs: 120_000,
  reconnectDelayMs: 2_500,
  mapCenter: [42.6977, 23.3219],
  mapZoom: 13
};
