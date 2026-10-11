import { t } from '../i18n';
import type { RainPoint } from '../types';
import { barsToProfile, profileToBars, RAIN_BARS, rainTotalMm } from '../logic/rain';
import { formatTime } from '../logic/time';
import { fmt, h } from './dom';

const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/** Bar editor for a rain profile (30-min bars, 05:00–13:00): drag to paint, commits on release. */
export function profileChart(profile: RainPoint[], onCommit: (p: RainPoint[]) => void): HTMLElement {
  const W = 340;
  const H = 150;
  const pad = { l: 28, r: 6, t: 10, b: 22 };
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'rain-chart', role: 'img', 'aria-label': t('Rain intensity over time: drag bars to set mm per hour') });
  const info = h('div.hint');
  let bars = profileToBars(profile);
  let maxY = 100;
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const bw = plotW / RAIN_BARS.n;

  const draw = () => {
    while (chart.firstChild) chart.removeChild(chart.firstChild);
    maxY = Math.max(100, Math.ceil(Math.max(...bars) / 20) * 20);
    for (let v = 0; v <= maxY; v += maxY / 4) {
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
      if (i % 2 === 0 && i > 0) {
        const t = svg('text', { x, y: H - 6, class: 'axis', 'text-anchor': 'middle' });
        t.textContent = `${(RAIN_BARS.startMin + i * RAIN_BARS.stepMin) / 60}h`;
        chart.appendChild(t);
      }
    });
    const p = barsToProfile(bars);
    info.textContent = p.length ? t('Total {total} mm · peak {peak} mm/h', { total: fmt(rainTotalMm(p)), peak: fmt(Math.max(...bars)) }) : t('No rain — drag on the chart to draw it.');
  };

  let dragging = false;
  const paint = (ev: PointerEvent) => {
    const rect = chart.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * W;
    const y = ((ev.clientY - rect.top) / rect.height) * H;
    const i = Math.floor((x - pad.l) / bw);
    if (i < 0 || i >= RAIN_BARS.n) return;
    const v = Math.max(0, Math.min(maxY, ((pad.t + plotH - y) / plotH) * maxY));
    bars[i] = Math.round(v / 5) * 5;
    draw();
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
    onCommit(barsToProfile(bars));
  };
  chart.addEventListener('pointerup', commit);
  chart.addEventListener('pointercancel', commit);
  draw();
  return h('div.profile-chart', chart, info);
}

