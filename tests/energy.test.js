import { describe, expect, test } from 'bun:test';
import { createEnergyTrend, energySample } from '../src/energy.js';

const dt = 0.015, gravity = 800;
function state(tick, position, velocity) { return { tick, position: { ...position }, velocity: { ...velocity } }; }
// Native half-step gravity: v -= g·dt/2, move, v -= g·dt/2.
function fall(s) {
  s.velocity.z -= gravity * dt / 2;
  s.position.x += s.velocity.x * dt; s.position.y += s.velocity.y * dt; s.position.z += s.velocity.z * dt;
  s.velocity.z -= gravity * dt / 2;
  s.tick++;
}
function run(trend, s, ticks, step) {
  let result;
  for (let i = 0; i < ticks; i++) { step(s); result = trend.sample(energySample(s, dt, false), gravity); }
  return result;
}

describe('energy trend', () => {
  test('free fall and arcs stay neutral: gravity conversion is not gain or loss', () => {
    const trend = createEnergyTrend();
    const s = state(0, { x: 0, y: 0, z: 5000 }, { x: 2500, y: 300, z: 400 });
    trend.sample(energySample(s, dt, false), gravity);
    const result = run(trend, s, 200, fall);
    expect(result.tone).toBe('neutral');
    expect(Math.abs(result.rate)).toBeLessThan(1e-6);
  });

  test('air strafe gain reads good and braking reads loss', () => {
    const trend = createEnergyTrend();
    const s = state(0, { x: 0, y: 0, z: 5000 }, { x: 3000, y: 0, z: 0 });
    trend.sample(energySample(s, dt, false), gravity);
    // ~10 u/s per second: a realistic high-speed strafe gain.
    let result = run(trend, s, 40, s => { fall(s); s.velocity.x += 10 * dt; });
    expect(result.tone).toBe('good');
    expect(result.rate).toBeGreaterThan(5);
    expect(result.level).toBeGreaterThan(0);
    result = run(trend, s, 40, s => { fall(s); s.velocity.x -= 10 * dt; });
    expect(result.tone).toBe('loss');
    expect(result.level).toBeLessThan(0);
  });

  test('climbing a ramp with exact height conversion stays neutral', () => {
    const trend = createEnergyTrend();
    const s = state(0, { x: 0, y: 0, z: 0 }, { x: 2000, y: 0, z: 0 });
    const energy = 2000 ** 2;
    trend.sample(energySample(s, dt, false), gravity);
    const result = run(trend, s, 60, s => {
      s.tick++;
      s.position.x += 30; s.position.z += 20;
      s.velocity.x = Math.sqrt(energy - 2 * gravity * s.position.z);
    });
    expect(result.tone).toBe('neutral');
    expect(Math.abs(result.rate)).toBeLessThan(1e-6);
  });

  test('teleports, restarts and long pauses start a new baseline instead of a spike', () => {
    const trend = createEnergyTrend();
    const s = state(100, { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 });
    trend.sample(energySample(s, dt, false), gravity);
    s.tick++; s.position.z += 5000;
    expect(trend.sample(energySample(s, dt, false), gravity).tone).toBe('neutral');
    s.tick = 3; s.position.z = 0;
    expect(trend.sample(energySample(s, dt, false), gravity).rate).toBe(0);
    s.tick += 100; s.velocity.x = 10;
    expect(trend.sample(energySample(s, dt, false), gravity).rate).toBe(0);
  });

  test('hysteresis holds a tone through brief strafe transitions', () => {
    const trend = createEnergyTrend();
    const s = state(0, { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 });
    trend.sample(energySample(s, dt, false), gravity);
    expect(run(trend, s, 30, s => { s.tick++; s.position.x += 15; s.velocity.x += 20 * dt; }).tone).toBe('good');
    // One coasting tick between strafes decays the rate but stays above EXIT.
    expect(run(trend, s, 1, s => { s.tick++; s.position.x += 15; }).tone).toBe('good');
    expect(run(trend, s, 60, s => { s.tick++; s.position.x += 15; }).tone).toBe('neutral');
  });

  test('repeated network poses keep the trend; invalid samples reset it', () => {
    const trend = createEnergyTrend();
    const pose = { x: 0, y: 0, z: 0, vx: 1000, vy: 0, vz: 0 };
    trend.sample(energySample(pose, dt, true, 0), gravity);
    pose.vx += 2; pose.x += 50;
    const gained = trend.sample(energySample(pose, dt, true, 50), gravity).rate;
    expect(gained).toBeGreaterThan(0);
    expect(trend.sample(energySample(pose, dt, true, 66), gravity).rate).toBe(gained);
    expect(trend.sample(energySample({ ...pose, vz: undefined }, dt, true, 80), gravity).tone).toBe('neutral');
    expect(energySample(null, dt, false)).toBe(null);
  });
});

test('suppressed samples read neutral but keep the baseline for an immediate response afterwards', () => {
  const trend = createEnergyTrend();
  const s = state(0, { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 });
  trend.sample(energySample(s, dt, false), gravity);
  for (let i = 0; i < 30; i++) {
    s.tick++; s.position.x += 15; s.velocity.x -= 40 * dt;
    expect(trend.sample(energySample(s, dt, false), gravity, true)).toMatchObject({ tone: 'neutral', rate: 0 });
  }
  s.tick++; s.position.x += 15; s.velocity.x += 400 * dt;
  expect(trend.sample(energySample(s, dt, false), gravity).tone).toBe('good');
});
