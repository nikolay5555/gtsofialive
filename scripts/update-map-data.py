#!/usr/bin/env python3
"""Refresh GTSOFIA Live's compact map data from the main GTSofia project.

Default usage (download latest published source data):
    python scripts/update-map-data.py

Use a locally generated data/transport.json instead:
    python scripts/update-map-data.py --source ../gtsofia-main/data/transport.json

The updater writes only data/transport-map.json. It does not create a
scheduled GitHub Action and does not edit the route/stop catalogs or local
configuration files.
"""

import argparse
import importlib.util
import json
import os
import tempfile
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path
from typing import Any

DEFAULT_SOURCE_URL = (
    "https://raw.githubusercontent.com/nikolay5555/gtsofia/main/data/transport.json"
)
USER_AGENT = "GTSOFIA-Live-Map-Updater/1.0"

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
BUILDER_FILE = ROOT / "scripts" / "make-map-data.py"
DEFAULT_OUTPUT = DATA_DIR / "transport-map.json"

# Conservative sanity checks intended to catch HTML error pages, partial files,
# or a source file with the wrong schema before replacing the current map data.
MIN_COUNTS = {
    "routes": 100,
    "stops": 500,
    "directions": 50,
    "shapes": 50,
}


def load_builder():
    spec = importlib.util.spec_from_file_location("gts_live_map_builder", BUILDER_FILE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Не може да бъде зареден преобразувателят: {BUILDER_FILE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def download_source(url: str, destination: Path) -> None:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
    )
    print(f"Изтеглям статичните данни от: {url}")
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            if response.status != 200:
                raise RuntimeError(f"Източникът върна HTTP статус {response.status}.")
            with destination.open("wb") as output:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(
            "Не успях да изтегля изходните данни. Провери интернет връзката "
            "или подай локален файл чрез --source. Подробности: " + str(exc)
        ) from exc
    if destination.stat().st_size == 0:
        raise RuntimeError("Изтегленият файл е празен; текущите данни няма да бъдат променени.")
    print(f"Изтеглен файл: {destination.stat().st_size / 1024 / 1024:.2f} MB")


def parse_updated_at(value: Any) -> date | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def validate_generated_map(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as stream:
            data = json.load(stream)
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Генерираният файл не е валиден JSON: {exc}") from exc

    required = {"updatedAt", "source", "routes", "stops", "directions", "shapes"}
    missing = required - data.keys() if isinstance(data, dict) else required
    if missing:
        raise RuntimeError("Генерираните данни нямат задължителни полета: " + ", ".join(sorted(missing)))

    actual = {
        "routes": len(data["routes"]) if isinstance(data["routes"], list) else 0,
        "stops": len(data["stops"]) if isinstance(data["stops"], list) else 0,
        "directions": len(data["directions"]) if isinstance(data["directions"], dict) else 0,
        "shapes": len(data["shapes"]) if isinstance(data["shapes"], dict) else 0,
    }
    too_small = [f"{key}: {actual[key]} (минимум {minimum})"
                 for key, minimum in MIN_COUNTS.items() if actual[key] < minimum]
    if too_small:
        raise RuntimeError(
            "Изходните данни изглеждат непълни; съществуващият файл е запазен. "
            + "; ".join(too_small)
        )

    if not any(isinstance(points, list) and len(points) >= 2 for points in data["shapes"].values()):
        raise RuntimeError("Не са намерени валидни маршрутни геометрии; съществуващият файл е запазен.")

    return data


def refuse_downgrade(output_path: Path, new_data: dict[str, Any], allow_older: bool) -> None:
    if allow_older or not output_path.exists():
        return
    try:
        with output_path.open("r", encoding="utf-8") as stream:
            old_data = json.load(stream)
    except (OSError, json.JSONDecodeError):
        return

    old_date = parse_updated_at(old_data.get("updatedAt")) if isinstance(old_data, dict) else None
    new_date = parse_updated_at(new_data.get("updatedAt"))
    if old_date and new_date and new_date < old_date:
        raise RuntimeError(
            f"Източникът е по-стар ({new_date.isoformat()}) от текущия файл "
            f"({old_date.isoformat()}). Файлът не е променен. Ако това е умишлено, "
            "използвай --allow-older-source."
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source", type=Path,
        help="локален data/transport.json от проекта GTSofia; при липса се изтегля файлът от GitHub",
    )
    parser.add_argument(
        "--source-url", default=DEFAULT_SOURCE_URL,
        help="URL на публикувания data/transport.json (използва се, ако --source не е зададен)",
    )
    parser.add_argument(
        "--output", type=Path, default=DEFAULT_OUTPUT,
        help="изходен файл (по подразбиране data/transport-map.json)",
    )
    parser.add_argument(
        "--tolerance-m", type=float, default=8.0,
        help="опростяване на геометриите в метри (по подразбиране 8)",
    )
    parser.add_argument(
        "--allow-older-source", action="store_true",
        help="разрешава умишлено връщане към изходни данни с по-стара дата",
    )
    args = parser.parse_args()

    if args.tolerance_m < 0:
        parser.error("--tolerance-m трябва да е положително или нула")

    source_path: Path | None = None
    temporary_source_dir: tempfile.TemporaryDirectory[str] | None = None
    candidate_path: Path | None = None
    output_path = args.output.expanduser().resolve()

    try:
        if args.source:
            source_path = args.source.expanduser().resolve()
            if not source_path.is_file():
                raise RuntimeError(f"Локалният изходен файл не е намерен: {source_path}")
            print(f"Използвам локални данни: {source_path}")
        else:
            temporary_source_dir = tempfile.TemporaryDirectory(prefix="gts-live-source-")
            source_path = Path(temporary_source_dir.name) / "transport.json"
            download_source(args.source_url, source_path)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        fd, candidate_name = tempfile.mkstemp(
            prefix=f".{output_path.name}.", suffix=".tmp", dir=output_path.parent
        )
        os.close(fd)
        candidate_path = Path(candidate_name)

        builder = load_builder()
        builder.build(source_path, candidate_path, args.tolerance_m)
        new_data = validate_generated_map(candidate_path)
        refuse_downgrade(output_path, new_data, args.allow_older_source)

        os.replace(candidate_path, output_path)
        candidate_path = None

        point_count = sum(
            len(points) for points in new_data["shapes"].values() if isinstance(points, list)
        )
        print("\nОбновяването приключи успешно.")
        print(f"Източникът е обновен на: {new_data.get('updatedAt') or 'неизвестно'}")
        print(f"Линии: {len(new_data['routes'])}; спирки: {len(new_data['stops'])}; "
              f"направления: {len(new_data['directions'])}; геометрии: {len(new_data['shapes'])}; "
              f"точки: {point_count}")
        print(f"Записан файл: {output_path}")
        return 0
    except Exception as exc:
        print(f"ГРЕШКА: {exc}")
        print("Текущият файл с данни не е заменен.")
        return 1
    finally:
        if candidate_path and candidate_path.exists():
            candidate_path.unlink()
        if temporary_source_dir is not None:
            temporary_source_dir.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
