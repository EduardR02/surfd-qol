// Compare's camera, planned for the whole replay before it plays. Every run is
// known in advance, so each choice is smoothed both ways in time: a move starts
// before the ramp or landing that calls for it, the camera never lags the
// ghosts, and seeking needs no catching up.
//
// The shots follow the played run's route. On a ramp the camera is out on its
// open side (the side its face looks to), so the ramp never hides the ghosts;
// in flight it rises behind them and leads towards where they'll land, which
// also carries it round to the next ramp's side. Two styles (STYLES): follow
// keeps one three-quarter chase throughout; cinematic gives each ramp its own
// shot, drifts round the prestrafe, opens high and wide after a teleport and
// pulls back at the finish. The view widens a little with speed.
// Geometry between the ghosts and the camera first turns the camera (a little
// round, then higher), then pulls it in, both before the obstruction arrives.
import {trackPoint, trackYaw} from './cinema-track.js';

export const STEP = 2;               // ticks per planned sample
// A shot: swing from behind towards the ramp's open side and elevation in
// degrees, distance as a multiple of the speed-based one, and room ahead as a
// share of the distance.
const CHASE = {swing: 32, elevation: 15, distance: 1, lead: 0.16};
const TRACK = {swing: 74, elevation: 14, distance: 1.8, lead: 0.3};    // alongside, across the face
const LOW = {swing: 52, elevation: -10, distance: 1.15, lead: 0.2};    // looking up the face
const HIGH = {swing: 24, elevation: 50, distance: 2.4, lead: 0.1};     // the ramp and what's next
const FOLLOW = {swing: 40, elevation: 16, distance: 1.1, lead: 0.18};  // steady, every ramp
// Per style: the shot for ramps under SHORT_RAMP seconds and the ones longer
// ramps take in turn; the shots in flight and before the start; how far round
// the start drifts (degrees); a teleport's opening and the finish's rise
// (degrees), widening and drift round; the share of the way to a landing the
// view leads by; the fov's widening at speed; and how long shots take to ease
// into each other (seconds either side).
const STYLES = {
  cinematic: {
    short: CHASE, long: [TRACK, LOW, TRACK, HIGH],
    flight: {swing: 0, elevation: 28, distance: 1.3, lead: 0.16}, start: {swing: 0, elevation: 20, distance: 1.45, lead: 0.1},
    orbit: 70, establish: {rise: 30, widen: 1.4}, finish: {rise: 22, widen: 1.4, swing: 30}, landing: 0.3, fov: 10, transition: 0.4,
  },
  follow: {
    short: FOLLOW, long: [FOLLOW],
    flight: {swing: 0, elevation: 23, distance: 1.2, lead: 0.16}, start: {swing: 0, elevation: 17, distance: 1.15, lead: 0.12},
    orbit: 0, establish: {rise: 0, widen: 0}, finish: {rise: 8, widen: 0.4, swing: 0}, landing: 0.15, fov: 6, transition: 0.55,
  },
};
const SHORT_RAMP = 0.9;
// Contact gaps under RAMP_GAP seconds are the same ramp; touches under RAMP_MIN aren't one.
const RAMP_GAP = 0.2, RAMP_MIN = 0.3, SAME_FACE = Math.cos(40 * Math.PI / 180);
// In flight the swing keeps this share of both ramps' swings: back behind
// between opposite sides, still out to the side between two on the same side.
const FLIGHT_SWING = 0.35;
// The view leads towards a landing at most this many seconds away.
const LANDING_AHEAD = 3;
// Before the start the camera drifts round to behind at ORBIT_RATE degrees a second.
const ORBIT_RATE = 14;
// A teleport's opening view settles over ESTABLISH seconds; the finish pulls back over FINISH.
const ESTABLISH = 2.2, FINISH = 2.5;
// Arriving over a ramp's ridge, its shot waits until they're on the face;
// leaving over it (or round its back), the shot ends early, so the camera is
// up behind them, not caught on the far side of the ramp.
const OVER_RIDGE = 0.4;
// Near behind, the camera stays at least this high above the ghosts (degrees),
// clear of the face they ride along; only out to the side can it go low.
const BEHIND_LOW = 20;
// The lead turns the view from the ghosts by at most this much (degrees).
const LEAD_TURN = 14;
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
const DETOURS = [[0, 0], [18, 0], [-18, 0], [0, 16], [36, 6], [-36, 6], [0, 32], [65, 12], [-65, 12], [0, 50]];
const TRACE_EVERY = 2;               // samples per occlusion test
const SLICE = 80;
const DEGREES = Math.PI / 180;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = (low, high, value) => { const t = clamp((value - low) / (high - low), 0, 1); return t * t * (3 - 2 * t); };

// A centred Gaussian blur that never reaches across a cut.
export function blur(values, sigma, segment) {
  if (sigma <= 0) return values.slice();
  const radius = Math.ceil(sigma * 3), weights = new Float32Array(radius + 1), out = new Float32Array(values.length);
  for (let k = 0; k <= radius; k++) weights[k] = Math.exp(-(k * k) / (2 * sigma * sigma));
  for (let i = 0; i < values.length; i++) {
    let total = values[i], weight = 1;
    for (let k = 1; k <= radius; k++) {
      if (i - k >= 0 && segment[i - k] === segment[i]) { total += values[i - k] * weights[k]; weight += weights[k]; }
      if (i + k < values.length && segment[i + k] === segment[i]) { total += values[i + k] * weights[k]; weight += weights[k]; }
    }
    out[i] = total / weight;
  }
  return out;
}
// The smallest value within radius, so a pull-in or rise starts before the obstruction.
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
// {from, to} sample ranges with the style's shot for each, its signed swing
// (positive towards the right of travel) and when the shot holds.
function findRamps(rampX, rampY, segment, runs, travel, samples, look) {
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
  let turn = 0;
  for (const ramp of ramps) {
    let nx = 0, ny = 0;
    for (let s = ramp.from; s <= ramp.to; s++) { nx += rampX[s]; ny += rampY[s]; }
    let fx = runs[ramp.to * 3] - runs[ramp.from * 3], fy = runs[ramp.to * 3 + 1] - runs[ramp.from * 3 + 1];
    if (Math.hypot(fx, fy) < 1) { const middle = (ramp.from + ramp.to) >> 1; fx = travel[0][middle]; fy = travel[1][middle]; }
    // Right of travel is (fy, -fx) with z up.
    const side = fy * nx - fx * ny >= 0 ? 1 : -1;
    ramp.shot = (ramp.to - ramp.from) < samples(SHORT_RAMP) ? look.short : look.long[turn++ % look.long.length];
    ramp.swing = side * ramp.shot.swing * DEGREES;
    // Coming from behind the face (over the ridge), or going there.
    const length = Math.hypot(nx, ny) || 1, before = Math.max(0, ramp.from - Math.round(samples(0.5))), after = Math.min(rampX.length - 1, ramp.to + Math.round(samples(0.5)));
    const behind = s => ((runs[s * 3] - runs[ramp.from * 3]) * nx + (runs[s * 3 + 1] - runs[ramp.from * 3 + 1]) * ny) / length < -50;
    ramp.start = ramp.from + (segment[before] === segment[ramp.from] && behind(before) ? Math.round(samples(OVER_RIDGE)) : 0);
    ramp.end = ramp.to - (segment[after] === segment[ramp.to] && behind(after) ? Math.round(samples(OVER_RIDGE)) : 0);
    if (ramp.end < ramp.start) ramp.start = ramp.end = (ramp.from + ramp.to) >> 1;
  }
  return ramps;
}

// trace(from, to) is the clear fraction of the way, 1 when nothing is hit.
// others: [{track, map}], each run and where it is for each of a's ticks
// ({b, map} for a single one). group frames every run together; without it
// the camera is on run a alone, the others passing through its shot.
// style is 'cinematic' or 'follow' (see STYLES).
// Returns {count, eye, target, fov, segment, cutTick}: one entry every STEP ticks of run a.
export async function planCamera({a, b = null, map = null, others = b ? [{track: b, map}] : [], group = true, style = 'cinematic', trace = null, yieldTask = null, isCurrent = () => true}) {
  const look = STYLES[style] ?? STYLES.cinematic;
  const count = Math.ceil(a.count / STEP) + 1;
  const sampleTick = s => Math.min(a.count - 1, s * STEP);
  const seconds = value => value / (a.dt * STEP);
  const focus = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
  const span = new Float32Array(count), speed = new Float32Array(count);
  const rampX = new Float32Array(count), rampY = new Float32Array(count);
  const segment = new Uint32Array(count), cutTick = new Uint32Array(count);
  // Positions of the played run and each other run, and how much each other run counts in the framing.
  const runs = [a, ...others.map(other => other.track)].map(() => new Float32Array(count * 3));
  const shares = others.map(() => new Float32Array(count));
  // Samples since and until each other run's own teleports.
  const since = others.map(() => new Float32Array(count).fill(Infinity)), until = others.map(() => new Float32Array(count).fill(Infinity));
  const point = {x: 0, y: 0, z: 0};
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
    for (const [index, {track, map: where}] of others.entries())
      for (let k = Math.floor(s ? where[previous] : where[tick]) + 1; k <= Math.floor(where[tick]) && !cut; k++)
        if (track.cut[k] === 1) { since[index][s] = until[index][s] = 0; break; }
    // The face run a touched last in this step, as a horizontal direction.
    for (let k = s ? previous + 1 : 0; k <= tick; k++) {
      const nx = a.normal[k * 3], ny = a.normal[k * 3 + 1], length = Math.hypot(nx, ny);
      if (length > 1e-3) { rampX[s] = nx / length; rampY[s] = ny / length; }
    }
    trackPoint(a, tick, point);
    runs[0][s * 3] = point.x; runs[0][s * 3 + 1] = point.y; runs[0][s * 3 + 2] = point.z;
    for (const [index, {track, map: where}] of others.entries()) {
      trackPoint(track, where[tick], point);
      runs[index + 1][s * 3] = point.x; runs[index + 1][s * 3 + 1] = point.y; runs[index + 1][s * 3 + 2] = point.z;
    }
  }
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
  for (let s = 0; s < count; s++) {
    let from = s, to = s;
    while (from > 0 && from > s - reach && segment[from - 1] === segment[s]) from--;
    while (to < count - 1 && to < s + reach && segment[to + 1] === segment[s]) to++;
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
  const ramps = findRamps(rampX, rampY, segment, runs[0], travel, seconds, look);
  const swingAt = new Float32Array(count), riseAt = new Float32Array(count), widenAt = new Float32Array(count), leadAt = new Float32Array(count);
  const ahead = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
  const ask = (s, shot, swing) => { swingAt[s] = swing; riseAt[s] = shot.elevation * DEGREES; widenAt[s] = shot.distance; leadAt[s] = shot.lead; };
  for (let s = 0, next = 0; s < count; s++) {
    while (next < ramps.length && ramps[next].to < s) next++;
    const ramp = ramps[next];
    if (ramp && ramp.start <= s && s <= ramp.end) { ask(s, ramp.shot, ramp.swing); continue; }
    // In the air, or on a ramp outside its shot: between the ramps either side.
    const leaving = ramp && ramp.end < s, around = leaving ? next + 1 : next;
    const before = around > 0 && segment[ramps[around - 1].to] === segment[s] ? ramps[around - 1] : null;
    const after = around < ramps.length && segment[ramps[around].from] === segment[s] ? ramps[around] : null;
    ask(s, look.flight, FLIGHT_SWING * ((before?.swing ?? 0) + (after?.swing ?? 0)));
    if (!(ramp && ramp.from <= s) && after && after.from - s <= seconds(LANDING_AHEAD))
      for (let axis = 0; axis < 3; axis++) ahead[axis][s] = runs[0][after.from * 3 + axis] - runs[0][s * 3 + axis];
  }
  // Before the start: a slow drift round from the first ramp's side to
  // behind, facing the way they'll leave.
  const first = Math.min(count - 1, Math.round(a.start / STEP));
  let zone = first;
  while (zone > 0 && segment[zone - 1] === segment[first]) zone--;
  const leave = Math.min(count - 1, first + Math.round(seconds(0.6)));
  const lx = runs[0][leave * 3] - runs[0][first * 3], ly = runs[0][leave * 3 + 1] - runs[0][first * 3 + 1], away = Math.hypot(lx, ly);
  if (zone < first && segment[leave] === segment[first] && away > 50) {
    const side = Math.sign(ramps.find(ramp => ramp.from >= first)?.swing ?? 1) || 1;
    for (let s = zone; s < first; s++) {
      const wait = (first - s) * a.dt * STEP;
      ask(s, look.start, side * Math.min(look.orbit, ORBIT_RATE * wait) * DEGREES);
      travel[0][s] = lx / away; travel[1][s] = ly / away;
      ahead[0][s] = ahead[1][s] = ahead[2][s] = 0;
    }
  }
  // After a teleport, a high wide view of where they are, settling in.
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

  // Blurred long enough to follow the route rather than each flight across a gap.
  const tx = blur(travel[0], seconds(1), segment), ty = blur(travel[1], seconds(1), segment);
  const ease = seconds(look.transition);
  const swing = blur(swingAt, ease, segment), rise = blur(riseAt, ease * 1.25, segment), widen = blur(widenAt, ease * 1.5, segment), leadShare = blur(leadAt, ease, segment);
  const toLanding = ahead.map(values => blur(values, seconds(0.3), segment));
  const smoothSpan = blur(span, seconds(0.6), segment), smoothSpeed = blur(speed, seconds(0.8), segment);
  const azimuth = new Float32Array(count), elevation = new Float32Array(count), distance = new Float32Array(count), fov = new Float32Array(count), halfViews = new Float32Array(count);
  for (let s = 0; s < count; s++) {
    fov[s] = FOV + look.fov * smoothstep(FOV_SLOW, FOV_FAST, smoothSpeed[s]);
    // The vertical half-angle: the narrower one, so a gap in height fits too.
    const halfView = halfViews[s] = Math.atan(Math.tan(fov[s] * Math.PI / 360) * 0.75);
    const length = Math.hypot(tx[s], ty[s]) || 1;
    azimuth[s] = Math.atan2(-ty[s] / length, -tx[s] / length) + swing[s];
    elevation[s] = Math.max(rise[s], BEHIND_LOW * DEGREES * (1 - smoothstep(15 * DEGREES, 40 * DEGREES, Math.abs(swing[s]))));
    distance[s] = clamp(Math.max((BASE_DISTANCE + smoothSpeed[s] * SPEED_DISTANCE) * widen[s], smoothSpan[s] * 0.5 / Math.tan(halfView) * 1.3 + 140), BASE_DISTANCE, MAX_DISTANCE);
  }
  unwrap(azimuth, segment);
  const detour = new Float32Array(count), lift = new Float32Array(count), limit = new Float32Array(count).fill(MAX_DISTANCE);
  if (trace) {
    const from = {x: 0, y: 0, z: 0}, to = {x: 0, y: 0, z: 0};
    for (let s = 0; s < count; s += TRACE_EVERY) {
      if (s % (SLICE * TRACE_EVERY) === 0 && yieldTask) { await yieldTask(); if (!isCurrent()) return null; }
      from.x = focus[0][s]; from.y = focus[1][s]; from.z = focus[2][s];
      let best = null;
      for (const [turn, up] of DETOURS) {
        const az = azimuth[s] + turn * DEGREES, el = Math.min(1.35, elevation[s] + up * DEGREES), d = distance[s];
        to.x = from.x + Math.cos(az) * Math.cos(el) * d; to.y = from.y + Math.sin(az) * Math.cos(el) * d; to.z = from.z + Math.sin(el) * d;
        const clear = trace(from, to);
        const score = Math.min(1, clear / 0.7) - Math.abs(turn) * 0.004 - up * 0.005;
        if (!best || score > best.score) best = {score, turn, up, room: clear * d - CLEARANCE};
        if (clear >= 0.98) break;
      }
      for (let k = s; k < Math.min(count, s + TRACE_EVERY); k++) {
        detour[k] = best.turn * DEGREES; lift[k] = best.up * DEGREES; limit[k] = Math.max(MIN_DISTANCE, best.room);
      }
    }
  }
  // A rise is held across the whole obstruction, so blurring can't shrink it into one that clips.
  const smoothDetour = blur(detour, seconds(0.45), segment);
  const smoothLift = blur(lowest(lift.map(value => -value), Math.round(seconds(0.3)), segment).map(value => -value), seconds(0.45), segment);
  const room = blur(lowest(limit, Math.round(seconds(0.45)), segment), seconds(0.2), segment);
  const az = blur(azimuth, seconds(0.3), segment), el = blur(elevation, seconds(0.3), segment), far = blur(distance, seconds(0.5), segment);
  // The shot from the smoothed choices. weight scales how far the framing
  // leans towards the other runs; limitTo caps the distance.
  const compose = (weight, limitTo) => {
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
    const cx = blur(fx, seconds(0.12), segment), cy = blur(fy, seconds(0.12), segment), cz = blur(fz, seconds(0.2), segment);
    const eye = new Float32Array(count * 3), target = new Float32Array(count * 3);
    for (let s = 0; s < count; s++) {
      const d = clamp(Math.min(far[s], room[s], limitTo[s]), MIN_DISTANCE, MAX_DISTANCE);
      const yaw = az[s] + smoothDetour[s], pitch = Math.min(1.35, el[s] + smoothLift[s]);
      const length = Math.hypot(tx[s], ty[s]) || 1, lead = Math.min(LEAD_MAX, far[s] * leadShare[s]);
      const ex = Math.cos(yaw) * Math.cos(pitch) * d, ey = Math.sin(yaw) * Math.cos(pitch) * d, ez = Math.sin(pitch) * d;
      // Room ahead and, in flight, towards the landing.
      let lx = tx[s] / length * lead + toLanding[0][s] * look.landing, ly = ty[s] / length * lead + toLanding[1][s] * look.landing, lz = toLanding[2][s] * look.landing;
      // Never so much that the ghosts drift from the middle: the part across
      // the view turns it by at most LEAD_TURN, and only into room the group
      // doesn't need, eased so it never jolts.
      const along = -(lx * ex + ly * ey + lz * ez) / d, across = Math.sqrt(Math.max(0, lx * lx + ly * ly + lz * lz - along * along));
      const most = Math.max(1, Math.min(Math.tan(LEAD_TURN * DEGREES) * Math.max(d * 0.5, d + along), Math.tan(halfViews[s]) * d * 0.85 - smoothSpan[s] * 0.5));
      if (across > 1e-6) { const k = most * Math.tanh(across / most) / across; lx *= k; ly *= k; lz *= k; }
      target[s * 3] = cx[s] + lx; target[s * 3 + 1] = cy[s] + ly; target[s * 3 + 2] = cz[s] + lz;
      eye[s * 3] = cx[s] + ex; eye[s * 3 + 1] = cy[s] + ey; eye[s * 3 + 2] = cz[s] + ez;
    }
    return {eye, target, focus: [cx, cy, cz]};
  };
  let weight = new Float32Array(count).fill(1), closest = new Float32Array(count).fill(MAX_DISTANCE);
  let shot = compose(weight, closest);
  // The smoothed shot can still end up behind something no detour was tested
  // against, and two lines either side of a wall can put the framing inside
  // it. Check what the camera really sees: where the played run is hidden,
  // frame it alone for a while; where the view is blocked, come in closer.
  for (let pass = 0; trace && pass < 2; pass++) {
    const hidden = new Float32Array(count), blocked = new Float32Array(count).fill(MAX_DISTANCE);
    const from = {x: 0, y: 0, z: 0}, to = {x: 0, y: 0, z: 0}, body = {x: 0, y: 0, z: 0};
    let found = false;
    for (let s = 0; s < count; s += TRACE_EVERY) {
      if (s % (SLICE * TRACE_EVERY) === 0 && yieldTask) { await yieldTask(); if (!isCurrent()) return null; }
      from.x = shot.focus[0][s]; from.y = shot.focus[1][s]; from.z = shot.focus[2][s];
      to.x = shot.eye[s * 3]; to.y = shot.eye[s * 3 + 1]; to.z = shot.eye[s * 3 + 2];
      body.x = runs[0][s * 3]; body.y = runs[0][s * 3 + 1]; body.z = runs[0][s * 3 + 2] + EYE_HEIGHT;
      const d = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z), clear = trace(from, to), seen = trace(body, to);
      for (let k = s; k < Math.min(count, s + TRACE_EVERY); k++) {
        if (clear < 0.97) { blocked[k] = Math.max(MIN_DISTANCE, clear * d - CLEARANCE); found = true; }
        if (seen < 0.97) { hidden[k] = 1; found = true; }
      }
    }
    if (!found) break;
    const lose = blur(lowest(hidden.map(value => 1 - value), Math.round(seconds(0.3)), segment), seconds(0.25), segment);
    weight = weight.map((value, s) => Math.min(value, lose[s]));
    const closer = blur(lowest(blocked, Math.round(seconds(0.45)), segment), seconds(0.2), segment);
    closest = closest.map((value, s) => Math.min(value, closer[s]));
    shot = compose(weight, closest);
  }
  return {count, eye: shot.eye, target: shot.target, fov, segment, cutTick};
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
