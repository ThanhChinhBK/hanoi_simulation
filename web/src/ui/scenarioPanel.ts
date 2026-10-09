import { state, isStructuralParam } from '../state';
import type { Network } from '../network';
import type { Scenario, Summary } from '../types';
import { clear, fmt, h, icon, pct, signed } from './dom';
import { toast } from './popups';

export interface ScenarioPanelHooks {
  run: () => void;
  share: () => Promise<string>;
  flyTo: (index: number) => void;
  showTab: (tab: string) => void;
}

interface PresetEntry {
  id: string;
  file: string;
  name: string;
}

export function scenarioPanel(net: Network, hooks: ScenarioPanelHooks): HTMLElement {
  const presetSelect = h('select', { 'aria-label': 'Example scenarios', 'data-testid': 'preset-select' }, h('option', { value: '' }, 'Load an example scenario…'));
  fetch(new URL('scenarios/index.json', document.baseURI))
    .then((r) => r.json() as Promise<PresetEntry[]>)
    .then((list) => list.forEach((p) => presetSelect.appendChild(h('option', { value: p.file }, p.name))))
    .catch(() => presetSelect.appendChild(h('option', { disabled: true }, '(examples unavailable)')));
  presetSelect.addEventListener('change', async () => {
    if (!presetSelect.value) return;
    try {
      const s = (await (await fetch(new URL(`scenarios/${presetSelect.value}`, document.baseURI))).json()) as Scenario;
      state.setScenario({ ...s, events: s.events ?? [] });
      const first = state.scenario.events.findIndex((e) => net.eventLocation(e));
      if (first >= 0) hooks.flyTo(first);
      toast(`Loaded “${s.name ?? presetSelect.value}”`);
    } catch (e) {
      toast(`Could not load example: ${e}`, 'error');
    }
    presetSelect.value = '';
  });

  const nameInput = h('input', { type: 'text', placeholder: 'Untitled scenario', 'aria-label': 'Scenario name' });
  nameInput.addEventListener('change', () => {
    state.scenario = { ...state.scenario, name: nameInput.value || undefined };
    state.emit('scenario');
  });

  const description = h('p.hint.scenario-desc');
  const list = h('ul.event-list', { 'data-testid': 'event-list' });
  const overrides = h('div.overrides');
  const modeHint = h('p.hint');
  const runBtn = h('button.btn.btn-primary.btn-run', { type: 'button', 'data-testid': 'run', onclick: () => hooks.run() }, icon('run'), h('span', 'Run scenario'));
  const shareBtn = h(
    'button.btn',
    {
      type: 'button',
      title: 'Copy a link to this scenario',
      onclick: async () => {
        const url = await hooks.share();
        try {
          await navigator.clipboard.writeText(url);
          toast('Link copied to clipboard');
        } catch {
          toast('Link is in the address bar');
        }
      },
    },
    icon('share'),
    h('span', 'Share'),
  );
  const clearBtn = h(
    'button.btn',
    {
      type: 'button',
      title: 'Remove all events and parameter changes',
      onclick: () => {
        state.setScenario({ events: [] });
      },
    },
    icon('trash'),
    h('span', 'Clear'),
  );
  const progress = h('div.progress', { hidden: true }, h('div.progress-bar'), h('div.progress-label'));
  const result = h('div.result-slot');

  const renderScenario = () => {
    nameInput.value = state.scenario.name ?? '';
    description.textContent = state.scenario.description ?? '';
    description.hidden = !state.scenario.description;
    clear(list);
    if (state.scenario.events.length === 0) {
      list.appendChild(h('li.empty', 'No changes yet. Load an example, click a road or junction on the map, draw rain in the Rain tab, or use the Build tools.'));
    }
    state.scenario.events.forEach((ev, i) => {
      const d = net.describe(ev);
      list.appendChild(
        h(
          'li.event',
          h('span.event-dot', { class: `ev-${ev.type}` }),
          h('div.event-body', h('div.event-title', d.title, d.structural ? h('span.badge.badge-structural', 'structural') : null), h('div.event-detail', d.detail)),
          net.eventLocation(ev) ? h('button.icon-btn', { type: 'button', title: 'Show on map', 'aria-label': 'Show on map', onclick: () => hooks.flyTo(i) }, icon('zoom')) : null,
          h('button.icon-btn', { type: 'button', title: 'Remove', 'aria-label': `Remove ${d.title}`, onclick: () => state.removeEvent(i) }, icon('trash')),
        ),
      );
    });
    clear(overrides);
    const o = Object.entries(state.scenario.parameter_overrides ?? {});
    if (o.length) {
      overrides.appendChild(
        h(
          'div.override-box',
          h('div.event-title', `${o.length} parameter${o.length > 1 ? 's' : ''} changed`),
          h('div.event-detail', o.map(([k, v]) => `${k} = ${v}`).join(' · ')),
          h('button.link-btn', { type: 'button', onclick: () => hooks.showTab('params') }, 'Edit parameters'),
        ),
      );
    }
    const structural = state.scenario.events.some((e) => net.describe(e).structural) || o.some(([k]) => isStructuralParam(k));
    modeHint.textContent = structural
      ? 'Structural change: demand is re-planned and compared with a “control” re-run of the baseline (first time adds ~10 s).'
      : state.scenario.events.length
        ? 'Sudden change: same trips as the baseline; drivers react en route. Compared with the baseline.'
        : '';
    renderRun();
  };

  const renderRun = () => {
    const r = state.run;
    runBtn.disabled = !state.ready || r.running;
    (runBtn.lastChild as HTMLElement).textContent = r.running ? 'Running…' : state.stale ? 'Re-run scenario' : 'Run scenario';
    runBtn.classList.toggle('pulse', state.ready && !r.running && (state.stale || (!state.result && state.scenario.events.length > 0)));
    progress.hidden = !r.running;
    (progress.firstChild as HTMLElement).style.width = `${Math.round(r.fraction * 100)}%`;
    (progress.lastChild as HTMLElement).textContent = `${r.stage} ${Math.round(r.fraction * 100)}%`;
    clear(result);
    if (r.error) result.appendChild(h('div.card.card-error', { role: 'alert' }, h('div.card-title', 'Run failed'), h('div', r.error)));
    else if (state.result && state.reference) result.appendChild(resultCard(state.result.meta.summary, state.reference.meta.summary, state.result.meta.reference));
  };

  state.on(['scenario', 'ready'], renderScenario);
  state.on(['run', 'result'], renderRun);
  renderScenario();

  return h(
    'section.panel',
    h(
      'div.disclaimer',
      h('strong', 'What-if sandbox. '),
      'Results come from a simplified model with synthetic demand (a 5% sample of estimated trips). Read them as qualitative, comparative indications — not forecasts.',
    ),
    h('div.panel-row', presetSelect),
    field('Scenario', nameInput),
    description,
    h('h3.section-title', 'Changes'),
    list,
    overrides,
    modeHint,
    h('div.run-row', runBtn, shareBtn, clearBtn),
    progress,
    result,
  );
}

function field(label: string, input: HTMLElement) {
  return h('label.field', h('span.field-label', label), input);
}

function resultCard(s: Summary, r: Summary, reference: string): HTMLElement {
  const delayPct = pct(s.total_delay_veh_h, r.total_delay_veh_h);
  const tripPct = pct(s.mean_trip_min, r.mean_trip_min);
  const cls = (x: number) => (Math.abs(x) < 1 ? 'neutral' : x > 0 ? 'worse' : 'better');
  const metric = (label: string, value: string, delta: string, deltaCls: string, testid?: string) =>
    h('div.metric', h('div.metric-label', label), h('div.metric-value', value), h('div.metric-delta', { class: deltaCls, 'data-testid': testid }, delta));
  const sf = s.sample_fraction || 1;
  const rows: [string, number, number][] = [
    ['Trips cancelled (rain)', s.trips_cancelled, r.trips_cancelled],
    ['Trips postponed (rain)', s.trips_delayed, r.trips_delayed],
    ['Trips aborted (blocked)', s.aborted, r.aborted],
    ['Not arrived by 12:00', s.unfinished, r.unfinished],
    ['En-route reroutes', s.reroutes, r.reroutes],
    ['Unroutable trips', s.trips_unroutable, r.trips_unroutable],
    ['Event trips', s.event_trips, r.event_trips],
  ];
  return h(
    'div.card.result-card',
    { 'data-testid': 'result-card' },
    h(
      'div.card-head',
      h('div.card-title', 'Result'),
      h('span.badge', s.mode),
      h('span.badge.badge-ref', `vs ${reference}`),
      state.stale ? h('span.badge.badge-warn', 'outdated — re-run') : null,
    ),
    h(
      'div.metrics',
      metric('Total delay', `${fmt(s.total_delay_veh_h / 1000, 1)}k veh·h`, `${signed(delayPct)}% vs ${reference}`, cls(delayPct), 'delay-pct'),
      metric('Mean trip time', `${fmt(s.mean_trip_min, 1)} min`, `${signed(s.mean_trip_min - r.mean_trip_min)} min (${signed(tripPct)}%)`, cls(tripPct)),
    ),
    h(
      'table.stats',
      h('tbody', [
        ...rows
          .filter(([, a, b]) => a !== 0 || b !== 0)
          .map(([label, a, b]) => h('tr', h('th', label), h('td', fmt(a / sf)), h('td.muted', a === b ? '' : signed((a - b) / sf, 0)))),
        s.flooded_links_max ? h('tr', h('th', 'Flooded road links (max)'), h('td', fmt(s.flooded_links_max)), h('td')) : null,
      ]),
    ),
    h('p.hint', `Counts are scaled from the ${fmt(sf * 100)}% vehicle sample. Delay = time lost vs free flow, summed over vehicles, 05:30–12:00.`),
    s.warnings.length ? h('ul.warnings', s.warnings.map((w) => h('li', w))) : null,
  );
}
