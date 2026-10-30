// A replay as a track: where the player was on every tick, which way they
// faced, whether they crouched and which ramp they were surfing. Compare plays
// one run in the game's own player and draws the other from its track; the
// camera is planned from both before playback starts.
import {observePhysics} from './observer.js';
import {MAX_COMMANDS} from './replay-store.js';

const SLICE_COMMANDS = 64;
const defer = () => new Promise(resolve => typeof requestIdleCallback === 'function'
  ? requestIdleCallback(resolve, {timeout: 50}) : setTimeout(resolve, 0));
const idleLeft = deadline => !!deadline && !deadline.didTimeout && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() > 2;
// A move this far within one tick is treated as a teleport: the camera cuts there.
const JUMP_UNITS = 600;
const TELEPORTS = new Set(['fall', 'teleport', 'restart', 'stage-restarted', 'stage-return']);

// Positions of index i are the state after i commands, so a track has one
// more entry than the replay has commands.
export function createTrack(count, dt) {
  // elapsed is the game's own run clock on each tick, 0 before the start.
  return {dt, count, position: new Float32Array(count * 3), yaw: new Float32Array(count), ducked: new Uint8Array(count), elapsed: new Float64Array(count),
    normal: new Float32Array(count * 3), cut: new Uint8Array(count), start: 0, startTick: null, finish: count - 1, splits: [], time: null};
}

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

// Native surf planes have normal.z above a small floor and below groundNormal.
function rampNormal(contacts, from, groundNormal) {
  for (let i = from; i < contacts.length; i++) {
    const normal = contacts[i]?.normal;
    if (normal && Number.isFinite(normal.x) && Number.isFinite(normal.y) && normal.z > 0.02 && normal.z < groundNormal) return normal;
  }
  return null;
}

// Re-simulates the replay on the loaded map in idle-time slices. Null when it
// isn't for this map, is too long, or stops being wanted (isCurrent()).
export async function recordTrack({adapter, session, replay, isCurrent = () => true, yieldTask = defer}) {
  if (typeof adapter?.Session !== 'function' || typeof adapter.Movement !== 'function' || !session?.map ||
    !Array.isArray(replay?.commands) || !replay.commands.length || replay.commands.length > MAX_COMMANDS ||
    replay.mapId !== session.map.id || replay.mapVersion !== session.map.version) return null;
  let deadline = await yieldTask();
  if (!isCurrent()) return null;
  const shadow = new adapter.Session(session.map, replay.config, replay.format);
  shadow.loadReplay(replay);
  const dt = Number.isFinite(shadow.config?.dt) && shadow.config.dt > 0 ? shadow.config.dt : 0.015;
  const groundNormal = Number.isFinite(shadow.config?.groundNormal) ? shadow.config.groundNormal : 0.7;
  const track = createTrack(replay.commands.length + 1, dt);
  track.phase = new Uint8Array(track.count);
  const base = shadow.state.tick ?? replay.initialState?.tick ?? 0;
  let index = 0, normal = null, active = null, startTick = null, splits = 0;
  const keep = at => {
    const state = shadow.state, p = state.position, o = at * 3;
    track.position[o] = p.x; track.position[o + 1] = p.y; track.position[o + 2] = p.z;
    track.yaw[at] = state.yaw;
    track.ducked[at] = state.ducked ? 1 : 0;
    if (normal) { track.normal[o] = normal.x; track.normal[o + 1] = normal.y; track.normal[o + 2] = normal.z; }
    if (at && Math.hypot(p.x - track.position[o - 3], p.y - track.position[o - 2], p.z - track.position[o - 1]) > JUMP_UNITS) track.cut[at] = 1;
    const timer = shadow.timer?.state;
    if (Number.isFinite(timer?.elapsed)) track.elapsed[at] = timer.elapsed;
    track.phase[at] = timer?.phase === 'finished' ? 2 : timer?.phase === 'running' ? 1 : 0;
    if (track.phase[at] && (startTick !== timer.startTick || track.startTick === null)) {
      startTick = timer.startTick;
      track.startTick = Number.isFinite(startTick) ? startTick - base : at;
      track.start = Math.max(0, Math.min(track.count - 1, Math.ceil(track.startTick)));
      track.finish = track.count - 1;
      track.time = null;
      track.splits.length = splits = 0;
    }
    const count = Array.isArray(timer?.splits) ? timer.splits.length : 0;
    while (splits < count) { splits++; track.splits.push(at); }
    if (timer?.phase === 'finished' && track.time === null) { track.finish = at; track.time = timer.elapsed; }
    if (timer?.phase === 'ready') startTick = null;
  };
  // Only ramp contacts are wanted, so the other observer callbacks do nothing.
  const contacts = {begin() {}, end() {}, acceleration() {}, reset() {},
    collision(collision) { normal ??= rampNormal(collision.contacts ?? [], collision.firstContact ?? 0, groundNormal); }};
  const shadowAdapter = {Session: adapter.Session, Movement: adapter.Movement, getSession: () => active};
  keep(0);
  while (index < replay.commands.length) {
    if (!isCurrent()) return null;
    // Observers never survive an await: the game's own ticks run in between.
    const observer = observePhysics(shadowAdapter, contacts);
    active = shadow;
    try {
      const end = Math.min(index + SLICE_COMMANDS, replay.commands.length);
      while (index < replay.commands.length && (index < end || idleLeft(deadline))) {
        normal = null;
        const events = shadow.step(replay.commands[index++]);
        keep(index);
        if (events.some(event => TELEPORTS.has(event))) track.cut[index] = 1;
        // A start-zone re-entry resets only the clock, not the physics path.
        // keep() follows the final departure, including sub-tick startTick.
      }
    } finally {
      active = null;
      observer.destroy();
    }
    if (index < replay.commands.length) deadline = await yieldTask();
  }
  if (!isCurrent()) return null;
  // The finish counts as a split in the game's timer; keep checkpoints only.
  if (track.time !== null && track.splits.at(-1) === track.finish) track.splits.pop();
  return track;
}
