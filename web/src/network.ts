import type { Bundle, RunMeta, ScenarioEvent } from './types';
import type { LngLat } from './logic/trips';
import { fmt } from './ui/dom';
import { t } from './i18n';
import { roadClassName } from './logic/roadClass';
import { areaKm2, centroid, latLonToLngLat } from './logic/zones';

/** Lookups over the city bundle (twins, labels, geometry of added links). */
export class Network {
  private twins = new Map<string, number>();
  private added = new Map<number, { from: number; to: number }>();

  constructor(public bundle: Bundle) {
    bundle.links.forEach((l, i) => this.twins.set(`${l.from}-${l.to}`, i));
  }

  get nLinks() {
    return this.bundle.links.length;
  }

  setAddedLinks(meta: RunMeta | undefined) {
    this.added.clear();
    for (const a of meta?.added_links ?? []) this.added.set(a.id, { from: a.from, to: a.to });
  }

  nodePos(n: number): LngLat {
    const nd = this.bundle.nodes[n];
    return [nd.lon, nd.lat];
  }

  geom = (link: number): LngLat[] | null => {
    const l = this.bundle.links[link];
    if (l) return l.geom;
    const a = this.added.get(link);
    return a ? [this.nodePos(a.from), this.nodePos(a.to)] : null;
  };

  /** Reverse-direction link of a two-way road, if any. */
  twin(link: number): number | null {
    const l = this.bundle.links[link];
    if (!l) return null;
    const t = this.twins.get(`${l.to}-${l.from}`);
    return t !== undefined && t !== link ? t : null;
  }

  midpoint(link: number): LngLat {
    const g = this.geom(link) ?? [[0, 0]];
    return g[Math.floor(g.length / 2)];
  }

  linkName(link: number): string {
    const l = this.bundle.links[link];
    if (!l) return this.added.has(link) ? t('new road #{id}', { id: link }) : t('link {id}', { id: link });
    return l.name || t('unnamed {cls}', { cls: roadClassName(l.road_class) });
  }

  nodeName(node: number): string {
    const names = new Set<string>();
    this.bundle.links.forEach((l) => {
      if ((l.to === node || l.from === node) && l.name) names.add(l.name);
    });
    const list = [...names].slice(0, 2);
    return list.length ? list.join(' × ') : t('node {id}', { id: node });
  }

  /** Nearest node to a point (simple scan; 8k nodes). */
  nearestNode(lon: number, lat: number): number {
    let best = 0;
    let bd = Infinity;
    const k = Math.cos((lat * Math.PI) / 180);
    this.bundle.nodes.forEach((n, i) => {
      const d = ((n.lon - lon) * k) ** 2 + (n.lat - lat) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  describe(ev: ScenarioEvent): { title: string; detail: string; structural: boolean } {
    const links = (ls: number[]) => [...new Set(ls.map((l) => this.linkName(l)))].join(', ');
    switch (ev.type) {
      case 'rain': {
        const peak = Math.max(0, ...ev.profile.map((p) => p.mm_per_hour));
        const first = ev.profile.find((p) => p.mm_per_hour > 0)?.at ?? '–';
        const where = ev.area ? t('zone {a} km²', { a: fmt(areaKm2(latLonToLngLat(ev.area)), 1) }) : t('citywide');
        return { title: ev.label || (ev.area ? t('Rain zone') : t('Citywide rain')), detail: t('{where} · peak {peak} mm/h from {first}', { where, peak: fmt(peak), first }), structural: false };
      }
      case 'accidents':
        return {
          title: t('Random accidents'),
          detail: `${t('{n} per hour · {d} min each · capacity ×{c}', { n: fmt(ev.per_hour, 1), d: ev.duration_min ?? 45, c: ev.capacity_factor ?? 0.4 })}${ev.from || ev.to ? ` · ${ev.from ?? t('start')}–${ev.to ?? t('end')}` : ''}`,
          structural: false,
        };
      case 'incident':
        return { title: t('Incident'), detail: `${links([ev.link])} · ${ev.from}–${ev.to} · ${t('capacity ×{c}', { c: ev.capacity_factor })}`, structural: false };
      case 'signal':
        return {
          title: t('Signal timing'),
          detail: `${this.nodeName(ev.node)} · ${t('cycle {c} s · NS {ns}% / EW {ew}%', { c: ev.cycle_s, ns: Math.round(ev.green_split.north_south * 100), ew: Math.round(ev.green_split.east_west * 100) })}`,
          structural: false,
        };
      case 'closure':
        return { title: t('Closure'), detail: `${links(ev.links)} · ${ev.from ?? '00:00'}–${ev.to ?? t('end of day')}`, structural: false };
      case 'event':
        return { title: t('Big event'), detail: t('{n} people arriving {from}–{to}', { n: fmt(ev.extra_trips), from: ev.arrive_between[0], to: ev.arrive_between[1] }), structural: false };
      case 'add_road':
        return {
          title: t('New road'),
          detail: `${this.nodeName(ev.from_node)} → ${this.nodeName(ev.to_node)} · ${roadClassName(ev.road_class)}, ${t('{n} lanes', { n: ev.lanes ?? t('default') })}, ${ev.oneway ? t('one-way') : t('two-way')}`,
          structural: true,
        };
      case 'remove_road':
        return { title: t('Road removed'), detail: links(ev.links), structural: true };
      case 'modify_road': {
        const parts = [ev.lanes !== undefined && t('{n} lanes', { n: ev.lanes }), ev.maxspeed_kmh !== undefined && `${ev.maxspeed_kmh} km/h`, ev.road_class && roadClassName(ev.road_class)].filter(Boolean);
        return { title: t('Road modified'), detail: `${links([ev.link])} → ${parts.join(', ')}`, structural: true };
      }
      case 'housing':
        return { title: t('New housing'), detail: t('{n} residents', { n: fmt(ev.population) }), structural: true };
      case 'jobs':
        return { title: t('New jobs'), detail: t('{n} jobs', { n: fmt(ev.jobs) }), structural: true };
    }
  }

  /** A point to fly to for an event. */
  eventLocation(ev: ScenarioEvent): LngLat | null {
    switch (ev.type) {
      case 'incident':
      case 'modify_road':
        return this.midpoint(ev.link);
      case 'closure':
      case 'remove_road':
        return ev.links.length ? this.midpoint(ev.links[0]) : null;
      case 'signal':
        return this.nodePos(ev.node);
      case 'add_road':
        return this.nodePos(ev.from_node);
      case 'event':
        return [ev.destination[1], ev.destination[0]];
      case 'housing':
      case 'jobs':
        return [ev.at[1], ev.at[0]];
      case 'rain':
        return ev.area && ev.area.length >= 3 ? centroid(latLonToLngLat(ev.area)) : null;
      default:
        return null;
    }
  }
}
