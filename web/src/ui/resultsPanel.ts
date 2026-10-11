import { t, tn, tStage } from '../i18n';
import { state } from '../state';
import type { Network } from '../network';
import type { Summary } from '../types';
import { formatTime } from '../logic/time';
import { clear, fmt, h, icon, pct, signed } from './dom';

export function resultsPanel(net: Network, hooks: { run: () => void; flyToLink: (link: number) => void }): HTMLElement {
  const body = h('div.results');
  const render = () => {
    clear(body);
    const r = state.run;
    if (r.running) {
      body.appendChild(
        h(
          'div.card.running',
          h('div.card-title', t('Simulating…')),
          h('div.progress', h('div.progress-bar', { style: { width: `${Math.round(r.fraction * 100)}%` } })),
          h('div.hint', `${tStage(r.stage)} ${Math.round(r.fraction * 100)}%`),
        ),
      );
    }
    if (r.error) body.appendChild(h('div.card.card-error', { role: 'alert' }, h('div.card-title', t('Run failed')), h('div', r.error)));
    if (state.result && state.reference) {
      if (state.stale)
        body.appendChild(
          h('div.note.warn', icon('alert', 15), h('span', `${t('The setup changed since this result.')} `, h('button.link-btn', { type: 'button', onclick: hooks.run }, t('Run again')), ` ${t('to update it.')}`)),
        );
      body.appendChild(resultCard(state.result.meta.summary, state.reference.meta.summary, state.result.meta.reference));
      const acc = state.result.meta.accidents ?? [];
      if (acc.length) {
        body.appendChild(
          h(
            'details.card.acc-list',
            h('summary.card-title', tn(acc.length, '{n} accident in this run', '{n} accidents in this run')),
            h(
              'ul.items.compact',
              acc.slice(0, 200).map((a) =>
                h(
                  'li.item',
                  { dataset: { layer: 'accident' } },
                  h(
                    'div.item-head',
                    h('div.item-text', h('div.item-title', net.linkName(a.link)), h('div.item-detail', `${formatTime(a.from_ms)}–${formatTime(a.to_ms)} · ${t('{p}% capacity left', { p: Math.round(a.capacity_factor * 100) })}`)),
                    h('button.icon-btn', { type: 'button', title: t('Show on map'), 'aria-label': t('Show on map'), onclick: () => { state.setTime(a.from_ms + 60_000); hooks.flyToLink(a.link); } }, icon('locate')),
                  ),
                ),
              ),
            ),
          ),
        );
      }
    } else if (!r.running && !r.error) {
      body.appendChild(
        h(
          'div.empty-state',
          icon('chart', 32),
          h('div.card-title', t('No result yet')),
          h('p.hint', t('Set up the scenario in the Setup tab, then run it. The map then shows where traffic gets better or worse.')),
          h('button.btn.btn-cta', { type: 'button', onclick: hooks.run }, icon('run'), h('span', t('Run simulation'))),
        ),
      );
    }
    body.appendChild(
      h(
        'p.disclaimer',
        h('strong', `${t('What-if sandbox.')} `),
        t('Results come from a simplified model with synthetic demand (a 5% sample of estimated trips). Read them as qualitative, comparative indications — not forecasts.'),
      ),
    );
  };
  state.on(['run', 'result', 'scenario', 'ready'], render);
  render();
  return h('section.panel', body);
}

function resultCard(s: Summary, r: Summary, reference: string): HTMLElement {
  const delayPct = pct(s.total_delay_veh_h, r.total_delay_veh_h);
  const tripPct = pct(s.mean_trip_min, r.mean_trip_min);
  const cls = (x: number) => (Math.abs(x) < 1 ? 'neutral' : x > 0 ? 'worse' : 'better');
  const metric = (label: string, value: string, delta: string, deltaCls: string, testid?: string) =>
    h('div.metric', h('div.metric-label', label), h('div.metric-value', value), h('div.metric-delta', { class: deltaCls, 'data-testid': testid }, delta));
  const sf = s.sample_fraction || 1;
  const rows: [string, number, number, boolean][] = [
    [t('Trips cancelled (rain)'), s.trips_cancelled, r.trips_cancelled, true],
    [t('Trips postponed (rain)'), s.trips_delayed, r.trips_delayed, true],
    [t('Trips aborted (blocked)'), s.aborted, r.aborted, true],
    [t('Not arrived by the end'), s.unfinished, r.unfinished, true],
    [t('En-route reroutes'), s.reroutes, r.reroutes, true],
    [t('Unroutable trips'), s.trips_unroutable, r.trips_unroutable, true],
    [t('Event trips'), s.event_trips, r.event_trips, true],
    [t('Accidents'), s.accidents ?? 0, r.accidents ?? 0, false],
  ];
  return h(
    'div.card.result-card',
    { 'data-testid': 'result-card' },
    h('div.card-head', h('div.card-title', t('Result')), h('span.badge', t(s.mode)), h('span.badge.badge-ref', t('vs {ref}', { ref: t(reference) }))),
    h(
      'div.metrics',
      metric(t('Total delay'), t('{n}k veh·h', { n: fmt(s.total_delay_veh_h / 1000, 1) }), `${signed(delayPct)}% ${t('vs {ref}', { ref: t(reference) })}`, cls(delayPct), 'delay-pct'),
      metric(t('Mean trip time'), t('{n} min', { n: fmt(s.mean_trip_min, 1) }), `${t('{n} min', { n: signed(s.mean_trip_min - r.mean_trip_min) })} (${signed(tripPct)}%)`, cls(tripPct)),
    ),
    h(
      'table.stats',
      h('tbody', [
        ...rows
          .filter(([, a, b]) => a !== 0 || b !== 0)
          .map(([label, a, b, scaled]) => {
            const k = scaled ? 1 / sf : 1;
            return h('tr', h('th', label), h('td', fmt(a * k)), h('td.muted', a === b ? '' : signed((a - b) * k, 0)));
          }),
        s.flooded_links_max ? h('tr', h('th', t('Flooded road links (max)')), h('td', fmt(s.flooded_links_max)), h('td')) : null,
      ]),
    ),
    h('p.hint', t('Counts are scaled from the {p}% vehicle sample. Delay = time lost vs free flow, summed over vehicles.', { p: fmt(sf * 100) })),
    s.warnings.length ? h('ul.warnings', s.warnings.map((w) => h('li', w))) : null,
  );
}
