import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRampSurfaces } from '../src/surfaces.js';

const groundNormal = 0.7;
const vector = (x = 0, y = 0, z = 0) => ({ x, y, z });
const rampNormal = Object.freeze(vector(0, 0.8, 0.6));
const point = (x, y) => vector(x, y, -4 * y / 3);

function brush(id, polygons) {
  const vertices = [];
  const faces = [];
  const planes = [];
  for (const { points, normal = rampNormal } of polygons) {
    const offset = vertices.length;
    vertices.push(...points);
    faces.push(points.map((_, i) => offset + i));
    planes.push({ normal: { ...normal },
      distance: normal.x * points[0].x + normal.y * points[0].y + normal.z * points[0].z });
  }
  return { id, vertices, faces, planes };
}

function ramp(id, x0 = 0, x1 = 10, y0 = 0, y1 = 10) {
  return brush(id, [{ points: [point(x0, y0), point(x1, y0), point(x1, y1), point(x0, y1)] }]);
}

function facet(id, y0, y1, z0, slope) {
  const length = Math.hypot(slope, 1);
  const normal = vector(0, -slope / length, 1 / length);
  return brush(id, [{ normal, points: [vector(0, y0, z0), vector(10, y0, z0),
    vector(10, y1, z0 + slope * (y1 - y0)), vector(0, y1, z0 + slope * (y1 - y0))] }]);
}

function translate(value, x, y, z) {
  for (const vertex of value.vertices) {
    vertex.x += x;
    vertex.y += y;
    vertex.z += z;
  }
  for (const plane of value.planes) plane.distance += plane.normal.x * x + plane.normal.y * y + plane.normal.z * z;
  return value;
}

function component(index, value, normal = value.planes[0].normal) {
  const id = index.find(value.id, normal);
  assert.notEqual(id, null, `missing surface for ${value.id}`);
  return id;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('maps without collision brushes and invalid ground thresholds have no index', () => {
  for (const map of [null, undefined, {}, { brushes: null }, { brushes: [] }]) {
    assert.equal(getRampSurfaces(map, groundNormal), null);
  }
  const map = { brushes: [ramp('a')] };
  for (const threshold of [undefined, NaN, Infinity, 0, -0.7, 1.01]) {
    assert.equal(getRampSurfaces(map, threshold), null);
  }
});

test('indexes are immutable, cached by map identity and ground threshold, and do not mutate geometry', () => {
  const a = ramp('a');
  let reads = 0;
  const vertices = a.vertices;
  Object.defineProperty(a, 'vertices', { enumerable: true, get() { reads++; return vertices; } });
  const map = freeze({ brushes: [a] });
  const before = JSON.stringify(map);
  const index = getRampSurfaces(map, groundNormal);
  const builtReads = reads;
  assert.equal(Object.isFrozen(index), true);
  for (let i = 0; i < 20; i++) {
    assert.equal(getRampSurfaces(map, groundNormal), index);
    assert.equal(index.find('a', rampNormal), 0);
  }
  assert.equal(reads, builtReads, 'cached lookups must not read brush vertices');
  assert.equal(JSON.stringify(map), before);
  assert.notEqual(getRampSurfaces(map, 0.8), index);
  const copy = JSON.parse(before);
  const copiedIndex = getRampSurfaces(copy, groundNormal);
  assert.notEqual(copiedIndex, index);
  assert.equal(copiedIndex.find('a', rampNormal), index.find('a', rampNormal));
});

test('only upward faces strictly below the configured ground normal are indexed', () => {
  const normals = [rampNormal, vector(0, -0.8, -0.6), vector(0, 1, 0), vector(0, 0, 1)];
  const brushes = normals.map((normal, i) => brush(i, [{ normal, points: [vector(), vector(10),
    vector(10, 10 * normal.z, -10 * normal.y), vector(0, 10 * normal.z, -10 * normal.y)] }]));
  const index = getRampSurfaces({ brushes }, groundNormal);
  assert.notEqual(index.find(0, normals[0]), null);
  for (let i = 1; i < normals.length; i++) assert.equal(index.find(i, normals[i]), null);
  assert.equal(getRampSurfaces({ brushes }, 0.6).find(0, rampNormal), null);
});

test('lookup matches the outward normal, accepts scaling and rejects unknown or malformed contacts', () => {
  const index = getRampSurfaces({ brushes: [ramp('a')] }, groundNormal);
  const id = index.find('a', rampNormal);
  assert.notEqual(id, null);
  assert.equal(index.find('a', vector(0, 8, 6)), id);
  assert.equal(index.find('a', vector(0.00005, 0.8, 0.6)), id);
  for (const normal of [null, {}, vector(), vector(NaN), vector(Infinity),
    vector(0, -0.8, -0.6), vector(0, -0.8, 0.6), vector(0.001, 0.8, 0.6), vector(0, 0, 1)]) {
    assert.equal(index.find('a', normal), null);
  }
  assert.equal(index.find('missing', rampNormal), null);
});

test('plane matching does not depend on plane index, winding or unit-length native normals', () => {
  const a = ramp('a');
  a.faces[0].reverse();
  a.planes = [{ normal: vector(0, 0, 1), distance: 500 },
    { normal: vector(0, -1, 0), distance: 500 },
    { normal: vector(0, 8, 6), distance: 0 }];
  const index = getRampSurfaces({ brushes: [a] }, groundNormal);
  assert.notEqual(index.find('a', rampNormal), null);
  assert.equal(index.find('a', vector(0, -0.8, 0.6)), null);
});

test('coplanar BSP faces sharing an edge form one stable component', () => {
  const a = ramp('a');
  const b = ramp('b', 10, 20);
  const unrelated = ramp('unrelated', 100, 110);
  const map = { brushes: [a, b, unrelated] };
  const index = getRampSurfaces(map, groundNormal);
  assert.equal(component(index, a), component(index, b));
  assert.notEqual(component(index, a), component(index, unrelated));
  const copy = JSON.parse(JSON.stringify(map));
  const copiedIndex = getRampSurfaces(copy, groundNormal);
  for (const value of map.brushes) assert.equal(component(copiedIndex, value), component(index, value));
});

test('curved facets connect transitively across shared edges despite different normals', () => {
  const a = facet('a', 0, 10, 0, -4 / 3);
  const b = facet('b', 10, 20, -40 / 3, -2);
  const c = facet('c', 20, 30, -40 / 3 - 20, -3);
  const index = getRampSurfaces({ brushes: [a, b, c] }, groundNormal);
  assert.equal(component(index, a), component(index, b));
  assert.equal(component(index, b), component(index, c));
  assert.equal(index.find('b', a.planes[0].normal), null);
});

test('T junctions and partial edge overlaps connect without identical endpoints', () => {
  const a = ramp('long');
  const b = ramp('short', 10, 20, 2, 5);
  const c = ramp('other-short', 10, 20, 6, 9);
  const index = getRampSurfaces({ brushes: [a, b, c] }, groundNormal);
  assert.equal(component(index, a), component(index, b));
  assert.equal(component(index, a), component(index, c));
});

test('a small positive seam overlap connects, but point-only contact and longitudinal gaps do not', () => {
  for (const [start, connected] of [[10 - 0.0001, true], [10, false], [10.02, false]]) {
    const a = ramp('a');
    const b = ramp('b', 10, 20, start, 20);
    const index = getRampSurfaces({ brushes: [a, b] }, groundNormal);
    assert.equal(component(index, a) === component(index, b), connected, `edge starts at ${start}`);
  }
});

test('transverse seam tolerance is conservative and uses distance rather than expanded AABBs', () => {
  for (const [offset, connected] of [[0.049, true], [0.051, false]]) {
    const a = ramp('a');
    const b = translate(ramp('b', 10, 20), offset, 0, 0);
    const index = getRampSurfaces({ brushes: [a, b] }, groundNormal);
    assert.equal(component(index, a) === component(index, b), connected, `seam offset ${offset}`);
  }
  const a = ramp('a');
  // Both coordinates are inside the broad-phase tolerance, but the combined
  // perpendicular displacement is sqrt(.04^2 + .04^2), greater than .05.
  const b = translate(ramp('b', 10, 20), 0.04, 0.032, 0.024);
  const index = getRampSurfaces({ brushes: [a, b] }, groundNormal);
  assert.notEqual(component(index, a), component(index, b));
});

test('positive-area coplanar overlaps connect, but overlapping bounds alone do not', () => {
  const outer = ramp('outer', 0, 20, 0, 20);
  const inner = ramp('inner', 5, 15, 5, 15);
  let index = getRampSurfaces({ brushes: [outer, inner] }, groundNormal);
  assert.equal(component(index, outer), component(index, inner));
  const a = brush('a', [{ points: [point(0, 0), point(10, 0), point(0, 10)] }]);
  const b = brush('b', [{ points: [point(2, -2), point(12, 8), point(12, -2)] }]);
  const separate = brush('separate', [{ points: [point(8, 8), point(18, 8), point(8, 18)] }]);
  index = getRampSurfaces({ brushes: [a, b] }, groundNormal);
  assert.equal(component(index, a), component(index, b));
  index = getRampSurfaces({ brushes: [a, separate] }, groundNormal);
  assert.notEqual(component(index, a), component(index, separate));
});

test('unordered, repeated and collinear face vertices recover connected convex faces', () => {
  // This bow-tie ordering has a zero signed triangle-fan area. It is still a
  // valid convex imported face once its actual boundary is recovered.
  const a = brush('shuffled', [{ points: [point(0, 0), point(10, 10), point(0, 10), point(10, 0),
    point(10, 5), point(10, 10), point(5, 5)] }]);
  const b = ramp('neighbor', 10, 20);
  const index = getRampSurfaces({ brushes: [a, b] }, groundNormal);
  assert.equal(component(index, a), component(index, b));
  const bowTie = brush('bow-tie', [{ points: [point(0, 0), point(10, 10), point(0, 10), point(10, 0)] }]);
  assert.notEqual(getRampSurfaces({ brushes: [bowTie] }, groundNormal).find('bow-tie', rampNormal), null);
});

test('disconnected same-normal faces sharing a brush ID are ambiguous rather than guessed', () => {
  const a = ramp('shared');
  const b = ramp('shared', 100, 110);
  let index = getRampSurfaces({ brushes: [a, b] }, groundNormal);
  assert.equal(index.find('shared', rampNormal), null);
  const neighbor = ramp('shared', 10, 20);
  index = getRampSurfaces({ brushes: [a, neighbor] }, groundNormal);
  assert.notEqual(index.find('shared', rampNormal), null);
});

test('distinct normals disambiguate disconnected faces within one brush', () => {
  const a = facet('unused', 0, 10, 0, -4 / 3);
  const b = facet('unused', 100, 110, 0, -2);
  const combined = brush('combined', [
    { points: a.vertices, normal: a.planes[0].normal },
    { points: b.vertices, normal: b.planes[0].normal },
  ]);
  const index = getRampSurfaces({ brushes: [combined] }, groundNormal);
  const first = index.find('combined', a.planes[0].normal);
  const second = index.find('combined', b.planes[0].normal);
  assert.notEqual(first, null);
  assert.notEqual(second, null);
  assert.notEqual(first, second);
});

test('malformed or degenerate faces are ignored without hiding valid surfaces', () => {
  const badIndex = ramp('bad-index');
  badIndex.faces[0][2] = 999;
  const nonfinite = ramp('nonfinite');
  nonfinite.vertices[0].x = NaN;
  const noPlane = ramp('no-plane');
  noPlane.planes = [{ normal: vector(), distance: 0 }, { normal: vector(0, 0.8, 0.6), distance: NaN }];
  const offPlane = ramp('off-plane');
  offPlane.planes[0].distance = 1;
  const collinear = brush('collinear', [{ points: [point(0, 0), point(5, 5), point(10, 10)] }]);
  const duplicate = brush('duplicate', [{ points: [point(0, 0), point(0, 0), point(0, 0)] }]);
  const valid = ramp('valid');
  const invalid = [badIndex, nonfinite, noPlane, offPlane, collinear, duplicate];
  const index = getRampSurfaces({ brushes: [null, {}, ...invalid, valid] }, groundNormal);
  for (const value of invalid) assert.equal(index.find(value.id, rampNormal), null);
  assert.notEqual(index.find('valid', rampNormal), null);
});

test('noncoplanar interior intersection segments connect without connecting isolated points', () => {
  const a = ramp('a');
  const normal = vector(0, 2 / Math.sqrt(5), 1 / Math.sqrt(5));
  const crossing = brush('crossing', [{ normal, points: [vector(2, 2, -2 / 3), vector(8, 2, -2 / 3),
    vector(8, 8, -38 / 3), vector(2, 8, -38 / 3)] }]);
  // The faces meet along y=5, z=-20/3, strictly inside both polygons.
  let index = getRampSurfaces({ brushes: [a, crossing] }, groundNormal);
  assert.equal(component(index, a), component(index, crossing));
  const pointOnly = brush('point-only', [{ normal, points: [vector(10, 5, -20 / 3),
    vector(15, 2, -2 / 3), vector(15, 8, -38 / 3)] }]);
  index = getRampSurfaces({ brushes: [a, pointOnly] }, groundNormal);
  assert.notEqual(component(index, a), component(index, pointOnly));
});

test('real Andromeda rotated BSP facets connect across their overlapping interior seam', () => {
  // Native collision planes and render-face vertices from bsp-0-164/165.
  // The rotated brush overlaps the straight face by ~36 units at its bottom;
  // their boundary edges do not coincide. Bevel vertices drift up to .006u
  // off the native face plane, so the collision plane remains authoritative.
  const a = brush('bsp-0-164', [{ normal: vector(0, -0.7327935099601746, 0.6804510951042175), points: [
    vector(-1120, -16.000201720562522, 5600), vector(-1120, -432, 5152),
    vector(544, -432, 5152), vector(544, -16.000201720562522, 5600),
  ] }]);
  a.planes[0].distance = 3822.2509765625;
  const b = brush('bsp-0-165', [{ normal: vector(-0.06385456770658493, -0.7300039529800415, 0.6804533004760742), points: [
    vector(735.2703247070312, -32.74994357668154, 5599.979406739518),
    vector(735.2703247070312, -32.7384801090674, 5599.991704977525),
    vector(735.2703247070312, -32.738186341826776, 5600),
    vector(735.2703247070312, -32.73442873420827, 5599.996051373759),
    vector(735.2703247070312, -32.73442873420828, 5600.004062099161),
    vector(735.2703247070312, -32.73074812981245, 5600),
    vector(735.2299242271234, -32.73089405670823, 5600),
    vector(735.1836391446836, -32.73089405670823, 5599.999999999999),
    vector(545.949884349309, -16.170598246085486, 5600),
    vector(545.5584351622883, -16.136357584080496, 5600.000000000001),
    vector(545.2014043409164, -16.10511299811471, 5600),
    vector(544.0006338754523, -15.992611920076682, 5600),
    vector(543.9999874352015, -16, 5600),
    vector(543.9999874352015, -16, 5599.992013288982),
    vector(507.736328125, -430.4189968548455, 5152),
    vector(507.739746047966, -430.4134915525307, 5152),
    vector(507.73938580415256, -430.4176087313139, 5151.9955492201625),
    vector(698.9783242809816, -447.15625, 5151.990321207787),
    vector(698.9791083686823, -447.14729676283196, 5152),
    vector(698.9999408756626, -447.15625, 5151.992349735399),
    vector(698.9999408571522, -447.15625, 5152),
    vector(699.0005602169525, -447.14917318896966, 5152),
    vector(699.0007019860133, -447.14755306745445, 5152.009652950644),
    vector(731.1269395065166, -80.06188365963992, 5548.833387680249),
    vector(732.6972216407434, -62.13135335136367, 5568.216977569296),
  ] }]);
  b.planes[0].distance = 3787.481689453125;
  const index = getRampSurfaces(freeze({ brushes: [a, b] }), groundNormal);
  assert.equal(component(index, a), component(index, b));
});
