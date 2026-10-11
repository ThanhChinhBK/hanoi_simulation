import type { ParamMap, SignalPlan, RunData, RunMeta, Trace, WireRun, WorkerRequest, WorkerResponse } from './types';

export type ProgressFn = (stage: string, fraction: number) => void;

export function unwire(w: WireRun): RunData {
  return {
    meta: JSON.parse(w.meta) as RunMeta,
    linkTt: w.linkTt,
    linkCount: w.linkCount,
    freeFlow: w.freeFlow,
    accessVolume: w.accessVolume,
    traces: JSON.parse(w.traces) as Trace[],
  };
}

export interface RunResponse {
  run: RunData;
  control?: RunData;
}

/** Promise-based wrapper around the engine worker. */
export class EngineClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: RunResponse) => void; reject: (e: Error) => void; progress?: ProgressFn }>();
  private loadProgress?: ProgressFn;
  private loadResolve?: (r: { params: ParamMap; signalPlans: SignalPlan[]; baseline: RunData }) => void;
  private loadReject?: (e: Error) => void;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'worker crashed');
      this.loadReject?.(err);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private send(msg: WorkerRequest) {
    this.worker.postMessage(msg);
  }

  load(bundleUrl: string, routesUrl: string, progress?: ProgressFn) {
    this.loadProgress = progress;
    return new Promise<{ params: ParamMap; signalPlans: SignalPlan[]; baseline: RunData }>((resolve, reject) => {
      this.loadResolve = resolve;
      this.loadReject = reject;
      this.send({ type: 'load', bundleUrl, routesUrl });
    });
  }

  run(scenario: string, progress?: ProgressFn) {
    const id = this.nextId++;
    return new Promise<RunResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      this.send({ type: 'run', id, scenario });
    });
  }

  private onMessage(m: WorkerResponse) {
    switch (m.type) {
      case 'ready': {
        const params = (JSON.parse(m.params) as { params: ParamMap }).params;
        this.loadResolve?.({ params, signalPlans: JSON.parse(m.signalPlans) as SignalPlan[], baseline: unwire(m.baseline) });
        break;
      }
      case 'progress':
        if (m.id === 0) this.loadProgress?.(m.stage, m.fraction);
        else this.pending.get(m.id)?.progress?.(m.stage, m.fraction);
        break;
      case 'result': {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        p?.resolve({ run: unwire(m.run), control: m.control ? unwire(m.control) : undefined });
        break;
      }
      case 'error': {
        if (m.id === 0) {
          this.loadReject?.(new Error(m.message));
          break;
        }
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        p?.reject(new Error(m.message));
        break;
      }
    }
  }
}
