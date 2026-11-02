import {describe, expect, test} from 'bun:test';
import {createTrack, trackPoint} from '../src/cinema-track.js';
import {planCamera, shotAt, STEP} from '../src/cinema-camera.js';
import {cameraBoundsQuery} from '../src/cinema.js';

// These solids include the camera probe's clearance. Unlike a trace echo,
// each reports the first actual entry into a geometric obstacle.
function box(low, high) {
  return (from, to) => {
    let enter = 0, exit = 1;
    for (const axis of ['x', 'y', 'z']) {
      const delta = to[axis] - from[axis];
      if (!delta) { if (from[axis] < low[axis] || from[axis] > high[axis]) return 1; continue; }
      let a = (low[axis] - from[axis]) / delta, b = (high[axis] - from[axis]) / delta;
      if (a > b) [a, b] = [b, a];
      enter = Math.max(enter, a); exit = Math.min(exit, b);
      if (enter > exit) return 1;
    }
    return enter >= 0 && enter < 1 ? enter : 1;
  };
}
function sphere(center, radius) {
  return (from, to) => {
    const x = from.x - center.x, y = from.y - center.y, z = from.z - center.z;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const c = x * x + y * y + z * z - radius * radius;
    if (c < 0) return 0;
    const a = dx * dx + dy * dy + dz * dz, b = x * dx + y * dy + z * dz, discriminant = b * b - a * c;
    if (!a || discriminant < 0) return 1;
    const t = (-b - Math.sqrt(discriminant)) / a;
    return t >= 0 && t < 1 ? t : 1;
  };
}
function straight(count = 401) {
  const a = createTrack(count, 0.015);
  for (let i = 0; i < count; i++) a.position[i * 3] = i * 20;
  return a;
}
function bodyAt(track, tick) {
  const body = trackPoint(track, tick); body.z += 40; return body;
}
function inFrame(shot, point) {
  const {eye, target, fov} = shot;
  let fx = target.x - eye.x, fy = target.y - eye.y, fz = target.z - eye.z;
  const length = Math.hypot(fx, fy, fz); fx /= length; fy /= length; fz /= length;
  const x = point.x - eye.x, y = point.y - eye.y, z = point.z - eye.z, depth = x * fx + y * fy + z * fz;
  const flat = Math.hypot(fx, fy) || 1, across = (x * fy - y * fx) / flat;
  const up = Math.sqrt(Math.max(0, x * x + y * y + z * z - depth * depth - across * across));
  const tall = Math.tan(fov * Math.PI / 360) * 0.75;
  return depth > 0 && Math.abs(across) <= tall * 16 / 9 * depth && up <= tall * depth;
}
function screenPoint(shot, point) {
  const {eye, target, fov} = shot;
  const forward = [target.x - eye.x, target.y - eye.y, target.z - eye.z];
  const length = Math.hypot(...forward);
  for (let i = 0; i < 3; i++) forward[i] /= length;
  const flat = Math.hypot(forward[0], forward[1]);
  const right = [forward[1] / flat, -forward[0] / flat, 0];
  const up = [-forward[0] * forward[2] / flat, -forward[1] * forward[2] / flat, flat];
  const delta = [point.x - eye.x, point.y - eye.y, point.z - eye.z];
  const dot = vector => delta.reduce((sum, value, i) => sum + value * vector[i], 0);
  const height = dot(forward) * Math.tan(fov * Math.PI / 360) * 0.75;
  return {x: dot(right) / (height * 16 / 9), y: dot(up) / height};
}
function groupScenario(kind) {
  const tracks = [0, -1, 1].map(shift => {
    const a = createTrack(401, 0.015);
    for (let i = 0; i < a.count; i++) {
      const angle = i / (a.count - 1) * Math.PI + shift * 0.09;
      a.position.set(kind === 'pillar' ? [Math.cos(angle) * (800 + shift * 20), Math.sin(angle) * (800 + shift * 20), 0] :
        [-1200 + i * 9 + shift * 90, shift * 35, 0], i * 3);
      // Entry/exit ramp contacts seed the orbit; the turn itself is free.
      if (kind === 'tunnel' || i < 60 || i > 340) a.normal.set([0, -0.8, 0.6], i * 3);
    }
    return a;
  });
  const pillar = (from, to) => {
    const dx = to.x - from.x, dy = to.y - from.y, c = from.x ** 2 + from.y ** 2 - 614 ** 2;
    if (c < 0) return 0;
    const a = dx * dx + dy * dy, b = from.x * dx + from.y * dy, discriminant = b * b - a * c;
    if (!a || discriminant < 0) return 1;
    const t = (-b - Math.sqrt(discriminant)) / a;
    return t >= 0 && t < 1 ? t : 1;
  };
  const walls = [
    box({x: 0, y: 180, z: -1e6}, {x: 1200, y: 1e6, z: 1e6}),
    box({x: 0, y: -1e6, z: -1e6}, {x: 1200, y: -180, z: 1e6}),
    box({x: 0, y: -1e6, z: 150}, {x: 1200, y: 1e6, z: 1e6}),
    box({x: -1e6, y: -1e6, z: -1e6}, {x: 1e6, y: 1e6, z: 0}),
  ];
  const map = Float32Array.from({length: tracks[0].count}, (_, i) => i);
  return {a: tracks[0], tracks, others: tracks.slice(1).map(track => ({track, map})),
    trace: kind === 'pillar' ? pillar : (from, to) => Math.min(...walls.map(wall => wall(from, to)))};
}
function expectConnected(plan, tracks, trace, minDistance = 0) {
  let previous = null;
  for (let tick = 0; tick < tracks[0].count - 1; tick += 0.5) {
    const shot = shotAt(plan, tick), sample = Math.floor(tick / STEP);
    for (const track of tracks) {
      const body = bodyAt(track, tick);
      expect(trace(body, shot.eye)).toBe(1);
      expect(inFrame(shot, body)).toBe(true);
    }
    const body = bodyAt(tracks[0], tick);
    expect(Math.hypot(shot.eye.x - body.x, shot.eye.y - body.y, shot.eye.z - body.z)).toBeGreaterThan(minDistance);
    if (previous && plan.segment[sample] === previous.segment) expect(trace(previous.eye, shot.eye)).toBe(1);
    previous = {eye: shot.eye, segment: plan.segment[sample]};
  }
}

describe('connected local camera paths', () => {
  test('keeps radially staggered runners distinct instead of aligning them behind a pillar', async () => {
    const scene = groupScenario('pillar'), second = createTrack(scene.a.count, scene.a.dt);
    for (let tick = 0; tick < second.count; tick++) {
      const angle = tick / (second.count - 1) * Math.PI + 0.05;
      second.position.set([Math.cos(angle) * 700, Math.sin(angle) * 700, 0], tick * 3);
      if (tick < 60 || tick > 340) second.normal.set([0, -0.8, 0.6], tick * 3);
    }
    const plan = await planCamera({...scene, others: [{track: second, map: scene.others[0].map}], style: 'cinematic'});
    let previous = null;
    // Both runners are individually visible around this corner. A camera on
    // their shared sightline still passes ray/framing checks, but visually
    // stacks their bodies/trails. Keep a readable normalized-screen gap.
    for (let tick = 326; tick <= 334; tick += 0.5) {
      const shot = shotAt(plan, tick), bodies = [bodyAt(scene.a, tick), bodyAt(second, tick)];
      for (const body of bodies) {
        expect(scene.trace(body, shot.eye)).toBe(1);
        expect(inFrame(shot, body)).toBe(true);
      }
      const [first, other] = bodies.map(body => screenPoint(shot, body));
      expect(Math.hypot(first.x - other.x, first.y - other.y)).toBeGreaterThan(0.15);
      if (previous) expect(scene.trace(previous, shot.eye)).toBe(1);
      previous = shot.eye;
    }
  });
  for (const style of ['cinematic', 'steady']) {
    test(`${style}: keeps a staggered three-run group wide and visible through a pillar half-turn`, async () => {
      const scene = groupScenario('pillar');
      const plan = await planCamera({...scene, style});
      // The former camera spent 0.53s / 0.94s below 250 units here despite
      // a connected visible offset. A close history chase is not necessary.
      expectConnected(plan, scene.tracks, scene.trace, 280);
    });
    test(`${style}: enters a tunnel with a group offset and recovers outside`, async () => {
      const scene = groupScenario('tunnel');
      const plan = await planCamera({...scene, style});
      expectConnected(plan, scene.tracks, scene.trace, 300);
      const before = shotAt(plan, 20), after = shotAt(plan, 380);
      expect(Math.hypot(after.eye.x - after.target.x, after.eye.y - after.target.y, after.eye.z - after.target.z)).toBeGreaterThan(300);
      expect(Math.hypot(before.eye.x - before.target.x, before.eye.y - before.target.y, before.eye.z - before.target.z)).toBeGreaterThan(300);
    });
    test(`${style}: keeps the conservative close fallback in a genuinely tiny enclosure`, async () => {
      const a = straight(41); a.position.fill(0);
      const trace = (from, to) => {
        let clear = 1;
        for (const axis of ['x', 'y', 'z']) {
          const low = axis === 'z' ? 0 : -30, high = axis === 'z' ? 70 : 30, delta = to[axis] - from[axis];
          if (to[axis] < low) clear = Math.min(clear, (low - from[axis]) / delta);
          if (to[axis] > high) clear = Math.min(clear, (high - from[axis]) / delta);
        }
        return clear;
      };
      const plan = await planCamera({a, trace, style});
      expectConnected(plan, [a], trace);
      expect(Math.hypot(...Object.values(shotAt(plan, 20).eye).map((v, i) => v - [0, 0, 40][i]))).toBeLessThan(70);
    });
  }

  for (const obstruction of ['eye chord', 'intermediate sightline']) test(`repairs a blocked ${obstruction} between clear endpoints`, async () => {
    const a = straight(), baseline = await planCamera({a, trace: () => 1});
    const tick = 201, middle = shotAt(baseline, tick), body = bodyAt(a, tick);
    const center = obstruction === 'eye chord' ? middle.eye : {
      x: (middle.eye.x + body.x) / 2, y: (middle.eye.y + body.y) / 2, z: (middle.eye.z + body.z) / 2,
    };
    const trace = sphere(center, 0.1);
    for (const at of [200, 202]) expect(trace(bodyAt(a, at), shotAt(baseline, at).eye)).toBe(1);
    if (obstruction === 'eye chord') expect(trace(shotAt(baseline, 200).eye, shotAt(baseline, 202).eye)).toBeLessThan(1);
    else expect(trace(body, middle.eye)).toBeLessThan(1);
    const plan = await planCamera({a, trace});
    expectConnected(plan, [a], trace, 250);
  });

  test('protects a baseline-visible participant below the usual group-share threshold', async () => {
    const a = straight(), b = straight(), map = Float32Array.from({length: a.count}, (_, i) => i);
    for (let tick = 0; tick < b.count; tick++) b.position[tick * 3] += 5300;
    const options = {a, others: [{track: b, map}], style: 'cinematic'};
    const baseline = await planCamera({...options, trace: () => 1}), middle = shotAt(baseline, 201);
    const trace = sphere(middle.eye, 0.1), plan = await planCamera({...options, trace});
    let protectedSamples = 0;
    for (let tick = 0; tick < a.count - 1; tick += 0.5) {
      const body = bodyAt(b, tick), before = shotAt(baseline, tick);
      if (!inFrame(before, body) || trace(body, before.eye) < 1) continue;
      protectedSamples++;
      const after = shotAt(plan, tick);
      expect(trace(body, after.eye)).toBe(1);
      expect(inFrame(after, body)).toBe(true);
    }
    expect(protectedSamples).toBeGreaterThan(0);
    expectConnected(plan, [a], trace);
  });

  test('checks actual intermediate body positions, not a chord through time-warped runs', async () => {
    const a = straight();
    a.position[201 * 3 + 1] = 200;
    const baseline = await planCamera({a, trace: () => 1}), middle = shotAt(baseline, 201), body = bodyAt(a, 201);
    const center = {x: (middle.eye.x + body.x) / 2,
      y: (middle.eye.y + body.y) / 2, z: (middle.eye.z + body.z) / 2};
    const trace = sphere(center, 0.1);
    trace.mayHit = cameraBoundsQuery(bounds =>
      ['x', 'y', 'z'].every(axis => bounds.max[axis] >= center[axis] - 0.1 &&
        bounds.min[axis] <= center[axis] + 0.1) ? [0] : []);
    for (const tick of [200, 202]) expect(trace(bodyAt(a, tick), shotAt(baseline, tick).eye)).toBe(1);
    expect(trace(body, middle.eye)).toBeLessThan(1);
    const plan = await planCamera({a, trace});
    expectConnected(plan, [a], trace, 250);
  });

  test('keeps each repaired candidate above its actual ridden ramp face', async () => {
    const scene = groupScenario('tunnel'), plan = await planCamera({...scene, style: 'cinematic'});
    for (let tick = 0; tick < scene.a.count - 1; tick += 0.5) for (const track of scene.tracks) {
      const shot = shotAt(plan, tick), body = bodyAt(track, tick);
      const x = shot.eye.x - body.x, y = shot.eye.y - body.y, z = shot.eye.z - body.z;
      expect((-0.8 * y + 0.6 * z) / Math.hypot(x, y, z)).toBeGreaterThan(Math.sin(6 * Math.PI / 180) - 0.001);
    }
  });

  test('does not hide the played run to satisfy a group centroid behind a wall', async () => {
    const a = straight(81), b = straight(81), map = Float32Array.from({length: a.count}, (_, i) => i);
    for (let i = 0; i < b.count; i++) b.position[i * 3 + 1] = 500;
    const trace = box({x: -1e6, y: 200, z: -1e6}, {x: 1e6, y: 220, z: 1e6});
    const plan = await planCamera({a, others: [{track: b, map}], trace});
    expectConnected(plan, [a], trace);
  });

  test('does not search or interpolate a camera connection across a teleport', async () => {
    const a = straight(81);
    for (let tick = 41; tick < a.count; tick++) a.position[tick * 3] += 10000;
    a.cut[41] = 1;
    const trace = box({x: 4000, y: -1e6, z: -1e6}, {x: 6000, y: 1e6, z: 1e6});
    const plan = await planCamera({a, trace});
    expect(plan.segment[20]).not.toBe(plan.segment[21]);
    expect(shotAt(plan, 40.999).eye.x).toBeLessThan(4000);
    expect(shotAt(plan, 41).eye.x).toBeGreaterThan(6000);
  });

});
