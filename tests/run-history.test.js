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
    clear: async (runs, bests) => {
      for (const id of runs) data.runs.delete(id);
      for (const id of bests) data.bests.delete(id);
    },
  };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const DT = 0.015;


test('a failed clear preserves visible history and bests, and can be retried', async () => {
  const r = rig();
  await r.history.ready;
  r.run();
  await flush();
  const before = structuredClone(r.history.view()), persisted = await r.store.load(), clear = r.store.clear;
  r.store.clear = async () => { throw new Error('Transaction aborted'); };
  await expect(r.history.clear()).rejects.toThrow('Transaction aborted');
  expect(r.history.view()).toEqual(before);
  expect(await r.store.load()).toEqual(persisted);
  r.store.clear = clear;
  await r.history.clear();
  expect(r.history.view()).toBeNull();
  expect(await r.store.load()).toEqual({runs: [], bests: []});
});
// A fake live session plus the metrics accessors the recorder reads.
// `now` is the page-load time; run IDs include it, as they do in the game.
function rig({ store = memoryStore(), map = { id: 'utopia', version: 3, stages: [] }, playback = false, onReplay = null, limits = () => ({ minSeconds: 0 }), onPrune, now = 1000, clock = null } = {}) {
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
  const exit = { available: true, speed: 348.4, heightAboveFloor: 4.25 };
  const start = { snapshot: () => ({ ...exit }) };
  const state = { playback };
  const snapshots = { count: 0 };
  const getState = () => { snapshots.count++; return state; };
  const history = createRunHistory({ metrics, start, store, onReplay, limits, onPrune, getState, getMapName: () => 'Utopia', clock: clock ?? (() => now) });
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
    live, history, store, state, snapshots, tick, exit,
    publishBoard(values) {
      Object.assign(board, {sequence: board.sequence + 1, surfaceId: 1, checkpoint: 0, visit: 1, available: true, crash: false}, values);
      revision++;
      tick();
    },
    reviseBoard(values) { Object.assign(board, values); revision++; tick(); },
    publishSurf(values) {
      Object.assign(surf, {sequence: surf.sequence + 1, surfaceId: 1, checkpoint: 0, visit: 1, available: true, crash: false}, values);
      tick();
    },
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
      Object.assign(board, { available: true, loss: boardLoss, sequence: board.sequence + 1, surfaceId, visit, checkpoint, crash: false });
      revision++;
      tick();
      Object.assign(surf, hidden ? { available: false, loss: null, downLoss: null, upLoss: null } : { available: true, loss: surfLoss, downLoss: down, upLoss: up },
        { sequence: surf.sequence + 1, surfaceId, visit, checkpoint, crash: false });
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
  test('bestTime reads retained browser bests after their run and replay are gone', async () => {
    const first = rig();
    await first.history.ready;
    first.run({ticks: 100});
    await flush();
    const best = first.history.runs()[0].time;
    first.store.data.runs.clear();
    const next = rig({store: first.store});
    await next.history.ready;
    expect(next.history.runs()).toEqual([]);
    expect(next.history.view('utopia:3').pb).toBeNull();
    expect(next.history.bestTime(next.live.map)).toBe(best);
    expect(next.history.bestTime({...next.live.map, version: 4})).toBeNull();
    expect(next.history.bestTime({id: 'other', version: 3})).toBeNull();
  });

  test('bestTime excludes practice and invalid finishes and captures the pre-finish best', async () => {
    const r = rig();
    await r.history.ready;
    r.run({ticks: 1, practice: true});
    r.run({ticks: 1, invalid: 'Teleported'});
    expect(r.history.bestTime(r.live.map)).toBeNull();
    r.run({ticks: 100});
    const best = r.history.bestTime(r.live.map);
    r.go();
    r.tick();
    const beforeFinish = r.history.bestTime(r.live.map);
    r.finish();
    expect(beforeFinish).toBe(best);
    expect(r.history.bestTime(r.live.map)).toBeLessThan(best);
  });

  test('bestTime during hydration merges only finishes that precede its read', async () => {
    const first = rig();
    await first.history.ready;
    first.run({ticks: 100});
    await flush();
    const saved = await first.store.load();
    let resolve;
    const store = memoryStore();
    store.load = () => new Promise(done => { resolve = done; });
    const r = rig({store});
    const beforeAny = r.history.bestTime(r.live.map);
    r.run({ticks: 50});
    const earlier = r.history.runs()[0].time;
    const beforeLatest = r.history.bestTime(r.live.map);
    r.run({ticks: 10});
    resolve(saved);
    expect(await beforeAny).toBe(first.history.bestTime(first.live.map));
    expect(await beforeLatest).toBe(earlier);
    expect(r.history.bestTime(r.live.map)).toBeLessThan(earlier);
  });

  test('a first finish captured during empty hydration remains a first finish', async () => {
    let resolve;
    const store = memoryStore();
    store.load = () => new Promise(done => { resolve = done; });
    const r = rig({store});
    const before = r.history.bestTime(r.live.map);
    r.run();
    resolve({runs: [], bests: []});
    expect(await before).toBeNull();
    expect(r.history.bestTime(r.live.map)).toBe(r.history.runs()[0].time);
  });

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

  test('a session reused after native replay exit records later live attempts', async () => {
    const r = rig({playback: true});
    await r.history.ready;
    const session = r.live;
    r.run();
    expect(r.history.runs()).toHaveLength(0);
    r.state.playback = false;
    r.restart();
    r.run({ticks: 200});
    expect(r.live).toBe(session);
    expect(r.history.runs()).toHaveLength(1);
    expect(r.history.runs()[0]).toMatchObject({outcome: 'finished', practice: false});
    expect(r.history.view().totals).toEqual({attempts: 1, finishes: 1});
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
    const quiet = rig();
    await quiet.history.ready;
    quiet.go(); quiet.ramp({ boardLoss: 4, surfLoss: 30 }); quiet.idle(1); quiet.finish();
    expect(quiet.history.runs()[0].boards).toBeUndefined();
  });

  test('metric sequence resets leave earlier timeline boards intact and revise only the current positive board', async () => {
    const r = rig({onReplay: () => {}});
    await r.history.ready;
    r.go();
    r.publishBoard({surfaceId: 7, loss: 4});
    const first = r.live.commands.length;
    r.reviseBoard({loss: 6});
    r.publishBoard({surfaceId: 8, loss: 9});
    const second = r.live.commands.length;
    // Teleport/stage-reset and analysis-disable snapshots have no board.
    r.reviseBoard({sequence: 0, available: false, surfaceId: null, visit: null});
    r.reviseBoard({sequence: 0, loss: 99});
    r.publishBoard({surfaceId: 9, loss: 11});
    const third = r.live.commands.length;
    r.reviseBoard({loss: 13});
    r.publishBoard({surfaceId: 10, loss: 15});
    const fourth = r.live.commands.length;
    r.finish();
    const expected = [[first, 6, '[7,0,1]'], [second, 9, '[8,0,1]'],
      [third, 13, '[9,0,1]'], [fourth, 15, '[10,0,1]']];
    expect(r.history.view().latest.boards).toEqual(expected);
    await flush();
    const restored = rig({store: r.store});
    await restored.history.ready;
    expect(restored.history.view('utopia:3').pb.boards).toEqual(expected);
  });

  test('a board after the timeline cap cannot revise the last retained mark', async () => {
    const r = rig({onReplay: () => {}});
    await r.history.ready;
    r.go();
    for (let surfaceId = 1; surfaceId <= 120; surfaceId++) r.publishBoard({surfaceId, loss: surfaceId});
    r.publishBoard({surfaceId: 121, loss: 999});
    r.reviseBoard({loss: 1000});
    r.finish();
    const marks = r.history.view().latest.boards;
    expect(marks).toHaveLength(120);
    expect(marks.at(-1).slice(1)).toEqual([120, '[120,0,1]']);
  });

  test('a decreasing positive sequence starts a distinct board when the zero reset snapshot was missed', async () => {
    const r = rig({onReplay: () => {}});
    await r.history.ready;
    r.go();
    r.publishBoard({sequence: 5, surfaceId: 7, loss: 4});
    const first = r.live.commands.length;
    r.publishBoard({sequence: 1, surfaceId: 8, loss: 9});
    const second = r.live.commands.length;
    r.reviseBoard({loss: 11});
    r.finish();
    expect(r.history.view().latest.boards).toEqual([[first, 4, '[7,0,1]'], [second, 11, '[8,0,1]']]);
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

  test('a clipped start (a failed prestrafe) is kept on the run but left out of the average', async () => {
    const r = rig();
    await r.history.ready;
    r.exit.speed = 340; r.run({ ticks: 20, finish: false });
    Object.assign(r.exit, { speed: 281.7, clipped: true }); r.run({ ticks: 20, finish: false });
    Object.assign(r.exit, { speed: 350, clipped: false }); r.run({ ticks: 20, finish: false });
    expect(r.history.view().start).toEqual({ best: 350, average: 345, count: 2 });
    expect(r.history.view().latest.start).toEqual({ speed: 350, height: 4.3 });
    expect(r.history.view().recent[0].start).toEqual({ speed: 281.7, height: 4.3, clipped: true });
    expect(r.history.view().totals.attempts).toBe(3);
  });

  test('an average saved before clipped starts were known starts over at the next clean start', async () => {
    const r = rig({ store: memoryStore({ bests: [{ id: 'utopia:3', name: 'Utopia', kind: 'CP', at: 1, best: null, splits: [], ramps: {},
      start: { best: 352, sum: 3100, count: 10 }, checkpointCount: null, attempts: 10, finishes: 0 }] }) });
    await r.history.ready;
    expect(r.history.view('utopia:3').start).toEqual({ best: 352, average: 310, count: 10 });
    Object.assign(r.exit, { speed: 280, clipped: true }); r.run({ ticks: 20, finish: false });
    expect(r.history.view().start).toEqual({ best: 352, average: 310, count: 10 });
    Object.assign(r.exit, { speed: 344, clipped: false }); r.run({ ticks: 20, finish: false });
    expect(r.history.view().start).toEqual({ best: 352, average: 344, count: 1 });
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

describe('runs completed during explicit deletion', () => {
  test('bookmark edits during a successful clear cannot resurrect deleted runs on disk', async () => {
    const r = rig();
    await r.history.ready;
    r.run({ticks: 200});
    await flush();
    const id = r.history.view().pb.id, clear = r.store.clear;
    let started, finish;
    const waiting = new Promise(resolve => { started = resolve; });
    r.store.clear = (...args) => new Promise(resolve => {
      finish = async () => { await clear(...args); resolve(); };
      started();
    });
    const clearing = r.history.clear();
    await waiting;
    r.history.setSpots(id, [10]);
    await finish();
    await clearing;
    await flush();
    expect(r.history.view()).toBeNull();
    expect(r.store.data.runs.has(id)).toBe(false);
  });

  for (const abort of [false, true]) {
    test(`${abort ? 'aborting' : 'committing'} a delayed clear preserves a new finish and its aggregates`, async () => {
      const r = rig();
      await r.history.ready;
      r.run({ticks: 200});
      await flush();
      const oldId = r.history.view().pb.id;
      const clear = r.store.clear;
      let started, finish;
      const waiting = new Promise(resolve => { started = resolve; });
      r.store.clear = (...args) => new Promise((resolve, reject) => {
        finish = async () => {
          if (abort) reject(new Error('Transaction aborted'));
          else { await clear(...args); resolve(); }
        };
        started();
      });
      const clearing = r.history.clear();
      const result = clearing.then(() => null, error => error);
      await waiting;
      r.go();
      r.checkpoint(2100);
      r.ramp({boardLoss: 2, surfLoss: 8, down: 3, up: 5});
      r.finish();
      // A pending clear never mutates the visible pre-clear aggregates.
      expect(r.history.view().totals).toEqual({attempts: 1, finishes: 1});
      await finish();
      expect((await result)?.message ?? null).toBe(abort ? 'Transaction aborted' : null);
      await flush();
      const view = r.history.view(), freshId = view.pb.id;
      expect(freshId).not.toBe(oldId);
      expect(view.totals).toEqual({attempts: abort ? 2 : 1, finishes: abort ? 2 : 1});
      expect(view.start.count).toBe(abort ? 2 : 1);
      expect(view.splits).toEqual([expect.objectContaining({speed: 2100, pb: expect.any(Number)})]);
      expect(view.ramps).toEqual([expect.objectContaining({board: 2, down: 3, up: 5, surf: 8})]);
      const reload = rig({store: r.store});
      await reload.history.ready;
      expect(reload.history.view('utopia:3')).toEqual(view);
      expect(r.history.runs().map(run => run.id)).toEqual(abort ? [oldId, freshId] : [freshId]);
    });
  }

  test('back-to-back clears serialize after rejection and retain only finishes after the second began', async () => {
    const r = rig();
    await r.history.ready;
    r.run();
    await flush();
    const clear = r.store.clear, gates = [];
    let firstStarted, secondStarted;
    const firstWaiting = new Promise(resolve => { firstStarted = resolve; });
    const secondWaiting = new Promise(resolve => { secondStarted = resolve; });
    r.store.clear = (...args) => new Promise((resolve, reject) => {
      gates.push({reject, commit: async () => { await clear(...args); resolve(); }});
      (gates.length === 1 ? firstStarted : secondStarted)();
    });
    const first = r.history.clear().catch(error => error.message);
    const second = r.history.clear();
    await firstWaiting;
    expect(gates).toHaveLength(1);
    r.run({ticks: 50});
    gates[0].reject(new Error('Transaction aborted'));
    expect(await first).toBe('Transaction aborted');
    await secondWaiting;
    expect(gates).toHaveLength(2);
    r.run({ticks: 10});
    await gates[1].commit();
    await second;
    await flush();
    expect(r.history.runs()).toHaveLength(1);
    expect(r.history.view().totals).toEqual({attempts: 1, finishes: 1});
    expect(r.history.view().pb.time).toBeCloseTo(11 * DT, 6);
    expect((await r.store.load()).runs).toEqual(r.history.runs());
  });
});

test('finished, reset and discarded runs release their native session and command log', async () => {
  const record = outcome => {
    const history = createRunHistory();
    const live = {
      map: {id: 'lifetime', version: 1}, config: {dt: DT}, replayFormat: 8,
      state: {velocity: {x: 350, y: 0, z: 0}},
      initialState: {position: {x: 0, y: 0, z: 0}},
      commands: [{forward: 400}],
      timer: {state: {phase: 'running', elapsed: 0, startTick: 1}},
    };
    const reference = new WeakRef(live);
    const log = new WeakRef(live.commands);
    history.observe(live, ['start']);
    if (outcome === 'discard') history.discard();
    else if (outcome === 'reset') history.reset();
    else {
      live.timer.state = {...live.timer.state, phase: 'finished', elapsed: 1};
      history.observe(live, ['finish']);
    }
    history.observe(live, []);
    return {history, reference, log};
  };
  for (const outcome of ['finished', 'reset', 'discard']) {
    const {history, reference, log} = record(outcome);
    await history.ready;
    // WeakRef keeps a dereferenced/new target alive until the current job ends.
    await flush();
    Bun.gc(true);
    expect(history.running).toBe(false);
    expect(reference.deref()).toBeUndefined();
    expect(log.deref()).toBeUndefined();
  }
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

describe('ramp averages', () => {
  const row = (history, mode = 'average', key = 'utopia:3') => history.view(key, {rampMode: mode}).ramps[0];
  const mean = values => values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)) : null;

  test('last ten valid measurements and overall are independent per metric, bounded and persisted', async () => {
    const r = rig();
    await r.history.ready;
    const values = {board: [], down: [], up: [], surf: []};
    for (let i = 1; i <= 24; i++) {
      const sample = {board: i, down: i % 3 ? i * 2 : null, up: i % 2 ? null : i * 3, surf: i % 2 ? i * 4 : null};
      r.go();
      r.ramp({boardLoss: sample.board, down: sample.down, up: sample.up, surfLoss: sample.surf});
      r.restart();
      for (const field of Object.keys(values)) if (sample[field] !== null) values[field].push(sample[field]);
    }
    for (const mode of ['recent', 'average']) {
      const result = row(r.history, mode);
      for (const [field, samples] of Object.entries(values)) {
        const selected = mode === 'recent' ? samples.slice(-10) : samples;
        expect(result[field]).toBe(mean(selected));
        expect(result.counts[field]).toBe(selected.length);
      }
    }
    expect(row(r.history, 'best')).toMatchObject({board: 1, down: 2, up: 6, surf: 4});
    await flush();
    const averages = r.store.data.bests.get('utopia:3').averages['[1,0,1]'];
    for (const field of Object.keys(values)) {
      const metric = averages[field], samples = values[field];
      expect(metric).toMatchObject({sum: samples.reduce((sum, value) => sum + value, 0),
        count: samples.length, recentSum: samples.slice(-10).reduce((sum, value) => sum + value, 0),
        next: samples.length % 10});
      expect(metric.recent).toHaveLength(10);
      expect([...metric.recent.slice(metric.next), ...metric.recent.slice(0, metric.next)]).toEqual(samples.slice(-10));
    }
    const reload = rig({store: r.store});
    await reload.history.ready;
    expect(row(reload.history)).toEqual(row(r.history));
    expect(row(reload.history, 'recent')).toEqual(row(r.history, 'recent'));
  });

  test('crashes count once per visit but never enter any average or last ten', async () => {
    const r = rig();
    await r.history.ready;
    r.go(); r.ramp({boardLoss: 40, down: 200, up: 100, surfLoss: 300}); r.finish();
    r.go();
    r.publishBoard({loss: 500});
    r.publishSurf({available: false, crash: true});
    r.publishSurf({available: false, crash: true});
    r.restart();
    for (const mode of ['average', 'recent']) {
      expect(row(r.history, mode)).toMatchObject({crashes: 1, board: 40, down: 200, up: 100, surf: 300,
        counts: {board: 1, down: 1, up: 1, surf: 1}});
    }
    expect(row(r.history, 'best')).toMatchObject({board: 40, surf: 300});
    await flush();
    const reload = rig({store: r.store});
    await reload.history.ready;
    expect(row(reload.history)).toEqual(row(r.history));
  });

  test('available board revisions count once without completed Surf, and unavailable fields never become zero', async () => {
    const r = rig();
    await r.history.ready;
    r.go();
    r.publishBoard({loss: 4});
    r.reviseBoard({loss: 7});
    r.reviseBoard({loss: 9});
    await flush();
    expect(r.store.data.bests.size).toBe(0);
    r.restart();
    expect(row(r.history)).toMatchObject({board: 9, down: null, up: null, surf: null,
      counts: {board: 1, down: 0, up: 0, surf: 0}});
    expect(row(r.history, 'best').board).toBe(9);
    r.go();
    r.publishBoard({loss: null});
    r.publishSurf({loss: null, downLoss: null, upLoss: 0});
    r.finish();
    expect(row(r.history)).toMatchObject({board: 9, down: null, up: 0, surf: null,
      counts: {board: 1, down: 0, up: 1, surf: 0}});
    r.go();
    r.ramp({boardLoss: 3, surfLoss: 90, down: 40, up: 50, hidden: true});
    r.finish();
    expect(row(r.history)).toMatchObject({board: 6, down: null, up: 0, surf: null,
      counts: {board: 2, down: 0, up: 1, surf: 0}});
  });

  test('clean resets count but practice, invalid runs and replay sessions do not', async () => {
    const r = rig();
    await r.history.ready;
    r.go(); r.ramp({boardLoss: 8, surfLoss: 20}); r.restart();
    r.live.practice = true;
    r.go(); r.ramp({boardLoss: 1, surfLoss: 1}); r.finish();
    r.live.practice = false;
    r.go(); r.ramp({boardLoss: 2, surfLoss: 2});
    r.live.timer.state.invalidReason = 'Teleported'; r.tick(); r.restart();
    r.live.timer.state.invalidReason = '';
    r.state.playback = true;
    r.go(); r.ramp({boardLoss: 3, surfLoss: 3}); r.finish();
    expect(row(r.history)).toMatchObject({board: 8, surf: 20, counts: {board: 1, surf: 1}});
    expect(r.history.runs()).toHaveLength(3);
  });

  test('reset is independent of bests, runs, replays and other maps; old in-flight visits cannot return', async () => {
    const r = rig({onReplay: () => {}});
    await r.history.ready;
    r.go(); r.ramp({boardLoss: 2, surfLoss: 10}); r.finish();
    const saved = structuredClone(r.history.runs()), before = r.history.view();
    r.live.map = {id: 'other', version: 1};
    r.go(); r.ramp({boardLoss: 9, surfLoss: 90}); r.finish();
    const other = r.history.view('other:1', {rampMode: 'average'});
    r.live.map = {id: 'utopia', version: 3};
    r.go();
    r.publishBoard({loss: 4});
    await r.history.resetRampAverages('utopia:3');
    expect(row(r.history)).toMatchObject({board: null, surf: null, counts: {board: 0, surf: 0}});
    expect(r.history.view('utopia:3')).toMatchObject({pb: before.pb, recentBest: before.recentBest, ramps: before.ramps, start: before.start});
    expect(r.history.runs().slice(0, 1)).toEqual(saved);
    expect(r.history.view('other:1', {rampMode: 'average'})).toEqual(other);
    r.reviseBoard({loss: 6});
    r.publishSurf({loss: 30, downLoss: 10, upLoss: 20});
    r.ramp({boardLoss: 8, surfLoss: 40, surfaceId: 2});
    r.restart();
    const rows = r.history.view('utopia:3', {rampMode: 'average'}).ramps;
    expect(rows[0]).toMatchObject({board: null, surf: null, counts: {board: 0, surf: 0}});
    // PB route stays unchanged, but the genuinely new post-reset visit is aggregated.
    await flush();
    expect(r.store.data.bests.get('utopia:3').averages['[2,0,1]']).toMatchObject({
      board: {sum: 8, count: 1, recent: [8]}, surf: {sum: 40, count: 1, recent: [40]}});
    const reload = rig({store: r.store});
    await reload.history.ready;
    expect(row(reload.history)).toEqual(row(r.history));
  });

  test('reset during load discards saved and pre-reset pending samples, preserving later ones', async () => {
    const store = memoryStore();
    const first = rig({store});
    await first.history.ready;
    first.go(); first.ramp({boardLoss: 2, surfLoss: 10}); first.finish();
    await flush();
    const saved = await store.load();
    let resolveLoad;
    const r = rig({store: {...store, load: () => new Promise(resolve => { resolveLoad = resolve; })}, now: 5000});
    r.go(); r.ramp({boardLoss: 4, surfLoss: 20}); r.restart();
    const resetting = r.history.resetRampAverages('utopia:3');
    r.go(); r.ramp({boardLoss: 6, surfLoss: 30}); r.restart();
    resolveLoad(saved);
    await resetting;
    expect(row(r.history)).toMatchObject({board: 6, surf: 30, counts: {board: 1, surf: 1}});
    expect(row(r.history, 'best').board).toBe(2);
    const reload = rig({store});
    await reload.history.ready;
    expect(row(reload.history)).toEqual(row(r.history));
  });

  for (const abort of [false, true]) {
    test(`reset during ${abort ? 'failed' : 'successful'} clear keeps only post-boundary samples`, async () => {
      const r = rig();
      await r.history.ready;
      r.go(); r.ramp({boardLoss: 2, surfLoss: 10}); r.finish();
      await flush();
      const clear = r.store.clear;
      let release, started;
      const waiting = new Promise(resolve => { started = resolve; });
      r.store.clear = (...args) => new Promise((resolve, reject) => {
        release = async () => {
          if (abort) reject(new Error('Transaction aborted'));
          else { await clear(...args); resolve(); }
        };
        started();
      });
      const clearing = r.history.clear('utopia:3').catch(error => error.message);
      await waiting;
      r.go(); r.ramp({boardLoss: 4, surfLoss: 20}); r.restart();
      const resetting = r.history.resetRampAverages('utopia:3');
      r.go(); r.ramp({boardLoss: 6, surfLoss: 30}); r.restart();
      await release(); await clearing; await resetting;
      expect(row(r.history)).toMatchObject({board: 6, surf: 30, counts: {board: 1, surf: 1}});
      const reload = rig({store: r.store});
      await reload.history.ready;
      expect(row(reload.history)).toEqual(row(r.history));
    });
  }

  test('legacy bests do not backfill averages and a failed reset persistence can be retried', async () => {
    const r = rig();
    await r.history.ready;
    r.go(); r.ramp({boardLoss: 3, surfLoss: 12}); r.finish();
    await flush();
    delete r.store.data.bests.get('utopia:3').averages;
    const reload = rig({store: r.store});
    await reload.history.ready;
    expect(row(reload.history)).toMatchObject({board: null, counts: {board: 0}});
    expect(row(reload.history, 'best').board).toBe(3);
    const putBests = r.store.putBests;
    r.store.putBests = async () => { throw new Error('Write failed'); };
    await expect(r.history.resetRampAverages('utopia:3')).rejects.toThrow('Write failed');
    r.store.putBests = putBests;
    await r.history.resetRampAverages('utopia:3');
    expect(r.store.data.bests.get('utopia:3').averages).toEqual({});
  });
});

describe('recent best replay', () => {
  const day = 24 * 60 * 60 * 1000;

  test('only strictly faster replay-backed clean finishes replace it; TTL uses completion time', async () => {
    let now = 1000;
    const r = rig({clock: () => now, onReplay: () => {}});
    await r.history.ready;
    r.go(); r.idle(1); now = 5000; r.finish();
    const initial = r.history.view().recentBest;
    expect(initial).toMatchObject({at: 1000, finishedAt: 5000, expiresAt: 5000 + day});
    now = 6000;
    r.go(); r.idle(1); r.finish();
    expect(r.history.view().recentBest.id).toBe(initial.id);
    r.run({ticks: 1, practice: true});
    r.run({ticks: 1, invalid: 'Teleported'});
    r.run({ticks: 1, finish: false});
    expect(r.history.view().recentBest.id).toBe(initial.id);
    r.run({ticks: 10});
    const faster = r.history.view().recentBest;
    expect(faster.id).not.toBe(initial.id);
    expect(faster.finishedAt).toBe(6000);
    await flush();
    expect(r.store.data.runs.get(faster.id).finishedAt).toBe(6000);
    now = faster.expiresAt;
    expect(r.history.view().recentBest).toBeNull();
    const unavailable = rig();
    await unavailable.history.ready;
    unavailable.run();
    expect(unavailable.history.view().recentBest).toBeNull();
  });

  test('expiry falls back only to eligible retained finishes, including on load and prune', async () => {
    let now = 1000;
    const r = rig({clock: () => now, onReplay: () => {}, limits: () => ({runsPerMap: 3})});
    await r.history.ready;
    r.run({ticks: 10});
    const first = r.history.view().recentBest;
    now += 1000;
    r.run({ticks: 20});
    const fallback = r.history.view().latest;
    now = first.expiresAt;
    expect(r.history.view().recentBest.id).toBe(fallback.id);
    r.history.prune();
    await flush();
    const reload = rig({store: r.store, clock: () => now});
    await reload.history.ready;
    expect(reload.history.view('utopia:3').recentBest.id).toBe(fallback.id);
    now += 1000;
    expect(reload.history.view('utopia:3').recentBest).toBeNull();
    expect(reload.history.view('utopia:3').pb.id).toBe(first.id);
  });

  test('highlight reserves a qualifying slot; PB pin and latest short reset retain their existing roles', async () => {
    let now = 1000, kept;
    const replays = new Set();
    const r = rig({clock: () => now, limits: () => ({runsPerMap: 3}),
      onReplay: run => replays.add(run.id),
      onPrune: ids => { kept = ids; for (const id of replays) if (!ids.has(id)) replays.delete(id); }});
    await r.history.ready;
    r.run({ticks: 1});
    const pb = r.history.view().pb.id;
    now += day;
    r.run({ticks: 10});
    const highlight = r.history.view().recentBest.id;
    for (let i = 0; i < 8; i++) { now++; r.run({ticks: 30 + i}); }
    expect(r.history.runs()).toHaveLength(4);
    expect(kept.has(pb)).toBe(true);
    expect(kept.has(highlight)).toBe(true);
    expect(r.history.view().recentBest.id).toBe(highlight);
    r.run({ticks: 1, finish: false});
    expect(r.history.runs()).toHaveLength(5);
    expect(replays.size).toBe(5);
    await flush();
    expect(r.store.data.runs.size).toBe(5);
    now += day;
    r.history.prune();
    expect(r.history.view().recentBest).toBeNull();
    r.run({ticks: 100});
    expect(replays.has(highlight)).toBe(false);
    expect(replays.has(pb)).toBe(true);
  });

  test('PB, latest and recent best share one recording; legacy completion uses its saved timestamp', async () => {
    let now = 1000;
    const r = rig({clock: () => now, onReplay: () => {}, limits: () => ({runsPerMap: 1})});
    await r.history.ready;
    r.run({ticks: 20});
    const view = r.history.view();
    expect(view.pb.id).toBe(view.latest.id);
    expect(view.pb.id).toBe(view.recentBest.id);
    expect(r.history.runs()).toHaveLength(1);
    await flush();
    const legacy = r.store.data.runs.get(view.pb.id);
    delete legacy.finishedAt;
    const reload = rig({store: r.store, clock: () => now});
    await reload.history.ready;
    expect(reload.history.view('utopia:3').recentBest).toMatchObject({finishedAt: legacy.at, expiresAt: legacy.at + day});
    now = legacy.at + day;
    expect(reload.history.view('utopia:3').recentBest).toBeNull();
  });
});

describe('history statistics boundary regressions', () => {
  const averages = (history, key = 'utopia:3') => history.view(key, {rampMode: 'average'}).ramps;

  test('a simultaneous board transition and completed Surf keep visit-specific samples and missing fields', async () => {
    const r = rig();
    await r.history.ready;
    r.go();
    r.ramp({boardLoss: 3, down: 10, up: 20, surfLoss: 30, surfaceId: 7,
      nextBoard: {surfaceId: 8, checkpoint: 0, visit: 1, loss: 12}});
    r.reviseBoard({loss: 16});
    r.publishSurf({surfaceId: 8, checkpoint: 0, visit: 1, loss: 60, downLoss: null, upLoss: 25});
    r.restart();
    expect(averages(r.history)).toEqual([
      {key: '[7,0,1]', label: 'Ramp 1', checkpoint: 0, crashes: 0, board: 3, down: 10, up: 20, surf: 30,
        counts: {board: 1, down: 1, up: 1, surf: 1}},
      {key: '[8,0,1]', label: 'Ramp 2', checkpoint: 0, crashes: 0, board: 16, down: null, up: 25, surf: 60,
        counts: {board: 1, down: 0, up: 1, surf: 1}},
    ]);
    r.go();
    r.ramp({boardLoss: 7, down: 20, up: 30, surfLoss: 50, surfaceId: 7});
    r.restart();
    expect(averages(r.history)[0]).toMatchObject({board: 5, down: 15, up: 25, surf: 40,
      counts: {board: 2, down: 2, up: 2, surf: 2}});
    expect(averages(r.history)[1].counts.board).toBe(1);
  });

  test('spectator starts cannot add a run or any ramp samples', async () => {
    const r = rig();
    await r.history.ready;
    r.go(); r.ramp({boardLoss: 8, surfLoss: 20}); r.restart();
    const before = structuredClone(r.history.view('utopia:3', {rampMode: 'average'}));
    r.state.spectator = {target: 123};
    r.go(); r.ramp({boardLoss: 1, surfLoss: 2}); r.finish();
    expect(r.history.view('utopia:3', {rampMode: 'average'})).toEqual(before);
    expect(r.history.runs()).toHaveLength(1);
  });

  test('successive resets keep their synchronous boundary while an earlier save is pending', async () => {
    const r = rig();
    await r.history.ready;
    r.go(); r.ramp({boardLoss: 2, surfLoss: 10}); r.restart();
    await flush();
    const putBests = r.store.putBests;
    let release, started;
    const waiting = new Promise(resolve => { started = resolve; });
    r.store.putBests = async record => {
      await new Promise(resolve => { release = resolve; started(); });
      await putBests(record);
    };
    const first = r.history.resetRampAverages('utopia:3');
    await waiting;
    // This visit starts after the first reset, but before the second.
    r.go(); r.publishBoard({loss: 4});
    const second = r.history.resetRampAverages('utopia:3');
    r.reviseBoard({loss: 6});
    r.publishSurf({loss: 30, downLoss: 10, upLoss: 20});
    r.ramp({boardLoss: 9, surfLoss: 45, surfaceId: 2});
    r.restart();
    r.store.putBests = putBests;
    release();
    await first; await second;
    const result = averages(r.history);
    expect(result[0]).toMatchObject({board: null, surf: null, counts: {board: 0, surf: 0}});
    expect(result[1]).toMatchObject({board: 9, surf: 45, counts: {board: 1, surf: 1}});
    const reload = rig({store: r.store});
    await reload.history.ready;
    expect(averages(reload.history)).toEqual(result);
  });

  test('a reset cannot report persistence success when saved history is unavailable', async () => {
    const r = rig({store: {...memoryStore(), load: async () => { throw new Error('Unavailable'); }}});
    await r.history.ready;
    await expect(r.history.resetRampAverages('utopia:3')).rejects.toThrow('Run history has not loaded');
  });

  test('watchable recent-best metadata exposes exact boards and reflects replay trim offsets', async () => {
    const r = rig({onReplay: () => {}});
    await r.history.ready;
    r.idle(1);
    r.go(); r.ramp({boardLoss: 3, surfLoss: 20, surfaceId: 7}); r.finish();
    const saved = r.history.runs()[0], tick = saved.boards[0][0];
    r.history.setReplayOffset(saved.id, 5);
    const view = r.history.view();
    expect(view.recentBest).toMatchObject({id: saved.id, map: 'utopia:3', mapName: 'Utopia',
      boards: [[tick, 3, '[7,0,1]']], replay: {offset: 5}});
    expect(view.pb.boards).toEqual(view.recentBest.boards);
    expect(view.latest.boards).toEqual(view.recentBest.boards);
    await flush();
    const reload = rig({store: r.store});
    await reload.history.ready;
    expect(reload.history.view('utopia:3').recentBest).toEqual(view.recentBest);
  });
});

describe('highlight retention boundaries', () => {
  const run = (id, map = 'a') => ({id, map, outcome: 'finished', time: 12});

  test('a distinct highlight consumes the only qualifying slot, not a new overflow slot', () => {
    const runs = [run('pb'), run('highlight'), run('newer'), run('latest-short')];
    Object.assign(runs[3], {outcome: 'reset', time: 1});
    expect(retainRuns(runs, {runsPerMap: 1, keep: new Set(['pb']), highlights: new Set(['highlight'])})
      .map(entry => entry.id)).toEqual(['pb', 'highlight', 'latest-short']);
    expect(retainRuns(runs, {runsPerMap: 1, keep: new Set(['pb']), highlights: new Set(['pb'])})
      .map(entry => entry.id)).toEqual(['pb', 'latest-short']);
  });

  test('reserving an older highlight cannot expand the fifty-most-recent-map budget', () => {
    const runs = [run('highlight')];
    for (let i = 0; i < 51; i++) runs.push(run(`map-${i}`, `map-${i}`));
    runs.push(run('latest-a'));
    const kept = retainRuns(runs, {runsPerMap: 1, highlights: new Set(['highlight'])});
    expect(kept).toHaveLength(50);
    expect(new Set(kept.map(entry => entry.map)).size).toBe(50);
    expect(kept.map(entry => entry.id)).toEqual(['highlight', ...Array.from({length: 49}, (_, i) => `map-${i + 2}`)]);
  });

  test('reserved highlights remain inside the global qualifying-run budget', () => {
    const runs = [], highlights = new Set();
    for (let attempt = 0; attempt < 42; attempt++) {
      for (let map = 0; map < 50; map++) {
        const id = `${map}-${attempt}`;
        runs.push(run(id, String(map)));
        if (attempt === 0) highlights.add(id);
      }
    }
    const kept = retainRuns(runs, {runsPerMap: 50, highlights});
    expect(kept).toHaveLength(2000);
    const ids = new Set(kept.map(entry => entry.id));
    expect([...highlights].every(id => ids.has(id))).toBe(true);
  });
});

describe('failed replay saves', () => {
  test('a failed winner falls back to a retained replay without changing run statistics or bests', async () => {
    const r = rig({onReplay: () => {}});
    await r.history.ready;
    r.go(); r.ramp({boardLoss: 8, surfLoss: 40}); r.idle(1); r.finish();
    const fallback = r.history.view().recentBest.id;
    r.go(); r.ramp({boardLoss: 4, surfLoss: 20}); r.finish();
    const winner = r.history.view().recentBest.id;
    r.history.setSpots(winner, [1]);
    const before = r.history.view('utopia:3', {rampMode: 'average'});
    let notifications = 0;
    r.history.subscribe(() => notifications++);
    r.history.setReplayUnavailable(winner);
    const after = r.history.view('utopia:3', {rampMode: 'average'});
    expect(after.recentBest.id).toBe(fallback);
    expect(after.pb.id).toBe(winner);
    expect(after.pb.replay).toBeUndefined();
    expect(after.latest.replay).toBeUndefined();
    expect(after.totals).toEqual(before.totals);
    expect(after.ramps).toEqual(before.ramps);
    expect(after.start).toEqual(before.start);
    expect(r.history.run(winner).boards).toBeUndefined();
    expect(r.history.run(winner).spots).toBeUndefined();
    expect(notifications).toBe(1);
    r.history.setReplayUnavailable(winner);
    r.history.setReplayUnavailable('not-kept');
    expect(notifications).toBe(1);
    await flush();
    expect(r.store.data.runs.get(winner).replay).toBeUndefined();
    const reload = rig({store: r.store});
    await reload.history.ready;
    expect(reload.history.view('utopia:3', {rampMode: 'average'})).toEqual(after);
  });

  test('failure before history load merges bests and persists the run without replay metadata', async () => {
    const store = memoryStore();
    const first = rig({store, onReplay: () => {}});
    await first.history.ready;
    first.run({ticks: 100});
    await flush();
    const saved = await store.load(), fallback = first.history.view().recentBest.id;
    let resolveLoad;
    const r = rig({now: 5000, store: {...store, load: () => new Promise(resolve => { resolveLoad = resolve; })},
      onReplay: () => {}});
    r.run({ticks: 1});
    const winner = r.history.runs()[0].id;
    r.history.setReplayUnavailable(winner);
    resolveLoad(saved);
    await r.history.ready;
    await flush();
    expect(r.history.view().recentBest.id).toBe(fallback);
    expect(r.history.view().pb.id).toBe(winner);
    expect(store.data.runs.get(winner).replay).toBeUndefined();
    expect(r.history.view().totals).toEqual({attempts: 2, finishes: 2});
  });

  for (const abort of [false, true]) {
    test(`a failed post-clear replay stays unavailable when deletion ${abort ? 'aborts' : 'commits'}`, async () => {
      let recorded, failReplay = false;
      const r = rig({onReplay: run => {
        recorded = run;
        if (failReplay) queueMicrotask(() => r.history.setReplayUnavailable(run.id));
      }});
      await r.history.ready;
      r.run({ticks: 100});
      const fallback = r.history.view().recentBest.id;
      await flush();
      const clear = r.store.clear;
      let started, release;
      const waiting = new Promise(resolve => { started = resolve; });
      r.store.clear = (...args) => new Promise((resolve, reject) => {
        release = async () => {
          if (abort) reject(new Error('Transaction aborted'));
          else { await clear(...args); resolve(); }
        };
        started();
      });
      const clearing = r.history.clear('utopia:3').catch(error => error.message);
      await waiting;
      failReplay = true;
      r.go(); r.ramp({boardLoss: 4, surfLoss: 20}); r.finish();
      await release();
      await clearing;
      const id = recorded.id;
      expect(recorded.replay).toBeUndefined();
      expect(r.history.view().pb.id).toBe(id);
      expect(r.history.view().recentBest?.id ?? null).toBe(abort ? fallback : null);
      await flush();
      const reload = rig({store: r.store});
      await reload.history.ready;
      expect(reload.history.view('utopia:3')).toEqual(r.history.view());
      expect(r.history.view('utopia:3', {rampMode: 'average'}).ramps[0]).toMatchObject({
        board: 4, surf: 20, counts: {board: 1, surf: 1}});
    });
  }
});
