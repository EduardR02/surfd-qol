// The Cinematic camera's direction: what the camera does over the take.
//
// The take is read as stretches: each ramp, with the approach to it, and each
// flight between ramps long enough to be a shot of its own, and each sharp
// turn of the route. Every stretch is given a move, a way for the view to
// travel round the run while it lasts: closing in low, passing the run or
// being passed, leading it, craning up over a flight, going under it,
// standing far off on a long lens, or running ahead to a place in the world
// (the outside of a turn, the lip of a ramp, a landing) and waiting there
// for the run to come past. The moves
// are chosen for the whole take at once: each stretch for what suits it (how
// long, how fast, how big the air, whether the map leaves room), each pair of
// neighbours for whether the camera can get from one to the next in the time
// there is, and the whole for variety. The boldest moves go to the biggest
// airs and the fastest ramps.
//
// What comes out is only the view asked for at each moment (the intent) and
// the lens that goes with it. The search still owns the map: where a move
// cannot be flown as asked, the camera does the nearest thing that can.
const DEGREES = Math.PI / 180;
// A pose: bearing in degrees from dead behind the run towards the ramp's open
// side, elevation above the run, distance in working distances (or `far`
// units), the lens in degrees wider than usual, and the least share of the
// frame's height the run may fill.
const SIZE = 0.075;
const HOME = {b: 35, e: 15, d: 1, lens: 0, size: SIZE};
// A ramp's stretch starts ARRIVE seconds before the run lands on it: its move
// is in place by then. A flight shorter than FLIGHT seconds is only the way
// from one ramp's move to the next; one longer than SPLIT is several stretches.
const ARRIVE = 0.4, FLIGHT = 1, SPLIT = 4.5;
// The moves. `on` is the kind of stretch a move is for; fit(stretch) what a
// second of it is worth there, or 0 where it does not suit; keys its poses,
// at shares of the way through the stretch; kind what sort of shot it is, for
// contrast; reach the distances a far pose is tried at, the furthest the map
// has room for being used. A key with an anchor is a place in the world
// instead of a pose: the camera is asked to be there from that key to the
// next. A stretch has seconds, fast and big (its rank among the take's ramps
// by speed, or flights by length, 0 to 1), crowd (how much added runs widen
// the shot, 0 to 1), flips (whether the next ramp faces the other way) and
// the places found for it: lip (by the end of its ramp), landing (by the
// end of its flight) and outside (of its turn).
const MOVES = [
  {name: 'home', on: 'ramp', kind: 'mid', fit: () => 0.2,
    keys: () => [{u: 0, ...HOME}, {u: 1, ...HOME}]},
  {name: 'low', on: 'ramp', kind: 'close', fit: ({seconds, fast, crowd}) => seconds >= 0.9 ? (0.45 + 0.5 * fast) * (1 - crowd) : 0,
    keys: () => [{u: 0, b: 27, e: 3, d: 0.55, lens: 12}, {u: 1, b: 30, e: 5, d: 0.6, lens: 12}]},
  {name: 'lead', on: 'ramp', kind: 'ahead', fit: () => 0.4,
    keys: () => [{u: 0, b: 150, e: 16, d: 1}, {u: 1, b: 148, e: 18, d: 1.05}]},
  {name: 'overtake', on: 'ramp', kind: 'pass', fit: ({seconds, fast}) => seconds >= 1.5 ? 0.6 + 0.3 * fast : 0,
    keys: () => [{u: 0, b: 32, e: 10, d: 0.85, lens: 4}, {u: 0.5, b: 95, e: 8, d: 0.62, lens: 10}, {u: 1, b: 150, e: 14, d: 0.95, lens: 2}]},
  {name: 'dropback', on: 'ramp', kind: 'pass', fit: ({seconds, fast}) => seconds >= 1.5 ? 0.6 + 0.3 * fast : 0,
    keys: () => [{u: 0, b: 150, e: 14, d: 0.95, lens: 2}, {u: 0.5, b: 90, e: 8, d: 0.62, lens: 10}, {u: 1, b: 32, e: 12, d: 0.9, lens: 4}]},
  {name: 'high', on: 'ramp', kind: 'high', fit: ({flips}) => flips ? 0.45 : 0.25,
    keys: () => [{u: 0, b: 24, e: 44, d: 1.3}, {u: 1, b: 24, e: 44, d: 1.3}]},
  {name: 'long', on: 'ramp', kind: 'wide', reach: [2600, 2000, 1500], fit: ({seconds, crowd}) => seconds >= 1.8 ? 0.6 * (1 - crowd) : 0,
    keys: (stretch, far) => [{u: 0, b: 66, e: 9, far, lens: -48}, {u: 1, b: 60, e: 10, far, lens: -48}]},
  {name: 'lip', on: 'ramp', kind: 'wait', fit: ({seconds, lip, fast}) => lip && seconds >= 1.5 ? 0.6 + 0.3 * fast : 0,
    keys: ({seconds, lip}) => [{u: 1 - WAIT / seconds, anchor: lip, lens: 8}, {u: 1, anchor: lip, lens: 8}]},

  {name: 'home', on: 'air', kind: 'mid', fit: () => 0.2,
    keys: () => [{u: 0.5, ...HOME}]},
  {name: 'crane', on: 'air', kind: 'wide', fit: ({seconds, big}) => seconds >= 1.5 ? 0.4 + 0.6 * big : 0,
    keys: () => [{u: 0.3, b: 55, e: 46, d: 2.4, lens: -4, size: 0.045}, {u: 0.65, b: 62, e: 50, d: 2.4, lens: -4, size: 0.045}]},
  {name: 'under', on: 'air', kind: 'under', fit: ({seconds, big}) => seconds >= 1.2 ? 0.35 + 0.5 * big : 0,
    keys: () => [{u: 0.35, b: 24, e: -40, d: 0.85, lens: 14}, {u: 0.65, b: 24, e: -40, d: 0.85, lens: 14}]},
  {name: 'swing', on: 'air', kind: 'pass', fit: ({seconds, big}) => seconds >= 1.2 ? 0.5 + 0.3 * big : 0,
    keys: () => [{u: 0.1, b: 42, e: 18, d: 1}, {u: 0.5, b: 95, e: 30, d: 1.1}, {u: 0.95, b: 150, e: 20, d: 1}]},
  {name: 'fallback', on: 'air', kind: 'pass', fit: ({seconds}) => seconds >= 1.2 ? 0.55 : 0,
    keys: () => [{u: 0.1, b: 150, e: 16, d: 1}, {u: 0.5, b: 90, e: 10, d: 0.65, lens: 10}, {u: 0.95, b: 35, e: 14, d: 0.95}]},
  {name: 'lead', on: 'air', kind: 'ahead', fit: () => 0.35,
    keys: () => [{u: 0.25, b: 150, e: 16, d: 1}, {u: 0.8, b: 150, e: 16, d: 1}]},
  {name: 'high', on: 'air', kind: 'high', fit: () => 0.3,
    keys: () => [{u: 0.3, b: 24, e: 44, d: 1.3}, {u: 0.7, b: 24, e: 44, d: 1.3}]},
  {name: 'long', on: 'air', kind: 'wide', reach: [2600, 2000, 1500], fit: ({seconds, crowd}) => seconds >= 2 ? 0.55 * (1 - crowd) : 0,
    keys: (stretch, far) => [{u: 0.2, b: 70, e: 6, far, lens: -48}, {u: 0.85, b: 70, e: 8, far, lens: -48}]},
  {name: 'flyby', on: 'air', kind: 'wait', fit: ({seconds, landing, big}) => landing && seconds >= 1.5 ? 0.55 + 0.3 * big : 0,
    keys: ({seconds, landing}) => [{u: 1 - WAIT / seconds, anchor: landing, lens: 8}, {u: 1, anchor: landing, lens: 8}]},

  {name: 'home', on: 'turn', kind: 'mid', fit: () => 0.2,
    keys: () => [{u: 0.5, ...HOME}]},
  {name: 'pivot', on: 'turn', kind: 'wait', fit: ({outside}) => outside ? 1.2 : 0,
    keys: ({seconds, outside}) => [{u: 1 - (WAIT + TURN.after) / seconds, anchor: outside, lens: 6}, {u: 1, anchor: outside, lens: 6}]},
];
// A turn is the route's heading changing by TURN.by degrees within TURN.within
// seconds; its stretch runs from `before` seconds ahead of the middle of
// the turn to `after` seconds past it.
const TURN = {by: 100, within: 1.4, before: 1.8, after: 0.9};
// The camera is in its place WAIT seconds before the run comes past. The
// places tried, the ideal first: units out to the open side (or the outside
// of the turn), on along the line of travel, and up. A place is no use if
// the run comes at it head on: it is at least OFF_LINE degrees off the run's
// line of travel when the wait begins.
const WAIT = 0.6, OFF_LINE = 20, PLACES = {lip: [[560, 80, 90], [440, 60, 220], [320, 40, 260]], landing: [[560, 0, 40], [440, 0, 200], [320, 0, 260]], outside: [[560, 0, 140], [420, 0, 200], [300, 0, 240]]};
// A stretch cut by a turn keeps what is left of it if that is at least REST seconds.
const REST = 0.6;
// The most of the take each move may fill, once it is used more than once.
const CAPS = {home: 0.35, low: 0.2, lead: 0.12, overtake: 0.12, dropback: 0.12, high: 0.15, long: 0.14, crane: 0.18, under: 0.1, swing: 0.12, fallback: 0.12, lip: 0.12, flyby: 0.12, pivot: 1};
// A move is only chosen where FEASIBLE of its poses stand clear in the map and see the run.
const FEASIBLE = 0.75, PROBE_ROOM = 40;
// Getting from one move to the next: the view may turn round the run at RATE
// degrees a second (a doubling of distance counting as REACH degrees) before
// it costs HASTE for each time over, squared. A move that follows itself
// costs REPEAT (home REPEAT_HOME), less the shorter the two stretches are below
// PHRASE seconds: a run of quick ramps is one phrase. A neighbour of another kind is worth CONTRAST.
const RATE = 170, REACH = 55, HASTE = 1.5, TRANSIT_LEAST = 0.3, REPEAT = 1.2, REPEAT_HOME = 0.1, PHRASE = [0.8, 2], CONTRAST = 0.25;
// A move over its cap is made dearer by CAP_STEP a second and the take chosen again, CAP_ROUNDS times at most.
const CAP_STEP = 0.08, CAP_ROUNDS = 12;
// The view matters AIRBORNE as much in a flight that has no move of its own
// as on a ramp or APPROACH seconds before one, and LOOSELY as much where it
// crosses the line of travel: how it gets across is the search's to choose.
// A place it waits in matters PLACED as much.
const AIRBORNE = 0.6, APPROACH = 0.8, LOOSELY = 0.5, PLACED = 1.3;
// A view never rests on the line of travel: within LINE degrees of it, behind
// or ahead, it rises towards OVER degrees above, so a change of side goes over
// the top; one already UNDER degrees below goes as far beneath instead.
const LINE = [18, 42], OVER = 42, UNDER = [-22, -4];
// Before the start: round the waiting run from ahead of it to beside it, then SETTLE seconds to the first move.
const START = {b: [135, 70], e: 7, d: 1.25, weight: 1.5}, SETTLE = 0.6;
// After a teleport: high and wide, settling to the first move over `seconds`.
const ESTABLISH = {b: 40, e: 40, d: 2.2, weight: 1.5, seconds: 1.6};
// Past the finish: back, up and round over `seconds`.
const FINISH = {b: 50, e: 38, d: 2.2, weight: 1.5, seconds: 2.5};
// The asked view's corners are rounded over ROUNDED seconds; its poses are at least APART seconds from each other.
const ROUNDED = 0.3, APART = 0.25;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = (low, high, value) => { const t = clamp((value - low) / (high - low), 0, 1); return t * t * (3 - 2 * t); };

// Poses are measured from the run's line of travel, FOLLOW of the way: as it
// dives the view from behind rises over it and the view from ahead sinks, by
// CLIMB degrees at most. The line's own pitch is smoothed over PITCHED seconds.
const FOLLOW = 0.6, CLIMB = 40, PITCHED = 0.5;

// The direction from the run to the eye for a signed bearing and an elevation, in degrees, at sample s.
function towards({hx, hy, pitch}, s, bearing, elevation, out) {
  const c = Math.cos(bearing * DEGREES), w = Math.sin(bearing * DEGREES), up = clamp(elevation - FOLLOW * pitch[s] * c, -75, 75) * DEGREES, flat = Math.cos(up);
  out[0] = (-hx[s] * c + hy[s] * w) * flat; out[1] = (-hy[s] * c - hx[s] * w) * flat; out[2] = Math.sin(up);
  return out;
}

// route: {count, dt, segment, segFrom, segTo, ramps, body, faces, hx, hy, turn, travel, speed, working,
// wide} as planCinematic reads them; start: {zone, first, waits}; finish: the
// sample the run finishes at (count when it does not); blur(values, seconds)
// smooths within a segment; scene as the search has it. due and pause share
// the planner's cooperative budget and cancellation check.
// Returns the intent, the lens ({wider, size}, per sample) and the moves chosen ({name, on, from, to}, in samples).
export async function direct({route, start, finish, blur, scene, due, pause}) {
  const {count, dt, segment, segFrom, segTo, ramps, body, faces, hx, hy, turn, travel, speed, working, wide} = route;
  const samples = seconds => Math.round(seconds / dt), arrive = samples(ARRIVE);
  const pitch = new Float32Array(count);
  for (let s = 0; s < count; s++) {
    if ((s & 255) === 0 && due()) await pause();
    pitch[s] = clamp(Math.asin(clamp(travel[s * 3 + 2], -1, 1)) / DEGREES, -CLIMB, CLIMB);
  }
  const frame = {hx, hy, pitch: await blur(pitch, PITCHED)};

  // Stretches, in order: {on, from, to, side, next}, side being the open
  // side of the ramp ridden or left and next that of the ramp ahead.
  const stretches = [];
  const flight = async (from, to, side, next) => {
    const parts = Math.ceil((to - from + 1) * dt / SPLIT);
    for (let part = 0; part < parts; part++) {
      if ((part & 63) === 0 && due()) await pause();
      stretches.push({on: 'air', from: from + Math.round((to - from + 1) * part / parts), to: from + Math.round((to - from + 1) * (part + 1) / parts) - 1, side, next: part + 1 < parts ? side : next});
    }
  };
  for (let s = 0; s < count; s = segTo[s] + 1) {
    if (due()) await pause();
    const end = segTo[s], inside = [];
    for (let i = 0; i < ramps.length; i++) {
      if ((i & 255) === 0 && due()) await pause();
      const ramp = ramps[i];
      if (ramp.from >= s && ramp.from <= end) inside.push(ramp);
    }
    let at = s;
    for (let index = 0; index < inside.length; index++) {
      if ((index & 63) === 0 && due()) await pause();
      const ramp = inside[index], land = Math.max(at, ramp.from - arrive), side = ramp.side;
      if ((land - at) * dt >= FLIGHT) { await flight(at, land - 1, index ? inside[index - 1].side : side, side); at = land; }
      stretches.push({on: 'ramp', from: at, to: ramp.to, side, next: inside[index + 1]?.side ?? side});
      at = ramp.to + 1;
    }
    if (at <= end && (!inside.length || (end - at + 1) * dt >= FLIGHT)) await flight(at, end, inside.at(-1)?.side ?? 1, inside.at(-1)?.side ?? 1);
    else if (inside.length) stretches[stretches.length - 1].last = end;
  }
  const settled = start.waits ? start.first + samples(SETTLE) : -1;
  // The first of the places tried by the run at a sample that stands clear
  // and sees the run at each of the samples watched: out along a direction, on along its travel, and up.
  const find = (places, at, ox, oy, watched) => {
    const flat = Math.hypot(ox, oy);
    if (flat < 1e-3) return null;
    for (const [out, on, up] of places) {
      const x = body[at * 3] + ox / flat * out + hx[at] * on, y = body[at * 3 + 1] + oy / flat * out + hy[at] * on, z = body[at * 3 + 2] + up;
      const s = watched[0], dx = x - body[s * 3], dy = y - body[s * 3 + 1], dz = z - body[s * 3 + 2];
      const along = Math.abs(dx * travel[s * 3] + dy * travel[s * 3 + 1] + dz * travel[s * 3 + 2]) / (Math.hypot(dx, dy, dz) || 1);
      if (along < Math.cos(OFF_LINE * DEGREES) && scene.free(x, y, z, PROBE_ROOM) && watched.every(s => scene.sees(x, y, z, s))) return [x, y, z];
    }
    return null;
  };
  // Turns: where the heading swings furthest, one stretch each, taken out of the stretches they fall in.
  const within = samples(TURN.within), swing = s => s + within <= segTo[s] ? Math.abs(turn[s + within] - turn[s]) / DEGREES : 0;
  for (let s = 0; s < count; s++) {
    if ((s & 127) === 0 && due()) await pause();
    if (swing(s) < TURN.by) continue;
    let top = s, end = s;
    while (end + 1 < count && swing(end + 1) >= TURN.by) {
      if ((end & 127) === 0 && due()) await pause();
      end++; if (swing(end) > swing(top)) top = end;
    }
    const middle = top + (within >> 1), from = Math.max(segFrom[s], middle - samples(TURN.before)), to = Math.min(segTo[s], middle + samples(TURN.after));
    s = end + within;
    const lo = Math.max(segFrom[middle], middle - (within >> 1)), hi = Math.min(segTo[middle], middle + (within >> 1));
    if (due()) await pause();
    const outside = find(PLACES.outside, middle, hx[lo] - hx[hi], hy[lo] - hy[hi], [Math.max(from, middle - samples(WAIT)), middle, to]);
    const cut = {on: 'turn', from, to, outside};
    if (!outside || from < (segment[from] > 0 ? segFrom[from] + samples(ESTABLISH.seconds) : settled) || to >= finish) continue;
    let overlap = false;
    for (let index = 0; index < stretches.length; index++) {
      if ((index & 63) === 0 && due()) await pause();
      if (stretches[index].on === 'turn' && stretches[index].to >= from) { overlap = true; break; }
    }
    if (overlap) continue;
    for (let index = 0, placed = false; index < stretches.length; index++) {
      if ((index & 63) === 0 && due()) await pause();
      const stretch = stretches[index];
      if (stretch === cut || stretch.to < cut.from || stretch.from > cut.to) continue;
      const pieces = [];
      if ((cut.from - stretch.from) * dt >= REST) pieces.push({...stretch, to: cut.from - 1, last: undefined}); else cut.from = Math.min(cut.from, stretch.from);
      if (!placed) { pieces.push(cut); cut.side = stretch.side; placed = true; }
      cut.next = stretch.next;
      if ((stretch.to - cut.to) * dt >= REST) pieces.push({...stretch, from: cut.to + 1}); else cut.to = Math.max(cut.to, stretch.last ?? stretch.to);
      stretches.splice(index, 1, ...pieces);
      index += pieces.length - 1;
    }
  }
  for (let index = 0; index < stretches.length; index++) {
    await pause();
    const stretch = stretches[index];
    const following = stretches[index + 1], o = stretch.to * 3;
    // By the lip of the ramp, on its open side; and by the end of the flight, on the open side of the ramp it lands on.
    if (stretch.on === 'ramp' && (faces[0][o] !== 0 || faces[0][o + 1] !== 0)) stretch.lip = find(PLACES.lip, stretch.to, faces[0][o], faces[0][o + 1], [Math.max(stretch.from, stretch.to - samples(WAIT)), stretch.to]);
    if (stretch.on === 'air' && following?.on === 'ramp' && segment[following.from] === segment[stretch.from]) {
      const land = Math.min(following.to, following.from + arrive + 1) * 3;
      stretch.landing = find(PLACES.landing, stretch.to, faces[0][land], faces[0][land + 1], [Math.max(stretch.from, stretch.to - samples(WAIT)), stretch.to]);
    }
  }
  for (let index = 0; index < stretches.length; index++) {
    const stretch = stretches[index];
    if (due()) await pause();
    const before = stretches[index - 1], arrived = segment[stretch.from] > 0 ? segFrom[stretch.from] + samples(ESTABLISH.seconds) : settled;
    stretch.seconds = (stretch.to - stretch.from + 1) * dt;
    let pace = 0, span = 0;
    for (let s = stretch.from; s <= stretch.to; s++) {
      if (((s - stretch.from) & 255) === 0 && due()) await pause();
      pace += speed[s]; span = Math.max(span, wide[s]);
    }
    stretch.pace = pace / (stretch.to - stretch.from + 1); stretch.crowd = smoothstep(150, 700, span);
    stretch.opens = !index || segment[before.from] !== segment[stretch.from];
    stretch.flips = stretch.next !== stretch.side;
    // The start, an arrival and the finish are shots of their own: no move begins before `least`.
    stretch.least = stretch.from < arrived ? arrived : -1;
    stretch.held = stretch.least > stretch.from + (stretch.to - stretch.from) * 0.4 || finish <= stretch.to;
  }
  const rank = async (on, value, name) => {
    const group = stretches.filter(stretch => stretch.on === on), sorted = Float64Array.from(group.map(value)).sort();
    for (let i = 0; i < group.length; i++) {
      if ((i & 31) === 0 && due()) await pause();
      const stretch = group[i];
      stretch[name] = sorted.length > 1 ? sorted.lastIndexOf(value(stretch)) / (sorted.length - 1) : 0;
    }
  };
  await rank('ramp', stretch => stretch.pace, 'fast'); await rank('air', stretch => stretch.seconds, 'big');

  // What each move would be on each stretch: its poses in samples, with the
  // side they are on, and its worth where the map lets it stand.
  const point = [0, 0, 0];
  const stands = (s, key) => {
    towards(frame, s, key.b * key.side, key.e, point);
    const far = key.far || key.d * working[s], x = body[s * 3] + point[0] * far, y = body[s * 3 + 1] + point[1] * far, z = body[s * 3 + 2] + point[2] * far;
    return scene.free(x, y, z, PROBE_ROOM) && scene.sees(x, y, z, s);
  };
  // An anchored key as a pose: where its place is round the run at its sample.
  const posed = key => {
    const s = key.s, dx = key.anchor[0] - body[s * 3], dy = key.anchor[1] - body[s * 3 + 1], dz = key.anchor[2] - body[s * 3 + 2], far = Math.hypot(dx, dy, dz) || 1;
    const round = Math.atan2(dx * hy[s] - dy * hx[s], -(dx * hx[s] + dy * hy[s])) / DEGREES;
    return {...key, b: Math.abs(round), side: round < 0 ? -1 : 1, e: Math.asin(dz / far) / DEGREES + FOLLOW * frame.pitch[s] * Math.cos(round * DEGREES), far};
  };
  const pose = (stretch, move, worth, far) => {
    const keys = move.keys(stretch, far).map(key => ({...HOME, ...key, s: Math.round(stretch.from + (stretch.to - stretch.from) * clamp(key.u, 0, 1)), side: stretch.on !== 'ramp' && key.u >= 0.5 ? stretch.next : stretch.side})).map(key => key.anchor ? posed(key) : key);
    if (move.name === 'home') return {move, worth, keys};
    let asked = 0, standing = 0;
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k], before = keys[k - 1];
      asked++; if (stands(key.s, key)) standing++;
      if (!before || before.side !== key.side && !key.anchor) continue;
      const s = (before.s + key.s) >> 1, f = (s - before.s) / Math.max(1, key.s - before.s), mix = name => before[name] + (key[name] - before[name]) * f;
      asked++; if (stands(s, key.anchor ? posed({...key, s}) : {b: mix('b'), e: mix('e'), d: mix('d'), far: key.far, side: key.side})) standing++;
    }
    return standing >= FEASIBLE * asked ? {move, worth: worth * standing / asked, keys} : null;
  };
  const options = [];
  for (const stretch of stretches) {
    await pause();
    const row = [];
    for (let m = 0; m < MOVES.length; m++) {
      if ((m & 3) === 0 && due()) await pause();
      const move = MOVES[m];
      let option = null;
      if (move.on === stretch.on) {
        const worth = (stretch.held ? 0 : move.fit(stretch)) * stretch.seconds;
        if (!(worth <= 0 && move.name !== 'home')) {
          for (const far of move.reach ?? [0]) {
            option = pose(stretch, move, worth, far);
            if (option) break;
          }
        }
      }
      row.push(option);
    }
    options.push(row);
  }

  // How hurried the camera would be between one move's last pose and the next's first.
  const from = [0, 0, 0], to = [0, 0, 0];
  const haste = (a, b) => {
    const last = a.keys[a.keys.length - 1], first = b.keys[0];
    towards(frame, last.s, last.b * last.side, last.e, from); towards(frame, last.s, first.b * first.side, first.e, to);
    const turn = Math.acos(clamp(from[0] * to[0] + from[1] * to[1] + from[2] * to[2], -1, 1)) / DEGREES;
    const reach = REACH * Math.abs(Math.log2((first.far || first.d * working[first.s]) / (last.far || last.d * working[last.s])));
    const over = (turn + reach) / Math.max(TRANSIT_LEAST, (first.s - last.s) * dt) / RATE - 1;
    return over > 0 ? HASTE * over * over : 0;
  };
  const between = (a, b, i) => haste(a, b) - (a.move.kind !== b.move.kind ? CONTRAST : 0) +
    (a.move.name === b.move.name ? (a.move.name === 'home' ? REPEAT_HOME : REPEAT) * smoothstep(PHRASE[0], PHRASE[1], Math.min(stretches[i - 1].seconds, stretches[i].seconds)) : 0);

  // The take: the sequence worth most, chosen again while any move fills more than its share.
  const dearer = Object.fromEntries(Object.keys(CAPS).map(name => [name, 0])), chosen = new Array(stretches.length), total = count * dt;
  for (let round = 0; round <= CAP_ROUNDS; round++) {
    await pause();
    const best = stretches.map(() => new Float64Array(MOVES.length).fill(-Infinity)), via = stretches.map(() => new Int8Array(MOVES.length).fill(-1));
    for (let i = 0; i < stretches.length; i++) {
      if (due()) await pause();
      for (let m = 0; m < MOVES.length; m++) {
        const option = options[i][m];
        if (!option) continue;
        const own = option.worth - dearer[option.move.name] * stretches[i].seconds;
        if (!i || stretches[i].opens) { const top = i ? best[i - 1].indexOf(Math.max(...best[i - 1])) : -1; best[i][m] = own + (i ? best[i - 1][top] : 0); via[i][m] = top; continue; }
        for (let p = 0; p < MOVES.length; p++) {
          if (best[i - 1][p] === -Infinity) continue;
          const value = best[i - 1][p] + own - between(options[i - 1][p], option, i);
          if (value > best[i][m]) { best[i][m] = value; via[i][m] = p; }
        }
      }
    }
    for (let i = stretches.length - 1, m = best[i].indexOf(Math.max(...best[i])); i >= 0; m = via[i][m], i--) chosen[i] = options[i][m];
    const filled = Object.fromEntries(Object.keys(CAPS).map(name => [name, 0])), used = {};
    chosen.forEach((option, i) => { filled[option.move.name] += stretches[i].seconds; used[option.move.name] = (used[option.move.name] ?? 0) + 1; });
    let over = false;
    for (const name of Object.keys(CAPS)) if (used[name] > 1 && filled[name] > CAPS[name] * total + 1e-6) { dearer[name] += CAP_STEP; over = true; }
    if (!over) break;
  }

  // The asked view over time: straight from pose to pose, then rounded.
  const bearing = new Float32Array(count), elevation = new Float32Array(count), distance = new Float32Array(count), wider = new Float32Array(count), size = new Float32Array(count), weight = new Float32Array(count).fill(AIRBORNE);
  const keys = [], apart = Math.max(1, samples(APART)), placed = new Array(count).fill(null);
  // A key too soon after the one before it waits, or is dropped where its
  // stretch ends first; bearings follow on from each other the short way round.
  const put = (s, key) => {
    const last = keys[keys.length - 1], joined = last && segment[last.s] === segment[s];
    if (joined && s < last.s + apart) { s = last.s + apart; if (s > segTo[last.s]) return; }
    let signed = key.b * key.side;
    if (joined) signed = last.signed + ((signed - last.signed + 540) % 360 - 180);
    keys.push({s, signed, e: key.e, far: key.far || 0, d: key.d, lens: key.lens, size: key.size, weight: key.weight ?? 1, anchor: key.anchor ?? null});
  };
  for (let index = 0; index < stretches.length; index++) {
    if ((index & 63) === 0 && due()) await pause();
    const stretch = stretches[index];
    const option = chosen[index], side = stretch.side;
    if (stretch.opens && segment[stretch.from] > 0) put(stretch.from, {...HOME, ...ESTABLISH, side});
    else if (stretch.opens && start.waits) {
      put(start.zone, {...HOME, ...START, b: START.b[0], side});
      put(Math.max(start.zone + 1, start.first - 1), {...HOME, ...START, b: START.b[1], side});
    }
    if (stretch.least >= stretch.from && stretch.least <= stretch.to && stretch.least < finish) put(stretch.least, {...HOME, side});
    if (stretch.from > finish) put(stretch.from, {...HOME, ...FINISH, side});
    else for (const key of option.keys) if (key.s < finish && key.s > stretch.least) put(key.s, key);
    if (finish >= stretch.from && finish <= (stretch.last ?? stretch.to)) {
      put(finish, {...HOME, side});
      put(Math.min(segTo[finish], finish + samples(FINISH.seconds)), {...HOME, ...FINISH, side});
    }
    if (stretch.on !== 'air' || option.move.name !== 'home' || stretch.opens) weight.fill(1, stretch.from, stretch.to + 1);
    if (stretch.on === 'ramp') weight.fill(1, Math.max(stretch.opens ? stretch.from : stretches[index - 1].from, stretch.from + arrive - samples(APPROACH)), stretch.from);
  }
  for (let k = 0, s = 0; s < count; s++) {
    if ((s & 255) === 0 && due()) await pause();
    while (k + 1 < keys.length && keys[k + 1].s <= s) k++;
    // Before a stretch's first key and after its last, the view is that key's.
    const here = key => key && segment[key.s] === segment[s];
    const a = here(keys[k]) || !here(keys[k + 1]) ? keys[k] : keys[k + 1], b = a === keys[k] && here(keys[k + 1]) ? keys[k + 1] : a;
    const f = b.s > a.s ? clamp((s - a.s) / (b.s - a.s), 0, 1) : 0, mix = name => a[name] + (b[name] - a[name]) * f;
    const reach = key => key.far || key.d * working[s];
    bearing[s] = mix('signed'); elevation[s] = mix('e'); wider[s] = mix('lens'); size[s] = mix('size');
    distance[s] = Math.exp(Math.log(reach(a)) + (Math.log(reach(b)) - Math.log(reach(a))) * f);
    weight[s] *= mix('weight');
    if (a.anchor && a.anchor === b.anchor) placed[s] = a.anchor;
  }
  const round = await blur(bearing, ROUNDED), rise = await blur(elevation, ROUNDED), out = await blur(distance, ROUNDED);
  const intent = {x: new Float32Array(count), y: new Float32Array(count), z: new Float32Array(count), distance: out, weight};
  for (let s = 0; s < count; s++) {
    if ((s & 255) === 0 && due()) await pause();
    const off = Math.abs((round[s] % 360 + 540) % 360 - 180), line = Math.min(off, 180 - off), near = 1 - smoothstep(LINE[0], LINE[1], line);
    const clear = OVER * (2 * smoothstep(UNDER[0], UNDER[1], rise[s]) - 1), up = Math.abs(rise[s]) < OVER ? rise[s] + (clear - rise[s]) * near : rise[s];
    towards(frame, s, round[s], up, point);
    intent.x[s] = point[0]; intent.y[s] = point[1]; intent.z[s] = point[2];
    weight[s] *= 1 - (1 - LOOSELY) * near;
    // Waiting in its place, the camera is asked for the place itself.
    if (!placed[s]) continue;
    const dx = placed[s][0] - body[s * 3], dy = placed[s][1] - body[s * 3 + 1], dz = placed[s][2] - body[s * 3 + 2], far = Math.hypot(dx, dy, dz) || 1;
    intent.x[s] = dx / far; intent.y[s] = dy / far; intent.z[s] = dz / far; out[s] = far; weight[s] = PLACED;
  }
  return {intent, lens: {wider: await blur(wider, ROUNDED), size: await blur(size, ROUNDED)},
    moves: stretches.map((stretch, index) => ({name: chosen[index].move.name, on: stretch.on, from: stretch.from, to: stretch.last ?? stretch.to}))};
}
