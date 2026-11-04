import {nativeBspShaderSignature} from './bsp-shader-signature.js';
export {nativeBspShaderSignature} from './bsp-shader-signature.js';

// Observe the existing native request; failures keep its optional fallback.
// The outcome settles only after the native callback has updated its owner.
export function loadNativeAtlas(load, onLoad, onError) {
  let settle;
  const ready = new Promise(resolve => { settle = resolve; });
  const texture = load((...args) => {
    try { onLoad?.(...args); } finally { settle(true); }
  }, (...args) => {
    try { onError?.(...args); } finally { settle(false); }
  });
  texture.__qolAtlasReady = ready;
  return texture;
}

// This function is injected into the native module via toString(): keep every
// helper inside it and leave texture construction/decoding to the native hooks.
export function createProgressiveTextureBindings(resources, bspShader = nativeBspShaderSignature()) {
  const bindings = new WeakMap(), completions = [], signatureCache = new WeakMap(), preparations = new Set();
  const signal = resources.signal;
  let disposed = false, cancelledResources = false, disposalReason, rejectDisposed, completion, pendingBindings = 0;

  function handled(promise) {
    // Observe background failures immediately without changing what callers await.
    promise.catch(() => {});
    return promise;
  }

  const cancelled = handled(new Promise((resolve, reject) => { rejectDisposed = reject; }));
  const ready = handled(Promise.resolve(resources.ready));

  function stop(reason) {
    if (disposed) return;
    disposed = true;
    disposalReason = reason ?? new DOMException('Texture bindings disposed', 'AbortError');
    signal.removeEventListener('abort', aborted);
    for (const cancel of preparations) cancel(disposalReason);
    rejectDisposed(disposalReason);
  }

  function aborted() {
    stop(signal.reason);
  }

  if (signal.aborted) aborted();
  else signal.addEventListener('abort', aborted, {once: true});

  function active() {
    if (disposed) throw disposalReason;
  }

  async function wait(promise) {
    handled(promise);
    active();
    await Promise.race([promise, cancelled]);
    active();
  }

  function published(url) {
    return resources.images.has(url) || resources.compressed.has(url);
  }

  function bind(texture, urls, apply) {
    const binding = {urls: typeof urls === 'string' ? [urls] : [...new Set(urls)], promise: null, pending: false};
    let registered = bindings.get(texture);
    if (!registered) bindings.set(texture, registered = []);
    registered.push(binding);

    function finish() {
      active();
      for (const url of binding.urls) {
        if (!published(url)) throw new Error(`Texture resource was not published: ${url}`);
      }
      apply();
    }

    try {
      active();
      const pending = [];
      for (const url of binding.urls) {
        if (published(url)) continue;
        const image = resources.pendingImages.get(url), compressed = resources.pendingCompressed.get(url);
        if (!image && !compressed) throw new Error(`Missing texture resource: ${url}`);
        if (image) pending.push(image);
        if (compressed) pending.push(compressed);
      }
      if (pending.length) {
        binding.pending = true;
        pendingBindings++;
        binding.promise = Promise.all(pending).then(finish).then(value => {
          binding.pending = false;
          pendingBindings--;
          return value;
        }, error => {
          binding.pending = false;
          pendingBindings--;
          throw error;
        });
      }
      else {
        // Already-published sky faces and cache hits keep native synchronous setup.
        finish();
        binding.promise = Promise.resolve();
      }
    } catch (error) {
      binding.promise = Promise.reject(error);
    }
    completions.push(handled(binding.promise));
    return texture;
  }

  function complete() {
    // Native scene construction must register its bindings synchronously before
    // the first complete() call. Keep failures, including already-settled ones.
    if (!completion) completion = handled(wait(Promise.all([ready, ...completions])));
    return completion;
  }

  async function prepareVisible(renderer, draw) {
    active();
    if (typeof renderer.renderBufferDirect !== 'function') {
      await complete();
      active();
      return;
    }

    const selected = new Set(), selectedTextures = new Map();
    const nativeDefines = new Set(['SECOND_MAP', 'DETAIL_MAP', 'UNLIT', 'TRANSLUCENT', 'PROP_FADE',
      'LIGHTING_RESPONSE', 'COLORED_SHADOW_LIFT', 'VIEW_BRIGHTNESS', 'ENV_MASK', 'ENV_SHAPING',
      'REFLECTION_ONLY', 'NO_FOG', 'PROP_LIGHT', 'WORLD_LIGHT', 'VERTEX_ALPHA', 'ALPHA_TEST',
      'SEAMLESS', 'ENVIRONMENT', 'NORMAL_MAP', 'NORMAL_ALPHA_MASK']);

    function defaultHooks(material) {
      return typeof material.onBeforeCompile === 'function' &&
        /^onBeforeCompile\s*\(\s*\)\s*\{\s*\}$/.test(Function.prototype.toString.call(material.onBeforeCompile)) &&
        typeof material.customProgramCacheKey === 'function' &&
        /^customProgramCacheKey\s*\(\s*\)\s*\{\s*return\s+this\.onBeforeCompile\.toString\(\)\s*;?\s*\}$/
          .test(Function.prototype.toString.call(material.customProgramCacheKey));
    }

    function nativeSamplers(material) {
      const vertex = material.vertexShader, fragment = material.fragmentShader;
      const hook = material.onBeforeCompile, key = material.customProgramCacheKey;
      let signature = signatureCache.get(material);
      if (!signature || signature.vertex !== vertex || signature.fragment !== fragment ||
          signature.hook !== hook || signature.key !== key ||
          signature.shader !== material.isShaderMaterial || signature.raw !== material.isRawShaderMaterial) {
        signature = {vertex, fragment, hook, key, shader: material.isShaderMaterial, raw: material.isRawShaderMaterial,
          recognized: !!material.isShaderMaterial && !material.isRawShaderMaterial &&
            typeof bspShader?.vertexShader === 'string' && typeof bspShader.fragmentShader === 'string' &&
            vertex === bspShader.vertexShader && fragment === bspShader.fragmentShader && defaultHooks(material)};
        signatureCache.set(material, signature);
      }
      if (!signature.recognized) return null;
      const enabled = new Set();
      for (const name in material.defines) {
        const value = material.defines[name];
        // A macro can otherwise introduce declarations or even new #defines.
        if (!nativeDefines.has(name) || !(typeof value === 'number' || typeof value === 'boolean' ||
            typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) return null;
        // Three emits #define for every enumerable value other than false;
        // in particular, zero is still defined for #ifdef.
        if (value !== false) enabled.add(name);
      }
      return enabled;
    }

    function sampled(key, enabled) {
      if (!enabled) return true;
      switch (key) {
        case 'secondMap': return enabled.has('SECOND_MAP');
        case 'detailMap': return enabled.has('DETAIL_MAP');
        case 'lightMap': return enabled.has('WORLD_LIGHT');
        case 'propLight': return enabled.has('PROP_LIGHT');
        // The captured shader reads normalMap unconditionally inside the
        // environment block, including the normal-alpha-mask path.
        case 'normalMap':
        case 'environment': return enabled.has('ENVIRONMENT');
        case 'envMask': return enabled.has('ENVIRONMENT') && enabled.has('ENV_MASK');
        default: return true;
      }
    }

    function collectTexture(value) {
      const registered = bindings.get(value);
      if (registered) {
        for (const binding of registered) selected.add(binding);
        selectedTextures.set(value, registered);
      }
      return registered !== undefined;
    }

    function collectMaterial(material) {
      if (!material) return;
      // Read at each native submission: onBeforeRender can change the same
      // material's uniforms for successive objects during the probe traversal.
      for (const key in material) {
        if (Object.prototype.hasOwnProperty.call(material, key)) collectTexture(material[key]);
      }
      const seen = new Set(), stack = [], enabled = nativeSamplers(material);
      const uniforms = material.uniforms;
      if (uniforms) for (const key in uniforms) {
        if (Object.prototype.hasOwnProperty.call(uniforms, key) && sampled(key, enabled)) stack.push(uniforms[key]?.value);
      }
      while (stack.length) {
        const value = stack.pop();
        if (!value || typeof value !== 'object' || collectTexture(value) || value.isTexture ||
            ArrayBuffer.isView(value) || seen.has(value)) continue;
        seen.add(value);
        for (const key in value) {
          if (Object.prototype.hasOwnProperty.call(value, key)) stack.push(value[key]);
        }
      }
    }

    const extensions = renderer.extensions;
    const parallel = pendingBindings > 0 && (typeof extensions?.has === 'function' ? extensions.has('KHR_parallel_shader_compile') :
      typeof extensions?.get === 'function' && extensions.get('KHR_parallel_shader_compile') != null);
    const canCompile = parallel && typeof renderer.compileAsync === 'function' && typeof renderer.compile === 'function' &&
      typeof renderer.properties?.get === 'function' && typeof renderer.__qolProbeLights === 'function' &&
      typeof renderer.getRenderTarget === 'function' && renderer.localClippingEnabled !== true &&
      !(renderer.clippingPlanes?.length > 0) &&
      typeof renderer.getContext === 'function' && typeof renderer.getContext()?.isContextLost === 'function';
    const views = [], submissions = [], byMaterial = new Map();

    function sameArray(left, right) {
      return left.length === right.length && left.every((value, index) => value === right[index]);
    }

    function geometryShape(object, geometry) {
      const attributes = geometry.attributes, morph = geometry.morphAttributes;
      return [!!object.isMesh, !!object.isLine, !!object.isPoints, !!object.isSprite, !!object.isInstancedMesh,
        !!object.isSkinnedMesh, !!object.isBatchedMesh, object.instanceColor !== null, object.morphTexture !== null,
        object._colorsTexture !== null, object.colorTexture !== null, !!attributes.tangent, attributes.color?.itemSize,
        !!attributes.uv, !!morph.position, morph.position?.length, !!morph.normal, morph.normal?.length,
        !!morph.color, morph.color?.length];
    }

    // Only plain scalar defines and extensions can be replayed without
    // executing user code. Other materials keep their normal first-draw path.
    function scalarFields(value) {
      if (value == null) return value;
      if (typeof value !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return null;
      const copy = Object.create(null);
      for (const key in value) {
        if (!Object.hasOwn(value, key)) return null;
        const descriptor = Object.getOwnPropertyDescriptor(value, key), field = descriptor.value;
        if (!('value' in descriptor) || !['string', 'number', 'boolean'].includes(typeof field)) return null;
        copy[key] = field;
      }
      return copy;
    }

    function sameFields(value, snapshot) {
      if (value == null || snapshot == null) return value === snapshot;
      if (typeof value !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return false;
      let count = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key) || !Object.hasOwn(snapshot, key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!('value' in descriptor) || descriptor.value !== snapshot[key]) return false;
        count++;
      }
      return count === Object.keys(snapshot).length;
    }

    function materialSnapshot(material) {
      if (!material.isShaderMaterial || material.isRawShaderMaterial || material.lights || material.clipping ||
          material.clippingPlanes || !defaultHooks(material)) return null;
      const side = Object.getOwnPropertyDescriptor(material, 'side');
      const defines = Object.getOwnPropertyDescriptor(material, 'defines');
      if (!side?.writable || !defines?.writable) return null;
      const macros = scalarFields(defines.value), extensions = scalarFields(material.extensions);
      if (macros === null || extensions === null) return null;
      const fields = Object.create(null);
      for (const key of Object.keys(material)) {
        if (key === '_listeners' || key === 'version' || key === 'side' || key === 'defines') continue;
        const descriptor = Object.getOwnPropertyDescriptor(material, key);
        if (!('value' in descriptor) || descriptor.value?.isTexture) return null;
        fields[key] = descriptor.value;
      }
      return {fields, side: side.value, macros, extensions,
        hook: material.onBeforeCompile, cacheKey: material.customProgramCacheKey};
    }

    function sameMaterial(material, state, matchVariant) {
      if (material.onBeforeCompile !== state.hook || material.customProgramCacheKey !== state.cacheKey ||
          !Object.getOwnPropertyDescriptor(material, 'side')?.writable ||
          !Object.getOwnPropertyDescriptor(material, 'defines')?.writable ||
          !sameFields(material.extensions, state.extensions) ||
          matchVariant && (material.side !== state.side || !sameFields(material.defines, state.macros))) return false;
      let count = 0;
      for (const key of Object.keys(material)) {
        if (key === '_listeners' || key === 'version' || key === 'side' || key === 'defines') continue;
        const descriptor = Object.getOwnPropertyDescriptor(material, key);
        if (!Object.hasOwn(state.fields, key) || !('value' in descriptor) ||
            descriptor.value !== state.fields[key]) return false;
        count++;
      }
      return count === Object.keys(state.fields).length;
    }

    function lightShape(light) {
      return [light.isLight, light.isAmbientLight, light.isLightProbe, light.isDirectionalLight,
        light.isPointLight, light.isSpotLight, light.isRectAreaLight, light.isHemisphereLight,
        light.layers?.mask, light.castShadow, light.map, light.shadow, light.shadow?.map];
    }

    function renderShape() {
      const target = renderer.getRenderTarget();
      return [target, target?.isXRRenderTarget, target?.texture?.colorSpace, renderer.outputColorSpace,
        renderer.toneMapping, renderer.shadowMap?.enabled, renderer.shadowMap?.type,
        renderer.localClippingEnabled, renderer.clippingPlanes?.length,
        renderer.state?.buffers?.depth?.getReversed?.()];
    }

    function unchangedView(view) {
      return view.scene.fog === view.fog && view.fog?.isFogExp2 === view.fogType &&
        view.scene.environment === view.environment && view.scene.environmentRotation === view.environmentRotation &&
        view.camera.layers?.mask === view.cameraLayers && sameArray(renderShape(), view.renderShape) &&
        view.lights.every((light, index) => sameArray(lightShape(light), view.lightShapes[index]));
    }

    const watched = new Set(), deadOwners = new WeakSet();
    function ownerDisposed(event) { deadOwners.add(event.target); }
    function watch(owner) {
      if (!watched.has(owner) && typeof owner.addEventListener === 'function' &&
          typeof owner.removeEventListener === 'function') {
        watched.add(owner);
        owner.addEventListener('dispose', ownerDisposed);
      }
    }

    function capture(camera, scene, geometry, material, object) {
      if (!canCompile || !camera?.isCamera || !scene?.isScene || !material?.isMaterial ||
          !geometry?.attributes || !geometry.morphAttributes || renderer.localClippingEnabled === true ||
          renderer.clippingPlanes?.length > 0 ||
          !(object?.isMesh || object?.isLine || object?.isPoints || object?.isSprite)) return;
      const lights = renderer.__qolProbeLights();
      if (!Array.isArray(lights) || lights.some(light => !light?.isLight)) return;
      const shape = geometryShape(object, geometry);
      let view = views.find(item => item.scene === scene && item.camera === camera &&
        sameArray(item.lights, lights) && unchangedView(item));
      if (!view) {
        view = {scene, camera, lights: lights.slice(), lightShapes: lights.map(lightShape),
          fog: scene.fog, fogType: scene.fog?.isFogExp2, environment: scene.environment,
          environmentRotation: scene.environmentRotation, cameraLayers: camera.layers?.mask, renderShape: renderShape()};
        view.compileScene = Object.create(scene);
        Object.defineProperties(view.compileScene, {
          fog: {value: view.fog}, environment: {value: view.environment},
          environmentRotation: {value: view.environmentRotation},
          traverseVisible: {value: visit => { for (const light of view.lights) visit(light); }}
        });
        views.push(view);
      }
      let variants = byMaterial.get(material);
      if (!variants) byMaterial.set(material, variants = []);
      if (variants.some(entry => entry.view === view && sameArray(entry.shape, shape) &&
          sameMaterial(material, entry.state, true))) return;
      const state = materialSnapshot(material);
      // Three's compile() would otherwise add both sides rather than this
      // particular renderBufferDirect submission.
      if (!state || material.transparent === true && state.side === 2 && material.forceSinglePass === false) return;
      const properties = {};
      for (const key of ['isMesh', 'isLine', 'isPoints', 'isSprite', 'isInstancedMesh', 'isSkinnedMesh',
        'isBatchedMesh', 'instanceColor', 'morphTexture', '_colorsTexture', 'colorTexture']) properties[key] = object[key];
      const entry = {camera, geometry, material, object, view, state, shape, properties};
      variants.push(entry);
      submissions.push(entry);
      watch(material);
      watch(geometry);
    }

    function preparePrograms() {
      let cancel;
      const promise = handled(new Promise((resolve, reject) => {
        const context = renderer.getContext(), canvas = renderer.domElement;
        const originalDispose = renderer.dispose, ownsDispose = Object.hasOwn(renderer, 'dispose');
        const programs = new Set(), materials = new Set(), geometries = new Set();
        let timer = null, settled = false;

        function cleanup() {
          clearTimeout(timer);
          canvas?.removeEventListener('webglcontextlost', contextLost);
          for (const material of materials) material.removeEventListener?.('dispose', objectDisposed);
          for (const geometry of geometries) geometry.removeEventListener?.('dispose', objectDisposed);
          if (renderer.dispose === disposeRenderer) {
            if (ownsDispose) renderer.dispose = originalDispose;
            else delete renderer.dispose;
          }
          preparations.delete(cancel);
          programs.clear();
          materials.clear();
          geometries.clear();
        }

        function finish(error) {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve();
        }

        cancel = reason => finish(reason ?? new DOMException('Shader preparation cancelled', 'AbortError'));
        function contextLost() { cancel(new DOMException('WebGL context lost during shader preparation', 'AbortError')); }
        function objectDisposed() { cancel(new DOMException('Shader owner disposed during preparation', 'AbortError')); }
        function disposeRenderer(...args) {
          cancel(new DOMException('Renderer disposed during shader preparation', 'AbortError'));
          return originalDispose.apply(this, args);
        }

        function poll() {
          timer = null;
          if (settled) return;
          try {
            if (context.isContextLost()) { contextLost(); return; }
            for (const program of programs) {
              if (program.program === undefined) { objectDisposed(); return; }
              if (!program.isReady()) continue;
              // Reflection is cached by Three; never ask for it until KHR says
              // linking is complete and never on an unsupported driver.
              program.getUniforms();
              program.getAttributes();
              if (program.diagnostics?.runnable === false) throw new Error('Map shader failed to link');
              programs.delete(program);
            }
            if (programs.size) timer = setTimeout(poll, 10);
            else finish();
          } catch (error) {
            finish(error);
          }
        }

        preparations.add(cancel);
        canvas?.addEventListener('webglcontextlost', contextLost);
        if (typeof originalDispose === 'function') renderer.dispose = disposeRenderer;
        try {
          if (context.isContextLost()) { contextLost(); return; }
          for (const entry of submissions) {
            if (settled) return;
            const {material, geometry, object, view, state, camera} = entry;
            // Probe callbacks may mutate or dispose an earlier submission.
            // Only replay side/defines; skip any other uncertain state.
            if (deadOwners.has(material) || deadOwners.has(geometry) || !unchangedView(view) ||
                !sameArray(geometryShape(object, geometry), entry.shape) || !sameMaterial(material, state, false)) continue;
            if (!materials.has(material)) {
              materials.add(material);
              material.addEventListener?.('dispose', objectDisposed);
            }
            if (!geometries.has(geometry)) {
              geometries.add(geometry);
              geometry.addEventListener?.('dispose', objectDisposed);
            }
            const objectView = Object.create(object);
            for (const [key, value] of Object.entries({...entry.properties, geometry, material})) {
              Object.defineProperty(objectView, key, {value, configurable: true, writable: true});
            }
            const root = {traverse: visit => visit(objectView), traverseVisible() {}};
            const properties = renderer.properties.get(material);
            const savedSide = material.side, savedDefines = material.defines;
            try {
              material.side = state.side;
              material.defines = state.macros;
              renderer.compile(root, camera, view.compileScene);
            } finally {
              material.side = savedSide;
              material.defines = savedDefines;
              // compile() changes the material's current program and lighting
              // state. Make the next real draw select its own native variant.
              properties.__version = -1;
            }
            if (settled) return;
            const program = properties.currentProgram;
            if (program && typeof program.isReady === 'function' &&
                typeof program.getUniforms === 'function' && typeof program.getAttributes === 'function') programs.add(program);
          }
          poll();
        } catch (error) {
          finish(error);
        }
      }));
      return {promise, cancel};
    }

    const original = renderer.renderBufferDirect;
    const owned = Object.prototype.hasOwnProperty.call(renderer, 'renderBufferDirect');
    const probe = function(camera, scene, geometry, material, object, group) {
      collectMaterial(material);
      capture(camera, scene, geometry, material, object);
    };
    renderer.renderBufferDirect = probe;
    try {
      // draw is the synchronous native render path. It retains native PVS,
      // frustum tests and material selection, but submits no geometry draws.
      draw();
    } finally {
      if (renderer.renderBufferDirect === probe) {
        if (owned) renderer.renderBufferDirect = original;
        else delete renderer.renderBufferDirect;
      }
      for (const owner of watched) owner.removeEventListener('dispose', ownerDisposed);
    }
    active();
    const urls = new Set(), pending = [];
    let needsShaders = false;
    for (const binding of selected) {
      for (const url of binding.urls) if (!published(url)) urls.add(url);
      pending.push(binding.promise);
      needsShaders ||= binding.pending;
    }
    resources.prioritize(urls);
    active();
    // Three's compileAsync uses uncancellable internal timers and can throw
    // after renderer disposal. Submit the same KHR-parallel work through its
    // native compile path, but own the cancellable readiness polling.
    const shaders = canCompile && submissions.length && needsShaders ? preparePrograms() : null;
    const uploads = [];
    if (resources.preparedMeshes && typeof renderer.initTexture === 'function') {
      // Worker asset preparation continues independently while the page uploads
      // finished first-view textures through Three's native ownership/cache.
      for (const [texture, registered] of selectedTextures) {
        uploads.push(handled(wait(Promise.all(registered.map(binding => binding.promise))).then(() => {
          active();
          if (!renderer.getContext?.().isContextLost?.()) renderer.initTexture(texture);
        })));
      }
    }
    try {
      await wait(Promise.all([Promise.all(pending), ...uploads, ...(shaders ? [shaders.promise] : [])]));
    } catch (error) {
      shaders?.cancel(error);
      throw error;
    }
  }

  function prepare(renderer, draw) {
    return handled(prepareVisible(renderer, draw));
  }

  function dispose() {
    if (cancelledResources) return;
    cancelledResources = true;
    stop(signal.reason);
    // Renderer disposal closes published images; cancellation closes late decodes.
    resources.cancel();
  }

  return {bind, prepare, complete, dispose, get disposed() { return disposed; }};
}

// Injected alongside the native renderer. Resource creation remains native;
// this queue only submits uploads/compiles, never a render or framebuffer clear.
export function createMapGpuPreparation(renderer, scenes, camera, textureMaps, assetsReady, zones, atlases = []) {
  const context = renderer.getContext(), canvas = renderer.domElement;
  let resolveReady, rejectReady, started = false, stopped = false, scheduled = null;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const idle = typeof requestIdleCallback === 'function' && typeof cancelIdleCallback === 'function';
  const originalDispose = renderer.dispose, ownsDispose = Object.hasOwn(renderer, 'dispose');
  let textureIterator, textureOwner, texturePassChanged = false, texturesFinished = false, assetsFinished = false, fence = null;
  const seenTextures = new Map(), programs = new Set(), seenPrograms = new Set();
  const materials = new Set(), disposedMaterials = new WeakSet();
  const geometries = new Set(), disposedGeometries = new WeakSet();
  const failedAtlases = new Set();
  let atlasesFinished = atlases.length === 0;
  const stack = [], objects = [];
  let sceneIndex = 0, geometryIndex = 0, objectIndex = 0, programIterator;
  // compile() accepts a traversal root separately from the scene whose fog,
  // environment and lights determine the native program cache key.
  let selectedObject;
  const root = {traverse(visit) { visit(selectedObject); }, traverseVisible() {}};
  const parallel = renderer.extensions.get('KHR_parallel_shader_compile') !== null;
  const syncSupported = typeof context.fenceSync === 'function' && typeof context.clientWaitSync === 'function' &&
    typeof context.deleteSync === 'function' && typeof context.flush === 'function';

  function cleanup() {
    if (scheduled !== null) {
      if (idle) cancelIdleCallback(scheduled);
      else clearTimeout(scheduled);
      scheduled = null;
    }
    if (fence !== null) { context.deleteSync(fence); fence = null; }
    canvas?.removeEventListener('webglcontextlost', contextLost);
    if (renderer.dispose === disposeRenderer) {
      if (ownsDispose) renderer.dispose = originalDispose;
      else delete renderer.dispose;
    }
    stack.length = objects.length = 0;
    for (const material of materials) material.removeEventListener?.('dispose', onMaterialDispose);
    for (const geometry of geometries) geometry.removeEventListener?.('dispose', onGeometryDispose);
    geometries.clear();
    materials.clear();
    seenTextures.clear();
    failedAtlases.clear();
    programs.clear();
    seenPrograms.clear();
    textureIterator = textureOwner = programIterator = selectedObject = null;
  }

  function dispose(reason = new DOMException('GPU preparation disposed', 'AbortError')) {
    if (stopped) return;
    stopped = true;
    cleanup();
    rejectReady(reason);
  }

  function disposeRenderer(...args) {
    dispose();
    return originalDispose.apply(this, args);
  }

  function contextLost() {
    dispose(new DOMException('WebGL context lost during GPU preparation', 'AbortError'));
  }

  function schedule() {
    if (stopped || scheduled !== null) return;
    scheduled = idle ? requestIdleCallback(step, {timeout: 100}) : setTimeout(step, 16);
  }

  function invalidateTextures() {
    if (stopped || !started) return;
    if (fence !== null) { context.deleteSync(fence); fence = null; }
    texturesFinished = texturePassChanged = false;
    textureIterator = textures();
    schedule();
  }

  function onMaterialDispose(event) {
    disposedMaterials.add(event.target);
  }

  function onGeometryDispose(event) {
    disposedGeometries.add(event.target);
  }

  function attached(object, scene) {
    for (let node = object; node; node = node.parent) if (node === scene) return true;
    return false;
  }

  function live(entry) {
    return attached(entry.object, entry.scene) && !disposedGeometries.has(entry.geometry) &&
      !(Array.isArray(entry.object.material) ? entry.object.material.some(wasDisposed) : wasDisposed(entry.object.material));
  }

  function wasDisposed(material) {
    return disposedMaterials.has(material);
  }

  function rememberMaterial(material) {
    if (Array.isArray(material)) {
      for (const entry of material) rememberMaterial(entry);
    } else if (material && !materials.has(material)) {
      materials.add(material);
      material.addEventListener?.('dispose', onMaterialDispose);
    }
  }

  function* uniformValues(value, seen) {
    // Yield non-texture values too, so a large uniform structure cannot hide
    // an unbounded scan inside a single iterator.next() operation.
    yield value;
    if (!value || typeof value !== 'object' || value.isTexture ||
        ArrayBuffer.isView(value) || seen.has(value)) return;
    seen.add(value);
    for (const key in value) if (Object.hasOwn(value, key)) yield* uniformValues(value[key], seen);
  }

  function* textures() {
    textureOwner = null;
    for (const map of textureMaps) yield* map.values();
    for (const scene of scenes) if (scene.background?.isTexture) yield scene.background;
    if (zones) yield* zones.__qolZoneTextures();
    yield* atlases;
    const seen = new Set();
    for (const material of materials) {
      if (wasDisposed(material)) continue;
      textureOwner = material;
      // Stage-label CanvasTextures and other scene-owned maps do not belong
      // to the BSP texture caches. Inspect each unique live material once.
      for (const key in material) if (Object.hasOwn(material, key)) yield material[key];
      const uniforms = material.uniforms;
      if (uniforms) for (const key in uniforms) if (Object.hasOwn(uniforms, key)) {
        yield* uniformValues(uniforms[key]?.value, seen);
      }
    }
    textureOwner = null;
  }

  function collect() {
    if (stack.length === 0) {
      if (sceneIndex === scenes.length) return false;
      const scene = scenes[sceneIndex++];
      const lights = [], view = Object.create(scene);
      // A single scene walk records native visible lights instead of making
      // compile() walk the entire map again for each individual mesh.
      view.traverseVisible = visit => { for (const light of lights) visit(light); };
      stack.push({object: scene, scene, view, lights, visible: true, child: -1});
    }
    const entry = stack[stack.length - 1], {object, scene, view, lights} = entry;
    if (!attached(object, scene)) { stack.pop(); return true; }
    if (entry.child === -1) {
      entry.visible &&= object.visible !== false;
      if (object.isLight && entry.visible) lights.push(object);
      if (object.isMesh || object.isLine || object.isPoints || object.isSprite) {
        objects.push({object, scene, view, geometry: object.geometry});
        if (object.geometry && !geometries.has(object.geometry)) {
          geometries.add(object.geometry);
          object.geometry.addEventListener?.('dispose', onGeometryDispose);
        }
        rememberMaterial(object.material);
      }
      entry.child = 0;
      entry.visited = new Set();
    } else {
      const children = object.children;
      // Removal/reordering can shift the next sibling between idle slices.
      // Restart that parent's cursor only on an observed shift; identities
      // already visited are skipped one per operation, never copied in bulk.
      if (entry.child && children?.[entry.child - 1] !== entry.previous) entry.child = 0;
      if (entry.child < (children?.length ?? 0)) {
        const child = children[entry.child++];
        entry.previous = child;
        if (!entry.visited.has(child)) {
          entry.visited.add(child);
          stack.push({object: child, scene, view, lights, visible: entry.visible, child: -1});
        }
      } else stack.pop();
    }
    return true;
  }

  function prepareGeometry() {
    if (geometryIndex === objects.length) return false;
    const entry = objects[geometryIndex++], {object} = entry;
    if (!live(entry)) return true;
    // The private adapter retains native ownership/version/disposal paths,
    // without stamping the next PVS traversal's object/geometry frame cache.
    if (object.geometry) renderer.__qolPrepareGeometry(object);
    return true;
  }

  function prepareObject() {
    if (!atlasesFinished || objectIndex === objects.length) return false;
    const entry = objects[objectIndex++], {object, view} = entry;
    if (!live(entry)) return true;
    rememberMaterial(object.material);
    selectedObject = object;
    const materials = renderer.compile(root, camera, view);
    if (parallel) for (const material of materials) {
      const variants = renderer.properties.get(material).programs;
      if (variants) for (const program of variants.values()) if (!seenPrograms.has(program)) {
        seenPrograms.add(program);
        programs.add(program);
      }
    }
    return true;
  }

  function uploadTexture() {
    if (!assetsFinished || !atlasesFinished || texturesFinished) return false;
    const entry = textureIterator.next();
    if (entry.done) {
      if (texturePassChanged) {
        texturePassChanged = false;
        textureIterator = textures();
        return true;
      }
      texturesFinished = true;
      return false;
    }
    const texture = entry.value;
    if (failedAtlases.has(texture)) return true;
    if (textureOwner && wasDisposed(textureOwner)) return true;
    if (texture?.isTexture && (!seenTextures.has(texture) || seenTextures.get(texture) !== texture.version)) {
      const version = texture.version;
      renderer.initTexture(texture);
      seenTextures.set(texture, version);
      texturePassChanged = true;
    }
    return true;
  }

  function pollProgram() {
    if (!programIterator) programIterator = programs.values();
    const entry = programIterator.next();
    if (entry.done) { programIterator = null; return false; }
    // isReady() is the native KHR COMPLETION_STATUS_KHR-only query. Never
    // force LINK_STATUS/getUniforms/getAttributes on unsupported browsers.
    const program = entry.value;
    if (program.program === undefined) programs.delete(program);
    else if (program.isReady()) {
      // Native diagnostics/reflection run only after KHR says linking has
      // finished. They retain Three's shader diagnostics and never draw.
      program.getUniforms();
      program.getAttributes();
      if (program.diagnostics?.runnable === false) throw new Error('Map shader failed to link');
      programs.delete(program);
    }
    return true;
  }

  function gpuComplete() {
    if (!syncSupported) return true;
    if (fence === null) {
      fence = context.fenceSync(context.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (fence === null) throw new Error('Unable to create GPU preparation fence');
      context.flush();
      return false;
    }
    const status = context.clientWaitSync(fence, 0, 0);
    if (status === context.WAIT_FAILED) throw new Error('GPU preparation fence failed');
    return status === context.ALREADY_SIGNALED || status === context.CONDITION_SATISFIED;
  }

  function step(deadline) {
    scheduled = null;
    if (stopped) return;
    if (context.isContextLost()) { contextLost(); return; }
    const began = performance.now();
    try {
      // Both a time and an operation cap matter: even a cheap/mock driver
      // must yield, and an idle callback with no budget still makes progress.
      for (let count = 0; count < 64; count++) {
        if (context.isContextLost()) { contextLost(); return; }
        if (!collect() && !prepareGeometry() && !prepareObject() && !uploadTexture()) {
          if (!assetsFinished || !atlasesFinished) return; // Settlement schedules the next slice.
          if (programs.size === 0) {
            if (gpuComplete()) {
              stopped = true;
              cleanup();
              resolveReady({uploadsComplete: syncSupported, shadersComplete: parallel,
                completion: syncSupported && parallel ? 'gpu-complete' : 'submitted'});
            } else schedule();
            return;
          }
          if (!pollProgram()) break; // At most one query per program per slice.
        }
        if (performance.now() - began >= 4 || deadline?.timeRemaining() <= 0) break;
      }
      schedule();
    } catch (error) {
      dispose(error);
    }
  }

  function start() {
    if (started || stopped) return ready;
    started = true;
    textureIterator = textures();
    if (!atlasesFinished) Promise.all(atlases.map(texture => texture.__qolAtlasReady.then(loaded => {
      if (!stopped && !loaded) failedAtlases.add(texture);
    }))).then(() => {
      if (stopped) return;
      atlasesFinished = true;
      schedule();
    }, dispose);
    // Register before scheduling so a background decode failure never turns
    // placeholder uploads into a successful GPU-completion result.
    Promise.resolve().then(assetsReady).then(() => {
      if (stopped) return;
      assetsFinished = true;
      schedule();
    }, dispose);
    schedule();
    return ready;
  }

  renderer.dispose = disposeRenderer;
  canvas?.addEventListener('webglcontextlost', contextLost);
  if (context.isContextLost()) contextLost();
  return {ready, start, dispose, invalidateTextures};
}
