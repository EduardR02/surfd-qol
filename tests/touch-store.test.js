import {describe, expect, test} from 'bun:test';
import {createRunHistory, createTouchStore, TOUCH_STORAGE_KEY} from '../src/run-history.js';

const KEY = '[1,0,1]';
const SECOND = '[2,1,1]';
const emptyMetric = {best: null, last10: null, avg: null};

function storageRig() {
  const values = new Map(), writes = [];
  return {values, writes,
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { writes.push(key); values.set(key, value); },
  };
}

function record(index, map = 'utopia:3', touches = []) {
  return {id: `run-${index}`, map, at: index, time: 1, outcome: 'reset', checkpoints: 0, touches};
}

function rig({storage = storageRig(), touchStore = createTouchStore({storage}), store = null,
  getTouchReferences = () => null} = {}) {
  let now = 1000, revision = 0;
  const state = {playback: false, spectator: {target: null}};
  const board = {sequence: 0, available: false};
  const surf = {sequence: 0};
  const live = {
    map: {id: 'utopia', version: 3, stages: []}, practice: false,
    config: {dt: 0.015, unrestrictedStart: false, autoBhop: true},
    state: {tick: 0, position: {x: 0, y: 0, z: 0}, velocity: {x: 300, y: 0, z: 0}},
    checkpointSpeeds: [], timer: {state: {phase: 'ready', elapsed: 0, startTick: null, invalidReason: null, splits: []}},
  };
  const history = createRunHistory({store, touchStore, getTouchReferences, getState: () => state,
    getMap: () => live.map, clock: () => now,
    metrics: {boardRevision: () => revision, boardSnapshot: () => ({...board}),
      surfSnapshot: sequence => sequence === surf.sequence ? null : {...surf}},
  });
  const tick = (events = []) => {
    now += 15;
    live.state.tick++;
    if (live.timer.state.phase === 'running') live.timer.state.elapsed += 0.015;
    history.observe(live, events);
  };
  return {history, live, state, storage, touchStore, tick,
    go() {
      live.timer.state = {phase: 'running', elapsed: 0, startTick: live.state.tick + 0.5, invalidReason: null, splits: []};
      live.checkpointSpeeds = [];
      tick(['start']);
    },
    touch(values = {}) {
      Object.assign(board, {sequence: board.sequence + 1, available: true, crash: false, surfaceId: 1, checkpoint: 0, visit: 1,
        loss: 10, speedBefore: 1000, speedAfter: 990, angle: 8}, values);
      revision++;
      tick();
    },
    revise(values) { Object.assign(board, values); revision++; tick(); },
    exit(values = {}) {
      Object.assign(surf, {sequence: surf.sequence + 1, surfaceId: board.surfaceId, checkpoint: board.checkpoint,
        visit: board.visit, available: true, crash: false, exitSpeed: 750}, values);
      tick();
    },
    finish() { live.timer.state.phase = 'finished'; tick(['finish']); },
    reset(event = 'restart') {
      live.timer.state = {phase: 'ready', elapsed: 0, startTick: null, invalidReason: null, splits: []};
      tick([event]);
    },
  };
}

const stats = r => r.history.touchStats('utopia:3');

describe('touch attempt store', () => {
  test('uses a separate durable key, writes only ended attempts and preserves legacy data', async () => {
    const r = rig();
    r.storage.values.set('legacy-history', 'untouched');
    await r.history.ready;
    expect(r.storage.writes).toEqual([]);
    r.go();
    r.touch();
    r.revise({speedAfter: 980});
    r.exit({exitSpeed: 700});
    r.tick();
    expect(r.storage.writes).toEqual([]);
    expect(stats(r).runs).toBe(0);
    r.reset();
    expect(r.storage.writes).toEqual([TOUCH_STORAGE_KEY]);
    expect(r.storage.values.get('legacy-history')).toBe('untouched');
    expect(r.touchStore.records('utopia:3')).toEqual([{
      id: expect.any(String), map: 'utopia:3', at: expect.any(Number), time: 0.075,
      outcome: 'reset', checkpoints: 0,
      touches: [{key: KEY, checkpoint: 0, speedBefore: 1000, speedAfter: 700, angle: 8, crash: false}],
    }]);
    const next = rig({storage: r.storage});
    await next.history.ready;
    expect(stats(next)).toEqual(stats(r));
    expect(r.storage.writes).toHaveLength(1);
  });

  test('retains the newest 200 attempts per map including short resets', async () => {
    const r = rig();
    await r.history.ready;
    r.go(); r.touch({speedBefore: 9999, angle: 0}); r.reset();
    for (let index = 0; index < 200; index++) {
      r.go();
      if (index === 199) r.touch({speedBefore: 500, angle: 20});
      r.reset();
    }
    expect(r.touchStore.records('utopia:3')).toHaveLength(200);
    expect(stats(r)).toMatchObject({runs: 200, touches: [{reach: 1 / 200,
      speedIn: {best: 500, last10: 500, avg: 500}, angle: {best: 20, last10: 20, avg: 20}}]});
    const next = rig({storage: r.storage});
    await next.history.ready;
    expect(stats(next)).toEqual(stats(r));
  });

  test('keeps only 50 recently played maps, including on reload, and supports a custom key', () => {
    const storage = storageRig(), store = createTouchStore({storage, key: 'own-touch-key'});
    for (let index = 0; index < 50; index++) store.append(record(index, `map-${index}`));
    store.append(record(50, 'map-0'));
    store.append(record(51, 'map-50'));
    expect(store.records('map-0')).toHaveLength(2);
    expect(store.records('map-1')).toEqual([]);
    expect(storage.values.has(TOUCH_STORAGE_KEY)).toBe(false);
    const next = createTouchStore({storage, key: 'own-touch-key'});
    expect(next.records('map-0')).toHaveLength(2);
    expect(next.records('map-1')).toEqual([]);
    expect(new Set(JSON.parse(storage.values.get('own-touch-key')).runs.map(run => run.map)).size).toBe(50);
  });

  test('bounds loaded records and rejects malformed records and touch identities', () => {
    const storage = storageRig();
    const runs = Array.from({length: 201}, (_, index) => record(index));
    runs.push({...record(202), time: -1}, {...record(203), outcome: 'practice'});
    runs[200].touches = [
      {key: KEY, checkpoint: 0, speedBefore: -1, speedAfter: 0, angle: 91},
      {key: KEY, checkpoint: 0, speedBefore: 99, speedAfter: 99, angle: 0},
      {key: 'invalid', checkpoint: 0},
      {key: '[2,1,1]', checkpoint: 0},
    ];
    storage.values.set(TOUCH_STORAGE_KEY, JSON.stringify({version: 2, runs}));
    const store = createTouchStore({storage});
    expect(store.records('utopia:3')).toHaveLength(200);
    expect(store.records('utopia:3')[0].id).toBe('run-1');
    expect(store.records('utopia:3').at(-1).touches).toEqual([
      {key: KEY, checkpoint: 0, speedBefore: null, speedAfter: 0, angle: null, crash: false},
    ]);
    expect(storage.writes).toEqual([]);
  });

  test('corrupt or unavailable storage keeps observation usable and failed writes can recover', async () => {
    const storage = storageRig();
    storage.values.set(TOUCH_STORAGE_KEY, '{');
    let failed = true;
    const save = storage.setItem.bind(storage);
    storage.setItem = (key, value) => { if (failed) throw new Error('Quota'); save(key, value); };
    const r = rig({storage});
    await r.history.ready;
    r.go(); r.touch(); r.reset();
    expect(stats(r).runs).toBe(1);
    failed = false;
    r.go(); r.reset();
    expect(createTouchStore({storage}).records('utopia:3')).toHaveLength(2);
    const unavailable = createTouchStore({storage: {getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); }}});
    unavailable.append(record(1));
    expect(unavailable.records('utopia:3')).toHaveLength(1);
  });
});

describe('per-touch statistics', () => {
  test('reach includes attempts before the first touch, unknown measurements and zero values', async () => {
    const r = rig();
    await r.history.ready;
    expect(stats(r)).toEqual({runs: 0, touches: []});
    r.go(); r.reset();
    r.go(); r.reset('start-return');
    r.go(); r.touch({available: false}); r.reset();
    expect(stats(r)).toEqual({runs: 3, touches: [{key: KEY, index: 0, checkpoint: 0,
      reach: 1 / 3, crashes: 0, speedIn: emptyMetric, speedOut: emptyMetric, angle: emptyMetric, pb: null, wr: null}]});
    r.go(); r.touch({speedBefore: 0, speedAfter: 0, angle: 0}); r.exit({exitSpeed: 0}); r.finish();
    expect(stats(r)).toMatchObject({runs: 4, touches: [{reach: 0.5, speedIn: {best: 0, last10: 0, avg: 0},
      speedOut: {best: 0, last10: 0, avg: 0}, angle: {best: 0, last10: 0, avg: 0}}]});
    expect(r.touchStore.records('utopia:3').at(-1).outcome).toBe('finished');
  });

  test('uses each field’s last ten known measurements and speed maxima but angle minima', async () => {
    const r = rig(), known = {speedIn: [], speedOut: [], angle: []};
    await r.history.ready;
    for (let index = 1; index <= 24; index++) {
      const speedBefore = index * 100, speedAfter = index % 2 ? null : index * 90, angle = index % 3 ? index : null;
      r.go(); r.touch({speedBefore, speedAfter, angle}); r.exit({exitSpeed: speedAfter}); r.reset();
      known.speedIn.push(speedBefore);
      if (speedAfter !== null) known.speedOut.push(speedAfter);
      if (angle !== null) known.angle.push(angle);
      r.go(); r.reset();
    }
    const row = stats(r).touches[0];
    expect(stats(r)).toMatchObject({runs: 48});
    expect(row.reach).toBe(0.5);
    for (const [field, values] of Object.entries(known)) {
      const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
      expect(row[field]).toEqual({best: field === 'angle' ? Math.min(...values) : Math.max(...values),
        last10: mean(values.slice(-10)), avg: mean(values)});
    }
  });

  test('keeps first entry speed and uses the final exit after a re-touch, not the landing clip', async () => {
    const r = rig();
    await r.history.ready;
    r.go();
    r.touch();
    r.revise({speedBefore: 980, speedAfter: 970, angle: 8});
    r.exit({exitSpeed: 700});
    r.revise({speedBefore: 800, speedAfter: 790, angle: 8});
    r.exit({exitSpeed: 600});
    r.touch({visit: 2, speedBefore: 800, speedAfter: 790, angle: 4});
    r.exit({exitSpeed: 500});
    r.finish();
    expect(stats(r).touches.map(touch => ({key: touch.key, index: touch.index, reach: touch.reach,
      speedOut: touch.speedOut, angle: touch.angle}))).toEqual([
      {key: KEY, index: 0, reach: 1, speedOut: {best: 600, last10: 600, avg: 600}, angle: {best: 8, last10: 8, avg: 8}},
      {key: '[1,0,2]', index: 1, reach: 1, speedOut: {best: 500, last10: 500, avg: 500}, angle: {best: 4, last10: 4, avg: 4}},
    ]);
    expect(stats(r).touches[0].speedIn).toEqual({best: 1000, last10: 1000, avg: 1000});
  });

  test('unfinished and unsupported visits never substitute a landing clip or a stale exit', async () => {
    const r = rig();
    await r.history.ready;
    r.go(); r.touch(); r.reset();
    r.go(); r.touch(); r.exit({available: false, reason: 'unsupported-contact-or-endpoint', exitSpeed: 900}); r.reset();
    expect(stats(r).touches[0]).toMatchObject({speedIn: {avg: 1000}, speedOut: emptyMetric});
  });

  test('crashes keep reach and bests without replacing clean averages or last-ten samples', async () => {
    const r = rig();
    await r.history.ready;
    for (let index = 1; index <= 12; index++) {
      r.go(); r.touch({speedBefore: index * 100, angle: 20}); r.exit({exitSpeed: index * 90}); r.reset();
      r.go(); r.touch({speedBefore: 9999, angle: 0});
      r.exit({crash: true, exitSpeed: 9998}); r.reset();
    }
    r.go(); r.reset();
    expect(stats(r)).toMatchObject({runs: 25, touches: [{reach: 24 / 25, crashes: 12,
      speedIn: {best: 9999, avg: 650, last10: 750},
      speedOut: {best: 9998, avg: 585, last10: 675},
      angle: {best: 0, avg: 20, last10: 20}}]});
    const next = rig({storage: r.storage});
    await next.history.ready;
    expect(stats(next)).toEqual(stats(r));
  });

  test('an immediate reset after an edge hit excludes the visit before Surf closes', async () => {
    const r = rig();
    await r.history.ready;
    r.go(); r.touch(); r.revise({crash: true}); r.reset();
    expect(stats(r)).toMatchObject({runs: 1, touches: [{reach: 1, crashes: 1,
      speedIn: {best: 1000, avg: null, last10: null}, angle: {best: 8, avg: null, last10: null}}]});
    expect(r.history.view('utopia:3', {rampMode: 'average'}).ramps[0]).toMatchObject({
      crashes: 1, board: null, counts: {board: 0}});
  });

  test('uses the existing route before new measurements, without importing old samples', async () => {
    const bests = {id: 'utopia:3', splits: [], start: {}, ramps: {
      [KEY]: {checkpoint: 0, order: 0, board: 12}, [SECOND]: {checkpoint: 1, order: 1, board: 9},
    }, route: [KEY, SECOND]};
    const store = {load: async () => ({runs: [], bests: [bests]})};
    const r = rig({store});
    await r.history.ready;
    expect(stats(r)).toEqual({runs: 0, touches: [KEY, SECOND].map((key, index) => ({
      key, index, checkpoint: index, reach: null, crashes: 0, speedIn: emptyMetric, speedOut: emptyMetric, angle: emptyMetric, pb: null, wr: null,
    }))});
  });

  test('selects the furthest route then the PB route and restores it without legacy history', async () => {
    const r = rig();
    await r.history.ready;
    r.go(); r.touch(); r.touch({surfaceId: 2, checkpoint: 1}); r.reset();
    r.go(); r.touch({surfaceId: 3}); r.reset();
    expect(stats(r).touches.map(touch => touch.key)).toEqual([KEY, SECOND]);
    r.go(); r.touch({surfaceId: 4}); r.finish();
    expect(stats(r).touches.map(touch => touch.key)).toEqual(['[4,0,1]']);
    const next = rig({storage: r.storage});
    await next.history.ready;
    expect(stats(next)).toEqual(stats(r));
  });

  test('reads cached references by visit key without treating missing fields as zero', async () => {
    const references = {pb: {status: 'ready', ramps: new Map([[KEY, {speedBefore: 2000, speedAfter: 1900, angle: 4}]])},
      wr: {status: 'ready', ramps: new Map([[KEY, {speedBefore: 2200, speedAfter: null, angle: null}]])}};
    const requested = [];
    const r = rig({getTouchReferences: key => { requested.push(key); return references; }});
    await r.history.ready;
    r.go(); r.touch(); r.touch({visit: 2}); r.reset();
    const result = stats(r);
    expect(requested).toEqual(['utopia:3']);
    expect(result.touches[0]).toMatchObject({pb: {speedIn: 2000, speedOut: 1900, angle: 4},
      wr: {speedIn: 2200, speedOut: null, angle: null}});
    expect(result.touches[1]).toMatchObject({pb: null, wr: null});
    references.pb.status = 'loading';
    expect(stats(r).touches[0].pb).toBeNull();
  });

  test('normal attempts survive legacy load races and explicit history deletion', async () => {
    const storage = storageRig(), touchStore = createTouchStore({storage});
    touchStore.append(record(1));
    let finishLoad;
    const store = {load: () => new Promise(resolve => { finishLoad = resolve; }),
      put: async () => {}, putBests: async () => {}, remove: async () => {}, clear: async () => {}};
    const r = rig({storage, touchStore, store});
    r.go(); r.touch(); r.reset();
    expect(stats(r).runs).toBe(2);
    finishLoad({runs: [], bests: []});
    await r.history.ready;
    expect(stats(r).runs).toBe(2);
    await r.history.clear();
    expect(r.history.runs()).toEqual([]);
    expect(stats(r)).toMatchObject({runs: 2, touches: [{reach: 0.5}]});
    expect(createTouchStore({storage}).records('utopia:3')).toHaveLength(2);
  });

  test('a failed legacy load cannot erase independent touch records', async () => {
    const r = rig({store: {load: async () => { throw new Error('Unavailable'); }, put: async () => {}}});
    r.go(); r.reset();
    await r.history.ready;
    expect(stats(r).runs).toBe(1);
    expect(createTouchStore({storage: r.storage}).records('utopia:3')).toHaveLength(1);
  });
});

describe('normal timed attempt eligibility', () => {
  test('excludes practice, playback, spectating, invalid, open-start and manual-jump attempts', async () => {
    const r = rig();
    await r.history.ready;
    r.live.practice = true;
    r.go(); r.touch(); r.reset();
    r.live.practice = false;
    r.state.playback = true;
    r.go(); r.touch(); r.finish();
    r.state.playback = false;
    r.state.spectator.target = 'another-player';
    r.go(); r.touch(); r.finish();
    r.state.spectator.target = null;
    r.go(); r.touch(); r.live.timer.state.invalidReason = 'Paused'; r.tick(); r.reset();
    r.live.config.unrestrictedStart = true;
    r.go(); r.touch(); r.finish();
    r.live.config.unrestrictedStart = false;
    r.live.config.autoBhop = false;
    r.go(); r.touch(); r.finish();
    r.live.config.autoBhop = true;
    expect(stats(r).runs).toBe(0);
    expect(r.storage.writes).toEqual([]);
    r.go(); r.reset();
    expect(stats(r).runs).toBe(1);
  });

  test('captures invalidation between ticks even when native restart replaces the timer state', async () => {
    const r = rig();
    await r.history.ready;
    r.go(); r.touch();
    r.live.timer.state.invalidReason = 'Paused';
    r.reset();
    expect(stats(r).runs).toBe(0);
    r.go(); r.touch();
    r.live.timer.state.invalidReason = 'Practice mode';
    r.live.practice = true;
    r.live.timer.state = {phase: 'ready', elapsed: 0, startTick: null, invalidReason: null, splits: []};
    r.history.reset();
    expect(stats(r).runs).toBe(0);
  });

  test('discard and ticks without a start do not record, while normal reset hooks do', async () => {
    const r = rig();
    await r.history.ready;
    r.live.timer.state.phase = 'running';
    r.tick(); r.touch(); r.finish();
    expect(stats(r).runs).toBe(0);
    r.go(); r.touch(); r.history.discard(); r.reset();
    expect(stats(r).runs).toBe(0);
    r.go(); r.history.reset(); r.history.reset();
    expect(stats(r).runs).toBe(1);
    expect(r.touchStore.records('utopia:3')[0].touches).toEqual([]);
  });

  test('changing practice or movement mode during an attempt excludes it', async () => {
    const r = rig();
    await r.history.ready;
    r.go(); r.touch(); r.live.practice = true; r.tick(); r.live.practice = false; r.reset();
    r.go(); r.live.config.unrestrictedStart = true; r.tick(); r.live.config.unrestrictedStart = false; r.reset();
    expect(stats(r).runs).toBe(0);
  });
});

test('known route touches have zero reach after attempts that end before touching', async () => {
  const storage = storageRig(), touchStore = createTouchStore({storage});
  const key = 'utopia:3';
  const history = createRunHistory({touchStore, store: {
    load: async () => ({runs: [], bests: [{id: key, splits: [], start: {}, route: [KEY],
      ramps: {[KEY]: {checkpoint: 0, order: 0}}}]}),
  }});
  await history.ready;
  touchStore.append(record(1));
  expect(history.touchStats(key)).toEqual({runs: 1, touches: [{
    key: KEY, index: 0, checkpoint: 0, reach: 0, crashes: 0, speedIn: emptyMetric, speedOut: emptyMetric, angle: emptyMetric, pb: null, wr: null,
  }]});
});

test('a repeated persisted attempt ID replaces rather than inflates its reach denominator', () => {
  const storage = storageRig(), store = createTouchStore({storage});
  store.append(record(1));
  store.append(record(1, 'utopia:3', [{key: KEY, checkpoint: 0, speedBefore: 100, speedAfter: 90, angle: 10}]));
  expect(store.records('utopia:3')).toHaveLength(1);
  expect(createTouchStore({storage}).records('utopia:3')).toEqual(store.records('utopia:3'));
});

test('upgrading touch statistics discards polluted attempts once and preserves the rebuilt store', () => {
  const storage = storageRig();
  storage.values.set('unrelated', 'keep');
  storage.values.set(TOUCH_STORAGE_KEY, JSON.stringify({version: 1, runs: [
    record(1, 'utopia:3', [{key: KEY, checkpoint: 0, speedBefore: 1000, speedAfter: 50, angle: 80}]),
    record(2, 'other:1'),
  ]}));
  const store = createTouchStore({storage});
  expect(store.records('utopia:3')).toEqual([]);
  expect(store.records('other:1')).toEqual([]);
  store.append(record(3, 'utopia:3', [{key: KEY, checkpoint: 0, speedBefore: 1000, speedAfter: 900, angle: 5}]));
  const reload = createTouchStore({storage});
  expect(reload.records('utopia:3')).toEqual(store.records('utopia:3'));
  expect(reload.records('utopia:3').map(run => run.id)).toEqual(['run-3']);
  expect(storage.values.get('unrelated')).toBe('keep');
});
