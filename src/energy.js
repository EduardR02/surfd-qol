// Mechanical energy trend for the optional speed tint. E = |v|² + 2·g·z is
// exactly conserved by the native half-step gravity integration, so its rate
// is input/collision/friction work only: height conversion on a ramp or a
// falling arc is neutral. The rate is reported as equivalent speed change,
// dE/dt / 2|v| (u/s per second), so it reads like gaining or losing units.
const TIME_CONSTANT = 0.12;
const ENTER = 2;
const EXIT = 0.5;
const FULL_SCALE = 30;
const MIN_SPEED = 50;
const MAX_GAP = 0.5;

export function createEnergyTrend() {
  let lastTime = NaN, lastEnergy = NaN, lastX = NaN, lastY = NaN, lastZ = NaN;
  let rate = 0, tone = 'neutral';
  const result = { tone: 'neutral', level: 0, rate: 0 };
  function publish() {
    result.tone = tone;
    result.rate = rate;
    result.level = Math.tanh(rate / FULL_SCALE);
    return result;
  }
  function reset() {
    lastTime = lastEnergy = lastX = lastY = lastZ = NaN;
    rate = 0;
    tone = 'neutral';
    return publish();
  }
  // time is simulated seconds (tick × dt) for exact local samples. A repeated
  // network pose carries no new information, so it keeps the previous trend.
  // Suppressed samples (e.g. while surfing a ramp) stay neutral but keep the
  // baseline, so the trend responds immediately once suppression ends.
  function sample({ x, y, z, vx, vy, vz, time, exact }, gravity, suppressed = false) {
    if (![x, y, z, vx, vy, vz, time, gravity].every(Number.isFinite)) return reset();
    const speedSquared = vx * vx + vy * vy + vz * vz;
    const energy = speedSquared + 2 * gravity * z;
    const dt = time - lastTime;
    const repeated = energy === lastEnergy && x === lastX && y === lastY && z === lastZ;
    if (dt === 0 || (repeated && !exact)) {
      if (suppressed) { rate = 0; tone = 'neutral'; }
      return publish();
    }
    const speed = Math.sqrt(speedSquared);
    // Restarts, seeks and teleports move the player further than its own
    // velocity could; they start a fresh baseline instead of a fake spike.
    const jumped = Math.hypot(x - lastX, y - lastY, z - lastZ) > Math.max(speed, MIN_SPEED) * dt * 2 + 64;
    if (!(dt > 0) || dt > MAX_GAP || jumped || suppressed) {
      reset();
      lastTime = time; lastEnergy = energy; lastX = x; lastY = y; lastZ = z;
      return publish();
    }
    const instant = (energy - lastEnergy) / dt / (2 * Math.max(speed, MIN_SPEED));
    rate += (instant - rate) * (1 - Math.exp(-dt / TIME_CONSTANT));
    lastTime = time; lastEnergy = energy; lastX = x; lastY = y; lastZ = z;
    if (tone === 'good' ? rate < EXIT : tone === 'loss' ? rate > -EXIT : true) {
      tone = rate > ENTER ? 'good' : rate < -ENTER ? 'loss' : 'neutral';
    }
    return publish();
  }
  return { sample, reset };
}

// Local sessions carry exact simulated ticks; spectator poses only carry a
// network timestamp, so they fall back to wall-clock time between new poses.
export function energySample(state, dt, spectator, now = performance.now()) {
  if (spectator) {
    return state ? { x: state.x, y: state.y, z: state.z, vx: state.vx, vy: state.vy, vz: state.vz, time: now / 1000, exact: false } : null;
  }
  const position = state?.position, velocity = state?.velocity;
  if (!position || !velocity || !Number.isFinite(state.tick)) return null;
  return { x: position.x, y: position.y, z: position.z, vx: velocity.x, vy: velocity.y, vz: velocity.z, time: state.tick * dt, exact: true };
}
