import {expect, test} from 'bun:test';
import {createTouchHistoryStorage} from '../extension/touch-history.js';

// Like the archive tests, stage mutations until transaction completion so an
// aborted import cannot partially replace attempts or publish its marker.
function databaseRig() {
  const records = {};
  let initialized = false;
  const db = {
    abortNext: false,
    createObjectStore(name) { records[name] = new Map(); return {createIndex() {}}; },
    transaction(names, mode) {
      const staged = Object.fromEntries(names.map(name => [name, new Map(records[name])]));
      let timer, settled = false;
      const tx = {
        error: null,
        abort() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          tx.error = new Error('Transaction aborted');
          tx.onabort?.();
        },
        objectStore(name) {
          const rows = staged[name];
          const request = value => {
            schedule();
            const result = {result: structuredClone(value)};
            queueMicrotask(() => result.onsuccess?.());
            return result;
          };
          return {
            get: id => request(rows.get(id)),
            getAll: () => request([...rows.values()]),
            put(value) { rows.set(value.id, structuredClone(value)); schedule(); },
            delete(id) { rows.delete(id); schedule(); },
            clear() { rows.clear(); schedule(); },
            index(field) {
              const matching = value => [...rows.values()].filter(row => row[field] === value);
              return {getAll: value => request(matching(value)), getAllKeys: value => request(matching(value).map(row => row.id))};
            },
          };
        },
      };
      function schedule() {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (settled) return;
          if (mode === 'readwrite' && db.abortNext) { db.abortNext = false; tx.abort(); return; }
          settled = true;
          if (mode === 'readwrite') for (const name of names) records[name] = staged[name];
          tx.oncomplete?.();
        }, 0);
      }
      schedule();
      return tx;
    },
  };
  const indexedDB = {open() {
    const request = {result: db};
    queueMicrotask(() => {
      if (!initialized) { initialized = true; request.onupgradeneeded?.(); }
      request.onsuccess?.();
    });
    return request;
  }};
  return {db, indexedDB};
}

const run = (index, map = 'utopia:3', speed = index) => ({id: `run-${index}`, map, at: index,
  time: 1, outcome: 'reset', checkpoints: 0,
  touches: [{key: '[1,0,1]', checkpoint: 0, speedBefore: speed, speedAfter: speed, angle: 5}]});

test('incremental writes durably retain the latest 200 attempts and 50 played maps', async () => {
  const database = databaseRig(), store = createTouchHistoryStorage(database);
  for (let index = 0; index <= 200; index++) await store.append(run(index));
  let reload = createTouchHistoryStorage(database);
  const records = await reload.load('utopia:3');
  expect(records.map(record => record.id)).toEqual(Array.from({length: 200}, (_, index) => `run-${index + 1}`));
  for (let index = 1; index <= 50; index++) await store.append(run(1000 + index, `map-${index}`));
  reload = createTouchHistoryStorage(database);
  expect(await reload.load('utopia:3')).toEqual([]);
  expect(await reload.load('map-1')).toEqual([run(1001, 'map-1')].map(record => ({...record,
    touches: record.touches.map(touch => ({...touch, crash: false}))})));
  expect((await reload.load('map-50'))[0].id).toBe('run-1050');
});

test('migration merges legacy attempts without overwriting newer database records or replaying expired imports', async () => {
  const database = databaseRig(), store = createTouchHistoryStorage(database);
  await store.append(run(200, 'utopia:3', 999));
  const legacy = JSON.stringify({version: 2, runs: Array.from({length: 201}, (_, index) => run(index))});
  await store.migrate(legacy);
  const imported = await store.load('utopia:3');
  expect(imported[0].id).toBe('run-1');
  expect(imported.at(-1).touches[0].speedBefore).toBe(999);
  await store.append(run(201));
  await store.migrate(legacy);
  const reload = createTouchHistoryStorage(database);
  const retained = await reload.load('utopia:3');
  expect(retained[0].id).toBe('run-2');
  expect(retained.at(-1).id).toBe('run-201');
});

test('an aborted import preserves existing history and can be retried without a false completed marker', async () => {
  const database = databaseRig(), store = createTouchHistoryStorage(database);
  await store.append(run(2));
  database.db.abortNext = true;
  const legacy = JSON.stringify({version: 2, runs: [run(1)]});
  await expect(store.migrate(legacy)).rejects.toThrow('Transaction aborted');
  expect((await store.load('utopia:3')).map(record => record.id)).toEqual(['run-2']);
  await store.migrate(legacy);
  expect((await store.load('utopia:3')).map(record => record.id)).toEqual(['run-1', 'run-2']);
  await expect(store.migrate('{')).rejects.toThrow();
  expect((await store.load('utopia:3')).map(record => record.id)).toEqual(['run-1', 'run-2']);
});

test('obsolete polluted statistics are discarded once without deleting subsequently rebuilt attempts', async () => {
  const database = databaseRig(), store = createTouchHistoryStorage(database);
  const legacy = JSON.stringify({version: 1, runs: [run(1), run(2, 'other:1')]});
  await store.migrate(legacy);
  expect(await store.load('utopia:3')).toEqual([]);
  expect(await store.load('other:1')).toEqual([]);
  await store.append(run(3));
  await store.migrate(legacy);
  const reload = createTouchHistoryStorage(database);
  expect((await reload.load('utopia:3')).map(record => record.id)).toEqual(['run-3']);
});

test('migration selects retained maps by final recency without losing their earlier attempts', async () => {
  const database = databaseRig(), store = createTouchHistoryStorage(database);
  await store.append(run(1, 'revisited'));
  for (let index = 2; index <= 50; index++) await store.append(run(index, `map-${index}`));
  await store.append(run(100, 'revisited'));
  await store.migrate(JSON.stringify({version: 2, runs: [run(51, 'imported')]}));
  expect((await store.load('revisited')).map(record => record.id)).toEqual(['run-1', 'run-100']);
  expect(await store.load('map-2')).toEqual([]);
  expect((await store.load('imported')).map(record => record.id)).toEqual(['run-51']);
});
