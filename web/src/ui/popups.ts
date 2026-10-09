import * as maplibregl from 'maplibre-gl';
import { state } from '../state';
import type { Network } from '../network';
import type { MapView } from '../map/mapView';
import type { Hotspot, ScenarioEvent } from '../types';
import type { LngLat } from '../logic/trips';
import { parseTime } from '../logic/time';
import { fmt, h } from './dom';

export const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street'];

let popup: maplibregl.Popup | null = null;

export function closePopup() {
  popup?.remove();
  popup = null;
}

function open(map: maplibregl.Map, at: LngLat, content: HTMLElement) {
  closePopup();
  popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: '340px', className: 'edit-popup' })
    .setLngLat(at)
    .setDOMContent(content)
    .addTo(map);
  popup.on('close', () => {
    if (state.selection.link !== undefined || state.selection.node !== undefined) {
      state.selection = {};
      state.emit('selection');
    }
  });
}

const field = (label: string, input: HTMLElement, hint?: string) => h('label.field', h('span.field-label', label), input, hint ? h('span.hint', hint) : null);

function timeInput(value: string) {
  return h('input', { type: 'time', value, step: 300 });
}

function numInput(value: number, min: number, max: number, step: number) {
  return h('input', { type: 'number', value: String(value), min: String(min), max: String(max), step: String(step) });
}

function validWindow(from: string, to: string): string | null {
  const a = parseTime(from);
  const b = parseTime(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return 'Enter both times';
  if (b <= a) return '“To” must be after “from”';
  return null;
}

function errorLine() {
  return h('div.form-error', { role: 'alert' });
}

export class Popups {
  constructor(private view: MapView, private net: Network) {}

  private added(msg: string) {
    closePopup();
    toast(msg);
  }

  link(link: number, at: LngLat) {
    const n = this.net;
    const l = n.bundle.links[link];
    const twin = n.twin(link);
    state.selection = { link };
    state.emit('selection');
    const both = h('input', { type: 'checkbox', checked: twin !== null, disabled: twin === null });
    const ids = () => (both.checked && twin !== null ? [link, twin] : [link]);

    const cap = h('input', { type: 'range', min: '0', max: '0.9', step: '0.05', value: '0.3' });
    const capLabel = h('span.value', '30%');
    cap.addEventListener('input', () => (capLabel.textContent = `${Math.round(Number(cap.value) * 100)}%`));
    const incFrom = timeInput('07:30');
    const incTo = timeInput('08:15');
    const incErr = errorLine();
    const addIncident = () => {
      const err = validWindow(incFrom.value, incTo.value);
      if (err) return void (incErr.textContent = err);
      for (const id of ids()) state.addEvent({ type: 'incident', link: id, from: incFrom.value, to: incTo.value, capacity_factor: Number(cap.value) });
      this.added('Incident added');
    };

    const allDay = h('input', { type: 'checkbox', checked: true });
    const clFrom = timeInput('06:00');
    const clTo = timeInput('22:00');
    const syncAllDay = () => {
      clFrom.disabled = allDay.checked;
      clTo.disabled = allDay.checked;
    };
    allDay.addEventListener('change', syncAllDay);
    syncAllDay();
    const clErr = errorLine();
    const addClosure = () => {
      if (allDay.checked) state.addEvent({ type: 'closure', links: ids() });
      else {
        const err = validWindow(clFrom.value, clTo.value);
        if (err) return void (clErr.textContent = err);
        state.addEvent({ type: 'closure', links: ids(), from: clFrom.value, to: clTo.value });
      }
      this.added('Closure added');
    };

    const lanes = numInput(l?.lanes ?? 1, 1, 8, 1);
    const speed = numInput(l?.maxspeed_kmh ?? 30, 5, 120, 5);
    const modify = () => {
      for (const id of ids()) {
        const base = n.bundle.links[id];
        const ev: ScenarioEvent = { type: 'modify_road', link: id };
        if (Number(lanes.value) !== base.lanes) ev.lanes = Number(lanes.value);
        if (Number(speed.value) !== base.maxspeed_kmh) ev.maxspeed_kmh = Number(speed.value);
        if (ev.lanes === undefined && ev.maxspeed_kmh === undefined) continue;
        state.addEvent(ev);
      }
      this.added('Road change added (structural)');
    };

    const content = h(
      'div.popup',
      h('div.popup-title', n.linkName(link)),
      h(
        'div.popup-meta',
        l
          ? `${l.road_class.replace('_', ' ')} · ${l.lanes} lane${l.lanes === 1 ? '' : 's'} · ${l.maxspeed_kmh} km/h · ${fmt(l.length_m)} m${l.bridge ? ' · bridge' : ''}${l.tunnel ? ' · tunnel' : ''}`
          : 'road added by the scenario',
      ),
      h('div.popup-meta.muted', `link #${link}${twin !== null ? ` · reverse #${twin}` : ' · one-way'}`),
      l ? h('label.check', both, ' Apply to both directions') : null,
      l
        ? [
            h(
              'details',
              { open: true },
              h('summary', 'Incident (temporary capacity loss)'),
              field('Remaining capacity', h('div.row', cap, capLabel)),
              h('div.row', field('From', incFrom), field('To', incTo)),
              incErr,
              h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: addIncident, 'data-testid': 'add-incident' }, 'Add incident'),
            ),
            h(
              'details',
              h('summary', 'Closure'),
              h('label.check', allDay, ' All day'),
              h('div.row', field('From', clFrom), field('To', clTo)),
              clErr,
              h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: addClosure }, 'Close road'),
            ),
            h(
              'details',
              h('summary', 'Modify road ', h('span.badge.badge-structural', 'structural')),
              h('div.row', field('Lanes', lanes), field('Speed km/h', speed)),
              h('button.btn.btn-sm', { type: 'button', onclick: modify }, 'Apply change'),
            ),
            h(
              'div.popup-actions',
              h(
                'button.btn.btn-danger.btn-sm',
                {
                  type: 'button',
                  onclick: () => {
                    state.addEvent({ type: 'remove_road', links: ids() });
                    this.added('Road removal added (structural)');
                  },
                },
                'Remove road permanently',
              ),
            ),
          ]
        : null,
    );
    open(this.view.map, at, content);
  }

  node(node: number) {
    const n = this.net;
    const nd = n.bundle.nodes[node];
    state.selection = { node };
    state.emit('selection');
    const existing = state.scenario.events.find((e): e is Extract<ScenarioEvent, { type: 'signal' }> => e.type === 'signal' && e.node === node);
    const defaultCycle = state.paramValue('signal.cycle_s') || 120;
    const cycle = h('input', { type: 'range', min: '40', max: '240', step: '5', value: String(existing?.cycle_s ?? defaultCycle) });
    const cycleLabel = h('span.value');
    const ns = h('input', { type: 'range', min: '0.1', max: '0.9', step: '0.05', value: String(existing ? existing.green_split.north_south / (existing.green_split.north_south + existing.green_split.east_west) : 0.5) });
    const nsLabel = h('span.value');
    const sync = () => {
      cycleLabel.textContent = `${cycle.value} s`;
      const v = Number(ns.value);
      nsLabel.textContent = `NS ${Math.round(v * 100)}% · EW ${Math.round((1 - v) * 100)}%`;
    };
    cycle.addEventListener('input', sync);
    ns.addEventListener('input', sync);
    sync();
    const apply = () => {
      const v = Number(ns.value);
      state.replaceEvents((e) => e.type === 'signal' && e.node === node, {
        type: 'signal',
        node,
        cycle_s: Number(cycle.value),
        green_split: { north_south: Math.round(v * 100) / 100, east_west: Math.round((1 - v) * 100) / 100 },
      });
      this.added(nd.signal ? 'Signal plan changed' : 'Signal added');
    };
    const content = h(
      'div.popup',
      h('div.popup-title', n.nodeName(node)),
      h(
        'div.popup-meta',
        nd.signal ? h('span.badge.badge-ok', 'signalised') : h('span.badge', 'no signal'),
        ` node #${node} · ${fmt(nd.elev_m, 0)} m elevation`,
      ),
      h(
        'p.hint',
        nd.signal
          ? `Default plan: ${defaultCycle} s cycle, green split by approach. Green shares apply to north–south vs east–west approaches.`
          : 'Not signalised in the base network. Applying a plan adds a signal here.',
      ),
      field('Cycle length', h('div.row', cycle, cycleLabel)),
      field('Green split', h('div.row', ns, nsLabel), 'Left: more east–west green · right: more north–south'),
      h(
        'div.popup-actions',
        h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: apply }, existing ? 'Update signal plan' : nd.signal ? 'Apply signal plan' : 'Add signal'),
        existing
          ? h(
              'button.btn.btn-sm',
              {
                type: 'button',
                onclick: () => {
                  state.replaceEvents((e) => e.type === 'signal' && e.node === node, null);
                  this.added('Signal change removed');
                },
              },
              'Revert',
            )
          : null,
        h(
          'button.btn.btn-sm',
          {
            type: 'button',
            onclick: () => {
              closePopup();
              state.setTool({ kind: 'add-road', fromNode: node });
              toast('Now click the node where the new road should end');
            },
          },
          'New road from here',
        ),
      ),
    );
    open(this.view.map, n.nodePos(node), content);
  }

  addRoad(from: number, to: number) {
    const n = this.net;
    const b = state.build;
    const cls = h('select', ROAD_CLASSES.map((c) => h('option', { value: c, selected: c === b.roadClass }, c.replace('_', ' '))));
    const lanes = numInput(b.lanes, 1, 6, 1);
    const oneway = h('input', { type: 'checkbox', checked: b.oneway });
    const name = h('input', { type: 'text', value: 'New road', maxLength: 60 });
    const [a, c] = [n.nodePos(from), n.nodePos(to)];
    const km = Math.hypot((c[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), c[1] - a[1]) * 111.32;
    const add = () => {
      b.roadClass = cls.value;
      b.lanes = Number(lanes.value);
      b.oneway = oneway.checked;
      state.addEvent({ type: 'add_road', from_node: from, to_node: to, road_class: cls.value, lanes: Number(lanes.value), oneway: oneway.checked, name: name.value || undefined });
      state.setTool({ kind: 'select' });
      this.added('New road added (structural)');
    };
    const content = h(
      'div.popup',
      h('div.popup-title', 'New road'),
      h('div.popup-meta', `${n.nodeName(from)} → ${n.nodeName(to)} · ${fmt(km, 2)} km straight line`),
      h('div.row', field('Class', cls), field('Lanes / dir.', lanes)),
      h('label.check', oneway, ' One-way (A → B only)'),
      field('Name', name),
      h(
        'div.popup-actions',
        h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: add }, 'Add road'),
        h(
          'button.btn.btn-sm',
          {
            type: 'button',
            onclick: () => {
              closePopup();
              state.setTool({ kind: 'select' });
            },
          },
          'Cancel',
        ),
      ),
    );
    open(this.view.map, c, content);
  }

  hotspot(hs: Hotspot, at: LngLat) {
    open(
      this.view.map,
      at,
      h(
        'div.popup',
        h('div.popup-title', 'Flood hotspot'),
        h('div', hs.label),
        h('div.popup-meta', `${hs.kind} · ${hs.links.length} links · observed ${hs.observed ?? '–'}`),
        h('div.popup-meta', 'Confidence: ', h(`span.badge.conf-${hs.confidence}`, hs.confidence)),
        h('p.hint', 'Source: ', hs.source),
      ),
    );
  }

  marker(index: number, at: LngLat) {
    const ev = state.scenario.events[index];
    if (!ev) return;
    const d = this.net.describe(ev);
    open(
      this.view.map,
      at,
      h(
        'div.popup',
        h('div.popup-title', d.title),
        h('div.popup-meta', d.detail),
        h(
          'div.popup-actions',
          h(
            'button.btn.btn-danger.btn-sm',
            {
              type: 'button',
              onclick: () => {
                state.removeEvent(index);
                closePopup();
              },
            },
            'Remove',
          ),
        ),
      ),
    );
  }
}

let toastTimer = 0;
export function toast(msg: string, kind: 'info' | 'error' = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div#toast', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), 3200);
}
