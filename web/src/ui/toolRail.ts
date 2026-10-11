import { state, type Tool } from '../state';
import { h, icon } from './dom';
import { t } from '../i18n';

interface ToolDef {
  kind: Tool['kind'];
  label: string;
  icon: string;
  key?: string;
  layer?: string;
}

const TOOLS: (ToolDef | null)[] = [
  { kind: 'select', label: t('Select & inspect'), icon: 'pointer', key: 'V' },
  null,
  { kind: 'rain-zone', label: t('Draw rain zone'), icon: 'polygon', key: 'R', layer: 'rain' },
  { kind: 'event', label: t('Place big event'), icon: 'users', key: 'E', layer: 'event' },
  null,
  { kind: 'add-road', label: t('New road'), icon: 'road', layer: 'build' },
  { kind: 'housing', label: t('New housing'), icon: 'home', layer: 'build' },
  { kind: 'jobs', label: t('New jobs'), icon: 'briefcase', layer: 'build' },
];

export function startTool(kind: Tool['kind']) {
  if (kind !== 'select' && state.tool.kind === kind) state.setTool({ kind: 'select' });
  else state.setTool(kind === 'rain-zone' ? { kind, points: [] } : ({ kind } as Tool));
}

/** Vertical tool palette floating on the left edge of the map. */
export function toolRail(): HTMLElement {
  const rail = h('div.tool-rail', { role: 'toolbar', 'aria-label': t('Map tools'), 'aria-orientation': 'vertical' });
  const buttons: HTMLButtonElement[] = [];
  for (const t of TOOLS) {
    if (!t) {
      rail.appendChild(h('span.tool-sep', { 'aria-hidden': 'true' }));
      continue;
    }
    const tip = t.key ? `${t.label} (${t.key})` : t.label;
    const b = h(
      'button.tool-btn',
      { type: 'button', title: tip, 'aria-label': tip, dataset: { tool: t.kind, ...(t.layer ? { layer: t.layer } : {}) }, 'data-testid': `rail-${t.kind}`, onclick: () => startTool(t.kind) },
      icon(t.icon, 18),
    );
    buttons.push(b);
    rail.appendChild(b);
  }
  const sync = () => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === state.tool.kind)));
  state.on('tool', sync);
  sync();
  return rail;
}
