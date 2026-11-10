#!/usr/bin/env python3
"""
filter_sydney_suburbs.py

Filters a folder of NSW suburb GeoJSON polygons to only those
within the Greater Sydney region (~658 suburbs).

Usage:
    python filter_sydney_suburbs.py --input ./geojson --output ./sydney_suburbs.geojson

Dependencies:
    pip install shapely
"""

import argparse
import json
import os
from pathlib import Path
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from shapely.validation import make_valid


# ---------------------------------------------------------------------------
# Greater Sydney boundary polygon
#
# Key boundary decisions:
#   NORTH:     Palm Beach headland (~-33.578) is the coastal limit.
#              Broken Bay physically separates Sydney from Central Coast.
#              The polygon hugs the Hawkesbury River westward so suburbs
#              like Woy Woy, Gosford, Pearl Beach are excluded.
#   NORTHWEST: Extends up to Kurrajong Heights (150.667, -33.533).
#   WEST:      Extends to Katoomba (150.312, -33.714) — Blue Mountains included.
#   SOUTHWEST: Extends to Bargo (150.575, -34.295).
#   SOUTH:     Royal National Park / Helensburgh as the natural boundary.
#   EAST:      Coastal boundary pushed out past Bondi, Clovelly, Maroubra,
#              Malabar, Little Bay, La Perouse, Phillip Bay so all beach
#              suburbs are captured.
#
# Coordinates are (longitude, latitude).
# ---------------------------------------------------------------------------
GREATER_SYDNEY_COORDS = [
    # ── NORTHEAST: Palm Beach headland (tip of Northern Beaches peninsula) ──
    (151.322, -33.578),

    # ── NORTH: Pittwater / Broken Bay coastal arm ──
    # Stay tight to the Sydney side of Broken Bay — excludes Central Coast
    (151.290, -33.582),
    (151.230, -33.600),
    (151.170, -33.628),   # Hawkesbury River mouth / Broken Bay western shore

    # ── Follow Hawkesbury River west ──
    (151.060, -33.628),
    (150.960, -33.605),
    (150.880, -33.568),
    (150.820, -33.543),

    # ── NORTHWEST: up to Kurrajong Heights ──
    (150.760, -33.515),
    (150.710, -33.510),
    (150.667, -33.533),   # Kurrajong Heights

    # ── WEST: arc down and out to Katoomba ──
    (150.560, -33.578),
    (150.450, -33.640),
    (150.380, -33.680),
    (150.312, -33.714),   # Katoomba

    # ── SOUTHWEST: descend to Bargo ──
    (150.330, -33.800),
    (150.380, -33.920),
    (150.440, -34.040),
    (150.500, -34.160),
    (150.545, -34.240),
    (150.575, -34.295),   # Bargo

    # ── SOUTH: east along southern boundary through Campbelltown/Sutherland ──
    (150.660, -34.265),
    (150.760, -34.190),
    (150.855, -34.155),

    # ── Southern boundary: Royal National Park / Helensburgh ──
    (150.960, -34.185),
    (151.045, -34.165),
    (151.100, -34.105),

    # ── SOUTHEAST: Sutherland / Cronulla ──
    (151.148, -34.058),
    (151.195, -34.018),

    # ── EAST: Botany Bay / eastern beach suburbs ──
    # Push the boundary east enough to catch all coastal suburbs
    (151.218, -34.005),   # Phillip Bay
    (151.240, -33.990),   # La Perouse
    (151.258, -33.970),   # Little Bay / Malabar
    (151.268, -33.948),   # Maroubra
    (151.280, -33.926),   # South Coogee
    (151.292, -33.905),   # Clovelly
    (151.302, -33.882),   # Tamarama
    (151.308, -33.858),   # North Bondi / Bondi Beach

    # ── Eastern coastline back north to Palm Beach ──
    (151.318, -33.820),
    (151.326, -33.778),
    (151.332, -33.730),
    (151.334, -33.680),
    (151.332, -33.638),
    (151.326, -33.600),
    (151.322, -33.578),   # close — back to Palm Beach headland
]

# Build the Sydney region as a Shapely polygon
from shapely.geometry import Polygon as ShapelyPolygon
SYDNEY_REGION = ShapelyPolygon(GREATER_SYDNEY_COORDS)


def load_geojson_features(input_path: Path) -> list[dict]:
    """
    Load features from either:
      - A single GeoJSON FeatureCollection file, or
      - A directory of individual GeoJSON files (one feature or
        FeatureCollection per file).
    """
    features = []

    if input_path.is_dir():
        files = sorted(input_path.glob("**/*.geojson")) + sorted(input_path.glob("**/*.json"))
        if not files:
            raise FileNotFoundError(f"No .geojson or .json files found in {input_path}")
        for f in files:
            features.extend(_read_file_features(f))
    else:
        features.extend(_read_file_features(input_path))

    return features


def _read_file_features(filepath: Path) -> list[dict]:
    with open(filepath, encoding="utf-8") as fh:
        data = json.load(fh)

    if data.get("type") == "FeatureCollection":
        return data.get("features", [])
    elif data.get("type") == "Feature":
        return [data]
    else:
        # Bare geometry — wrap it
        return [{"type": "Feature", "geometry": data, "properties": {}}]


def is_within_sydney(feature: dict, buffer_deg: float = 0.0) -> bool:
    """
    Returns True if the feature's geometry intersects the Sydney region.
    Uses the centroid for a fast, reliable check — avoids boundary artefacts
    where a suburb straddles the edge of the defined region.

    Set buffer_deg > 0 (e.g. 0.01) to be slightly more inclusive at borders.
    """
    geom_raw = feature.get("geometry")
    if geom_raw is None:
        return False

    try:
        geom = make_valid(shape(geom_raw))
    except Exception:
        return False

    region = SYDNEY_REGION if buffer_deg == 0 else SYDNEY_REGION.buffer(buffer_deg)

    # Primary check: centroid inside region
    if region.contains(geom.centroid):
        return True

    # Secondary check: at least 50 % of the suburb overlaps the region
    try:
        if geom.area > 0:
            intersection = geom.intersection(region)
            if intersection.area / geom.area >= 0.50:
                return True
    except Exception:
        pass

    return False


def filter_sydney_suburbs(
    input_path: Path,
    output_path: Path,
    buffer_deg: float = 0.0,
    verbose: bool = True,
) -> int:
    """
    Main filter function. Returns the number of suburbs kept.
    """
    if verbose:
        print(f"Loading features from: {input_path}")

    all_features = load_geojson_features(input_path)
    total = len(all_features)

    if verbose:
        print(f"  Total features loaded : {total}")

    sydney_features = [f for f in all_features if is_within_sydney(f, buffer_deg)]
    kept = len(sydney_features)

    if verbose:
        removed = total - kept
        print(f"  Kept (Sydney)         : {kept}")
        print(f"  Removed (outside)     : {removed}")

    # Write output FeatureCollection
    output_path.parent.mkdir(parents=True, exist_ok=True)
    feature_collection = {
        "type": "FeatureCollection",
        "features": sydney_features,
    }
    with open(output_path, "w", encoding="utf-8") as fh:
        json.dump(feature_collection, fh, ensure_ascii=False, indent=2)

    if verbose:
        print(f"\nSaved to: {output_path}")

    return kept


def main():
    parser = argparse.ArgumentParser(
        description="Filter NSW suburb GeoJSON polygons to those within Greater Sydney."
    )
    parser.add_argument(
        "--input", "-i",
        required=True,
        help="Path to a GeoJSON file or a directory of GeoJSON files.",
    )
    parser.add_argument(
        "--output", "-o",
        default="sydney_suburbs.geojson",
        help="Output GeoJSON file path (default: sydney_suburbs.geojson).",
    )
    parser.add_argument(
        "--buffer",
        type=float,
        default=0.0,
        help=(
            "Buffer in degrees applied to the Sydney boundary "
            "(e.g. 0.01 ≈ 1 km). Useful for including border suburbs. "
            "Default: 0.0 (no buffer)."
        ),
    )
    parser.add_argument(
        "--list-suburbs",
        action="store_true",
        help="Print the name of every suburb that is kept.",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)

    if not input_path.exists():
        print(f"ERROR: Input path does not exist: {input_path}")
        raise SystemExit(1)

    # Run the filter
    all_features = load_geojson_features(input_path)
    total = len(all_features)
    print(f"Loading features from : {input_path}")
    print(f"  Total features loaded: {total}")

    sydney_features = [f for f in all_features if is_within_sydney(f, args.buffer)]
    kept = len(sydney_features)
    print(f"  Kept (Sydney)        : {kept}")
    print(f"  Removed (outside)    : {total - kept}")

    if args.list_suburbs:
        print("\nKept suburbs:")
        name_keys = ["SAL_NAME21", "SAL_NAME", "suburb", "name", "NAME", "LOC_NAME"]
        for f in sydney_features:
            props = f.get("properties") or {}
            name = next((props[k] for k in name_keys if k in props), "(unnamed)")
            print(f"  {name}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    feature_collection = {"type": "FeatureCollection", "features": sydney_features}
    with open(output_path, "w", encoding="utf-8") as fh:
        json.dump(feature_collection, fh, ensure_ascii=False, indent=2)

    print(f"\nSaved to: {output_path}")


if __name__ == "__main__":
    main()