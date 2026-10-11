import type { Bundle } from '../types';
import { fmt, h } from './dom';
import { t } from '../i18n';

export function aboutPanel(bundle: Bundle): HTMLElement {
  return h(
    'section.panel.about',
    h('h3.section-title', t('What is this?')),
    h(
      'p',
      t('An interactive “what-if” sandbox for traffic in inner Hanoi. A mesoscopic traffic engine (Rust → WebAssembly, running in your browser) simulates the morning peak (departures ~06:00–09:00, statistics 05:30–12:00) on the OpenStreetMap road network with motorbikes, cars and buses.'),
    ),
    h('h3.section-title', t('How to read the map')),
    h(
      'ul',
      h('li', h('b', `${t('Before running:')} `), t('roads are coloured by baseline congestion (travel time ÷ free-flow time).')),
      h(
        'li',
        h('b', `${t('After running:')} `),
        t('roads are coloured by the difference between your scenario and its reference in the selected 10-minute bin: green = faster, grey = no change, red = slower. Line width shows traffic volume.'),
      ),
      h(
        'li',
        h('b', `${t('Reference:')} `),
        t('sudden events (rain, incidents, closures, signals, big events) are compared with the baseline — same trips, drivers react en route. Structural changes (new/removed roads, housing, jobs, network or demand parameters) re-plan everyone’s routes, and are compared with a “control” run: the baseline re-planned the same way, so that model noise cancels.'),
      ),
      h('li', t('Blue lines are flooded roads (darker/wider = deeper). White circles are reported flood points.')),
      h('li', t('Moving dots are a sample of individual vehicles (orange motorbike, blue car, green bus).')),
    ),
    h('h3.section-title', t('Limitations')),
    h(
      'ul',
      h('li', t('Demand is synthetic: estimated from population and points of interest, not from counts or surveys. Only a 5% sample of vehicles is simulated and scaled up.')),
      h('li', t('Only the morning peak is simulated; times outside are accepted for rain/closures but have little effect.')),
      h('li', t('Signals use generic plans; flooding is a simple hotspot/bucket model on a coarse elevation model.')),
      h('li', t('Small differences are noise. Look at the direction and rough size of changes, not exact numbers.')),
    ),
    h('h3.section-title', t('Data & attributions')),
    h(
      'ul.attributions',
      h('li', `${t('Basemap:')} `, h('a', { href: 'https://openfreemap.org', target: '_blank', rel: 'noopener' }, 'OpenFreeMap'), ' · © ', h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, 'OpenStreetMap contributors')),
      bundle.attributions.map((a) => h('li', h('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.name), ` — ${a.license}; ${t('used for {what}', { what: a.used_for })}`)),
      h('li', `${t('Rendering:')} MapLibre GL JS, deck.gl`),
    ),
    h(
      'p.muted.small',
      t('City bundle “{name}” v{version}, created {created}: {nodes} junctions, {links} directed road links.', {
        name: bundle.name,
        version: bundle.version,
        created: bundle.created,
        nodes: fmt(bundle.nodes.length),
        links: fmt(bundle.links.length),
      }),
    ),
  );
}
