import { describe, expect, test } from 'bun:test';
import { createRunHistory, HISTORY_KEY, retainRuns, summarize } from '../src/run-history.js';
import { runsView } from '../src/runs-panel.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = String(value); }, removeItem: key => { delete data[key]; } };
}
// The IndexedDB run store, in memory: one record per run.
function memoryStore(initial = []) {
  const data = new Map(initial.map(run => [run.id, structuredClone(run)]));
  return {
    data,
    load: async () => [...data.values()].map(run => structuredClone(run)),
    put: async run => { data.set(run.id, structuredClone(run)); },
    remove: async ids => { for (const id of ids) data.delete(id); },
  };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

// A fake live session plus the metrics accessors the recorder reads.
function rig({ store = memoryStore(), legacy = memoryStorage(), map = { id: 'utopia', version: 3, stages: [] }, playback = false, onReplay = null, limits, onPrune } = {}) {
  let now = 1000;
  const live = {
    map, practice: false, checkpointSpeeds: [], replayFormat: 8, config: { dt: 0.015 },
    initialState: { spawn: true }, commands: [],
    state: { tick: 0, velocity: { x: 0, y: 0, z: 0 } },
    timer: { state: { phase: 'ready', elapsed: 0, splits: [], startTick: null, invalidReason: '' } },
  };
  const board = { available: false, loss: 0, sequence: 0, surfaceId: null, visit: null };
  const surf = { available: false, sequence: 0 };
  const air = { available: false, sequence: 0 };
  let revision = 0;
  const metrics = {
    boardRevision: () => revision,
    boardSnapshot: () => ({ ...board }),
    surfSnapshot: sequence => surf.sequence !== sequence ? { ...surf } : null,
    airSnapshot: sequence => air.sequence !== sequence ? { ...air } : null,
  };
  const start = { snapshot: () => ({ available: true, speed: 348.4, heightAboveFloor: 4.25 }) };
  const state = { playback, strafeSync: { percentage: 91.26 } };
  const snapshots = { count: 0 };
  const getState = () => { snapshots.count++; return state; };
  const history = createRunHistory({ metrics, start, store, legacy, onReplay, limits, onPrune, getState, getMapName: () => 'Utopia', clock: () => now });
  const tick = (events = [], seconds = 0.015) => {
    now += seconds * 1000;
    live.state = { tick: live.state.tick + 1, velocity: live.state.velocity };
    live.commands.push({ tick: live.state.tick });
    if (live.timer.state.phase === 'running') live.timer.state.elapsed += seconds;
    history.observe(live, events);
  };
  return {
    live, history, store, legacy, state, snapshots, tick,
    go(speed = 350) {
      live.state.velocity = { x: speed, y: 0, z: 0 };
      live.timer.state = { ...live.timer.state, phase: 'running', elapsed: 0, splits: [], startTick: live.state.tick + 0.5 };
      live.checkpointSpeeds = [];
      tick(['start']);
    },
    checkpoint(speed) {
      live.timer.state.splits.push(live.timer.state.elapsed);
      live.checkpointSpeeds.push(speed);
      tick(['checkpoint']);
    },
    ramp({ boardLoss, down, up, surfaceId = 1, hidden = false }) {
      Object.assign(board, { available: true, loss: boardLoss, sequence: board.sequence + 1, surfaceId, visit: 1 });
      revision++;
      tick();
      Object.assign(surf, hidden
        ? { available: false, loss: null, downLoss: null, upLoss: null, exitSpeed: null, reason: 'not-tracked-while-hidden' }
        : { available: true, loss: down + up, downLoss: down, upLoss: up, exitSpeed: 2500, reason: '' },
      { sequence: surf.sequence + 1, surfaceId, visit: 1, checkpoint: 0 });
      tick();
    },
    flight(braking, missed) {
      Object.assign(air, { available: true, loss: braking + missed, brakingLoss: braking, missedGain: missed, measuredSeconds: 1, sequence: air.sequence + 1 });
      tick();
    },
    finish() { live.timer.state.phase = 'finished'; tick(['finish']); },
  };
}

describe('run history', () => {
  test('records a finished run with splits, start, ramps, air and sync', async () => {
    const r = rig();
    r.go();
    for (let i = 0; i < 100; i++) r.tick();
    r.ramp({ boardLoss: 3.2, down: 14.6, up: 38.1 });
    r.flight(4, 5.5);
    r.checkpoint(2412);
    r.live.state.velocity = { x: 3000, y: 400, z: 0 };
    r.tick();
    r.finish();
    const [run] = r.history.runs();
    expect(run).toMatchObject({
      outcome: 'finished', mapName: 'Utopia', map: 'utopia:3', practice: false, kind: 'CP',
      start: { speed: 348.4, height: 4.3 }, sync: 91.3, topSpeed: 3026.5,
      board: { total: 3.2, count: 1 }, surf: { down: 14.6, up: 38.1, loss: 52.7, count: 1 },
      air: { loss: 9.5, braking: 4, missed: 5.5, count: 1 },
    });
    expect(run.checkpoints).toEqual([{ split: expect.any(Number), speed: 2412, command: expect.any(Number) }]);
    expect(run.ramps).toEqual([{ checkpoint: 0, board: 3.2, down: 14.6, up: 38.1, exit: 2500 }]);
    expect(run.time).toBeCloseTo(1.59, 3);
    await flush();
    expect([...r.store.data.values()]).toEqual([run]);
  });

  test('a ramp surfed with Ramp hidden keeps Board, falls back to the current speed and says why', () => {
    const r = rig();
    r.go(2600);
    for (let i = 0; i < 100; i++) r.tick();
    r.ramp({ boardLoss: 3.2, down: 0, up: 0, hidden: true });
    r.finish();
    const [run] = r.history.runs();
    expect(run.ramps).toEqual([{ checkpoint: 0, board: 3.2, down: null, up: null, exit: 2600, missing: 'hidden' }]);
    expect(run.surf).toMatchObject({ count: 0, unavailable: 1 });
  });

  test('each run hands over its replay: the session log up to the end, and where it left the start', () => {
    const saved = [];
    const r = rig({ onReplay: (run, replay) => saved.push({ run, replay }) });
    for (let i = 0; i < 20; i++) r.tick();
    r.go();
    for (let i = 0; i < 50; i++) r.tick();
    r.checkpoint(2000);
    for (let i = 0; i < 30; i++) r.tick();
    // A restart swaps in a fresh log, as the game does; the old one must survive.
    r.live.commands = [];
    r.tick(['restart']);
    const [{ run, replay }] = saved;
    expect(replay).toMatchObject({ format: 8, mapId: 'utopia', mapVersion: 3, config: { dt: 0.015 }, initialState: { spawn: true } });
    expect(replay.commands).toHaveLength(102);
    expect(run.replay).toEqual({ start: 20, length: 102, dt: 0.015 });
    expect(run.checkpoints[0].command).toBe(72);
  });

  test('a restart ends the run as a reset, keeping the splits reached', () => {
    const r = rig();
    r.go();
    for (let i = 0; i < 100; i++) r.tick();
    r.checkpoint(2000);
    r.live.checkpointSpeeds = [];
    r.tick(['restart']);
    const [run] = r.history.runs();
    expect(run.outcome).toBe('reset');
    expect(run.checkpoints).toHaveLength(1);
  });

  test('an instant restart out of the start zone is not recorded', () => {
    const r = rig();
    r.go();
    r.tick();
    r.history.reset();
    expect(r.history.runs()).toHaveLength(0);
  });

  test('a new start while running closes the previous run', () => {
    const r = rig();
    r.go();
    for (let i = 0; i < 100; i++) r.tick();
    r.go();
    expect(r.history.runs()).toHaveLength(1);
    expect(r.history.running).toBe(true);
  });

  test('replays never record', () => {
    const r = rig({ playback: true });
    r.go();
    for (let i = 0; i < 100; i++) r.tick();
    r.finish();
    expect(r.history.runs()).toHaveLength(0);
  });

  test('history persists across page loads, applies the runs-per-map limit on load, and can be cleared', async () => {
    const store = memoryStore();
    let kept = null;
    const first = rig({ store, limits: () => ({ runsPerMap: 12 }), onPrune: ids => { kept = ids; } });
    await first.history.ready;
    for (let i = 0; i < 15; i++) {
      first.go();
      for (let t = 0; t < 70; t++) first.tick();
      first.finish();
    }
    expect(first.history.runs()).toHaveLength(12);
    expect(kept).toEqual(new Set(first.history.runs().map(run => run.id)));
    await flush();
    expect(store.data.size).toBe(12);
    expect(first.history.usage()).toMatchObject({ runs: 12, maps: 1 });
    expect(first.history.usage().bytes).toBeGreaterThan(12 * 100);
    const second = rig({ store, limits: () => ({ runsPerMap: 5 }) });
    await second.history.ready;
    expect(second.history.runs()).toHaveLength(5);
    await flush();
    expect(store.data.size).toBe(5);
    await second.history.clear('utopia:3');
    const third = rig({ store });
    await third.history.ready;
    expect(third.history.runs()).toHaveLength(0);
  });

  test('a history saved by older versions in localStorage moves into the store once', async () => {
    const old = (id, at) => ({ id, map: 'utopia:3', mapName: 'Utopia', session: 1, at, time: 50, outcome: 'finished', checkpoints: [], ramps: [] });
    const legacy = memoryStorage({ [HISTORY_KEY]: JSON.stringify({ runs: [old('a', 2), old('b', 1), { id: 'broken' }] }) });
    const store = memoryStore([old('b', 1)]);
    const r = rig({ store, legacy });
    await r.history.ready;
    expect(r.history.runs().map(run => run.id)).toEqual(['b', 'a']);
    expect([...store.data.keys()].sort()).toEqual(['a', 'b']);
    expect(legacy.data[HISTORY_KEY]).toBeUndefined();
  });

  test('a history that fails to load never prunes, so no replay is deleted', async () => {
    let pruned = 0;
    const store = { ...memoryStore(), load: async () => { throw new Error('broken'); } };
    const r = rig({ store, onPrune: () => { pruned++; } });
    await r.history.ready;
    r.go();
    for (let t = 0; t < 100; t++) r.tick();
    r.finish();
    expect(r.history.runs()).toHaveLength(1);
    expect(pruned).toBe(0);
  });

  test('the game snapshot is read when a run starts and ends, not every tick', () => {
    const r = rig();
    r.go();
    for (let t = 0; t < 500; t++) r.tick();
    r.finish();
    expect(r.history.runs()).toHaveLength(1);
    expect(r.snapshots.count).toBe(2);
  });

  test('discard drops the run in progress without recording it', () => {
    const r = rig();
    r.go();
    for (let t = 0; t < 100; t++) r.tick();
    r.history.discard();
    r.finish();
    expect(r.history.runs()).toHaveLength(0);
  });

  test('limits keep the newest runs, the most recently played maps and the latest sessions', () => {
    const run = (id, map, session) => ({ id, map, session });
    const runs = [run(1, 'a', 1), run(2, 'b', 1), run(3, 'a', 2), run(4, 'c', 2), run(5, 'a', 3), run(6, 'b', 3)];
    const ids = limits => retainRuns(runs, limits).map(entry => entry.id);
    expect(ids({})).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ids({ runsPerMap: 1 })).toEqual([4, 5, 6]);
    // b and a were played most recently; c is older.
    expect(ids({ maps: 2 })).toEqual([1, 2, 3, 5, 6]);
    expect(ids({ sessions: 2 })).toEqual([3, 4, 5, 6]);
    expect(ids({ sessions: 1, maps: 1 })).toEqual([6]);
  });

  test('a corrupt old history is ignored and left where it is', async () => {
    const legacy = memoryStorage({ [HISTORY_KEY]: '{nope' });
    const r = rig({ legacy });
    await r.history.ready;
    expect(r.history.runs()).toEqual([]);
    expect(legacy.data[HISTORY_KEY]).toBe('{nope');
  });
});

describe('runs view', () => {
  const run = (overrides) => ({ map: 'a:1', mapName: 'A', session: 1, at: 0, outcome: 'finished', time: 50, practice: false, invalid: '',
    start: { speed: 340 }, sync: 90, checkpoints: [], ramps: [], board: {}, surf: {}, air: {}, ...overrides });

  test('summary excludes practice, invalid and reset runs from times', () => {
    const summary = summarize([run({ time: 40, practice: true }), run({ time: 42, invalid: 'Teleported' }), run({ time: 45, outcome: 'reset' }), run({ time: 48 }), run({ time: 52 })]);
    expect(summary).toMatchObject({ count: 5, finished: 2, average: 50, bestStart: 340, averageSync: 90 });
    expect(summary.best.time).toBe(48);
  });

  test('session scope spans maps; map scope reads every saved run of the current map', () => {
    const all = [run({ session: 0, time: 30 }), run({ session: 1, time: 55 }), run({ session: 1, map: 'b:1', mapName: 'B', time: 70 })];
    const session = runsView(all, { scope: 'session', session: 1, map: 'b:1' });
    expect(session.rows.map(row => row.run.time)).toEqual([70, 55]);
    expect(session.multipleMaps).toBe(true);
    expect(session.rows.every(row => row.best)).toBe(true);
    const map = runsView(all, { scope: 'map', session: 1, map: 'a:1' });
    expect(map.rows.map(row => [row.number, row.run.time, row.best])).toEqual([[2, 55, false], [1, 30, true]]);
    expect(map.mapName).toBe('A');
  });
});
