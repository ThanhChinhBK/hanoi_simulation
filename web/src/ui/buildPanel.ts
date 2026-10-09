import { state, type Tool } from '../state';
import { clear, fmt, h, icon } from './dom';
import { ROAD_CLASSES } from './popups';

const TOOLS: { kind: Tool['kind']; label: string; icon: string; hint: string }[] = [
  { kind: 'select', label: 'Inspect / edit', icon: 'pointer', hint: 'Click a road to add an incident, closure, removal or change; click a junction to edit its signal.' },
  { kind: 'add-road', label: 'Add road', icon: 'road', hint: 'Click junction A, then junction B. The new road is a straight line between them.' },
  { kind: 'housing', label: 'Add housing', icon: 'home', hint: 'Click where the new residents live.' },
  { kind: 'jobs', label: 'Add jobs', icon: 'briefcase', hint: 'Click where the new offices / shops are.' },
  { kind: 'event', label: 'Big event', icon: 'users', hint: 'Click the venue. Extra trips arrive there in the chosen window.' },
];

export function buildPanel(): HTMLElement {
  const b = state.build;
  const toolBar = h('div.tool-grid', { role: 'toolbar', 'aria-label': 'Map tools' });
  const hint = h('p.tool-hint', { 'aria-live': 'polite' });
  const renderTools = () => {
    clear(toolBar);
    for (const t of TOOLS) {
      const active = state.tool.kind === t.kind;
      toolBar.appendChild(
        h(
          'button.tool',
          { type: 'button', 'aria-pressed': String(active), class: active ? 'active' : '', dataset: { tool: t.kind }, onclick: () => state.setTool(active ? { kind: 'select' } : ({ kind: t.kind } as Tool)) },
          icon(t.icon, 18),
          h('span', t.label),
        ),
      );
    }
    const cur = TOOLS.find((t) => t.kind === state.tool.kind)!;
    hint.textContent = state.tool.kind === 'add-road' && state.tool.fromNode !== undefined ? 'Junction A chosen — now click junction B.' : cur.hint;
  };
  state.on('tool', renderTools);
  renderTools();

  const num = (value: number, min: number, max: number, step: number, set: (v: number) => void) => {
    const el = h('input', { type: 'number', value: String(value), min: String(min), max: String(max), step: String(step) });
    el.addEventListener('change', () => {
      const v = Math.max(min, Math.min(max, Number(el.value) || min));
      el.value = String(v);
      set(v);
    });
    return el;
  };
  const time = (value: string, set: (v: string) => void) => {
    const el = h('input', { type: 'time', value, step: 300 });
    el.addEventListener('change', () => set(el.value));
    return el;
  };
  const cls = h('select', ROAD_CLASSES.map((c) => h('option', { value: c, selected: c === b.roadClass }, c.replace('_', ' '))));
  cls.addEventListener('change', () => (b.roadClass = cls.value));
  const oneway = h('input', { type: 'checkbox', checked: b.oneway });
  oneway.addEventListener('change', () => (b.oneway = oneway.checked));

  // population growth (parameter population.scale)
  const popSlider = h('input', { type: 'range', min: '0.5', max: '2', step: '0.05', 'aria-label': 'Population scale', 'data-testid': 'population-scale' });
  const popLabel = h('span.value');
  const syncPop = () => {
    if (!state.ready) return;
    const v = state.paramValue('population.scale');
    popSlider.value = String(v);
    popLabel.textContent = `×${fmt(v, 2)} (${v >= 1 ? '+' : ''}${fmt((v - 1) * 100)}%)`;
  };
  popSlider.addEventListener('input', () => (popLabel.textContent = `×${fmt(Number(popSlider.value), 2)}`));
  popSlider.addEventListener('change', () => state.setOverride('population.scale', Number(popSlider.value)));
  state.on(['scenario', 'ready'], syncPop);
  syncPop();

  const field = (label: string, el: HTMLElement) => h('label.field', h('span.field-label', label), el);

  return h(
    'section.panel',
    h('h3.section-title', 'Tools'),
    toolBar,
    hint,
    h('h3.section-title', 'New road'),
    h('div.row', field('Class', cls), field('Lanes / direction', num(b.lanes, 1, 6, 1, (v) => (b.lanes = v)))),
    h('label.check', oneway, ' One-way (A → B)'),
    h('h3.section-title', 'Housing & jobs'),
    h('div.row', field('Residents', num(b.housingPopulation, 100, 500000, 1000, (v) => (b.housingPopulation = v))), field('Jobs', num(b.jobs, 100, 500000, 1000, (v) => (b.jobs = v)))),
    h('h3.section-title', 'Big event'),
    h('div.row', field('People', num(b.eventPeople, 100, 200000, 1000, (v) => (b.eventPeople = v))), field('Arrive from', time(b.eventFrom, (v) => (b.eventFrom = v))), field('to', time(b.eventTo, (v) => (b.eventTo = v)))),
    h('h3.section-title', 'Population growth'),
    h('div.row.slider-row', popSlider, popLabel),
    h('p.hint', 'Scales all residents (parameter population.scale). New roads, housing, jobs and population changes are structural: trips are re-planned, and results are compared with a control run of the baseline through the same re-planning so model noise cancels out.'),
  );
}
