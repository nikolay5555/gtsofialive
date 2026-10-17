/* Official Sofia Traffic GTFS-Realtime source. */
window.GTSOFIA_LIVEMAP_CONFIG = {
  sources: {
    gtfs: {
      label: 'ЦГМ · GTFS-Realtime',
      // Official vehicle-position feed. The response is a GTFS-Realtime protobuf message.
      url: 'https://gtfs.sofiatraffic.bg/api/v1/vehicle-positions'
    }
  },
  // GTFS-Realtime positions are refreshed every few seconds by the source.
  pollIntervalMs: 5_000,
  routeCatalogUrl: 'https://raw.githubusercontent.com/Dimitar5555/sofiatraffic-schedules/master/data/routes.json',
  minActiveSpeed: 3,
  refreshStaleAfterMs: 120_000,
  reconnectDelayMs: 2_500,
  mapCenter: [42.6977, 23.3219],
  mapZoom: 13
};
