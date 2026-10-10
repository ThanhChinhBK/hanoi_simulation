import { describe, expect, it } from 'vitest';
import { decodeScenario, encodeScenario, scenarioCodeFromHash } from './scenarioUrl';
import { barsToProfile, profileToBars, RAIN_BARS, rainTotalMm } from './rain';
import { congestionColor, diffColor, diffValue, ESTIMATE, GREEN, NEUTRAL, NO_DATA, RED } from './colors';
import { computeLinkStyle, localAccessFactor } from './linkStyle';
import { buildTrips, type LngLat } from './trips';
import { formatTime, parseTime } from './time';
import { quickRainFromProfile, quickRainProfile } from './quickRain';
import { hexColor, parseMetro } from './metro';
import type { RunData, Scenario } from '../types';

describe('scenario URL', () => {
  it('round-trips a scenario with unicode and overrides', async () => {
    const s: Scenario = {
      name: 'Mưa lớn ở Hà Nội',
      events: [
        { type: 'rain', profile: [{ at: '07:00', mm_per_hour: 80 }, { at: '08:00', mm_per_hour: 0 }], flood_model: 'bucket' },
        { type: 'closure', links: [38620, 30436], from: '06:00', to: '22:00' },
        { type: 'add_road', from_node: 7192, to_node: 4108, road_class: 'primary', lanes: 3 },
      ],
      parameter_overrides: { 'population.scale': 1.1 },
    };
    const code = await encodeScenario(s);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await decodeScenario(code)).toEqual(s);
    expect(scenarioCodeFromHash(`#s=${code}`)).toBe(code);
    expect(scenarioCodeFromHash('#foo')).toBeNull();
  });
  it('rejects garbage', async () => {
    await expect(decodeScenario('AAAA')).rejects.toThrow();
  });
});

describe('time', () => {
  it('parses and formats', () => {
    expect(parseTime('07:30')).toBe(27_000_000);
    expect(parseTime('7:30:15')).toBe(27_015_000);
    expect(parseTime('bad')).toBeNaN();
    expect(formatTime(27_000_000)).toBe('07:30');
  });
});

describe('rain editor conversion', () => {
  it('maps an aligned profile to bars and back exactly', () => {
    const profile = [
      { at: '07:00', mm_per_hour: 15 },
      { at: '07:30', mm_per_hour: 80 },
      { at: '08:30', mm_per_hour: 10 },
      { at: '09:30', mm_per_hour: 0 },
    ];
    const bars = profileToBars(profile);
    expect(bars).toHaveLength(RAIN_BARS.n);
    expect(bars.slice(4, 10)).toEqual([15, 80, 80, 10, 10, 0]);
    expect(barsToProfile(bars)).toEqual(profile);
  });
  it('averages points inside a bar and closes trailing rain', () => {
    const bars = profileToBars([{ at: '07:15', mm_per_hour: 20 }]);
    expect(bars[4]).toBe(10);
    expect(bars[15]).toBe(20);
    const p = barsToProfile(bars);
    expect(p[p.length - 1]).toEqual({ at: '13:00', mm_per_hour: 0 });
  });
  it('no rain → empty profile', () => {
    expect(barsToProfile(new Array(16).fill(0))).toEqual([]);
  });
  it('totals', () => {
    expect(rainTotalMm([{ at: '07:00', mm_per_hour: 60 }, { at: '08:00', mm_per_hour: 0 }])).toBeCloseTo(60);
  });
});

describe('link colouring', () => {
  it('no data in both → NaN / faint', () => {
    expect(diffValue(-1, -1, 10000)).toBeNaN();
    expect(diffColor(-1, -1, 10000)).toEqual(NO_DATA);
  });
  it('within deadband → neutral', () => {
    expect(diffColor(10500, 10000, 5000)).toEqual(NEUTRAL);
  });
  it('slower is red, faster is green, saturating at 2x', () => {
    expect(diffValue(40000, 20000, 10000)).toBe(1);
    expect(diffColor(80000, 20000, 10000)).toEqual(RED);
    expect(diffColor(10000, 40000, 10000)).toEqual(GREEN);
    const mid = diffColor(30000, 20000, 10000);
    expect(mid[0]).toBeGreaterThan(NEUTRAL[0]);
    expect(mid[1]).toBeLessThan(NEUTRAL[1]);
  });
  it('new traffic compares with free flow', () => {
    expect(diffValue(20000, -1, 10000)).toBe(1);
  });
  it('congestion scale', () => {
    expect(congestionColor(10000, 10000)[1]).toBeGreaterThan(congestionColor(50000, 10000)[1]);
    expect(congestionColor(-1, 10000)).toEqual(NO_DATA);
  });
});

describe('trip builder', () => {
  const geoms: Record<number, LngLat[]> = {
    1: [[0, 0], [0.001, 0], [0.002, 0]],
    2: [[0.002, 0], [0.002, 0.002]],
  };
  const g = (l: number) => geoms[l] ?? null;
  it('interpolates timestamps along links and joins shared vertices', () => {
    const [t] = buildTrips([{ vehicle: 0, vehicle_type: 1, links: [[1, 10_000], [2, 20_000]], end_ms: 40_000 }], g, 0);
    expect(t.vehicleType).toBe(1);
    expect(t.path).toEqual([[0, 0], [0.001, 0], [0.002, 0], [0.002, 0.002]]);
    expect(t.timestamps[0]).toBeCloseTo(10);
    expect(t.timestamps[1]).toBeCloseTo(15);
    expect(t.timestamps[2]).toBeCloseTo(20);
    expect(t.timestamps[3]).toBeCloseTo(40);
  });
  it('drops an unfinished last link and unknown links', () => {
    const [t] = buildTrips([{ vehicle: 0, vehicle_type: 0, links: [[1, 0], [99, 5000], [2, 6000]], end_ms: null }], g, 0);
    expect(t.path).toEqual([[0, 0], [0.001, 0], [0.002, 0]]);
    expect(t.timestamps[2]).toBeCloseTo(5);
  });
  it('uses the time origin', () => {
    const [t] = buildTrips([{ vehicle: 0, vehicle_type: 0, links: [[2, 19_800_000]], end_ms: 19_810_000 }], g, 19_800_000);
    expect(t.timestamps).toEqual([0, 10]);
  });
});

describe('local-access estimate', () => {
  // 2 links × 2 bins: link 0 simulated, link 1 a small street with no sampled vehicle
  const run = {
    meta: {
      n_links: 2,
      window: { start_ms: 0, bin_ms: 600_000, n_bins: 2 },
      summary: { sample_fraction: 0.05 },
      departure_share: [0.25, 0.75],
    },
    linkTt: new Float32Array([60_000, 60_000, -1, -1]),
    linkCount: new Uint32Array([4, 4, 0, 0]),
    freeFlow: new Float32Array([30_000, 30_000]),
    accessVolume: new Float32Array([0, 400]),
    traces: [],
  } as unknown as RunData;

  it('converts full-population volume to sampled vehicles per bin', () => {
    expect(localAccessFactor(run, 1, 1)).toBeCloseTo(0.05 * 0.75);
    expect(localAccessFactor(run, 0, 1)).toBeCloseTo(0.05 * 0.5);
    expect(localAccessFactor(run, 0, 1, false)).toBe(0);
  });

  it('fills unsimulated small streets with the estimate colour, only in congestion views', () => {
    const base = { current: run, bin: 1, smoothing: 0 as const, closed: new Set<number>() };
    const on = computeLinkStyle({ ...base, mode: 'congestion', localAccess: true });
    expect([...on.colors.subarray(4, 8)]).toEqual(ESTIMATE);
    expect(on.widths[1]).toBeGreaterThan(1);
    const off = computeLinkStyle({ ...base, mode: 'congestion', localAccess: false });
    expect(off.widths[1]).toBe(1);
    const diff = computeLinkStyle({ ...base, mode: 'diff', reference: run, localAccess: true });
    expect([...diff.colors.subarray(4, 8)]).toEqual(NO_DATA);
  });
});

describe('quick rain', () => {
  it('round-trips a single burst and rejects other profiles', () => {
    const q = { intensity: 80, startMs: parseTime('07:30'), durationMin: 45 };
    const p = quickRainProfile(q);
    expect(p).toEqual([{ at: '07:30', mm_per_hour: 80 }, { at: '08:15', mm_per_hour: 0 }]);
    expect(quickRainFromProfile(p)).toEqual(q);
    expect(quickRainProfile({ ...q, intensity: 0 })).toEqual([]);
    expect(quickRainFromProfile([{ at: '07:00', mm_per_hour: 15 }, { at: '07:30', mm_per_hour: 80 }])).toBeNull();
  });
});

describe('metro', () => {
  it('parses lines and stations, planned lines drawn first and faded', () => {
    const m = parseMetro({
      features: [
        { geometry: { type: 'MultiLineString', coordinates: [[[1, 1], [2, 2]], [[2, 2], [3, 3]]] }, properties: { kind: 'line', ref: 'T3', name: 'L3', status: 'operating', colour: '#d1427a' } },
        { geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 0]]] }, properties: { kind: 'line', ref: 'T8', name: 'L8', status: 'planned', colour: '#7f6cc4' } },
        { geometry: { type: 'Point', coordinates: [1, 1] }, properties: { kind: 'station', ref: 'T3', name: 'Cầu Giấy', status: 'operating', colour: '#d1427a' } },
      ],
    });
    expect(m.lines.map((l) => l.ref)).toEqual(['T8', 'T3', 'T3']);
    expect(m.lines[1].color).toEqual([209, 66, 122, 255]);
    expect(m.lines[0].color[3]).toBeLessThan(255); // planned: slightly faded
    expect(m.stations).toHaveLength(1);
    expect(hexColor('bad')).toHaveLength(4);
  });
});
