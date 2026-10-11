/// <reference lib="webworker" />
// Runs the WebAssembly engine off the main thread. All engine calls are
// synchronous (1–15 s), so progress callbacks are forwarded with postMessage.
import init, { WasmEngine, type RunResult } from '@engine/hanoi_engine_wasm.js';
import type { WireRun, WorkerRequest, WorkerResponse } from './types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let engine: WasmEngine | null = null;
let controlSent = false;

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

function wire(r: RunResult): WireRun {
  try {
    return {
      meta: r.meta(),
      linkTt: r.linkTtMs(),
      linkCount: r.linkCount(),
      freeFlow: r.freeFlowMs(),
      accessVolume: r.accessVolume(),
      traces: r.traces(),
    };
  } finally {
    r.free();
  }
}

const transfers = (w: WireRun): Transferable[] => [w.linkTt.buffer, w.linkCount.buffer, w.freeFlow.buffer, w.accessVolume.buffer];

function progress(id: number, prefix = '') {
  let last = 0;
  return (stage: string, fraction: number) => {
    const now = performance.now();
    if (now - last < 50 && fraction < 1) return;
    last = now;
    post({ type: 'progress', id, stage: prefix + stage, fraction });
  };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.type === 'load') {
    try {
      post({ type: 'progress', id: 0, stage: 'downloading city', fraction: 0 });
      const [, bundle, routes] = await Promise.all([
        init(),
        fetch(req.bundleUrl).then((r) => {
          if (!r.ok) throw new Error(`could not load ${req.bundleUrl} (${r.status})`);
          return r.text();
        }),
        fetch(req.routesUrl).then((r) => (r.ok ? r.arrayBuffer() : null)),
      ]);
      engine = new WasmEngine(bundle, routes ? new Uint8Array(routes) : undefined, progress(0));
      const baseline = wire(engine.baseline());
      post({ type: 'ready', params: engine.params(), signalPlans: engine.signalPlans(), baseline }, transfers(baseline));
    } catch (e) {
      post({ type: 'error', id: 0, message: message(e) });
    }
    return;
  }
  if (req.type === 'run') {
    if (!engine) {
      post({ type: 'error', id: req.id, message: 'engine not loaded' });
      return;
    }
    try {
      const run = wire(engine.run(req.scenario, progress(req.id)));
      let control: WireRun | undefined;
      const reference = (JSON.parse(run.meta) as { reference: string }).reference;
      if (reference === 'control' && !controlSent) {
        control = wire(engine.control(progress(req.id, 'reference run: ')));
        controlSent = true;
      }
      const t = [...transfers(run), ...(control ? transfers(control) : [])];
      post({ type: 'result', id: req.id, run, control }, t);
    } catch (e) {
      post({ type: 'error', id: req.id, message: message(e) });
    }
  }
};
