import { state } from '../state';
import type { FloodModel, RainPoint, RainPreset, ScenarioEvent } from '../types';
import { barsToProfile, profileToBars, RAIN_BARS, rainTotalMm } from '../logic/rain';
import { formatTime } from '../logic/time';
import { clear, fmt, h } from './dom';

type RainEvent = Extract<ScenarioEvent, { type: 'rain' }>;

const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

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

const FLOOD_MODELS: { id: FloodModel; label: string; hint: string }[] = [
  { id: 'none', label: 'No flooding', hint: 'Rain only slows traffic (wet-road speed/capacity factors).' },
  { id: 'hotspots', label: 'Known hotspots', hint: 'Flooding at reported flood points when rain exceeds thresholds.' },
  { id: 'bucket', label: 'Catchment bucket', hint: 'Water balance per drainage catchment: rain minus drainage fills low-lying roads.' },
];

export function rainEvent(): RainEvent | undefined {
  return state.scenario.events.find((e): e is RainEvent => e.type === 'rain');
}

function setRain(profile: RainPoint[] | null, flood?: FloodModel) {
  const cur = rainEvent();
  const model = flood ?? cur?.flood_model ?? 'hotspots';
  state.replaceEvents((e) => e.type === 'rain', profile && profile.length ? { type: 'rain', profile, flood_model: model } : null);
}

export function rainPanel(presets: RainPreset[]): HTMLElement {
  const all = [...presets, ...EXTRA_PRESETS.filter((p) => !presets.some((q) => q.id === p.id))];
  const W = 340;
  const H = 180;
  const pad = { l: 30, r: 6, t: 10, b: 24 };
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'rain-chart', role: 'img', 'aria-label': 'Rain intensity editor: drag bars to set mm per hour' });
  const info = h('div.rain-info');
  const presetInfo = h('p.hint');
  let floodModel: FloodModel = 'hotspots';
  const modelSel = h(
    'div.segmented',
    { role: 'radiogroup', 'aria-label': 'Flood model' },
    FLOOD_MODELS.map((m) =>
      h(
        'button.seg',
        {
          type: 'button',
          role: 'radio',
          dataset: { model: m.id },
          title: m.hint,
          onclick: () => {
            floodModel = m.id;
            if (rainEvent()) setRain(rainEvent()!.profile, m.id);
            else render();
          },
        },
        m.label,
      ),
    ),
  );
  const modelHint = h('p.hint');

  let bars = new Array(RAIN_BARS.n).fill(0) as number[];
  let maxY = 100;
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const bw = plotW / RAIN_BARS.n;

  const drawChart = () => {
    while (chart.firstChild) chart.removeChild(chart.firstChild);
    maxY = Math.max(100, Math.ceil(Math.max(...bars) / 20) * 20);
    for (let v = 0; v <= maxY; v += 20) {
      const y = pad.t + plotH - (v / maxY) * plotH;
      chart.appendChild(svg('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: 'grid' }));
      const t = svg('text', { x: pad.l - 4, y: y + 3, class: 'axis', 'text-anchor': 'end' });
      t.textContent = String(v);
      chart.appendChild(t);
    }
    bars.forEach((v, i) => {
      const x = pad.l + i * bw;
      const hgt = (v / maxY) * plotH;
      const r = svg('rect', { x: x + 1, y: pad.t + plotH - hgt, width: bw - 2, height: Math.max(0, hgt), class: v >= 50 ? 'bar heavy' : 'bar', rx: 2 });
      const title = svg('title');
      title.textContent = `${formatTime((RAIN_BARS.startMin + i * RAIN_BARS.stepMin) * 60000)}: ${v} mm/h`;
      r.appendChild(title);
      chart.appendChild(r);
      if (i % 2 === 0) {
        const t = svg('text', { x: x + bw, y: H - 8, class: 'axis', 'text-anchor': 'middle' });
        t.textContent = formatTime((RAIN_BARS.startMin + i * RAIN_BARS.stepMin) * 60000).replace(/^0/, '').replace(':00', 'h');
        if (i > 0) chart.appendChild(t);
      }
    });
    const lbl = svg('text', { x: pad.l + 2, y: pad.t + 8, class: 'axis' });
    lbl.textContent = 'mm/h';
    chart.appendChild(lbl);
  };

  // drag-to-paint editing
  let dragging = false;
  const paint = (ev: PointerEvent) => {
    const rect = chart.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * W;
    const y = ((ev.clientY - rect.top) / rect.height) * H;
    const i = Math.floor((x - pad.l) / bw);
    if (i < 0 || i >= RAIN_BARS.n) return;
    const v = Math.max(0, Math.min(maxY, ((pad.t + plotH - y) / plotH) * maxY));
    bars[i] = Math.round(v / 5) * 5;
    drawChart();
    updateInfo();
  };
  chart.addEventListener('pointerdown', (ev) => {
    dragging = true;
    chart.setPointerCapture(ev.pointerId);
    paint(ev);
  });
  chart.addEventListener('pointermove', (ev) => dragging && paint(ev));
  const commit = () => {
    if (!dragging) return;
    dragging = false;
    setRain(barsToProfile(bars), floodModel);
  };
  chart.addEventListener('pointerup', commit);
  chart.addEventListener('pointercancel', commit);

  const updateInfo = () => {
    const p = barsToProfile(bars);
    const total = rainTotalMm(p);
    const peak = Math.max(...bars);
    info.textContent = p.length ? `Total ${fmt(total)} mm · peak ${fmt(peak)} mm/h` : 'No rain — drag on the chart to draw rain.';
  };

  const render = () => {
    const ev = rainEvent();
    if (ev?.flood_model) floodModel = ev.flood_model;
    bars = ev ? profileToBars(ev.profile) : new Array(RAIN_BARS.n).fill(0);
    drawChart();
    updateInfo();
    if (ev) {
      const outside = ev.profile.some((p) => {
        const m = Number(p.at.slice(0, 2)) * 60 + Number(p.at.slice(3, 5));
        return p.mm_per_hour > 0 && (m < RAIN_BARS.startMin || m >= RAIN_BARS.startMin + RAIN_BARS.n * RAIN_BARS.stepMin);
      });
      if (outside) info.textContent += ' (profile also has rain outside 05:00–13:00; editing replaces it)';
    }
    modelSel.querySelectorAll<HTMLButtonElement>('.seg').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.model === floodModel)));
    modelHint.textContent = FLOOD_MODELS.find((m) => m.id === floodModel)?.hint ?? '';
  };

  const presetList = h(
    'div.preset-list',
    all.map((p) =>
      h(
        'button.preset',
        {
          type: 'button',
          onclick: () => {
            setRain(p.profile, p.id.includes('thunderstorm') ? 'bucket' : floodModel);
            clear(presetInfo);
            presetInfo.append(p.description, ' ', h('span.muted', `Source: ${p.source}`), ' ', h(`span.badge.conf-${p.confidence}`, p.confidence));
          },
        },
        h('span.preset-label', p.label),
        h('span.preset-meta', `peak ${fmt(Math.max(...p.profile.map((x) => x.mm_per_hour)))} mm/h`),
      ),
    ),
    h(
      'button.preset',
      {
        type: 'button',
        onclick: () => {
          setRain(null);
          presetInfo.textContent = '';
        },
      },
      h('span.preset-label', 'No rain'),
      h('span.preset-meta', 'clear'),
    ),
  );

  state.on(['scenario', 'ready'], render);
  render();

  return h(
    'section.panel',
    h('h3.section-title', 'Rain presets'),
    presetList,
    presetInfo,
    h('h3.section-title', 'Rain intensity (drag to draw)'),
    chart,
    info,
    h('h3.section-title', 'Flood model'),
    modelSel,
    modelHint,
    h('p.hint', 'Rain is a sudden event: everyone departs as in the baseline; heavy rain cancels or postpones some trips, slows traffic and (with a flood model) floods roads. Compared with the baseline.'),
  );
}
