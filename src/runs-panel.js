// Runs: your history on one map, opened from the menu dock or from the replay
// bar. Organised by what you came to find out: your PB and the map's
// headline numbers, how close each checkpoint has come to beating PB pace,
// your latest attempt, then recent runs to rewatch. Ramps get their own view,
// each one compared against the PB or WR run with the HUD's colours.
import {formatTime, formatDelta, formatSplitDelta, referenceTone} from './hud-model.js';
import {mapKey} from './run-history.js';
import {referenceIdentity, sessionKey} from './references.js';

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
const tags = run => `${run.practice ? '<span class="rn-tag practice" title="Practice runs don’t count for your bests">practice</span>' : ''}${
  run.invalid ? `<span class="rn-tag invalid" title="${escape(typeof run.invalid === 'string' && run.invalid ? `Invalid: ${run.invalid}` : 'Invalid run')}">invalid</span>` : ''}`;

export function createRunsPanel({root, host, history, replays = null, replayControl = null, rampReference = null, getSession = () => null, getReferences = () => null, settings = {}, onOpen, onOpenSettings, now = () => Date.now()}) {
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
        ${stat(start ? `<b class="rn-spd">${fixed(start.average)}</b>` : '—', 'average start')}
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
  function rampControls(compare = '') {
    const [, , note] = RAMP_MODES.find(([mode]) => mode === rampMode);
    const asking = confirmReset ? `<div class="rn-reset-confirm" role="group" aria-label="Reset ramp averages">
        <span>Start Last 10 and Average over on this map? <small>Bests and replays stay.</small></span>
        <button type="button" class="rn-reset" data-reset-averages="cancel"${resetting ? ' disabled' : ''}>Cancel</button>
        <button type="button" class="rn-reset danger" data-reset-averages="confirm"${resetting ? ' disabled' : ''}>${resetting ? 'Resetting…' : 'Reset'}</button></div>` : '';
    return `<div class="rn-toolbar"><div class="rn-seg" role="radiogroup" aria-label="Ramp statistic">${RAMP_MODES.map(([mode, label, title]) =>
      `<button type="button" role="radio" aria-checked="${rampMode === mode}" tabindex="${rampMode === mode ? 0 : -1}" data-ramp-mode="${mode}" title="${title}">${label}</button>`).join('')}</div>
      ${compare ? `<span class="rn-vs">vs</span>${compare}` : ''}</div>
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
  // A ramp's name plays it straight away in the compared replay; its chevron
  // opens the other replays it can be watched in, each one click away.
  function rampName(data, ramp, refs, selected, picked, choices) {
    const destination = selected?.name ?? 'pb', name = choices.find(([entry]) => entry === destination)?.[1] ?? 'PB';
    const reason = playbackReason(data, ramp.key, destination, refs, selected, picked);
    const pending = busy === `ramp:${ramp.key}`;
    const label = reason ? `${ramp.label}: ${reason}` : `Watch ${ramp.label} in ${name}, from just before it`;
    return `<button type="button" class="rn-name${reason ? ' off' : ''}" data-ramp-watch="${escape(ramp.key)}" data-play-source="" aria-label="${escape(label)}" title="${escape(label)}"${pending ? ' aria-busy="true"' : ''}><i class="rn-tri" aria-hidden="true"></i>${escape(ramp.label)}</button>`;
  }
  function rampPlayback(data, ramp, refs, selected, picked, choices) {
    if (expandedRamp !== ramp.key) return '';
    const pending = busy === `ramp:${ramp.key}`;
    const chips = choices.map(([name, label]) => {
      const reason = playbackReason(data, ramp.key, name, refs, selected, picked);
      return {reason, html: `<button type="button" class="rn-chip" data-ramp-watch="${escape(ramp.key)}" data-play-source="${name}" aria-label="${escape(reason ? `${label}: ${reason}` : `Watch ${ramp.label} in ${label}`)}" title="${escape(reason || `Watch ${ramp.label} in ${label}`)}"${reason || pending ? ' disabled' : ''}${pending && playbackSource === name ? ' aria-busy="true"' : ''}><i class="rn-tri" aria-hidden="true"></i>${escape(label)}</button>`};
    });
    const missing = chips.filter(chip => chip.reason).map(chip => chip.reason);
    return `<div id="rn-play-${escape(encodeURIComponent(ramp.key))}" class="rn-ramp-play" role="group" aria-label="Watch ${escape(ramp.label)} in another replay">
      ${chips.map(chip => chip.html).join('')}
      <span class="rn-play-note">${escape(missing.length ? `${missing.join('. ')}.` : 'Starts just before the ramp, paused.')}</span>
    </div>`;
  }
  function ramps(data) {
    const sections = rampSections(data);
    if (!sections.length) {
      rampConsumer?.release();
      return rampControls() + `<div class="rn-empty"><b>No ramps measured yet</b><p>Ramps you board in a recorded run show up here with your Board, Down and Up measurements.</p></div>`;
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
    const fields = net ? [['board', 'board'], ['surf', 'surf']] : [['board', 'board'], ['down', 'down'], ['up', 'up']];
    const tolerance = settings.referenceLossTolerance ?? 0;
    const here = history.currentMap === key;
    const note = !here ? `Comparisons need the map loaded in the game. Load ${escape(data.name)} to compare against your PB or the WR.`
      : !refs.length ? 'There’s no PB or WR replay on this map to compare against.'
        : picked?.status === 'loading' ? `Reading the ${escape(picked.label)} run…`
          : picked?.status === 'missing' ? `The ${escape(picked.label)} run couldn’t be read, so there’s nothing to compare against.` : '';
    const compare = refs.length ? `<div class="rn-seg" role="radiogroup" aria-label="Compare with">${refs.map(ref =>
      `<button type="button" role="radio" aria-checked="${ref === selected}" tabindex="${ref === selected ? 0 : -1}" data-source="${ref.name}">${escape(ref.label)}</button>`).join('')}</div>` : '';
    const legend = ready ? `<p class="rn-legend"><span class="good">at or better than ${escape(picked.label)}</span><span class="warn">within ${fixed(tolerance)} u/s</span><span class="loss">worse</span></p>` : '';
    const counted = rampMode !== 'best';
    const cell = (ramp, field, label) => {
      const reference = ready ? picked.ramps.get(ramp.key)?.[field] : null;
      const value = compareRamp(ramp[field], reference, tolerance);
      const count = ramp.counts?.[field] ?? 0;
      const title = [counted ? `${label} from ${count} valid run${count === 1 ? '' : 's'}` : '',
        Number.isFinite(reference) ? `${picked.label}: ${formatDelta(-reference, 1)}` : ''].filter(Boolean).join('. ');
      return `<span class="rn-v ${value.tone}" role="cell"${title ? ` title="${escape(title)}"` : ''}><b>${value.text}</b>${value.diff ? `<em>${value.diff}</em>` : ''}</span>`;
    };
    const bars = new Map(surfBars(data.ramps ?? [], ready ? ramp => picked.ramps.get(ramp.key)?.surf : null, tolerance).map((bar, index) => [data.ramps[index], bar]));
    const bar = ramp => {
      const entry = bars.get(ramp);
      return `<span class="rn-bar${ready ? ' vs' : ''}" aria-hidden="true">${entry ? `<i class="${entry.tone} ${entry.side}" style="width:${(entry.size * (ready ? 50 : 100)).toFixed(1)}%"></i>` : ''}</span>`;
    };
    // How many runs back a Last 10 or Average row: the most any of its values has.
    const samples = ramp => counted ? Math.max(0, ...fields.map(([field]) => ramp.counts?.[field] ?? 0)) : null;
    const choices = destinations(data, refs);
    const rampRow = ramp => {
      const open = expandedRamp === ramp.key, count = samples(ramp);
      const runs = count === null ? '' : `<small class="rn-n">${count ? `${count} run${count === 1 ? '' : 's'}` : 'no runs yet'}</small>`;
      return `<div class="rn-rr${open ? ' open' : ''}" role="row"><span class="rn-namecell" role="rowheader">${rampName(data, ramp, refs, selected, picked, choices)}${runs}</span>${bar(ramp)}${
        fields.map(([field, label]) => cell(ramp, field, label)).join('')}<span role="cell"><button type="button" class="rn-more" data-ramp="${escape(ramp.key)}" aria-expanded="${open}"${
        open ? ` aria-controls="rn-play-${escape(encodeURIComponent(ramp.key))}"` : ''} aria-label="Watch ${escape(ramp.label)} in another replay" title="Other replays">${CHEVRON}</button></span></div>${rampPlayback(data, ramp, refs, selected, picked, choices)}`;
    };
    return rampControls(compare) + `${note ? `<p class="rn-note">${note}</p>` : legend}
      <div class="rn-ramps${net ? ' net' : ''}" role="table" aria-label="Ramp measurements">
        <div class="rn-rr rn-rh" role="row"><span role="columnheader"></span><span class="rn-bar-head" role="columnheader">surf${ready ? `<span class="rn-bar-reference"> vs ${escape(picked.label)}</span>` : ''}</span>${fields.map(([, label]) => `<span role="columnheader">${label}</span>`).join('')}<span role="columnheader"></span></div>
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
          isCurrent: adopted => ownsRequest() && (adopted || isCurrent())});
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
    if (!target) return;
    if (target.dataset.watch) return watch(target.dataset.watch);
    // A ramp name or chip names its replay ('' = the compared one) and plays it in one click.
    if (target.dataset.rampWatch && 'playSource' in target.dataset) {
      cancelRampNavigation();
      playbackSource = target.dataset.playSource || null;
      return watchRamp(target.dataset.rampWatch);
    }
    else if (target.dataset.settings) onOpenSettings?.(target.dataset.settings);
    else if (target.dataset.source) { cancelRampNavigation(); source = target.dataset.source; playbackSource = null; render(); }
    else if (target.dataset.rampMode) { rampMode = target.dataset.rampMode; render(); }
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
