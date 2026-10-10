//! Python bindings: `hanoi_engine._native`. The pure-Python wrapper in
//! `python/hanoi_engine/__init__.py` turns outputs into dicts and numpy arrays.

use std::collections::BTreeMap;
use std::sync::Arc;

use hanoi_engine::flood::{self, FloodModel, RainProfile};
use hanoi_engine::scenario::parse_time;
use hanoi_engine::{Bundle, City, Engine as Core, Params, RunOutput, Scenario};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;

fn err(e: impl std::fmt::Display) -> PyErr {
    PyValueError::new_err(e.to_string())
}

fn to_json(o: &RunOutput) -> PyResult<String> {
    serde_json::to_string(o).map_err(err)
}

/// Default parameter registry as JSON.
#[pyfunction]
fn default_params_json() -> PyResult<String> {
    serde_json::to_string(&Params::default()).map_err(err)
}

#[pyclass(module = "hanoi_engine._native", frozen)]
struct Engine {
    inner: Core,
}

#[pymethods]
impl Engine {
    /// `bundle_json`: city bundle text. `routes`: baseline routes bytes (optional).
    /// `params`: baseline parameter overrides (calibration). `iterations`: replanning
    /// iterations when routes are not given.
    #[new]
    #[pyo3(signature = (bundle_json, routes=None, params=None, iterations=None, verbose=false))]
    fn new(
        py: Python<'_>,
        bundle_json: &str,
        routes: Option<Vec<u8>>,
        params: Option<BTreeMap<String, f64>>,
        iterations: Option<usize>,
        verbose: bool,
    ) -> PyResult<Self> {
        let bundle = Arc::new(Bundle::from_json(bundle_json).map_err(err)?);
        let p = Params::default()
            .with_overrides(&params.unwrap_or_default())
            .map_err(err)?;
        let inner = py
            .detach(|| {
                let mut prog = |s: &str, f: f64| {
                    if verbose {
                        eprintln!("[hanoi-engine] {s} {:.0}%", f * 100.0);
                    }
                };
                Core::with_params(bundle, p, routes.as_deref(), iterations, &mut prog)
            })
            .map_err(err)?;
        Ok(Engine { inner })
    }

    fn params_json(&self) -> PyResult<String> {
        serde_json::to_string(self.inner.params()).map_err(err)
    }

    fn baseline_json(&self) -> PyResult<String> {
        to_json(self.inner.baseline())
    }

    fn baseline_routes(&self) -> Vec<u8> {
        self.inner.baseline_routes()
    }

    fn control_json(&self, py: Python<'_>) -> PyResult<String> {
        let o = py
            .detach(|| self.inner.control(&mut |_, _| {}).cloned())
            .map_err(err)?;
        to_json(&o)
    }

    fn run_json(&self, py: Python<'_>, scenario_json: &str) -> PyResult<String> {
        let sc = Scenario::from_json(scenario_json).map_err(err)?;
        let o = py
            .detach(|| self.inner.run(&sc, &mut |_, _| {}))
            .map_err(err)?;
        to_json(&o)
    }
}

/// Flood layer only (no traffic): fast enough for calibration sweeps.
#[pyclass(module = "hanoi_engine._native", frozen)]
struct Flood {
    city: City,
}

#[pymethods]
impl Flood {
    #[new]
    fn new(bundle_json: &str) -> PyResult<Self> {
        let bundle = Arc::new(Bundle::from_json(bundle_json).map_err(err)?);
        let city = City::build(bundle, &Params::default(), &[]).map_err(err)?;
        Ok(Flood { city })
    }

    /// `profile`: [("HH:MM", mm/h)], `model`: "hotspots" | "bucket" | "none".
    /// Returns the flood series as JSON: {start_ms, step_ms, n_steps, depth_cm: {link: [cm]}}.
    #[pyo3(signature = (profile, model, start, end, params=None))]
    fn run_json(
        &self,
        py: Python<'_>,
        profile: Vec<(String, f64)>,
        model: &str,
        start: &str,
        end: &str,
        params: Option<BTreeMap<String, f64>>,
    ) -> PyResult<String> {
        let p = Params::default()
            .with_overrides(&params.unwrap_or_default())
            .map_err(err)?;
        let pts = profile
            .iter()
            .map(|(t, v)| Ok((parse_time(t)?, *v)))
            .collect::<Result<Vec<_>, String>>()
            .map_err(err)?;
        let rain = RainProfile::new(pts).map_err(err)?;
        let model: FloodModel = serde_json::from_value(serde_json::Value::String(model.into()))
            .map_err(err)?;
        let (t0, t1) = (parse_time(start).map_err(err)?, parse_time(end).map_err(err)?);
        let fl = py.detach(|| flood::simulate(&self.city, &p, &rain, model, t0, t1));
        serde_json::to_string(&fl).map_err(err)
    }
}

#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Engine>()?;
    m.add_class::<Flood>()?;
    m.add_function(wrap_pyfunction!(default_params_json, m)?)?;
    Ok(())
}
