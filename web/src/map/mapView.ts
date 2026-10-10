import * as maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

// MapLibre v6 locates its worker relative to its own module URL, which breaks once bundled.
maplibregl.setWorkerUrl(maplibreWorkerUrl);
import { MapboxOverlay } from '@deck.gl/mapbox';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { PathStyleExtension, type PathStyleExtensionProps } from '@deck.gl/extensions';
import { TripsLayer } from '@deck.gl/geo-layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { state } from '../state';
import type { Network } from '../network';
import { buildTrips, type LngLat, type TripPath } from '../logic/trips';
import { computeLinkStyle, aggTt, binRange, localAccessFactor, type LinkStyle } from '../logic/linkStyle';
import { parseTime, formatTime } from '../logic/time';
import { fmt } from '../ui/dom';
import type { Hotspot, RunData, ScenarioEvent } from '../types';

export interface LinkDatum {
  id: number;
  path: LngLat[];
  /** Two-way roads: each direction is drawn on its right-hand side (Vietnam drives on the right). */
  offset: number;
}

/** Offset in multiples of the line width; > 0.5 leaves a small gap between the two directions. */
const TWO_WAY_OFFSET = 0.6;
/** Vehicles keep to the right of the road centre line. */
const VEHICLE_OFFSET = 0.9;
const OFFSET_EXT = [new PathStyleExtension({ offset: true })];

interface NodeDatum {
  i: number;
  pos: LngLat;
  signal: boolean;
}

interface MarkerDatum {
  pos: LngLat;
  color: [number, number, number, number];
  label: string;
  index: number;
}

type Color = [number, number, number, number];

export type PickKind = 'link' | 'node' | 'hotspot' | 'marker';

export interface MapClick {
  lngLat: LngLat;
  kind?: PickKind;
  id?: number;
  hotspot?: Hotspot;
}

const BASEMAP = 'https://tiles.openfreemap.org/styles/positron';
const BLANK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef0f3' } }],
};

export const VEHICLE_COLORS: Record<number, [number, number, number]> = {
  0: [234, 88, 12], // motorbike
  1: [37, 99, 235], // car
  2: [22, 163, 74], // bus
  3: [147, 51, 234],
};
export const VEHICLE_NAMES: Record<number, string> = { 0: 'motorbike', 1: 'car', 2: 'bus', 3: 'other' };

export const EDIT_COLORS: Record<string, Color> = {
  closure: [124, 58, 237, 150],
  incident: [245, 158, 11, 170],
  remove_road: [30, 30, 30, 140],
  modify_road: [13, 148, 136, 160],
  add_road: [37, 99, 235, 200],
};

const MARKER_COLORS: Record<string, Color> = {
  housing: [16, 185, 129, 235],
  jobs: [234, 179, 8, 235],
  event: [219, 39, 119, 235],
  signal: [14, 165, 233, 235],
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export class MapView {
  map: maplibregl.Map;
  private overlay: MapboxOverlay;
  private links: LinkDatum[] = [];
  private style: LinkStyle | null = null;
  private styleKey = '';
  private trips: TripPath[] = [];
  private tripsFor: RunData | null = null;
  private floodData: { id: number; path: LngLat[]; depth: number[] }[] = [];
  private floodFor: RunData | null = null;
  private allNodes: NodeDatum[];
  private signalNodes: NodeDatum[];
  private hotspots: Hotspot[];
  private editsCache: { events: ScenarioEvent[] | null; edits: { path: LngLat[]; color: Color }[]; markers: MarkerDatum[]; tool: unknown } = {
    events: null,
    edits: [],
    markers: [],
    tool: null,
  };
  private zoom = 13;
  onClick: (c: MapClick) => void = () => {};

  constructor(container: HTMLElement, private net: Network) {
    const [minLon, minLat, maxLon, maxLat] = net.bundle.bbox;
    const attribution = [
      '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
      '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
      ...net.bundle.attributions
        .filter((a) => !a.name.startsWith('OpenStreetMap'))
        .map((a) => `<a href="${a.url}" target="_blank" rel="noopener">${esc(a.name)}</a>`),
    ].join(' · ');
    this.map = new maplibregl.Map({
      container,
      style: BASEMAP,
      bounds: [minLon, minLat, maxLon, maxLat],
      fitBoundsOptions: { padding: 20 },
      attributionControl: { compact: true, customAttribution: attribution },
      maxPitch: 0,
      dragRotate: false,
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    // the container may not have its final size at construction time
    requestAnimationFrame(() => {
      this.map.resize();
      this.map.fitBounds([minLon, minLat, maxLon, maxLat], { padding: 20, duration: 0 });
    });
    let styleOk = false;
    this.map.once('style.load', () => (styleOk = true));
    this.map.on('error', (e: { error?: unknown }) => {
      if (!styleOk) {
        console.warn('basemap failed, using a blank background', e.error);
        styleOk = true;
        this.map.setStyle(BLANK_STYLE);
      }
    });
    this.overlay = new MapboxOverlay({
      interleaved: false,
      pickingRadius: 8,
      layers: [],
      onClick: (info: PickingInfo) => this.handleClick(info),
      getTooltip: (info: PickingInfo) => this.tooltip(info),
      getCursor: ({ isHovering }: { isHovering: boolean }) => (state.tool.kind !== 'select' ? 'crosshair' : isHovering ? 'pointer' : 'grab'),
    });
    this.map.addControl(this.overlay as unknown as maplibregl.IControl);
    this.zoom = this.map.getZoom();
    this.map.on('zoomend', () => {
      const z = this.map.getZoom();
      const changed = z >= 15 !== this.zoom >= 15;
      this.zoom = z;
      if (changed) this.render();
    });
    this.allNodes = net.bundle.nodes.map((n, i) => ({ i, pos: [n.lon, n.lat], signal: n.signal }));
    this.signalNodes = this.allNodes.filter((n) => n.signal);
    this.hotspots = net.bundle.hotspots.filter((h) => h.links.length > 0);
    this.rebuildLinks();
  }

  /** Call when the displayed run changes (added links, new traces). */
  rebuildLinks() {
    this.net.setAddedLinks(state.result?.meta);
    const n = state.current.meta.n_links;
    const links: LinkDatum[] = [];
    for (let i = 0; i < n; i++) {
      const g = this.net.geom(i);
      if (g) links.push({ id: i, path: g, offset: this.net.twin(i) !== null ? TWO_WAY_OFFSET : 0 });
    }
    this.links = links;
    this.styleKey = '';
    this.style = null;
  }

  private closedLinks(): Set<number> {
    const s = new Set<number>();
    if (!state.result || state.stale) return s;
    state.result.meta.removed_links.forEach((l) => s.add(l));
    for (const ev of state.scenario.events) {
      if (ev.type !== 'closure') continue;
      const a = ev.from ? parseTime(ev.from) : 0;
      const b = ev.to ? parseTime(ev.to) : Infinity;
      if (state.time >= a && state.time < b) ev.links.forEach((l) => s.add(l));
    }
    return s;
  }

  effectiveView() {
    return state.result ? state.view : 'congestion';
  }

  private linkStyle(): LinkStyle {
    const closed = this.closedLinks();
    const view = this.effectiveView();
    const key = [state.bin, view, state.smoothing, state.layers.localAccess, state.result ? state.result.meta.n_links : 0, [...closed].join(',')].join('|');
    if (!this.style || key !== this.styleKey) {
      this.style = computeLinkStyle({
        current: state.current,
        reference: state.reference,
        mode: view,
        bin: state.bin,
        smoothing: state.smoothing,
        closed,
        localAccess: state.layers.localAccess,
      });
      this.styleKey = key;
    }
    return this.style;
  }

  private ensureTrips() {
    if (this.tripsFor === state.current) return;
    this.tripsFor = state.current;
    this.trips = buildTrips(state.current.traces, this.net.geom, state.window.start_ms);
  }

  private ensureFlood() {
    if (this.floodFor === state.current) return;
    this.floodFor = state.current;
    const f = state.current.meta.flood;
    this.floodData = Object.entries(f.depth_cm)
      .map(([id, depth]) => ({ id: Number(id), path: this.net.geom(Number(id)) ?? [], depth }))
      .filter((d) => d.path.length > 1);
  }

  private floodStep(): number {
    const f = state.current.meta.flood;
    if (!f.n_steps) return -1;
    return Math.max(0, Math.min(f.n_steps - 1, Math.floor((state.time - f.start_ms) / f.step_ms)));
  }

  private scenarioOverlays() {
    const c = this.editsCache;
    if (c.events === state.scenario.events && c.tool === state.tool) return c;
    const edits: { path: LngLat[]; color: Color }[] = [];
    const markers: MarkerDatum[] = [];
    const pushLink = (l: number, type: string) => {
      const g = this.net.geom(l);
      if (g) edits.push({ path: g, color: EDIT_COLORS[type] });
    };
    state.scenario.events.forEach((ev, index) => {
      if (ev.type === 'closure' || ev.type === 'remove_road') ev.links.forEach((l) => pushLink(l, ev.type));
      if (ev.type === 'incident' || ev.type === 'modify_road') pushLink(ev.link, ev.type);
      if (ev.type === 'add_road') edits.push({ path: [this.net.nodePos(ev.from_node), this.net.nodePos(ev.to_node)], color: EDIT_COLORS.add_road });
      if (ev.type === 'housing') markers.push({ pos: [ev.at[1], ev.at[0]], color: MARKER_COLORS.housing, label: `+${fmt(ev.population)} residents`, index });
      if (ev.type === 'jobs') markers.push({ pos: [ev.at[1], ev.at[0]], color: MARKER_COLORS.jobs, label: `+${fmt(ev.jobs)} jobs`, index });
      if (ev.type === 'event')
        markers.push({ pos: [ev.destination[1], ev.destination[0]], color: MARKER_COLORS.event, label: `Event: ${fmt(ev.extra_trips)} people`, index });
      if (ev.type === 'signal') markers.push({ pos: this.net.nodePos(ev.node), color: MARKER_COLORS.signal, label: `Signal ${ev.cycle_s}s`, index });
    });
    if (state.tool.kind === 'add-road' && state.tool.fromNode !== undefined)
      markers.push({ pos: this.net.nodePos(state.tool.fromNode), color: [37, 99, 235, 255], label: 'A', index: -1 });
    this.editsCache = { events: state.scenario.events, tool: state.tool, edits, markers };
    return this.editsCache;
  }

  render() {
    if (!state.ready) return;
    const t = (state.time - state.window.start_ms) / 1000;
    const style = this.linkStyle();
    const { edits, markers } = this.scenarioOverlays();
    const layers: Layer[] = [];
    layers.push(
      new PathLayer<{ path: LngLat[]; color: Color }>({
        id: 'edits',
        data: edits,
        getPath: (d) => d.path,
        getColor: (d) => d.color,
        getWidth: 12,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
      }),
      new PathLayer<LinkDatum, PathStyleExtensionProps<LinkDatum>>({
        id: 'links',
        data: this.links,
        getPath: (d) => d.path,
        getColor: (d) => style.colors.subarray(d.id * 4, d.id * 4 + 4) as unknown as Color,
        getWidth: (d) => style.widths[d.id],
        getOffset: (d) => d.offset,
        extensions: OFFSET_EXT,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        capRounded: true,
        jointRounded: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [15, 23, 42, 200],
        updateTriggers: { getColor: this.styleKey, getWidth: this.styleKey },
      }),
    );
    if (state.selection.link !== undefined) {
      const g = this.net.geom(state.selection.link);
      if (g)
        layers.push(
          new PathLayer<LngLat[], PathStyleExtensionProps<LngLat[]>>({ id: 'selected', data: [g], getPath: (d) => d, getColor: [15, 23, 42, 230], getWidth: 7, widthUnits: 'pixels', capRounded: true, getOffset: this.net.twin(state.selection.link) !== null ? TWO_WAY_OFFSET : 0, extensions: OFFSET_EXT }),
        );
    }
    if (state.layers.flood) {
      this.ensureFlood();
      const step = this.floodStep();
      const data = step < 0 ? [] : this.floodData.filter((d) => d.depth[step] > 0);
      layers.push(
        new PathLayer<{ id: number; path: LngLat[]; depth: number[] }>({
          id: 'flood',
          data,
          getPath: (d) => d.path,
          getColor: (d) => {
            const x = Math.min(1, d.depth[step] / 50);
            return [Math.round(147 - 117 * x), Math.round(197 - 133 * x), Math.round(253 - 78 * x), 235];
          },
          getWidth: (d) => 3 + Math.min(12, d.depth[step] / 4),
          widthUnits: 'pixels',
          capRounded: true,
          pickable: true,
          updateTriggers: { getColor: step, getWidth: step },
        }),
      );
    }
    if (state.layers.vehicles) {
      this.ensureTrips();
      layers.push(
        new TripsLayer<TripPath, PathStyleExtensionProps<TripPath>>({
          id: 'trips',
          data: this.trips,
          getPath: (d) => d.path,
          getTimestamps: (d) => d.timestamps,
          getColor: (d) => VEHICLE_COLORS[d.vehicleType] ?? [80, 80, 80],
          widthMinPixels: 3,
          getOffset: VEHICLE_OFFSET,
          extensions: OFFSET_EXT,
          capRounded: true,
          jointRounded: true,
          trailLength: 120,
          currentTime: t,
          fadeTrail: true,
        }),
      );
    }
    const showAll = state.tool.kind === 'add-road' || (state.layers.nodes && this.zoom >= 15);
    const nodes = showAll ? this.allNodes : state.layers.nodes ? this.signalNodes : [];
    layers.push(
      new ScatterplotLayer<NodeDatum>({
        id: 'nodes',
        data: nodes,
        getPosition: (d) => d.pos,
        getRadius: (d) => (d.signal ? 3.5 : 2.5),
        radiusUnits: 'pixels',
        getFillColor: (d) => (d.signal ? [15, 23, 42, 230] : [100, 116, 139, 210]),
        getLineColor: [255, 255, 255, 255],
        lineWidthMinPixels: 1,
        stroked: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [37, 99, 235, 255],
      }),
    );
    if (state.layers.hotspots) {
      layers.push(
        new ScatterplotLayer<Hotspot>({
          id: 'hotspots',
          data: this.hotspots,
          getPosition: (d) => this.net.midpoint(d.links[0]),
          getRadius: 6,
          radiusUnits: 'pixels',
          getFillColor: [255, 255, 255, 235],
          getLineColor: [29, 78, 216, 255],
          lineWidthMinPixels: 2.5,
          stroked: true,
          pickable: true,
        }),
      );
    }
    layers.push(
      new ScatterplotLayer<MarkerDatum>({
        id: 'markers',
        data: markers,
        getPosition: (d) => d.pos,
        getRadius: 9,
        radiusUnits: 'pixels',
        getFillColor: (d) => d.color,
        getLineColor: [255, 255, 255, 255],
        lineWidthMinPixels: 2,
        stroked: true,
        pickable: true,
      }),
      new TextLayer<MarkerDatum>({
        id: 'marker-labels',
        data: markers,
        getPosition: (d) => d.pos,
        getText: (d) => d.label,
        getSize: 12,
        getColor: [15, 23, 42, 255],
        getPixelOffset: [0, -20],
        background: true,
        getBackgroundColor: [255, 255, 255, 230],
        backgroundPadding: [4, 2],
        fontFamily: 'system-ui, sans-serif',
        fontWeight: 600,
      }),
    );
    this.overlay.setProps({ layers });
  }

  flyTo(p: LngLat, zoom = 16) {
    this.map.flyTo({ center: p, zoom: Math.max(this.map.getZoom(), zoom), duration: 800 });
  }

  private handleClick(info: PickingInfo) {
    const lngLat = (info.coordinate as LngLat | undefined) ?? [0, 0];
    const id = info.layer?.id;
    const obj = info.object as Record<string, unknown> | undefined;
    if (id === 'links' && obj) this.onClick({ lngLat, kind: 'link', id: obj.id as number });
    else if (id === 'flood' && obj) this.onClick({ lngLat, kind: 'link', id: obj.id as number });
    else if (id === 'nodes' && obj) this.onClick({ lngLat, kind: 'node', id: obj.i as number });
    else if (id === 'hotspots' && obj) this.onClick({ lngLat, kind: 'hotspot', hotspot: obj as unknown as Hotspot });
    else if (id === 'markers' && obj) this.onClick({ lngLat, kind: 'marker', id: obj.index as number });
    else this.onClick({ lngLat });
  }

  private tooltip(info: PickingInfo): { html: string; className: string } | null {
    const obj = info.object as Record<string, unknown> | undefined;
    if (!obj || !info.layer) return null;
    const box = (html: string) => ({ html, className: 'map-tooltip' });
    switch (info.layer.id) {
      case 'links': {
        const l = obj.id as number;
        const link = this.net.bundle.links[l];
        const [a, b] = binRange(state.bin, state.smoothing, state.window.n_bins);
        const cur = aggTt(state.current, l, a, b);
        const ff = state.current.freeFlow[l];
        const sf = state.current.meta.summary.sample_fraction || 1;
        const tt = (x: number) => (x >= 0 ? `${fmt(x / 1000, 0)} s` : 'no vehicles');
        let rows = `<div><b>${esc(this.net.linkName(l))}</b></div><div class="muted">${link ? `${esc(link.road_class)} · ${link.lanes} lanes · ${link.maxspeed_kmh} km/h · ${fmt(link.length_m)} m` : 'new road'}</div>`;
        rows += `<div>${state.result ? 'Scenario' : 'Baseline'} travel time: <b>${tt(cur.tt)}</b> <span class="muted">(free flow ${fmt(ff / 1000, 0)} s)</span></div>`;
        if (state.result && state.reference) rows += `<div>Reference: ${tt(aggTt(state.reference, l, a, b).tt)}</div>`;
        rows += `<div class="muted">≈${fmt(cur.count / sf, 0)} vehicles entering per 10 min (simulated sample ×${fmt(1 / sf, 0)})</div>`;
        const est = (state.current.accessVolume[l] ?? 0) * localAccessFactor(state.current, a, b);
        if (est > 0)
          rows += `<div class="muted">Local access estimate: ≈${fmt(est / sf, 0)} per 10 min · ${fmt(state.current.accessVolume[l], 0)} over the morning (residents to/from the main roads; not simulated)</div>`;
        return box(rows);
      }
      case 'flood': {
        const step = this.floodStep();
        return box(`<div><b>${esc(this.net.linkName(obj.id as number))}</b></div><div>Flood depth: <b>${fmt((obj.depth as number[])[step] ?? 0)} cm</b> at ${formatTime(state.time)}</div>`);
      }
      case 'nodes': {
        const i = obj.i as number;
        return box(`<div><b>${esc(this.net.nodeName(i))}</b></div><div class="muted">node ${i} · ${obj.signal ? 'signalised' : 'no signal'} · click to edit</div>`);
      }
      case 'hotspots': {
        const h = obj as unknown as Hotspot;
        return box(
          `<div><b>Flood hotspot</b></div><div>${esc(h.label)}</div><div class="muted">${esc(h.kind)} · observed ${esc(h.observed ?? '–')} · confidence ${esc(h.confidence)}</div><div class="muted small">${esc(h.source)}</div>`,
        );
      }
      case 'markers':
        return box(`<div><b>${esc(obj.label as string)}</b></div><div class="muted">${(obj.index as number) >= 0 ? 'click for options' : 'now click node B'}</div>`);
    }
    return null;
  }
}
