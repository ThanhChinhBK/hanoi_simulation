# Hanoi traffic what-if sandbox

Interactive, browser-based simulation of Hanoi traffic (motorbike-dominated, city scale)
with rain/flood scenarios. Change rain, signals, incidents, closures, roads, housing,
jobs, big events or any model parameter, run it in the browser, and see which areas get
better or worse than on a normal day. Results are **comparative**, not forecasts; every
parameter shows its source and confidence.

## Layout

| Path | What |
|---|---|
| `pipeline/` | Python: OSM, WorldPop, DEM, flood points → city bundle (`data/bundles/*.json`) |
| `engine/` | Rust core: queue simulation, demand, replanning, flood, scenarios, CLI `hanoi-sim` |
| `engine-wasm/` | wasm-bindgen build used by the web app (Web Worker) |
| `engine-py/` | PyO3 bindings for notebooks / calibration |
| `web/` | Vite + TypeScript + MapLibre + deck.gl static site |
| `scenarios/` | Example scenarios (IDs refer to the current `hanoi-inner` bundle) |

CLI, Python and WASM give bit-identical results for the same inputs and seed.

## Quick start

```sh
# 1. data (downloads OSM, WorldPop, DEM; ~minutes)
cd pipeline && uv run python -m hanoi_pipeline && cd ..
# 2. baseline routes (offline equilibrium, ~1.5 min)
cargo build --release
target/release/hanoi-sim baseline --bundle data/bundles/hanoi-inner.json \
    --routes-out data/out/routes.bin --out data/out/baseline.json
# 3. web app
cd engine-wasm && wasm-pack build --target web --release --out-dir pkg && cd ..
cd web && npm install && npm run dev
```

Tests: `cargo test --workspace --release`, `cd pipeline && uv run pytest`,
`cd engine-py && .venv/bin/python -m pytest`, `cd web && npm test && npm run e2e`.

## Scenario kinds

- **Sudden** (incident, closure, rain/flood, signal timing, big event): one run from the
  baseline routes with en-route rerouting (~1–2 s). Compared with the baseline.
- **Structural** (new/removed/modified roads, housing, jobs, population or trip-rate
  changes): demand and network are rebuilt and replanned (~10–30 s). Compared with a
  *control* run (the unchanged baseline through the same replanning), so noise cancels.

See `engine/README.md` for the model, `web/README.md` for the app.

## Data & licences

OpenStreetMap (ODbL), WorldPop (CC BY 4.0), Copernicus GLO-30 DEM, flood points from
Hanoi Sewerage and Drainage Co. via news reports. Attributions are shown in the app.
Code: MIT OR Apache-2.0.
