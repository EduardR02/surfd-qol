// Per-run stats and history. Observes the live session once per tick (after
// metrics and start feedback) and keeps one compact record per run: splits,
// start, ramp/air totals, top speed and sync. Runs are kept in memory and
// saved one record each in IndexedDB (createRunStore), so ending a run writes
// only that run.
// Where older versions kept the whole history, in the game's localStorage.
export const HISTORY_KEY = 'surfd-qol.runs.v1';
// A hard ceiling, whatever the limits say.
const MAX_RUNS = 2000;
const MAX_RAMPS = 120;
// Restarts straight out of the start zone are not worth a row.
const MIN_RESET_SECONDS = 1;
const endEvents = new Set(['restart', 'start-return', 'practice-restore']);
// About 15 minutes of ticks since the last restart; longer is not kept as a replay.
const MAX_REPLAY_COMMANDS = 60000;

const round = (value, digits = 1) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const valid = run => run && typeof run.map === 'string' && Number.isFinite(run.at) && Number.isFinite(run.time) &&
  (run.outcome === 'finished' || run.outcome === 'reset') && Array.isArray(run.checkpoints) && Array.isArray(run.ramps);

// Applies the History limits, newest first: runs from the latest `sessions`
// page loads (0 keeps all), on the `maps` most recently played maps, and at
// most `runsPerMap` of each.
export function retainRuns(runs, {runsPerMap = 100, maps = 20, sessions = 0} = {}) {
  const keptSessions = new Set(), keptMaps = new Set(), counts = new Map(), kept = [];
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    const newSession = sessions > 0 && !keptSessions.has(run.session);
    if (newSession && keptSessions.size >= sessions) continue;
    const newMap = !keptMaps.has(run.map);
    if (newMap && keptMaps.size >= maps) continue;
    const count = counts.get(run.map) ?? 0;
    if (count >= runsPerMap || kept.length >= MAX_RUNS) continue;
    if (newSession) keptSessions.add(run.session);
    if (newMap) keptMaps.add(run.map);
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

export function createRunHistory({metrics, start, getState = () => null, getMapName = () => null, onReplay = null, limits = () => ({}),
  onPrune = null, store = null, legacy, clock = () => Date.now()} = {}) {
  if (legacy === undefined) {
    try { legacy = globalThis.localStorage; } catch { legacy = null; }
  }
  const session = clock();
  let runs = [], loaded = false;
  // Serialized size per run, for the storage readout; computed once per run.
  const sizes = new WeakMap();
  const sizeOf = run => {
    let size = sizes.get(run);
    if (size === undefined) { size = JSON.stringify(run).length; sizes.set(run, size); }
    return size;
  };
  const write = work => Promise.resolve().then(work).catch(error => console.warn('[Surfd QoL] Could not save run history:', error));
  const listeners = new Set();
  let current = null, owner = null, startTick = null, lastMap = '', lastMapName = '';
  let boardRevision = -1, board = null, surfSequence = 0, airSequence = 0;
  // The session's own command log and spawn state. A restart swaps in a new
  // array, so this reference still holds the whole run when it ends.
  let commands = null, initialState = null, commandCount = 0;
  // Replay sessions keep stepping after playback stops; they never record.
  const replaySessions = new WeakSet();

  // Applies the limits and saves `changed` runs. Deleting waits for the saved
  // history to load: before that, the kept set is incomplete.
  function commit(changed = []) {
    let limit = {};
    try { limit = limits() ?? {}; } catch { /* defaults */ }
    const before = runs;
    runs = retainRuns(runs, limit);
    const kept = new Set(runs.map(run => run.id));
    for (const run of changed) if (kept.has(run.id) && store) write(() => store.put(run));
    if (!loaded) return;
    const removed = before.filter(run => !kept.has(run.id)).map(run => run.id);
    if (removed.length && store) write(() => store.remove(removed));
    // Replays follow: a run that is no longer kept takes its replay with it.
    try { onPrune?.(kept); } catch { /* optional */ }
  }
  function notify() { for (const listener of listeners) { try { listener(); } catch { /* UI only */ } } }
  const ready = (async () => {
    let saved = null;
    try { saved = await store?.load(); } catch (error) { console.warn('[Surfd QoL] Could not load run history:', error); }
    let moved = [];
    if (Array.isArray(saved)) {
      // Older versions kept everything in one localStorage entry: move it over once.
      try {
        const text = legacy?.getItem(HISTORY_KEY);
        if (text) {
          const known = new Set(saved.map(run => run.id));
          moved = (JSON.parse(text)?.runs ?? []).filter(run => valid(run) && !known.has(run.id));
          await Promise.all(moved.map(run => store.put(run)));
          legacy.removeItem(HISTORY_KEY);
        }
      } catch { /* an unreadable old history is left where it is */ }
    }
    // Runs that ended while loading stay newest.
    const recorded = new Set(runs.map(run => run.id));
    const older = [...(saved ?? []), ...moved].filter(run => valid(run) && !recorded.has(run.id)).sort((a, b) => a.at - b.at);
    runs = [...older, ...runs];
    // A failed load never unlocks deleting: the kept set would be incomplete.
    loaded = !store || Array.isArray(saved);
    commit();
    notify();
  })();

  function commitBoard() {
    if (!current || !board?.available) return;
    current.board.total += board.loss;
    current.board.count++;
  }
  function begin(live) {
    const map = live.map;
    const startStats = start?.snapshot?.();
    const state = live.state;
    lastMap = mapKey(map);
    let name = null;
    try { name = getMapName?.(); } catch { /* optional */ }
    lastMapName = name ?? prettyName(map);
    current = {
      id: `${session.toString(36)}-${clock().toString(36)}-${runs.length}`,
      session, map: lastMap, mapName: lastMapName, at: clock(),
      kind: map?.stages?.length ? 'S' : 'CP',
      outcome: 'reset', practice: live.practice === true, invalid: '', time: 0,
      start: {
        speed: round(startStats?.available ? startStats.speed : Math.hypot(state.velocity.x, state.velocity.y)),
        height: round(startStats?.available ? startStats.heightAboveFloor : null),
      },
      topSpeed: 0, sync: null, checkpoints: [], ramps: [],
      board: {total: 0, count: 0},
      surf: {down: 0, up: 0, loss: 0, count: 0, unavailable: 0},
      air: {loss: 0, braking: 0, missed: 0, seconds: 0, count: 0},
    };
    commands = Array.isArray(live.commands) ? live.commands : null;
    initialState = live.initialState ?? null;
    commandCount = commands?.length ?? 0;
    // Watching starts a moment before this tick: the command that left the start.
    if (commands) current.replay = {start: Math.max(0, commandCount - 1), length: 0, dt: live.config?.dt ?? 0.015};
    boardRevision = metrics?.boardRevision?.() ?? -1;
    board = null;
    surfSequence = metrics?.surfSnapshot?.(-1)?.sequence ?? 0;
    airSequence = metrics?.airSnapshot?.(-1)?.sequence ?? 0;
  }
  function end(outcome, live) {
    const run = current;
    if (!run) return;
    commitBoard();
    current = board = null;
    run.outcome = outcome;
    try { run.sync = round(getState?.()?.strafeSync?.percentage); } catch { /* optional */ }
    const timer = live?.timer?.state;
    if (outcome === 'finished' && Number.isFinite(timer?.elapsed)) run.time = timer.elapsed;
    if (outcome === 'reset' && run.time < MIN_RESET_SECONDS) return;
    run.time = round(run.time, 3);
    run.topSpeed = round(run.topSpeed);
    for (const group of [run.board, run.surf, run.air]) for (const key of Object.keys(group)) group[key] = round(group[key], 1);
    runs.push(run);
    saveReplay(run, owner);
    commit([run]);
    notify();
  }
  function saveReplay(run, live) {
    const log = commands, spawn = initialState;
    commands = initialState = null;
    if (!run.replay || !onReplay || !log || !spawn || !Number.isInteger(live?.replayFormat) ||
      commandCount <= run.replay.start || commandCount > MAX_REPLAY_COMMANDS) { delete run.replay; return; }
    run.replay.length = commandCount;
    const replay = {format: live.replayFormat, mapId: live.map.id, mapVersion: live.map.version, config: {...live.config},
      initialState: structuredClone(spawn), commands: log.slice(0, commandCount)};
    try { onReplay(run, replay); } catch { delete run.replay; }
  }

  function track(live) {
    const run = current, state = live.state, timer = live.timer.state;
    run.topSpeed = Math.max(run.topSpeed, Math.hypot(state.velocity.x, state.velocity.y));
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
      const next = metrics.boardSnapshot();
      // Re-touches merge into the same board; only a new sequence is a new ramp.
      if (next.sequence !== board?.sequence) commitBoard();
      board = next;
    }
    const surf = metrics.surfSnapshot?.(surfSequence);
    if (surf) {
      surfSequence = surf.sequence;
      if (surf.sequence > 0) {
        const own = board?.available && board.surfaceId === surf.surfaceId && board.visit === surf.visit;
        if (surf.available) {
          run.surf.down += surf.downLoss; run.surf.up += surf.upLoss; run.surf.loss += surf.loss; run.surf.count++;
        } else run.surf.unavailable++;
        // A ramp surfed while Ramp feedback was hidden (or in live mode) has
        // no exit sample; the current speed, just after leaving, stands in.
        const velocity = live.state.velocity;
        if (run.ramps.length < MAX_RAMPS) run.ramps.push({
          checkpoint: Number.isInteger(surf.checkpoint) ? surf.checkpoint : run.checkpoints.length,
          board: own ? round(board.loss) : null,
          down: surf.available ? round(surf.downLoss) : null,
          up: surf.available ? round(surf.upLoss) : null,
          exit: round(surf.exitSpeed ?? Math.hypot(velocity.x, velocity.y, velocity.z)),
          ...(surf.available ? {} : {missing: surf.reason === 'not-tracked-while-hidden' ? 'hidden' : 'unclear'}),
        });
      }
    }
    const air = metrics.airSnapshot?.(airSequence);
    if (air) {
      airSequence = air.sequence;
      if (air.sequence > 0 && air.available) {
        run.air.loss += air.loss; run.air.braking += air.brakingLoss; run.air.missed += air.missedGain;
        run.air.seconds += air.measuredSeconds; run.air.count++;
      }
    }
  }

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
      if (!current) return;
      track(live);
      if (events.includes('finish') || timer.phase === 'finished') end('finished', live);
    },
    // Restart, practice restore, replay load or station visit.
    reset() { if (current) end('reset', owner); },
    // Drops the run in progress without recording it (recording turned off).
    discard() { current = board = commands = initialState = null; },
    // Resolves once the saved history has loaded.
    ready,
    get currentMap() { return lastMap; },
    get currentMapName() { return lastMapName; },
    get running() { return !!current; },
    runs() { return runs; },
    // Re-applies the History limits after they change.
    prune() { commit(); notify(); },
    usage() { return {bytes: runs.reduce((total, run) => total + sizeOf(run), 0), runs: runs.length, maps: new Set(runs.map(run => run.map)).size}; },
    async clear(map) {
      await ready;
      const removed = runs.filter(run => !map || run.map === map).map(run => run.id);
      runs = map ? runs.filter(run => run.map !== map) : [];
      if (store && removed.length) await write(() => store.remove(removed));
      commit();
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

// Pure summary of a list of runs, for the stats popup and tests.
export function summarize(list) {
  const finished = list.filter(run => run.outcome === 'finished' && !run.practice && !run.invalid);
  const best = finished.reduce((a, b) => !a || b.time < a.time ? b : a, null);
  const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const starts = list.map(run => run.start?.speed).filter(Number.isFinite);
  const syncs = list.map(run => run.sync).filter(Number.isFinite);
  return {
    count: list.length,
    finished: finished.length,
    best,
    average: mean(finished.map(run => run.time)),
    bestStart: starts.length ? Math.max(...starts) : null,
    averageStart: mean(starts),
    averageSync: mean(syncs),
  };
}
