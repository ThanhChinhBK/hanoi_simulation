import { t } from '../i18n';
import type { LngLat } from './trips';

/** Words for rain intensity (mm/h), roughly following the Vietnamese met service classes. */
export function rainWord(mmh: number): string {
  if (mmh <= 0) return t('none');
  if (mmh < 10) return t('light');
  if (mmh < 30) return t('moderate');
  if (mmh < 60) return t('heavy');
  return t('very heavy');
}

/** Area-weighted centroid of a simple polygon ([lon, lat]); vertex mean if degenerate. */
export function centroid(ring: LngLat[]): LngLat {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const n = ring.length || 1;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** Polygon area in km² (equirectangular approximation, fine at city scale). */
export function areaKm2(ring: LngLat[]): number {
  if (ring.length < 3) return 0;
  const lat0 = (ring.reduce((s, p) => s + p[1], 0) / ring.length) * (Math.PI / 180);
  const kx = 111.32 * Math.cos(lat0);
  const ky = 110.57;
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    a += x0 * kx * (y1 * ky) - x1 * kx * (y0 * ky);
  }
  return Math.abs(a) / 2;
}

/** Scenario areas are [lat, lon]; the map works in [lon, lat]. */
export const latLonToLngLat = (area: [number, number][]): LngLat[] => area.map(([lat, lon]) => [lon, lat]);
export const lngLatToLatLon = (ring: LngLat[]): [number, number][] =>
  ring.map(([lon, lat]) => [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5]);
