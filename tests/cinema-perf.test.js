import {describe, expect, test} from 'bun:test';
import {createTrack} from '../src/cinema-track.js';
import {alignByPlace} from '../src/cinema-sync.js';
import {planCamera} from '../src/cinema-camera.js';
import {searchTake} from '../src/cinema-viewpoints.js';
import {cameraTrace, cameraWorld, PROBE} from '../src/cinema-world.js';

function route(xs, dt) {
  const track = createTrack(xs.length, dt);
  for (let tick = 0; tick < xs.length; tick++) track.position[tick * 3] = xs[tick];
  return track;
}

// Direction probes use free/view; viewpoint construction alone starts with a
// contiguous run of clear traces before search asks free/view again.
function tracedPlanner() {
  const work = {phase: 'direction', probes: 0, clears: 0, direction: [], graph: []};
  const trace = (from, to) => {
    if (work.phase !== 'search') {
      work.phase = 'graph'; work.clears++;
      work.graph.push([from.x, from.y, from.z, to.x, to.y, to.z]);
    }
    return 1;
  };
  trace.free = (point, room) => {
    if (work.phase === 'graph') work.phase = 'search';
    if (work.phase === 'direction') {
      work.probes++;
      work.direction.push(['free', point.x, point.y, point.z, room]);
    }
    return true;
  };
  trace.view = (from, to) => {
    if (work.phase === 'graph') work.phase = 'search';
    if (work.phase === 'direction') work.direction.push(['view', from.x, from.y, from.z, to.x, to.y, to.z]);
    return 1;
  };
  return {trace, work};
}

describe('cinematic preparation boundaries', () => {
  test('place matching retains the mean of repeated positions, including asymmetric matches', async () => {
    const a = route([0, 10, 20], 0.35), b = route([0, 0, 10, 10, 20], 0.35);
    // The middle sample pairs with both of b's samples at x=10. After
    // preserving the timer endpoints, its centred window is [0, 2.5, 4].
    expect(await alignByPlace(a, b)).toEqual(Float32Array.from([0, 6.5 / 3, 4]));
    expect(await alignByPlace(b, a)).toEqual(Float32Array.from([0, 1 / 3, 2 / 3, 4 / 3, 2]));
  });

  test('sliced matching preserves exact route and checkpoint results', async () => {
    const a = route(Array.from({length: 1500}, (_, tick) => Math.max(0, tick - 20) * 10), 0.015);
    const b = route(Array.from({length: 1600}, (_, tick) => Math.max(0, tick - 40) * 9.5), 0.015);
    a.start = 20; b.start = 40;
    a.splits = [500, 1000]; b.splits = [550, 1100];
    const expected = await alignByPlace(a, b);
    const actual = await alignByPlace(a, b, {yieldTask: async () => null});
    expect(actual).toEqual(expected);
    for (const [from, to] of [[20, 40], [500, 550], [1000, 1100], [1499, 1599]]) expect(actual[from]).toBe(to);
  });

  test('cancelled matching never returns a partial route', async () => {
    const a = route(Array.from({length: 1000}, (_, tick) => tick * 10), 0.015);
    let current = true, resumed = false;
    const result = await alignByPlace(a, a, {
      isCurrent: () => current,
      yieldTask: async () => {
        if (resumed) current = false;
        resumed = true;
        return null;
      },
    });
    expect(result).toBeNull();
  });

  test('matching propagates preparation failure rather than returning a partial route', async () => {
    const a = route([0, 10, 20], 0.015);
    await expect(alignByPlace(a, a, {yieldTask: async () => { throw new Error('Map unloaded'); }})).rejects.toThrow('Map unloaded');
  });

  test('sliced camera preparation produces the same shots and cuts', async () => {
    const a = route(Array.from({length: 1600}, (_, tick) => tick * 20), 0.015);
    a.cut[701] = 1;
    const expected = await planCamera({a});
    const actual = await planCamera({a, yieldTask: async () => null});
    expect(actual).toEqual(expected);
  });

  test('cancellation before camera preparation publishes no shot', async () => {
    const a = route([0, 10, 20], 0.015);
    let current = true;
    expect(await planCamera({a, isCurrent: () => current, yieldTask: async () => { current = false; return null; }})).toBeNull();
  });

  test('yielding during obstruction checks preserves the complete corrected camera plan', async () => {
    const a = route(Array.from({length: 600}, (_, tick) => tick * 20), 0.015);
    const trace = (from, to) => Math.min(1, 180 / Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z));
    const expected = await planCamera({a, trace});
    const actual = await planCamera({a, trace, yieldTask: async () => null});
    expect(actual).toEqual(expected);
  });

  test('native broadphase keeps swept hull and uncertain geometry candidates', () => {
    const box = (x, y, z = 0, radius = 1) => {
      const min = {x: x - radius, y: y - radius, z: z - radius}, max = {x: x + radius, y: y + radius, z: z + radius};
      const axes = ['x', 'y', 'z'];
      return {contents: 1, min, max, planes: axes.flatMap(axis => [
        {normal: Object.fromEntries(axes.map(key => [key, key === axis ? 1 : 0])), distance: max[axis]},
        {normal: Object.fromEntries(axes.map(key => [key, key === axis ? -1 : 0])), distance: -min[axis]},
      ])};
    };
    const wedge = box(30, 80);
    wedge.planes = [{normal: {x: 0.001, y: 1, z: 0}, distance: 80}];
    const brushes = [box(50, 50), box(10, 90), box(50, 64), box(20, 80), {...box(50, 50), contents: 8}, box(50, 6.03125, 0, 0), wedge];
    brushes[3].min.x = NaN;
    const triangleBounds = [box(75, 75), {min: {x: 0, y: 20000, z: 0}, max: {x: 10000, y: 30000, z: 0}}];
    const triangles = [{}, {}], visited = [];
    let extra = 0;
    class World {
      constructor() {
        this.brushes = brushes; this.triangles = triangles; this.triangleBounds = triangleBounds;
        this.triangleCache = new Map();
        this.tree = {query: () => [0, 1, 2, 3, 4, 5, 6, 7, 8]};
      }
      triangleBrush() {}
      trace(from, to, hull) {
        const bounds = {min: {}, max: {}};
        for (const axis of ['x', 'y', 'z']) {
          bounds.min[axis] = Math.min(from[axis], to[axis]) + hull.min[axis] - 0.03125 - extra;
          bounds.max[axis] = Math.max(from[axis], to[axis]) + hull.max[axis] + 0.03125 + extra;
        }
        visited.push(this.tree.query(bounds));
        return {fraction: 1, startSolid: false, allSolid: false};
      }
    }
    const world = new World(), map = {brushes, displacementTriangles: triangles};
    const filtered = cameraWorld({map, movement: {world}}), from = {x: 0, y: 0, z: 0}, to = {x: 100, y: 100, z: 0};
    filtered.trace(from, to, PROBE);
    // The diagonal misses index 1; a probe touching index 2, malformed
    // index 3, the unsupported wedge and both triangles must remain.
    expect(visited.pop()).toEqual([0, 2, 3, 6, 7, 8]);
    const left = {x: 0, y: 0, z: 0}, right = {x: 100, y: 0, z: 0};
    filtered.trace(left, right, PROBE);
    expect(visited.pop()).toEqual([3, 5, 6, 8]);
    filtered.trace(right, left, PROBE);
    expect(visited.pop()).toEqual([3, 5, 6, 8]);
    filtered.trace({x: 50, y: -100, z: 0}, {x: 50, y: 100, z: 0}, PROBE);
    expect(visited.pop()).toEqual([0, 2, 3, 5, 6, 8]);
    filtered.trace({x: 50, y: 6.03125, z: 100}, {x: 50, y: 6.03125, z: -100}, PROBE);
    expect(visited.pop()).toEqual([3, 5, 6, 8]);
    // A different native query is not necessarily for this sweep.
    extra = 2;
    filtered.trace(from, to, PROBE);
    expect(visited.pop()).toEqual([0, 1, 2, 3, 5, 6, 7, 8]);
  });

  test('optimized native queries match reference collisions at edges, overlaps and displacement faces', () => {
    const axes = ['x', 'y', 'z'], epsilon = 0.03125;
    const box = (min, max, contents = 1) => ({
      min, max, contents, planes: axes.flatMap(axis => [
        {normal: Object.fromEntries(axes.map(key => [key, key === axis ? 1 : 0])), distance: max[axis]},
        {normal: Object.fromEntries(axes.map(key => [key, key === axis ? -1 : 0])), distance: -min[axis]},
      ]),
    });
    const brushes = [
      box({x: 40, y: -8, z: -10}, {x: 60, y: 8, z: 80}),
      box({x: 60, y: -8, z: -10}, {x: 90, y: 8, z: 80}),
      box({x: 10, y: 70, z: -20}, {x: 20, y: 80, z: 80}),
      box({x: 10, y: -80, z: -20}, {x: 20, y: -60, z: 80}, 8),
    ];
    // Inflating a sharp wedge's planes can extend its apparent collision far
    // past the vertex AABB. It has no negative-x support plane.
    const slope = 0.0001, inverse = 1 / Math.hypot(slope, 1);
    brushes.push({
      contents: 1, min: {x: 0, y: 0, z: -1}, max: {x: 10000, y: 1, z: 1},
      planes: [
        {normal: {x: 1, y: 0, z: 0}, distance: 10000},
        {normal: {x: 0, y: -1, z: 0}, distance: 0},
        {normal: {x: -slope * inverse, y: inverse, z: 0}, distance: 0},
        {normal: {x: 0, y: 0, z: 1}, distance: 1},
        {normal: {x: 0, y: 0, z: -1}, distance: 1},
      ],
    });
    const diagonal = Math.SQRT1_2;
    const triangle = {
      min: {x: 100, y: 100, z: 20}, max: {x: 200, y: 200, z: 20},
      vertices: [{x: 100, y: 100, z: 20}, {x: 200, y: 100, z: 20}, {x: 100, y: 200, z: 20}],
      faces: [[0, 1, 2]],
      planes: [
        {normal: {x: -1, y: 0, z: 0}, distance: -100},
        {normal: {x: 1, y: 0, z: 0}, distance: 200},
        {normal: {x: 0, y: -1, z: 0}, distance: -100},
        {normal: {x: 0, y: 1, z: 0}, distance: 200},
        {normal: {x: diagonal, y: diagonal, z: 0}, distance: 300 * diagonal},
        {normal: {x: 0, y: 0, z: 1}, distance: 20},
        {normal: {x: 0, y: 0, z: -1}, distance: -20},
      ],
    };
    class World {
      constructor(solids, triangles) {
        this.brushes = solids; this.triangles = triangles;
        this.triangleBounds = triangles.map(({min, max}) => ({min, max}));
        this.triangleCache = new Map();
        this.tree = {query: bounds => [...solids, ...this.triangleBounds].flatMap((item, index) =>
          axes.every(axis => bounds.max[axis] >= item.min[axis] && bounds.min[axis] <= item.max[axis]) ? [index] : [])};
      }
      triangleBrush(index) { return this.triangles[index]; }
      trace(from, to, hull) {
        const bounds = {min: {}, max: {}}, result = {fraction: 1, startSolid: false, allSolid: false, brush: null};
        for (const axis of axes) {
          bounds.min[axis] = Math.min(from[axis], to[axis]) + hull.min[axis] - epsilon;
          bounds.max[axis] = Math.max(from[axis], to[axis]) + hull.max[axis] + epsilon;
        }
        for (const index of this.tree.query(bounds)) {
          const brush = index < this.brushes.length ? this.brushes[index] : this.triangleBrush(index - this.brushes.length);
          let enter = -1, leave = 1, outside = false, endsOutside = false, missed = false;
          for (const {normal, distance} of brush.planes) {
            let offset = 0, start = -distance, end = -distance;
            for (const axis of axes) {
              offset += normal[axis] * (normal[axis] < 0 ? hull.max[axis] : hull.min[axis]);
              start += normal[axis] * from[axis]; end += normal[axis] * to[axis];
            }
            start += offset; end += offset;
            outside ||= start > 0; endsOutside ||= end > 0;
            if (start > 0 && end > 0) { missed = true; break; }
            if (start <= 0 && end <= 0) continue;
            if (start > end) enter = Math.max(enter, Math.max(0, (start - epsilon) / (start - end)));
            else leave = Math.min(leave, (start + epsilon) / (start - end));
          }
          if (missed) continue;
          if (!outside) {
            result.startSolid = true;
            if (!endsOutside) return {...result, fraction: 0, allSolid: true, brush};
          } else if (enter < leave && enter > -1 && enter < result.fraction) {
            result.fraction = Math.max(0, enter); result.brush = brush;
          }
        }
        return result;
      }
    }
    const triangles = [triangle], world = new World(brushes, triangles);
    const native = cameraWorld({map: {brushes, displacementTriangles: triangles}, movement: {world}});
    const optimized = cameraTrace(native), reference = cameraTrace(new World(brushes.filter(brush => brush.contents === 1), triangles));
    const point = (x, y, z) => ({x, y, z});
    const wedgeRay = [point(-200, -100, 0), point(100, 200, 0)];
    const rays = [
      [point(-20, 0, 40), point(120, 0, 40)],
      [point(-20, 14.03124, 40), point(120, 14.03124, 40)],
      [point(-20, 14.03126, 40), point(120, 14.03126, 40)],
      [point(50, 0, 40), point(120, 0, 40)],
      [point(50, 0, 40), point(65, 0, 40)],
      [point(-20, -80, 40), point(100, 70, 40)],
      wedgeRay,
      [point(130, 130, 100), point(130, 130, -50)],
      [point(130, 130, -50), point(130, 130, 100)],
      [point(100, 100, 100), point(100, 100, -50)],
    ];
    expect(reference(...wedgeRay)).toBeLessThan(1);
    for (const [from, to] of rays) {
      expect(optimized(from, to)).toBe(reference(from, to));
      const shown = optimized.view(from, to), inside = optimized.view.inside;
      expect(shown).toBe(reference.view(from, to));
      expect(inside).toBe(reference.view.inside);
    }
    for (const at of [point(50, 0, 40), point(50, 20, 40), point(50, 38.03125, 40), point(130, 130, -20), point(130, 130, 60)])
      for (const room of [0, 8, 30, 140]) expect(optimized.free(at, room)).toBe(reference.free(at, room));
  });

  test('first-entry traces avoid only redundant touching-solid probes', () => {
    const eye = {x: 0, y: 0, z: 0}, target = {x: 10, y: 0, z: 0};
    const makeWorld = (firstEntry, initialSolid, nearSolid) => {
      let calls = 0;
      const world = {
        cameraFirstEntry: firstEntry,
        trace(from, to) {
          calls++;
          if (from === to) return {startSolid: nearSolid};
          if (calls === 1) return {fraction: 0.5, startSolid: initialSolid, allSolid: false};
          return {fraction: 1, startSolid: false, allSolid: false};
        },
      };
      return {trace: cameraTrace(world), calls: () => calls};
    };
    const open = makeWorld(true, false, false);
    expect(open.trace.view(eye, target)).toBe(0.5);
    expect(open.calls()).toBe(1);
    const touching = makeWorld(true, true, true);
    expect(touching.trace.view(eye, target)).toBe(1);
    expect(touching.trace.view.inside).toBe(true);
    expect(touching.calls()).toBe(3);
    // Unknown worlds may have different collision semantics and must still
    // be asked whether the point before the hit is inside.
    const unknown = makeWorld(false, false, true);
    expect(unknown.trace.view(eye, target)).toBe(1);
    expect(unknown.calls()).toBe(3);
  });

  test('proof still checks samples between the surveyed sightlines', async () => {
    const count = 19, body = new Float32Array(count * 3), zero = () => new Float32Array(count);
    const face = new Float32Array(count * 3), travel = new Float32Array(count * 3);
    for (let s = 0; s < count; s++) { body[s * 3] = s * 30; travel[s * 3] = 1; }
    const neighbours = () => Array.from({length: 3}, () => new Int32Array(count).fill(-1));
    const route = {
      count, dt: 0.03, segTo: new Int32Array(count).fill(count - 1),
      runs: [body], faces: [face], landing: neighbours(), leaving: neighbours(), shares: [],
      centre: [Float32Array.from({length: count}, (_, s) => body[s * 3]), zero(), zero()],
      hx: new Float32Array(count).fill(1), hy: zero(), travel,
      speed: new Float32Array(count).fill(1000), working: new Float32Array(count).fill(500),
    };
    const intent = {
      x: new Float32Array(count).fill(-1), y: zero(), z: zero(),
      distance: new Float32Array(count).fill(500), weight: new Float32Array(count).fill(1),
    };
    let unsurveyed = 0;
    const scene = {
      clear: () => 1,
      free: () => true,
      // The first leg is surveyed at samples 3 and 6, but must also be
      // proved at sample 4 before accepting it as continuously visible.
      sees: (_x, _y, _z, s) => { if (s === 4) { unsurveyed++; return false; } return true; },
    };
    const take = await searchTake({route, intent, scene, due: () => false, pause: async () => {}, debug: true});
    expect(take).not.toBeNull();
    expect(unsurveyed).toBeGreaterThan(0);
    expect(take.search.repairs).toBeGreaterThan(0);
  });

  test('direction probes and viewpoint construction honor budgets without changing the take', async () => {
    const a = route(Array.from({length: 1000}, (_, tick) => tick * 20), 0.015);
    const baseline = tracedPlanner();
    const expected = await planCamera({a, trace: baseline.trace, debug: true});
    const sliced = tracedPlanner(), directionYields = [], graphYields = [];
    let probes = 0, clears = 0;
    const yieldTask = async () => {
      const {phase, probes: nowProbes, clears: nowClears} = sliced.work;
      if (phase === 'direction' && nowProbes) directionYields.push(nowProbes);
      if (phase === 'graph') graphYields.push(nowClears);
      probes = nowProbes; clears = nowClears;
      return {didTimeout: false, timeRemaining: () => {
        const {phase, probes: nowProbes, clears: nowClears} = sliced.work;
        const expired = phase === 'direction' ? nowProbes - probes >= 4 : phase === 'graph' && nowClears - clears >= 10;
        return expired ? 0 : 50;
      }};
    };
    const actual = await planCamera({a, trace: sliced.trace, yieldTask, debug: true});
    expect(actual).toEqual(expected);
    expect(sliced.work.direction).toEqual(baseline.work.direction);
    expect(sliced.work.graph).toEqual(baseline.work.graph);
    expect(directionYields.length).toBeGreaterThan(0);
    expect(directionYields[0]).toBeGreaterThanOrEqual(4);
    expect(directionYields[0]).toBeLessThan(sliced.work.probes);
    expect(graphYields.length).toBeGreaterThan(1);
    expect(graphYields[0]).toBeGreaterThanOrEqual(10);
    expect(graphYields[0]).toBeLessThan(sliced.work.clears);
    const points = [0, ...graphYields, sliced.work.clears];
    for (let i = 1; i < points.length; i++) expect(points[i] - points[i - 1]).toBeLessThanOrEqual(19);
  });

  test('cancellation interrupts direction probes even with idle time remaining', async () => {
    const a = route(Array.from({length: 1000}, (_, tick) => tick * 20), 0.015);
    const scene = tracedPlanner(), free = scene.trace.free;
    let current = true;
    scene.trace.free = (...args) => {
      const result = free(...args);
      if (scene.work.phase === 'direction' && scene.work.probes >= 4) current = false;
      return result;
    };
    const plan = await planCamera({
      a, trace: scene.trace, isCurrent: () => current,
      yieldTask: async () => ({didTimeout: false, timeRemaining: () => 50}),
    });
    expect(plan).toBeNull();
    expect(scene.work.probes).toBeGreaterThanOrEqual(4);
    expect(scene.work.probes).toBeLessThanOrEqual(30);
    expect(scene.work.clears).toBe(0);

    const interrupted = tracedPlanner();
    current = true;
    let cancelledAt = 0;
    const stopped = await planCamera({
      a, trace: interrupted.trace, isCurrent: () => current,
      yieldTask: async () => {
        if (interrupted.work.phase === 'direction' && interrupted.work.probes >= 4) {
          cancelledAt = interrupted.work.probes; current = false;
        }
        return null;
      },
    });
    expect(stopped).toBeNull();
    expect(cancelledAt).toBeGreaterThanOrEqual(4);
    expect(cancelledAt).toBeLessThanOrEqual(16);
    expect(interrupted.work.probes).toBe(cancelledAt);
    expect(interrupted.work.clears).toBe(0);
  });

  test('cancellation interrupts viewpoint construction even with idle time remaining', async () => {
    const a = route(Array.from({length: 1000}, (_, tick) => tick * 20), 0.015);
    const scene = tracedPlanner(), clear = scene.trace;
    let current = true;
    const trace = (...args) => {
      const result = clear(...args);
      if (scene.work.phase === 'graph' && scene.work.clears >= 12) current = false;
      return result;
    };
    trace.free = scene.trace.free; trace.view = scene.trace.view;
    const plan = await planCamera({
      a, trace, isCurrent: () => current,
      yieldTask: async () => ({didTimeout: false, timeRemaining: () => 50}),
    });
    expect(plan).toBeNull();
    expect(scene.work.clears).toBeGreaterThanOrEqual(12);
    expect(scene.work.clears).toBeLessThanOrEqual(60);

    const interrupted = tracedPlanner();
    current = true;
    let cancelledAt = 0;
    const stopped = await planCamera({
      a, trace: interrupted.trace, isCurrent: () => current,
      yieldTask: async () => {
        if (interrupted.work.phase === 'graph' && interrupted.work.clears >= 10) {
          cancelledAt = interrupted.work.clears; current = false;
        }
        return null;
      },
    });
    expect(stopped).toBeNull();
    expect(cancelledAt).toBe(10);
    expect(interrupted.work.clears).toBe(cancelledAt);
  });

  test('short teleport stretches retain their own speed-based fov, including a one-sample ending', async () => {
    const a = createTrack(30, 0.01);
    let stretch = 0;
    for (let tick = 0; tick < a.count; tick++) {
      if ([5, 11, 17, 23, 29].includes(tick)) { a.cut[tick] = 1; stretch++; }
      a.position[tick * 3] = stretch * 100000 + tick * 24;
    }
    const plan = await planCamera({a, style: 'steady'});
    // Each non-singleton stretch travels at 2400 units/sec. Neither the
    // travel window nor its speed blur may include a neighbouring teleport.
    const t = (2400 - 1200) / (3500 - 1200);
    const movingFov = Math.fround(74 + 6 * t * t * (3 - 2 * t));
    expect(Array.from(plan.fov.slice(0, -1))).toEqual(Array(15).fill(movingFov));
    expect(plan.fov.at(-1)).toBe(74);
    expect(Array.from(plan.segment)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5]);
    expect(Array.from(plan.cutTick).filter(Boolean)).toEqual([5, 11, 17, 23, 29]);
  });

  test('cancellation discards a plan even when its idle window still has time left', async () => {
    const a = route(Array.from({length: 2000}, (_, tick) => tick * 10), 0.015);
    let current = true;
    const plan = await planCamera({
      a, isCurrent: () => current,
      yieldTask: async () => ({didTimeout: false, timeRemaining: () => 50}),
      trace: () => { current = false; return 1; },
    });
    expect(plan).toBeNull();
  });
});
