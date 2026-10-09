import './style.css';
import { state } from './state';
import { EngineClient } from './engineClient';
import { Network } from './network';
import { MapView, type MapClick } from './map/mapView';
import type { Bundle } from './types';
import { decodeScenario, encodeScenario, scenarioCodeFromHash } from './logic/scenarioUrl';
import { parseTime } from './logic/time';
import { h } from './ui/dom';
import { closePopup, Popups, toast } from './ui/popups';
import { scenarioPanel } from './ui/scenarioPanel';
import { rainPanel } from './ui/rainPanel';
import { buildPanel } from './ui/buildPanel';
import { paramsPanel } from './ui/paramsPanel';
import { aboutPanel } from './ui/aboutPanel';
import { timeline } from './ui/timeline';
import { mapLegend } from './ui/legend';

const app = document.getElementById('app')!;
const setPhase = (s: 'loading' | 'ready' | 'running' | 'done' | 'error') => (document.body.dataset.state = s);
setPhase('loading');

const loadingLabel = h('div.loading-label', 'Loading city…');
const loadingBar = h('div.progress-bar');
const loading = h(
  'div.loading',
  { role: 'status' },
  h('div.loading-card', h('div.brand', 'Hanoi traffic what-if'), loadingLabel, h('div.progress', h('div.progress-bar-wrap', loadingBar))),
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
    toast('The scenario in the link could not be read', 'error');
    return false;
  }
}

async function main() {
  const client = new EngineClient();
  const bundleUrl = dataUrl('data/hanoi-inner.json');
  const [bundle, engine] = await Promise.all([
    fetch(bundleUrl).then((r) => {
      if (!r.ok) throw new Error(`Could not load the city bundle (${r.status}). Run “npm run prepare-data”.`);
      return r.json() as Promise<Bundle>;
    }),
    client.load(bundleUrl, dataUrl('data/routes.bin'), (stage, f) => {
      loadingLabel.textContent = `${stage}…`;
      loadingBar.style.width = `${Math.round(f * 100)}%`;
    }),
  ]);
  state.bundle = bundle;
  state.params = engine.params;
  state.baseline = engine.baseline;
  state.time = 7.5 * 3600_000;
  const fromLink = await scenarioFromHash();

  const net = new Network(bundle);
  const mapEl = h('div#map', { 'aria-label': 'Map of inner Hanoi' });
  const tabs = ['scenario', 'rain', 'build', 'params', 'about'] as const;
  type Tab = (typeof tabs)[number];
  const labels: Record<Tab, string> = { scenario: 'Scenario', rain: 'Rain', build: 'Build', params: 'Parameters', about: 'About' };
  const tabBar = h('nav.tabs', { role: 'tablist' });
  const panels = h('div.panels');
  const showTab = (t: string) => {
    tabBar.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    panels.querySelectorAll<HTMLElement>('[role=tabpanel]').forEach((p) => (p.hidden = p.dataset.tab !== t));
  };
  state.ready = true;

  const view = new MapView(mapEl, net);
  const popups = new Popups(view, net);
  const flyTo = (i: number) => {
    const ev = state.scenario.events[i];
    const p = ev && net.eventLocation(ev);
    if (p) view.flyTo(p);
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
    } catch (e) {
      state.run = { running: false, stage: '', fraction: 0, error: e instanceof Error ? e.message : String(e) };
      setPhase('error');
      state.emit('run');
    }
  };

  const panelEls: Record<Tab, HTMLElement> = {
    scenario: scenarioPanel(net, { run, share, flyTo, showTab }),
    rain: rainPanel(bundle.rain_presets),
    build: buildPanel(),
    params: paramsPanel(),
    about: aboutPanel(bundle),
  };
  for (const t of tabs) {
    tabBar.appendChild(h('button.tab', { type: 'button', role: 'tab', dataset: { tab: t }, 'aria-controls': `panel-${t}`, onclick: () => showTab(t) }, labels[t]));
    panels.appendChild(h('div', { role: 'tabpanel', id: `panel-${t}`, dataset: { tab: t } }, panelEls[t]));
  }
  showTab('scenario');

  const sidebar = h(
    'aside.sidebar',
    h('header.brand-bar', h('div.brand', 'Hanoi traffic what-if'), h('div.brand-sub', 'Morning peak sandbox · inner Hanoi')),
    tabBar,
    panels,
  );
  const mapWrap = h('div.map-wrap', mapEl, mapLegend(), h('div.tool-banner', { hidden: true }));
  const main = h('main.main', mapWrap, timeline());
  loading.remove();
  app.append(sidebar, main);
  view.map.resize();

  const banner = mapWrap.querySelector<HTMLElement>('.tool-banner')!;
  state.on('tool', () => {
    const t = state.tool;
    banner.hidden = t.kind === 'select';
    const text: Record<string, string> = {
      'add-road': t.kind === 'add-road' && t.fromNode !== undefined ? 'New road: click junction B' : 'New road: click junction A',
      housing: `Click to place ${state.build.housingPopulation.toLocaleString()} new residents`,
      jobs: `Click to place ${state.build.jobs.toLocaleString()} new jobs`,
      event: `Click the venue for ${state.build.eventPeople.toLocaleString()} people`,
    };
    banner.replaceChildren(h('span', text[t.kind] ?? ''), h('button.btn.btn-sm', { type: 'button', onclick: () => state.setTool({ kind: 'select' }) }, 'Cancel (Esc)'));
    view.render();
  });

  const round = (x: number) => Math.round(x * 1e5) / 1e5;
  view.onClick = (c: MapClick) => {
    const t = state.tool;
    const latLon: [number, number] = [round(c.lngLat[1]), round(c.lngLat[0])];
    switch (t.kind) {
      case 'select':
        if (c.kind === 'link' && c.id !== undefined) popups.link(c.id, c.lngLat);
        else if (c.kind === 'node' && c.id !== undefined) popups.node(c.id);
        else if (c.kind === 'hotspot' && c.hotspot) popups.hotspot(c.hotspot, c.lngLat);
        else if (c.kind === 'marker' && c.id !== undefined && c.id >= 0) popups.marker(c.id, c.lngLat);
        else {
          closePopup();
          state.selection = {};
          state.emit('selection');
        }
        return;
      case 'add-road': {
        const node = c.kind === 'node' && c.id !== undefined ? c.id : net.nearestNode(c.lngLat[0], c.lngLat[1]);
        if (t.fromNode === undefined) state.setTool({ kind: 'add-road', fromNode: node });
        else if (node !== t.fromNode) popups.addRoad(t.fromNode, node);
        return;
      }
      case 'housing':
        state.addEvent({ type: 'housing', at: latLon, population: state.build.housingPopulation });
        toast('Housing added (structural)');
        break;
      case 'jobs':
        state.addEvent({ type: 'jobs', at: latLon, jobs: state.build.jobs });
        toast('Jobs added (structural)');
        break;
      case 'event': {
        const b = state.build;
        if (!(parseTime(b.eventTo) > parseTime(b.eventFrom))) {
          toast('Event arrival window: “to” must be after “from”', 'error');
          return;
        }
        state.addEvent({ type: 'event', destination: latLon, extra_trips: b.eventPeople, arrive_between: [b.eventFrom, b.eventTo] });
        toast('Big event added');
        break;
      }
    }
    state.setTool({ kind: 'select' });
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePopup();
      if (state.tool.kind !== 'select') state.setTool({ kind: 'select' });
    }
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
  if (fromLink) toast('Scenario loaded from the link — press Run to simulate it');
  (window as unknown as { __app: unknown }).__app = { state, view, net };
}

main().catch((e) => {
  console.error(e);
  setPhase('error');
  loadingLabel.textContent = `Failed to start: ${e instanceof Error ? e.message : e}`;
  loadingLabel.classList.add('form-error');
});
