# Design system — Hanoi traffic what-if

The web app is a **map-first scenario builder**: the user sets up a scenario (where it
rains, how traffic lights are timed, what events and accidents happen), then presses
**Run simulation** and reads the result on the map, the timeline and the results card.
This document is the reference for every screen and component. Code lives in `web/src`
(vanilla TypeScript + `h()` DOM helper, MapLibre + deck.gl); tokens are CSS custom
properties at the top of `web/src/style.css`.

Basis: the *Data-Dense Dashboard* style and *Analytics Dashboard / Government* palettes
from the ui-ux-pro-max design-intelligence catalogue, adapted to a GIS planning tool.
Rejected from the generic recommendation: pink/marketplace palettes, emoji icons,
decorative gradients, glassmorphism.

---

## 1. Principles

1. **Set up, then run.** Editing never starts a run by itself (unless the user switches
   on *Live update*). The status chip always tells whether the result matches the setup.
2. **Draw where it happens.** Anything with a place (rain zone, event venue, incident,
   signal, new road, housing) is created on the map with a tool, then fine-tuned in the
   side panel or the inspector. Forms never ask for coordinates or ids.
3. **One colour per scenario layer.** Rain is blue, signals amber, events violet,
   accidents/incidents red, road works/growth teal. The same colour marks the section
   header, its list items, its map overlay and its timeline marks.
4. **Plain units people know.** Rain in mm/h with words (light … very heavy); signals in
   green seconds per direction, not split ratios; accidents per hour; times as HH:MM.
5. **Honest results.** Every number says what it is compared with (baseline or control)
   and that it comes from a 5 % sample of a simplified model.
6. **Data density without clutter.** Collapsible sections with count badges; details on
   demand (inspector, tooltips); nothing decorative.

## 2. Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Top bar: brand · scenario name · Examples ▾ · status chip · Live ◻ · Share ·  │
│          Clear · [▶ Run simulation]                                          │
├──────────────┬───────────────────────────────────────────────────────────────┤
│ Side panel   │ Map                                                           │
│ (400 px)     │ ┌────┐                                    ┌───────────────┐   │
│ Tabs:        │ │tool│  ← floating tool rail              │ Inspector     │   │
│ Setup        │ │rail│                                    │ (selected     │   │
│ Results      │ └────┘                                    │  road/junction│   │
│ Advanced     │          tool banner (while drawing)      │  /zone)       │   │
│ About        │ Legend (bottom-left, collapsible)          └───────────────┘   │
│              ├───────────────────────────────────────────────────────────────┤
│              │ Timeline: play · time · speed · delay chart (+ rain, accidents)│
└──────────────┴───────────────────────────────────────────────────────────────┘
```

- **Top bar** (56 px): global actions only. The Run button is the single primary
  call-to-action of the app (amber, right-most).
- **Side panel → Setup**: accordion of scenario sections (§5). **Results**: progress,
  summary card, warnings. **Advanced**: full parameter registry. **About**: model notes,
  sources, licences.
- **Map tool rail** (left edge of the map, vertical): Select, Rain zone, Event venue,
  New road, Housing, Jobs. Shows the keyboard shortcut in the tooltip.
- **Inspector** (right side of the map, 340 px, floating card): replaces map popups.
  Shows the selected object and its editors. Closes with × or Esc.
- **Timeline** (132 px): playback and the network-delay chart; rain is drawn as bars
  hanging from the top, accidents as red ticks.
- Below 760 px wide: map on top, panel below; top bar wraps; inspector becomes a bottom
  sheet.

## 3. Tokens

### Colour — UI

| Token | Value | Use |
|---|---|---|
| `--bg` | `#F8FAFC` | app background |
| `--surface` | `#FFFFFF` | panels, cards, inspector |
| `--surface-2` | `#F1F5F9` | section headers, inputs at rest, table stripes |
| `--border` | `#E2E8F0` | dividers, card borders |
| `--border-strong` | `#CBD5E1` | inputs, segmented controls |
| `--text` | `#0F172A` | body text (contrast 17:1 on white) |
| `--muted` | `#475569` | secondary text (7.5:1) |
| `--faint` | `#94A3B8` | placeholders, disabled |
| `--primary` | `#1D4ED8` | links, focus ring, selected tab, active tool |
| `--primary-hover` | `#1E40AF` | |
| `--primary-soft` | `#DBEAFE` | selected backgrounds |
| `--cta` | `#F59E0B` | Run simulation (text `#111827` on it) |
| `--cta-hover` | `#D97706` | |
| `--danger` | `#B91C1C` | destructive actions, errors |
| `--better` / `--worse` | `#15803D` / `#B91C1C` | result deltas (always with a sign) |

### Colour — scenario layers

| Layer | Token | Solid | Soft (backgrounds) | Map |
|---|---|---|---|---|
| Rain / flooding | `--c-rain` | `#0284C7` | `#E0F2FE` | zone fill `rgba(2,132,199, 0.10–0.40)` by intensity, 2 px outline |
| Traffic signals | `--c-signal` | `#D97706` | `#FEF3C7` | amber junction markers |
| Events | `--c-event` | `#7C3AED` | `#EDE9FE` | violet venue markers |
| Accidents & incidents | `--c-accident` | `#DC2626` | `#FEE2E2` | red road overlay / dots while active |
| Road works & growth | `--c-build` | `#0F766E` | `#CCFBF1` | teal road overlay / markers |

Traffic colours (congestion ramp, diverging difference ramp, vehicles) are defined in
`web/src/logic/colors.ts` and are not reused for UI chrome.

### Typography

- UI: **Fira Sans** (fallback `system-ui`), 14 px base, line-height 1.5.
- Numbers, times, ids, parameter keys: **Fira Code** / `ui-monospace` with
  `font-variant-numeric: tabular-nums`.
- Scale: 11 (caption) · 12 (meta) · 13 (controls) · 14 (body) · 16 (section) · 20 (time
  readout) · 24 (metric value). Weights 400 / 500 / 600 / 700.

### Space, radius, elevation, motion

- Spacing scale 4 · 8 · 12 · 16 · 24 · 32 px.
- Radius: 6 px controls, 10 px cards, 999 px chips.
- Shadows: `--shadow-sm` for cards on the map; `--shadow-lg` for inspector and menus.
- Z-index scale: map 0 · map overlays 10 · tool rail/legend 20 · inspector 30 ·
  top bar 40 · toast 50 · modal 60.
- Motion 150–200 ms ease-out for hover/expand; no motion on the map except the user's
  own fly-to. Respect `prefers-reduced-motion`.

## 4. Components

| Component | Notes |
|---|---|
| **Button** | `btn` (secondary, bordered), `btn-primary` (blue), `btn-cta` (amber, Run only), `btn-ghost`, `btn-danger`; sizes default 36 px / `btn-sm` 30 px. Icon + label; icon-only buttons need `aria-label` and a tooltip. Disabled while running. |
| **Status chip** | `Baseline` (grey), `Draft` (changes not run), `Running 42 %` (blue), `Up to date` (green), `Outdated` (amber: setup changed since the result), `Failed` (red). |
| **Section (accordion)** | Header: layer-colour icon tile, title, count badge, chevron. Body: short hint, list, add buttons. |
| **Item card** | Left colour bar = layer colour; title + one-line detail; inline editors for the important numbers; actions *Show on map* and *Remove* on the right. |
| **Slider row** | Label · range input · live value with unit and a word (e.g. “60 mm/h · very heavy”). Commit on `change`, preview on `input`. |
| **Segmented control** | 2–4 mutually exclusive options (flood model, severity). |
| **Number input** | `input[type=number]` with unit suffix; clamps to range. |
| **Profile chart** | Bar editor for rain over time (30-min bars 05:00–13:00); drag to paint. Used inside a rain zone card as *Custom profile*. |
| **Tool rail button** | 40 × 40 px, icon, `aria-pressed`, tooltip “Rain zone (R)”. Active = primary-soft background + primary icon. |
| **Tool banner** | Dark pill at the top of the map with the current step (“Click to add points · Enter or double-click to finish · Backspace undo · Esc cancel”) and Finish / Cancel buttons. |
| **Inspector** | Title, meta line, then editors grouped with `details` blocks; primary action at the bottom. |
| **Result card** | Two big metrics (total delay, mean trip time) with signed % vs reference, then a compact stats table; sample-scaling note. |
| **Toast** | Bottom-centre of the map, 3 s, for confirmations and errors (errors also stay in the panel). |

## 5. Scenario setup (Setup tab)

Sections, in this order (all collapsible, count badge = number of items):

1. **Weather & flooding** (rain colour)
   - *+ Citywide rain* and *Draw rain zone* (map tool). Each rain becomes a zone card:
     name, intensity slider (0–150 mm/h with words), start time, duration, optional
     *Custom profile* chart. Zones can overlap (the heaviest applies).
   - One *Flooding* control for the whole scenario: No flooding / Flood points /
     Drainage model.
2. **Traffic signals** (signal colour)
   - Global cycle length (parameter `signal.cycle_s`).
   - Junction search (signalised junctions by street names) and “click a junction on
     the map”.
   - Edited junctions list: green seconds north–south and east–west, the resulting cycle,
     *Revert*.
3. **Events** (event colour) — *Place event on map*; each event card edits people and
   arrival window.
4. **Accidents & incidents** (accident colour)
   - *Random accidents*: on/off, accidents per hour, how long each blocks the road,
     severity (capacity left), time window; rain makes them more likely (parameter
     `accidents.rain_multiplier`).
   - *Incidents & closures* placed by clicking a road (inspector).
5. **Road works & city growth** (build colour, marked *structural*) — new road, housing,
   jobs tools; road removals/changes from the inspector; population growth slider.

The footer of the Setup tab shows the comparison mode (“Sudden change — compared with
the baseline” / “Structural — compared with a control run”).

## 6. Interaction patterns

- **Polygon drawing (rain zone)**: click adds a vertex; click the first vertex, press
  Enter, double-click or *Finish* to close (≥ 3 points); Backspace removes the last
  vertex; Esc cancels. Double-click zoom is disabled while drawing. The new zone card
  is opened in Setup.
- **Placing points** (event, housing, jobs): one click places, then the tool returns to
  Select.
- **Selecting** a road / junction / marker / zone opens the inspector; the selected
  object is outlined on the map.
- **Keyboard**: V select · R rain zone · E event · Esc cancel/close · Space play/pause ·
  Ctrl/⌘+Enter run.
- **Run**: Run button → status chip shows progress → Results tab opens on completion →
  map switches to *Difference*. Editing after that marks the result *Outdated*.
- **Live update** (off by default): re-runs sudden scenarios 0.6 s after each edit.
- **Share**: the scenario is always encoded in the URL hash; Share copies the link.

## 7. Accessibility

- Text contrast ≥ 4.5:1 (body text ≥ 7:1); never encode meaning by colour alone — every
  coloured item also has an icon and a label; deltas carry a sign.
- All controls are native elements with labels; icon-only buttons have `aria-label`.
- Visible focus ring (2 px primary) on every focusable element.
- Tabs use `role=tablist/tab/tabpanel`; segmented controls use `role=radiogroup/radio`.
- Touch targets ≥ 32 px (40 px on the tool rail).
- Live regions: status chip and toast are `aria-live=polite`.

## 8. Do / don’t

| Do | Don’t |
|---|---|
| Use the layer colour consistently (panel, map, timeline) | Re-use traffic ramp colours for UI |
| Put the place-based setup on the map | Ask users for node ids, link ids or coordinates |
| Show units and words (“60 mm/h · very heavy”) | Show raw ratios (0.35) without explanation |
| One amber CTA (Run) | Several competing primary buttons |
| SVG line icons (Lucide style) | Emoji as icons |
| Explain the comparison reference next to every result | Present results as forecasts |

## 9. Checklist for new UI

- [ ] Uses tokens (no hard-coded colours except map layer RGB arrays mirroring them).
- [ ] Belongs to a layer → uses that layer’s colour and icon everywhere.
- [ ] Place-based input is created on the map, editable afterwards.
- [ ] Labels, units, ranges and error messages are present.
- [ ] Keyboard reachable; focus visible; works at 1280 × 800 and on a 390 px phone.
- [ ] Editing marks the result *Outdated*; nothing runs unless Run (or Live update).
- [ ] `data-testid` on the controls exercised by `web/e2e`.
