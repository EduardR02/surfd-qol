import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMapGpuPreparation, createProgressiveTextureBindings, loadNativeAtlas} from '../extension/progressive-textures.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return {promise, resolve, reject};
}

function fixture() {
  const controller = new AbortController(), finished = deferred();
  const gates = new Map(['visible', 'offscreen'].map(url => [url, deferred()]));
  const resources = {
    images: new Map(), compressed: new Map(), pendingCompressed: new Map(),
    pendingImages: new Map([...gates].map(([url, gate]) => [url, gate.promise])),
    signal: controller.signal, ready: finished.promise, prioritize() {},
    cancel() { controller.abort(new DOMException('Map disposed', 'AbortError')); }
  };
  const bindings = createProgressiveTextureBindings(resources);
  const textures = {};
  for (const url of gates.keys()) {
    const texture = textures[url] = {image: null};
    bindings.bind(texture, url, () => { texture.image = resources.images.get(url); });
  }
  const renderer = {renderBufferDirect() { throw new Error('Probe submitted a draw'); }};
  const nested = {value: {textures: [textures.visible]}};
  nested.value.cycle = nested;
  const draw = () => renderer.renderBufferDirect(null, null, null, {uniforms: {nested}});
  return {
    bindings, resources, textures, renderer, draw, finished, gates,
    publish(url) {
      const image = {url};
      resources.images.set(url, image);
      gates.get(url).resolve(image);
      return image;
    }
  };
}

test('the initial view waits for visible uniform textures but not offscreen resources', async () => {
  const run = fixture(), initial = run.bindings.prepare(run.renderer, run.draw);
  const visible = run.publish('visible');
  await initial;
  assert.equal(run.textures.visible.image, visible);
  assert.equal(run.textures.offscreen.image, null);
  const complete = run.bindings.complete();
  const offscreen = run.publish('offscreen');
  run.finished.resolve();
  await complete;
  assert.equal(run.textures.offscreen.image, offscreen);
});

test('a native traversal failure restores renderer submission before rejecting', async () => {
  const run = fixture(), original = run.renderer.renderBufferDirect;
  const failure = new Error('Native traversal failed');
  await assert.rejects(run.bindings.prepare(run.renderer, () => { throw failure; }), error => error === failure);
  assert.equal(run.renderer.renderBufferDirect, original);
  run.bindings.dispose();
});

test('disposing a waiting view rejects preparation and prevents late texture mutation', async () => {
  const run = fixture(), initial = run.bindings.prepare(run.renderer, run.draw);
  run.bindings.dispose();
  await assert.rejects(initial, {name: 'AbortError'});
  run.publish('visible');
  run.publish('offscreen');
  run.finished.resolve();
  await assert.rejects(run.bindings.complete(), {name: 'AbortError'});
  assert.equal(run.textures.visible.image, null);
  assert.equal(run.textures.offscreen.image, null);
});

test('a background decode failure remains observable after initial preparation succeeds', async () => {
  const run = fixture(), initial = run.bindings.prepare(run.renderer, run.draw);
  run.publish('visible');
  await initial;
  const failure = new Error('Offscreen decode failed');
  run.gates.get('offscreen').reject(failure);
  run.finished.reject(failure);
  await assert.rejects(run.bindings.complete(), error => error === failure);
  assert.equal(run.textures.offscreen.image, null);
});

test('an unsupported renderer keeps complete-resource readiness before returning', async () => {
  const run = fixture();
  let prepared = false;
  const initial = run.bindings.prepare({}, () => { throw new Error('Unsupported traversal'); })
    .then(() => { prepared = true; });
  run.publish('visible');
  await Promise.resolve();
  assert.equal(prepared, false);
  run.publish('offscreen');
  run.finished.resolve();
  await initial;
  assert.equal(run.textures.offscreen.image, run.resources.images.get('offscreen'));
});

async function withGpuQueue(run, {parallel = true, sync = true, count = 180, budget = Infinity, atlases = []} = {}) {
  const idleDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback');
  const cancelDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback');
  const callbacks = new Map();
  let nextId = 0, lost = false, linked = false, reads = 0, reflections = 0, disposals = 0;
  let fences = 0, waits = 0, flushes = 0, fenceStatus = 37148;
  const deletedFences = [];
  globalThis.requestIdleCallback = callback => { callbacks.set(++nextId, callback); return nextId; };
  globalThis.cancelIdleCallback = id => callbacks.delete(id);
  const assets = deferred(), material = new EventTarget(), camera = {};
  const program = {
    program: {},
    isReady() { assert.equal(parallel, true, 'Unsupported drivers must not be polled'); reads++; return linked; },
    getUniforms() { assert.equal(linked, true, 'Reflected uniforms before KHR completion'); reflections++; },
    getAttributes() { assert.equal(linked, true, 'Reflected attributes before KHR completion'); reflections++; }
  };
  const children = Array.from({length: count}, (_, index) => ({
    isMesh: true, visible: index % 2 === 0, frustumCulled: true, count: index % 3,
    geometry: {index: {}}, material, children: [],
    instanceMatrix: {array: Float32Array.from([index, -index, 1, 0])}
  }));
  const light = {isLight: true, visible: true, children: []};
  const hiddenLight = {isLight: true, visible: true, children: []};
  const scene = {isScene: true, visible: true, fog: {}, environment: {}, children: [
    light, {visible: false, children: [hiddenLight]}, ...children
  ]};
  for (const child of scene.children) {
    child.parent = scene;
    for (const nested of child.children) nested.parent = child;
  }
  const texture = {isTexture: true, loaded: false, version: 0};
  const sky = {isTexture: true, loaded: false, version: 0};
  scene.background = sky;
  const textures = new Map([['wall', texture], ['duplicate wall', texture]]);
  const uploaded = [], uploadedVersions = [], compiled = [], geometry = [], nativeLights = [];
  const context = {
    isContextLost: () => lost,
    SYNC_GPU_COMMANDS_COMPLETE: 37143, ALREADY_SIGNALED: 37146,
    TIMEOUT_EXPIRED: 37147, CONDITION_SATISFIED: 37148, WAIT_FAILED: 37149
  };
  if (sync) Object.assign(context, {
    fenceSync(condition, flags) {
      assert.equal(condition, context.SYNC_GPU_COMMANDS_COMPLETE);
      assert.equal(flags, 0);
      assert.equal(parallel && program.program !== undefined ? reflections > 0 : reflections === 0, true);
      return {id: ++fences};
    },
    clientWaitSync(fence, flags, timeout) {
      assert.equal(flags, 0);
      assert.equal(timeout, 0, 'GPU completion polling must never block');
      waits++;
      return fenceStatus;
    },
    deleteSync(fence) { deletedFences.push(fence); },
    flush() { flushes++; },
    finish() { throw new Error('Preparation blocked on gl.finish'); }
  });
  const renderer = {
    domElement: new EventTarget(),
    getContext: () => context,
    extensions: {get: () => parallel ? {} : null},
    properties: {get: () => ({programs: new Map([['native variant', program]])})},
    compile(root, receivedCamera, receivedScene) {
      assert.equal(receivedCamera, camera);
      assert.equal(receivedScene.fog, scene.fog);
      assert.equal(receivedScene.environment, scene.environment);
      receivedScene.traverseVisible(item => nativeLights.push(item));
      root.traverse(item => compiled.push(item));
      return new Set([material]);
    },
    __qolPrepareGeometry(object) { geometry.push(object); },
    initTexture(value) {
      assert.equal(value.loaded, true, 'Placeholder uploaded as final');
      uploaded.push(value);
      uploadedVersions.push(value.version);
    },
    render() { throw new Error('Preparation rendered a framebuffer'); },
    renderBufferDirect() { throw new Error('Preparation submitted a framebuffer draw'); },
    clear() { throw new Error('Preparation cleared a framebuffer'); },
    dispose() { disposals++; return 'native dispose'; }
  };
  const originalDispose = renderer.dispose;
  const preparation = createMapGpuPreparation(renderer, [scene], camera, [textures], () => assets.promise, null, atlases);
  function slice(time = budget) {
    const entry = callbacks.entries().next().value;
    assert.ok(entry, 'Expected scheduled GPU progress');
    callbacks.delete(entry[0]);
    entry[1]({timeRemaining: () => time});
  }
  function drain(maximum = 1000) {
    let count = 0;
    while (callbacks.size && count++ < maximum) slice();
    assert.ok(count < maximum, 'Preparation did not finish bounded slices');
  }
  async function publish() {
    texture.loaded = sky.loaded = true;
    assets.resolve();
    // The production queue observes readiness independently of entry.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
  try {
    await run({
      preparation, renderer, scene, children, light, hiddenLight, assets, callbacks, material, program, texture,
      uploaded, uploadedVersions, compiled, geometry, nativeLights, originalDispose, slice, drain, publish, deletedFences,
      link() { linked = true; }, get reads() { return reads; }, get reflections() { return reflections; },
      get disposals() { return disposals; }, get fences() { return fences; }, get waits() { return waits; },
      get flushes() { return flushes; },
      holdFence() { fenceStatus = context.TIMEOUT_EXPIRED; },
      signalFence() { fenceStatus = context.CONDITION_SATISFIED; },
      failFence() { fenceStatus = context.WAIT_FAILED; },
      loseContext(event = true) { lost = true; if (event) renderer.domElement.dispatchEvent(new Event('webglcontextlost')); }
    });
  } finally {
    preparation.dispose();
    if (idleDescriptor) Object.defineProperty(globalThis, 'requestIdleCallback', idleDescriptor);
    else delete globalThis.requestIdleCallback;
    if (cancelDescriptor) Object.defineProperty(globalThis, 'cancelIdleCallback', cancelDescriptor);
    else delete globalThis.cancelIdleCallback;
  }
}

test('post-entry preparation is deferred and bounded without rendering or changing native instance state', async () => {
  await withGpuQueue(async run => {
    const before = run.children.map(object => ({
      visible: object.visible, frustumCulled: object.frustumCulled, count: object.count,
      matrix: [...object.instanceMatrix.array]
    }));
    assert.equal(run.callbacks.size, 0);
    assert.equal(run.preparation.start(), run.preparation.ready);
    assert.equal(run.preparation.start(), run.preparation.ready);
    assert.equal(run.callbacks.size, 1);
    assert.equal(run.compiled.length, 0);
    run.slice();
    assert.ok(run.compiled.length < run.children.length);
    assert.ok(run.geometry.length < run.children.length);
    await run.publish();
    run.link();
    run.drain();
    await run.preparation.ready;
    assert.deepEqual(run.compiled, run.children);
    assert.deepEqual(run.geometry, run.children);
    assert.equal(run.uploaded.length, 2);
    assert.ok(run.nativeLights.length > 0);
    assert.ok(run.nativeLights.every(light => light === run.light));
    assert.deepEqual(run.children.map(object => ({
      visible: object.visible, frustumCulled: object.frustumCulled, count: object.count,
      matrix: [...object.instanceMatrix.array]
    })), before);
    assert.equal(run.renderer.dispose, run.originalDispose);
  });
});

test('geometry and shaders advance while assets are pending, but final texture uploads wait for publication', async () => {
  await withGpuQueue(async run => {
    run.preparation.start();
    run.drain();
    assert.equal(run.geometry.length, run.children.length);
    assert.equal(run.uploaded.length, 0);
    assert.equal(run.callbacks.size, 0, 'Waiting for assets must not spin an idle queue');
    await run.publish();
    run.link();
    assert.equal(run.callbacks.size, 1);
    run.drain();
    await run.preparation.ready;
    assert.equal(run.uploaded.length, 2);
  });
});

test('zero idle budget still makes forward progress and KHR completion polling remains bounded', async () => {
  await withGpuQueue(async run => {
    run.preparation.start();
    await run.publish();
    while (run.reads === 0) run.slice();
    let settled = false;
    run.preparation.ready.then(() => { settled = true; });
    const before = run.reads;
    run.slice();
    assert.ok(run.reads - before <= 1, 'A pending program must not be queried repeatedly in one slice');
    await Promise.resolve();
    assert.equal(settled, false);
    run.link();
    run.drain();
    await run.preparation.ready;
    assert.equal(run.geometry.length, run.children.length);
  }, {count: 3, budget: 0});
});

test('unsupported parallel compilation submits native compiles without blocking program queries', async () => {
  await withGpuQueue(async run => {
    run.preparation.start();
    await run.publish();
    run.drain();
    const result = await run.preparation.ready;
    assert.deepEqual(result, {uploadsComplete: true, shadersComplete: false, completion: 'submitted'});
    assert.equal(run.compiled.length, run.children.length);
    assert.equal(run.reads, 0);
  }, {parallel: false});
});

test('renderer disposal cancels queued work, restores its own disposal method and rejects readiness', async () => {
  await withGpuQueue(async run => {
    run.preparation.start();
    const queued = [...run.callbacks.values()];
    assert.equal(run.renderer.dispose(), 'native dispose');
    await assert.rejects(run.preparation.ready, {name: 'AbortError'});
    assert.equal(run.disposals, 1);
    assert.equal(run.renderer.dispose, run.originalDispose);
    assert.equal(run.callbacks.size, 0);
    await run.publish();
    for (const callback of queued) callback({timeRemaining: () => Infinity});
    assert.equal(run.compiled.length, 0);
    assert.equal(run.uploaded.length, 0);
  });
});

for (const event of [true, false]) {
  test(`context loss stops pending shader work ${event ? 'immediately' : 'at the next slice'}`, async () => {
    await withGpuQueue(async run => {
      run.preparation.start();
      await run.publish();
      while (run.reads === 0) run.slice();
      const reads = run.reads;
      run.loseContext(event);
      if (!event) run.slice();
      await assert.rejects(run.preparation.ready, {name: 'AbortError'});
      assert.equal(run.callbacks.size, 0);
      assert.equal(run.reads, reads);
      assert.equal(run.renderer.dispose, run.originalDispose);
    }, {count: 1});
  });
}

test('background asset failure rejects GPU completion with the original native failure', async () => {
  await withGpuQueue(async run => {
    run.preparation.start();
    run.drain();
    const failure = new Error('Native DDS validation failed');
    run.assets.reject(failure);
    await assert.rejects(run.preparation.ready, error => error === failure);
    assert.equal(run.uploaded.length, 0);
    assert.equal(run.callbacks.size, 0);
  });
});

test('an atomic upload error rejects preparation without hiding it or scheduling more work', async () => {
  await withGpuQueue(async run => {
    const failure = new Error('Native buffer upload failed');
    run.renderer.__qolPrepareGeometry = () => { throw failure; };
    run.preparation.start();
    await run.publish();
    run.drain();
    await assert.rejects(run.preparation.ready, error => error === failure);
    assert.equal(run.callbacks.size, 0);
    assert.equal(run.renderer.dispose, run.originalDispose);
  });
});

test('timer fallback remains deferred and restores inherited renderer disposal', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback');
  delete globalThis.requestIdleCallback;
  let uploads = 0;
  const dispose = () => 'native dispose';
  const renderer = Object.assign(Object.create({dispose}), {
    getContext: () => ({isContextLost: () => false}),
    extensions: {get: () => null},
    initTexture() { uploads++; }
  });
  const texture = {isTexture: true};
  const preparation = createMapGpuPreparation(renderer, [], {}, [new Map([['wall', texture]])], () => Promise.resolve());
  try {
    preparation.start();
    assert.equal(uploads, 0);
    await preparation.ready;
    assert.equal(uploads, 1);
    assert.equal(Object.hasOwn(renderer, 'dispose'), false);
    assert.equal(renderer.dispose, dispose);
  } finally {
    preparation.dispose();
    if (descriptor) Object.defineProperty(globalThis, 'requestIdleCallback', descriptor);
  }
});

test('scene-owned labels and nested uniforms upload without requiring BSP cache membership', async () => {
  await withGpuQueue(async run => {
    const label = {isTexture: true, loaded: true};
    const detail = {isTexture: true, loaded: true};
    const nested = {textures: [detail, label], ignored: new Float32Array(2000)};
    nested.cycle = nested;
    run.material.map = label;
    run.material.uniforms = {nested: {value: nested}};
    run.preparation.start();
    await run.publish();
    run.link();
    run.drain();
    await run.preparation.ready;
    assert.equal(run.uploaded.filter(texture => texture === label).length, 1);
    assert.equal(run.uploaded.filter(texture => texture === detail).length, 1);
  });
});

test('disposed dynamic materials and destroyed programs are not resurrected during preparation', async () => {
  await withGpuQueue(async run => {
    const retired = {isTexture: true, loaded: true};
    run.material.map = retired;
    run.preparation.start();
    run.drain(); // Collect/compile while decoding is still outstanding.
    run.material.dispatchEvent(new Event('dispose'));
    run.program.program = undefined; // Native WebGLProgram.destroy contract.
    await run.publish();
    run.drain();
    await run.preparation.ready;
    assert.equal(run.uploaded.includes(retired), false);
    assert.equal(run.reads, 0);
    assert.equal(run.reflections, 0);
  });
});

test('KHR readiness defers native reflection until linking finishes and reflects each program once', async () => {
  await withGpuQueue(async run => {
    run.preparation.start();
    await run.publish();
    while (run.reads === 0) run.slice();
    assert.equal(run.reflections, 0);
    run.link();
    run.drain();
    await run.preparation.ready;
    assert.equal(run.reflections, 2);
  });
});

test('native failed-shader diagnostics reject GPU readiness without a framebuffer draw', async () => {
  await withGpuQueue(async run => {
    run.program.diagnostics = {runnable: false};
    run.preparation.start();
    await run.publish();
    run.link();
    run.drain();
    await assert.rejects(run.preparation.ready, /shader failed to link/);
    assert.equal(run.fences, 0);
  });
});

test('GPU readiness waits for a flushed zero-timeout fence without blocking or busy polling', async () => {
  await withGpuQueue(async run => {
    run.holdFence();
    run.preparation.start();
    await run.publish();
    run.link();
    while (run.fences === 0) run.slice();
    assert.equal(run.flushes, 1);
    assert.equal(run.waits, 0);
    let complete = false;
    run.preparation.ready.then(() => { complete = true; });
    run.slice();
    assert.equal(run.waits, 1);
    await Promise.resolve();
    assert.equal(complete, false);
    run.signalFence();
    run.drain();
    assert.deepEqual(await run.preparation.ready,
      {uploadsComplete: true, shadersComplete: true, completion: 'gpu-complete'});
    assert.equal(run.deletedFences.length, 1);
  });
});

for (const kind of ['dispose', 'context loss', 'wait failure']) {
  test(`pending GPU fences are deleted on ${kind}`, async () => {
    await withGpuQueue(async run => {
      run.holdFence();
      run.preparation.start();
      await run.publish();
      run.link();
      while (run.fences === 0) run.slice();
      if (kind === 'dispose') run.preparation.dispose();
      else if (kind === 'context loss') run.loseContext();
      else { run.failFence(); run.slice(); }
      await assert.rejects(run.preparation.ready);
      assert.equal(run.deletedFences.length, 1);
      assert.equal(run.callbacks.size, 0);
    });
  });
}

test('texture-version invalidation replaces a pending fence and uploads the new version before readiness', async () => {
  await withGpuQueue(async run => {
    run.holdFence();
    run.preparation.start();
    await run.publish();
    run.link();
    while (run.fences === 0) run.slice();
    run.texture.version++;
    run.preparation.invalidateTextures();
    assert.equal(run.deletedFences.length, 1);
    run.signalFence();
    run.drain();
    await run.preparation.ready;
    assert.equal(run.uploaded.filter(texture => texture === run.texture).length, 2);
    assert.equal(run.fences, 2);
    assert.equal(run.deletedFences.length, 2);
  });
});

test('browsers without sync APIs report submission-only completion explicitly', async () => {
  await withGpuQueue(async run => {
    run.preparation.start();
    await run.publish();
    run.link();
    run.drain();
    assert.deepEqual(await run.preparation.ready,
      {uploadsComplete: false, shadersComplete: true, completion: 'submitted'});
    assert.equal(run.fences, 0);
  }, {sync: false});
});

test('native atlas outcome settles after its existing callback without issuing another load', async () => {
  let success, failure, loads = 0, nativeSuccess = 0;
  const texture = {isTexture: true, version: 0, image: null};
  const atlas = loadNativeAtlas((yes, no) => {
    loads++;
    success = yes;
    failure = no;
    return texture;
  }, received => {
    assert.equal(received, texture);
    assert.ok(received.image);
    nativeSuccess++;
  }, () => { throw new Error('Unexpected failure callback'); });
  let settled = false;
  atlas.__qolAtlasReady.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  texture.image = {};
  texture.version++;
  success(texture);
  assert.equal(await atlas.__qolAtlasReady, true);
  assert.equal(nativeSuccess, 1);
  assert.equal(loads, 1);
  assert.equal(typeof failure, 'function');
});

test('an optional native atlas error preserves its fallback and settles a nonfatal outcome', async () => {
  let failure, fallback = false;
  const original = new Error('Native atlas unavailable');
  const atlas = loadNativeAtlas((yes, no) => {
    failure = no;
    return {isTexture: true};
  }, () => {}, error => { assert.equal(error, original); fallback = true; });
  failure(original);
  assert.equal(fallback, true);
  assert.equal(await atlas.__qolAtlasReady, false);
});

test('slow native atlases do not block entry or geometry and cannot certify null-image uploads', async () => {
  let success;
  const atlas = loadNativeAtlas(yes => {
    success = yes;
    return {isTexture: true, loaded: false, image: null, version: 0};
  }, () => {}, () => {});
  await withGpuQueue(async run => {
    run.material.map = atlas;
    run.preparation.start();
    await run.publish();
    run.link();
    run.drain();
    assert.equal(run.geometry.length, run.children.length);
    assert.equal(run.compiled.length, 0);
    assert.equal(run.uploaded.length, 0);
    assert.equal(run.callbacks.size, 0, 'Native atlas wait must not idle-poll');
    run.material.uniforms = {map: {value: null}};
    atlas.loaded = true;
    atlas.image = {};
    atlas.version++;
    success(atlas);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    run.material.uniforms.map.value = atlas;
    run.drain();
    await run.preparation.ready;
    assert.equal(run.uploaded.filter(texture => texture === atlas).length, 1);
    assert.equal(run.compiled.length, run.children.length);
  }, {atlases: [atlas]});
});

test('failed native atlases remain optional and are never uploaded from stale hidden template maps', async () => {
  let failure, nativeFallback = false;
  const atlas = loadNativeAtlas((yes, no) => {
    failure = no;
    return {isTexture: true, loaded: false, image: null, version: 0};
  }, () => {}, () => { nativeFallback = true; });
  await withGpuQueue(async run => {
    run.material.map = atlas;
    run.preparation.start();
    await run.publish();
    run.link();
    failure(new Error('Optional atlas failed'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    run.drain();
    await run.preparation.ready;
    assert.equal(nativeFallback, true);
    assert.equal(run.uploaded.includes(atlas), false);
  }, {atlases: [atlas]});
});

test('disposing during an unsettled native atlas load rejects completion without waiting for its callback', async () => {
  let success;
  const atlas = loadNativeAtlas(yes => {
    success = yes;
    return {isTexture: true};
  }, () => {}, () => {});
  await withGpuQueue(async run => {
    run.preparation.start();
    await run.publish();
    run.drain();
    run.preparation.dispose();
    await assert.rejects(run.preparation.ready, {name: 'AbortError'});
    success(atlas);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(run.callbacks.size, 0);
    assert.equal(run.compiled.length, 0);
    assert.equal(run.uploaded.length, 0);
  }, {atlases: [atlas]});
});

test('removing an already-visited sibling cannot skip later original scene objects', async () => {
  await withGpuQueue(async run => {
    run.preparation.start();
    // One zero-budget operation per slice: scene, first child, light enter.
    run.slice();
    run.slice();
    run.slice();
    run.scene.children.splice(0, 1);
    run.light.parent = null;
    await run.publish();
    run.link();
    run.drain();
    await run.preparation.ready;
    assert.deepEqual(run.geometry, run.children);
    assert.deepEqual(run.compiled, run.children);
  }, {count: 4, budget: 0});
});

test('detached ancestors and independently disposed geometry cannot be resurrected after atlas readiness', async () => {
  const gate = deferred(), atlas = {isTexture: true, loaded: true, __qolAtlasReady: gate.promise};
  await withGpuQueue(async run => {
    const detached = run.children[0], retiredGeometry = run.children[1];
    const group = {parent: run.scene, children: [detached], visible: true};
    detached.parent = group;
    run.scene.children.splice(run.scene.children.indexOf(detached), 1, group);
    retiredGeometry.geometry = Object.assign(new EventTarget(), {index: {}});
    run.preparation.start();
    await run.publish();
    run.drain();
    assert.equal(run.compiled.length, 0);
    group.parent = null;
    run.scene.children.splice(run.scene.children.indexOf(group), 1);
    retiredGeometry.geometry.dispatchEvent(new Event('dispose'));
    gate.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    run.link();
    run.drain();
    await run.preparation.ready;
    assert.equal(run.compiled.includes(detached), false);
    assert.equal(run.compiled.includes(retiredGeometry), false);
    assert.equal(run.compiled.length, 2);
  }, {count: 4, atlases: [atlas]});
});
