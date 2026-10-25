// Run history: a compact record per run plus each map's bests. Observes the
// live session after every tick (after metrics and start feedback). Runs and
// bests are saved one record each in IndexedDB (createHistoryStore), so
// ending a run writes only that run and its map's bests.
import {visitKey} from './replay-store.js';

// Maps whose recent runs are kept; bests are kept for every map.
const MAX_MAPS = 50;
const MAX_RUNS = 2000;
const MAX_RAMPS = 120;
const RAMP_FIELDS = ['board', 'down', 'up', 'surf'];
const RECENT_BEST_MS = 24 * 60 * 60 * 1000;
const endEvents = new Set(['restart', 'start-return', 'practice-restore']);
// About 15 minutes of ticks since the last restart; longer is not kept as a replay.
const MAX_REPLAY_COMMANDS = 60000;
// Saved replays keep this much before the run left the start; idle time
// before it is trimmed (replay-trim.js).
export const LEAD_SECONDS = 5;
// A trim must remove at least this much; shorter waits are kept as they are,
// so the usual restart-and-go run costs nothing.
const MIN_TRIM_SECONDS = 5;
// The furthest a fallback trim point may be from the start (the check
// simulates from there to the start).
const MAX_TRIM_CHECK_SECONDS = 30;
// Pre-start player states, one every SNAPSHOT_TICKS, reaching back further than LEAD_SECONDS.
const SNAPSHOT_TICKS = 16;
const SNAPSHOT_COUNT = 40;
// Fallback trim points: moments of standing fully still (which also clears the
// game's start-zone hop counters), at most one a second, reaching back further.
const STILL_SPACING = 66;
const STILL_COUNT = 64;

const round = (value, digits = 1) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const validRun = run => run && typeof run.id === 'string' && typeof run.map === 'string' && Number.isFinite(run.at) &&
  Number.isFinite(run.time) && (run.outcome === 'finished' || run.outcome === 'reset') && Array.isArray(run.checkpoints);
const validBests = record => record && typeof record.id === 'string' && Array.isArray(record.splits) &&
  record.ramps && typeof record.ramps === 'object' && record.start && typeof record.start === 'object';
const lower = (value, best) => Number.isFinite(value) && (best == null || value < best);

// Newest first: qualifying runs on each of the MAX_MAPS most recently played
// maps. A short latest attempt is an extra slot; it never evicts useful runs.
// Each map's best stays pinned and counts while among the newest.
export function retainRuns(runs, {runsPerMap = 10, minSeconds = 10, keep = new Set(), highlights = new Set()} = {}) {
  const counts = new Map(), kept = [];
  // Reserve a qualifying slot, rather than pinning an extra replay. A PB that
  // is also the highlight is still one run and consumes this same slot.
  const recentMaps = new Set(), reserved = new Set();
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (run.outcome !== 'finished' && run.time < minSeconds) continue;
    if (!recentMaps.has(run.map) && recentMaps.size >= MAX_MAPS) continue;
    recentMaps.add(run.map);
    if (highlights.has(run.id)) {
      reserved.add(run.id);
      counts.set(run.map, (counts.get(run.map) ?? 0) + 1);
    }
  }
  let remaining = reserved.size;
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i], count = counts.get(run.map) ?? 0;
    if (run.outcome !== 'finished' && run.time < minSeconds) {
      if (i === runs.length - 1 || keep.has(run.id)) kept.push(run);
      continue;
    }
    const highlighted = reserved.has(run.id);
    if (!keep.has(run.id) && !highlighted && (!recentMaps.has(run.map) || count >= runsPerMap || kept.length + remaining >= MAX_RUNS)) continue;
    if (!highlighted) counts.set(run.map, count + 1);
    else remaining--;
    kept.push(run);
  }
  return kept.reverse();
}

export function mapKey(map) {
  return map ? `${map.id}:${map.version ?? ''}` : '';
}
function prettyName(map) {
  const raw = map?.title ?? map?.name ?? map?.slug ?? map?.id;
  return raw == null ? 'Unknown map' : String(raw);
}

// Adds one recorded run to its map's bests. Practice and invalid runs only
// update when the map was last played; they never count as a best.
export function addToBests(record, run, ramps = []) {
  record.at = Math.max(record.at, run.at);
  record.name = run.mapName;
  record.kind = run.kind;
  if (run.practice) return record;
  record.attempts = (record.attempts ?? 0) + 1;
  if (run.outcome === 'finished') record.finishes = (record.finishes ?? 0) + 1;
  if (run.invalid) return record;
  run.checkpoints.forEach((checkpoint, index) => {
    if (lower(checkpoint.split, record.splits[index]?.time)) record.splits[index] = {time: checkpoint.split, speed: checkpoint.speed, at: run.at};
  });
  ramps.forEach((ramp, order) => {
    const entry = record.ramps[ramp.key] ??= {checkpoint: ramp.checkpoint, order, board: null, down: null, up: null, surf: null};
    for (const field of ['board', 'down', 'up', 'surf']) if (lower(ramp[field], entry[field])) entry[field] = ramp[field];
  });
  if (Number.isFinite(run.start?.speed)) {
    record.start.best = Math.max(record.start.best ?? -Infinity, run.start.speed);
    record.start.sum += run.start.speed;
    record.start.count++;
  }
  // The ramps listed are one route's: the PB's, or before a finish the run
  // that got furthest. Every run still improves the bests of the ramps it
  // touched, but repeat visits, other lines and mistakes don't add rows.
  const route = ramps.map(ramp => ramp.key);
  const pb = run.outcome === 'finished' && (!record.best || run.time < record.best.time);
  // How far a run got: checkpoints, then ramps past the last one.
  const reach = run.checkpoints.length * 1000 + route.length;
  if (route.length && (pb || (!record.best && reach > (record.routeReach ?? -1)))) {
    record.route = route;
    record.routeReach = reach;
  }
  if (run.outcome === 'finished') {
    record.checkpointCount = run.checkpoints.length;
    if (!record.best || run.time < record.best.time) record.best = {runId: run.id, time: run.time, at: run.at, splits: run.checkpoints.map(checkpoint => checkpoint.split)};
  }
  return record;
}
// [key, best] for each ramp of the map's route, in order.
const routeOf = record => !record ? [] : record.route
  ? record.route.flatMap(key => record.ramps[key] ? [[key, record.ramps[key]]] : [])
  : Object.entries(record.ramps).sort(([, a], [, b]) => a.checkpoint - b.checkpoint || a.order - b.order);
const emptyBests = (key, run) => ({id: key, name: run.mapName, kind: run.kind, at: 0, best: null, splits: [], ramps: {},
  start: {best: null, sum: 0, count: 0}, checkpointCount: null, attempts: 0, finishes: 0});

function addRampAverages(record, run, ramps, epoch) {
  if (run.practice || run.invalid) return;
  for (const ramp of ramps) {
    if (ramp.epoch !== epoch) continue;
    for (const field of RAMP_FIELDS) {
      const value = ramp[field];
      if (!Number.isFinite(value)) continue;
      const entry = (record.averages ??= {})[ramp.key] ??= {};
      const metric = entry[field] ??= {sum: 0, count: 0, recent: [], recentSum: 0, next: 0};
      metric.sum += value;
      metric.count++;
      metric.recentSum += value - (metric.recent[metric.next] ?? 0);
      metric.recent[metric.next] = value;
      metric.next = (metric.next + 1) % 10;
    }
  }
}

const finishedAt = run => Number.isFinite(run.finishedAt) ? run.finishedAt : run.at;
function recentBestRuns(runs, now) {
  const selected = new Map();
  for (const run of runs) {
    if (run.outcome !== 'finished' || run.practice || run.invalid || !run.replay ||
      finishedAt(run) + RECENT_BEST_MS <= now) continue;
    const previous = selected.get(run.map);
    if (!previous || run.time < previous.time) selected.set(run.map, run);
  }
  return selected;
}

const isStill = state => state.grounded === true && !state.ducked && !(state.duckFraction > 0) && !state.jumpHeld &&
  state.velocity?.x === 0 && state.velocity?.y === 0 && state.velocity?.z === 0;

// Copies the fields the game's replay initial state has from a live state.
function copyState(state, template) {
  if (!template || typeof template !== 'object') return null;
  const copy = {};
  for (const key of Object.keys(template)) {
    const value = state[key];
    copy[key] = value && typeof value === 'object' ? {...value} : value;
  }
  return copy;
}

// getMap() is the map the game has loaded, so the Runs panel opens on it before any run starts.
export function createRunHistory({metrics, start, getState = () => null, getMap = () => null, getMapName = () => null, onReplay = null,
  limits = () => ({}), onPrune = null, store = null, archive = null, clock = () => Date.now()} = {}) {
  const session = clock();
  let runs = [];
  let runSequence = 0;
  const bests = new Map();
  let recentHighlights = new Map();
  const averageEpochs = new Map();
  const averageEpoch = key => averageEpochs.get(key) ?? 0;
  // `settled` once the saved history has been read (or failed to be);
  // `loaded` only when it was read: deleting anything needs the full picture.
  let settled = false, loaded = false;
  const pending = [];
  let clearing = null, clearTail = Promise.resolve();
  const sizes = new WeakMap();
  const sizeOf = record => {
    let size = sizes.get(record);
    if (size === undefined) { size = JSON.stringify(record).length; sizes.set(record, size); }
    return size;
  };
  let writeTail = Promise.resolve();
  const write = work => {
    const operation = writeTail.then(work);
    writeTail = operation.catch(error => console.warn('[Surfd QoL] Could not save run history:', error));
    return operation;
  };
  const listeners = new Set();
  let current = null, owner = null, startTick = null, lastMap = '', lastMapName = '';
  let boardRevision = -1, board = null, boardSequence = 0, surfSequence = 0;
  // The session's own command log and spawn state. A restart swaps in a new
  // array, so this reference still holds the whole run when it ends.
  let commands = null, initialState = null, commandCount = 0;
  // Replay sessions keep stepping after playback stops; they never record.
  const replaySessions = new WeakSet();
  const snapshots = [], stills = [];
  let snapshotLog = null, snapshotTick = 0, wasStill = false;
  const clearSnapshots = () => { snapshots.length = stills.length = 0; snapshotLog = null; wasStill = false; };

  const runsPerMap = () => {
    try { return limits()?.runsPerMap ?? 10; } catch { return 10; }
  };
  const minSeconds = () => {
    try { return limits()?.minSeconds ?? 10; } catch { return 10; }
  };
  const pinned = () => new Set([...bests.values()].map(record => record.best?.runId).filter(Boolean));
  // Applies the limits and saves what changed. Deleting waits for the saved
  // history: before that, the kept set is incomplete.
  function commit(changed = [], changedBests = []) {
    const before = runs;
    recentHighlights = recentBestRuns(runs, clock());
    const highlights = new Set([...recentHighlights.values()].map(run => run.id));
    runs = retainRuns(runs, {runsPerMap: runsPerMap(), minSeconds: minSeconds(), keep: pinned(), highlights});
    const kept = new Set(runs.map(run => run.id));
    for (const [key, run] of recentHighlights) if (!kept.has(run.id)) recentHighlights.delete(key);
    if (store) {
      for (const run of changed) if (kept.has(run.id)) write(() => store.put(run));
      for (const record of changedBests) { sizes.delete(record); write(() => store.putBests(record)); }
    }
    if (!loaded) return;
    const removed = before.filter(run => !kept.has(run.id)).map(run => run.id);
    if (removed.length && store) write(() => store.remove(removed));
    // Replays follow: a run that is no longer kept takes its replay with it.
    try { onPrune?.(kept); } catch { /* optional */ }
  }
  function notify() { for (const listener of listeners) { try { listener(); } catch { /* UI only */ } } }
  function addRun(run, ramps) {
    let record = bests.get(run.map);
    if (!record) bests.set(run.map, record = emptyBests(run.map, run));
    addToBests(record, run, ramps);
    addRampAverages(record, run, ramps, averageEpoch(run.map));
    return record;
  }
  const ready = (async () => {
    let saved = null;
    try { saved = await store?.load(); } catch (error) { console.warn('[Surfd QoL] Could not load run history:', error); }
    if (saved) {
      for (const record of saved.bests ?? []) if (validBests(record)) {
        if (averageEpoch(record.id)) record.averages = {};
        bests.set(record.id, record);
      }
      // Runs that ended while loading stay newest.
      const recorded = new Set(runs.map(run => run.id));
      runs = [...(saved.runs ?? []).filter(run => validRun(run) && !recorded.has(run.id)).sort((a, b) => a.at - b.at), ...runs];
    }
    loaded = !store || Array.isArray(saved?.runs);
    settled = true;
    // Bests from runs that ended while loading apply on top of the saved ones.
    const touched = new Set(pending.splice(0).map(([run, ramps]) => addRun(run, ramps)));
    commit([], loaded ? [...touched] : []);
    notify();
  })();

  function begin(live) {
    const map = live.map;
    const startStats = start?.snapshot?.();
    const state = live.state;
    lastMap = mapKey(map);
    let name = null;
    try { name = getMapName?.(); } catch { /* optional */ }
    lastMapName = name ?? prettyName(map);
    current = {
      id: `${session.toString(36)}-${clock().toString(36)}-${runSequence++}`,
      session, map: lastMap, mapName: lastMapName, at: clock(),
      kind: map?.stages?.length ? 'S' : 'CP',
      outcome: 'reset', practice: live.practice === true, invalid: '', time: 0,
      start: {
        speed: round(startStats?.available ? startStats.speed : Math.hypot(state.velocity.x, state.velocity.y)),
        height: round(startStats?.available ? startStats.heightAboveFloor : null),
      },
      checkpoints: [], ramps: [],
      rampEntries: new Map(),
    };
    commands = Array.isArray(live.commands) ? live.commands : null;
    initialState = live.initialState ?? null;
    commandCount = commands?.length ?? 0;
    if (commands) {
      // The command that left the start, marked on the replay timeline.
      const startIndex = Math.max(0, commandCount - 1);
      const dt = live.config?.dt ?? 0.015;
      current.replay = {start: startIndex, length: 0, dt};
      // Trim points, tried in order: the newest pre-start state at least
      // LEAD_SECONDS before the start, then the last still moment before it.
      const keepFrom = startIndex - Math.round(LEAD_SECONDS / dt);
      const own = snapshotLog === commands;
      const cut = own ? snapshots.findLast(entry => entry.index <= keepFrom) : null;
      const still = own ? stills.findLast(entry => entry.index <= keepFrom && entry.index < (cut?.index ?? Infinity)) : null;
      const worth = entry => entry?.state && entry.index * dt >= MIN_TRIM_SECONDS && (startIndex - entry.index) * dt <= MAX_TRIM_CHECK_SECONDS;
      const candidates = [cut, still].filter(worth).map(({index, state}) => ({index, state}));
      if (candidates.length) current.clip = {candidates, start: startIndex, expect: {position: {...state.position}, velocity: {...state.velocity}}};
    }
    clearSnapshots();
    boardRevision = metrics?.boardRevision?.() ?? -1;
    boardSequence = metrics?.boardSnapshot?.()?.sequence ?? 0;
    if (commands) current.boards = [];
    board = null;
    surfSequence = metrics?.surfSnapshot?.(-1)?.sequence ?? 0;
  }
  function end(outcome, live) {
    // A board can be measured even when held Surf is disabled or the run
    // ends before leaving the ramp. Its final revision is already collected.
    const run = current;
    if (!run) return;
    current = board = null;
    run.outcome = outcome;
    if (outcome === 'finished') run.finishedAt = clock();
    const timer = live?.timer?.state;
    if (outcome === 'finished' && Number.isFinite(timer?.elapsed)) run.time = timer.elapsed;
    const {ramps, clip} = run;
    delete run.ramps;
    delete run.clip;
    delete run.rampEntries;
    run.time = round(run.time, 3);
    if (!clearing) runs.push(run);
    saveReplay(run, owner, clip);
    owner = startTick = null;
    // Boards only mark a saved replay's timeline.
    if (!run.replay || !run.boards?.length) delete run.boards;
    if (clearing) { clearing.runs.push([run, ramps]); return; }
    if (!settled) { pending.push([run, ramps]); commit([run]); }
    else { const record = addRun(run, ramps); commit([run], loaded ? [record] : []); }
    notify();
  }
  function saveReplay(run, live, clip) {
    const log = commands, spawn = initialState;
    commands = initialState = null;
    if (!run.replay || !onReplay || !log || !spawn || !Number.isInteger(live?.replayFormat) ||
      commandCount <= run.replay.start || commandCount > MAX_REPLAY_COMMANDS) { delete run.replay; return; }
    run.replay.length = commandCount;
    const replay = {format: live.replayFormat, mapId: live.map.id, mapVersion: live.map.version, config: {...live.config},
      initialState: structuredClone(spawn), commands: log.slice(0, commandCount)};
    const segment = clip ? {...clip, map: live.map} : null;
    if (clearing) clearing.replays.push([run, replay, segment]);
    else sendReplay(run, replay, segment);
  }
  function sendReplay(run, replay, clip) {
    if (!run.replay) return;
    try { onReplay(run, replay, clip); } catch { delete run.replay; delete run.boards; }
  }
  function rampEntry(run, measurement) {
    const key = visitKey(measurement);
    if (!key) return null;
    let entry = run.rampEntries.get(key);
    if (!entry && run.ramps.length < MAX_RAMPS) {
      entry = {key, checkpoint: measurement.checkpoint, epoch: averageEpoch(run.map),
        board: null, down: null, up: null, surf: null};
      run.rampEntries.set(key, entry);
      run.ramps.push(entry);
    }
    return entry;
  }
  function track(live) {
    const run = current, timer = live.timer.state;
    if (Number.isFinite(timer.elapsed)) run.time = timer.elapsed;
    if (commands) commandCount = commands.length;
    if (timer.invalidReason) run.invalid = String(timer.invalidReason);
    const speeds = live.checkpointSpeeds;
    // Splits are copied as they happen: a restart clears them before the reset hook runs.
    while (Array.isArray(speeds) && run.checkpoints.length < speeds.length && run.checkpoints.length < 64) {
      const index = run.checkpoints.length;
      run.checkpoints.push({split: round(timer.splits?.[index], 3), speed: round(speeds[index]), ...(commands ? {command: commands.length} : {})});
    }
    if (!metrics) return;
    const revision = metrics.boardRevision?.();
    if (revision !== undefined && revision !== boardRevision) {
      boardRevision = revision;
      board = metrics.boardSnapshot();
      if (board?.sequence > 0) {
        const entry = rampEntry(run, board);
        if (entry && board.available && Number.isFinite(board.loss)) entry.board = round(board.loss);
      }
      // Each board, for the replay timeline: [tick, loss, ramp key]. Quick
      // re-touches while landing are the same board.
      if (run.boards && Number.isSafeInteger(board?.sequence) && board.sequence >= boardSequence) {
        const loss = board.available && Number.isFinite(board.loss) ? round(board.loss) : null;
        if (board.sequence === boardSequence) { if (run.boards.length) run.boards.at(-1)[1] = loss; }
        else if (run.boards.length < MAX_RAMPS) run.boards.push([commands.length, loss, visitKey(board)]);
        boardSequence = board.sequence;
      }
    }
    const surf = metrics.surfSnapshot?.(surfSequence);
    if (!surf) return;
    surfSequence = surf.sequence;
    if (surf.sequence > 0) {
      const entry = rampEntry(run, surf);
      if (entry && surf.available) {
        entry.down = round(surf.downLoss);
        entry.up = round(surf.upLoss);
        entry.surf = round(surf.loss);
      }
    }
  }
  // Keeps recent pre-start states so a replay can start LEAD_SECONDS before its run.
  function snapshot(live) {
    if (!Array.isArray(live.commands)) return;
    if (snapshotLog !== live.commands) { clearSnapshots(); snapshotLog = live.commands; snapshotTick = 0; }
    if (snapshotTick++ % SNAPSHOT_TICKS) return;
    const entry = {index: live.commands.length, state: copyState(live.state, live.initialState)};
    snapshots.push(entry);
    if (snapshots.length > SNAPSHOT_COUNT) snapshots.shift();
    // Still for two snapshots in a row, so the game has settled too.
    const still = isStill(live.state);
    if (still && wasStill && !(entry.index - (stills.at(-1)?.index ?? -Infinity) < STILL_SPACING)) {
      stills.push(entry);
      if (stills.length > STILL_COUNT) stills.shift();
    }
    wasStill = still;
  }
  const shape = (run, total) => ({id: run.id, map: run.map, mapName: run.mapName, at: run.at, time: run.time,
    outcome: run.outcome, checkpoints: run.checkpoints.length, totalCheckpoints: total,
    practice: run.practice, invalid: run.invalid, start: run.start, kind: run.kind,
    ...(run.replay ? {replay: run.replay, ...(run.boards ? {boards: run.boards} : {})} : {})});

  return {
    session,
    // Called after every live tick. Replays and reference reconstructions never record.
    observe(live, events) {
      const timer = live?.timer?.state;
      if (!timer || !live.state) return;
      const starting = events.includes('start');
      // The game snapshot is a full copy of its state, so it is read only when
      // a run would start. A replay loaded mid-run ends that run via reset().
      let playback = replaySessions.has(live), spectating = false;
      if (starting && !playback) {
        try {
          const state = getState?.();
          playback = state?.playback === true;
          spectating = state?.spectator?.target != null;
        } catch { /* optional */ }
        if (playback) replaySessions.add(live);
      }
      if (current && (live !== owner || events.some(event => endEvents.has(event)) ||
        timer.phase === 'ready' || timer.startTick !== startTick)) {
        end('reset', live);
      }
      if (starting && !playback && !spectating) {
        if (current) end('reset', live);
        owner = live;
        startTick = timer.startTick;
        begin(live);
      }
      if (!current) { if (!playback && timer.phase === 'ready') snapshot(live); return; }
      track(live);
      if (events.includes('finish') || timer.phase === 'finished') end('finished', live);
    },
    // Restart, practice restore, replay load or station visit.
    reset() { if (current) end('reset', owner); },
    // Drops the run in progress without recording it (recording turned off).
    discard() { current = board = commands = initialState = owner = startTick = null; clearSnapshots(); },
    // Resolves once the saved history has loaded.
    ready,
    get currentMap() {
      let map = null;
      try { map = getMap?.(); } catch { /* the last run's map */ }
      return map ? mapKey(map) : lastMap;
    },
    get currentMapName() {
      let map = null, name = null;
      try { map = getMap?.(); } catch { /* the last run's map */ }
      if (!map || mapKey(map) === lastMap) return lastMapName;
      try { name = getMapName?.(); } catch { /* optional */ }
      return name ?? prettyName(map);
    },
    get running() { return !!current; },
    runs() { return runs; },
    run: id => runs.find(run => run.id === id) ?? null,
    // Maps with history, most recently played first.
    maps() {
      const entries = new Map();
      for (const record of bests.values()) entries.set(record.id, {key: record.id, name: record.name, at: record.at, runs: 0});
      for (const run of runs) {
        const entry = entries.get(run.map) ?? {key: run.map, name: run.mapName, at: run.at, runs: 0};
        entry.runs++;
        entry.at = Math.max(entry.at, run.at);
        entries.set(run.map, entry);
      }
      return [...entries.values()].sort((a, b) => b.at - a.at);
    },
    // What the Runs view shows for one map; null when it has no history.
    view(key = lastMap, {rampMode = 'best'} = {}) {
      const record = bests.get(key) ?? null;
      const list = runs.filter(run => run.map === key);
      if (!record && !list.length) return null;
      const kind = record?.kind ?? list.at(-1)?.kind ?? 'CP';
      const total = record?.checkpointCount ?? null;
      const best = record?.best ? runs.find(run => run.id === record.best.runId) ?? null : null;
      let recentBest = recentHighlights.get(key) ?? null;
      // Reads are cheap while the selected finish remains eligible. Expiry
      // alone may choose a retained fallback; no per-frame history scan/timer.
      if (recentBest && finishedAt(recentBest) + RECENT_BEST_MS <= clock()) {
        recentBest = recentBestRuns(list, clock()).get(key) ?? null;
        if (recentBest) recentHighlights.set(key, recentBest);
        else recentHighlights.delete(key);
      }
      const minimum = minSeconds();
      // The newest attempt stands apart; older short resets don't take a slot.
      const latest = list.at(-1) ?? null;
      const recent = list.filter(run => run.outcome === 'finished' || run.time >= minimum).slice(-runsPerMap()).filter(run => run !== latest);
      const pbSplits = record?.best?.splits ?? best?.checkpoints.map(checkpoint => checkpoint.split) ?? [];
      return {
        key, name: record?.name ?? list.at(-1)?.mapName ?? key, kind,
        totals: {attempts: record?.attempts ?? 0, finishes: record?.finishes ?? 0},
        pb: best ? shape(best, total) : null,
        recentBest: recentBest ? {...shape(recentBest, total), finishedAt: finishedAt(recentBest),
          expiresAt: finishedAt(recentBest) + RECENT_BEST_MS} : null,
        latest: latest ? shape(latest, total) : null,
        recent: recent.reverse().map(run => shape(run, total)),
        splits: (record?.splits ?? []).flatMap((split, index) => split ? [{index, label: `${kind}${index + (kind === 'S' ? 2 : 1)}`, time: split.time, speed: split.speed,
          at: split.at, pb: Number.isFinite(pbSplits[index]) ? pbSplits[index] : null}] : []),
        ramps: routeOf(record).map(([rampKey, ramp], index) => {
          const row = {key: rampKey, label: `Ramp ${index + 1}`, checkpoint: ramp.checkpoint};
          if (rampMode === 'recent' || rampMode === 'average') row.counts = {};
          for (const field of RAMP_FIELDS) {
            if (!row.counts) { row[field] = ramp[field] ?? null; continue; }
            const metric = record.averages?.[rampKey]?.[field];
            const count = rampMode === 'recent' ? metric?.recent.length ?? 0 : metric?.count ?? 0;
            row.counts[field] = count;
            row[field] = count ? round((rampMode === 'recent' ? metric.recentSum : metric.sum) / count) : null;
          }
          return row;
        }),
        start: record?.start?.count ? {best: record.start.best, average: round(record.start.sum / record.start.count), count: record.start.count} : null,
      };
    },
    // A ramp's number on its map's route (as the Runs view lists it), or null.
    rampNumber(key, rampKey) {
      const index = routeOf(bests.get(key)).findIndex(([entry]) => entry === rampKey);
      return index < 0 ? null : index + 1;
    },
    // Re-applies the limits after they change.
    prune() { if (!clearing) commit(); notify(); },
    usage() {
      let bytes = 0;
      for (const run of runs) bytes += sizeOf(run);
      for (const record of bests.values()) bytes += sizeOf(record);
      return {bytes, runs: runs.length, maps: this.maps().length};
    },
    // The boundary is synchronous, including while load/clear is pending.
    // Visits already in flight keep their old epoch; later visits can count.
    resetRampAverages(key = lastMap) {
      averageEpochs.set(key, averageEpoch(key) + 1);
      const record = bests.get(key);
      if (record) { record.averages = {}; sizes.delete(record); }
      notify();
      const operation = clearTail.then(async () => {
        await ready;
        await writeTail;
        if (store && !loaded) throw new Error('Run history has not loaded; averages could not be saved.');
        const record = bests.get(key);
        if (record && store) {
          await write(() => store.putBests(record));
        }
      });
      clearTail = operation.catch(() => {});
      return operation;
    },
    // Clears serialize, including after rejection. Runs ending during the
    // transaction apply only after its result, against fresh or preserved bests.
    clear(key) {
      const operation = clearTail.then(async () => {
        await ready;
        const queued = clearing = {runs: [], replays: [], changed: new Set()};
        try {
          await writeTail;
          const removed = runs.filter(run => !key || run.map === key).map(run => run.id);
          const dropped = key ? (bests.has(key) ? [key] : []) : [...bests.keys()];
          if (archive) await archive.clearHistory(removed, dropped, key);
          else if (store) await store.clear(removed, dropped);
          const ids = new Set(removed);
          runs = runs.filter(run => !ids.has(run.id));
          for (const id of dropped) bests.delete(id);
        } finally {
          clearing = null;
          const touched = new Set();
          for (const [run, ramps] of queued.runs) {
            runs.push(run);
            queued.changed.add(run);
            touched.add(addRun(run, ramps));
          }
          // New finishes belong after the clear boundary. Start their archive
          // jobs only once deletion has settled, including when it failed.
          for (const replay of queued.replays) sendReplay(...replay);
          commit([...queued.changed], loaded ? [...touched] : []);
          notify();
        }
      });
      clearTail = operation.catch(() => {});
      return operation;
    },
    // The saved replay was trimmed: it now starts `offset` commands into the run.
    setReplayOffset(id, offset) {
      const run = runs.find(entry => entry.id === id);
      if (!run?.replay || !(offset > 0) || run.replay.offset) return;
      run.replay = {...run.replay, start: run.replay.start - offset, length: run.replay.length - offset, offset};
      sizes.delete(run);
      if (clearing) clearing.changed.add(run);
      else if (store) write(() => store.put(run));
      notify();
    },
    // A failed archive save must not leave a watchable highlight descriptor.
    // Its attempt, bests and measurements remain useful without a replay.
    setReplayUnavailable(id) {
      const run = runs.find(entry => entry.id === id) ?? clearing?.runs.find(([entry]) => entry.id === id)?.[0];
      if (!run || (!run.replay && !run.boards && !run.spots)) return;
      delete run.replay;
      delete run.boards;
      delete run.spots;
      sizes.delete(run);
      if (clearing) {
        clearing.changed.add(run);
        recentHighlights = recentBestRuns(runs, clock());
      } else commit([run]);
      notify();
    },
    // Replay spots (bookmarks) the player saved while watching this run.
    setSpots(id, spots) {
      const run = runs.find(entry => entry.id === id);
      if (!run) return;
      if (spots.length) run.spots = spots; else delete run.spots;
      sizes.delete(run);
      if (clearing) clearing.changed.add(run);
      else if (store) write(() => store.put(run));
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
