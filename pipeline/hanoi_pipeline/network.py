"""Road network from OSM via OSMnx."""

from __future__ import annotations

import logging

import numpy as np
import osmnx as ox
import rasterio

from . import config
from .download import fetch
from .geo import dist_m, to_xy

log = logging.getLogger(__name__)

CLASS_RANK = {c: i for i, c in enumerate(config.ROAD_CLASSES)}
MAJOR = {"motorway", "trunk", "primary", "secondary"}


def _first(v):
    return v[0] if isinstance(v, list) else v


def _best_class(v) -> str:
    vals = v if isinstance(v, list) else [v]
    vals = [x for x in vals if x in CLASS_RANK] or ["residential"]
    return min(vals, key=lambda c: CLASS_RANK[c])


def _parse_float(v) -> float | None:
    vals = v if isinstance(v, list) else [v]
    out = []
    for x in vals:
        if x is None:
            continue
        for part in str(x).replace(",", ";").split(";"):
            part = part.strip().lower().replace("km/h", "").replace("kmh", "").strip()
            try:
                out.append(float(part))
            except ValueError:
                pass
    return max(out) if out else None


def _flag(v, true_values) -> bool:
    vals = v if isinstance(v, list) else [v]
    return any(str(x).lower() in true_values for x in vals if x is not None)


def _name(v) -> str:
    if isinstance(v, list):
        return " / ".join(sorted({str(x) for x in v}))
    return "" if v is None or (isinstance(v, float) and np.isnan(v)) else str(v)


def dem_paths():
    return [
        fetch(config.COPERNICUS_DEM_URL.format(t=t), config.CACHE / "dem" / f"cop30_{t}.tif")
        for t in config.COPERNICUS_DEM_TILES
    ]


def sample_elevation(lonlat: list[tuple[float, float]]) -> list[float]:
    """Elevation (m) from Copernicus GLO-30. DSM: includes buildings; broad trends only."""
    elev = np.full(len(lonlat), np.nan)
    for path in dem_paths():
        with rasterio.open(path) as src:
            b = src.bounds
            idx = [i for i, (x, y) in enumerate(lonlat) if b.left <= x < b.right and b.bottom <= y < b.top]
            if not idx:
                continue
            vals = [v[0] for v in src.sample([lonlat[i] for i in idx])]
            for i, v in zip(idx, vals):
                if v > -100:
                    elev[i] = float(v)
    fill = float(np.nanmedian(elev)) if np.isfinite(elev).any() else 0.0
    return [round(float(e), 1) if np.isfinite(e) else fill for e in elev]


def build_network(bbox=config.BBOX) -> dict:
    ox.settings.cache_folder = str(config.CACHE / "osmnx")
    ox.settings.use_cache = True
    ox.settings.log_console = False

    G = ox.graph_from_bbox(bbox, custom_filter=config.OSM_ROAD_FILTER, simplify=True,
                           retain_all=False, truncate_by_edge=True)
    G = ox.truncate.largest_component(G, strongly=True)
    log.info("OSM graph: %d nodes, %d edges", len(G.nodes), len(G.edges))

    osm_nodes = sorted(G.nodes)
    nid = {n: i for i, n in enumerate(osm_nodes)}
    lonlat = [(G.nodes[n]["x"], G.nodes[n]["y"]) for n in osm_nodes]
    elev = sample_elevation(lonlat)

    signal_nodes = _snap_signals(bbox, lonlat)

    nodes = [
        {"lon": round(x, 6), "lat": round(y, 6), "elev_m": e, "signal": i in signal_nodes}
        for i, ((x, y), e) in enumerate(zip(lonlat, elev))
    ]

    links = []
    for u, v, k, d in sorted(G.edges(keys=True, data=True), key=lambda e: (nid[e[0]], nid[e[1]], e[2])):
        if u == v:
            continue
        oneway = bool(_first(d.get("oneway", False)))
        lanes = _parse_float(d.get("lanes"))
        if lanes is not None and not oneway:
            lanes = max(1.0, lanes / 2.0)
        if "geometry" in d:
            coords = [(round(x, 6), round(y, 6)) for x, y in d["geometry"].coords]
        else:
            coords = [nodes[nid[u]]["lon"], nodes[nid[u]]["lat"]], [nodes[nid[v]]["lon"], nodes[nid[v]]["lat"]]
            coords = [tuple(c) for c in coords]
        links.append({
            "from": nid[u],
            "to": nid[v],
            "length_m": round(max(float(d.get("length", 1.0)), 1.0), 2),
            "road_class": _best_class(d.get("highway")),
            "lanes": lanes,
            "maxspeed_kmh": _parse_float(d.get("maxspeed")),
            "oneway": oneway,
            "bridge": _flag(d.get("bridge"), {"yes", "viaduct", "true", "1"}),
            "tunnel": _flag(d.get("tunnel"), {"yes", "true", "1"}),
            "name": _name(d.get("name")),
            "osm_way": int(_first(d.get("osmid", 0)) or 0),
            "geom": [list(c) for c in coords],
        })

    entries = _entry_nodes(bbox, nodes, links)
    log.info("network: %d nodes (%d signals), %d links, %d entry points",
             len(nodes), len(signal_nodes), len(links), len(entries))
    return {"nodes": nodes, "links": links, "entries": entries}


def _snap_signals(bbox, lonlat, max_dist_m: float = 40.0) -> set[int]:
    try:
        feats = ox.features_from_bbox(bbox, tags={"highway": "traffic_signals"})
    except Exception as e:  # noqa: BLE001 - no signals is a valid outcome
        log.warning("signal fetch failed: %s", e)
        return set()
    pts = [(g.x, g.y) for g in feats.geometry if g.geom_type == "Point"]
    if not pts:
        return set()
    xy = np.array([to_xy(x, y) for x, y in lonlat])
    out = set()
    for x, y in pts:
        px, py = to_xy(x, y)
        d = np.hypot(xy[:, 0] - px, xy[:, 1] - py)
        i = int(np.argmin(d))
        if d[i] <= max_dist_m:
            out.add(i)
    return out


def _entry_nodes(bbox, nodes, links, margin_m: float = 250.0) -> list[dict]:
    """Nodes near the bbox edge on major roads: where through traffic enters/leaves."""
    major_in = {}
    for i, l in enumerate(links):
        if l["road_class"] in MAJOR:
            major_in.setdefault(l["from"], []).append(l["road_class"])
            major_in.setdefault(l["to"], []).append(l["road_class"])
    entries = []
    w, s, e, n = bbox
    for i, cls in sorted(major_in.items()):
        nd = nodes[i]
        dmin = min(
            dist_m(nd["lon"], nd["lat"], w, nd["lat"]), dist_m(nd["lon"], nd["lat"], e, nd["lat"]),
            dist_m(nd["lon"], nd["lat"], nd["lon"], s), dist_m(nd["lon"], nd["lat"], nd["lon"], n),
        )
        if dmin <= margin_m:
            best = min(cls, key=lambda c: CLASS_RANK[c])
            entries.append({"node": i, "road_class": best})
    # Thin out: keep one entry per 600 m along the boundary.
    kept: list[dict] = []
    for en in sorted(entries, key=lambda x: CLASS_RANK[x["road_class"]]):
        nd = nodes[en["node"]]
        if all(dist_m(nd["lon"], nd["lat"], nodes[k["node"]]["lon"], nodes[k["node"]]["lat"]) > 600 for k in kept):
            kept.append(en)
    return sorted(kept, key=lambda x: x["node"])
