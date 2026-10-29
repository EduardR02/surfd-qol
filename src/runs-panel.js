// Runs: your history on one map, opened from the menu dock or from the replay
// bar. Organised by what you came to find out: your PB and the map's
// headline numbers, how close each checkpoint has come to beating PB pace,
// your latest attempt, then recent runs to rewatch. Ramps get their own view,
// each one compared against the PB or WR run with the HUD's colours.
import {formatTime, formatDelta, formatSplitDelta, referenceTone} from './hud-model.js';
import {mapKey} from './run-history.js';
import {analysisKey, referenceIdentity, sessionKey} from './references.js';

const ERROR_MS = 6000;
const MAX_METER = 12;
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const svg = (path, box = 16) => `<svg viewBox="0 0 ${box} ${box}" aria-hidden="true"><path d="${path}"/></svg>`;
// Optically centred: the triangle's box sits a little right of centre, its centroid a hair left.
const PLAY = svg('M5.2 3.9v8.2c0 .48.53.77.94.52l6.5-4.1a.62.62 0 0 0 0-1.04l-6.5-4.1c-.41-.25-.94.04-.94.52z');
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
// Native own is scoped to the loaded map/version; historical maps only have
// their locally recorded best finish. Both carry cumulative checkpoint times.
export function bestFinish(data, {key = data?.key, session = null, refs = null} = {}) {
  const own = refs?.own;
  if (session?.map && key === mapKey(session.map) && referenceIdentity(own)) {
    const at = typeof own.createdAt === 'string' ? Date.parse(own.createdAt) : own.createdAt;
    return {official: true, label: 'PB', runId: own.runId, time: own.timeUs / 1e6, at, splitsUs: own.splitsUs};
  }
  return data?.pb ? {...data.pb, official: false, label: 'Best finish'} : null;
}
// A finished run against your PB, the way the HUD tones split deltas: ahead
// is teal, behind is red. Unfinished runs have no time to compare.
export function versusPb(run, pb) {
  if (run?.outcome !== 'finished' || !Number.isFinite(run.time)) return null;
  if (!Number.isFinite(pb?.time)) return null;
  const delta = formatSplitDelta(run.time, Math.round(pb.time * 1e6));
  if (!pb.official && run.id != null && run.id === pb.id) return {...delta, text: 'best'};
  return delta;
}
// Compare the displayed best checkpoint with the displayed finish's split,
// never an unrelated local finish's split when the header shows a native PB.
export function paceCells(view, best = bestFinish(view)) {
  return (view.splits ?? []).map(split => {
    const referenceUs = best?.official
      ? Number.isInteger(split.index) && split.index >= 0 ? best.splitsUs[split.index] : null
      : best && Number.isFinite(split.pb) ? Math.round(split.pb * 1e6) : null;
    const delta = formatSplitDelta(split.time, referenceUs);
    return {
      label: split.label, time: split.time, speed: split.speed,
      delta: delta?.text ?? '', tone: delta?.tone ?? 'muted',
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

// The statistic a touch value shows for each of the Ramps view's modes.
const TOUCH_STAT = {best: 'best', recent: 'last10', average: 'avg'};
// Touch stats are firm once a map has this many runs; they show from the first.
export const TOUCH_MIN_RUNS = 50;
// How much steeper than the reference an angle can be and still count as near.
export const ANGLE_NEAR = 0.5;
// Reach rounds down, so 100% means every run got there.
export const reachText = reach => Number.isFinite(reach) ? `${Math.floor(reach * 100 + 1e-9)}%` : '—';

// One touch's reach, speed in, speed out and angle for a statistic, each
// against the reference touch when there is one. Speed is better higher and
// graded with the u/s margin; the angle is better lower, near within ANGLE_NEAR.
export function touchCells(touch, mode = 'best', reference = null, tolerance = 0) {
  const stat = TOUCH_STAT[mode] ?? 'best';
  const pick = field => Number.isFinite(touch?.[field]?.[stat]) ? touch[field][stat] : null;
  const speedIn = pick('speedIn'), speedOut = pick('speedOut'), angle = pick('angle');
  const plain = value => value === null ? 'muted' : 'plain';
  const speed = (value, other) => {
    const compared = value !== null && Number.isFinite(other);
    return {value, text: value === null ? '—' : value.toFixed(0), diff: compared ? formatDelta(value - other, 0) : '',
      tone: compared ? referenceTone(-value, -other, tolerance) : plain(value)};
  };
  const reach = Number.isFinite(touch?.reach) ? touch.reach : null;
  const other = reference?.angle, compared = angle !== null && Number.isFinite(other);
  return {
    reach: {value: reach, text: reachText(reach), diff: '', tone: plain(reach)},
    speedIn: speed(speedIn, reference?.speedIn),
    speedOut: speed(speedOut, reference?.speedOut),
    angle: {value: angle, text: angle === null ? '—' : `${angle.toFixed(1)}°`, diff: compared ? `${formatDelta(angle - other, 1)}°` : '',
      tone: compared ? referenceTone(angle, other, ANGLE_NEAR) : plain(angle)},
  };
}

// Bars share one scale per metric: the largest value within three times the
// median, never under a floor (5 u/s, 1°). A bail far past the rest then runs
// off the end with a break instead of shrinking every other bar to a sliver.
export function barScale(values, floor = 5) {
  const sizes = values.filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
  if (!sizes.length) return floor;
  const cap = 3 * sizes[Math.floor((sizes.length - 1) / 2)];
  return Math.max(floor, ...sizes.filter(size => size <= cap));
}
export function scaleBars(entries, floor = 5) {
  const scale = barScale(entries.map(entry => entry.bar), floor);
  return entries.map(entry => {
    const size = Math.abs(entry.bar ?? 0) / scale;
    return {...entry, size: Math.min(1, size), over: size > 1};
  });
}

// What the Ramps view's one column can show for every ramp: [key, label, what it is].
export const RAMP_METRICS = [['surf', 'Surf', 'The whole ramp, touch included'], ['board', 'Touch', 'Speed lost as you touched the ramp'],
  ['angle', 'Angle', 'How far your path was off the ramp’s surface. 0° loses nothing'], ['down', 'Down', 'The way down, touch included'],
  ['up', 'Up', 'The way up'], ['speedIn', 'In', 'Speed as you touched the ramp'], ['speedOut', 'Out', 'Speed right after the touch']];
const TOUCH_METRICS = new Set(['angle', 'speedIn', 'speedOut']);

// One ramp's value for a metric: its difference from the reference when the
// reference has it, else the value itself. Losses and the angle are better
// lower, speeds higher. `bar` is what its bar measures.
export function rampMetric(metric, {ramp = null, reference = null, touch = null, touchReference = null, mode = 'best', tolerance = 0, compared = false} = {}) {
  let own, value, other, ref;
  if (TOUCH_METRICS.has(metric)) {
    const cell = touchCells(touch, mode, compared ? touchReference : null, tolerance)[metric];
    own = cell.value; other = touchReference?.[metric]; value = cell;
    ref = Number.isFinite(other) ? metric === 'angle' ? `${other.toFixed(1)}°` : other.toFixed(0) : '';
  } else {
    own = Number.isFinite(ramp?.[metric]) ? ramp[metric] : null; other = reference?.[metric];
    value = compareRamp(own, other, tolerance);
    ref = Number.isFinite(other) ? formatDelta(-other, 1) : '';
  }
  if (own === null) return {text: '—', tone: 'muted', bar: null, you: '', ref: ''};
  if (!compared) return {text: value.text, tone: 'plain', bar: own, you: value.text, ref: ''};
  if (!value.diff) return {text: '', tone: 'muted', bar: null, absent: true, you: value.text, ref: ''};
  return {text: value.diff, tone: value.tone, bar: TOUCH_METRICS.has(metric) ? own - other : other - own, you: value.text, ref};
}

// The open ramp's measurements against the reference: Touch with its angle,
// Surf with Down and Up, then the speeds into and out of the touch. Only the
// difference is graded.
export function detailRows({ramp, reference = null, touch = null, touchReference = null, mode = 'best', tolerance = 0, split = true}) {
  const loss = (label, field, sub = false) => {
    const other = reference?.[field], value = compareRamp(ramp?.[field], other, tolerance);
    return {label, sub, you: value.text, ref: Number.isFinite(other) ? formatDelta(-other, 1) : '—', diff: value.diff, tone: value.diff ? value.tone : 'muted'};
  };
  const cells = touch ? touchCells(touch, mode, touchReference, tolerance) : null;
  const measured = (label, cell, other, sub = false) => ({label, sub, you: cell.text, ref: other, diff: cell.diff, tone: cell.diff ? cell.tone : 'muted'});
  return [
    loss('Touch', 'board'),
    ...cells ? [measured('angle', cells.angle, Number.isFinite(touchReference?.angle) ? `${touchReference.angle.toFixed(1)}°` : '—', true)] : [],
    loss('Surf', 'surf'),
    ...split ? [loss('down', 'down', true), loss('up', 'up', true)] : [],
    ...cells ? [measured('Speed in', cells.speedIn, fixed(touchReference?.speedIn, 0)), measured('Speed out', cells.speedOut, fixed(touchReference?.speedOut, 0))] : [],
  ];
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
const tags = run => `${run.practice ? '<span class="rn-tag practice" title="Practice runs don’t count for your bests">practice</span>' : ''}${
  run.invalid ? `<span class="rn-tag invalid" title="${escape(typeof run.invalid === 'string' && run.invalid ? `Invalid: ${run.invalid}` : 'Invalid run')}">invalid</span>` : ''}`;

export function createRunsPanel({root, host, history, replays = null, replayControl = null, rampReference = null, getSession = () => null, getReferences = () => null, settings = {}, onSettings = null, onOpen, onOpenSettings, now = () => Date.now()}) {
  const node = id => root.getElementById(id);
  const panel = node('runs-panel'), opener = node('runs-open'), close = node('rn-close');
  const mapButton = node('rn-map'), mapName = node('rn-name'), mapList = node('rn-maps'), body = node('rn-body'), status = node('rn-status');
  const tabs = [...panel.querySelectorAll('[role="tab"]')];
  const rampConsumer = rampReference?.createConsumer();
  let key = null, view = 'runs', source = null, busy = null, errorTimer = 0, menu = false, replay = false;
  let unsubscribe = [], rendered = '', watchRequest = 0, replayCache = null, referenceContext = '', referenceSession = null;
  let rampMode = 'best', expandedRamp = null, playbackSource = null, confirmReset = false, resetting = false;
  let expiryTimer = 0, expiryAt = null, comparisonSlot = null, navigationContext = null;

  function scheduleExpiry(run) {
    const at = Number.isFinite(run?.expiresAt) ? run.expiresAt : null;
    if (at === expiryAt) return;
    clearTimeout(expiryTimer);
    expiryAt = at;
    if (at !== null && at > now()) expiryTimer = setTimeout(() => {
      expiryAt = null;
      render();
    }, Math.min(2147483647, at - now() + 1));
  }

  function rampContext() {
    try {
      const session = getSession(), refs = getReferences();
      // Native Watch adopts replay-format labels without changing movement.
      const movement = Object.keys(session?.config ?? {}).filter(name => name !== 'version' && name !== 'unrestrictedStart')
        .sort().map(name => [name, session.config[name]]);
      return JSON.stringify([key, session?.map?.id, session?.map?.version, movement, refs?.boardId, refs?.ownerKey,
        referenceIdentity(refs?.own), referenceIdentity(refs?.record), settings.wrSource, settings.surfColorReference]);
    } catch { return null; }
  }
  function cancelRampNavigation() {
    if (!busy?.startsWith('ramp:')) return;
    rampConsumer?.release();
    busy = null;
    navigationContext = null;
    comparisonSlot = null;
    watchRequest++;
  }

  function currentBest(data) {
    try { return bestFinish(data, {key, session: getSession(), refs: getReferences()}); }
    catch { return bestFinish(data); }
  }

  // One raw replay at most, scoped to its real board/map/account identity.
  // Native Watch replaces Session even when it watches the very same run.
  function replayIdentity() {
    try {
      const session = getSession(), refs = getReferences(), identity = referenceIdentity(refs?.own);
      return session?.map && identity ? JSON.stringify([sessionKey(session, refs?.boardId), refs?.ownerKey ?? 'guest', identity]) : null;
    } catch { return null; }
  }
  function syncReplayCache() {
    const identity = replayIdentity();
    if (replayCache?.identity !== identity) replayCache = null;
    return identity;
  }

  const watching = () => { try { return replayControl?.status?.()?.run?.id ?? null; } catch { return null; } };
  const canWatch = run => { try { return !!run && !!replayControl?.canWatch?.(run); } catch { return false; } };
  function watchButton(run, label, big = false) {
    if (!run) return '';
    const id = run.official ? `official-pb:${run.runId}` : run.id;
    const playing = !run.official && watching() === run.id;
    const ok = run.official ? typeof replayControl?.watchLoaded === 'function' : canWatch(run);
    const title = playing ? 'Playing now' : ok ? label : 'This run’s replay wasn’t kept';
    return `<button type="button" class="rn-watch${big ? ' big' : ''}${playing ? ' now' : ''}" data-watch="${escape(id)}" aria-label="${escape(title)}" title="${escape(title)}"${ok && !playing && busy !== id ? '' : ' disabled'}${busy === id ? ' aria-busy="true"' : ''}>${PLAY}</button>`;
  }

  function overview(data) {
    const pb = currentBest(data), start = data.start, totals = data.totals ?? {attempts: 0, finishes: 0};
    const stat = (value, label, className = '') => `<div class="rn-stat${className}"><dd>${value}</dd><dt>${label}</dt></div>`;
    const head = `<section class="rn-top">
      <div class="rn-pb${pb ? '' : ' none'}">
        ${pb ? `<div class="rn-pb-line"><b class="rn-pb-time">${clock(pb.time)}</b>${watchButton(pb, `Watch your ${pb.label}`, true)}</div>
          <div class="rn-pb-meta"><span class="rn-lab">${pb.label}</span><span>${escape(when(pb.at, now()))}</span></div>`
          : `<div class="rn-pb-line"><b class="rn-pb-time empty">No finish yet</b></div><div class="rn-pb-meta"><span>Your best finish shows here once you finish a recorded run.</span></div>`}
      </div>
      <dl class="rn-stats">
        ${stat(start ? `<b class="rn-spd">${fixed(start.best)}</b>` : '—', 'best start')}
        ${stat(totals.attempts ?? 0, totals.attempts === 1 ? 'attempt' : 'attempts')}
        ${stat(start ? `<b class="rn-spd" title="Leaves out clipped starts: you landed back in the start zone, so the game blocked your hop.">${fixed(start.average)}</b>` : '—', 'average start')}
        ${stat(totals.finishes ?? 0, totals.finishes === 1 ? 'finish' : 'finishes')}
      </dl>
    </section>`;
    const cells = paceCells(data, pb);
    const pace = cells.length ? `<section class="rn-pace" aria-labelledby="rn-pace-title">
      <h3 id="rn-pace-title">Best at each checkpoint<span>${pb ? `against your ${pb.official ? 'PB' : 'best finish'}’s splits` : 'no best finish to compare with yet'}</span></h3>
      <ol class="rn-cps">${cells.map(cell => `<li class="${cell.tone}" title="${escape(`${cell.label}: best ${formatTime(cell.time)}${Number.isFinite(cell.speed) ? ` at ${Math.round(cell.speed)} u/s` : ''}`)}">
        <i aria-hidden="true"></i><span class="rn-cp">${escape(cell.label)}${Number.isFinite(cell.speed) ? `<b class="rn-spd">${Math.round(cell.speed)}</b>` : ''}</span>
        <b class="rn-cp-time">${clock(cell.time)}</b><em>${escape(cell.delta)}</em></li>`).join('')}</ol>
    </section>` : '';
    // Your form right now: the newest attempt, and the fastest finish of the last 24 h.
    const recentBest = data.recentBest, same = recentBest && data.latest?.id === recentBest.id;
    const latest = data.latest || recentBest ? `<section class="rn-latest" aria-label="Latest attempt and recent best">
      ${data.latest ? `<h3><i class="rn-dash" aria-hidden="true"></i>Latest attempt${same ? '<span class="rn-also">also your best in the last 24 h</span>' : ''}</h3>
      ${row(data.latest, pb, true)}` : ''}
      ${recentBest && !same ? `<h3 class="rn-sub"><i class="rn-dash" aria-hidden="true"></i>Best finish in the last 24 h</h3>
      ${row(recentBest, pb, true)}` : ''}
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
    try { return rampReference?.sources(key) ?? []; } catch { return []; }
  }
  const RAMP_MODES = [['best', 'Best', 'Your best on each ramp'], ['recent', 'Last 10', 'Mean of your last 10 valid runs on each ramp.'],
    ['average', 'Average', 'Mean of every valid run since you last reset.']];
  // One toolbar: what to show (left) and what to compare it with (right).
  // Below it, one caption line: what the statistic means, and Reset for the means.
  function rampControls(compare = '', metric = null) {
    const [, , note] = RAMP_MODES.find(([mode]) => mode === rampMode);
    const asking = confirmReset ? `<div class="rn-reset-confirm" role="group" aria-label="Reset ramp averages">
        <span>Start Last 10 and Average over on this map? <small>Bests and replays stay.</small></span>
        <button type="button" class="rn-reset" data-reset-averages="cancel"${resetting ? ' disabled' : ''}>Cancel</button>
        <button type="button" class="rn-reset danger" data-reset-averages="confirm"${resetting ? ' disabled' : ''}>${resetting ? 'Resetting…' : 'Reset'}</button></div>` : '';
    return `<div class="rn-toolbar"><div class="rn-seg" role="radiogroup" aria-label="Ramp statistic">${RAMP_MODES.map(([mode, label, title]) =>
      `<button type="button" role="radio" aria-checked="${rampMode === mode}" tabindex="${rampMode === mode ? 0 : -1}" data-ramp-mode="${mode}" title="${title}">${label}</button>`).join('')}</div>
      ${compare ? `<span class="rn-vs">vs</span>${compare}` : ''}${metric ? `<div class="rn-seg rn-metric" role="radiogroup" aria-label="Show for each ramp">${RAMP_METRICS.map(([name, label, title]) =>
        `<button type="button" role="radio" aria-checked="${metric === name}" tabindex="${metric === name ? 0 : -1}" data-ramp-metric="${name}" title="${escape(title)}">${label}</button>`).join('')}</div>` : ''}</div>
      ${asking || (rampMode === 'best' ? '' : `<p class="rn-caption rn-samples"><span>${note}</span><button type="button" class="rn-reset" data-reset-averages="ask"${resetting ? ' disabled' : ''}>Reset</button></p>`)}`;
  }
  function playbackReason(data, rampKey, destination, refs, selected, picked) {
    if (destination === 'recentBest') {
      const run = data.recentBest;
      if (!run) return 'No recent best in the last 24h';
      if (!canWatch(run)) return 'Recent best replay unavailable';
      return run.boards?.some(([tick, , key]) => key === rampKey && Number.isInteger(tick) && tick >= (run.replay?.offset ?? 0)) ? '' : 'This ramp is absent from Recent best';
    }
    if (destination === 'pb' && !refs.some(ref => ref.name === 'pb')) {
      const best = currentBest(data);
      if (best && !best.official) {
        if (!canWatch(best)) return 'PB replay unavailable';
        return best.boards?.some(([tick, , key]) => key === rampKey && Number.isInteger(tick) && tick >= (best.replay?.offset ?? 0)) ? '' : 'This ramp is absent from PB';
      }
    }
    const ref = refs.find(entry => entry.name === destination);
    if (!ref || !rampConsumer?.watchRamp) return `${destination === 'pb' ? 'PB' : 'WR'} replay unavailable on this map`;
    if (selected?.name === destination) {
      if (picked?.status === 'missing') return `${ref.label} replay unavailable`;
      if (picked?.status === 'ready' && !Number.isInteger(picked.ramps.get(rampKey)?.tick)) return `This ramp is absent from ${ref.label}`;
    }
    return '';
  }
  // The replays a ramp can be watched in, by name.
  function destinations(data, refs) {
    const best = currentBest(data);
    const pbLabel = refs.find(ref => ref.name === 'pb')?.label ?? (best && !best.official ? 'Best finish' : 'PB');
    return [['pb', pbLabel], ['wr', refs.find(ref => ref.name === 'wr')?.label ?? 'WR'], ['recentBest', 'Recent best']];
  }
  function rampPlayback(data, ramp, refs, selected, picked, choices) {
    const pending = busy === `ramp:${ramp.key}`;
    const chips = choices.map(([name, label]) => {
      const reason = playbackReason(data, ramp.key, name, refs, selected, picked);
      return {reason, html: `<button type="button" class="rn-chip" data-ramp-watch="${escape(ramp.key)}" data-play-source="${name}" aria-label="${escape(reason ? `${label}: ${reason}` : `Watch ${ramp.label} in ${label}`)}" title="${escape(reason || `Watch ${ramp.label} in ${label}`)}"${reason || pending ? ' disabled' : ''}${pending && playbackSource === name ? ' aria-busy="true"' : ''}><i class="rn-tri" aria-hidden="true"></i>${escape(label)}</button>`};
    });
    const missing = chips.filter(chip => chip.reason).map(chip => chip.reason);
    return `<div class="rn-ramp-play" role="group" aria-label="Watch ${escape(ramp.label)} in another replay">
      ${chips.map(chip => chip.html).join('')}
      <span class="rn-play-note">${escape(missing.length ? `${missing.join('. ')}.` : 'Starts just before the ramp, paused.')}</span>
    </div>`;
  }
  function ramps(data) {
    const sections = rampSections(data);
    if (!sections.length) {
      rampConsumer?.release();
      return rampControls() + `<div class="rn-empty"><b>No ramps measured yet</b><p>Ramps you touch in a recorded run show up here with your Touch, Down and Up measurements.</p></div>`;
    }
    const refs = references();
    const preferred = settings.surfColorReference === 'pb' || settings.surfColorReference === 'wr' ? settings.surfColorReference : 'pb';
    const selected = refs.find(ref => ref.name === source) ?? refs.find(ref => ref.name === preferred) ?? refs[0] ?? null;
    let picked = null;
    // Navigation owns the consumer until its selected replay has loaded. A
    // subscription render must not swap it back to the comparison source.
    const navigating = busy?.startsWith('ramp:');
    if (navigating) picked = comparisonSlot?.key === key && comparisonSlot.source === selected?.name ? comparisonSlot.slot : null;
    else {
      try { picked = selected ? rampConsumer?.get(key, selected.name) : null; } catch { /* unavailable */ }
      comparisonSlot = {key, source: selected?.name, slot: picked};
      if (!picked) rampConsumer?.release();
    }
    const ready = picked?.status === 'ready';
    const net = settings.rampResult === 'total';
    const tolerance = settings.referenceLossTolerance ?? 0;
    const here = history.currentMap === key;
    const note = !here ? `Comparisons need the map loaded in the game. Load ${escape(data.name)} to compare against your PB or the WR.`
      : !refs.length ? 'There’s no PB or WR replay on this map to compare against.'
        : picked?.status === 'loading' ? `Reading the ${escape(picked.label)} run…`
          : picked?.status === 'missing' ? `The ${escape(picked.label)} run couldn’t be read, so there’s nothing to compare against.` : '';
    const compare = refs.length ? `<div class="rn-seg" role="radiogroup" aria-label="Compare with">${refs.map(ref =>
      `<button type="button" role="radio" aria-checked="${ref === selected}" tabindex="${ref === selected ? 0 : -1}" data-source="${ref.name}">${escape(ref.label)}</button>`).join('')}</div>` : '';
    const metric = RAMP_METRICS.some(([name]) => name === settings.rampMetric) ? settings.rampMetric : 'surf';
    const legend = ready ? `<p class="rn-legend"><span class="good">at or better than ${escape(picked.label)}</span><span class="warn">within ${metric === 'angle' ? `${ANGLE_NEAR}°` : `${fixed(tolerance)} u/s`}</span><span class="loss">worse</span></p>` : '';
    const counted = rampMode !== 'best';
    const referenceOf = ramp => ready ? picked.ramps.get(ramp.key) ?? null : null;
    // How many runs back a Last 10 or Average row: the most any of its values has.
    const samples = ramp => Math.max(0, ...['board', 'down', 'up', 'surf'].map(field => ramp.counts?.[field] ?? 0));
    const choices = destinations(data, refs);
    let touchData = null;
    try { touchData = history.touchStats?.(key) ?? null; } catch { /* unavailable */ }
    const touches = touchData ? new Map((touchData.touches ?? []).map(touch => [touch.key, touch])) : null;
    const [, metricLabel, metricHelp] = RAMP_METRICS.find(([name]) => name === metric);
    const values = scaleBars((data.ramps ?? []).map(ramp => {
      const touch = touches?.get(ramp.key) ?? null;
      return rampMetric(metric, {ramp, reference: referenceOf(ramp), touch, touchReference: ready ? touch?.[selected.name] ?? null : null, mode: rampMode, tolerance, compared: ready});
    }), metric === 'angle' ? 1 : 5);
    const heroes = new Map(values.map((value, index) => [data.ramps[index], value]));
    const detail = ramp => {
      const touch = touches?.get(ramp.key) ?? null, reach = touch ? reachText(touch.reach) : '—';
      const rows = detailRows({ramp, reference: referenceOf(ramp), touch, touchReference: ready ? touch?.[selected.name] ?? null : null,
        mode: rampMode, tolerance, split: !net});
      const count = samples(ramp);
      const line = [counted ? count ? plural(count, 'run') : 'No runs yet' : '', reach !== '—' ? `reached in ${reach} of runs` : ''].filter(Boolean).join(' · ');
      return `<div class="rn-detail" role="row"><div id="rn-play-${escape(encodeURIComponent(ramp.key))}" class="rn-detail-in" role="cell">
        <div class="rn-x${ready ? '' : ' solo'}" role="table" aria-label="${escape(`${ramp.label}${ready ? ` against ${picked.label}` : ''}`)}">
          <div class="rn-xr rn-xh" role="row"><span role="columnheader"></span><span role="columnheader">You</span>${ready ? `<span role="columnheader">${escape(picked.label)}</span><span role="columnheader">Δ</span>` : ''}</div>
          ${rows.map(row => `<div class="rn-xr${row.sub ? ' sub' : ''}" role="row"><span role="rowheader">${row.label}</span><b role="cell">${row.you}</b>${
            ready ? `<span role="cell">${row.ref}</span><b role="cell" class="${row.tone}">${row.diff || ''}</b>` : ''}</div>`).join('')}
        </div>
        ${line ? `<p class="rn-x-note">${line.charAt(0).toUpperCase()}${line.slice(1)}</p>` : ''}
        ${rampPlayback(data, ramp, refs, selected, picked, choices)}
      </div></div>`;
    };
    const rampRow = ramp => {
      const open = expandedRamp === ramp.key, hero = heroes.get(ramp), touch = touches?.get(ramp.key);
      const reach = touch && Number.isFinite(touch.reach) ? reachText(touch.reach) : '';
      const title = hero.you ? `${metricHelp}: ${hero.you}${hero.ref ? `. ${picked.label}: ${hero.ref}` : ''}` : 'No measurement yet';
      return `<div class="rn-rr${open ? ' open' : ''}" role="row" data-ramp="${escape(ramp.key)}"><span class="rn-name" role="rowheader">${escape(ramp.label)}</span>
        <span class="rn-rch" role="cell"${reach ? ` title="${escape(`Reached in ${reach} of your runs`)}"` : ''}>${reach}</span>
        <span class="rn-bar" aria-hidden="true">${hero.size ? `<i class="${hero.tone}${hero.over ? ' over' : ''}" style="width:${(hero.size * 100).toFixed(1)}%"></i>` : ''}</span>
        <span class="rn-hero ${hero.tone}" role="cell" title="${escape(title)}">${hero.absent ? `not in ${escape(picked.label)}` : hero.text}</span>
        <span role="cell"><button type="button" class="rn-more" data-ramp="${escape(ramp.key)}" aria-expanded="${open}"${
        open ? ` aria-controls="rn-play-${escape(encodeURIComponent(ramp.key))}"` : ''} aria-label="${escape(`${ramp.label}: details and other replays`)}" title="Details and other replays">${CHEVRON}</button></span></div>${open ? detail(ramp) : ''}`;
    };
    const runCount = Math.max(0, Math.min(TOUCH_MIN_RUNS, touchData?.runs ?? 0)), filled = Math.floor(runCount / TOUCH_MIN_RUNS * 10);
    const collecting = touchData?.collecting ? `<p class="rn-caption rn-collect"><span class="rn-meter" aria-hidden="true">${
      Array.from({length: 10}, (_, i) => `<i${i < filled ? ' class="on"' : ''}></i>`).join('')}</span><span>Collecting touch stats: ${runCount} of ${TOUCH_MIN_RUNS} runs. Reach firms up as runs come in.</span></p>` : '';
    return rampControls(compare, metric) + collecting + `${note ? `<p class="rn-note">${note}</p>` : legend}
      <div class="rn-ramps" role="table" aria-label="Ramp measurements">
        <div class="rn-rr rn-rh" role="row"><span role="columnheader"></span><span role="columnheader">${touches ? 'reach' : ''}</span><span class="rn-metric-head" role="columnheader">${metricLabel}${ready ? ` vs ${escape(picked.label)}` : ''}</span><span role="columnheader"></span></div>
        ${sections.map(section => `<div class="rn-sec" role="row"><span role="rowheader"><i aria-hidden="true"></i>${escape(section.label)}</span></div>
          ${section.ramps.map(rampRow).join('')}`).join('')}
      </div>`;
  }

  function empty() {
    if (settings.keepHistory === false) {
      return `<div class="rn-empty"><b>Run recording is off</b><p>Turn it on and your runs on each map collect here, with replays to rewatch.</p>
        <button type="button" class="rn-cta" data-settings="history">Open History settings</button></div>`;
    }
    const name = key === history.currentMap ? history.currentMapName : null;
    return `<div class="rn-empty"><b>No runs ${name ? `on ${escape(name)} ` : ''}yet</b><p>Your attempts on this map show up here as you play: your best finish, your best splits and every ramp.</p></div>`;
  }

  function render(force = false) {
    if (panel.hidden || busy && replayControl?.adopting) return;
    if (replayCache) syncReplayCache();
    if (navigationContext && navigationContext !== rampContext()) cancelRampNavigation();
    let data = null;
    try { data = key ? history.view(key, {rampMode}) : null; } catch { /* unavailable */ }
    scheduleExpiry(data?.recentBest);
    if (!data && currentBest(null)?.official) data = {name: history.currentMapName, splits: [], recent: [], ramps: []};
    if (!data || view !== 'ramps') rampConsumer?.release();
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
    const scroll = body.scrollTop, active = root.activeElement;
    const focused = active && body.contains?.(active) ? {...active.dataset} : null;
    body.innerHTML = html;
    if (focused && Object.keys(focused).length) {
      const buttons = [...body.querySelectorAll('button')];
      const replacement = buttons.find(button =>
        Object.entries(focused).every(([name, value]) => button.dataset[name] === value))
        ?? (focused.resetAverages ? buttons.find(button => button.dataset.resetAverages === 'ask') : null);
      replacement?.focus({preventScroll: true});
    }
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
    if (busy === id || !replayControl) return;
    let data = null;
    try { data = history.view(key); } catch { /* unavailable */ }
    const best = currentBest(data);
    const run = best?.official && id === `official-pb:${best.runId}` ? best
      : [data?.pb, data?.recentBest, data?.latest, ...(data?.recent ?? [])].find(entry => entry?.id === id);
    if (!run) return;
    const request = ++watchRequest, expectedKey = key;
    const expectedOwner = getReferences()?.ownerKey;
    const ownsRequest = () => request === watchRequest && key === expectedKey && !panel.hidden &&
      getReferences()?.ownerKey === expectedOwner;
    let isCurrent = () => true;
    busy = id;
    render(true);
    try {
      if (run.official) {
        const session = getSession(), refs = getReferences(), identity = syncReplayCache();
        isCurrent = () => key === expectedKey && getSession() === session && mapKey(session.map) === expectedKey &&
          replayIdentity() === identity;
        if (!identity) throw new Error('The personal best changed. Choose the run again.');
        replayCache ??= {identity, promise: null};
        const cache = replayCache;
        await replayControl.watchLoaded(async () => {
          if (!isCurrent()) throw new Error('The personal best changed. Choose the run again.');
          cache.promise ??= Promise.resolve().then(() => refs.loadReplay(run.runId)).catch(error => { cache.promise = null; throw error; });
          const replay = await cache.promise;
          if (!isCurrent()) throw new Error('The personal best changed. Choose the run again.');
          return replay;
        }, {title: `Your PB on ${data?.name ?? history.currentMapName ?? 'this map'} · ${formatTime(run.time)}`,
          isCurrent: adopted => ownsRequest() && (adopted || isCurrent()),
          // The PB's analysis (shared with the ramp comparisons) marks its ramp boards.
          analysis: referenceIdentity(refs?.own) ? {key: `${analysisKey(session, refs?.boardId)}:official:${referenceIdentity(refs.own)}`,
            entry: {runId: refs.own.runId, timeUs: refs.own.timeUs, splitsUs: refs.own.splitsUs.slice()}} : null});
      } else {
        await replayControl.watch(run, {isCurrent: ownsRequest});
      }
      if (request !== watchRequest || key !== expectedKey) return;
      busy = null;
      closePanel();
    } catch (error) {
      if (request !== watchRequest || key !== expectedKey) return;
      busy = null;
      if (isCurrent()) showError(error?.message || 'The replay didn’t start.');
      render(true);
    }
  }

  async function watchRamp(rampKey) {
    if (panel.hidden || view !== 'ramps' || busy || !replayControl) return;
    const data = history.view(key, {rampMode}), refs = references();
    if (!data) return;
    const preferred = settings.surfColorReference === 'wr' ? 'wr' : 'pb';
    const selected = refs.find(ref => ref.name === source) ?? refs.find(ref => ref.name === preferred) ?? refs[0];
    const destination = playbackSource ?? selected?.name ?? 'pb';
    const picked = selected ? rampConsumer?.get(key, selected.name) : null;
    const reason = playbackReason(data, rampKey, destination, refs, selected, picked);
    if (reason) { showError(reason); return; }
    const expectedKey = key, request = ++watchRequest;
    const expectedContext = navigationContext = rampContext();
    const expectedOwner = getReferences()?.ownerKey;
    busy = `ramp:${rampKey}`;
    render(true);
    try {
      const options = {leadSeconds: 0.5, paused: true};
      const local = destination === 'recentBest' ? data.recentBest
        : destination === 'pb' && !refs.some(ref => ref.name === 'pb') ? currentBest(data) : null;
      const result = local
        ? await replayControl.watch(local, {rampKey, ...options, isCurrent: adopted =>
          request === watchRequest && key === expectedKey && !panel.hidden && view === 'ramps' &&
          (adopted ? getReferences()?.ownerKey === expectedOwner : rampContext() === expectedContext)})
        : await rampConsumer.watchRamp(key, destination, rampKey, replayControl, options);
      if (request !== watchRequest || key !== expectedKey) return;
      busy = null; navigationContext = null;
      if (result === false) { showError('This ramp is unavailable in that replay.'); render(true); }
      else closePanel();
    } catch (error) {
      if (request !== watchRequest || key !== expectedKey) return;
      busy = null; navigationContext = null;
      showError(error?.message || 'The ramp replay didn’t start.');
      render(true);
    }
  }
  async function resetAverages(action) {
    if (resetting) return;
    if (action !== 'confirm') { confirmReset = action === 'ask'; render(); return; }
    if (!confirmReset) return;
    const expectedKey = key;
    resetting = true;
    render();
    try {
      await history.resetRampAverages(expectedKey);
      if (key === expectedKey && !panel.hidden) {
        confirmReset = false;
        write(status, 'Ramp averages reset. Bests and replays kept.');
        status.classList.remove('error');
      }
    } catch (error) {
      if (key === expectedKey && !panel.hidden) showError(error?.message || 'Averages could not be reset.');
    } finally {
      resetting = false;
      render();
    }
  }

  body.addEventListener('click', event => {
    const target = event.target.closest('button');
    // A ramp's whole row opens it; its chevron is the same toggle for the keyboard.
    if (!target) {
      const row = event.target.closest('.rn-rr[data-ramp]');
      if (row) { cancelRampNavigation(); expandedRamp = expandedRamp === row.dataset.ramp ? null : row.dataset.ramp; playbackSource = null; render(); }
      return;
    }
    if (target.dataset.watch) return watch(target.dataset.watch);
    // A chip names its replay and plays it in one click.
    if (target.dataset.rampWatch && 'playSource' in target.dataset) {
      cancelRampNavigation();
      playbackSource = target.dataset.playSource || null;
      return watchRamp(target.dataset.rampWatch);
    }
    else if (target.dataset.settings) onOpenSettings?.(target.dataset.settings);
    else if (target.dataset.source) { cancelRampNavigation(); source = target.dataset.source; playbackSource = null; render(); }
    else if (target.dataset.rampMode) { rampMode = target.dataset.rampMode; render(); }
    else if (target.dataset.rampMetric) {
      if (onSettings) onSettings({rampMetric: target.dataset.rampMetric});
      else settings.rampMetric = target.dataset.rampMetric;
      render();
    }
    else if (target.dataset.resetAverages) return resetAverages(target.dataset.resetAverages);
    else if (target.dataset.ramp) { cancelRampNavigation(); expandedRamp = expandedRamp === target.dataset.ramp ? null : target.dataset.ramp; playbackSource = null; render(); }
    else if (target.dataset.playSource) { cancelRampNavigation(); playbackSource = target.dataset.playSource; render(); }
    else if (target.dataset.rampWatch) return watchRamp(target.dataset.rampWatch);
  });
  for (const tab of tabs) tab.addEventListener('click', () => { cancelRampNavigation(); rampConsumer?.release(); view = tab.dataset.view; toggleMaps(false); render(); body.scrollTop = 0; });
  mapButton.addEventListener('click', () => toggleMaps());
  mapList.addEventListener('click', event => {
    const target = event.target.closest('[data-map]');
    if (!target) return;
    rampConsumer?.release();
    key = target.dataset.map;
    expandedRamp = null; playbackSource = null; confirmReset = false;
    busy = null; watchRequest++;
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
    if (key && !history.view?.(key) && !currentBest(null)?.official) key = history.currentMap && history.view(history.currentMap) ? history.currentMap : safeMaps()[0]?.key ?? key;
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
    rampConsumer?.release();
    clearTimeout(expiryTimer); expiryAt = null;
    confirmReset = false; expandedRamp = null; playbackSource = null;
    navigationContext = null; comparisonSlot = null;
    if (panel.hidden) return;
    panel.hidden = true;
    referenceSession = null;
    busy = null; watchRequest++;
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
      if (busy && replayControl?.adopting) return;
      if (replayCache && !panel.hidden) syncReplayCache();
      if (!panel.hidden && !menu && !(replay && panel.classList.contains('over-replay'))) closePanel();
      if (!panel.hidden && menu && panel.classList.contains('over-replay')) closePanel();
      if (!panel.hidden) {
        const session = getSession(), refs = getReferences();
        const context = JSON.stringify([key, replayIdentity(), refs?.own?.createdAt, refs?.boardId, refs?.ownerKey,
          referenceIdentity(refs?.record), rampReference?.version(), settings.surfColorReference, settings.wrSource]);
        if (context !== referenceContext || session !== referenceSession) {
          referenceContext = context; referenceSession = session; render();
        }
      }
    },
    show(mapKey, anchor) { openPanel(mapKey, anchor); },
    toggle(mapKey, anchor) { if (!panel.hidden) closePanel(); else openPanel(mapKey, anchor); },
    showMaps() { if (!panel.hidden) toggleMaps(true); },
    showView(next) { cancelRampNavigation(); rampConsumer?.release(); view = next === 'ramps' ? 'ramps' : 'runs'; render(true); },
    handleKey(event) {
      if (panel.hidden) return;
      const inside = event.composedPath().includes(panel);
      if (event.type === 'keydown' && event.code === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!mapList.hidden) { toggleMaps(false); mapButton.focus(); } else closePanel(true);
        return;
      }
      if (inside && event.type === 'keydown') {
        const target = event.composedPath()[0]?.closest?.('[role="radio"]');
        const group = target?.closest('[role="radiogroup"]');
        if (group && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          const buttons = [...group.querySelectorAll('[role="radio"]')], index = buttons.indexOf(target);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
          event.preventDefault();
          event.stopPropagation();
          buttons[next].focus();
          buttons[next].click();
          return;
        }
      }
      const index = tabs.indexOf(event.composedPath()[0]);
      if (event.type === 'keydown' && index !== -1 && (event.code === 'ArrowLeft' || event.code === 'ArrowRight')) {
        event.preventDefault();
        const next = tabs[(index + 1) % tabs.length];
        cancelRampNavigation();
        rampConsumer?.release();
        view = next.dataset.view;
        render();
        next.focus();
      }
      // Keep the panel's keystrokes out of the game's handlers.
      if (inside) event.stopPropagation();
    },
    destroy() { closePanel(); rampConsumer?.destroy(); replayCache = null; referenceSession = null; clearTimeout(errorTimer); },
  };
}
