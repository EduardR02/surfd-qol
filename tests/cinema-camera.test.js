import {describe, expect, test} from 'bun:test';
import {createTrack, trackPoint} from '../src/cinema-track.js';
import {planCamera, shotAt, STEP} from '../src/cinema-camera.js';

function straight({count = 400, speed = 20} = {}) {
  const track = createTrack(count, 0.015);
  for (let tick = 0; tick < count; tick++) track.position[tick * 3] = tick * speed;
  return track;
}

// Solid walls surrounding an empty box. All sightlines in these fixtures
// start inside the empty space; the first exit is the first opaque surface.
function enclosure(low, high) {
  return (from, to) => {
    let clear = 1;
    for (const axis of ['x', 'y', 'z']) {
      const delta = to[axis] - from[axis];
      if (to[axis] < low[axis]) clear = Math.min(clear, (low[axis] - from[axis]) / delta);
      if (to[axis] > high[axis]) clear = Math.min(clear, (high[axis] - from[axis]) / delta);
    }
    return clear;
  };
}

function sphere(center, radius) {
  return (from, to) => {
    const x = from.x - center.x, y = from.y - center.y, z = from.z - center.z;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const c = x * x + y * y + z * z - radius * radius;
    if (c < 0) return 0;
    const a = dx * dx + dy * dy + dz * dz, b = x * dx + y * dy + z * dz;
    const discriminant = b * b - a * c;
    if (!a || discriminant < 0) return 1;
    const fraction = (-b - Math.sqrt(discriminant)) / a;
    return fraction >= 0 && fraction < 1 ? fraction : 1;
  };
}

function bodyAt(track, tick) {
  const body = trackPoint(track, tick);
  body.z += 40;
  return body;
}

function expectVisibleSamples(track, planned, trace) {
  for (let sample = 0; sample < planned.count; sample++) {
    const tick = Math.min(track.count - 1, sample * STEP);
    const eye = {x: planned.eye[sample * 3], y: planned.eye[sample * 3 + 1], z: planned.eye[sample * 3 + 2]};
    expect(trace(bodyAt(track, tick), eye)).toBe(1);
  }
}

function direction(from, to) {
  const x = to.x - from.x, y = to.y - from.y, z = to.z - from.z;
  const length = Math.hypot(x, y, z);
  return {x: x / length, y: y / length, z: z / length};
}

function bodyBearing(shot, body) {
  const forward = direction(shot.eye, shot.target), bearing = direction(shot.eye, body);
  return forward.x * bearing.x + forward.y * bearing.y + forward.z * bearing.z;
}

describe('final camera visibility', () => {
  for (const style of ['cinematic', 'steady']) describe(style, () => {
    test('preserves the planned shot when its sightlines are clear', async () => {
      const a = straight({count: 64});
      const baseline = await planCamera({a, style, trace: () => 1});
      const trace = sphere({x: 0, y: 10000, z: 40}, 100);
      const planned = await planCamera({a, style, trace});
      expect(planned.eye).toEqual(baseline.eye);
      expect(planned.target).toEqual(baseline.target);
      expectVisibleSamples(a, planned, trace);
    });

    test('keeps the smoothed eye inside walls closer than the preferred shot minimum', async () => {
      const a = straight({count: 32, speed: 0});
      const trace = enclosure({x: -30, y: -30, z: 0}, {x: 30, y: 30, z: 70});
      const uncorrected = await planCamera({a, style});
      expect(trace(bodyAt(a, 10), shotAt(uncorrected, 10).eye)).toBeLessThan(1);

      const planned = await planCamera({a, style, trace});
      expectVisibleSamples(a, planned, trace);
      const body = bodyAt(a, 10), {eye} = shotAt(planned, 10);
      expect(Math.hypot(eye.x - body.x, eye.y - body.y, eye.z - body.z)).toBeLessThan(70);
    });

    test('checks the final eye at samples skipped by the anticipatory collision passes', async () => {
      const a = straight();
      const baseline = await planCamera({a, style, trace: () => 1});
      // Tick 202 is stored sample 101. Earlier collision passes only trace
      // even samples, whose parallel sightlines miss this small solid sphere.
      const tick = 202, center = shotAt(baseline, tick).eye, trace = sphere(center, 1);
      expect(trace(bodyAt(a, tick), center)).toBeLessThan(1);
      for (const adjacent of [tick - STEP, tick + STEP])
        expect(trace(bodyAt(a, adjacent), shotAt(baseline, adjacent).eye)).toBe(1);

      const planned = await planCamera({a, style, trace});
      expectVisibleSamples(a, planned, trace);
      const {eye} = shotAt(planned, tick);
      expect(Math.hypot(eye.x - center.x, eye.y - center.y, eye.z - center.z)).toBeGreaterThan(1);
    });

    test('keeps the surfer framed when a close obstruction disrupts a shot with lead', async () => {
      const a = straight({count: 80});
      for (let tick = 0; tick < a.count; tick++) a.normal.set([0, -0.8, 0.6], tick * 3);
      const baseline = await planCamera({a, style, trace: () => 1});
      const tick = 42, body = bodyAt(a, tick), before = shotAt(baseline, tick);
      expect(Math.hypot(before.target.x - body.x, before.target.y - body.y, before.target.z - body.z)).toBeGreaterThan(40);
      const outward = direction(body, before.eye);
      const trace = sphere({x: body.x + outward.x * 30, y: body.y + outward.y * 30, z: body.z + outward.z * 30}, 1);
      for (const adjacent of [tick - STEP, tick + STEP])
        expect(trace(bodyAt(a, adjacent), shotAt(baseline, adjacent).eye)).toBe(1);

      const planned = await planCamera({a, style, trace}), after = shotAt(planned, tick);
      expect(trace(body, after.eye)).toBe(1);
      // A body inside the vertical half-angle's cone is also inside the
      // wider 16:9 horizontal frustum. This checks actual viewing geometry.
      const verticalHalfAngle = Math.atan(Math.tan(after.fov * Math.PI / 360) * 0.75);
      expect(bodyBearing(after, body)).toBeGreaterThan(Math.cos(verticalHalfAngle));
    });

    test('reframes the body when a near ceiling leaves the smoothed eye beyond the surfer', async () => {
      const a = straight({speed: 100});
      const trace = enclosure({x: -1e9, y: -1e9, z: -1e9}, {x: 1e9, y: 1e9, z: 41});
      const planned = await planCamera({a, style, trace}), body = bodyAt(a, 0), shot = shotAt(planned, 0);
      // Near the beginning, the eased focus is ahead of the actual body.
      // A ceiling-driven pull-in can leave the eye ahead too, while the old
      // forward lead would point away from the surfer behind that eye.
      expect(shot.eye.x).toBeGreaterThan(body.x + 1);
      expect(trace(body, shot.eye)).toBe(1);
      expect(shot.target.x).toBeLessThan(shot.eye.x);
      const verticalHalfAngle = Math.atan(Math.tan(shot.fov * Math.PI / 360) * 0.75);
      expect(bodyBearing(shot, body)).toBeGreaterThan(Math.cos(verticalHalfAngle));
    });

    test('uses clear travelled space through a bend instead of an extreme close-up', async () => {
      const a = createTrack(360, 0.015), radius = 1012;
      for (let tick = 0; tick < a.count; tick++) {
        const angle = tick / (a.count - 1) * 2;
        a.position.set([1000 * Math.cos(angle), 1000 * Math.sin(angle), 0], tick * 3);
      }
      const trace = (from, to) => {
        const dx = to.x - from.x, dy = to.y - from.y;
        const length = dx * dx + dy * dy, dot = from.x * dx + from.y * dy;
        const offset = from.x * from.x + from.y * from.y - radius * radius;
        if (!length) return offset < 0 ? 1 : 0;
        if (offset >= 0) return to.x * to.x + to.y * to.y < radius * radius ? 1 : 0;
        return Math.min(1, (-dot + Math.sqrt(dot * dot - length * offset)) / length);
      };
      const planned = await planCamera({a, style, trace});
      expectVisibleSamples(a, planned, trace);
      for (let tick = 100; tick < 260; tick += STEP) {
        const body = bodyAt(a, tick), shot = shotAt(planned, tick);
        expect(Math.hypot(shot.eye.x - body.x, shot.eye.y - body.y, shot.eye.z - body.z)).toBeGreaterThan(200);
        expect(bodyBearing(shot, body)).toBeGreaterThan(0.95);
      }
    });

    test('does not push the eye through a wall to preserve clearance or minimum distance', async () => {
      const a = straight({count: 32, speed: 0});
      const trace = enclosure({x: -1, y: -1, z: 39}, {x: 1, y: 1, z: 41});
      const planned = await planCamera({a, style, trace});
      expectVisibleSamples(a, planned, trace);
      expect(shotAt(planned, 10).eye).toEqual(bodyAt(a, 10));
    });
  });
});
