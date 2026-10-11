import { state } from '../state';
import type { Network } from '../network';
import type { Scenario } from '../types';
import { h, icon } from './dom';
import { toast } from './popups';
import { lang, setLang, t } from '../i18n';

interface PresetEntry {
  id: string;
  file: string;
  name: string;
}

export function runStatus(): { label: string; kind: 'idle' | 'draft' | 'running' | 'ok' | 'stale' | 'error' } {
  const r = state.run;
  if (r.running) return { label: t('Running {p}%', { p: Math.round(r.fraction * 100) }), kind: 'running' };
  if (r.error) return { label: t('Run failed'), kind: 'error' };
  if (state.result) return state.stale ? { label: t('Outdated'), kind: 'stale' } : { label: t('Up to date'), kind: 'ok' };
  const empty = !state.scenario.events.length && !state.scenario.parameter_overrides;
  return empty ? { label: t('Baseline'), kind: 'idle' } : { label: t('Not run yet'), kind: 'draft' };
}

export function topBar(net: Network, hooks: { run: () => void; share: () => Promise<string>; flyTo: (i: number) => void }): HTMLElement {
  const presetSelect = h('select.examples', { 'aria-label': t('Example scenarios'), 'data-testid': 'preset-select' }, h('option', { value: '' }, t('Examples…')));
  fetch(new URL('scenarios/index.json', document.baseURI))
    .then((r) => r.json() as Promise<PresetEntry[]>)
    .then((list) => list.forEach((p) => presetSelect.appendChild(h('option', { value: p.file }, t(p.name)))))
    .catch(() => presetSelect.appendChild(h('option', { disabled: true }, t('(examples unavailable)'))));
  presetSelect.addEventListener('change', async () => {
    if (!presetSelect.value) return;
    try {
      const s = (await (await fetch(new URL(`scenarios/${presetSelect.value}`, document.baseURI))).json()) as Scenario;
      state.setScenario({ ...s, events: s.events ?? [] });
      const first = state.scenario.events.findIndex((e) => net.eventLocation(e));
      if (first >= 0) hooks.flyTo(first);
      state.scenario.events.forEach((_, i) => i === 0 && state.focusEvent(0));
      toast(t('Loaded “{name}” — press Run simulation', { name: s.name ? t(s.name) : presetSelect.value }));
    } catch (e) {
      toast(t('Could not load example: {e}', { e: String(e) }), 'error');
    }
    presetSelect.value = '';
  });

  const name = h('input.scenario-name', { type: 'text', placeholder: t('Untitled scenario'), 'aria-label': t('Scenario name'), maxLength: 80 });
  name.addEventListener('change', () => {
    state.scenario = { ...state.scenario, name: name.value || undefined };
    state.emit('scenario');
  });

  const chip = h('span.status-chip', { role: 'status', 'aria-live': 'polite', 'data-testid': 'status' });
  const live = h('input', { type: 'checkbox', checked: state.autoRun, 'data-testid': 'auto-run' });
  live.addEventListener('change', () => {
    state.autoRun = live.checked;
    state.emit('scenario');
  });
  const runBtn = h('button.btn.btn-cta', { type: 'button', 'data-testid': 'run', title: t('Run simulation (Ctrl/⌘ + Enter)'), onclick: () => hooks.run() }, icon('run'), h('span', t('Run simulation')));
  const share = h(
    'button.btn.btn-ghost',
    {
      type: 'button',
      title: t('Copy a link to this scenario'),
      onclick: async () => {
        const url = await hooks.share();
        try {
          await navigator.clipboard.writeText(url);
          toast(t('Link copied to clipboard'));
        } catch {
          toast(t('Link is in the address bar'));
        }
      },
    },
    icon('share'),
    h('span', t('Share')),
  );
  const clearBtn = h(
    'button.btn.btn-ghost',
    {
      type: 'button',
      title: t('Remove everything from the scenario'),
      onclick: () => {
        if (!state.scenario.events.length && !state.scenario.parameter_overrides) return;
        if (confirm(t('Clear the whole scenario?'))) state.setScenario({ events: [] });
      },
    },
    icon('trash'),
    h('span', t('Clear')),
  );

  const render = () => {
    if (document.activeElement !== name) name.value = state.scenario.name ?? '';
    const s = runStatus();
    chip.textContent = s.label;
    chip.dataset.kind = s.kind;
    runBtn.disabled = !state.ready || state.run.running;
    (runBtn.lastChild as HTMLElement).textContent = state.run.running ? t('Running…') : t('Run simulation');
    runBtn.classList.toggle('attention', s.kind === 'draft' || s.kind === 'stale');
  };
  state.on(['scenario', 'run', 'result', 'ready'], render);
  render();

  return h(
    'header.topbar',
    h('div.brand', h('span.brand-mark', icon('road', 18)), h('span.brand-text', h('b', t('Hanoi traffic what-if')), h('span.brand-sub', t('Morning peak · inner Hanoi')))),
    h('div.topbar-scenario', name, presetSelect),
    h('div.topbar-actions', chip, h('label.live', { title: t('Re-run automatically after each change (sudden scenarios only)') }, live, ` ${t('Live update')}`), share, clearBtn, langSwitch(hooks.share), runBtn),
  );
}

/** VI | EN toggle. Reloads the page; the scenario survives in the URL hash. */
function langSwitch(share: () => Promise<string>): HTMLElement {
  const opts: { value: 'vi' | 'en'; label: string; title: string }[] = [
    { value: 'vi', label: 'VI', title: 'Tiếng Việt' },
    { value: 'en', label: 'EN', title: 'English' },
  ];
  return h(
    'div.segmented.small.lang-switch',
    { role: 'radiogroup', 'aria-label': t('Language'), 'data-testid': 'lang-switch' },
    opts.map((o) =>
      h(
        'button.seg',
        {
          type: 'button',
          role: 'radio',
          lang: o.value,
          title: o.title,
          'aria-checked': String(o.value === lang),
          dataset: { value: o.value },
          onclick: async () => {
            if (o.value === lang) return;
            if (state.scenario.events.length || state.scenario.parameter_overrides) await share();
            setLang(o.value);
          },
        },
        o.label,
      ),
    ),
  );
}
