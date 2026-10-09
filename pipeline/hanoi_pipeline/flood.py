"""Flood inputs: reported hotspots mapped to links, catchments, rain presets."""

from __future__ import annotations

import csv
import logging
import unicodedata
from collections import defaultdict

import numpy as np
import requests

from . import config
from .geo import dist_m, grid_index, to_xy

log = logging.getLogger(__name__)

HOTSPOT_SOURCE = (
    "Hanoi Sewerage and Drainage Co., list of 65 flood points at 13:00 30/9/2025, via "
    "tienphong.vn / techz.vn"
)


def norm(s: str) -> str:
    return " ".join(unicodedata.normalize("NFC", s).lower().split())


def name_matches(osm_name: str, query: str) -> bool:
    q = norm(query)
    for part in osm_name.split(" / "):
        p = norm(part)
        if p == q or p.endswith(" " + q):
            return True
    return False


def _mid(nodes, link):
    a, b = nodes[link["from"]], nodes[link["to"]]
    return (a["lon"] + b["lon"]) / 2, (a["lat"] + b["lat"]) / 2, (a["elev_m"] + b["elev_m"]) / 2


def map_hotspots(nodes: list[dict], links: list[dict], csv_path=None) -> tuple[list[dict], list[dict]]:
    csv_path = csv_path or config.INPUTS / "flood_hotspots_2025-09-30.csv"
    rows = list(csv.DictReader(open(csv_path, encoding="utf-8")))
    by_name: dict[str, list[int]] = defaultdict(list)
    for i, l in enumerate(links):
        if l["name"]:
            by_name[l["name"]].append(i)

    def street_links(q: str) -> list[int]:
        return sorted(i for n, ids in by_name.items() if name_matches(n, q) for i in ids)

    hotspots, report = [], []
    for r in rows:
        status = "mapped"
        ids: list[int] = []
        streets = [s.strip() for s in r["streets"].split(";") if s.strip()]
        if r["status"] == "outside" or not streets:
            status = "outside study area"
        elif r["kind"] == "intersection" and len(streets) >= 2:
            ids = _intersection_links(nodes, links, street_links(streets[0]), street_links(streets[1]))
            status = "mapped" if ids else "streets not found / do not meet in OSM"
        else:
            ids = _street_low_point_links(nodes, links, street_links(streets[0]))
            status = "mapped (lowest DEM point of street)" if ids else "street not found in OSM"
        report.append({"id": int(r["id"]), "label": r["label"], "status": status, "links": len(ids)})
        if ids:
            ids = [i for i in ids if not links[i]["bridge"]]
            hotspots.append({
                "id": f"hs-{r['id']}",
                "label": r["label"],
                "kind": r["kind"],
                "links": ids,
                "source": HOTSPOT_SOURCE,
                "confidence": "medium" if r["kind"] == "intersection" else "low",
                "observed": "2025-09-30",
            })

    seen = {i for h in hotspots for i in h["links"]}
    tunnels = [i for i, l in enumerate(links) if l["tunnel"] and i not in seen]
    for k, group in enumerate(_group_links(nodes, links, tunnels, 150.0)):
        hotspots.append({
            "id": f"underpass-{k}",
            "label": "Underpass: " + (links[group[0]]["name"] or "unnamed"),
            "kind": "underpass",
            "links": group,
            "source": "OSM tunnel=yes; underpasses are classic flood points (assumption)",
            "confidence": "low",
            "observed": None,
        })
    n_mapped = sum(1 for r in report if r["status"].startswith("mapped"))
    log.info("hotspots: %d of %d reported points mapped; %d underpass groups", n_mapped, len(rows),
             len(hotspots) - n_mapped)
    return hotspots, report


def _intersection_links(nodes, links, a: list[int], b: list[int], radius_m: float = 120.0) -> list[int]:
    if not a or not b:
        return []
    na = {links[i][e] for i in a for e in ("from", "to")}
    nb = {links[i][e] for i in b for e in ("from", "to")}
    common = sorted(na & nb)
    if not common:
        best = None
        for u in na:
            for v in nb:
                d = dist_m(nodes[u]["lon"], nodes[u]["lat"], nodes[v]["lon"], nodes[v]["lat"])
                if d < 60 and (best is None or d < best[0]):
                    best = (d, u)
        if best is None:
            return []
        common = [best[1]]
    c = nodes[common[0]]
    out = []
    for i in sorted(set(a) | set(b)):
        lon, lat, _ = _mid(nodes, links[i])
        if dist_m(lon, lat, c["lon"], c["lat"]) <= radius_m:
            out.append(i)
    return out


def _street_low_point_links(nodes, links, ids: list[int], radius_m: float = 200.0) -> list[int]:
    ids = [i for i in ids if not links[i]["bridge"]]
    if not ids:
        return []
    mids = {i: _mid(nodes, links[i]) for i in ids}
    low = min(ids, key=lambda i: (mids[i][2], i))
    lon0, lat0, _ = mids[low]
    return [i for i in ids if dist_m(mids[i][0], mids[i][1], lon0, lat0) <= radius_m]


def _group_links(nodes, links, ids: list[int], radius_m: float) -> list[list[int]]:
    groups: list[list[int]] = []
    for i in ids:
        lon, lat, _ = _mid(nodes, links[i])
        for g in groups:
            glon, glat, _ = _mid(nodes, links[g[0]])
            if dist_m(lon, lat, glon, glat) <= radius_m:
                g.append(i)
                break
        else:
            groups.append([i])
    return groups


def build_catchments(bbox, nodes, links, low_share: float = 0.2) -> list[dict]:
    """Square catchments (proxy; real drainage basins are not openly available). In each,
    the lowest `low_share` of non-bridge links (by DEM) plus tunnels receive ponded water."""
    size = config.CATCHMENT_SIZE_M
    cells: dict[tuple[int, int], list[int]] = defaultdict(list)
    for i, l in enumerate(links):
        lon, lat, _ = _mid(nodes, l)
        cells[grid_index(lon, lat, bbox, size)].append(i)
    out = []
    for (ix, iy), ids in sorted(cells.items()):
        ground = [i for i in ids if not links[i]["bridge"]]
        if not ground:
            continue
        ground.sort(key=lambda i: (_mid(nodes, links[i])[2], i))
        n_low = max(1, int(round(len(ground) * low_share)))
        low = sorted(set(ground[:n_low]) | {i for i in ids if links[i]["tunnel"]})
        elev = [_mid(nodes, links[i])[2] for i in ground]
        out.append({
            "id": f"c-{ix}-{iy}",
            "area_m2": size * size,
            "links": sorted(ids),
            "low_links": low,
            "mean_elev_m": round(float(np.mean(elev)), 1),
        })
    log.info("catchments: %d", len(out))
    return out


def rain_presets() -> list[dict]:
    presets = [
        {
            "id": "storm-2025-09-30",
            "label": "30/9/2025 storm (Bualoi remnants)",
            "description": "Totals 7:00–13:00 from inner-city stations (Hai Bà Trưng 195 mm, Thanh "
                           "Xuân 165 mm, Ô Chợ Dừa 320 mm). Hourly shape is assumed (peak ~9:00, "
                           ">150 mm in 120 min reported).",
            "source": "Hanoi People's Committee via tienphong.vn (station totals); hourly shape assumed",
            "confidence": "medium",
            "profile": [
                {"at": "07:00", "mm_per_hour": 20}, {"at": "08:00", "mm_per_hour": 45},
                {"at": "09:00", "mm_per_hour": 75}, {"at": "10:00", "mm_per_hour": 35},
                {"at": "11:00", "mm_per_hour": 12}, {"at": "12:00", "mm_per_hour": 8},
                {"at": "13:00", "mm_per_hour": 0},
            ],
        },
        {
            "id": "thunderstorm-rush-80",
            "label": "80 mm/h thunderstorm at rush hour",
            "description": "Synthetic: 1 h of 80 mm/h at 7:30, with lighter rain around it.",
            "source": "assumption",
            "confidence": "low",
            "profile": [
                {"at": "07:00", "mm_per_hour": 15}, {"at": "07:30", "mm_per_hour": 80},
                {"at": "08:30", "mm_per_hour": 10}, {"at": "09:30", "mm_per_hour": 0},
            ],
        },
        {
            "id": "light-rain",
            "label": "Light rain all morning (5 mm/h)",
            "description": "Synthetic: rain without flooding.",
            "source": "assumption",
            "confidence": "low",
            "profile": [{"at": "06:00", "mm_per_hour": 5}, {"at": "10:00", "mm_per_hour": 0}],
        },
    ]
    era5 = _openmeteo_2025_09_30()
    if era5:
        presets.append(era5)
    return presets


def _openmeteo_2025_09_30() -> dict | None:
    url = ("https://archive-api.open-meteo.com/v1/archive?latitude=21.03&longitude=105.83"
           "&start_date=2025-09-30&end_date=2025-09-30&hourly=precipitation&timezone=Asia%2FBangkok")
    try:
        d = requests.get(url, timeout=30).json()["hourly"]
    except Exception as e:  # noqa: BLE001
        log.warning("Open-Meteo fetch failed: %s", e)
        return None
    profile = [{"at": t[11:16], "mm_per_hour": round(v or 0.0, 1)} for t, v in zip(d["time"], d["precipitation"])]
    return {
        "id": "era5-2025-09-30",
        "label": "30/9/2025 from reanalysis (Open-Meteo)",
        "description": "Gridded reanalysis smooths convective rain: total is far below station "
                       "observations. Shown for comparison only.",
        "source": "Open-Meteo historical weather API (ERA5), CC BY 4.0",
        "confidence": "low",
        "profile": profile,
    }
