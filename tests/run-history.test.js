import { describe, expect, test } from 'bun:test';
import { createRunHistory, LEAD_SECONDS, retainRuns } from '../src/run-history.js';
import { trimReplay } from '../src/replay-trim.js';

// The IndexedDB history store, in memory: one record per run and per map's bests.
function memoryStore({ runs = [], bests = [] } = {}) {
  const data = { runs: new Map(runs.map(run => [run.id, structuredClone(run)])), bests: new Map(bests.map(record => [record.id, structuredClone(record)])) };
  return {
    data,
    load: async () => ({ runs: [...data.runs.values()].map(run => structuredClone(run)), bests: [...data.bests.values()].map(record => structuredClone(record)) }),
    put: async run => { data.runs.set(run.id, structuredClone(run)); },
    remove: async ids => { for (const id of ids) data.runs.delete(id); },
    putBests: async record => { data.bests.set(record.id, structuredClone(record)); },
    removeBests: async ids => { for (const id of ids) data.bests.delete(id); },
  };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const DT = 0.015;

// A fake live session plus the metrics accessors the recorder reads.
// `now` is the page-load time; run IDs include it, as they do in the game.
function rig({ store = memoryStore(), map = { id: 'utopia', version: 3, stages: [] }, playback = false, onReplay = null, limits = () => ({ minSeconds: 0 }), onPrune, wantsReplay, now = 1000, clock = null } = {}) {
  const live = {
    map, practice: false, checkpointSpeeds: [], replayFormat: 8, config: { dt: DT },
    initialState: { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, tick: 0 }, commands: [],
    state: { tick: 0, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } },
    timer: { state: { phase: 'ready', elapsed: 0, splits: [], startTick: null, invalidReason: '' } },
  };
  const board = { available: false, loss: 0, sequence: 0, surfaceId: null, visit: null };
  const surf = { available: false, sequence: 0 };
  let revision = 0;
  const metrics = {
    boardRevision: () => revision,
    boardSnapshot: () => ({ ...board }),
    surfSnapshot: sequence => surf.sequence !== sequence ? { ...surf } : null,
  };
  const start = { snapshot: () => ({ available: true, speed: 348.4, heightAboveFloor: 4.25 }) };
  const state = { playback };
  const snapshots = { count: 0 };
  const getState = () => { snapshots.count++; return state; };
  const history = createRunHistory({ metrics, start, store, onReplay, limits, onPrune, wantsReplay, getState, getMapName: () => 'Utopia', clock: clock ?? (() => now) });
  let standing = false;
  const tick = (events = [], seconds = DT) => {
    now += seconds * 1000;
    const tick = live.state.tick + 1;
    live.state = { tick, position: { x: tick, y: 0, z: 0 }, velocity: standing ? { x: 0, y: 0, z: 0 } : live.state.velocity,
      grounded: standing, ducked: false, duckFraction: 0, jumpHeld: false };
    live.commands.push({ tick });
    if (live.timer.state.phase === 'running') live.timer.state.elapsed += seconds;
    history.observe(live, events);
  };
  return {
    live, history, store, state, snapshots, tick,
    idle(seconds, { still = false } = {}) {
      standing = still;
      if (!still) live.state.velocity = { x: 1, y: 0, z: 0 };
      for (let i = 0; i < Math.round(seconds / DT); i++) tick();
      standing = false;
    },
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
    ramp({ boardLoss, surfLoss, down = null, up = null, surfaceId = 1, checkpoint = live.checkpointSpeeds.length, visit = 1, hidden = false, nextBoard = null }) {
      Object.assign(board, { available: true, loss: boardLoss, sequence: board.sequence + 1, surfaceId, visit, checkpoint });
      revision++;
      tick();
      Object.assign(surf, hidden ? { available: false, loss: null, downLoss: null, upLoss: null } : { available: true, loss: surfLoss, downLoss: down, upLoss: up },
        { sequence: surf.sequence + 1, surfaceId, visit, checkpoint });
      // A direct ramp-to-ramp tick publishes the old Surf and the new Board together.
      if (nextBoard) { Object.assign(board, nextBoard, {sequence: board.sequence + 1}); revision++; }
      tick();
    },
    finish() { live.timer.state.phase = 'finished'; tick(['finish']); },
    restart() { live.commands = []; live.timer.state = { ...live.timer.state, phase: 'ready' }; tick(['restart']); },
    // A complete run: n ticks, then finished or reset.
    run({ ticks = 100, finish = true, practice = false, invalid = '' } = {}) {
      live.practice = practice;
      this.go();
      live.timer.state.invalidReason = invalid;
      for (let i = 0; i < ticks; i++) tick();
      if (finish) this.finish(); else this.restart();
      live.practice = false;
      live.timer.state.invalidReason = '';
    },
  };
}

const attempts = view => [view.latest, ...view.recent].filter(Boolean);

describe('run history', () => {
  test('records a run compactly and saves it as one record', async () => {
    const r = rig();
    await r.history.ready;
    r.go();
    for (let i = 0; i < 100; i++) r.tick();
    r.checkpoint(2412);
    r.finish();
    const [run] = r.history.runs();
    expect(run).toMatchObject({ outcome: 'finished', mapName: 'Utopia', map: 'utopia:3', practice: false, invalid: '', kind: 'CP',
      start: { speed: 348.4, height: 4.3 } });
    expect(run.checkpoints).toEqual([{ split: expect.any(Number), speed: 2412, command: expect.any(Number) }]);
    await flush();
    expect([...r.store.data.runs.values()]).toEqual([run]);
  });

  test('pruning and clearing never reuse a run ID within the same clock millisecond', async () => {
    const ids = [];
    const r = rig({clock: () => 1000, limits: () => ({runsPerMap: 1, minSeconds: 0}),
      onReplay: run => ids.push(run.id)});
    await r.history.ready;
    for (let i = 0; i < 3; i++) r.run({ticks: 1, finish: false});
    expect(new Set(ids).size).toBe(3);
    expect(r.history.runs()).toHaveLength(1);
    expect(r.history.runs()[0].id).toBe(ids[2]);
    await r.history.clear();
    r.run({ticks: 1, finish: false});
    expect(new Set(ids).size).toBe(4);
    await flush();
    expect([...r.store.data.runs.keys()]).toEqual([ids[3]]);
  });

  test('each run hands over its replay: the session log up to the end, and where it left the start', () => {
    const saved = [];
    const r = rig({ onReplay: (run, replay, clip) => saved.push({ run, replay, clip }) });
    r.idle(0.3);
    r.go();
    for (let i = 0; i < 50; i++) r.tick();
    r.checkpoint(2000);
    for (let i = 0; i < 30; i++) r.tick();
    r.restart();
    const [{ run, replay, clip }] = saved;
    expect(replay).toMatchObject({ format: 8, mapId: 'utopia', mapVersion: 3, config: { dt: DT } });
    expect(replay.commands).toHaveLength(102);
    expect(run.replay).toEqual({ start: 20, length: 102, dt: DT });
    expect(run.checkpoints[0].command).toBe(72);
    // Under five seconds of waiting: nothing to trim.
    expect(clip).toBeNull();
  });

  test(`a long wait before the start offers a trim to ${LEAD_SECONDS} seconds before it, from a recorded state`, () => {
    const saved = [];
    const r = rig({ onReplay: (run, replay, clip) => saved.push({ run, replay, clip }) });
    r.idle(30);
    r.go();
    for (let i = 0; i < 100; i++) r.tick();
    r.finish();
    const [{ run, clip }] = saved;
    const lead = Math.round(LEAD_SECONDS / DT);
    const [cut] = clip.candidates;
    expect(clip.candidates).toHaveLength(1);
    expect(cut.index).toBeLessThanOrEqual(run.replay.start - lead);
    expect(cut.index).toBeGreaterThan(run.replay.start - lead - 16);
    // The state after `index` commands, in the shape of the game's initial state.
    expect(cut.state).toEqual({ position: { x: cut.index, y: 0, z: 0 }, velocity: { x: 1, y: 0, z: 0 }, tick: cut.index });
    expect(clip).toMatchObject({ start: run.replay.start, expect: { position: { x: run.replay.start + 1, y: 0, z: 0 } }, map: r.live.map });
  });

  test('a wait under ten seconds is kept as it is: trimming it would save too little', () => {
    const saved = [];
    const r = rig({ onReplay: (run, replay, clip) => saved.push(clip) });
    r.idle(8);
    r.run();
    expect(saved).toEqual([null]);
  });

  test('the last moment of standing fully still before the cut is offered as a fallback trim', () => {
    const saved = [];
    const r = rig({ onReplay: (run, replay, clip) => saved.push({ run, clip }) });
    r.idle(20, { still: true });
    const stillUntil = r.live.commands.length;
    r.idle(8);
    r.run();
    const [{ run, clip }] = saved;
    const [cut, still] = clip.candidates;
    expect(cut.index).toBeLessThanOrEqual(run.replay.start - Math.round(LEAD_SECONDS / DT));
    expect(still.index).toBeLessThanOrEqual(stillUntil);
    expect(still.index).toBeGreaterThan(stillUntil - 66 - 16);
    expect(still.state.velocity).toEqual({ x: 0, y: 0, z: 0 });
  });

  test('no replay and no pre-start recording when replays are off', () => {
    const saved = [];
    const r = rig({ onReplay: (...args) => saved.push(args), wantsReplay: () => false });
    r.idle(10);
    r.run();
    expect(saved).toHaveLength(0);
    expect(r.history.runs()[0].replay).toBeUndefined();
  });

  test('a restart ends the run as a reset, keeping the checkpoints reached', () => {
    const r = rig();
    r.go();
    for (let i = 0; i < 100; i++) r.tick();
    r.checkpoint(2000);
    r.restart();
    const [run] = r.history.runs();
    expect(run.outcome).toBe('reset');
    expect(run.checkpoints).toHaveLength(1);
  });

  test('the latest instant reset stays accessible and a new start closes the previous run', () => {
    const r = rig({ limits: () => ({}) });
    r.go();
    r.tick();
    r.history.reset();
    const previous = r.history.runs()[0];
    expect(previous).toMatchObject({outcome: 'reset', time: 0.03});
    expect(r.history.view().latest).toMatchObject({id: previous.id});
    r.go();
    for (let i = 0; i < 100; i++) r.tick();
    r.go();
    expect(r.history.runs().map(run => run.id)).not.toContain(previous.id);
    expect(r.history.view().latest).toMatchObject({outcome: 'reset'});
    expect(r.history.running).toBe(true);
  });

  test('replays never record, and the game snapshot is read only when a run starts', () => {
    const replay = rig({ playback: true });
    replay.run();
    expect(replay.history.runs()).toHaveLength(0);
    const r = rig();
    r.go();
    for (let t = 0; t < 500; t++) r.tick();
    r.finish();
    expect(r.history.runs()).toHaveLength(1);
    expect(r.snapshots.count).toBe(1);
  });

  test('discard drops the run in progress without recording it', () => {
    const r = rig();
    r.go();
    for (let t = 0; t < 100; t++) r.tick();
    r.history.discard();
    r.finish();
    expect(r.history.runs()).toHaveLength(0);
  });
});

describe('bests', () => {
  test('best checkpoint times come from any clean run, finished or not; practice and invalid runs never count', async () => {
    const r = rig();
    await r.history.ready;
    r.go(); for (let i = 0; i < 100; i++) r.tick(); r.checkpoint(2000); for (let i = 0; i < 100; i++) r.tick(); r.checkpoint(2500); r.finish();
    r.go(); for (let i = 0; i < 80; i++) r.tick(); r.checkpoint(2100); r.restart();
    r.live.practice = true;
    r.go(); for (let i = 0; i < 10; i++) r.tick(); r.checkpoint(9999); r.idle(2); r.restart();
    r.live.practice = false;
    const view = r.history.view();
    expect(view.splits.map(split => [split.label, split.speed])).toEqual([['CP1', 2100], ['CP2', 2500]]);
    expect(view.splits[0].time).toBeCloseTo(81 * DT, 6);
    expect(attempts(view).map(run => run.outcome)).toEqual(['reset', 'reset', 'finished']);
    expect(view.latest).toMatchObject({ practice: true, checkpoints: 1, totalCheckpoints: 2 });
  });

  test('best Board and Surf per ramp, matched by surface, checkpoint and visit, in route order', async () => {
    const r = rig();
    await r.history.ready;
    r.go();
    r.ramp({ boardLoss: 4, surfLoss: 30, surfaceId: 7 });
    r.ramp({ boardLoss: 9, surfLoss: 12, surfaceId: 8 });
    r.idle(2);
    r.restart();
    r.go();
    r.ramp({ boardLoss: 2, surfLoss: 35, surfaceId: 7 });
    r.ramp({ boardLoss: 5, surfLoss: null, surfaceId: 8, hidden: true });
    r.ramp({ boardLoss: 1, surfLoss: 1, surfaceId: 9 });
    r.idle(2);
    r.restart();
    // Keyed like the HUD's PB/WR references (visitKey), so the two compare.
    expect(r.history.view().ramps).toEqual([
      { key: '[7,0,1]', label: 'Ramp 1', checkpoint: 0, board: 2, down: null, up: null, surf: 30 },
      { key: '[8,0,1]', label: 'Ramp 2', checkpoint: 0, board: 5, down: null, up: null, surf: 12 },
      { key: '[9,0,1]', label: 'Ramp 3', checkpoint: 0, board: 1, down: null, up: null, surf: 1 },
    ]);
  });

  test('ramps are listed along one route: repeat visits and other lines improve bests but add no rows', async () => {
    const r = rig();
    await r.history.ready;
    // The PB route: ramps 7, 8, 9.
    r.go(); r.ramp({ boardLoss: 6, surfLoss: 30, surfaceId: 7 }); r.ramp({ boardLoss: 5, surfLoss: 20, surfaceId: 8 });
    r.ramp({ boardLoss: 4, surfLoss: 10, surfaceId: 9 }); r.idle(1); r.finish();
    // A sloppier run: a bounce re-boards ramp 7 (visit 2), then another line (ramp 12).
    r.go(); r.ramp({ boardLoss: 1, surfLoss: 25, surfaceId: 7 }); r.ramp({ boardLoss: 2, surfLoss: 9, surfaceId: 7, visit: 2 });
    r.ramp({ boardLoss: 3, surfLoss: 8, surfaceId: 12 }); r.idle(1); r.restart();
    const view = r.history.view();
    expect(view.ramps.map(ramp => [ramp.label, ramp.key, ramp.board])).toEqual([
      ['Ramp 1', '[7,0,1]', 1], ['Ramp 2', '[8,0,1]', 5], ['Ramp 3', '[9,0,1]', 4]]);
    expect(r.history.rampNumber('utopia:3', '[9,0,1]')).toBe(3);
    expect(r.history.rampNumber('utopia:3', '[7,0,2]')).toBeNull();
  });

  test('the current map is the one the game has loaded, before any run starts', async () => {
    let map = null;
    const history = createRunHistory({ getMap: () => map, getMapName: () => 'Utopia' });
    expect(history.currentMap).toBe('');
    map = { id: 'utopia', version: 3 };
    expect([history.currentMap, history.currentMapName]).toEqual(['utopia:3', 'Utopia']);
  });

  test('each run with a replay marks its ramp boards for the timeline', async () => {
    const r = rig({ onReplay: () => {} });
    await r.history.ready;
    r.go(); r.idle(1);
    r.ramp({ boardLoss: 4, surfLoss: 30, surfaceId: 7 });
    r.ramp({ boardLoss: 9, surfLoss: 12, surfaceId: 8 });
    r.idle(1); r.finish();
    const [run] = r.history.runs();
    expect(run.boards.map(([, loss, key]) => [loss, key])).toEqual([[4, '[7,0,1]'], [9, '[8,0,1]']]);
    expect(run.boards[0][0]).toBeGreaterThan(run.replay.start);
    // No replay, nothing to mark.
    const quiet = rig({ onReplay: () => {}, wantsReplay: () => false });
    await quiet.history.ready;
    quiet.go(); quiet.ramp({ boardLoss: 4, surfLoss: 30 }); quiet.idle(1); quiet.finish();
    expect(quiet.history.runs()[0].boards).toBeUndefined();
  });

  test('totals count every attempt; each checkpoint best carries the PB split; ramps keep their best down and up', async () => {
    const r = rig();
    await r.history.ready;
    r.go(); r.ramp({ boardLoss: 3, surfLoss: 10, down: 6, up: 4 }); r.idle(2); r.checkpoint(2000); r.idle(1); r.finish();
    r.go(); r.ramp({ boardLoss: 5, surfLoss: 9, down: 7, up: 2 }); r.idle(1); r.checkpoint(2100); r.idle(2); r.restart();
    r.run({ ticks: 300, practice: true });
    r.go(); r.idle(3); r.checkpoint(1900); r.idle(1); r.finish();
    const view = r.history.view();
    expect(view.totals).toEqual({ attempts: 3, finishes: 2 });
    // The reset run was fastest to CP1; the PB (first run) got there later.
    expect(view.splits[0].speed).toBe(2100);
    expect(view.splits[0].pb).toBeGreaterThan(view.splits[0].time);
    expect(view.pb.time).toBeLessThan(view.latest.time);
    expect(view.ramps[0]).toMatchObject({ board: 3, down: 6, up: 2, surf: 9 });
  });

  test('start speed keeps its best and average; the best run is the fastest clean finish', async () => {
    const r = rig();
    await r.history.ready;
    r.run({ ticks: 200 });
    r.run({ ticks: 100 });
    r.run({ ticks: 50, invalid: 'Teleported' });
    r.run({ ticks: 150 });
    const view = r.history.view();
    expect(view.start).toEqual({ best: 348.4, average: 348.4, count: 3 });
    expect(view.pb).toMatchObject({ outcome: 'finished', time: expect.closeTo(101 * DT, 6) });
  });

  test('the best run stays, beyond the runs-per-map limit, until beaten', async () => {
    const store = memoryStore();
    let kept = null;
    const r = rig({ store, limits: () => ({ runsPerMap: 3 }), onPrune: ids => { kept = ids; } });
    await r.history.ready;
    r.run({ ticks: 50 });
    const bestId = r.history.view().pb.id;
    for (let i = 0; i < 5; i++) r.run({ ticks: 300 });
    expect(r.history.runs()).toHaveLength(4);
    expect(kept.has(bestId)).toBe(true);
    expect(attempts(r.history.view())).toHaveLength(3);
    r.run({ ticks: 20 });
    expect(r.history.view().pb.id).not.toBe(bestId);
    expect(r.history.runs().some(run => run.id === bestId)).toBe(false);
    await flush();
    expect(store.data.runs.size).toBe(3);
  });

  test('runs and bests persist across page loads; limits apply on load; clear removes both', async () => {
    const store = memoryStore();
    const first = rig({ store, limits: () => ({ runsPerMap: 12 }) });
    await first.history.ready;
    for (let i = 0; i < 15; i++) first.run({ ticks: 70 + i });
    await flush();
    // The twelve newest, plus the best (the first, shortest run).
    expect(store.data.runs.size).toBe(13);
    expect(store.data.bests.size).toBe(1);
    expect(first.history.usage()).toMatchObject({ runs: 13, maps: 1 });
    const second = rig({ store, limits: () => ({ runsPerMap: 5 }) });
    await second.history.ready;
    // The five newest, plus the best (the first, shortest run).
    expect(second.history.runs()).toHaveLength(6);
    expect(second.history.view('utopia:3').pb.time).toBeCloseTo(71 * DT, 6);
    expect(second.history.maps()).toEqual([{ key: 'utopia:3', name: 'Utopia', at: expect.any(Number), runs: 6 }]);
    await second.history.clear('utopia:3');
    const third = rig({ store });
    await third.history.ready;
    expect(third.history.runs()).toHaveLength(0);
    expect(third.history.view('utopia:3')).toBeNull();
  });

  test('a history that fails to load never prunes, so no replay is deleted', async () => {
    let pruned = 0;
    const store = { ...memoryStore(), load: async () => { throw new Error('broken'); } };
    const r = rig({ store, onPrune: () => { pruned++; } });
    await r.history.ready;
    r.run();
    expect(r.history.runs()).toHaveLength(1);
    expect(pruned).toBe(0);
  });

  test('runs that end before the saved history loads add to the saved bests', async () => {
    const store = memoryStore();
    const first = rig({ store });
    await first.history.ready;
    first.run({ ticks: 40 });
    await flush();
    const second = rig({ store, now: 999999 });
    second.run({ ticks: 90 });
    await second.history.ready;
    await flush();
    expect(second.history.view().pb.time).toBeCloseTo(41 * DT, 6);
    expect(second.history.view().start.count).toBe(2);
  });

  test('a trimmed replay moves the run’s start and length once', () => {
    const r = rig({ onReplay: () => {} });
    r.run();
    const run = r.history.runs()[0];
    const before = { ...run.replay };
    r.history.setReplayOffset(run.id, 10);
    r.history.setReplayOffset(run.id, 10);
    expect(run.replay).toEqual({ start: before.start - 10, length: before.length - 10, dt: DT, offset: 10 });
  });

  test('retention keeps the newest per map and every pinned run', () => {
    const run = (id, map) => ({ id, map, outcome: 'reset', time: 12 });
    const runs = [run('1', 'a'), run('2', 'b'), run('3', 'a'), run('4', 'a'), run('5', 'b')];
    expect(retainRuns(runs, { runsPerMap: 1 }).map(entry => entry.id)).toEqual(['4', '5']);
    expect(retainRuns(runs, { runsPerMap: 1, keep: new Set(['1']) }).map(entry => entry.id)).toEqual(['1', '4', '5']);
  });
});

describe('ramp transition recording', () => {
  test('a new ramp board cannot replace the board belonging to the completed ramp', async () => {
    const r = rig();
    await r.history.ready;
    r.go();
    r.ramp({boardLoss: 3.4, surfLoss: 22.5, surfaceId: 1,
      nextBoard: {surfaceId: 2, visit: 1, checkpoint: 0, loss: 8.6}});
    r.ramp({boardLoss: 8.6, surfLoss: 44.5, surfaceId: 2});
    r.finish();
    expect(r.history.view().ramps.map(ramp => ({board: ramp.board, surf: ramp.surf}))).toEqual([
      {board: 3.4, surf: 22.5},
      {board: 8.6, surf: 44.5},
    ]);
  });
});

describe('minimum history duration', () => {
  test('repeated start resets keep the latest replay without evicting qualifying runs', async () => {
    let kept = new Set();
    const replayIds = new Set();
    const r = rig({
      limits: () => ({runsPerMap: 3}),
      onReplay: run => { replayIds.add(run.id); },
      onPrune: ids => { kept = ids; for (const id of replayIds) if (!ids.has(id)) replayIds.delete(id); },
    });
    await r.history.ready;
    for (let i = 0; i < 3; i++) r.run({ticks: 800, finish: false});
    const qualified = r.history.runs().map(run => run.id);
    let previous;
    for (let i = 0; i < 8; i++) {
      r.run({ticks: 2, finish: false});
      const view = r.history.view();
      expect(view.recent.map(run => run.id)).toEqual(qualified.toReversed());
      expect(view.latest).toMatchObject({time: 0.045});
      if (previous) expect(kept.has(previous)).toBe(false);
      previous = view.latest.id;
    }
    expect([...replayIds].sort()).toEqual([...qualified, previous].sort());
    await flush();
    expect([...r.store.data.runs.keys()].sort()).toEqual([...qualified, previous].sort());
    const reload = rig({store: r.store, limits: () => ({runsPerMap: 3})});
    await reload.history.ready;
    expect(attempts(reload.history.view('utopia:3')).map(run => run.id)).toEqual([previous, ...qualified.toReversed()]);
  });

  test('cutoff is inclusive, completed runs bypass it, and zero disables filtering', () => {
    const runs = [
      {id: 'under', map: 'a', outcome: 'reset', time: 9.999},
      {id: 'boundary', map: 'a', outcome: 'reset', time: 10},
      {id: 'finish', map: 'a', outcome: 'finished', time: 1},
      {id: 'latest', map: 'a', outcome: 'reset', time: 0},
    ];
    expect(retainRuns(runs).map(run => run.id)).toEqual(['boundary', 'finish', 'latest']);
    expect(retainRuns(runs, {minSeconds: 0}).map(run => run.id)).toEqual(runs.map(run => run.id));
  });

  test('only the latest attempt gets an extra slot, including across maps', () => {
    const runs = [
      {id: 'long-a', map: 'a', outcome: 'reset', time: 15},
      {id: 'short-a', map: 'a', outcome: 'reset', time: 1},
      {id: 'long-b', map: 'b', outcome: 'reset', time: 15},
      {id: 'short-b', map: 'b', outcome: 'reset', time: 1},
    ];
    expect(retainRuns(runs, {runsPerMap: 1}).map(run => run.id)).toEqual(['long-a', 'long-b', 'short-b']);
  });

  test('raising the cutoff prunes older resets and their replays but preserves the latest and best', async () => {
    let minimum = 0, kept;
    const r = rig({limits: () => ({runsPerMap: 3, minSeconds: minimum}), onPrune: ids => { kept = ids; }});
    await r.history.ready;
    r.run({ticks: 10});
    const bestId = r.history.runs().at(-1).id;
    r.run({ticks: 100, finish: false});
    const discarded = r.history.runs().at(-1).id;
    r.run({ticks: 20, finish: false});
    const latestId = r.history.runs().at(-1).id;
    minimum = 10;
    r.history.prune();
    expect([...kept]).toEqual([bestId, latestId]);
    expect(attempts(r.history.view()).map(run => run.id)).toEqual([latestId, bestId]);
    await flush();
    expect(r.store.data.runs.has(discarded)).toBe(false);
  });
});

describe('replay trimming', () => {
  // A tiny deterministic game: x moves by `forward`; reaching x >= 100 starts
  // the run. With `hidden`, jumps (state the initial state doesn't carry) change the start.
  function makeSession({ hidden = false } = {}) {
    return class {
      constructor(map) { this.map = map; }
      loadReplay(replay) { this.state = structuredClone(replay.initialState); this.jumps = 0; this.started = false; }
      step(command) {
        if (hidden && command.jump) this.jumps++;
        this.state.position.x += command.forward + (hidden && this.jumps > 1 ? 1 : 0);
        this.state.velocity.x = command.forward;
        if (!this.started && this.state.position.x >= 100) { this.started = true; return ['start']; }
        return [];
      }
    };
  }
  const commands = Array.from({ length: 200 }, (_, i) => ({ forward: i < 150 ? 0.5 : 1, jump: i === 20 || i === 30 }));
  const replay = { format: 8, config: {}, initialState: { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }, commands };
  // The live run: its state after 120 commands, where it started, and its state then.
  function live(Session) {
    const session = new Session({});
    session.loadReplay(replay);
    let state = null, early = null, start = -1, expected = null;
    commands.forEach((command, index) => {
      const started = session.step(command).includes('start');
      if (index === 9) early = { index: 10, state: structuredClone(session.state) };
      if (index === 119) state = structuredClone(session.state);
      if (started) { start = index; expected = { position: { ...session.state.position }, velocity: { ...session.state.velocity } }; }
    });
    return { candidates: [{ index: 120, state }], start, expect: expected, map: {}, early };
  }

  const now = { yieldTask: async () => {} };
  test('keeps the trimmed replay when re-simulating it reaches the same start', async () => {
    const Session = makeSession();
    const trimmed = await trimReplay(Session, replay, live(Session), now);
    expect(trimmed.offset).toBe(120);
    expect(trimmed.replay.commands).toHaveLength(80);
    expect(trimmed.replay.initialState.position.x).toBe(60);
  });

  test('falls back to the full replay when state outside the initial state changes the start', async () => {
    const Session = makeSession({ hidden: true });
    expect(await trimReplay(Session, replay, live(Session), now)).toBeNull();
    expect(await trimReplay(undefined, replay, live(makeSession()), now)).toBeNull();
  });

  test('when the cut fails, an earlier fallback point that passes is used', async () => {
    const Session = makeSession({ hidden: true });
    const clip = live(Session);
    // The jumps (ticks 20 and 30) lie after the early point, so trimming there keeps them.
    let yields = 0;
    const trimmed = await trimReplay(Session, replay, { ...clip, candidates: [...clip.candidates, clip.early] }, { yieldTask: async () => { yields++; } });
    // The check yields between slices instead of simulating in one block.
    expect(yields).toBeGreaterThan(0);
    expect(trimmed.offset).toBe(10);
    expect(trimmed.replay.commands).toHaveLength(190);
  });
});
