"""Zones: population (WorldPop grid) and activity attractors (OSM POIs) on a regular grid."""

from __future__ import annotations

import logging
import math
from collections import defaultdict

import numpy as np
import osmnx as ox
import rasterio
from rasterio.windows import from_bounds
from scipy.spatial import cKDTree

from . import config
from .download import fetch
from .geo import grid_center, grid_index, to_xy

log = logging.getLogger(__name__)

POI_TAGS = {
    "amenity": True,
    "shop": True,
    "office": True,
    "craft": True,
    "tourism": True,
    "leisure": ["park", "sports_centre", "stadium", "fitness_centre"],
    "building": ["office", "commercial", "retail", "industrial", "government",
                 "university", "school", "college", "hospital"],
}
CATEGORIES = ["work", "school", "shop", "health", "leisure"]


def classify(tags: dict) -> str | None:
    a, b = tags.get("amenity"), tags.get("building")
    if a in {"school", "kindergarten", "college", "university"} or b in {"school", "university", "college"}:
        return "school"
    if a in {"hospital", "clinic", "doctors"} or b == "hospital":
        return "health"
    if tags.get("shop") or a in {"marketplace", "restaurant", "cafe", "fast_food"} or b == "retail":
        return "shop"
    if (tags.get("office") or tags.get("craft") or b in {"office", "commercial", "industrial", "government"}
            or a in {"bank", "townhall", "courthouse", "police", "post_office", "embassy"}):
        return "work"
    if tags.get("leisure") or tags.get("tourism"):
        return "leisure"
    return None


def _is_set(v) -> bool:
    return v is not None and not (isinstance(v, float) and math.isnan(v))


def poi_points(bbox) -> list[tuple[float, float, str, float]]:
    """(lon, lat, category, size weight). Size weight = 1 + footprint/2000 m² (capped):
    OSM has no size for POIs, so large campuses/hospitals count more (assumption)."""
    ox.settings.cache_folder = str(config.CACHE / "osmnx")
    gdf = ox.features_from_bbox(bbox, tags=POI_TAGS)
    cols = [c for c in ["amenity", "shop", "office", "craft", "tourism", "leisure", "building"] if c in gdf.columns]
    proj = gdf.to_crs(3405)  # VN-2000 / UTM 48N, for areas
    out = []
    for (geom, pgeom, *vals) in zip(gdf.geometry, proj.geometry, *[gdf[c] for c in cols]):
        tags = {c: v for c, v in zip(cols, vals) if _is_set(v)}
        cat = classify(tags)
        if cat is None:
            continue
        c = geom.representative_point()
        area = pgeom.area if pgeom.geom_type in ("Polygon", "MultiPolygon") else 0.0
        out.append((c.x, c.y, cat, min(1.0 + area / 2000.0, 50.0)))
    log.info("POIs: %d classified of %d features", len(out), len(gdf))
    return out


def population_cells(bbox) -> tuple[list[tuple[float, float, float]], float]:
    path = fetch(config.WORLDPOP_URL, config.CACHE / "worldpop" / "vnm_ppp_2020_constrained.tif")
    with rasterio.open(path) as src:
        win = from_bounds(*bbox, transform=src.transform)
        arr = src.read(1, window=win, boundless=True, fill_value=0)
        tr = src.window_transform(win)
        nodata = src.nodata
    arr = np.where((arr == nodata) | (arr < 0), 0, arr).astype(float)
    rows, cols = np.nonzero(arr)
    cells = []
    for r, c in zip(rows, cols):
        lon, lat = tr * (c + 0.5, r + 0.5)
        if bbox[0] <= lon < bbox[2] and bbox[1] <= lat < bbox[3]:
            cells.append((lon, lat, float(arr[r, c])))
    total = sum(p for *_, p in cells)
    log.info("WorldPop cells: %d, total population in bbox: %.0f", len(cells), total)
    return cells, total


def build_zones(bbox, nodes: list[dict], links: list[dict]) -> tuple[list[dict], dict]:
    """Zones on a `ZONE_SIZE_M` grid. Each zone lists its access nodes: population of
    each 100 m WorldPop cell is spread over the minor-road (ngõ, residential) nodes
    near the cell centre; POIs attach to their nearest node. Trips start and end at
    these nodes, so traffic appears on the small streets where people live."""
    size = config.ZONE_SIZE_M
    acc: dict[tuple[int, int], dict] = {}

    def zone(ix, iy):
        return acc.setdefault((ix, iy), {"population": 0.0, "poi": {c: 0.0 for c in CATEGORIES},
                                         "access": defaultdict(lambda: [0.0, 0.0])})

    node_xy = np.array([to_xy(n["lon"], n["lat"]) for n in nodes])
    all_tree = cKDTree(node_xy)
    minor = sorted({l[e] for l in links if l["road_class"] in config.MINOR_CLASSES for e in ("from", "to")})
    minor_tree = cKDTree(node_xy[minor])

    cells, pop_total = population_cells(bbox)
    unplaced = 0.0
    for lon, lat, p in cells:
        z = zone(*grid_index(lon, lat, bbox, size))
        z["population"] += p
        xy = to_xy(lon, lat)
        near = [minor[k] for k in minor_tree.query_ball_point(xy, config.HOME_SNAP_M)]
        if not near:
            d, k = all_tree.query(xy)
            if d > size:
                unplaced += p
                continue
            near = [int(k)]
        for n in near:
            z["access"][n][0] += p / len(near)
    n_poi = 0
    for lon, lat, cat, w in poi_points(bbox):
        if not (bbox[0] <= lon < bbox[2] and bbox[1] <= lat < bbox[3]):
            continue
        z = zone(*grid_index(lon, lat, bbox, size))
        z["poi"][cat] += w
        d, k = all_tree.query(to_xy(lon, lat))
        if d <= config.POI_SNAP_M:
            z["access"][int(k)][1] += w
            n_poi += 1

    zones = []
    for (ix, iy), z in sorted(acc.items()):
        lon, lat = grid_center(ix, iy, bbox, size)
        x, y = to_xy(lon, lat)
        access = sorted((n, round(a, 2), round(b, 2)) for n, (a, b) in z["access"].items()
                        if round(a, 2) > 0 or round(b, 2) > 0)
        if access:
            centre = min(access, key=lambda a: (np.hypot(*(node_xy[a[0]] - (x, y))), a[0]))[0]
        else:
            d, k = all_tree.query((x, y))
            if d > size:  # e.g. cells in the river with no road nearby
                continue
            centre = int(k)
        zones.append({
            "lon": round(lon, 6), "lat": round(lat, 6), "node": int(centre),
            "population": round(z["population"], 1),
            "poi": {k: round(v, 2) for k, v in z["poi"].items()},
            "access": [[int(n), a, b] for n, a, b in access],
        })
    log.info("zones: %d, access nodes: %d, POIs snapped: %d, population not placed: %.0f",
             len(zones), sum(len(z["access"]) for z in zones), n_poi, unplaced)
    census = sum(config.CENSUS_2019_INNER.values())
    check = {
        "worldpop_2020_bbox_total": round(pop_total),
        "zones_population_total": round(sum(z["population"] for z in zones)),
        "census_2019_six_inner_districts": census,
        "note": "bbox also covers parts of Tây Hồ, Hoàng Mai, Nam/Bắc Từ Liêm, Thanh Trì; "
                "expect the bbox total to exceed the six-district census figure.",
    }
    log.info("zones: %d; population check: %s", len(zones), check)
    return zones, check
