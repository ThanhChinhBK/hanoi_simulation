# hanoi-engine-wasm

wasm-bindgen facade used by the web app's Web Worker.

```sh
cd engine-wasm && wasm-pack build --target web --release --out-dir pkg
```

API (see `pkg/hanoi_engine_wasm.d.ts`): `defaultParams()`,
`new WasmEngine(bundleJson, routesBytes?, progress?)`, `.baseline()`, `.control()`,
`.run(scenarioJson, progress?)`. A `RunResult` gives `meta()` (JSON: summary, reference,
window, delay series, rain, flood depths, added/removed links), per-link typed arrays
(`linkTtMs()`, `linkCount()`, `freeFlowMs()`, link-major `[link * n_bins + bin]`),
`traces()` and `toJson()`. Calls are synchronous — run them in a worker.
