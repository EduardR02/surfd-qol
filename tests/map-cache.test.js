import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {encodeMapValue, decodeMapValue, decodeMapValueCooperatively, sameMapValue, buildMapCacheRecord, decodeMapCacheRecord, cachedWorld, staleMapCacheKeys, writeMapCache, readVerifiedMapCache, MAP_CACHE_VERSION} from '../src/map-cache.js';
import {buildCollisionTree} from '../extension/collision-tree.js';
import {getRampSurfaces} from '../src/surfaces.js';
import {installCachedRampSurfaces} from '../src/map-ramp-preparation.js';
import {createMapPreparation, defaultCache} from '../src/map-preparation.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return {promise, resolve, reject};
}

// In-memory IndexedDB. Requests settle on later tasks in issue order; writes
// apply when their transaction commits, after its last request settles.
function memoryIndexedDB({quota = Infinity} = {}) {
  const stores = new Map(), later = callback => setTimeout(callback, 0);
  const factory = {stores, afterGet: null,
    open() {
      const request = {};
      later(() => {
        const db = {closed: false,
          objectStoreNames: {contains: name => stores.has(name)},
          createObjectStore(name) { stores.set(name, new Map()); },
          transaction(names, mode = 'readonly') {
            if (db.closed) throw new DOMException('Database closed', 'InvalidStateError');
            return transaction([names].flat(), mode);
          },
          close() { db.closed = true; },
        };
        request.result = db;
        if (!stores.size) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  function transaction(names, mode) {
    const writes = [];
    let pending = 0, finished = false;
    const result = {error: null, objectStore(name) {
      if (!names.includes(name)) throw new DOMException('Store outside the transaction', 'NotFoundError');
      const store = stores.get(name);
      function write(change) {
        if (mode !== 'readwrite') throw new DOMException('Read-only transaction', 'ReadOnlyError');
        writes.push(() => change(store));
        return issue(() => undefined);
      }
      return {
        get: key => issue(() => { const value = structuredClone(store.get(key)); factory.afterGet?.(name, key); return value; }),
        getKey: key => issue(() => store.has(key) ? key : undefined),
        getAll: () => issue(() => [...store.values()].map(value => structuredClone(value))),
        put(value) {
          const copy = structuredClone(value);
          if (copy.buffer?.byteLength > quota) abort(new DOMException('Quota exceeded', 'QuotaExceededError'));
          return write(target => target.set(copy.key, copy));
        },
        delete: key => write(target => target.delete(key)),
      };
    }};
    function issue(read) {
      const request = {};
      pending++;
      later(() => {
        if (finished) return;
        request.result = read();
        request.onsuccess?.();
        if (--pending === 0) later(commit);
      });
      return request;
    }
    function commit() {
      if (finished || pending) return;
      finished = true;
      for (const apply of writes) apply();
      result.oncomplete?.();
    }
    function abort(error) {
      later(() => {
        if (finished) return;
        finished = true;
        result.error = error;
        result.onerror?.();
        result.onabort?.();
      });
    }
    later(commit);
    return result;
  }
  return factory;
}

function mapFixture() {
  const normal = {x: 0, y: .8, z: .6};
  const brushes = [0, 10, 100].map((x, id) => ({id: `bsp-${id}`,
    vertices: [{x, y: 0, z: 0}, {x: x + 10, y: 0, z: 0}, {x: x + 10, y: 10, z: -40 / 3}, {x, y: 10, z: -40 / 3}],
    faces: [[0, 1, 2, 3]], planes: [{normal: {...normal}, distance: 0}],
    min: {x, y: 0, z: -40 / 3}, max: {x: x + 10, y: 10, z: 0}, kind: 'surf'}));
  const displacementTriangles = [
    {vertices: [{x: 1, y: 2, z: 3}, {x: 4.5, y: -2, z: 0.1}, {x: -0, y: 1e-7, z: 3e20}], surfaceId: 0, triangleId: 0},
    {vertices: [{x: 5, y: 5, z: 5}, {x: 6, y: 5, z: 5}, {x: 5, y: 6, z: 5.25}], surfaceId: 0, triangleId: 1},
  ];
  return {id: 'surf_fixture', version: 'v1', brushes, displacementTriangles,
    zones: [{id: 'start', kind: 'start', min: {x: 0, y: 0, z: 0}, max: {x: 1, y: 1, z: 1}}, {id: 'end', kind: 'finish', min: {x: 2, y: 2, z: 2}, max: {x: 3, y: 3, z: 3}}],
    spawn: {position: {x: 0, y: 0, z: 0}, yaw: 90, pitch: 0}, fallZ: -1e4, stages: [], flags: [true, false, null]};
}

test('decoding reproduces parsed JSON exactly, including key order and negative zero', () => {
  const text = '{"2":1,"b":[-0,0,1.5,0.1,4294967296,-2147483648,2147483648,"\\u2603",true,false,null,[],{}],' +
    '"__proto__":{"x":1},"a":{"x":1,"y":[{"x":2},{"x":3,"y":4}]},"1":"one","nested":[[1,[2,[3]]]],"sparse":[0.30000000000000004]}';
  const parsed = JSON.parse(text), decoded = decodeMapValue(encodeMapValue(parsed));
  expect(sameMapValue(decoded, parsed)).toBe(true);
  expect(JSON.stringify(decoded)).toBe(JSON.stringify(parsed));
  expect(Object.keys(decoded)).toEqual(Object.keys(parsed));
  expect(Object.is(decoded.b[0], -0)).toBe(true);
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  expect(Object.hasOwn(decoded, '__proto__')).toBe(true);
  expect(decoded.__proto__).toEqual({x: 1});
  expect(sameMapValue({a: 1, b: 2}, {b: 2, a: 1})).toBe(false);
  expect(sameMapValue([0], [-0])).toBe(false);
});

test('decoder rejects truncated or inconsistent streams', () => {
  const encoded = encodeMapValue({a: [1, 2, 3], b: 'x'});
  expect(() => decodeMapValue({...encoded, streams: {...encoded.streams, tags: encoded.streams.tags.subarray(0, 3)}})).toThrow();
  expect(() => decodeMapValue({...encoded, strings: []})).toThrow();
  expect(() => decodeMapValue({...encoded, shapes: []})).toThrow();
  const extra = new Uint8Array(encoded.streams.tags.length + 1);
  extra.set(encoded.streams.tags);
  expect(() => decodeMapValue({...encoded, streams: {...encoded.streams, tags: extra}})).toThrow();
});

test('cooperative decoding preserves values, yields, rejects corruption and stops on abort', async () => {
  const value = JSON.parse('{"__proto__":{"x":-0},"list":[]}');
  value.list = Array.from({length: 12000}, (_, index) => ({index, point: [index, -0, index / 3]}));
  const encoded = encodeMapValue(value);
  let yields = 0;
  const decoded = await decodeMapValueCooperatively(encoded, undefined, async () => { yields++; });
  expect(yields).toBeGreaterThan(0);
  expect(sameMapValue(decoded, value)).toBe(true);
  expect(Object.hasOwn(decoded, '__proto__')).toBe(true);
  const bad = {...encoded, streams: {...encoded.streams, tags: encoded.streams.tags.subarray(0, 3)}};
  await expect(decodeMapValueCooperatively(bad)).rejects.toThrow();
  const controller = new AbortController();
  await expect(decodeMapValueCooperatively(encoded, controller.signal, async () => controller.abort())).rejects.toBeDefined();
});

test('a record needs the geometry hash, and carries the exact map, tree and ramps', async () => {
  const map = mapFixture(), raw = new TextEncoder().encode(JSON.stringify(map)), key = sha(raw);
  expect(await buildMapCacheRecord(raw, {key: '0'.repeat(64), groundNormal: .7, mapId: map.id})).toBe(null);
  expect(await buildMapCacheRecord(raw, {key, groundNormal: .7, mapId: 'other'})).toBe(null);
  const record = await buildMapCacheRecord(raw, {key, groundNormal: .7, mapId: map.id});
  expect(record.version).toBe(MAP_CACHE_VERSION);
  const decoded = await decodeMapCacheRecord(structuredClone(record), key);
  expect(sameMapValue(decoded.map, JSON.parse(new TextDecoder().decode(raw)))).toBe(true);
  const world = cachedWorld(decoded, decoded.map);
  const bounds = [...decoded.map.brushes, ...world.triangleBounds];
  expect(world.root).toEqual(buildCollisionTree(JSON.parse(JSON.stringify(bounds))));
  expect(world.triangleBounds[0]).toEqual({min: {x: 0, y: -2, z: 0.1}, max: {x: 4.5, y: 2, z: 3e20}});
  const expected = getRampSurfaces(JSON.parse(new TextDecoder().decode(raw)), .7);
  const {rampOrdinals, rampComponents, rampNormals} = decoded.sections;
  expect(installCachedRampSurfaces(decoded.map, .7, rampOrdinals, rampComponents, rampNormals)).toBe(true);
  const actual = getRampSurfaces(decoded.map, .7);
  for (const brush of decoded.map.brushes) {
    expect(actual.find(brush.id, brush.planes[0].normal)).toEqual(expected.find(brush.id, brush.planes[0].normal));
  }
});

test('any changed byte, key or version keeps the native download', async () => {
  const map = mapFixture(), raw = new TextEncoder().encode(JSON.stringify(map)), key = sha(raw);
  const record = await buildMapCacheRecord(raw, {key, groundNormal: .7, mapId: map.id});
  for (let offset = 0; offset < record.buffer.byteLength; offset += Math.max(1, record.buffer.byteLength >> 6)) {
    const copy = structuredClone(record), bytes = new Uint8Array(copy.buffer);
    bytes[offset] ^= 1;
    expect(await decodeMapCacheRecord(copy, key)).toBe(null);
  }
  expect(await decodeMapCacheRecord(record, '1'.repeat(64))).toBe(null);
  expect(await decodeMapCacheRecord({...record, version: 'old'}, key)).toBe(null);
  expect(await decodeMapCacheRecord(null, key)).toBe(null);
});

test('cached ramps reject out-of-range or unordered faces', () => {
  const map = mapFixture();
  const ordinals = Uint32Array.of(0, 1), components = Uint32Array.of(0, 1), normals = Float64Array.of(0, .8, .6, 0, .8, .6);
  expect(installCachedRampSurfaces(map, .7, Uint32Array.of(0, 9), components, normals)).toBe(false);
  expect(installCachedRampSurfaces(map, .7, Uint32Array.of(1, 0), components, normals)).toBe(false);
  expect(installCachedRampSurfaces(map, .7, ordinals, Uint32Array.of(1, 1), normals)).toBe(false);
  expect(installCachedRampSurfaces(map, .7, ordinals, components, Float64Array.of(0, .8, .6, 0, 0, .9))).toBe(false);
  expect(installCachedRampSurfaces(map, .7, ordinals, components, normals)).toBe(true);
});

class Tree {
  constructor(bounds) { this.bounds = bounds; this.root = buildCollisionTree(bounds); }
}

test('a cached load adopts the stored tree and ramps without starting workers', async () => {
  const map = mapFixture(), raw = new TextEncoder().encode(JSON.stringify(map)), key = sha(raw);
  const record = await buildMapCacheRecord(raw, {key, groundNormal: .7, mapId: map.id});
  const created = [], scheduled = [];
  const preparation = createMapPreparation({
    read: async requested => requested === key ? decodeMapCacheRecord(structuredClone(record), key) : null,
    schedule: (start, delay) => { scheduled.push({start, delay}); return () => {}; },
  });
  const load = preparation.createLoad(new AbortController().signal, type => { created.push(type); throw new Error('no workers'); }, true);
  const decoded = await load.read(key);
  expect(sameMapValue(decoded, JSON.parse(new TextDecoder().decode(raw)))).toBe(true);
  await load.prepare(decoded, .7, null);
  const world = {};
  expect(preparation.useWorld(world, decoded.brushes, decoded.displacementTriangles, false, true, Tree)).toBe(true);
  expect(world.tree.root).toEqual(new Tree([...decoded.brushes, ...world.triangleBounds]).root);
  expect(preparation.useRamps(decoded, .7)).toBe(true);
  expect(created).toEqual([]);
  expect(scheduled).toEqual([]);
});

test('aborting during cooperative cached preparation prevents world installation', async () => {
  const map = mapFixture(), raw = new TextEncoder().encode(JSON.stringify(map)), key = sha(raw);
  const record = await buildMapCacheRecord(raw, {key, groundNormal: .7, mapId: map.id});
  const preparation = createMapPreparation({
    read: async () => decodeMapCacheRecord(structuredClone(record), key),
    schedule: () => () => {},
  });
  const controller = new AbortController();
  const load = preparation.createLoad(controller.signal, () => { throw new Error('no workers'); }, true);
  const decoded = await load.read(key);
  const pending = load.prepare(decoded, .7);
  controller.abort();
  await pending;
  expect(preparation.useWorld({}, decoded.brushes, decoded.displacementTriangles, false, false, Tree)).toBe(false);
  expect(preparation.useRamps(decoded, .7)).toBe(false);
});

test('a load without a signal keeps native preparation available', async () => {
  const preparation = createMapPreparation({read: async () => null, schedule: () => () => {}});
  const load = preparation.createLoad(undefined, () => ({ready: Promise.resolve(false), run: async () => null, dispose() {}}), true);
  expect(load).not.toBe(null);
  expect(await load.read(undefined)).toBe(null);
});

test('eviction keeps the most recently used records within one byte budget', () => {
  const MB = 1024 * 1024;
  const entries = [
    {key: 'oldest', size: 46 * MB, usedAt: 1}, {key: 'small', size: 4 * MB, usedAt: 7},
    {key: 'a', size: 46 * MB, usedAt: 2}, {key: 'b', size: 46 * MB, usedAt: 3}, {key: 'c', size: 46 * MB, usedAt: 4},
    {key: 'd', size: 46 * MB, usedAt: 5}, {key: 'e', size: 46 * MB, usedAt: 6},
  ];
  expect(staleMapCacheKeys(entries)).toEqual(['oldest']);
  expect(staleMapCacheKeys(entries.filter(entry => entry.key !== 'oldest'))).toEqual([]);
  expect(staleMapCacheKeys(Array.from({length: 40}, (_, index) => ({key: String(index), size: 4 * MB, usedAt: index})))).toEqual([]);
  expect(staleMapCacheKeys([{key: 'huge', size: 300 * MB, usedAt: 1}])).toEqual(['huge']);
  expect(staleMapCacheKeys([{key: 'broken', size: 'large', usedAt: 9}, {key: 'kept', size: MB, usedAt: 1}])).toEqual(['broken']);
});

// Rebuild jobs that finish when the test settles them; disposal rejects them.
function rebuildFixture() {
  const timers = [], runs = [];
  const preparation = createMapPreparation({read: async () => null,
    schedule: (start, delay) => { const timer = {start, delay, live: true}; timers.push(timer); return () => { timer.live = false; }; }});
  const createJobs = type => {
    const job = {type, disposed: false, ready: Promise.resolve(false),
      run(kind, payload) {
        const run = {payload, job, ...deferred()};
        runs.push(run);
        return run.promise;
      },
      dispose() {
        this.disposed = true;
        for (const run of runs) if (run.job === this) run.reject(new DOMException('Disposed', 'AbortError'));
      }};
    return job;
  };
  return {preparation, timers, runs,
    async visit(key) {
      const load = preparation.createLoad(new AbortController().signal, createJobs, true);
      await load.read(key.repeat(64));
      await load.prepare(mapFixture(), .7, {key: key.repeat(64), url: `https://assets.example/packed/${key}.json.gz`});
    },
    fire() { for (const timer of timers.splice(0)) if (timer.live) timer.start(); },
    started: () => runs.map(run => run.payload.key[0]),
    running: () => runs.filter(run => !run.job.disposed).map(run => run.payload.key[0]),
    async finish(result = {stored: true}) {
      runs.find(run => !run.job.disposed).resolve(result);
      await flush();
    },
  };
}

test('record rebuilds wait for entry and run one at a time, newest map first', async () => {
  const fixture = rebuildFixture();
  for (const key of ['a', 'b', 'c']) await fixture.visit(key);
  expect(fixture.running()).toEqual([]);
  fixture.preparation.enterMap();
  expect(fixture.runs).toEqual([]);
  fixture.fire();
  expect(fixture.running()).toEqual(['c']);
  expect(fixture.runs[0].payload).toEqual({key: 'c'.repeat(64), url: 'https://assets.example/packed/c.json.gz', groundNormal: .7, mapId: 'surf_fixture'});
  await fixture.finish();
  expect(fixture.running()).toEqual(['b']);
  await fixture.finish({stored: false});
  expect(fixture.running()).toEqual(['a']);
  await fixture.finish();
  expect(fixture.started()).toEqual(['c', 'b', 'a']);
  expect(fixture.running()).toEqual([]);
});

test('a missed map is queued once and only the newest few wait', async () => {
  const fixture = rebuildFixture();
  for (const key of ['a', 'b', 'a', 'c', 'd', 'e', 'f']) await fixture.visit(key);
  fixture.preparation.enterMap();
  fixture.fire();
  for (let index = 0; index < 4; index++) await fixture.finish();
  expect(fixture.started()).toEqual(['f', 'e', 'd', 'c']);
  expect(fixture.running()).toEqual([]);
});

test('a new load stops the running rebuild, which resumes after the new map', async () => {
  const fixture = rebuildFixture();
  await fixture.visit('a');
  fixture.preparation.enterMap();
  fixture.fire();
  expect(fixture.running()).toEqual(['a']);
  await fixture.visit('b');
  expect(fixture.running()).toEqual([]);
  fixture.preparation.enterMap();
  fixture.fire();
  expect(fixture.running()).toEqual(['b']);
  await fixture.finish();
  expect(fixture.running()).toEqual(['a']);
  await fixture.visit('c');
  expect(fixture.running()).toEqual([]);
  fixture.preparation.destroy();
  fixture.preparation.enterMap();
  fixture.fire();
  expect(fixture.started()).toEqual(['a', 'b', 'a']);
});

test('storage that cannot keep a record stops rebuilds for the session', async () => {
  const fixture = rebuildFixture();
  await fixture.visit('a');
  await fixture.visit('b');
  fixture.preparation.enterMap();
  fixture.fire();
  await fixture.finish({stored: false, unavailable: true});
  expect(fixture.started()).toEqual(['b']);
  await fixture.visit('c');
  fixture.preparation.enterMap();
  fixture.fire();
  expect(fixture.started()).toEqual(['b']);
});

function geometryFixture() {
  const map = mapFixture(), raw = new TextEncoder().encode(JSON.stringify(map)), key = sha(raw);
  const fetched = [], fetcher = async url => { fetched.push(url); return new Response(raw); };
  return {key, fetched, fetcher, payload: {key, url: 'https://assets.example/packed/map.json.gz', groundNormal: .7, mapId: map.id}};
}

test('a rebuild opens storage first and skips a key that is already stored', async () => {
  const {key, fetched, fetcher, payload} = geometryFixture(), indexedDB = memoryIndexedDB();
  expect(await writeMapCache(payload, fetcher, indexedDB)).toEqual({stored: true, size: expect.any(Number)});
  expect(fetched).toHaveLength(1);
  expect(indexedDB.stores.get('index').get(key)).toMatchObject({key, version: MAP_CACHE_VERSION});
  expect(await writeMapCache(payload, fetcher, indexedDB)).toEqual({stored: true});
  expect(fetched).toHaveLength(1);
  // A record from another version is rebuilt.
  indexedDB.stores.get('index').get(key).version = 'old';
  expect(await writeMapCache(payload, fetcher, indexedDB)).toEqual({stored: true, size: expect.any(Number)});
  expect(fetched).toHaveLength(2);
  expect(indexedDB.stores.get('index').get(key).version).toBe(MAP_CACHE_VERSION);
});

test('blocked or full storage is reported and keeps nothing', async () => {
  const {key, fetched, fetcher, payload} = geometryFixture();
  expect(await writeMapCache(payload, fetcher, undefined)).toEqual({stored: false, unavailable: true});
  expect(await writeMapCache(payload, fetcher, {open() { throw new DOMException('Blocked', 'SecurityError'); }})).toEqual({stored: false, unavailable: true});
  expect(fetched).toEqual([]);
  const full = memoryIndexedDB({quota: 16});
  expect(await writeMapCache(payload, fetcher, full)).toEqual({stored: false, unavailable: true});
  expect(fetched).toHaveLength(1);
  expect(full.stores.get('records').has(key)).toBe(false);
  expect(full.stores.get('index').has(key)).toBe(false);
});

async function storedCache() {
  const map = mapFixture(), raw = new TextEncoder().encode(JSON.stringify(map)), key = sha(raw), indexedDB = memoryIndexedDB();
  await writeMapCache({key, url: 'https://assets.example/packed/map.json.gz', groundNormal: .7, mapId: map.id}, async () => new Response(raw), indexedDB);
  const timers = [];
  const cache = defaultCache(indexedDB, (start, delay) => { const timer = {start, delay, live: true}; timers.push(timer); return () => { timer.live = false; }; });
  return {map, key, indexedDB, timers, cache};
}

function readJob({ready = Promise.resolve(true), read} = {}) {
  const pending = [];
  return {ready, disposed: false, runs: 0,
    run(type, payload) {
      this.runs++;
      return read ? read(payload) : new Promise((resolve, reject) => pending.push(reject));
    },
    dispose() { this.disposed = true; for (const reject of pending.splice(0)) reject(new DOMException('Disposed', 'AbortError')); }};
}

test('a key without a current index row misses before the reading worker has started', async () => {
  const {key, indexedDB, cache} = await storedCache();
  const unknown = readJob({ready: new Promise(() => {})});
  expect(await cache.read('f'.repeat(64), () => unknown)).toBe(null);
  expect(unknown.disposed).toBe(true);
  indexedDB.stores.get('index').get(key).version = 'old';
  const stale = readJob({ready: new Promise(() => {})});
  expect(await cache.read(key, () => stale)).toBe(null);
  expect(stale.runs).toBe(0);
});

test('a stored record is read and verified by the worker without starting the download', async () => {
  const {map, key, indexedDB, timers, cache} = await storedCache();
  const job = readJob({read: payload => readVerifiedMapCache(payload, indexedDB)});
  const created = [], preparation = createMapPreparation(cache);
  const load = preparation.createLoad(new AbortController().signal, type => { created.push(type); return job; }, true);
  const decoded = await load.read(key);
  expect(sameMapValue(decoded, JSON.parse(JSON.stringify(map)))).toBe(true);
  expect(created).toEqual(['map-cache-read']);
  expect(job.disposed).toBe(true);
  expect(timers.map(timer => [timer.delay, timer.live])).toEqual([[20000, false]]);
});

test('a record read that stops replying falls back to the download', async () => {
  const {key, timers, cache} = await storedCache(), job = readJob();
  const result = cache.read(key, () => job);
  while (!job.runs) await flush();
  expect(timers.map(timer => timer.delay)).toEqual([20000]);
  timers[0].start();
  expect(await result).toBe(null);
  expect(job.disposed).toBe(true);
});

test('reading a record marks it used unless it was evicted after the read', async () => {
  const {key, indexedDB} = await storedCache(), index = indexedDB.stores.get('index');
  index.get(key).usedAt = 1;
  expect((await readVerifiedMapCache({key}, indexedDB)).bytes).toBeInstanceOf(Uint8Array);
  expect(index.get(key).usedAt).toBeGreaterThan(1);
  expect(index.get(key).version).toBe(MAP_CACHE_VERSION);
  // Another tab evicts the record between the read and the recency update.
  indexedDB.afterGet = (store, evicted) => {
    if (store !== 'records') return;
    indexedDB.stores.get('records').delete(evicted);
    index.delete(evicted);
  };
  expect((await readVerifiedMapCache({key}, indexedDB)).bytes).toBeInstanceOf(Uint8Array);
  await flush();
  expect(index.has(key)).toBe(false);
});
