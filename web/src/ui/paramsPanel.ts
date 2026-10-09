import { state, isStructuralParam } from '../state';
import type { Param } from '../types';
import { clear, h, icon } from './dom';

const CATEGORY_LABELS: Record<string, string> = {
  demand: 'Demand (who travels, when, how)',
  network: 'Road network (capacity, speeds)',
  simulation: 'Simulation & re-planning',
  signals: 'Traffic signals',
  rain: 'Rain effects',
  flood: 'Flooding',
  behaviour: 'Driver behaviour',
};

export const isAssumption = (p: Param) => /^assumption/i.test(p.source.trim());

function stepFor(p: Param): number {
  const range = p.max - p.min;
  if (Number.isInteger(p.value) && Number.isInteger(p.min) && range >= 20) return 1;
  if (range <= 1) return 0.01;
  if (range <= 10) return 0.05;
  return 0.5;
}

export function paramsPanel(): HTMLElement {
  const search = h('input', { type: 'search', placeholder: 'Search parameters, sources…', 'aria-label': 'Search parameters' });
  const onlyModified = h('input', { type: 'checkbox' });
  const body = h('div.param-groups');
  const count = h('span.muted');
  const resetAll = h(
    'button.btn.btn-sm',
    {
      type: 'button',
      onclick: () => {
        state.scenario = { ...state.scenario };
        delete state.scenario.parameter_overrides;
        state.emit('scenario');
      },
    },
    icon('reset', 14),
    ' Reset all',
  );

  const row = (p: Param) => {
    const value = state.paramValue(p.key);
    const modified = state.scenario.parameter_overrides?.[p.key] !== undefined;
    const input = h('input', { type: 'number', value: String(value), min: String(p.min), max: String(p.max), step: String(stepFor(p)), 'aria-label': p.key });
    const err = h('span.form-error');
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (input.value === '' || !Number.isFinite(v) || v < p.min || v > p.max) {
        err.textContent = `Allowed range ${p.min} – ${p.max}`;
        input.classList.add('invalid');
        return;
      }
      state.setOverride(p.key, v);
    });
    return h(
      'div.param',
      { class: modified ? 'modified' : '', dataset: { key: p.key } },
      h(
        'div.param-head',
        h('code.param-key', p.key),
        modified ? h('span.badge.badge-mod', { title: `baseline: ${p.value}` }, 'modified') : null,
        isStructuralParam(p.key) ? h('span.badge.badge-structural', { title: 'Changing it re-plans demand and compares with a control run' }, 'structural') : null,
      ),
      h('div.param-desc', p.description),
      h(
        'div.param-edit',
        input,
        h('span.unit', p.unit),
        h('span.range.muted', `${p.min} – ${p.max}`),
        modified
          ? h('button.icon-btn', { type: 'button', title: `Reset to ${p.value}`, 'aria-label': `Reset ${p.key}`, onclick: () => state.setOverride(p.key, null) }, icon('reset', 14))
          : null,
      ),
      err,
      h(
        'div.param-src',
        h(`span.badge.conf-${p.confidence}`, { title: 'Confidence in this value' }, p.confidence),
        h(isAssumption(p) ? 'span.badge.prov-assumption' : 'span.badge.prov-data', isAssumption(p) ? 'assumption' : 'data'),
        h('span.src-text', p.source),
      ),
    );
  };

  const render = () => {
    if (!state.ready) return;
    const q = search.value.trim().toLowerCase();
    const params = Object.values(state.params).filter(
      (p) =>
        (!q || `${p.key} ${p.description} ${p.source} ${p.category}`.toLowerCase().includes(q)) &&
        (!onlyModified.checked || state.scenario.parameter_overrides?.[p.key] !== undefined),
    );
    const groups = new Map<string, Param[]>();
    for (const p of params) {
      if (!groups.has(p.category)) groups.set(p.category, []);
      groups.get(p.category)!.push(p);
    }
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active?.closest<HTMLElement>('.param')?.dataset.key;
    clear(body);
    const order = Object.keys(CATEGORY_LABELS);
    const cats = [...groups.keys()].sort((a, b) => (order.indexOf(a) + 99 * +(order.indexOf(a) < 0)) - (order.indexOf(b) + 99 * +(order.indexOf(b) < 0)));
    for (const c of cats) {
      const list = groups.get(c)!;
      const nMod = list.filter((p) => state.scenario.parameter_overrides?.[p.key] !== undefined).length;
      body.appendChild(
        h(
          'details.param-group',
          { open: !!q || onlyModified.checked || nMod > 0 },
          h('summary', CATEGORY_LABELS[c] ?? c, h('span.muted', ` (${list.length})`), nMod ? h('span.badge.badge-mod', `${nMod} modified`) : null),
          list.map(row),
        ),
      );
    }
    const n = Object.keys(state.scenario.parameter_overrides ?? {}).length;
    count.textContent = `${params.length} of ${Object.keys(state.params).length} shown · ${n} modified`;
    resetAll.disabled = n === 0;
    if (focusKey) body.querySelector<HTMLInputElement>(`.param[data-key="${CSS.escape(focusKey)}"] input`)?.focus();
  };
  search.addEventListener('input', render);
  onlyModified.addEventListener('change', render);
  state.on(['scenario', 'ready'], render);
  render();

  return h(
    'section.panel',
    h(
      'p.hint',
      'Every model parameter, with its unit, source and our confidence. ',
      h('span.badge.prov-data', 'data'),
      ' values come from measurements or literature; ',
      h('span.badge.prov-assumption', 'assumption'),
      ' values are modelling guesses. Changes become parameter_overrides in the scenario.',
    ),
    search,
    h('div.param-toolbar', h('label.check', onlyModified, ' Modified only'), count, resetAll),
    body,
  );
}
