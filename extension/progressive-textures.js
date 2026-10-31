// This function is injected into the native module via toString(): keep every
// helper inside it and leave texture construction/decoding to the native hooks.
export function createProgressiveTextureBindings(resources) {
  const bindings = new WeakMap(), completions = [];
  const signal = resources.signal;
  let disposed = false, cancelledResources = false, disposalReason, rejectDisposed, completion;

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
    const binding = {urls: typeof urls === 'string' ? [urls] : [...new Set(urls)], promise: null};
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
      if (pending.length) binding.promise = Promise.all(pending).then(finish);
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

    const selected = new Set();
    function collectTexture(value) {
      const registered = bindings.get(value);
      if (registered) for (const binding of registered) selected.add(binding);
      return registered !== undefined;
    }

    function collectMaterial(material) {
      if (!material) return;
      // Read at each native submission: onBeforeRender can change the same
      // material's uniforms for successive objects during the probe traversal.
      for (const key in material) {
        if (Object.prototype.hasOwnProperty.call(material, key)) collectTexture(material[key]);
      }
      const seen = new Set(), stack = [];
      const uniforms = material.uniforms;
      if (uniforms) for (const key in uniforms) {
        if (Object.prototype.hasOwnProperty.call(uniforms, key)) stack.push(uniforms[key]?.value);
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

    const original = renderer.renderBufferDirect;
    const owned = Object.prototype.hasOwnProperty.call(renderer, 'renderBufferDirect');
    renderer.renderBufferDirect = function(camera, scene, geometry, material, object, group) {
      collectMaterial(material);
    };
    try {
      // draw is the synchronous native render path. It retains native PVS,
      // frustum tests and material selection, but submits no geometry draws.
      draw();
    } finally {
      if (owned) renderer.renderBufferDirect = original;
      else delete renderer.renderBufferDirect;
    }
    active();
    const urls = new Set(), pending = [];
    for (const binding of selected) {
      for (const url of binding.urls) if (!published(url)) urls.add(url);
      pending.push(binding.promise);
    }
    resources.prioritize(urls);
    await wait(Promise.all(pending));
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
