import { expect, test } from 'bun:test';
import { createHistoryStore, createReplayArchive, packReplay, unpackReplay } from '../src/replay-archive.js';
import { createRunHistory } from '../src/run-history.js';

test('a packed replay unpacks to exactly the same commands, much smaller', async () => {
  let yaw = -94.72559999999929;
  const commands = Array.from({ length: 6000 }, (_, i) => {
    yaw += (i % 7) * 0.0132 - 0.0264;
    return { forward: i % 3 ? 0 : 400, side: i % 2 ? -400 : 400, jump: i % 50 === 0, duck: false, yaw, pitch: 10.084800000000019 + i * 1e-7 };
  });
  const replay = { format: 8, mapId: 'surf_utopia_njv', mapVersion: 'v1', config: { dt: 0.014999999664723873, gravity: 800 },
    initialState: { tick: 0, position: { x: 1.5, y: -2.25, z: 64 } }, commands };
  const packed = await packReplay(replay);
  expect(packed.byteLength).toBeLessThan(JSON.stringify(replay).length / 3);
  const back = await unpackReplay(packed);
  expect(back).toEqual(replay);
  expect(back.commands.every((command, i) => Object.is(command.yaw, commands[i].yaw) && Object.is(command.pitch, commands[i].pitch))).toBe(true);
  // Chunk joins (here every 7 commands) must not change anything.
  expect(await unpackReplay(await packReplay(replay, { chunk: 7, yieldTask: async () => {} }))).toEqual(replay);
  expect(await unpackReplay(await packReplay({ ...replay, commands: [] }))).toEqual({ ...replay, commands: [] });
});

test('cancelling replay packing stops command serialization at the next yield', async () => {
  let current = true, serialized = 0;
  const replay = {format: 8, commands: Array.from({length: 32}, (_, side) => ({
    toJSON() { serialized++; return {forward: 400, side}; },
  }))};
  const result = await packReplay(replay, {chunk: 4, isCurrent: () => current,
    yieldTask: async () => { current = false; }});
  expect(result).toBeNull();
  expect(serialized).toBe(4);
});

// Transactions stage deletions until completion, like IndexedDB; abort leaves
// both object stores intact so the caller can retry.
function deletionDatabase(records) {
  const stores = Object.fromEntries(Object.entries(records).map(([name, rows]) => [name, new Map(rows.map(row => [row.id, row]))]));
  const request = result => {
    const value = {result};
    queueMicrotask(() => value.onsuccess?.());
    return value;
  };
  const database = {
    abort: true,
    transaction(_names, mode) {
      const changes = [];
      const transaction = {error: null, objectStore: name => ({
        getAll: () => request([...stores[name].values()]),
        get: id => request(stores[name].get(id)),
        delete: id => changes.push([name, id]),
      })};
      if (mode === 'readwrite') queueMicrotask(() => {
        if (database.abort) {
          transaction.error = new Error('Deletion transaction aborted');
          transaction.onabort?.();
        } else {
          for (const [name, id] of changes) stores[name].delete(id);
          transaction.oncomplete?.();
        }
      });
      return transaction;
    },
  };
  return database;
}

test('failed replay deletion keeps it watchable and retry removes it', async () => {
  const replay = {format: 8, mapId: 'utopia', commands: [{side: 400, forward: 0, jump: true, duck: false, yaw: 1, pitch: 2}]};
  const packed = await packReplay(replay);
  const db = deletionDatabase({meta: [{id: 'run', map: 'utopia:3', bytes: packed.byteLength}], replays: [{id: 'run', packed}]});
  const archive = createReplayArchive({database: Promise.resolve(db)});
  await archive.ready;
  await expect(archive.clearMap()).rejects.toThrow('Deletion transaction aborted');
  expect(archive.has('run')).toBe(true);
  expect(await archive.get('run')).toEqual(replay);
  db.abort = false;
  await archive.clearMap();
  expect(archive.has('run')).toBe(false);
  expect(await archive.get('run')).toBeNull();
  expect(archive.usage().count).toBe(0);
});

test('clearing run records and bests is atomic when their transaction aborts', async () => {
  const records = {runs: [{id: 'run', time: 12}], bests: [{id: 'utopia:3', best: {runId: 'run'}}]};
  const db = deletionDatabase(records), history = createHistoryStore(Promise.resolve(db));
  await expect(history.clear(['run'], ['utopia:3'])).rejects.toThrow('Deletion transaction aborted');
  expect(await history.load()).toEqual(records);
  db.abort = false;
  await history.clear(['run'], ['utopia:3']);
  expect(await history.load()).toEqual({runs: [], bests: []});
});

// The four stores share transaction scheduling. Abort can target just one
// store group, so independent history/archive transactions cannot pass.
function sharedDatabase() {
  const records = Object.fromEntries(['runs', 'bests', 'meta', 'replays'].map(name => [name, new Map()]));
  const request = result => {
    const value = {result: structuredClone(result)};
    queueMicrotask(() => value.onsuccess?.());
    return value;
  };
  let held = null;
  const db = {
    records, abortStore: null, abortSaveStore: null,
    holdNextClear() {
      let started;
      const gate = {started: new Promise(resolve => { started = resolve; }), begin: started};
      held = gate;
      return gate;
    },
    transaction(names, mode) {
      names = Array.isArray(names) ? names : [names];
      const changes = [];
      const transaction = {error: null, objectStore(name) {
        if (!names.includes(name)) throw new Error(`Store outside transaction: ${name}`);
        return {
          getAll: () => request([...records[name].values()]),
          get: id => request(records[name].get(id)),
          put: value => changes.push(['put', name, structuredClone(value)]),
          delete: id => changes.push(['delete', name, id]),
          clear: () => changes.push(['clear', name]),
        };
      }};
      if (mode === 'readwrite') queueMicrotask(() => {
        const deleting = changes.some(([operation]) => operation !== 'put');
        const complete = () => {
          const abortStore = deleting ? db.abortStore : db.abortSaveStore;
          if (abortStore && names.includes(abortStore)) {
            transaction.error = new Error(`Aborted ${abortStore}`);
            transaction.onabort?.();
            return;
          }
          for (const [operation, name, value] of changes) {
            if (operation === 'clear') records[name].clear();
            else if (operation === 'delete') records[name].delete(value);
            else records[name].set(value.id, value);
          }
          transaction.oncomplete?.();
        };
        if (held && deleting) {
          const gate = held;
          held = null;
          gate.complete = complete;
          gate.begin();
        } else complete();
      });
      return transaction;
    },
  };
  return db;
}

function archivedHistory(db, prepare = null) {
  const database = Promise.resolve(db), store = createHistoryStore(database), archive = createReplayArchive({database});
  const saves = [];
  let now = 1000, sequence = 0;
  const live = {
    map: {id: 'utopia', version: 3}, config: {dt: 0.015}, replayFormat: 8,
    initialState: {position: {x: 0, y: 0, z: 0}, velocity: {x: 0, y: 0, z: 0}},
    state: {position: {x: 0, y: 0, z: 0}, velocity: {x: 350, y: 0, z: 0}},
    commands: [], timer: {state: {phase: 'ready'}}, checkpointSpeeds: [],
  };
  const history = createRunHistory({
    store, archive, clock: () => now, limits: () => ({minSeconds: 0}),
    onReplay: (run, replay) => saves.push(archive.save(run, replay, prepare)),
    onPrune: ids => { archive.retain(ids); },
    metrics: {surfSnapshot: seen => sequence && seen !== sequence ? {
      available: true, sequence, surfaceId: 1, checkpoint: 1, visit: 1, loss: 8, downLoss: 3, upLoss: 5,
    } : null},
  });
  return {
    history, store, archive, saves,
    async ready() { await Promise.all([history.ready, archive.ready]); },
    finish(time, mapId = 'utopia') {
      now++;
      live.map = {id: mapId, version: 3};
      live.commands = [{forward: 400}];
      live.checkpointSpeeds = [];
      live.timer.state = {phase: 'running', elapsed: 0, startTick: now, splits: []};
      history.observe(live, ['start']);
      live.commands.push({forward: 400});
      live.checkpointSpeeds = [2100];
      live.timer.state = {...live.timer.state, phase: 'finished', elapsed: time, splits: [time / 2]};
      sequence++;
      history.observe(live, ['finish']);
      return history.runs().at(-1)?.id;
    },
  };
}

for (const abortStore of ['runs', 'meta']) {
  test(`explicit clear aborting only ${abortStore} preserves both history and watchable replay`, async () => {
    const db = sharedDatabase(), r = archivedHistory(db);
    await r.ready();
    const id = r.finish(12);
    await Promise.all(r.saves);
    const before = structuredClone(r.history.view()), replay = await r.archive.get(id);
    db.abortStore = abortStore;
    await expect(r.history.clear()).rejects.toThrow(`Aborted ${abortStore}`);
    expect(r.history.view()).toEqual(before);
    expect(await r.archive.get(id)).toEqual(replay);
    expect((await r.store.load()).runs.map(run => run.id)).toEqual([id]);
    db.abortStore = null;
    await r.history.clear();
    expect(r.history.view()).toBeNull();
    expect(r.archive.has(id)).toBe(false);
    expect(await r.archive.get(id)).toBeNull();
    for (const rows of Object.values(db.records)) expect(rows.size).toBe(0);
  });
}

for (const abort of [false, true]) {
  test(`a finish during ${abort ? 'aborted' : 'successful'} clear keeps fresh PB, splits, ramps and replay`, async () => {
    const db = sharedDatabase(), r = archivedHistory(db);
    await r.ready();
    const oldId = r.finish(12);
    await Promise.all(r.saves);
    const gate = db.holdNextClear(), clearing = r.history.clear();
    const result = clearing.then(() => null, error => error.message);
    await gate.started;
    r.finish(6);
    expect(r.history.view().pb.id).toBe(oldId);
    db.abortStore = abort ? 'runs' : null;
    gate.complete();
    expect(await result).toBe(abort ? 'Aborted runs' : null);
    db.abortStore = null;
    await Promise.all(r.saves);
    const view = r.history.view(), freshId = view.pb.id;
    expect(freshId).not.toBe(oldId);
    expect(view.pb).toMatchObject({time: 6, replay: {length: 2}});
    expect(view.totals).toEqual({attempts: abort ? 2 : 1, finishes: abort ? 2 : 1});
    expect(view.start.count).toBe(abort ? 2 : 1);
    expect(view.splits).toEqual([expect.objectContaining({time: 3, speed: 2100, pb: 3})]);
    expect(view.ramps).toEqual([expect.objectContaining({down: 3, up: 5, surf: 8})]);
    expect((await r.archive.get(freshId)).commands).toEqual([{forward: 400}, {forward: 400}]);
    expect(r.archive.has(oldId)).toBe(abort);
    const reload = archivedHistory(db);
    await reload.ready();
    expect(reload.history.view('utopia:3')).toEqual(view);
    expect(await reload.archive.get(freshId)).toEqual(await r.archive.get(freshId));
  });

  test(`pending pre-clear preparation is ${abort ? 'preserved on abort' : 'cancelled only after commit'}`, async () => {
    const db = sharedDatabase();
    let preparing, release;
    const started = new Promise(resolve => { preparing = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    let preparations = 0;
    const r = archivedHistory(db, async () => {
      preparations++;
      preparing();
      await waiting;
      return null;
    });
    await r.ready();
    const oldId = r.finish(12);
    await started;
    const gate = db.holdNextClear(), clearing = r.history.clear();
    const result = clearing.then(() => null, error => error.message);
    await gate.started;
    db.abortStore = abort ? 'meta' : null;
    gate.complete();
    expect(await result).toBe(abort ? 'Aborted meta' : null);
    db.abortStore = null;
    release();
    expect(await r.saves[0]).toEqual(abort ? {offset: 0} : null);
    expect(preparations).toBe(1);
    expect(r.archive.has(oldId)).toBe(abort);
    expect((await r.store.load()).runs.map(run => run.id)).toEqual(abort ? [oldId] : []);
    if (abort) expect((await r.archive.get(oldId)).commands).toHaveLength(2);
    else for (const rows of Object.values(db.records)) expect(rows.size).toBe(0);
  });
}

test('a finish while clear waits for older history writes keeps its replay across reload', async () => {
  const db = sharedDatabase(), r = archivedHistory(db);
  await r.ready();
  const put = r.store.put;
  let entered, release;
  const writing = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  r.store.put = async run => { entered(); await blocked; return put(run); };
  const oldId = r.finish(12);
  await writing;
  await Promise.all(r.saves);
  const clearing = r.history.clear();
  // Enter clear's wait for the blocked write, before archive deletion begins.
  await Promise.resolve();
  await Promise.resolve();
  r.finish(6);
  release();
  await clearing;
  await Promise.all(r.saves);
  const view = r.history.view(), freshId = view.pb.id;
  expect(freshId).not.toBe(oldId);
  expect(view.recentBest.id).toBe(freshId);
  expect(view.totals).toEqual({attempts: 1, finishes: 1});
  expect((await r.archive.get(freshId)).commands).toEqual([{forward: 400}, {forward: 400}]);
  expect(r.archive.has(oldId)).toBe(false);
  const reload = archivedHistory(db);
  await reload.ready();
  expect(reload.history.view('utopia:3')).toEqual(view);
  expect(await reload.archive.get(freshId)).toEqual(await r.archive.get(freshId));
});

test('clearing one map leaves other maps and their replays intact', async () => {
  const db = sharedDatabase(), r = archivedHistory(db);
  await r.ready();
  const removed = r.finish(12), kept = r.finish(9, 'other');
  await Promise.all(r.saves);
  await r.history.clear('utopia:3');
  expect(r.history.view('utopia:3')).toBeNull();
  expect(r.history.view('other:3').pb.id).toBe(kept);
  expect(r.archive.has(removed)).toBe(false);
  expect((await r.archive.get(kept)).mapId).toBe('other');
  expect((await r.store.load()).runs.map(run => run.id)).toEqual([kept]);
  expect((await r.store.load()).bests.map(record => record.id)).toEqual(['other:3']);
});

test('compression already started before a committed clear cannot resurrect its replay', async () => {
  const db = sharedDatabase();
  let packing;
  const started = new Promise(resolve => { packing = resolve; });
  const commands = Array.from({length: 4096}, () => ({forward: 400, side: 0, yaw: 1}));
  const r = archivedHistory(db, async () => ({
    replay: {format: 8, mapId: 'utopia', get commands() { packing(); return commands; }},
    offset: 0,
  }));
  await r.ready();
  const id = r.finish(12);
  await started;
  await r.history.clear();
  expect(await r.saves[0]).toBeNull();
  expect(r.history.view()).toBeNull();
  expect(await r.archive.get(id)).toBeNull();
  for (const rows of Object.values(db.records)) expect(rows.size).toBe(0);
});

test('trim offset survives reload with the archived replay even when the run-record update never happened', async () => {
  const db = sharedDatabase(), database = Promise.resolve(db), store = createHistoryStore(database);
  const run = {id: 'trimmed', map: 'utopia:3', at: 10, replay: {start: 8, length: 10, dt: 0.015}};
  const replay = {format: 8, mapId: 'utopia', mapVersion: 3, initialState: {tick: 100},
    commands: Array.from({length: 10}, (_, tick) => ({tick}))};
  const trimmed = {...replay, initialState: {tick: 104}, commands: replay.commands.slice(4)};
  await store.put(run);
  const archive = createReplayArchive({database});
  await archive.ready;
  expect(archive.offset(run.id)).toBeNull();
  expect(await archive.save(run, replay, async () => ({replay: trimmed, offset: 4}))).toEqual({offset: 4});
  expect(archive.offset(run.id)).toBe(4);
  // Simulate closing the page before history.setReplayOffset could save.
  const restored = createReplayArchive({database});
  await restored.ready;
  expect(restored.offset(run.id)).toBe(4);
  expect(await restored.get(run.id)).toEqual(trimmed);
  expect((await store.load()).runs[0].replay).toEqual(run.replay);
});

test('untrimmed archives persist zero while missing and legacy metadata have no known offset', async () => {
  const db = sharedDatabase(), database = Promise.resolve(db);
  const replay = {format: 8, mapId: 'utopia', commands: [{forward: 400}]};
  const packed = await packReplay(replay);
  db.records.meta.set('legacy', {id: 'legacy', map: 'utopia:3', bytes: packed.byteLength});
  db.records.replays.set('legacy', {id: 'legacy', packed});
  const archive = createReplayArchive({database});
  await archive.ready;
  expect(archive.offset('absent')).toBeNull();
  expect(archive.offset('legacy')).toBeNull();
  expect(await archive.get('legacy')).toEqual(replay);
  expect(await archive.save({id: 'full', map: 'utopia:3', at: 10}, replay)).toEqual({offset: 0});
  const restored = createReplayArchive({database});
  await restored.ready;
  expect(restored.offset('full')).toBe(0);
  expect(await restored.get('full')).toEqual(replay);
});

test('an aborted replay transaction cannot publish its trim offset or replace the previous replay', async () => {
  const db = sharedDatabase(), database = Promise.resolve(db), archive = createReplayArchive({database});
  const run = {id: 'run', map: 'utopia:3', at: 10};
  const replay = {format: 8, mapId: 'utopia', commands: [{tick: 1}, {tick: 2}]};
  const trimmed = {...replay, commands: replay.commands.slice(1)};
  await archive.ready;
  await archive.save(run, replay);
  db.abortSaveStore = 'meta';
  expect(await archive.save(run, replay, async () => ({replay: trimmed, offset: 1}))).toBeNull();
  expect(archive.offset(run.id)).toBe(0);
  expect(await archive.get(run.id)).toEqual(replay);
  const restored = createReplayArchive({database});
  await restored.ready;
  expect(restored.offset(run.id)).toBe(0);
  expect(await restored.get(run.id)).toEqual(replay);
});
