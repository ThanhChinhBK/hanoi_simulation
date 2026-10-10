import type { RainPoint } from '../types';
import { formatTime, parseTime } from './time';

export interface QuickRain {
  /** mm/h; 0 = no rain */
  intensity: number;
  /** ms since midnight */
  startMs: number;
  durationMin: number;
}

/** A single rain burst: constant intensity from start for the duration, then dry. */
export function quickRainProfile(q: QuickRain): RainPoint[] {
  if (q.intensity <= 0 || q.durationMin <= 0) return [];
  return [
    { at: formatTime(q.startMs), mm_per_hour: q.intensity },
    { at: formatTime(q.startMs + q.durationMin * 60_000), mm_per_hour: 0 },
  ];
}

/** Inverse of `quickRainProfile`; null if the profile is not a single burst. */
export function quickRainFromProfile(p: RainPoint[] | undefined): QuickRain | null {
  if (!p || p.length !== 2 || p[1].mm_per_hour !== 0 || p[0].mm_per_hour <= 0) return null;
  const a = parseTime(p[0].at);
  const b = parseTime(p[1].at);
  if (!(b > a)) return null;
  return { intensity: p[0].mm_per_hour, startMs: a, durationMin: Math.round((b - a) / 60_000) };
}
