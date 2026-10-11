//! WebAssembly facade over [`hanoi_engine::Engine`].
//!
//! Large per-link arrays are returned as typed arrays; everything else as JSON.
//! Everything is synchronous: run it inside a Web Worker and report progress via
//! the callback (`(stage: string, fraction: number) => void`).

use std::sync::Arc;

use hanoi_engine::{Bundle, Engine, Params, RunOutput, Scenario};
use serde::Serialize;
use wasm_bindgen::prelude::*;

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn progress_fn(cb: &Option<js_sys::Function>) -> impl FnMut(&str, f64) + '_ {
    move |stage: &str, f: f64| {
        if let Some(cb) = cb {
            let _ = cb.call2(
                &JsValue::NULL,
                &JsValue::from_str(stage),
                &JsValue::from_f64(f),
            );
        }
    }
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Default parameter registry (value, unit, range, source, confidence, …) as JSON.
#[wasm_bindgen(js_name = defaultParams)]
pub fn default_params() -> Result<String, JsError> {
    serde_json::to_string(&Params::default()).map_err(err)
}

#[wasm_bindgen]
pub struct WasmEngine {
    engine: Engine,
}

#[wasm_bindgen]
impl WasmEngine {
    /// `bundle_json`: the city bundle; `routes`: baseline routes (`routes.bin`), or
    /// undefined to compute them (slow: minutes).
    #[wasm_bindgen(constructor)]
    pub fn new(
        bundle_json: &str,
        routes: Option<Vec<u8>>,
        progress: Option<js_sys::Function>,
    ) -> Result<WasmEngine, JsError> {
        let bundle = Arc::new(Bundle::from_json(bundle_json).map_err(err)?);
        let mut p = progress_fn(&progress);
        let engine = Engine::new(bundle, routes.as_deref(), None, &mut p).map_err(err)?;
        Ok(WasmEngine { engine })
    }

    /// Parameters in effect for the baseline, as JSON.
    pub fn params(&self) -> Result<String, JsError> {
        serde_json::to_string(self.engine.params()).map_err(err)
    }

    /// Default plan of every signalised junction, as JSON
    /// `[{node, cycle_s, green_split: {north_south, east_west}}]`.
    #[wasm_bindgen(js_name = signalPlans)]
    pub fn signal_plans(&self) -> Result<String, JsError> {
        #[derive(Serialize)]
        struct Row {
            node: u32,
            #[serde(flatten)]
            plan: hanoi_engine::signals::SignalPlan,
        }
        let rows: Vec<Row> = self
            .engine
            .signal_plans()
            .into_iter()
            .map(|(node, plan)| Row { node, plan })
            .collect();
        serde_json::to_string(&rows).map_err(err)
    }

    pub fn baseline(&self) -> RunResult {
        RunResult(self.engine.baseline().clone())
    }

    /// Reference for structural scenarios (computed once, then cached).
    pub fn control(&self, progress: Option<js_sys::Function>) -> Result<RunResult, JsError> {
        let mut p = progress_fn(&progress);
        Ok(RunResult(self.engine.control(&mut p).map_err(err)?.clone()))
    }

    #[wasm_bindgen(js_name = controlReady)]
    pub fn control_ready(&self) -> bool {
        self.engine.control_ready()
    }

    /// Run a scenario (JSON). Check `meta().reference` to know whether to compare
    /// with `baseline()` or `control()`.
    pub fn run(
        &self,
        scenario_json: &str,
        progress: Option<js_sys::Function>,
    ) -> Result<RunResult, JsError> {
        let sc = Scenario::from_json(scenario_json).map_err(err)?;
        let mut p = progress_fn(&progress);
        Ok(RunResult(self.engine.run(&sc, &mut p).map_err(err)?))
    }
}

/// Output of one run.
#[wasm_bindgen]
pub struct RunResult(RunOutput);

#[derive(Serialize)]
struct Meta<'a> {
    summary: &'a hanoi_engine::Summary,
    reference: &'a str,
    window: &'a hanoi_engine::stats::StatsConfig,
    n_links: usize,
    delay_veh_h: &'a [f64],
    en_route: &'a [f64],
    rain_mm_h: &'a [f64],
    departure_share: &'a [f32],
    flood: &'a hanoi_engine::flood::FloodSeries,
    added_links: &'a [hanoi_engine::scenario::AddedLink],
    removed_links: &'a [u32],
    accidents: &'a [hanoi_engine::scenario::Accident],
}

#[wasm_bindgen]
impl RunResult {
    /// Everything except the per-link arrays and traces, as JSON.
    pub fn meta(&self) -> Result<String, JsError> {
        let o = &self.0;
        serde_json::to_string(&Meta {
            summary: &o.summary,
            reference: &o.reference,
            window: &o.window,
            n_links: o.n_links,
            delay_veh_h: &o.delay_veh_h,
            en_route: &o.en_route,
            rain_mm_h: &o.rain_mm_h,
            departure_share: &o.departure_share,
            flood: &o.flood,
            added_links: &o.added_links,
            removed_links: &o.removed_links,
            accidents: &o.accidents,
        })
        .map_err(err)
    }

    /// Mean travel time per link and bin (ms), link-major; -1 = no data.
    #[wasm_bindgen(js_name = linkTtMs)]
    pub fn link_tt_ms(&self) -> Vec<f32> {
        self.0.link_tt_ms.clone()
    }

    /// Vehicles entering each link per bin (sampled), link-major.
    #[wasm_bindgen(js_name = linkCount)]
    pub fn link_count(&self) -> Vec<u32> {
        self.0.link_count.clone()
    }

    /// Expected local-access vehicles per link over the window (full population estimate).
    #[wasm_bindgen(js_name = accessVolume)]
    pub fn access_volume(&self) -> Vec<f32> {
        self.0.access_volume.clone()
    }

    #[wasm_bindgen(js_name = freeFlowMs)]
    pub fn free_flow_ms(&self) -> Vec<f32> {
        self.0.free_flow_ms.clone()
    }

    /// Sampled vehicle traces as JSON: `[{vehicle, vehicle_type, links: [[link, t_ms]…], end_ms}]`.
    pub fn traces(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.0.traces).map_err(err)
    }

    /// Full output as JSON (same as the CLI writes).
    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.0).map_err(err)
    }
}
