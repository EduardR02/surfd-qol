// Compare's camera, planned for the whole replay before it plays. Both runs
// are known in advance, so every choice is smoothed both ways in time: the
// camera starts turning before a ramp instead of reacting to it, never lags
// the ghosts, and seeking needs no catching up.
//
// The shot: behind the ghosts and a little above, swung towards the open side
// of the ramp they surf, so you look onto the ramp face instead of through the
// ramp's back. The swing stops well short of side-on (MAX_SWING) to keep depth
// and the route ahead in view. Between ramps it eases back behind and rises a
// little, which also carries it over the ramp's edge when they switch sides.
// Geometry between the ghosts and the camera first turns the camera (a little
// round, then higher), then pulls it in, both before the obstruction arrives.
import {trackPoint, trackYaw} from './cinema-track.js';

export const STEP = 2;               // ticks per planned sample
const MAX_SWING = 50 * Math.PI / 180;
const ELEVATION = 15 * Math.PI / 180, ELEVATION_AIR = 12 * Math.PI / 180;
const BASE_DISTANCE = 230, MAX_DISTANCE = 1300, MIN_DISTANCE = 70;
// The view the plan frames for, in the game's horizontal (4:3) degrees.
export const FOV = 74;
const EYE_HEIGHT = 40;               // aim at the body, not the feet
const LEAD = 0.16;                   // room ahead of the ghosts, as a share of the distance
const CLEARANCE = 14;
// Detours tried when the planned spot is blocked: [swing, rise] in degrees.
const DETOURS = [[0, 0], [18, 0], [-18, 0], [0, 16], [36, 6], [-36, 6], [0, 32], [65, 12], [-65, 12], [0, 50]];
const TRACE_EVERY = 2;               // samples per occlusion test
const SLICE = 80;

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

// trace(from, to) is the clear fraction of the way, 1 when nothing is hit.
// Returns {count, eye, target, segment}: one entry every STEP ticks of run a.
export async function planCamera({a, b, map, trace = null, yieldTask = null, isCurrent = () => true}) {
  const count = Math.ceil(a.count / STEP) + 1;
  const sampleTick = s => Math.min(a.count - 1, s * STEP);
  const seconds = value => value / (a.dt * STEP);
  const focus = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
  const span = new Float32Array(count), speed = new Float32Array(count), side = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
  const segment = new Uint32Array(count);
  const pa = {x: 0, y: 0, z: 0}, pb = {x: 0, y: 0, z: 0};
  let cutAt = 0;
  for (let s = 0; s < count; s++) {
    const tick = sampleTick(s), other = map[tick], previous = s ? sampleTick(s - 1) : 0;
    let cut = false;
    for (let k = previous + 1; k <= tick && !cut; k++) cut = a.cut[k] === 1;
    for (let k = Math.floor(s ? map[previous] : other) + 1; k <= Math.ceil(other) && !cut; k++) cut = b.cut[k] === 1;
    if (s && cut) cutAt++;
    segment[s] = cutAt;
    trackPoint(a, tick, pa); trackPoint(b, other, pb);
    // Far apart (a different line, a skipped stage), frame the played run alone.
    const apart = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z), share = 0.5 * (1 - smoothstep(800, 1800, apart));
    focus[0][s] = pa.x + (pb.x - pa.x) * share;
    focus[1][s] = pa.y + (pb.y - pa.y) * share;
    focus[2][s] = pa.z + (pb.z - pa.z) * share + EYE_HEIGHT;
    span[s] = apart * share * 2;
    // Each run surfing a ramp votes for its open side.
    for (const [track, at] of [[a, tick], [b, Math.round(other)]]) {
      const o = clamp(at, 0, track.count - 1) * 3;
      const nx = track.normal[o], ny = track.normal[o + 1], length = Math.hypot(nx, ny);
      if (length > 1e-3) { side[0][s] += nx / length; side[1][s] += ny / length; side[2][s] += 1; }
    }
    if (side[2][s]) { side[0][s] /= side[2][s]; side[1][s] /= side[2][s]; side[2][s] = 1; }
  }
  // Travel: where the focus goes over the next and last third of a second.
  const reach = Math.max(1, Math.round(seconds(0.33)));
  const travel = [new Float32Array(count), new Float32Array(count)];
  for (let s = 0; s < count; s++) {
    let from = s, to = s;
    while (from > 0 && from > s - reach && segment[from - 1] === segment[s]) from--;
    while (to < count - 1 && to < s + reach && segment[to + 1] === segment[s]) to++;
    let dx = focus[0][to] - focus[0][from], dy = focus[1][to] - focus[1][from];
    speed[s] = to > from ? Math.hypot(dx, dy, focus[2][to] - focus[2][from]) / ((to - from) * a.dt * STEP) : 0;
    // Standing still (the start zone), face the way the player looks.
    if (Math.hypot(dx, dy) < 4 * (to - from + 1)) {
      const yaw = trackYaw(a, sampleTick(s)) * Math.PI / 180;
      dx = Math.cos(yaw); dy = Math.sin(yaw);
    }
    const length = Math.hypot(dx, dy) || 1;
    travel[0][s] = dx / length; travel[1][s] = dy / length;
  }
  const tx = blur(travel[0], seconds(0.55), segment), ty = blur(travel[1], seconds(0.55), segment);
  // The ramp side, blurred wide so the camera is already swinging as a ramp
  // comes up. The blur also weakens it over long flights.
  const sx = blur(side[0], seconds(0.8), segment), sy = blur(side[1], seconds(0.8), segment);
  const smoothSpan = blur(span, seconds(0.6), segment), smoothSpeed = blur(speed, seconds(0.8), segment);
  const azimuth = new Float32Array(count), elevation = new Float32Array(count), distance = new Float32Array(count);
  const halfView = Math.atan(Math.tan(FOV * Math.PI / 360) * 0.75) * 1.25;
  for (let s = 0; s < count; s++) {
    const length = Math.hypot(tx[s], ty[s]) || 1, fx = tx[s] / length, fy = ty[s] / length;
    // The ramp's open side relative to travel, from -1 (left) to 1 (right).
    // Right of travel is (fy, -fx) with z up, a quarter turn anticlockwise from behind.
    const lean = clamp((fy * sx[s] - fx * sy[s]) * 1.35, -1, 1);
    const behind = Math.atan2(-fy, -fx);
    azimuth[s] = behind + MAX_SWING * lean;
    elevation[s] = ELEVATION + ELEVATION_AIR * (1 - Math.abs(lean));
    distance[s] = clamp(Math.max(BASE_DISTANCE + smoothSpeed[s] * 0.035, smoothSpan[s] * 0.5 / Math.tan(halfView) * 1.35 + 120), BASE_DISTANCE, MAX_DISTANCE);
  }
  unwrap(azimuth, segment);
  const swing = new Float32Array(count), rise = new Float32Array(count), limit = new Float32Array(count).fill(MAX_DISTANCE);
  if (trace) {
    const from = {x: 0, y: 0, z: 0}, to = {x: 0, y: 0, z: 0};
    for (let s = 0; s < count; s += TRACE_EVERY) {
      if (s % (SLICE * TRACE_EVERY) === 0 && yieldTask) { await yieldTask(); if (!isCurrent()) return null; }
      from.x = focus[0][s]; from.y = focus[1][s]; from.z = focus[2][s];
      let best = null;
      for (const [turn, up] of DETOURS) {
        const az = azimuth[s] + turn * Math.PI / 180, el = Math.min(1.35, elevation[s] + up * Math.PI / 180), d = distance[s];
        to.x = from.x + Math.cos(az) * Math.cos(el) * d; to.y = from.y + Math.sin(az) * Math.cos(el) * d; to.z = from.z + Math.sin(el) * d;
        const clear = trace(from, to);
        const score = Math.min(1, clear / 0.7) - Math.abs(turn) * 0.004 - up * 0.005;
        if (!best || score > best.score) best = {score, turn, up, room: clear * d - CLEARANCE};
        if (clear >= 0.98) break;
      }
      for (let k = s; k < Math.min(count, s + TRACE_EVERY); k++) {
        swing[k] = best.turn * Math.PI / 180; rise[k] = best.up * Math.PI / 180; limit[k] = Math.max(MIN_DISTANCE, best.room);
      }
    }
  }
  const smoothSwing = blur(swing, seconds(0.45), segment), smoothRise = blur(rise, seconds(0.45), segment);
  const room = blur(lowest(limit, Math.round(seconds(0.45)), segment), seconds(0.2), segment);
  const az = blur(azimuth, seconds(0.35), segment), el = blur(elevation, seconds(0.5), segment), far = blur(distance, seconds(0.6), segment);
  const cx = blur(focus[0], seconds(0.12), segment), cy = blur(focus[1], seconds(0.12), segment), cz = blur(focus[2], seconds(0.2), segment);
  const eye = new Float32Array(count * 3), target = new Float32Array(count * 3);
  for (let s = 0; s < count; s++) {
    const d = clamp(Math.min(far[s], room[s]), MIN_DISTANCE, MAX_DISTANCE);
    const yaw = az[s] + smoothSwing[s], pitch = Math.min(1.35, el[s] + smoothRise[s]);
    const length = Math.hypot(tx[s], ty[s]) || 1, lead = Math.min(140, far[s] * LEAD);
    target[s * 3] = cx[s] + tx[s] / length * lead;
    target[s * 3 + 1] = cy[s] + ty[s] / length * lead;
    target[s * 3 + 2] = cz[s];
    eye[s * 3] = cx[s] + Math.cos(yaw) * Math.cos(pitch) * d;
    eye[s * 3 + 1] = cy[s] + Math.sin(yaw) * Math.cos(pitch) * d;
    eye[s * 3 + 2] = cz[s] + Math.sin(pitch) * d;
  }
  return {count, eye, target, segment};
}

// Angles kept continuous within a segment, so blurring never spins the long way.
function unwrap(angles, segment) {
  for (let i = 1; i < angles.length; i++) {
    if (segment[i] !== segment[i - 1]) continue;
    while (angles[i] - angles[i - 1] > Math.PI) angles[i] -= 2 * Math.PI;
    while (angles[i] - angles[i - 1] < -Math.PI) angles[i] += 2 * Math.PI;
  }
}

// The planned eye and target at a fractional tick of run a, into out.
export function shotAt(plan, tick, out = {eye: {x: 0, y: 0, z: 0}, target: {x: 0, y: 0, z: 0}}) {
  const at = clamp(tick / STEP, 0, plan.count - 1), low = Math.floor(at), high = Math.min(plan.count - 1, low + 1);
  const t = plan.segment[high] === plan.segment[low] ? at - low : 0;
  for (const [name, array] of [['eye', plan.eye], ['target', plan.target]]) {
    const point = out[name];
    point.x = array[low * 3] + (array[high * 3] - array[low * 3]) * t;
    point.y = array[low * 3 + 1] + (array[high * 3 + 1] - array[low * 3 + 1]) * t;
    point.z = array[low * 3 + 2] + (array[high * 3 + 2] - array[low * 3 + 2]) * t;
  }
  return out;
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
