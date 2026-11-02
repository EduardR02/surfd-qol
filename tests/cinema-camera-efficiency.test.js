import {describe, expect, test} from 'bun:test';
import {createTrack} from '../src/cinema-track.js';
import {planCamera, STEP} from '../src/cinema-camera.js';

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

  test('long-track convolution yields without changing the camera', async () => {
    const a = straight(16385);
    for (let tick = 0; tick < a.count; tick++) {
      a.position[tick * 3 + 1] = Math.sin(tick / 90) * 100;
      if (tick === 7000) a.cut[tick] = 1;
    }
    const reference = await planCamera({a});
    const planned = await planCamera({a, yieldTask: async () => ({didTimeout: true, timeRemaining: () => 0})});
    expect(planned).toEqual(reference);
  });

  test('cancellation discards long-track preparation', async () => {
    const a = straight(16385);
    let current = true;
    const planned = await planCamera({a, yieldTask: async () => {
      current = false;
      return {didTimeout: true, timeRemaining: () => 0};
    }, isCurrent: () => current});
    expect(planned).toBeNull();
  });

  test('final validation respects a bounded native-trace workload between opportunities to render', async () => {
    const a = straight(), budget = 3;
    let work = 0, previous = 0, longest = 0;
    const plan = await planCamera({a, trace: () => { work++; return 1; },
      yieldTask: async () => {
        longest = Math.max(longest, work - previous);
        previous = work;
        const start = work;
        return {didTimeout: false, timeRemaining: () => Math.max(0, budget - (work - start))};
      },
    });
    longest = Math.max(longest, work - previous);
    expect(plan).toEqual(await planCamera({a, trace: () => 1}));
    expect(longest).toBeLessThanOrEqual(budget);
  });

  test('blocked fallback searches respect the native-trace budget and keep the camera at the visible body', async () => {
    const a = straight(), budget = 3;
    let work = 0, previous = 0, longest = 0;
    const plan = await planCamera({a,
      trace: () => { work++; return 0; },
      yieldTask: async () => {
        longest = Math.max(longest, work - previous);
        previous = work;
        const start = work;
        return {didTimeout: false, timeRemaining: () => Math.max(0, budget - (work - start))};
      },
    });
    longest = Math.max(longest, work - previous);
    expect(longest).toBeLessThanOrEqual(budget);
    for (let sample = 0; sample < plan.count; sample++) {
      expect(plan.eye[sample * 3]).toBe(Math.min(a.count - 1, sample * STEP) * 20);
      expect(plan.eye[sample * 3 + 1]).toBe(0);
      expect(plan.eye[sample * 3 + 2]).toBe(40);
    }
  });

  test('sparse fallback checks cancellation even when no affected sample is a slice boundary', async () => {
    const a = straight();
    let current = true;
    const plan = await planCamera({a,
      // Cancel during an obstructed route-candidate search, not during the
      // initial composition. No partially prepared plan should be published.
      trace: (from, to) => {
        if (routeCandidate(from, to)) {
          current = false;
          return 0;
        }
        return from.x === 238 * 20 && to.z > 40 ? 0 : 1;
      },
      isCurrent: () => current,
      yieldTask: async () => ({didTimeout: false, timeRemaining: () => 50}),
    });
    expect(current).toBe(false);
    expect(plan).toBeNull();
  });
});
