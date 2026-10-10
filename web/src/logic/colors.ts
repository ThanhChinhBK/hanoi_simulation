export type RGBA = [number, number, number, number];

export const GREEN: RGBA = [26, 152, 80, 255];
export const NEUTRAL: RGBA = [176, 182, 190, 200];
export const RED: RGBA = [215, 48, 39, 255];
export const NO_DATA: RGBA = [160, 166, 176, 90];
export const CLOSED: RGBA = [60, 20, 90, 255];
/** Small street with only the local-access estimate (not simulated): light green. */
export const ESTIMATE: RGBA = [120, 130, 165, 170];
export const ADDED: RGBA = [37, 99, 235, 255];

/** Travel-time differences smaller than this (ms) count as "no change". */
export const DEADBAND_MS = 2000;
/** |log2 ratio| that saturates the colour scale (1 = twice as slow / fast). */
export const SATURATION = 1;

function lerp(a: RGBA, b: RGBA, t: number): RGBA {
  return [0, 1, 2, 3].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as RGBA;
}

/**
 * Signed change in [-1, 1] of a link's travel time in one bin, scenario vs
 * reference (log2 ratio clipped at ±SATURATION). NaN = no vehicles in either.
 * If only the scenario has traffic, it is compared with free flow.
 */
export function diffValue(scenTt: number, refTt: number, freeFlowMs: number): number {
  const s = scenTt >= 0;
  const r = refTt >= 0;
  if (!s && !r) return NaN;
  if (!s) return 0;
  const ref = r ? refTt : freeFlowMs;
  if (!(ref > 0)) return 0;
  if (Math.abs(scenTt - ref) < DEADBAND_MS) return 0;
  const v = Math.log2(scenTt / ref) / SATURATION;
  return Math.max(-1, Math.min(1, v));
}

/** Diverging colour: -1 green (faster), 0 grey, +1 red (slower). NaN → faint grey. */
export function divergingColor(v: number): RGBA {
  if (Number.isNaN(v)) return NO_DATA;
  if (v === 0) return NEUTRAL;
  const t = Math.min(1, Math.abs(v));
  // ease so that small changes are still visible
  const e = Math.min(1, 0.25 + 0.75 * Math.sqrt(t));
  return v < 0 ? lerp(NEUTRAL, GREEN, e) : lerp(NEUTRAL, RED, e);
}

export function diffColor(scenTt: number, refTt: number, freeFlowMs: number): RGBA {
  return divergingColor(diffValue(scenTt, refTt, freeFlowMs));
}

const CONGESTION_STOPS: [number, RGBA][] = [
  [1, [26, 152, 80, 230]],
  [1.5, [145, 207, 96, 240]],
  [2, [254, 224, 139, 255]],
  [3, [252, 141, 89, 255]],
  [5, [215, 48, 39, 255]],
  [10, [120, 0, 30, 255]],
];

/** Sequential colour for absolute congestion (travel time / free-flow time). */
export function congestionColor(tt: number, freeFlowMs: number): RGBA {
  if (!(tt >= 0) || !(freeFlowMs > 0)) return NO_DATA;
  const ratio = Math.max(1, tt / freeFlowMs);
  for (let i = 1; i < CONGESTION_STOPS.length; i++) {
    const [x1, c1] = CONGESTION_STOPS[i];
    if (ratio <= x1) {
      const [x0, c0] = CONGESTION_STOPS[i - 1];
      return lerp(c0, c1, (ratio - x0) / (x1 - x0));
    }
  }
  return CONGESTION_STOPS[CONGESTION_STOPS.length - 1][1];
}

export const CONGESTION_LEGEND = CONGESTION_STOPS;

/** Line width (px) from sampled vehicles entering a link in one bin. */
export function volumeWidth(count: number): number {
  if (!(count > 0)) return 1;
  return Math.min(9, 1.2 + Math.sqrt(count) * 0.9);
}

export const toCss = (c: RGBA) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(2)})`;
