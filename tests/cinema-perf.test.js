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
  test('place matching retains the mean of repeated positions, including asymmetric matches', () => {
    const a = route([0, 10, 20], 0.35), b = route([0, 0, 10, 10, 20], 0.35);
    // The middle sample pairs with both of b's samples at x=10. After
    // preserving the timer endpoints, its centred window is [0, 2.5, 4].
    expect(alignByPlace(a, b)).toEqual(Float32Array.from([0, 6.5 / 3, 4]));
    expect(alignByPlace(b, a)).toEqual(Float32Array.from([0, 1 / 3, 2 / 3, 4 / 3, 2]));
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
