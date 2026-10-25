// Run history: a compact record per run plus each map's bests. Observes the
// live session after every tick (after metrics and start feedback). Runs and
// bests are saved one record each in IndexedDB (createHistoryStore), so
// ending a run writes only that run and its map's bests.
import {visitKey} from './replay-store.js';

// Maps whose recent runs are kept; bests are kept for every map.
const MAX_MAPS = 50;
const MAX_RUNS = 2000;
const MAX_RAMPS = 120;
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
export function retainRuns(runs, {runsPerMap = 10, minSeconds = 10, keep = new Set()} = {}) {
  const maps = new Set(), counts = new Map(), kept = [];
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i], count = counts.get(run.map) ?? 0;
    if (run.outcome !== 'finished' && run.time < minSeconds) {
      if (i === runs.length - 1 || keep.has(run.id)) kept.push(run);
      continue;
    }
    if (!keep.has(run.id) && ((!maps.has(run.map) && maps.size >= MAX_MAPS) || count >= runsPerMap || kept.length >= MAX_RUNS)) continue;
    maps.add(run.map);
    counts.set(run.map, count + 1);
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
  limits = () => ({}), onPrune = null, store = null, clock = () => Date.now()} = {}) {
  const session = clock();
  let runs = [];
  let runSequence = 0;
  const bests = new Map();
  // `settled` once the saved history has been read (or failed to be);
  // `loaded` only when it was read: deleting anything needs the full picture.
  let settled = false, loaded = false;
  const pending = [];
  const sizes = new WeakMap();
  const sizeOf = record => {
    let size = sizes.get(record);
    if (size === undefined) { size = JSON.stringify(record).length; sizes.set(record, size); }
    return size;
  };
  const write = work => Promise.resolve().then(work).catch(error => console.warn('[Surfd QoL] Could not save run history:', error));
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
    runs = retainRuns(runs, {runsPerMap: runsPerMap(), minSeconds: minSeconds(), keep: pinned()});
    const kept = new Set(runs.map(run => run.id));
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
    return addToBests(record, run, ramps);
  }
  const ready = (async () => {
    let saved = null;
    try { saved = await store?.load(); } catch (error) { console.warn('[Surfd QoL] Could not load run history:', error); }
    if (saved) {
      for (const record of saved.bests ?? []) if (validBests(record)) bests.set(record.id, record);
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
    const run = current;
    if (!run) return;
    current = board = null;
    run.outcome = outcome;
    const timer = live?.timer?.state;
    if (outcome === 'finished' && Number.isFinite(timer?.elapsed)) run.time = timer.elapsed;
    const {ramps, clip} = run;
    delete run.ramps;
    delete run.clip;
    run.time = round(run.time, 3);
    runs.push(run);
    saveReplay(run, owner, clip);
    // Boards only mark a saved replay's timeline.
    if (!run.replay || !run.boards?.length) delete run.boards;
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
    try { onReplay(run, replay, clip ? {...clip, map: live.map} : null); } catch { delete run.replay; }
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
    const previousBoard = board;
    const revision = metrics.boardRevision?.();
    if (revision !== undefined && revision !== boardRevision) {
      boardRevision = revision;
      board = metrics.boardSnapshot();
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
    // Ramps are identified like PB/WR matching does (visitKey): surface, checkpoint, visit.
    const key = surf.sequence > 0 ? visitKey(surf) : null;
    if (key && run.ramps.length < MAX_RAMPS) {
      const matches = entry => entry?.available && visitKey(entry) === key;
      const entry = matches(board) ? board : matches(previousBoard) ? previousBoard : null;
      const value = field => surf.available ? round(surf[field]) : null;
      run.ramps.push({key, checkpoint: surf.checkpoint, board: entry ? round(entry.loss) : null,
        down: value('downLoss'), up: value('upLoss'), surf: value('loss')});
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
  const shape = (run, total) => ({id: run.id, at: run.at, time: run.time, outcome: run.outcome, checkpoints: run.checkpoints.length,
    totalCheckpoints: total, practice: run.practice, invalid: run.invalid, start: run.start, kind: run.kind,
    ...(run.replay ? {replay: run.replay} : {})});

  return {
    session,
    // Called after every live tick. Replays and reference reconstructions never record.
    observe(live, events) {
      const timer = live?.timer?.state;
      if (!timer || !live.state) return;
      const starting = events.includes('start');
      // The game snapshot is a full copy of its state, so it is read only when
      // a run would start. A replay loaded mid-run ends that run via reset().
      let playback = replaySessions.has(live);
      if (starting && !playback) {
        try { playback = getState?.()?.playback === true; } catch { /* optional */ }
        if (playback) replaySessions.add(live);
      }
      if (current && (live !== owner || events.some(event => endEvents.has(event)) ||
        timer.phase === 'ready' || timer.startTick !== startTick)) {
        end('reset', live);
      }
      if (starting && !playback) {
        if (current) end('reset', live);
        owner = live;
        startTick = timer.startTick;
        begin(live);
      }
      if (!current) { if (!playback) snapshot(live); return; }
      track(live);
      if (events.includes('finish') || timer.phase === 'finished') end('finished', live);
    },
    // Restart, practice restore, replay load or station visit.
    reset() { if (current) end('reset', owner); },
    // Drops the run in progress without recording it (recording turned off).
    discard() { current = board = commands = initialState = null; clearSnapshots(); },
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
    view(key = lastMap) {
      const record = bests.get(key) ?? null;
      const list = runs.filter(run => run.map === key);
      if (!record && !list.length) return null;
      const kind = record?.kind ?? list.at(-1)?.kind ?? 'CP';
      const total = record?.checkpointCount ?? null;
      const best = record?.best ? runs.find(run => run.id === record.best.runId) ?? null : null;
      const minimum = minSeconds();
      // The newest attempt stands apart; older short resets don't take a slot.
      const latest = list.at(-1) ?? null;
      const recent = list.filter(run => run.outcome === 'finished' || run.time >= minimum).slice(-runsPerMap()).filter(run => run !== latest);
      const pbSplits = record?.best?.splits ?? best?.checkpoints.map(checkpoint => checkpoint.split) ?? [];
      return {
        key, name: record?.name ?? list.at(-1)?.mapName ?? key, kind,
        totals: {attempts: record?.attempts ?? 0, finishes: record?.finishes ?? 0},
        pb: best ? shape(best, total) : null,
        latest: latest ? shape(latest, total) : null,
        recent: recent.reverse().map(run => shape(run, total)),
        splits: (record?.splits ?? []).flatMap((split, index) => split ? [{index, label: `${kind}${index + (kind === 'S' ? 2 : 1)}`, time: split.time, speed: split.speed,
          at: split.at, pb: Number.isFinite(pbSplits[index]) ? pbSplits[index] : null}] : []),
        ramps: routeOf(record).map(([rampKey, ramp], index) => ({key: rampKey, label: `Ramp ${index + 1}`, checkpoint: ramp.checkpoint,
            board: ramp.board, down: ramp.down ?? null, up: ramp.up ?? null, surf: ramp.surf})),
        start: record?.start?.count ? {best: record.start.best, average: round(record.start.sum / record.start.count), count: record.start.count} : null,
      };
    },
    // A ramp's number on its map's route (as the Runs view lists it), or null.
    rampNumber(key, rampKey) {
      const index = routeOf(bests.get(key)).findIndex(([entry]) => entry === rampKey);
      return index < 0 ? null : index + 1;
    },
    // Re-applies the limits after they change.
    prune() { commit(); notify(); },
    usage() {
      let bytes = 0;
      for (const run of runs) bytes += sizeOf(run);
      for (const record of bests.values()) bytes += sizeOf(record);
      return {bytes, runs: runs.length, maps: this.maps().length};
    },
    // Clears one map's runs and bests, or everything.
    async clear(key) {
      await ready;
      const removed = runs.filter(run => !key || run.map === key).map(run => run.id);
      const dropped = key ? (bests.has(key) ? [key] : []) : [...bests.keys()];
      // Unlike background saves, an explicit deletion must report failure.
      // Delete runs and their aggregate records atomically before publishing it.
      if (store) await store.clear(removed, dropped);
      const ids = new Set(removed);
      runs = runs.filter(run => !ids.has(run.id));
      for (const id of dropped) bests.delete(id);
      commit();
      notify();
    },
    // The saved replay was trimmed: it now starts `offset` commands into the run.
    setReplayOffset(id, offset) {
      const run = runs.find(entry => entry.id === id);
      if (!run?.replay || !(offset > 0) || run.replay.offset) return;
      run.replay = {...run.replay, start: run.replay.start - offset, length: run.replay.length - offset, offset};
      sizes.delete(run);
      if (store) write(() => store.put(run));
      notify();
    },
    // Replay spots (bookmarks) the player saved while watching this run.
    setSpots(id, spots) {
      const run = runs.find(entry => entry.id === id);
      if (!run) return;
      if (spots.length) run.spots = spots; else delete run.spots;
      sizes.delete(run);
      if (store) write(() => store.put(run));
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
