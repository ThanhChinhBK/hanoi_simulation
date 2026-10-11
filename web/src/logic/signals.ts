import type { GreenSplit } from '../types';

export interface Greens {
  /** green seconds per cycle for north–south and east–west approaches */
  ns: number;
  ew: number;
}

/** Green seconds of a plan: the cycle minus lost time, shared by the split. */
export function planToGreens(cycleS: number, split: GreenSplit, lostS: number): Greens {
  const green = Math.max(0, cycleS - lostS);
  const sum = split.north_south + split.east_west || 1;
  return { ns: Math.round((green * split.north_south) / sum), ew: Math.round((green * split.east_west) / sum) };
}

/** Plan from green seconds: cycle = greens + lost time; split = share of green. */
export function greensToPlan(g: Greens, lostS: number): { cycle_s: number; green_split: GreenSplit } {
  const ns = Math.max(1, g.ns);
  const ew = Math.max(1, g.ew);
  const share = Math.round((ns / (ns + ew)) * 1000) / 1000;
  return { cycle_s: ns + ew + lostS, green_split: { north_south: share, east_west: Math.round((1 - share) * 1000) / 1000 } };
}
