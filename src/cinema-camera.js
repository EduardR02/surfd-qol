// Camera shots planned from a recorded route or a window around the playhead.
// Each choice is smoothed both ways in time, so moves can begin before the
// ramp or landing that calls for them. A complete route uses the same math
// and can replace its initial window while playback continues.
//
// The shots follow the played run's route. On a ramp the camera is out on its
// open side (the side its face looks to), so the ramp never hides the ghosts,
// and low, so the dip and climb read as down and up; in flight it follows
// behind and leads towards where they'll land. Two styles (STYLES): steady
// keeps one three-quarter chase throughout; cinematic varies the shot from
// ramp to ramp and flight to flight (alongside, ahead as they come towards it,
// low along the face, beside a long flight's arc), drifts round the
// prestrafe, opens wider after a teleport and pulls back at the finish. The
// view widens a little with speed.
// Obstructed shots first get conservative turning/pull-in corrections, then a
// bounded local trajectory search tries to recover a wide connected view of
// the group. A fixed orbit/radius/lift with moving endpoint tangents is tried
// first, then a small connected beam proposes a cubic control corridor. Stored
// chords, native body sightlines, screen separation and ridden faces validate
// the resulting curve, never merely its individually safe control poses.
// Windows retain both shoulders without overwriting an earlier repair; clear
// shots outside those local joins keep their original composition exactly.
// The final eye is still clipped against the played run's sightline where no
// connected shot fits, even below the preferred minimum distance.
import {trackPoint, trackYaw} from './cinema-track.js';

export const STEP = 2;               // ticks per planned sample
// A shot: swing from behind towards the open side and elevation in degrees
// (to: the swing a shot they pass ends on), distance as a multiple of the
// speed-based one, and room ahead as a share of the distance.
const CHASE = {swing: 36, elevation: 9, distance: 1, lead: 0.16};
const FACE = {swing: 72, elevation: 14, distance: 1.45, lead: 0.32};                // from the open side onto the face, a little ahead: the clearest view of the lines
const TRACK = {swing: 65, elevation: 4, distance: 1.5, lead: 0.26};                 // three-quarter alongside, at body height
const LOW = {swing: 40, elevation: -6, distance: 1.1, lead: 0.2};                   // near the face, along and up it
const FRONT = {swing: 155, to: 105, elevation: 5, distance: 1.4, lead: 0};          // ahead; they come towards it and pass
const FLIGHT = {swing: 0, elevation: 11, distance: 1.25, lead: 0.16};               // behind, the landing ahead
const ARC = {swing: 72, elevation: 3, distance: 1.5, lead: 0.24};                   // beside a long flight's rise and fall
const STEADY = {swing: 62, elevation: 12, distance: 1.3, lead: 0.26};
// Per style: the shots ramps take in turn by length (under MEDIUM_RAMP,
// under LONG_RAMP, longer), and those for a ramp with one on the other side
// within CRAMPED seconds (gentle: there's no time to swing far out and back);
// the shots flights longer than LONG_FLIGHT take in turn (beside them only
// where that doesn't cross the line); the shots in other flight and before
// the start; how far round the start drifts (degrees); a teleport's opening
// and the finish's rise (degrees), widening and drift round; the share of
// the way to a landing the view leads by; the fov's widening at speed; how
// long shots take to ease into each other (seconds either side). Shots never
// cut into each other, only teleports cut.
const STYLES = {
  cinematic: {
    ramps: [[CHASE], [FACE, LOW], [FACE, TRACK, FACE, LOW]], front: FRONT, gentle: [LOW, CHASE], flights: [ARC, FLIGHT],
    flight: FLIGHT, start: {swing: 0, elevation: 10, distance: 1.45, lead: 0.1},
    orbit: 70, establish: {rise: 16, widen: 0.8}, finish: {rise: 12, widen: 1.2, swing: 30}, landing: 0.3, fov: 10, transition: 0.5,
  },
  steady: {
    ramps: [[STEADY], [STEADY], [STEADY]], gentle: [STEADY], flights: [],
    flight: {swing: 0, elevation: 11, distance: 1.2, lead: 0.16}, start: {swing: 0, elevation: 10, distance: 1.15, lead: 0.12},
    orbit: 0, establish: {rise: 0, widen: 0}, finish: {rise: 6, widen: 0.4, swing: 0}, landing: 0.15, fov: 6, transition: 0.55,
  },
};
// Flights longer than LONGEST_FLIGHT (running, hopping) keep the plain flight shot.
const MEDIUM_RAMP = 0.7, LONG_RAMP = 1.3, CRAMPED = 0.9, LONG_FLIGHT = 1.1, LONGEST_FLIGHT = 5;
// Seen from ahead or straight behind, travel collapses into depth, so most
// shots look from three-quarters. The style's front shot is an event: only
// on ramps of at least FRONT_RAMP seconds, at most once every FRONT_GAP.
const FRONT_RAMP = 1.6, FRONT_GAP = 10;
// Contact gaps under RAMP_GAP seconds are the same ramp; touches under RAMP_MIN aren't one.
const RAMP_GAP = 0.2, RAMP_MIN = 0.3, SAME_FACE = Math.cos(40 * Math.PI / 180);
// In flight the swing keeps this share of both ramps' swings: back behind
// between opposite sides, still out to the side between two on the same side.
const FLIGHT_SWING = 0.35;
// Within AXIS degrees of straight behind or ahead, a shot isn't beside them.
const AXIS = 20;
// The view leads towards a landing at most this many seconds away.
const LANDING_AHEAD = 3;
// Before the start the camera drifts round to behind at ORBIT_RATE degrees a second.
const ORBIT_RATE = 14;
// A teleport's opening view settles over ESTABLISH seconds; the finish pulls back over FINISH.
const ESTABLISH = 1.6, FINISH = 2.5;
// Arriving over a ramp's ridge, its shot waits until they're on the face;
// leaving over it (or round its back), the shot ends early, so the camera is
// up behind them, not caught on the far side of the ramp.
const OVER_RIDGE = 0.4;
// Near behind, the camera stays at least this high above the ghosts (degrees),
// clear of the face they ride along; only out to the side can it go low.
const BEHIND_LOW = 8;
// The conservative baseline retries a persistently blocked stretch with its
// safest shot. Local repair may replace it, but never weakens that fallback.
const RETREAT_ELEVATION = 10, RETREAT = 0.45, TROUBLE = 0.25;
// The lead turns the view from the ghosts by at most this much (degrees).
const LEAD_TURN = 14;
// Where the composed view would still turn faster than this (degrees a
// second), as when a shot's move meets a bend in the route, the eye glides.
const TURN_LIMIT = 110;
// A group strung out along the route lines up in depth from behind or ahead,
// but from the side it needs a long way back to fit across the frame, which
// walls rarely allow: as the group's span over a shot grows from SPREAD_NEAR
// to SPREAD_FAR, a shot from behind swings out only SPREAD_SWING as far.
const SPREAD_NEAR = 800, SPREAD_FAR = 3000, SPREAD_SWING = 0.8;
// While a framed ghost rides a face, the camera stays at least this far
// (degrees, seen from the ghost) above the face's plane, so the ramp never
// hides them, even passing behind them onto a new ramp.
const FACE_MARGIN = 6;
// Other runs' faces lift the camera no higher than this (degrees).
const OTHER_FACE_MAX = 18;
// The camera stays back far enough to keep the map around the ghosts in view;
// only walls bring it nearer than BASE_DISTANCE. Speed and the shot widen it.
const BASE_DISTANCE = 300, MAX_DISTANCE = 2400, MIN_DISTANCE = 70, SPEED_DISTANCE = 0.07;
// The group shot keeps a run in frame until it's this far from the others
// (fading out between the two), so the camera only leaves one far behind.
const GROUP_NEAR = 2500, GROUP_FAR = 6000;
// The view in the game's horizontal (4:3) degrees, widening (by the style's fov) between these speeds.
export const FOV = 74;
const FOV_SLOW = 1200, FOV_FAST = 3500;
const EYE_HEIGHT = 40;               // aim at the body, not the feet
const LEAD_MAX = 320;
const CLEARANCE = 14;
// Detours tried when the planned spot is blocked: [swing, rise] in degrees.
// Preserve the conservative baseline; expanded downward routes are validated
// locally against every protected body, face and stored connecting chord.
const DETOURS = [[0, 0], [18, 0], [-18, 0], [0, 16], [0, -14], [36, 6], [-36, 6], [0, 32], [0, -24], [65, 12], [-65, 12]];
const DETOUR_CEILING = DETOURS.map(([turn, up]) => 1 - Math.abs(turn) * 0.004 - Math.max(up * 0.018, -up * 0.005));
const DETOUR_FLOOR = 4;
for (let index = DETOURS.length - 2; index >= 0; index--) DETOUR_CEILING[index] = Math.max(DETOUR_CEILING[index], DETOUR_CEILING[index + 1]);
const TRACE_EVERY = 2;               // samples per occlusion test
const SLICE = 80;
const DEGREES = Math.PI / 180;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const unit = (normals, at, out, offset) => {
  const x = normals[at * 3], y = normals[at * 3 + 1], z = normals[at * 3 + 2], length = Math.hypot(x, y, z) || 1;
  out[offset] = x / length; out[offset + 1] = y / length; out[offset + 2] = z / length;
};
const smoothstep = (low, high, value) => { const t = clamp((value - low) / (high - low), 0, 1); return t * t * (3 - 2 * t); };

// A centred Gaussian blur that never reaches across a cut.
function prepareBlur(values, sigma, segment) {
  const radius = Math.ceil(sigma * 3), weights = new Float32Array(radius + 1), out = new Float32Array(values.length);
  for (let k = 0; k <= radius; k++) weights[k] = Math.exp(-(k * k) / (2 * sigma * sigma));
  // Camera IDs are monotonic; arbitrary labels still use the generic path.
  let ordered = segment instanceof Uint32Array && segment.length >= values.length;
  for (let i = 1; ordered && i < values.length; i++) ordered = segment[i] >= segment[i - 1];
  return {values, segment, radius, weights, out, ordered, from: 0, to: 0};
}

function blurRange(state, start, end) {
  const {values, segment, radius, weights, out, ordered} = state;
  let {from, to} = state;
  for (let i = start; i < end; i++) {
    let total = values[i], weight = 1;
    if (ordered) {
      if (i >= to) {
        from = i;
        to = i + 1;
        while (to < values.length && segment[to] === segment[i]) to++;
      }
      const left = Math.min(radius, i - from), right = Math.min(radius, to - i - 1), last = Math.max(left, right);
      for (let k = 1; k <= last; k++) {
        if (k <= left) { total += values[i - k] * weights[k]; weight += weights[k]; }
        if (k <= right) { total += values[i + k] * weights[k]; weight += weights[k]; }
      }
    } else {
      for (let k = 1; k <= radius; k++) {
        if (i - k >= 0 && segment[i - k] === segment[i]) { total += values[i - k] * weights[k]; weight += weights[k]; }
        if (i + k < values.length && segment[i + k] === segment[i]) { total += values[i + k] * weights[k]; weight += weights[k]; }
      }
    }
    out[i] = total / weight;
  }
  state.from = from; state.to = to;
}

export function blur(values, sigma, segment) {
  if (sigma <= 0) return values.slice();
  const state = prepareBlur(values, sigma, segment);
  blurRange(state, 0, values.length);
  return state.out;
}
// The value furthest from zero within radius, so a rise or drop is held
// across the whole obstruction instead of blurring into one that clips.
function strongest(values, radius, segment) {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let pick = values[i];
    for (let k = Math.max(0, i - radius); k <= Math.min(values.length - 1, i + radius); k++) if (segment[k] === segment[i] && Math.abs(values[k]) > Math.abs(pick)) pick = values[k];
    out[i] = pick;
  }
  return out;
}
// The smallest value within radius, so a pull-in starts before the obstruction.
function lowest(values, radius, segment) {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let min = values[i];
    for (let k = Math.max(0, i - radius); k <= Math.min(values.length - 1, i + radius); k++) if (segment[k] === segment[i] && values[k] < min) min = values[k];
    out[i] = min;
  }
  return out;
}

// The ramps run a surfs, from its per-sample ramp normals (0 off a ramp), as
// {from, to} sample ranges with the side their face looks to (1 right of
// travel, -1 left) and when their shot holds (start, end).
function findRamps(rampX, rampY, segment, runs, travel, samples) {
  const ramps = [];
  let open = null;
  const close = () => { if (open && open.to - open.from >= samples(RAMP_MIN)) ramps.push(open); open = null; };
  for (let s = 0; s < rampX.length; s++) {
    const on = rampX[s] !== 0 || rampY[s] !== 0;
    if (open && (segment[s] !== segment[open.to] || s - open.to > samples(RAMP_GAP) ||
      on && rampX[s] * rampX[open.to] + rampY[s] * rampY[open.to] < SAME_FACE)) close();
    if (!on) continue;
    if (open) open.to = s; else open = {from: s, to: s};
  }
  close();
  for (const ramp of ramps) {
    let nx = 0, ny = 0;
    for (let s = ramp.from; s <= ramp.to; s++) { nx += rampX[s]; ny += rampY[s]; }
    let fx = runs[ramp.to * 3] - runs[ramp.from * 3], fy = runs[ramp.to * 3 + 1] - runs[ramp.from * 3 + 1];
    if (Math.hypot(fx, fy) < 1) { const middle = (ramp.from + ramp.to) >> 1; fx = travel[0][middle]; fy = travel[1][middle]; }
    // Right of travel is (fy, -fx) with z up.
    ramp.side = fy * nx - fx * ny >= 0 ? 1 : -1;
    // Coming from behind the face (over the ridge), or going there.
    const length = Math.hypot(nx, ny) || 1, before = Math.max(0, ramp.from - Math.round(samples(0.5))), after = Math.min(rampX.length - 1, ramp.to + Math.round(samples(0.5)));
    const behind = s => ((runs[s * 3] - runs[ramp.from * 3]) * nx + (runs[s * 3 + 1] - runs[ramp.from * 3 + 1]) * ny) / length < -50;
    ramp.start = ramp.from + (segment[before] === segment[ramp.from] && behind(before) ? Math.round(samples(OVER_RIDGE)) : 0);
    ramp.end = ramp.to - (segment[after] === segment[ramp.to] && behind(after) ? Math.round(samples(OVER_RIDGE)) : 0);
    if (ramp.end < ramp.start) ramp.start = ramp.end = (ramp.from + ramp.to) >> 1;
  }
  return ramps;
}

// The route as stretches, in order: each ramp's shot window and the flight
// between (broken at the start sample, first), each with its shot and signed
// swing at its start and end (swing, last). Ramps of each length and long
// flights take the style's shots in turn; spread(from, to) scales a shot from
// behind for a strung-out group.
function planStretches(ramps, segment, count, first, look, samples, spread, safe) {
  const stretches = [], turns = look.ramps.map(() => 0);
  let flights = 0, gentle = 0, front = -Infinity;
  for (let s = 0, next = 0; s < count;) {
    let end = s;
    while (end + 1 < count && segment[end + 1] === segment[s]) end++;
    for (; next < ramps.length && ramps[next].from <= end; next++) {
      const ramp = ramps[next];
      if (s < first && first < ramp.start) { stretches.push({from: s, to: first - 1}); s = first; }
      if (ramp.start > s) stretches.push({from: s, to: ramp.start - 1});
      stretches.push({from: ramp.start, to: ramp.end, ramp});
      s = ramp.end + 1;
    }
    if (s < first && first <= end) { stretches.push({from: s, to: first - 1}); s = first; }
    if (s <= end) stretches.push({from: s, to: end});
    s = end + 1;
  }
  const out = (side, degrees, k) => side * (Math.abs(degrees) > 90 ? degrees : degrees * k) * DEGREES;
  let rampIndex = 0;
  stretches.forEach((stretch, index) => {
    const k = spread(stretch.from, stretch.to), ramp = stretch.ramp;
    if (ramp) {
      const length = ramp.to - ramp.from, kind = length < samples(MEDIUM_RAMP) ? 0 : length < samples(LONG_RAMP) ? 1 : 2;
      const at = rampIndex++, near = other => other && segment[other.from] === segment[ramp.from] && other.side !== ramp.side &&
        Math.min(Math.abs(other.from - ramp.to), Math.abs(ramp.from - other.to)) < samples(CRAMPED);
      const cramped = kind && (near(ramps[at - 1]) || near(ramps[at + 1]));
      let shot = cramped ? look.gentle[gentle++ % look.gentle.length] : look.ramps[kind][turns[kind]++ % look.ramps[kind].length];
      if (look.front && !cramped && length >= samples(FRONT_RAMP) && ramp.from - front >= samples(FRONT_GAP)) { shot = look.front; front = ramp.from; }
      if (safe.has(stretch.from)) shot = look.gentle.at(-1);
      stretch.shot = shot;
      stretch.swing = out(ramp.side, shot.swing, k);
      stretch.last = out(ramp.side, shot.to ?? shot.swing, k);
      return;
    }
    const joined = other => other && segment[other.from] === segment[stretch.from] ? other.ramp : null;
    const before = joined(stretches[index - 1]), after = joined(stretches[index + 1]);
    stretch.landing = after;
    const length = stretch.to - stretch.from;
    if (look.flights.length && (before || after) && length >= samples(LONG_FLIGHT) && length <= samples(LONGEST_FLIGHT) && !safe.has(stretch.from)) {
      const sides = [before?.side, after?.side].filter(Boolean);
      for (let tries = 0; tries < look.flights.length && !stretch.shot; tries++) {
        const shot = look.flights[flights++ % look.flights.length];
        // Beside them only where both ramps (or the one there is) share the side.
        if (shot.swing > AXIS && shot.swing < 180 - AXIS && !(sides.length && sides.every(side => side === sides[0]))) continue;
        stretch.shot = shot;
      }
      if (stretch.shot && stretch.shot !== look.flight) {
        const side = after?.side ?? before?.side ?? 1;
        stretch.swing = out(side, stretch.shot.swing, k);
        stretch.last = out(side, stretch.shot.to ?? stretch.shot.swing, k);
        if (Math.abs(stretch.shot.swing) > 90) stretch.landing = null;
        return;
      }
    }
    stretch.shot = look.flight;
    stretch.swing = stretch.last = 0;
  });
  // A plain flight blends the ramps either side; a safe one stays behind.
  stretches.forEach((stretch, index) => {
    if (stretch.shot !== look.flight || stretch.ramp || safe.has(stretch.from)) return;
    const near = other => other && segment[other.from] === segment[stretch.from] ? other : null;
    const before = near(stretches[index - 1]), after = near(stretches[index + 1]);
    stretch.swing = stretch.last = FLIGHT_SWING * ((before?.last ?? 0) + (Math.abs(after?.swing ?? 0) > 90 * DEGREES ? 0 : after?.swing ?? 0));
  });
  return stretches;
}

// Which side of the travel a swing is on: 1 right, -1 left, 0 near the axis.

// trace(from, to) is the clear fraction of the way, 1 when nothing is hit.
// others: [{track, map}], each run and where it is for each of a's ticks
// ({b, map} for a single one). group frames every run together; without it
// the camera is on run a alone, the others passing through its shot.
// style is 'cinematic' or 'steady' (see STYLES).
// Returns {count, eye, target, fov, segment, cutTick}: one entry every STEP ticks of run a.
export async function planCamera({a, b = null, map = null, others = b ? [{track: b, map}] : [], group = true, style = 'cinematic', trace = null, yieldTask = null, isCurrent = () => true}) {
  const cancelled = Symbol();
  try {
  const look = STYLES[style] ?? STYLES.cinematic;
  const count = Math.ceil(a.count / STEP) + 1;
  const sampleTick = s => Math.min(a.count - 1, s * STEP);
  const seconds = value => value / (a.dt * STEP);
  const focus = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
  const span = new Float32Array(count), speed = new Float32Array(count);
  const rampX = new Float32Array(count), rampY = new Float32Array(count);
  // The face each run rides at each sample (unit normals, 0 off a ramp).
  const faces = [a, ...others].map(() => new Float32Array(count * 3));
  const segment = new Uint32Array(count), cutTick = new Uint32Array(count);
  // Positions of the played run and each other run, and how much each other run counts in the framing.
  const runs = [a, ...others.map(other => other.track)].map(() => new Float32Array(count * 3));
  const shares = others.map(() => new Float32Array(count));
  // Samples since and until each other run's own teleports.
  const since = others.map(() => new Float32Array(count).fill(Infinity)), until = others.map(() => new Float32Array(count).fill(Infinity));
  const point = {x: 0, y: 0, z: 0};
  // Larger preprocessing batches keep 2ms in reserve. Individual collision
  // queries use 0.5ms, so high-refresh idle windows are not surrendered unused.
  let deadline = yieldTask ? await yieldTask() : null;
  if (!isCurrent()) return null;
  const idleLeft = (reserve = 2) => deadline && !deadline.didTimeout && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() > reserve;
  // Long convolutions share one output and kernel, but check the idle budget
  // between bounded ranges. Short tracks retain the synchronous fast path.
  const smooth = async (values, sigma, ids) => {
    if (!yieldTask || values.length < 8192 || sigma <= 0) return blur(values, sigma, ids);
    const state = prepareBlur(values, sigma, ids);
    for (let start = 0; start < values.length; start += 128) {
      if (!idleLeft()) deadline = await yieldTask();
      if (!isCurrent()) throw cancelled;
      blurRange(state, start, Math.min(values.length, start + 128));
    }
    return state.out;
  };
  let cutAt = 0;
  for (let s = 0; s < count; s++) {
    const tick = sampleTick(s), previous = s ? sampleTick(s - 1) : 0;
    let cut = false;
    for (let k = previous + 1; k <= tick && !cut; k++) {
      cut = a.cut[k] === 1;
      if (cut) cutTick[s] = k;
    }
    if (s && cut) cutAt++;
    segment[s] = cutAt;
    for (let index = 0; index < others.length; index++) {
      const {track, map: where} = others[index];
      for (let k = Math.floor(s ? where[previous] : where[tick]) + 1; k <= Math.floor(where[tick]) && !cut; k++)
        if (track.cut[k] === 1) { since[index][s] = until[index][s] = 0; break; }
    }
    // The face run a touched last in this step, as a horizontal direction.
    for (let k = s ? previous + 1 : 0; k <= tick; k++) {
      const nx = a.normal[k * 3], ny = a.normal[k * 3 + 1], length = Math.hypot(nx, ny);
      if (length > 1e-3) { rampX[s] = nx / length; rampY[s] = ny / length; unit(a.normal, k, faces[0], s * 3); }
    }
    trackPoint(a, tick, point);
    runs[0][s * 3] = point.x; runs[0][s * 3 + 1] = point.y; runs[0][s * 3 + 2] = point.z;
    for (let index = 0; index < others.length; index++) {
      const {track, map: where} = others[index];
      trackPoint(track, where[tick], point);
      runs[index + 1][s * 3] = point.x; runs[index + 1][s * 3 + 1] = point.y; runs[index + 1][s * 3 + 2] = point.z;
      const at = Math.max(0, Math.min(track.count - 1, Math.round(where[tick])));
      if (Math.hypot(track.normal[at * 3], track.normal[at * 3 + 1]) > 1e-3) unit(track.normal, at, faces[index + 1], s * 3);
    }
  }
  if (yieldTask && !idleLeft()) deadline = await yieldTask();
  if (!isCurrent()) return null;
  // Another run's teleport doesn't cut the shot (only the played run's do):
  // that run leaves the framing for a moment around it, so the camera glides.
  for (let index = 0; index < others.length; index++) {
    for (let s = 1; s < count; s++) since[index][s] = Math.min(since[index][s], since[index][s - 1] + 1);
    for (let s = count - 2; s >= 0; s--) until[index][s] = Math.min(until[index][s], until[index][s + 1] + 1);
  }
  for (let s = 0; s < count; s++) {
    const o = s * 3, ax = runs[0][o], ay = runs[0][o + 1], az = runs[0][o + 2];
    let fx = ax, fy = ay, fz = az, total = 1;
    for (let index = 0; index < others.length; index++) {
      const r = runs[index + 1];
      // Far off (another line, a skipped stage), a run stops pulling the framing.
      const weight = group ? (1 - smoothstep(GROUP_NEAR, GROUP_FAR, Math.hypot(r[o] - ax, r[o + 1] - ay, r[o + 2] - az))) *
        smoothstep(seconds(0.3), seconds(0.9), Math.min(since[index][s], until[index][s])) : 0;
      shares[index][s] = weight;
      fx += r[o] * weight; fy += r[o + 1] * weight; fz += r[o + 2] * weight; total += weight;
    }
    focus[0][s] = fx / total; focus[1][s] = fy / total; focus[2][s] = fz / total + EYE_HEIGHT;
    let reach = Math.hypot(ax - focus[0][s], ay - focus[1][s], az + EYE_HEIGHT - focus[2][s]);
    for (let index = 0; index < others.length; index++) {
      const r = runs[index + 1];
      reach = Math.max(reach, shares[index][s] * Math.hypot(r[o] - focus[0][s], r[o + 1] - focus[1][s], r[o + 2] + EYE_HEIGHT - focus[2][s]));
    }
    span[s] = reach * 2;
  }
  // Travel: where the focus goes over the next and last third of a second.
  const reach = Math.max(1, Math.round(seconds(0.33)));
  const travel = [new Float32Array(count), new Float32Array(count)], known = new Uint8Array(count);
  // Segment bounds only advance: don't search the same neighbours for every sample.
  let segmentFrom = 0, segmentTo = -1;
  for (let s = 0; s < count; s++) {
    if (s > segmentTo) {
      segmentFrom = s;
      segmentTo = s;
      while (segmentTo + 1 < count && segment[segmentTo + 1] === segment[s]) segmentTo++;
    }
    const from = Math.max(segmentFrom, s - reach), to = Math.min(segmentTo, s + reach);
    const dx = focus[0][to] - focus[0][from], dy = focus[1][to] - focus[1][from];
    speed[s] = to > from ? Math.hypot(dx, dy, focus[2][to] - focus[2][from]) / ((to - from) * a.dt * STEP) : 0;
    const length = Math.hypot(dx, dy);
    if (length >= 4 * (to - from + 1)) { travel[0][s] = dx / length; travel[1][s] = dy / length; known[s] = 1; }
  }
  // Standing still, keep the way they last went (or will go), else where the player looks.
  for (let s = 1; s < count; s++) if (!known[s] && known[s - 1] && segment[s] === segment[s - 1]) { travel[0][s] = travel[0][s - 1]; travel[1][s] = travel[1][s - 1]; known[s] = 1; }
  for (let s = count - 2; s >= 0; s--) if (!known[s] && known[s + 1] && segment[s] === segment[s + 1]) { travel[0][s] = travel[0][s + 1]; travel[1][s] = travel[1][s + 1]; known[s] = 1; }
  for (let s = 0; s < count; s++) if (!known[s]) { const yaw = trackYaw(a, sampleTick(s)) * Math.PI / 180; travel[0][s] = Math.cos(yaw); travel[1][s] = Math.sin(yaw); }

  // The shot each sample asks for, before easing: swing, elevation, distance
  // and lead (see CHASE), and in flight the way to the landing.
  const ramps = findRamps(rampX, rampY, segment, runs[0], travel, seconds);
  // How far a shot from behind may swing out for the group's span over a stretch.
  const spread = (from, to) => {
    let total = 0;
    for (let s = from; s <= to; s++) total += span[s];
    return 1 - (1 - SPREAD_SWING) * smoothstep(SPREAD_NEAR, SPREAD_FAR, total / (to - from + 1));
  };
  const first = Math.min(count - 1, Math.round(a.start / STEP));
  // Before-start travel and these blurs do not depend on the chosen shots.
  // Keep them outside shoot(), which may repeat with safer shots.
  let zone = first;
  while (zone > 0 && segment[zone - 1] === segment[first]) zone--;
  const leave = Math.min(count - 1, first + Math.round(seconds(0.6)));
  const lx = runs[0][leave * 3] - runs[0][first * 3], ly = runs[0][leave * 3 + 1] - runs[0][first * 3 + 1], away = Math.hypot(lx, ly);
  const leaving = zone < first && segment[leave] === segment[first] && away > 50;
  if (leaving) for (let s = zone; s < first; s++) { travel[0][s] = lx / away; travel[1][s] = ly / away; }
  const tx = await smooth(travel[0], seconds(1), segment), ty = await smooth(travel[1], seconds(1), segment);
  const smoothSpan = await smooth(span, seconds(0.6), segment), smoothSpeed = await smooth(speed, seconds(0.8), segment);
  if (yieldTask && !idleLeft()) deadline = await yieldTask();
  if (!isCurrent()) return null;
  // Solo framing never changes with corrective group weights.
  const fixedFocus = !group || !others.length;
  let composedFocus = null, originalFocus = null;
  // A safer-shot retry changes only a few stretches. Reuse its exact radial
  // detour result everywhere azimuth/elevation/distance are unchanged; focus
  // is immutable here. This avoids retracing the rest of the route.
  const detourChoices = trace ? new Float64Array(count * 6) : null;
  const shoot = async safe => {
    const stretches = planStretches(ramps, segment, count, first, look, seconds, spread, safe);
    const swingAt = new Float32Array(count), riseAt = new Float32Array(count), widenAt = new Float32Array(count), leadAt = new Float32Array(count);
    const ahead = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
    const ask = (s, shot, swing) => { swingAt[s] = swing; riseAt[s] = shot.elevation * DEGREES; widenAt[s] = shot.distance; leadAt[s] = shot.lead; };
    stretches.forEach(stretch => {
      for (let s = stretch.from; s <= stretch.to; s++) {
        const through = stretch.to > stretch.from ? (s - stretch.from) / (stretch.to - stretch.from) : 0;
        ask(s, stretch.shot, stretch.swing + (stretch.last - stretch.swing) * through);
        const landing = stretch.landing;
        if (landing && landing.from - s <= seconds(LANDING_AHEAD))
          for (let axis = 0; axis < 3; axis++) ahead[axis][s] = runs[0][landing.from * 3 + axis] - runs[0][s * 3 + axis];
      }
    });
    // Before the start: a slow drift round from the first ramp's side to
    // behind, facing the way they'll leave.
    if (leaving) {
      const side = ramps.find(ramp => ramp.from >= first)?.side ?? 1;
      for (let s = zone; s < first; s++) {
        const wait = (first - s) * a.dt * STEP;
        ask(s, look.start, side * Math.min(look.orbit, ORBIT_RATE * wait) * DEGREES);
        ahead[0][s] = ahead[1][s] = ahead[2][s] = 0;
      }
    }
    // After a teleport, a higher, wider view of where they are, settling in.
    for (let s = 1, opened = 0; s < count; s++) {
      if (segment[s] !== segment[s - 1]) opened = s;
      if (!opened) continue;
      const settle = 1 - smoothstep(ESTABLISH * 0.15, ESTABLISH, (s - opened) * a.dt * STEP);
      riseAt[s] += look.establish.rise * DEGREES * settle;
      widenAt[s] *= 1 + look.establish.widen * settle;
    }
    // Past the finish, pull back, up and a little round.
    const finish = Math.round(a.finish / STEP);
    if (a.finish < a.count - 1)
      for (let s = finish + 1; s < count && segment[s] === segment[finish]; s++) {
        const out = smoothstep(0, FINISH, (s - finish) * a.dt * STEP);
        riseAt[s] += look.finish.rise * DEGREES * out;
        widenAt[s] *= 1 + look.finish.widen * out;
        swingAt[s] += (Math.sign(swingAt[finish]) || 1) * look.finish.swing * DEGREES * out;
      }

    // Shots ease into each other everywhere but at teleports.
    const view = segment;
    const ease = seconds(look.transition);
    if (yieldTask && !idleLeft()) deadline = await yieldTask();
    if (!isCurrent()) return null;
    const swing = await smooth(swingAt, ease, view), rise = await smooth(riseAt, ease * 1.25, view), widen = await smooth(widenAt, ease * 1.5, view), leadShare = await smooth(leadAt, ease, view);
    const toLanding = [];
    for (const values of ahead) toLanding.push(await smooth(values, seconds(0.3), view));
    if (yieldTask && !idleLeft()) deadline = await yieldTask();
    if (!isCurrent()) return null;
    const azimuth = new Float32Array(count), elevation = new Float32Array(count), distance = new Float32Array(count), fov = new Float32Array(count), halfViews = new Float32Array(count), above = new Float32Array(count);
    for (let s = 0; s < count; s++) {
      fov[s] = FOV + look.fov * smoothstep(FOV_SLOW, FOV_FAST, smoothSpeed[s]);
      // The vertical half-angle: the narrower one, so a gap in height fits too.
      const halfView = halfViews[s] = Math.atan(Math.tan(fov[s] * Math.PI / 360) * 0.75);
      const length = Math.hypot(tx[s], ty[s]) || 1;
      azimuth[s] = Math.atan2(-ty[s] / length, -tx[s] / length) + swing[s];
      // Keep to the open side of the face the played run rides. Reaching the
      // far side would mean rising over the ramp, so a swing across waits
      // level behind or ahead of them until they leave it.
      const ox = faces[0][s * 3], oy = faces[0][s * 3 + 1];
      if ((ox || oy) && Math.cos(azimuth[s]) * ox + Math.sin(azimuth[s]) * oy < 0) {
        const normal = Math.atan2(oy, ox), wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
        const [left, right] = [wrap(normal + Math.PI / 2 - azimuth[s]), wrap(normal - Math.PI / 2 - azimuth[s])];
        azimuth[s] += Math.abs(left) < Math.abs(right) ? left : right;
      }
      elevation[s] = Math.max(rise[s], BEHIND_LOW * DEGREES * (1 - smoothstep(15 * DEGREES, 40 * DEGREES, Math.abs(swing[s]))));
      // The lowest elevation that keeps the camera above every ridden face's
      // plane: A cos e + B sin e is how far above it a unit step towards the
      // camera goes.
      let least = -Math.PI / 2;
      for (let r = 0; r < runs.length; r++) {
        if (r && shares[r - 1][s] < 0.25) continue;
        const nx = faces[r][s * 3], ny = faces[r][s * 3 + 1], nz = faces[r][s * 3 + 2];
        if (!nx && !ny) continue;
        const A = Math.cos(azimuth[s]) * nx + Math.sin(azimuth[s]) * ny, B = nz, reach = Math.hypot(A, B) || 1;
        const needed = Math.atan2(B, A) - Math.acos(Math.min(1, Math.sin(FACE_MARGIN * DEGREES) / reach));
        // Another run on a face turned away isn't worth going over the top for:
        // the visibility check eases the shot back low instead.
        least = Math.max(least, r ? Math.min(needed, OTHER_FACE_MAX * DEGREES) : needed);
      }
      above[s] = least;
      distance[s] = clamp(Math.max((BASE_DISTANCE + smoothSpeed[s] * SPEED_DISTANCE) * widen[s], smoothSpan[s] * 0.5 / Math.tan(halfView) * 1.3 + 140), BASE_DISTANCE, MAX_DISTANCE);
    }
    unwrap(azimuth, view);
    const detour = new Float32Array(count), lift = new Float32Array(count), limit = new Float32Array(count).fill(MAX_DISTANCE);
    const repairTrouble = new Uint8Array(count);
    if (trace) {
      const from = {x: 0, y: 0, z: 0}, to = {x: 0, y: 0, z: 0};
      for (let s = 0; s < count; s += TRACE_EVERY) {
        if (yieldTask && !idleLeft(0.5)) deadline = await yieldTask();
        if (!isCurrent()) return null;
        from.x = focus[0][s]; from.y = focus[1][s]; from.z = focus[2][s];
        const o = s * 6, cached = detourChoices[o] === azimuth[s] && detourChoices[o + 1] === elevation[s] && detourChoices[o + 2] === distance[s];
        let best = cached ? {turn: detourChoices[o + 3], lift: detourChoices[o + 4], room: detourChoices[o + 5]} : null;
        for (let index = 0; !cached && index < DETOURS.length; index++) {
          if (yieldTask && !idleLeft(0.5)) deadline = await yieldTask();
          if (!isCurrent()) return null;
          const [turn, up] = DETOURS[index];
          const az = azimuth[s] + turn * DEGREES, d = distance[s];
          const el = clamp(elevation[s] + up * DEGREES, Math.min(elevation[s], DETOUR_FLOOR * DEGREES), 1.35);
          if (up < 0 && el >= elevation[s]) continue;
          to.x = from.x + Math.cos(az) * Math.cos(el) * d; to.y = from.y + Math.sin(az) * Math.cos(el) * d; to.z = from.z + Math.sin(el) * d;
          const clear = trace(from, to);
          // Rising costs most: a high camera flattens the dip and climb, so
          // turning or coming closer wins wherever they can.
          const score = Math.min(1, clear / 0.7) - Math.abs(turn) * 0.004 - Math.max(up * 0.018, -up * 0.005);
          if (!best || score > best.score) best = {score, turn, lift: el - elevation[s], room: clear * d - CLEARANCE};
          // Stop when even a perfectly clear remaining detour cannot win.
          if (clear >= 0.98 || best.score >= (DETOUR_CEILING[index + 1] ?? -Infinity)) break;
        }
        if (!cached) {
          detourChoices[o] = azimuth[s]; detourChoices[o + 1] = elevation[s]; detourChoices[o + 2] = distance[s];
          detourChoices[o + 3] = best.turn; detourChoices[o + 4] = best.lift; detourChoices[o + 5] = best.room;
        }
        for (let k = s; k < Math.min(count, s + TRACE_EVERY); k++) {
          detour[k] = best.turn * DEGREES; lift[k] = best.lift; limit[k] = Math.max(MIN_DISTANCE, best.room);
          if (best.room < distance[s] * 0.8) repairTrouble[k] = 1;
        }
      }
    }
    if (yieldTask && !idleLeft()) deadline = await yieldTask();
    if (!isCurrent()) return null;
    const smoothDetour = await smooth(detour, seconds(0.45), view);
    const smoothLift = await smooth(strongest(lift, Math.round(seconds(0.3)), view), seconds(0.45), view);
    const room = await smooth(lowest(limit, Math.round(seconds(0.45)), view), seconds(0.2), view);
    // The face floor is held from just before a landing, then eased.
    const floor = await smooth(strongest(above.map(value => value + Math.PI / 2), Math.round(seconds(0.25)), view).map(value => value - Math.PI / 2), seconds(0.3), view);
    const az = await smooth(azimuth, seconds(0.3), view), far = await smooth(distance, seconds(0.5), view);
    const el = (await smooth(elevation, seconds(0.3), view)).map((value, s) => Math.max(value, floor[s]));
    const out = await smooth(swing, seconds(0.3), view);
    // Where a retreat heads: the nearer of behind and ahead, eased so the
    // choice never flips between them from one frame to the next.
    const axis = await smooth(out.map(value => Math.abs(value) > Math.PI / 2 ? Math.sign(value) * Math.PI : 0), seconds(0.45), view);
    // The shot from the smoothed choices. weight scales how far the framing
    // leans towards the other runs; limitTo caps the distance; retreat eases
    // the shot back towards a low chase.
    // One composition calculation serves both the unchanged full shot and
    // sparse repair layers. Repairs never blur/recompose the entire route.
    const place = (s, d, yaw, pitch, centre, eye, target, o) => {
      const length = Math.hypot(tx[s], ty[s]) || 1, lead = Math.min(LEAD_MAX, far[s] * leadShare[s]);
      const ex = Math.cos(yaw) * Math.cos(pitch) * d, ey = Math.sin(yaw) * Math.cos(pitch) * d, ez = Math.sin(pitch) * d;
      let lx = tx[s] / length * lead + toLanding[0][s] * look.landing, ly = ty[s] / length * lead + toLanding[1][s] * look.landing, lz = toLanding[2][s] * look.landing;
      const along = -(lx * ex + ly * ey + lz * ez) / d, across = Math.sqrt(Math.max(0, lx * lx + ly * ly + lz * lz - along * along));
      const most = Math.max(1, Math.min(Math.tan(LEAD_TURN * DEGREES) * Math.max(d * 0.5, d + along), Math.tan(halfViews[s]) * d * 0.85 - smoothSpan[s] * 0.5));
      if (across > 1e-6) { const k = most * Math.tanh(across / most) / across; lx *= k; ly *= k; lz *= k; }
      target[o] = centre[0][s] + lx; target[o + 1] = centre[1][s] + ly; target[o + 2] = centre[2][s] + lz;
      eye[o] = centre[0][s] + ex; eye[o + 1] = centre[1][s] + ey; eye[o + 2] = centre[2][s] + ez;
    };
    const compose = async (weight, limitTo, retreat) => {
      let centre = fixedFocus && composedFocus;
      if (!centre) {
        const fx = new Float32Array(count), fy = new Float32Array(count), fz = new Float32Array(count);
        for (let s = 0; s < count; s++) {
          const o = s * 3;
          let x = runs[0][o], y = runs[0][o + 1], z = runs[0][o + 2], total = 1;
          for (let index = 0; index < others.length; index++) {
            const k = shares[index][s] * weight[s], r = runs[index + 1];
            x += r[o] * k; y += r[o + 1] * k; z += r[o + 2] * k; total += k;
          }
          fx[s] = x / total; fy[s] = y / total; fz[s] = z / total + EYE_HEIGHT;
        }
        centre = [await smooth(fx, seconds(0.12), segment), await smooth(fy, seconds(0.12), segment), await smooth(fz, seconds(0.2), segment)];
        if (fixedFocus) composedFocus = centre;
      }
      originalFocus ??= centre;
      const eye = new Float32Array(count * 3), target = new Float32Array(count * 3);
      for (let s = 0; s < count; s++) {
        const d = clamp(Math.min(far[s], room[s], limitTo[s]), MIN_DISTANCE, MAX_DISTANCE);
        const yaw = az[s] + (axis[s] - out[s]) * retreat[s] + smoothDetour[s];
        const pitch = clamp(Math.max(el[s] + (RETREAT_ELEVATION * DEGREES - el[s]) * retreat[s], floor[s]) + smoothLift[s], -1.35, 1.35);
        place(s, d, yaw, pitch, centre, eye, target, s * 3);
      }
      await calm(eye, target, view, seconds, smooth);
      return {eye, target, focus: centre};
    };
    const desiredEye = new Float32Array(3), desiredTarget = new Float32Array(3);
    const desired = s => {
      place(s, far[s], az[s], el[s], originalFocus, desiredEye, desiredTarget, 0);
      return {x: desiredEye[0], y: desiredEye[1], z: desiredEye[2], tx: desiredTarget[0], ty: desiredTarget[1], tz: desiredTarget[2],
        cx: originalFocus[0][s], cy: originalFocus[1][s], cz: originalFocus[2][s]};
    };
    let weight = new Float32Array(count).fill(1), closest = new Float32Array(count).fill(MAX_DISTANCE), retreat = new Float32Array(count);
    let shot = await compose(weight, closest, retreat), firstLook = null;
    // The smoothed shot can still end up behind something no detour was tested
    // against, and two lines either side of a wall can put the framing inside
    // it. Check what the camera really sees. Where any ghost in frame is
    // hidden, ease back towards a low chase; where the played run still is,
    // or is out of frame, frame it alone for a while; where the view is
    // blocked, come in closer.
    for (let pass = 0; trace && pass < 3; pass++) {
      const hidden = new Float32Array(count), obstructed = new Float32Array(count), blocked = new Float32Array(count).fill(MAX_DISTANCE);
      const from = {x: 0, y: 0, z: 0}, to = {x: 0, y: 0, z: 0}, body = {x: 0, y: 0, z: 0};
      let found = false;
      for (let s = 0; s < count; s += TRACE_EVERY) {
        if (yieldTask && !idleLeft(0.5)) deadline = await yieldTask();
        if (!isCurrent()) return null;
        from.x = shot.focus[0][s]; from.y = shot.focus[1][s]; from.z = shot.focus[2][s];
        to.x = shot.eye[s * 3]; to.y = shot.eye[s * 3 + 1]; to.z = shot.eye[s * 3 + 2];
        body.x = runs[0][s * 3]; body.y = runs[0][s * 3 + 1]; body.z = runs[0][s * 3 + 2] + EYE_HEIGHT;
        const d = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z), clear = trace(from, to);
        if (yieldTask && !idleLeft(0.5)) deadline = await yieldTask();
        if (!isCurrent()) return null;
        const seen = trace(body, to);
        // The played run out of frame (a group that can't fit) frames it alone.
        const outside = others.length > 0 && !framed(shot, s, body, fov[s]);
        // The other runs are checked half as often, and not on the last pass.
        let lost = false;
        for (let index = 0; index < others.length && !lost && pass < 2 && s % (TRACE_EVERY * 2) === 0; index++) {
          if (shares[index][s] * weight[s] < 0.25) continue;
          if (yieldTask && !idleLeft(0.5)) deadline = await yieldTask();
          if (!isCurrent()) return null;
          const r = runs[index + 1];
          body.x = r[s * 3]; body.y = r[s * 3 + 1]; body.z = r[s * 3 + 2] + EYE_HEIGHT;
          lost = framed(shot, s, body, fov[s]) && trace(body, to) < 0.97;
        }
        if (lost) for (let k = s; k < Math.min(count, s + TRACE_EVERY * 2); k++) obstructed[k] = 1;
        lost ||= seen < 0.97;
        for (let k = s; k < Math.min(count, s + TRACE_EVERY); k++) {
          if (lost || clear < 0.97) repairTrouble[k] = 1;
          if (clear < 0.97) { blocked[k] = Math.max(MIN_DISTANCE, clear * d - CLEARANCE); found = true; }
          // Hemmed in (it would have to come in to under half its distance) counts too: behind is usually clearest.
          if (lost || clear * d < far[k] * 0.5) { obstructed[k] = 1; found = true; }
          if (seen < 0.97 && retreat[k] > 0.9 || outside) { hidden[k] = 1; found = true; }
        }
      }
      firstLook ??= {obstructed, blocked};
      if (!found) break;
      const back = await smooth(strongest(obstructed, Math.round(seconds(RETREAT)), view), seconds(0.35), view);
      retreat = retreat.map((value, s) => Math.max(value, back[s]));
      const lose = await smooth(lowest(hidden.map(value => 1 - value), Math.round(seconds(0.5)), view), seconds(0.4), view);
      weight = weight.map((value, s) => Math.min(value, lose[s]));
      const closer = await smooth(lowest(blocked, Math.round(seconds(0.45)), view), seconds(0.2), view);
      closest = closest.map((value, s) => Math.min(value, closer[s]));
      shot = await compose(weight, closest, retreat);
    }
    const troubled = new Set();
    for (const stretch of stretches) {
      if (safe.has(stretch.from) || stretch.shot === look.flight || stretch.shot === look.gentle.at(-1)) continue;
      let bad = 0;
      for (let s = stretch.from; s <= stretch.to && firstLook; s++)
        if (firstLook.obstructed[s] || firstLook.blocked[s] < far[s] * 0.5) bad++;
      if (bad > (stretch.to - stretch.from + 1) * TROUBLE) troubled.add(stretch.from);
    }
    const affected = new Uint8Array(segment[count - 1] + 1);
    for (let s = 0; s < count; s++) if (repairTrouble[s]) affected[segment[s]] = 1;
    for (let s = 0; s < count; s++) {
      const o = s * 3, d = Math.hypot(shot.eye[o] - shot.focus[0][s], shot.eye[o + 1] - shot.focus[1][s], shot.eye[o + 2] - shot.focus[2][s]);
      repairTrouble[s] = affected[segment[s]] && (retreat[s] > 0.2 || weight[s] < 0.95 || d < far[s] * 0.6) ? 1 : 0;
    }
    return {shot, fov, view, cutTicks: cutTick, troubled, desired, trouble: repairTrouble, weight};
  };
  let planned = await shoot(new Set());
  const desiredPlan = planned;
  if (planned?.troubled.size) planned = await shoot(planned.troubled);
  if (!planned) return null;
  const baselineClearance = trace ? new Float64Array(count) : null;
  if (trace) {
    const body = {x: 0, y: 0, z: 0}, eye = {x: 0, y: 0, z: 0};
    let cramped = null;
    // Constrain after all easing. If a shot is cramped, first try a calm chase
    // along the travelled route; clipping into a close-up is the last resort.
    for (let pass = 0; pass < 2; pass++) {
      for (let s = 0; s < count; s++) {
        if (s % SLICE === 0) {
          if (yieldTask && !idleLeft()) deadline = await yieldTask();
          if (!isCurrent()) return null;
        }
        const o = s * 3;
        body.x = runs[0][o]; body.y = runs[0][o + 1]; body.z = runs[0][o + 2] + EYE_HEIGHT;
        eye.x = planned.shot.eye[o]; eye.y = planned.shot.eye[o + 1]; eye.z = planned.shot.eye[o + 2];
        // A native trace cannot be interrupted, so check the idle budget
        // between queries rather than allowing a whole sample batch through.
        if (yieldTask && !idleLeft(0.5)) deadline = await yieldTask();
        if (!isCurrent()) return null;
        const clear = trace(body, eye);
        baselineClearance[s] = clear;
        const dx = eye.x - body.x, dy = eye.y - body.y, dz = eye.z - body.z;
        const distance = Math.hypot(dx, dy, dz);
        if (!pass && (clear < 1 || distance < BASE_DISTANCE * 0.5)) (cramped ??= new Float32Array(count))[s] = 1;
        if (clear < 1) {
          const share = distance > 0 ? Math.max(0, clear - CLEARANCE / distance) : 0;
          planned.shot.eye[o] = body.x + dx * share;
          planned.shot.eye[o + 1] = body.y + dy * share;
          planned.shot.eye[o + 2] = body.z + dz * share;
          // Preserve a good shot's bearing by shrinking its lead with its eye.
          planned.shot.target[o] = body.x + (planned.shot.target[o] - body.x) * share;
          planned.shot.target[o + 1] = body.y + (planned.shot.target[o + 1] - body.y) * share;
          planned.shot.target[o + 2] = body.z + (planned.shot.target[o + 2] - body.z) * share;
        }
        if (!framed(planned.shot, s, body, planned.fov[s])) {
          planned.shot.target[o] = body.x;
          planned.shot.target[o + 1] = body.y;
          planned.shot.target[o + 2] = body.z;
        }
      }
      if (pass || !cramped) break;
      const blend = await smooth(strongest(cramped, Math.ceil(seconds(0.45)), segment), seconds(0.2), segment);
      const history = Math.ceil(seconds(1));
      // Count search work, not absolute sample indices: sparse fallback regions
      // can miss sample boundaries, and one sample can try many native traces.
      let changed = false, work = SLICE;
      for (let s = 0; s < count; s++) {
        if (work >= SLICE) {
          if (yieldTask && !idleLeft()) deadline = await yieldTask();
          if (!isCurrent()) return null;
          work = 0;
        }
        work++;
        if (!blend[s]) continue;
        const o = s * 3;
        body.x = runs[0][o]; body.y = runs[0][o + 1]; body.z = runs[0][o + 2] + EYE_HEIGHT;
        let back = s;
        while (back > 0 && s - back < history && segment[back - 1] === segment[s]) {
          if (work >= SLICE) {
            if (yieldTask && !idleLeft()) deadline = await yieldTask();
            if (!isCurrent()) return null;
            work = 0;
          }
          work++;
          back--;
          if (Math.hypot(runs[0][back * 3] - body.x, runs[0][back * 3 + 1] - body.y,
            runs[0][back * 3 + 2] + EYE_HEIGHT - body.z) >= BASE_DISTANCE) break;
        }
        for (; back < s; back++) {
          if (work >= SLICE) {
            if (yieldTask && !idleLeft()) deadline = await yieldTask();
            if (!isCurrent()) return null;
            work = 0;
          }
          work++;
          const dx = runs[0][back * 3] - body.x, dy = runs[0][back * 3 + 1] - body.y;
          const dz = runs[0][back * 3 + 2] + EYE_HEIGHT - body.z, distance = Math.hypot(dx, dy, dz);
          if (distance < MIN_DISTANCE) continue;
          const scale = Math.min(1, BASE_DISTANCE / distance);
          eye.x = body.x + dx * scale; eye.y = body.y + dy * scale; eye.z = body.z + dz * scale;
          if (yieldTask && !idleLeft(0.5)) deadline = await yieldTask();
          if (!isCurrent()) return null;
          if (trace(body, eye) < 1) continue;
          const weight = blend[s];
          planned.shot.eye[o] += (eye.x - planned.shot.eye[o]) * weight;
          planned.shot.eye[o + 1] += (eye.y - planned.shot.eye[o + 1]) * weight;
          planned.shot.eye[o + 2] += (eye.z - planned.shot.eye[o + 2]) * weight;
          planned.shot.target[o] += (body.x - planned.shot.target[o]) * weight;
          planned.shot.target[o + 1] += (body.y - planned.shot.target[o + 1]) * weight;
          planned.shot.target[o + 2] += (body.z - planned.shot.target[o + 2]) * weight;
          changed = true;
          break;
        }
      }
      if (!changed) break;
    }
    // Search on the completed conservative baseline. A failed window leaves
    // its eyes, framing and group participation exactly as they were.
    let sliceStarted = performance.now();
    const checkpoint = () => {
      if (!isCurrent()) throw cancelled;
      if (yieldTask && (!idleLeft(0.5) || performance.now() - sliceStarted > 3))
        return Promise.resolve(yieldTask()).then(next => {
          deadline = next; sliceStarted = performance.now();
          if (!isCurrent()) throw cancelled;
        });
      return null;
    };
    const sampleBody = (r, s, out) => {
      const tick = Math.min(a.count - 1, s * STEP);
      if (!r) trackPoint(a, tick, out);
      else {
        const {track, map: where} = others[r - 1], lo = Math.floor(tick), hi = Math.min(a.count - 1, lo + 1);
        trackPoint(track, where[lo] + (where[hi] - where[lo]) * (tick - lo), out);
      }
      out.z += EYE_HEIGHT;
      return out;
    };
    const bodyBounds = (r, from, to, low, high) => {
      from = Math.min(a.count - 1, from * STEP); to = Math.min(a.count - 1, to * STEP);
      const track = r ? others[r - 1].track : a, where = r ? others[r - 1].map : null;
      let first = from, last = to;
      if (where) {
        first = Infinity; last = -Infinity;
        for (let tick = from; tick <= to; tick++) {
          first = Math.min(first, where[tick]); last = Math.max(last, where[tick]);
        }
      }
      first = Math.max(0, Math.floor(first)); last = Math.min(track.count - 1, Math.ceil(last));
      // Unusually large time warps cannot be certified with bounded work.
      if (!Number.isFinite(first) || !Number.isFinite(last) || last - first > 48 || first > last) return false;
      low.x = low.y = low.z = Infinity; high.x = high.y = high.z = -Infinity;
      for (let tick = first; tick <= last; tick++) {
        const o = tick * 3, x = track.position[o], y = track.position[o + 1], z = track.position[o + 2] + EYE_HEIGHT;
        low.x = Math.min(low.x, x); low.y = Math.min(low.y, y); low.z = Math.min(low.z, z);
        high.x = Math.max(high.x, x); high.y = Math.max(high.y, y); high.z = Math.max(high.z, z);
      }
      return true;
    };
    // An earlier correction is not an invitation to restyle a now-good safe
    // shot. Search only persistent group loss or strong final compression.
    for (let s = 0; s < count; s++) {
      if (s % SLICE === 0) {
        const pause = checkpoint();
        if (pause) await pause;
      }
      if (!planned.trouble[s]) { desiredPlan.trouble[s] = 0; continue; }
      const reference = desiredPlan.desired(s), o = s * 3;
      const wanted = Math.hypot(reference.x - reference.cx, reference.y - reference.cy, reference.z - reference.cz);
      const actual = Math.hypot(planned.shot.eye[o] - reference.cx, planned.shot.eye[o + 1] - reference.cy, planned.shot.eye[o + 2] - reference.cz);
      const compressed = actual < wanted * 0.6;
      let lost = false;
      if (!compressed && planned.weight[s] < 0.95) {
        eye.x = planned.shot.eye[o]; eye.y = planned.shot.eye[o + 1]; eye.z = planned.shot.eye[o + 2];
        for (let r = 1; r < runs.length && !lost; r++) {
          if (shares[r - 1][s] < 0.25) continue;
          sampleBody(r, s, body);
          if (!framed(planned.shot, s, body, planned.fov[s])) { lost = true; break; }
          const pause = checkpoint();
          if (pause) await pause;
          lost = trace(body, eye) < 0.97;
        }
      }
      desiredPlan.trouble[s] = compressed || lost ? 1 : 0;
    }
    await repairPaths({shot: planned.shot, desired: desiredPlan.desired,
      trouble: desiredPlan.trouble, runs, faces, shares, fov: planned.fov,
      segment, dt: a.dt * STEP, style, trace, checkpoint, sampleBody, bodyBounds, baselineClearance});
  }
  return {count, eye: planned.shot.eye, target: planned.shot.target, fov: planned.fov, segment: planned.view, cutTick: planned.cutTicks};
  } catch (error) {
    if (error === cancelled) return null;
    throw error;
  }
}

// Bounded local trajectory search. Contenders pay for sparse swept geometry;
// only the selected, continuously joined curve pays for dense validation.
// Clear shots never enter the search, and no eye blur follows repair.
async function repairPaths({shot, desired, trouble, runs, faces, shares, fov, segment, dt, style, trace, checkpoint, sampleBody, bodyBounds, baselineClearance}) {
  const count = segment.length, bad = new Uint8Array(count), repaired = new Uint8Array(count);
  const clearance = baselineClearance, references = new Map();
  const layers = new Map(), visibility = new Map(), originalIds = new Map();
  let nextNode = 0, coreStart = 0, coreEnd = count - 1;
  const referenceAt = s => {
    let reference = references.get(s);
    if (!reference) { reference = desired(s); references.set(s, reference); }
    return reference;
  };
  const eye = {x: 0, y: 0, z: 0}, body = {x: 0, y: 0, z: 0}, previous = {x: 0, y: 0, z: 0};
  const sweptBounds = Array.from({length: runs.length * 2 + 2}, () => ({x: 0, y: 0, z: 0}));
  const controls = [{x: 0, y: 0, z: 0}, {x: 0, y: 0, z: 0}], curveBounds = [...sweptBounds, ...controls];
  const emptySweep = (from, to, a, b, curved = false) => {
    if (!trace.mayHit) return false;
    sweptBounds[0].x = a.x; sweptBounds[0].y = a.y; sweptBounds[0].z = a.z;
    sweptBounds[1].x = b.x; sweptBounds[1].y = b.y; sweptBounds[1].z = b.z;
    // Bound every native path vertex, including intervening ghost ticks in
    // time-warped groups. Two corners suffice for the enclosing AABB.
    for (let r = 0; r < runs.length; r++)
      if (!bodyBounds(r, from, to, sweptBounds[r * 2 + 2], sweptBounds[r * 2 + 3])) return false;
    return trace.mayHit(curved ? curveBounds : sweptBounds) === false;
  };
  const query = (from, to, fraction = false) => {
    const result = () => {
      // A positive swept certificate already performed the BVH lookup.
      // Repeating that lookup for each radial ray costs more than tracing it.
      const clear = trace(from, to);
      return fraction ? clear : clear === 1;
    };
    const pause = checkpoint();
    return pause ? pause.then(result) : result();
  };
  const point = (array, s, out, height = 0) => {
    const lo = Math.floor(s), hi = Math.min(count - 1, lo + 1), t = s - lo;
    out.x = array[lo * 3] + (array[hi * 3] - array[lo * 3]) * t;
    out.y = array[lo * 3 + 1] + (array[hi * 3 + 1] - array[lo * 3 + 1]) * t;
    out.z = array[lo * 3 + 2] + (array[hi * 3 + 2] - array[lo * 3 + 2]) * t + height;
  };
  // Radial passes miss a blocked eye chord and intermediate body sightlines.
  for (let s = 0; s < count; s++) {
    point(shot.eye, s, eye); point(runs[0], s, body, EYE_HEIGHT);
    const pause = checkpoint();
    if (pause) await pause;
    const joined = s && segment[s] === segment[s - 1];
    if (joined) {
      point(shot.eye, s - 1, previous);
      if (emptySweep(s - 1, s, previous, eye)) {
        clearance[s] = 1;
        if (trouble[s]) bad[s] = 1;
        continue;
      }
    }
    if (clearance[s] !== 1) clearance[s] = await query(body, eye, true);
    if (trouble[s] || clearance[s] < 1) bad[s] = 1;
    if (joined) {
      point(shot.eye, s - 1, previous);
      if (!await query(previous, eye)) bad[s - 1] = bad[s] = 1;
      point(shot.eye, s - 0.5, eye); sampleBody(0, s - 0.5, body);
      if (!await query(body, eye)) bad[s - 1] = bad[s] = 1;
    }
  }
  if (!bad.some(Boolean)) return {repaired, clearance};
  const stride = Math.max(1, Math.min(8, Math.round(0.18 / dt))), padding = Math.max(stride, Math.ceil(1.2 / dt));
  const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
  const positionKeys = ['x', 'y', 'z', 'tx', 'ty', 'tz'], velocityKeys = ['vx', 'vy', 'vz', 'vtx', 'vty', 'vtz'];
  const nodeAt = (source, s) => ({
    s, x: source.eye[s * 3], y: source.eye[s * 3 + 1], z: source.eye[s * 3 + 2],
    tx: source.target[s * 3], ty: source.target[s * 3 + 1], tz: source.target[s * 3 + 2],
    cost: Infinity, parent: null, rate: 0,
  });
  const derivative = (source, s, key) => {
    const lo = s > 0 && segment[s - 1] === segment[s] ? s - 1 : s;
    const hi = s + 1 < count && segment[s + 1] === segment[s] ? s + 1 : s;
    return (source[hi * 3 + key] - source[lo * 3 + key]) / Math.max(dt, (hi - lo) * dt);
  };
  const velocity = node => {
    for (let k = 0; k < 6; k++) node[velocityKeys[k]] = derivative(k < 3 ? shot.eye : shot.target, node.s, k % 3);
    return node;
  };
  const interpolate = (a, b, s, out) => {
    const duration = (b.s - a.s) * dt, t = (s - a.s) / (b.s - a.s);
    const t2 = t * t, t3 = t2 * t;
    const h0 = 2 * t3 - 3 * t2 + 1, h1 = t3 - 2 * t2 + t;
    const h2 = -2 * t3 + 3 * t2, h3 = t3 - t2;
    for (let k = 0; k < 6; k++) {
      const key = positionKeys[k], speed = velocityKeys[k];
      out[key] = h0 * a[key] + h1 * duration * a[speed] + h2 * b[key] + h3 * duration * b[speed];
    }
    return out;
  };
  const baselineFrames = new Map(), required = new Uint8Array(runs.length);
  const screen = new Float64Array(runs.length * 2), inside = new Uint8Array(runs.length);
  const ranges = new Float64Array(runs.length);
  const target = {x: 0, y: 0, z: 0};
  const bodySamples = new Map();
  let bodies;
  const bodiesAt = s => {
    let sample = bodySamples.get(s);
    if (!sample) {
      sample = Array.from({length: runs.length}, (_, r) => sampleBody(r, s, {x: 0, y: 0, z: 0}));
      bodySamples.set(s, sample);
    }
    return sample;
  };
  const baselineAt = s => {
    let baseline = baselineFrames.get(s);
    if (baseline) return baseline;
    const lo = Math.floor(s), hi = Math.min(count - 1, lo + 1), t = s - lo;
    baseline = {eye: {x: 0, y: 0, z: 0}, target: {x: 0, y: 0, z: 0},
      screen: new Float64Array(runs.length * 2), inside: new Uint8Array(runs.length),
      ranges: new Float64Array(runs.length), seen: new Int8Array(runs.length).fill(-1)};
    point(shot.eye, s, baseline.eye); point(shot.target, s, baseline.target);
    for (let r = 0; r < runs.length; r++) {
      const body = bodiesAt(s)[r];
      baseline.ranges[r] = Math.hypot(body.x - baseline.eye.x, body.y - baseline.eye.y, body.z - baseline.eye.z);
      baseline.inside[r] = projected(baseline.eye, baseline.target, body,
        fov[lo] * (1 - t) + fov[hi] * t, baseline.screen, r * 2) ? 1 : 0;
    }
    baselineFrames.set(s, baseline);
    return baseline;
  };
  const baselineSeen = (baseline, r, s) => {
    if (baseline.seen[r] >= 0) return baseline.seen[r] === 1;
    const remember = visible => { baseline.seen[r] = visible ? 1 : 0; return visible; };
    if (!r && Number.isInteger(s) && clearance[s] === 1) return remember(true);
    const visible = query(bodies[r], baseline.eye);
    return typeof visible === 'boolean' ? remember(visible) : visible.then(remember);
  };
  const participating = (r, s, lo, hi, t, fullGroup) => {
    if (!r) return true;
    const share = shares[r - 1][lo] * (1 - t) + shares[r - 1][hi] * t;
    // A shoulder must retain everybody the baseline actually showed, but a
    // previously missing participant can enter smoothly. Requiring that
    // participant in the unchanged anchor makes any recovery impossible.
    // The entire relevant group is mandatory throughout the repair's core.
    if (fullGroup && share >= 0.25) return true;
    // Composition weight is not rendered opacity: even a zero-weight ghost
    // must retain the visibility and framing the original shot gave it.
    const baseline = baselineAt(s);
    return baseline.inside[r] ? baselineSeen(baseline, r, s) : false;
  };
  const valid = async (node, s, geometryClear = false, score = false, fullGroup = s >= coreStart && s <= coreEnd) => {
    eye.x = node.x; eye.y = node.y; eye.z = node.z;
    target.x = node.tx; target.y = node.ty; target.z = node.tz;
    inside.fill(0);
    node.separation = 0;
    bodies = bodiesAt(s);
    const lo = Math.floor(s), hi = Math.min(count - 1, lo + 1), t = s - lo;
    const field = fov[lo] * (1 - t) + fov[hi] * t;
    // Reject all cheap composition/face failures before any candidate ray.
    for (let r = 0; r < runs.length; r++) {
      const included = participating(r, s, lo, hi, t, fullGroup);
      required[r] = (typeof included === 'boolean' ? included : await included) ? 1 : 0;
      if (!required[r]) continue;
      const body = bodies[r];
      if (!r) {
        point(shot.eye, s, previous);
        const original = Math.hypot(previous.x - body.x, previous.y - body.y, previous.z - body.z);
        if (Math.hypot(eye.x - body.x, eye.y - body.y, eye.z - body.z) + 1 < Math.min(BASE_DISTANCE, original * 0.98)) return false;
      }
      // Candidate-specific face guards; do not average opposing landing faces.
      for (let at = lo; at <= hi; at++) {
        const nx = faces[r][at * 3], ny = faces[r][at * 3 + 1], nz = faces[r][at * 3 + 2];
        if (!nx && !ny) continue;
        const dx = eye.x - body.x, dy = eye.y - body.y, dz = eye.z - body.z;
        if (dx * nx + dy * ny + dz * nz < Math.sin(FACE_MARGIN * DEGREES) * Math.hypot(dx, dy, dz)) return false;
      }
      ranges[r] = Math.hypot(body.x - eye.x, body.y - eye.y, body.z - eye.z);
      inside[r] = projected(eye, target, body, field, screen, r * 2) ? 1 : 0;
      if (!inside[r]) return false;
    }
    if (runs.length > 1) {
      const baseline = baselineAt(s);
      for (let a = 0; a < runs.length; a++) for (let b = a + 1; b < runs.length; b++) {
        if (!baseline.inside[a] || !baseline.inside[b]) continue;
        const before = Math.hypot(baseline.screen[a * 2] - baseline.screen[b * 2],
          baseline.screen[a * 2 + 1] - baseline.screen[b * 2 + 1]);
        if (before < 1e-6) continue;
        const after = Math.hypot(screen[a * 2] - screen[b * 2], screen[a * 2 + 1] - screen[b * 2 + 1]);
        // Allow the expected perspective shrink when restoring a wide shot,
        // but not foreshortening distinct subjects into the same sightline.
        const scale = Math.min(1, (baseline.ranges[a] + baseline.ranges[b]) / (ranges[a] + ranges[b]));
        const retained = after / (before * scale);
        const collapsed = !inside[a] || !inside[b] || after + 1e-6 < Math.min(before * scale * 0.6, 0.45);
        if (!collapsed && (!score || retained >= 1)) continue;
        const seenA = baselineSeen(baseline, a, s);
        if (!(typeof seenA === 'boolean' ? seenA : await seenA)) continue;
        const seenB = baselineSeen(baseline, b, s);
        if (!(typeof seenB === 'boolean' ? seenB : await seenB)) continue;
        if (collapsed) return false;
        if (score) node.separation += (1 - retained) ** 2 * 2;
      }
    }
    if (!geometryClear) for (let r = 0; r < runs.length; r++)
      if (required[r] && !await query(bodies[r], eye)) return false;
    return true;
  };
  const anchorClear = new Uint8Array(count);
  const anchorValid = async s => {
    if (repaired[s] || anchorClear[s] === 1) return true;
    if (anchorClear[s] === 2) return false;
    const clear = await valid(nodeAt(shot, s), s, false, false, false);
    anchorClear[s] = clear ? 1 : 2;
    return clear;
  };
  const validateStored = async (eyes, targets, from, to, coreStart = from, coreEnd = to, certified = null) => {
    const stored = {x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0};
    const a = {x: 0, y: 0, z: 0}, b = {x: 0, y: 0, z: 0};
    let geometryClear = false;
    for (let s = from; s <= to; s += 0.25) {
      const sample = (s - from) * 4;
      if (certified?.samples[sample]) continue;
      const edge = Math.min(to - from - 1, Math.floor(s) - from);
      if (certified) geometryClear = certified.edges[edge] === 1;
      const lo = (Math.floor(s) - from) * 3, hi = Math.min(to - from, Math.floor(s) - from + 1) * 3, t = s - Math.floor(s);
      if (!t && s < to && !certified?.edges[edge]) {
        a.x = eyes[lo]; a.y = eyes[lo + 1]; a.z = eyes[lo + 2];
        b.x = eyes[hi]; b.y = eyes[hi + 1]; b.z = eyes[hi + 2];
        geometryClear = emptySweep(s, s + 1, a, b);
        // Stored eyes interpolate linearly. One complete chord query covers
        // every subdivision; repeating it four times adds no information.
        if (!geometryClear && !await query(a, b)) return s + 0.5;
        if (certified) certified.edges[edge] = geometryClear ? 1 : 2;
      }
      stored.x = eyes[lo] + (eyes[hi] - eyes[lo]) * t;
      stored.y = eyes[lo + 1] + (eyes[hi + 1] - eyes[lo + 1]) * t;
      stored.z = eyes[lo + 2] + (eyes[hi + 2] - eyes[lo + 2]) * t;
      stored.tx = targets[lo] + (targets[hi] - targets[lo]) * t;
      stored.ty = targets[lo + 1] + (targets[hi + 1] - targets[lo + 1]) * t;
      stored.tz = targets[lo + 2] + (targets[hi + 2] - targets[lo + 2]) * t;
      if (!await valid(stored, s, geometryClear, false, s >= coreStart && s <= coreEnd)) return s;
      if (certified) certified.samples[sample] = 1;
    }
    return null;
  };
  const fitCorridor = (path, eyes, targets) => {
    // Clamped cubic B-spline: selected safe poses are corridor controls, not
    // interpolation knots. Moving between their convex hulls removes the
    // quantized layer impulses. The two extra controls retain the unchanged
    // entry/exit's actual eye AND target derivatives, without stopping there.
    // Individual safe controls do not certify this curve; validateStored is
    // still authoritative for every published Float32 chord and sightline.
    const first = path[0], last = path.at(-1), n = path.length;
    const controls = new Float64Array((n + 2) * 6), knots = new Float64Array(n + 6);
    const work = new Float64Array(24);
    for (let k = 0; k < 6; k++) {
      const key = positionKeys[k], speed = velocityKeys[k];
      controls[k] = first[key];
      controls[6 + k] = first[key] + first[speed] * (path[1].s - first.s) * dt / 3;
      for (let index = 1; index < n - 1; index++) controls[(index + 1) * 6 + k] = path[index][key];
      controls[n * 6 + k] = last[key] - last[speed] * (last.s - path[n - 2].s) * dt / 3;
      controls[(n + 1) * 6 + k] = last[key];
    }
    knots.fill(first.s, 0, 4);
    for (let index = 1; index < n - 1; index++) knots[index + 3] = path[index].s;
    knots.fill(last.s, n + 2);
    const write = () => {
      let span = 3;
      for (let s = first.s; s <= last.s; s++) {
        while (span < n + 1 && s >= knots[span + 1]) span++;
        for (let j = 0; j < 4; j++) for (let k = 0; k < 6; k++)
          work[j * 6 + k] = controls[(span - 3 + j) * 6 + k];
        for (let degree = 1; degree <= 3; degree++) for (let j = 3; j >= degree; j--) {
          const low = knots[span - 3 + j], high = knots[span + 1 + j - degree];
          const alpha = high === low ? 0 : (s - low) / (high - low);
          for (let k = 0; k < 6; k++) work[j * 6 + k] = work[(j - 1) * 6 + k] * (1 - alpha) + work[j * 6 + k] * alpha;
        }
        const o = (s - first.s) * 3;
        for (let k = 0; k < 3; k++) { eyes[o + k] = work[18 + k]; targets[o + k] = work[21 + k]; }
      }
    };
    const weights = new Float64Array(n + 2), basis = new Float64Array(16), delta = new Float64Array(6);
    const addWeights = (s, weight) => {
      let span = 3;
      while (span < n + 1 && s >= knots[span + 1]) span++;
      basis.fill(0);
      for (let j = 0; j < 4; j++) basis[j * 5] = 1;
      for (let degree = 1; degree <= 3; degree++) for (let j = 3; j >= degree; j--) {
        const low = knots[span - 3 + j], high = knots[span + 1 + j - degree];
        const alpha = high === low ? 0 : (s - low) / (high - low);
        for (let k = 0; k < 4; k++) basis[j * 4 + k] = basis[(j - 1) * 4 + k] * (1 - alpha) + basis[j * 4 + k] * alpha;
      }
      for (let k = 0; k < 4; k++) weights[span - 3 + k] += basis[12 + k] * weight;
    };
    write();
    return (s, reference) => {
      // Correct only the controls influencing the actual failed stored chord.
      // The least-norm update retains C2 continuity; fixed endpoint handles
      // cannot be moved by a late geometry counterexample.
      const lo = Math.floor(s), hi = Math.min(last.s, lo + 1), fraction = s - lo;
      weights.fill(0); addWeights(lo, 1 - fraction); addWeights(hi, fraction);
      let squared = 0;
      for (let index = 2; index < n; index++) squared += weights[index] ** 2;
      if (squared < 1e-8) return false;
      for (let k = 0; k < 6; k++) {
        const source = k < 3 ? eyes : targets, axis = k % 3;
        const value = source[(lo - first.s) * 3 + axis] * (1 - fraction) + source[(hi - first.s) * 3 + axis] * fraction;
        delta[k] = reference[positionKeys[k]] - value;
      }
      let scale = 1;
      const movement = Math.hypot(delta[0], delta[1], delta[2]);
      for (let index = 2; index < n; index++) if (weights[index]) {
        const o = index * 6;
        const span = Math.hypot(controls[o + 6] - controls[o - 6], controls[o + 7] - controls[o - 5], controls[o + 8] - controls[o - 4]);
        scale = Math.min(scale, Math.max(BASE_DISTANCE * 0.5, span * 0.5) * squared / Math.max(1e-8, movement * weights[index]));
      }
      let from = last.s, to = first.s;
      for (let index = 2; index < n; index++) if (weights[index]) {
        from = Math.min(from, knots[index]); to = Math.max(to, knots[index + 4]);
        for (let k = 0; k < 6; k++) controls[index * 6 + k] += delta[k] * weights[index] / squared * scale;
      }
      write();
      return {from, to};
    };
  };
  const edge = async (a, b) => {
    const between = {...a}, last = {x: a.x, y: a.y, z: a.z};
    // Endpoint visibility is shared by every predecessor, but the curved
    // sweep is specific to its incoming velocity and must not be cached by ID.
    let visible = visibility.get(b.id);
    if (visible === undefined) { visible = await valid(b, b.s); visibility.set(b.id, visible); }
    if (!visible) return false;
    for (let s = a.s + 0.25; s < b.s; s += 0.25)
      if (!await valid(interpolate(a, b, s, between), s, true)) return false;
    // A cubic lies inside its Bezier control hull, not necessarily inside
    // its endpoint AABB. Certify the whole curved eye together with all
    // intermediate native body vertices before omitting any visibility ray.
    const third = (b.s - a.s) * dt / 3;
    for (let k = 0; k < 3; k++) {
      const key = positionKeys[k], speed = velocityKeys[k];
      controls[0][key] = a[key] + third * a[speed];
      controls[1][key] = b[key] - third * b[speed];
    }
    const geometryClear = emptySweep(a.s, b.s, a, b, true);
    for (let step = 1; step <= 2; step++) {
      const s = a.s + (b.s - a.s) * step / 2;
      interpolate(a, b, s, between);
      eye.x = between.x; eye.y = between.y; eye.z = between.z;
      if (!geometryClear && !await query(last, eye)) return false;
      if (step < 2 && !await valid(between, s, geometryClear)) return false;
      last.x = between.x; last.y = between.y; last.z = between.z;
    }
    return true;
  };
  const buildCandidates = async (s, anchor) => {
    const original = nodeAt(shot, s);
    original.original = true;
    if (anchor) { original.anchor = true; return await valid(original, s) ? [velocity(original)] : []; }
    const reference = referenceAt(s), {cx, cy, cz} = reference;
    const dx = reference.x - cx, dy = reference.y - cy, dz = reference.z - cz;
    const yaw = Math.atan2(dy, dx), pitch = Math.atan2(dz, Math.hypot(dx, dy)), radius = Math.hypot(dx, dy, dz);
    const nodes = [];
    // Full orbits, with distance scored up to the reference (no 70% plateau).
    for (let turn = 0; turn < 12; turn++) {
      for (const variant of [0, 3, 4, 1, 2]) {
        const angle = wrap(turn * Math.PI / 6), az = yaw + angle;
        const scale = variant === 1 ? 0.72 : variant === 2 ? 0.48 : 1;
        let el = pitch + (variant === 3 ? 18 * DEGREES : variant === 4 ? -18 * DEGREES : 0);
        const nx = faces[0][s * 3], ny = faces[0][s * 3 + 1], nz = faces[0][s * 3 + 2];
        if (nx || ny) {
          const A = Math.cos(az) * nx + Math.sin(az) * ny, reach = Math.hypot(A, nz);
          el = Math.max(el, Math.atan2(nz, A) - Math.acos(Math.min(1, Math.sin(FACE_MARGIN * DEGREES) / reach)));
        }
        if (el > Math.min(1.35, pitch + 18 * DEGREES)) continue;
        const d = Math.max(MIN_DISTANCE, radius * scale), flat = Math.cos(el) * d;
        const node = {s, x: Math.fround(cx + Math.cos(az) * flat), y: Math.fround(cy + Math.sin(az) * flat), z: Math.fround(cz + Math.sin(el) * d),
          tx: Math.fround(reference.tx),
          ty: Math.fround(reference.ty),
          tz: Math.fround(reference.tz),
          cost: Infinity, parent: null, rate: 0,
          composition: angle * angle * (style === 'steady' ? 0.9 : 0.45) + (1 - scale) ** 2 * 16 + (el - pitch) ** 2 * 8};
        if (await valid(node, s, true, true)) {
          node.composition += node.separation;
          nodes.push(node);
        }
      }
    }
    if (await valid(original, s, true)) {
      const ox = original.x - cx, oy = original.y - cy, oz = original.z - cz;
      const angle = wrap(Math.atan2(oy, ox) - yaw), scale = Math.hypot(ox, oy, oz) / radius;
      original.composition = angle * angle * (style === 'steady' ? 0.9 : 0.45) + (1 - scale) ** 2 * 16 +
        (Math.atan2(oz, Math.hypot(ox, oy)) - pitch) ** 2 * 8;
      nodes.push(original);
    }
    return nodes;
  };
  const candidates = async (s, anchor) => {
    const key = s * 2 + (anchor ? 1 : 0);
    let nodes = layers.get(key);
    if (!nodes) {
      nodes = await buildCandidates(s, anchor);
      for (const node of nodes) {
        if (node.original && originalIds.has(s)) node.id = originalIds.get(s);
        else {
          node.id = nextNode++;
          if (node.original) originalIds.set(s, node.id);
        }
      }
      layers.set(key, nodes);
    }
    // Search state belongs to an attempt; geometry results belong to the
    // bounded window and can be reused by its second anchor expansion.
    return nodes.map(node => ({...node, cost: Infinity, parent: null, rate: 0}));
  };
  // Prefer one continuous shot intention to independently chosen layer nodes.
  // The bearing, radius and lift stay fixed relative to the original composed
  // route. Quintic shoulders preserve the baseline's position and velocity at
  // both ends; every resulting stored chord is checked before publication.
  const coherent = async (from, to, start, end) => {
    // A fixed neighbour needs a shoulder to meet its pose continuously.
    // The endpoint-anchored beam can still search when no shoulder fits.
    if (from === start && from > 0 && segment[from - 1] === segment[from] ||
        to === end && to + 1 < count && segment[to + 1] === segment[to]) return false;
    const length = to - from + 1, eyes = new Float32Array(length * 3), targets = new Float32Array(length * 3);
    const at = {x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0};
    const ease = t => { t = clamp(t, 0, 1); return t * t * t * (10 + t * (-15 + 6 * t)); };
    const coordinates = [];
    for (let s = from; s <= to; s++) {
      const reference = referenceAt(s), {cx, cy, cz} = reference;
      const dx = reference.x - cx, dy = reference.y - cy, dz = reference.z - cz;
      coordinates.push({...reference, az: Math.atan2(dy, dx),
        el: Math.atan2(dz, Math.hypot(dx, dy)), radius: Math.hypot(dx, dy, dz)});
    }
    const residual = s => {
      const p = referenceAt(s), o = s * 3;
      const dx = p.x - p.cx, dy = p.y - p.cy, dz = p.z - p.cz;
      const bx = shot.eye[o] - p.cx, by = shot.eye[o + 1] - p.cy, bz = shot.eye[o + 2] - p.cz;
      return [wrap(Math.atan2(by, bx) - Math.atan2(dy, dx)),
        Math.hypot(bx, by, bz) / Math.max(1, Math.hypot(dx, dy, dz)),
        Math.atan2(bz, Math.hypot(bx, by)) - Math.atan2(dz, Math.hypot(dx, dy)),
        shot.target[o] - p.tx, shot.target[o + 1] - p.ty, shot.target[o + 2] - p.tz];
    };
    const anchor = s => {
      const low = s > 0 && segment[s - 1] === segment[s] ? s - 1 : s;
      const high = s + 1 < count && segment[s + 1] === segment[s] ? s + 1 : s;
      const value = residual(s), a = residual(low), b = residual(high);
      return {value, speed: value.map((_, k) => (k ? b[k] - a[k] : wrap(b[k] - a[k])) / Math.max(1, high - low))};
    };
    const entry = from > 0 && segment[from - 1] === segment[from] ? anchor(from) : null;
    const exit = to + 1 < count && segment[to + 1] === segment[to] ? anchor(to) : null;
    const parameters = new Float64Array(6);
    const compose = (s, choice) => {
      const p = coordinates[s - from];
      parameters[0] = choice.turn;
      parameters[1] = choice.scale; parameters[2] = choice.rise;
      parameters[3] = parameters[4] = parameters[5] = 0;
      const entering = s < start, boundary = entering ? entry : s > end ? exit : null;
      if (boundary) {
        const duration = entering ? Math.max(1, start - from) : Math.max(1, to - end);
        const t = clamp((entering ? s - from : to - s) / duration, 0, 1), weight = ease(t);
        const tangent = t - 6 * t ** 3 + 8 * t ** 4 - 3 * t ** 5;
        for (let k = 0; k < 6; k++) {
          const delta = k ? boundary.value[k] - parameters[k] : wrap(boundary.value[k] - parameters[k]);
          parameters[k] += delta * (1 - weight) + tangent * duration * boundary.speed[k] * (entering ? 1 : -1);
        }
      }
      const bearing = p.az + parameters[0], elevation = p.el + parameters[2];
      const radius = p.radius * parameters[1], flat = radius * Math.cos(elevation);
      at.x = Math.fround(p.cx + Math.cos(bearing) * flat);
      at.y = Math.fround(p.cy + Math.sin(bearing) * flat);
      at.z = Math.fround(p.cz + Math.sin(elevation) * radius);
      at.tx = Math.fround(p.tx + parameters[3]); at.ty = Math.fround(p.ty + parameters[4]); at.tz = Math.fround(p.tz + parameters[5]);
      return at;
    };
    const choices = [];
    for (const turn of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6])
      for (const scale of [1, 0.84, 0.68, 0.5])
        for (const rise of [0, -18 * DEGREES, 18 * DEGREES, -36 * DEGREES])
          choices.push({turn: turn * Math.PI / 6, scale, rise,
            cost: turn * turn * (style === 'steady' ? 0.24 : 0.12) + (1 - scale) ** 2 * 16 + rise * rise * 8});
    choices.sort((a, b) => a.cost - b.cost);
    for (const choice of choices) {
      // Reject an entire intention at its most constrained samples before
      // paying for its shoulders or its full interpolation.
      let clear = true;
      for (let s = from; s <= to && clear; s += stride) clear = await valid(compose(s, choice), s, true, false, s >= start && s <= end);
      if (!clear) continue;
      for (let s = start; s <= end && clear; s += stride) clear = await valid(compose(s, choice), s);
      if (!clear) continue;
      for (let s = from; s <= to; s++) {
        compose(s, choice);
        const o = (s - from) * 3;
        eyes[o] = at.x; eyes[o + 1] = at.y; eyes[o + 2] = at.z;
        targets[o] = at.tx; targets[o + 1] = at.ty; targets[o + 2] = at.tz;
      }
      if (await validateStored(eyes, targets, from, to, start, end) !== null) continue;
      shot.eye.set(eyes, from * 3); shot.target.set(targets, from * 3);
      repaired.fill(1, from, to + 1); clearance.fill(1, from, to + 1);
      return true;
    }
    return false;
  };
  for (let cursor = 0; cursor < count;) {
    if (!bad[cursor] || repaired[cursor]) { cursor++; continue; }
    references.clear(); layers.clear(); visibility.clear(); originalIds.clear(); baselineFrames.clear(); bodySamples.clear(); nextNode = 0;
    const start = cursor, id = segment[start];
    let end = start;
    for (let next = start + 1; next < count && segment[next] === id && next - start < 112 && next - end <= padding; next++)
      if (bad[next] && !repaired[next]) end = next;
    coreStart = start; coreEnd = end;
    let accepted = false;
    for (let attempt = 1; attempt <= 2 && !accepted; attempt++) {
      let from = start, to = end;
      const shoulder = Math.min(padding * attempt, Math.floor((159 - (end - start)) / 2));
      while (from > 0 && !repaired[from - 1] && segment[from - 1] === id && start - from < shoulder) from--;
      while (to + 1 < count && !repaired[to + 1] && segment[to + 1] === id && to - end < shoulder) to++;
      if (from === to) continue;
      // No trajectory can meet an invalid fixed endpoint. Expand the window
      // before testing speculative bearings, rather than rediscovering the
      // same failure for every candidate and every predecessor.
      if (from > 0 && segment[from - 1] === id && !await anchorValid(from)) continue;
      if (to + 1 < count && segment[to + 1] === id && !await anchorValid(to)) continue;
      if (await coherent(from, to, start, end)) { accepted = true; break; }
      const intervals = Math.max(1, Math.ceil((to - from) / stride));
      const times = Array.from({length: intervals + 1}, (_, i) => from + Math.round((to - from) * i / intervals));
      let layer = await candidates(from, from > 0 && segment[from - 1] === id);
      for (const node of layer) { node.cost = node.composition ?? 0; velocity(node); }
      for (let index = 1; index < times.length && layer.length; index++) {
        const pause = checkpoint();
        if (pause) await pause;
        const s = times[index], next = await candidates(s, index === times.length - 1 && to + 1 < count && segment[to + 1] === id);
        const ranked = [];
        for (const node of next) {
          const {cx, cy} = referenceAt(s), yaw = Math.atan2(node.y - cy, node.x - cx);
          const predecessors = [];
          for (const before of layer) {
            const {cx: bx, cy: by, cz: bz} = referenceAt(before.s);
            const turn = wrap(yaw - Math.atan2(before.y - by, before.x - bx)), duration = (s - before.s) * dt, rate = turn / duration;
            if (Math.abs(rate) > (style === 'steady' ? 300 : 540) * DEGREES) continue;
            const candidate = {...node};
            let acceleration = 0;
            const normalization = Math.max(BASE_DISTANCE, Math.hypot(node.x - cx, node.y - cy));
            for (let k = 0; k < 6; k++) {
              const key = positionKeys[k], speed = velocityKeys[k];
              const secant = (node[key] - before[key]) / duration;
              candidate[speed] = node.anchor ? node[speed] : (before[speed] + secant) * 0.5;
              acceleration += ((secant - before[speed]) / normalization) ** 2;
            }
            const radius = Math.hypot(node.x - cx, node.y - cy, node.z - referenceAt(s).cz);
            const oldRadius = Math.hypot(before.x - bx, before.y - by, before.z - bz);
            const radial = (radius - oldRadius) / duration / Math.max(300, radius);
            const reversed = before.rate * rate < 0 ? Math.min(Math.abs(before.rate), Math.abs(rate)) ** 2 : 0;
            const cost = before.cost + (node.composition ?? 0) * duration + turn * turn * 3 +
              (rate - before.rate) ** 2 * 0.08 + acceleration * 0.3 + radial * radial * 0.6 + reversed * 0.4;
            let at = 0;
            while (at < predecessors.length && predecessors[at].cost <= cost) at++;
            if (at < 4) { predecessors.splice(at, 0, {before, node: candidate, cost, rate}); if (predecessors.length > 4) predecessors.pop(); }
          }
          if (predecessors.length) ranked.push({node, predecessors});
        }
        ranked.sort((a, b) => a.predecessors[0].cost - b.predecessors[0].cost);
        layer = [];
        // Most alternatives cannot compete compositionally. Trace connected
        // contenders in cost order; expand the beam on the second attempt.
        for (const {node, predecessors} of ranked) {
          for (const candidate of predecessors) if (await edge(candidate.before, candidate.node)) {
            Object.assign(node, candidate.node);
            node.cost = candidate.cost; node.parent = candidate.before; node.rate = candidate.rate; break;
          }
          if (Number.isFinite(node.cost)) layer.push(node);
          if (layer.length >= attempt * 4) break;
        }
      }
      if (!layer.length || layer[0].s !== to) continue;
      const best = layer.reduce((a, b) => a.cost <= b.cost ? a : b);
      const proposedEye = new Float32Array((to - from + 1) * 3), proposedTarget = new Float32Array(proposedEye.length);
      const path = [];
      for (let node = best; node; node = node.parent) path.push(node);
      path.reverse();
      const refine = fitCorridor(path, proposedEye, proposedTarget);
      const certified = {samples: new Uint8Array((to - from) * 4 + 1), edges: new Uint8Array(to - from)};
      let failed = await validateStored(proposedEye, proposedTarget, from, to, start, end, certified);
      const reference = {};
      for (let correction = 0; failed !== null && correction < 4; correction++) {
        let before = path[0], after = path[1];
        for (let index = 1; index < path.length; index++) {
          after = path[index];
          if (failed <= after.s) break;
          before = after;
        }
        interpolate(before, after, failed, reference);
        if (!await valid(reference, failed, false, false, failed >= start && failed <= end)) break;
        const changed = refine(failed, reference);
        if (!changed) break;
        // Only this control support and its adjacent stored chords changed.
        // Retain every other native geometry/body/composition certificate,
        // including any prefix already checked before the counterexample.
        const low = Math.max(from, Math.floor(changed.from) - 1), high = Math.min(to, Math.ceil(changed.to) + 1);
        certified.samples.fill(0, (low - from) * 4, (high - from) * 4 + 1);
        certified.edges.fill(0, low - from, high - from);
        failed = await validateStored(proposedEye, proposedTarget, from, to, start, end, certified);
      }
      const smooth = failed === null;
      if (!smooth) for (let node = best; node.parent; node = node.parent) {
        const before = node.parent;
        for (let s = before.s; s <= node.s; s++) {
          const o = (s - from) * 3, value = interpolate(before, node, s, {});
          proposedEye[o] = value.x; proposedEye[o + 1] = value.y; proposedEye[o + 2] = value.z;
          proposedTarget[o] = value.tx; proposedTarget[o + 1] = value.ty; proposedTarget[o + 2] = value.tz;
        }
      }
      // Float32 storage slightly changes chords. Validate that stored path,
      // including its fractional interpolation, before replacing any sample.
      failed = smooth ? null : await validateStored(proposedEye, proposedTarget, from, to, start, end);
      // A failure belongs to this curve's endpoint tangents, not just the
      // endpoint IDs. The wider attempt may use that edge with a safe tangent.
      if (failed !== null) continue;
      shot.eye.set(proposedEye, from * 3); shot.target.set(proposedTarget, from * 3);
      repaired.fill(1, from, to + 1);
      clearance.fill(1, from, to + 1);
      accepted = true;
    }
    cursor = end + 1;
  }
  return {repaired, clearance};
}

// Smooths the eye in place wherever the view turns faster than TURN_LIMIT:
// the camera glides instead of whipping round, still aimed at the ghosts.
async function calm(eye, target, view, seconds, smoothBlur) {
  const count = view.length, rate = new Float32Array(count);
  const direction = (s, out) => {
    const x = target[s * 3] - eye[s * 3], y = target[s * 3 + 1] - eye[s * 3 + 1], z = target[s * 3 + 2] - eye[s * 3 + 2], length = Math.hypot(x, y, z) || 1;
    out[0] = x / length; out[1] = y / length; out[2] = z / length;
  };
  const before = [0, 0, 0], after = [0, 0, 0];
  for (let s = 1; s < count - 1; s++) {
    if (view[s - 1] !== view[s] || view[s + 1] !== view[s]) continue;
    direction(s - 1, before); direction(s + 1, after);
    const turn = Math.acos(clamp(before[0] * after[0] + before[1] * after[1] + before[2] * after[2], -1, 1));
    rate[s] = turn / (2 * seconds(1) ** -1) / DEGREES;
  }
  const weight = await smoothBlur(strongest(rate.map(value => smoothstep(TURN_LIMIT * 0.8, TURN_LIMIT * 1.5, value)), Math.round(seconds(0.25)), view), seconds(0.15), view);
  if (!weight.some(value => value > 0.01)) return;
  for (let axis = 0; axis < 3; axis++) {
    const values = new Float32Array(count);
    for (let s = 0; s < count; s++) values[s] = eye[s * 3 + axis];
    const smooth = await smoothBlur(values, seconds(0.35), view);
    for (let s = 0; s < count; s++) eye[s * 3 + axis] += (smooth[s] - values[s]) * weight[s];
  }
}

// Full viewport projection using the planner's existing 16:9 convention.
// FOV is horizontal at 4:3: .75 converts it to vertical, not a safety margin.
function projected(eye, target, body, fov, out, offset) {
  let fx = target.x - eye.x, fy = target.y - eye.y, fz = target.z - eye.z;
  const length = Math.hypot(fx, fy, fz) || 1;
  fx /= length; fy /= length; fz /= length;
  const x = body.x - eye.x, y = body.y - eye.y, z = body.z - eye.z;
  const depth = x * fx + y * fy + z * fz, flat = Math.hypot(fx, fy) || 1;
  const tall = Math.tan(fov * Math.PI / 360) * 0.75;
  out[offset] = (x * fy - y * fx) / (flat * depth * tall * 16 / 9);
  out[offset + 1] = (z * flat - (x * fx + y * fy) * fz / flat) / (depth * tall);
  return depth >= 1 && Math.abs(out[offset]) <= 1 && Math.abs(out[offset + 1]) <= 1;
}

// Whether a point is in a shot's frame at sample s, for a 16:9 screen.
function framed(shot, s, point, fov) {
  const ex = shot.eye[s * 3], ey = shot.eye[s * 3 + 1], ez = shot.eye[s * 3 + 2];
  let fx = shot.target[s * 3] - ex, fy = shot.target[s * 3 + 1] - ey, fz = shot.target[s * 3 + 2] - ez;
  const length = Math.hypot(fx, fy, fz) || 1;
  fx /= length; fy /= length; fz /= length;
  const px = point.x - ex, py = point.y - ey, pz = point.z - ez, depth = px * fx + py * fy + pz * fz;
  if (depth < 1) return false;
  const flat = Math.hypot(fx, fy) || 1, rx = fy / flat, ry = -fx / flat;
  const across = px * rx + py * ry, up = Math.sqrt(Math.max(0, px * px + py * py + pz * pz - depth * depth - across * across));
  const tall = Math.tan(fov * Math.PI / 360) * 0.75;
  return Math.abs(across) <= tall * 16 / 9 * depth && up <= tall * depth;
}

// Angles kept continuous within a segment, so blurring never spins the long way.
function unwrap(angles, segment) {
  for (let i = 1; i < angles.length; i++) {
    if (segment[i] !== segment[i - 1]) continue;
    while (angles[i] - angles[i - 1] > Math.PI) angles[i] -= 2 * Math.PI;
    while (angles[i] - angles[i - 1] < -Math.PI) angles[i] += 2 * Math.PI;
  }
}

// The planned eye, target and fov at a fractional tick of run a, into out.
export function shotAt(plan, tick, out = {eye: {x: 0, y: 0, z: 0}, target: {x: 0, y: 0, z: 0}, fov: FOV}) {
  const at = clamp(tick / STEP, 0, plan.count - 1), low = Math.floor(at), high = Math.min(plan.count - 1, low + 1);
  const t = plan.segment[high] === plan.segment[low] ? at - low : tick >= (plan.cutTick?.[high] ?? high * STEP) ? 1 : 0;
  interpolatePoint(plan.eye, low, high, t, out.eye);
  interpolatePoint(plan.target, low, high, t, out.target);
  out.fov = plan.fov ? plan.fov[low] + (plan.fov[high] - plan.fov[low]) * t : FOV;
  return out;
}

function interpolatePoint(array, low, high, t, point) {
  point.x = array[low * 3] + (array[high * 3] - array[low * 3]) * t;
  point.y = array[low * 3 + 1] + (array[high * 3 + 1] - array[low * 3 + 1]) * t;
  point.z = array[low * 3 + 2] + (array[high * 3 + 2] - array[low * 3 + 2]) * t;
}

// The player's own adjustment on top of the plan: turned round the ghosts by
// yaw, raised by pitch (radians) and moved in or out by zoom.
export function adjust(shot, {yaw = 0, pitch = 0, zoom = 1} = {}) {
  const {eye, target} = shot;
  const dx = eye.x - target.x, dy = eye.y - target.y, dz = eye.z - target.z;
  const d = Math.hypot(dx, dy, dz) || 1;
  const az = Math.atan2(dy, dx) + yaw, el = clamp(Math.asin(clamp(dz / d, -1, 1)) + pitch, -0.35, 1.45);
  const far = clamp(d * zoom, MIN_DISTANCE * 0.6, MAX_DISTANCE * 1.6);
  eye.x = target.x + Math.cos(az) * Math.cos(el) * far;
  eye.y = target.y + Math.sin(az) * Math.cos(el) * far;
  eye.z = target.z + Math.sin(el) * far;
  return shot;
}

// The game's view angles (degrees, pitch positive down) looking from eye to target.
export function viewAngles(eye, target) {
  const dx = target.x - eye.x, dy = target.y - eye.y, dz = target.z - eye.z;
  return {yaw: Math.atan2(dy, dx) * 180 / Math.PI, pitch: -Math.atan2(dz, Math.hypot(dx, dy)) * 180 / Math.PI};
}
