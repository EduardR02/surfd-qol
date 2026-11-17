import {describe, expect, test} from 'bun:test';
import {createTrack} from '../src/cinema-track.js';
import {alignByPlace} from '../src/cinema-sync.js';
import {planCamera} from '../src/cinema-camera.js';

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
