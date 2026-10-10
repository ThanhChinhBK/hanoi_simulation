"""Assemble the city bundle consumed by the engine and the web app.

Usage: uv run python -m hanoi_pipeline [--out PATH]
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import logging
import shutil

from . import config
from .flood import build_catchments, map_hotspots, rain_presets
from . import metro
from .network import build_network
from .terrain import Dem, load_worldcover
from .zones import build_zones

log = logging.getLogger("hanoi_pipeline")

BUNDLE_VERSION = 1


def build(bbox=config.BBOX, name: str = "hanoi-inner") -> tuple[dict, dict]:
    dem = Dem.load(bbox)
    net = build_network(bbox, dem)
    zones, pop_check = build_zones(bbox, net["nodes"], net["links"])
    hotspots, hotspot_report = map_hotspots(net["nodes"], net["links"])
    catchments = build_catchments(bbox, net["nodes"], net["links"], dem, load_worldcover(bbox))
    bundle = {
        "version": BUNDLE_VERSION,
        "name": name,
        "created": dt.date.today().isoformat(),
        "bbox": list(bbox),
        "nodes": net["nodes"],
        "links": net["links"],
        "entries": net["entries"],
        "zones": zones,
        "hotspots": hotspots,
        "catchments": catchments,
        "dem_source": dem.source,
        "rain_presets": rain_presets(),
        "attributions": config.ATTRIBUTIONS,
    }
    report = {"population_check": pop_check, "hotspots": hotspot_report, "dem_source": dem.source}
    return bundle, report


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="hanoi-inner")
    args = ap.parse_args()

    bundle, report = build(name=args.name)
    config.BUNDLES.mkdir(parents=True, exist_ok=True)
    out = config.BUNDLES / f"{args.name}.json"
    out.write_text(json.dumps(bundle, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    with open(out, "rb") as f, gzip.open(str(out) + ".gz", "wb", compresslevel=9) as g:
        shutil.copyfileobj(f, g)
    (config.BUNDLES / f"{args.name}.report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    log.info("wrote %s (%.1f MB)", out, out.stat().st_size / 1e6)
    try:
        metro.main()
    except RuntimeError as e:  # display-only layer: never block the bundle
        log.warning("metro layer skipped: %s", e)


if __name__ == "__main__":
    main()
