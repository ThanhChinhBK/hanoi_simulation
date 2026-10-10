"""Hanoi metro lines and stations from OSM route relations → GeoJSON for the map.

Display only: the engine does not model rail (non-goal). Operating status is not reliably
tagged in OSM, so it comes from `config.METRO_LINES` (sourced, checked by hand).

Usage: uv run python -m hanoi_pipeline.metro
"""

from __future__ import annotations

import json
import logging
import time

import requests

from . import config

log = logging.getLogger("hanoi_pipeline.metro")

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def _query(bbox) -> str:
    w, s, e, n = bbox
    b = f"({s},{w},{n},{e})"
    return (
        "[out:json][timeout:120];"
        f'(rel["route"~"^(subway|light_rail)$"]{b};'
        f' rel["route"="train"]["ref"~"^T[0-9]+[A-Z]?$"]{b};)->.r;'
        ".r out geom;"
        "node(r.r);out tags;"
    )


def fetch_overpass(bbox=config.METRO_BBOX, retries: int = 4) -> dict:
    cache = config.CACHE / "metro_overpass.json"
    if cache.exists() and cache.stat().st_size > 0:
        return json.loads(cache.read_text(encoding="utf-8"))
    q = _query(bbox)
    last: Exception | None = None
    for attempt in range(retries):
        for url in OVERPASS_URLS:
            try:
                r = requests.post(url, data={"data": q}, timeout=180,
                                  headers={"User-Agent": "hanoi-sim pipeline"})
                r.raise_for_status()
                d = r.json()
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_text(json.dumps(d), encoding="utf-8")
                return d
            except (requests.RequestException, ValueError) as e:
                last = e
                log.warning("overpass %s failed: %s", url, e)
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"Overpass unavailable: {last}")


def _round(c):
    return [round(c[0], 6), round(c[1], 6)]


def build_metro(osm: dict) -> dict:
    """One feature per line (first relation per ref; both directions share the track)
    plus one feature per station (deduplicated by name per line)."""
    nodes = {e["id"]: e.get("tags", {}) for e in osm["elements"] if e["type"] == "node"}
    rels = sorted((e for e in osm["elements"] if e["type"] == "relation"), key=lambda e: e["id"])
    features, seen = [], set()
    for rel in rels:
        t = rel.get("tags", {})
        ref = t.get("ref", "")
        meta = config.METRO_LINES.get(ref)
        if meta is None or ref in seen:
            continue
        seen.add(ref)
        lines = [[_round((p["lon"], p["lat"])) for p in m["geometry"]]
                 for m in rel.get("members", [])
                 if m["type"] == "way" and m.get("role", "") == "" and m.get("geometry")]
        if not lines:
            continue
        features.append({
            "type": "Feature",
            "geometry": {"type": "MultiLineString", "coordinates": lines},
            "properties": {"kind": "line", "ref": ref, "name": meta["name"],
                           "osm_name": t.get("name", ""), "colour": meta["colour"],
                           "status": meta["status"], "note": meta["note"],
                           "osm_relation": rel["id"]},
        })
        names = set()
        for m in rel.get("members", []):
            if m["type"] != "node" or not m.get("role", "").startswith("stop"):
                continue
            nt = nodes.get(m["ref"], {})
            name = nt.get("name") or nt.get("name:vi") or ""
            if not name or name in names:
                continue
            names.add(name)
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": _round((m["lon"], m["lat"]))},
                "properties": {"kind": "station", "ref": ref, "name": name,
                               "name_en": nt.get("name:en", ""), "colour": meta["colour"],
                               "status": meta["status"]},
            })
    missing = sorted(set(config.METRO_LINES) - seen)
    if missing:
        log.warning("metro lines not found in OSM: %s", missing)
    return {"type": "FeatureCollection", "features": features,
            "attribution": "© OpenStreetMap contributors (ODbL)"}


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    fc = build_metro(fetch_overpass())
    config.BUNDLES.mkdir(parents=True, exist_ok=True)
    out = config.BUNDLES / "metro.geojson"
    out.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_lines = sum(f["properties"]["kind"] == "line" for f in fc["features"])
    log.info("wrote %s: %d lines, %d stations", out, n_lines, len(fc["features"]) - n_lines)


if __name__ == "__main__":
    main()
