import type { Trace } from '../types';

export type LngLat = [number, number];

export interface TripPath {
  vehicleType: number;
  path: LngLat[];
  /** seconds since the time origin (float32-safe) */
  timestamps: number[];
}

function segLen(a: LngLat, b: LngLat): number {
  const kx = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const dx = (b[0] - a[0]) * kx;
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Build animated paths from traces: each link's geometry is traversed between
 * its enter time and the next link's enter time (or the trace's end). A last
 * link without end time is dropped (vehicle still en route at window end).
 */
export function buildTrips(traces: Trace[], linkGeom: (link: number) => LngLat[] | null, originMs: number): TripPath[] {
  const out: TripPath[] = [];
  for (const tr of traces) {
    const path: LngLat[] = [];
    const ts: number[] = [];
    const n = tr.links.length;
    for (let i = 0; i < n; i++) {
      const [link, enter] = tr.links[i];
      const exit = i + 1 < n ? tr.links[i + 1][1] : tr.end_ms;
      if (exit == null) break;
      const g = linkGeom(link);
      if (!g || g.length < 2) continue;
      const cum = [0];
      for (let k = 1; k < g.length; k++) cum.push(cum[k - 1] + segLen(g[k - 1], g[k]));
      const total = cum[cum.length - 1];
      const dur = Math.max(0, exit - enter);
      for (let k = 0; k < g.length; k++) {
        const t = (enter + (total > 0 ? (cum[k] / total) * dur : (k / (g.length - 1)) * dur) - originMs) / 1000;
        const last = path[path.length - 1];
        if (k === 0 && last && last[0] === g[0][0] && last[1] === g[0][1]) {
          ts[ts.length - 1] = Math.max(ts[ts.length - 1], t);
          continue;
        }
        path.push(g[k]);
        ts.push(t);
      }
    }
    if (path.length >= 2) out.push({ vehicleType: tr.vehicle_type, path, timestamps: ts });
  }
  return out;
}
