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
  main.ts            bootstrap, sidebar tabs, map-click tools, URL sync, run handler
  worker.ts          Web Worker that owns the WasmEngine
  engineClient.ts    promise-based wrapper around the worker
  state.ts           AppState: scenario, results, time, view, tool (tiny pub/sub)
  network.ts         bundle helpers: geometry (incl. added roads), names, twins, event descriptions
  logic/             pure, unit-tested logic: colors, link styling, trips, rain, scenario URL, time
  map/mapView.ts     MapLibre map + deck.gl MapboxOverlay
                     (links, flood, trips, nodes, hotspots, markers)
  ui/                sidebar panels, popups, legend, timeline (vanilla TS, `h()` DOM helper)
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
- Before any run, the map shows baseline congestion (tt ÷ free flow). After a run, the legend can switch between Difference, Scenario congestion and Reference congestion.

**Summary card:** shows deltas of `total_delay_veh_h` and `mean_trip_min` against the reference. Counts from the 5 % vehicle sample are scaled by `1/sample_fraction`. The delay chart in the timeline plots the scenario against the reference (dashed), with rain bars.

### Scenario URL

The scenario JSON is deflate-raw compressed with the browser `CompressionStream`, then base64url-encoded into `#s=…`. The hash updates as you edit, and the Share button copies the URL. On load, a `#s=` hash is decoded and restored, but the scenario is not run automatically.

## Using it

- **Scenario tab:** load an example, list or delete changes, Run, read the summary card.
- **Click a road:** incident, closure, modify road or remove road. The "both directions" option applies the action to the twin link too.
- **Click a junction:** signal cycle and green split, or start a new road from that junction. Signalised junctions are always shown; all junctions appear at zoom ≥ 15.
- **Rain tab:** presets, drag the 30-min bars to paint rain, choose the flood model.
- **Build tab:** add road (click junction A, then junction B), housing, jobs, big event, population scale.
- **Parameters tab:** every engine parameter, with unit, source, confidence and a data/assumption badge. Edits become `parameter_overrides`.
- **Timeline:** play/pause (space bar), scrub, playback speed.

## Known limitations

- Results are comparative and qualitative. Demand is synthetic: a 5 % sample of estimated trips.
- Added roads are drawn as straight lines between junctions.
- The signal popup cannot show a junction's current default plan, because the engine does not expose it.
- The main JS chunk is about 1.8 MB (≈500 KB gzip), mostly deck.gl and MapLibre.
