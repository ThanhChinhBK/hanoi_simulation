"""Calibrate the bucket flood model on the 30/9/2025 storm.

Ground truth: the 65 flood points reported at 13:00 (51 mapped inside the study area);
a further ~116 points were reported city-wide that day. The model gets no information
about the points (hotspot_depth_factor = 0), so this measures what terrain, land cover
and the bucket model alone predict.

Metrics, at 13:00 (time of the list):
- hit rate: share of reported points with a flooded link (>= DEPTH_CM) within RADIUS_M
- predicted spots: 200 m grid cells with a flooded link; target ~ 116 x 51/65 ~ 91

Usage: engine-py/.venv/bin/python engine-py/calibration/flood_2025_09_30.py [bundle]
"""

from __future__ import annotations

import itertools
import json
import math
import sys
from pathlib import Path

from hanoi_engine import Flood

DEPTH_CM = 10.0
RADIUS_M = 150.0
TARGET_SPOTS = round(116 * 51 / 65)
OBS_TIME = "13:00"


def main(bundle_path: str = "data/bundles/hanoi-inner.json") -> dict:
    b = json.loads(Path(bundle_path).read_text(encoding="utf-8"))
    res = calibrate(b)
    # Baseline: same model, ponding ranked by absolute elevation (no lowness).
    for n in b["nodes"]:
        n.pop("low_m", None)
    best = {k: res["best"][k] for k in ("drainage_mm_h", "runoff_scale", "low_link_share")}
    res["elevation_ranking_at_best"] = calibrate(b, grid=[best])["best"]
    print("elevation ranking:", res["elevation_ranking_at_best"])
    res["random_placement_hit_rate"] = random_baseline(b, res["best"]["spots"])
    print("random placement hit rate:", res["random_placement_hit_rate"])
    return res


def random_baseline(b: dict, n_spots: int, reps: int = 200, seed: int = 1) -> float:
    """Hit rate when the same number of 200 m spots are placed at random road cells."""
    import random

    nodes, links = b["nodes"], b["links"]
    lat0 = math.radians(sum(b["bbox"][1::2]) / 2)

    def xy(i):
        a, c = nodes[links[i]["from"]], nodes[links[i]["to"]]
        return ((a["lon"] + c["lon"]) / 2 * 111_320 * math.cos(lat0), (a["lat"] + c["lat"]) / 2 * 110_574)

    cells: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for i, l in enumerate(links):
        if not l["bridge"]:
            x, y = xy(i)
            cells.setdefault((int(x // 200), int(y // 200)), []).append((x, y))
    keys = sorted(cells)
    obs = [[xy(i) for i in h["links"]] for h in b["hotspots"] if h.get("observed")]
    rng = random.Random(seed)
    total = 0
    for _ in range(reps):
        wet = [rng.choice(cells[k]) for k in rng.sample(keys, n_spots)]
        total += sum(any(math.dist(p, q) <= RADIUS_M for p in pts for q in wet) for pts in obs)
    return round(total / reps / len(obs), 3)


def calibrate(b: dict, grid: list[dict] | None = None) -> dict:
    nodes, links = b["nodes"], b["links"]
    lat0 = math.radians(sum(b["bbox"][1::2]) / 2)

    def xy(i):
        a, c = nodes[links[i]["from"]], nodes[links[i]["to"]]
        return ((a["lon"] + c["lon"]) / 2 * 111_320 * math.cos(lat0), (a["lat"] + c["lat"]) / 2 * 110_574)

    observed = [h for h in b["hotspots"] if h.get("observed")]
    obs_xy = [[xy(i) for i in h["links"]] for h in observed]
    preset = next(p for p in b["rain_presets"] if p["id"] == "storm-2025-09-30")
    profile = [(r["at"], r["mm_per_hour"]) for r in preset["profile"]]
    fl = Flood(json.dumps(b))

    def evaluate(params: dict) -> dict:
        out = fl.run(profile, "bucket", "05:00", "16:00", params)
        step = (int(OBS_TIME[:2]) * 3600_000 - out["start_ms"]) // out["step_ms"]
        wet = [int(k) for k, v in out["depth_cm"].items() if v[step] >= DEPTH_CM]
        wet_xy = [xy(i) for i in wet]
        hits = sum(
            any(math.dist(p, q) <= RADIUS_M for p in pts for q in wet_xy) for pts in obs_xy
        )
        spots = len({(int(x // 200), int(y // 200)) for x, y in wet_xy})
        return {"hit_rate": round(hits / len(observed), 3), "hits": hits, "spots": spots}

    base = {"flood.hotspot_depth_factor": 0.0}
    grid = grid or [
        {"drainage_mm_h": q, "runoff_scale": s, "low_link_share": ls}
        for q, s, ls in itertools.product(range(4, 26, 2), [0.8, 1.0, 1.2], [0.25, 0.5, 1.0])
    ]
    rows = []
    for g in grid:
        params = {**base, **{f"flood.{k}": v for k, v in g.items()}}
        rows.append({**g, **evaluate(params)})
    # Pick: predicted spot count within 25% of the target, then best hit rate; ties ->
    # spot count closest to target.
    ok = [r for r in rows if abs(r["spots"] - TARGET_SPOTS) <= 0.25 * TARGET_SPOTS] or rows
    best = max(ok, key=lambda r: (r["hit_rate"], -abs(r["spots"] - TARGET_SPOTS)))
    # Skill vs. chance: same number of spots placed by plain elevation would be the
    # baseline; here we report the share of the study area's 200 m cells that are wet.
    n_cells = len({(int(x // 200), int(y // 200)) for x, y in (xy(i) for i in range(len(links)))})
    result = {"observed_points": len(observed), "target_spots": TARGET_SPOTS, "cells_with_roads": n_cells,
              "best": best, "sweep": rows}
    print("best:", best, "| wet share of road cells:", round(best["spots"] / n_cells, 3))
    return result


if __name__ == "__main__":
    res = main(*sys.argv[1:])
    Path("data/out").mkdir(parents=True, exist_ok=True)
    Path("data/out/flood_calibration.json").write_text(json.dumps(res, indent=1))
