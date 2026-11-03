// A replay as a track: where the player was on every tick, which way they
// faced, whether they crouched and which ramp they were surfing. Compare plays
// one run in the game's own player and draws the others from their tracks;
// recorded windows can already be viewed while the rest is being simulated.
import {MAX_COMMANDS} from './replay-store.js';
import {captureTrack} from './cinema-recording.js';
export {createTrack} from './cinema-recording.js';

const SLICE_COMMANDS = 64;
const defer = () => new Promise(resolve => typeof requestIdleCallback === 'function'
  ? requestIdleCallback(resolve, {timeout: 50}) : setTimeout(resolve, 0));
const idleLeft = deadline => !!deadline && !deadline.didTimeout && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() > 2;

// Linear interpolation at a fractional index, into out {x, y, z}.
export function trackPoint(track, at, out = {x: 0, y: 0, z: 0}) {
  const last = track.count - 1;
  const index = Math.max(0, Math.min(last, at));
  const low = Math.floor(index), high = Math.min(last, low + 1), t = track.cut[high] ? 0 : index - low;
  const p = track.position;
  out.x = p[low * 3] + (p[high * 3] - p[low * 3]) * t;
  out.y = p[low * 3 + 1] + (p[high * 3 + 1] - p[low * 3 + 1]) * t;
  out.z = p[low * 3 + 2] + (p[high * 3 + 2] - p[low * 3 + 2]) * t;
  return out;
}
// Yaw in degrees at a fractional index, the short way round.
export function trackYaw(track, at) {
  const last = track.count - 1, index = Math.max(0, Math.min(last, at));
  const low = Math.floor(index), high = Math.min(last, low + 1);
  const a = track.yaw[low], delta = ((track.yaw[high] - a + 540) % 360) - 180;
  return a + delta * (track.cut[high] ? 0 : index - low);
}


// Re-simulates the replay on the loaded map in idle-time slices. Null when it
// isn't for this map, is too long, or stops being wanted (isCurrent()).
// onProgress borrows the first `count` recorded positions, never the suffix.
// Only the shadow movement instance is observed; callbacks run between batches.
export async function recordTrack({adapter, session, replay, isCurrent = () => true, yieldTask = defer, onProgress = null, signal = null}) {
  if (typeof adapter?.Session !== 'function' || typeof adapter.Movement !== 'function' || !session?.map ||
    !Array.isArray(replay?.commands) || !replay.commands.length || replay.commands.length > MAX_COMMANDS ||
    replay.mapId !== session.map.id || replay.mapVersion !== session.map.version) return null;
  const worker = adapter.cinema?.worker?.(session, replay);
  if (worker) {
    try {
      const playback = adapter.replay?.playback?.();
      const track = await worker.record({replay, onProgress, signal, tick: playback?.replay === replay ? playback.index ?? 0 : 0});
      if (!isCurrent() || signal?.aborted) return null;
      if (track) return track;
    } catch {
      if (!isCurrent() || signal?.aborted) return null;
      // Unsupported or failed workers keep the original native fallback.
    }
  }
  let deadline = await yieldTask();
  if (!isCurrent() || signal?.aborted) return null;
  const shadow = new adapter.Session(session.map, replay.config, replay.format);
  shadow.loadReplay(replay);
  const capture = captureTrack(shadow, replay);
  let index = 0;
  try {
    while (index < replay.commands.length) {
      if (!isCurrent() || signal?.aborted) return null;
      const end = Math.min(index + SLICE_COMMANDS, replay.commands.length);
      while (index < replay.commands.length && (index < end || idleLeft(deadline))) shadow.step(replay.commands[index++]);
      if (capture.publishable && isCurrent()) onProgress?.(capture.track, capture.count);
      if (index < replay.commands.length) deadline = await yieldTask();
    }
    return isCurrent() ? capture.finish() : null;
  } finally { capture.dispose(); }
}
