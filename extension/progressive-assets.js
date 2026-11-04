// Self-contained so native hooks can inject this function with .toString().
export async function loadProgressiveAssets(data, packs, useCompressed, signal, hooks) {
  // Decide before fetching or transferring any native pack body. A blocked or
  // unsupported worker leaves the existing native loader completely untouched.
  let worker = null;
  if (hooks.fetchPack && typeof __qolCreateMapLoadJobs === 'function' &&
      typeof __qolMapWorkerSource === 'string' && __qolMapWorkerSource) {
    let candidate;
    try {
      candidate = __qolCreateMapLoadJobs(__qolMapWorkerSource, signal);
      if (await candidate.ready) worker = candidate;
      else candidate.dispose();
    } catch (error) {
      candidate?.dispose();
      if (signal.aborted) throw signal.reason ?? error;
    }
  }

  const meshes = new Map(), preparedMeshes = worker ? new Map() : undefined, images = new Map(), compressed = new Map();
  const pendingImages = new Map(), pendingCompressed = new Map();
  const assets = new Map(), alternatives = new Map(), meshCounts = new Map();
  // Native rendering falls back to fog unless all six sky faces are present.
  const sky = new Set(data.sky?.length === 6 && data.sky.every(Boolean) ? data.sky : []);
  let skyRemaining = sky.size;
  // Lighting is a useful early hint, not a handoff requirement. A real
  // first-view selection later receives strictly higher priority.
  const lighting = new Set();
  if (worker) {
    for (const url of [...(data.lightmaps ?? []).map(value => value.url),
      data.propLighting?.url, data.propLodLighting?.url]) {
      if (url) lighting.add(useCompressed ? data.compressedTextures?.[url]?.url ?? url : url);
    }
    function recordMeshes(meshes) {
      for (const mesh of meshes ?? []) {
        if (!mesh?.url) continue;
        if (!meshCounts.has(mesh.url)) meshCounts.set(mesh.url, mesh.vertexCount);
        else if (meshCounts.get(mesh.url) !== mesh.vertexCount) meshCounts.set(mesh.url, null);
      }
    }
    recordMeshes(data.world);
    recordMeshes(data.skyOccluders);
    for (const model of data.models ?? []) {
      recordMeshes(model.meshes);
      for (const lod of model.lods ?? []) recordMeshes(lod.meshes);
    }
  }
  const unread = [], decodeQueue = [];
  let remaining = 0, criticalRemaining = 0, producers = 2, decoders = 0;
  let stopped = false, handedOff = false, workerPacks = 0, finishing = false, workerFinished = false;

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
          priority: critical ? 3 : lighting.has(entry.url) ? 1 : 0, critical, packs: [],
          assetLength: entry.assetLength, vertexCount: meshCounts.get(entry.url),
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
    meshes, preparedMeshes, images, compressed, pendingImages, pendingCompressed,
    ready: completion.promise, prioritize, cancel, signal, skyPreparation: null,
  };

  function sortWork() {
    // Stable sorting preserves manifest order among equally important work.
    unread.sort((a, b) => b.priority - a.priority);
    decodeQueue.sort((a, b) => b.priority - a.priority);
  }

  function prioritize(urls) {
    if (stopped) return;
    const selected = [];
    for (const url of urls) {
      const asset = assets.get(useCompressed ? data.compressedTextures?.[url]?.url ?? url : url);
      if (!asset || asset.settled) continue;
      asset.priority = Math.max(asset.priority, 2);
      for (const work of asset.packs) work.priority = Math.max(work.priority, asset.priority);
      selected.push(asset.url);
    }
    sortWork();
    if (worker && selected.length) worker.run('prioritize', {urls: selected}).catch(error => {
      if (!workerFinished) fail(error);
    });
    decodeImages();
  }

  function fail(error) {
    if (stopped) return;
    stopped = true;
    const failure = signal.aborted ? signal.reason ?? error : error;
    resources.skyPreparation?.cancel(failure);
    worker?.dispose();
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
      preparedMeshes?.clear();
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
    if (worker && producers === 0 && workerPacks === 0 && !finishing) {
      finishing = true;
      worker.run('finish', {}).then(() => {
        workerFinished = true;
        worker.dispose();
        if (remaining !== 0) fail(new Error('Incomplete visual assets'));
        else checkReady();
      }, fail);
    }
    if (remaining === 0 && producers === 0 && (!worker || workerFinished)) {
      signal.removeEventListener('abort', onAbort);
      completion.resolve();
      // Settled promise maps and published resources remain consumer-owned;
      // pack metadata and assembly bookkeeping are no longer needed.
      assets.clear();
    }
  }

  function publish(asset, value, prepared) {
    if (stopped) return;
    if (asset.kind === 'mesh') {
      meshes.set(asset.url, value);
      if (prepared) preparedMeshes?.set(asset.url, prepared);
    }
    else if (asset.kind === 'compressed-texture') compressed.set(asset.alternative.key, value);
    else images.set(asset.url, value);
    if (sky.has(asset.url) && --skyRemaining === 0 && hooks.prepareSky) {
      // Begin as soon as the last face is decoded, not when meshes or the
      // renderer finish. Preparation never takes ownership of these images.
      resources.skyPreparation = hooks.prepareSky(data.sky.map(url => images.get(url)), data.skyTransforms, signal);
    }
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
          if (!stopped && worker) worker.run('image-decoded', {url: asset.url}).catch(fail);
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

  function receiveWorkerEvent(event, eof) {
    if (stopped) {
      if (event.kind === 'image') event.value?.close?.();
      return;
    }
    try {
      if (event.kind === 'pack-eof') {
        eof.seen = true;
        eof.resolve();
        return;
      }
      if (event.kind === 'asset-error') {
        const error = new Error(event.error.message);
        error.name = event.error.name;
        throw error;
      }
      const asset = assets.get(event.url);
      if (!asset || asset.settled) {
        if (event.kind === 'image') event.value?.close?.();
        throw new Error('Unexpected visual worker asset');
      }
      if (event.kind === 'image-bytes') {
        if (asset.kind !== 'image') throw new Error('Unexpected visual image');
        asset.bytes = new Uint8Array(event.value);
        decodeQueue.push(asset);
        sortWork();
        decodeImages();
      } else if (event.kind === asset.kind) {
        if (asset.kind === 'compressed-texture') {
          if (!asset.alternative) throw new Error('Unexpected native texture');
          hooks.validateDDS(event.value, asset.alternative.descriptor);
        }
        publish(asset, event.value, event.prepared);
      } else {
        if (event.kind === 'image') event.value?.close?.();
        throw new Error('Unexpected visual worker event');
      }
    } catch (error) {
      eof.reject(error);
      fail(error);
    }
  }

  function discardResponse(response, reason) {
    try { response?.body?.cancel(reason)?.catch(() => {}); } catch { /* Already transferred or closed. */ }
  }

  // The worker fetches by URL when the page can name it; a refused response
  // is fetched again through the native loader and streamed to the worker.
  async function sendPack(pack, eof) {
    const description = {byteLength: pack.byteLength, entries: pack.entries};
    const url = hooks.packUrl?.(pack);
    if (url) {
      const request = worker.run('pack', {url, pack: description}, [], event => receiveWorkerEvent(event, eof));
      request.catch(() => {});
      const refused = await Promise.race([eof.promise.then(() => false, () => false),
        request.then(() => false, error => error?.name === 'PackFetchError')]);
      if (!refused) return {request};
      if (stopped) return null;
    }
    const response = await hooks.fetchPack(pack);
    if (stopped) {
      discardResponse(response, signal.reason);
      return null;
    }
    if (!response.ok) {
      discardResponse(response);
      throw new Error(`Visual pack: ${response.status}`);
    }
    if (!response.body) throw new Error('Empty visual pack response');
    try {
      return {request: worker.run('pack', {stream: response.body, pack: description}, [response.body],
        event => receiveWorkerEvent(event, eof)), response};
    } catch (error) {
      discardResponse(response, error);
      throw error;
    }
  }

  async function produceWorker() {
    try {
      while (!stopped && unread.length) {
        const {pack} = unread.shift();
        const eof = deferred();
        workerPacks++;
        let sent;
        try { sent = await sendPack(pack, eof); }
        catch (error) { workerPacks--; throw error; }
        if (!sent) { workerPacks--; return; }
        const {request, response} = sent;
        request.then(() => {
          workerPacks--;
          if (!eof.seen) {
            const error = new Error('Visual pack ended without EOF');
            eof.reject(error);
            fail(error);
            return;
          }
          checkReady();
        }, error => {
          discardResponse(response, error);
          workerPacks--;
          eof.reject(error);
          fail(error);
        });
        await eof.promise;
      }
      producers--;
      checkReady();
    } catch (error) {
      fail(error);
    }
  }

  async function startWorker() {
    try {
      await worker.run('init', {assets: [...assets.values()].map(asset => ({
        url: asset.url, kind: asset.kind, assetLength: asset.assetLength,
        vertexCount: asset.vertexCount, priority: asset.priority,
      }))});
      if (stopped) return;
      // Worker-side fetches keep more packs in flight while the page is busy.
      const lanes = hooks.packUrl ? 4 : 2;
      producers = lanes;
      for (let lane = 0; lane < lanes; lane++) produceWorker();
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
      if (worker) startWorker();
      else {
        produce();
        produce();
        checkReady();
      }
    }
  }
  return initial.promise;
}
