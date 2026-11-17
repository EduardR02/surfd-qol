import {describe, expect, test} from 'bun:test';
import {createTrack, trackPoint} from '../src/cinema-track.js';
import {alignByTime} from '../src/cinema-sync.js';
import {planCamera, shotAt, STEP} from '../src/cinema-camera.js';
import {fly} from '../src/cinema-flight.js';

// A run along +x at `speed` units per tick, starting after `lead` ticks in the start zone.
function straight({count = 400, speed = 20, lead = 20, dt = 0.015, y = 0, normal = null} = {}) {
  const track = createTrack(count, dt);
  for (let i = 0; i < count; i++) {
    track.position.set([Math.max(0, i - lead) * speed, y, 0], i * 3);
    track.elapsed[i] = Math.max(0, i - lead) * dt;
    if (normal) track.normal.set(normal, i * 3);
  }
  track.start = lead;
  track.finish = count - 1;
  track.time = (count - 1 - lead) * dt;
  return track;
}
// Ramps between the given ticks, each open to `side` of travel (1 right, the face looking to -y).
function surfing(spans, options = {}) {
  const track = straight({count: 900, ...options});
  for (const [from, to, side = 1] of spans) for (let i = from; i <= to; i++) track.normal.set([0, -0.8 * side, 0.6], i * 3);
  return track;
}
// A run through the given points, one a tick.
function along(points, dt = 0.015) {
  const track = createTrack(points.length, dt);
  points.forEach(([x, y, z, normal], i) => {
    track.position.set([x, y, z], i * 3);
    track.elapsed[i] = i * dt;
    if (normal) track.normal.set(normal, i * 3);
  });
  track.start = 0; track.finish = points.length - 1; track.time = (points.length - 1) * dt;
  return track;
}
// A map of solid boxes ({min, max}), as cinema-world.js gives one to the planner:
// the clear fraction of a line, what an eye is shown (from inside a box it looks out), and whether a camera fits.
function boxes(list) {
  const axes = ['x', 'y', 'z'];
  const enters = (from, to, box) => {
    let first = 0, last = 1;
    for (const axis of axes) {
      const d = to[axis] - from[axis];
      if (Math.abs(d) < 1e-9) { if (from[axis] <= box.min[axis] || from[axis] >= box.max[axis]) return 1; continue; }
      const a = (box.min[axis] - from[axis]) / d, b = (box.max[axis] - from[axis]) / d;
      first = Math.max(first, Math.min(a, b)); last = Math.min(last, Math.max(a, b));
      if (first >= last) return 1;
    }
    return first;
  };
  const within = (point, box, room = 0) => axes.every(axis => point[axis] > box.min[axis] - room && point[axis] < box.max[axis] + room);
  const trace = (from, to) => Math.min(1, ...list.map(box => enters(from, to, box)));
  trace.view = (eye, to) => {
    trace.view.inside = list.some(box => within(eye, box));
    return Math.min(1, ...list.filter(box => !within(eye, box)).map(box => enters(eye, to, box)));
  };
  trace.free = (point, room) => !list.some(box => within(point, box, room));
  return trace;
}
// An opaque rectangular tunnel with thick side walls and a solid floor/roof.
function tunnel(width, ceiling, wall = 1000) {
  const half = width / 2, from = -20000, to = 20000;
  return boxes([
    {min: {x: from, y: -wall, z: -5000}, max: {x: to, y: -half, z: 5000}},
    {min: {x: from, y: half, z: -5000}, max: {x: to, y: wall, z: 5000}},
    {min: {x: from, y: -half, z: -5000}, max: {x: to, y: half, z: 0}},
    {min: {x: from, y: -half, z: ceiling}, max: {x: to, y: half, z: 5000}},
  ]);
}
const body = (track, tick) => { const point = trackPoint(track, tick); point.z += 40; return point; };
const length = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const eyeAt = (plan, s) => ({x: plan.eye[s * 3], y: plan.eye[s * 3 + 1], z: plan.eye[s * 3 + 2]});
// Where the camera is round the played run: degrees from behind its travel
// (+x) towards its right (-y), degrees above it, and how far.
function around(plan, track, tick) {
  const {eye} = shotAt(plan, tick), at = body(track, tick), dx = eye.x - at.x, dy = eye.y - at.y, dz = eye.z - at.z;
  return {swing: Math.atan2(-dy, -dx) * 180 / Math.PI, elevation: Math.asin(dz / Math.hypot(dx, dy, dz)) * 180 / Math.PI, distance: Math.hypot(dx, dy, dz)};
}
// Degrees between the view's axis and a point.
function offAxis(shot, point) {
  const view = [shot.target.x - shot.eye.x, shot.target.y - shot.eye.y, shot.target.z - shot.eye.z];
  const to = [point.x - shot.eye.x, point.y - shot.eye.y, point.z - shot.eye.z];
  const dot = view[0] * to[0] + view[1] * to[1] + view[2] * to[2];
  return Math.acos(Math.max(-1, Math.min(1, dot / (Math.hypot(...view) * Math.hypot(...to))))) * 180 / Math.PI;
}
// Every sample of a take through a map: the eye outside everything solid, the
// run in sight, in frame and clear of the lens, no flight through anything
// solid, and the eye in front of the ramp the run rides.
function expectSound(plan, track, trace) {
  let hidden = 0;
  for (let s = 0; s < plan.count; s++) {
    const tick = Math.min(track.count - 1, s * STEP), eye = eyeAt(plan, s), at = body(track, tick), shot = shotAt(plan, tick);
    expect(trace.free(eye, 0)).toBe(true);
    if (trace.view(eye, at) < 1) hidden++;
    if (s && plan.segment[s] === plan.segment[s - 1]) expect(trace(eyeAt(plan, s - 1), eye)).toBe(1);
    expect(length(eye, at)).toBeGreaterThan(100);
    expect(offAxis(shot, at)).toBeLessThan(shot.fov * 0.75 / 2);
    const nx = track.normal[tick * 3], ny = track.normal[tick * 3 + 1], nz = track.normal[tick * 3 + 2];
    if (Math.hypot(nx, ny) > 1e-3) expect(nx * (eye.x - at.x) + ny * (eye.y - at.y) + nz * (eye.z - at.z)).toBeGreaterThan(39);
  }
  expect(hidden).toBeLessThan(2);
}

describe('the cinematic take', () => {
  test('is one take: no cut without a teleport, and no jump from sample to sample', async () => {
    const a = surfing([[100, 250, 1], [330, 480, -1], [560, 700, 1], [760, 860, -1]]);
    const plan = await planCamera({a});
    expect([...plan.segment].every(segment => segment === 0)).toBe(true);
    let previous = null;
    for (let s = 0; s < plan.count; s++) {
      const tick = Math.min(a.count - 1, s * STEP), shot = shotAt(plan, tick), at = body(a, tick);
      const offset = {x: shot.eye.x - at.x, y: shot.eye.y - at.y, z: shot.eye.z - at.z};
      if (previous) {
        // Relative to the run, the camera moves at most a few thousand units a second.
        expect(length(offset, previous.offset)).toBeLessThan(150);
        expect(offAxis(previous.shot, {x: previous.shot.eye.x + shot.target.x - shot.eye.x, y: previous.shot.eye.y + shot.target.y - shot.eye.y, z: previous.shot.eye.z + shot.target.z - shot.eye.z})).toBeLessThan(12);
        expect(Math.abs(shot.fov - previous.shot.fov)).toBeLessThan(4);
      }
      expect(offAxis(shot, at)).toBeLessThan(shot.fov * 0.75 / 2);
      previous = {offset, shot: structuredClone(shot)};
    }
  });

  test('is never behind or inside the ramp the run rides', async () => {
    const a = surfing([[100, 250, 1], [330, 480, -1], [560, 700, 1], [760, 860, -1]]);
    const plan = await planCamera({a});
    for (let s = 0; s < plan.count; s++) {
      const tick = Math.min(a.count - 1, s * STEP), eye = eyeAt(plan, s), at = body(a, tick);
      for (let k = Math.max(0, tick - STEP + 1); k <= tick; k++) {
        const ny = a.normal[k * 3 + 1], nz = a.normal[k * 3 + 2];
        if (ny !== 0) expect(ny * (eye.y - at.y) + nz * (eye.z - at.z)).toBeGreaterThan(Math.max(39, Math.sin(8 * Math.PI / 180) * length(eye, at) - 1));
      }
    }
  });

  test('moves: the view changes side, scale and height over the take, and never rests on the line of travel', async () => {
    const a = surfing([[100, 250, 1], [330, 480, -1], [560, 700, 1], [760, 860, -1]]);
    const plan = await planCamera({a, debug: true});
    expect(new Set(plan.moves.map(move => move.name)).size).toBeGreaterThan(3);
    let ahead = 0, behind = 0, along = 0, moving = 0, near = Infinity, far = 0, low = Infinity, high = -Infinity;
    for (let tick = a.start + 40; tick < a.count - 40; tick += STEP) {
      const {swing, elevation, distance} = around(plan, a, tick), shot = shotAt(plan, tick);
      moving++;
      if (Math.abs(swing) > 110) ahead++; else if (Math.abs(swing) < 70) behind++;
      // Looking along the line of travel, from behind or ahead, flattens the run into depth.
      const off = offAxis(shot, {x: shot.eye.x + 1, y: shot.eye.y, z: shot.eye.z});
      if (off < 12 || off > 168) along++;
      near = Math.min(near, distance); far = Math.max(far, distance); low = Math.min(low, elevation); high = Math.max(high, elevation);
    }
    expect(ahead / moving).toBeGreaterThan(0.05);
    expect(behind / moving).toBeGreaterThan(0.3);
    expect(along / moving).toBeLessThan(0.03);
    expect(far / near).toBeGreaterThan(1.5);
    expect(high - low).toBeGreaterThan(25);
  });

  test('cuts at the played run’s teleport, on its tick', async () => {
    const a = straight({count: 12, lead: 0});
    for (let i = 3; i < a.count; i++) a.position[i * 3] += 5000;
    a.cut[3] = 1;
    const plan = await planCamera({a});
    expect(shotAt(plan, 2.9).target.x).toBeLessThan(1000);
    expect(shotAt(plan, 3).target.x).toBeGreaterThan(4000);
    expect(Array.from(plan.cutTick).filter(Boolean)).toEqual([3]);
  });

  test('turns the view towards where the run is going, keeping it near the middle', async () => {
    // A long bend to the left.
    const a = createTrack(500, 0.015);
    for (let i = 0, x = 0, y = 0; i < a.count; i++) {
      const heading = Math.max(0, i - 150) * 0.006;
      x += Math.cos(heading) * 30; y += Math.sin(heading) * 30;
      a.position.set([x, y, 0], i * 3);
    }
    a.start = 0; a.finish = a.count - 1;
    const plan = await planCamera({a});
    for (let tick = 200; tick < 400; tick += 20) {
      const shot = shotAt(plan, tick), now = body(a, tick);
      expect(offAxis(shot, now)).toBeLessThan(shot.fov * 0.75 / 2 * 0.6);
    }
  });

  test('rounds a wall the route turns back round: ahead of the run, never through the wall', async () => {
    // Out along a wall's near side on a ramp facing away from it, round its
    // end, and back along its far side on a ramp facing away from it.
    const points = [];
    for (let x = 0; x < 3600; x += 20) points.push([x, 0, 0, [0, -0.8, 0.6]]);
    for (let turn = 0; turn < 63; turn++) { const angle = -Math.PI / 2 + Math.PI * turn / 63; points.push([3600 + Math.cos(angle) * 400, 400 + Math.sin(angle) * 400, 0]); }
    for (let x = 3600; x > 0; x -= 20) points.push([x, 800, 0, [0, 0.8, 0.6]]);
    const a = along(points), trace = boxes([{min: {x: -9000, y: 300, z: -4000}, max: {x: 3600, y: 500, z: 4000}}]);
    const plan = await planCamera({a, trace});
    expectSound(plan, a, trace);
    // Before the run reaches the wall's end, the camera is already past it
    // and sees the start of the far side, which the run itself does not.
    const far = {x: 3500, y: 800, z: 40};
    let anticipated = false;
    for (let tick = 100; tick < 180 && !anticipated; tick += STEP) {
      const eye = eyeAt(plan, tick / STEP);
      anticipated = eye.x > 3600 && trace.view(body(a, tick), far) < 1 && trace.view(eye, far) === 1;
    }
    expect(anticipated).toBe(true);
  });

  test('goes over a wall the run flies over', async () => {
    const points = [];
    for (let x = 0; x < 6000; x += 20) points.push([x, 0, x > 2000 && x < 4100 ? 700 * (1 - ((x - 3050) / 1050) ** 2) : 0, x <= 2000 ? [0, -0.8, 0.6] : x >= 4100 ? [0, 0.8, 0.6] : null]);
    const a = along(points), trace = boxes([{min: {x: 3000, y: -6000, z: -4000}, max: {x: 3100, y: 6000, z: 250}}]);
    expectSound(await planCamera({a, trace}), a, trace);
  });

  test('follows the run through a doorway instead of losing it', async () => {
    // A wall across the route at x 3000 with an opening round the run's line.
    const wall = (from, to) => {
      if ((from.x - 3000) * (to.x - 3000) >= 0) return 1;
      const t = (3000 - from.x) / (to.x - from.x), y = from.y + (to.y - from.y) * t, z = from.z + (to.z - from.z) * t;
      return Math.hypot(y, z - 40) < 130 ? 1 : t;
    };
    const a = straight(), plan = await planCamera({a, trace: wall});
    for (let s = 0; s < plan.count; s++) {
      const tick = Math.min(a.count - 1, s * STEP), shot = shotAt(plan, tick), at = body(a, tick);
      expect(wall(at, shot.eye)).toBe(1);
      expect(length(at, shot.eye)).toBeGreaterThan(69);
    }
  });

  for (const [name, normal, speed] of [['in flight', null, 20], ['on a ridden face', [0, -0.8, 0.6], 20], ['at rest on a ridden face', [0, -0.8, 0.6], 0]]) {
    test(`keeps a visible, safe view inside a narrow opaque tunnel ${name}`, async () => {
      // Only a 16-unit-wide camera fits in the 50-unit passage; the search's
      // preferred 60-unit hull cannot. Outside viewpoints exist but the walls
      // hide the run.
      const a = straight({count: 240, lead: 0, normal, speed}), trace = tunnel(50, 220);
      const plan = await planCamera({a, trace});
      expect(plan).not.toBeNull();
      for (let s = 0; s < plan.count; s++) {
        const tick = Math.min(a.count - 1, s * STEP), eye = eyeAt(plan, s), at = body(a, tick), distance = length(eye, at);
        expect(trace.free(eye, 8)).toBe(true);
        expect(trace.view(eye, at)).toBe(1);
        expect(distance).toBeGreaterThanOrEqual(110 - 1e-4);
        if (normal) {
          const facing = normal[1] * (eye.y - at.y) + normal[2] * (eye.z - at.z);
          expect(facing).toBeGreaterThanOrEqual(Math.max(40, Math.sin(8 * Math.PI / 180) * distance) - 1e-3);
        }
      }
    });
  }

  test('returns no plan when even the flown camera cannot fit in the tunnel', async () => {
    const a = straight({count: 180, lead: 0}), trace = tunnel(14, 220, 10000);
    expect(await planCamera({a, trace})).toBeNull();
  });

  test('never publishes a flight still violating hard rules after repair', async () => {
    const count = 8, samples = () => new Int32Array(count).fill(-1);
    const route = {count, dt: 0.03, segTo: new Int32Array(count).fill(count - 1),
      runs: [new Float32Array(count * 3)], faces: [new Float32Array(count * 3)], landing: [samples()], leaving: [samples()]};
    const clear = {free: () => true, sees: () => true}, crossing = new Uint8Array(count);
    const options = {route, scene: clear, crossing, due: () => false, pause: async () => {}};
    // The target path itself is too near the run, so no amount of pulling
    // the flight closer to it can satisfy the lens clearance.
    expect(await fly({...options, path: new Float32Array(count * 3)})).toBeNull();
    const path = new Float32Array(count * 3);
    for (let s = 0; s < count; s++) path[s * 3] = 250;
    const face = new Float32Array(count * 3);
    for (let s = 0; s < count; s++) face.set([0, -0.8, 0.6], s * 3);
    expect(await fly({...options, path, route: {...route, faces: [face]}})).toBeNull();
    // A hidden searched path must not mask an eye buried in solid.
    const hiddenSolid = {free: () => false, sees: () => false};
    expect(await fly({...options, path, scene: hiddenSolid})).toBeNull();
    // Planned terrain crossings and sight already lost by the searched path
    // retain their existing allowances.
    expect(await fly({...options, path, scene: hiddenSolid, crossing: new Uint8Array(count).fill(1)})).not.toBeNull();
  });

  test('opens high and wide after a teleport, then settles', async () => {
    const a = straight({count: 700});
    for (let i = 300; i < a.count; i++) a.position[i * 3 + 1] += 20000;
    a.cut[300] = 1;
    const plan = await planCamera({a});
    expect(around(plan, a, 306).elevation).toBeGreaterThan(30);
    expect(around(plan, a, 306).distance).toBeGreaterThan(750);
    expect(around(plan, a, 420).distance).toBeLessThan(around(plan, a, 306).distance);
  });

  test('stays the played run’s take with added runs, and frames a focused run alone', async () => {
    const a = surfing([[100, 250, 1], [330, 480, -1], [560, 700, 1], [760, 860, -1]]), b = surfing([[100, 250, 1], [330, 480, -1], [560, 700, 1], [760, 860, -1]], {y: 500, lead: 30});
    const others = [{track: b, map: alignByTime(a, b)}];
    const solo = await planCamera({a}), group = await planCamera({a, others}), focused = await planCamera({a, others, group: false});
    const usual = plan => Array.from({length: plan.count}, (_, s) => length(eyeAt(plan, s), body(a, Math.min(a.count - 1, s * STEP)))).sort((x, y) => x - y)[plan.count >> 1];
    let framed = 0, samples = 0, previous = null;
    for (let s = 0; s < group.count; s++) {
      const tick = Math.min(a.count - 1, s * STEP), shot = shotAt(group, tick), at = body(a, tick);
      expect(offAxis(shot, at)).toBeLessThan(shot.fov * 0.75 / 2);
      expect(length(shot.eye, at)).toBeLessThan(3500);
      expect(length(shot.eye, body(b, others[0].map[tick]))).toBeGreaterThan(80);
      const offset = {x: shot.eye.x - at.x, y: shot.eye.y - at.y, z: shot.eye.z - at.z};
      if (previous) expect(length(offset, previous)).toBeLessThan(150);
      previous = offset;
      samples++;
      if (offAxis(shot, body(b, others[0].map[tick])) < shot.fov / 2) framed++;
    }
    expect(framed / samples).toBeGreaterThan(0.7);
    // Focused on the played run, the others no longer widen the shot.
    expect(usual(group)).toBeGreaterThan(usual(solo));
    expect(usual(focused)).toBeLessThan(usual(solo) * 1.15);
  });

  test('another run’s teleport doesn’t cut the take', async () => {
    const a = straight(), b = straight({y: 200});
    for (let i = 200; i < b.count; i++) b.position[i * 3 + 1] += 3000;
    b.cut[200] = 1;
    const plan = await planCamera({a, others: [{track: b, map: alignByTime(a, b)}]});
    expect([...plan.segment].every(segment => segment === 0)).toBe(true);
    expect(length(shotAt(plan, 199).eye, shotAt(plan, 201).eye)).toBeLessThan(150);
  });

  test('banks into its turns, a little, and Steady not at all', async () => {
    const a = surfing([[100, 250, 1], [330, 480, -1], [560, 700, 1], [760, 860, -1]]);
    const plan = await planCamera({a}), steady = await planCamera({a, style: 'steady'});
    expect(plan.roll.length).toBe(plan.count);
    const most = Math.max(...Array.from(plan.roll, Math.abs));
    expect(most).toBeGreaterThan(0.01);
    expect(most).toBeLessThanOrEqual(10 * Math.PI / 180 + 1e-6);
    for (let s = 1; s < plan.count; s++) expect(Math.abs(plan.roll[s] - plan.roll[s - 1])).toBeLessThan(0.03);
    expect(steady.roll).toBeUndefined();
    expect(shotAt(steady, 200).roll).toBe(0);
    expect(shotAt(plan, 201).roll).toBeCloseTo((plan.roll[100] + plan.roll[101]) / 2, 6);
  });

  test('gives the same plan again, with or without yielding, and none once cancelled', async () => {
    const a = surfing([[100, 300], [380, 580]]), trace = (from, to) => to.z < -200 ? (from.z + 200) / (from.z - to.z) : 1;
    const plan = await planCamera({a, trace});
    expect(await planCamera({a, trace})).toEqual(plan);
    expect(await planCamera({a, trace, yieldTask: async () => ({didTimeout: true, timeRemaining: () => 0})})).toEqual(plan);
    let current = true;
    expect(await planCamera({a, isCurrent: () => current, yieldTask: async () => null, trace: () => { current = false; return 1; }})).toBeNull();
  });

  test('spends a bounded number of traces', async () => {
    const a = surfing([[100, 300], [380, 580], [660, 860]]), seconds = a.count * a.dt;
    let traces = 0;
    await planCamera({a, trace: () => { traces++; return 1; }});
    expect(traces / seconds).toBeLessThan(2200);
    traces = 0;
    await planCamera({a, trace: (from, to) => { traces++; return Math.min(1, 400 / length(from, to)); }});
    expect(traces / seconds).toBeLessThan(3000);
  });
});
