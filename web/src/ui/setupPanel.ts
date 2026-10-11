import { state, isStructuralScenario, type Tool } from '../state';
import type { Network } from '../network';
import type { FloodModel, RainPoint, RainPreset, ScenarioEvent } from '../types';
import type { LngLat } from '../logic/trips';
import { quickRainFromProfile, quickRainProfile, type QuickRain } from '../logic/quickRain';
import { greensToPlan, planToGreens } from '../logic/signals';
import { rainWord } from '../logic/zones';
import { formatTime, parseTime } from '../logic/time';
import { clear, fmt, h, icon } from './dom';
import { field, itemCard, numberInput, section, segmented, slider, timeInput, type SectionHandle } from './kit';
import { profileChart } from './profileChart';
import { ROAD_CLASSES } from './popups';
import { roadClassName } from '../logic/roadClass';
import { t, tn } from '../i18n';

export interface SetupHooks {
  flyTo: (index: number) => void;
  flyToPoint: (p: LngLat) => void;
  inspectNode: (node: number) => void;
  showTab: (tab: string) => void;
}

type Ev<T extends ScenarioEvent['type']> = Extract<ScenarioEvent, { type: T }>;
type Indexed<T extends ScenarioEvent['type']> = { ev: Ev<T>; i: number };

const FLOOD_MODELS: { value: FloodModel; label: string; title: string }[] = [
  { value: 'none', label: t('No flooding'), title: t('Rain only slows traffic (wet-road speed and capacity).') },
  { value: 'hotspots', label: t('Flood points'), title: t('Known flood points flood when rain is heavy enough.') },
  { value: 'bucket', label: t('Drainage model'), title: t('Each drainage catchment fills when rain exceeds drainage; low roads flood.') },
];

const EXTRA_PRESETS: RainPreset[] = [
  {
    id: 'thunderstorm-rush-80',
    label: '80 mm/h thunderstorm at rush hour',
    description: 'Synthetic: 1 h of 80 mm/h at 7:30, with lighter rain around it.',
    source: 'assumption',
    confidence: 'low',
    profile: [
      { at: '07:00', mm_per_hour: 15 },
      { at: '07:30', mm_per_hour: 80 },
      { at: '08:30', mm_per_hour: 10 },
      { at: '09:30', mm_per_hour: 0 },
    ],
  },
];

const SEVERITY = [
  { value: 0.7, label: t('Minor'), title: t('Fender-bender on the shoulder: 70% of capacity left') },
  { value: 0.4, label: t('Lane blocked'), title: t('One lane blocked: 40% of capacity left') },
  { value: 0.1, label: t('Road blocked'), title: t('Almost blocked: 10% of capacity left') },
];

export const DEFAULT_RAIN: QuickRain = { intensity: 50, startMs: 7.5 * 3600_000, durationMin: 60 };

function indexed<T extends ScenarioEvent['type']>(...types: T[]): Indexed<T>[] {
  const out: Indexed<T>[] = [];
  state.scenario.events.forEach((ev, i) => {
    if ((types as string[]).includes(ev.type)) out.push({ ev: ev as Ev<T>, i });
  });
  return out;
}

export function currentFloodModel(): FloodModel {
  return indexed('rain')[0]?.ev.flood_model ?? 'hotspots';
}

/** A new rain event (citywide or in an area) using the scenario's flood model. */
export function newRain(profile: RainPoint[], area?: [number, number][], label?: string): Ev<'rain'> {
  const ev: Ev<'rain'> = { type: 'rain', profile, flood_model: currentFloodModel() };
  if (area) ev.area = area;
  if (label) ev.label = label;
  return ev;
}

export function setupPanel(net: Network, hooks: SetupHooks): HTMLElement {
  const customOpen = new Set<number>();
  const fly = (i: number) => (net.eventLocation(state.scenario.events[i]) ? () => hooks.flyTo(i) : undefined);
  const remove = (i: number) => () => state.removeEvent(i);
  const toolBtn = (kind: Tool['kind'], label: string, ic: string, testid: string) => {
    const b = h('button.btn.btn-sm', { type: 'button', dataset: { tool: kind }, 'data-testid': testid, onclick: () => state.setTool(state.tool.kind === kind ? { kind: 'select' } : kind === 'rain-zone' ? { kind, points: [] } : ({ kind } as Tool)) }, icon(ic, 15), h('span', label));
    state.on('tool', () => b.setAttribute('aria-pressed', String(state.tool.kind === kind)));
    return b;
  };

  // ------------------------------------------------------------ weather
  const rainList = h('ul.items', { 'data-testid': 'rain-list' });
  const floodSlot = h('div');
  const presetSel = h('select', { 'aria-label': t('Add a historic storm') }, h('option', { value: '' }, t('Add a historic storm…')));
  const presets = [...state.bundle.rain_presets, ...EXTRA_PRESETS.filter((p) => !state.bundle.rain_presets.some((q) => q.id === p.id))];
  presets.forEach((p) => presetSel.appendChild(h('option', { value: p.id }, t('{label} · peak {peak} mm/h', { label: t(p.label), peak: fmt(Math.max(...p.profile.map((x) => x.mm_per_hour))) }))));
  presetSel.addEventListener('change', () => {
    const p = presets.find((x) => x.id === presetSel.value);
    presetSel.value = '';
    if (!p) return;
    state.addEvent(newRain(p.profile, undefined, t(p.label)));
    state.focusEvent(state.scenario.events.length - 1);
  });
  const weather = section(
    { id: 'weather', title: t('Weather & flooding'), subtitle: t('Where and when it rains'), icon: 'rain', layer: 'rain', open: true },
    h('p.hint', t('Draw a rain zone on the map, or let it rain over the whole city. Zones may overlap — the heaviest rain applies.')),
    h(
      'div.btn-row',
      toolBtn('rain-zone', t('Draw rain zone'), 'polygon', 'draw-rain-zone'),
      h(
        'button.btn.btn-sm',
        {
          type: 'button',
          'data-testid': 'add-citywide-rain',
          onclick: () => {
            state.addEvent(newRain(quickRainProfile(DEFAULT_RAIN)));
            state.focusEvent(state.scenario.events.length - 1);
          },
        },
        icon('plus', 15),
        h('span', t('Citywide rain')),
      ),
    ),
    presetSel,
    rainList,
    floodSlot,
  );

  const rainCard = ({ ev, i }: Indexed<'rain'>) => {
    const q = quickRainFromProfile(ev.profile);
    const set = (patch: Partial<Ev<'rain'>>) => state.updateEvent(i, { ...ev, ...patch });
    const setQ = (patch: Partial<QuickRain>) => set({ profile: quickRainProfile({ ...(q ?? DEFAULT_RAIN), ...patch }) });
    const name = h('input.inline-name', { type: 'text', value: ev.label ?? '', placeholder: ev.area ? t('Rain zone') : t('Citywide rain'), 'aria-label': t('Rain name'), maxLength: 60 });
    name.addEventListener('change', () => {
      const e = { ...ev };
      if (name.value.trim()) e.label = name.value.trim();
      else delete e.label;
      state.updateEvent(i, e);
    });
    const showCustom = customOpen.has(i) || !q;
    const d = net.describe(ev);
    return itemCard(
      { layer: 'rain', index: i, title: d.title, detail: d.detail, onFly: fly(i), onRemove: remove(i), testid: 'rain-item' },
      field(t('Name'), name),
      q && !customOpen.has(i)
        ? h(
            'div.sliders',
            slider({ label: t('Intensity'), min: 5, max: 150, step: 5, value: q.intensity, format: (v) => `${v} mm/h · ${rainWord(v)}`, onCommit: (v) => setQ({ intensity: v }), testid: 'rain-intensity' }),
            slider({ label: t('Starts'), min: 5 * 60, max: 11 * 60, step: 15, value: q.startMs / 60_000, format: (v) => formatTime(v * 60_000), onCommit: (v) => setQ({ startMs: v * 60_000 }) }),
            slider({ label: t('Lasts'), min: 15, max: 300, step: 15, value: q.durationMin, format: (v) => t('{n} min', { n: v }), onCommit: (v) => setQ({ durationMin: v }) }),
          )
        : null,
      showCustom ? profileChart(ev.profile, (p) => (p.length ? set({ profile: p }) : state.removeEvent(i))) : null,
      h(
        'button.link-btn',
        {
          type: 'button',
          onclick: () => {
            if (customOpen.has(i)) customOpen.delete(i);
            else customOpen.add(i);
            renderAll();
          },
          hidden: !q,
        },
        customOpen.has(i) ? t('Simple controls') : t('Custom profile over time'),
      ),
    );
  };

  const renderWeather = () => {
    const rains = indexed('rain');
    clear(rainList);
    rains.forEach((r) => rainList.appendChild(rainCard(r)));
    if (!rains.length) rainList.appendChild(h('li.empty', t('No rain. The morning is dry.')));
    weather.setCount(rains.length);
    const model = currentFloodModel();
    floodSlot.replaceChildren(
      rains.length
        ? h(
            'div.field',
            h('span.field-label', t('Flooding (all rain)')),
            segmented(t('Flood model'), FLOOD_MODELS, model, (m) => {
              state.setScenario({ ...state.scenario, events: state.scenario.events.map((e) => (e.type === 'rain' ? { ...e, flood_model: m } : e)) });
            }, 'flood-model'),
            h('span.hint', FLOOD_MODELS.find((m) => m.value === model)?.title ?? ''),
          )
        : '',
    );
  };

  // ------------------------------------------------------------ signals
  const signalList = h('ul.items', { 'data-testid': 'signal-list' });
  const cycleSlot = h('div');
  const lost = () => state.paramValue('signal.lost_time_s') || 0;
  const junctions = h('datalist#junctions');
  const junctionSearch = h('input.search', { type: 'search', placeholder: t('Find a signalised junction by street…'), list: 'junctions', 'aria-label': t('Find junction'), 'data-testid': 'junction-search' });
  junctionSearch.addEventListener('change', () => {
    const m = /#(\d+)\s*$/.exec(junctionSearch.value);
    if (!m) return;
    junctionSearch.value = '';
    hooks.inspectNode(Number(m[1]));
  });
  const fillJunctions = () => {
    clear(junctions);
    const seen = new Set<string>();
    for (const n of state.signalPlans.keys()) {
      const name = net.nodeName(n);
      if (name.startsWith('node ') || seen.has(name)) continue;
      seen.add(name);
      junctions.appendChild(h('option', { value: `${name} · #${n}` }));
    }
  };
  const signals = section(
    { id: 'signals', title: t('Traffic signals'), subtitle: t('Green time at junctions'), icon: 'signal', layer: 'signal' },
    cycleSlot,
    h('p.hint', t('Click a junction on the map, or search for one, to change how long each direction gets green.')),
    junctionSearch,
    junctions,
    signalList,
  );

  const signalCard = ({ ev, i }: Indexed<'signal'>) => {
    const g = planToGreens(ev.cycle_s, ev.green_split, lost());
    const def = state.signalPlans.get(ev.node);
    const dg = def ? planToGreens(def.cycle_s, def.green_split, lost()) : null;
    const set = (ns: number, ew: number) => state.updateEvent(i, { ...ev, ...greensToPlan({ ns, ew }, lost()) });
    return itemCard(
      {
        layer: 'signal',
        index: i,
        title: net.nodeName(ev.node),
        detail: dg ? t('cycle {c} s · was NS {ns} s / EW {ew} s', { c: fmt(ev.cycle_s), ns: dg.ns, ew: dg.ew }) : t('cycle {c} s · new signal', { c: fmt(ev.cycle_s) }),
        onFly: fly(i),
        onRemove: remove(i),
        removeLabel: t('Revert'),
        testid: 'signal-item',
      },
      h(
        'div.row',
        field(t('North–south green'), h('div.unit-input', numberInput(g.ns, 5, 200, 1, (v) => set(v, g.ew), t('North–south green seconds'), 'green-ns'), h('span.unit', 's'))),
        field(t('East–west green'), h('div.unit-input', numberInput(g.ew, 5, 200, 1, (v) => set(g.ns, v), t('East–west green seconds'), 'green-ew'), h('span.unit', 's'))),
      ),
    );
  };

  const renderSignals = () => {
    const list = indexed('signal');
    clear(signalList);
    list.forEach((s) => signalList.appendChild(signalCard(s)));
    signals.setCount(list.length);
    const cycle = state.paramValue('signal.cycle_s');
    cycleSlot.replaceChildren(
      slider({
        label: t('Default cycle'),
        min: 40,
        max: 240,
        step: 5,
        value: cycle,
        format: (v) => `${v} s${state.scenario.parameter_overrides?.['signal.cycle_s'] !== undefined ? '' : ` ${t('(default)')}`}`,
        onCommit: (v) => state.setOverride('signal.cycle_s', v),
        testid: 'signal-cycle',
      }),
      h('p.hint', t('Applies to every signalised junction you have not edited ({n} in the network). {lost} s per cycle are lost to amber and clearance.', { n: fmt(state.signalPlans.size), lost: fmt(lost()) })),
    );
  };

  // ------------------------------------------------------------ events
  const eventList = h('ul.items', { 'data-testid': 'event-items' });
  const b = state.build;
  const events = section(
    { id: 'events', title: t('Events'), subtitle: t('Concerts, matches, festivals'), icon: 'users', layer: 'event' },
    h('p.hint', t('Extra people travel to a venue and arrive within a time window.')),
    h(
      'div.row',
      field(t('People'), numberInput(b.eventPeople, 100, 200000, 1000, (v) => (b.eventPeople = v), t('People'))),
      field(t('Arrive from'), timeInput(b.eventFrom, (v) => (b.eventFrom = v), t('Arrive from'))),
      field(t('to'), timeInput(b.eventTo, (v) => (b.eventTo = v), t('Arrive until'))),
    ),
    h('div.btn-row', toolBtn('event', t('Place event on map'), 'pin', 'place-event')),
    eventList,
  );
  const eventCard = ({ ev, i }: Indexed<'event'>) => {
    const set = (patch: Partial<Ev<'event'>>) => {
      const next = { ...ev, ...patch };
      if (!(parseTime(next.arrive_between[1]) > parseTime(next.arrive_between[0]))) return;
      state.updateEvent(i, next);
    };
    return itemCard(
      { layer: 'event', index: i, title: t('Big event'), detail: net.describe(ev).detail, onFly: fly(i), onRemove: remove(i), testid: 'event-item' },
      h(
        'div.row',
        field(t('People'), numberInput(ev.extra_trips, 100, 200000, 1000, (v) => set({ extra_trips: v }), t('People'))),
        field(t('From'), timeInput(ev.arrive_between[0], (v) => set({ arrive_between: [v, ev.arrive_between[1]] }), t('Arrive from'))),
        field(t('To'), timeInput(ev.arrive_between[1], (v) => set({ arrive_between: [ev.arrive_between[0], v] }), t('Arrive until'))),
      ),
    );
  };
  const renderEvents = () => {
    const list = indexed('event');
    clear(eventList);
    list.forEach((e) => eventList.appendChild(eventCard(e)));
    events.setCount(list.length);
  };

  // ------------------------------------------------------------ accidents & incidents
  const accSlot = h('div.acc');
  const incidentList = h('ul.items', { 'data-testid': 'incident-list' });
  const accidents = section(
    { id: 'accidents', title: t('Accidents & incidents'), subtitle: t('Random crashes, blocked roads'), icon: 'alert', layer: 'accident' },
    accSlot,
    h('h4.sub-title', t('Incidents & closures')),
    h('p.hint', t('Click a road on the map to add an incident (temporary capacity loss) or a closure.')),
    incidentList,
  );
  const renderAccidents = () => {
    const acc = indexed('accidents')[0];
    const on = h('input', { type: 'checkbox', checked: !!acc, 'data-testid': 'accidents-toggle' });
    on.addEventListener('change', () => {
      if (on.checked) state.addEvent({ type: 'accidents', per_hour: 4, duration_min: 45, capacity_factor: 0.4, from: '06:00', to: '10:00' });
      else if (acc) state.removeEvent(acc.i);
    });
    const parts: (Node | null)[] = [h('label.check.strong', on, ` ${t('Random accidents on main roads')}`)];
    if (acc) {
      const { ev, i } = acc;
      const set = (patch: Partial<Ev<'accidents'>>) => state.updateEvent(i, { ...ev, ...patch });
      const hours = Math.max(0, (parseTime(ev.to ?? '10:00') - parseTime(ev.from ?? '06:00')) / 3600_000);
      const mult = state.paramValue('accidents.rain_multiplier');
      parts.push(
        slider({ label: t('Rate'), min: 0.5, max: 30, step: 0.5, value: ev.per_hour, format: (v) => t('{n} / hour', { n: fmt(v, 1) }), onCommit: (v) => set({ per_hour: v }), testid: 'accidents-rate' }),
        slider({ label: t('Blocks for'), min: 10, max: 180, step: 5, value: ev.duration_min ?? 45, format: (v) => t('{n} min', { n: v }), onCommit: (v) => set({ duration_min: v }) }),
        h('div.field', h('span.field-label', t('Severity')), segmented(t('Severity'), SEVERITY, ev.capacity_factor ?? 0.4, (v) => set({ capacity_factor: v }))),
        h(
          'div.row',
          field(t('Between'), timeInput(ev.from ?? '06:00', (v) => parseTime(v) < parseTime(ev.to ?? '10:00') && set({ from: v }), t('Accidents from'))),
          field(t('and'), timeInput(ev.to ?? '10:00', (v) => parseTime(v) > parseTime(ev.from ?? '06:00') && set({ to: v }), t('Accidents until'))),
        ),
        slider({ label: t('In heavy rain'), min: 1, max: 5, step: 0.1, value: mult, format: (v) => t('×{n} more likely', { n: fmt(v, 1) }), onCommit: (v) => state.setOverride('accidents.rain_multiplier', v) }),
        h('p.hint', t('≈ {n} accidents expected (more where it rains). Where and when they happen is drawn at random but is the same on every run; they show as red dots on the map after the run.', { n: fmt(ev.per_hour * hours, 0) })),
      );
    }
    accSlot.replaceChildren(...parts.filter((x): x is Node => !!x));
    const list = indexed('incident', 'closure');
    clear(incidentList);
    list.forEach(({ ev, i }) => {
      const d = net.describe(ev);
      incidentList.appendChild(itemCard({ layer: 'accident', index: i, title: d.title, detail: d.detail, onFly: fly(i), onRemove: remove(i) }));
    });
    accidents.setCount(list.length + (acc ? 1 : 0));
  };

  // ------------------------------------------------------------ road works & growth
  const buildList = h('ul.items', { 'data-testid': 'build-list' });
  const popSlot = h('div');
  const cls = h('select', { 'aria-label': t('Road class') }, ROAD_CLASSES.map((c) => h('option', { value: c, selected: c === b.roadClass }, roadClassName(c))));
  cls.addEventListener('change', () => (b.roadClass = cls.value));
  const build = section(
    { id: 'build', title: t('Road works & city growth'), subtitle: t('New roads, housing, jobs'), icon: 'build', layer: 'build', badge: t('structural') },
    h('p.hint', t('These change where people live, work and drive, so trips are re-planned (slower run, compared with a control run). Click a road on the map to remove or modify it.')),
    h('div.btn-row', toolBtn('add-road', t('New road'), 'road', 'tool-add-road'), toolBtn('housing', t('Housing'), 'home', 'tool-housing'), toolBtn('jobs', t('Jobs'), 'briefcase', 'tool-jobs')),
    h(
      'div.row',
      field(t('New road class'), cls),
      field(t('Lanes'), numberInput(b.lanes, 1, 6, 1, (v) => (b.lanes = v), t('Lanes per direction'))),
      field(t('Residents'), numberInput(b.housingPopulation, 100, 500000, 1000, (v) => (b.housingPopulation = v), t('Residents'))),
      field(t('Jobs'), numberInput(b.jobs, 100, 500000, 1000, (v) => (b.jobs = v), t('Jobs'))),
    ),
    buildList,
    popSlot,
  );
  const renderBuild = () => {
    const list = indexed('add_road', 'remove_road', 'modify_road', 'housing', 'jobs');
    clear(buildList);
    list.forEach(({ ev, i }) => {
      const d = net.describe(ev);
      buildList.appendChild(itemCard({ layer: 'build', index: i, title: d.title, detail: d.detail, onFly: fly(i), onRemove: remove(i), testid: 'build-item' }));
    });
    const pop = state.paramValue('population.scale');
    popSlot.replaceChildren(
      slider({ label: t('Population'), min: 0.5, max: 2, step: 0.05, value: pop, format: (v) => `×${fmt(v, 2)} (${v >= 1 ? '+' : '−'}${fmt(Math.abs(v - 1) * 100)}%)`, onCommit: (v) => state.setOverride('population.scale', v), testid: 'population-scale' }),
    );
    build.setCount(list.length + (state.scenario.parameter_overrides?.['population.scale'] !== undefined ? 1 : 0));
  };

  // ------------------------------------------------------------ footer
  const footer = h('div.setup-footer');
  const SHOWN = new Set(['signal.cycle_s', 'accidents.rain_multiplier', 'population.scale']);
  const renderFooter = () => {
    const structural = isStructuralScenario(net);
    const empty = !state.scenario.events.length && !state.scenario.parameter_overrides;
    const other = Object.entries(state.scenario.parameter_overrides ?? {}).filter(([k]) => !SHOWN.has(k));
    footer.replaceChildren(
      ...[
        other.length
          ? h(
              'div.note',
              icon('sliders', 15),
              h('span', `${tn(other.length, '{n} advanced parameter changed:', '{n} advanced parameters changed:')} ${other.map(([k, v]) => `${k} = ${v}`).join(', ')} `, h('button.link-btn', { type: 'button', onclick: () => hooks.showTab('advanced') }, t('Edit'))),
            )
          : null,
        empty
          ? h('p.hint', t('Nothing changed yet — the map shows the baseline morning. Set up the scenario above, then press Run simulation.'))
          : h(
              'div.note',
              { dataset: { mode: structural ? 'structural' : 'sudden' } },
              icon('info', 15),
              h(
                'span',
                structural
                  ? t('Structural scenario: trips are re-planned and compared with a control run of the baseline (the first run takes a little longer).')
                  : t('Sudden scenario: same trips as the baseline, drivers react en route. Compared with the baseline.'),
              ),
            ),
      ].filter((x): x is HTMLDivElement | HTMLParagraphElement => !!x),
    );
  };

  const sections: Record<string, SectionHandle> = { rain: weather, signal: signals, event: events, accidents: accidents, incident: accidents, closure: accidents };
  const renderAll = () => {
    if (!state.ready) return;
    renderWeather();
    renderSignals();
    renderEvents();
    renderAccidents();
    renderBuild();
    renderFooter();
  };
  state.on(['scenario', 'ready'], renderAll);
  state.on('ready', fillJunctions);
  state.on('focus', () => {
    const i = state.focus;
    const ev = i !== undefined ? state.scenario.events[i] : undefined;
    if (!ev) return;
    (sections[ev.type] ?? build).open();
    requestAnimationFrame(() => {
      const el = (sections[ev.type] ?? build).el.querySelector<HTMLElement>(`li.item[data-index="${i}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1200);
    });
  });
  renderAll();
  fillJunctions();

  return h('section.panel.setup', weather.el, signals.el, events.el, accidents.el, build.el, footer);
}
