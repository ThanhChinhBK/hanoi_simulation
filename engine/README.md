# hanoi-engine

Mesoscopic link-queue traffic simulation (MATSim-style), event-driven. Rust core library;
CLI, Python (PyO3) and WASM targets will wrap it.

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

**Sampling**: simulate fraction `f` of trips; capacities and storage are multiplied by `f`.

**Trips** start at the end of their first link and end at the end of their last link
(MATSim convention). Departing vehicles wait off-network until the origin link has space.

## Determinism

- Time is integer milliseconds; road space is integer milli-PCU; the capacity token is
  integer microseconds.
- The event queue is ordered by `(time, sequence number)`; same input → identical log.
- Entities live in `Vec`s indexed by integer IDs; node in-links are sorted by ID.

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
cargo run --release --example bench_grid -- 40 200000   # throughput
```
