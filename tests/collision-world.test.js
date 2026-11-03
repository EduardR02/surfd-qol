import {expect, spyOn, test} from 'bun:test';
import {packCollisionWorld, unpackCollisionWorld, triangleCollisionBrush} from '../extension/collision-world.js';
import {cameraWorld} from '../src/cinema-world.js';

const axes = ['x', 'y', 'z'];
const point = (x, y, z) => ({x, y, z});
const box = (x, y, z, X = x, Y = y, Z = z) => ({min: point(x, y, z), max: point(X, Y, Z)});
const overlap = (a, b) => axes.every(axis => a.min[axis] <= b.max[axis] && a.max[axis] >= b.min[axis]);
function boxPlanes(bounds) {
  return axes.flatMap(axis => [1, -1].map(sign => {
    const normal = point(0, 0, 0);
    normal[axis] = sign;
    return {normal, distance: sign > 0 ? bounds.max[axis] : -bounds.min[axis]};
  }));
}

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
  for (const brush of brushes) if (!Object.hasOwn(brush, 'planes')) brush.planes = boxPlanes(brush);
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

// The native replay worker's swept-hull brush trace, kept here as an oracle
// for the values actually read by movement, including both collision fixes.
function nativeTrace(tree, brushes, start, end, hull, featureFix, cornerFix) {
  const epsilon = 0.03125, dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const sweep = {min: point(0, 0, 0), max: point(0, 0, 0)};
  for (const axis of axes) {
    sweep.min[axis] = Math.min(start[axis], end[axis]) + hull.min[axis] - epsilon;
    sweep.max[axis] = Math.max(start[axis], end[axis]) + hull.max[axis] + epsilon;
  }
  const result = {fraction: 1, end: {...end}, normal: point(0, 0, 0), startSolid: false, allSolid: false, brush: null};
  const finish = () => ({...result, brush: result.brush && {
    id: result.brush.id, friction: result.brush.friction, collisionModel: result.brush.collisionModel,
  }});
  for (const index of tree.query(sweep)) {
    const brush = brushes[index];
    if (axes.some(axis => Math.max(start[axis], end[axis]) + hull.max[axis] < brush.min[axis] - epsilon ||
        Math.min(start[axis], end[axis]) + hull.min[axis] > brush.max[axis] + epsilon) ||
        brush.leafBounds && !brush.leafBounds.some(leaf => overlap(sweep, leaf))) continue;
    let enter = -1, leave = 1, normal = point(0, 0, 0), startsOutside = false, endsOutside = false;
    let missed = false, friction, exactEnter = -Infinity, exactLeave = Infinity, fixedEnter = -1, fixedNormal = point(0, 0, 0);
    const corner = cornerFix && !brush.collisionModel && brush.planes.length === 6 &&
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
            exactEnter = exact;
            fixedEnter = Math.max(0, (from - epsilon) / (from - to));
            fixedNormal = n;
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
    if (featureFix && brush.collisionModel === 'vphysics') { enter = fixedEnter; normal = fixedNormal; }
    if (!startsOutside) {
      result.startSolid = true;
      if (!endsOutside) {
        result.allSolid = true; result.fraction = 0; result.end = {...start}; result.brush = brush;
        return finish();
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
  return finish();
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

test('packed brushes reproduce native swept-hull contacts for both collision fixes', async () => {
  const wall = {...box(0, -8, -8, 4, 8, 8), id: 'bsp-0-22', friction: 0.75, kind: 'stone',
    leafBounds: [box(0, -8, -8, 4, -2, 8), box(0, 2, -8, 4, 8, 8)]};
  wall.planes = boxPlanes(wall);
  wall.planes[1].friction = 0.375;
  const prop = {...box(12, -8, -8, 16, 8, 8), id: 'prop-12-2', friction: 0.5,
    kind: 'ramp', collisionModel: 'vphysics'};
  prop.planes = boxPlanes(prop);
  prop.planes[1].normal.z = -0;
  prop.planes[1].friction = 0;
  const ramp = {...box(22, -8, -8, 28, 8, 8), id: 'bsp-ramp', friction: 0.91, kind: 'ramp'};
  ramp.planes = [...boxPlanes(ramp), {normal: point(0.125, 0, 0.9921567416492215), distance: 7.123456789012345}];
  const {map, world} = fixture([wall, prop, ramp]);
  const packet = await packCollisionWorld(map, world);
  const transfer = [...new Set(Object.values(packet).filter(ArrayBuffer.isView).map(view => view.buffer))];
  const snapshot = unpackCollisionWorld(structuredClone(packet, {transfer}));
  const hull = box(-0.5, -0.5, -0.5, 0.5, 0.5, 0.5);
  const paths = [
    [point(-10, 4, 0), point(30, 4, 0)],
    [point(-10, 0, 0), point(30, 0, 0)],
    [point(2, 4, 0), point(2, 4, 0)],
    [point(2, 4, 0), point(8, 4, 0)],
    [point(20, 0, 12), point(26, 0, -5)],
    [point(40, 30, 0), point(50, 30, 0)],
  ];
  for (const featureFix of [false, true]) for (const cornerFix of [false, true]) {
    for (const [start, end] of paths) {
      expect(nativeTrace(snapshot.tree, snapshot.map.brushes, start, end, hull, featureFix, cornerFix))
        .toEqual(nativeTrace(world.tree, world.brushes, start, end, hull, featureFix, cornerFix));
    }
  }
  const hit = nativeTrace(snapshot.tree, snapshot.map.brushes, ...paths[0], hull, false, false);
  expect(hit.brush.id).toBe('bsp-0-22');
  expect(hit.friction).toBe(0.375);
  expect(nativeTrace(snapshot.tree, snapshot.map.brushes, ...paths[1], hull, true, true).brush.id).toBe('prop-12-2');
  expect(nativeTrace(snapshot.tree, snapshot.map.brushes, ...paths[2], hull, false, false).allSolid).toBe(true);
  expect(snapshot.map.brushes[2].planes[6].distance).toBe(7.123456789012345);
  expect(Object.is(snapshot.map.brushes[1].planes[1].normal.z, -0)).toBe(true);
});

test('brush scalar columns and lazy objects preserve IDs, optional values and mutation', async () => {
  const ids = ['bsp-\ud800', 'bsp-\ud800', -0, 2 ** 45 + 3, NaN, Infinity, 12345678901234567890n, null, undefined];
  const brushes = ids.map((id, i) => {
    const brush = {...box(i * 10, 0, 0, i * 10 + 5, 5, 5), id, friction: i === 0 ? -0 : i,
      kind: 'stone', vertices: [point(1, 2, 3)], faces: [[0]], color: '#fff',
      contents: 1, modelIndex: 0, sourceBrush: i};
    brush.planes = boxPlanes(brush);
    return brush;
  });
  brushes[0].planes[0].friction = undefined;
  brushes[0].planes[1].friction = null;
  brushes[0].planes[2].friction = -0;
  brushes[0].planes[3].friction = NaN;
  Object.assign(brushes[1], {surfaceprop: 'wood', propIndex: 'part-2',
    modelPath: 'models/example.mdl', collisionModel: 'vphysics', broadphaseOnlyVertices: true});
  brushes[1].leafBounds = [];
  brushes[2].leafBounds = null;
  brushes[3].leafBounds = undefined;
  const {map, world} = fixture(brushes);
  const packet = await packCollisionWorld(map, world);
  expect(packet.map.brushes).toBeNull();
  expect(packet.brushData).toBeInstanceOf(Uint32Array);
  expect(packet.planeValues).toBeInstanceOf(Float64Array);
  expect(packet.scalarChars).toBeInstanceOf(Uint16Array);
  const snapshot = unpackCollisionWorld(structuredClone(packet));
  const values = snapshot.map.brushes;
  expect(Array.isArray(values)).toBe(true);
  for (let i = 0; i < ids.length; i++) {
    expect(Object.is(values[i].id, ids[i])).toBe(true);
    expectBounds(values[i], brushes[i]);
    expect(values[i]).toBe(values[i]);
    expect(Object.hasOwn(values[i], 'vertices')).toBe(false);
    expect(Object.hasOwn(values[i], 'faces')).toBe(false);
  }
  expect(Object.is(values[0].friction, -0)).toBe(true);
  expect(values[1].kind).toBe('stone');
  expect(values[1].collisionModel).toBe('vphysics');
  expect(Object.getOwnPropertyDescriptor(values[0], 'planes').get).toBeInstanceOf(Function);
  const planes = values[0].planes;
  expect(values[0].planes).toBe(planes);
  expect(Object.hasOwn(planes[0], 'friction')).toBe(true);
  expect(planes[0].friction).toBeUndefined();
  expect(planes[1].friction).toBeNull();
  expect(Object.is(planes[2].friction, -0)).toBe(true);
  expect(Number.isNaN(planes[3].friction)).toBe(true);
  expect(Object.hasOwn(planes[4], 'friction')).toBe(false);
  expect(values[1].leafBounds).toEqual([]);
  expect(values[2].leafBounds).toBeNull();
  expect(Object.hasOwn(values[3], 'leafBounds')).toBe(true);
  expect(values[3].leafBounds).toBeUndefined();
  planes[0].normal.x = 0.125;
  values[0].friction = 0.25;
  expect(values[0].planes[0].normal.x).toBe(0.125);
  expect(values[0].friction).toBe(0.25);
  expect(brushes[0].planes[0].normal.x).toBe(1);
  const replacementPlanes = [{normal: point(0, 0, 1), distance: 4}];
  values[4].planes = replacementPlanes;
  expect(values[4].planes).toBe(replacementPlanes);
  expect(brushes[4].planes.length).toBe(6);
  delete values[1];
  expect(1 in values).toBe(false);
  expect(values[1]).toBeUndefined();
  values.length = 2;
  values.length = ids.length;
  expect(2 in values).toBe(false);
  values[2] = {id: 'replacement'};
  expect(values[2].id).toBe('replacement');
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

test('native displacement import fields are accepted without entering worker collision data', async () => {
  const item = {...triangle([point(0, 0, 0), point(1, 0, 0), point(0, 1, 0)], 7, 8),
    contents: 268435458, tags: 6};
  const {map, world} = fixture([], [item]);
  const snapshot = unpackCollisionWorld(await packCollisionWorld(map, world));
  const result = snapshot.map.displacementTriangles[0];
  expect(result.surfaceId).toBe(7);
  expect(result.triangleId).toBe(8);
  expect(result.vertices).toEqual(item.vertices);
  expect(Object.hasOwn(result, 'contents')).toBe(false);
  expect(Object.hasOwn(result, 'tags')).toBe(false);
});
test('triangle packets preserve coordinates and enforce strict vector shape validation', async () => {
  const vertex = point(-0, 1, 2);
  const {map, world} = fixture([], [triangle([vertex, point(3, 4, 5), point(6, 7, 8)])]);
  const packet = await packCollisionWorld(map, world);
  expect(packet).not.toBeNull();
  expect(Object.is(packet.vertices[0], -0)).toBe(true);
  world.triangles[0].vertices[1] = Object.assign(Object.create({x: 3}), {y: 4, z: 5});
  expect(await packCollisionWorld(map, world)).toBeNull();
});

test('triangle packets reject custom mapping, species and accessors without reading them', async () => {
  for (const pack of [packCollisionWorld, Function(`return (${packCollisionWorld.toString()})`)()])
  for (const variant of ['map', 'subclass', 'map getter', 'constructor', 'constructor getter', 'vertices',
    'inherited vertices', 'index', 'outer index', 'coordinates', 'inherited coordinates', 'surface id', 'triangle id']) {
    let reads = 0;
    const vertices = [point(0, 0, 0), point(1, 0, 0), point(0, 1, 0)];
    let item = triangle(vertices);
    if (variant === 'map') vertices.map = function (callback) {
      reads++;
      return Array.prototype.map.call(this, callback).map(value => value + 17);
    };
    if (variant === 'subclass') Object.setPrototypeOf(vertices, (class extends Array {
      map(callback) { reads++; return Array.from(this, callback).map(value => value + 37); }
    }).prototype);
    if (variant === 'map getter') Object.defineProperty(vertices, 'map', {
      get() { reads++; return Array.prototype.map; },
    });
    if (variant === 'constructor') vertices.constructor = {[Symbol.species]: class extends Array {}};
    if (variant === 'constructor getter') Object.defineProperty(vertices, 'constructor', {
      get() { reads++; return Array; },
    });
    if (variant === 'vertices') Object.defineProperty(item, 'vertices', {
      enumerable: true, get() { reads++; return vertices; },
    });
    if (variant === 'inherited vertices') {
      const prototype = Object.defineProperty({}, 'vertices', {get() { reads++; return vertices; }});
      item = Object.assign(Object.create(prototype), {surfaceId: 'surface', triangleId: 'triangle'});
    }
    if (variant === 'index') Object.defineProperty(vertices, 1, {
      configurable: true, enumerable: true, get() { reads++; return point(1, 0, 0); },
    });
    if (variant === 'coordinates') Object.defineProperty(vertices[0], 'x', {
      enumerable: true, get() { reads++; return 0; },
    });
    if (variant === 'inherited coordinates') {
      const prototype = Object.defineProperty({}, 'x', {get() { reads++; return 0; }});
      vertices[0] = Object.assign(Object.create(prototype), {y: 0, z: 0});
    }
    if (variant === 'surface id') Object.defineProperty(item, 'surfaceId', {
      enumerable: true, get() { reads++; return 'surface'; },
    });
    if (variant === 'triangle id') Object.defineProperty(item, 'triangleId', {
      enumerable: true, get() { reads++; return 'triangle'; },
    });
    const {map, world} = fixture([], [item]);
    if (variant === 'outer index') Object.defineProperty(world.triangles, 0, {
      enumerable: true, configurable: true, get() { reads++; return item; },
    });
    reads = 0;
    expect(await pack(map, world)).toBeNull();
    expect(reads).toBe(0);
  }
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
  map.importMetadata = {entities: [{name: 'not-used-by-replay-physics'}]};
  map.vphysicsFeatureFix = true;
  map.bspCornerFix = false;
  map.conveyors = [{brushIds: ['bsp-0-22'], velocity: point(8, 0, 0)}];
  const originalBrush = world.brushes[0], originalPlane = originalBrush.planes[0];
  const originalTriangle = world.triangles[0], originalRoot = world.tree.root;
  const packet = await packCollisionWorld(map, world);
  expect(packet.map.displacementTriangles).toBeNull();
  expect(packet.map.brushes).toBeNull();
  expect(Object.hasOwn(packet.map, 'importMetadata')).toBe(false);
  const transfer = [...new Set(Object.values(packet).filter(ArrayBuffer.isView).map(view => view.buffer))];
  const received = structuredClone(packet, {transfer});
  for (const buffer of transfer) expect(buffer.byteLength).toBe(0);
  expect(map.futurePhysicsField.liveBuffer.byteLength).toBe(24);
  expect(Object.is(map.futurePhysicsField.liveBuffer[1], -0)).toBe(true);
  expect(world.triangles[0]).toBe(originalTriangle);
  expect(world.tree.root).toBe(originalRoot);
  expect(world.brushes[0]).toBe(originalBrush);
  expect(originalBrush.planes[0]).toBe(originalPlane);
  expect(map.importMetadata.entities[0].name).toBe('not-used-by-replay-physics');
  expect(map.displacementTriangles).toBe(world.triangles);
  const snapshot = unpackCollisionWorld(received);
  expect(snapshot.map.vphysicsFeatureFix).toBe(true);
  expect(snapshot.map.bspCornerFix).toBe(false);
  expect(snapshot.map.conveyors).toEqual(map.conveyors);
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

test('a single large brush yields and cancels while copying its planes', async () => {
  let reads = 0, clock = 0, current = true, yields = 0;
  const brush = box(0, 0, 0, 10, 10, 10);
  brush.planes = Array.from({length: 2048}, () => ({
    normal: point(1, 0, 0),
    get distance() { reads++; return 10; },
  }));
  const {map, world} = fixture([brush]);
  const now = spyOn(performance, 'now').mockImplementation(() => clock += 5);
  try {
    expect(await packCollisionWorld(map, world, {
      isCurrent: () => current,
      yieldTask: async () => { yields++; current = false; },
    })).toBeNull();
    expect(yields).toBe(1);
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(brush.planes.length * 2);
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
    ({world}) => { world.brushes[0].futureCollisionFlag = true; },
    ({world}) => { world.brushes[0].planes = null; },
    ({world}) => { world.brushes[0].planes[0].futureCollisionFlag = true; },
    ({world}) => { world.brushes[0].planes[0].distance = NaN; },
    ({world}) => { world.brushes[0].planes[0].normal.x = Infinity; },
    ({world}) => { world.brushes[0].planes[0].normal.futureComponent = 1; },
    ({world}) => { world.brushes[0].planes[0].friction = {value: 1}; },
    ({world}) => { world.brushes[0].id = {value: 'unsupported'}; },
    ({world}) => { world.brushes[0].min.futureComponent = 1; },
    ({world}) => { world.brushes[0].leafBounds = [box(0, 0, 0, Infinity, 1, 1)]; },
    ({world}) => { world.brushes[0].leafBounds = [{...box(0, 0, 0), collisionFlag: true}]; },
    ({world}) => { world.triangles[0].futureCollisionFlag = true; },
    ({world}) => { world.triangles[0].vertices[0].futureComponent = 1; },
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

test('packing revalidates mutated triangles on every call without reading new accessors', async () => {
  const {map, world} = variedFixture(3);
  const first = await packCollisionWorld(map, world);
  const item = world.triangles[1];
  item.vertices[2].z = -0;
  item.surfaceId = 12345678901234567890n;
  const second = await packCollisionWorld(map, world);
  expect(second).not.toBeNull();
  expect(Object.is(second.vertices[17], -0)).toBe(true);
  expect(second.surfaceIds[1]).toBe(item.surfaceId);
  expect(Object.is(first.vertices[17], -0)).toBe(false);
  for (const vertexIndex of [0, 1, 2]) for (const axis of axes) {
    const vertex = item.vertices[vertexIndex], original = Object.getOwnPropertyDescriptor(vertex, axis);
    let reads = 0;
    Object.defineProperty(vertex, axis, {
      configurable: true, enumerable: true, get() { reads++; return original.value; },
    });
    try {
      expect(await packCollisionWorld(map, world)).toBeNull();
      expect(reads).toBe(0);
    } finally { Object.defineProperty(vertex, axis, original); }
  }
  expect(await packCollisionWorld(map, world)).not.toBeNull();
});

test('packing does not reuse pre-yield validation for later geometry', async () => {
  for (const variant of ['coordinate', 'inherited coordinate', 'map', 'constructor', 'index']) {
    const {map, world} = variedFixture(513);
    const item = world.triangles[512];
    let clock = 0, reads = 0, changed = false;
    const now = spyOn(performance, 'now').mockImplementation(() => clock += 5);
    try {
      const packet = await packCollisionWorld(map, world, {yieldTask: async () => {
        if (changed) return;
        changed = true;
        const getter = {configurable: true, enumerable: true, get() { reads++; return 0; }};
        if (variant === 'coordinate') Object.defineProperty(item.vertices[2], 'z', getter);
        if (variant === 'inherited coordinate') {
          delete item.vertices[1].x;
          Object.setPrototypeOf(item.vertices[1], Object.defineProperty({}, 'x', getter));
        }
        if (variant === 'map') Object.defineProperty(item.vertices, 'map', getter);
        if (variant === 'constructor') Object.defineProperty(item.vertices, 'constructor', getter);
        if (variant === 'index') Object.defineProperty(item.vertices, 2, getter);
      }});
      expect(changed).toBe(true);
      expect(packet).toBeNull();
      expect(reads).toBe(0);
    } finally { now.mockRestore(); }
  }
});

test('triangle coordinate reads remain after native bounds validation', async () => {
  const {map, world} = variedFixture(3);
  const item = world.triangles[0], min = world.triangleBounds[0].min;
  const original = min.x;
  let reads = 0;
  Object.defineProperty(min, 'x', {configurable: true, enumerable: true, get() {
    reads++;
    item.vertices[0].x = -123.25;
    return original;
  }});
  const packet = await packCollisionWorld(map, world);
  expect(packet).not.toBeNull();
  expect(reads).toBe(1);
  expect(packet.vertices[0]).toBe(-123.25);
});

test('unpacking rejects malformed or detached packets', async () => {
  const {map, world} = variedFixture(9);
  world.brushes[0].id = 'sample-id';
  world.brushes[0].leafBounds = [box(-1, -1, -1, 1, 1, 1)];
  const original = await packCollisionWorld(map, world);
  for (const change of [
    packet => { packet.version = 99; },
    packet => { packet.version = 1; },
    packet => { packet.map.brushes = []; },
    packet => { packet.brushData = packet.brushData.slice(1); },
    packet => { packet.brushData[0] = 1; },
    packet => { packet.brushData[7] = packet.planeFriction.length + 1; },
    packet => { packet.brushData[8] = 2; },
    packet => { packet.brushData[2] = 0x3fffffff; },
    packet => { packet.brushData[2] = 0x80000000; },
    packet => { packet.brushData[6] = 4; },
    packet => { packet.brushData[packet.brushData.length - 1] = 1; },
    packet => { packet.planeValues = new Float32Array(packet.planeValues); },
    packet => { packet.planeValues[0] = NaN; },
    packet => { packet.planeFriction[0] = 0xffffffff; },
    packet => { packet.leafBounds[0] = Infinity; },
    packet => { packet.scalarOffsets[0] = 1; },
    packet => { packet.scalarOffsets[packet.scalarOffsets.length - 1]--; },
    packet => { packet.scalarChars = new Uint8Array(packet.scalarChars); },
    packet => { structuredClone(packet.scalarChars, {transfer: [packet.scalarChars.buffer]}); },
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

// Native displacement SAT expansion, independent of the scalar implementation.
function nativeTriangleBrush(triangle, bounds) {
  const vector = (x = 0, y = 0, z = 0) => ({x, y, z});
  const sub = (a, b) => vector(a.x - b.x, a.y - b.y, a.z - b.z);
  const scale = (a, n) => vector(a.x * n, a.y * n, a.z * n);
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const cross = (a, b) => vector(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  const size = a => Math.hypot(a.x, a.y, a.z);
  const normalize = a => size(a) > 1e-12 ? scale(a, 1 / size(a)) : vector();
  const vertices = triangle.vertices, axes = [vector(1, 0, 0), vector(0, 1, 0), vector(0, 0, 1)];
  const candidates = [normalize(cross(sub(vertices[1], vertices[0]), sub(vertices[2], vertices[0]))), ...axes];
  for (let i = 0; i < 3; i++) for (const axis of axes) candidates.push(cross(sub(vertices[(i + 1) % 3], vertices[i]), axis));
  const planes = [];
  for (const candidate of candidates) if (!(size(candidate) < 1e-8)) for (const sign of [1, -1]) {
    const normal = scale(normalize(candidate), sign);
    if (!planes.some(plane => dot(plane.normal, normal) > 1 - 1e-9))
      planes.push({normal, distance: Math.max(...vertices.map(vertex => dot(normal, vertex)))});
  }
  return {id: `disp-${triangle.surfaceId}-${triangle.triangleId}`, vertices, faces: [[0, 1, 2]],
    planes, ...bounds, color: '#d4dadd', friction: 1, kind: 'snow'};
}

test('fresh displacement SAT planes match native order, exact numbers and contacts', () => {
  let seed = 0x12345678;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 * 65536 - 32768; };
  const examples = [
    [point(0, 0, 0), point(16, 0, 0), point(0, 16, 0)],
    [point(-0, 0, -0), point(0, -0, 0), point(-0, -0, 0)],
    [point(1, 1, 1), point(1, 1, 1), point(1, 1, 1)],
    [point(0, 0, 0), point(1e-13, 0, 0), point(0, 1e-13, 0)],
    [point(0, 0, 0), point(100, 100, 100), point(200, 200, 200)],
    ...Array.from({length: 128}, () => Array.from({length: 3}, () => point(random(), random(), random()))),
  ];
  const implementations = [triangleCollisionBrush, Function(`return (${triangleCollisionBrush.toString()})`)()];
  for (const vertices of examples) {
    const item = triangle(vertices, 'surface', 17);
    const bounds = {min: point(...axes.map(axis => Math.min(...vertices.map(vertex => vertex[axis])))),
      max: point(...axes.map(axis => Math.max(...vertices.map(vertex => vertex[axis]))))};
    const expected = nativeTriangleBrush(item, bounds);
    for (const compile of implementations) {
      const actual = compile(item, bounds), again = compile(item, bounds);
      expect(actual).toEqual(expected);
      expect(actual).not.toBe(again); expect(actual.planes).not.toBe(again.planes);
      for (let i = 0; i < expected.planes.length; i++) {
        expect(Object.is(actual.planes[i].distance, expected.planes[i].distance)).toBe(true);
        for (const axis of axes) expect(Object.is(actual.planes[i].normal[axis], expected.planes[i].normal[axis])).toBe(true);
      }
      for (const feature of [false, true]) for (const corner of [false, true]) {
        const tree = {query: () => [0]}, hull = box(-16, -16, 0, 16, 16, 62);
        expect(nativeTrace(tree, [actual], point(-100, -100, 100), point(100, 100, -100), hull, feature, corner))
          .toEqual(nativeTrace(tree, [expected], point(-100, -100, 100), point(100, 100, -100), hull, feature, corner));
      }
    }
  }
});

test('displacement SAT preserves native nonfinite intermediates and signed zero for finite vertices', () => {
  const examples = [
    [point(0, 0, 0), point(1e160, 0, 0), point(0, 1e149, 0)],
    [point(0, 0, 0), point(1e160, 0, 0), point(0, -1e149, 0)],
    [point(-1e308, -0, 0), point(1e308, 0, 0), point(0, 1, 0)],
    [point(-1e308, -1e308, 0), point(1e308, 1e308, -0), point(0, 0, 1)],
    [point(0, 0, 0), point(1e-160, 0, 0), point(0, 1e-160, 0)],
    [point(0, 0, 0), point(1e-8, 0, 0), point(0, 1e-4, 0)],
    [point(0, 0, 0), point(1e-8 + 1e-23, 0, 0), point(0, 1e-4, 0)],
  ];
  const values = [-Number.MAX_VALUE, -1e160, -1e149, -1e-8, -Number.MIN_VALUE, -0, 0,
    Number.MIN_VALUE, 1e-8, 1e149, 1e160, Number.MAX_VALUE];
  let seed = 0x32a4e6f8;
  const coordinate = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return values[seed % values.length];
  };
  for (let i = 0; i < 128; i++) {
    examples.push(Array.from({length: 3}, () => point(coordinate(), coordinate(), coordinate())));
  }
  const implementations = [triangleCollisionBrush, Function(`return (${triangleCollisionBrush.toString()})`)()];
  for (const vertices of examples) {
    const item = triangle(vertices), bounds = {
      min: point(...axes.map(axis => Math.min(...vertices.map(vertex => vertex[axis])))),
      max: point(...axes.map(axis => Math.max(...vertices.map(vertex => vertex[axis])))),
    };
    const expected = nativeTriangleBrush(item, bounds);
    for (const compile of implementations) {
      const actual = compile(item, bounds);
      expect(actual.planes.length).toBe(expected.planes.length);
      for (let i = 0; i < expected.planes.length; i++) {
        expect(Object.is(actual.planes[i].distance, expected.planes[i].distance)).toBe(true);
        for (const axis of axes) expect(Object.is(actual.planes[i].normal[axis], expected.planes[i].normal[axis])).toBe(true);
      }
      expect(actual).toEqual(expected);
    }
  }
  const item = triangle(examples[0]), expected = nativeTriangleBrush(item, box(0, 0, 0, 1e160, 1e149, 0));
  expect(expected.planes.filter(({normal}) => axes.every(axis => normal[axis] === 0))).toHaveLength(2);
  expect(expected.planes).toHaveLength(8);
  const actual = triangleCollisionBrush(item, box(0, 0, 0, 1e160, 1e149, 0));
  const isCornerBox = brush => brush.planes.length === 6 && brush.planes.every(plane =>
    axes.filter(axis => plane.normal[axis] !== 0).length === 1 && axes.some(axis => Math.abs(plane.normal[axis]) === 1));
  expect(isCornerBox(expected)).toBe(false);
  expect(isCornerBox(actual)).toBe(false);
});

test('the scalar SAT helper explicitly rejects nontriangles instead of ignoring extra vertices', async () => {
  const item = triangle([point(0, 0, 0), point(1, 0, 0), point(0, 1, 0), point(0, 0, 100)]);
  const bounds = box(0, 0, 0, 1, 1, 100), native = nativeTriangleBrush(item, bounds);
  expect(native.planes.find(({normal}) => normal.z === 1).distance).toBe(100);
  for (const compile of [triangleCollisionBrush, Function(`return (${triangleCollisionBrush.toString()})`)()]) {
    expect(() => compile(item, bounds)).toThrow(RangeError);
    expect(() => compile(triangle(item.vertices.slice(0, 2)), bounds)).toThrow(RangeError);
    const sparse = triangle([point(0, 0, 0), , point(0, 1, 0)]);
    expect(() => nativeTriangleBrush(sparse, bounds)).toThrow(TypeError);
    expect(() => compile(sparse, bounds)).toThrow(TypeError);
  }
  const {map, world} = fixture([], [item]);
  expect(await packCollisionWorld(map, world)).toBeNull();
});

test('packed camera worlds preserve native brush visibility and trace results', async () => {
  class NativeWorld {
    constructor(brushes, triangles, feature = false, corner = false) {
      this.brushes = brushes; this.triangles = triangles;
      this.vphysicsFeatureFix = feature; this.bspCornerFix = corner;
      this.tree = nativeTree(brushes); this.triangleBounds = []; this.triangleCache = new Map();
    }
    triangleBrush() { throw new Error('No triangles in this fixture'); }
    trace(start, end, hull) {
      return nativeTrace(this.tree, this.brushes, start, end, hull, this.vphysicsFeatureFix, this.bspCornerFix);
    }
  }
  const cases = [
    [{}, true], [{contents: undefined}, true], [{contents: null}, true],
    [{contents: 0}, false], [{contents: -0}, false], [{contents: 1}, true],
    [{contents: 9}, false], [{contents: 0x10000001}, false],
    [{contents: 2}, false], [{contents: 0x40000001}, true],
    [{contents: '9'}, false], [{contents: true}, true], [{contents: NaN}, false],
    [{contents: 0x100000001}, true], [{contents: Infinity}, false],
  ];
  const brushes = cases.map(([flags], i) => {
    const brush = {...box(0, i * 10, 0, 2, i * 10 + 4, 4), id: `brush-${i}`, ...flags};
    brush.planes = boxPlanes(brush);
    return brush;
  });
  const original = structuredClone(brushes);
  const map = {id: 'camera', version: '1', brushes, displacementTriangles: []};
  const world = new NativeWorld(brushes, map.displacementTriangles, true, true);
  const packet = await packCollisionWorld(map, world);
  expect(packet).not.toBeNull();
  const transfer = [...new Set(Object.values(packet).filter(ArrayBuffer.isView).map(view => view.buffer))];
  const snapshot = unpackCollisionWorld(structuredClone(packet, {transfer}));
  expect(snapshot).not.toBeNull();
  expect(brushes).toEqual(original);
  expect(map.brushes).toBe(brushes);
  expect(world.brushes).toBe(brushes);
  const packedWorld = Object.assign(Object.create(NativeWorld.prototype), {
    brushes: snapshot.map.brushes, triangles: snapshot.map.displacementTriangles,
    tree: snapshot.tree, triangleBounds: snapshot.triangleBounds, triangleCache: new Map(),
    vphysicsFeatureFix: world.vphysicsFeatureFix, bspCornerFix: world.bspCornerFix,
  });
  const nativeCamera = cameraWorld({map, movement: {world}});
  const packedCamera = cameraWorld({map: snapshot.map, movement: {world: packedWorld}});
  const hull = box(-0.5, -0.5, -0.5, 0.5, 0.5, 0.5);
  for (let i = 0; i < cases.length; i++) {
    const source = brushes[i], restored = snapshot.map.brushes[i];
    expect(Object.hasOwn(restored, 'contents')).toBe(Object.hasOwn(source, 'contents'));
    expect(Object.is(restored.contents, source.contents)).toBe(true);
    const start = point(-5, i * 10 + 2, 2), end = point(5, i * 10 + 2, 2);
    const expected = nativeCamera.trace(start, end, hull), actual = packedCamera.trace(start, end, hull);
    expect(expected.brush?.id ?? null).toBe(cases[i][1] ? source.id : null);
    expect(actual).toEqual(expected);
    expect(packedCamera.tree.query(box(-5, i * 10 + 2, 2, 5, i * 10 + 2, 2)))
      .toEqual(nativeCamera.tree.query(box(-5, i * 10 + 2, 2, 5, i * 10 + 2, 2)));
  }
});

test('contents packet validation rejects unsupported values and malformed typed columns', async () => {
  const {map, world} = fixture([{...box(0, 0, 0, 1, 1, 1), contents: 1}]);
  const packet = await packCollisionWorld(map, world);
  expect(packet.brushContents).toBeInstanceOf(Uint32Array);
  for (const change of [
    value => { value.version = 2; },
    value => { delete value.brushContents; },
    value => { value.brushContents = new Uint16Array(value.brushContents); },
    value => { value.brushContents = new Uint32Array(0); },
    value => { value.brushContents[0] = 0x3fffffff; },
    value => { value.brushContents[0] = 0x80000000; },
    value => { structuredClone(value.brushContents, {transfer: [value.brushContents.buffer]}); },
  ]) {
    const changed = structuredClone(packet);
    change(changed);
    expect(unpackCollisionWorld(changed)).toBeNull();
  }
  for (const value of [{valueOf: () => 1}, Symbol('solid')]) {
    world.brushes[0].contents = value;
    expect(await packCollisionWorld(map, world)).toBeNull();
    expect(world.brushes[0].contents).toBe(value);
  }
  for (const value of [-42n, 0n, 12345678901234567890n]) {
    world.brushes[0].contents = value;
    const restored = unpackCollisionWorld(await packCollisionWorld(map, world));
    expect(restored.map.brushes[0].contents).toBe(value);
  }
  const prototype = Object.defineProperty({}, 'contents', {value: 0});
  const inherited = Object.assign(Object.create(prototype), box(0, 0, 0, 1, 1, 1));
  const example = fixture([inherited]);
  expect(await packCollisionWorld(example.map, example.world)).toBeNull();
  expect(inherited.contents).toBe(0);
  let reads = 0;
  Object.defineProperty(world.brushes[0], 'contents', {
    configurable: true, enumerable: true, get() { return ++reads & 1; },
  });
  expect(await packCollisionWorld(map, world)).toBeNull();
  expect(reads).toBe(0);
});
