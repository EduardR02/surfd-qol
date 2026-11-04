import {expect, test} from 'bun:test';
import {buildCollisionTree} from '../extension/collision-tree.js';
import {triangleCollisionBrush} from '../extension/collision-world.js';
import {packMapBounds, buildMapBoundsTree, unpackMapBoundsTree, adoptPreparedMapWorld}
  from '../extension/map-bvh-preparation.js';

const axes = ['x', 'y', 'z'];
const point = (x = 0, y = 0, z = 0) => ({x, y, z});
const box = (x, y, z, X = x, Y = y, Z = z) => ({min: point(x, y, z), max: point(X, Y, Z)});
const triangle = (a, b, c, id = 0) => ({vertices: [a, b, c], surfaceId: 'surface', triangleId: id});
const overlap = (a, b) => axes.every(axis => a.min[axis] <= b.max[axis] && a.max[axis] >= b.min[axis]);

// Independent native sorting builder and query, including axis and ID ties.
class NativeTree {
  static constructions = 0;
  constructor(bounds, threshold = 12) {
    NativeTree.constructions++;
    this.bounds = bounds;
    const build = items => {
      const min = point(Infinity, Infinity, Infinity), max = point(-Infinity, -Infinity, -Infinity);
      for (const id of items) for (const axis of axes) {
        min[axis] = Math.min(min[axis], bounds[id].min[axis]);
        max[axis] = Math.max(max[axis], bounds[id].max[axis]);
      }
      if (items.length <= threshold) return {min, max, items};
      const axis = axes.reduce((a, b) => max[b] - min[b] > max[a] - min[a] ? b : a);
      items.sort((a, b) => bounds[a].min[axis] + bounds[a].max[axis] -
        (bounds[b].min[axis] + bounds[b].max[axis]) || a - b);
      const middle = items.length >> 1;
      return {min, max, left: build(items.slice(0, middle)), right: build(items.slice(middle))};
    };
    this.root = bounds.length ? build(bounds.map((_, i) => i)) : null;
  }
  query(query) {
    const result = [];
    const visit = node => {
      if (!overlap(node, query)) return;
      if (node.items) {
        for (const id of node.items) if (overlap(this.bounds[id], query)) result.push(id);
      } else { visit(node.left); visit(node.right); }
    };
    if (this.root) visit(this.root);
    return result.sort((a, b) => a - b);
  }
}

function nativeTriangleBounds(triangles) {
  return triangles.map(item => ({
    min: point(...axes.map(axis => Math.min(...item.vertices.map(vertex => vertex[axis])))),
    max: point(...axes.map(axis => Math.max(...item.vertices.map(vertex => vertex[axis])))),
  }));
}

// This uses the reviewed native sweep fixture's actual plane clipping, including
// displacement brushes and both feature flags, not a forwarding stub.
class NativeWorld {
  triangleCache = new Map();
  constructor(brushes, triangles = [], feature = false, corner = false) {
    this.brushes = brushes; this.triangles = triangles;
    this.vphysicsFeatureFix = feature; this.bspCornerFix = corner;
    this.triangleBounds = nativeTriangleBounds(triangles);
    this.tree = new NativeTree([...brushes, ...this.triangleBounds]);
  }
  triangleBrush(index) {
    let brush = this.triangleCache.get(index);
    if (!brush) {
      brush = triangleCollisionBrush(this.triangles[index], this.triangleBounds[index]);
      this.triangleCache.set(index, brush);
    }
    return brush;
  }
  trace(start, end, hull) {
    const epsilon = 0.03125, dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
    const sweep = {min: point(), max: point()};
    for (const axis of axes) {
      sweep.min[axis] = Math.min(start[axis], end[axis]) + hull.min[axis] - epsilon;
      sweep.max[axis] = Math.max(start[axis], end[axis]) + hull.max[axis] + epsilon;
    }
    const result = {fraction: 1, end: {...end}, normal: point(), startSolid: false, allSolid: false, brush: null};
    for (const index of this.tree.query(sweep)) {
      const brush = index < this.brushes.length ? this.brushes[index] : this.triangleBrush(index - this.brushes.length);
      if (axes.some(axis => Math.max(start[axis], end[axis]) + hull.max[axis] < brush.min[axis] - epsilon ||
          Math.min(start[axis], end[axis]) + hull.min[axis] > brush.max[axis] + epsilon) ||
          brush.leafBounds && !brush.leafBounds.some(leaf => overlap(sweep, leaf))) continue;
      let enter = -1, leave = 1, normal = point(), startsOutside = false, endsOutside = false;
      let missed = false, friction, exactEnter = -Infinity, exactLeave = Infinity, fixedEnter = -1, fixedNormal = point();
      const corner = this.bspCornerFix && !brush.collisionModel && brush.planes.length === 6 &&
        brush.planes.every(plane => axes.filter(axis => plane.normal[axis] !== 0).length === 1 &&
          axes.some(axis => Math.abs(plane.normal[axis]) === 1));
      for (const plane of brush.planes) {
        const n = plane.normal;
        const support = n.x * (n.x < 0 ? hull.max.x : hull.min.x) +
          n.y * (n.y < 0 ? hull.max.y : hull.min.y) + n.z * (n.z < 0 ? hull.max.z : hull.min.z);
        const from = dot(start, n) - (plane.distance - support), to = dot(end, n) - (plane.distance - support);
        if (brush.collisionModel === 'vphysics' || corner) {
          if (from > to) {
            const exact = from / (from - to);
            if (exact > exactEnter) {
              exactEnter = exact; fixedEnter = Math.max(0, (from - epsilon) / (from - to)); fixedNormal = n;
            }
          } else if (from < to) exactLeave = Math.min(exactLeave, from / (from - to));
        }
        if (from > 0) startsOutside = true;
        if (to > 0) endsOutside = true;
        if (from > 0 && to > 0 && (!brush.collisionModel || to >= from - 1e-5)) { missed = true; break; }
        if (from <= 0 && to <= 0) continue;
        if (from > to) {
          const fraction = Math.max(0, (from - epsilon) / (from - to));
          if (fraction > enter) { enter = fraction; normal = n; friction = plane.friction; }
        } else leave = Math.min(leave, (from + epsilon) / (from - to));
      }
      if (missed || exactLeave < 1 && exactEnter > exactLeave) continue;
      if (this.vphysicsFeatureFix && brush.collisionModel === 'vphysics') { enter = fixedEnter; normal = fixedNormal; }
      if (!startsOutside) {
        result.startSolid = true;
        if (!endsOutside) {
          result.allSolid = true; result.fraction = 0; result.end = {...start}; result.brush = brush;
          return result;
        }
        continue;
      }
      if (enter < leave && enter > -1 && enter < result.fraction) {
        result.fraction = Math.max(0, enter); result.normal = {...normal}; result.brush = brush;
        if (friction !== undefined) result.friction = friction;
        else delete result.friction;
      }
    }
    for (const axis of axes) result.end[axis] = start[axis] + (end[axis] - start[axis]) * result.fraction;
    return result;
  }
}

function expectExactBounds(actual, expected) {
  for (const side of ['min', 'max']) for (const axis of axes) {
    expect(Object.is(actual[side][axis], expected[side][axis])).toBe(true);
  }
}
function expectExactTree(actual, expected) {
  if (expected === null) { expect(actual).toBeNull(); return; }
  expectExactBounds(actual, expected);
  if (expected.items) expect(actual.items).toEqual(expected.items);
  else {
    expect(actual.items).toBeUndefined();
    expectExactTree(actual.left, expected.left);
    expectExactTree(actual.right, expected.right);
  }
}
function makeMap(brushCount, triangleCount) {
  const brushes = Array.from({length: brushCount}, (_, i) => {
    const x = (i * 17) % 23 - 11, y = (i * 7) % 19 - 9, z = (i * 11) % 13 - 6;
    return box(x, y, z, x + i % 4, y + i % 3, z + i % 5);
  });
  const displacementTriangles = Array.from({length: triangleCount}, (_, i) => {
    const x = (i * 13) % 23 - 11, y = (i * 3) % 19 - 9, z = (i * 5) % 13 - 6;
    return triangle(point(x, y, z), point(x + 2, y + 1, z), point(x - 1, y + 3, z + i % 4), i);
  });
  return {brushes, displacementTriangles};
}
function transferBounds(record) {
  return structuredClone(record.packedBounds, {transfer: [record.packedBounds.buffer]});
}
function transferPacket(packet) {
  return structuredClone(packet, {transfer: [packet.nodeBounds.buffer, packet.nodeData.buffer, packet.indices.buffer]});
}
const variants = [
  ['module', packMapBounds, unpackMapBoundsTree, adoptPreparedMapWorld],
  ['standalone', Function(`return (${packMapBounds.toString()})`)(),
    Function(`return (${unpackMapBoundsTree.toString()})`)(),
    Function(`return (${adoptPreparedMapWorld.toString()})`)()],
];

for (const [name, pack, unpack, adopt] of variants) {
  test(`${name}: compact transfers preserve exact bounds, native leaf order and ordered queries`, () => {
    for (const size of [0, 1, 11, 12, 13, 23, 24, 25, 64, 257]) {
      const map = makeMap(Math.floor(size / 2), size - Math.floor(size / 2));
      if (size >= 13) {
        map.brushes[0] = box(-0, -0, 0, 0, -0, -0);
        map.brushes[1] = box(5, 4, 3, -5, -4, -3);
        map.displacementTriangles[0] = triangle(point(0, -0, 0), point(-0, 0, -0), point(0, 0, -0));
      }
      const original = structuredClone(map), packed = pack(map);
      expect(packed).not.toBeNull();
      expect(packed.brushes).toBe(map.brushes);
      expect(packed.triangles).toBe(map.displacementTriangles);
      expect(packed.itemCount).toBe(size);
      const triangles = nativeTriangleBounds(map.displacementTriangles);
      for (let i = 0; i < triangles.length; i++) expectExactBounds(packed.triangleBounds[i], triangles[i]);
      const bounds = [...map.brushes, ...triangles], native = new NativeTree(bounds);
      const input = transferBounds(packed);
      expect(packed.packedBounds.byteLength).toBe(0);
      expect(map).toEqual(original);
      for (let i = 0; i < size; i++) for (let j = 0; j < 6; j++) {
        const side = j < 3 ? 'min' : 'max', axis = axes[j % 3];
        expect(Object.is(input[i * 6 + j], bounds[i][side][axis])).toBe(true);
      }
      const produced = buildMapBoundsTree(input), packet = transferPacket(produced);
      expect(produced.nodeBounds.byteLength).toBe(0);
      expect(produced.nodeData.byteLength).toBe(0);
      expect(produced.indices.byteLength).toBe(0);
      const root = unpack(packet, size);
      expectExactTree(root, native.root);
      expectExactTree(root, buildCollisionTree(bounds));
      const tree = Object.assign(Object.create(NativeTree.prototype), {bounds, root});
      const queries = [box(-100, -100, -100, 100, 100, 100), box(-0, 0, -0), box(100, 100, 100),
        box(-2, -2, -2, 2, 2, 2), ...bounds.filter((_, i) => i % 17 === 0)];
      for (const query of queries) expect(tree.query(query)).toEqual(native.query(query));
      expect(map).toEqual(original);
    }
  });

  test(`${name}: equal centers, tied axes, signed zeros and large finite coordinates keep the native tree`, () => {
    const brushes = Array.from({length: 129}, (_, i) => {
      const radius = i % 17;
      return box(-radius, -radius, i % 2 ? -0 : 0, radius, radius, i % 2 ? 0 : -0);
    });
    brushes[0] = box(-8e307, -Number.MIN_VALUE, -0, 8e307, Number.MIN_VALUE, 0);
    brushes[1] = box(2 ** 52, -0, -0, 2 ** 52 + 1, 0, 0);
    const map = {brushes, displacementTriangles: []}, packed = pack(map);
    const root = unpack(buildMapBoundsTree(transferBounds(packed)), brushes.length);
    const native = new NativeTree(brushes);
    expectExactTree(root, native.root);
    const tree = Object.assign(Object.create(NativeTree.prototype), {bounds: brushes, root});
    for (const query of [box(-0, 0, -0), box(2 ** 52 + 1, 0, 0), box(-20, -20, -1, 20, 20, 1)]) {
      expect(tree.query(query)).toEqual(native.query(query));
    }
  });

  test(`${name}: adoption uses ready native-prototype trees or immediately builds from saved triangle bounds`, () => {
    for (const ready of [true, false]) {
      const map = makeMap(23, 16), record = pack(map), savedBounds = record.triangleBounds;
      const native = new NativeWorld(map.brushes, map.displacementTriangles, true, false);
      const root = unpack(buildMapBoundsTree(transferBounds(record)), record.itemCount);
      if (ready) record.root = root;
      let consumed = 0;
      record.consume = () => { consumed++; };
      const records = new WeakMap([[map.brushes, record]]), world = Object.create(NativeWorld.prototype);
      const builds = NativeTree.constructions;
      expect(adopt(world, map.brushes, map.displacementTriangles, true, false, NativeTree, records)).toBe(true);
      expect(NativeTree.constructions).toBe(builds + (ready ? 0 : 1));
      expect(world.tree).toBeInstanceOf(NativeTree);
      expect(world.brushes).toBe(map.brushes);
      expect(world.triangles).toBe(map.displacementTriangles);
      expect(world.triangleBounds).toBe(savedBounds);
      expect(world.tree.bounds.slice(0, map.brushes.length)).toEqual(map.brushes);
      for (let i = 0; i < map.brushes.length; i++) expect(world.tree.bounds[i]).toBe(map.brushes[i]);
      for (let i = 0; i < savedBounds.length; i++) expect(world.tree.bounds[map.brushes.length + i]).toBe(savedBounds[i]);
      expect(world.vphysicsFeatureFix).toBe(true);
      expect(world.bspCornerFix).toBe(false);
      expect(world.triangleCache).toBeInstanceOf(Map);
      expect(world.triangleCache.size).toBe(0);
      expect(record.consumed).toBe(true);
      expect(consumed).toBe(1);
      expectExactTree(world.tree.root, native.tree.root);
      expect(adopt(Object.create(NativeWorld.prototype), map.brushes, map.displacementTriangles,
        false, false, NativeTree, records)).toBe(false);
      expect(consumed).toBe(1);
    }
  });

  test(`${name}: empty arrays, absent triangles, identities, count changes and cancellation stay distinct`, () => {
    const empty = {brushes: [], displacementTriangles: []}, record = pack(empty);
    record.root = unpack(buildMapBoundsTree(transferBounds(record)), 0);
    const records = new WeakMap([[empty.brushes, record]]), world = Object.create(NativeWorld.prototype);
    expect(adopt(world, empty.brushes, [], false, false, NativeTree, records)).toBe(false);
    expect(adopt(world, [], empty.displacementTriangles, false, false, NativeTree, records)).toBe(false);
    expect(adopt(world, empty.brushes, undefined, false, false, NativeTree, records)).toBe(false);
    expect(record.consumed).toBeUndefined();
    const builds = NativeTree.constructions;
    expect(adopt(world, empty.brushes, empty.displacementTriangles, undefined, undefined, NativeTree, records)).toBe(true);
    expect(NativeTree.constructions).toBe(builds);
    expect(world.tree.root).toBeNull();
    expect(world.triangles).toBe(empty.displacementTriangles);
    expect(world.vphysicsFeatureFix).toBe(false);
    expect(world.bspCornerFix).toBe(false);

    const absent = {brushes: []}, other = pack(absent), others = new WeakMap([[absent.brushes, other]]);
    expect(other.triangles).toBeUndefined();
    expect(adopt({}, absent.brushes, [], false, false, NativeTree, others)).toBe(false);
    const actual = {};
    expect(adopt(actual, absent.brushes, undefined, undefined, undefined, NativeTree, others)).toBe(true);
    expect(actual.triangles).toEqual([]);
    expect(actual.tree.root).toBeNull();

    const changed = makeMap(2, 1), saved = pack(changed), savedMap = new WeakMap([[changed.brushes, saved]]);
    changed.displacementTriangles.push(triangle(point(), point(), point()));
    expect(adopt({}, changed.brushes, changed.displacementTriangles, false, false, NativeTree, savedMap)).toBe(false);
    expect(saved.consumed).toBeUndefined();
    changed.displacementTriangles.pop();
    saved.consume = () => { throw new Error('already stopped'); };
    expect(adopt({}, changed.brushes, changed.displacementTriangles, false, false, NativeTree, savedMap)).toBe(true);
    expect(saved.consumed).toBe(true);
  });

  test(`${name}: reviewed world traces agree for native brushes, displacements and both fixes`, () => {
    const brushes = Array.from({length: 24}, (_, i) => {
      const bound = box(i * 8, -3, -2, i * 8 + 4, 3, 2);
      const planes = axes.flatMap(axis => [1, -1].map(sign => {
        const normal = point(); normal[axis] = sign;
        return {normal, distance: sign > 0 ? bound.max[axis] : -bound.min[axis], friction: i % 3 ? undefined : .4};
      }));
      return {...bound, id: `box-${i}`, planes, collisionModel: i % 2 ? 'vphysics' : undefined,
        leafBounds: i % 4 ? undefined : [bound]};
    });
    const triangles = Array.from({length: 24}, (_, i) => triangle(
      point(i * 8, 12, 0), point(i * 8 + 6, 12, 0), point(i * 8, 18, 3), i));
    const map = {brushes, displacementTriangles: triangles};
    const hulls = [box(0, 0, 0), box(-.5, -.5, -.5, .5, .5, .5)];
    for (const feature of [false, true]) for (const corner of [false, true]) {
      const native = new NativeWorld(brushes, triangles, feature, corner), record = pack(map);
      record.root = unpack(buildMapBoundsTree(transferBounds(record)), record.itemCount);
      const world = Object.create(NativeWorld.prototype);
      expect(adopt(world, brushes, triangles, feature, corner, NativeTree, new WeakMap([[brushes, record]]))).toBe(true);
      for (const hull of hulls) for (let i = 0; i < 24; i++) {
        const x = i * 8;
        const sweeps = [
          [point(x - 4, 0, 0), point(x + 8, 0, 0)],
          [point(x + 2, 0, 0), point(x + 2, 1, 0)],
          [point(x + 1, 13, 7), point(x + 1, 13, -4)],
          [point(x - 3, -6, 0), point(x + 7, 6, 0)],
          [point(x + 2, 30, 10), point(x + 2, 30, -10)],
        ];
        for (const [start, end] of sweeps) expect(world.trace(start, end, hull)).toEqual(native.trace(start, end, hull));
      }
    }
  });
}

test('unreviewed geometry returns null without invoking accessors', () => {
  const changes = [
    map => { map.brushes = new Array(1); },
    map => { map.displacementTriangles = new Array(1); },
    map => { map.displacementTriangles = null; },
    map => { map.brushes[0].min.x = NaN; },
    map => { map.brushes[0].max.y = Infinity; },
    map => { map.displacementTriangles[0].vertices[2].z = '0'; },
    map => { map.displacementTriangles[0].vertices.push(point()); },
    map => { delete map.displacementTriangles[0].vertices[1]; },
    map => { map.displacementTriangles[0].vertices.map = Array.prototype.map; },
    map => { map.displacementTriangles.constructor = Array; },
    map => { map.brushes[Symbol.iterator] = Array.prototype[Symbol.iterator]; },
    map => { Object.setPrototypeOf(map.brushes[0].min, null); },
    map => { map.displacementTriangles[0].vertices[0] = Object.assign(Object.create({x: 1}), {y: 0, z: 0}); },
    map => { Object.setPrototypeOf(map.brushes, (class extends Array {}).prototype); },
  ];
  for (const change of changes) {
    const map = makeMap(1, 1);
    change(map);
    expect(packMapBounds(map)).toBeNull();
  }
  for (const target of ['map', 'brush-index', 'brush-min', 'coordinate', 'triangle-index', 'vertices', 'vertex-index', 'map-method']) {
    const map = makeMap(1, 1), vertices = map.displacementTriangles[0].vertices;
    let reads = 0;
    const getter = () => { reads++; return 0; };
    if (target === 'map') Object.defineProperty(map, 'brushes', {get: getter});
    if (target === 'brush-index') Object.defineProperty(map.brushes, 0, {get: getter});
    if (target === 'brush-min') Object.defineProperty(map.brushes[0], 'min', {get: getter});
    if (target === 'coordinate') Object.defineProperty(vertices[0], 'x', {get: getter});
    if (target === 'triangle-index') Object.defineProperty(map.displacementTriangles, 0, {get: getter});
    if (target === 'vertices') Object.defineProperty(map.displacementTriangles[0], 'vertices', {get: getter});
    if (target === 'vertex-index') Object.defineProperty(vertices, 1, {get: getter});
    if (target === 'map-method') Object.defineProperty(vertices, 'map', {get: getter});
    expect(packMapBounds(map)).toBeNull();
    expect(reads).toBe(0);
  }
});

test('worker rejects malformed buffers and native-overflowing centers', () => {
  for (const value of [null, undefined, [], new Float32Array(6), new Float64Array(5),
    new Float64Array([NaN, 0, 0, 0, 0, 0]), new Float64Array([0, 0, 0, Infinity, 0, 0]),
    new Float64Array([Number.MAX_VALUE, 0, 0, Number.MAX_VALUE, 0, 0])]) {
    expect(buildMapBoundsTree(value)).toBeUndefined();
  }
  const detached = new Float64Array(0);
  structuredClone(detached, {transfer: [detached.buffer]});
  expect(buildMapBoundsTree(detached)).toBeUndefined();
});

test('decoder rejects malformed, disconnected, duplicated and detached internal results', () => {
  const record = packMapBounds(makeMap(30, 15));
  const original = buildMapBoundsTree(transferBounds(record));
  const changes = [
    packet => { packet.itemCount++; },
    packet => { packet.nodeBounds = new Float32Array(packet.nodeBounds); },
    packet => { packet.nodeBounds = packet.nodeBounds.slice(1); },
    packet => { packet.nodeData = packet.nodeData.slice(0, -1); },
    packet => { packet.indices = packet.indices.slice(1); },
    packet => { packet.nodeBounds[0] = NaN; },
    packet => { packet.nodeBounds[0] += 1; },
    packet => { packet.nodeData[0] = 0; },
    packet => { packet.nodeData[1] = 1; },
    packet => { packet.nodeData[2] = 0; },
    packet => { packet.indices[1] = packet.indices[0]; },
    packet => { packet.indices[0] = packet.itemCount; },
    packet => { structuredClone(packet.nodeBounds, {transfer: [packet.nodeBounds.buffer]}); },
    packet => { structuredClone(packet.nodeData, {transfer: [packet.nodeData.buffer]}); },
    packet => { structuredClone(packet.indices, {transfer: [packet.indices.buffer]}); },
  ];
  for (const change of changes) {
    const packet = structuredClone(original);
    change(packet);
    expect(unpackMapBoundsTree(packet, record.itemCount)).toBeUndefined();
  }
  for (const count of [-1, .5, NaN, undefined, record.itemCount + 1]) {
    expect(unpackMapBoundsTree(original, count)).toBeUndefined();
  }
  const empty = buildMapBoundsTree(new Float64Array(0));
  expect(unpackMapBoundsTree(empty, 0)).toBeNull();
  expect(unpackMapBoundsTree({...empty, indices: new Uint32Array(1)}, 0)).toBeUndefined();
});

test('packing frozen geometry never transfers or changes live buffers or vertex owners', () => {
  for (const [, pack, unpack, adopt] of variants) {
    const map = makeMap(2, 2), external = new Uint8Array([9, 8, 7]);
    map.brushes[0].vertices = [point(1, 2, 3)];
    map.displacementTriangles[0].metadata = external;
    const vertexOwners = map.displacementTriangles.map(item => item.vertices);
    for (const brush of map.brushes) {
      Object.freeze(brush.min); Object.freeze(brush.max);
      if (brush.vertices) {
        for (const vertex of brush.vertices) Object.freeze(vertex);
        Object.freeze(brush.vertices);
      }
      Object.freeze(brush);
    }
    for (const item of map.displacementTriangles) {
      for (const vertex of item.vertices) Object.freeze(vertex);
      Object.freeze(item.vertices); Object.freeze(item);
    }
    Object.freeze(map.brushes); Object.freeze(map.displacementTriangles); Object.freeze(map);
    const packed = pack(map), input = transferBounds(packed);
    const packet = transferPacket(buildMapBoundsTree(input));
    packed.root = unpack(packet, packed.itemCount);
    const world = Object.create(NativeWorld.prototype);
    expect(adopt(world, map.brushes, map.displacementTriangles, false, false, NativeTree,
      new WeakMap([[map.brushes, packed]]))).toBe(true);
    expect(external.byteLength).toBe(3);
    expect([...external]).toEqual([9, 8, 7]);
    expect(map.displacementTriangles[0].metadata).toBe(external);
    for (let i = 0; i < vertexOwners.length; i++) expect(map.displacementTriangles[i].vertices).toBe(vertexOwners[i]);
    expect(world.brushes).toBe(map.brushes);
    expect(world.triangles).toBe(map.displacementTriangles);
  }
});

test('invalid packet properties and shared columns request synchronous fallback', () => {
  const record = packMapBounds(makeMap(1, 1)), packet = buildMapBoundsTree(transferBounds(record));
  for (const name of ['itemCount', 'nodeBounds', 'nodeData', 'indices']) {
    const malformed = {...packet};
    Object.defineProperty(malformed, name, {get() { throw new Error('invalid packet'); }});
    expect(unpackMapBoundsTree(malformed, record.itemCount)).toBeUndefined();
  }
  if (typeof SharedArrayBuffer === 'function') {
    const shared = new Float64Array(new SharedArrayBuffer(6 * Float64Array.BYTES_PER_ELEMENT));
    expect(buildMapBoundsTree(shared)).toBeUndefined();
    const sharedNodes = new Float64Array(new SharedArrayBuffer(packet.nodeBounds.byteLength));
    sharedNodes.set(packet.nodeBounds);
    expect(unpackMapBoundsTree({...packet, nodeBounds: sharedNodes}, record.itemCount)).toBeUndefined();
  }
});
