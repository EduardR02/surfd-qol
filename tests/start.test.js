import { describe, expect, test } from 'bun:test';
import { createStartFeedback } from '../src/start.js';

const zone = { id: 'start', kind: 'start', min: { x: -100, y: -100, z: 100 }, max: { x: 100, y: 100, z: 200 } };

function scene({ ducked = false, exitHeight = 100, floorHeight = 100, platformEdge = 100 } = {}) {
  return {
    state: { tick: 11, ducked, grounded: false, position: { x: 122, y: 0, z: exitHeight }, velocity: { x: 350, y: 0, z: -100 } },
    config: { dt: 0.015, standHeight: 62, duckHeight: 45, stepSize: 18, groundNormal: 0.7, unrestrictedStart: false },
    timer: { state: { startTick: 10.5 }, startSpeedCap: () => 350 },
    map: { zones: [zone] },
    movement: { world: {
      // A finite horizontal platform, swept against the supplied foot box.
      trace(from, to, hull) {
        if (from.x + hull.min.x >= platformEdge || from.z < floorHeight || to.z >= floorHeight) {
          return { fraction: 1, end: to, normal: { x: 0, y: 0, z: 0 } };
        }
        const fraction = (from.z - floorHeight) / (from.z - to.z);
        return { fraction, end: { x: from.x, y: from.y, z: from.z + fraction * (to.z - from.z) }, normal: { x: 0, y: 0, z: 1 } };
      }
    } },
    lastResult: { segments: [{ from: { x: 110, y: 0, z: exitHeight }, to: { x: 122, y: 0, z: exitHeight }, startFraction: 0, endFraction: 1 }] }
  };
}

describe('start platform height', () => {
  test('walking off reads zero with either hull, not plus duck or stand height', () => {
    for (const ducked of [false, true]) {
      const feedback = createStartFeedback();
      feedback.observe(scene({ ducked }), ['start']);
      expect(feedback.snapshot()).toMatchObject({ exitHeight: 100, floorHeight: 100, heightAboveFloor: 0 });
    }
  });

  test('a platform above the trigger bottom is still the zero-height reference', () => {
    const feedback = createStartFeedback();
    feedback.observe(scene({ floorHeight: 150, exitHeight: 150 }), ['start']);
    expect(feedback.snapshot().heightAboveFloor).toBe(0);
    feedback.observe(scene({ floorHeight: 150, exitHeight: 180 }), ['start']);
    expect(feedback.snapshot().heightAboveFloor).toBe(30);
  });

  test('uses the fractional crossing rather than the end-of-tick height', () => {
    const feedback = createStartFeedback();
    const session = scene({ exitHeight: 160 });
    session.lastResult.segments[0].from.z = 180;
    feedback.observe(session, ['start']);
    expect(feedback.snapshot()).toMatchObject({ available: true, speed: 350, speedDelta: 0, exitHeight: 170, floorHeight: 100, heightAboveFloor: 70, age: 0 });
    session.state.tick += 10;
    expect(feedback.snapshot().age).toBeCloseTo(150, 6);
    feedback.observe(session, ['fall']);
    expect(feedback.snapshot().available).toBe(false);
  });

  test('an airborne exit beyond the ledge retains its actual takeoff platform reference', () => {
    const feedback = createStartFeedback();
    const session = scene({ platformEdge: 80, exitHeight: 90 });
    session.state.grounded = true;
    session.state.position = { x: 0, y: 0, z: 100 };
    feedback.observe(session, []);
    session.state.grounded = false;
    session.state.position = { x: 122, y: 0, z: 90 };
    feedback.observe(session, ['start']);
    expect(feedback.snapshot()).toMatchObject({ floorHeight: 100, heightAboveFloor: -10 });
    feedback.reset();
    feedback.observe(session, ['start']);
    expect(feedback.snapshot().heightAboveFloor).toBeNull();
  });

  test('missing solid geometry is unknown rather than a fabricated trigger-bottom height', () => {
    const feedback = createStartFeedback();
    const session = scene();
    delete session.movement;
    feedback.observe(session, ['start']);
    expect(feedback.snapshot()).toMatchObject({ available: true, floorHeight: null, heightAboveFloor: null });
  });

  test('checkpoints retain takeoff support and restore independent start feedback with its age', () => {
    const feedback = createStartFeedback();
    const session = scene({ platformEdge: 80, exitHeight: 90 });
    session.state.grounded = true;
    session.state.position = { x: 0, y: 0, z: 100 };
    feedback.observe(session, []);
    const grounded = feedback.saveState();
    expect(grounded.ground.zone).toBe(zone);
    expect(grounded.sessionIdentity).toBe(session);
    feedback.reset();
    feedback.restoreState(grounded);
    session.state.grounded = false;
    session.state.position = { x: 122, y: 0, z: 90 };
    feedback.observe(session, ['start']);
    session.state.tick += 2;
    const started = feedback.saveState();
    expect(feedback.snapshot()).toMatchObject({floorHeight: 100, heightAboveFloor: -10, age: 30});
    feedback.observe(session, ['fall']);
    feedback.restoreState(started);
    expect(feedback.snapshot()).toMatchObject({available: true, floorHeight: 100, heightAboveFloor: -10, age: 30});
    feedback.observe(session, ['start']);
    feedback.restoreState(started);
    expect(feedback.snapshot().age).toBe(30);
    expect(started.latest.tick).toBe(11);
    feedback.observe(scene(), []);
    expect(feedback.snapshot().available).toBe(false);
  });

  test('a seek shows the start only when the replay is at it: never as if the run just began', () => {
    const feedback = createStartFeedback();
    const session = scene();
    // Re-simulating through the start zone exit, then on to a moment 3 s later.
    feedback.observe(session, ['start']);
    session.state.tick += 200;
    expect(feedback.snapshot().age).toBeCloseTo(3000, 6);
    // Back before the exit (a restored session): nothing to show.
    session.state.tick = 5;
    expect(feedback.snapshot()).toEqual({available: false});
  });

  test('landing back in the zone after the one jump it allows marks the start clipped', () => {
    const feedback = createStartFeedback();
    const session = scene();
    const at = (grounded, x, startJumps, events = []) => {
      Object.assign(session.state, { grounded, position: { x, y: 0, z: 100 } });
      session.startJumps = startJumps;
      feedback.observe(session, events);
    };
    // Prestrafe, jump, land short of the edge, then leave on the ground.
    at(true, 0, 0); at(false, 40, 1); at(true, 80, 1); at(true, 122, 1, ['start']);
    expect(feedback.snapshot()).toMatchObject({ available: true, clipped: true });
    // A restart gives the jump back: jumping clear of the zone is a clean start.
    at(true, 0, 0, ['restart']); at(false, 60, 1); at(false, 122, 1, ['start']);
    expect(feedback.snapshot().clipped).toBe(false);
    // Standing still after landing back also gives it back, and a fresh attempt.
    at(false, 40, 1); at(true, 50, 1); at(true, 50, 0); at(false, 90, 1); at(false, 122, 1, ['start']);
    expect(feedback.snapshot().clipped).toBe(false);
    // Unrestricted starts allow prehops: landing in the zone is part of them.
    session.config.unrestrictedStart = true;
    at(false, 40, 3); at(true, 80, 3); at(false, 122, 4, ['start']);
    expect(feedback.snapshot().clipped).toBe(false);
  });

  test('an empty start checkpoint clears later feedback', () => {
    const feedback = createStartFeedback();
    const empty = feedback.saveState();
    feedback.observe(scene(), ['start']);
    expect(feedback.snapshot().available).toBe(true);
    feedback.restoreState(empty);
    expect(feedback.snapshot()).toEqual({available: false});

    feedback.observe(scene(), ['start']);
    feedback.reset();
    expect(feedback.saveState().sessionIdentity).toBeNull();
    expect(feedback.snapshot()).toEqual({available: false});
  });
});
