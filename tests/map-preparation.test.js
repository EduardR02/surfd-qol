import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMapPreparation} from '../src/map-preparation.js';
import {buildCollisionTree} from '../extension/collision-tree.js';
import {buildMapBoundsTree} from '../extension/map-bvh-preparation.js';
import {buildPackedRampPreparation} from '../src/map-ramp-preparation.js';
import {getRampSurfaces} from '../src/surfaces.js';

const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return {promise, resolve, reject};
}
function mapFixture() {
  const normal = {x: 0, y: .8, z: .6};
  const brushes = [0, 10, 100].map((x, id) => ({id,
    vertices: [{x, y: 0, z: 0}, {x: x + 10, y: 0, z: 0},
      {x: x + 10, y: 10, z: -40 / 3}, {x, y: 10, z: -40 / 3}],
    faces: [[0, 1, 2, 3]], planes: [{normal: {...normal}, distance: 0}],
    min: {x, y: 0, z: -40 / 3}, max: {x: x + 10, y: 10, z: 0}}));
  return {brushes, displacementTriangles: []};
}
class Tree {
  constructor(bounds) { this.bounds = bounds; this.root = buildCollisionTree(bounds); }
}
function jobsFixture({holdReady = false, holdResults = false} = {}) {
  const ready = deferred(), results = deferred(), jobs = [];
  if (!holdReady) ready.resolve(true);
  if (!holdResults) results.resolve();
  return {ready, results, jobs, create() {
    const job = {ready: ready.promise, disposed: false,
      async run(type, payload, transfers) {
        const input = structuredClone(payload, {transfer: transfers});
        const packet = type === 'map-bvh' ? buildMapBoundsTree(input) : buildPackedRampPreparation(input);
        await results.promise;
        if (job.disposed) throw new DOMException('Disposed', 'AbortError');
        return structuredClone(packet, {transfer: Object.values(packet).filter(ArrayBuffer.isView).map(value => value.buffer)});
      },
      dispose() { this.disposed = true; }
    };
    jobs.push(job);
    return job;
  }};
}

test('ready compact preparation preserves native tree bounds, flags and ramp lookup', async () => {
  const map = mapFixture(), expectedMap = structuredClone(map), expectedTree = new Tree(map.brushes);
  const expectedRamps = getRampSurfaces(expectedMap, .7), jobs = jobsFixture(), controller = new AbortController();
  const preparation = createMapPreparation(), load = preparation.createLoad(controller.signal, () => jobs.create());
  await flush();
  await load.prepare(map, .7);
  const world = {};
  assert.equal(preparation.useWorld(world, map.brushes, map.displacementTriangles, true, true, Tree), true);
  assert.equal(world.brushes, map.brushes);
  assert.equal(world.triangles, map.displacementTriangles);
  assert.equal(world.vphysicsFeatureFix, true);
  assert.equal(world.bspCornerFix, true);
  assert.deepEqual(world.tree.root, expectedTree.root);
  assert.equal(preparation.useRamps(map, .7), true);
  const actual = getRampSurfaces(map, .7);
  for (const brush of map.brushes) assert.equal(actual.find(brush.id, brush.planes[0].normal), expectedRamps.find(brush.id, brush.planes[0].normal));
  assert.deepEqual(map, expectedMap);
  assert.ok(jobs.jobs.every(job => job.disposed));
});

test('an omitted displacement array uses the prepared tree with the native empty default', async () => {
  const map = mapFixture(), jobs = jobsFixture(), controller = new AbortController();
  delete map.displacementTriangles;
  const preparation = createMapPreparation(), load = preparation.createLoad(controller.signal, () => jobs.create());
  await flush();
  await load.prepare(map, .7);
  const world = {}, triangles = [];
  assert.equal(preparation.useWorld(world, map.brushes, triangles, true, true, Tree), true);
  assert.equal(world.brushes, map.brushes);
  assert.equal(world.triangles, triangles);
  assert.deepEqual(world.tree.root, new Tree(map.brushes).root);
  assert.equal(preparation.useRamps(map, .7), true);
});

test('a missed preparation window immediately keeps native work and cannot later replace its cache', async () => {
  const map = mapFixture(), jobs = jobsFixture({holdReady: true}), controller = new AbortController();
  const preparation = createMapPreparation(), load = preparation.createLoad(controller.signal, () => jobs.create());
  assert.equal(load.prepare(map, .7), undefined);
  assert.equal(preparation.useWorld({}, map.brushes, map.displacementTriangles, false, false, Tree), false);
  assert.equal(preparation.useRamps(map, .7), false);
  const native = getRampSurfaces(map, .7);
  jobs.ready.resolve(true);
  await flush();
  assert.equal(getRampSurfaces(map, .7), native);
  assert.equal(preparation.useRamps(map, .7), false);
  assert.ok(jobs.jobs.every(job => job.disposed));
});

test('entry joins the ready worker without waiting for a still-starting sibling', async () => {
  const map = mapFixture(), controller = new AbortController();
  const tree = jobsFixture({holdResults: true}), ramps = jobsFixture({holdReady: true});
  const preparation = createMapPreparation();
  const load = preparation.createLoad(controller.signal, type =>
    (type === 'map-bvh' ? tree : ramps).create());
  await flush();
  let joined = false;
  const pending = load.prepare(map, .7).then(() => { joined = true; });
  await flush();
  assert.equal(joined, false);
  tree.results.resolve();
  await pending;
  assert.equal(joined, true);
  assert.equal(preparation.useWorld({}, map.brushes, map.displacementTriangles, false, false, Tree), true);
  assert.equal(preparation.useRamps(map, .7), false);
  const native = getRampSurfaces(map, .7);
  ramps.ready.resolve(true);
  await flush();
  assert.equal(getRampSurfaces(map, .7), native);
  assert.ok(tree.jobs.every(job => job.disposed));
  assert.ok(ramps.jobs.every(job => job.disposed));
});

test('pending BVH results never delay construction after triangle bounds are available', async () => {
  const map = mapFixture(), jobs = jobsFixture({holdResults: true}), controller = new AbortController();
  const preparation = createMapPreparation(), load = preparation.createLoad(controller.signal, () => jobs.create());
  load.prepare(map, .7);
  await flush();
  const world = {};
  assert.equal(preparation.useWorld(world, map.brushes, map.displacementTriangles, false, true, Tree), true);
  assert.deepEqual(world.tree.root, new Tree(map.brushes).root);
  assert.equal(preparation.useRamps(map, .7), false);
  const native = getRampSurfaces(map, .7);
  jobs.results.resolve();
  await flush();
  assert.equal(getRampSurfaces(map, .7), native);
});

function deadlineFixture() {
  const timers = [], jobs = [];
  const preparation = createMapPreparation({read: async () => null,
    schedule: (start, delay) => { const timer = {start, delay, live: true}; timers.push(timer); return () => { timer.live = false; }; }});
  return {preparation, timers, jobs, create(hang) {
    if (!hang) return jobsFixture().create();
    const pending = [];
    const job = {ready: Promise.resolve(true), disposed: false,
      run() { return new Promise((resolve, reject) => pending.push(reject)); },
      dispose() { this.disposed = true; for (const reject of pending.splice(0)) reject(new DOMException('Disposed', 'AbortError')); }};
    jobs.push(job);
    return job;
  }};
}

test('tree and ramp jobs that stop replying are given up on, and both are built natively', async () => {
  const map = mapFixture(), fixture = deadlineFixture();
  const load = fixture.preparation.createLoad(new AbortController().signal, () => fixture.create(true));
  await flush();
  let joined = false;
  const entry = load.prepare(map, .7).then(() => { joined = true; });
  await flush();
  assert.equal(joined, false);
  assert.deepEqual(fixture.timers.map(timer => timer.delay), [20000]);
  fixture.timers[0].start();
  await entry;
  assert.ok(fixture.jobs.every(job => job.disposed));
  const world = {};
  assert.equal(fixture.preparation.useWorld(world, map.brushes, map.displacementTriangles, false, false, Tree), true);
  assert.ok(world.tree instanceof Tree);
  assert.deepEqual(world.tree.root, new Tree(map.brushes).root);
  assert.equal(fixture.preparation.useRamps(map, .7), false);
});

test('jobs that reply in time clear their deadline', async () => {
  const map = mapFixture(), fixture = deadlineFixture();
  const load = fixture.preparation.createLoad(new AbortController().signal, () => fixture.create(false));
  await flush();
  await load.prepare(map, .7);
  assert.deepEqual(fixture.timers.map(timer => timer.live), [false]);
  assert.equal(fixture.preparation.useRamps(map, .7), true);
});

for (const stop of ['abort', 'destroy']) test(`${stop} prevents late results from entering a live map`, async () => {
  const map = mapFixture(), jobs = jobsFixture({holdResults: true}), controller = new AbortController();
  const preparation = createMapPreparation(), load = preparation.createLoad(controller.signal, () => jobs.create());
  load.prepare(map, .7);
  await flush();
  if (stop === 'abort') controller.abort();
  else preparation.destroy();
  jobs.results.resolve();
  await flush();
  assert.equal(preparation.useWorld({}, map.brushes, map.displacementTriangles, false, false, Tree), false);
  assert.equal(preparation.useRamps(map, .7), false);
  assert.ok(jobs.jobs.every(job => job.disposed));
});
