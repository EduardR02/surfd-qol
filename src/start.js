function planesFor(zone) {
  if (zone.hulls?.length) return zone.hulls.map(hull => hull.planes);
  const { min, max } = zone;
  if (!min || !max) return [];
  return [[
    { normal: { x: 1, y: 0, z: 0 }, distance: max.x },
    { normal: { x: -1, y: 0, z: 0 }, distance: -min.x },
    { normal: { x: 0, y: 1, z: 0 }, distance: max.y },
    { normal: { x: 0, y: -1, z: 0 }, distance: -min.y },
    { normal: { x: 0, y: 0, z: 1 }, distance: max.z },
    { normal: { x: 0, y: 0, z: -1 }, distance: -min.z }
  ]];
}

function expandedDistance(plane, height) {
  const n = plane.normal;
  // Match the game's swept player-box/trigger overlap, not a point-player test.
  const support = n.x * (n.x < 0 ? 16 : -16) + n.y * (n.y < 0 ? 16 : -16) + n.z * (n.z < 0 ? height : 0);
  return plane.distance - support;
}

function dot(p, n) { return p.x * n.x + p.y * n.y + p.z * n.z; }

function contains(zone, position, height) {
  return planesFor(zone).some(planes => planes.every(plane =>
    dot(position, plane.normal) <= expandedDistance(plane, height) + 0.05));
}

function floorAt(session, zone, crossing, segment, ground) {
  const config = session.config;
  const world = session.movement?.world;
  if (typeof world?.trace === 'function' && Number.isFinite(zone.min?.z)) {
    // The exit lies on the expanded trigger edge, just beyond platform support,
    // so probe slightly inward. The foot box has zero height so a ducked hull
    // cannot shift the floor reference.
    const from = {
      x: crossing.x - Math.sign(crossing.x - segment.from.x) * 0.125,
      y: crossing.y - Math.sign(crossing.y - segment.from.y) * 0.125,
      z: Math.max(crossing.z, zone.min.z) + config.stepSize
    };
    const hit = world.trace(from, { ...from, z: zone.min.z - config.standHeight - config.stepSize },
      { min: { x: -16, y: -16, z: 0 }, max: { x: 16, y: 16, z: 0 } });
    if (!hit.startSolid && !hit.allSolid && hit.fraction < 1 &&
      hit.normal.z >= config.groundNormal && Number.isFinite(hit.end.z)) return hit.end.z;
  }
  // An airborne exit may already be beyond the ledge. Its most recent actual
  // support inside this start zone remains a measured platform reference.
  return ground?.zone === zone ? ground.z : null;
}

function isExit(zone, segment, height, fraction) {
  for (const planes of planesFor(zone)) {
    let enter = 0;
    let exit = 1;
    let intersects = true;
    for (const plane of planes) {
      const d = expandedDistance(plane, height);
      const a = dot(segment.from, plane.normal) - d;
      const b = dot(segment.to, plane.normal) - d;
      if (a > 0 && b > 0) { intersects = false; break; }
      if (a <= 0 && b <= 0) continue;
      const t = a / (a - b);
      if (a > b) enter = Math.max(enter, t);
      else exit = Math.min(exit, t);
      if (enter > exit) { intersects = false; break; }
    }
    const at = segment.startFraction + exit * (segment.endFraction - segment.startFraction);
    if (intersects && Math.abs(at - fraction) < 1e-4) return true;
  }
  return false;
}

// The exit's age is game time (ticks since it), not wall time: a replay's
// speed, pauses and seeks then show it exactly when the run had it, and a
// seek that re-simulates past the start doesn't make it look new.
//
// A start is `clipped` when the prestrafe failed by landing back in the start
// zone: the game allows one jump per visit (session.startJumps), so after
// that landing it blocks the next hop and you leave on the ground, slowed.
// Standing still for a moment gives the jump back, and the attempt with it.
export function createStartFeedback() {
  let latest = null;
  let sessionIdentity = null;
  let ground = null;
  let clipped = false;
  return {
    reset() { latest = ground = sessionIdentity = null; clipped = false; },
    // Zone and Session identities are static for a watched replay; retain them
    // without copying geometry or the native command log.
    saveState() {
      return {
        latest: latest ? { ...latest } : null,
        ground: ground ? { ...ground } : null,
        sessionIdentity, clipped,
      };
    },
    restoreState(saved) {
      latest = saved.latest ? { ...saved.latest } : null;
      ground = saved.ground ? { ...saved.ground } : null;
      sessionIdentity = saved.sessionIdentity;
      clipped = saved.clipped === true;
    },
    observe(session, events) {
      if (sessionIdentity !== session) { latest = ground = null; clipped = false; sessionIdentity = session; }
      if (events.some(event => ['fall', 'start-return', 'stage-return'].includes(event))) { latest = ground = null; clipped = false; }
      const state = session.state;
      const config = session.config;
      const height = state.ducked ? config.duckHeight : config.standHeight;
      // Unrestricted starts allow prehops, and the counter never resets there.
      const jumpSpent = !config.unrestrictedStart && session.startJumps >= 1;
      if (!jumpSpent) clipped = false;
      if (state.grounded) {
        const zone = session.map.zones.find(zone => zone.kind === 'start' && contains(zone, state.position, height));
        if (zone) {
          ground = { zone, z: state.position.z };
          if (jumpSpent) clipped = true;
        }
      }
      if (!events.includes('start') || !session.lastResult) return;
      const tick = state.tick - 1;
      const fraction = session.timer.state.startTick - tick;
      let crossing = null;
      let zone = null;
      let exitSegment = null;
      for (const segment of session.lastResult.segments) {
        if (fraction < segment.startFraction - 1e-5 || fraction > segment.endFraction + 1e-5) continue;
        const span = segment.endFraction - segment.startFraction;
        const t = span > 0 ? Math.max(0, Math.min(1, (fraction - segment.startFraction) / span)) : 0;
        const point = {
          x: segment.from.x + (segment.to.x - segment.from.x) * t,
          y: segment.from.y + (segment.to.y - segment.from.y) * t,
          z: segment.from.z + (segment.to.z - segment.from.z) * t
        };
        const candidate = session.map.zones.find(candidate => candidate.kind === 'start' && isExit(candidate, segment, height, fraction));
        if (candidate) { crossing = point; zone = candidate; exitSegment = segment; break; }
      }
      const targetSpeed = session.timer.startSpeedCap(state.grounded);
      const speed = Math.hypot(state.velocity.x, state.velocity.y);
      const floorHeight = crossing && zone ? floorAt(session, zone, crossing, exitSegment, ground) : null;
      latest = {
        available: true, speed, targetSpeed, speedDelta: speed - targetSpeed,
        exitHeight: crossing?.z ?? null, floorHeight,
        heightAboveFloor: floorHeight === null ? null : crossing.z - floorHeight,
        label: config.unrestrictedStart ? 'Unrestricted start' : state.grounded ? 'Ground start' : 'Airborne start',
        clipped, tick: state.tick, dt: config.dt ?? 0.015
      };
    },
    // age: milliseconds of game time since the exit; none before it.
    snapshot() {
      const now = sessionIdentity?.state?.tick;
      const ticks = latest && Number.isFinite(now) ? now - latest.tick : 0;
      return latest && ticks >= 0 ? { ...latest, age: ticks * latest.dt * 1000 } : { available: false };
    }
  };
}
