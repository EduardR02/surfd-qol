import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics } from '../src/metrics.js';
import { observePhysics } from '../src/observer.js';

const config = Object.freeze({ dt: 0.015, gravity: 800, airAccelerate: 150, airCap: 30, groundNormal: 0.7, float32: false });
const vector = (x = 0, y = 0, z = 0) => ({ x, y, z });
const rampNormal = Object.freeze(vector(0, 0.8, 0.6));
const rampContact = Object.freeze({ normal: rampNormal, brushId: 'ramp-a' });

function close(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (tolerance ${tolerance})`);
}

// Independent transcription of the observed Source accelerate operation, not
// the optimizer. Tests pass its result as the real before/after observation.
function sample({ before = vector(1000), direction = vector(1), wishSpeed = 260,
  airborne = true, physics = config, surfaceFriction = 1 } = {}) {
  const round = physics.float32 ? Math.fround : value => value;
  const cap = airborne ? Math.min(wishSpeed, physics.airCap) : wishSpeed;
  const available = round(cap - round(before.x * direction.x + before.y * direction.y + before.z * direction.z));
  const budget = round(round(round((airborne ? physics.airAccelerate : 5) * physics.dt) * wishSpeed) * surfaceFriction);
  const amount = available > 0 ? Math.min(available, budget) : 0;
  const after = amount > 0 ? vector(round(before.x + direction.x * amount),
    round(before.y + direction.y * amount), round(before.z + direction.z * amount)) : { ...before };
  return { before, after, direction, wishSpeed, airborne, config: physics, surfaceFriction };
}

function session(physics = config) {
  return { config: physics, state: { tick: 0, grounded: false, velocity: vector(1000), position: vector() } };
}

function tick(metrics, game, acceleration, collision, events = []) {
  if (acceleration) game.state.velocity = {...acceleration.before};
  metrics.begin(game, {});
  if (acceleration) metrics.acceleration(acceleration);
  if (collision) metrics.collision(collision);
  if (collision || acceleration) game.state.velocity = {...(collision?.after ?? acceleration.after)};
  game.state.tick++;
  metrics.end(game, {}, events);
  return metrics.snapshot();
}

function clip(before, after, contacts = [rampContact]) {
  return { before, after, contacts, config };
}

const curveNormal = Object.freeze(vector(0, 0.9, Math.sqrt(0.19)));
const curveContact = Object.freeze({ normal: curveNormal, brushId: 'ramp-b' });
const separateContact = Object.freeze({ normal: rampNormal, brushId: 'ramp-c' });
// Two facets share a real edge; the third is coplanar but spatially separate.
const rampMap = {
  brushes: [
    { id: 'ramp-a', vertices: [vector(), vector(10), vector(0, -6, 8)],
      faces: [[0, 1, 2]], planes: [{ normal: rampNormal, distance: 0 }] },
    { id: 'ramp-b', vertices: [vector(10), vector(), vector(0, Math.sqrt(0.19) * 10, -9)],
      faces: [[0, 1, 2]], planes: [{ normal: curveNormal, distance: 0 }] },
    { id: 'ramp-c', vertices: [vector(100), vector(110), vector(100, -6, 8)],
      faces: [[0, 1, 2]], planes: [{ normal: rampNormal, distance: 0 }] },
  ],
};

function mappedSession(physics = { ...config }) {
  return { ...session(physics), map: rampMap, checkpointSpeeds: [] };
}

function coastContact(metrics, game, { before = vector(1000), after = vector(990),
  contacts = [rampContact], events = [] } = {}) {
  const input = sample({ before, wishSpeed: 0, direction: vector(), physics: game.config });
  return tick(metrics, game, input, { before: input.after, after, contacts, config: game.config }, events);
}

function leaveRamp(metrics, game) {
  let result;
  const steps = Math.ceil(0.251 / game.config.dt);
  for (let i = 0; i < steps; i++) result = tick(metrics, game);
  return result;
}

function endpointContact(metrics, game, velocity, height = game.state.position.z, contacts = [rampContact]) {
  metrics.begin(game);
  metrics.collision(clip(game.state.velocity, velocity, contacts));
  game.state.velocity = {...velocity};
  game.state.position.z = height;
  game.state.tick++;
  metrics.end(game);
  return metrics.snapshot();
}

test('blocked forward air input measures missed local gain, not horizontal speed loss', () => {
  const result = tick(createMetrics(), session(), sample());
  const optimum = Math.hypot(1000, 30) - 1000;
  assert.equal(result.strafe.available, true);
  close(result.strafe.gain, 0);
  close(result.strafe.loss, optimum);
  close(result.strafe.optimalGain, optimum);
  close(result.strafe.efficiency, 0);
  assert.equal(result.ramp.available, false);
});

test('perpendicular high-acceleration strafe reaches the one-tick maximum', () => {
  const result = tick(createMetrics(), session(), sample({ direction: vector(0, 1) }));
  close(result.strafe.loss, 0);
  close(result.strafe.gain, Math.hypot(1000, 30) - 1000);
  close(result.strafe.efficiency, 1);
});

test('acceleration-limited optimum is the cap transition, not perpendicular', () => {
  const physics = { ...config, dt: 0.1, airAccelerate: 1 };
  const direction = vector(0.2, Math.sqrt(0.96));
  const result = tick(createMetrics(), session(physics), sample({
    physics, before: vector(100), wishSpeed: 100, direction,
  }));
  close(result.strafe.loss, 0);
  close(result.strafe.optimalGain, Math.sqrt(10500) - 100);
});

test('starting from rest and below the optimum projection favors forward acceleration', () => {
  const physics = { ...config, dt: 0.1, airAccelerate: 1 };
  for (const speed of [0, 5]) {
    const result = tick(createMetrics(), session(physics), sample({ physics, before: vector(speed), wishSpeed: 100 }));
    close(result.strafe.gain, 10);
    close(result.strafe.optimalGain, 10);
    close(result.strafe.loss, 0);
  }
});

test('reversing loses actual speed as well as missing the available gain', () => {
  const result = tick(createMetrics(), session(), sample({ before: vector(100), direction: vector(-1) }));
  close(result.strafe.gain, -70);
  close(result.strafe.optimalGain, Math.hypot(100, 30) - 100);
  close(result.strafe.loss, Math.hypot(100, 30) - 30);
  assert.equal(result.strafe.efficiency, 0);
});

test('actual duck/analog wish speed and surface friction determine acceleration budget', () => {
  const physics = { ...config, airAccelerate: 1 };
  for (const wishSpeed of [260 * 0.34, 8]) {
    for (const surfaceFriction of [1, 0.25]) {
      const result = tick(createMetrics(), session(physics), sample({ physics, wishSpeed, surfaceFriction }));
      const budget = physics.airAccelerate * physics.dt * wishSpeed * surfaceFriction;
      const cap = Math.min(wishSpeed, physics.airCap);
      close(result.strafe.loss, Math.sqrt(1000 ** 2 + 2 * budget * cap - budget ** 2) - 1000);
    }
  }
});

test('float32 measurements use observed gains and agree with a dense independent angular oracle', () => {
  const physics = { ...config, dt: Math.fround(0.015), float32: true };
  for (const airAccelerate of [1, 150]) {
    for (const surfaceFriction of [0.2, 1]) {
      const current = { ...physics, airAccelerate };
      const before = vector(Math.fround(2134.125), Math.fround(-789.6875), Math.fround(123.25));
      const actual = sample({ physics: current, before, direction: vector(Math.fround(0.6), Math.fround(0.8)),
        wishSpeed: Math.fround(260 * 0.34), surfaceFriction });
      const result = tick(createMetrics(), session(current), actual);
      const speed = Math.hypot(before.x, before.y);
      let oracle = -Infinity;
      for (let i = 0; i < 16384; i++) {
        const angle = i * 2 * Math.PI / 16384;
        const candidate = sample({ physics: current, before,
          direction: vector(Math.fround(Math.cos(angle)), Math.fround(Math.sin(angle))),
          wishSpeed: actual.wishSpeed, surfaceFriction });
        oracle = Math.max(oracle, Math.hypot(candidate.after.x, candidate.after.y) - speed);
      }
      assert.equal(result.strafe.available, true);
      close(result.strafe.gain, Math.hypot(actual.after.x, actual.after.y) - speed);
      assert.ok(result.strafe.loss >= 0);
      // A float32 lattice is not a continuous angular optimizer. Its last-bit
      // differences, and the test oracle's spacing, are below displayed units.
      close(result.strafe.optimalGain, oracle, 0.001);
    }
  }
});

test('vertical velocity and gravity do not enter horizontal strafe opportunity', () => {
  const metrics = createMetrics();
  const a = tick(metrics, session(), sample({ before: vector(1000, 0, -4000) })).strafe;
  metrics.reset();
  const b = tick(metrics, session(), sample({ before: vector(1000, 0, 4000) })).strafe;
  assert.deepEqual(a, b);
});

test('ground, no wish and zero acceleration are excluded, not counted as bad strafing', () => {
  for (const [input, status] of [
    [sample({ airborne: false }), 'ground'],
    [sample({ wishSpeed: 0, direction: vector() }), 'no-wish'],
    [sample({ surfaceFriction: 0 }), 'no-acceleration'],
  ]) {
    const result = tick(createMetrics(), session(), input);
    assert.equal(result.status, status);
    assert.equal(result.strafe.available, false);
    assert.equal(result.strafe.efficiency, null);
    assert.equal(result.strafe.totalLoss, 0);
  }
});

test('unexpected physics output and nonhorizontal wishes are not silently attributed to strafing', () => {
  const input = sample();
  input.after.x += 1;
  const result = tick(createMetrics(), session(), input);
  assert.equal(result.status, 'unsupported-physics');
  assert.equal(result.strafe.available, false);
  const vertical = tick(createMetrics(), session(), sample({ direction: vector(0, 0, 1) }));
  assert.equal(vertical.strafe.available, false);
});

test('rolling loss expires after half a simulation second while total loss persists', () => {
  const metrics = createMetrics({ strafeLookbackSeconds: 0.5 });
  const game = session();
  const first = tick(metrics, game, sample()).strafe.loss;
  let result;
  for (let i = 1; i < 300; i++) result = tick(metrics, game, sample());
  close(result.strafe.loss, first * 34, 1e-7);
  close(result.strafe.totalLoss, first * 300, 1e-7);
  for (let i = 0; i < 35; i++) result = tick(metrics, game);
  assert.equal(result.strafe.available, false);
  close(result.strafe.loss, 0);
  close(result.strafe.totalLoss, first * 300, 1e-7);
});

test('ramp boarding measures full 3D clipping loss and separates subsequent turn loss', () => {
  const metrics = createMetrics();
  const game = session();
  const first = clip(vector(1000, 0, -300), vector(1000, 144, -192));
  const entry = Math.hypot(1000, 0, -300) - Math.hypot(1000, 144, -192);
  let result = tick(metrics, game, undefined, first);
  assert.equal(result.ramp.available, true);
  assert.equal(result.ramp.kind, 'board');
  close(result.ramp.entryLoss, entry);
  close(result.ramp.loss, entry);
  result = tick(metrics, game, undefined, clip(vector(1000, -100, -100), vector(1000, 12, -16)));
  const turn = Math.hypot(1000, -100, -100) - Math.hypot(1000, 12, -16);
  assert.equal(result.ramp.kind, 'turn');
  close(result.ramp.entryLoss, entry);
  close(result.ramp.turnLoss, turn);
  close(result.ramp.loss, turn);
  close(result.ramp.totalLoss, entry + turn);
});

test('slope conversion and increasing 3D speed are not counted as collision loss', () => {
  for (const after of [vector(800, 0, 600), vector(800, 0, 700)]) {
    const result = tick(createMetrics(), session(), undefined, clip(vector(1000), after));
    assert.equal(result.ramp.kind, 'board');
    close(result.ramp.loss, 0);
    close(result.ramp.totalLoss, 0);
  }
});

test('normals, not airborne alone, identify ramp contacts; mixed contacts are excluded', () => {
  for (const contacts of [
    [],
    [{ normal: vector(0, 0, 1) }],
    [{ normal: vector(1, 0, 0) }],
    [{ normal: vector(0, 0, -1) }],
    [{ normal: vector(0, 0, 0.5) }],
    [rampContact, { normal: vector(1, 0, 0) }],
  ]) {
    const result = tick(createMetrics(), session(), undefined, clip(vector(1000), vector(500), contacts));
    assert.equal(result.ramp.available, false);
    close(result.ramp.totalLoss, 0);
  }
  const game = session();
  game.state.grounded = true;
  const result = tick(createMetrics(), game, undefined, clip(vector(1000), vector(500)));
  assert.equal(result.ramp.available, false);
});

test('airborne jumping from a grounded tick still admits ramp collision observations', () => {
  const game = session();
  game.state.grounded = true;
  const result = tick(createMetrics(), game, sample(), clip(vector(1000), vector(900)));
  assert.equal(result.ramp.kind, 'board');
  close(result.ramp.loss, 100);
});

test('brief contact gaps preserve a ramp turn, but free flight produces a new boarding', () => {
  const metrics = createMetrics();
  const game = session();
  const impact = clip(vector(1000), vector(900));
  tick(metrics, game, undefined, impact);
  tick(metrics, game);
  const turn = tick(metrics, game, undefined, impact);
  assert.equal(turn.ramp.kind, 'turn');
  for (let i = 0; i < 4; i++) tick(metrics, game);
  const board = tick(metrics, game, undefined, impact);
  assert.equal(board.ramp.kind, 'board');
  close(board.ramp.turnLoss, 0);
  close(board.ramp.totalLoss, 300);
});

test('recent ramp feedback expires without erasing the measured run total', () => {
  const metrics = createMetrics();
  tick(metrics, session(), undefined, clip(vector(1000), vector(900)));
  const expired = metrics.snapshot(performance.now() + 2000);
  assert.equal(expired.ramp.available, false);
  assert.equal(expired.ramp.kind, '');
  assert.equal(expired.ramp.loss, 0);
  close(expired.ramp.totalLoss, 100);
});

test('teleport, fall, run return and practice restore discard even in-flight observations', () => {
  for (const event of ['teleport', 'fall', 'stage-restarted', 'start-return', 'stage-return', 'restart', 'practice-restore']) {
    const metrics = createMetrics();
    const game = session();
    tick(metrics, game, sample(), clip(vector(1000), vector(900)));
    const result = tick(metrics, game, sample(), clip(vector(1000), vector(800)), [event]);
    assert.equal(result.status, 'reset');
    assert.equal(result.strafe.available, false);
    assert.equal(result.ramp.available, false);
    assert.equal(result.strafe.totalLoss, 0);
    assert.equal(result.ramp.totalLoss, 0);
  }
});

test('state replacement, session replacement and tick discontinuities clear stale statistics', () => {
  for (const change of [
    game => { game.state = { ...game.state }; return game; },
    game => { game.state.tick = 0; return game; },
    game => { game.state.tick += 10; return game; },
    () => session(),
  ]) {
    const metrics = createMetrics();
    let game = session();
    tick(metrics, game, sample(), clip(vector(1000), vector(900)));
    game = change(game);
    const result = tick(metrics, game);
    assert.equal(result.strafe.totalLoss, 0);
    assert.equal(result.ramp.totalLoss, 0);
    assert.equal(result.ramp.available, false);
  }
});

test('explicit reset clears histories and detached observations cannot pollute a later tick', () => {
  const metrics = createMetrics();
  const game = session();
  tick(metrics, game, sample(), clip(vector(1000), vector(900)));
  metrics.reset();
  metrics.acceleration(sample());
  metrics.collision(clip(vector(1000), vector(500)));
  const result = tick(metrics, game);
  assert.equal(result.strafe.totalLoss, 0);
  assert.equal(result.ramp.totalLoss, 0);
});

test('analysis never mutates inputs and returned snapshots do not expose internal state', () => {
  const metrics = createMetrics();
  const game = session();
  const input = sample();
  Object.freeze(input.before);
  Object.freeze(input.after);
  Object.freeze(input.direction);
  Object.freeze(input);
  const collision = Object.freeze(clip(Object.freeze(vector(1000)), Object.freeze(vector(900)), Object.freeze([rampContact])));
  const expected = structuredClone({ input, collision });
  const result = tick(metrics, game, input, collision);
  assert.deepEqual({ input, collision }, expected);
  result.strafe.totalLoss = -1;
  result.ramp.totalLoss = -1;
  assert.equal(metrics.snapshot().strafe.totalLoss, 0);
  assert.equal(metrics.snapshot().ramp.totalLoss, 100);
});

test('tangent ramp holding is compared at the same pressure, not to free air', () => {
  const input = sample({ before: vector(1000, 120, -160), direction: vector(0, -1) });
  const result = tick(createMetrics({continuousFeedback:true}), session(), input,
    clip(input.after, vector(1000, 66, -88)));
  // v dot n was zero before acceleration. Holding into the ramp reduces
  // horizontal speed, but reflecting the contour component changes nothing.
  assert.ok(Math.hypot(input.after.x, input.after.y) < Math.hypot(input.before.x, input.before.y));
  assert.equal(result.status, 'surf');
  assert.equal(result.strafe.mode, 'surf');
  assert.equal(result.strafe.comparison, 'same-pressure');
  assert.equal(result.strafe.available, true);
  assert.equal(result.strafe.efficiency, null);
  close(result.strafe.loss, 0);
  assert.ok(result.ramp.loss > 0);
  assert.equal(result.ramp.measurement, 'collision');
});

test('bad along-contour braking still loses speed against a feasible same-pressure input', () => {
  const input = sample({ before: vector(100), direction: vector(-1) });
  const result = tick(createMetrics({continuousFeedback:true}), session(), input, clip(input.after, input.after));
  // Both wishes have zero normal pressure. The opposite wish is capped (no
  // acceleration); the observed reverse input destroys 70 units of speed.
  assert.equal(result.status, 'surf');
  close(result.strafe.loss, 70);
  close(result.strafe.gain, -70);
  close(result.strafe.optimalGain, 0);
});

test('Cannonball imported record tick 1035 receives a constrained rather than free-air comparison', () => {
  // Captured from /replays/cannonball-complete.json (format 7) using native
  // game-nzhJsY4N.js Session.step, not the Surfd leaderboard rank-one run.
  const physics = { ...config, dt: Math.fround(0.015), float32: true };
  const input = {
    before: vector(-2276.010986328125, -1877.3787841796875, -976.9261474609375),
    after: vector(-2117.8525390625, -2044.5821533203125, -976.9261474609375),
    direction: vector(0.6871841549873352, -0.7264832258224487),
    wishSpeed: 260, airborne: true, config: physics, surfaceFriction: 1,
  };
  const contact = {
    normal: vector(-0.6139499545097351, 0.3922457993030548, 0.6849880814552307),
    brushId: 'bsp-0-792',
  };
  const result = tick(createMetrics({continuousFeedback:true}), session(physics), input, {
    before: input.after,
    after: vector(-2222.7802734375, -1977.544921875, -859.8575439453125),
    contacts: [contact], config: physics,
  });
  assert.equal(result.status, 'surf');
  assert.equal(result.strafe.mode, 'surf');
  assert.equal(result.strafe.comparison, 'same-pressure');
  assert.equal(result.strafe.available, true);
  assert.ok(Number.isFinite(result.strafe.loss) && result.strafe.loss >= 0);
  close(result.strafe.totalLoss, result.strafe.loss);
  // The real clip stays visible, but is not proof of an avoidable mistake.
  close(result.ramp.loss, 4.712291435371753);
  assert.equal(result.ramp.measurement, 'collision');
});

test('changing from free air to surf does not carry an unrelated optimum into ramp feedback', () => {
  const metrics = createMetrics({continuousFeedback:true});
  const game = session();
  assert.ok(tick(metrics, game, sample()).strafe.loss > 0);
  const input = sample({ before: vector(1000, 120, -160), direction: vector(0, -1) });
  const result = tick(metrics, game, input, clip(input.after, vector(1000, 66, -88)));
  close(result.strafe.loss, 0);
  assert.ok(result.strafe.totalLoss > 0);
});

test('a rapid long ramp keeps only half a simulated second of turn loss', () => {
  const metrics = createMetrics();
  const game = session();
  const impact = clip(vector(1000), vector(999));
  let result;
  for (let i = 0; i < 2000; i++) result = tick(metrics, game, undefined, impact);
  assert.equal(result.ramp.kind, 'turn');
  close(result.ramp.entryLoss, 1);
  close(result.ramp.loss, 34);
  close(result.ramp.turnLoss, 34);
  close(result.ramp.totalLoss, 2000);
  assert.equal(result.ramp.windowSeconds, 0.5);
  for (let i = 0; i < 35; i++) result = tick(metrics, game);
  close(result.ramp.loss, 0);
  close(result.ramp.turnLoss, 0);
  for (let i = 0; i < 75; i++) result = tick(metrics, game);
  assert.equal(result.ramp.available, false);
  close(result.ramp.totalLoss, 2000);
});

test('a different brush during continuous contact remains turn loss, not a new board', () => {
  const metrics = createMetrics();
  const game = session();
  tick(metrics, game, undefined, clip(vector(1000), vector(990)));
  tick(metrics, game, undefined, clip(vector(990), vector(985)));
  const result = tick(metrics, game, undefined,
    clip(vector(985), vector(965), [{ normal: rampNormal, brushId: 'ramp-b' }]));
  assert.equal(result.ramp.kind, 'turn');
  close(result.ramp.entryLoss, 10);
  close(result.ramp.turnLoss, 25);
  close(result.board.loss, 10);
  assert.equal(result.board.sequence, 1);
  close(result.ramp.totalLoss, 35);
});

test('multiple ramp planes preserve measured contact loss without inventing a board or strafe optimum', () => {
  const contacts = [rampContact, { normal: vector(0.8, 0, 0.6), brushId: 'ramp-b' }];
  const result = tick(createMetrics({continuousFeedback:true}), session(), sample(), clip(vector(1000), vector(900), contacts));
  assert.equal(result.status, 'unsupported-surf');
  assert.equal(result.strafe.available, false);
  assert.equal(result.ramp.kind, 'contact');
  close(result.ramp.loss, 100);
  close(result.ramp.entryLoss, 0);
});

test('native gravity after slide is not included in a ramp collision measurement', () => {
  const metrics = createMetrics();
  const game = session();
  const before = vector(1000, 0, -300);
  const after = vector(1000, 144, -192);
  metrics.begin(game);
  metrics.collision(clip(before, after));
  // Native movement applies its second half-gravity update after slide.
  after.z -= 6;
  game.state.tick++;
  metrics.end(game);
  close(metrics.snapshot().ramp.loss,
    Math.hypot(1000, 0, -300) - Math.hypot(1000, 144, -192));
});

test('a single ramp plane identifies an entry even without brush identity', () => {
  const result = tick(createMetrics(), session(), undefined,
    clip(vector(1000), vector(950), [{ normal: rampNormal, brushId: 'unknown' }]));
  assert.equal(result.ramp.kind, 'board');
  close(result.ramp.loss, 50);
  close(result.ramp.entryLoss, 50);
  assert.equal(result.board.available, true);
});

test('Cannonball largest observed pure-ramp clip stays a measured entry, not a grade', () => {
  // Native imported-route tick 4762; the ~50+ readings came from later
  // accumulated contacts, not a single 50-unit entry in this replay.
  const result = tick(createMetrics(), session(), undefined, clip(
    vector(209.80941772460938, 3684.636474609375, -791.0997314453125),
    vector(493.37677001953125, 3684.636474609375, -524.2128295898438),
    [{ normal: vector(0.7281999588012695, 0, 0.6853646636009216), brushId: 'bsp-0-1038' }],
  ));
  assert.equal(result.ramp.kind, 'board');
  assert.equal(result.ramp.measurement, 'collision');
  close(result.ramp.entryLoss, 20.14135655115706);
  close(result.ramp.loss, result.ramp.entryLoss);
});

test('all-solid slides cannot turn an unexecuted free-air optimum into strafe feedback', () => {
  const input = sample();
  const result = tick(createMetrics({continuousFeedback:true}), session(), input,
    { ...clip(input.after, vector(), []), blocked: true });
  assert.equal(result.status, 'unsupported-surf');
  assert.equal(result.strafe.available, false);
  close(result.strafe.totalLoss, 0);
  assert.equal(result.ramp.available, false);
});

test('a velocity-frame change between acceleration and slide disables the local surf comparison', () => {
  const input = sample({ before: vector(100), direction: vector(-1) });
  const result = tick(createMetrics({continuousFeedback:true}), session(), input,
    clip(vector(input.after.x + 200), vector(input.after.x + 200)));
  assert.equal(result.status, 'unsupported-surf');
  assert.equal(result.strafe.available, false);
  close(result.strafe.totalLoss, 0);
  assert.equal(result.ramp.measurement, 'collision');
});

test('strafe feedback defaults to a shorter 0.2-second simulation window without changing ramp history', () => {
  const metrics = createMetrics();
  const game = session();
  const first = tick(metrics, game, sample()).strafe.loss;
  let result;
  for (let i = 1; i < 100; i++) result = tick(metrics, game, sample());
  close(result.strafe.loss, first * 14, 1e-7);
  close(result.strafe.totalLoss, first * 100, 1e-7);
  assert.equal(result.strafe.windowSeconds, 0.2);
  assert.equal(result.ramp.windowSeconds, 0.5);
});

test('live lookback shrinking evicts its exact boundary and expansion fills without resetting totals', () => {
  const settings = { strafeLookbackSeconds: 0.5 };
  const metrics = createMetrics(settings);
  const physics = { ...config, dt: 0.03125 };
  const game = session(physics);
  const input = sample({ physics });
  const first = tick(metrics, game, input).strafe.loss;
  for (let i = 1; i < 16; i++) tick(metrics, game, input);
  close(metrics.snapshot().strafe.loss, first * 16);

  // Change settings without another simulated tick. Age == window is out.
  settings.strafeLookbackSeconds = 0.0625;
  let result = metrics.snapshot();
  close(result.strafe.loss, first * 2);
  close(result.strafe.totalLoss, first * 16);
  assert.equal(result.strafe.windowSeconds, 0.0625);
  assert.equal(result.strafe.available, true);

  settings.strafeLookbackSeconds = 0.125;
  close(metrics.snapshot().strafe.loss, first * 2);
  for (let i = 0; i < 2; i++) result = tick(metrics, game, input);
  close(result.strafe.loss, first * 4);
  close(result.strafe.totalLoss, first * 18);
  result = tick(metrics, game, input);
  close(result.strafe.loss, first * 4);
  close(result.strafe.totalLoss, first * 19);
  assert.equal(result.ramp.windowSeconds, 0.5);
});

test('lookback reads live bounded finite settings with a safe default', () => {
  const settings = {};
  const metrics = createMetrics(settings);
  for (const [value, expected] of [[undefined, 0.2], [NaN, 0.2], [Infinity, 0.2],
    [0.01, 0.05], [1, 0.5], [0.15, 0.15]]) {
    settings.strafeLookbackSeconds = value;
    assert.equal(metrics.snapshot().strafe.windowSeconds, expected);
  }
});

test('asymmetric capped acceleration finds equal-pressure roots beyond the reflected wish', () => {
  for (const float32 of [false, true]) {
    const physics = { ...config, float32 };
    const round = float32 ? Math.fround : value => value;
    const input = sample({ physics, before: vector(100, -87.5, -120),
      direction: vector(round(-0.8), round(0.6)) });
    const contact = { normal: vector(0.8, 0, 0.6), brushId: 'ramp-root' };
    const result = tick(createMetrics({continuousFeedback:true}), session(physics), input,
      { ...clip(input.after, vector(46.8, 10, -62.4), [contact]), config: physics });
    // Actual: a=162.5, u=(-130,97.5). Feasible alternative d=(-1,0):
    // a=130, u=(-130,0). Both have normal impulse -104. Reflecting the
    // original wish instead gives a=57.5 and a different normal impulse.
    // F is strictly convex here, so these are its only two capped roots.
    const expected = Math.hypot(78, 87.5) - Math.hypot(78, 10);
    assert.equal(result.status, 'surf');
    assert.equal(result.strafe.available, true);
    close(result.strafe.loss, expected, float32 ? 0.001 : 1e-9);
    assert.equal(result.strafe.efficiency, null);
  }
});

test('budget-limited same-pressure alternatives are included alongside capped roots', () => {
  const physics = { ...config, dt: 0.1, airAccelerate: 1, airCap: 100 };
  const input = sample({ physics, before: vector(0, 100, -10),
    wishSpeed: 100, direction: vector(0.6, -0.8) });
  const contact = { normal: vector(0.8, 0, 0.6), brushId: 'ramp-budget' };
  const result = tick(createMetrics({continuousFeedback:true}), session(physics), input,
    { ...clip(input.after, vector(6.96, 92, -9.28), [contact]), config: physics });
  // Both u=(6,-8) and u=(6,8) use the full 10-unit budget and preserve
  // normal impulse 4.8; their plane-tangent slope component is 11.6.
  assert.equal(result.status, 'surf');
  close(result.strafe.loss, Math.hypot(11.6, 108) - Math.hypot(11.6, 92));
});

test('held ramp feedback excludes unrelated air optima when continuous analysis is enabled mid-ramp', () => {
  const settings = {continuousFeedback:false};
  const metrics = createMetrics(settings);
  const game = session();
  const first = tick(metrics, game, sample());
  assert.ok(first.strafe.loss > 0);
  const input = sample({before:vector(100),direction:vector(-1)});
  const held = tick(metrics, game, input, clip(input.after, input.after));
  assert.equal(held.strafe.available, false);
  close(held.strafe.loss, 0);
  settings.continuousFeedback = true;
  const live = tick(metrics, game, input, clip(input.after, input.after));
  assert.equal(live.strafe.available, true);
  close(live.strafe.loss, 70);
});

test('retained board keeps the first collision speeds through large turns and live expiry', () => {
  const metrics = createMetrics();
  const game = session();
  const before = vector(1000, 0, -300);
  const after = vector(1000, 144, -192);
  const board = tick(metrics, game, undefined, clip(before, after)).board;
  assert.equal(board.available, true);
  assert.equal(board.tick, 1);
  assert.equal(board.sequence, 1);
  close(board.speedBefore, Math.hypot(1000, 0, -300));
  close(board.speedAfter, Math.hypot(1000, 144, -192));
  close(board.loss, board.speedBefore - board.speedAfter);
  before.x = after.x = 0;
  for (let i = 0; i < 100; i++) {
    const result = tick(metrics, game, undefined, clip(vector(1000), vector(100)));
    assert.deepEqual(result.board, board);
    assert.equal(result.ramp.kind, 'turn');
  }
  const expired = metrics.snapshot(Infinity);
  assert.equal(expired.ramp.available, false);
  assert.deepEqual(expired.board, board);
});

test('retained board uses only the first collision observation within a step', () => {
  const metrics = createMetrics();
  const game = session();
  metrics.begin(game);
  metrics.collision(clip(vector(1000), vector(900)));
  metrics.collision(clip(vector(900), vector(500)));
  game.state.tick++;
  metrics.end(game);
  const result = metrics.snapshot();
  assert.equal(result.board.available, true);
  assert.equal(result.board.sequence, 1);
  assert.equal(result.board.tick, 1);
  assert.equal(result.board.entryContacts, 1);
  close(result.board.loss, 100);
  close(result.board.speedBefore, 1000);
  close(result.board.speedAfter, 900);
  close(result.ramp.totalLoss, 500);
});

test('same-plane recontacts sum only first clips without including intervening speed changes', () => {
  const metrics = createMetrics();
  const game = session();
  tick(metrics, game, undefined, clip(vector(1000), vector(990)));
  tick(metrics, game, sample());
  metrics.begin(game);
  metrics.collision(clip(vector(1200), vector(1195),
    [{ normal: rampNormal, brushId: 'ramp-b' }]));
  metrics.collision(clip(vector(1195), vector(900)));
  game.state.tick++;
  metrics.end(game);
  const merged = metrics.snapshot().board;
  assert.equal(merged.available, true);
  assert.equal(merged.sequence, 1);
  assert.equal(merged.tick, 1);
  assert.equal(merged.entryContacts, 2);
  close(merged.loss, 15);
  close(merged.speedBefore, 1000);
  close(merged.speedAfter, 1195);
  const ongoing = tick(metrics, game, undefined, clip(vector(900), vector(500)));
  assert.deepEqual(ongoing.board, merged);
  assert.equal(ongoing.ramp.kind, 'turn');
  close(ongoing.ramp.totalLoss, 710);
  for (let i = 0; i < 4; i++) tick(metrics, game);
  const next = tick(metrics, game, undefined, clip(vector(750), vector(725))).board;
  assert.equal(next.sequence, 2);
  assert.equal(next.tick, 9);
  assert.equal(next.entryContacts, 1);
  close(next.loss, 25);
});

test('ambiguous ramp entries invalidate the old board without relabeling their continuation', () => {
  for (const impact of [
    { ...clip(vector(900), vector(700), []), blocked: true },
    clip(vector(900), vector(700), [rampContact, { normal: vector(0.8, 0, 0.6), brushId: 'ramp-b' }]),
    clip(vector(900), vector(700), [rampContact, { normal: vector(1, 0, 0), brushId: 'wall' }]),
    { ...clip(vector(900), vector(700)), blocked: true },
  ]) {
    const metrics = createMetrics();
    const game = session();
    tick(metrics, game, undefined, clip(vector(1000), vector(900)));
    for (let i = 0; i < 4; i++) tick(metrics, game);
    const unknown = tick(metrics, game, undefined, impact).board;
    assert.equal(unknown.available, false);
    assert.equal(unknown.sequence, 1);
    assert.equal(unknown.tick, null);
    assert.equal(unknown.entryContacts, 0);
    close(unknown.loss, 0);
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(tick(metrics, game, undefined, clip(vector(700), vector(690))).board, unknown);
    }
    for (let i = 0; i < 4; i++) tick(metrics, game, sample());
    const next = tick(metrics, game, undefined, clip(vector(690), vector(680))).board;
    assert.equal(next.available, true);
    assert.equal(next.sequence, 2);
    close(next.loss, 10);
  }
});

test('completed air separates braking and missed positive gain without counting coasting', () => {
  const metrics = createMetrics();
  const game = session();
  const localGain = Math.hypot(1000, 30) - 1000;
  const reverse = sample({ direction: vector(-1) });
  tick(metrics, game, reverse);
  tick(metrics, game, sample());
  tick(metrics, game, sample({ direction: vector(0, 1) }));
  tick(metrics, game, sample({ wishSpeed: 0 }));
  const unsupported = sample();
  unsupported.after.x += 1;
  tick(metrics, game, unsupported);
  tick(metrics, game);
  const pending = tick(metrics, game, sample());
  assert.equal(pending.air.available, false);
  // The landing tick is excluded even though acceleration preceded its contact.
  const result = tick(metrics, game, reverse, clip(reverse.after, vector(400))).air;
  assert.equal(result.available, true);
  assert.equal(result.tick, 8);
  assert.equal(result.sequence, 1);
  close(result.brakingLoss, 585);
  close(result.missedGain, 3 * localGain);
  close(result.loss, 585 + 3 * localGain);
  close(result.measuredSeconds, 4 * config.dt);
});

test('completed air stays unchanged throughout the next flight and updates only on contact', () => {
  const metrics = createMetrics();
  const game = session();
  for (let i = 0; i < 4; i++) tick(metrics, game, sample());
  const first = tick(metrics, game, undefined, clip(vector(1000), vector(900))).air;
  assert.equal(first.available, true);
  for (let i = 0; i < 12; i++) {
    const pending = tick(metrics, game, sample({ direction: vector(0, 1) }));
    assert.deepEqual(pending.air, first);
  }
  assert.deepEqual(metrics.snapshot(Infinity).air, first);
  const second = tick(metrics, game, undefined, clip(vector(1000), vector(900))).air;
  assert.equal(second.sequence, 2);
  assert.equal(second.tick, 18);
  close(second.loss, 0);
  close(second.brakingLoss, 0);
  close(second.missedGain, 0);
  close(second.measuredSeconds, 12 * config.dt);
});

test('contact-grace microflights cannot overwrite a completed meaningful air segment', () => {
  const metrics = createMetrics();
  const game = session();
  for (let i = 0; i < 4; i++) tick(metrics, game, sample());
  const first = tick(metrics, game, undefined, clip(vector(1000), vector(900))).air;
  for (const count of [1, 2, 3, 1, 2, 3]) {
    for (let i = 0; i < count; i++) tick(metrics, game, sample({ direction: vector(-1) }));
    assert.deepEqual(tick(metrics, game, undefined, clip(vector(1000), vector(900))).air, first);
  }
});

test('air duration threshold uses measured simulation time, not observation count', () => {
  const physics = { ...config, dt: 0.025 };
  const metrics = createMetrics();
  const game = session(physics);
  for (let i = 0; i < 2; i++) tick(metrics, game, sample({ physics }));
  const result = tick(metrics, game, undefined, clip(vector(1000), vector(900))).air;
  assert.equal(result.available, true);
  close(result.measuredSeconds, 0.05);
  assert.equal(result.tick, 3);
});

test('ground observations and end-of-step grounded state both finalize free air', () => {
  for (const boundary of ['floor-contact', 'ground-acceleration', 'grounded-state']) {
    const metrics = createMetrics();
    const game = session();
    for (let i = 0; i < 4; i++) tick(metrics, game, sample());
    metrics.begin(game);
    if (boundary === 'floor-contact') {
      metrics.collision(clip(vector(1000), vector(900), [{ normal: vector(0, 0, 1), brushId: 'floor' }]));
    } else if (boundary === 'ground-acceleration') {
      metrics.acceleration(sample({ airborne: false }));
    } else {
      metrics.acceleration(sample());
      game.state.grounded = true;
    }
    game.state.tick++;
    metrics.end(game);
    const result = metrics.snapshot().air;
    assert.equal(result.available, true, boundary);
    assert.equal(result.tick, 5);
    close(result.measuredSeconds, 4 * config.dt);
    close(result.brakingLoss, 0);
    close(result.loss, 4 * (Math.hypot(1000, 30) - 1000));
    assert.deepEqual(tick(metrics, game, sample({ airborne: false })).air, result);
  }
});

test('same-pressure surf, unsupported physics and no-wish ticks never create an air summary', () => {
  const metrics = createMetrics();
  const game = session();
  for (let i = 0; i < 10; i++) {
    const input = sample({ before: vector(1000, -100), direction: vector(0, -1) });
    tick(metrics, game, input, clip(input.after, input.after));
  }
  for (let i = 0; i < 10; i++) {
    tick(metrics, game, sample({ wishSpeed: 0 }));
    tick(metrics, game, sample({ physics: { ...config, airAccelerate: 0 } }));
    const unsupported = sample();
    unsupported.after.x++;
    tick(metrics, game, unsupported);
  }
  const result = tick(metrics, game, undefined, clip(vector(1000), vector(900)));
  assert.equal(result.air.available, false);
  assert.equal(result.air.sequence, 0);
  close(result.air.measuredSeconds, 0);
});

test('pure ground contacts retain the last board but separate the next ramp entry', () => {
  const metrics = createMetrics();
  const game = session();
  const first = tick(metrics, game, undefined, clip(vector(1000), vector(900))).board;
  const ground = tick(metrics, game, undefined,
    clip(vector(900), vector(890), [{ normal: vector(0, 0, 1), brushId: 'floor' }]));
  assert.deepEqual(ground.board, first);
  const second = tick(metrics, game, undefined, clip(vector(890), vector(880))).board;
  assert.equal(second.sequence, 2);
  close(second.loss, 10);
});

test('retained summaries reset on native transitions and discard pending flight measurements', () => {
  const empty = createMetrics().snapshot();
  for (const event of ['start', 'teleport', 'fall', 'stage-restarted', 'start-return',
    'stage-return', 'restart', 'practice-restore']) {
    const metrics = createMetrics();
    const game = session();
    for (let i = 0; i < 4; i++) tick(metrics, game, sample());
    const populated = tick(metrics, game, undefined, clip(vector(1000), vector(900)));
    assert.equal(populated.board.available, true);
    assert.equal(populated.air.available, true);
    for (let i = 0; i < 4; i++) tick(metrics, game, sample());
    const result = tick(metrics, game, undefined, clip(vector(1000), vector(800)), [event]);
    assert.deepEqual(result.board, empty.board, event);
    assert.deepEqual(result.air, empty.air, event);
    const next = tick(metrics, game, undefined, clip(vector(1000), vector(900)));
    assert.deepEqual(next.air, empty.air);
    assert.equal(next.board.sequence, 1);
  }
});

test('explicit reset, replaced sessions and tick discontinuities clear both retained summaries', () => {
  const empty = createMetrics().snapshot();
  for (const change of [
    (metrics, game) => { metrics.reset(); return game; },
    (metrics, game) => { game.state = { ...game.state }; return game; },
    (metrics, game) => { game.state.tick = 0; return game; },
    (metrics, game) => { game.state.tick += 10; return game; },
    () => session(),
  ]) {
    const metrics = createMetrics();
    let game = session();
    for (let i = 0; i < 4; i++) tick(metrics, game, sample());
    tick(metrics, game, undefined, clip(vector(1000), vector(900)));
    game = change(metrics, game);
    const result = tick(metrics, game);
    assert.deepEqual(result.board, empty.board);
    assert.deepEqual(result.air, empty.air);
  }
});

test('returned board and air summaries cannot mutate retained state', () => {
  const metrics = createMetrics();
  const game = session();
  for (let i = 0; i < 4; i++) tick(metrics, game, sample());
  const result = tick(metrics, game, undefined, clip(vector(1000), vector(900)));
  const board = { ...result.board };
  const air = { ...result.air };
  for (const summary of [result.board, result.air]) {
    for (const key of Object.keys(summary)) summary[key] = null;
  }
  assert.deepEqual(metrics.snapshot().board, board);
  assert.deepEqual(metrics.snapshot().air, air);
});

test('retained board uses full 3D speed and never turns slope conversion into loss', () => {
  for (const after of [vector(800, 0, 600), vector(800, 0, 700)]) {
    const result = tick(createMetrics(), session(), undefined, clip(vector(1000), after)).board;
    assert.equal(result.available, true);
    close(result.speedBefore, 1000);
    close(result.speedAfter, Math.hypot(after.x, after.y, after.z));
    close(result.loss, 0);
  }
});

test('mixed ramp and ground boundaries finish measured air without inventing a board', () => {
  for (const contacts of [
    [rampContact, { normal: vector(0, 0, 1), brushId: 'floor' }],
    [rampContact, { normal: vector(1, 0, 0), brushId: 'wall' }],
  ]) {
    const metrics = createMetrics();
    const game = session();
    for (let i = 0; i < 4; i++) tick(metrics, game, sample());
    const result = tick(metrics, game, sample(), clip(vector(1000), vector(900), contacts));
    assert.equal(result.board.available, false);
    assert.equal(result.air.available, true);
    assert.equal(result.air.sequence, 1);
    close(result.air.measuredSeconds, 4 * config.dt);
    close(result.air.loss, 4 * (Math.hypot(1000, 30) - 1000));
  }
});

test('later mixed, multi-plane and blocked observations retain an accepted episode entry', () => {
  for (const impact of [
    clip(vector(900), vector(700), [rampContact, { normal: vector(1, 0, 0), brushId: 'wall' }]),
    clip(vector(900), vector(700), [rampContact, { normal: vector(0.8, 0, 0.6), brushId: 'ramp-b' }]),
    { ...clip(vector(900), vector(700)), blocked: true },
    { ...clip(vector(900), vector(700), []), blocked: true },
  ]) {
    const metrics = createMetrics();
    const game = session();
    const first = tick(metrics, game, undefined, clip(vector(1000), vector(900))).board;
    assert.deepEqual(tick(metrics, game, undefined, impact).board, first);
    const continuation = tick(metrics, game, undefined, clip(vector(700), vector(690)));
    assert.deepEqual(continuation.board, first);
    assert.equal(continuation.ramp.kind, 'turn');
  }
});

test('coplanar multi-brush entries are boards but preserve stricter same-pressure eligibility', () => {
  const contacts = [rampContact, { normal: { ...rampNormal }, brushId: 'ramp-b' }];
  const metrics = createMetrics({continuousFeedback:true});
  const game = session();
  const result = tick(metrics, game, sample(), clip(vector(1000), vector(900), contacts));
  assert.equal(result.board.available, true);
  close(result.board.loss, 100);
  assert.equal(result.ramp.kind, 'board');
  assert.equal(result.status, 'unsupported-surf');
  assert.equal(result.strafe.available, false);
  const seam = tick(metrics, game, undefined, clip(vector(900), vector(850), contacts));
  assert.deepEqual(seam.board, result.board);
  assert.equal(seam.ramp.kind, 'turn');
  close(seam.ramp.turnLoss, 50);
});

test('native coplanar exit seams preserve their entry instead of tiny replacement boards', () => {
  for (const [normal, firstBrush, nextBrush, loss] of [
    [vector(0, 0.7282000184059143, 0.6853647232055664), 'bsp-0-793', 'bsp-0-794', 0.46183564759348883],
    [vector(0, -0.7281999588012695, 0.6853646636009216), 'bsp-0-594', 'bsp-0-593', 0.2266097451024507],
    [vector(0.7281999588012695, 0, 0.6853646636009216), 'bsp-0-602', 'bsp-0-601', 1.042391000144562],
  ]) {
    const metrics = createMetrics();
    const game = session();
    const first = tick(metrics, game, undefined,
      clip(vector(1000), vector(970), [{ normal, brushId: firstBrush }])).board;
    const seam = tick(metrics, game, undefined,
      clip(vector(970), vector(970 - loss), [{ normal, brushId: nextBrush }]));
    assert.deepEqual(seam.board, first);
    assert.equal(seam.ramp.kind, 'turn');
    close(seam.ramp.loss, loss);
  }
});

test('a brief exit graze after the entry window retains its board across brush changes', () => {
  const metrics = createMetrics();
  const game = session();
  const first = tick(metrics, game, undefined, clip(vector(1000), vector(970))).board;
  for (let i = 0; i < 7; i++) tick(metrics, game, undefined, clip(vector(970), vector(969)));
  for (let i = 0; i < 3; i++) tick(metrics, game);
  const exit = tick(metrics, game, undefined,
    clip(vector(969), vector(968.5), [{ normal: rampNormal, brushId: 'exit' }]));
  assert.deepEqual(exit.board, first);
  assert.equal(exit.ramp.kind, 'turn');
});

test('continuous contacts and changing ramp normals never add to the retained entry', () => {
  const metrics = createMetrics();
  const game = session();
  const first = tick(metrics, game, undefined, clip(vector(1000), vector(990))).board;
  for (const normal of [rampNormal, vector(0.8, 0, 0.6), rampNormal]) {
    const result = tick(metrics, game, undefined,
      clip(vector(1500), vector(500), [{ normal, brushId: 'flick' }]));
    assert.deepEqual(result.board, first);
    assert.equal(result.ramp.kind, 'turn');
  }
  tick(metrics, game);
  const differentPlane = tick(metrics, game, undefined,
    clip(vector(1200), vector(800), [{ normal: vector(0.8, 0, 0.6), brushId: 'other' }]));
  assert.deepEqual(differentPlane.board, first);
});

test('brief recontacts match entry normals rather than brush identity or float32 noise', () => {
  const metrics = createMetrics();
  const game = session();
  const normal = vector(0, Math.fround(0.8), Math.fround(0.6));
  tick(metrics, game, undefined, clip(vector(1000), vector(990)));
  tick(metrics, game);
  const result = tick(metrics, game, undefined,
    clip(vector(1100), vector(1098), [{ normal, brushId: 'another-brush' }]));
  close(result.board.loss, 12);
  assert.equal(result.board.entryContacts, 2);
  assert.equal(result.board.sequence, 1);
});

test('repeated bounces never renew the fixed inclusive 90ms entry deadline', () => {
  const metrics = createMetrics();
  const game = session();
  const impact = clip(vector(1000), vector(990));
  tick(metrics, game, undefined, impact);
  for (let i = 0; i < 3; i++) {
    tick(metrics, game);
    const result = tick(metrics, game, undefined, impact);
    assert.equal(result.board.entryContacts, i + 2);
    close(result.board.loss, (i + 2) * 10);
    assert.equal(result.board.tick, 1);
    assert.equal(result.board.sequence, 1);
  }
  const atDeadline = metrics.snapshot().board;
  tick(metrics, game);
  assert.deepEqual(tick(metrics, game, undefined, impact).board, atDeadline);
});

test('entry window rejects a recontact strictly later than 90ms without replacing it', () => {
  for (const delay of [0.09, 0.090001]) {
    const metrics = createMetrics();
    const game = session({ ...config, dt: 0.01 });
    const impact = clip(vector(1000), vector(990));
    const first = tick(metrics, game, undefined, impact).board;
    game.config.dt = delay - 0.02;
    tick(metrics, game, undefined, impact);
    game.config.dt = 0.01;
    tick(metrics, game);
    const result = tick(metrics, game, undefined, impact).board;
    assert.equal(result.sequence, 1);
    if (delay === 0.09) {
      close(result.loss, 20);
      assert.equal(result.entryContacts, 2);
    } else assert.deepEqual(result, first);
  }
});

test('separation counts actual no-ramp dt with an inclusive 45ms grace, not contact dt', () => {
  for (const gap of [0.044999, 0.045, 0.045001]) {
    for (const contactDt of [0.001, 0.04]) {
      const metrics = createMetrics();
      const game = session({ ...config, dt: 0.01 });
      tick(metrics, game, undefined, clip(vector(1000), vector(990)));
      game.config.dt = gap;
      tick(metrics, game);
      game.config.dt = contactDt;
      const result = tick(metrics, game, undefined, clip(vector(1200), vector(1199)));
      const separated = gap > 0.045;
      assert.equal(result.board.sequence, separated ? 2 : 1);
      assert.equal(result.board.tick, separated ? 3 : 1);
      assert.equal(result.board.entryContacts, separated ? 1 : 2);
      close(result.board.loss, separated ? 1 : 11);
      assert.equal(result.ramp.kind, separated ? 'board' : 'turn');
    }
  }
});

test('confirmed longer flights accept small genuine boards without a loss magnitude filter', () => {
  for (const seconds of [3.555, 3.18, 0.48]) {
    const metrics = createMetrics();
    const game = session({ ...config });
    tick(metrics, game, undefined, clip(vector(1000), vector(970)));
    game.config.dt = seconds;
    tick(metrics, game);
    game.config.dt = 0.015;
    const result = tick(metrics, game, undefined, clip(vector(1200), vector(1199.75)));
    assert.equal(result.board.sequence, 2);
    assert.equal(result.board.entryContacts, 1);
    assert.equal(result.ramp.kind, 'board');
    close(result.board.loss, 0.25);
  }
});

test('ramp-bearing ambiguous contacts restart the airborne gap without losing an accepted board', () => {
  for (const impact of [
    clip(vector(900), vector(800), [rampContact, { normal: vector(1, 0, 0) }]),
    clip(vector(900), vector(800), [rampContact, { normal: vector(0.8, 0, 0.6) }]),
    { ...clip(vector(900), vector(800)), blocked: true },
  ]) {
    const metrics = createMetrics();
    const game = session();
    const first = tick(metrics, game, undefined, clip(vector(1000), vector(990))).board;
    for (let i = 0; i < 2; i++) tick(metrics, game);
    assert.deepEqual(tick(metrics, game, undefined, impact).board, first);
    for (let i = 0; i < 2; i++) tick(metrics, game);
    const result = tick(metrics, game, undefined, clip(vector(1100), vector(1098)));
    assert.equal(result.board.sequence, 1);
    close(result.board.loss, 12);
    assert.equal(result.board.entryContacts, 2);
  }
});

test('wall and blocked observations cannot manufacture confirmed free-flight separation', () => {
  for (const impact of [
    clip(vector(900), vector(800), [{ normal: vector(1, 0, 0) }]),
    { ...clip(vector(900), vector(800), []), blocked: true },
  ]) {
    const metrics = createMetrics();
    const game = session();
    const first = tick(metrics, game, undefined, clip(vector(1000), vector(990))).board;
    for (let i = 0; i < 2; i++) tick(metrics, game);
    for (let i = 0; i < 10; i++) tick(metrics, game, undefined, impact);
    for (let i = 0; i < 2; i++) tick(metrics, game);
    const result = tick(metrics, game, undefined, clip(vector(1100), vector(1099)));
    assert.deepEqual(result.board, first);
    assert.equal(result.ramp.kind, 'turn');
  }
});

test('ground state and grounded acceleration end a board episode without erasing its summary', () => {
  for (const boundary of ['state', 'acceleration']) {
    const metrics = createMetrics();
    const game = session();
    const first = tick(metrics, game, undefined, clip(vector(1000), vector(990))).board;
    if (boundary === 'state') game.state.grounded = true;
    const grounded = tick(metrics, game, boundary === 'acceleration' ? sample({ airborne: false }) : undefined);
    assert.deepEqual(grounded.board, first);
    game.state.grounded = false;
    const result = tick(metrics, game, undefined, clip(vector(1100), vector(1099)));
    assert.equal(result.board.sequence, 2);
    close(result.board.loss, 1);
  }
});

test('reset clears a merged entry and its episode deadline and separation state', () => {
  const metrics = createMetrics();
  const game = session();
  const empty = metrics.snapshot().board;
  tick(metrics, game, undefined, clip(vector(1000), vector(990)));
  tick(metrics, game);
  assert.equal(tick(metrics, game, undefined, clip(vector(1200), vector(1195))).board.entryContacts, 2);
  metrics.reset();
  assert.deepEqual(metrics.snapshot().board, empty);
  const first = tick(metrics, game, undefined, clip(vector(1000), vector(980)));
  assert.equal(first.board.sequence, 1);
  assert.equal(first.board.entryContacts, 1);
  tick(metrics, game);
  const merged = tick(metrics, game, undefined, clip(vector(1100), vector(1097)));
  assert.equal(merged.board.sequence, 1);
  assert.equal(merged.board.entryContacts, 2);
  close(merged.board.loss, 23);
});

test('zero-loss recontact updates its clip endpoint without subtracting gains from entry loss', () => {
  const metrics = createMetrics();
  const game = session();
  tick(metrics, game, undefined, clip(vector(1000), vector(990)));
  tick(metrics, game);
  const result = tick(metrics, game, undefined, clip(vector(1200), vector(1201)));
  close(result.board.loss, 10);
  close(result.board.speedBefore, 1000);
  close(result.board.speedAfter, 1201);
  assert.equal(result.board.entryContacts, 2);
  assert.equal(result.board.tick, 1);
  assert.equal(result.board.sequence, 1);
});

test('known curved surfaces keep one board through 60–135ms skips without extending its entry window', () => {
  for (const gap of [0.06, 0.135]) {
    const metrics = createMetrics();
    const game = mappedSession();
    const first = coastContact(metrics, game).board;
    assert.notEqual(first.surfaceId, null);
    game.config.dt = gap;
    tick(metrics, game, sample({ physics: game.config }));
    game.config.dt = 0.015;
    const result = coastContact(metrics, game, { contacts: [curveContact], after: vector(980) });
    assert.equal(result.board.sequence, 1);
    assert.equal(result.board.surfaceId, first.surfaceId);
    assert.equal(result.board.visit, 1);
    assert.equal(result.board.entryContacts, gap < 0.09 ? 2 : 1);
    close(result.board.loss, gap < 0.09 ? 30 : 10);
    assert.equal(result.air.available, false);
    assert.equal(result.surf.available, false);
  }
});

test('known surface separation uses an inclusive 250ms grace independent of return tick duration', () => {
  for (const gap of [0.249999, 0.25, 0.250001]) {
    for (const contactDt of [0.001, 0.04]) {
      const metrics = createMetrics();
      const game = mappedSession();
      const first = coastContact(metrics, game).board;
      game.config.dt = gap;
      tick(metrics, game);
      game.config.dt = contactDt;
      const result = coastContact(metrics, game, { contacts: [curveContact] });
      assert.equal(result.board.sequence, gap > 0.25 ? 2 : 1);
      assert.equal(result.board.visit, gap > 0.25 ? 2 : 1);
      assert.equal(result.board.surfaceId, first.surfaceId);
    }
  }
});

test('different known components begin new boards immediately, even with matching normals', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  for (let i = 0; i < 4; i++) coastContact(metrics, game);
  const first = metrics.snapshot().board;
  const result = coastContact(metrics, game, { contacts: [separateContact], after: vector(975) });
  assert.equal(result.board.sequence, 2);
  assert.notEqual(result.board.surfaceId, first.surfaceId);
  assert.equal(result.board.visit, 1);
  close(result.board.loss, 25);
  assert.equal(result.surf.available, true);
  assert.equal(result.surf.surfaceId, first.surfaceId);
  assert.equal(result.surf.tick, 4);
  close(result.surf.loss, 10);
});

test('Board identity records per-surface visits and checkpoint at entry, not at later turns', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  game.checkpointSpeeds.push(500);
  const first = coastContact(metrics, game).board;
  assert.equal(first.visit, 1);
  assert.equal(first.checkpoint, 1);
  game.checkpointSpeeds.push(600);
  const turn = coastContact(metrics, game, { contacts: [curveContact] }).board;
  assert.equal(turn.checkpoint, 1);
  assert.equal(turn.visit, 1);
  assert.equal(turn.surfaceId, first.surfaceId);
  const other = coastContact(metrics, game, { contacts: [separateContact] }).board;
  assert.equal(other.checkpoint, 2);
  assert.equal(other.visit, 1);
  const returned = coastContact(metrics, game).board;
  assert.equal(returned.surfaceId, first.surfaceId);
  assert.equal(returned.visit, 2);
  assert.equal(returned.checkpoint, 2);
  assert.equal(returned.sequence, 3);
  metrics.reset();
  const restarted = coastContact(metrics, game).board;
  assert.equal(restarted.sequence, 1);
  assert.equal(restarted.visit, 1);
});

test('Board checkpoint falls back to timer splits and unknown geometry cannot produce matching identity', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  delete game.checkpointSpeeds;
  game.timer = { splits: [12, 24] };
  const known = coastContact(metrics, game).board;
  assert.notEqual(known.surfaceId, null);
  assert.equal(known.checkpoint, 2);
  const unknownGame = session();
  unknownGame.checkpointSpeeds = [500];
  const unknown = coastContact(createMetrics(), unknownGame).board;
  assert.equal(unknown.available, true);
  close(unknown.loss, 10);
  assert.equal(unknown.surfaceId, null);
  assert.equal(unknown.visit, null);
  assert.equal(unknown.checkpoint, null);
});

test('Surf holds the net first-entry to last-contact result, includes Board, and credits later gains', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  for (const speed of [990, 995, 985, 990]) {
    const result = endpointContact(metrics, game, vector(speed));
    assert.equal(result.surf.available, false);
    assert.equal(result.surf.sequence, 0);
  }
  const completed = leaveRamp(metrics, game).surf;
  assert.equal(completed.available, true);
  assert.equal(completed.sequence, 1);
  assert.equal(completed.tick, 4);
  close(completed.entrySpeed, 1000);
  close(completed.exitSpeed, 990);
  close(completed.expectedExitSpeed, 1000);
  close(completed.loss, 10);
  close(completed.measuredSeconds, 0.06);
  close(metrics.snapshot().board.loss, 10);
  for (let i = 0; i < 10; i++) tick(metrics, game, sample());
  const next = endpointContact(metrics, game, vector(980), 0, [separateContact]);
  assert.deepEqual(next.surf, completed);
});

test('Surf cancels intermediate losses with gains and reports signed net gains', () => {
  for (const finalSpeed of [1000, 1020]) {
    const metrics = createMetrics();
    const game = mappedSession();
    for (const speed of [990, 1000, 980, finalSpeed]) endpointContact(metrics, game, vector(speed));
    const result = leaveRamp(metrics, game).surf;
    assert.equal(result.available, true);
    close(result.loss, 1000 - finalSpeed);
    close(result.heightDelta, 0);
  }
});

test('Surf corrects both uphill and downhill conversion using native gravity and full 3D speed', () => {
  for (const gravity of [400, 800]) {
    for (const heightDelta of [-120, 120]) {
      for (const deficit of [0, 5, -8]) {
        const metrics = createMetrics();
        const game = mappedSession({...config, gravity});
        game.state.position.z = 200;
        const expected = Math.sqrt(1000000 - 2 * gravity * heightDelta);
        const actual = expected - deficit;
        for (let i = 1; i <= 4; i++) {
          const fraction = i / 4;
          endpointContact(metrics, game, vector(actual * 0.6, 0, actual * 0.8), 200 + heightDelta * fraction);
        }
        const result = leaveRamp(metrics, game).surf;
        assert.equal(result.available, true);
        close(result.expectedExitSpeed, expected);
        close(result.exitSpeed, actual);
        close(result.heightDelta, heightDelta);
        close(result.loss, deficit);
      }
    }
  }
});

test('Surf samples whole native ticks, including gravity halves, rather than acceleration/slide sub-intervals', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  game.state.velocity = vector(800, 0, -594);
  game.state.position.z = 1000;
  const initialSquared = 800 ** 2 + 594 ** 2;
  const finalVelocity = vector(0, 720, -546);
  const finalSquared = 720 ** 2 + 546 ** 2;
  const finalHeight = 1000 + (initialSquared - finalSquared) / (2 * config.gravity);
  metrics.begin(game);
  metrics.acceleration(sample({before:vector(800, 0, -600),wishSpeed:0,direction:vector()}));
  metrics.collision(clip(vector(800, 0, -600), vector(0, 720, -540)));
  game.state.velocity = {...finalVelocity};
  game.state.position.z = finalHeight;
  game.state.tick++;
  metrics.end(game);
  for (let i = 0; i < 3; i++) endpointContact(metrics, game, finalVelocity, finalHeight);
  const result = leaveRamp(metrics, game).surf;
  assert.equal(result.available, true);
  close(result.entrySpeed, Math.sqrt(initialSquared));
  close(result.exitSpeed, Math.sqrt(finalSquared));
  close(result.loss, 0);
});

test('Surf preserves first entry across same-ramp skips and ignores all post-exit movement', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  game.state.position.z = 100;
  for (const speed of [990, 980, 970, 960]) endpointContact(metrics, game, vector(speed));
  for (let i = 0; i < 9; i++) {
    game.state.velocity = vector(2000);
    game.state.position.z = -10000;
    tick(metrics, game);
  }
  endpointContact(metrics, game, vector(1020), 50, [curveContact]);
  const board = metrics.snapshot().board;
  assert.equal(board.sequence, 1);
  const expectedLoss = Math.sqrt(1000000 + 2 * config.gravity * 50) - 1020;
  let completed;
  for (let i = 0; i < 40; i++) {
    game.state.velocity.x += 100;
    game.state.position.z -= 100;
    const result = tick(metrics, game).surf;
    if (result.available) {
      completed ??= result;
      assert.deepEqual(result, completed);
      close(result.entrySpeed, 1000);
      close(result.exitSpeed, 1020);
      close(result.heightDelta, -50);
      close(result.loss, expectedLoss);
      close(result.measuredSeconds, 0.075);
      assert.equal(result.tick, 14);
    }
  }
  assert.equal(completed?.available, true);
});

test('Surf treats direction changes at unchanged speed and height as zero loss without input opportunity data', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  for (let i = 0; i < 4; i++) endpointContact(metrics, game, vector(600, 0, 800));
  const result = leaveRamp(metrics, game).surf;
  assert.equal(result.available, true);
  close(result.loss, 0);
  assert.equal(metrics.snapshot().air.available, false);
});

test('Surf handles the gravity-only apex without inventing a baseline above it', () => {
  for (const height of [625, 626]) {
    const metrics = createMetrics();
    const game = mappedSession();
    for (let i = 0; i < 4; i++) endpointContact(metrics, game, vector(10), height);
    const result = leaveRamp(metrics, game).surf;
    assert.equal(result.available, height === 625);
    if (height === 625) {
      close(result.expectedExitSpeed, 0);
      close(result.loss, -10);
    } else {
      assert.equal(result.loss, null);
      assert.equal(result.expectedExitSpeed, null);
      assert.equal(result.reason, 'above-gravity-only-height');
    }
  }
});

test('invalid endpoints or changing/missing gravity invalidate Surf instead of showing a partial result', () => {
  for (const corrupt of [
    game => { game.state.position.z = NaN; },
    game => { game.state.velocity.x = Infinity; },
    game => { game.config = {...game.config,gravity:NaN}; },
    game => { game.config = {...game.config,gravity:400}; },
  ]) {
    const metrics = createMetrics();
    const game = mappedSession();
    for (let i = 0; i < 4; i++) endpointContact(metrics, game, vector(990));
    corrupt(game);
    endpointContact(metrics, game, game.state.velocity);
    const result = leaveRamp(metrics, game).surf;
    assert.equal(result.available, false);
    assert.equal(result.loss, null);
    assert.equal(result.sequence, 1);
    assert.equal(result.unsupportedTicks, 1);
  }
});

test('mixed and blocked constituents preserve Board identity but invalidate the completed Surf', () => {
  for (const obstruction of [
    clip(vector(1000), vector(900), [rampContact, { normal: vector(1, 0, 0) }]),
    { ...clip(vector(1000), vector(900)), blocked: true },
    { ...clip(vector(1000), vector(900), []), blocked: true },
    clip(vector(1000), vector(900), [{ normal: vector(1, 0, 0) }]),
  ]) {
    const metrics = createMetrics();
    const game = mappedSession();
    for (let i = 0; i < 4; i++) coastContact(metrics, game);
    const first = metrics.snapshot().board;
    tick(metrics, game, sample({ wishSpeed: 0, direction: vector() }), obstruction);
    const continued = coastContact(metrics, game, { contacts: [curveContact] });
    assert.equal(continued.board.sequence, first.sequence);
    assert.equal(continued.board.surfaceId, first.surfaceId);
    assert.equal(continued.board.visit, first.visit);
    close(continued.board.loss, first.loss);
    const result = leaveRamp(metrics, game).surf;
    assert.equal(result.available, false);
    assert.equal(result.unsupportedTicks, 1);
    assert.equal(result.surfaceId, first.surfaceId);
    assert.equal(result.sequence, 1);
  }
});

test('connected changing facets are supported physical measurements even when the pressure optimum is unavailable', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  const input = sample();
  for (let i = 0; i < 4; i++) {
    const result = tick(metrics, game, input, clip(input.after, vector(990), [rampContact, curveContact]));
    assert.equal(result.board.available, true);
    assert.equal(result.board.sequence, 1);
    assert.equal(result.strafe.available, false);
  }
  const result = leaveRamp(metrics, game).surf;
  assert.equal(result.available, true);
  assert.equal(result.unsupportedTicks, 0);
  close(result.loss, 10);
});

test('short same-surface skips discard pending Air but genuine subsequent flight still completes it', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  for (let i = 0; i < 4; i++) coastContact(metrics, game);
  for (let i = 0; i < 9; i++) tick(metrics, game, sample());
  const returned = coastContact(metrics, game, { contacts: [curveContact] });
  assert.equal(returned.air.available, false);
  assert.equal(returned.board.sequence, 1);
  for (let i = 0; i < 17; i++) tick(metrics, game, sample());
  const landed = coastContact(metrics, game, { contacts: [separateContact] });
  assert.equal(landed.air.available, true);
  close(landed.air.measuredSeconds, 0.255);
  assert.equal(landed.surf.available, true);
  assert.equal(landed.surf.tick, 14);
  close(landed.surf.measuredSeconds, 0.075);
});

test('Surf requires 50ms actual ramp contact, not elapsed time or gaps, and retains meaningful prior totals', () => {
  for (const seconds of [0.049999, 0.05]) {
    const metrics = createMetrics();
    const game = mappedSession({ ...config, dt: seconds });
    coastContact(metrics, game);
    const result = leaveRamp(metrics, game).surf;
    assert.equal(result.available, seconds >= 0.05);
    assert.equal(result.sequence, seconds >= 0.05 ? 1 : 0);
  }
  const metrics = createMetrics();
  const game = mappedSession();
  for (let i = 0; i < 4; i++) coastContact(metrics, game);
  const first = leaveRamp(metrics, game).surf;
  coastContact(metrics, game, { contacts: [separateContact], after: vector(500) });
  const afterGraze = leaveRamp(metrics, game).surf;
  assert.equal(afterGraze.sequence, first.sequence);
  close(afterGraze.loss, first.loss);
});

test('ground and native finish finalize Surf using last contact tick, not the boundary tick', () => {
  for (const boundary of ['ground', 'ground-acceleration', 'floor', 'finish', 'timer']) {
    const metrics = createMetrics();
    const game = mappedSession();
    for (let i = 0; i < 4; i++) coastContact(metrics, game);
    if (boundary === 'ground') game.state.grounded = true;
    if (boundary === 'timer') game.timer = { phase: 'finished' };
    const result = tick(metrics, game,
      boundary === 'ground-acceleration' ? sample({ airborne: false }) : undefined,
      boundary === 'floor' ? clip(vector(1000), vector(990), [{ normal: vector(0, 0, 1) }]) : undefined,
      boundary === 'finish' ? ['finish'] : []);
    assert.equal(result.surf.available, true);
    assert.equal(result.surf.tick, 4);
    assert.equal(result.surf.sequence, 1);
    close(result.surf.loss, 10);
  }
});

test('native reset transitions discard pending Surf, completed Surf and per-surface visits', () => {
  for (const event of ['start', 'teleport', 'fall', 'stage-restarted', 'start-return',
    'stage-return', 'restart', 'practice-restore']) {
    const metrics = createMetrics();
    const game = mappedSession();
    for (let i = 0; i < 4; i++) coastContact(metrics, game);
    leaveRamp(metrics, game);
    for (let i = 0; i < 4; i++) coastContact(metrics, game);
    const result = coastContact(metrics, game, { events: [event] });
    assert.equal(result.surf.available, false);
    assert.equal(result.surf.sequence, 0);
    assert.equal(result.surf.tick, null);
    assert.equal(result.board.available, false);
    const restarted = coastContact(metrics, game);
    assert.equal(restarted.board.visit, 1);
    assert.equal(restarted.board.sequence, 1);
    leaveRamp(metrics, game);
    assert.equal(metrics.snapshot().surf.sequence, 0);
  }
});

test('Board route evidence follows real surface visits even if consumers miss earlier entries', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  const first = coastContact(metrics, game).board;
  assert.equal(first.routePrefix, `${JSON.stringify([first.surfaceId, 0, 1])};`);
  const next = coastContact(metrics, game, { contacts: [separateContact] }).board;
  const returned = coastContact(metrics, game).board;
  assert.equal(returned.routePrefix,
    `${first.routePrefix}${JSON.stringify([next.surfaceId, 0, 1])};${JSON.stringify([first.surfaceId, 0, 2])};`);
  game.checkpointSpeeds.push(100);
  coastContact(metrics, game, { contacts: [curveContact] });
  assert.equal(metrics.snapshot().board.routePrefix, returned.routePrefix);
  metrics.reset();
  const restarted = coastContact(metrics, game).board;
  assert.equal(restarted.routePrefix, `${JSON.stringify([restarted.surfaceId, 1, 1])};`);
});

test('unknown and ambiguous new episodes invalidate route evidence until run reset', () => {
  for (const contacts of [
    [{ normal: rampNormal, brushId: 'unknown' }],
    [rampContact, separateContact],
  ]) {
    const metrics = createMetrics();
    const game = mappedSession();
    coastContact(metrics, game);
    leaveRamp(metrics, game);
    coastContact(metrics, game, { contacts });
    leaveRamp(metrics, game);
    const next = coastContact(metrics, game).board;
    assert.equal(next.available, true);
    assert.notEqual(next.surfaceId, null);
    assert.equal(next.routePrefix, null);
    metrics.reset();
    assert.notEqual(coastContact(metrics, game).board.routePrefix, null);
  }
});

test('route evidence caps accepted entries while Board measurement and surface visit counting continue', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  let result;
  for (let i = 0; i < 257; i++) {
    result = coastContact(metrics, game, { contacts: [i % 2 ? separateContact : rampContact] });
    if (i === 255) assert.notEqual(result.board.routePrefix, null);
  }
  assert.equal(result.board.available, true);
  assert.equal(result.board.sequence, 257);
  assert.equal(result.board.visit, 129);
  assert.equal(result.board.routePrefix, null);
  close(result.board.loss, 10);
});

test('obstructions during a known-surface skip cannot replace its Board or manufacture an Air summary', () => {
  for (const impact of [
    clip(vector(1000), vector(900), [rampContact, { normal: vector(1, 0, 0) }]),
    { ...clip(vector(1000), vector(900)), blocked: true },
    { ...clip(vector(1000), vector(900), []), blocked: true },
    clip(vector(1000), vector(900), [rampContact, separateContact]),
  ]) {
    const metrics = createMetrics();
    const game = mappedSession();
    for (let i = 0; i < 4; i++) coastContact(metrics, game);
    const first = metrics.snapshot().board;
    for (let i = 0; i < 9; i++) tick(metrics, game, sample());
    const obstructed = tick(metrics, game, sample({ wishSpeed: 0, direction: vector() }), impact);
    assert.equal(obstructed.board.available, true);
    assert.equal(obstructed.board.sequence, first.sequence);
    assert.equal(obstructed.board.routePrefix, first.routePrefix);
    close(obstructed.board.loss, first.loss);
    assert.equal(obstructed.air.available, false);
    const continued = coastContact(metrics, game, { contacts: [curveContact] });
    assert.equal(continued.board.visit, 1);
    assert.equal(continued.board.sequence, 1);
    assert.equal(continued.air.available, false);
    const completed = leaveRamp(metrics, game).surf;
    assert.equal(completed.available, false);
    assert.equal(completed.unsupportedTicks, 1);
    assert.equal(completed.surfaceId, first.surfaceId);
  }
});

test('replaced sessions, state objects and tick discontinuities discard pending and completed Surf', () => {
  for (const replace of [
    game => mappedSession(),
    game => { game.state = { ...game.state }; return game; },
    game => { game.state.tick = 0; return game; },
  ]) {
    const metrics = createMetrics();
    let game = mappedSession();
    for (let i = 0; i < 4; i++) coastContact(metrics, game);
    leaveRamp(metrics, game);
    for (let i = 0; i < 4; i++) coastContact(metrics, game);
    game = replace(game);
    const result = coastContact(metrics, game);
    assert.equal(result.surf.available, false);
    assert.equal(result.surf.sequence, 0);
    assert.equal(result.surf.tick, null);
    assert.equal(result.board.sequence, 1);
    assert.equal(result.board.visit, 1);
    assert.equal(leaveRamp(metrics, game).surf.sequence, 0);
  }
});

test('a mixed ramp-floor landing invalidates Surf rather than treating the mixed clip as a pure ground boundary', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  for (let i = 0; i < 4; i++) coastContact(metrics, game);
  const board = metrics.snapshot().board;
  const result = coastContact(metrics, game, {
    contacts: [rampContact, { normal: vector(0, 0, 1), brushId: 'floor' }],
  });
  assert.equal(result.surf.available, false);
  assert.equal(result.surf.sequence, 1);
  assert.equal(result.surf.unsupportedTicks, 1);
  assert.equal(result.surf.tick, 5);
  assert.equal(result.board.sequence, board.sequence);
  assert.equal(result.board.routePrefix, board.routePrefix);
  close(result.board.loss, board.loss);
  assert.equal(coastContact(metrics, game).board.visit, 2);
});

test('deferred float32 air analysis retains native inputs through later velocity and config changes', () => {
  const physics = { ...config, dt: Math.fround(0.015), float32: true };
  const metrics = createMetrics();
  const game = session(physics);
  const before = vector(Math.fround(2134.125), Math.fround(-789.6875), Math.fround(123.25));
  const input = sample({ physics, before, direction: vector(Math.fround(0.6), Math.fround(0.8)) });
  const expected = tick(createMetrics(), session(physics), input).strafe;
  metrics.begin(game);
  metrics.acceleration(input);
  // Native gravity and later movement mutate the same vectors before end().
  input.before.x = input.after.x = input.after.z = 0;
  input.direction.x = 0;
  physics.float32 = false;
  physics.airCap = 100;
  game.state.tick++;
  metrics.end(game);
  assert.deepEqual(metrics.snapshot().strafe, expected);
});

test('deferred air analysis preserves all accepted accelerations within a completed tick', () => {
  const metrics = createMetrics();
  const game = session();
  const first = sample({ before: vector(1000), direction: vector(-1) });
  const second = sample({ before: first.after, direction: vector(1) });
  const firstResult = tick(createMetrics(), session(), first).strafe;
  const secondResult = tick(createMetrics(), session(), second).strafe;
  metrics.begin(game);
  metrics.acceleration(first);
  metrics.acceleration(second);
  game.state.tick++;
  metrics.end(game);
  const result = metrics.snapshot().strafe;
  close(result.gain, firstResult.gain + secondResult.gain);
  close(result.optimalGain, firstResult.optimalGain + secondResult.optimalGain);
  close(result.loss, firstResult.loss + secondResult.loss);
});

test('held and continuous float32 ramp ticks preserve the completed free-air summary', () => {
  for (const continuousFeedback of [false, true]) {
    const physics = { ...config, float32: true };
    const metrics = createMetrics({ continuousFeedback });
    const game = session(physics);
    const input = sample({ physics, before: vector(1000), direction: vector(-1) });
    const expected = tick(createMetrics(), session(physics), input).strafe;
    for (let i = 0; i < 4; i++) tick(metrics, game, input);
    const landed = tick(metrics, game, input, { ...clip(input.after, input.after), config: physics });
    close(landed.air.loss, 4 * expected.loss);
    close(landed.air.measuredSeconds, 4 * physics.dt);
    for (let i = 0; i < 8; i++) {
      const result = tick(metrics, game, input, { ...clip(input.after, input.after), config: physics });
      assert.deepEqual(result.air, landed.air);
      assert.equal(result.strafe.available, continuousFeedback);
    }
  }
});

test('Board revisions advance for entries, merged clips, invalidation and reset, not retained ticks', () => {
  const metrics = createMetrics();
  const game = session();
  const initial = metrics.boardRevision();
  tick(metrics, game, sample());
  assert.equal(metrics.boardRevision(), initial);
  const entry = coastContact(metrics, game).board;
  const entryRevision = metrics.boardRevision();
  assert.ok(entryRevision > initial);
  coastContact(metrics, game);
  assert.deepEqual(metrics.boardSnapshot(), entry);
  assert.equal(metrics.boardRevision(), entryRevision);
  tick(metrics, game);
  coastContact(metrics, game, { before: vector(800), after: vector(800) });
  const mergedRevision = metrics.boardRevision();
  assert.ok(mergedRevision > entryRevision);
  assert.equal(metrics.boardSnapshot().entryContacts, 2);
  leaveRamp(metrics, game);
  assert.equal(metrics.boardRevision(), mergedRevision);
  coastContact(metrics, game, { contacts: [rampContact, { normal: vector(1), brushId: 'wall' }] });
  assert.equal(metrics.boardSnapshot().available, false);
  const invalidRevision = metrics.boardRevision();
  assert.ok(invalidRevision > mergedRevision);
  tick(metrics, game);
  assert.equal(metrics.boardRevision(), invalidRevision);
  metrics.reset();
  const resetRevision = metrics.boardRevision();
  assert.ok(resetRevision > invalidRevision);
  assert.equal(metrics.boardSnapshot().sequence, 0);
  metrics.reset();
  assert.ok(metrics.boardRevision() > resetRevision);
});

test('collision contact offsets exclude earlier contacts and preserve empty-suffix blocking', () => {
  const metrics = createMetrics();
  const game = session();
  const contacts = [{ normal: vector(1), brushId: 'old-wall' }, rampContact];
  const result = tick(metrics, game, undefined, {
    ...clip(vector(1000), vector(900), contacts), firstContact: 1,
  });
  assert.equal(result.board.available, true);
  close(result.board.loss, 100);
  const retained = result.board;
  const blocked = tick(metrics, game, sample(), {
    ...clip(vector(1000), vector(900), contacts), firstContact: contacts.length, blocked: true,
  });
  assert.equal(blocked.strafe.available, false);
  assert.deepEqual(blocked.board, retained);
});

function observedGame() {
  class Movement {
    constructor() { this.config = config; }
    accelerate(state, direction, wishSpeed, airborne, returned) {
      assert.equal(this.config, config);
      const input = sample({ before: state.velocity, direction, wishSpeed, airborne,
        physics: this.config, surfaceFriction: state.surfaceFriction });
      Object.assign(state.velocity, input.after);
      return returned;
    }
    slide(state, result, change) {
      assert.equal(this.config, config);
      if (change.velocity) Object.assign(state.velocity, change.velocity);
      result.contacts.push(...(change.contacts ?? []));
      result.blocked = change.blocked ?? false;
      return change.returned;
    }
  }
  class Session {
    constructor() {
      Object.assign(this, session());
      this.state.surfaceFriction = 1;
      this.movement = new Movement();
    }
    step(command, events = []) {
      command(this.movement, this.state);
      this.state.tick++;
      return events;
    }
    restart(returned) { return returned; }
    restorePractice(returned) { return returned; }
    loadReplay(returned) { return returned; }
    visitStation(returned) { return returned; }
  }
  const game = new Session();
  return { game, adapter: { Session, Movement, getSession: () => game } };
}

test('observer preserves native arguments/results and measures only appended airborne slide contacts', () => {
  const { game, adapter } = observedGame();
  const metrics = createMetrics();
  const observer = observePhysics(adapter, metrics);
  try {
    const events = [];
    const returned = {};
    const nativeResult = game.step((movement, state) => {
      assert.equal(movement.accelerate(state, vector(1), 260, true, returned), returned);
      const contacts = [{ normal: vector(1), brushId: 'previous-wall' }];
      assert.equal(movement.slide(state, { contacts }, {
        velocity: vector(900), contacts: [rampContact], returned,
      }), returned);
      // A grounded walk probe is discarded rather than added to the board.
      movement.slide({ grounded: true, velocity: vector(900) }, { contacts: [] }, {
        velocity: vector(100), contacts: [rampContact],
      });
      state.velocity.z -= 6;
    }, events);
    assert.equal(nativeResult, events);
    assert.equal(observer.healthy, true);
    const result = metrics.snapshot();
    assert.equal(result.board.available, true);
    close(result.board.loss, 100);
    close(result.board.speedAfter, 900);
    assert.equal(result.strafe.available, false);
  } finally { observer.destroy(); }
});

test('reference observation matches live Board and Surf when a grounded tick jumps onto a ramp', () => {
  const results = [];
  for (const referenceOnly of [false, true]) {
    const { game, adapter } = observedGame();
    const metrics = createMetrics({}, { referenceOnly });
    // begin() sees the grounded pre-step state; accelerate() is the first
    // observation that establishes the native jump's airborne movement.
    game.state.grounded = true;
    const observer = observePhysics(adapter, metrics);
    try {
      let entry;
      for (const speed of [900, 850, 800, 750]) {
        game.step((movement, state) => {
          state.grounded = false;
          movement.accelerate(state, vector(1), 260, true);
          movement.slide(state, { contacts: [] }, { velocity: vector(speed), contacts: [rampContact] });
        });
        entry ??= metrics.boardSnapshot();
      }
      game.step(() => {}, ['finish']);
      const result = metrics.snapshot();
      assert.equal(observer.healthy, true);
      assert.equal(entry.available, true);
      assert.equal(entry.tick, 1);
      close(entry.loss, 100);
      assert.equal(result.surf.available, true);
      close(result.surf.loss, 250);
      close(result.surf.measuredSeconds, 4 * config.dt);
      results.push({ entry, board: result.board, surf: result.surf });
    } finally { observer.destroy(); }
  }
  assert.deepEqual(results[1], results[0]);
});

test('nested shadow observers preserve live measurements and restore synchronously', () => {
  const { game, adapter } = observedGame();
  const liveMetrics = createMetrics();
  const shadowMetrics = createMetrics({}, { referenceOnly: true });
  const nativeStep = adapter.Session.prototype.step;
  const nativeSlide = adapter.Movement.prototype.slide;
  const nativeAccelerate = adapter.Movement.prototype.accelerate;
  const live = observePhysics(adapter, liveMetrics);
  const shadow = new adapter.Session();
  const shadowObserver = observePhysics({ ...adapter, getSession: () => shadow }, shadowMetrics);
  try {
    const boardStep = (movement, state) => {
      movement.accelerate(state, vector(1), 260, true);
      movement.slide(state, { contacts: [] }, { velocity: vector(900), contacts: [rampContact] });
    };
    game.step(() => shadow.step(boardStep));
    assert.equal(liveMetrics.boardSnapshot().available, false);
    assert.equal(shadowMetrics.boardSnapshot().available, true);
    const sentinel = new Error('native step failed');
    assert.throws(() => shadow.step(() => { throw sentinel; }), error => error === sentinel);
    shadowObserver.destroy();
    game.step(boardStep);
    assert.equal(liveMetrics.boardSnapshot().available, true);
    assert.equal(live.healthy, true);
  } finally {
    shadowObserver.destroy();
    live.destroy();
  }
  assert.equal(adapter.Session.prototype.step, nativeStep);
  assert.equal(adapter.Movement.prototype.slide, nativeSlide);
  assert.equal(adapter.Movement.prototype.accelerate, nativeAccelerate);
});

test('observer analysis failures remain fail-open even when diagnostics throw', () => {
  for (const method of ['begin', 'acceleration', 'collision', 'end', 'reset']) {
    const { game, adapter } = observedGame();
    const metrics = createMetrics();
    let errors = 0;
    const sentinel = new Error(method);
    const observed = { ...metrics, [method]() { throw sentinel; } };
    const observer = observePhysics(adapter, observed, {
      onError(error) { assert.equal(error, sentinel); errors++; throw new Error('diagnostic failed'); },
    });
    const events = [];
    try {
      assert.equal(game.step((movement, state) => {
        movement.accelerate(state, vector(-1), 260, true);
        movement.slide(state, { contacts: [] }, { velocity: vector(400), contacts: [rampContact] });
      }, events), events);
      if (method === 'reset') assert.equal(game.restart(true), true);
      assert.equal(game.state.tick, 1);
      assert.equal(game.state.velocity.x, 400);
      assert.equal(observer.healthy, false);
      assert.equal(errors, 1);
      game.step(() => {});
      assert.equal(game.state.tick, 2);
      assert.equal(errors, 1);
    } finally {
      // The failing reset is an injected analysis callback, not teardown work.
      observed.reset = metrics.reset;
      observer.destroy();
    }
  }
});

test('observer restores prior native methods when installation fails partway through', () => {
  const { adapter } = observedGame();
  const nativeStep = adapter.Session.prototype.step;
  const nativeAccelerate = adapter.Movement.prototype.accelerate;
  const nativeSlide = adapter.Movement.prototype.slide;
  delete adapter.Session.prototype.loadReplay;
  assert.throws(() => observePhysics(adapter, createMetrics()), /Unsupported Surfd observer method: loadReplay/);
  assert.equal(adapter.Session.prototype.step, nativeStep);
  assert.equal(adapter.Movement.prototype.accelerate, nativeAccelerate);
  assert.equal(adapter.Movement.prototype.slide, nativeSlide);
});

function phaseSplit(entry, contacts, gravity = config.gravity) {
  const energy = ({ speed, z }) => speed * speed + 2 * gravity * z;
  const low = contacts.reduce((best, item) => item.z < best.z ? item : best);
  const exit = contacts.at(-1);
  const expected = Math.sqrt(entry.speed ** 2 + 2 * gravity * (entry.z - exit.z));
  const scale = expected + exit.speed;
  return { loss: expected - exit.speed, down: (energy(entry) - energy(low)) / scale, up: (energy(low) - energy(exit)) / scale };
}

test('Down and Up split a visit at its lowest contact and add up exactly to Surf', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  game.state.position.z = 1000;
  const contacts = [{ speed: 1060, z: 900 }, { speed: 1200, z: 700 }, { speed: 1230, z: 650 }, { speed: 1100, z: 800 }, { speed: 960, z: 950 }];
  for (const { speed, z } of contacts) endpointContact(metrics, game, vector(speed * 0.6, 0, speed * 0.8), z);
  const result = leaveRamp(metrics, game).surf;
  const expected = phaseSplit({ speed: 1000, z: 1000 }, contacts);
  assert.equal(result.available, true);
  close(result.loss, expected.loss);
  close(result.downLoss, expected.down);
  close(result.upLoss, expected.up);
  close(result.downLoss + result.upLoss, result.loss);
  close(result.lowHeightDelta, -350);
  assert.ok(result.downLoss > 0 && result.upLoss > 0);
});

test('a climbed-only ramp keeps its board clip in Down; a ramp left at its bottom has zero Up', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  const climb = [{ speed: 990, z: 10 }];
  for (let z = 30; z <= 90; z += 20) climb.push({ speed: Math.sqrt(990 ** 2 - 2 * config.gravity * (z - 10)), z });
  for (const { speed, z } of climb) endpointContact(metrics, game, vector(speed), z);
  const climbed = leaveRamp(metrics, game).surf;
  const expected = phaseSplit({ speed: 1000, z: 0 }, climb);
  close(climbed.downLoss, expected.down);
  close(climbed.upLoss, 0, 1e-9);
  close(climbed.downLoss + climbed.upLoss, climbed.loss);
  assert.ok(climbed.downLoss > 0);

  const drop = createMetrics();
  const dropGame = mappedSession();
  dropGame.state.position.z = 500;
  for (const { speed, z } of [{ speed: 1050, z: 450 }, { speed: 1100, z: 380 }, { speed: 1150, z: 300 }]) {
    endpointContact(drop, dropGame, vector(speed), z);
  }
  const dropped = leaveRamp(drop, dropGame).surf;
  close(dropped.upLoss, 0);
  close(dropped.downLoss, dropped.loss);
});

test('hidden Ramp skips endpoint tracking; enabling it mid-visit publishes that visit as unavailable', () => {
  const settings = { showSurf: false };
  const metrics = createMetrics(settings);
  const game = mappedSession();
  for (const speed of [990, 985]) endpointContact(metrics, game, vector(speed));
  settings.showSurf = true;
  for (const speed of [980, 975]) endpointContact(metrics, game, vector(speed));
  const partial = leaveRamp(metrics, game).surf;
  assert.equal(partial.sequence, 1);
  assert.equal(partial.available, false);
  assert.equal(partial.loss, null);
  assert.equal(partial.downLoss, null);
  assert.equal(partial.reason, 'not-tracked-while-hidden');
  game.state.velocity = vector(1000);
  for (const speed of [990, 985, 980, 975]) endpointContact(metrics, game, vector(speed), 0, [separateContact]);
  const tracked = leaveRamp(metrics, game).surf;
  assert.equal(tracked.available, true);
  close(tracked.loss, 25);
  // Board and visit identity keep working while Ramp is hidden.
  assert.equal(metrics.snapshot().board.available, true);
});

test('hidden Air computes no optimum; a flight enabled mid-way is unavailable, the next one complete', () => {
  const settings = { showAir: false };
  const metrics = createMetrics(settings);
  const game = mappedSession();
  for (let i = 0; i < 4; i++) coastContact(metrics, game);
  for (let i = 0; i < 20; i++) assert.equal(tick(metrics, game, sample()).status, 'hidden');
  settings.showAir = true;
  for (let i = 0; i < 6; i++) tick(metrics, game, sample());
  const partial = coastContact(metrics, game, { contacts: [separateContact] }).air;
  assert.equal(partial.available, false);
  assert.equal(partial.sequence, 1);
  for (let i = 0; i < 17; i++) tick(metrics, game, sample());
  const landed = coastContact(metrics, game).air;
  assert.equal(landed.available, true);
  assert.equal(landed.sequence, 2);
  close(landed.measuredSeconds, 0.255);
});

test('hidden HUD or all-hidden feedback leaves metrics idle; resuming mid-run cannot claim a reference visit', () => {
  for (const hidden of [{ hud: false }, { showBoard: false, showAir: false, showSurf: false }]) {
    const settings = { ...hidden };
    const metrics = createMetrics(settings);
    const game = mappedSession();
    const idle = coastContact(metrics, game);
    assert.equal(idle.board.available, false);
    assert.equal(idle.status, 'waiting');
    Object.assign(settings, { hud: true, showBoard: true, showAir: true, showSurf: true });
    const resumed = coastContact(metrics, game).board;
    assert.equal(resumed.available, true);
    assert.equal(resumed.routePrefix, null);
    tick(metrics, game, null, null, ['start']);
    const fresh = coastContact(metrics, game, { contacts: [separateContact] }).board;
    assert.equal(typeof fresh.routePrefix, 'string');
    assert.equal(fresh.visit, 1);
  }
});

test('live ramp Input runs only with Live feedback and Ramp both enabled', () => {
  const settings = { continuousFeedback: true, showSurf: false };
  const metrics = createMetrics(settings);
  const game = mappedSession();
  const input = sample({ before: vector(1000), direction: vector(0, 1) });
  const contact = () => tick(metrics, game, input, clip(input.after, vector(input.after.x, input.after.y * 0.5, 0)));
  assert.equal(contact().strafe.available, false);
  settings.showSurf = true;
  assert.equal(contact().strafe.available, true);
});

test('disabling analysis releases the previous Session before caching inactive replay feedback', () => {
  const settings = {};
  const metrics = createMetrics(settings);
  const previous = mappedSession();
  coastContact(metrics, previous);
  assert.equal(metrics.saveState().previousSession, previous);
  settings.hud = false;
  const current = mappedSession();
  tick(metrics, current);
  const inactive = metrics.saveState();
  assert.equal(inactive.previousSession, null);
  metrics.restoreState(inactive);
  settings.hud = true;
  const resumed = coastContact(metrics, current).board;
  assert.equal(resumed.available, true);
  assert.equal(resumed.routePrefix, null);
});

test('metrics checkpoints require completed ticks and restore empty or idle state', () => {
  const settings = {};
  const metrics = createMetrics(settings);
  const game = mappedSession();
  const empty = metrics.saveState();
  const expected = metrics.snapshot();
  metrics.begin(game);
  assert.throws(() => metrics.saveState(), /unfinished metrics tick/);
  metrics.restoreState(empty);
  assert.deepEqual(metrics.snapshot(), expected);
  coastContact(metrics, game);
  assert.equal(metrics.boardSnapshot().available, true);
  settings.hud = false;
  tick(metrics, game);
  const idle = metrics.saveState();
  assert.equal(metrics.snapshot().active, false);
  settings.hud = true;
  coastContact(metrics, game);
  metrics.restoreState(idle);
  assert.equal(metrics.snapshot().active, false);
  const resumed = coastContact(metrics, game).board;
  assert.equal(resumed.available, true);
  assert.equal(resumed.routePrefix, null);
});

test('cold replay keyframes suppress an interrupted ramp, then measure complete later segments without claiming route grades', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  game.state.tick = 1024;
  metrics.reset({replayGap: true});
  for (let i = 0; i < 4; i++) {
    const result = coastContact(metrics, game);
    assert.equal(result.board.available, false);
    assert.notEqual(result.ramp.kind, 'board');
  }
  const partial = leaveRamp(metrics, game).surf;
  assert.equal(partial.available, false);
  assert.equal(partial.loss, null);
  assert.equal(partial.downLoss, null);
  assert.equal(partial.upLoss, null);
  assert.equal(partial.reason, 'replay-gap');
  for (let i = 0; i < 4; i++) tick(metrics, game, sample());
  const entry = coastContact(metrics, game, {contacts: [separateContact]});
  assert.equal(entry.board.available, true);
  assert.equal(entry.board.routePrefix, null);
  assert.equal(entry.air.available, true);
  for (let i = 0; i < 3; i++) coastContact(metrics, game, {contacts: [separateContact]});
  const complete = leaveRamp(metrics, game).surf;
  assert.equal(complete.available, true);
  assert.equal(complete.routePrefix, null);
  tick(metrics, game, null, null, ['start']);
  const restarted = coastContact(metrics, game);
  assert.equal(restarted.board.available, true);
  assert.equal(typeof restarted.board.routePrefix, 'string');
  assert.notEqual(restarted.board.routePrefix, '');
});

test('a saveloc loaded mid-ramp suppresses that ramp, then grades the next one as usual', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  game.state.tick = 1024;
  metrics.reset({partial: true});
  for (let i = 0; i < 4; i++) {
    const result = coastContact(metrics, game);
    assert.equal(result.board.available, false);
  }
  const partial = leaveRamp(metrics, game).surf;
  assert.equal(partial.available, false);
  assert.equal(partial.loss, null);
  for (let i = 0; i < 4; i++) tick(metrics, game, sample());
  // Unlike a cold replay seek, later ramps keep their route: practice is graded against PB/WR.
  const entry = coastContact(metrics, game, {contacts: [separateContact]});
  assert.equal(entry.board.available, true);
  assert.equal(typeof entry.board.routePrefix, 'string');
  assert.notEqual(entry.board.routePrefix, '');
  for (let i = 0; i < 3; i++) coastContact(metrics, game, {contacts: [separateContact]});
  const complete = leaveRamp(metrics, game).surf;
  assert.equal(complete.available, true);
  assert.equal(typeof complete.routePrefix, 'string');
});

test('cold replay keyframes discard only the first incomplete flight and preserve gap guards through analysis checkpoints', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  metrics.reset({replayGap: true});
  for (let i = 0; i < 20; i++) tick(metrics, game, sample());
  const saved = metrics.saveState();
  metrics.reset();
  metrics.restoreState(saved);
  const first = coastContact(metrics, game);
  assert.equal(first.air.available, false);
  assert.equal(first.board.available, true);
  assert.equal(first.board.routePrefix, null);
  leaveRamp(metrics, game);
  for (let i = 0; i < 4; i++) tick(metrics, game, sample());
  const next = coastContact(metrics, game, {contacts: [separateContact]});
  assert.equal(next.air.available, true);
  assert.equal(next.board.available, true);
});

test('cold replay gap guards survive disabled analysis without making disabled ticks do measurement work', () => {
  const settings = {hud: false};
  const metrics = createMetrics(settings);
  const game = mappedSession();
  metrics.reset({replayGap: true});
  for (let i = 0; i < 10; i++) coastContact(metrics, game);
  assert.equal(metrics.snapshot().active, false);
  assert.equal(metrics.saveState().elapsed, 0);
  settings.hud = true;
  const resumed = coastContact(metrics, game);
  assert.equal(resumed.board.available, false);
  assert.equal(resumed.air.available, false);
});

test('a real surface transition after a cold replay seek opens a complete subsequent ramp without waiting for an air gap', () => {
  const metrics = createMetrics();
  const game = mappedSession();
  metrics.reset({replayGap: true});
  for (let i = 0; i < 4; i++) coastContact(metrics, game);
  const next = coastContact(metrics, game, {contacts: [separateContact]});
  assert.equal(next.board.available, true);
  assert.equal(next.board.routePrefix, null);
  for (let i = 0; i < 3; i++) coastContact(metrics, game, {contacts: [separateContact]});
  const complete = leaveRamp(metrics, game).surf;
  assert.equal(complete.available, true);
  assert.equal(complete.routePrefix, null);
});
