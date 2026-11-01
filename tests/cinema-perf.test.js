import {describe, expect, test} from 'bun:test';
import {createTrack} from '../src/cinema-track.js';
import {alignByPlace} from '../src/cinema-sync.js';
import {planCamera} from '../src/cinema-camera.js';

function route(xs, dt) {
  const track = createTrack(xs.length, dt);
  for (let tick = 0; tick < xs.length; tick++) track.position[tick * 3] = xs[tick];
  return track;
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

  test('short teleport stretches retain their own speed-based fov, including a one-sample ending', async () => {
    const a = createTrack(30, 0.01);
    let stretch = 0;
    for (let tick = 0; tick < a.count; tick++) {
      if ([5, 11, 17, 23, 29].includes(tick)) { a.cut[tick] = 1; stretch++; }
      a.position[tick * 3] = stretch * 100000 + tick * 24;
    }
    const plan = await planCamera({a});
    // Each non-singleton stretch travels at 2400 units/sec. Neither the
    // travel window nor its speed blur may include a neighbouring teleport.
    const t = (2400 - 1200) / (3500 - 1200);
    const movingFov = Math.fround(74 + 10 * t * t * (3 - 2 * t));
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
