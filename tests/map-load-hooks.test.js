import {expect, test} from 'bun:test';
import {decodeMapImage, prepareMapRenderer} from '../extension/map-load-hooks.js';

function fixture() {
  let clock = 0, alive = true;
  const queue = [], objects = Array.from({length: 25}, () => ({isMesh: true}));
  const textures = new Set(Array.from({length: 5}, () => ({})));
  const uploaded = new Set(), warmed = new Set();
  const viewport = {x: 3, y: 7, z: 900, w: 600};
  let scissor = {...viewport}, testScissor = false, frames = 0;
  const state = {
    get frames() { return frames; }, get queued() { return queue.length; },
    get scissor() { return scissor; }, get tested() { return testScissor; },
    uploaded, warmed, objects, textures,
    dispose() { alive = false; },
    next(deadline = null) { queue.shift()?.(deadline); },
    finish() { let remaining = 100; while (queue.length && remaining--) state.next(); expect(queue).toEqual([]); },
  };
  const config = {
    renderer: {
      compile() {},
      initTexture(texture) { uploaded.add(texture); clock += 3; },
      getScissor(target) { return target.copy(scissor); },
      getScissorTest() { return testScissor; },
      setScissor(x, y, z, w) { scissor = {x, y, z, w}; },
      setScissorTest(value) { testScissor = value; },
    },
    scenes: [{traverse(visit) { objects.forEach(visit); }}], camera: {}, textures,
    alive: () => alive, schedule: callback => queue.push(callback), now: () => clock,
    render() { frames++; },
    warm(selected) {
      // Preparation may submit geometry but must not change any visible pixels.
      expect(testScissor).toBe(true);
      expect(scissor).toEqual({x: 0, y: 0, z: 0, w: 0});
      for (const object of selected) warmed.add(object);
      clock += 3;
    },
  };
  return {state, config};
}

test('first frame is available before background work and every remaining resource finishes', () => {
  const {state, config} = fixture();
  prepareMapRenderer(config);
  expect(state.frames).toBe(1);
  expect(state.uploaded.size).toBe(0);
  expect(state.warmed.size).toBe(0);
  state.next();
  expect(state.uploaded.size).toBe(1);
  expect(state.warmed.size).toBe(0);
  state.finish();
  expect(state.uploaded).toEqual(state.textures);
  expect(state.warmed).toEqual(new Set(state.objects));
  expect(state.scissor).toEqual({x: 3, y: 7, z: 900, w: 600});
  expect(state.tested).toBe(false);
  expect(state.frames).toBe(1);
});

test('an exhausted idle deadline defers work, but timeout callbacks still make progress', () => {
  const {state, config} = fixture();
  prepareMapRenderer(config);
  state.next({didTimeout: false, timeRemaining: () => 0});
  expect(state.uploaded.size).toBe(0);
  expect(state.queued).toBe(1);
  state.next({didTimeout: true, timeRemaining: () => 0});
  expect(state.uploaded.size).toBe(1);
  state.finish();
});

test('disposing a map prevents queued uploads and geometry work', () => {
  const {state, config} = fixture();
  prepareMapRenderer(config);
  state.next();
  state.dispose();
  state.finish();
  expect(state.uploaded.size).toBe(1);
  expect(state.warmed.size).toBe(0);
  const alreadyDisposed = fixture();
  alreadyDisposed.state.dispose();
  prepareMapRenderer(alreadyDisposed.config);
  expect(alreadyDisposed.state.frames).toBe(0);
  expect(alreadyDisposed.state.queued).toBe(0);
});

test('geometry warm-up restores an existing scissor even when rendering fails', () => {
  const {state, config} = fixture();
  config.textures = [];
  config.renderer.setScissorTest(true);
  config.warm = () => { throw Error('GPU failure'); };
  prepareMapRenderer(config);
  expect(() => state.next()).toThrow('GPU failure');
  expect(state.scissor).toEqual({x: 3, y: 7, z: 900, w: 600});
  expect(state.tested).toBe(true);
  expect(state.queued).toBe(0);
});

test('standalone injected preparation keeps its scheduling and cancellation behavior', () => {
  const standalone = Function(`return (${prepareMapRenderer.toString()})`)();
  const {state, config} = fixture();
  standalone(config);
  state.next();
  state.dispose();
  state.finish();
  expect(state.uploaded.size).toBe(1);
  expect(state.warmed.size).toBe(0);
});

async function withDecoder(decoder, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  Object.defineProperty(globalThis, 'createImageBitmap', {value: decoder, configurable: true});
  try { await run(); }
  finally {
    if (original) Object.defineProperty(globalThis, 'createImageBitmap', original);
    else delete globalThis.createImageBitmap;
  }
}

test('a map cancelled during bitmap decoding closes the completed bitmap and does not retry', async () => {
  const controller = new AbortController();
  let finish, closed = 0;
  await withDecoder(() => new Promise(resolve => { finish = resolve; }), async () => {
    const loading = decodeMapImage(new Uint8Array([1]), 'test.webp', controller.signal,
      () => { throw Error('Unexpected native retry'); });
    controller.abort(Error('Changed map'));
    finish({close() { closed++; }});
    await expect(loading).rejects.toThrow('Changed map');
    expect(closed).toBe(1);
  });
});

test('a decoder failure after cancellation preserves the cancellation rather than starting more work', async () => {
  const controller = new AbortController();
  let reject;
  await withDecoder(() => new Promise((_, fail) => { reject = fail; }), async () => {
    const loading = decodeMapImage(new Uint8Array([1]), 'test.png', controller.signal,
      () => { throw Error('Unexpected native retry'); });
    controller.abort(Error('Changed map'));
    reject(Error('Decode failed'));
    await expect(loading).rejects.toThrow('Changed map');
  });
});

test('unsupported bitmap decoding retains native image errors instead of swallowing them', async () => {
  for (const decoder of [undefined, () => Promise.reject(Error('Unsupported options'))]) {
    await withDecoder(decoder, async () => {
      await expect(decodeMapImage(new Uint8Array([1]), 'broken.webp', new AbortController().signal,
        () => Promise.reject(Error('Invalid image')))).rejects.toThrow('Invalid image');
    });
  }
});
