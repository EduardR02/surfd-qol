import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {encodeMapValue, decodeMapValue, sameMapValue, buildMapCacheRecord, decodeMapCacheRecord, cachedWorld, MAP_CACHE_VERSION} from '../src/map-cache.js';
import {buildCollisionTree} from '../extension/collision-tree.js';
import {getRampSurfaces} from '../src/surfaces.js';
import {installCachedRampSurfaces} from '../src/map-ramp-preparation.js';
import {createMapPreparation} from '../src/map-preparation.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

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
  expect(load.prepare(decoded, .7, null)).toBe(undefined);
  const world = {};
  expect(preparation.useWorld(world, decoded.brushes, decoded.displacementTriangles, false, true, Tree)).toBe(true);
  expect(world.tree.root).toEqual(new Tree([...decoded.brushes, ...world.triangleBounds]).root);
  expect(preparation.useRamps(decoded, .7)).toBe(true);
  expect(created).toEqual([]);
  expect(scheduled).toEqual([]);
});

test('a miss schedules one record rebuild, which a later load interrupts and restarts', async () => {
  const map = mapFixture(), created = [], scheduled = [], runs = [];
  const preparation = createMapPreparation({read: async () => null,
    schedule: (start, delay) => { const item = {start, delay, cancelled: false}; scheduled.push(item); return () => { item.cancelled = true; }; }});
  const jobs = type => {
    created.push(type);
    return {ready: Promise.resolve(false), run: async (kind, payload) => { runs.push({kind, payload}); return {stored: true}; }, dispose() {}};
  };
  const load = preparation.createLoad(new AbortController().signal, jobs, true);
  expect(created).toEqual([]);
  expect(await load.read('a'.repeat(64))).toBe(null);
  expect(created).toEqual(['map-bvh', 'map-ramps']);
  load.prepare(map, .7, {key: 'a'.repeat(64), url: 'https://assets.example/packed/a.json.gz'});
  const second = preparation.createLoad(new AbortController().signal, jobs, true);
  await second.read('a'.repeat(64));
  second.prepare(mapFixture(), .7, {key: 'a'.repeat(64), url: 'https://assets.example/packed/a.json.gz'});
  expect(scheduled).toHaveLength(2);
  expect(scheduled.map(item => item.cancelled)).toEqual([true, false]);
  expect(scheduled[1].delay).toBeGreaterThan(0);
  scheduled[1].start();
  await Promise.resolve();
  expect(runs).toEqual([{kind: 'map-cache', payload: {key: 'a'.repeat(64), url: 'https://assets.example/packed/a.json.gz', groundNormal: .7, mapId: map.id}}]);
});

test('a load without a signal keeps native preparation available', async () => {
  const preparation = createMapPreparation({read: async () => null, schedule: () => () => {}});
  const load = preparation.createLoad(undefined, () => ({ready: Promise.resolve(false), run: async () => null, dispose() {}}), true);
  expect(load).not.toBe(null);
  expect(await load.read(undefined)).toBe(null);
});

test('a new load stops a running record rebuild and restarts it after its own geometry', async () => {
  const scheduled = [], jobs = [];
  const preparation = createMapPreparation({read: async () => null,
    schedule: start => { scheduled.push(start); return () => {}; }});
  const createJobs = type => {
    const job = {type, disposed: false, ready: Promise.resolve(false), run: () => new Promise(() => {}), dispose() { this.disposed = true; }};
    jobs.push(job);
    return job;
  };
  const first = preparation.createLoad(new AbortController().signal, createJobs, true);
  await first.read('b'.repeat(64));
  first.prepare(mapFixture(), .7, {key: 'b'.repeat(64), url: 'https://assets.example/b'});
  scheduled[0]();
  const rebuild = jobs.find(job => job.type === 'map-cache');
  expect(rebuild.disposed).toBe(false);
  const second = preparation.createLoad(new AbortController().signal, createJobs, true);
  expect(rebuild.disposed).toBe(true);
  expect(scheduled).toHaveLength(1);
  await second.read('c'.repeat(64));
  second.prepare(mapFixture(), .7, null);
  expect(scheduled).toHaveLength(2);
  preparation.destroy();
});
