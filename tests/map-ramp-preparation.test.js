import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRampSurfaces } from '../src/surfaces.js';
import { packRampPreparation, buildPackedRampPreparation, installPreparedRampSurfaces,
  hasRampSurfaces, cancelRampPreparation } from '../src/map-ramp-preparation.js';

const vector = (x = 0, y = 0, z = 0) => ({ x, y, z });
const normal = vector(0, 0.8, 0.6);
const point = (x, y) => vector(x, y, -4 * y / 3);

function brush(id, polygons) {
  const vertices = [], faces = [], planes = [];
  for (const polygon of polygons) {
    const n = polygon.normal ?? normal;
    const offset = vertices.length;
    vertices.push(...polygon.points);
    faces.push(polygon.points.map((_, i) => offset + i));
    const p = polygon.points[0];
    planes.push({ normal: { ...n }, distance: n.x * p.x + n.y * p.y + n.z * p.z });
  }
  return { id, vertices, faces, planes };
}

function ramp(id, x0 = 0, x1 = 10, y0 = 0, y1 = 10) {
  return brush(id, [{ points: [point(x0, y0), point(x1, y0), point(x1, y1), point(x0, y1)] }]);
}

function facet(id, y0, y1, z0, slope) {
  const length = Math.hypot(slope, 1);
  return brush(id, [{ normal: vector(0, -slope / length, 1 / length), points: [
    vector(0, y0, z0), vector(10, y0, z0), vector(10, y1, z0 + slope * (y1 - y0)),
    vector(0, y1, z0 + slope * (y1 - y0)),
  ] }]);
}

function transferInput(packet) {
  const keys = ['brushOrdinals', 'brushPlaneOffsets', 'brushVertexOffsets', 'brushFaceOffsets',
    'faceOffsets', 'faceIndices', 'planes', 'vertices'];
  return structuredClone(packet, { transfer: keys.map(key => packet[key].buffer) });
}

function transferOutput(packet) {
  return structuredClone(packet, { transfer: [packet.brushOrdinals.buffer, packet.components.buffer, packet.normals.buffer] });
}

function prepareAndCompare(brushes, groundNormal, extraNormals = []) {
  const map = { brushes };
  const packet = packRampPreparation(map, groundNormal);
  assert.ok(packet);
  const workerResult = buildPackedRampPreparation(transferInput(packet));
  assert.ok(workerResult);
  const result = transferOutput(workerResult);
  const native = getRampSurfaces({ brushes }, groundNormal);
  assert.equal(hasRampSurfaces(map, groundNormal), false);
  assert.equal(installPreparedRampSurfaces(map, groundNormal, result), true);
  assert.equal(hasRampSurfaces(map, groundNormal), true);
  const prepared = getRampSurfaces(map, groundNormal);
  const ids = new Set(brushes.filter(value => value &&
    (typeof value.id === 'string' || typeof value.id === 'number')).map(value => value.id));
  ids.add('missing');
  const normals = [null, {}, vector(), vector(NaN, 0, 1), vector(Infinity, 0, 1),
    vector(0, 0, 1), vector(0, -0.8, -0.6), ...extraNormals];
  for (const value of brushes) for (const plane of value?.planes ?? []) {
    if (plane?.normal && Number.isFinite(plane.normal.x) && Number.isFinite(plane.normal.y) && Number.isFinite(plane.normal.z)) {
      const n = plane.normal;
      normals.push(n, vector(n.x * 10, n.y * 10, n.z * 10), vector(n.x + 0.00005, n.y, n.z),
        vector(n.x + 0.0003, n.y, n.z));
    }
  }
  for (const id of ids) for (const n of normals) {
    assert.equal(prepared.find(id, n), native.find(id, n), `brush ${String(id)} normal ${JSON.stringify(n)} threshold ${groundNormal}`);
  }
  return { map, native, prepared };
}

test('worker geometry preserves connected, isolated, ambiguous and degenerate face components', () => {
  const a = ramp('a');
  const b = ramp('b', 10, 20);
  const separate = ramp('separate', 100, 110);
  const ignored = brush('ground', [{ normal: vector(0, 0, 1), points: [vector(), vector(10, 0, 0), vector(0, 10, 0)] }]);
  const collinear = brush('line', [{ points: [point(0, 0), point(5, 5), point(10, 10)] }]);
  const shuffled = brush('shuffled', [{ points: [point(20, 0), point(30, 10), point(20, 10), point(30, 0),
    point(25, 5), point(30, 10)] }]);
  const first = facet('first', 500, 510, 0, -4 / 3);
  const second = facet('second', 600, 610, 0, -2);
  const compound = brush('compound', [
    { points: first.vertices, normal: first.planes[0].normal },
    { points: second.vertices, normal: second.planes[0].normal },
  ]);
  const sharedA = ramp('shared', 200, 210), sharedB = ramp('shared', 300, 310);
  const competing = ramp('competing', 400, 410);
  competing.planes.unshift({ normal: vector(0.001, 0.8, 0.6), distance: 0.4 });
  const linkedA = ramp('linked', 500, 510), linkedB = ramp('linked', 520, 530);
  const bridge = ramp('bridge', 510, 520);
  const { native, prepared } = prepareAndCompare([a, null, ignored, b, separate, collinear, shuffled,
    sharedA, sharedB, compound, competing, linkedA, linkedB, bridge], 0.7);
  assert.equal(prepared.find('a', normal), 0);
  assert.equal(prepared.find('a', normal), prepared.find('b', normal));
  assert.equal(prepared.find('b', normal), prepared.find('shuffled', normal));
  assert.notEqual(prepared.find('a', normal), prepared.find('separate', normal));
  assert.equal(prepared.find('line', normal), null);
  assert.equal(prepared.find('shared', normal), null);
  assert.notEqual(prepared.find('linked', normal), null);
  assert.equal(prepared.find('linked', normal), prepared.find('bridge', normal));
  assert.notEqual(prepared.find('competing', normal), null);
  assert.equal(prepared.find('competing', competing.planes[0].normal), null);
  assert.notEqual(prepared.find('compound', first.planes[0].normal), prepared.find('compound', second.planes[0].normal));
  assert.equal(prepared.find('compound', first.planes[0].normal), native.find('compound', first.planes[0].normal));
});

test('selective packing respects the configured strict normal threshold and finite precision', () => {
  const scaled = ramp('scaled');
  scaled.planes.unshift({ normal: vector(0, 0, 1), distance: 0 });
  scaled.planes.push({ normal: vector(-0, 8, 6), distance: -0 });
  scaled.planes.splice(1, 1);
  scaled.vertices[0].x = -0;
  const brushWithNaNId = ramp(NaN, 30, 40);
  const brushWithZeroId = ramp(-0, 50, 60);
  const flat = brush('flat', [{ normal: vector(0, 0, 1), points: [vector(), vector(10, 0, 0), vector(0, 10, 0)] }]);
  const vertical = brush('vertical', [{ normal: vector(0, 1, 0), points: [vector(), vector(10, 0, 0), vector(0, 0, 10)] }]);
  const brushes = [scaled, flat, vertical, brushWithNaNId, brushWithZeroId];
  for (const threshold of [Number.MIN_VALUE, 0.6, 0.6000000000000001, 0.7, 1]) {
    const { prepared } = prepareAndCompare(brushes, threshold, [vector(-0, 8, 6)]);
    assert.equal(prepared.find('scaled', normal) === null, threshold <= 0.6);
    assert.equal(prepared.find(NaN, normal) === null, threshold <= 0.6);
    assert.equal(prepared.find(0, normal) === null, threshold <= 0.6);
    assert.equal(prepared.find('flat', vector(0, 0, 1)), null);
  }
  const map = { brushes };
  const packet = packRampPreparation(map, 0.7);
  assert.equal(Object.is(packet.vertices[0], -0), true);
  assert.equal(Object.is(packet.planes[0], -0), true);
  assert.equal(Object.is(packet.planes[3], -0), true);
  const result = buildPackedRampPreparation(transferInput(packet));
  assert.equal(Object.is(scaled.vertices[0].x, -0), true);
  assert.equal(Object.is(scaled.planes[1].distance, -0), true);
  assert.equal(installPreparedRampSurfaces(map, 0.7, transferOutput(result)), true);
  assert.notEqual(getRampSurfaces(map, 0.7).find('scaled', normal), null);
});

test('deterministic dense and separated layouts retain exact component labels and lookup ambiguity', () => {
  const brushes = [];
  for (let i = 0; i < 180; i++) {
    const group = (i * 37) % 19;
    const cell = (i * 53) % 7;
    const x = group * 200 + cell * 10;
    const y = (group % 3) * 200;
    const id = i % 23 === 0 ? 'duplicate' : `brush-${i}`;
    const value = ramp(id, x, x + 10, y, y + 10);
    if (i % 13 === 0) {
      value.faces[0] = [2, 0, 3, 1, 2];
      value.planes.unshift({ normal: vector(0, 1, 0), distance: 0 });
    }
    brushes.push(value);
  }
  const { native, prepared } = prepareAndCompare(brushes, 0.7);
  assert.equal(prepared.find('duplicate', normal), native.find('duplicate', normal));
  assert.equal(prepared.find('duplicate', normal), null);
  for (const value of brushes) {
    assert.equal(prepared.find(value.id, normal), native.find(value.id, normal));
  }
});

test('stale identities, thresholds and malformed worker results cannot replace a native or prepared cache', () => {
  const brushes = [ramp('a'), ramp('b', 10, 20), ramp('c', 100, 110)];
  const map = { brushes };
  const packet = packRampPreparation(map, 0.7);
  const result = buildPackedRampPreparation(packet);
  assert.equal(installPreparedRampSurfaces({ brushes }, 0.7, result), false);
  assert.equal(installPreparedRampSurfaces(map, 0.6, result), false);
  assert.equal(installPreparedRampSurfaces(map, 0.7, { ...result, requestId: result.requestId + 1 }), false);
  assert.equal(installPreparedRampSurfaces(map, 0.7, { ...result, groundNormal: 0.6 }), false);
  assert.equal(installPreparedRampSurfaces(map, 0.7, { ...result, normals: result.normals.slice(0, -1) }), false);
  const wrongOrdinal = result.brushOrdinals.slice();
  wrongOrdinal[0] = brushes.length;
  assert.equal(installPreparedRampSurfaces(map, 0.7, { ...result, brushOrdinals: wrongOrdinal }), false);
  const wrongComponent = result.components.slice();
  wrongComponent[0] = 1;
  assert.equal(installPreparedRampSurfaces(map, 0.7, { ...result, components: wrongComponent }), false);
  const wrongNormal = result.normals.slice();
  wrongNormal[2] = 0;
  assert.equal(installPreparedRampSurfaces(map, 0.7, { ...result, normals: wrongNormal }), false);
  assert.equal(hasRampSurfaces(map, 0.7), false);
  assert.equal(installPreparedRampSurfaces(map, 0.7, result), true);
  const prepared = getRampSurfaces(map, 0.7);
  assert.equal(installPreparedRampSurfaces(map, 0.7, result), false);
  assert.equal(getRampSurfaces(map, 0.7), prepared);

  const nativeMap = { brushes };
  const pendingPacket = packRampPreparation(nativeMap, 0.7);
  const pendingResult = buildPackedRampPreparation(pendingPacket);
  const native = getRampSurfaces(nativeMap, 0.7);
  assert.equal(hasRampSurfaces(nativeMap, 0.7), true);
  assert.equal(installPreparedRampSurfaces(nativeMap, 0.7, pendingResult), false);
  assert.equal(getRampSurfaces(nativeMap, 0.7), native);
  assert.equal(native.find('a', normal), prepared.find('a', normal));
});

test('new jobs supersede stale results independently for each threshold', () => {
  const map = { brushes: [ramp('a'), ramp('b', 10, 20)] };
  const old = buildPackedRampPreparation(packRampPreparation(map, 0.7));
  const otherThreshold = buildPackedRampPreparation(packRampPreparation(map, 0.6));
  const latest = buildPackedRampPreparation(packRampPreparation(map, 0.7));
  assert.equal(installPreparedRampSurfaces(map, 0.7, old), false);
  assert.equal(installPreparedRampSurfaces(map, 0.6, otherThreshold), true);
  assert.equal(installPreparedRampSurfaces(map, 0.7, latest), true);
  assert.equal(getRampSurfaces(map, 0.6).find('a', normal), null);
  assert.equal(getRampSurfaces(map, 0.7).find('a', normal), getRampSurfaces(map, 0.7).find('b', normal));
});

test('an unsupported new preparation cancels the previous result only for that threshold', () => {
  const map = { brushes: [ramp('a'), ramp('b', 10, 20)] };
  const old = buildPackedRampPreparation(packRampPreparation(map, 0.7));
  const other = buildPackedRampPreparation(packRampPreparation(map, 0.6));
  map.brushes[0].faces[0][2] = 999;
  assert.equal(packRampPreparation(map, 0.7), null);
  map.brushes[0].faces[0][2] = 2;
  assert.equal(installPreparedRampSurfaces(map, 0.7, old), false);
  assert.equal(installPreparedRampSurfaces(map, 0.6, other), true);
  assert.equal(hasRampSurfaces(map, 0.7), false);
  assert.notEqual(getRampSurfaces(map, 0.7).find('a', normal), null);
});

test('cancellation revokes only the intended pending result and leaves native fallback intact', () => {
  const map = { brushes: [ramp('a'), ramp('b', 10, 20)] };
  const old = buildPackedRampPreparation(packRampPreparation(map, 0.7));
  const latest = buildPackedRampPreparation(packRampPreparation(map, 0.7));
  assert.equal(cancelRampPreparation(map, 0.7, old.requestId), false);
  assert.equal(cancelRampPreparation(map, 0.7, latest.requestId), true);
  assert.equal(cancelRampPreparation(map, 0.7, latest.requestId), false);
  assert.equal(installPreparedRampSurfaces(map, 0.7, latest), false);
  assert.equal(hasRampSurfaces(map, 0.7), false);
  const native = getRampSurfaces(map, 0.7);
  assert.equal(native.find('a', normal), native.find('b', normal));
});

test('unsupported eligible geometry and malformed packets fall back to synchronous indexing', () => {
  for (const bad of [
    value => { value.faces[0][2] = 999; },
    value => { value.faces[0][2] = 1.5; },
    value => { value.vertices[0].x = NaN; },
    value => { delete value.faces[0][2]; },
  ]) {
    const broken = ramp('broken');
    bad(broken);
    const map = { brushes: [broken, ramp('valid', 100, 110)] };
    assert.equal(packRampPreparation(map, 0.7), null);
    // Sparse face indices can make the native algorithm throw; fallback must
    // retain that behavior rather than fabricating a partial worker index.
    if (2 in broken.faces[0]) {
      assert.notEqual(getRampSurfaces(map, 0.7).find('valid', normal), null);
    } else {
      assert.throws(() => getRampSurfaces(map, 0.7));
    }
  }
  class Face extends Array {}
  const exotic = ramp('exotic');
  exotic.faces[0] = Face.from(exotic.faces[0]);
  const exoticMap = { brushes: [exotic] };
  assert.equal(packRampPreparation(exoticMap, 0.7), null);
  assert.notEqual(getRampSurfaces(exoticMap, 0.7).find('exotic', normal), null);

  const excluded = ramp('excluded');
  excluded.planes = [{ normal: vector(0, 0, 1), distance: 0 }];
  excluded.vertices[0].x = NaN;
  const selective = prepareAndCompare([excluded, ramp('selective', 100, 110)], 0.7);
  assert.equal(selective.prepared.find('excluded', normal), null);
  assert.notEqual(selective.prepared.find('selective', normal), null);
  const map = { brushes: [null, {}, ramp('valid')] };
  const packet = packRampPreparation(map, 0.7);
  const badIndices = packet.faceIndices.slice();
  badIndices[0] = 0xffffffff;
  assert.equal(buildPackedRampPreparation({ ...packet, faceIndices: badIndices }), null);
  const badOffsets = packet.faceOffsets.slice();
  badOffsets[badOffsets.length - 1]--;
  assert.equal(buildPackedRampPreparation({ ...packet, faceOffsets: badOffsets }), null);
  assert.equal(hasRampSurfaces(map, 0.7), false);
  assert.notEqual(getRampSurfaces(map, 0.7).find('valid', normal), null);
  for (const threshold of [undefined, NaN, Infinity, 0, -1, 1.01]) {
    assert.equal(packRampPreparation(map, threshold), null);
    assert.equal(hasRampSurfaces(map, threshold), false);
  }
  for (const value of [null, {}, { brushes: [] }]) assert.equal(packRampPreparation(value, 0.7), null);
});
