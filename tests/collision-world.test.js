import {expect, spyOn, test} from 'bun:test';
import {packCollisionWorld, unpackCollisionWorld} from '../extension/collision-world.js';

const axes = ['x', 'y', 'z'];
const point = (x, y, z) => ({x, y, z});
const box = (x, y, z, X = x, Y = y, Z = z) => ({min: point(x, y, z), max: point(X, Y, Z)});
const overlap = (a, b) => axes.every(axis => a.min[axis] <= b.max[axis] && a.max[axis] >= b.min[axis]);

function nativeTree(bounds, leafSize = 3) {
  function build(items) {
    const min = point(Infinity, Infinity, Infinity), max = point(-Infinity, -Infinity, -Infinity);
    for (const i of items) for (const axis of axes) {
      min[axis] = Math.min(min[axis], bounds[i].min[axis]);
      max[axis] = Math.max(max[axis], bounds[i].max[axis]);
    }
    if (items.length <= leafSize) return {min, max, items};
    const axis = axes.reduce((a, b) => max[b] - min[b] > max[a] - min[a] ? b : a);
    items.sort((a, b) => bounds[a].min[axis] + bounds[a].max[axis] -
      (bounds[b].min[axis] + bounds[b].max[axis]) || a - b);
    const middle = items.length >> 1;
    return {min, max, left: build(items.slice(0, middle)), right: build(items.slice(middle))};
  }
  const root = bounds.length ? build(bounds.map((_, i) => i)) : null;
  return {bounds, root, query(query) {
    const result = [];
    function visit(node) {
      if (!overlap(node, query)) return;
      if (node.items) {
        for (const index of node.items) if (overlap(bounds[index], query)) result.push(index);
      } else { visit(node.left); visit(node.right); }
    }
    if (root) visit(root);
    return result.sort((a, b) => a - b);
  }};
}

function triangle(vertices, surfaceId = 'surface', triangleId = 'triangle') {
  return {vertices, surfaceId, triangleId};
}
function fixture(brushes = [], triangles = []) {
  const triangleBounds = triangles.map(t => ({
    min: Object.fromEntries(axes.map(axis => [axis, Math.min(...t.vertices.map(v => v[axis]))])),
    max: Object.fromEntries(axes.map(axis => [axis, Math.max(...t.vertices.map(v => v[axis]))])),
  }));
  const map = {id: 'offline-map', version: 'test', brushes, displacementTriangles: triangles,
    zones: [{kind: 'start', ...box(-5, -5, -5, 5, 5, 5)}],
    spawn: {position: point(1, 2, 3), yaw: 42, pitch: -3},
    futurePhysicsField: {mode: 'preserve-without-an-allowlist', values: [1, 2, 3]}};
  return {map, world: {brushes, triangles, triangleBounds, tree: nativeTree([...brushes, ...triangleBounds])}};
}
function variedFixture(count = 67) {
  const triangles = Array.from({length: count}, (_, i) => {
    const x = (i * 17) % 31 - 15, y = (i * 7) % 23 - 11, z = (i * 11) % 19 - 9;
    return triangle([point(x, y, z), point(x + (i % 3), y + 4, z), point(x - 2, y, z + (i % 5))],
      i % 2 ? `surface-${i}` : 2 ** 40 + i, i % 3 ? `triangle-${i}` : BigInt(i));
  });
  return fixture([box(-10, -10, -10, 10, 10, 10), box(10, 0, 0, 20, 0, 0), box(3, 3, 3, -3, -3, -3)], triangles);
}
function expectBounds(actual, expected) {
  for (const side of ['min', 'max']) for (const axis of axes) {
    expect(Object.is(actual[side][axis], expected[side][axis])).toBe(true);
  }
}
function expectQueries(snapshot, world, queries) {
  for (const query of queries) {
    const actual = snapshot.tree.query(query);
    expect(actual).toEqual(world.tree.query(query));
    expect(actual).toEqual(world.tree.bounds.flatMap((bound, index) => overlap(bound, query) ? [index] : []));
  }
}

const queries = [box(-100, -100, -100, 100, 100, 100), box(0, 0, 0), box(10, 0, 0),
  box(-3, -3, -3, 3, 3, 3), box(10, 10, 10), box(1000, 1000, 1000), box(3, 3, 3, -3, -3, -3)];

test('empty, brush-only and triangle-only snapshots preserve native candidates', async () => {
  const examples = [fixture(), fixture([box(0, 0, 0)]),
    fixture([], [triangle([point(0, 0, 0), point(1, 0, 0), point(0, 1, 0)])]), variedFixture()];
  for (const {map, world} of examples) {
    const packet = await packCollisionWorld(map, world);
    expect(packet).not.toBeNull();
    const snapshot = unpackCollisionWorld(packet);
    expect(snapshot).not.toBeNull();
    expectQueries(snapshot, world, queries);
    expect(Array.isArray(snapshot.map.displacementTriangles)).toBe(true);
    expect(Array.isArray(snapshot.triangleBounds)).toBe(true);
    expect(snapshot.map.displacementTriangles.length).toBe(world.triangles.length);
    expect(snapshot.triangleBounds.length).toBe(world.triangles.length);
  }
});

test('lazy indexed geometry preserves numerical values, signed zeros, IDs and caching', async () => {
  const triangles = [
    triangle([point(-0, 0, -0), point(0, -0, 0), point(-0, -0, 0)], -0, '000001'),
    triangle([point(-8e307, -Number.MIN_VALUE, 0), point(8e307, Number.MIN_VALUE, -0), point(0, 0, 0)], 2 ** 45 + 7, 9007199254740991n),
  ];
  const {map, world} = fixture([box(-0, -0, -0, 0, 0, 0)], triangles);
  const snapshot = unpackCollisionWorld(await packCollisionWorld(map, world));
  for (let i = 0; i < triangles.length; i++) {
    const actual = snapshot.map.displacementTriangles[i], expected = triangles[i];
    expect(actual).toBe(snapshot.map.displacementTriangles[i]);
    expect(actual).not.toBe(expected);
    expect(Object.is(actual.surfaceId, expected.surfaceId)).toBe(true);
    expect(actual.triangleId).toBe(expected.triangleId);
    for (let v = 0; v < 3; v++) for (const axis of axes) {
      expect(Object.is(actual.vertices[v][axis], expected.vertices[v][axis])).toBe(true);
    }
    expect(snapshot.triangleBounds[i]).toBe(snapshot.triangleBounds[i]);
    expectBounds(snapshot.triangleBounds[i], world.triangleBounds[i]);
  }
  expectQueries(snapshot, world, queries);
});

test('numeric ID columns transfer without narrowing signed zero, large or nonfinite numbers', async () => {
  const ids = [-0, Number.MAX_SAFE_INTEGER, 2 ** 40 + 7, NaN, Infinity, -Infinity, Number.MIN_VALUE];
  const triangles = ids.map((id, i) => triangle(
    [point(i, 0, 0), point(i + 1, 0, 0), point(i, 1, 0)], id, ids[ids.length - i - 1],
  ));
  const {map, world} = fixture([], triangles);
  const packet = await packCollisionWorld(map, world);
  expect(packet.surfaceIds instanceof Float64Array).toBe(true);
  expect(packet.triangleIds instanceof Float64Array).toBe(true);
  const buffers = [...new Set(Object.values(packet).filter(ArrayBuffer.isView).map(view => view.buffer))];
  const received = structuredClone(packet, {transfer: buffers});
  for (const buffer of buffers) expect(buffer.byteLength).toBe(0);
  const snapshot = unpackCollisionWorld(received);
  for (let i = 0; i < triangles.length; i++) {
    const actual = snapshot.map.displacementTriangles[i], expected = triangles[i];
    expect(Object.is(actual.surfaceId, expected.surfaceId)).toBe(true);
    expect(Object.is(actual.triangleId, expected.triangleId)).toBe(true);
    expect(`disp-${actual.surfaceId}-${actual.triangleId}`).toBe(`disp-${expected.surfaceId}-${expected.triangleId}`);
    expect(Object.is(world.triangles[i].surfaceId, ids[i])).toBe(true);
  }
  expectQueries(snapshot, world, queries);
});

test('mixed ID columns preserve the numeric prefix and opaque values independently', async () => {
  const surfaceIds = [-0, Number.MAX_SAFE_INTEGER, '000001', 12345678901234567890n, Infinity, undefined];
  const triangleIds = [2 ** 45 + 3, -0, NaN, Infinity, 'triangle-id', null];
  const triangles = surfaceIds.map((surfaceId, i) => ({
    vertices: [point(i, 0, 0), point(i + 1, 0, 0), point(i, 1, 0)], surfaceId, triangleId: triangleIds[i],
  }));
  const {map, world} = fixture([], triangles);
  const packet = await packCollisionWorld(map, world);
  expect(Array.isArray(packet.surfaceIds)).toBe(true);
  expect(Array.isArray(packet.triangleIds)).toBe(true);
  const snapshot = unpackCollisionWorld(structuredClone(packet));
  for (let i = 0; i < triangles.length; i++) {
    const actual = snapshot.map.displacementTriangles[i];
    expect(Object.is(actual.surfaceId, surfaceIds[i])).toBe(true);
    expect(Object.is(actual.triangleId, triangleIds[i])).toBe(true);
  }
  const oneMixed = fixture([], triangles.map((value, i) => ({...value, triangleId: i})));
  const independent = await packCollisionWorld(oneMixed.map, oneMixed.world);
  expect(Array.isArray(independent.surfaceIds)).toBe(true);
  expect(independent.triangleIds instanceof Float64Array).toBe(true);
  expectQueries(unpackCollisionWorld(independent), oneMixed.world, queries);
});

test('Array proxies preserve indexed reads, length, symbols and iteration', async () => {
  const {map, world} = variedFixture(5);
  const snapshot = unpackCollisionWorld(await packCollisionWorld(map, world));
  for (const array of [snapshot.map.displacementTriangles, snapshot.triangleBounds]) {
    expect(Array.isArray(array)).toBe(true);
    expect(array.length).toBe(5);
    expect(0 in array).toBe(true);
    expect(5 in array).toBe(false);
    expect(array[-1]).toBeUndefined();
    expect(array['-0']).toBeUndefined();
    expect(array['01']).toBeUndefined();
    expect(array['1.0']).toBeUndefined();
    expect(array[Symbol.iterator]).toBe(Array.prototype[Symbol.iterator]);
    expect([...array]).toEqual(array.map(value => value));
  }
});

test('transfer detaches only new snapshot buffers and preserves live geometry and metadata', async () => {
  const {map, world} = variedFixture();
  map.futurePhysicsField.liveBuffer = new Float64Array([1, -0, 3]);
  const originalTriangle = world.triangles[0], originalRoot = world.tree.root;
  const packet = await packCollisionWorld(map, world);
  expect(packet.map.displacementTriangles).toBeNull();
  expect(packet.map.brushes).toBe(map.brushes);
  const transfer = [...new Set(Object.values(packet).filter(ArrayBuffer.isView).map(view => view.buffer))];
  const received = structuredClone(packet, {transfer});
  for (const buffer of transfer) expect(buffer.byteLength).toBe(0);
  expect(map.futurePhysicsField.liveBuffer.byteLength).toBe(24);
  expect(Object.is(map.futurePhysicsField.liveBuffer[1], -0)).toBe(true);
  expect(world.triangles[0]).toBe(originalTriangle);
  expect(world.tree.root).toBe(originalRoot);
  expect(map.displacementTriangles).toBe(world.triangles);
  const snapshot = unpackCollisionWorld(received);
  expect(snapshot.map.futurePhysicsField).toEqual(map.futurePhysicsField);
  expect(snapshot.map.spawn).toEqual(map.spawn);
  expect(snapshot.map.zones).toEqual(map.zones);
  expectQueries(snapshot, world, queries);
});

test('overlap, duplicates, slender bounds and touching are inclusive after transfer', async () => {
  const triangles = [
    triangle([point(-1e6, -1e-9, 0), point(1e6, 1e-9, 0), point(0, 0, 0)], 'slender', 1),
    ...Array.from({length: 29}, (_, i) => triangle([point(-i, -i, -i), point(i, i, i), point(0, 0, 0)], 'overlap', i)),
    triangle([point(10, 10, 10), point(10, 10, 10), point(10, 10, 10)], 'duplicate', 'a'),
    triangle([point(10, 10, 10), point(10, 10, 10), point(10, 10, 10)], 'duplicate', 'b'),
  ];
  const {map, world} = fixture([box(-10, -10, -10, 10, 10, 10)], triangles);
  const snapshot = unpackCollisionWorld(await packCollisionWorld(map, world));
  expectQueries(snapshot, world, [...queries, box(-1e6, 0, 0), box(1e6, 0, 0), box(10, 10, 10), box(10 + 1e-8, 10, 10)]);
});

test('deterministic random queries match native and brute force repeatedly', async () => {
  const {map, world} = variedFixture(257);
  const snapshot = unpackCollisionWorld(await packCollisionWorld(map, world));
  let state = 0xabcdef01;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const boxes = Array.from({length: 200}, () => {
    const x = random() * 80 - 40, y = random() * 80 - 40, z = random() * 80 - 40;
    return box(x, y, z, x + random() * 20, y + random() * 20, z + random() * 20);
  });
  expectQueries(snapshot, world, boxes);
  expectQueries(snapshot, world, [...boxes].reverse());
});

test('both exported functions work from standalone source', async () => {
  const pack = Function(`return (${packCollisionWorld.toString()})`)();
  const unpack = Function(`return (${unpackCollisionWorld.toString()})`)();
  const {map, world} = variedFixture();
  const snapshot = unpack(await pack(map, world));
  expectQueries(snapshot, world, queries);
});

test('cooperative slices make progress, cancel promptly and use task yields by default', async () => {
  const {map, world} = variedFixture(513);
  let clock = 0;
  const now = spyOn(performance, 'now').mockImplementation(() => clock += 5);
  try {
    let yields = 0;
    const packet = await packCollisionWorld(map, world, {yieldTask: async () => { yields++; }});
    expect(yields).toBeGreaterThan(0);
    expectQueries(unpackCollisionWorld(packet), world, queries);
    expect(await packCollisionWorld(map, world, {isCurrent: () => false})).toBeNull();
    let current = true, cancellations = 0;
    expect(await packCollisionWorld(map, world, {
      isCurrent: () => current,
      yieldTask: async () => { cancellations++; current = false; },
    })).toBeNull();
    expect(cancellations).toBe(1);
    let taskRan = false;
    const timer = setTimeout(() => { taskRan = true; }, 0);
    try {
      expect(await packCollisionWorld(map, world)).not.toBeNull();
      expect(taskRan).toBe(true);
    } finally { clearTimeout(timer); }
  } finally { now.mockRestore(); }
});

test('empty triangle representations are compatible but unrelated world ownership is rejected', async () => {
  const {map, world} = fixture([box(0, 0, 0)]);
  delete map.displacementTriangles;
  expect(await packCollisionWorld(map, world)).not.toBeNull();
  map.displacementTriangles = [];
  expect(await packCollisionWorld(map, world)).not.toBeNull();
  expect(await packCollisionWorld(map, {...world, brushes: [...world.brushes]})).toBeNull();
  const populated = variedFixture(3);
  expect(await packCollisionWorld(populated.map, {...populated.world, triangles: [...populated.world.triangles]})).toBeNull();
});

test('packing rejects malformed geometry, bounds and topology without changing originals', async () => {
  for (const change of [
    ({world}) => { world.triangles[0].vertices.pop(); },
    ({world}) => { world.triangles[0].vertices.push(point(0, 0, 0)); },
    ({world}) => { world.triangles[0].vertices[1].x = Infinity; },
    ({world}) => { world.triangles[0].vertices[1].y = '0'; },
    ({world}) => { world.triangleBounds[0].min.x = NaN; },
    ({world}) => { world.tree.root.max.z = Infinity; },
    ({world}) => { world.tree.bounds = world.tree.bounds.slice(1); },
    ({world}) => { world.tree.bounds[0] = {...world.tree.bounds[0]}; },
    ({world}) => { world.triangleBounds = []; },
    ({world}) => { world.tree.root = {min: point(0, 0, 0), max: point(1, 1, 1), items: []}; },
    ({world}) => { world.tree.root = {min: point(0, 0, 0), max: point(1, 1, 1), items: [0, 0]}; },
    ({world}) => { world.tree.root.left = world.tree.root; },
    ({world}) => { world.tree.root.right = null; },
  ]) {
    const example = variedFixture(9);
    change(example);
    expect(await packCollisionWorld(example.map, example.world)).toBeNull();
  }
  expect(await packCollisionWorld(null, null)).toBeNull();
  const {map, world} = fixture();
  expect(await packCollisionWorld(map, world, {yieldTask: null})).toBeNull();
});

test('unpacking rejects malformed or detached packets', async () => {
  const {map, world} = variedFixture(9);
  const original = await packCollisionWorld(map, world);
  for (const change of [
    packet => { packet.version = 99; },
    packet => { packet.map.displacementTriangles = []; },
    packet => { packet.vertices = new Float32Array(packet.vertices); },
    packet => { packet.vertices[0] = NaN; },
    packet => { packet.bounds[0] = Infinity; },
    packet => { packet.nodeBounds[0] = -Infinity; },
    packet => { packet.surfaceIds.pop(); },
    packet => { packet.triangleIds.push(0); },
    packet => { packet.surfaceIds = new Float32Array(packet.surfaceIds.length); },
    packet => { packet.triangleIds = new Float64Array(packet.triangleIds.length - 1); },
    packet => { packet.nodeData = packet.nodeData.slice(1); },
    packet => { packet.nodeData[0] = 0; },
    packet => { packet.nodeData[1] = 0x7fffffff; },
    packet => { packet.indices[0] = 0xffffffff; },
    packet => { packet.indices[1] = packet.indices[0]; },
    packet => { packet.maxDepth = -1; },
    packet => { packet.maxDepth = 0; },
    packet => { packet.maxDepth += 1; },
    packet => { structuredClone(packet.bounds, {transfer: [packet.bounds.buffer]}); },
  ]) {
    const packet = structuredClone(original);
    change(packet);
    expect(unpackCollisionWorld(packet)).toBeNull();
  }
  for (const packet of [null, undefined, {}, {version: 1}]) expect(unpackCollisionWorld(packet)).toBeNull();
});
