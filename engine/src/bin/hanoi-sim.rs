//! Command-line interface.
//!
//! ```text
//! hanoi-sim baseline --bundle B.json --routes-out routes.bin [--out baseline.json] [--iterations N] [--set k=v,...]
//! hanoi-sim run      --bundle B.json --routes routes.bin --scenario s.json --out result.json
//! hanoi-sim params   [--out params.json]
//! ```

use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;
use std::time::Instant;

use hanoi_engine::{Bundle, Engine, Params, Scenario};

fn main() {
    if let Err(e) = real_main() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn args() -> (String, HashMap<String, String>) {
    let mut it = std::env::args().skip(1);
    let cmd = it.next().unwrap_or_default();
    let mut map = HashMap::new();
    while let Some(k) = it.next() {
        if let Some(k) = k.strip_prefix("--") {
            map.insert(k.to_string(), it.next().unwrap_or_default());
        }
    }
    (cmd, map)
}

fn read(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("{path}: {e}"))
}

fn write(path: &str, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|e| format!("{path}: {e}"))?;
    eprintln!("wrote {path} ({} bytes)", bytes.len());
    Ok(())
}

fn progress_printer() -> impl FnMut(&str, f64) {
    let t0 = Instant::now();
    let mut last = String::new();
    move |phase: &str, f: f64| {
        let s = format!("{phase} {:>3.0}%", f * 100.0);
        if s != last {
            eprint!("\r{s}   [{:.1}s]   ", t0.elapsed().as_secs_f64());
            let _ = std::io::stderr().flush();
            last = s;
        }
    }
}

fn load_engine(a: &HashMap<String, String>, routes: Option<Vec<u8>>) -> Result<Engine, String> {
    let path = a.get("bundle").ok_or("--bundle is required")?;
    if path.ends_with(".gz") {
        return Err("pass the uncompressed .json bundle".into());
    }
    let raw = read(path)?;
    let t0 = Instant::now();
    let bundle = Bundle::from_json(std::str::from_utf8(&raw).map_err(|e| e.to_string())?)?;
    let iterations = a
        .get("iterations")
        .map(|s| s.parse::<usize>().map_err(|e| e.to_string()))
        .transpose()?;
    let mut params = Params::default();
    if let Some(sets) = a.get("set") {
        for kv in sets.split(',').filter(|s| !s.is_empty()) {
            let (k, v) = kv
                .split_once('=')
                .ok_or("--set expects key=value[,key=value]")?;
            let v: f64 = v.parse().map_err(|_| format!("--set {k}: not a number"))?;
            params.set(k, v).map_err(|e| e.to_string())?;
        }
    }
    let e = Engine::with_params(
        Arc::new(bundle),
        params,
        routes.as_deref(),
        iterations,
        &mut progress_printer(),
    )?;
    eprintln!("\nbaseline ready in {:.1}s", t0.elapsed().as_secs_f64());
    Ok(e)
}

fn json<T: serde::Serialize>(v: &T, pretty: bool) -> String {
    if pretty {
        serde_json::to_string_pretty(v).expect("serializable")
    } else {
        serde_json::to_string(v).expect("serializable")
    }
}

fn real_main() -> Result<(), String> {
    let (cmd, a) = args();
    match cmd.as_str() {
        "params" => {
            let s = json(&Params::default(), true);
            match a.get("out") {
                Some(p) => write(p, s.as_bytes())?,
                None => println!("{s}"),
            }
        }
        "baseline" => {
            let e = load_engine(&a, None)?;
            eprintln!("{}", json(&e.baseline().summary, true));
            if let Some(p) = a.get("routes-out") {
                write(p, &e.baseline_routes())?;
            }
            if let Some(p) = a.get("out") {
                write(p, json(e.baseline(), false).as_bytes())?;
            }
        }
        "run" => {
            let routes = a.get("routes").map(|p| read(p)).transpose()?;
            let e = load_engine(&a, routes)?;
            let sp = a.get("scenario").ok_or("--scenario is required")?;
            let sc = Scenario::from_json(&String::from_utf8_lossy(&read(sp)?))?;
            let t0 = Instant::now();
            let out = e.run(&sc, &mut progress_printer())?;
            eprintln!("\nscenario run in {:.1}s", t0.elapsed().as_secs_f64());
            let s = &out.summary;
            eprintln!("{}", json(s, true));
            let b = &e.reference_for(&out, &mut progress_printer())?.summary;
            eprintln!(
                "\ndelay vs {}: {:.0} -> {:.0} veh*h ({:+.1}%), mean trip {:.1} -> {:.1} min",
                out.reference,
                b.total_delay_veh_h,
                s.total_delay_veh_h,
                100.0 * (s.total_delay_veh_h / b.total_delay_veh_h.max(1e-9) - 1.0),
                b.mean_trip_min,
                s.mean_trip_min
            );
            if let Some(p) = a.get("out") {
                write(p, json(&out, false).as_bytes())?;
            }
            if let (Some(p), true) = (a.get("reference-out"), out.reference == "control") {
                write(p, json(e.control(&mut progress_printer())?, false).as_bytes())?;
            }
        }
        _ => {
            return Err("usage: hanoi-sim <baseline|run|params> [--bundle B.json] [--routes R.bin] \
                 [--routes-out R.bin] [--scenario S.json] [--out O.json] [--iterations N] [--set k=v,k=v]"
                .into())
        }
    }
    Ok(())
}
