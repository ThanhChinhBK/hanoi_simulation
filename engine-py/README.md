# hanoi-engine (Python bindings)

PyO3 bindings for notebooks: calibration, sensitivity analysis, plotting. Results are
identical to the CLI and the browser build.

```sh
cd engine-py
uv venv .venv && uv pip install --python .venv/bin/python maturin numpy pytest
.venv/bin/maturin develop --release
.venv/bin/python -m pytest -q tests
```

```python
from hanoi_engine import Engine, default_params

eng = Engine.load("../data/bundles/hanoi-inner.json", "../data/out/routes.bin")
run = eng.run({"events": [{"type": "closure", "links": [38620]}]})
ref = eng.reference(run)                       # baseline or control, as appropriate
print(run.summary["total_delay_veh_h"] / ref.summary["total_delay_veh_h"] - 1)
worse = run.link_delay_veh_h() - ref.link_delay_veh_h()   # numpy, per link

# Calibration: baseline parameters other than the defaults (routes are recomputed
# unless they still match, so pass iterations).
cal = Engine.load("../data/bundles/hanoi-inner.json",
                  params={"flood.drainage_mm_h": 30}, iterations=50)
```

`Run` exposes `summary`, `link_tt_ms` / `link_count` (n_links × n_bins numpy arrays),
`free_flow_ms`, `delay_veh_h`, and the raw dict (`run.raw`, same as the CLI JSON).
