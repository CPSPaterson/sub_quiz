#!/usr/bin/env python3
"""
Shrink the filtered Sydney suburb GeoJSON into a small file the browser can load.

- Simplifies boundaries (Douglas-Peucker) and rounds coordinates
- Keeps only name + postcode
- Merges features that share a suburb name into one MultiPolygon
- Drops water-only "suburbs" (Botany Bay, Pittwater, ...)
- Tags each suburb with a quiz region, based on which council (LGA) it sits in.
  Council boundaries: suburbjsons/lga.geojson (ABS ASGS 2021 LGAs)

Usage:
    python3 tools/build_data.py [input] [output] [tolerance_deg]
Defaults: suburbjsons/almost.geojson -> src/data/suburbs.geojson, 0.00008 (~8 m)
No dependencies.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "suburbjsons" / "almost.geojson"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "src" / "data" / "suburbs.geojson"
TOL = float(sys.argv[3]) if len(sys.argv) > 3 else 0.00008
DECIMALS = 5
LGA_FILE = ROOT / "suburbjsons" / "lga.geojson"

# Gazetted "suburbs" that are only water.
WATER_ONLY = {"Botany Bay", "Middle Harbour", "North Harbour", "Pittwater", "Port Hacking"}

# Quiz regions, as groups of councils. Order here is the order shown in the app.
REGIONS = {
    "City & Eastern Suburbs": ["Sydney", "Waverley", "Woollahra", "Randwick"],
    "Inner West": ["Inner West", "Canada Bay", "Burwood", "Strathfield"],
    "North Shore": ["North Sydney", "Mosman", "Lane Cove", "Willoughby", "Hunters Hill",
                    "Ryde", "Ku-ring-gai", "Hornsby"],
    "Northern Beaches": ["Northern Beaches"],
    "Hills & Hawkesbury": ["The Hills Shire", "Hawkesbury"],
    "Parramatta & Blacktown": ["Parramatta", "Cumberland", "Blacktown"],
    "South West": ["Canterbury-Bankstown", "Fairfield", "Liverpool"],
    "St George & Sutherland": ["Bayside (NSW)", "Georges River", "Sutherland Shire"],
    "Macarthur": ["Camden", "Campbelltown (NSW)", "Wollondilly"],
    "Penrith & Blue Mountains": ["Penrith", "Blue Mountains"],
}
LGA_TO_REGION = {lga: region for region, lgas in REGIONS.items() for lga in lgas}
# Suburbs whose council lookup lands outside the list above.
REGION_OVERRIDES = {"Woronora Dam": "St George & Sutherland"}


# ---------- point-in-polygon helpers for region lookup ----------
def in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def in_polygon(x, y, poly):
    return in_ring(x, y, poly[0]) and not any(in_ring(x, y, h) for h in poly[1:])


def ring_area(r):
    return abs(sum(r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1] for i in range(len(r) - 1))) / 2


def inside_point(polys):
    """A point guaranteed inside the largest polygon (midpoint of the widest scanline span)."""
    ring = max(polys, key=lambda p: ring_area(p[0]))[0]
    ys = [p[1] for p in ring]
    best = None
    for frac in (0.5, 0.4, 0.6, 0.3, 0.7):
        y = min(ys) + (max(ys) - min(ys)) * frac
        xs = []
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            if (y1 > y) != (y2 > y):
                xs.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
        xs.sort()
        for a, b in zip(xs[::2], xs[1::2]):
            if best is None or b - a > best[0]:
                best = (b - a, ((a + b) / 2, y))
    return best[1]


def load_lgas():
    data = json.loads(LGA_FILE.read_text(encoding="utf-8"))
    return [(f["properties"]["lga_name_2021"], polygons_of(f["geometry"])) for f in data["features"]]


def find_region(name, polys, lgas):
    if name in REGION_OVERRIDES:
        return REGION_OVERRIDES[name]
    x, y = inside_point(polys)
    for lga, lpolys in lgas:
        if any(in_polygon(x, y, p) for p in lpolys):
            return LGA_TO_REGION.get(lga)
    # Point fell in a coastal gap of the simplified council outline: use the nearest council.
    def dist(lpolys):
        return min((x - px) ** 2 + (y - py) ** 2 for p in lpolys for px, py in p[0])
    lga = min((l for l in lgas if l[0] in LGA_TO_REGION), key=lambda l: dist(l[1]))[0]
    return LGA_TO_REGION[lga]


def perp_dist_sq(p, a, b):
    ax, ay = a
    dx, dy = b[0] - ax, b[1] - ay
    if dx == 0 and dy == 0:
        return (p[0] - ax) ** 2 + (p[1] - ay) ** 2
    t = ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    px, py = ax + t * dx, ay + t * dy
    return (p[0] - px) ** 2 + (p[1] - py) ** 2


def simplify(points, tol):
    """Iterative Douglas-Peucker."""
    if len(points) < 3:
        return points
    tol_sq = tol * tol
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        max_d, idx = 0.0, -1
        for i in range(start + 1, end):
            d = perp_dist_sq(points[i], points[start], points[end])
            if d > max_d:
                max_d, idx = d, i
        if max_d > tol_sq and idx != -1:
            keep[idx] = True
            stack.append((start, idx))
            stack.append((idx, end))
    return [p for p, k in zip(points, keep) if k]


def simplify_ring(ring, tol):
    pts = simplify(ring, tol)
    pts = [[round(x, DECIMALS), round(y, DECIMALS)] for x, y in pts]
    # drop consecutive duplicates created by rounding
    out = [pts[0]]
    for p in pts[1:]:
        if p != out[-1]:
            out.append(p)
    if out[0] != out[-1]:
        out.append(out[0])
    return out if len(out) >= 4 else None


def polygons_of(geom):
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []


def nice_name(raw):
    name = raw.strip().title()
    name = re.sub(r"\bMc([a-z])", lambda m: "Mc" + m.group(1).upper(), name)
    return name


def main():
    data = json.loads(SRC.read_text(encoding="utf-8"))
    merged = {}  # name -> {"postcode", "polys"}
    for f in data["features"]:
        props = f.get("properties") or {}
        name = nice_name(props.get("suburbname", ""))
        if not name or not f.get("geometry") or name in WATER_ONLY:
            continue
        entry = merged.setdefault(name, {"postcode": props.get("postcode"), "polys": []})
        for poly in polygons_of(f["geometry"]):
            rings = [simplify_ring(r, TOL) for r in poly]
            if rings[0] is None:
                continue  # outer ring collapsed: polygon is tiny
            entry["polys"].append([r for r in rings if r])

    lgas = load_lgas()
    features = []
    counts = {r: 0 for r in REGIONS}
    for i, (name, e) in enumerate(sorted(merged.items())):
        if not e["polys"]:
            continue
        region = find_region(name, e["polys"], lgas)
        if region is None:
            raise SystemExit(f"No region for {name}: add it to REGION_OVERRIDES")
        counts[region] += 1
        geom = (
            {"type": "Polygon", "coordinates": e["polys"][0]}
            if len(e["polys"]) == 1
            else {"type": "MultiPolygon", "coordinates": e["polys"]}
        )
        features.append({
            "type": "Feature",
            "id": i,
            "properties": {"name": name, "postcode": e["postcode"], "region": region},
            "geometry": geom,
        })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"type": "FeatureCollection", "regions": list(REGIONS),
                               "features": features}, separators=(",", ":")), encoding="utf-8")
    print(f"{len(data['features'])} features in -> {len(features)} suburbs out")
    for region, n in counts.items():
        print(f"  {n:4d}  {region}")
    print(f"Wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
