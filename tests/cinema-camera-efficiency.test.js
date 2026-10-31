import {describe, expect, test} from 'bun:test';
import {createTrack} from '../src/cinema-track.js';
import {planCamera} from '../src/cinema-camera.js';

function straight(count = 400) {
  const track = createTrack(count, 0.015);
  for (let tick = 0; tick < count; tick++) track.position[tick * 3] = tick * 20;
  return track;
}

function box(from, to) {
  let clear = 1;
  for (const [axis, low, high] of [['y', -100, 100], ['z', 0, 90]]) {
    const delta = to[axis] - from[axis];
    if (to[axis] < low) clear = Math.min(clear, (low - from[axis]) / delta);
    if (to[axis] > high) clear = Math.min(clear, (high - from[axis]) / delta);
  }
  return clear;
}

const routeCandidate = (from, to) => from.z === 40 && to.z === 40 && Math.hypot(to.x - from.x, to.y - from.y) >= 70;

describe('camera preparation efficiency', () => {
  for (const style of ['cinematic', 'steady']) test(`${style} keeps fixed-focus composition identical to recomputing its focus`, async () => {
    const a = straight(), other = straight();
    for (let tick = 0; tick < a.count; tick++) {
      a.position[tick * 3 + 1] = Math.sin(tick / 40) * 12;
      if (tick >= 60 && tick < 200) a.normal.set([0, -0.8, 0.6], tick * 3);
      other.position[tick * 3 + 1] = 100000;
      if (tick >= 260) a.position[tick * 3] += 10000;
    }
    a.cut[260] = 1;
    a.start = 20;
    a.finish = 350;
    const others = [{track: other, map: Float32Array.from({length: a.count}, (_, tick) => tick)}];
    // This distant run has exactly zero framing share in both cases. Group
    // framing recomputes the centre on every correction; solo framing caches
    // it, including across a safer-shot retry. Both still check the same runs.
    const reference = await planCamera({a, others, group: true, style, trace: box});
    const cached = await planCamera({a, others, group: false, style, trace: box});
    expect(cached).toEqual(reference);
  });

  test('fallback yields within candidate searches instead of counting only affected samples', async () => {
    const a = straight();
    let candidates = 0, previous = 0, longest = 0, fallbackYields = 0;
    const plan = await planCamera({a,
      trace: (from, to) => {
        if (routeCandidate(from, to)) candidates++;
        return 0;
      },
      yieldTask: async () => {
        longest = Math.max(longest, candidates - previous);
        if (candidates > previous) fallbackYields++;
        previous = candidates;
        return {didTimeout: true, timeRemaining: () => 0};
      },
    });
    longest = Math.max(longest, candidates - previous);
    expect(plan).not.toBeNull();
    expect(candidates).toBeGreaterThan(80);
    expect(fallbackYields).toBeGreaterThan(1);
    expect(longest).toBeLessThanOrEqual(80);
  });

  test('sparse fallback checks cancellation even when no affected sample is a slice boundary', async () => {
    const a = straight();
    let current = true, candidates = 0;
    const plan = await planCamera({a,
      // Stored sample 119 is skipped by the anticipatory traces. Its final
      // eye is clipped to the body, producing fallback support around samples
      // 84..154: neither 80 nor 160 is affected. Route candidates stay blocked.
      trace: (from, to) => {
        if (routeCandidate(from, to)) {
          candidates++;
          current = false;
          return 0;
        }
        return from.x === 238 * 20 && to.z > 40 ? 0 : 1;
      },
      isCurrent: () => current,
      yieldTask: async () => ({didTimeout: false, timeRemaining: () => 50}),
    });
    expect(candidates).toBeGreaterThan(0);
    expect(candidates).toBeLessThanOrEqual(80);
    expect(plan).toBeNull();
  });
});
