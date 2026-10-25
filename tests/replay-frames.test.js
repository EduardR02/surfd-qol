import {describe, expect, test, spyOn} from 'bun:test';
import {createFrames, freeze, thaw, FRAME_TICKS} from '../src/replay-frames.js';
import {createMetrics} from '../src/metrics.js';
import {createStartFeedback} from '../src/start.js';
import {observePhysics} from '../src/observer.js';

// A replay session whose state is how many commands it has played.
class Session {
  map = {id: 'utopia'}; config = {dt: 0.015}; commands = []; lastResult = {brush: {}};
  state = {x: 0, velocity: {x: 1}}; checkpointSpeeds = [];
  timer = {zones: ['start'], dt: 0.015, state: {phase: 'ready', splits: []}, prehops: 0};
  loadReplay() { this.commands = []; this.state = {x: 0, velocity: {x: 1}}; this.timer.state = {phase: 'ready', splits: []}; }
  step(command) {
    this.commands.push(command);
    this.state = {x: this.state.x + 1, velocity: {x: this.state.x}};
    if (this.commands.length === 300) { this.timer.state.splits.push(4.2); this.checkpointSpeeds.push(2500); }
    return this.commands.length === 50 ? ['start'] : [];
  }
}
const replay = {mapId: 'utopia', commands: Array.from({length: 600}, (_, i) => ({i}))};
const played = ticks => { const session = new Session(); for (let i = 0; i < ticks; i++) session.step(replay.commands[i]); return session; };

describe('replay snapshots', () => {
  test('restore everything a step depends on, and leave fixed fields alone', () => {
    const frame = freeze(played(200));
    const session = played(20);
    const zones = session.timer.zones;
    thaw(session, frame, replay, 200);
    expect(session).toMatchObject({state: {x: 200, velocity: {x: 199}}, commands: {length: 200}});
    expect(session.timer.zones).toBe(zones);
    // Restoring twice from one snapshot gives independent copies.
    session.state.velocity.x = -1;
    thaw(session, frame, replay, 200);
    expect(session.state.velocity.x).toBe(199);
  });

  test('a seek resumes from the latest snapshot after where it starts and up to the target', () => {
    const frames = createFrames(replay);
    const source = new Session();
    for (let i = 0; i < 500; i++) { source.step(replay.commands[i]); frames.keep(source, i + 1); }
    expect(frames.size).toBe(Math.floor(500 / FRAME_TICKS));
    const session = new Session();
    expect(frames.resume(session, 0, 300)).toBe(256);
    expect(session.state.x).toBe(256);
    expect(frames.resume(session, 256, 300)).toBe(-1);
    expect(frames.resume(session, 0, 100)).toBe(-1);
  });

  test('a session that cannot be copied just goes without snapshots', () => {
    const frames = createFrames(replay);
    const session = played(FRAME_TICKS);
    session.callback = () => {};
    frames.keep(session, FRAME_TICKS);
    expect(frames.size).toBe(0);
  });
});

// Use the real observer and both coaching controllers around deterministic
// native-like movement. The same ramp is visited repeatedly, including a
// checkpoint during its entry grace and another during a long surf episode.
function coachingGame() {
  const vector = (x = 0, y = 0, z = 0) => ({x, y, z});
  const normal = vector(0, 0.8, 0.6);
  const config = {dt: 0.015, gravity: 0, airAccelerate: 150, airCap: 30,
    groundNormal: 0.7, float32: false, standHeight: 62, duckHeight: 45, stepSize: 18};
  const zone = {kind: 'start', min: vector(-100, -100, 100), max: vector(100, 100, 200)};
  const map = {zones: [zone], brushes: [0, 100].map((x, i) => ({
    id: `ramp-${i}`, vertices: [vector(x), vector(x + 10), vector(x, -6, 8)],
    faces: [[0, 1, 2]], planes: [{normal, distance: 0}],
  }))};
  class Timer {
    zones = map.zones;
    dt = config.dt;
    state = {phase: 'ready', startTick: null, splits: []};
    phase = 'ready';
    startSpeedCap() { return 350; }
  }
  class Movement {
    config = config;
    accelerate(state, direction, wishSpeed) {
      const available = Math.min(wishSpeed, config.airCap) -
        (state.velocity.x * direction.x + state.velocity.y * direction.y);
      const amount = Math.max(0, Math.min(available, config.airAccelerate * config.dt * wishSpeed));
      state.velocity.x += direction.x * amount;
      state.velocity.y += direction.y * amount;
    }
    slide(state, result, brush) {
      if (brush === null) return;
      result.contacts.push({normal, brushId: `ramp-${brush}`});
      state.velocity.x *= 0.999;
    }
  }
  class CoachingSession {
    map = map;
    config = config;
    movement = new Movement();
    timer = new Timer();
    constructor() { this.loadReplay(); }
    loadReplay() {
      this.commands = [];
      this.checkpointSpeeds = [];
      this.state = {tick: 0, grounded: true, ducked: false, surfaceFriction: 1,
        velocity: vector(350), position: vector(0, 0, 100)};
      this.timer.state = {phase: 'ready', startTick: null, splits: []};
      this.timer.phase = 'ready';
      this.lastResult = null;
    }
    restart() { this.loadReplay(); }
    restorePractice() { return false; }
    visitStation() { return false; }
    step(command) {
      const tick = this.state.tick + 1;
      this.commands.push(command);
      this.state = {...this.state, velocity: {...this.state.velocity}, position: {...this.state.position}};
      this.state.grounded = tick < 3;
      const brush = tick >= 10 && tick <= 30 || tick >= 126 && tick <= 145 && tick !== 128 ||
        tick >= 250 && tick <= 270 || tick >= 385 && tick <= 410 ? 0 :
        tick >= 180 && tick <= 200 ? 1 : null;
      this.movement.accelerate(this.state, vector(0, 1), 260, !this.state.grounded);
      this.lastResult = {contacts: [], blocked: false, segments: []};
      this.movement.slide(this.state, this.lastResult, brush);
      this.state.position.z += tick % 20 < 10 ? -0.25 : 0.25;
      this.state.tick = tick;
      if (tick === 3) {
        this.timer.phase = this.timer.state.phase = 'running';
        this.timer.state.startTick = 2.5;
        this.lastResult.segments.push({from: vector(110, 0, 100), to: vector(122, 0, 100),
          startFraction: 0, endFraction: 1});
        return ['start'];
      }
      if (tick === 170 || tick === 300) {
        this.checkpointSpeeds.push(Math.hypot(this.state.velocity.x, this.state.velocity.y));
        this.timer.state.splits.push(tick * config.dt);
        return ['checkpoint'];
      }
      if (tick === 450) { this.timer.phase = this.timer.state.phase = 'finished'; return ['finish']; }
      return [];
    }
  }
  const session = new CoachingSession();
  return {session, adapter: {Session: CoachingSession, Movement, getSession: () => session}};
}

describe('replay coaching checkpoints', () => {
  test('backward cached seeks and following ticks match continuous full-HUD analysis', () => {
    const now = spyOn(performance, 'now').mockReturnValue(1000);
    const {session, adapter} = coachingGame();
    const metrics = createMetrics();
    const start = createStartFeedback();
    let saved = 0;
    let observedTicks = 0;
    const observer = observePhysics(adapter, metrics, {
      onTick(session, command, events) { observedTicks++; start.observe(session, events); },
      onReset() { start.reset(); },
    });
    const frames = createFrames(replay, {
      save() { saved++; return {metrics: metrics.saveState(), start: start.saveState()}; },
      restore(state) { metrics.restoreState(state.metrics); start.restoreState(state.start); },
    });
    const read = () => ({
      metrics: metrics.snapshot(), revision: metrics.boardRevision(), board: metrics.boardSnapshot(),
      surf: metrics.surfSnapshot(-1), start: start.snapshot(), state: structuredClone(session.state),
      timer: structuredClone(session.timer.state), speeds: [...session.checkpointSpeeds],
      commands: session.commands.length,
    });
    const continuous = new Map();
    try {
      for (let tick = 1; tick <= 500; tick++) {
        session.step(replay.commands[tick - 1]);
        frames.keep(session, tick);
        continuous.set(tick, read());
      }
      expect(saved).toBe(3);
      expect(frames.size).toBe(3);
      expect(continuous.get(128).board).toMatchObject({available: true, visit: 2, entryContacts: 1});
      expect(continuous.get(129).board.entryContacts).toBe(2);
      expect(continuous.get(256).board.visit).toBe(3);
      expect(continuous.get(384).metrics.strafe.available).toBe(true);
      expect(continuous.get(128).start.available).toBe(true);
      for (const target of [128, 129, 140, 146, 163, 180, 218, 256, 257, 271, 288, 384, 385, 420]) {
        session.loadReplay(replay);
        const before = observedTicks;
        const checkpoint = frames.resume(session, 0, target);
        expect(checkpoint).toBe(target - target % FRAME_TICKS);
        expect(observedTicks).toBe(before);
        expect(read()).toEqual(continuous.get(checkpoint));
        for (let tick = checkpoint + 1; tick <= target + 3; tick++) {
          session.step(replay.commands[tick - 1]);
          expect(read()).toEqual(continuous.get(tick));
        }
        expect(observedTicks - before).toBe(target + 3 - checkpoint);
      }
      expect(observer.healthy).toBe(true);
      // Reusing one checkpoint after many resumed episodes must not mutate it.
      session.loadReplay(replay);
      frames.resume(session, 0, 128);
      expect(read()).toEqual(continuous.get(128));
    } finally { observer.destroy(); now.mockRestore(); }
  });

  test('restoring coaching rebases event ages without copying native or borrowed state', () => {
    const now = spyOn(performance, 'now').mockReturnValue(1000);
    const {session, adapter} = coachingGame();
    const metrics = createMetrics();
    const start = createStartFeedback();
    const observer = observePhysics(adapter, metrics, {
      onTick(session, command, events) { start.observe(session, events); },
      onReset() { start.reset(); },
    });
    try {
      for (let tick = 1; tick <= 128; tick++) session.step(replay.commands[tick - 1]);
      now.mockReturnValue(1025);
      const native = freeze(session);
      const saved = metrics.saveState();
      const savedStart = start.saveState();
      const expected = metrics.snapshot();
      expect(saved.previousSession).toBe(session);
      expect(saved).not.toHaveProperty('previousState');
      expect(saved).not.toHaveProperty('accelerationInputs');
      expect(saved).not.toHaveProperty('tickPlane');
      expect(expected.ramp.available).toBe(true);
      expect(savedStart.age).toBe(25);
      session.loadReplay(replay);
      now.mockReturnValue(100000);
      thaw(session, native, replay, 128);
      metrics.restoreState(saved);
      start.restoreState(savedStart);
      expect(metrics.snapshot()).toEqual(expected);
      expect(start.snapshot()).toMatchObject({available: true, age: 25});
      now.mockReturnValue(101601);
      expect(metrics.snapshot().ramp.available).toBe(false);
      expect(observer.healthy).toBe(true);
    } finally { observer.destroy(); now.mockRestore(); }
  });

  test('coaching capture failure discards the cache rather than publishing a partial frame', () => {
    const frames = createFrames(replay, {save() { throw new Error('unavailable'); }});
    frames.keep(played(128), 128);
    expect(frames.size).toBe(0);
    expect(frames.resume(new Session(), 0, 128)).toBe(-1);
  });
});
