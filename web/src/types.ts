// ---------------------------------------------------------------- city bundle

export interface BundleNode {
  lon: number;
  lat: number;
  elev_m: number;
  signal: boolean;
}

export interface BundleLink {
  from: number;
  to: number;
  length_m: number;
  road_class: string;
  lanes: number;
  maxspeed_kmh: number;
  oneway: boolean;
  bridge: boolean;
  tunnel: boolean;
  name: string | null;
  osm_way: number;
  geom: [number, number][];
}

export interface Hotspot {
  id: string;
  label: string;
  kind: string;
  links: number[];
  source: string;
  confidence: Confidence;
  observed?: string;
}

export interface RainPoint {
  at: string;
  mm_per_hour: number;
}

export interface RainPreset {
  id: string;
  label: string;
  description: string;
  source: string;
  confidence: Confidence;
  profile: RainPoint[];
}

export interface Attribution {
  name: string;
  license: string;
  url: string;
  used_for: string;
}

export interface Bundle {
  version: number;
  name: string;
  created: string;
  bbox: [number, number, number, number];
  nodes: BundleNode[];
  links: BundleLink[];
  hotspots: Hotspot[];
  rain_presets: RainPreset[];
  attributions: Attribution[];
}

// ---------------------------------------------------------------- parameters

export type Confidence = 'high' | 'medium' | 'low';

export interface Param {
  key: string;
  value: number;
  default: number;
  unit: string;
  min: number;
  max: number;
  category: string;
  source: string;
  confidence: Confidence;
  description: string;
}

export type ParamMap = Record<string, Param>;

// ---------------------------------------------------------------- scenario

export type FloodModel = 'none' | 'hotspots' | 'bucket';

export interface GreenSplit {
  north_south: number;
  east_west: number;
}

export type ScenarioEvent =
  | { type: 'rain'; profile: RainPoint[]; flood_model?: FloodModel; area?: [number, number][]; label?: string }
  | { type: 'accidents'; per_hour: number; duration_min?: number; capacity_factor?: number; from?: string; to?: string }
  | { type: 'incident'; link: number; from: string; to: string; capacity_factor: number }
  | { type: 'signal'; node: number; cycle_s: number; green_split: GreenSplit }
  | { type: 'closure'; links: number[]; from?: string; to?: string }
  | { type: 'event'; destination: [number, number]; extra_trips: number; arrive_between: [string, string] }
  | { type: 'add_road'; from_node: number; to_node: number; road_class: string; lanes?: number; oneway?: boolean; name?: string }
  | { type: 'remove_road'; links: number[] }
  | { type: 'modify_road'; link: number; lanes?: number; maxspeed_kmh?: number; road_class?: string }
  | { type: 'housing'; at: [number, number]; population: number }
  | { type: 'jobs'; at: [number, number]; jobs: number };

export type EventType = ScenarioEvent['type'];

export interface Scenario {
  name?: string;
  description?: string;
  base?: string;
  seed?: number;
  events: ScenarioEvent[];
  parameter_overrides?: Record<string, number>;
}

// ---------------------------------------------------------------- run output

export interface Summary {
  mode: 'baseline' | 'sudden' | 'structural';
  sample_fraction: number;
  trips_planned: number;
  trips_simulated: number;
  trips_cancelled: number;
  trips_delayed: number;
  trips_unroutable: number;
  event_trips: number;
  arrived: number;
  aborted: number;
  unfinished: number;
  stuck_pushes: number;
  reroutes: number;
  total_delay_veh_h: number;
  mean_trip_min: number;
  iterations: number;
  convergence_mean_trip_min: number[];
  flooded_links_max: number;
  accidents?: number;
  warnings: string[];
}

export interface FloodSeries {
  start_ms: number;
  step_ms: number;
  n_steps: number;
  depth_cm: Record<string, number[]>;
}

export interface RunMeta {
  summary: Summary;
  reference: 'baseline' | 'control';
  window: { start_ms: number; bin_ms: number; n_bins: number };
  n_links: number;
  delay_veh_h: number[];
  en_route: number[];
  rain_mm_h: number[];
  /** share of all departures per bin (time profile of the local-access estimate) */
  departure_share: number[];
  flood: FloodSeries;
  added_links: { id: number; from: number; to: number }[];
  removed_links: number[];
  accidents?: Accident[];
}

export interface Accident {
  link: number;
  from_ms: number;
  to_ms: number;
  capacity_factor: number;
}

export interface SignalPlan {
  node: number;
  cycle_s: number;
  green_split: GreenSplit;
}

export interface Trace {
  vehicle: number;
  vehicle_type: number;
  links: [number, number][];
  end_ms: number | null;
}

/** A run as held on the main thread (typed arrays transferred from the worker). */
export interface RunData {
  meta: RunMeta;
  linkTt: Float32Array;
  linkCount: Uint32Array;
  freeFlow: Float32Array;
  /** expected local-access vehicles per link over the window, full population (estimate) */
  accessVolume: Float32Array;
  traces: Trace[];
}

// ---------------------------------------------------------------- worker protocol

export type WorkerRequest =
  | { type: 'load'; bundleUrl: string; routesUrl: string }
  | { type: 'run'; id: number; scenario: string };

export interface WireRun {
  meta: string;
  linkTt: Float32Array;
  linkCount: Uint32Array;
  freeFlow: Float32Array;
  accessVolume: Float32Array;
  traces: string;
}

export type WorkerResponse =
  | { type: 'progress'; id: number; stage: string; fraction: number }
  | { type: 'ready'; params: string; signalPlans: string; baseline: WireRun }
  | { type: 'result'; id: number; run: WireRun; control?: WireRun }
  | { type: 'error'; id: number; message: string };
