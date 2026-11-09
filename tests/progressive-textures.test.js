import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMapGpuPreparation, createProgressiveTextureBindings, loadNativeAtlas, nativeBspShaderSignature} from '../extension/progressive-textures.js';

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

test('worker-prepared first-view textures upload as each becomes ready, not after the slowest texture', async () => {
  const run = fixture(), uploaded = deferred(), uploads = [];
  run.resources.preparedMeshes = new Map();
  run.renderer.initTexture = texture => {
    assert.ok(texture.image, 'Only decoded images may be uploaded');
    uploads.push(texture.image.url);
    if (texture === run.textures.visible) uploaded.resolve();
  };
  let ready = false;
  const initial = run.bindings.prepare(run.renderer, () => {
    run.renderer.renderBufferDirect(null, null, null, {
      uniforms: {maps: {value: [run.textures.visible, run.textures.visible, run.textures.offscreen]}}
    });
  }).then(() => { ready = true; });
  run.publish('visible');
  await uploaded.promise;
  assert.equal(ready, false);
  assert.deepEqual(uploads, ['visible']);
  run.publish('offscreen');
  await initial;
  assert.deepEqual(uploads, ['visible', 'offscreen']);
  run.finished.resolve();
  await run.bindings.complete();
});

test('an already published native texture uploads before first-view readiness', async () => {
  const run = fixture(), uploaded = [];
  const texture = {isTexture: true, image: {url: 'warm'}};
  run.resources.preparedMeshes = new Map();
  run.renderer.initTexture = value => uploaded.push(value);
  const initial = run.bindings.prepare(run.renderer, () => {
    run.renderer.renderBufferDirect(null, null, null, {uniforms: {baseMap: {value: texture}}});
  });
  assert.deepEqual(uploaded, []);
  await initial;
  assert.deepEqual(uploaded, [texture]);
  run.bindings.dispose();
});

test('cancelling first-view preparation prevents late worker textures from uploading', async () => {
  const run = fixture(), uploads = [];
  run.resources.preparedMeshes = new Map();
  run.renderer.initTexture = texture => uploads.push(texture);
  const initial = run.bindings.prepare(run.renderer, run.draw);
  run.resources.cancel();
  await assert.rejects(initial, {name: 'AbortError'});
  run.publish('visible');
  run.publish('offscreen');
  run.finished.resolve();
  await assert.rejects(run.bindings.complete(), {name: 'AbortError'});
  assert.deepEqual(uploads, []);
});

test('context loss cancels a first-view texture wait even without parallel shader preparation', async () => {
  const run = fixture(), uploads = [], canvas = eventSource();
  let lost = false;
  run.resources.preparedMeshes = new Map();
  run.renderer.domElement = canvas;
  run.renderer.getContext = () => ({isContextLost: () => lost});
  run.renderer.initTexture = texture => uploads.push(texture);
  const initial = run.bindings.prepare(run.renderer, run.draw);
  lost = true;
  canvas.emit('webglcontextlost');
  await assert.rejects(initial, {name: 'AbortError'});
  assert.equal(run.resources.signal.aborted, true);
  run.publish('visible');
  run.publish('offscreen');
  run.finished.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(uploads, []);
  assert.equal(run.textures.visible.image, null);
});

test('an already lost context skips the first-view probe and cancels resources', async () => {
  const run = fixture();
  let probes = 0;
  run.renderer.domElement = eventSource();
  run.renderer.getContext = () => ({isContextLost: () => true});
  await assert.rejects(run.bindings.prepare(run.renderer, () => { probes++; }), {name: 'AbortError'});
  assert.equal(probes, 0);
  assert.equal(run.resources.signal.aborted, true);
});

test('context loss after first-view readiness does not cancel the live resource owner', async () => {
  const run = fixture(), canvas = eventSource();
  run.renderer.domElement = canvas;
  run.renderer.getContext = () => ({isContextLost: () => false});
  const initial = run.bindings.prepare(run.renderer, run.draw);
  run.publish('visible');
  await initial;
  canvas.emit('webglcontextlost');
  assert.equal(run.resources.signal.aborted, false);
  run.bindings.dispose();
});

test('a first-view upload failure rejects preparation instead of hiding an incomplete GPU texture', async () => {
  const run = fixture(), failure = new Error('Texture upload failed');
  run.resources.preparedMeshes = new Map();
  run.renderer.initTexture = () => { throw failure; };
  const initial = run.bindings.prepare(run.renderer, run.draw);
  run.publish('visible');
  await assert.rejects(initial, error => error === failure);
  run.bindings.dispose();
});

test('a native traversal failure restores renderer submission before rejecting', async () => {
  const run = fixture(), original = run.renderer.renderBufferDirect;
  const failure = new Error('Native traversal failed');
  await assert.rejects(run.bindings.prepare(run.renderer, () => { throw failure; }), error => error === failure);
  assert.equal(run.renderer.renderBufferDirect, original);
  run.bindings.dispose();
});

test('probe cleanup preserves a renderer method replaced by native callbacks', async () => {
  const run = fixture(), replacement = () => 'replacement';
  const initial = run.bindings.prepare(run.renderer, () => {
    run.draw();
    run.renderer.renderBufferDirect = replacement;
  });
  assert.equal(run.renderer.renderBufferDirect, replacement);
  run.publish('visible');
  await initial;
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

function bspMaterial(uniforms, defines = {}) {
  return {
    ...nativeBspShaderSignature(), isMaterial: true, isShaderMaterial: true,
    defines, uniforms,
    onBeforeCompile() {},
    customProgramCacheKey() { return this.onBeforeCompile.toString(); }
  };
}

test('disabled native BSP samplers do not gate or prioritize the initial view', async () => {
  const run = fixture();
  let prioritized;
  run.resources.prioritize = urls => { prioritized = new Set(urls); };
  const uniforms = {baseMap: {value: run.textures.visible}};
  for (const key of ['secondMap', 'normalMap', 'detailMap', 'lightMap', 'propLight', 'environment', 'envMask']) {
    uniforms[key] = {value: run.textures.offscreen};
  }
  // Neither NORMAL_MAP nor ENV_MASK can sample when ENVIRONMENT is disabled.
  const material = bspMaterial(uniforms, {NORMAL_MAP: 1, ENV_MASK: 1, DETAIL_MAP: false});
  const initial = run.bindings.prepare(run.renderer, () => run.renderer.renderBufferDirect(null, null, null, material));
  assert.deepEqual(prioritized, new Set(['visible']));
  run.publish('visible');
  await initial;
  assert.equal(run.textures.offscreen.image, null);
  run.bindings.dispose();
});

for (const [uniform, defines] of [
  ['baseMap', {}], ['secondMap', {SECOND_MAP: 0}], ['detailMap', {DETAIL_MAP: 1}],
  ['lightMap', {WORLD_LIGHT: 1}], ['propLight', {PROP_LIGHT: 1}],
  ['environment', {ENVIRONMENT: 1}], ['normalMap', {ENVIRONMENT: 1}],
  ['normalMap', {ENVIRONMENT: 1, NORMAL_MAP: 1}], ['normalMap', {ENVIRONMENT: 1, NORMAL_ALPHA_MASK: 1}],
  ['envMask', {ENVIRONMENT: 1, ENV_MASK: 1}]
]) {
  test(`an active native ${uniform} sampler gates the first view`, async () => {
    const run = fixture();
    let prioritized, settled = false;
    run.resources.prioritize = urls => { prioritized = new Set(urls); };
    const material = bspMaterial({[uniform]: {value: run.textures.offscreen}}, defines);
    const initial = run.bindings.prepare(run.renderer, () => run.renderer.renderBufferDirect(null, null, null, material))
      .then(() => { settled = true; });
    assert.deepEqual(prioritized, new Set(['offscreen']));
    run.publish('visible');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false);
    const image = run.publish('offscreen');
    await initial;
    assert.equal(run.textures.offscreen.image, image);
    run.bindings.dispose();
  });
}

test('successive submissions reread changed defines and the current shader signature', async () => {
  for (const change of [
    material => { material.defines.SECOND_MAP = 1; },
    material => { material.fragmentShader += '\n// a different shader'; }
  ]) {
    const run = fixture();
    let prioritized;
    run.resources.prioritize = urls => { prioritized = new Set(urls); };
    const material = bspMaterial({baseMap: {value: run.textures.visible}, secondMap: {value: run.textures.offscreen}});
    const initial = run.bindings.prepare(run.renderer, () => {
      run.renderer.renderBufferDirect(null, null, null, material);
      change(material);
      run.renderer.renderBufferDirect(null, null, null, material);
    });
    assert.deepEqual(prioritized, new Set(['visible', 'offscreen']));
    run.publish('visible');
    run.publish('offscreen');
    await initial;
    run.bindings.dispose();
  }
});

test('unknown shaders, injected defines, and shader hooks conservatively wait for every uniform', async () => {
  for (const change of [
    material => { material.vertexShader += '\n// changed'; },
    material => { material.defines.UNRECOGNIZED = 1; },
    material => { material.onBeforeCompile = shader => { shader.fragmentShader += '\n// custom'; }; },
    material => { material.customProgramCacheKey = () => 'unknown'; },
  ]) {
    const run = fixture();
    let prioritized, settled = false;
    run.resources.prioritize = urls => { prioritized = new Set(urls); };
    const material = bspMaterial({secondMap: {value: run.textures.offscreen}});
    change(material);
    const initial = run.bindings.prepare(run.renderer, () => run.renderer.renderBufferDirect(null, null, null, material))
      .then(() => { settled = true; });
    assert.deepEqual(prioritized, new Set(['offscreen']));
    await Promise.resolve();
    assert.equal(settled, false);
    run.publish('offscreen');
    await initial;
    run.bindings.dispose();
  }
});

function eventSource(target = {}) {
  const listeners = new Map();
  target.addEventListener = (type, listener) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(listener);
  };
  target.removeEventListener = (type, listener) => listeners.get(type)?.delete(listener);
  target.emit = type => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener({type, target});
  };
  return target;
}

function firstViewFixture() {
  const run = fixture(), context = {lost: false, isContextLost() { return this.lost; }};
  const canvas = eventSource(), properties = new WeakMap(), compiled = [], order = [];
  const linked = {value: false}, polls = {value: 0}, reflected = [];
  const renderer = {
    domElement: canvas,
    extensions: {has: name => name === 'KHR_parallel_shader_compile'},
    properties: {get(material) {
      if (!properties.has(material)) properties.set(material, {programs: new Map(), __version: material.version});
      return properties.get(material);
    }},
    getContext() { return context; },
    getRenderTarget() { return this.target ?? null; },
    __qolProbeLights() { return this.lights; },
    compileAsync() { throw new Error('Uncancellable compileAsync was called'); },
    renderBufferDirect() { throw new Error('Probe submitted a draw'); },
    compile(root, camera, scene) {
      order.push('compile');
      if (this.failure) throw this.failure;
      const lights = [];
      scene.traverseVisible(light => {
        if (light.isLight && light.layers.test(camera.layers)) lights.push(light);
      });
      root.traverseVisible(() => { throw new Error('A hidden light was traversed'); });
      root.traverse(object => {
        const material = object.material, owned = this.properties.get(material);
        const entry = {camera, fog: scene.fog, environment: scene.environment, lights,
          material, geometry: object.geometry, instanced: !!object.isInstancedMesh, skinned: !!object.isSkinnedMesh,
          skeleton: object.skeleton,
          side: material.side, defines: {...material.defines}};
        entry.program = {
          program: {},
          isReady() { polls.value++; return linked.value; },
          getUniforms() { assert.equal(linked.value, true); reflected.push([entry, 'uniforms']); },
          getAttributes() { assert.equal(linked.value, true); reflected.push([entry, 'attributes']); }
        };
        owned.programs.set(compiled.length, entry.program);
        owned.currentProgram = entry.program;
        compiled.push(entry);
      });
    },
    drawFromCache(camera, scene, geometry, material, object, lights) {
      const owned = this.properties.get(material);
      if (owned.__version !== material.version) {
        const entry = compiled.find(item => item.camera === camera && item.fog === scene.fog &&
          item.geometry === geometry && item.side === material.side &&
          item.instanced === !!object.isInstancedMesh && item.skinned === !!object.isSkinnedMesh &&
          JSON.stringify(item.defines) === JSON.stringify(material.defines) &&
          item.lights.length === lights.length && item.lights.every((light, index) => light === lights[index]));
        if (!entry) throw new Error('First draw missed its selected program');
        owned.currentProgram = entry.program;
        owned.__version = material.version;
      }
      return owned.currentProgram;
    },
    dispose() { this.disposals = (this.disposals ?? 0) + 1; }
  };
  const light = name => ({name, isLight: true, isDirectionalLight: true, castShadow: false,
    layers: {mask: 1, test(layers) { return !!(this.mask & layers.mask); }}});
  const scene = name => ({name, isScene: true, fog: {name}, environment: {name},
    traverseVisible() { throw new Error('The complete scene was traversed'); }});
  const camera = name => ({name, isCamera: true, layers: {mask: 1}});
  const geometry = () => eventSource({attributes: {uv: {}}, morphAttributes: {}});
  const object = (geom, instanced = false) => ({isMesh: true, isInstancedMesh: instanced,
    geometry: geom, instanceColor: null, morphTexture: null});
  run.resources.prioritize = urls => { order.push('prioritize'); run.prioritized = new Set(urls); };
  Object.assign(run, {renderer, canvas, context, compiled, order, linked, polls, reflected,
    light, scene, camera, geometry, object});
  return run;
}

function visibleShader(run) {
  return eventSource(Object.assign(bspMaterial({baseMap: {value: run.textures.visible},
    secondMap: {value: run.textures.offscreen}}), {side: 0, version: 7}));
}

test('pending textures overlap only selected shader variants, with native owners and current views', async () => {
  const run = firstViewFixture(), material = visibleShader(run), defines = material.defines;
  const sceneA = run.scene('world'), sceneB = run.scene('sky');
  const cameraA = run.camera('world'), cameraB = run.camera('sky');
  const lightA = run.light('sun'), lightB = run.light('sky light');
  const geometryA = run.geometry(), geometryB = run.geometry();
  const ordinary = run.object(geometryB), instanced = run.object(geometryB, true);
  const skinned = Object.assign(run.object(geometryB), {isSkinnedMesh: true, skeleton: {}});
  const original = run.renderer.renderBufferDirect;
  let settled = false;
  const initial = run.bindings.prepare(run.renderer, () => {
    run.renderer.lights = [lightA];
    run.renderer.renderBufferDirect(cameraA, sceneA, geometryA, material, ordinary);
    run.renderer.renderBufferDirect(cameraA, sceneA, geometryA, material, ordinary);
    material.side = 1;
    defines.SECOND_MAP = 1;
    run.renderer.renderBufferDirect(cameraA, sceneA, geometryB, material, instanced);
    run.renderer.renderBufferDirect(cameraA, sceneA, geometryB, material, skinned);
    run.renderer.lights = [lightA, lightB];
    run.renderer.renderBufferDirect(cameraA, sceneA, geometryB, material, instanced);
    run.renderer.lights = [lightB];
    run.renderer.renderBufferDirect(cameraB, sceneB, geometryA, material, ordinary);
  }).then(() => { settled = true; });

  assert.deepEqual(run.order, ['prioritize']);
  while (run.compiled.length < 5) await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(run.order, ['prioritize', 'compile', 'compile', 'compile', 'compile', 'compile']);
  assert.deepEqual(run.prioritized, new Set(['visible', 'offscreen']));
  assert.equal(run.renderer.renderBufferDirect, original);
  assert.equal(material.defines, defines);
  assert.deepEqual(defines, {SECOND_MAP: 1});
  assert.equal(material.side, 1);
  assert.equal(ordinary.geometry, geometryB);
  assert.deepEqual(run.compiled.map(entry => ({
    camera: entry.camera.name, fog: entry.fog.name, lights: entry.lights.map(light => light.name),
    instanced: entry.instanced, skinned: entry.skinned, side: entry.side, defines: entry.defines
  })), [
    {camera: 'world', fog: 'world', lights: ['sun'], instanced: false, skinned: false, side: 0, defines: {}},
    {camera: 'world', fog: 'world', lights: ['sun'], instanced: true, skinned: false, side: 1, defines: {SECOND_MAP: 1}},
    {camera: 'world', fog: 'world', lights: ['sun'], instanced: false, skinned: true, side: 1, defines: {SECOND_MAP: 1}},
    {camera: 'world', fog: 'world', lights: ['sun', 'sky light'], instanced: true, skinned: false, side: 1, defines: {SECOND_MAP: 1}},
    {camera: 'sky', fog: 'sky', lights: ['sky light'], instanced: false, skinned: false, side: 1, defines: {SECOND_MAP: 1}}
  ]);
  assert.equal(run.compiled[0].geometry, geometryA);
  assert.equal(run.compiled[1].geometry, geometryB);
  assert.equal(run.compiled[2].skeleton, skinned.skeleton);
  assert.ok(run.compiled.every(entry => entry.material === material));
  const owned = run.renderer.properties.get(material);
  assert.equal(owned.programs.size, 5);
  assert.equal(owned.__version, -1);
  run.publish('visible');
  run.publish('offscreen');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(run.reflected, []);
  run.linked.value = true;
  await initial;
  assert.equal(run.reflected.length, 10);
  assert.equal(material.defines, defines);
  assert.equal(material.side, 1);
  assert.equal(run.renderer.drawFromCache(cameraA, sceneA, geometryB, material, instanced, [lightA]),
    run.compiled[1].program);
  material.side = 0;
  delete defines.SECOND_MAP;
  material.version++;
  assert.equal(run.renderer.drawFromCache(cameraA, sceneA, geometryA, material, ordinary, [lightA]),
    run.compiled[0].program);
  material.side = 1;
  defines.SECOND_MAP = 1;
  material.version++;
  assert.equal(run.renderer.drawFromCache(cameraB, sceneB, geometryA, material, ordinary, [lightB]),
    run.compiled[4].program);
  assert.equal(run.compiled.length, 5);
  run.bindings.dispose();
});

test('warm visible textures still prepare selected shaders without waiting for unrelated textures', async () => {
  const run = firstViewFixture(), material = visibleShader(run), scene = run.scene('world');
  const camera = run.camera('world'), geometry = run.geometry(), object = run.object(geometry);
  run.renderer.lights = [run.light('sun')];
  run.publish('visible');
  await new Promise(resolve => setTimeout(resolve, 0));
  run.linked.value = true;
  await run.bindings.prepare(run.renderer,
    () => run.renderer.renderBufferDirect(camera, scene, geometry, material, object));
  assert.equal(run.compiled.length, 1);
  assert.equal(run.reflected.length, 2);
  assert.deepEqual(run.prioritized, new Set());
  assert.equal(run.textures.offscreen.image, null);
  run.bindings.dispose();
});

test('unsupported parallel compilation waits only for the selected textures without compiling', async () => {
  for (const disable of [
    run => { run.renderer.extensions.has = () => false; },
    run => { delete run.renderer.compileAsync; },
    run => { delete run.renderer.__qolProbeLights; },
    run => { delete run.context.isContextLost; },
    run => { delete run.renderer.getRenderTarget; },
    run => { run.renderer.lights = undefined; },
    run => { run.renderer.localClippingEnabled = true; },
    run => { run.renderer.clippingPlanes = [{}]; },
    run => { delete run.renderer.properties; }
  ]) {
    const run = firstViewFixture(), material = visibleShader(run), scene = run.scene('world');
    const camera = run.camera('world'), geometry = run.geometry(), object = run.object(geometry);
    run.renderer.lights = [run.light('sun')];
    disable(run);
    const initial = run.bindings.prepare(run.renderer,
      () => run.renderer.renderBufferDirect(camera, scene, geometry, material, object));
    assert.deepEqual(run.prioritized, new Set(['visible']));
    assert.deepEqual(run.compiled, []);
    run.publish('visible');
    await initial;
    assert.equal(run.textures.offscreen.image, null);
    run.bindings.dispose();
  }
});

test('custom hooks, stale view state and owners disposed during the probe skip speculative compilation', async () => {
  for (const [custom, mutate] of [
    [true, ({material}) => { material.onBeforeCompile = () => { throw new Error('Custom hook ran early'); }; }],
    [true, ({material}) => { material.customProgramCacheKey = () => { throw new Error('Custom key ran early'); }; }],
    [false, ({scene}) => { scene.fog = {name: 'changed'}; }],
    [false, ({run}) => { run.renderer.target = {texture: {colorSpace: 'changed'}}; }],
    [false, ({run}) => { run.renderer.lights[0].castShadow = true; }],
    [false, ({geometry}) => { geometry.emit('dispose'); }],
    [false, ({material}) => { material.emit('dispose'); }]
  ]) {
    const run = firstViewFixture(), material = visibleShader(run), scene = run.scene('world');
    const camera = run.camera('world'), geometry = run.geometry(), object = run.object(geometry);
    run.renderer.lights = [run.light('sun')];
    if (custom) mutate({run, material, scene, geometry});
    const initial = run.bindings.prepare(run.renderer, () => {
      run.renderer.renderBufferDirect(camera, scene, geometry, material, object);
      if (!custom) mutate({run, material, scene, geometry});
    });
    assert.deepEqual(run.compiled, []);
    run.publish('visible');
    // Custom hooks make texture selection conservative as well.
    if (custom) run.publish('offscreen');
    await initial;
    run.bindings.dispose();
  }
});

test('a failed speculative compile restores shared material state and the renderer', async () => {
  const run = firstViewFixture(), material = visibleShader(run), defines = material.defines;
  const scene = run.scene('world'), camera = run.camera('world'), geometry = run.geometry(), object = run.object(geometry);
  const failure = new Error('Compile failed'), originalDispose = run.renderer.dispose;
  run.renderer.lights = [run.light('sun')];
  run.renderer.failure = failure;
  const initial = run.bindings.prepare(run.renderer, () => {
    run.renderer.renderBufferDirect(camera, scene, geometry, material, object);
    material.side = 1;
    defines.SECOND_MAP = 1;
  });
  await assert.rejects(initial, error => error === failure);
  assert.equal(material.side, 1);
  assert.equal(material.defines, defines);
  assert.deepEqual(defines, {SECOND_MAP: 1});
  assert.equal(run.renderer.dispose, originalDispose);
  run.bindings.dispose();
});

test('cancellation, disposal, context loss and texture failure stop first-view shader polling', async () => {
  for (const kind of ['bindings', 'signal', 'renderer', 'context', 'material', 'geometry', 'texture']) {
    const run = firstViewFixture(), material = visibleShader(run), scene = run.scene('world');
    const camera = run.camera('world'), geometry = run.geometry(), object = run.object(geometry);
    const failure = new Error('Decode failed'), originalDispose = run.renderer.dispose;
    run.renderer.lights = [run.light('sun')];
    const initial = run.bindings.prepare(run.renderer,
      () => run.renderer.renderBufferDirect(camera, scene, geometry, material, object));
    assert.equal(run.compiled.length, 0);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(run.compiled.length, 1);
    const polls = run.polls.value;
    if (kind === 'bindings') run.bindings.dispose();
    if (kind === 'signal') run.resources.cancel();
    if (kind === 'renderer') run.renderer.dispose();
    if (kind === 'context') { run.context.lost = true; run.canvas.emit('webglcontextlost'); }
    if (kind === 'material') material.emit('dispose');
    if (kind === 'geometry') geometry.emit('dispose');
    if (kind === 'texture') run.gates.get('visible').reject(failure);
    await assert.rejects(initial, error => kind === 'texture' ? error === failure : error.name === 'AbortError');
    assert.equal(run.renderer.dispose, originalDispose);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(run.polls.value, polls);
    run.bindings.dispose();
  }
});

test('disposing before scheduled shader work prevents compilation', async () => {
  const run = firstViewFixture(), material = visibleShader(run), scene = run.scene('world');
  const camera = run.camera('world'), geometry = run.geometry(), object = run.object(geometry);
  run.renderer.lights = [run.light('sun')];
  const initial = run.bindings.prepare(run.renderer,
    () => run.renderer.renderBufferDirect(camera, scene, geometry, material, object));
  run.bindings.dispose();
  await assert.rejects(initial, error => error.name === 'AbortError');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(run.compiled, []);
});

test('many visible shader variants yield before all native compiles and stop on cancellation', async () => {
  const run = firstViewFixture(), material = visibleShader(run), geometry = run.geometry();
  const object = run.object(geometry);
  run.renderer.lights = [run.light('sun')];
  const initial = run.bindings.prepare(run.renderer, () => {
    for (let index = 0; index < 100; index++) {
      run.renderer.renderBufferDirect(run.camera(String(index)), run.scene(String(index)), geometry, material, object);
    }
  });
  assert.equal(run.compiled.length, 0);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(run.compiled.length > 0 && run.compiled.length <= 64);
  run.bindings.dispose();
  await assert.rejects(initial, error => error.name === 'AbortError');
  const count = run.compiled.length;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(run.compiled.length, count);
});

async function withGpuQueue(run, {parallel = true, sync = true, count = 180, budget = Infinity, atlases = []} = {}) {
  const idleDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback');
  const cancelDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback');
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
  const clearTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout');
  const callbacks = new Map();
  let nextId = 0, lost = false, linked = false, reads = 0, reflections = 0, disposals = 0;
  let textureBindings = null;
  let fences = 0, waits = 0, flushes = 0, fenceStatus = 37148;
  const deletedFences = [];
  globalThis.requestIdleCallback = callback => { callbacks.set(++nextId, callback); return nextId; };
  globalThis.cancelIdleCallback = id => callbacks.delete(id);
  globalThis.setTimeout = callback => { callbacks.set(++nextId, callback); return nextId; };
  globalThis.clearTimeout = id => callbacks.delete(id);
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
  const preparation = createMapGpuPreparation(renderer, [scene], camera, [textures], () => assets.promise, null, atlases, () => textureBindings);
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
      setBindings(bindings) { textureBindings = bindings; },
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
    Object.defineProperty(globalThis, 'setTimeout', timeoutDescriptor);
    Object.defineProperty(globalThis, 'clearTimeout', clearTimeoutDescriptor);
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
    run.link();
    run.drain();
    assert.equal(run.geometry.length, run.children.length);
    assert.equal(run.uploaded.length, 0);
    assert.equal(run.callbacks.size, 0, 'Waiting for assets must not spin an idle queue');
    assert.ok(run.reflections > 0, 'Ready shader reflection must not wait for unrelated assets');
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
      if (!event) run.drain();
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
    while (run.geometry.length < run.children.length) run.slice();
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
    while (run.compiled.length < run.children.length) run.slice();
    run.material.dispatchEvent(new Event('dispose'));
    run.program.program = undefined; // Native WebGLProgram.destroy contract.
    const reads = run.reads;
    await run.publish();
    run.drain();
    await run.preparation.ready;
    assert.equal(run.uploaded.includes(retired), false);
    assert.equal(run.reads, reads);
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

test('a continuously changing live texture cannot keep the background scan running forever', async () => {
  await withGpuQueue(async run => {
    run.preparation.start();
    await run.publish();
    run.link();
    let slices = 0;
    while (run.callbacks.size && slices++ < 1000) {
      // Native canvas textures can change while successive idle slices run.
      run.texture.version++;
      run.slice(0);
    }
    assert.ok(slices < 1000, 'Live texture updates restarted the scan indefinitely');
    await run.preparation.ready;
    assert.ok(run.uploaded.includes(run.texture));
    assert.ok(run.uploaded.includes(run.scene.background));
    assert.equal(run.callbacks.size, 0);
  }, {count: 3});
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

test('slow native atlases do not block geometry or unrelated real textures', async () => {
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
    assert.equal(run.callbacks.size, 0, 'Native atlas wait must not idle-poll');
    assert.equal(run.uploaded.includes(atlas), false);
    assert.equal(run.uploaded.includes(run.texture), true);
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
    assert.equal(run.uploaded.includes(atlas), false);
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

test('real textures warm individually while unrelated map assets and scene traversal are still pending', async () => {
  await withGpuQueue(async run => {
    const controller = new AbortController(), wall = deferred(), sky = deferred();
    const resources = {
      images: new Map(), compressed: new Map(), pendingCompressed: new Map(),
      pendingImages: new Map([['wall', wall.promise], ['sky', sky.promise]]),
      signal: controller.signal, ready: run.assets.promise, prioritize() {}, cancel() { controller.abort(); }
    };
    const bindings = createProgressiveTextureBindings(resources);
    bindings.bind(run.texture, 'wall', () => { run.texture.loaded = true; });
    bindings.bind(run.scene.background, 'sky', () => { run.scene.background.loaded = true; });
    run.setBindings(bindings);
    run.preparation.start();
    run.slice(0);
    assert.equal(run.uploaded.length, 0);
    resources.images.set('wall', {});
    wall.resolve();
    await Promise.resolve();
    await Promise.resolve();
    while (!run.uploaded.includes(run.texture)) run.slice(0);
    assert.equal(run.uploaded.includes(run.scene.background), false);
    assert.ok(run.geometry.length < run.children.length);
    resources.images.set('sky', {});
    sky.resolve();
    await run.publish();
    run.link();
    run.drain();
    await run.preparation.ready;
    assert.equal(run.uploaded.filter(texture => texture === run.texture).length, 1);
    assert.equal(run.uploaded.filter(texture => texture === run.scene.background).length, 1);
    bindings.dispose();
  });
});

test('geometry starts warming before a large scene walk finishes without compiling incomplete light lists', async () => {
  await withGpuQueue(async run => {
    run.preparation.start();
    while (run.geometry.length === 0) run.slice(0);
    assert.ok(run.geometry.length < run.children.length);
    assert.equal(run.compiled.length, 0);
    await run.publish();
    run.link();
    run.drain();
    await run.preparation.ready;
    assert.ok(run.nativeLights.every(light => light === run.light));
    assert.equal(run.geometry.length, run.children.length);
  });
});

test('large scalar uniform structures yield without missing a texture at the end', async () => {
  await withGpuQueue(async run => {
    let reads = 0;
    const last = {isTexture: true, loaded: true};
    const values = Array.from({length: 8192}, () => ({get scalar() { reads++; return 0; }}));
    values.push(last);
    run.material.uniforms = {values: {value: values}};
    run.preparation.start();
    await run.publish();
    run.link();
    while (reads === 0) run.slice(0);
    assert.ok(reads < values.length - 1, 'A single idle operation scanned the entire uniform structure');
    run.drain();
    await run.preparation.ready;
    assert.ok(reads >= values.length - 1);
    assert.equal(run.uploaded.filter(texture => texture === last).length, 1);
  }, {count: 1});
});
