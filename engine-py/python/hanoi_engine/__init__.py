"""Python bindings for the Hanoi traffic engine.

    from hanoi_engine import Engine
    eng = Engine.load("data/bundles/hanoi-inner.json", "data/out/routes.bin")
    out = eng.run({"events": [{"type": "closure", "links": [38620]}]})
    ref = eng.reference(out)
    print(out.summary["total_delay_veh_h"] / ref.summary["total_delay_veh_h"] - 1)

Results are deterministic: the same bundle, parameters and seed give results
identical to the CLI and the browser (WASM) build.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from . import _native

__all__ = ["Engine", "Flood", "Run", "default_params"]


def default_params() -> dict[str, dict[str, Any]]:
    """Parameter registry: key -> {value, default, unit, min, max, category, source, confidence, description}."""
    return json.loads(_native.default_params_json())["params"]


class Flood:
    """Flood layer only (no traffic), for calibration.

        fl = Flood.load("data/bundles/hanoi-inner.json")
        peak = fl.peak_depth_cm([("07:00", 20), ("09:00", 75), ("11:00", 0)], "bucket",
                                params={"flood.drainage_mm_h": 30})
    """

    def __init__(self, bundle_json: str):
        self._inner = _native.Flood(bundle_json)

    @classmethod
    def load(cls, bundle: str | Path) -> "Flood":
        return cls(Path(bundle).read_text(encoding="utf-8"))

    def run(self, profile, model: str = "bucket", start: str = "05:00", end: str = "14:00",
            params: dict[str, float] | None = None) -> dict[str, Any]:
        prof = [(t, float(v)) for t, v in profile]
        return json.loads(self._inner.run_json(prof, model, start, end, params))

    def peak_depth_cm(self, profile, model: str = "bucket", start: str = "05:00", end: str = "14:00",
                      params: dict[str, float] | None = None) -> dict[int, float]:
        """Maximum depth (cm) per flooded link over the window."""
        out = self.run(profile, model, start, end, params)
        return {int(k): max(v) for k, v in out["depth_cm"].items()}


@dataclass
class Run:
    """One simulation output. Per-link arrays have shape (n_links, n_bins)."""

    raw: dict[str, Any]

    @property
    def summary(self) -> dict[str, Any]:
        return self.raw["summary"]

    @property
    def reference(self) -> str:
        return self.raw["reference"]

    @property
    def n_bins(self) -> int:
        return self.raw["window"]["n_bins"]

    @property
    def bin_start_ms(self) -> np.ndarray:
        w = self.raw["window"]
        return w["start_ms"] + w["bin_ms"] * np.arange(w["n_bins"])

    @property
    def link_tt_ms(self) -> np.ndarray:
        """Mean link travel time (ms) per bin; NaN where no vehicle entered."""
        a = np.asarray(self.raw["link_tt_ms"], dtype=np.float32).reshape(-1, self.n_bins)
        return np.where(a < 0, np.nan, a)

    @property
    def link_count(self) -> np.ndarray:
        return np.asarray(self.raw["link_count"], dtype=np.uint32).reshape(-1, self.n_bins)

    @property
    def free_flow_ms(self) -> np.ndarray:
        return np.asarray(self.raw["free_flow_ms"], dtype=np.float32)

    @property
    def delay_veh_h(self) -> np.ndarray:
        return np.asarray(self.raw["delay_veh_h"])

    def link_delay_veh_h(self) -> np.ndarray:
        """Delay per link (vehicle-hours, sampled scale), summed over bins."""
        tt = np.nan_to_num(self.link_tt_ms, nan=0.0)
        ff = self.free_flow_ms[: tt.shape[0], None]
        d = np.clip(tt - ff, 0, None) * self.link_count / 3.6e6
        return d.sum(axis=1)


class Engine:
    def __init__(self, bundle_json: str, routes: bytes | None = None,
                 params: dict[str, float] | None = None, iterations: int | None = None,
                 verbose: bool = False):
        self._e = _native.Engine(bundle_json, routes, params, iterations, verbose)

    @classmethod
    def load(cls, bundle: str | Path, routes: str | Path | None = None, **kw) -> "Engine":
        rb = Path(routes).read_bytes() if routes else None
        return cls(Path(bundle).read_text(encoding="utf-8"), rb, **kw)

    def params(self) -> dict[str, dict[str, Any]]:
        return json.loads(self._e.params_json())["params"]

    def baseline(self) -> Run:
        return Run(json.loads(self._e.baseline_json()))

    def baseline_routes(self) -> bytes:
        return bytes(self._e.baseline_routes())

    def control(self) -> Run:
        return Run(json.loads(self._e.control_json()))

    def run(self, scenario: dict[str, Any] | str) -> Run:
        s = scenario if isinstance(scenario, str) else json.dumps(scenario)
        return Run(json.loads(self._e.run_json(s)))

    def reference(self, run: Run) -> Run:
        """The run a scenario must be compared with (baseline or control)."""
        return self.control() if run.reference == "control" else self.baseline()
