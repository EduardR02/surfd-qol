// The HUD's own analysis (movement metrics and start feedback) at the ticks
// where the game keeps replay keyframes. A seek in the game's player restores
// its nearest keyframe and steps forward from it; restoring the analysis
// kept at that same tick lets the HUD show exactly what it showed when the
// replay first played through there.
export const FRAME_TICKS = 128;
// About ten minutes of native keyframes; evicted seeks use replay-gap analysis.
export const MAX_FRAMES = 320;

// coaching: {save(), restore(state)}.
export function createCoachingFrames(coaching) {
  const frames = new Map();
  let broken = false;
  return {
    get size() { return frames.size; },
    clear() { frames.clear(); broken = false; },
    keep(tick) {
      if (broken || !(tick > 0) || tick % FRAME_TICKS || frames.has(tick)) return;
      try {
        const state = coaching.save();
        if (frames.size === MAX_FRAMES) frames.delete(frames.keys().next().value);
        frames.set(tick, state);
      } catch { broken = true; frames.clear(); }
    },
    // False when nothing was kept at that tick.
    restore(tick) {
      if (!frames.has(tick)) return false;
      try { coaching.restore(frames.get(tick)); return true; }
      catch { broken = true; frames.clear(); return false; }
    },
  };
}
