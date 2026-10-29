import { getRampSurfaces } from './surfaces.js';

// Source-style acceleration observation only: never writes to a session or its vectors.
// Losses are speed differences (units/s), not a route optimum. Surf compares
// complete movement endpoints against the gravity-only exit speed.
const RAMP_WINDOW_SECONDS = 0.5;
const DEFAULT_STRAFE_WINDOW_SECONDS = 0.2;
const SAMPLE_CAPACITY = 128;
const EVENT_MILLISECONDS = 1600;
const RAMP_CONTACT_GRACE = 0.045;
const SURFACE_CONTACT_GRACE = 0.25;
const BOARD_ENTRY_WINDOW_SECONDS = 0.09;
const TIME_EPSILON = 1e-12;
const MIN_AIR_SECONDS = 0.05;
const MIN_SURF_SECONDS = 0.05;
const MAX_ROUTE_ENTRIES = 256;
const MAX_ROUTE_PREFIX_LENGTH = 16384;
const identity = value => value;
const clock = () => performance.now();
const finiteVector = value => value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
// Contacts expose normals, not plane offsets. Allow float32 normal noise,
// but never use BSP identity to decide whether two ramp orientations match.
const sameRampPlane = (a, b) => Math.abs(a.x - b.x) <= 1e-6 &&
  Math.abs(a.y - b.y) <= 1e-6 && Math.abs(a.z - b.z) <= 1e-6;

function acceleratedSpeed(x, y, dx, dy, cap, budget, round) {
  const available = round(cap - round(x * dx + y * dy));
  if (available <= 0) return Math.hypot(x, y);
  const amount = Math.min(available, budget);
  return Math.hypot(round(x + dx * amount), round(y + dy * amount));
}

function optimumSpeed(before, cap, budget, round, actualSpeed) {
  const speed = Math.hypot(before.x, before.y);
  if (speed === 0) {
    return Math.max(actualSpeed, acceleratedSpeed(0, 0, 1, 0, cap, budget, round));
  }
  // With t = v.dot(wishDirection), a = min(budget, cap - t), the
  // squared speed is v² + 2at + a². Its maximum is at
  // t = clamp(cap - budget, 0, |v|), NOT always at the cap boundary.
  const projection = Math.min(speed, Math.max(0, cap - budget));
  const cosine = projection / speed;
  const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  const x = before.x / speed;
  const y = before.y / speed;
  // Evaluate both analytic directions with the game's float32 direction,
  // dot, cap subtraction and final-vector rounding. Including the observed
  // direction prevents roundoff from reporting negative opportunity loss.
  // This is not an exhaustive search of the float32 direction lattice;
  // discrepancies from that lattice's exact maximum are float32-rounding scale.
  const left = acceleratedSpeed(before.x, before.y,
    round(x * cosine - y * sine), round(y * cosine + x * sine), cap, budget, round);
  const right = acceleratedSpeed(before.x, before.y,
    round(x * cosine + y * sine), round(y * cosine - x * sine), cap, budget, round);
  return Math.max(actualSpeed, left, right);
}

function tangentSpeed(x, y, z, normal) {
  const projection = (x * normal.x + y * normal.y + z * normal.z) /
    (normal.x ** 2 + normal.y ** 2 + normal.z ** 2);
  return Math.hypot(x - normal.x * projection, y - normal.y * projection, z - normal.z * projection);
}

function pressureCurve(t, p, normalSpeed, contourSpeed, cap, derivative) {
  const magnitude = Math.hypot(p, t);
  return derivative ? 2 * t + contourSpeed - cap * t / magnitude :
    p * p + t * t + normalSpeed * p + contourSpeed * t - cap * magnitude;
}

function pressureRoot(low, high, p, normalSpeed, contourSpeed, cap, derivative) {
  let left = pressureCurve(low, p, normalSpeed, contourSpeed, cap, derivative);
  for (let i = 0; i < 56; i++) {
    const middle = (low + high) / 2;
    if (middle === low || middle === high) return middle;
    const value = pressureCurve(middle, p, normalSpeed, contourSpeed, cap, derivative);
    if (value === 0) return middle;
    if ((value < 0) === (left < 0)) {
      low = middle;
      left = value;
    } else high = middle;
  }
  return (low + high) / 2;
}

export function createMetrics(settings = {}, {referenceOnly = false} = {}) {
  // Fixed-size storage and constant-time eviction: no history grows with a run.
  const sampleTimes = new Float64Array(SAMPLE_CAPACITY);
  const sampleGains = new Float64Array(SAMPLE_CAPACITY);
  const sampleOptima = new Float64Array(SAMPLE_CAPACITY);
  const rampTimes = new Float64Array(SAMPLE_CAPACITY);
  const rampLosses = new Float64Array(SAMPLE_CAPACITY);
  const pressureCuts = new Float64Array(4);
  const pressureIntervals = new Float64Array(6);
  let rampHead = 0;
  let rampCount = 0;
  let mode = 'air';
  // Reuse validated native inputs; a tick normally accelerates once, but keep
  // every observation if a movement implementation accelerates more often.
  const accelerationInputs = [];
  let accelerationCount = 0;
  let inputBefore = null;
  let inputAfter = null;
  let inputCap = 0;
  let inputBudget = 0;
  let inputFloat32 = false;
  let tickPlane = null;
  let tickBrush = null;
  let tickMultiplePlanes = false;
  let surfaces = null;
  let tickSurface = null;
  let tickSurfaceUnknown = false;
  let tickSurfaceConflict = false;
  let tickDifferentNormals = false;
  let tickStartSpeedSquared = NaN;
  let tickStartHeight = NaN;
  let tickGravity = NaN;
  let head = 0;
  let count = 0;
  let rollingGain = 0;
  let rollingOptimum = 0;
  let strafeTotal = 0;
  let rampTotal = 0;
  let elapsed = 0;
  let duration = 0.015;
  let previousSession = null;
  let previousState = null;
  let previousTick = null;
  let open = false;
  let eligible = false;
  let status = 'waiting';
  let tickGain = 0;
  let tickOptimum = 0;
  let tickAvailable = false;
  let tickReason = 'no-acceleration';
  let tickRampLoss = 0;
  let tickRampContact = false;
  let tickMixedContact = false;
  let tickCrashContact = false;
  let tickGround = false;
  let tickGroundContact = false;
  let tickAirBoundary = false;
  let tickBoardAmbiguous = false;
  let tickBoardSpeedBefore = 0;
  let tickBoardSpeedAfter = 0;
  let tickBoardAngleSine = null;
  let episodeActive = false;
  let episodeSeconds = 0;
  let airborneGapSeconds = 0;
  let episodeSurface = null;
  let surfEntrySpeedSquared = NaN;
  let surfEntryHeight = NaN;
  let surfExitSpeedSquared = NaN;
  let surfExitHeight = NaN;
  let surfGravity = NaN;
  let surfContactSeconds = 0;
  let surfMeasuredSeconds = 0;
  let surfUnsupportedTicks = 0;
  let surfSkippedTicks = 0;
  let surfCrash = false;
  let surfLowHeight = Infinity;
  let surfLowEnergy = NaN;
  let surfTick = null;
  let idle = false;
  let tickAirGated = false;
  let airSkippedSeconds = 0;
  const entryPlane = { x: 0, y: 0, z: 0 };
  const surfaceVisits = new Map();
  let routePrefix = '';
  let routeEntries = 0;
  let airBrakingLoss = 0;
  let airMissedGain = 0;
  let airMeasuredSeconds = 0;
  // tick is the completed simulation step (session.state.tick), not wall time.
  // Each sequence counts accepted summaries since reset; invalidating a board
  // clears its values/tick but does not pretend another board was measured.
  const board = {
    available: false, loss: 0, speedBefore: 0, speedAfter: 0, angle: null, tick: null, sequence: 0, crash: false,
    entryContacts: 0, entryWindowSeconds: BOARD_ENTRY_WINDOW_SECONDS,
    surfaceId: null, visit: null, checkpoint: null, routePrefix: null,
  };
  let boardVersion = 0;
  const air = { available: false, loss: 0, brakingLoss: 0, missedGain: 0, measuredSeconds: 0, tick: null, sequence: 0 };
  // downLoss + upLoss === loss: the visit splits at its lowest contact point.
  const surf = {
    available: false, loss: null, downLoss: null, upLoss: null, entrySpeed: null, exitSpeed: null,
    expectedExitSpeed: null, heightDelta: null, lowHeightDelta: null, measuredSeconds: 0,
    tick: null, sequence: 0, surfaceId: null, visit: null, checkpoint: null, routePrefix: null,
    unsupportedTicks: 0, reason: '', crash: false,
  };
  // Cold native seeks can restore a worker keyframe we never analysed.
  // Do not publish the interrupted flight/visit as a complete measurement.
  let unknownAir = false, unknownRamp = false, unknownRampGap = 0, episodeUnknown = false;
  let entryLoss = 0;
  let turnLoss = 0;
  let eventLoss = 0;
  let eventKind = '';
  let eventAt = -Infinity;
  let eventSimulationAt = -Infinity;

  // Hidden HUD values skip their work entirely. Reference reconstruction
  // always measures. A value enabled mid-section publishes that section as
  // unavailable instead of a partial measurement.
  const shown = key => settings[key] !== false;
  const live = () => !referenceOnly && settings.continuousFeedback === true;
  const active = () => referenceOnly ||
    (settings.hud !== false && settings.zen !== true && (shown('showBoard') || shown('showAir') || shown('showSurf')));
  const airWanted = () => !referenceOnly && shown('showAir');
  const heldSurfWanted = () => referenceOnly || (shown('showSurf') && !live());

  function clearBoard() {
    if (board.available) boardVersion++;
    board.available = false;
    board.crash = false;
    board.loss = board.speedBefore = board.speedAfter = 0;
    board.angle = null;
    board.tick = null;
    board.entryContacts = 0;
    board.surfaceId = board.visit = board.checkpoint = board.routePrefix = null;
  }

  function finishAir(tick) {
    // Tiny contact-grace gaps are not useful flights. Unsupported/coasting
    // ticks contribute neither time nor invented input opportunity. Contact
    // closes the segment even when too short to replace the retained summary.
    if (unknownAir) {
      unknownAir = false;
    } else if (airSkippedSeconds > 0 && airSkippedSeconds + airMeasuredSeconds >= MIN_AIR_SECONDS) {
      // Part of this flight was not analysed while Air was hidden.
      air.available = false;
      air.loss = air.brakingLoss = air.missedGain = 0;
      air.measuredSeconds = airMeasuredSeconds;
      air.tick = tick;
      air.sequence++;
    } else if (airMeasuredSeconds >= MIN_AIR_SECONDS) {
      air.available = true;
      air.brakingLoss = airBrakingLoss;
      air.missedGain = airMissedGain;
      air.loss = airBrakingLoss + airMissedGain;
      air.measuredSeconds = airMeasuredSeconds;
      air.tick = tick;
      air.sequence++;
    }
    airBrakingLoss = airMissedGain = airMeasuredSeconds = airSkippedSeconds = 0;
  }

  function clearSurfEpisode() {
    surfEntrySpeedSquared = surfEntryHeight = surfExitSpeedSquared = surfExitHeight = surfGravity = NaN;
    surfContactSeconds = surfMeasuredSeconds = surfUnsupportedTicks = surfSkippedTicks = 0;
    surfCrash = false;
    surfLowHeight = Infinity;
    surfLowEnergy = NaN;
    surfTick = null;
    episodeSurface = null;
    episodeActive = false;
    airborneGapSeconds = 0;
    episodeUnknown = false;
  }

  function finishSurf() {
    if (surfCrash || surfContactSeconds > 0) {
      const expectedSquared = surfEntrySpeedSquared + 2 * surfGravity * (surfEntryHeight - surfExitHeight);
      surf.available = surfContactSeconds + TIME_EPSILON >= MIN_SURF_SECONDS &&
        !episodeUnknown && surfUnsupportedTicks === 0 && surfSkippedTicks === 0 && Number.isFinite(expectedSquared) &&
        expectedSquared >= 0 && Number.isFinite(surfExitSpeedSquared) && Number.isFinite(surfLowEnergy);
      surf.entrySpeed = Number.isFinite(surfEntrySpeedSquared) ? Math.sqrt(surfEntrySpeedSquared) : null;
      surf.exitSpeed = Number.isFinite(surfExitSpeedSquared) ? Math.sqrt(surfExitSpeedSquared) : null;
      surf.expectedExitSpeed = surf.available ? Math.sqrt(expectedSquared) : null;
      surf.heightDelta = Number.isFinite(surfEntryHeight) && Number.isFinite(surfExitHeight)
        ? surfExitHeight - surfEntryHeight : null;
      surf.lowHeightDelta = Number.isFinite(surfLowHeight) && Number.isFinite(surfEntryHeight)
        ? surfLowHeight - surfEntryHeight : null;
      surf.loss = surf.available ? surf.expectedExitSpeed - surf.exitSpeed : null;
      // Energy E = v² + 2gh. expected − exit = (E_entry − E_exit) / (expected + exit),
      // so dividing each phase's energy drop by the same sum makes them add up
      // exactly to the whole-visit result, in exit-speed units.
      const scale = surf.available ? surf.expectedExitSpeed + surf.exitSpeed : 0;
      if (scale > 0) {
        const entryEnergy = surfEntrySpeedSquared + 2 * surfGravity * surfEntryHeight;
        const exitEnergy = surfExitSpeedSquared + 2 * surfGravity * surfExitHeight;
        surf.downLoss = (entryEnergy - surfLowEnergy) / scale;
        surf.upLoss = (surfLowEnergy - exitEnergy) / scale;
      } else surf.downLoss = surf.upLoss = surf.available ? 0 : null;
      surf.reason = episodeUnknown ? 'replay-gap' : surfSkippedTicks ? 'not-tracked-while-hidden'
        : surfUnsupportedTicks ? 'unsupported-contact-or-endpoint'
        : !Number.isFinite(expectedSquared) || !Number.isFinite(surfExitSpeedSquared) ? 'invalid-endpoint'
        : expectedSquared < 0 ? 'above-gravity-only-height'
        : surfCrash ? 'crash'
        : surfContactSeconds + TIME_EPSILON < MIN_SURF_SECONDS ? 'short-contact' : '';
      surf.measuredSeconds = surfMeasuredSeconds;
      surf.tick = surfTick;
      surf.surfaceId = episodeSurface;
      surf.visit = board.visit;
      surf.checkpoint = board.checkpoint;
      surf.routePrefix = board.routePrefix;
      surf.unsupportedTicks = surfUnsupportedTicks;
      surf.crash = surfCrash;
      surf.sequence++;
    }
    clearSurfEpisode();
  }

  // replayGap: what came before is unknown, so the flight or ramp in progress
  // isn't measured and nothing may claim a PB/WR visit match until a run start.
  // partial: only the flight or ramp in progress is unknown (a saveloc loaded
  // mid-air or mid-ramp); later ramps are measured and graded as usual.
  function reset({replayGap = false, partial = false} = {}) {
    boardVersion++;
    accelerationCount = 0;
    head = count = 0;
    rampHead = rampCount = 0;
    mode = 'air';
    tickPlane = tickBrush = null;
    surfaces = tickSurface = null;
    tickMultiplePlanes = false;
    rollingGain = rollingOptimum = strafeTotal = rampTotal = 0;
    elapsed = 0;
    previousSession = previousState = previousTick = null;
    open = eligible = tickAvailable = false;
    status = 'waiting';
    tickGain = tickOptimum = tickRampLoss = 0;
    tickRampContact = tickMixedContact = tickGround = tickGroundContact = false;
    tickCrashContact = false;
    eventAt = eventSimulationAt = -Infinity;
    entryLoss = turnLoss = eventLoss = 0;
    eventKind = '';
    tickAirBoundary = tickBoardAmbiguous = episodeActive = false;
    tickBoardSpeedBefore = tickBoardSpeedAfter = 0;
    tickBoardAngleSine = null;
    episodeSeconds = airborneGapSeconds = 0;
    clearBoard();
    board.sequence = 0;
    surfaceVisits.clear();
    routePrefix = '';
    routeEntries = 0;
    air.available = false;
    air.loss = air.brakingLoss = air.missedGain = air.measuredSeconds = air.sequence = 0;
    air.tick = null;
    airBrakingLoss = airMissedGain = airMeasuredSeconds = airSkippedSeconds = 0;
    tickAirGated = false;
    clearSurfEpisode();
    surf.available = false;
    surf.crash = false;
    surf.loss = surf.downLoss = surf.upLoss = surf.entrySpeed = surf.exitSpeed = surf.expectedExitSpeed = null;
    surf.heightDelta = surf.lowHeightDelta = null;
    surf.measuredSeconds = 0;
    surf.reason = '';
    surf.sequence = surf.unsupportedTicks = 0;
    surf.tick = surf.surfaceId = surf.visit = surf.checkpoint = surf.routePrefix = null;
    unknownAir = unknownRamp = replayGap || partial;
    unknownRampGap = 0;
    episodeUnknown = false;
    if (replayGap) routePrefix = null;
  }

  function removeOldest() {
    rollingGain -= sampleGains[head];
    rollingOptimum -= sampleOptima[head];
    head = (head + 1) % SAMPLE_CAPACITY;
    count--;
    if (count === 0) rollingGain = rollingOptimum = 0;
  }

  function strafeWindowSeconds() {
    const value = settings.strafeLookbackSeconds;
    return Number.isFinite(value) ? Math.max(0.05, Math.min(0.5, value)) : DEFAULT_STRAFE_WINDOW_SECONDS;
  }

  function trimStrafeWindow(windowSeconds) {
    // Shrinking takes effect immediately, including while paused. Expanding
    // fills from retained/new observations; discarded history is not invented.
    while (count && elapsed - sampleTimes[head] >= windowSeconds) removeOldest();
  }

  function removeRampOldest() {
    turnLoss -= rampLosses[rampHead];
    rampHead = (rampHead + 1) % SAMPLE_CAPACITY;
    rampCount--;
    if (rampCount === 0) turnLoss = 0;
  }

  function surfCandidate(dx, dy, normal, best) {
    const round = inputFloat32 ? Math.fround : identity;
    dx = round(dx);
    dy = round(dy);
    const available = round(inputCap - round(inputBefore.x * dx + inputBefore.y * dy));
    const amount = available <= 0 ? 0 : Math.min(available, inputBudget);
    const x = amount === 0 ? inputBefore.x : round(inputBefore.x + dx * amount);
    const y = amount === 0 ? inputBefore.y : round(inputBefore.y + dy * amount);
    const difference = (x - inputAfter.x) * normal.x + (y - inputAfter.y) * normal.y;
    // Check the native rounded output, not just the continuous root. This is
    // an arithmetic error bound, not permission to change holding pressure.
    const epsilon = inputFloat32 ? 2 ** -23 : Number.EPSILON;
    const tolerance = 8 * epsilon * (Math.abs(x * normal.x) + Math.abs(y * normal.y) +
      Math.abs(inputAfter.x * normal.x) + Math.abs(inputAfter.y * normal.y) + 1);
    if (Math.abs(difference) > tolerance) return best;
    return Math.max(best, tangentSpeed(x, y, inputBefore.z, normal));
  }

  function surfImpulse(p, t, hx, hy, normal, best) {
    const magnitude = Math.hypot(p, t);
    if (magnitude === 0) return best;
    return surfCandidate((p * hx - t * hy) / magnitude,
      (p * hy + t * hx) / magnitude, normal, best);
  }

  function surfAcceleration() {
    if (!tickAvailable) return;
    tickAvailable = false;
    tickReason = 'unsupported-surf';
    if (tickMixedContact || tickMultiplePlanes || !tickPlane) return;
    const n = tickPlane;
    const horizontalNormal = Math.hypot(n.x, n.y);
    const hx = n.x / horizontalNormal;
    const hy = n.y / horizontalNormal;
    const p = (inputAfter.x - inputBefore.x) * hx + (inputAfter.y - inputBefore.y) * hy;
    const normalSpeed = inputBefore.x * hx + inputBefore.y * hy;
    const contourSpeed = -inputBefore.x * hy + inputBefore.y * hx;
    const before = tangentSpeed(inputBefore.x, inputBefore.y, inputBefore.z, n);
    const actual = tangentSpeed(inputAfter.x, inputAfter.y, inputAfter.z, n);
    let best = actual;
    if (p === 0) {
      // A nonzero impulse with zero normal pressure must lie along contour.
      // The observed input already includes the zero-acceleration possibility.
      best = surfCandidate(-hy, hx, n, best);
      best = surfCandidate(hy, -hx, n, best);
    } else if (Math.abs(p) <= inputBudget) {
      // In horizontal normal/contour coordinates the impulse is u=(p,t).
      // Keeping p fixes contact pressure. Native acceleration permits either
      // |u|=budget or |u|² + v.u = cap*|u| (cap-limited acceleration).
      // The latter is F(t)=0 on the budget chord. Its second derivative is
      // 2-cap*p²/(p²+t²)^(3/2), with at most two analytically known zeros.
      // Split there to isolate all F' roots, then all F roots. Unlike a
      // reflected wish, these roots allow different impulse magnitudes.
      const limit = Math.sqrt(Math.max(0, inputBudget * inputBudget - p * p));
      const inflectionSquared = Math.cbrt(inputCap * p * p / 2) ** 2 - p * p;
      let cutCount = 1;
      pressureCuts[0] = -limit;
      if (inflectionSquared > 0 && inflectionSquared < limit * limit) {
        const inflection = Math.sqrt(inflectionSquared);
        pressureCuts[cutCount++] = -inflection;
        pressureCuts[cutCount++] = inflection;
      }
      pressureCuts[cutCount++] = limit;
      let intervalCount = 1;
      pressureIntervals[0] = -limit;
      for (let i = 1; i < cutCount; i++) {
        const low = pressureCuts[i - 1];
        const high = pressureCuts[i];
        const left = pressureCurve(low, p, normalSpeed, contourSpeed, inputCap, true);
        const right = pressureCurve(high, p, normalSpeed, contourSpeed, inputCap, true);
        if (left === 0 && low !== -limit) pressureIntervals[intervalCount++] = low;
        if ((left < 0 && right > 0) || (left > 0 && right < 0)) {
          pressureIntervals[intervalCount++] = pressureRoot(low, high, p, normalSpeed, contourSpeed, inputCap, true);
        }
      }
      pressureIntervals[intervalCount++] = limit;
      for (let i = 0; i < intervalCount; i++) {
        const high = pressureIntervals[i];
        // Endpoints include the budget-limited possibilities and stationary
        // (double) roots. Native re-evaluation rejects infeasible candidates.
        best = surfImpulse(p, high, hx, hy, n, best);
        if (i === 0) continue;
        const low = pressureIntervals[i - 1];
        const left = pressureCurve(low, p, normalSpeed, contourSpeed, inputCap, false);
        const right = pressureCurve(high, p, normalSpeed, contourSpeed, inputCap, false);
        if ((left < 0 && right > 0) || (left > 0 && right < 0)) {
          const root = pressureRoot(low, high, p, normalSpeed, contourSpeed, inputCap, false);
          best = surfImpulse(p, root, hx, hy, n, best);
        }
      }
    }
    // This is a local same-pressure comparison, not a route optimum or a
    // search of the entire float32 input lattice. Actual input stays a valid
    // baseline even when rounding prevents a distinct candidate being used.
    tickGain = actual - before;
    tickOptimum = best - before;
    tickAvailable = true;
    tickReason = 'surf';
  }

  function begin(session) {
    if (!active()) {
      if (!idle) reset({replayGap: unknownAir || unknownRamp});
      idle = true;
      open = false;
      return;
    }
    const resumed = idle;
    idle = false;
    if (resumed || (previousSession && (session !== previousSession || session.state !== previousState ||
      session.state.tick !== previousTick))) reset({replayGap: resumed && (unknownAir || unknownRamp)});
    // Visits counted before the pause are unknown: until the next run start
    // resets the route, nothing may claim a PB/WR visit match.
    if (resumed) routePrefix = null;
    duration = Number.isFinite(session.config?.dt) && session.config.dt > 0 ? session.config.dt : 0.015;
    open = true;
    accelerationCount = 0;
    tickGain = tickOptimum = tickRampLoss = 0;
    tickAvailable = tickRampContact = tickMixedContact = false;
    tickCrashContact = false;
    tickPlane = tickBrush = null;
    tickMultiplePlanes = false;
    surfaces = getRampSurfaces(session.map, session.config?.groundNormal);
    tickSurface = null;
    tickSurfaceUnknown = tickSurfaceConflict = tickDifferentNormals = false;
    // Sample the whole native tick, not the accelerate/slide sub-interval:
    // endpoint heights and speeds must include the same gravity half-steps.
    const velocity = session.state?.velocity;
    tickStartSpeedSquared = finiteVector(velocity)
      ? velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z : NaN;
    tickStartHeight = session.state?.position?.z;
    tickGravity = session.config?.gravity;
    tickAirBoundary = tickBoardAmbiguous = false;
    tickBoardSpeedBefore = tickBoardSpeedAfter = 0;
    tickBoardAngleSine = null;
    tickGround = session.state?.grounded === true;
    tickGroundContact = false;
    tickAirGated = false;
    tickReason = tickGround ? 'ground' : 'no-acceleration';
  }

  function acceleration({ before, after, direction, wishSpeed, airborne, config, surfaceFriction }) {
    if (!open) return;
    // Reference passes still observe this transition: begin() may see the
    // grounded state immediately before native movement jumps onto a ramp.
    tickGround = !airborne;
    if (!airborne || referenceOnly) { tickReason = !airborne ? 'ground' : 'no-analysis'; return; }
    if (!airWanted() && !(live() && shown('showSurf'))) {
      tickAirGated = true;
      tickReason = 'hidden';
      return;
    }
    if (!Number.isFinite(wishSpeed) || wishSpeed < 0 || !finiteVector(direction)) {
      tickReason = 'unsupported-physics';
      return;
    }
    if (wishSpeed === 0 || (direction.x === 0 && direction.y === 0)) {
      tickReason = 'no-wish';
      return;
    }
    if (!finiteVector(before) || !finiteVector(after) || direction.z !== 0 ||
      Math.abs(Math.hypot(direction.x, direction.y) - 1) > 2e-6 ||
      !config || !Number.isFinite(config.dt) || config.dt <= 0 ||
      !Number.isFinite(config.airAccelerate) || config.airAccelerate < 0 ||
      !Number.isFinite(config.airCap) || config.airCap < 0 ||
      !Number.isFinite(surfaceFriction) || surfaceFriction < 0) {
      tickReason = 'unsupported-physics';
      return;
    }
    const round = config.float32 ? Math.fround : identity;
    const cap = Math.min(wishSpeed, config.airCap);
    // wishSpeed already includes maxSpeed, analog input and the game's .34
    // duck multiplier. Reconstructing it from keys would silently overestimate.
    const budget = round(round(round(config.airAccelerate * config.dt) * wishSpeed) * surfaceFriction);
    if (!Number.isFinite(budget)) { tickReason = 'unsupported-physics'; return; }
    if (cap <= 0 || budget <= 0) { tickReason = 'no-acceleration'; return; }
    const available = round(cap - round(before.x * direction.x + before.y * direction.y));
    const amount = available <= 0 ? 0 : Math.min(available, budget);
    const expectedX = amount === 0 ? before.x : round(before.x + direction.x * amount);
    const expectedY = amount === 0 ? before.y : round(before.y + direction.y * amount);
    // A changed upstream acceleration implementation is unsupported, not an
    // opportunity loss. Observed output, not a simulated actual gain, is used.
    if (after.x !== expectedX || after.y !== expectedY || after.z !== before.z) {
      tickReason = 'unsupported-physics';
      return;
    }
    let input = accelerationInputs[accelerationCount];
    if (!input) {
      input = { before: { x: 0, y: 0, z: 0 }, after: { x: 0, y: 0, z: 0 },
        cap: 0, budget: 0, float32: false };
      accelerationInputs.push(input);
    }
    accelerationCount++;
    inputBefore = input.before;
    inputAfter = input.after;
    inputBefore.x = before.x;
    inputBefore.y = before.y;
    inputBefore.z = before.z;
    inputAfter.x = after.x;
    inputAfter.y = after.y;
    inputAfter.z = after.z;
    input.cap = inputCap = cap;
    input.budget = inputBudget = budget;
    input.float32 = inputFloat32 = config.float32;
    tickAvailable = true;
    tickReason = 'air';
  }

  function collision({ before, after, contacts, firstContact = 0, blocked, config }) {
    if (!open || tickGround) return;
    if (blocked) {
      tickCrashContact = true;
      tickMixedContact = true;
      tickAirBoundary = true;
      tickBoardAmbiguous = true;
    }
    if (!contacts || firstContact >= contacts.length) return;
    const validEndpoints = finiteVector(before) && finiteVector(after);
    if (!validEndpoints || !Number.isFinite(config?.groundNormal)) {
      tickMixedContact = tickBoardAmbiguous = true;
      if (!Number.isFinite(config?.groundNormal)) return;
    }
    // Native base velocity can be applied between accelerate() and slide().
    // A pressure comparison in a different velocity frame is unsupported.
    if (tickAvailable && (!validEndpoints || before.x !== inputAfter.x || before.y !== inputAfter.y || before.z !== inputAfter.z)) {
      tickAvailable = false;
      tickReason = 'unsupported-surf';
    }
    let ramp = false;
    let other = false;
    for (let i = firstContact; i < contacts.length; i++) {
      const contact = contacts[i];
      const normal = contact.normal;
      const brush = contact.brushId === 'unknown' ? null : contact.brushId ?? null;
      const validNormal = finiteVector(normal) && Math.abs(Math.hypot(normal.x, normal.y, normal.z) - 1) < 1e-4;
      // Native surf planes require 0 < normal.z < groundNormal; retain the existing 1e-4 unit-normal tolerance.
      // Other measured planes or native blocking indicate a crash, not speed loss or unsupported analysis alone.
      if (validNormal && normal.z > 0 && normal.z < config.groundNormal) {
        ramp = true;
        const surface = surfaces?.find(brush, normal) ?? null;
        if (surface === null) tickSurfaceUnknown = true;
        else if (tickSurface === null) tickSurface = surface;
        else if (tickSurface !== surface) tickSurfaceConflict = true;
        tickAirBoundary = true;
        if (tickPlane) {
          // The pressure solver remains stricter than entry geometry: a BSP
          // seam can be a single board without being a supported surf solve.
          if (normal.x !== tickPlane.x || normal.y !== tickPlane.y || normal.z !== tickPlane.z ||
            brush !== tickBrush) tickMultiplePlanes = true;
          if (!sameRampPlane(normal, tickPlane)) tickDifferentNormals = true;
        } else {
          tickPlane = normal;
          tickBrush = brush;
        }
      } else {
        other = true;
        if (validNormal) {
          if (normal.z >= config.groundNormal) tickAirBoundary = tickGroundContact = true;
          else tickCrashContact = true;
        }
      }
    }
    // Remember ramp presence even when this slide cannot provide a clip.
    // Mixed/blocked contact is not a no-ramp airborne separation.
    const firstRampContact = !tickRampContact;
    tickRampContact ||= ramp;
    if (other) tickMixedContact = true;
    tickBoardAmbiguous ||= tickSurfaceConflict ||
      (tickDifferentNormals && (tickSurfaceUnknown || tickSurface === null));
    // Whole-slide hooks cannot separate a ramp clip from a wall/floor clip.
    if (other || blocked || !ramp || !validEndpoints) return;
    const speedBefore = Math.hypot(before.x, before.y, before.z);
    const speedAfter = Math.hypot(after.x, after.y, after.z);
    if (firstRampContact) {
      // Copy the first slide's speeds now: later slides, gravity and mutable
      // native vectors must not change the entry observation.
      tickBoardSpeedBefore = speedBefore;
      tickBoardSpeedAfter = speedAfter;
      tickBoardAngleSine = speedBefore > 0 ? Math.abs(
        before.x * tickPlane.x + before.y * tickPlane.y + before.z * tickPlane.z
      ) / (speedBefore * Math.hypot(tickPlane.x, tickPlane.y, tickPlane.z)) : null;
    }
    // slide excludes acceleration and both gravity half-steps. Full 3D speed
    // ignores harmless horizontal-to-vertical conversion on a slope.
    tickRampLoss += Math.max(0, speedBefore - speedAfter);
  }

  function end(session, command, events = []) {
    if (!open) return;
    // These ticks may contain observations from a movement branch discarded
    // by teleport, fall recovery or a restart. Discard the entire observation.
    if (events.some(event => event === 'teleport' || event === 'fall' ||
      event === 'stage-restarted' || event === 'start-return' || event === 'stage-return' ||
      event === 'restart' || event === 'practice-restore' || event === 'start')) {
      reset();
      status = 'reset';
      return;
    }
    open = false;
    elapsed += duration;
    const nextMode = tickRampContact || tickMixedContact ? 'surf' : 'air';
    if (nextMode === 'surf') {
      if (live() && shown('showSurf')) surfAcceleration();
      else { tickAvailable = false; tickReason = 'surf'; }
    } else if (tickAvailable && !airWanted()) {
      // Live ramp Input still needs air observations; hidden Air needs no optimum.
      tickAvailable = false;
      tickAirGated = true;
      tickReason = 'hidden';
    } else if (tickAvailable) {
      // Contacts classify the completed tick before any horizontal optimum is
      // evaluated. Held ramp ticks never compute an optimum just to discard it.
      for (let i = 0; i < accelerationCount; i++) {
        const input = accelerationInputs[i];
        const beforeSpeed = Math.hypot(input.before.x, input.before.y);
        const afterSpeed = Math.hypot(input.after.x, input.after.y);
        const round = input.float32 ? Math.fround : identity;
        tickGain += afterSpeed - beforeSpeed;
        tickOptimum += optimumSpeed(input.before, input.cap, input.budget, round, afterSpeed) - beforeSpeed;
      }
    }
    const grounded = tickGround || session.state.grounded || tickGroundContact;
    const episodeContact = tickRampContact || tickBoardAmbiguous;
    const surface = tickSurfaceUnknown || tickSurfaceConflict ? null : tickSurface;
    const sameSurface = episodeActive && surface !== null && surface === episodeSurface;
    const ambiguous = tickBoardAmbiguous || tickMixedContact;
    if (unknownRamp) {
      if (grounded || (episodeActive && episodeContact && surface !== null && episodeSurface !== null && !sameSurface && !ambiguous))
        unknownRamp = false;
      else if (episodeContact || tickMixedContact) unknownRampGap = 0;
      else {
        unknownRampGap += duration;
        if (unknownRampGap > SURFACE_CONTACT_GRACE + TIME_EPSILON) unknownRamp = false;
      }
    }
    // A known new surface is a new entry even without free air. A pure
    // unknown contact gets only the short grace; obstructions cannot prove
    // a departure or replace an accepted entry inside its existing grace.
    if (episodeActive && episodeContact &&
      ((surface !== null && episodeSurface !== null && !sameSurface) ||
        (!sameSurface && !ambiguous && airborneGapSeconds > RAMP_CONTACT_GRACE + TIME_EPSILON))) {
      finishSurf();
    }
    if (tickAirBoundary || grounded) {
      if (episodeActive && !grounded && ((sameSurface && tickRampContact) || ambiguous)) {
        airBrakingLoss = airMissedGain = airMeasuredSeconds = airSkippedSeconds = 0;
      } else finishAir(session.state.tick);
    } else if (nextMode === 'air' && tickAvailable) {
      // Only confirmed free air enters the unchanged horizontal comparison.
      airBrakingLoss += Math.max(0, -tickGain);
      airMissedGain += Math.max(0, tickOptimum - Math.max(0, tickGain));
      airMeasuredSeconds += duration;
    } else if (nextMode === 'air' && tickAirGated) airSkippedSeconds += duration;
    // Never mix a free-air optimum with the narrower same-pressure comparison.
    if (nextMode !== mode || !tickAvailable) {
      head = count = 0;
      rollingGain = rollingOptimum = 0;
    }
    mode = nextMode;
    while (rampCount && elapsed - rampTimes[rampHead] >= RAMP_WINDOW_SECONDS) removeRampOldest();
    trimStrafeWindow(strafeWindowSeconds());
    if (tickAvailable) {
      if (count === SAMPLE_CAPACITY) removeOldest();
      const index = (head + count) % SAMPLE_CAPACITY;
      sampleTimes[index] = elapsed;
      sampleGains[index] = tickGain;
      sampleOptima[index] = tickOptimum;
      count++;
      rollingGain += tickGain;
      rollingOptimum += tickOptimum;
      strafeTotal += Math.max(0, tickOptimum - tickGain);
    }
    eligible = tickAvailable;
    status = tickReason;
    // Only completed, unobstructed no-ramp airborne ticks count toward the
    // separation. The returning contact's dt must never inflate that gap.
    // Entry age is simulated time between completed contact steps, with a
    // fixed inclusive 90ms deadline. The tiny epsilon only absorbs arithmetic
    // roundoff at exact 45/90ms boundaries; it is not another contact tick.
    if (episodeActive) episodeSeconds += duration;
    const boarding = episodeContact && !episodeActive;
    // A floor reached after free air is a landing; simultaneous ramp-floor contact is still an obstruction.
    if (episodeActive || boarding) {
      surfCrash ||= tickCrashContact || (tickGroundContact && (tickRampContact || airborneGapSeconds === 0));
    }
    if (episodeContact) {
      if (boarding) {
        episodeActive = true;
        episodeSeconds = 0;
        episodeSurface = surface;
        surfEntrySpeedSquared = tickStartSpeedSquared;
        surfEntryHeight = tickStartHeight;
        surfGravity = tickGravity;
        episodeUnknown = unknownRamp;
        if (surface !== null) surfaceVisits.set(surface, (surfaceVisits.get(surface) ?? 0) + 1);
        if (surface === null || ambiguous) routePrefix = null;
        rampHead = rampCount = 0;
        turnLoss = 0;
        clearBoard();
        if (!ambiguous && !episodeUnknown) {
          boardVersion++;
          board.available = true;
          board.speedBefore = tickBoardSpeedBefore;
          board.speedAfter = tickBoardSpeedAfter;
          // Native clipping removes v·n along the normal, leaving speed × cos α; α is the error because parallel contact loses nothing.
          board.angle = tickBoardAngleSine === null ? null : Math.asin(Math.min(1, tickBoardAngleSine)) * 180 / Math.PI;
          board.loss = Math.max(0, tickBoardSpeedBefore - tickBoardSpeedAfter);
          board.tick = session.state.tick;
          board.sequence++;
          board.entryContacts = 1;
          if (surface !== null) {
            board.surfaceId = surface;
            board.visit = surfaceVisits.get(surface);
            board.checkpoint = session.checkpointSpeeds?.length ?? session.timer?.splits?.length ?? 0;
            if (routePrefix !== null) {
              // Entry-only, bounded route evidence lets late HUD consumers
              // match the actual route without retaining per-tick history.
              if (routeEntries === MAX_ROUTE_ENTRIES) routePrefix = null;
              else {
                const key = `${JSON.stringify([surface, board.checkpoint, board.visit])};`;
                if (routePrefix.length + key.length > MAX_ROUTE_PREFIX_LENGTH) routePrefix = null;
                else {
                  routePrefix += key;
                  routeEntries++;
                }
              }
            }
            board.routePrefix = routePrefix;
          }
          Object.assign(entryPlane, tickPlane);
        }
      } else if (board.available && !ambiguous && airborneGapSeconds > 0 &&
        episodeSeconds <= BOARD_ENTRY_WINDOW_SECONDS + TIME_EPSILON &&
        (sameSurface || sameRampPlane(entryPlane, tickPlane))) {
        // Sum only genuine brief recontact clips, never intervening gravity,
        // acceleration, continuous contact/flicks, or later slides this step.
        board.loss += Math.max(0, tickBoardSpeedBefore - tickBoardSpeedAfter);
        board.speedAfter = tickBoardSpeedAfter;
        board.entryContacts++;
        boardVersion++;
      }
      if (!boarding && tickRampContact && !ambiguous && surface !== episodeSurface) episodeSurface = null;
      if (tickRampContact) {
        surfContactSeconds += duration;
        surfTick = session.state.tick;
        const velocity = session.state.velocity;
        const height = session.state.position?.z;
        if (!heldSurfWanted()) surfSkippedTicks++;
        else if (!ambiguous && !tickMixedContact && finiteVector(velocity) &&
          Number.isFinite(height) && Number.isFinite(tickStartHeight) &&
          Number.isFinite(tickStartSpeedSquared) && Number.isFinite(surfEntrySpeedSquared) &&
          Number.isFinite(surfEntryHeight) && Number.isFinite(surfGravity) && surfGravity >= 0 &&
          tickGravity === surfGravity) {
          surfExitSpeedSquared = velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z;
          surfExitHeight = height;
          surfMeasuredSeconds += duration;
          // The first contact tick seeds the split, so Down always holds the
          // board clip even on a ramp that is only ever climbed.
          if (height < surfLowHeight) {
            surfLowHeight = height;
            surfLowEnergy = surfExitSpeedSquared + 2 * surfGravity * height;
          }
        } else surfUnsupportedTicks++;
      } else if (episodeActive && tickMixedContact) surfUnsupportedTicks++;
      airborneGapSeconds = 0;
    } else if (grounded || tickMixedContact) {
      airborneGapSeconds = 0;
      // A pure ground boundary closes the preceding ramp; it is not a mixed
      // ramp constituent. Ramp+floor contacts were invalidated above.
      if (episodeActive && tickMixedContact && !grounded) surfUnsupportedTicks++;
    } else if (episodeActive) {
      airborneGapSeconds += duration;
      const grace = episodeSurface === null ? RAMP_CONTACT_GRACE : SURFACE_CONTACT_GRACE;
      if (airborneGapSeconds > grace + TIME_EPSILON) finishSurf();
    }
    if (episodeActive && surfCrash && !board.crash) {
      board.crash = true;
      boardVersion++;
    }
    if (grounded) {
      finishSurf();
    }
    if (tickRampContact && !tickMixedContact) {
      if (boarding) {
        if (!ambiguous && !episodeUnknown) entryLoss = tickRampLoss;
      } else {
        if (rampCount === SAMPLE_CAPACITY) removeRampOldest();
        const index = (rampHead + rampCount) % SAMPLE_CAPACITY;
        rampTimes[index] = elapsed;
        rampLosses[index] = tickRampLoss;
        rampCount++;
        turnLoss += tickRampLoss;
      }
      rampTotal += tickRampLoss;
      if (boarding || tickRampLoss > 0) {
        // Raw turn clips retain their rolling simulation half-second, even
        // when a brief recontact also contributes to the retained entry.
        eventLoss = boarding ? tickRampLoss : turnLoss;
        eventKind = boarding ? (ambiguous || episodeUnknown ? 'contact' : 'board') : 'turn';
        eventAt = clock();
        eventSimulationAt = elapsed;
      }
    }
    if (events.includes('finish') || session.timer?.phase === 'finished') {
      finishSurf();
      finishAir(session.state.tick);
    }
    previousSession = session;
    previousState = session.state;
    previousTick = session.state.tick;
  }

  function snapshot(now = clock()) {
    const windowSeconds = strafeWindowSeconds();
    trimStrafeWindow(windowSeconds);
    const available = eligible && count > 0;
    const rampAvailable = now - eventAt <= EVENT_MILLISECONDS &&
      elapsed - eventSimulationAt <= EVENT_MILLISECONDS / 1000;
    return {
      strafe: {
        mode,
        comparison: mode === 'surf' ? 'same-pressure' : 'air-optimum',
        windowSeconds,
        loss: Math.max(0, rollingOptimum - rollingGain),
        gain: rollingGain,
        optimalGain: rollingOptimum,
        efficiency: mode === 'air' && available && rollingOptimum > 0 ? Math.max(0, Math.min(1, rollingGain / rollingOptimum)) : null,
        totalLoss: strafeTotal,
        available,
      },
      ramp: {
        loss: rampAvailable ? (eventKind === 'turn' ? Math.max(0, turnLoss) : eventLoss) : 0,
        entryLoss,
        turnLoss,
        totalLoss: rampTotal,
        kind: rampAvailable ? eventKind : '',
        available: rampAvailable,
        measurement: 'collision',
        windowSeconds: RAMP_WINDOW_SECONDS,
      },
      // Copies keep caller mutation out of retained simulation state. These
      // summaries have no wall-clock expiry; only new events or reset replace them.
      board: { ...board },
      air: { ...air },
      surf: { ...surf },
      // false while every movement value is hidden: mode is then unknown.
      active: !idle,
      status,
    };
  }

  // Replay checkpoints are taken between completed steps. Only persistent
  // analysis belongs here: native vectors, contact payloads and solver scratch
  // are borrowed/rebuilt by begin(), and map geometry remains shared.
  function saveState() {
    if (open) throw new Error('Cannot checkpoint an unfinished metrics tick');
    return {
      sampleTimes: sampleTimes.slice(), sampleGains: sampleGains.slice(), sampleOptima: sampleOptima.slice(),
      rampTimes: rampTimes.slice(), rampLosses: rampLosses.slice(),
      head, count, rampHead, rampCount, mode, rollingGain, rollingOptimum, strafeTotal, rampTotal,
      elapsed, eligible, status, idle, previousSession, previousTick,
      episodeActive, episodeSeconds, airborneGapSeconds, episodeSurface,
      surfEntrySpeedSquared, surfEntryHeight, surfExitSpeedSquared, surfExitHeight, surfGravity,
      surfContactSeconds, surfMeasuredSeconds, surfUnsupportedTicks, surfSkippedTicks, surfCrash,
      surfLowHeight, surfLowEnergy, surfTick,
      unknownAir, unknownRamp, unknownRampGap, episodeUnknown,
      entryPlane: { ...entryPlane }, surfaceVisits: new Map(surfaceVisits), routePrefix, routeEntries,
      airBrakingLoss, airMissedGain, airMeasuredSeconds, airSkippedSeconds,
      board: { ...board }, boardVersion, air: { ...air }, surf: { ...surf },
      entryLoss, turnLoss, eventLoss, eventKind, eventSimulationAt, eventAge: clock() - eventAt,
    };
  }

  function restoreState(saved) {
    sampleTimes.set(saved.sampleTimes);
    sampleGains.set(saved.sampleGains);
    sampleOptima.set(saved.sampleOptima);
    rampTimes.set(saved.rampTimes);
    rampLosses.set(saved.rampLosses);
    ({
      head, count, rampHead, rampCount, mode, rollingGain, rollingOptimum, strafeTotal, rampTotal,
      elapsed, eligible, status, idle, previousSession, previousTick,
      episodeActive, episodeSeconds, airborneGapSeconds, episodeSurface,
      surfEntrySpeedSquared, surfEntryHeight, surfExitSpeedSquared, surfExitHeight, surfGravity,
      surfContactSeconds, surfMeasuredSeconds, surfUnsupportedTicks, surfSkippedTicks, surfCrash,
      surfLowHeight, surfLowEnergy, surfTick, routePrefix, routeEntries,
      unknownAir, unknownRamp, unknownRampGap, episodeUnknown,
      airBrakingLoss, airMissedGain, airMeasuredSeconds, airSkippedSeconds,
      boardVersion, entryLoss, turnLoss, eventLoss, eventKind, eventSimulationAt,
    } = saved);
    Object.assign(entryPlane, saved.entryPlane);
    Object.assign(board, saved.board);
    Object.assign(air, saved.air);
    Object.assign(surf, saved.surf);
    surfaceVisits.clear();
    for (const [surface, visits] of saved.surfaceVisits) surfaceVisits.set(surface, visits);
    // Native thaw replaces state, but not the watched Session. Rebind this
    // continuity guard or the next begin() would discard the restored episode.
    previousState = previousSession?.state ?? null;
    eventAt = clock() - saved.eventAge;
    open = false;
    accelerationCount = 0;
  }

  const boardSnapshot = () => ({...board});
  const boardRevision = () => boardVersion;
  // Reference reconstruction reads completed Surf visits only, not per-tick copies.
  const surfSnapshot = sequence => surf.sequence !== sequence ? {...surf} : null;
  return { begin, acceleration, collision, end, reset, snapshot, boardSnapshot, boardRevision, surfSnapshot, saveState, restoreState };
}
