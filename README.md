# Hanoi traffic what-if sandbox

Interactive, browser-based simulation of Hanoi traffic (motorbike-dominated, city scale)
with rain/flood scenarios. Results are comparative ("which option is better"), not forecasts.

## Layout

| Path | Status |
|---|---|
| `engine/` | Rust core: network, queue simulation, routing (step 1 done) |
| `engine-py/`, `engine-wasm/`, `web/`, `pipeline/`, `scenarios/` | planned |

## Scenario kinds (affects architecture)

- **Sudden** (incident, closure, rain/flood, big event): one run from baseline routes with
  en-route rerouting.
- **Structural** (new/removed roads, more housing or population): routes and demand
  change for everyone, so the engine regenerates demand and runs a few replanning
  iterations in the browser. The network is immutable per run; edits rebuild it.

## Development

Requires Rust (`rustup`). `cargo test` runs the full suite. See `engine/README.md`.
