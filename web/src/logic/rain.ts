import type { RainPoint } from '../types';
import { formatTime, parseTime } from './time';

export interface BarSpec {
  startMin: number;
  stepMin: number;
  n: number;
}

/** Default editor grid: 30-min bars, 05:00–13:00. */
export const RAIN_BARS: BarSpec = { startMin: 5 * 60, stepMin: 30, n: 16 };

/** Step-function value of a profile at minute t (0 before the first point). */
export function rainAt(profile: RainPoint[], tMin: number): number {
  let v = 0;
  for (const p of profile) {
    if (parseTime(p.at) / 60000 <= tMin) v = p.mm_per_hour;
    else break;
  }
  return v;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Profile → bar values (time-weighted mean over each bar). */
export function profileToBars(profile: RainPoint[], spec: BarSpec = RAIN_BARS): number[] {
  const sorted = [...profile].sort((a, b) => parseTime(a.at) - parseTime(b.at));
  const bars: number[] = [];
  for (let i = 0; i < spec.n; i++) {
    const a = spec.startMin + i * spec.stepMin;
    let sum = 0;
    for (let m = 0; m < spec.stepMin; m++) sum += rainAt(sorted, a + m);
    bars.push(round1(sum / spec.stepMin));
  }
  return bars;
}

/** Bar values → minimal step profile (empty if no rain). */
export function barsToProfile(bars: number[], spec: BarSpec = RAIN_BARS): RainPoint[] {
  const out: RainPoint[] = [];
  let prev = 0;
  bars.forEach((raw, i) => {
    const v = round1(Math.max(0, raw));
    if (v !== prev) {
      out.push({ at: formatTime((spec.startMin + i * spec.stepMin) * 60000), mm_per_hour: v });
      prev = v;
    }
  });
  if (prev !== 0) out.push({ at: formatTime((spec.startMin + bars.length * spec.stepMin) * 60000), mm_per_hour: 0 });
  return out;
}

/** Total rainfall (mm) of a profile between two minutes. */
export function rainTotalMm(profile: RainPoint[], fromMin = 0, toMin = 24 * 60): number {
  let sum = 0;
  for (let m = fromMin; m < toMin; m++) sum += rainAt(profile, m) / 60;
  return sum;
}
