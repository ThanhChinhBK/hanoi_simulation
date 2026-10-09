"""Binding tests. The real-bundle parity test is skipped when the (gitignored)
bundle, routes and CLI outputs are not present."""

import json
from pathlib import Path

import numpy as np
import pytest

from hanoi_engine import Engine, default_params

ROOT = Path(__file__).resolve().parents[2]
BUNDLE = ROOT / "data/bundles/hanoi-inner.json"
ROUTES = ROOT / "data/out/routes.bin"
OUT = ROOT / "data/out"


def test_default_params_have_provenance():
    p = default_params()
    assert len(p) > 50
    for k, v in p.items():
        assert v["key"] == k
        assert v["confidence"] in {"high", "medium", "low"}
        assert v["source"] and v["unit"] is not None
        assert v["min"] <= v["value"] <= v["max"]


def test_invalid_bundle_raises():
    with pytest.raises(ValueError):
        Engine("{}")


real = pytest.mark.skipif(not (BUNDLE.exists() and ROUTES.exists()), reason="bundle not built")


@pytest.fixture(scope="module")
def engine():
    return Engine.load(BUNDLE, ROUTES)


@real
def test_baseline_shapes(engine):
    b = engine.baseline()
    assert b.reference == "baseline"
    assert b.link_tt_ms.shape == (b.raw["n_links"], b.n_bins)
    assert np.all(b.link_count.sum(axis=1) >= 0)
    assert b.summary["arrived"] > 0
    assert engine.baseline_routes() == ROUTES.read_bytes()


@real
def test_invalid_scenario_raises(engine):
    with pytest.raises(ValueError):
        engine.run({"events": [{"type": "closure", "links": [10**9]}]})


@real
@pytest.mark.parametrize("name", ["closure-lang", "storm-2025-09-30"])
def test_identical_to_cli(engine, name):
    cli = OUT / f"run-{name}.json"
    if not cli.exists():
        pytest.skip("run `hanoi-sim run` first")
    out = engine.run((ROOT / f"scenarios/{name}.json").read_text())
    ref = json.loads(cli.read_text())
    assert out.summary == ref["summary"]
    assert out.raw["link_tt_ms"] == ref["link_tt_ms"]
