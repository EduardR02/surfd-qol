import {expect, test} from 'bun:test';
import {createTouchStorageClient} from '../src/touch-storage.js';
import {TOUCH_STORAGE_KEY} from '../extension/touch-history.js';

function rig(handle, {waitForIdle = async () => {}} = {}) {
  const values = new Map([[TOUCH_STORAGE_KEY, '{"version":2,"runs":[]}'], ['unrelated', 'keep']]);
  const listeners = new Set(), origin = 'https://surfd.net';
  const events = {
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
    postMessage(message) {
      if (message.direction !== 'request') return;
      Promise.resolve().then(() => handle(message)).then(
        value => deliver({...message, direction: 'response', value}),
        error => deliver({...message, direction: 'response', error: error.message}));
    },
  };
  function deliver(data) { for (const listener of listeners) listener({source: events, origin, data}); }
  const client = createTouchStorageClient({events, origin, waitForIdle,
    legacyStorage: () => ({getItem: key => values.get(key) ?? null, removeItem: key => values.delete(key)})});
  return {values, client};
}

function gate() {
  let resolve;
  return {promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value)};
}

test('migration leaves the only legacy copy intact until the worker commits', async () => {
  const commit = gate(), started = gate(), idle = gate();
  const r = rig(async () => { started.resolve(); return commit.promise; }, {waitForIdle: () => idle.promise});
  try {
    expect(r.values.has(TOUCH_STORAGE_KEY)).toBe(true);
    idle.resolve();
    await started.promise;
    expect(r.values.has(TOUCH_STORAGE_KEY)).toBe(true);
    commit.resolve(true);
    await r.client.ready;
    expect(r.values.has(TOUCH_STORAGE_KEY)).toBe(false);
    expect(r.values.get('unrelated')).toBe('keep');
  } finally { r.client.destroy(); }
});

for (const failure of ['reject', 'uncommitted']) test(`a ${failure} migration preserves the legacy data without blocking new storage`, async () => {
  const records = [{id: 'saved-attempt'}];
  const r = rig(async message => {
    if (message.action === 'migrate') {
      if (failure === 'reject') throw new Error('Transaction aborted');
      return false;
    }
    return records;
  });
  try {
    const original = r.values.get(TOUCH_STORAGE_KEY);
    await r.client.ready;
    expect(r.values.get(TOUCH_STORAGE_KEY)).toBe(original);
    expect(await r.client.load('map:1')).toEqual(records);
  } finally { r.client.destroy(); }
});

test('migration cannot delete legacy records changed by another tab during the import', async () => {
  const commit = gate(), started = gate();
  const r = rig(async () => { started.resolve(); return commit.promise; });
  try {
    await started.promise;
    const replacement = '{"version":2,"runs":[{"id":"newer-attempt"}]}';
    r.values.set(TOUCH_STORAGE_KEY, replacement);
    commit.resolve(true);
    await r.client.ready;
    expect(r.values.get(TOUCH_STORAGE_KEY)).toBe(replacement);
  } finally { r.client.destroy(); }
});
