#!/usr/bin/env python3
"""Build a compact live-map dataset from GTSofia's modular data files.

Usage:
  python scripts/make-map-data.py /path/to/gtsofia/data
  python scripts/make-map-data.py /path/to/gtsofia/data/transport.json  # legacy

The map needs metadata, routes, stops, direction patterns, and route geometry
only. Schedule, trip and calendar tables are omitted. Shape geometry is
simplified with an 8 m Douglas-Peucker tolerance for GitHub Pages.
"""
import argparse
import json
import math
from pathlib import Path
from typing import Any

SURFACE_TYPES = {"0", "3", "11"}


def simplify_shape(points: list[dict[str, Any]], tolerance_m: float = 8.0) -> list[dict[str, float]]:
    """Simplify [lat/lon] points using a local metric projection and Douglas-Peucker."""
    clean = []
    for point in points:
        try:
            lat, lon = float(point["lat"]), float(point["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(lat) and math.isfinite(lon) and abs(lat) <= 90 and abs(lon) <= 180:
            clean.append((lat, lon))
    if len(clean) <= 2:
        return [{"lat": round(lat, 6), "lon": round(lon, 6)} for lat, lon in clean]

    mean_lat = sum(lat for lat, _ in clean) / len(clean)
    x_scale = 111_320.0 * math.cos(math.radians(mean_lat))
    y_scale = 110_540.0
    projected = [(lon * x_scale, lat * y_scale) for lat, lon in clean]
    keep = [False] * len(clean)
    keep[0] = keep[-1] = True
    stack = [(0, len(clean) - 1)]
    tolerance_sq = tolerance_m * tolerance_m

    while stack:
        start, end = stack.pop()
        ax, ay = projected[start]
        bx, by = projected[end]
        dx, dy = bx - ax, by - ay
        denom = dx * dx + dy * dy
        best_error = tolerance_sq
        best_index = None
        for index in range(start + 1, end):
            px, py = projected[index]
            if denom:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / denom))
                qx, qy = ax + t * dx, ay + t * dy
            else:
                qx, qy = ax, ay
            error = (px - qx) ** 2 + (py - qy) ** 2
            if error > best_error:
                best_error, best_index = error, index
        if best_index is not None:
            keep[best_index] = True
            stack.append((start, best_index))
            stack.append((best_index, end))

    return [
        {"lat": round(clean[index][0], 6), "lon": round(clean[index][1], 6)}
        for index, retained in enumerate(keep) if retained
    ]


MODULAR_SOURCE_FILES = {
    "metadata": "metadata.json",
    "routes": "routes.json",
    "stops": "stops.json",
    "directions": "directions.json",
    "shapes": "shapes.json",
}


def _load_json(path: Path) -> Any:
    try:
        with path.open(encoding="utf-8") as stream:
            return json.load(stream)
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Не може да се прочете {path}: {exc}") from exc


def load_source(input_path: Path) -> dict[str, Any]:
    """Load either the modular GTSofia data directory or a legacy monolith."""
    input_path = input_path.expanduser().resolve()

    if input_path.is_file() and input_path.name == "metadata.json":
        return load_source(input_path.parent)

    if input_path.is_dir():
        candidates = [input_path, input_path / "data"]
        data_dir = next(
            (
                candidate for candidate in candidates
                if all((candidate / filename).is_file()
                       for filename in MODULAR_SOURCE_FILES.values())
            ),
            None,
        )
        if data_dir is None:
            expected = ", ".join(MODULAR_SOURCE_FILES.values())
            raise RuntimeError(
                f"Не са намерени модулните данни в {input_path}. "
                f"Очакват се файловете: {expected}."
            )

        source = _load_json(data_dir / MODULAR_SOURCE_FILES["metadata"])
        if not isinstance(source, dict):
            raise RuntimeError("metadata.json трябва да съдържа JSON обект.")
        source = dict(source)
        for key, filename in MODULAR_SOURCE_FILES.items():
            if key == "metadata":
                continue
            source[key] = _load_json(data_dir / filename)
        return source

    if input_path.is_file():
        source = _load_json(input_path)
        if not isinstance(source, dict) or not isinstance(source.get("routes"), list):
            raise RuntimeError(
                f"{input_path} не е съвместим transport.json и не е metadata.json "
                "от директория с модулни данни."
            )
        return source

    raise RuntimeError(f"Източникът не е намерен: {input_path}")


def build(input_path: Path, output_path: Path, tolerance_m: float = 8.0) -> None:
    source = load_source(input_path)

    routes = [
        {
            key: route[key]
            for key in ("route_id", "route_short_name", "route_type", "route_color")
            if key in route
        }
        for route in source.get("routes", [])
        if str(route.get("route_type")) in SURFACE_TYPES
    ]
    route_ids = {str(route.get("route_id")) for route in routes}

    stops = [
        {
            target: stop.get(source_key, "")
            for target, source_key in (
                ("stop_id", "stop_id"), ("stop_code", "stop_code"),
                ("stop_name", "stop_name"), ("stop_lat", "stop_lat"), ("stop_lon", "stop_lon"),
            )
        }
        for stop in source.get("stops", [])
    ]

    directions = {}
    used_shape_ids = set()
    for route_id, items in source.get("directions", {}).items():
        if str(route_id) not in route_ids:
            continue
        compact_items = {}
        for key, direction in items.items():
            entry = {
                field: direction[field]
                for field in ("headsign", "destination", "shape_id", "pattern")
                if field in direction
            }
            shape_id = entry.get("shape_id")
            if shape_id:
                used_shape_ids.add(str(shape_id))
            if entry:
                compact_items[str(key)] = entry
        if compact_items:
            directions[str(route_id)] = compact_items

    shapes = {}
    for shape_id in sorted(used_shape_ids):
        raw_points = source.get("shapes", {}).get(shape_id)
        if isinstance(raw_points, list) and raw_points:
            shapes[shape_id] = simplify_shape(raw_points, tolerance_m)

    data = {
        "updatedAt": source.get("updatedAt", ""),
        "source": source.get("source", ""),
        "lineOverrides": source.get("lineOverrides", []),
        "routes": routes,
        "stops": stops,
        "directions": directions,
        "shapes": shapes,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False, separators=(",", ":"))

    point_count = sum(len(points) for points in shapes.values())
    print(f"Записан файл: {output_path} ({output_path.stat().st_size / 1024 / 1024:.2f} MB)")
    print(f"Линии: {len(routes)}; спирки: {len(stops)}; геометрии: {len(shapes)}; точки: {point_count}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "input", type=Path,
        help="директория data/ от GTSofia, коренът на проекта или стар transport.json",
    )
    parser.add_argument("--output", type=Path, default=Path("data/transport-map.json"), help="Изходен JSON файл")
    parser.add_argument("--tolerance-m", type=float, default=8.0, help="Допуск за опростяване на геометрията в метри (по подразбиране 8)")
    args = parser.parse_args()
    if args.tolerance_m < 0:
        parser.error("--tolerance-m трябва да е положително или нула")
    build(args.input, args.output, args.tolerance_m)


if __name__ == "__main__":
    main()
