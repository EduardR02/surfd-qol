import {describe, expect, test} from 'bun:test';
import {createStrafePreview, strafeTick} from '../src/strafe-preview.js';

const config = {dt: Math.fround(0.015), maxSpeed: 260, airCap: 30, airAccelerate: 150,
  accelerate: 5, friction: 4, stopSpeed: 75, standHeight: 62, duckHeight: 45, float32: true};

function fixture() {
  const events = new EventTarget();
  events.document = new EventTarget();
  const frames = new Map(), updates = [], states = [];
  let sequence = 0;
  const session = {config, map: {zones: [{kind: 'start', min: {x: -100, y: -100, z: -10}, max: {x: 100, y: 100, z: 100}}]},
    state: {position: {x: 0, y: 0, z: 0}, velocity: {x: 0, y: 0, z: 0}, grounded: true, surfaceFriction: 1},
    timer: {state: {phase: 'ready'}}};
  let view = {yaw: 73, pitch: 12}, viewed = {target: null, view: null}, replay = null;
  const input = {keys: new Set(), wheelPending: new Set(), turnLeft: {held: new Set()}, turnRight: {held: new Set()}};
  const adapter = {getSession: () => session, getInput: () => input, getView: () => viewed,
    replay: {playback: () => ({replay})}, previewView: {get: () => ({...view}), set: next => {view = {...next}; updates.push(view);}}};
  const preview = createStrafePreview({getAdapter: () => adapter, events,
    requestFrame: callback => {frames.set(++sequence, callback); return sequence;}, cancelFrame: id => frames.delete(id)});
  preview.subscribe(state => states.push(state));
  return {preview, events, session, input, adapter, frames, updates, states, view: () => view,
    spectate: () => {viewed.target = 'other';}, replay: () => {replay = {};},
    frame(now) {const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(now);}};
}

describe('perfect strafe model', () => {
  test('air uses the perpendicular cap clip, not the full acceleration budget', () => {
    for (const speed of [300, 1000, 3000]) {
      const result = strafeTick(speed, 'air', config);
      expect(result.speed).toBeCloseTo(Math.hypot(speed, 30), 6);
      expect(result.turnRate).toBeCloseTo(Math.atan2(30, speed) * 180 / Math.PI / config.dt, 6);
    }
  });
  test('ground applies friction before optimizing the capped acceleration', () => {
    const speed = 3000;
    const before = Math.fround(speed * (1 - config.friction * config.dt));
    const amount = Math.fround(Math.fround(config.accelerate * config.dt) * config.maxSpeed);
    const projection = config.maxSpeed - amount;
    const expected = Math.sqrt(before * before + 2 * amount * projection + amount * amount);
    const result = strafeTick(speed, 'ground', config);
    expect(result.speed).toBeCloseTo(expected, 3);
    expect(result.speed).toBeLessThan(speed);
  });
  test('low-speed ground accelerates straight until lateral strafing can help', () => {
    const result = strafeTick(1, 'ground', config);
    expect(result.turnRate).toBe(0);
    expect(result.speed).toBeCloseTo(19.5, 4);
  });
});

describe('camera-only strafe preview', () => {
  test('idle schedules no work, active simulation alternates and leaves player vectors untouched', async () => {
    const f = fixture(), before = structuredClone(f.session.state);
    expect(f.frames.size).toBe(0);
    await f.preview.start({units: 300, mode: 'air'});
    for (let now = 0; now <= 1000; now += 16) f.frame(now);
    expect(new Set(f.states.map(state => state.key))).toEqual(new Set(['A', 'D']));
    expect(f.states.at(-1).speed).toBeGreaterThan(300);
    expect(f.view().pitch).toBe(12);
    expect(f.session.state).toEqual(before);
    expect(f.input.keys.size).toBe(0);
    f.preview.stop();
    expect(f.frames.size).toBe(0);
    expect(f.view()).toEqual({yaw: 73, pitch: 12});
    expect(f.states.at(-1)).toEqual({active: false});
  });
  for (const type of ['keydown', 'keyup', 'mousedown', 'mouseup', 'pointerdown', 'mousemove', 'pointermove', 'wheel', 'blur']) {
    test(`${type} immediately cancels and restores once`, async () => {
      const f = fixture();
      await f.preview.start({units: 300, mode: 'air'});
      f.frame(0); f.frame(32);
      expect(f.view().yaw).not.toBe(73);
      f.events.dispatchEvent(new Event(type));
      expect(f.preview.active).toBe(false);
      expect(f.view()).toEqual({yaw: 73, pitch: 12});
      expect(f.frames.size).toBe(0);
      f.preview.stop(); f.events.dispatchEvent(new Event(type));
      expect(f.states.filter(state => !state.active)).toEqual([{active: false}]);
    });
  }
  for (const mutate of [
    f => {f.session.state.velocity.x = 0.001;},
    f => {f.session.state.grounded = false;},
    f => {f.session.state.position.x = 200;},
    f => {f.session.timer.state.phase = 'running';},
    f => {f.session.practice = true;},
    f => {f.session.config = {...config, unrestrictedStart: true};},
    f => {f.session.timer.state.invalidReason = 'invalid';},
    f => {f.input.keys.add('KeyW');},
    f => {f.input.turnLeft.held.add('ArrowLeft');},
    f => {f.input.turnRight.held.add('ArrowRight');},
    f => {f.session.state.ducked = true;},
    f => f.spectate(), f => f.replay(), f => {delete f.adapter.previewView;},
  ]) {
    test('rejects an unsafe start without scheduling frames', async () => {
      const f = fixture(); mutate(f);
      await expect(f.preview.start({units: 300, mode: 'ground'})).rejects.toThrow('Stand still in the start zone first.');
      expect(f.frames.size).toBe(0);
    });
  }
  test('leaving ready state cancels before another camera frame', async () => {
    const f = fixture();
    await f.preview.start({units: 1000, mode: 'ground'});
    f.frame(0); f.frame(32);
    f.session.timer.state.phase = 'running';
    f.preview.check();
    expect(f.view()).toEqual({yaw: 73, pitch: 12});
    expect(f.frames.size).toBe(0);
  });
  test('missing camera setter fails open and restores if a later update fails', async () => {
    const f = fixture();
    await f.preview.start({units: 1000, mode: 'ground'});
    f.adapter.previewView.set = () => {throw new Error('native changed');};
    f.frame(0);
    expect(f.preview.active).toBe(false);
    expect(f.states.at(-1)).toEqual({active: false});
    expect(f.frames.size).toBe(0);
  });
  test('speed validation and unsubscribe have no idle work', async () => {
    const f = fixture();
    for (const units of [0, -1, NaN, Infinity, 5001, '300']) {
      await expect(f.preview.start({units, mode: 'air'})).rejects.toThrow('Enter a speed from 1 to 5000 units.');
    }
    const received = [];
    const unsubscribe = f.preview.subscribe(state => received.push(state));
    unsubscribe();
    await f.preview.start({units: 300, mode: 'ground'});
    f.frame(0); f.preview.destroy();
    expect(received).toEqual([]);
    expect(f.frames.size).toBe(0);
  });
});
