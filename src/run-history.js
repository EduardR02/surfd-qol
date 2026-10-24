// Per-run stats and history. Observes the live session once per tick (after
// metrics and start feedback) and keeps one compact record per run: splits,
// start, ramp/air totals, top speed and sync. Runs are kept in memory for this
// page session and saved per map in surfd.net's local storage.
export const HISTORY_KEY = 'surfd-qol.runs.v1';
export const RUNS_PER_MAP = 100;
const MAX_RUNS = 600;
const MAX_RAMPS = 120;
// Restarts straight out of the start zone are not worth a row.
const MIN_RESET_SECONDS = 1;
const endEvents = new Set(['restart', 'start-return', 'practice-restore']);
// About 15 minutes of ticks since the last restart; longer is not kept as a replay.
const MAX_REPLAY_COMMANDS = 60000;

const round = (value, digits = 1) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const valid = run => run && typeof run.map === 'string' && Number.isFinite(run.at) && Number.isFinite(run.time) &&
  (run.outcome === 'finished' || run.outcome === 'reset') && Array.isArray(run.checkpoints) && Array.isArray(run.ramps);

export function mapKey(map) {
  return map ? `${map.id}:${map.version ?? ''}` : '';
}
function prettyName(map) {
  const raw = map?.title ?? map?.name ?? map?.slug ?? map?.id;
  return raw == null ? 'Unknown map' : String(raw);
}

export function createRunHistory({metrics, start, getState = () => null, getMapName = () => null, onReplay = null, storage, clock = () => Date.now()} = {}) {
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch { storage = null; }
  }
  const session = clock();
  let runs = [];
  try {
    const saved = JSON.parse(storage?.getItem(HISTORY_KEY) ?? 'null');
    if (Array.isArray(saved?.runs)) runs = saved.runs.filter(valid);
  } catch { /* Private browsing or an incompatible history must not affect play. */ }
  const listeners = new Set();
  let current = null, owner = null, startTick = null, lastMap = '', lastMapName = '';
  let boardRevision = -1, board = null, surfSequence = 0, airSequence = 0;
  // The session's own command log and spawn state. A restart swaps in a new
  // array, so this reference still holds the whole run when it ends.
  let commands = null, initialState = null, commandCount = 0;
  // Replay sessions keep stepping after playback stops; they never record.
  const replaySessions = new WeakSet();

  function save() {
    // Per-map and global caps keep localStorage well under its quota.
    const counts = new Map();
    const kept = [];
    for (let i = runs.length - 1; i >= 0; i--) {
      const count = counts.get(runs[i].map) ?? 0;
      if (count >= RUNS_PER_MAP || kept.length >= MAX_RUNS) continue;
      counts.set(runs[i].map, count + 1);
      kept.push(runs[i]);
    }
    runs = kept.reverse();
    for (let attempt = 0; attempt < 2; attempt++) {
      try { storage?.setItem(HISTORY_KEY, JSON.stringify({runs})); return; }
      catch { runs = runs.slice(Math.floor(runs.length / 2)); }
    }
  }
  function notify() { for (const listener of listeners) { try { listener(); } catch { /* UI only */ } } }

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
    save();
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
      let playback = false;
      try { playback = getState?.()?.playback === true; } catch { /* optional */ }
      if (playback) replaySessions.add(live);
      else playback = replaySessions.has(live);
      if (current && (live !== owner || playback || events.some(event => endEvents.has(event)) ||
        timer.phase === 'ready' || timer.startTick !== startTick)) {
        end('reset', live);
      }
      if (events.includes('start') && !playback) {
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
    get currentMap() { return lastMap; },
    get currentMapName() { return lastMapName; },
    get running() { return !!current; },
    runs() { return runs; },
    clear(map) {
      runs = map ? runs.filter(run => run.map !== map) : [];
      save();
      notify();
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
