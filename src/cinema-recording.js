// Shared by the main-thread fallback and the retained native index Session.
const JUMP_UNITS = 600;
const TELEPORTS = new Set(['fall', 'teleport', 'restart', 'stage-restarted', 'stage-return']);

export function createTrack(count, dt) {
  return {dt, count, position: new Float32Array(count * 3), yaw: new Float32Array(count), ducked: new Uint8Array(count), elapsed: new Float64Array(count),
    normal: new Float32Array(count * 3), cut: new Uint8Array(count), start: 0, startTick: null, finish: count - 1, splits: [], time: null};
}

function rampNormal(contacts, from, groundNormal) {
  for (let i = from; i < contacts.length; i++) {
    const normal = contacts[i]?.normal;
    if (normal && Number.isFinite(normal.x) && Number.isFinite(normal.y) && normal.z > 0.02 && normal.z < groundNormal) return normal;
  }
  return null;
}

// Observe, never advance, the real simulation. Initial landing can rewrite the
// prefix, so consumers publish it only once landing (or a running clock) exists.
export function captureTrack(shadow, replay, {base = shadow.state.tick ?? replay.initialState?.tick ?? 0, normalizeLanding = true} = {}) {
  const dt = Number.isFinite(shadow.config?.dt) && shadow.config.dt > 0 ? shadow.config.dt : 0.015;
  const groundNormal = Number.isFinite(shadow.config?.groundNormal) ? shadow.config.groundNormal : 0.7;
  const track = createTrack(replay.commands.length + 1, dt);
  track.phase = new Uint8Array(track.count);
  let index = 0, normal = null, startTick = null, splits = 0, landed = normalizeLanding ? null : 0;
  const keep = at => {
    const state = shadow.state, p = state.position, o = at * 3;
    if (landed === null && (state.grounded || state.grounded === undefined)) landed = at;
    track.position[o] = p.x; track.position[o + 1] = p.y; track.position[o + 2] = p.z;
    track.yaw[at] = state.yaw;
    track.ducked[at] = state.ducked ? 1 : 0;
    if (normal) { track.normal[o] = normal.x; track.normal[o + 1] = normal.y; track.normal[o + 2] = normal.z; }
    if (at && Math.hypot(p.x - track.position[o - 3], p.y - track.position[o - 2], p.z - track.position[o - 1]) > JUMP_UNITS) track.cut[at] = 1;
    const timer = shadow.timer?.state;
    if (Number.isFinite(timer?.elapsed)) track.elapsed[at] = timer.elapsed;
    track.phase[at] = timer?.phase === 'finished' ? 2 : timer?.phase === 'running' ? 1 : 0;
    if (track.phase[at] && landed === null) landed = 0;
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
    if (landed === at) for (let before = 0; before < at; before++) track.position.copyWithin(before * 3, at * 3, at * 3 + 3);
  };
  let movement, slide, step, restored = true;
  const observe = () => {
    movement = shadow.movement; slide = movement.slide; step = shadow.step;
    movement.slide = function (state, result) {
      if (state.grounded) return slide.apply(this, arguments);
      const firstContact = result.contacts.length;
      const returned = slide.apply(this, arguments);
      normal ??= rampNormal(result.contacts, firstContact, groundNormal);
      return returned;
    };
    shadow.step = function (...args) {
      normal = null;
      const events = step.apply(this, args);
      keep(++index);
      if (events.some(event => TELEPORTS.has(event))) track.cut[index] = 1;
      return events;
    };
    restored = false;
  };
  observe();
  keep(0);
  return {
    track,
    get count() { return index + 1; },
    get publishable() { return landed !== null; },
    dispose() {
      if (restored) return;
      restored = true;
      movement.slide = slide;
      shadow.step = step;
    },
    follow(session) {
      this.dispose();
      shadow = session;
      observe();
    },
    finish() {
      if (track.time !== null && track.splits.at(-1) === track.finish) track.splits.pop();
      this.dispose();
      return track;
    },
  };
}

export const TRACK_ARRAYS = ['position', 'normal', 'yaw', 'ducked', 'elapsed', 'phase', 'cut'];

export function trackSlice(track, from, end) {
  const count = end - from;
  const out = {...track, count,
    start: Math.max(0, Math.min(count - 1, track.start - from)), startTick: track.startTick === null ? null : track.startTick - from,
    finish: Math.max(0, Math.min(count - 1, track.finish - from)), splits: track.splits.filter(at => at >= from && at < end).map(at => at - from)};
  for (const key of TRACK_ARRAYS) {
    const size = key === 'position' || key === 'normal' ? 3 : 1;
    out[key] = track[key]?.subarray(from * size, end * size);
  }
  return out;
}
