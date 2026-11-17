// The Cinematic camera: one continuous take, planned from the whole recorded
// route and the map it runs through.
//
// Terrain is part of the plan from the start. The space round the route is
// sampled into viewpoints, each knowing what it can see of the run and when
// (cinema-viewpoints.js); the take is the cheapest path through them over a
// whole stretch between teleports, so the camera is round a corner or over a
// wall before the run gets there instead of meeting it. The camera then
// flies that path with momentum (cinema-flight.js). Nothing is corrected
// afterwards: a sample the flight gets wrong is flown again, nearer the
// searched path.
//
// This file reads the route (the runs, the ramps, the group), has the
// direction say what view is asked for at each moment (cinema-direction.js),
// and aims, zooms and banks the lens along the finished flight. Only the
// played run's teleports cut.
//
// The take is the played run's. Added runs shift the view's centre and widen
// the shot within limits, are kept in frame where that costs little, and are
// kept out of the lens.
import {trackPoint, trackYaw} from './cinema-track.js';
import {searchTake, LENS} from './cinema-viewpoints.js';
import {fly} from './cinema-flight.js';
import {direct} from './cinema-direction.js';

export const STEP = 2;               // ticks per planned sample
// The view in the game's horizontal (4:3) degrees.
export const FOV = 74;
const DEGREES = Math.PI / 180;
const EYE_HEIGHT = 40;               // aim at the body, not the feet
// A run slower than this has no line of travel to speak of.
const MIN_SPEED = 300;
// However the group and the way ahead turn the view, the played run stays
// within this share of the frame's half-height of its middle.
const CENTRED = 0.55;
// Contact gaps under RAMP_GAP seconds are the same ramp; touches under RAMP_MIN aren't one.
const RAMP_GAP = 0.2, RAMP_MIN = 0.3, SAME_FACE = Math.cos(40 * DEGREES);
// The camera is in front of a ramp from LANDING seconds before the run
// touches it until LEAVING seconds after it has left: for the finished
// flight, for the searched path, and for what the search prefers (the three
// levels in cinema-viewpoints.js).
const LANDING = [0.4, 0.55, 0.8], LEAVING = [0.03, 0.12, 0.35];
// The working distance, the unit the direction's moves are measured in: from
// NEAR units at SLOW units a second to FAR at FAST.
const WORKING = {near: 450, far: 700, slow: 1200, fast: 3500};
// The lens is as wide as the move asks, and FOV_SPEED degrees wider at speed.
// It zooms in, to FOV_MIN at most, to keep the run the size the move asks
// for, and out, to FOV_MAX, before the run fills more than SIZE_MAX of the frame's height.
const SIZE_MAX = 0.3, FOV_MIN = 22, FOV_MAX = 100, FOV_SPEED = 9, FOV_SLOW = 1200, FOV_FAST = 3500;
// A run counts in the framing until it is GROUP_NEAR units from the played
// one, less and less out to GROUP_FAR. The group moves the view's centre off
// the played run by GROUP_SHIFT units at most and widens the working
// distance to GROUP_WIDEN times at most: runs that still don't fit are left
// out of frame rather than everyone being made small.
const GROUP_NEAR = 1200, GROUP_FAR = 2600, GROUP_SHIFT = 200, GROUP_WIDEN = 1.8;
// The view turns LOOK_SHARE of the way from the runs to where they will be in
// LOOK_AHEAD seconds, by LOOK_MAX degrees at most. Within NEAR units the
// camera aims at the played run alone.
const NEAR = [LENS, 260];
const LOOK_AHEAD = 0.8, LOOK_SHARE = 0.55, LOOK_MAX = 11;
// The camera banks into its own turns: ROLL degrees at most, half of that
// when it is pulled sideways at ROLL_HALF units a second squared, eased over
// ROLL_EASE seconds. ROLL 0 keeps the horizon level.
const ROLL = 10, ROLL_HALF = 3300, ROLL_EASE = 0.3;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = (low, high, value) => { const t = clamp((value - low) / (high - low), 0, 1); return t * t * (3 - 2 * t); };
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const angle = (a, b) => Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1));
// From unit vector a towards b at a steady turn; out may be neither.
function slerp(a, b, t, out) {
  const theta = angle(a, b), sin = Math.sin(theta);
  const ka = sin > 1e-4 ? Math.sin((1 - t) * theta) / sin : 1 - t, kb = sin > 1e-4 ? Math.sin(t * theta) / sin : t;
  const x = a[0] * ka + b[0] * kb, y = a[1] * ka + b[1] * kb, z = a[2] * ka + b[2] * kb, length = Math.hypot(x, y, z) || 1;
  out[0] = x / length; out[1] = y / length; out[2] = z / length;
  return out;
}

// A Gaussian blur that never reaches across a cut: from[i]..to[i] is i's segment.
async function blur(values, sigma, from, to, due, pause) {
  if (sigma <= 0) return values.slice();
  const radius = Math.ceil(sigma * 3), weights = new Float32Array(radius + 1), out = new Float32Array(values.length);
  for (let k = 0; k <= radius; k++) weights[k] = Math.exp(-(k * k) / (2 * sigma * sigma));
  for (let i = 0; i < values.length; i++) {
    if ((i & 127) === 0 && due()) await pause();
    let total = values[i], weight = 1;
    const left = Math.min(radius, i - from[i]), right = Math.min(radius, to[i] - i);
    for (let k = 1; k <= left; k++) { total += values[i - k] * weights[k]; weight += weights[k]; }
    for (let k = 1; k <= right; k++) { total += values[i + k] * weights[k]; weight += weights[k]; }
    out[i] = total / weight;
  }
  return out;
}

// trace(from, to) is the clear fraction of the way, 1 when nothing is hit;
// trace.view(eye, to), where given, the fraction to the first surface drawn,
// and trace.free(point, room) whether a camera fits at a point (see cinema-world.js).
// others: [{track, map}], each run and where it is for each of a's ticks.
// group frames every run together; without it the camera is on run a alone.
// Returns {count, eye, target, fov, roll, segment, cutTick}: one entry every STEP ticks of run a, or null when cancelled or no safe take was found.
export async function planCinematic({a, others = [], group = true, trace = null, yieldTask = null, isCurrent = () => true, debug = false}) {
  const cancelled = Symbol();
  try {
    const count = Math.ceil(a.count / STEP) + 1, dt = a.dt * STEP;
    const samples = seconds => seconds / dt;
    const sampleTick = s => Math.min(a.count - 1, s * STEP);
    let deadline = yieldTask ? await yieldTask() : null;
    if (!isCurrent()) return null;
    const due = () => !!yieldTask && !(deadline && !deadline.didTimeout && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() > 0.5);
    const pause = async () => {
      if (due()) deadline = await yieldTask();
      if (!isCurrent()) throw cancelled;
    };

    // Samples: segments between the played run's teleports, every run's
    // position and the face it rides, and the group's centre and span.
    const point = {x: 0, y: 0, z: 0};
    const segment = new Uint32Array(count), cutTick = new Uint32Array(count), segFrom = new Int32Array(count), segTo = new Int32Array(count);
    const runs = [a, ...others.map(other => other.track)].map(() => new Float32Array(count * 3)), faces = runs.map(() => new Float32Array(count * 3));
    const since = others.map(() => new Float32Array(count).fill(Infinity)), until = others.map(() => new Float32Array(count).fill(Infinity));
    const ride = (track, from, to, face, s) => {
      for (let k = from; k <= to; k++) {
        const nx = track.normal[k * 3], ny = track.normal[k * 3 + 1], nz = track.normal[k * 3 + 2];
        if (Math.hypot(nx, ny) <= 1e-3) continue;
        const length = Math.hypot(nx, ny, nz);
        face[s * 3] = nx / length; face[s * 3 + 1] = ny / length; face[s * 3 + 2] = nz / length;
      }
    };
    for (let s = 0, cuts = 0; s < count; s++) {
      if ((s & 127) === 0 && due()) await pause();
      const tick = sampleTick(s), previous = s ? sampleTick(s - 1) : 0;
      let cut = false;
      for (let k = previous + 1; k <= tick && !cut; k++) if (a.cut[k] === 1) { cut = true; cutTick[s] = k; }
      if (s && cut) cuts++;
      segment[s] = cuts;
      ride(a, s ? previous + 1 : 0, tick, faces[0], s);
      trackPoint(a, tick, point);
      runs[0][s * 3] = point.x; runs[0][s * 3 + 1] = point.y; runs[0][s * 3 + 2] = point.z + EYE_HEIGHT;
      for (let index = 0; index < others.length; index++) {
        const {track, map: where} = others[index];
        for (let k = Math.floor(s ? where[previous] : where[tick]) + 1; k <= Math.floor(where[tick]) && !cut; k++)
          if (track.cut[k] === 1) { since[index][s] = until[index][s] = 0; break; }
        const now = clamp(Math.floor(where[tick]), 0, track.count - 1);
        ride(track, now, now, faces[index + 1], s);
        trackPoint(track, where[tick], point);
        runs[index + 1][s * 3] = point.x; runs[index + 1][s * 3 + 1] = point.y; runs[index + 1][s * 3 + 2] = point.z + EYE_HEIGHT;
      }
    }
    for (let s = 0, start = 0; s <= count; s++) if (s === count || s && segment[s] !== segment[s - 1]) {
      for (let k = start; k < s; k++) {
        if (((k - start) & 255) === 0 && due()) await pause();
        segFrom[k] = start; segTo[k] = s - 1;
      }
      start = s;
    }
    // Another run's teleport doesn't cut the shot: it leaves the framing for a moment.
    for (let index = 0; index < others.length; index++) {
      for (let s = 1; s < count; s++) {
        if ((s & 255) === 0 && due()) await pause();
        since[index][s] = Math.min(since[index][s], since[index][s - 1] + 1);
      }
      for (let s = count - 2; s >= 0; s--) {
        if (((count - 2 - s) & 255) === 0 && due()) await pause();
        until[index][s] = Math.min(until[index][s], until[index][s + 1] + 1);
      }
    }
    const focus = [new Float32Array(count), new Float32Array(count), new Float32Array(count)], span = new Float32Array(count);
    const shares = others.map(() => new Float32Array(count));
    for (let s = 0; s < count; s++) {
      if ((s & 127) === 0 && due()) await pause();
      const o = s * 3, ax = runs[0][o], ay = runs[0][o + 1], az = runs[0][o + 2];
      let fx = ax, fy = ay, fz = az, total = 1;
      for (let index = 0; index < others.length; index++) {
        const r = runs[index + 1];
        const weight = group ? (1 - smoothstep(GROUP_NEAR, GROUP_FAR, Math.hypot(r[o] - ax, r[o + 1] - ay, r[o + 2] - az))) *
          smoothstep(samples(0.3), samples(0.9), Math.min(since[index][s], until[index][s])) : 0;
        shares[index][s] = weight;
        fx += r[o] * weight; fy += r[o + 1] * weight; fz += r[o + 2] * weight; total += weight;
      }
      // The take is the played run's: the others draw its centre towards
      // them by GROUP_SHIFT units at most, so a spread-out group can never
      // carry the camera off the run it follows or into the walls between.
      const cx = fx / total - ax, cy = fy / total - ay, cz = fz / total - az, off = Math.hypot(cx, cy, cz);
      const pull = off > 1e-3 ? GROUP_SHIFT * Math.tanh(off / GROUP_SHIFT) / off : 1;
      focus[0][s] = ax + cx * pull; focus[1][s] = ay + cy * pull; focus[2][s] = az + cz * pull;
      let reach = Math.hypot(ax - focus[0][s], ay - focus[1][s], az - focus[2][s]);
      for (let index = 0; index < others.length; index++) {
        const r = runs[index + 1];
        reach = Math.max(reach, shares[index][s] * Math.hypot(r[o] - focus[0][s], r[o + 1] - focus[1][s], r[o + 2] - focus[2][s]));
      }
      span[s] = reach * 2;
    }
    await pause();

    // The route: where the camera aims (lightly smoothed), and the heading
    // and speed along it.
    const sm = (values, seconds) => blur(values, samples(seconds), segFrom, segTo, due, pause);
    const aim = [await sm(focus[0], 0.1), await sm(focus[1], 0.1), await sm(focus[2], 0.14)];
    const wide = await sm(span, 0.6);
    const heading = [new Float32Array(count), new Float32Array(count)], speedRaw = new Float32Array(count), known = new Uint8Array(count), travel = new Float32Array(count * 3);
    const reach = Math.max(1, Math.round(samples(0.33)));
    for (let s = 0; s < count; s++) {
      if ((s & 255) === 0 && due()) await pause();
      const lo = Math.max(segFrom[s], s - reach), hi = Math.min(segTo[s], s + reach);
      const dx = focus[0][hi] - focus[0][lo], dy = focus[1][hi] - focus[1][lo], dz = focus[2][hi] - focus[2][lo], flat = Math.hypot(dx, dy), far = Math.hypot(dx, dy, dz);
      speedRaw[s] = hi > lo ? far / ((hi - lo) * dt) : 0;
      if (flat >= 4 * (hi - lo + 1)) { heading[0][s] = dx / flat; heading[1][s] = dy / flat; known[s] = 1; }
      if (speedRaw[s] > MIN_SPEED) { travel[s * 3] = dx / far; travel[s * 3 + 1] = dy / far; travel[s * 3 + 2] = dz / far; }
    }
    // Standing still, keep the way they last went (or will go), else where the player looks.
    for (let s = 1; s < count; s++) if (!known[s] && known[s - 1] && segment[s] === segment[s - 1]) { heading[0][s] = heading[0][s - 1]; heading[1][s] = heading[1][s - 1]; known[s] = 1; }
    for (let s = count - 2; s >= 0; s--) if (!known[s] && known[s + 1] && segment[s] === segment[s + 1]) { heading[0][s] = heading[0][s + 1]; heading[1][s] = heading[1][s + 1]; known[s] = 1; }
    for (let s = 0; s < count; s++) if (!known[s]) { const yaw = trackYaw(a, sampleTick(s)) * DEGREES; heading[0][s] = Math.cos(yaw); heading[1][s] = Math.sin(yaw); }
    // Before the start the route's own heading wanders: use the way they leave.
    const first = clamp(Math.round(a.start / STEP), 0, count - 1), zone = segFrom[first];
    const leave = Math.min(segTo[first], first + Math.round(samples(0.6)));
    const lx = focus[0][leave] - focus[0][first], ly = focus[1][leave] - focus[1][first], away = Math.hypot(lx, ly);
    const waits = first - zone >= samples(0.5) && away > 50;
    if (waits) for (let s = zone; s < first; s++) { heading[0][s] = lx / away; heading[1][s] = ly / away; }
    // Smoothed as an angle, so a sharp turn or a loop turns the frame with it
    // instead of averaging to nothing.
    const turnTo = new Float32Array(count);
    for (let s = 0; s < count; s++) {
      if ((s & 255) === 0 && due()) await pause();
      turnTo[s] = Math.atan2(heading[1][s], heading[0][s]);
      if (s && segment[s] === segment[s - 1]) turnTo[s] = turnTo[s - 1] + wrap(turnTo[s] - turnTo[s - 1]);
    }
    const bearing = await sm(turnTo, 0.6), hx = bearing.map(Math.cos), hy = bearing.map(Math.sin), speed = await sm(speedRaw, 0.7);

    // Ramps: {from, to, side} with side 1 where the face looks right of
    // travel. And every touchdown, however brief, for the samples before it.
    const ramps = [], landing = LANDING.map(() => new Int32Array(count).fill(-1)), leaving = LEAVING.map(() => new Int32Array(count).fill(-1)), face = faces[0];
    {
      const on = s => face[s * 3] !== 0 || face[s * 3 + 1] !== 0;
      const same = (s, k) => face[s * 3] * face[k * 3] + face[s * 3 + 1] * face[k * 3 + 1] + face[s * 3 + 2] * face[k * 3 + 2] >= SAME_FACE;
      let open = null;
      const close = () => { if (open && open.to - open.from >= samples(RAMP_MIN)) ramps.push(open); open = null; };
      for (let s = 0; s < count; s++) {
        if ((s & 255) === 0 && due()) await pause();
        if (open && (segment[s] !== segment[open.to] || s - open.to > samples(RAMP_GAP) || on(s) && !same(s, open.to))) close();
        if (!on(s)) continue;
        if (open) open.to = s; else open = {from: s, to: s};
      }
      close();
      for (const ramp of ramps) {
        let nx = 0, ny = 0;
        if (due()) await pause();
        for (let s = ramp.from; s <= ramp.to; s++) {
          if (((s - ramp.from) & 255) === 0 && due()) await pause();
          nx += face[s * 3]; ny += face[s * 3 + 1];
        }
        const middle = (ramp.from + ramp.to) >> 1;
        ramp.side = hy[middle] * nx - hx[middle] * ny >= 0 ? 1 : -1;
      }
      for (let s = count - 1; s > 0; s--) if (on(s) && (s === segFrom[s] || !on(s - 1) || !same(s, s - 1)))
        LANDING.forEach((early, level) => { for (let k = Math.max(segFrom[s], s - Math.round(samples(early))); k < s; k++) landing[level][k] = s; });
      for (let s = 0; s < count - 1; s++) if (on(s) && (s === segTo[s] || !on(s + 1) || !same(s, s + 1)))
        LEAVING.forEach((late, level) => { for (let k = s + 1; k <= Math.min(segTo[s], s + Math.round(samples(late))); k++) leaving[level][k] = s; });
    }

    // The map, as the search and the flight ask of it.
    const view = trace ? trace.view ?? trace : null, from = {x: 0, y: 0, z: 0}, to = {x: 0, y: 0, z: 0}, body = runs[0];
    const scene = {
      // What an eye is shown of the played run at a sample. The game draws
      // map faces from their front only, so from inside a solid the eye
      // looks straight out (trace.view knows; a plain trace is taken at its word).
      sees(x, y, z, s) {
        if (!view) return true;
        from.x = x; from.y = y; from.z = z; to.x = body[s * 3]; to.y = body[s * 3 + 1]; to.z = body[s * 3 + 2];
        return view(from, to) >= 1;
      },
      clear(ax, ay, az, bx, by, bz) {
        if (!trace) return 1;
        from.x = ax; from.y = ay; from.z = az; to.x = bx; to.y = by; to.z = bz;
        return trace(from, to);
      },
      free(x, y, z, room) {
        if (!trace?.view) return true;
        from.x = x; from.y = y; from.z = z;
        if (trace.free) return trace.free(from, room);
        trace.view(from, from);
        return trace.view.inside !== true;
      },
    };
    // The direction: the view asked for at each sample, as a direction from
    // the run to the eye, a distance and how much it matters; and the lens.
    const finish = a.finish < a.count - 1 ? clamp(Math.round(a.finish / STEP), 0, count - 1) : count;
    const tall = Math.tan(FOV * Math.PI / 360) * 0.75, working = new Float32Array(count);
    for (let s = 0; s < count; s++) {
      if ((s & 255) === 0 && due()) await pause();
      const solo = WORKING.near + (WORKING.far - WORKING.near) * clamp((speed[s] - WORKING.slow) / (WORKING.fast - WORKING.slow), 0, 1);
      working[s] = Math.min(solo * GROUP_WIDEN, Math.max(solo, wide[s] * 0.5 / tall * 1.3 + 140));
    }
    const route = {count, dt, segment, segFrom, segTo, runs, body, faces, shares, ramps, landing, leaving, centre: aim, hx, hy, turn: bearing, travel, speed, working, wide};
    const {intent, lens, moves} = await direct({route, start: {zone, first, waits}, finish, blur: sm, scene, due, pause});
    await pause();

    const take = await searchTake({route, intent, scene, due, pause, debug});
    if (!take) return null;
    const flown = await fly({route, scene, path: take.path, crossing: take.crossing, due, pause, debug});
    if (!flown) return null;
    const eye = flown.eye, target = new Float32Array(count * 3), fov = new Float32Array(count);
    await pause();

    // The view turns from the runs towards where they will be: into a bend
    // before they take it, down a drop, across to the ramp they are about to
    // land on. Never so far that the runs leave the middle of the frame.
    const lookAhead = Math.round(samples(LOOK_AHEAD));
    const unitA = [0, 0, 0], unitB = [0, 0, 0], towards = [0, 0, 0];
    for (let s = 0; s < count; s++) {
      if ((s & 127) === 0 && due()) await pause();
      const o = s * 3, dx = aim[0][s] - eye[o], dy = aim[1][s] - eye[o + 1], dz = aim[2][s] - eye[o + 2], d = Math.hypot(dx, dy, dz) || 1;
      const there = Math.min(segTo[s], s + lookAhead);
      const fx = aim[0][there] - eye[o], fy = aim[1][there] - eye[o + 1], fz = aim[2][there] - eye[o + 2], far = Math.hypot(fx, fy, fz) || 1;
      const apart = Math.acos(clamp((dx * fx + dy * fy + dz * fz) / (d * far), -1, 1));
      const upright = degrees => Math.atan(Math.tan(degrees * DEGREES / 2) * 0.75), near = Math.hypot(body[o] - eye[o], body[o + 1] - eye[o + 1], body[o + 2] - eye[o + 2]) || 1;
      const widest = upright(FOV + lens.wider[s] + FOV_SPEED * smoothstep(FOV_SLOW, FOV_FAST, speed[s]));
      const fit = Math.max(Math.atan(EYE_HEIGHT * 0.9 / (near * lens.size[s])), Math.atan((wide[s] * 0.5 + 70) / d * 1.25));
      const half = clamp(Math.max(Math.min(widest, fit), Math.atan(EYE_HEIGHT * 0.9 / (near * SIZE_MAX))), upright(FOV_MIN), upright(FOV_MAX));
      fov[s] = 2 * Math.atan(Math.tan(half) / 0.75) / DEGREES;
      // A long lens or a group across the frame leaves less room to turn, and
      // a point they will pass the camera to reach is not one to turn to.
      const most = Math.max(0, Math.min(LOOK_MAX * DEGREES, half * 0.45 - Math.atan(wide[s] * 0.5 / d)));
      const share = apart > 1e-4 ? Math.min(LOOK_SHARE, most / apart) * (1 - smoothstep(35 * DEGREES, 70 * DEGREES, apart)) : 0;
      // Towards the point where their line meets the runs' own distance, so a far point turns the view no further than a near one.
      target[o] = aim[0][s] + (eye[o] + fx * d / far - aim[0][s]) * share; target[o + 1] = aim[1][s] + (eye[o + 1] + fy * d / far - aim[1][s]) * share; target[o + 2] = aim[2][s] + (eye[o + 2] + fz * d / far - aim[2][s]) * share;
    }
    const zoom = await sm(fov, 0.22);
    for (let axis = 0; axis < 3; axis++) {
      const values = new Float32Array(count);
      for (let s = 0; s < count; s++) values[s] = target[s * 3 + axis];
      const calm = await sm(values, 0.12);
      for (let s = 0; s < count; s++) target[s * 3 + axis] = calm[s];
    }
    for (let s = 0; s < count; s++) {
      if ((s & 255) === 0 && due()) await pause();
      const o = s * 3, vx = target[o] - eye[o], vy = target[o + 1] - eye[o + 1], vz = target[o + 2] - eye[o + 2], v = Math.hypot(vx, vy, vz) || 1;
      const bx = body[o] - eye[o], by = body[o + 1] - eye[o + 1], bz = body[o + 2] - eye[o + 2], b = Math.hypot(bx, by, bz) || 1;
      const off = Math.acos(clamp((vx * bx + vy * by + vz * bz) / (v * b), -1, 1)), most = Math.atan(Math.tan(zoom[s] * DEGREES / 2) * 0.75) * CENTRED;
      if (off <= most) continue;
      unitA[0] = vx / v; unitA[1] = vy / v; unitA[2] = vz / v; unitB[0] = bx / b; unitB[1] = by / b; unitB[2] = bz / b;
      slerp(unitA, unitB, 1 - most / off, towards);
      target[o] = eye[o] + towards[0] * v; target[o + 1] = eye[o + 1] + towards[1] * v; target[o + 2] = eye[o + 2] + towards[2] * v;
    }
    // Close in, the least offset is a large angle: aim at the played run itself.
    for (let s = 0; s < count; s++) {
      if ((s & 255) === 0 && due()) await pause();
      const o = s * 3, lock = 1 - smoothstep(NEAR[0], NEAR[1], Math.hypot(eye[o] - body[o], eye[o + 1] - body[o + 1], eye[o + 2] - body[o + 2]));
      if (lock > 0) for (let axis = 0; axis < 3; axis++) target[o + axis] += (body[o + axis] - target[o + axis]) * lock;
    }
    // The bank: how hard the flight pulls to the side of where the lens looks.
    const lean = new Float32Array(count);
    if (ROLL > 0) for (let s = 1; s < count - 1; s++) {
      if ((s & 255) === 0 && due()) await pause();
      if (segment[s - 1] !== segment[s + 1]) continue;
      const o = s * 3, fx = target[o] - eye[o], fy = target[o + 1] - eye[o + 1], flat = Math.hypot(fx, fy);
      if (flat < 1) continue;
      const ax = (eye[o + 3] - 2 * eye[o] + eye[o - 3]) / (dt * dt), ay = (eye[o + 4] - 2 * eye[o + 1] + eye[o - 2]) / (dt * dt);
      lean[s] = ROLL * DEGREES * Math.tanh((ax * fy - ay * fx) / flat / ROLL_HALF * Math.atanh(0.5));
    }
    const plan = {count, eye, target, fov: zoom, roll: await sm(lean, ROLL_EASE), segment, cutTick};
    if (debug) Object.assign(plan, {path: take.path, crossing: take.crossing, search: take.search, flight: flown.flight, held: flown.weight, why: flown.why, intent, moves});
    if (!isCurrent()) return null;
    return plan;
  } catch (error) {
    if (error === cancelled) return null;
    throw error;
  }
}
