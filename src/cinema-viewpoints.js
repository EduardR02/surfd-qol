// The Cinematic camera's search: where the camera can be, and one take through it.
//
// Round the route, every SLICE samples, a spread of viewpoints is laid out in
// the world: at many bearings, heights and distances from where the run is
// then, on the route itself, and where the direction asks for the camera.
// They are fixed in the world, so one point serves many moments: ahead of the
// run before it gets there, beside it as it passes, behind it after. A point
// that terrain would bury or hide is drawn in along its line to the run until
// it stands clear, so a corridor is filled with viewpoints that fit it. What a
// point is worth at a moment comes from the map: whether it sees the run now,
// how much of the coming route it sees, and how near it is to the view asked
// for. The take is the cheapest path through (moment, viewpoint) over a whole
// stretch between teleports, so terrain shapes it from the start: the camera
// is already round the corner, over the wall or on the ramp's open side when
// the run gets there, because every other path was worse.
//
// Sightlines are only traced for what the search is about to use. At each
// moment the candidates are ranked by what they would cost if nothing were in
// the way, and traced in that order until enough stand.
const DEGREES = Math.PI / 180;
export const SLICE = 9;
// The lens stays LENS units from the played run and LENS_ANY from every run.
export const LENS = 110, LENS_ANY = 90;
// An eye must be in front of a ridden face by FACE_ROOM units and FACE_ANGLE
// (a sine) of its distance: behind the face the ramp hides the run, inside
// it the ramp is not drawn at all.
const FACE_ROOM = 40, FACE_ANGLE = Math.sin(8 * DEGREES);
// The rules are kept at three levels, each with more to spare (times the
// lens and face distances and the face's angle; and for a face, from longer
// before the run lands on it until longer after it has left, see
// planCinematic): FLOWN is what the finished flight must keep, SEARCHED what
// the searched path must, so the flight can round its corners, and ROOMY what
// the search prefers. A point that is not roomy costs TIGHT a second.
export const FLOWN = 0, SEARCHED = 1, ROOMY = 2;
const SPARE = [{lens: 1, room: 1, angle: 1}, {lens: 1.2, room: 1.5, angle: Math.sin(10.5 * DEGREES) / FACE_ANGLE}, {lens: 1.4, room: 1.8, angle: Math.sin(13 * DEGREES) / FACE_ANGLE}];
const TIGHT = 3;
// A viewpoint prefers ROOM units clear of anything solid; with less than WIDE
// it costs CLOSE a second. Where ROOM cannot fit, the search can fall back to
// the finished flight's SKIM clearance.
const ROOM = 30, WIDE = 140, CLOSE = 1;
// Rings of viewpoints round the run: distance in working distances, degrees
// above the run, and bearings in degrees from dead behind (each to both sides).
const RINGS = [
  [1, 15, [0, 35, 70, 110, 145, 180]],
  [0.6, 10, [0, 35, 80, 140]],
  [0.85, -6, [30, 75, 140]],
  [1.6, 14, [0, 35, 70, 110, 150, 180]],
  [1.25, 38, [0, 50, 100, 150]],
  [1.5, 65, [0, 90, 180]],
  [2.7, 22, [0, 35, 90, 145, 180]],
  [3.4, 48, [45, 135]],
];
// The view asked for is laid out at these shares of its distance as well.
const ASKED = [1, 0.72, 1.35];
// A point with terrain between it and the run is drawn in to PULL units short
// of that terrain, unless that leaves it nearer than PULL_LEAST of its distance.
const PULL = 60, PULL_LEAST = 0.3;
// Points on the route itself are raised this far off the ridden face, or straight up in the air.
const ON_ROUTE = [150, 60];
// A moment's candidates are the points laid out within REACH slices of it, no
// further from the run than FAR or FAR_ASKED times the distance asked for.
const REACH = 4, FAR = 2600, FAR_ASKED = 1.5;
// Sight of the route is asked for these slices ahead, each costing this much a second when missing: losing it soon costs most.
const AHEAD = [[1, 2.5], [2, 2], [4, 1.5], [6, 1.1], [9, 0.7]];
// And this far back, for where they came from.
const BEHIND = [2, 0.35];
// How far from the view asked for, in units of these, costs INTENT a second
// each (less and less steeply further out). Distance counts by its ratio
// (as a logarithm), and nearer than asked counts for more than further.
const INTENT = 1.1, OFF_BEARING = 30 * DEGREES, OFF_ELEVATION = 14 * DEGREES, OFF_DISTANCE = [0.22, 0.4];
// Looking along the line of travel, from behind or ahead, flattens it into
// depth (full cost within the first angle off it, none past the second);
// looking square across it loses where it leads (none before the first, full past the second).
// Within ALONG_LEAST of the line it costs ALONG_LAST more: a last resort.
const ALONG = [16 * DEGREES, 30 * DEGREES], ALONG_COST = 3, ALONG_LEAST = 11 * DEGREES, ALONG_LAST = 9, ACROSS = [58 * DEGREES, 85 * DEGREES], ACROSS_COST = 1.2;
// Looking straight onto the ridden face shows the face and nothing of where it leads.
const SQUARE = [18 * DEGREES, 32 * DEGREES], SQUARE_COST = 1.6;
// Another run within CROWD units of the lens, one left out of frame, and one whose ramp hides it.
const CROWD = [170, 420], CROWD_COST = 2.5, UNSEEN_COST = 1.2, OTHER_FACE_COST = 0.8;
const FRAMED = Math.cos(28 * DEGREES);
// Moving costs by the smaller of how far the camera moves in the world and
// how far it moves round the run: a camera that stands still and one that
// travels with the run are both calm. Per 1000 units a second, and its square.
const MOVE = 0.55, MOVE_FAST = 0.12;
// A change of the camera's own velocity from one leg to the next costs JOLT
// per 1000 units a second of it: the take keeps its momentum where it can.
const JOLT = 0.25;
// A sightline turning faster than PAN degrees a second is hard to follow, and
// one faster than PAN_MOST is not flown.
const PAN = 180, PAN_COST = 8, PAN_MOST = 420;
// The camera flies no faster than SPEED times the run, or SPEED_MIN units a second.
const SPEED = 2.2, SPEED_MIN = 3000;
// Flying through terrain costs CROSS, and is only possible through at most CROSS_DEPTH units of it.
const CROSS = 10, CROSS_DEPTH = 260;
// The search keeps BEAM candidates a moment, and the best in each of SECTORS
// directions round the run, low and high, and ON_LINE points on the route
// itself besides; it traces at most TRIED of them, and for each at most WAYS flights in.
const BEAM = 36, TRIED = 110, SECTORS = 6, ON_LINE = 3, WAYS = 2;
// Where the beam runs into a dead end, the BACK slices before it are decided again keeping WIDER times as much.
const BACK = 5, WIDER = 4;
// A take whose legs do not hold up sample by sample is reckoned again
// without them, REPAIRS times at most. A leg on which the run is hidden for one sample costs BLINK.
const REPAIRS = 24, BLINK = 2;
// A leg keeps SKIM units clear of anything solid along its way.
export const SKIM = 8;
// A hidden view costs HIDDEN a second when no visible path can be found.
const HIDDEN = 40;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = (low, high, value) => { const t = clamp((value - low) / (high - low), 0, 1); return t * t * (3 - 2 * t); };

// Whether an eye is behind or inside the face `run` rides at sample s.
function behind(face, run, s, x, y, z, room = 1, angle = 1) {
  const o = s * 3, nx = face[o], ny = face[o + 1], nz = face[o + 2];
  if (nx === 0 && ny === 0 && nz === 0) return false;
  const dx = x - run[o], dy = y - run[o + 1], dz = z - run[o + 2];
  return nx * dx + ny * dy + nz * dz < Math.max(FACE_ROOM * room, FACE_ANGLE * angle * Math.hypot(dx, dy, dz));
}
// Why an eye may not be at a point at sample s: 1 too near a run, 2 behind or
// inside the ramp the played run rides, is about to land on or has just
// left. 0 when it may.
export function barred(route, s, x, y, z, level = FLOWN) {
  const {runs, faces} = route, o = s * 3, {lens, room, angle} = SPARE[level];
  for (let index = 0; index < runs.length; index++) {
    const r = runs[index], dx = x - r[o], dy = y - r[o + 1], dz = z - r[o + 2], near = (index ? LENS_ANY : LENS) * lens;
    if (dx * dx + dy * dy + dz * dz < near * near) return 1;
  }
  if (behind(faces[0], runs[0], s, x, y, z, room, angle)) return 2;
  const next = route.landing[level][s], last = route.leaving[level][s];
  if (next >= 0 && behind(faces[0], runs[0], next, x, y, z, room, angle)) return 2;
  return last >= 0 && behind(faces[0], runs[0], last, x, y, z, room, angle) ? 2 : 0;
}

// route: the sampled run (see planCinematic). intent: per sample, the view
// asked for as a direction from the run to the eye (x, y, z), a distance and
// how much it matters (weight). scene: sees(x, y, z, s), clear(ax..bz) and
// free(x, y, z, room) over the map. Returns the take as a path, one point a
// sample, with `crossing` marking where it flies through terrain; null when no
// path satisfying the flown face, lens and clearance rules can be found.
export async function searchTake({route, intent, scene, due, pause, debug = false}) {
  const {count, dt, segTo, runs, faces, shares, centre, hx, hy, travel, speed, working} = route, body = runs[0];
  // Slices: the moments the search decides at, per stretch between teleports.
  const at = [], lowest = [], highest = [];
  for (let s = 0; s < count; s = segTo[s] + 1) {
    const from = at.length, hi = segTo[s];
    for (let k = s, n = 0; k < hi; k += SLICE, n++) {
      if ((n & 255) === 0 && due()) await pause();
      at.push(k);
    }
    if (at.length > from + 1 && hi - at[at.length - 1] < SLICE / 2) at[at.length - 1] = hi; else at.push(hi);
    for (let k = from; k < at.length; k++) {
      if (((k - from) & 255) === 0 && due()) await pause();
      lowest.push(from); highest.push(at.length - 1);
    }
  }
  const slices = at.length;

  // Viewpoints, laid out slice by slice.
  const perSlice = RINGS.reduce((sum, ring) => sum + ring[2].reduce((n, bearing) => n + (bearing % 180 ? 2 : 1), 0), 0) + ASKED.length + 2;
  const P = new Float32Array(slices * perSlice * 3), home = new Int32Array(slices * perSlice), onRoute = new Uint8Array(slices * perSlice), starts = new Int32Array(slices + 1);
  let points = 0;
  const add = (k, x, y, z, route = 0) => { P[points * 3] = x; P[points * 3 + 1] = y; P[points * 3 + 2] = z; onRoute[points] = route; home[points++] = k; };
  // A point round the run at slice k, drawn in where terrain stands between.
  const lay = (k, bx, by, bz, x, y, z) => {
    const far = Math.hypot(x, y, z), clear = scene.clear(bx, by, bz, bx + x, by + y, bz + z);
    const share = clear >= 1 ? 1 : Math.max(clear - PULL / far, 0);
    if (share < 1 && share >= PULL_LEAST && share * far >= LENS * SPARE[ROOMY].lens) add(k, bx + x * share, by + y * share, bz + z * share);
    else add(k, bx + x, by + y, bz + z);
  };
  for (let k = 0; k < slices; k++) {
    await pause();
    const s = at[k], o = s * 3, bx = body[o], by = body[o + 1], bz = body[o + 2], D = working[s], A = intent.distance[s];
    starts[k] = points;
    for (const [distance, elevation, bearings] of RINGS) {
      if (due()) await pause();
      const flat = Math.cos(elevation * DEGREES) * distance * D, up = Math.sin(elevation * DEGREES) * distance * D;
      for (const bearing of bearings) for (const side of bearing % 180 ? [1, -1] : [1]) {
        const c = Math.cos(bearing * DEGREES), w = Math.sin(bearing * DEGREES) * side;
        lay(k, bx, by, bz, (-hx[s] * c + hy[s] * w) * flat, (-hy[s] * c - hx[s] * w) * flat, up);
      }
    }
    if (due()) await pause();
    for (const share of ASKED) lay(k, bx, by, bz, intent.x[s] * A * share, intent.y[s] * A * share, intent.z[s] * A * share);
    // On the route, here and half a slice on: behind the run later, ahead of it earlier, and clear by definition.
    for (const q of s < segTo[s] ? [s, Math.min(segTo[s], s + (SLICE >> 1))] : [s]) {
      const i = q * 3, nx = faces[0][i], ny = faces[0][i + 1], nz = faces[0][i + 2], on = nx !== 0 || ny !== 0 || nz !== 0;
      add(k, body[i] + (on ? nx * ON_ROUTE[0] : 0), body[i + 1] + (on ? ny * ON_ROUTE[0] : 0), body[i + 2] + (on ? nz * ON_ROUTE[0] : ON_ROUTE[1]), 1);
    }
  }
  starts[slices] = points;

  // What the map says of a point, asked once: whether a camera fits there,
  // and whether it sees the run at a slice.
  const stats = {slices, points, fitted: 0, sights: 0, flights: 0, tried: 0, proofs: 0, repairs: 0, crossings: 0, widened: 0, relaxed: 0};
  const fits = new Uint8Array(points), BACK = REACH + BEHIND[0], SPAN = BACK + REACH + AHEAD[AHEAD.length - 1][0] + 1, sight = new Uint8Array(points * SPAN);
  const wide = new Uint8Array(points);
  let minimum = null;
  const open = p => {
    if (!wide[p]) { stats.fitted++; wide[p] = scene.free(P[p * 3], P[p * 3 + 1], P[p * 3 + 2], WIDE) ? 1 : 2; }
    return wide[p] === 1;
  };
  const fit = p => {
    if (!fits[p]) { stats.fitted++; fits[p] = scene.free(P[p * 3], P[p * 3 + 1], P[p * 3 + 2], ROOM) ? 1 : 2; }
    return fits[p] === 1;
  };
  const fitMinimum = p => {
    minimum ??= new Uint8Array(points);
    if (!minimum[p]) { stats.fitted++; minimum[p] = scene.free(P[p * 3], P[p * 3 + 1], P[p * 3 + 2], SKIM) ? 1 : 2; }
    return minimum[p] === 1;
  };
  const seen = (p, j) => {
    const i = p * SPAN + j - home[p] + BACK;
    if (!sight[i]) { stats.sights++; sight[i] = scene.sees(P[p * 3], P[p * 3 + 1], P[p * 3 + 2], at[j]) ? 1 : 2; }
    return sight[i] === 1;
  };
  // What terrain makes of a point at slice k, a second: unusable where it
  // cannot see the run, dearer the less of the route ahead it sees.
  const terrain = (k, p, relax, narrow) => {
    const roomy = open(p);
    if (!roomy && !fit(p) && (!narrow || !fitMinimum(p))) return Infinity;
    let cost = roomy ? 0 : CLOSE;
    if (!seen(p, k)) { if (!relax) return Infinity; cost += HIDDEN; }
    for (const [ahead, missing] of AHEAD) if (k + ahead <= highest[k] && !seen(p, k + ahead)) cost += missing;
    if (k - BEHIND[0] >= lowest[k] && !seen(p, k - BEHIND[0])) cost += BEHIND[1];
    return cost;
  };
  // What a point is worth at slice k for the view it gives, a second, before terrain.
  const regard = (k, p, rule) => {
    const s = at[k], o = s * 3, x = P[p * 3], y = P[p * 3 + 1], z = P[p * 3 + 2];
    const dx = x - body[o], dy = y - body[o + 1], dz = z - body[o + 2], d = Math.hypot(dx, dy, dz);
    let cost = 0;
    if (barred(route, s, x, y, z, rule)) return Infinity;
    else if (barred(route, s, x, y, z, ROOMY)) cost = TIGHT;
    const flat = Math.hypot(dx, dy), elevation = Math.atan2(dz, flat), asked = Math.asin(clamp(intent.z[s], -1, 1));
    const round = Math.atan2(dy, dx) - Math.atan2(intent.y[s], intent.x[s]);
    const bearing = Math.atan2(Math.sin(round), Math.cos(round)) * Math.cos(elevation) / OFF_BEARING;
    const rise = (elevation - asked) / OFF_ELEVATION, ratio = Math.log(d / intent.distance[s]), reach = ratio / OFF_DISTANCE[ratio < 0 ? 0 : 1];
    cost += INTENT * intent.weight[s] * (Math.sqrt(1 + bearing * bearing + rise * rise + reach * reach) - 1);
    const tx = travel[o], ty = travel[o + 1], tz = travel[o + 2];
    if (tx !== 0 || ty !== 0 || tz !== 0) {
      const off = Math.acos(Math.min(1, Math.abs(dx * tx + dy * ty + dz * tz) / d));
      cost += ALONG_COST * (1 - smoothstep(ALONG[0], ALONG[1], off)) + (off < ALONG_LEAST ? ALONG_LAST : 0) + ACROSS_COST * smoothstep(ACROSS[0], ACROSS[1], off);
    }
    const nx = faces[0][o], ny = faces[0][o + 1], nz = faces[0][o + 2];
    if (nx !== 0 || ny !== 0 || nz !== 0) cost += SQUARE_COST * (1 - smoothstep(SQUARE[0], SQUARE[1], Math.acos(clamp((dx * nx + dy * ny + dz * nz) / d, -1, 1))));
    if (runs.length > 1) {
      const cx = centre[0][s] - x, cy = centre[1][s] - y, cz = centre[2][s] - z, c = Math.hypot(cx, cy, cz) || 1;
      let shown = 0, counted = 0, crowd = 0;
      for (let index = 1; index < runs.length; index++) {
        const r = runs[index], ox = r[o] - x, oy = r[o + 1] - y, oz = r[o + 2] - z, far = Math.hypot(ox, oy, oz) || 1, share = shares[index - 1][s];
        crowd = Math.max(crowd, 1 - smoothstep(CROWD[0], CROWD[1], far));
        if (share < 0.05) continue;
        counted += share;
        if ((ox * cx + oy * cy + oz * cz) / (far * c) > FRAMED) shown += share;
        if (behind(faces[index], r, s, x, y, z)) cost += OTHER_FACE_COST * share;
      }
      cost += CROWD_COST * crowd;
      if (counted > 0) cost += UNSEEN_COST * (1 - shown / counted);
    }
    return cost;
  };

  // The flight from one slice's point to the next's.
  const seconds = k => (at[k + 1] - at[k]) * dt;
  const offset = (k, p, out) => { const o = at[k] * 3; out[0] = P[p * 3] - body[o]; out[1] = P[p * 3 + 1] - body[o + 1]; out[2] = P[p * 3 + 2] - body[o + 2]; return out; };
  const fromRun = [0, 0, 0], toRun = [0, 0, 0];
  let rigid = false;
  const hop = (k, u, v, relax) => {
    const T = seconds(k), world = Math.hypot(P[v * 3] - P[u * 3], P[v * 3 + 1] - P[u * 3 + 1], P[v * 3 + 2] - P[u * 3 + 2]);
    if (world > Math.max(SPEED * speed[at[k]], SPEED_MIN) * T && relax < 2) return Infinity;
    offset(k, u, fromRun); offset(k + 1, v, toRun);
    const round = Math.hypot(toRun[0] - fromRun[0], toRun[1] - fromRun[1], toRun[2] - fromRun[2]);
    rigid = round < world;
    const moved = Math.min(world, round) / T / 1000;
    let cost = (MOVE * moved + MOVE_FAST * moved * moved) * T;
    // The sightline turns fastest where the run passes nearest: there, or at
    // the nearer end of the leg when the nearest point is beyond it.
    if (round > 1) {
      const mx = toRun[0] - fromRun[0], my = toRun[1] - fromRun[1], mz = toRun[2] - fromRun[2];
      const t = clamp(-(fromRun[0] * mx + fromRun[1] * my + fromRun[2] * mz) / (round * round), 0, 1);
      const nx = fromRun[0] + mx * t, ny = fromRun[1] + my * t, nz = fromRun[2] + mz * t, near = Math.hypot(nx, ny, nz);
      if (near < LENS && relax < 2) return Infinity;
      const across = Math.hypot(ny * mz - nz * my, nz * mx - nx * mz, nx * my - ny * mx) / (near || 1), turn = across / ((near || 1) * T) / DEGREES;
      if (turn > PAN_MOST && relax < 2) return Infinity;
      if (turn > PAN) cost += PAN_COST * (turn / PAN - 1) ** 2 * T;
    }
    return cost;
  };
  // What it costs to leave slice k's kept candidate j for point v: the change from the velocity it arrived with.
  const jolt = (k, keep, j, v) => {
    const from = keep.from[j];
    if (from < 0) return 0;
    const u = keep.p[j], w = kept[k - 1].p[from], before = seconds(k - 1), after = seconds(k);
    return JOLT / 1000 * Math.hypot((P[v * 3] - P[u * 3]) / after - (P[u * 3] - P[w * 3]) / before, (P[v * 3 + 1] - P[u * 3 + 1]) / after - (P[u * 3 + 1] - P[w * 3 + 1]) / before,
      (P[v * 3 + 2] - P[u * 3 + 2]) / after - (P[u * 3 + 2] - P[w * 3 + 2]) / before);
  };
  // Where the flight is at a sample between the two: straight through the
  // world, or keeping its place by the run when that is the smaller move.
  const between = (k, u, v, s, out) => {
    const f = (s - at[k]) / (at[k + 1] - at[k]);
    if (rigid) {
      const a = at[k], b = at[k + 1];
      for (let axis = 0; axis < 3; axis++) out[axis] = centre[axis][s] + (P[u * 3 + axis] - centre[axis][a]) * (1 - f) + (P[v * 3 + axis] - centre[axis][b]) * f;
    } else for (let axis = 0; axis < 3; axis++) out[axis] = P[u * 3 + axis] + (P[v * 3 + axis] - P[u * 3 + axis]) * f;
    return out;
  };
  // How much terrain the straight line between two points passes through.
  const walls = new Map(), middle = [0, 0, 0];
  const through = (u, v) => {
    if (u === v) return 0;
    const key = u < v ? u * points + v : v * points + u;
    let depth = walls.get(key);
    if (depth === undefined) {
      stats.flights++;
      const ax = P[u * 3], ay = P[u * 3 + 1], az = P[u * 3 + 2], bx = P[v * 3], by = P[v * 3 + 1], bz = P[v * 3 + 2];
      const clear = scene.clear(ax, ay, az, bx, by, bz);
      if (clear >= 1) depth = 0;
      else { stats.flights++; depth = Math.max(1, (1 - clear - scene.clear(bx, by, bz, ax, ay, az)) * Math.hypot(bx - ax, by - ay, bz - az)); }
      walls.set(key, depth);
    }
    return depth;
  };
  // 0 clear, 1 through terrain, 2 hidden, 3 unsafe. The flown and searched
  // face/lens rules need separate caches when a narrow passage needs FLOWN.
  const refused = [new Set(), new Set()], unseen = [new Set(), new Set()], flown = [new Map(), new Map()];
  const leg = (k, u, v) => (k * points + u) * points + v;
  const flight = (k, u, v, rule) => {
    const key = leg(k, u, v);
    if (refused[rule].has(key)) return 3;
    if (unseen[rule].has(key)) return 2;
    let state = flown[rule].get(key);
    if (state === undefined) flown[rule].set(key, state = survey(k, u, v, rule));
    return state;
  };
  const survey = (k, u, v, rule) => {
    hop(k, u, v, 2);
    const depth = through(u, v);
    if (depth > CROSS_DEPTH) return 3;
    const a = at[k], b = at[k + 1];
    for (let q = 1; q < 4; q++) {
      const s = Math.round(a + (b - a) * q / 4);
      between(k, u, v, s, middle);
      if (barred(route, s, middle[0], middle[1], middle[2], rule)) return 3;
    }
    for (let q = 1; q < 3; q++) {
      const s = Math.round(a + (b - a) * q / 3);
      if (s <= a || s >= b) continue;
      between(k, u, v, s, middle);
      stats.sights++;
      if (!scene.sees(middle[0], middle[1], middle[2], s)) return 2;
    }
    return depth > 0 ? 1 : 0;
  };

  // One pass over each stretch: every slice keeps its best candidates with
  // the cost of the cheapest take that reaches them.
  const kept = new Array(slices), path = new Float32Array(count * 3), crossing = new Uint8Array(count), chosen = new Int32Array(slices);
  const sector = (k, p) => {
    const s = at[k], o = s * 3, dx = P[p * 3] - body[o], dy = P[p * 3 + 1] - body[o + 1], dz = P[p * 3 + 2] - body[o + 2];
    const round = Math.atan2(dy * hx[s] - dx * hy[s], -(dx * hx[s] + dy * hy[s]));
    return Math.min(SECTORS - 1, Math.floor((round + Math.PI) / (2 * Math.PI) * SECTORS)) + (dz > 0.45 * Math.hypot(dx, dy, dz) ? SECTORS : 0);
  };
  const decide = async (k, relax, wider, narrow = false, rule = SEARCHED) => {
    const s = at[k], o = s * 3, before = k > lowest[k] ? kept[k - 1] : null, T = before ? seconds(k - 1) : dt * SLICE;
    const legRule = before ? Math.min(before.rule, rule) : rule;
    const cand = [], own = [], value = [], via = [], known = new Map();
    // Each candidate's best way in, taking untraced flights as clear unless only traced ones will do.
    const reach = (i, p, traced) => {
      let best = Infinity, from = -1;
      const any = known.size > 0;
      for (let j = 0; j < before.n; j++) {
        const u = before.p[j], state = any ? known.get(j * points + p) : undefined;
        if (state === undefined ? traced : state === 3 || state === 2 && relax < 1) continue;
        const way = hop(k - 1, u, p, relax);
        if (way === Infinity) continue;
        const cost = before.value[j] + way + jolt(k - 1, before, j, p) + (state === 1 ? CROSS : state === 2 ? HIDDEN * T : 0);
        if (cost < best) { best = cost; from = j; }
      }
      via[i] = from;
      return best;
    };
    for (let home = Math.max(lowest[k], k - REACH); home <= Math.min(highest[k], k + REACH); home++) for (let p = starts[home]; p < starts[home + 1]; p++) {
      if (((p - starts[home]) & 15) === 0 && due()) await pause();
      if (fits[p] === 2 && (!narrow || minimum?.[p] === 2)) continue;
      const far = Math.hypot(P[p * 3] - body[o], P[p * 3 + 1] - body[o + 1], P[p * 3 + 2] - body[o + 2]);
      if (far > Math.max(FAR, FAR_ASKED * intent.distance[s])) continue;
      const view = regard(k, p, rule);
      if (view === Infinity) continue;
      const i = cand.length;
      cand.push(p); own.push(view * T);
      if (before) value.push(reach(i, p, false) + own[i]); else { via[i] = -1; value.push(own[i]); }
    }
    const order = cand.map((_, i) => i).filter(i => value[i] < Infinity).sort((i, j) => value[i] - value[j] || i - j);
    const beam = BEAM * wider, room = beam + (SECTORS * 2 + ON_LINE) * wider, keep = {p: new Int32Array(room), value: new Float64Array(room), cost: new Float64Array(room), from: new Int32Array(room), n: 0, relax, rule};
    const standing = new Uint8Array(SECTORS * 2 + 1), attempts = new Uint8Array(SECTORS * 2 + 1);
    let best = Infinity, tried = 0;
    for (let n = 0; n < order.length; n++) {
      const i = order[n], p = cand[i], cell = onRoute[p] ? SECTORS * 2 : sector(k, p), main = keep.n < beam || value[i] < best;
      // Past the beam, only directions with nothing standing yet are still
      // looked into, and the route's own line: whatever closes in round the
      // run, the way it came stays open.
      const wanted = (onRoute[p] ? ON_LINE : 1) * wider;
      if (!main && (standing[cell] >= wanted || attempts[cell] >= wanted + 2)) continue;
      if (tried >= TRIED * wider && keep.n && !onRoute[p]) break;
      if (due()) await pause();
      // The way in is traced before it is counted on: the likeliest few, then the best of those.
      if (before) {
        for (let traced = 0; via[i] >= 0 && !known.has(via[i] * points + p); traced++) {
          if (traced === WAYS) { value[i] = reach(i, p, true) + own[i]; break; }
          known.set(via[i] * points + p, flight(k - 1, before.p[via[i]], p, legRule));
          value[i] = reach(i, p, false) + own[i];
        }
        if (via[i] < 0 || value[i] === Infinity) continue;
        // Dearer than it looked, it waits its turn again.
        if (n + 1 < order.length && value[i] > value[order[n + 1]] + 1e-9) {
          let m = n + 1;
          while (m < order.length && value[order[m]] < value[i]) { order[m - 1] = order[m]; m++; }
          order[m - 1] = i; n--;
          continue;
        }
      }
      tried++; attempts[cell]++;
      const ground = terrain(k, p, relax, narrow);
      if (ground === Infinity) continue;
      const total = value[i] + ground * T;
      keep.p[keep.n] = p; keep.value[keep.n] = total; keep.cost[keep.n] = own[i] + ground * T; keep.from[keep.n] = via[i]; keep.n++;
      standing[cell]++;
      if (total < best) best = total;
      if (keep.n === room) break;
    }
    stats.tried += tried;
    return keep;
  };
  // A dead end is retried wide, first with preferred clearance, then with the
  // flown clearance and rules. Only after visible choices fail may it accept
  // a hidden one; no tier admits a point barred by its face or lens rules.
  const recover = async k => {
    for (let tier = 0; tier < 5; tier++) {
      const relax = tier < 3 ? 0 : tier - 2, narrow = tier > 0, rule = tier < 2 ? SEARCHED : FLOWN;
      const keep = await decide(k, relax, WIDER, narrow, rule);
      if (keep.n) return keep;
      stats.relaxed++;
    }
    return null;
  };
  const settle = async k => {
    kept[k] = await decide(k, 0, 1);
    if (kept[k].n) return true;
    stats.widened++;
    for (let again = Math.max(lowest[k], k - BACK); again <= k; again++) {
      kept[again] = await recover(again);
      if (!kept[again]) return false;
    }
    return true;
  };
  // Prove every sample of a leg. A broken hard rule is never admitted;
  // temporarily lost sight is kept separately so it can still be penalized.
  const sound = [new Set(), new Set()], blinks = [new Set(), new Set()], here = [0, 0, 0];
  const proof = async (from, to) => {
    let first = -1, unsafe = false;
    for (let k = from; k < to; k++) {
      if (due()) await pause();
      const u = chosen[k], v = chosen[k + 1], key = leg(k, u, v), rule = Math.min(kept[k].rule, kept[k + 1].rule);
      if (sound[rule].has(key) || refused[rule].has(key) || blinks[rule].has(key) || unseen[rule].has(key)) continue;
      hop(k, u, v, 2);
      const crosses = through(u, v) > 0;
      let fails = false, hardFail = false, lost = 0;
      for (let s = at[k] + 1; s < at[k + 1] && !hardFail; s++) {
        between(k, u, v, s, here);
        stats.proofs++;
        if (!scene.sees(here[0], here[1], here[2], s)) lost++;
        const barredHere = barred(route, s, here[0], here[1], here[2], rule), solid = !crosses && !scene.free(here[0], here[1], here[2], SKIM);
        fails ||= barredHere !== 0 || solid;
        hardFail = solid || barredHere !== 0 && (rule === FLOWN || barred(route, s, here[0], here[1], here[2], FLOWN) !== 0);
      }
      if (!fails && !lost) { sound[rule].add(key); continue; }
      if (fails) { refused[rule].add(key); unsafe ||= hardFail; }
      else (lost > 1 ? unseen[rule] : blinks[rule]).add(key);
      if (first < 0) first = k;
    }
    return {first, unsafe};
  };
  // The cheapest take through the candidates already kept, from a slice on:
  // the same reckoning as decide, over what it kept, with what the proof
  // found. Where nothing kept can be reached any more, the slices from
  // BACK before there on are decided afresh.
  const relink = async (first, last) => {
    for (let k = first + 1; k <= last; k++) {
      const before = kept[k - 1], now = kept[k], T = seconds(k - 1), rule = Math.min(before.rule, now.rule);
      let alive = 0;
      for (let pass = 0; pass < 2 && !alive; pass++) {
        if (pass) { now.relax = Math.max(1, now.relax); stats.relaxed++; }
        for (let i = 0; i < now.n; i++) {
          if ((i & 3) === 0 && due()) await pause();
          const p = now.p[i];
          let best = Infinity, from = -1;
          for (let traced = 0; ; traced++) {
            best = Infinity; from = -1;
            for (let j = 0; j < before.n; j++) {
              if (before.value[j] === Infinity) continue;
              const key = leg(k - 1, before.p[j], p), state = refused[rule].has(key) ? 3 : unseen[rule].has(key) ? 2 : flown[rule].get(key);
              if (state === undefined ? traced > WAYS : state === 3 || state === 2 && now.relax < 1) continue;
              const way = hop(k - 1, before.p[j], p, now.relax);
              if (way === Infinity) continue;
              const cost = before.value[j] + way + jolt(k - 1, before, j, p) + (state === 1 ? CROSS : state === 2 ? HIDDEN * T : 0) + (blinks[rule].has(key) ? BLINK : 0);
              if (cost < best) { best = cost; from = j; }
            }
            if (from < 0 || traced > WAYS) break;
            const key = leg(k - 1, before.p[from], p);
            if (refused[rule].has(key) || unseen[rule].has(key) || flown[rule].has(key)) break;
            if (traced < WAYS) flight(k - 1, before.p[from], p, rule);
          }
          now.from[i] = from; now.value[i] = from < 0 ? Infinity : best + now.cost[i];
          if (from >= 0) alive++;
        }
      }
      if (alive) continue;
      stats.widened++;
      for (let again = Math.max(lowest[k], k - BACK); again <= last; again++) {
        if (again > k) { if (!await settle(again)) return false; continue; }
        kept[again] = await recover(again);
        if (!kept[again]) return false;
      }
      return true;
    }
    return true;
  };
  for (let k = 0; k < slices; k++) {
    await pause();
    if (!await settle(k)) return null;
    if (k < highest[k]) continue;
    // The stretch is done: its cheapest take, read back from the end, and
    // reckoned again from any leg that does not hold up.
    const lo = lowest[k];
    for (let round = 0; ; round++) {
      let j = 0;
      for (let i = 1; i < kept[k].n; i++) if (kept[k].value[i] < kept[k].value[j]) j = i;
      for (let back = k; back >= lo; back--) { chosen[back] = kept[back].p[j]; j = kept[back].from[j]; }
      const checked = await proof(lo, k);
      if (checked.first < 0 || round === REPAIRS && !checked.unsafe) break;
      if (round === REPAIRS) return null;
      stats.repairs++;
      await pause();
      if (!await relink(checked.first, k)) return null;
    }
    for (let back = lo; back <= k; back++) {
      if (due()) await pause();
      const p = chosen[back];
      if (back === k) { path[at[back] * 3] = P[p * 3]; path[at[back] * 3 + 1] = P[p * 3 + 1]; path[at[back] * 3 + 2] = P[p * 3 + 2]; break; }
      const next = chosen[back + 1];
      hop(back, p, next, 2);
      const crosses = through(p, next) > 0;
      if (crosses) stats.crossings++;
      for (let s = at[back]; s < at[back + 1]; s++) {
        between(back, p, next, s, here);
        path[s * 3] = here[0]; path[s * 3 + 1] = here[1]; path[s * 3 + 2] = here[2];
        if (crosses) crossing[s] = 1;
      }
      if (crosses) crossing[at[back + 1]] = 1;
    }
  }
  const take = {path, crossing};
  if (debug) take.search = {...stats, at: Int32Array.from(at), chosen: Array.from(chosen, p => [P[p * 3], P[p * 3 + 1], P[p * 3 + 2]])};
  return take;
}
