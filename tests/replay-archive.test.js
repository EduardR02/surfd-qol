import { expect, test } from 'bun:test';
import { createHistoryStore, createReplayArchive, packReplay, unpackReplay } from '../src/replay-archive.js';

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
