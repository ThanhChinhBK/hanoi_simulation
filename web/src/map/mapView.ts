import * as maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

// MapLibre v6 locates its worker relative to its own module URL, which breaks once bundled.
maplibregl.setWorkerUrl(maplibreWorkerUrl);
import { MapboxOverlay } from '@deck.gl/mapbox';
import { PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { PathStyleExtension, type PathStyleExtensionProps } from '@deck.gl/extensions';
import { TripsLayer } from '@deck.gl/geo-layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { state } from '../state';
import type { Network } from '../network';
import { buildTrips, type LngLat, type TripPath } from '../logic/trips';
import { computeLinkStyle, aggTt, binRange, localAccessFactor, type LinkStyle } from '../logic/linkStyle';
import { parseTime, formatTime } from '../logic/time';
import { fmt } from '../ui/dom';
import type { Accident, Hotspot, RainPoint, RunData, ScenarioEvent } from '../types';
import { rainAt } from '../logic/rain';
import { latLonToLngLat } from '../logic/zones';
import { t, tn } from '../i18n';
import { roadClassName } from '../logic/roadClass';
import { parseMetro, type Metro, type MetroLine, type MetroStation } from '../logic/metro';

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
const DASH_EXT = [new PathStyleExtension({ dash: true })];

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

export type PickKind = 'link' | 'node' | 'hotspot' | 'marker' | 'zone' | 'accident';

export interface MapClick {
  lngLat: LngLat;
  kind?: PickKind;
  id?: number;
  hotspot?: Hotspot;
  accident?: Accident;
}

interface ZoneDatum {
  index: number;
  ring: LngLat[];
  profile: RainPoint[];
  label: string;
}

/** Scenario layer colours (mirror the CSS tokens --c-rain, --c-signal, … in style.css). */
export const LAYER_RGB = {
  rain: [2, 132, 199],
  signal: [217, 119, 6],
  event: [124, 58, 237],
  accident: [220, 38, 38],
  build: [15, 118, 110],
} as const;

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
  closure: [127, 29, 29, 170],
  incident: [220, 38, 38, 150],
  remove_road: [30, 30, 30, 140],
  modify_road: [15, 118, 110, 160],
  add_road: [15, 118, 110, 210],
};

const MARKER_COLORS: Record<string, Color> = {
  housing: [15, 118, 110, 235],
  jobs: [13, 148, 136, 235],
  event: [124, 58, 237, 235],
  signal: [217, 119, 6, 235],
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
  private metro: Metro = { lines: [], stations: [] };
  /** pointer position while drawing a polygon (rubber band) */
  private cursor: LngLat | null = null;
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
      locale: {
        'NavigationControl.ZoomIn': t('Zoom in'),
        'NavigationControl.ZoomOut': t('Zoom out'),
        'GeolocateControl.FindMyLocation': t('Find my location'),
        'GeolocateControl.LocationNotAvailable': t('Location not available'),
        'AttributionControl.ToggleAttribution': t('Toggle attribution'),
      },
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showAccuracyCircle: true,
        fitBoundsOptions: { maxZoom: 15 },
      }),
      'top-right',
    );
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
      const changed = z >= 15 !== this.zoom >= 15 || z >= 13 !== this.zoom >= 13;
      this.zoom = z;
      if (changed) this.render();
    });
    this.map.on('mousemove', (e) => {
      if (state.tool.kind !== 'rain-zone') return;
      this.cursor = [e.lngLat.lng, e.lngLat.lat];
      this.render();
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
      if (ev.type === 'housing') markers.push({ pos: [ev.at[1], ev.at[0]], color: MARKER_COLORS.housing, label: t('+{n} residents', { n: fmt(ev.population) }), index });
      if (ev.type === 'jobs') markers.push({ pos: [ev.at[1], ev.at[0]], color: MARKER_COLORS.jobs, label: t('+{n} jobs', { n: fmt(ev.jobs) }), index });
      if (ev.type === 'event')
        markers.push({ pos: [ev.destination[1], ev.destination[0]], color: MARKER_COLORS.event, label: t('Event: {n} people', { n: fmt(ev.extra_trips) }), index });
      if (ev.type === 'signal') markers.push({ pos: this.net.nodePos(ev.node), color: MARKER_COLORS.signal, label: t('Signal {n}s', { n: ev.cycle_s }), index });
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
    const [zoneFill, ...zoneLabels] = this.zoneLayers();
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
    layers.push(...this.metroLayers());
    if (zoneFill) layers.push(zoneFill);
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
    layers.push(...zoneLabels, ...this.accidentLayers(), ...this.draftLayers());
    this.overlay.setProps({ layers });
  }

  private zoneLayers(): Layer[] {
    const zones: ZoneDatum[] = [];
    state.scenario.events.forEach((ev, index) => {
      if (ev.type === 'rain' && ev.area && ev.area.length >= 3) zones.push({ index, ring: latLonToLngLat(ev.area), profile: ev.profile, label: ev.label ?? t('Rain zone') });
    });
    if (!zones.length) return [];
    const [r, g, b] = LAYER_RGB.rain;
    const tMin = state.time / 60_000;
    const sel = state.selection.event;
    return [
      new PolygonLayer<ZoneDatum>({
        id: 'rain-zones',
        data: zones,
        getPolygon: (d) => d.ring,
        getFillColor: (d) => [r, g, b, Math.round(50 + Math.min(1, rainAt(d.profile, tMin) / 80) * 100)],
        getLineColor: (d) => [r, g, b, d.index === sel ? 255 : 230],
        getLineWidth: (d) => (d.index === sel ? 4.5 : 3),
        lineWidthUnits: 'pixels',
        stroked: true,
        filled: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [r, g, b, 60],
        updateTriggers: { getFillColor: Math.floor(tMin), getLineColor: sel, getLineWidth: sel },
      }),
      new TextLayer<ZoneDatum>({
        id: 'rain-zone-labels',
        data: zones,
        getPosition: (d) => d.ring.reduce((a, p) => (p[1] > a[1] ? p : a), d.ring[0]),
        getText: (d) => `${d.label} · ${rainAt(d.profile, tMin)} mm/h`,
        getSize: 12,
        getColor: [7, 89, 133, 255],
        getPixelOffset: [0, -12],
        background: true,
        getBackgroundColor: [255, 255, 255, 230],
        backgroundPadding: [4, 2],
        fontFamily: 'system-ui, sans-serif',
        fontWeight: 600,
        characterSet: 'auto',
        updateTriggers: { getText: Math.floor(tMin) },
      }),
    ];
  }

  private accidentLayers(): Layer[] {
    const acc = state.result?.meta.accidents ?? [];
    if (!acc.length) return [];
    const t = state.time;
    const [r, g, b] = LAYER_RGB.accident;
    return [
      new ScatterplotLayer<Accident>({
        id: 'accidents',
        data: acc,
        getPosition: (d) => this.net.midpoint(d.link),
        getRadius: (d) => (t >= d.from_ms && t < d.to_ms ? 8 : 4),
        radiusUnits: 'pixels',
        getFillColor: (d) => (t >= d.from_ms && t < d.to_ms ? [r, g, b, 245] : [255, 255, 255, 200]),
        getLineColor: (d) => (t >= d.from_ms && t < d.to_ms ? [255, 255, 255, 255] : [r, g, b, 150]),
        lineWidthMinPixels: 2,
        stroked: true,
        pickable: true,
        updateTriggers: { getRadius: Math.floor(t / 60_000), getFillColor: Math.floor(t / 60_000), getLineColor: Math.floor(t / 60_000) },
      }),
    ];
  }

  private draftLayers(): Layer[] {
    if (state.tool.kind !== 'rain-zone') return [];
    const pts = state.tool.points as LngLat[];
    const [r, g, b] = LAYER_RGB.rain;
    const band = this.cursor && pts.length ? [...pts, this.cursor] : pts;
    const layers: Layer[] = [];
    if (pts.length >= 2 || (pts.length && this.cursor))
      layers.push(
        new PolygonLayer<LngLat[]>({
          id: 'draft-fill',
          data: band.length >= 3 ? [band] : [],
          getPolygon: (d) => d,
          getFillColor: [r, g, b, 70],
          stroked: false,
        }),
        new PathLayer<LngLat[]>({
          id: 'draft-casing',
          data: [band],
          getPath: (d) => d,
          getColor: [255, 255, 255, 230],
          getWidth: 7,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
        }),
        new PathLayer<LngLat[], PathStyleExtensionProps<LngLat[]>>({
          id: 'draft-line',
          data: [band],
          getPath: (d) => d,
          getColor: [r, g, b, 255],
          getWidth: 3,
          widthUnits: 'pixels',
          getDashArray: [4, 2],
          extensions: DASH_EXT,
        }),
      );
    layers.push(
      new ScatterplotLayer<{ p: LngLat; first: boolean }>({
        id: 'draft-vertices',
        data: pts.map((p, i) => ({ p, first: i === 0 })),
        getPosition: (d) => d.p,
        getRadius: (d) => (d.first && pts.length >= 3 ? 9 : 6),
        radiusUnits: 'pixels',
        getFillColor: (d) => (d.first ? [255, 255, 255, 255] : [r, g, b, 255]),
        getLineColor: (d) => (d.first ? [r, g, b, 255] : [255, 255, 255, 255]),
        lineWidthMinPixels: 2.5,
        stroked: true,
      }),
    );
    return layers;
  }

  /** Metro lines/stations (display only; rail is not simulated). */
  setMetro(fc: unknown) {
    this.metro = parseMetro(fc as Parameters<typeof parseMetro>[0]);
    this.render();
  }

  private metroLayers(): Layer[] {
    if (!state.layers.metro || !this.metro.lines.length) return [];
    const stations = this.metro.stations;
    const lines = state.layers.metroPlanned ? this.metro.lines : this.metro.lines.filter((l) => l.status === 'operating');
    return [
      new PathLayer<MetroLine, PathStyleExtensionProps<MetroLine>>({
        id: 'metro-casing',
        data: lines,
        getPath: (d) => d.path,
        getColor: (d) => (d.status === 'operating' ? [30, 41, 59, 235] : [255, 255, 255, 220]),
        getWidth: (d) => (d.status === 'operating' ? 9 : 7),
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
      }),
      new PathLayer<MetroLine, PathStyleExtensionProps<MetroLine>>({
        id: 'metro',
        data: lines,
        getPath: (d) => d.path,
        getColor: (d) => d.color,
        getWidth: (d) => (d.status === 'operating' ? 5 : 4),
        getDashArray: (d) => (d.status === 'operating' ? [0, 0] : [2.5, 1.5]),
        dashJustified: true,
        extensions: DASH_EXT,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [15, 23, 42, 160],
      }),
      new ScatterplotLayer<MetroStation>({
        id: 'metro-stations',
        data: stations,
        getPosition: (d) => d.pos,
        getRadius: 6,
        radiusUnits: 'pixels',
        getFillColor: [255, 255, 255, 255],
        getLineColor: (d) => d.color,
        lineWidthMinPixels: 3,
        stroked: true,
        pickable: true,
      }),
      new TextLayer<MetroStation>({
        id: 'metro-labels',
        data: this.zoom >= 13 ? stations : [],
        getPosition: (d) => d.pos,
        getText: (d) => `Ⓜ ${d.name}`,
        getSize: 12,
        getColor: [15, 23, 42, 255],
        getPixelOffset: [0, -16],
        background: true,
        getBackgroundColor: [255, 255, 255, 220],
        backgroundPadding: [3, 1],
        fontFamily: 'system-ui, sans-serif',
        fontWeight: 600,
        characterSet: 'auto',
      }),
    ];
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
    else if (id === 'rain-zones' && obj) this.onClick({ lngLat, kind: 'zone', id: obj.index as number });
    else if (id === 'accidents' && obj) this.onClick({ lngLat, kind: 'accident', accident: obj as unknown as Accident });
    else this.onClick({ lngLat });
  }

  private tooltip(info: PickingInfo): { html: string; className: string } | null {
    const obj = info.object as Record<string, unknown> | undefined;
    if (!obj || !info.layer) return null;
    if (state.tool.kind === 'rain-zone') return null;
    const box = (html: string) => ({ html, className: 'map-tooltip' });
    switch (info.layer.id) {
      case 'links': {
        const l = obj.id as number;
        const link = this.net.bundle.links[l];
        const [a, b] = binRange(state.bin, state.smoothing, state.window.n_bins);
        const cur = aggTt(state.current, l, a, b);
        const ff = state.current.freeFlow[l];
        const sf = state.current.meta.summary.sample_fraction || 1;
        const tt = (x: number) => (x >= 0 ? `${fmt(x / 1000, 0)} s` : t('no vehicles'));
        let rows = `<div><b>${esc(this.net.linkName(l))}</b></div><div class="muted">${link ? `${esc(roadClassName(link.road_class))} · ${tn(link.lanes, '{n} lane', '{n} lanes')} · ${link.maxspeed_kmh} km/h · ${fmt(link.length_m)} m` : t('new road')}</div>`;
        rows += `<div>${state.result ? t('Scenario travel time:') : t('Baseline travel time:')} <b>${tt(cur.tt)}</b> <span class="muted">(${t('free flow {n} s', { n: fmt(ff / 1000, 0) })})</span></div>`;
        if (state.result && state.reference) rows += `<div>${t('Reference:')} ${tt(aggTt(state.reference, l, a, b).tt)}</div>`;
        rows += `<div class="muted">${t('≈{n} vehicles entering per 10 min (simulated sample ×{k})', { n: fmt(cur.count / sf, 0), k: fmt(1 / sf, 0) })}</div>`;
        const est = (state.current.accessVolume[l] ?? 0) * localAccessFactor(state.current, a, b);
        if (est > 0)
          rows += `<div class="muted">${t('Local access estimate: ≈{n} per 10 min · {m} over the morning (residents to/from the main roads; not simulated)', { n: fmt(est / sf, 0), m: fmt(state.current.accessVolume[l], 0) })}</div>`;
        return box(rows);
      }
      case 'flood': {
        const step = this.floodStep();
        return box(`<div><b>${esc(this.net.linkName(obj.id as number))}</b></div><div>${t('Flood depth:')} <b>${fmt((obj.depth as number[])[step] ?? 0)} cm</b> ${t('at {time}', { time: formatTime(state.time) })}</div>`);
      }
      case 'nodes': {
        const i = obj.i as number;
        return box(`<div><b>${esc(this.net.nodeName(i))}</b></div><div class="muted">${t('node {id}', { id: i })} · ${obj.signal ? t('signalised') : t('no signal')} · ${t('click to edit')}</div>`);
      }
      case 'hotspots': {
        const h = obj as unknown as Hotspot;
        return box(
          `<div><b>${t('Flood hotspot')}</b></div><div>${esc(h.label)}</div><div class="muted">${esc(t(h.kind))} · ${esc(t('observed {d}', { d: h.observed ?? '–' }))} · ${esc(t('confidence {c}', { c: t(h.confidence) }))}</div><div class="muted small">${esc(h.source)}</div>`,
        );
      }
      case 'metro': {
        const m = obj as unknown as MetroLine;
        return box(`<div><b>${esc(m.name)}</b></div><div class="muted">${m.status === 'operating' ? 'operating' : 'planned / under construction'} · ${esc(m.note)}</div><div class="muted small">Shown for context; the metro is not simulated.</div>`);
      }
      case 'metro-stations': {
        const m = obj as unknown as MetroStation;
        return box(`<div><b>Ⓜ ${esc(m.name)}</b></div><div class="muted">${esc(m.ref.replace(/^T/, `${t('Line')} `))}${m.nameEn && m.nameEn !== m.name ? ` · ${esc(m.nameEn)}` : ''}</div>`);
      }
      case 'rain-zones': {
        const z = obj as unknown as ZoneDatum;
        return box(`<div><b>${esc(z.label)}</b></div><div>${rainAt(z.profile, state.time / 60_000)} mm/h ${t('at {time}', { time: formatTime(state.time) })}</div><div class="muted">${t('click to edit')}</div>`);
      }
      case 'accidents': {
        const a = obj as unknown as Accident;
        return box(`<div><b>${t('Accident')}</b> · ${esc(this.net.linkName(a.link))}</div><div>${formatTime(a.from_ms)}–${formatTime(a.to_ms)} · ${t('{p}% capacity left', { p: Math.round(a.capacity_factor * 100) })}</div>`);
      }
      case 'markers':
        return box(`<div><b>${esc(obj.label as string)}</b></div><div class="muted">${(obj.index as number) >= 0 ? t('click for options') : t('now click node B')}</div>`);
    }
    return null;
  }
}
