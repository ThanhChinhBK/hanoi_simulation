# hanoi-engine

Mesoscopic link-queue traffic simulation (MATSim-style), event-driven, plus synthetic
demand, replanning, scenarios and a rain/flood layer. One Rust library wrapped by a CLI
(`src/bin/hanoi-sim.rs`), Python (`../engine-py`) and WASM (`../engine-wasm`). All three
give bit-identical results for the same bundle, parameters and seed.

## Model in one page

**Link** = FIFO queue with
- *free-flow time* `ceil(length / min(free_speed, vehicle_max_speed) / speed_factor)`,
- *flow capacity* (PCU/s exiting): enforced by a token: after a vehicle of size `p`
  exits, the next exit is allowed at `max(token, now) + p / capacity`,
- *storage* (PCU that fit when jammed): default `length × lanes / 7.5 m`, raised to at
  least `capacity × free-flow time`.

A vehicle leaves a link when it is at the head, its free-flow time has elapsed, the
token allows it, and the next link has space (`used < storage`, MATSim rule: a vehicle
may enter while the link is not yet full, so one large vehicle may overshoot by < 1 PCU).
Otherwise it waits and blocks everyone behind it → **spillback**.

**Node** (intersection): when woken, it first lets arriving vehicles leave, then moves
head vehicles of its in-links. Competing in-links are served by *smooth weighted round
robin* with weight = effective capacity — deterministic fair merging (MATSim uses
weighted random). Head-of-line blocking is intentional: no turn pockets.

**Signals** are a capacity factor (green share) per approach; no explicit phases.

**Gridlock breaker**: a head vehicle that is ready but blocked by a full downstream link
for `stuck_threshold_ms` is pushed through, ignoring storage, and a `Stuck` event is
logged. Waiting for a *closed* link never triggers it (rerouting will handle that).

**Closures** block new entries; vehicles already on the link may leave.

**Capacity/speed factors** from independent sources (signal, incident, rain, flood)
multiply, so the UI can explain why a link is slow.

**Sampling**: simulate fraction `f` of trips; capacities are multiplied by `f`, storage by
`f^storage_scale_exponent` (0.75; scaling storage linearly makes small samples gridlock
far too easily — a known MATSim effect).

**Trips** start at the end of their first link and end at the end of their last link
(MATSim convention). Departing vehicles wait off-network until the origin link has space.

**En-route rerouting** (scenarios only): a vehicle reaching a junction whose next link is
closed or badly disrupted computes a new A* path from there (expected travel times from
the baseline, plus what it knows). *Informed* vehicles (`reroute.informed_share`) know
every disruption as it happens and re-check their route once per new disruption; others
learn on arrival. Closures are *signposted*: a closed link within
`reroute.closure_visibility_m` ahead is seen at the current junction, so drivers detour
before being trapped in a dead end. A vehicle with no path left is aborted (reported).

**Demand** (`demandgen.rs`): zone population (WorldPop grid) × trip rate × mode share
→ trips; destinations by a gravity model over POI attraction; departure times from a
parameterised AM-peak profile; through-traffic at city entry points. Zones are 200 m
cells; each lists **access nodes** (bundle `zones[].access` = `[node, population, poi]`):
the pipeline spreads every 100 m WorldPop cell over the ngõ/residential street nodes near
it and snaps POIs to their nearest node. Trips start at a home node drawn by population
and end at a node drawn by POI weight, so traffic appears on the small streets where
people live (falls back to the zone's centre node when `access` is empty). Motorbikes, cars and
buses are vehicle types with their own PCU (buses as road-occupying vehicles only).
A share `trip_rate.return_share` (0.3) of trips get a return leg after a dwell of about
`trip_rate.return_dwell_min` (school drop-offs, errands). Outbound trips are scaled by
1/(1+share), so the trip total is unchanged.

**Local-access estimate** (`access.rs`, display only): at a 5% sample most ngõ see fewer
than one simulated vehicle per morning, so they look empty. `RunOutput.access_volume`
estimates, for the *full* population, how many vehicles use each small street to get between
homes/POIs and the nearest main road (shortest free-flow path to any non-minor road, both
directions, including return legs). It is not simulated and has no congestion. Main roads
are 0. The web scales it by `sample_fraction × departure_share[bin]` to match the
sampled counts. To simulate the small streets instead, raise `sample_fraction`; each 2×
roughly doubles runtime.

**Replanning** (`replan.rs`, `scenario.rs`): each iteration simulates everyone, then a
random `replan.share` (10%) re-route on the observed travel times. Travel times used for
routing are averaged over iterations (method of successive averages) to damp
flip-flopping. A route is only switched if the new one is `replan.switch_gain` faster.
The baseline runs `replan.iterations` (50) offline; its routes ship as `routes.bin`.

**Rain & flood** (`flood.rs`): depth per link over time, computed before the traffic run.
- `hotspots`: known flood points (mapped to links) rise above an intensity threshold and
  recede at a fixed rate.
- `bucket`: per catchment, inflow `C × i × A`, drainage `Q`, depression storage `S`;
  excess ponds on the catchment's lowest links (deepest on the lowest) and hotspots.
- Depth → speed: capped by the Pregnolato et al. (2017) safe speed; capacity falls
  linearly to a stall factor at the motorbike stall depth; closed above a closure depth.
  Bridges never flood. Rain alone reduces speed/capacity network-wide.
- Behaviour: in heavy rain some trips are cancelled or delayed.

**Signals**: default plan per signalised node: fixed cycle, green split by approach
capacity (NS vs EW by approach bearing). Scenario overrides set cycle and split.

## Scenarios

`Scenario` JSON (examples in `../scenarios/`) mixes:
- *sudden* events — rain, incident, signal, closure, big event: one run from the
  baseline routes with en-route rerouting. Compared with the **baseline**.
- *structural* edits — `add_road`, `remove_road`, `modify_road`, `housing`, `jobs`, and
  structural parameter changes (population scale, trip rates…): demand and network are
  rebuilt, then replanned (`replan.scenario_iterations` up to
  `replan.scenario_max_iterations`, stopping at `replan.convergence_tol`). Compared with
  the **control**: the unchanged baseline put through the same replanning, so iteration
  noise cancels. `RunOutput.reference` says which one to use.

Link and node IDs are indices into the bundle (`links[i]`, `nodes[i]`) and therefore tied
to a bundle build. Added links get IDs ≥ the bundle's link count.

## CLI

```
cargo build --release
B=data/bundles/hanoi-inner.json
target/release/hanoi-sim params --out params.json
target/release/hanoi-sim baseline --bundle $B --routes-out data/out/routes.bin --out data/out/baseline.json
target/release/hanoi-sim run --bundle $B --routes data/out/routes.bin \
    --scenario scenarios/closure-lang.json --out data/out/run.json [--reference-out control.json]
# any command: --set key=value,key=value  (baseline parameter overrides, for calibration)
```

Inner Hanoi incl. alleys (42k nodes, 97k links of which 62k `service` = ngõ/ngách;
5% sample = 35k trips): baseline 50 iterations ≈ 4 min on a laptop (routing runs in
parallel on native and stays deterministic: route groups are computed in parallel and
applied in order; WASM is single-threaded); a sudden scenario ≈ 3–10 s,
a structural one ≈ 1–4 min (native; WASM ≈ same). The web animates up to 8,000 traced
vehicles (`MAX_TRACES` in `scenario.rs`).

## Determinism

- Time is integer milliseconds; road space is integer milli-PCU; the capacity token is
  integer microseconds.
- The event queue is ordered by `(time, sequence number)`; same input → identical log.
- Entities live in `Vec`s indexed by integer IDs; node in-links are sorted by ID.
- Random numbers come from counter-based streams `(seed, purpose, index)`, so adding a
  trip or an event does not shift unrelated random draws (common random numbers).

## Events

Internal (scheduled): `Departure`, `NodeUpdate` (deduplicated: at most one live update
per node), `SetCapFactor`, `SetSpeedFactor`, `SetClosed`.

Output log (`SimEvent`): `Depart`, `LinkEnter`, `LinkLeave`, `Arrive`, `Stuck`.

## Tests

```
cargo test                      # all
cargo test --test toy_networks  # hand-computed cases (bottleneck, spillback chain, …)
cargo test --test properties    # random grids: conservation, storage, FIFO, free-flow
                                # bound, Little's law, determinism, liveness
cargo test --test rerouting     # closures/incidents, informed vs uninformed, signposting
cargo test --test scenarios     # every scenario kind on a synthetic grid bundle
cargo run --release --example bench_grid -- 40 200000   # throughput
```
