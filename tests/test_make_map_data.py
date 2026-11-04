import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "make-map-data.py"
SPEC = importlib.util.spec_from_file_location("gts_live_map_builder_tests", MODULE_PATH)
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class ModularSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "gtsofia"
        self.data_dir = self.root / "data"
        self.data_dir.mkdir(parents=True)
        self.payloads = {
            "metadata.json": {
                "schemaVersion": 2,
                "updatedAt": "2026-10-27",
                "source": "Test GTFS",
                "lineOverrides": [{"cgm_id": "R1", "route_ref": "12"}],
            },
            "routes.json": [
                {"route_id": "R1", "route_short_name": "12", "route_type": "3", "route_color": "123456"},
                {"route_id": "M1", "route_short_name": "M1", "route_type": "1", "route_color": "654321"},
            ],
            "stops.json": [
                {"stop_id": "0001", "stop_code": "0001", "stop_name": "A", "stop_lat": "42.7", "stop_lon": "23.3"},
                {"stop_id": "0002", "stop_code": "0002", "stop_name": "B", "stop_lat": "42.8", "stop_lon": "23.4"},
            ],
            "directions.json": {
                "R1": {"D1": {"headsign": "B", "destination": "B", "shape_id": "SH1", "pattern": ["0001", "0002"]}},
                "M1": {"D1": {"headsign": "Metro", "destination": "Metro", "shape_id": "SH2", "pattern": ["M1", "M2"]}},
            },
            "shapes.json": {
                "SH1": [
                    {"lat": 42.7000001, "lon": 23.3000001},
                    {"lat": 42.7001001, "lon": 23.3001001},
                    {"lat": 42.7002001, "lon": 23.3002001},
                ],
                "SH2": [{"lat": 42.6, "lon": 23.2}, {"lat": 42.61, "lon": 23.21}],
            },
        }
        for filename, value in self.payloads.items():
            (self.data_dir / filename).write_text(json.dumps(value), encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_load_modular_data_from_data_directory_or_project_root(self):
        from_data = BUILDER.load_source(self.data_dir)
        from_root = BUILDER.load_source(self.root)
        from_metadata = BUILDER.load_source(self.data_dir / "metadata.json")
        for source in (from_data, from_root, from_metadata):
            self.assertEqual(source["updatedAt"], "2026-10-27")
            self.assertEqual(len(source["routes"]), 2)
            self.assertIn("R1", source["directions"])
            self.assertIn("SH1", source["shapes"])

    def test_builder_emits_the_same_compact_map_schema_from_modular_sources(self):
        output = Path(self.temp.name) / "transport-map.json"
        BUILDER.build(self.root, output, tolerance_m=0)
        result = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(result["updatedAt"], "2026-10-27")
        self.assertEqual(result["source"], "Test GTFS")
        self.assertEqual([r["route_id"] for r in result["routes"]], ["R1"])
        self.assertEqual(set(result["directions"]), {"R1"})
        self.assertEqual(set(result["shapes"]), {"SH1"})
        self.assertEqual(result["lineOverrides"], self.payloads["metadata.json"]["lineOverrides"])
        self.assertEqual(result["shapes"]["SH1"][0]["lat"], 42.7)
        self.assertEqual(len(result["stops"]), 2)

    def test_legacy_monolith_is_still_supported(self):
        legacy = {
            "updatedAt": "2026-10-27", "source": "Legacy GTFS",
            "lineOverrides": [],
            "routes": self.payloads["routes.json"],
            "stops": self.payloads["stops.json"],
            "directions": self.payloads["directions.json"],
            "shapes": self.payloads["shapes.json"],
        }
        path = Path(self.temp.name) / "transport.json"
        path.write_text(json.dumps(legacy), encoding="utf-8")
        self.assertEqual(BUILDER.load_source(path)["source"], "Legacy GTFS")


class UpdaterDownloadTests(unittest.TestCase):
    def test_download_source_fetches_only_map_relevant_modular_files(self):
        import importlib.util
        import io
        from unittest.mock import patch

        updater_path = ROOT / "scripts" / "update-map-data.py"
        updater_spec = importlib.util.spec_from_file_location("gts_live_updater_tests", updater_path)
        updater = importlib.util.module_from_spec(updater_spec)
        updater_spec.loader.exec_module(updater)

        payloads = {
            "metadata.json": {"updatedAt": "2026-10-27"},
            "routes.json": [],
            "stops.json": [],
            "directions.json": {},
            "shapes.json": {},
        }
        requested = []

        class FakeResponse(io.BytesIO):
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.close()

        def fake_urlopen(request, timeout=120):
            url = request.full_url
            requested.append(url)
            filename = url.rsplit("/", 1)[-1]
            return FakeResponse(json.dumps(payloads[filename]).encode("utf-8"))

        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "downloaded"
            with patch.object(updater.urllib.request, "urlopen", side_effect=fake_urlopen):
                source_path = updater.download_source("https://example.test/gtsofia/data", destination)

            self.assertEqual(source_path, destination)
            self.assertEqual({path.name for path in destination.iterdir()}, set(payloads))
            self.assertEqual(len(requested), 5)
            self.assertTrue(all(url.startswith("https://example.test/gtsofia/data/") for url in requested))



if __name__ == "__main__":
    unittest.main()
