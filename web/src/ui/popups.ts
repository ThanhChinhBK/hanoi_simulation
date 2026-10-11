import type { Map as MlMap } from 'maplibre-gl';
import { state } from '../state';
import type { Network } from '../network';
import type { MapView } from '../map/mapView';
import type { Hotspot, ScenarioEvent } from '../types';
import type { LngLat } from '../logic/trips';
import { parseTime } from '../logic/time';
import { fmt, h, icon } from './dom';
import { greensToPlan, planToGreens } from '../logic/signals';
import { formatTime } from '../logic/time';
import type { Accident } from '../types';
import { t, tn } from '../i18n';
import { roadClassName } from '../logic/roadClass';

export const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street'];

let inspector: HTMLElement | null = null;

/** The inspector is a floating panel on the right of the map (replaces map popups). */
export function mountInspector(el: HTMLElement) {
  inspector = el;
  el.hidden = true;
}

export function closePopup() {
  if (!inspector || inspector.hidden) return;
  inspector.hidden = true;
  inspector.replaceChildren();
  if (state.selection.link !== undefined || state.selection.node !== undefined || state.selection.event !== undefined) {
    state.selection = {};
    state.emit('selection');
  }
}

function open(_map: MlMap, _at: LngLat, content: HTMLElement) {
  if (!inspector) return;
  inspector.replaceChildren(
    h('button.icon-btn.inspector-close', { type: 'button', 'aria-label': t('Close inspector'), title: t('Close (Esc)'), onclick: () => closePopup() }, icon('x')),
    content,
  );
  inspector.hidden = false;
  inspector.scrollTop = 0;
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
  if (Number.isNaN(a) || Number.isNaN(b)) return t('Enter both times');
  if (b <= a) return t('“To” must be after “from”');
  return null;
}

function errorLine() {
  return h('div.form-error', { role: 'alert' });
}

export class Popups {
  constructor(
    private view: MapView,
    private net: Network,
    private edit: (index: number) => void = () => {},
  ) {}

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
      this.added(t('Incident added'));
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
      this.added(t('Closure added'));
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
      this.added(t('Road change added (structural)'));
    };

    const content = h(
      'div.popup',
      { 'data-testid': 'inspector-road' },
      h('div.popup-kicker', icon('road', 14), t('Road')),
      h('div.popup-title', n.linkName(link)),
      h(
        'div.popup-meta',
        l
          ? `${roadClassName(l.road_class)} · ${tn(l.lanes, '{n} lane', '{n} lanes')} · ${l.maxspeed_kmh} km/h · ${fmt(l.length_m)} m${l.bridge ? ` · ${t('bridge')}` : ''}${l.tunnel ? ` · ${t('tunnel')}` : ''}`
          : t('road added by the scenario'),
      ),
      h('div.popup-meta.muted', `${t('link #{id}', { id: link })}${twin !== null ? ` · ${t('reverse #{id}', { id: twin })}` : ` · ${t('one-way')}`}`),
      l ? h('label.check', both, ` ${t('Apply to both directions')}`) : null,
      l
        ? [
            h(
              'details',
              { open: true },
              h('summary', t('Incident (temporary capacity loss)')),
              field(t('Remaining capacity'), h('div.row', cap, capLabel)),
              h('div.row', field(t('From'), incFrom), field(t('To'), incTo)),
              incErr,
              h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: addIncident, 'data-testid': 'add-incident' }, t('Add incident')),
            ),
            h(
              'details',
              h('summary', t('Closure')),
              h('label.check', allDay, ` ${t('All day')}`),
              h('div.row', field(t('From'), clFrom), field(t('To'), clTo)),
              clErr,
              h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: addClosure }, t('Close road')),
            ),
            h(
              'details',
              h('summary', `${t('Modify road')} `, h('span.badge.badge-structural', t('structural'))),
              h('div.row', field(t('Lanes'), lanes), field(t('Speed km/h'), speed)),
              h('button.btn.btn-sm', { type: 'button', onclick: modify }, t('Apply change')),
            ),
            h(
              'div.popup-actions',
              h(
                'button.btn.btn-danger.btn-sm',
                {
                  type: 'button',
                  onclick: () => {
                    state.addEvent({ type: 'remove_road', links: ids() });
                    this.added(t('Road removal added (structural)'));
                  },
                },
                t('Remove road permanently'),
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
    const lost = state.paramValue('signal.lost_time_s') || 0;
    const cycle = state.paramValue('signal.cycle_s') || 120;
    const def = state.signalPlans.get(node);
    const defGreens = def ? planToGreens(cycle, def.green_split, lost) : planToGreens(cycle, { north_south: 0.5, east_west: 0.5 }, lost);
    const cur = existing ? planToGreens(existing.cycle_s, existing.green_split, lost) : defGreens;
    const ns = numInput(cur.ns, 5, 200, 1);
    const ew = numInput(cur.ew, 5, 200, 1);
    ns.setAttribute('data-testid', 'inspector-green-ns');
    ew.setAttribute('data-testid', 'inspector-green-ew');
    const total = h('div.hint');
    const sync = () => {
      const c = Math.max(1, Number(ns.value)) + Math.max(1, Number(ew.value)) + lost;
      total.textContent = t('Cycle {c} s = {ns} s + {ew} s green + {lost} s amber/clearance. A driver waits up to ~{wait} s on red.', { c: fmt(c), ns: ns.value, ew: ew.value, lost: fmt(lost), wait: fmt(c - Math.min(Number(ns.value), Number(ew.value))) });
    };
    ns.addEventListener('input', sync);
    ew.addEventListener('input', sync);
    sync();
    const apply = () => {
      state.replaceEvents((e) => e.type === 'signal' && e.node === node, { type: 'signal', node, ...greensToPlan({ ns: Number(ns.value), ew: Number(ew.value) }, lost) });
      this.added(nd.signal ? t('Signal timing changed') : t('Signal added'));
      const i = state.scenario.events.length - 1;
      this.edit(i);
    };
    const content = h(
      'div.popup',
      { 'data-testid': 'inspector-junction' },
      h('div.popup-kicker', { dataset: { layer: 'signal' } }, icon('signal', 14), nd.signal ? t('Signalised junction') : t('Junction (no signal)')),
      h('div.popup-title', n.nodeName(node)),
      h('div.popup-meta', t('node #{id} · {m} m elevation', { id: node, m: fmt(nd.elev_m, 0) })),
      h(
        'p.hint',
        nd.signal
          ? t('Now: north–south {ns} s, east–west {ew} s of green per {c} s cycle.', { ns: defGreens.ns, ew: defGreens.ew, c: fmt(cycle) })
          : t('Not signalised in the base network. Applying a timing adds a signal here.'),
      ),
      h('div.row', field(t('North–south green (s)'), ns), field(t('East–west green (s)'), ew)),
      total,
      h(
        'div.popup-actions',
        h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: apply, 'data-testid': 'apply-signal' }, existing ? t('Update timing') : nd.signal ? t('Apply timing') : t('Add signal')),
        existing
          ? h(
              'button.btn.btn-sm',
              {
                type: 'button',
                onclick: () => {
                  state.replaceEvents((e) => e.type === 'signal' && e.node === node, null);
                  this.added(t('Signal timing reverted'));
                },
              },
              t('Revert'),
            )
          : null,
        h(
          'button.btn.btn-ghost.btn-sm',
          {
            type: 'button',
            onclick: () => {
              closePopup();
              state.setTool({ kind: 'add-road', fromNode: node });
              toast(t('Now click the junction where the new road should end'));
            },
          },
          t('New road from here'),
        ),
      ),
    );
    open(this.view.map, n.nodePos(node), content);
  }

  addRoad(from: number, to: number) {
    const n = this.net;
    const b = state.build;
    const cls = h('select', ROAD_CLASSES.map((c) => h('option', { value: c, selected: c === b.roadClass }, roadClassName(c))));
    const lanes = numInput(b.lanes, 1, 6, 1);
    const oneway = h('input', { type: 'checkbox', checked: b.oneway });
    const name = h('input', { type: 'text', value: t('New road'), maxLength: 60 });
    const [a, c] = [n.nodePos(from), n.nodePos(to)];
    const km = Math.hypot((c[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), c[1] - a[1]) * 111.32;
    const add = () => {
      b.roadClass = cls.value;
      b.lanes = Number(lanes.value);
      b.oneway = oneway.checked;
      state.addEvent({ type: 'add_road', from_node: from, to_node: to, road_class: cls.value, lanes: Number(lanes.value), oneway: oneway.checked, name: name.value || undefined });
      state.setTool({ kind: 'select' });
      this.added(t('New road added (structural)'));
    };
    const content = h(
      'div.popup',
      h('div.popup-title', t('New road')),
      h('div.popup-meta', `${n.nodeName(from)} → ${n.nodeName(to)} · ${t('{km} km straight line', { km: fmt(km, 2) })}`),
      h('div.row', field(t('Class'), cls), field(t('Lanes / dir.'), lanes)),
      h('label.check', oneway, ` ${t('One-way (A → B only)')}`),
      field(t('Name'), name),
      h(
        'div.popup-actions',
        h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: add }, t('Add road')),
        h(
          'button.btn.btn-sm',
          {
            type: 'button',
            onclick: () => {
              closePopup();
              state.setTool({ kind: 'select' });
            },
          },
          t('Cancel'),
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
        h('div.popup-title', t('Flood hotspot')),
        h('div', hs.label),
        h('div.popup-meta', `${t(hs.kind)} · ${tn(hs.links.length, '{n} link', '{n} links')} · ${t('observed {d}', { d: hs.observed ?? '–' })}`),
        h('div.popup-meta', `${t('Confidence:')} `, h(`span.badge.conf-${hs.confidence}`, t(hs.confidence))),
        h('p.hint', `${t('Source:')} `, hs.source),
      ),
    );
  }

  /** Scenario item placed on the map (marker or rain zone). */
  marker(index: number, _at?: LngLat) {
    const ev = state.scenario.events[index];
    if (!ev) return;
    const d = this.net.describe(ev);
    state.selection = { event: index };
    state.emit('selection');
    open(
      this.view.map,
      [0, 0],
      h(
        'div.popup',
        h('div.popup-kicker', { dataset: { layer: LAYER_OF[ev.type] ?? 'build' } }, d.structural ? t('Structural change') : t('Scenario item')),
        h('div.popup-title', d.title),
        h('div.popup-meta', d.detail),
        h(
          'div.popup-actions',
          h(
            'button.btn.btn-primary.btn-sm',
            {
              type: 'button',
              onclick: () => {
                closePopup();
                this.edit(index);
              },
            },
            t('Edit'),
          ),
          h(
            'button.btn.btn-danger.btn-sm',
            {
              type: 'button',
              onclick: () => {
                state.removeEvent(index);
                closePopup();
              },
            },
            t('Remove'),
          ),
        ),
      ),
    );
  }

  accident(a: Accident) {
    state.selection = { link: a.link };
    state.emit('selection');
    open(
      this.view.map,
      [0, 0],
      h(
        'div.popup',
        h('div.popup-kicker', { dataset: { layer: 'accident' } }, icon('alert', 14), t('Accident (random)')),
        h('div.popup-title', this.net.linkName(a.link)),
        h('div.popup-meta', `${formatTime(a.from_ms)}–${formatTime(a.to_ms)} · ${t('{p}% of capacity left', { p: Math.round(a.capacity_factor * 100) })}`),
        h('p.hint', t('Drawn at random from the accident rate in the scenario (more likely in rain). Change the rate in Setup → Accidents & incidents.')),
      ),
    );
  }
}

const LAYER_OF: Record<string, string> = { rain: 'rain', signal: 'signal', event: 'event', incident: 'accident', closure: 'accident', accidents: 'accident' };

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
