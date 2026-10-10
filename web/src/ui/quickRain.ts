import { state } from '../state';
import { quickRainFromProfile, quickRainProfile, type QuickRain } from '../logic/quickRain';
import { formatTime } from '../logic/time';
import type { FloodModel } from '../types';
import { fmt, h } from './dom';
import { rainEvent } from './rainPanel';

const MODELS: [FloodModel, string, string][] = [
  ['none', 'No flooding', 'Rain only slows traffic.'],
  ['hotspots', 'Flood points', 'Known flood points flood when rain is heavy enough.'],
  ['bucket', 'Drainage model', 'Each catchment fills when rain exceeds drainage; low roads flood.'],
];

/** One-glance rain control: three sliders and a flood model; replaces the scenario's rain. */
export function quickRainCard(): HTMLElement {
  const q: QuickRain = { intensity: 0, startMs: 7.5 * 3600_000, durationMin: 60 };
  let model: FloodModel = 'hotspots';

  const slider = (label: string, min: number, max: number, step: number, testid: string) => {
    const input = h('input', { type: 'range', min, max, step, 'aria-label': label, 'data-testid': testid });
    const out = h('output.qr-value');
    return { input, out, row: h('label.qr-row', h('span.qr-label', label), input, out) };
  };
  const inten = slider('Rain', 0, 120, 5, 'qr-intensity');
  const start = slider('Starts', 5.5 * 60, 10 * 60, 15, 'qr-start');
  const dur = slider('Lasts', 15, 180, 15, 'qr-duration');
  const total = h('div.qr-total');
  const custom = h('p.hint', { hidden: true }, 'The scenario has a custom rain profile (Rain tab). Moving a slider replaces it.');
  const models = h(
    'div.segmented',
    { role: 'radiogroup', 'aria-label': 'Flooding' },
    MODELS.map(([id, label, hint]) =>
      h('button.seg', { type: 'button', role: 'radio', title: hint, dataset: { model: id }, onclick: () => { model = id; apply(); } }, label),
    ),
  );

  const describe = (mmh: number) =>
    mmh === 0 ? 'none' : mmh < 10 ? 'light' : mmh < 30 ? 'moderate' : mmh < 60 ? 'heavy' : 'very heavy';

  const paint = () => {
    inten.input.value = String(q.intensity);
    start.input.value = String(q.startMs / 60_000);
    dur.input.value = String(q.durationMin);
    inten.out.textContent = q.intensity ? `${q.intensity} mm/h · ${describe(q.intensity)}` : 'off';
    start.out.textContent = formatTime(q.startMs);
    dur.out.textContent = `${q.durationMin} min`;
    total.textContent = q.intensity
      ? `≈ ${fmt((q.intensity * q.durationMin) / 60, 0)} mm in total, ${formatTime(q.startMs)}–${formatTime(q.startMs + q.durationMin * 60_000)}`
      : 'Drag “Rain” to start a storm.';
    start.input.disabled = dur.input.disabled = q.intensity === 0;
    for (const b of models.children) (b as HTMLElement).setAttribute('aria-checked', String((b as HTMLElement).dataset.model === model));
  };

  const apply = () => {
    const profile = quickRainProfile(q);
    state.replaceEvents((e) => e.type === 'rain', profile.length ? { type: 'rain', profile, flood_model: model } : null);
    // jump the clock to when flooding is near its worst
    if (profile.length) state.setTime(q.startMs + Math.min(q.durationMin, 90) * 45_000);
  };

  const onInput = () => {
    q.intensity = Number(inten.input.value);
    q.startMs = Number(start.input.value) * 60_000;
    q.durationMin = Number(dur.input.value);
    paint();
  };
  for (const s of [inten, start, dur]) {
    s.input.addEventListener('input', onInput);
    s.input.addEventListener('change', apply);
  }

  const sync = () => {
    const ev = rainEvent();
    const parsed = quickRainFromProfile(ev?.profile);
    if (parsed) Object.assign(q, parsed);
    else if (!ev) q.intensity = 0;
    if (ev?.flood_model) model = ev.flood_model;
    custom.hidden = !ev || !!parsed;
    paint();
  };
  state.on(['scenario'], sync);
  sync();

  return h(
    'div.card.quick-rain',
    { 'data-testid': 'quick-rain' },
    h('div.card-title', 'Quick rain'),
    h('p.hint', 'Set a storm and the map updates by itself. Then press ▶ on the timeline to watch it.'),
    inten.row,
    start.row,
    dur.row,
    total,
    h('div.qr-row', h('span.qr-label', 'Flooding'), models),
    custom,
  );
}
