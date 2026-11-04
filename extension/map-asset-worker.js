// One processor owns all fragments for a visual load. Pack streams can run
// concurrently, while image decoding is bounded across packs.
export function createVisualPackProcessor({inflate, decodeImage, decodeMesh, emit}) {
  const assets = new Map(), imageQueue = [], fallbackImages = new Map();
  const controller = new AbortController();
  const maxBytes = 64 * 1024 * 1024;
  let initialized = false, activeImages = 0;

  function errorEvent(id, error) {
    emit(id, {kind: 'asset-error', error: {name: error?.name ?? 'Error', message: error?.message ?? String(error)}});
  }

  function decodeImages() {
    while (activeImages < 4 && imageQueue.length) {
      const job = imageQueue.shift(), {asset, id} = job;
      activeImages++;
      (async () => {
        const bytes = asset.bytes;
        // A null native fallback means this worker cannot produce the image;
        // keep the slot until the page's native decoder has settled.
        const image = await decodeImage(bytes, asset.url, controller.signal, () => null);
        if (image == null) {
          let resolve, reject;
          const acknowledged = new Promise((yes, no) => { resolve = yes; reject = no; });
          fallbackImages.set(asset.url, {resolve, reject});
          asset.bytes = null;
          emit(id, {kind: 'image-bytes', url: asset.url, value: bytes.buffer}, [bytes.buffer]);
          await acknowledged;
        } else {
          asset.bytes = null;
          try { emit(id, {kind: 'image', url: asset.url, value: image}, [image]); }
          catch (error) { image.close?.(); throw error; }
        }
        asset.completed = true;
      })().then(job.resolve, error => {
        errorEvent(id, error);
        job.reject(error);
      }).finally(() => {
        activeImages--;
        decodeImages();
      });
    }
  }

  function enqueueImage(asset, id) {
    let resolve, reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    // A pack may still be reading when a decode rejects.
    result.catch(() => {});
    imageQueue.push({asset, id, resolve, reject});
    imageQueue.sort((a, b) => b.asset.priority - a.asset.priority);
    decodeImages();
    return result;
  }

  function complete(asset, id, decodes) {
    asset.assembled = true;
    if (asset.kind === 'image') {
      decodes.push(enqueueImage(asset, id));
      return;
    }
    const value = asset.bytes.buffer, transfers = [value];
    let prepared;
    if (asset.kind === 'mesh' && Number.isSafeInteger(asset.vertexCount) && asset.vertexCount >= 0) {
      prepared = decodeMesh(value, asset.vertexCount);
      transfers.push(prepared.vertices.buffer);
    }
    asset.bytes = null;
    asset.completed = true;
    emit(id, {kind: asset.kind, url: asset.url, value, prepared}, transfers);
  }

  async function readPack(id, {stream, pack}) {
    if (!initialized) throw new Error('Visual worker is not initialized');
    const {byteLength, entries} = pack;
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > maxBytes || !Array.isArray(entries)) {
      throw new Error('Invalid visual pack size');
    }
    let expected = 0;
    for (const entry of entries) {
      const asset = assets.get(entry.url);
      if (!asset || asset.kind !== entry.kind || entry.offset !== expected ||
          !Number.isSafeInteger(entry.length) || entry.length <= 0 ||
          !Number.isSafeInteger(entry.assetOffset) || entry.assetOffset < 0 ||
          entry.assetLength !== asset.length || entry.assetOffset + entry.length > asset.length) {
        throw new Error('Invalid visual pack entry');
      }
      expected += entry.length;
    }
    if (expected !== byteLength) throw new Error('Incorrect visual pack length');

    const reader = (await inflate(stream, byteLength)).getReader(), decodes = [];
    let position = 0, index = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        if (position + value.byteLength > byteLength) throw new Error('Visual pack exceeds declared size');
        let cursor = 0;
        while (cursor < value.byteLength) {
          const entry = entries[index], asset = assets.get(entry.url);
          const withinEntry = position - entry.offset;
          const count = Math.min(value.byteLength - cursor, entry.length - withinEntry);
          if (asset.assembled || asset.received + count > asset.length) throw new Error('Invalid visual asset fragments');
          asset.bytes ??= new Uint8Array(asset.length);
          asset.bytes.set(value.subarray(cursor, cursor + count), entry.assetOffset + withinEntry);
          asset.received += count;
          cursor += count;
          position += count;
          if (position === entry.offset + entry.length) index++;
          if (asset.received === asset.length) complete(asset, id, decodes);
        }
      }
      if (position !== byteLength) throw new Error('Truncated visual pack');
      // Permit another fetch immediately, but keep this request alive until its
      // image events are delivered and page-decoded fallbacks are acknowledged.
      emit(id, {kind: 'pack-eof'});
      await Promise.all(decodes);
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  return {
    async run(id, type, payload) {
      if (type === 'init') {
        if (initialized) throw new Error('Visual worker is already initialized');
        for (const value of payload.assets) {
          if (assets.has(value.url) || !Number.isSafeInteger(value.assetLength) ||
              value.assetLength <= 0 || value.assetLength > maxBytes) throw new Error('Invalid visual asset');
          assets.set(value.url, {url: value.url, kind: value.kind, length: value.assetLength,
            vertexCount: value.vertexCount, priority: value.priority, received: 0,
            bytes: null, assembled: false, completed: false});
        }
        initialized = true;
      } else if (type === 'pack') {
        await readPack(id, payload);
      } else if (type === 'prioritize') {
        for (const url of payload.urls) {
          const asset = assets.get(url);
          if (asset) asset.priority = Math.max(asset.priority, 2);
        }
        imageQueue.sort((a, b) => b.asset.priority - a.asset.priority);
        decodeImages();
      } else if (type === 'image-decoded') {
        const pending = fallbackImages.get(payload.url);
        if (!pending) throw new Error('Unknown visual image decode');
        fallbackImages.delete(payload.url);
        pending.resolve();
      } else if (type === 'finish') {
        if (!initialized || [...assets.values()].some(asset => !asset.assembled || !asset.completed)) {
          throw new Error('Incomplete visual assets');
        }
        assets.clear();
      } else {
        throw new Error(`Unknown visual worker request: ${type}`);
      }
    },
  };
}
