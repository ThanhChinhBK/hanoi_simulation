import { h, icon } from './dom';
import { t } from '../i18n';

/** Scenario layers: each has one colour (CSS `--c-<layer>`) used in the panel, map and timeline. */
export type Layer = 'rain' | 'signal' | 'event' | 'accident' | 'build';

export interface SectionHandle {
  el: HTMLElement;
  setCount(n: number): void;
  open(): void;
}

/** Collapsible scenario section with a layer-coloured icon tile and a count badge. */
export function section(o: { id: string; title: string; icon: string; layer: Layer; subtitle?: string; open?: boolean; badge?: string }, ...body: (Node | null)[]): SectionHandle {
  const count = h('span.count', { hidden: true });
  const details = h(
    'details.section',
    { open: o.open ?? false, dataset: { layer: o.layer, section: o.id }, 'data-testid': `section-${o.id}` },
    h(
      'summary.section-head',
      h('span.layer-tile', icon(o.icon, 18)),
      h('span.section-name', h('span.section-title', o.title), o.subtitle ? h('span.section-sub', o.subtitle) : null),
      o.badge ? h('span.badge.badge-structural', o.badge) : null,
      count,
      h('span.chev', icon('chevron', 16)),
    ),
    h('div.section-body', ...body),
  );
  return {
    el: details,
    setCount(n: number) {
      count.hidden = n === 0;
      count.textContent = String(n);
    },
    open() {
      details.open = true;
    },
  };
}

/** List item for a scenario event: colour bar, title, detail, optional editors, actions. */
export function itemCard(o: { layer: Layer; index?: number; title: string; detail?: string; onFly?: () => void; onRemove: () => void; removeLabel?: string; testid?: string }, ...body: (Node | null)[]): HTMLElement {
  return h(
    'li.item',
    { dataset: o.index !== undefined ? { layer: o.layer, index: String(o.index) } : { layer: o.layer }, 'data-testid': o.testid },
    h(
      'div.item-head',
      h('div.item-text', h('div.item-title', o.title), o.detail ? h('div.item-detail', o.detail) : null),
      o.onFly ? h('button.icon-btn', { type: 'button', title: t('Show on map'), 'aria-label': t('Show {name} on map', { name: o.title }), onclick: o.onFly }, icon('locate')) : null,
      h('button.icon-btn', { type: 'button', title: o.removeLabel ?? t('Remove'), 'aria-label': `${o.removeLabel ?? t('Remove')} ${o.title}`, onclick: o.onRemove }, icon('trash')),
    ),
    body.some(Boolean) ? h('div.item-body', ...body) : null,
  );
}

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onCommit: (v: number) => void;
  testid?: string;
  disabled?: boolean;
}

/** Label · range · live value. Previews on input, commits on change. */
export function slider(o: SliderOpts): HTMLElement {
  const input = h('input', { type: 'range', min: o.min, max: o.max, step: o.step, value: String(o.value), 'aria-label': o.label, 'data-testid': o.testid, disabled: o.disabled });
  const out = h('output.slider-value', o.format(o.value));
  input.addEventListener('input', () => (out.textContent = o.format(Number(input.value))));
  input.addEventListener('change', () => o.onCommit(Number(input.value)));
  return h('label.slider-row', h('span.slider-label', o.label), input, out);
}

/** Segmented control (radio group). */
export function segmented<T extends string | number>(label: string, options: { value: T; label: string; title?: string }[], current: T, onChange: (v: T) => void, testid?: string): HTMLElement {
  return h(
    'div.segmented',
    { role: 'radiogroup', 'aria-label': label, 'data-testid': testid },
    options.map((o) =>
      h('button.seg', { type: 'button', role: 'radio', 'aria-checked': String(o.value === current), title: o.title, dataset: { value: String(o.value) }, onclick: () => o.value !== current && onChange(o.value) }, o.label),
    ),
  );
}

export function timeInput(value: string, onCommit: (v: string) => void, label: string): HTMLInputElement {
  const el = h('input.time', { type: 'time', value, step: 300, 'aria-label': label });
  el.addEventListener('change', () => el.value && onCommit(el.value));
  return el;
}

export function numberInput(value: number, min: number, max: number, step: number, onCommit: (v: number) => void, label: string, testid?: string): HTMLInputElement {
  const el = h('input.num', { type: 'number', value: String(value), min: String(min), max: String(max), step: String(step), 'aria-label': label, 'data-testid': testid });
  el.addEventListener('change', () => {
    const v = Math.max(min, Math.min(max, Number(el.value) || min));
    el.value = String(v);
    onCommit(v);
  });
  return el;
}

export const field = (label: string, input: HTMLElement, hint?: string) => h('label.field', h('span.field-label', label), input, hint ? h('span.hint', hint) : null);
