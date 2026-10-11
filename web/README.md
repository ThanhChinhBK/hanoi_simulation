# Hanoi traffic what-if sandbox — web front-end

A static single-page app (no backend). The Rust traffic engine runs as WebAssembly in a Web Worker. The map uses MapLibre GL with an OpenFreeMap basemap (no API key needed) and deck.gl layers.

## Running it

```bash
cd web
npm install
npm run build:wasm     # optional: rebuilds ../engine-wasm/pkg (needs wasm-pack; run `source ~/.cargo/env` first)
npm run dev            # http://localhost:5173 (runs prepare-data first)
npm run build          # tsc --noEmit (strict) + vite build → dist/ (static, base './')
npm run preview        # serve dist/
npm test               # Vitest unit tests (pure logic)
npm run e2e            # Playwright smoke test (builds, serves on :4179, screenshots in e2e/screenshots/)
```

The first time you run the e2e test, install the browser with `npx playwright install chromium`.

### Data

`npm run prepare-data` runs automatically before `dev` and `build`. It copies the following into `public/`, which is gitignored:

- `../data/bundles/hanoi-inner.json` and `../data/out/routes.bin` → `public/data/`
- `../scenarios/*.json` → `public/scenarios/`, plus an `index.json`

If anything is missing, the script fails and says which pipeline step produces the missing file. At runtime the app fetches everything relative to the page URL, so `dist/` works on a GitHub Pages subpath.

## Architecture

```
src/
  main.ts            bootstrap, top bar, sidebar tabs, map tools + polygon drawing, shortcuts, URL sync, run handler
  worker.ts          Web Worker that owns the WasmEngine
  engineClient.ts    promise-based wrapper around the worker
  state.ts           AppState: scenario, results, time, view, tool (tiny pub/sub)
  network.ts         bundle helpers: geometry (incl. added roads), names, twins, event descriptions
  logic/             pure, unit-tested logic: colors, link styling, trips, rain, scenario URL, time
  map/mapView.ts     MapLibre map + deck.gl MapboxOverlay
                     (links, flood, trips, nodes, hotspots, markers)
  ui/                top bar, setup/results/advanced panels, kit (sections, items, sliders), tool rail, inspector, legend, timeline (vanilla TS, `h()` DOM helper)
```

### Worker protocol

| main → worker | worker → main |
|---|---|
| `{type:'load', bundleUrl, routesUrl}` | `{type:'progress', id: 0, stage, fraction}` …<br>`{type:'ready', params, baseline: WireRun}` |
| `{type:'run', id, scenario}` (scenario is a JSON string) | `{type:'progress', id, stage, fraction}` …<br>`{type:'result', id, run: WireRun, control?: WireRun}` |
| | `{type:'error', id, message}` (e.g. an invalid scenario) |

`WireRun = {meta: string, linkTt: Float32Array, linkCount: Uint32Array, freeFlow: Float32Array, traces: string}`. The typed arrays are sent as transferables, so they are not copied.

- **Load:** the worker fetches the bundle text and `routes.bin`, then constructs the `WasmEngine`, which also computes the baseline.
- **Run:** when a run's `meta.reference` is `"control"`, the worker also sends `engine.control()` the first time. The control is slow to compute once, then cached. The main thread keeps it.
- **Progress:** callbacks are throttled to one message every 50 ms.
- **Geometry:** the main thread fetches the bundle separately (the browser cache usually serves it) to get geometry for drawing.

### How comparison works

Every run says what it should be compared with (`meta.reference`):

- **`baseline`** — "sudden" scenarios such as rain, incidents, closures, signal timing and big events. The trips are the same as the baseline, and drivers react en route.
- **`control`** — "structural" scenarios: new or removed roads, housing, jobs, network/demand parameters. Demand is replanned, so the engine provides a *control* run: the baseline put through the same replanning. Diffing against it cancels the replanning noise.

**Link colours** always show the difference against that reference, never absolute speed:

- The value per link is `log2(tt_scenario / tt_reference)`, using count-weighted mean travel times over the selected time aggregation (one 10-min bin, ±1 bin, or the whole window).
- Differences under 2 s count as no change (grey).
- The scale saturates at ½× (green) and 2× (red).
- If a link has traffic only in the scenario, it is compared with its free-flow time.
- Closed and removed links are drawn in purple.
- Width scales with volume.
- **Metro:** operating lines 2A and 3 with their stations; planned lines (2, 8, 10, 14) behind the "Planned metro" toggle. They come from OSM route relations (`data/bundles/metro.geojson`), and line status is set by hand in `pipeline/hanoi_pipeline/config.py`. Shown for context only; rail is not simulated.
- Two-way roads are drawn as two lines, one per direction, offset to the right-hand side of travel (Vietnam drives on the right). Vehicles keep to the right too.
- Small streets that the 5 % sample does not reach are filled with the engine's *local-access estimate* (slate colour, "Small streets (est.)" toggle): the full-population residents travelling to and from the main roads, scaled to the sample. It is an estimate, not a simulation, so it has no congestion colour and is not used in Difference mode.
- Before any run, the map shows baseline congestion (tt ÷ free flow). After a run, the legend can switch between Difference, Scenario congestion and Reference congestion.

**Summary card:** shows deltas of `total_delay_veh_h` and `mean_trip_min` against the reference. Counts from the 5 % vehicle sample are scaled by `1/sample_fraction`. The delay chart in the timeline plots the scenario against the reference (dashed), with rain bars.

### Scenario URL

The scenario JSON is deflate-raw compressed with the browser `CompressionStream`, then base64url-encoded into `#s=…`. The hash updates as you edit, and the Share button copies the URL. On load, a `#s=` hash is decoded and restored, but the scenario is not run automatically.

## Using it

The UI follows [`docs/design-system.md`](../docs/design-system.md): set up a scenario, then run it.

- **Top bar:** scenario name, *Examples*, status chip (Baseline / Not run yet / Running / Up to date / Outdated), *Live update* (off by default: re-runs sudden scenarios ~0.6 s after each change), Share, Clear and **Run simulation** (Ctrl/⌘ + Enter).
- **Setup tab**, one colour per layer (same colour on the map):
  - *Weather & flooding* (blue): **Draw rain zone** (or press `R`): click corners on the map, then click the first corner, double-click or press Enter (Backspace undoes, Esc cancels). Or *Citywide rain*, or a historic storm. Each rain has intensity / start / duration sliders or a custom profile chart. One flood model for all rain.
  - *Traffic signals* (amber): default cycle for all junctions; search a junction or click one on the map, then set north–south / east–west **green seconds**.
  - *Events* (violet): people, arrival window, *Place on map* (`E`).
  - *Accidents & incidents* (red): random accidents (rate per hour, how long each blocks, severity, time window, more in rain); incidents and closures added by clicking roads.
  - *Road works & growth* (teal): new road, housing, jobs, population.
- **Map tool rail** (left of the map): Select `V`, Rain zone `R`, Event `E`, New road, Housing, Jobs.
- **Locate me** (top-right, under zoom): shows and follows your position via the browser Geolocation API. Needs HTTPS in production (localhost is fine) and the user's permission.
- **Language** (VI | EN in the top bar): the UI defaults to Vietnamese. The choice is saved in `localStorage` (`hanoi-sim.lang`); `?lang=en` / `?lang=vi` forces it. Switching keeps the current scenario. Strings are wrapped in `t('English text')` / `tn(n, one, other)` from `src/i18n.ts`; add the Vietnamese text to `src/i18n.vi.ts` (`npm test` fails if a key is missing or placeholders differ). Engine parameter descriptions, warnings and data sources stay in English.
- **Inspector** (right of the map): click a road (incident, closure, modify/remove), a junction (green seconds, new road from here), a rain zone, marker or accident.
- **Results tab:** opens after a run: summary card, deltas, accident list, warnings.
- **Advanced tab:** every engine parameter, with unit, source, confidence and a data/assumption badge. Edits become `parameter_overrides`.
- **Timeline:** play/pause (space bar), scrub, speed; rain bars and accident ticks.

## Known limitations

- Results are comparative and qualitative. Demand is synthetic: a 5 % sample of estimated trips.
- Added roads are drawn as straight lines between junctions.
- The main JS chunk is about 1.8 MB (≈500 KB gzip), mostly deck.gl and MapLibre.
