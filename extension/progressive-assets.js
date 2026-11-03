// Self-contained so native hooks can inject this function with .toString().
export async function loadProgressiveAssets(data, packs, useCompressed, signal, hooks) {
  const meshes = new Map(), images = new Map(), compressed = new Map();
  const pendingImages = new Map(), pendingCompressed = new Map();
  const assets = new Map(), alternatives = new Map();
  // Native rendering falls back to fog unless all six sky faces are present.
  const sky = new Set(data.sky?.length === 6 && data.sky.every(Boolean) ? data.sky : []);
  const unread = [], decodeQueue = [];
  // Collision JSON shares bandwidth with visual packs. More pack producers can
  // delay collision readiness even when visual transfers finish sooner.
  let remaining = 0, criticalRemaining = 0, producers = 2, decoders = 0;
  let stopped = false, handedOff = false;

  function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Rejection remains observable by consumers, including ready, without an
    // unhandled rejection before a renderer subscribes to background assets.
    promise.catch(() => {});
    return {promise, resolve, reject};
  }

  const initial = deferred(), completion = deferred();
  if (useCompressed) {
    for (const [key, descriptor] of Object.entries(data.compressedTextures ?? {})) {
      alternatives.set(descriptor.url, {key, descriptor});
    }
  }
  for (const pack of packs) {
    const work = {pack, priority: 0};
    for (const entry of pack.entries) {
      let asset = assets.get(entry.url);
      if (!asset) {
        const alternative = alternatives.get(entry.url);
        const critical = entry.kind === 'mesh' || sky.has(entry.url);
        asset = {
          url: entry.url, kind: entry.kind, alternative,
          priority: critical ? 2 : 0, critical, packs: [],
          bytes: null, received: 0, assembled: false, settled: false,
          ...deferred(),
        };
        assets.set(entry.url, asset);
        remaining++;
        if (critical) criticalRemaining++;
        if (entry.kind === 'image') pendingImages.set(entry.url, asset.promise);
        if (entry.kind === 'compressed-texture' && alternative) {
          pendingCompressed.set(alternative.key, asset.promise);
        }
      }
      asset.packs.push(work);
      work.priority = Math.max(work.priority, asset.priority);
    }
    unread.push(work);
  }

  const resources = {
    meshes, images, compressed, pendingImages, pendingCompressed,
    ready: completion.promise, prioritize, cancel, signal,
  };

  function sortWork() {
    // Stable sorting preserves manifest order among equally important work.
    unread.sort((a, b) => b.priority - a.priority);
    decodeQueue.sort((a, b) => b.priority - a.priority);
  }

  function prioritize(urls) {
    if (stopped) return;
    for (const url of urls) {
      const asset = assets.get(useCompressed ? data.compressedTextures?.[url]?.url ?? url : url);
      if (!asset || asset.settled) continue;
      asset.priority = Math.max(asset.priority, 1);
      for (const work of asset.packs) work.priority = Math.max(work.priority, asset.priority);
    }
    sortWork();
    decodeImages();
  }

  function fail(error) {
    if (stopped) return;
    stopped = true;
    const failure = signal.aborted ? signal.reason ?? error : error;
    signal.removeEventListener('abort', onAbort);
    unread.length = decodeQueue.length = 0;
    for (const asset of assets.values()) {
      asset.bytes = null;
      asset.packs.length = 0;
      if (!asset.settled) {
        asset.settled = true;
        asset.reject(failure);
      }
    }
    assets.clear();
    // After handoff the renderer owns published images and finds them in these
    // maps during disposal. Keep them reachable; only late decodes are closed.
    if (!handedOff) {
      for (const image of images.values()) image.close?.();
      meshes.clear();
      images.clear();
      compressed.clear();
    }
    initial.reject(failure);
    completion.reject(failure);
    try { hooks.abort(failure); } catch { /* Keep the original resource failure. */ }
  }

  function cancel() {
    fail(signal.reason ?? new DOMException('Map load aborted', 'AbortError'));
  }

  function onAbort() {
    cancel();
  }

  function checkReady() {
    if (stopped) return;
    if (criticalRemaining === 0 && !handedOff) {
      handedOff = true;
      initial.resolve(resources);
    }
    if (remaining === 0 && producers === 0) {
      signal.removeEventListener('abort', onAbort);
      completion.resolve();
      // Settled promise maps and published resources remain consumer-owned;
      // pack metadata and assembly bookkeeping are no longer needed.
      assets.clear();
    }
  }

  function publish(asset, value) {
    if (stopped) return;
    if (asset.kind === 'mesh') meshes.set(asset.url, value);
    else if (asset.kind === 'compressed-texture') compressed.set(asset.alternative.key, value);
    else images.set(asset.url, value);
    asset.settled = true;
    asset.bytes = null;
    asset.packs.length = 0;
    remaining--;
    if (asset.critical) criticalRemaining--;
    asset.resolve(value);
    checkReady();
  }

  function decodeImages() {
    while (!stopped && decoders < 4 && decodeQueue.length) {
      const asset = decodeQueue.shift();
      const bytes = asset.bytes;
      asset.bytes = null;
      decoders++;
      (async () => {
        try {
          const image = await hooks.decodeImage(bytes, asset.url);
          // A decoder can finish after abort even when the native controller
          // has cancelled network work. Such images never enter resource maps.
          if (stopped) image.close?.();
          else publish(asset, image);
        } catch (error) {
          fail(error);
        } finally {
          decoders--;
          decodeImages();
        }
      })();
    }
  }

  function accept(entry, packBytes) {
    const asset = assets.get(entry.url);
    let bytes = packBytes.subarray(entry.offset, entry.offset + entry.length);
    if (entry.length !== entry.assetLength) {
      asset.bytes ??= new Uint8Array(entry.assetLength);
      asset.bytes.set(bytes, entry.assetOffset);
      asset.received += entry.length;
      if (asset.received !== entry.assetLength) return;
      bytes = asset.bytes;
    }
    asset.assembled = true;
    asset.bytes = null;
    if (entry.kind === 'mesh' || entry.kind === 'compressed-texture') {
      // Fragment assembly already owns an exact-sized buffer. Only copy views
      // into a larger pack: native mesh/DDS readers require an exact ArrayBuffer.
      const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer : bytes.slice().buffer;
      if (entry.kind === 'compressed-texture') {
        if (!asset.alternative) throw new Error('Unexpected native texture');
        hooks.validateDDS(buffer, asset.alternative.descriptor);
      }
      publish(asset, buffer);
    } else {
      asset.bytes = bytes;
      decodeQueue.push(asset);
    }
  }

  async function produce() {
    try {
      while (!stopped && unread.length) {
        const {pack} = unread.shift();
        const bytes = await hooks.readPack(pack);
        if (stopped) return;
        for (const entry of pack.entries) {
          if (stopped) return;
          accept(entry, bytes);
        }
        decodeQueue.sort((a, b) => b.priority - a.priority);
        decodeImages();
        // Fetch the next pack without waiting for this pack's image decodes.
      }
      producers--;
      if (!stopped && producers === 0) {
        for (const asset of assets.values()) {
          if (!asset.assembled) throw new Error('Incomplete visual assets');
        }
      }
      checkReady();
    } catch (error) {
      fail(error);
    }
  }

  signal.addEventListener('abort', onAbort, {once: true});
  if (signal.aborted) onAbort();
  else {
    for (const url of sky) {
      if (!pendingImages.has(url)) {
        fail(new Error('Missing sky image'));
        break;
      }
    }
    if (!stopped) {
      sortWork();
      produce();
      produce();
      checkReady();
    }
  }
  return initial.promise;
}
