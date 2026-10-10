import type { LngLat } from './trips';

export type RGBA = [number, number, number, number];

export interface MetroLine {
  ref: string;
  name: string;
  status: 'operating' | 'planned' | string;
  note: string;
  color: RGBA;
  path: LngLat[];
}

export interface MetroStation {
  ref: string;
  name: string;
  nameEn: string;
  status: string;
  color: RGBA;
  pos: LngLat;
}

export interface Metro {
  lines: MetroLine[];
  stations: MetroStation[];
}

export function hexColor(hex: string, alpha = 255): RGBA {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [100, 116, 139, alpha];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

interface Feature {
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, string>;
}

/** Pipeline `metro.geojson` → one path per track piece and one point per station. */
export function parseMetro(fc: { features?: Feature[] }): Metro {
  const lines: MetroLine[] = [];
  const stations: MetroStation[] = [];
  for (const f of fc.features ?? []) {
    const p = f.properties ?? {};
    const planned = p.status !== 'operating';
    const color = hexColor(p.colour ?? '', planned ? 235 : 255);
    if (p.kind === 'line' && f.geometry.type === 'MultiLineString') {
      for (const path of f.geometry.coordinates as LngLat[][])
        if (path.length >= 2) lines.push({ ref: p.ref, name: p.name, status: p.status, note: p.note ?? '', color, path });
    } else if (p.kind === 'station' && f.geometry.type === 'Point') {
      stations.push({ ref: p.ref, name: p.name, nameEn: p.name_en ?? '', status: p.status, color, pos: f.geometry.coordinates as LngLat });
    }
  }
  // planned lines first so operating ones draw on top
  lines.sort((a, b) => Number(b.status !== 'operating') - Number(a.status !== 'operating'));
  return { lines, stations };
}
