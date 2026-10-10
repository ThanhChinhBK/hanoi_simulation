import type { Bundle, ParamMap, RunData, Scenario, ScenarioEvent } from './types';

export type ViewMode = 'diff' | 'congestion' | 'congestion-ref';
export type Smoothing = 0 | 1 | 'all';

export type Tool =
  | { kind: 'select' }
  | { kind: 'add-road'; fromNode?: number }
  | { kind: 'housing' }
  | { kind: 'jobs' }
  | { kind: 'event' };

export type Topic = 'scenario' | 'result' | 'time' | 'view' | 'tool' | 'run' | 'ready' | 'selection';

export interface RunStatus {
  running: boolean;
  stage: string;
  fraction: number;
  error?: string;
  started?: number;
}

export interface Selection {
  link?: number;
  node?: number;
}

export interface BuildDefaults {
  roadClass: string;
  lanes: number;
  oneway: boolean;
  housingPopulation: number;
  jobs: number;
  eventPeople: number;
  eventFrom: string;
  eventTo: string;
}

export class AppState {
  bundle!: Bundle;
  params!: ParamMap;
  baseline!: RunData;
  control?: RunData;
  ready = false;

  scenario: Scenario = { events: [] };
  /** Latest result and the run it is compared with. */
  result?: RunData;
  reference?: RunData;
  /** JSON of the scenario that produced `result` (to flag stale results). */
  resultScenario?: string;

  time = 7.5 * 3600_000;
  playing = false;
  speed = 60; // simulated seconds per real second
  view: ViewMode = 'congestion';
  smoothing: Smoothing = 0;
  layers = { vehicles: true, localAccess: true, metro: true, metroPlanned: false, flood: true, hotspots: true, nodes: true };
  tool: Tool = { kind: 'select' };
  selection: Selection = {};
  run: RunStatus = { running: false, stage: '', fraction: 0 };
  /** re-run sudden scenarios automatically after each edit */
  autoRun = true;

  build: BuildDefaults = {
    roadClass: 'primary',
    lanes: 2,
    oneway: false,
    housingPopulation: 20000,
    jobs: 10000,
    eventPeople: 30000,
    eventFrom: '08:00',
    eventTo: '09:00',
  };

  private listeners = new Map<Topic, Set<() => void>>();

  on(topics: Topic | Topic[], fn: () => void) {
    for (const t of Array.isArray(topics) ? topics : [topics]) {
      if (!this.listeners.has(t)) this.listeners.set(t, new Set());
      this.listeners.get(t)!.add(fn);
    }
  }

  emit(...topics: Topic[]) {
    const fns = new Set<() => void>();
    for (const t of topics) this.listeners.get(t)?.forEach((f) => fns.add(f));
    fns.forEach((f) => f());
  }

  /** The run shown on the map: latest result, or the baseline. */
  get current(): RunData {
    return this.result ?? this.baseline;
  }

  get window() {
    return this.baseline.meta.window;
  }

  get bin(): number {
    const w = this.window;
    return Math.max(0, Math.min(w.n_bins - 1, Math.floor((this.time - w.start_ms) / w.bin_ms)));
  }

  get stale(): boolean {
    return !!this.result && this.resultScenario !== JSON.stringify(this.scenarioForRun());
  }

  setScenario(s: Scenario) {
    this.scenario = s;
    this.emit('scenario');
  }

  addEvent(ev: ScenarioEvent) {
    this.scenario = { ...this.scenario, events: [...this.scenario.events, ev] };
    this.emit('scenario');
  }

  replaceEvents(pred: (e: ScenarioEvent) => boolean, ev: ScenarioEvent | null) {
    const events = this.scenario.events.filter((e) => !pred(e));
    if (ev) events.push(ev);
    this.scenario = { ...this.scenario, events };
    this.emit('scenario');
  }

  removeEvent(index: number) {
    const events = this.scenario.events.slice();
    events.splice(index, 1);
    this.scenario = { ...this.scenario, events };
    this.emit('scenario');
  }

  setOverride(key: string, value: number | null) {
    const o = { ...(this.scenario.parameter_overrides ?? {}) };
    if (value === null || (this.params[key] && value === this.params[key].value)) delete o[key];
    else o[key] = value;
    this.scenario = { ...this.scenario, parameter_overrides: o };
    if (Object.keys(o).length === 0) delete this.scenario.parameter_overrides;
    this.emit('scenario');
  }

  paramValue(key: string): number {
    return this.scenario.parameter_overrides?.[key] ?? this.params[key]?.value ?? NaN;
  }

  scenarioForRun(): Scenario {
    const s: Scenario = { ...this.scenario, base: this.scenario.base ?? 'hanoi-inner' };
    if (s.parameter_overrides && Object.keys(s.parameter_overrides).length === 0) delete s.parameter_overrides;
    return s;
  }

  setTime(t: number) {
    const w = this.window;
    this.time = Math.max(w.start_ms, Math.min(w.start_ms + w.n_bins * w.bin_ms - 1, t));
    this.emit('time');
  }

  setTool(t: Tool) {
    this.tool = t;
    this.emit('tool');
  }
}

export const state = new AppState();

/** Network/demand parameters force a structural (re-planned) run in the engine. */
export function isStructuralParam(key: string): boolean {
  const c = state.params?.[key]?.category;
  return c === 'network' || c === 'demand';
}

export function isStructuralScenario(net: { describe(e: ScenarioEvent): { structural: boolean } }): boolean {
  return (
    state.scenario.events.some((e) => net.describe(e).structural) ||
    Object.keys(state.scenario.parameter_overrides ?? {}).some(isStructuralParam)
  );
}
