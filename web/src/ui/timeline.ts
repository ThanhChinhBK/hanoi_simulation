import { state } from '../state';
import { formatTime } from '../logic/time';
import { fmt, h, icon } from './dom';

const SPEEDS = [
  { v: 60, label: '1 min/s' },
  { v: 300, label: '5 min/s' },
  { v: 900, label: '15 min/s' },
];

export function timeline(): HTMLElement {
  const playBtn = h('button.icon-btn.play', { type: 'button', 'aria-label': 'Play', title: 'Play / pause (space)' });
  const timeLabel = h('div.time-label', { 'aria-live': 'off' });
  const slider = h('input.time-slider', { type: 'range', step: '60000', 'aria-label': 'Time of day' });
  const speed = h('select', { 'aria-label': 'Playback speed' }, SPEEDS.map((s) => h('option', { value: String(s.v), selected: s.v === state.speed }, s.label)));
  speed.addEventListener('change', () => (state.speed = Number(speed.value)));
  const canvas = h('canvas.delay-chart', { 'aria-label': 'Network delay over time' });
  const legend = h('div.chart-legend');

  const syncPlay = () => {
    playBtn.replaceChildren(icon(state.playing ? 'pause' : 'play', 18));
    playBtn.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  };
  playBtn.addEventListener('click', () => {
    state.playing = !state.playing;
    syncPlay();
    if (state.playing) loop();
  });
  slider.addEventListener('input', () => state.setTime(Number(slider.value)));

  let last = 0;
  const loop = () => {
    last = performance.now();
    const step = (now: number) => {
      if (!state.playing) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const w = state.window;
      let t = state.time + dt * state.speed * 1000;
      if (t >= w.start_ms + w.n_bins * w.bin_ms) t = w.start_ms;
      state.setTime(t);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      playBtn.click();
    }
  });

  const draw = () => {
    if (!state.ready) return;
    const w = state.window;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (!cw || !ch) return;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const padL = 44;
    const padB = 16;
    const padT = 6;
    const pw = cw - padL - 8;
    const ph = ch - padB - padT;
    const n = w.n_bins;
    const x = (bin: number) => padL + (bin / n) * pw;
    const cur = state.current.meta;
    const ref = state.result ? state.reference?.meta : undefined;
    const series = [cur.delay_veh_h, ...(ref ? [ref.delay_veh_h] : [])];
    const maxY = Math.max(1, ...series.flat()) * 1.1;
    const y = (v: number) => padT + ph - (v / maxY) * ph;
    // rain bars hanging from the top
    const maxRain = Math.max(...cur.rain_mm_h, 0);
    if (maxRain > 0) {
      ctx.fillStyle = 'rgba(59,130,246,0.28)';
      cur.rain_mm_h.forEach((r, i) => {
        if (r > 0) ctx.fillRect(x(i) + 0.5, padT, pw / n - 1, (Math.min(r, 100) / 100) * ph * 0.6);
      });
    }
    // grid + axis
    ctx.strokeStyle = '#e2e8f0';
    ctx.fillStyle = '#64748b';
    ctx.font = '10px system-ui, sans-serif';
    ctx.lineWidth = 1;
    for (let k = 0; k <= 2; k++) {
      const v = (maxY / 1.1) * (k / 2);
      ctx.beginPath();
      ctx.moveTo(padL, y(v));
      ctx.lineTo(padL + pw, y(v));
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(v >= 1000 ? `${fmt(v / 1000, 0)}k` : fmt(v), padL - 4, y(v) + 3);
    }
    ctx.textAlign = 'center';
    for (let hr = Math.ceil(w.start_ms / 3600000); hr * 3600000 <= w.start_ms + n * w.bin_ms; hr++) {
      const b = (hr * 3600000 - w.start_ms) / w.bin_ms;
      ctx.fillText(`${hr}:00`, x(b), ch - 3);
    }
    const line = (vals: number[], color: string, width: number, dash: number[] = []) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      vals.forEach((v, i) => {
        const px = x(i + 0.5);
        if (i === 0) ctx.moveTo(px, y(v));
        else ctx.lineTo(px, y(v));
      });
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (ref) line(ref.delay_veh_h, '#94a3b8', 2, [4, 3]);
    line(cur.delay_veh_h, state.result ? '#dc2626' : '#334155', 2);
    // cursor
    const cx = padL + ((state.time - w.start_ms) / (n * w.bin_ms)) * pw;
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, padT);
    ctx.lineTo(cx, padT + ph);
    ctx.stroke();
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(x(state.bin), padT + ph, pw / n, 2);
  };

  const renderLegend = () => {
    legend.replaceChildren(
      ...[
      h('span.lg', h('i.sw', { style: { background: state.result ? '#dc2626' : '#334155' } }), state.result ? 'Scenario' : 'Baseline'),
      state.result ? h('span.lg', h('i.sw.dashed'), `Reference (${state.result.meta.reference})`) : null,
      h('span.lg', h('i.sw.rain'), 'Rain'),
      h('span.muted', 'delay, veh·h per 10 min'),
      ].filter((x): x is HTMLSpanElement => x !== null),
    );
  };

  // scrub on the chart
  let scrubbing = false;
  const scrub = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const w = state.window;
    const f = (e.clientX - rect.left - 44) / (rect.width - 52);
    state.setTime(w.start_ms + Math.max(0, Math.min(1, f)) * w.n_bins * w.bin_ms);
  };
  canvas.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    canvas.setPointerCapture(e.pointerId);
    scrub(e);
  });
  canvas.addEventListener('pointermove', (e) => scrubbing && scrub(e));
  canvas.addEventListener('pointerup', () => (scrubbing = false));

  const syncTime = () => {
    if (!state.ready) return;
    const w = state.window;
    slider.min = String(w.start_ms);
    slider.max = String(w.start_ms + w.n_bins * w.bin_ms - 1);
    slider.value = String(state.time);
    const b = state.bin;
    const binStart = w.start_ms + b * w.bin_ms;
    timeLabel.replaceChildren(h('b', formatTime(state.time)), h('span.muted', ` bin ${formatTime(binStart)}–${formatTime(binStart + w.bin_ms)}`));
    draw();
  };
  state.on(['time', 'ready'], syncTime);
  state.on(['result', 'ready'], () => {
    renderLegend();
    draw();
  });
  new ResizeObserver(draw).observe(canvas);
  syncPlay();

  return h(
    'footer.timeline',
    h('div.tl-controls', playBtn, timeLabel, speed),
    h('div.tl-main', slider, h('div.chart-box', canvas), legend),
  );
}
