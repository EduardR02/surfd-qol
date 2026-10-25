// Runs: your history on one map, opened from the menu dock or from the replay
// bar. Organised by what you came to find out: your PB and the map's
// headline numbers, how close each checkpoint has come to beating PB pace,
// your latest attempt, then recent runs to rewatch. Ramps get their own view,
// each one compared against the PB or WR run with the HUD's colours.
import {formatTime, formatDelta, referenceTone} from './hud-model.js';

const ERROR_MS = 6000;
const MAX_METER = 12;
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const svg = (path, box = 16) => `<svg viewBox="0 0 ${box} ${box}" aria-hidden="true"><path d="${path}"/></svg>`;
const PLAY = svg('M5.2 3.3v9.4c0 .5.5.8 1 .5l7.3-4.7a.6.6 0 0 0 0-1L6.2 2.8c-.5-.3-1 0-1 .5z');
const CHEVRON = svg('M4.5 6.5 8 10l3.5-3.5');
const CLOSE = svg('M4 4l8 8M12 4l-8 8');
const fixed = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
// "00:41.233" as a bold whole part and a quieter fraction, the HUD's way.
const clock = seconds => {
  const text = formatTime(seconds), cut = text.lastIndexOf('.');
  return cut > 0 ? `<span>${text.slice(0, cut)}</span><span class="f">${text.slice(cut)}</span>` : `<span>${text}</span>`;
};
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

export const runsLauncherMarkup = `<button id="runs-open" class="launcher" type="button" aria-expanded="false" aria-controls="runs-panel" hidden><span class="rn-glyph" aria-hidden="true"><i></i><i></i><i></i></span>Runs</button>`;

export const runsMarkup = `
<section id="runs-panel" class="rn" role="dialog" aria-labelledby="rn-name" tabindex="-1" hidden>
  <header class="rn-head">
    <button id="rn-map" class="rn-map" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="rn-maps" title="Other maps you’ve played">
      <span id="rn-name">Runs</span>${CHEVRON}
    </button>
    <div class="rn-views" role="tablist" aria-label="Runs or ramps">
      <button id="rn-tab-runs" type="button" role="tab" aria-selected="true" aria-controls="rn-body" data-view="runs">Runs</button>
      <button id="rn-tab-ramps" type="button" role="tab" aria-selected="false" aria-controls="rn-body" data-view="ramps" tabindex="-1">Ramps</button>
    </div>
    <button id="rn-close" class="rn-close" type="button" aria-label="Close runs">${CLOSE}</button>
  </header>
  <div id="rn-maps" class="rn-maps" role="listbox" aria-label="Maps you’ve played" hidden></div>
  <div id="rn-body" class="rn-body" role="tabpanel" tabindex="-1"></div>
  <p id="rn-status" class="rn-status" role="status"></p>
</section>`;

// "Today 19:12" is just "19:12"; older runs show their day.
export function when(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '';
  const date = new Date(at), day = value => new Date(value).toDateString();
  if (day(at) === day(now)) return date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', hour12: false});
  if (day(at) === day(now - 86400000)) return 'Yesterday';
  return date.toLocaleDateString([], {month: 'short', day: 'numeric', ...(new Date(now).getFullYear() !== date.getFullYear() ? {year: 'numeric'} : {})});
}
// How far a run got, in words: Finished, CP2, Stage 3, Before CP1.
export function reached(run) {
  if (run.outcome === 'finished') return 'Finished';
  const count = run.checkpoints ?? 0;
  if (run.kind === 'S') return `Stage ${count + 1}`;
  if (run.totalCheckpoints === 0) return 'Reset';
  return count ? `CP${count}` : 'Before CP1';
}
// A finished run against your PB, the way the HUD tones split deltas: ahead
// is teal, behind is red. Unfinished runs have no time to compare.
export function versusPb(run, pb) {
  if (run?.outcome !== 'finished' || !Number.isFinite(run.time)) return null;
  if (pb && run.id === pb.id) return {text: 'pb', tone: 'pb'};
  if (!Number.isFinite(pb?.time)) return null;
  const ms = Math.round((run.time - pb.time) * 1000);
  return {text: `${ms > 0 ? '+' : ms < 0 ? '−' : '±'}${(Math.abs(ms) / 1000).toFixed(3)}`, tone: ms < 0 ? 'good' : ms > 0 ? 'loss' : 'muted'};
}
// Your best time at each checkpoint against your PB's split there. Teal means
// some run (finished or not) has been ahead of PB pace; rose means the PB itself
// holds that split.
export function paceCells(view) {
  return (view.splits ?? []).map(split => {
    const ms = Number.isFinite(split.time) && Number.isFinite(split.pb) ? Math.round((split.time - split.pb) * 1000) : null;
    return {
      label: split.label, time: split.time, speed: split.speed,
      delta: ms === null ? '' : ms === 0 ? 'pb pace' : `${ms < 0 ? '−' : '+'}${(Math.abs(ms) / 1000).toFixed(3)}`,
      tone: ms === null ? 'muted' : ms < 0 ? 'good' : ms === 0 ? 'pb' : 'loss',
    };
  });
}
// Ramps in route order, grouped by the checkpoint that opens each section.
export function rampSections(view) {
  const sections = new Map();
  for (const ramp of view.ramps ?? []) {
    const index = Number.isInteger(ramp.checkpoint) ? ramp.checkpoint : 0;
    if (!sections.has(index)) sections.set(index, []);
    sections.get(index).push(ramp);
  }
  const name = index => index === 0 ? (view.kind === 'S' ? 'Stage 1' : 'Start') : view.kind === 'S' ? `Stage ${index + 1}` : view.splits?.[index - 1]?.label ?? `CP${index}`;
  return [...sections.keys()].sort((a, b) => a - b).map(index => ({label: name(index), ramps: sections.get(index)}));
}
// One ramp value against the reference: the loss as the HUD shows it (−5.9),
// its tone, and how far it is from the reference in speed (−3.5 means 3.5 u/s
// more lost than the reference).
export function compareRamp(value, reference, tolerance = 0) {
  const known = Number.isFinite(value), compared = known && Number.isFinite(reference);
  return {
    text: known ? formatDelta(-value, 1) : '—',
    diff: compared ? formatDelta(reference - value, 1) : '',
    tone: compared ? referenceTone(value, reference, tolerance) : known ? 'plain' : 'muted',
  };
}

// Each ramp's net Surf loss as a bar. Against a reference the bars diverge
// from the middle: left for speed lost beyond it, right for speed kept. With
// no reference they grow from the left with the loss itself.
export function surfBars(ramps, reference = null, tolerance = 0) {
  const entries = ramps.map(ramp => {
    const own = ramp.surf, other = reference ? reference(ramp) : null;
    if (!Number.isFinite(own) || (reference && !Number.isFinite(other))) return null;
    return reference ? {value: other - own, tone: referenceTone(own, other, tolerance)} : {value: own, tone: 'plain'};
  });
  const scale = Math.max(1e-6, ...entries.filter(Boolean).map(entry => Math.abs(entry.value)));
  return entries.map(entry => entry && {...entry, side: !reference ? 'raw' : entry.value < 0 ? 'left' : 'right', size: Math.abs(entry.value) / scale});
}

// One slanted segment per checkpoint and one for the finish, filled as far as the run got.
function meter(run) {
  const total = Number.isInteger(run.totalCheckpoints) ? run.totalCheckpoints + 1 : null;
  const filled = run.outcome === 'finished' ? total : Math.min((total ?? 1) - 1, run.checkpoints ?? 0);
  if (!total || total > MAX_METER) return `<span class="rn-reach">${escape(reached(run))}</span>`;
  return `<span class="rn-meter${run.outcome === 'finished' ? ' done' : ''}" aria-hidden="true">${Array.from({length: total}, (_, i) => `<i${i < filled ? ' class="on"' : ''}></i>`).join('')}</span>`;
}
function describe(run) {
  if (run.outcome === 'finished') return `Finished in ${formatTime(run.time)}`;
  const total = Number.isInteger(run.totalCheckpoints) ? run.totalCheckpoints : null;
  const word = run.kind === 'S' ? 'stages' : 'checkpoints';
  return total ? `Reset at ${formatTime(run.time)}, after ${run.checkpoints ?? 0} of ${total} ${word}` : `Reset at ${formatTime(run.time)}`;
}
const tags = run => `${run.practice ? '<span class="rn-tag practice" title="Practice runs don’t count for your PB or bests">practice</span>' : ''}${
  run.invalid ? `<span class="rn-tag invalid" title="${escape(typeof run.invalid === 'string' && run.invalid ? `Invalid: ${run.invalid}` : 'Invalid run')}">invalid</span>` : ''}`;

export function createRunsPanel({root, host, history, replays = null, replayControl = null, rampReference = null, settings = {}, onOpen, onOpenSettings, now = () => Date.now()}) {
  const node = id => root.getElementById(id);
  const panel = node('runs-panel'), opener = node('runs-open'), close = node('rn-close');
  const mapButton = node('rn-map'), mapName = node('rn-name'), mapList = node('rn-maps'), body = node('rn-body'), status = node('rn-status');
  const tabs = [...panel.querySelectorAll('[role="tab"]')];
  let key = null, view = 'runs', source = null, busy = null, errorTimer = 0, menu = false, replay = false;
  let unsubscribe = [], rendered = '';

  const watching = () => { try { return replayControl?.status?.()?.run?.id ?? null; } catch { return null; } };
  const canWatch = run => { try { return !!run && !!replayControl?.canWatch?.(run); } catch { return false; } };
  function watchButton(run, label, big = false) {
    if (!run) return '';
    const playing = watching() === run.id, ok = canWatch(run);
    const title = playing ? 'Playing now' : ok ? label : 'This run’s replay wasn’t kept';
    return `<button type="button" class="rn-watch${big ? ' big' : ''}${playing ? ' now' : ''}" data-watch="${escape(run.id)}" aria-label="${escape(title)}" title="${escape(title)}"${ok && !playing ? '' : ' disabled'}${busy === run.id ? ' aria-busy="true"' : ''}>${PLAY}</button>`;
  }

  function overview(data) {
    const pb = data.pb, start = data.start, totals = data.totals ?? {attempts: 0, finishes: 0};
    const stat = (value, label, className = '') => `<div class="rn-stat${className}"><dd>${value}</dd><dt>${label}</dt></div>`;
    const head = `<section class="rn-top">
      <div class="rn-pb${pb ? '' : ' none'}">
        ${pb ? `<div class="rn-pb-line"><b class="rn-pb-time">${clock(pb.time)}</b>${watchButton(pb, 'Watch your PB', true)}</div>
          <div class="rn-pb-meta"><span class="rn-lab">pb</span><span>${escape(when(pb.at, now()))}</span></div>`
          : `<div class="rn-pb-line"><b class="rn-pb-time empty">No finish yet</b></div><div class="rn-pb-meta"><span>Your PB shows here once you finish a run.</span></div>`}
      </div>
      <dl class="rn-stats">
        ${stat(start ? `<b class="rn-spd">${fixed(start.best)}</b>` : '—', 'best start')}
        ${stat(totals.attempts ?? 0, totals.attempts === 1 ? 'attempt' : 'attempts')}
        ${stat(start ? `<b class="rn-spd">${fixed(start.average)}</b>` : '—', 'average start')}
        ${stat(totals.finishes ?? 0, totals.finishes === 1 ? 'finish' : 'finishes')}
      </dl>
    </section>`;
    const cells = paceCells(data);
    const pace = cells.length ? `<section class="rn-pace" aria-labelledby="rn-pace-title">
      <h3 id="rn-pace-title">Best at each checkpoint<span>${pb ? 'against your PB’s splits' : 'no PB to compare with yet'}</span></h3>
      <ol class="rn-cps">${cells.map(cell => `<li class="${cell.tone}" title="${escape(`${cell.label}: best ${formatTime(cell.time)}${Number.isFinite(cell.speed) ? ` at ${Math.round(cell.speed)} u/s` : ''}`)}">
        <i aria-hidden="true"></i><span class="rn-cp">${escape(cell.label)}${Number.isFinite(cell.speed) ? `<b class="rn-spd">${Math.round(cell.speed)}</b>` : ''}</span>
        <b class="rn-cp-time">${clock(cell.time)}</b><em>${escape(cell.delta)}</em></li>`).join('')}</ol>
    </section>` : '';
    const latest = data.latest ? `<section class="rn-latest" aria-label="Latest attempt">
      <h3><i class="rn-dash" aria-hidden="true"></i>Latest attempt</h3>
      ${row(data.latest, pb, true)}
    </section>` : '';
    const recent = data.recent?.length ? `<section class="rn-recent" aria-label="Recent runs">
      <div class="rn-cols" aria-hidden="true"><span>Recent runs</span><span></span><span></span><span>start</span><span>when</span><span></span></div>
      <ol class="rn-list">${data.recent.map(run => `<li>${row(run, pb)}</li>`).join('')}</ol>
    </section>` : '';
    const off = settings.keepHistory === false ? `<div class="rn-off"><span>Recording is off, so new runs aren’t added.</span><button type="button" class="rn-link" data-settings="history">History settings</button></div>` : '';
    return off + head + pace + latest + recent;
  }
  function row(run, pb, latest = false) {
    const versus = versusPb(run, pb);
    const result = versus ? `<span class="rn-res ${versus.tone}">${versus.text}</span>` : `<span class="rn-res reach">${escape(reached(run))}</span>`;
    return `<div class="rn-row${latest ? ' latest' : ''}${watching() === run.id ? ' now' : ''}" title="${escape(describe(run))}">
      <b class="rn-time">${clock(run.time)}</b>
      <span class="rn-what">${run.practice || run.invalid ? tags(run) : result}</span>
      ${meter(run)}
      <span class="rn-start">${run.start ? `<b class="rn-spd">${fixed(run.start.speed, 0)}</b>` : '—'}</span>
      <span class="rn-when">${escape(when(run.at, now()))}</span>
      ${watchButton(run, 'Watch this run')}
    </div>`;
  }

  // Ramps against a reference, which only the map loaded in the game can have.
  function references() {
    if (!rampReference) return [];
    const list = [];
    for (const name of ['pb', 'wr']) {
      let entry = null;
      try { entry = rampReference.get(key, name); } catch { /* unavailable */ }
      if (entry) list.push({name, ...entry});
    }
    return list;
  }
  function ramps(data) {
    const sections = rampSections(data);
    if (!sections.length) return `<div class="rn-empty"><b>No ramps measured yet</b><p>Ramps you board in a recorded run show up here with your best Board, Down and Up on each.</p></div>`;
    const refs = references();
    const preferred = settings.surfColorReference === 'pb' || settings.surfColorReference === 'wr' ? settings.surfColorReference : 'pb';
    const picked = refs.find(ref => ref.name === source) ?? refs.find(ref => ref.name === preferred) ?? refs[0] ?? null;
    const ready = picked?.status === 'ready';
    const net = settings.rampResult === 'total';
    const fields = net ? [['board', 'board'], ['surf', 'surf']] : [['board', 'board'], ['down', 'down'], ['up', 'up']];
    const tolerance = settings.referenceLossTolerance ?? 0;
    const here = history.currentMap === key;
    const note = !here ? `Comparisons need the map loaded in the game. Load ${escape(data.name)} to compare against your PB or the WR.`
      : !refs.length ? 'There’s no PB or WR replay on this map to compare against.'
        : picked.status === 'loading' ? `Reading the ${escape(picked.label)} run…`
          : picked.status === 'missing' ? `The ${escape(picked.label)} run couldn’t be read, so there’s nothing to compare against.` : '';
    const compare = refs.length ? `<div class="rn-seg" role="radiogroup" aria-label="Compare with">${refs.map(ref =>
      `<button type="button" role="radio" aria-checked="${ref === picked}" data-source="${ref.name}">${escape(ref.label)}</button>`).join('')}</div>` : '';
    const legend = ready ? `<p class="rn-legend"><span class="good">at or better than ${escape(picked.label)}</span><span class="warn">within ${fixed(tolerance)} u/s</span><span class="loss">worse</span></p>` : '';
    const cell = (ramp, field) => {
      const reference = ready ? picked.ramps.get(ramp.key)?.[field] : null;
      const value = compareRamp(ramp[field], reference, tolerance);
      const title = Number.isFinite(reference) ? `${picked.label}: ${formatDelta(-reference, 1)}` : '';
      return `<span class="rn-v ${value.tone}" role="cell"${title ? ` title="${escape(title)}"` : ''}><b>${value.text}</b>${value.diff ? `<em>${value.diff}</em>` : ''}</span>`;
    };
    const bars = new Map(surfBars(data.ramps ?? [], ready ? ramp => picked.ramps.get(ramp.key)?.surf : null, tolerance).map((bar, index) => [data.ramps[index], bar]));
    const bar = ramp => {
      const entry = bars.get(ramp);
      return `<span class="rn-bar${ready ? ' vs' : ''}" aria-hidden="true">${entry ? `<i class="${entry.tone} ${entry.side}" style="width:${(entry.size * (ready ? 50 : 100)).toFixed(1)}%"></i>` : ''}</span>`;
    };
    return `<div class="rn-compare"><span class="rn-compare-label">${refs.length ? 'Compare with' : 'Your best on each ramp'}</span>${compare}</div>
      ${note ? `<p class="rn-note">${note}</p>` : legend}
      <div class="rn-ramps${net ? ' net' : ''}" role="table" aria-label="Best ramps">
        <div class="rn-rr rn-rh" role="row"><span role="columnheader"></span><span class="rn-bar-head" role="columnheader">${ready ? `surf vs ${escape(picked.label)}` : 'surf'}</span>${fields.map(([, label]) => `<span role="columnheader">${label}</span>`).join('')}</div>
        ${sections.map(section => `<div class="rn-sec" role="row"><span role="rowheader"><i aria-hidden="true"></i>${escape(section.label)}</span></div>
          ${section.ramps.map(ramp => `<div class="rn-rr" role="row"><span class="rn-name" role="rowheader">${escape(ramp.label)}</span>${bar(ramp)}${fields.map(([field]) => cell(ramp, field)).join('')}</div>`).join('')}`).join('')}
      </div>`;
  }

  function empty() {
    if (settings.keepHistory === false) {
      return `<div class="rn-empty"><b>Run recording is off</b><p>Turn it on and your runs on each map collect here, with replays to rewatch.</p>
        <button type="button" class="rn-cta" data-settings="history">Open History settings</button></div>`;
    }
    const name = key === history.currentMap ? history.currentMapName : null;
    return `<div class="rn-empty"><b>No runs ${name ? `on ${escape(name)} ` : ''}yet</b><p>Your attempts on this map show up here as you play: your PB, your best splits and every ramp.</p></div>`;
  }

  function render(force = false) {
    if (panel.hidden) return;
    let data = null;
    try { data = key ? history.view(key) : null; } catch { /* unavailable */ }
    const maps = safeMaps();
    write(mapName, data?.name ?? maps.find(map => map.key === key)?.name ?? (key && key === history.currentMap ? history.currentMapName : null) ?? 'Runs');
    mapButton.disabled = maps.length < (data ? 2 : 1);
    for (const tab of tabs) {
      const selected = tab.dataset.view === view;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.disabled = !data;
    }
    panel.classList.toggle('blank', !data);
    const html = !data ? empty() : view === 'ramps' ? ramps(data) : overview(data);
    if (!force && html === rendered) return;
    rendered = html;
    const scroll = body.scrollTop;
    body.innerHTML = html;
    body.scrollTop = scroll;
  }
  const write = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  function safeMaps() { try { return history.maps() ?? []; } catch { return []; } }

  function renderMaps() {
    const maps = safeMaps(), current = history.currentMap;
    mapList.innerHTML = maps.map(map => `<button type="button" role="option" data-map="${escape(map.key)}" aria-selected="${map.key === key}">
      <span class="rn-map-name">${map.key === current ? '<i class="rn-here" title="Loaded in the game"></i>' : ''}${escape(map.name)}</span>
      <span class="rn-map-meta">${plural(map.runs, 'run')}</span><span class="rn-map-meta">${escape(when(map.at, now()))}</span></button>`).join('');
  }
  function toggleMaps(show = mapList.hidden) {
    if (show && mapButton.disabled) return;
    mapList.hidden = !show;
    mapButton.setAttribute('aria-expanded', String(show));
    if (show) { renderMaps(); (mapList.querySelector('[aria-selected="true"]') ?? mapList.firstElementChild)?.focus(); }
  }
  function showError(text) {
    write(status, text);
    status.classList.add('error');
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { write(status, ''); status.classList.remove('error'); }, ERROR_MS);
  }

  async function watch(id) {
    if (busy) return;
    let data = null;
    try { data = history.view(key); } catch { /* unavailable */ }
    const run = [data?.pb, data?.latest, ...(data?.recent ?? [])].find(entry => entry?.id === id);
    if (!run || !replayControl) return;
    busy = id;
    render(true);
    try {
      await replayControl.watch(run);
      busy = null;
      closePanel();
    } catch (error) {
      busy = null;
      showError(error?.message || 'The replay didn’t start.');
      render(true);
    }
  }

  body.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.watch) watch(target.dataset.watch);
    else if (target.dataset.settings) onOpenSettings?.(target.dataset.settings);
    else if (target.dataset.source) { source = target.dataset.source; render(); }
  });
  for (const tab of tabs) tab.addEventListener('click', () => { view = tab.dataset.view; toggleMaps(false); render(); body.scrollTop = 0; });
  mapButton.addEventListener('click', () => toggleMaps());
  mapList.addEventListener('click', event => {
    const target = event.target.closest('[data-map]');
    if (!target) return;
    key = target.dataset.map;
    toggleMaps(false);
    mapButton.focus();
    render();
    body.scrollTop = 0;
  });

  function subscribe() {
    const update = () => render();
    for (const source of [history, replays, rampReference]) {
      try { const stop = source?.subscribe?.(update); if (typeof stop === 'function') unsubscribe.push(stop); } catch { /* optional */ }
    }
  }
  function openPanel(mapKey, anchor = null) {
    onOpen?.();
    key = mapKey ?? key ?? history.currentMap ?? safeMaps()[0]?.key ?? null;
    if (key && !history.view?.(key)) key = history.currentMap && history.view(history.currentMap) ? history.currentMap : safeMaps()[0]?.key ?? key;
    // Over a replay the panel sits at the right edge just above the replay bar, clear of the HUD; in menus, above the dock.
    panel.classList.toggle('over-replay', !!anchor);
    if (anchor) {
      panel.style.setProperty('--rn-bottom', `${Math.round(innerHeight - anchor.top + 12)}px`);
    }
    if (panel.hidden) { panel.hidden = false; subscribe(); }
    opener.setAttribute('aria-expanded', 'true');
    rendered = '';
    render(true);
    panel.focus({preventScroll: true});
  }
  function closePanel(focus = false) {
    if (panel.hidden) return;
    panel.hidden = true;
    toggleMaps(false);
    for (const stop of unsubscribe) stop();
    unsubscribe = [];
    opener.setAttribute('aria-expanded', 'false');
    rendered = '';
    if (focus && menu) opener.focus();
  }
  opener.addEventListener('click', () => { if (!panel.hidden) closePanel(true); else openPanel(history.currentMap); });
  close.addEventListener('click', () => closePanel(true));

  return {
    get open() { return !panel.hidden; },
    close: closePanel,
    // Where the panel can be: in menus from the dock; during a replay from the replay bar.
    setContext(next) {
      menu = !!next.menu; replay = !!next.replay;
      if (opener.hidden === menu) opener.hidden = !menu;
      if (!panel.hidden && !menu && !(replay && panel.classList.contains('over-replay'))) closePanel();
      if (!panel.hidden && menu && panel.classList.contains('over-replay')) closePanel();
    },
    show(mapKey, anchor) { openPanel(mapKey, anchor); },
    toggle(mapKey, anchor) { if (!panel.hidden) closePanel(); else openPanel(mapKey, anchor); },
    showMaps() { if (!panel.hidden) toggleMaps(true); },
    showView(next) { view = next === 'ramps' ? 'ramps' : 'runs'; render(true); },
    handleKey(event) {
      if (panel.hidden) return;
      const inside = event.composedPath().includes(panel);
      if (event.type === 'keydown' && event.code === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!mapList.hidden) { toggleMaps(false); mapButton.focus(); } else closePanel(true);
        return;
      }
      const index = tabs.indexOf(event.composedPath()[0]);
      if (event.type === 'keydown' && index !== -1 && (event.code === 'ArrowLeft' || event.code === 'ArrowRight')) {
        event.preventDefault();
        const next = tabs[(index + 1) % tabs.length];
        view = next.dataset.view;
        render();
        next.focus();
      }
      // Keep the panel's keystrokes out of the game's handlers.
      if (inside) event.stopPropagation();
    },
    destroy() { closePanel(); clearTimeout(errorTimer); },
  };
}
