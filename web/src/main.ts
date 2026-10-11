import './style.css';
import { state, isStructuralScenario } from './state';
import { EngineClient } from './engineClient';
import { Network } from './network';
import { MapView, type MapClick } from './map/mapView';
import type { Bundle } from './types';
import { decodeScenario, encodeScenario, scenarioCodeFromHash } from './logic/scenarioUrl';
import { parseTime } from './logic/time';
import { fmt, h, icon } from './ui/dom';
import { quickRainProfile } from './logic/quickRain';
import { lngLatToLatLon } from './logic/zones';
import { closePopup, mountInspector, Popups, toast } from './ui/popups';
import { DEFAULT_RAIN, newRain, setupPanel } from './ui/setupPanel';
import { resultsPanel } from './ui/resultsPanel';
import { topBar } from './ui/topBar';
import { startTool, toolRail } from './ui/toolRail';
import { paramsPanel } from './ui/paramsPanel';
import { aboutPanel } from './ui/aboutPanel';
import { timeline } from './ui/timeline';
import { mapLegend } from './ui/legend';
import { t, tn, tStage } from './i18n';

const app = document.getElementById('app')!;
const setPhase = (s: 'loading' | 'ready' | 'running' | 'done' | 'error') => (document.body.dataset.state = s);
setPhase('loading');

const loadingLabel = h('div.loading-label', t('Loading city…'));
const loadingBar = h('div.progress-bar');
const loading = h(
  'div.loading',
  { role: 'status' },
  h('div.loading-card', h('div.brand', t('Hanoi traffic what-if')), loadingLabel, h('div.progress', h('div.progress-bar-wrap', loadingBar))),
);
app.appendChild(loading);

const dataUrl = (p: string) => new URL(p, document.baseURI).href;

let lastHashCode: string | null = null;
async function scenarioFromHash(): Promise<boolean> {
  const code = scenarioCodeFromHash(location.hash);
  if (!code || code === lastHashCode) return false;
  lastHashCode = code;
  try {
    const s = await decodeScenario(code);
    state.setScenario(s);
    return true;
  } catch (e) {
    console.warn('bad scenario in URL', e);
    toast(t('The scenario in the link could not be read'), 'error');
    return false;
  }
}

async function main() {
  const client = new EngineClient();
  const bundleUrl = dataUrl('data/hanoi-inner.json');
  const [bundle, engine] = await Promise.all([
    fetch(bundleUrl).then((r) => {
      if (!r.ok) throw new Error(t('Could not load the city bundle ({status}). Run “npm run prepare-data”.', { status: r.status }));
      return r.json() as Promise<Bundle>;
    }),
    client.load(bundleUrl, dataUrl('data/routes.bin'), (stage, f) => {
      loadingLabel.textContent = `${tStage(stage)}…`;
      loadingBar.style.width = `${Math.round(f * 100)}%`;
    }),
  ]);
  state.bundle = bundle;
  state.params = engine.params;
  state.baseline = engine.baseline;
  state.signalPlans = new Map(engine.signalPlans.map((p) => [p.node, p]));
  state.time = 7.5 * 3600_000;
  const fromLink = await scenarioFromHash();

  const net = new Network(bundle);
  const mapEl = h('div#map', { 'aria-label': t('Map of inner Hanoi') });
  const tabs = ['setup', 'results', 'advanced', 'about'] as const;
  type Tab = (typeof tabs)[number];
  const labels: Record<Tab, [string, string]> = { setup: [t('Setup'), 'sliders'], results: [t('Results'), 'chart'], advanced: [t('Advanced'), 'layers'], about: [t('About'), 'info'] };
  const tabBar = h('nav.tabs', { role: 'tablist', 'aria-label': t('Sidebar') });
  const panels = h('div.panels');
  const showTab = (t: string) => {
    tabBar.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    panels.querySelectorAll<HTMLElement>('[role=tabpanel]').forEach((p) => (p.hidden = p.dataset.tab !== t));
  };
  state.ready = true;

  const view = new MapView(mapEl, net);
  fetch(dataUrl('data/metro.geojson'))
    .then((r) => (r.ok ? r.json() : null))
    .then((fc) => fc && view.setMetro(fc))
    .catch(() => console.warn('metro layer unavailable'));
  const editEvent = (i: number) => {
    showTab('setup');
    state.focusEvent(i);
  };
  const popups = new Popups(view, net, editEvent);
  const flyTo = (i: number) => {
    const ev = state.scenario.events[i];
    const p = ev && net.eventLocation(ev);
    if (p) view.flyTo(p, ev.type === 'rain' ? 14 : 16);
  };

  const share = async () => {
    const code = await encodeScenario(state.scenario);
    lastHashCode = code;
    history.replaceState(null, '', `#s=${code}`);
    return location.href;
  };

  const run = async () => {
    if (state.run.running) return;
    const json = JSON.stringify(state.scenarioForRun());
    state.run = { running: true, stage: 'starting', fraction: 0, started: performance.now() };
    setPhase('running');
    state.emit('run');
    try {
      const res = await client.run(json, (stage, fraction) => {
        state.run.stage = stage;
        state.run.fraction = fraction;
        state.emit('run');
      });
      if (res.control) state.control = res.control;
      const reference = res.run.meta.reference === 'control' ? state.control : state.baseline;
      if (!reference) throw new Error('reference run missing');
      state.result = res.run;
      state.reference = reference;
      state.resultScenario = json;
      state.view = 'diff';
      view.rebuildLinks();
      state.run = { running: false, stage: '', fraction: 1 };
      setPhase('done');
      state.emit('run', 'result', 'view');
      showTab('results');
    } catch (e) {
      state.run = { running: false, stage: '', fraction: 0, error: e instanceof Error ? e.message : String(e) };
      setPhase('error');
      state.emit('run');
    }
    if (autoPending) {
      autoPending = false;
      scheduleAutoRun();
    }
  };

  // Auto-run: sudden scenarios take seconds, so re-run shortly after each edit.
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  let autoPending = false;
  const scheduleAutoRun = () => {
    clearTimeout(autoTimer);
    if (!state.autoRun || !state.ready || isStructuralScenario(net)) return;
    const empty = !state.scenario.events.length && !Object.keys(state.scenario.parameter_overrides ?? {}).length;
    if (empty || (state.result && !state.stale)) return;
    autoTimer = setTimeout(() => {
      if (state.run.running) autoPending = true;
      else void run();
    }, 600);
  };
  state.on(['scenario'], scheduleAutoRun);

  const panelEls: Record<Tab, HTMLElement> = {
    setup: setupPanel(net, {
      flyTo,
      flyToPoint: (p) => view.flyTo(p),
      inspectNode: (node) => {
        view.flyTo(net.nodePos(node), 16);
        state.selection = { node };
        state.emit('selection');
        popups.node(node);
      },
      showTab: (t) => showTab(t),
    }),
    results: resultsPanel(net, { run: () => void run(), flyToLink: (l) => view.flyTo(net.midpoint(l), 15) }),
    advanced: paramsPanel(),
    about: aboutPanel(bundle),
  };
  for (const t of tabs) {
    const [label, ic] = labels[t];
    tabBar.appendChild(h('button.tab', { type: 'button', role: 'tab', dataset: { tab: t }, 'data-testid': `tab-${t}`, 'aria-controls': `panel-${t}`, onclick: () => showTab(t) }, icon(ic, 15), h('span', label)));
    panels.appendChild(h('div.tab-panel', { role: 'tabpanel', id: `panel-${t}`, dataset: { tab: t } }, panelEls[t]));
  }
  showTab('setup');

  const sidebar = h('aside.sidebar', tabBar, panels);
  const inspector = h('aside.inspector', { 'aria-label': t('Inspector'), 'data-testid': 'inspector' });
  mountInspector(inspector);
  const banner = h('div.tool-banner', { role: 'status', hidden: true, 'data-testid': 'tool-banner' });
  const mapWrap = h('div.map-wrap', mapEl, toolRail(), banner, inspector, mapLegend());
  const main = h('main.main', mapWrap, timeline());
  loading.remove();
  app.append(topBar(net, { run: () => void run(), share, flyTo }), h('div.workspace', sidebar, main));
  view.map.resize();

  // ---- polygon drawing (rain zones) ----
  const SNAP_PX = 12;
  const drawPoints = (): [number, number][] => (state.tool.kind === 'rain-zone' ? state.tool.points : []);
  const finishZone = () => {
    let pts = drawPoints();
    // drop near-duplicates (double-click adds the same point twice)
    pts = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-5);
    if (pts.length < 3) {
      toast(t('A rain zone needs at least 3 points'), 'error');
      return;
    }
    const n = state.scenario.events.filter((e) => e.type === 'rain' && e.area).length + 1;
    state.setTool({ kind: 'select' });
    state.addEvent(newRain(quickRainProfile(DEFAULT_RAIN), lngLatToLatLon(pts), t('Rain zone {n}', { n })));
    editEvent(state.scenario.events.length - 1);
    toast(t('Rain zone added — set intensity and timing in Setup'));
  };
  const addVertex = (p: [number, number]) => {
    const pts = drawPoints();
    if (pts.length >= 3) {
      const a = view.map.project(pts[0]);
      const b = view.map.project(p);
      if (Math.hypot(a.x - b.x, a.y - b.y) < SNAP_PX) return finishZone();
    }
    state.setTool({ kind: 'rain-zone', points: [...pts, p] });
  };
  view.map.on('dblclick', (e) => {
    if (state.tool.kind !== 'rain-zone') return;
    e.preventDefault();
    finishZone();
  });

  const syncBanner = () => {
    const tool = state.tool;
    banner.hidden = tool.kind === 'select';
    if (tool.kind === 'rain-zone') view.map.doubleClickZoom.disable();
    else view.map.doubleClickZoom.enable();
    const text: Record<string, string> = {
      'add-road': tool.kind === 'add-road' && tool.fromNode !== undefined ? t('New road: click junction B') : t('New road: click junction A'),
      housing: t('Click to place {n} new residents', { n: fmt(state.build.housingPopulation) }),
      jobs: t('Click to place {n} new jobs', { n: fmt(state.build.jobs) }),
      event: t('Click the venue for {n} people ({from}–{to})', { n: fmt(state.build.eventPeople), from: state.build.eventFrom, to: state.build.eventTo }),
      'rain-zone':
        tool.kind === 'rain-zone' && tool.points.length
          ? tn(tool.points.length, '{n} point · click the first point, double-click or press Enter to finish · Backspace undoes', '{n} points · click the first point, double-click or press Enter to finish · Backspace undoes')
          : t('Draw a rain zone: click on the map to add corners'),
    };
    banner.dataset.layer = tool.kind === 'rain-zone' ? 'rain' : tool.kind === 'event' ? 'event' : 'build';
    banner.replaceChildren(
      ...[
      h('span', text[tool.kind] ?? ''),
      tool.kind === 'rain-zone' ? h('button.btn.btn-sm.btn-primary', { type: 'button', disabled: tool.points.length < 3, onclick: finishZone, 'data-testid': 'finish-zone' }, t('Finish')) : null,
      h('button.btn.btn-sm', { type: 'button', onclick: () => state.setTool({ kind: 'select' }) }, t('Cancel (Esc)')),
      ].filter((x): x is HTMLElement => !!x),
    );
    view.render();
  };
  state.on('tool', syncBanner);

  const round = (x: number) => Math.round(x * 1e5) / 1e5;
  view.onClick = (c: MapClick) => {
    const tool = state.tool;
    const latLon: [number, number] = [round(c.lngLat[1]), round(c.lngLat[0])];
    switch (tool.kind) {
      case 'select':
        if (c.kind === 'link' && c.id !== undefined) popups.link(c.id, c.lngLat);
        else if (c.kind === 'node' && c.id !== undefined) popups.node(c.id);
        else if (c.kind === 'hotspot' && c.hotspot) popups.hotspot(c.hotspot, c.lngLat);
        else if ((c.kind === 'marker' || c.kind === 'zone') && c.id !== undefined && c.id >= 0) popups.marker(c.id);
        else if (c.kind === 'accident' && c.accident) popups.accident(c.accident);
        else closePopup();
        return;
      case 'rain-zone':
        addVertex([round(c.lngLat[0]), round(c.lngLat[1])]);
        return;
      case 'add-road': {
        const node = c.kind === 'node' && c.id !== undefined ? c.id : net.nearestNode(c.lngLat[0], c.lngLat[1]);
        if (tool.fromNode === undefined) state.setTool({ kind: 'add-road', fromNode: node });
        else if (node !== tool.fromNode) popups.addRoad(tool.fromNode, node);
        return;
      }
      case 'housing':
        state.addEvent({ type: 'housing', at: latLon, population: state.build.housingPopulation });
        toast(t('Housing added (structural)'));
        break;
      case 'jobs':
        state.addEvent({ type: 'jobs', at: latLon, jobs: state.build.jobs });
        toast(t('Jobs added (structural)'));
        break;
      case 'event': {
        const b = state.build;
        if (!(parseTime(b.eventTo) > parseTime(b.eventFrom))) {
          toast(t('Event arrival window: “to” must be after “from”'), 'error');
          return;
        }
        state.addEvent({ type: 'event', destination: latLon, extra_trips: b.eventPeople, arrive_between: [b.eventFrom, b.eventTo] });
        state.setTool({ kind: 'select' });
        editEvent(state.scenario.events.length - 1);
        toast(t('Big event added'));
        return;
      }
    }
    state.setTool({ kind: 'select' });
  };

  const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void run();
      return;
    }
    if (e.key === 'Escape') {
      if (state.tool.kind !== 'select') state.setTool({ kind: 'select' });
      else closePopup();
      return;
    }
    if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (state.tool.kind === 'rain-zone') {
      if (e.key === 'Enter') {
        e.preventDefault();
        finishZone();
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        state.setTool({ kind: 'rain-zone', points: drawPoints().slice(0, -1) });
        return;
      }
    }
    const k = e.key.toLowerCase();
    if (k === 'v') startTool('select');
    else if (k === 'r') startTool('rain-zone');
    else if (k === 'e') startTool('event');
  });

  let hashTimer = 0;
  state.on('scenario', () => {
    clearTimeout(hashTimer);
    hashTimer = window.setTimeout(async () => {
      if (state.scenario.events.length === 0 && !state.scenario.parameter_overrides) {
        lastHashCode = null;
        history.replaceState(null, '', location.pathname + location.search);
      } else await share();
    }, 250);
    view.render();
  });
  window.addEventListener('hashchange', () => void scenarioFromHash());
  state.on(['time', 'view', 'result', 'selection'], () => view.render());

  state.emit('ready');
  view.render();
  setPhase('ready');
  if (fromLink) toast(t('Scenario loaded from the link — press Run simulation'));
  (window as unknown as { __app: unknown }).__app = { state, view, net };
}

main().catch((e) => {
  console.error(e);
  setPhase('error');
  loadingLabel.textContent = t('Failed to start: {e}', { e: e instanceof Error ? e.message : String(e) });
  loadingLabel.classList.add('form-error');
});
