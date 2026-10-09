import type { RunData } from '../types';
import { CLOSED, congestionColor, diffColor, NO_DATA, volumeWidth, type RGBA } from './colors';
import type { Smoothing, ViewMode } from '../state';

export interface LinkStyleInput {
  current: RunData;
  reference?: RunData;
  mode: ViewMode;
  bin: number;
  smoothing: Smoothing;
  /** links shown as closed (removed or closed at this time) */
  closed: Set<number>;
}

export interface LinkStyle {
  colors: Uint8ClampedArray;
  widths: Float32Array;
}

/** Count-weighted mean travel time of a link over bins [a, b]; -1 if no vehicle. */
export function aggTt(run: RunData, link: number, a: number, b: number): { tt: number; count: number } {
  const n = run.meta.window.n_bins;
  if (link >= run.meta.n_links) return { tt: -1, count: 0 };
  if (a === b) {
    const i = link * n + a;
    return { tt: run.linkTt[i], count: run.linkCount[i] };
  }
  let sum = 0;
  let cnt = 0;
  for (let k = a; k <= b; k++) {
    const i = link * n + k;
    const c = run.linkCount[i];
    const t = run.linkTt[i];
    if (c > 0 && t >= 0) {
      sum += t * c;
      cnt += c;
    }
  }
  return { tt: cnt > 0 ? sum / cnt : -1, count: cnt / (b - a + 1) };
}

export function binRange(bin: number, smoothing: Smoothing, nBins: number): [number, number] {
  if (smoothing === 'all') return [0, nBins - 1];
  return [Math.max(0, bin - smoothing), Math.min(nBins - 1, bin + smoothing)];
}

/** Per-link colour and width for the map in one time bin. */
export function computeLinkStyle(inp: LinkStyleInput): LinkStyle {
  const { current, reference, mode, closed } = inp;
  const n = current.meta.n_links;
  const colors = new Uint8ClampedArray(n * 4);
  const widths = new Float32Array(n);
  const [a, b] = binRange(inp.bin, inp.smoothing, current.meta.window.n_bins);
  const shown = mode === 'congestion-ref' && reference ? reference : current;
  for (let l = 0; l < n; l++) {
    let c: RGBA;
    const s = aggTt(shown, l, a, b);
    const ff = current.freeFlow[l] ?? shown.freeFlow[l];
    if (closed.has(l)) c = CLOSED;
    else if (mode === 'diff' && reference) {
      const r = aggTt(reference, l, a, b);
      c = diffColor(s.tt, r.tt, ff);
    } else if (mode === 'diff') c = NO_DATA;
    else c = congestionColor(s.tt, ff);
    colors.set(c, l * 4);
    widths[l] = closed.has(l) ? 3 : volumeWidth(s.count);
  }
  return { colors, widths };
}
