import { state, type Smoothing, type ViewMode } from '../state';
import { CONGESTION_LEGEND, divergingColor, NO_DATA, CLOSED, ESTIMATE, toCss } from '../logic/colors';
import { VEHICLE_COLORS, VEHICLE_NAMES } from '../map/mapView';
import { h } from './dom';

export function mapLegend(): HTMLElement {
  const modes = h('div.segmented.small', { role: 'radiogroup', 'aria-label': 'Map colouring' });
  const scale = h('div.legend-scale');
  const smoothing = h(
    'select',
    { 'aria-label': 'Time aggregation' },
    h('option', { value: '0' }, '10-min bin'),
    h('option', { value: '1' }, '30 min (±10)'),
    h('option', { value: 'all' }, 'Whole morning'),
  );
  smoothing.addEventListener('change', () => {
    state.smoothing = (smoothing.value === 'all' ? 'all' : Number(smoothing.value)) as Smoothing;
    state.emit('view');
  });
  const layerToggles = h('div.layer-toggles');
  const toggle = (key: keyof typeof state.layers, label: string) => {
    const cb = h('input', { type: 'checkbox', checked: state.layers[key] });
    cb.addEventListener('change', () => {
      state.layers[key] = cb.checked;
      state.emit('view');
    });
    return h('label.check', cb, ` ${label}`);
  };
  layerToggles.append(toggle('vehicles', 'Vehicles'), toggle('localAccess', 'Small streets (est.)'), toggle('flood', 'Flooding'), toggle('hotspots', 'Flood points'), toggle('nodes', 'Junctions'));

  const render = () => {
    const opts: { id: ViewMode; label: string; enabled: boolean }[] = [
      { id: 'diff', label: 'Difference', enabled: !!state.result },
      { id: 'congestion', label: state.result ? 'Scenario' : 'Congestion', enabled: true },
      { id: 'congestion-ref', label: 'Reference', enabled: !!state.result },
    ];
    const effective = state.result ? state.view : 'congestion';
    modes.replaceChildren(
      ...opts.map((o) =>
        h(
          'button.seg',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(effective === o.id),
            disabled: !o.enabled,
            title: o.enabled ? '' : 'Run a scenario first',
            onclick: () => {
              state.view = o.id;
              state.emit('view');
            },
          },
          o.label,
        ),
      ),
    );
    if (effective === 'diff') {
      const stops = [-1, -0.5, -0.15, 0, 0.15, 0.5, 1];
      scale.replaceChildren(
        h('div.legend-title', `Travel time vs ${state.result?.meta.reference ?? 'reference'}`),
        h('div.gradient', { style: { background: `linear-gradient(90deg, ${stops.map((s) => toCss(divergingColor(s))).join(',')})` } }),
        h('div.gradient-labels', h('span', '½× faster'), h('span', 'no change'), h('span', '2× slower')),
        h('div.legend-row', h('i.sw', { style: { background: toCss(CLOSED) } }), 'closed / removed', h('i.sw', { style: { background: toCss(NO_DATA) } }), 'no traffic'),
      );
    } else {
      scale.replaceChildren(
        h('div.legend-title', `Congestion${state.result ? (effective === 'congestion-ref' ? ' (reference)' : ' (scenario)') : ' (baseline)'}: travel time ÷ free flow`),
        h('div.gradient', { style: { background: `linear-gradient(90deg, ${CONGESTION_LEGEND.map(([, c]) => toCss(c)).join(',')})` } }),
        h('div.gradient-labels', ...CONGESTION_LEGEND.map(([x]) => h('span', `${x}×`))),
        h('div.legend-row', h('i.sw', { style: { background: toCss(ESTIMATE) } }), 'small street, estimated (not simulated)'),
      );
    }
    scale.append(
      h('div.legend-row', 'Width = traffic volume'),
      h('div.legend-row', ...Object.entries(VEHICLE_NAMES).slice(0, 3).map(([k, name]) => [h('i.dot', { style: { background: `rgb(${VEHICLE_COLORS[Number(k)].join(',')})` } }), name])),
      h('div.legend-row', h('i.sw', { style: { background: 'rgb(59,104,215)' } }), 'flooded road', h('i.dot.hollow'), 'flood point'),
    );
  };
  state.on(['result', 'view', 'ready'], render);
  render();

  const body = h('div.legend-body', modes, scale, h('label.field.inline', h('span.field-label', 'Time'), smoothing), layerToggles);
  const collapse = h(
    'button.legend-toggle',
    {
      type: 'button',
      'aria-expanded': 'true',
      onclick: () => {
        body.hidden = !body.hidden;
        collapse.setAttribute('aria-expanded', String(!body.hidden));
      },
    },
    'Map',
  );
  return h('div.map-legend', { 'data-testid': 'legend' }, collapse, body);
}
