import {describe, expect, test} from 'bun:test';
import {createCoachingFrames, FRAME_TICKS, MAX_FRAMES} from '../src/replay-frames.js';

describe('HUD analysis at replay keyframes', () => {
  test('kept only at keyframe ticks, once each, and restored exactly there', () => {
    let state = 0, saves = 0;
    const frames = createCoachingFrames({save: () => { saves++; return {state}; }, restore: saved => { state = saved.state; }});
    for (let tick = 0; tick <= 3 * FRAME_TICKS; tick++) { state = tick * 10; frames.keep(tick); }
    frames.keep(FRAME_TICKS);
    expect([frames.size, saves]).toEqual([3, 3]);
    expect(frames.restore(2 * FRAME_TICKS)).toBe(true);
    expect(state).toBe(2 * FRAME_TICKS * 10);
    // Nothing at the start or between keyframes: the caller clears instead.
    expect(frames.restore(0)).toBe(false);
    expect(frames.restore(FRAME_TICKS + 1)).toBe(false);
    frames.clear();
    expect(frames.restore(FRAME_TICKS)).toBe(false);
  });

  test('analysis that cannot be copied just goes without frames', () => {
    const frames = createCoachingFrames({save() { throw new Error('unfinished tick'); }, restore() {}});
    frames.keep(FRAME_TICKS);
    frames.keep(2 * FRAME_TICKS);
    expect(frames.size).toBe(0);
  });

  test('long native replays evict old analysis without losing recent keyframes', () => {
    let state = 0;
    const frames = createCoachingFrames({save: () => state, restore: saved => { state = saved; }});
    for (let i = 1; i <= MAX_FRAMES + 10; i++) { state = i; frames.keep(i * FRAME_TICKS); }
    expect(frames.size).toBe(MAX_FRAMES);
    expect(frames.restore(10 * FRAME_TICKS)).toBe(false);
    expect(frames.restore((MAX_FRAMES + 10) * FRAME_TICKS)).toBe(true);
    expect(state).toBe(MAX_FRAMES + 10);
  });

  test('failed restore falls back safely and clearing invalidated settings permits recovery', () => {
    let fail = true, state = 0;
    const frames = createCoachingFrames({save: () => state, restore: saved => {
      if (fail) throw new Error('incompatible analysis');
      state = saved;
    }});
    frames.keep(FRAME_TICKS);
    expect(frames.restore(FRAME_TICKS)).toBe(false);
    expect(frames.size).toBe(0);
    fail = false;
    frames.clear();
    frames.keep(FRAME_TICKS);
    state = 1;
    expect(frames.restore(FRAME_TICKS)).toBe(true);
    expect(state).toBe(0);
  });
});
