// Self-contained: the native loader injects this factory with .toString().
export function createMapLoadJobs(source, signal, streamProbe = true) {
  const requests = new Map();
  let worker = null, objectURL = null, timer = null, nextId = 0;
  let state = 'starting', phase = 'ready', failure;
  let resolveReady, rejectReady, readySettled = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // A load may be cancelled before its caller has subscribed to readiness.
  ready.catch(() => {});

  function revoke() {
    if (objectURL === null) return;
    try { URL.revokeObjectURL(objectURL); } catch { /* Already revoked. */ }
    objectURL = null;
  }

  function closeImages(value) {
    if (typeof ImageBitmap !== 'function' || !value || typeof value !== 'object') return;
    const seen = new WeakSet(), stack = [value];
    while (stack.length) {
      const item = stack.pop();
      if (!item || typeof item !== 'object' || seen.has(item)) continue;
      seen.add(item);
      if (item instanceof ImageBitmap) {
        try { item.close(); } catch { /* An already closed bitmap needs no owner. */ }
      } else if (item instanceof Map) {
        for (const [key, child] of item) stack.push(key, child);
      } else if (item instanceof Set) {
        for (const child of item) stack.push(child);
      } else if (!ArrayBuffer.isView(item) && !(item instanceof ArrayBuffer)) {
        for (const child of Object.values(item)) stack.push(child);
      }
    }
  }

  function stop(error, unavailable = false) {
    if (state === 'closed' || state === 'unavailable') return;
    state = unavailable ? 'unavailable' : 'closed';
    failure = error;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    signal?.removeEventListener('abort', onAbort);
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      try { worker.terminate(); } catch { /* Preserve the original failure. */ }
      worker = null;
    }
    revoke();
    if (!readySettled) {
      readySettled = true;
      if (unavailable) resolveReady(false);
      else rejectReady(error);
    }
    for (const request of requests.values()) request.reject(error);
    requests.clear();
  }

  function unsupported() {
    stop(new Error('Map load worker unavailable'), true);
  }

  function onAbort() {
    stop(signal.reason);
  }

  function workerError(event) {
    event?.preventDefault?.();
    if (state === 'starting') unsupported();
    else stop(new Error(event?.message || 'Map load worker failed'));
  }

  function errorFromWorker(info) {
    const message = typeof info?.message === 'string' ? info.message : 'Map load worker failed';
    const name = typeof info?.name === 'string' ? info.name : 'Error';
    let error;
    switch (name) {
      case 'SyntaxError': error = new SyntaxError(message); break;
      case 'TypeError': error = new TypeError(message); break;
      case 'RangeError': error = new RangeError(message); break;
      case 'ReferenceError': error = new ReferenceError(message); break;
      case 'URIError': error = new URIError(message); break;
      case 'EvalError': error = new EvalError(message); break;
      default: error = new Error(message); error.name = name;
    }
    return error;
  }
  function finishReady() {
    state = 'ready';
    if (timer !== null) { clearTimeout(timer); timer = null; }
    revoke();
    readySettled = true;
    resolveReady(true);
  }


  function receive(event) {
    const data = event?.data;
    if (state === 'closed' || state === 'unavailable') {
      closeImages(data?.event ?? data?.result);
      return;
    }
    if (state === 'starting') {
      if (phase === 'ready' && data?.type === 'ready' && (!streamProbe || data.streams === true)) {
        if (!streamProbe) { finishReady(); return; }
        phase = 'probe';
        try {
          // Test the actual transfer path before detaching any native response.
          const stream = new ReadableStream({start(controller) {
            controller.enqueue(new Uint8Array([81]));
            controller.close();
          }});
          worker.postMessage({type: 'probe', stream}, [stream]);
        } catch { unsupported(); }
      } else if (phase === 'probe' && data?.type === 'probe' && data.ok === true) {
        finishReady();
      } else unsupported();
      return;
    }
    if (!data || typeof data !== 'object' || !Number.isSafeInteger(data.id)) {
      stop(new Error('Invalid map load worker message'));
      return;
    }
    const request = requests.get(data.id);
    if (!request) {
      closeImages(data.event ?? data.result);
      return;
    }
    if (Object.hasOwn(data, 'event')) {
      if (!request.onEvent) closeImages(data.event);
      else {
        try { request.onEvent(data.event); }
        catch (error) { closeImages(data.event); stop(error); }
      }
    } else if (Object.hasOwn(data, 'result')) {
      requests.delete(data.id);
      request.resolve(data.result);
    } else if (Object.hasOwn(data, 'error')) {
      requests.delete(data.id);
      request.reject(errorFromWorker(data.error));
    } else stop(new Error('Invalid map load worker message'));
  }

  async function run(type, payload, transfers = [], onEvent) {
    if (state === 'closed') throw failure;
    if (!await ready) throw failure;
    if (state !== 'ready') throw failure;
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      requests.set(id, {resolve, reject, onEvent});
      try { worker.postMessage({id, type, payload}, transfers); }
      catch (error) { requests.delete(id); reject(error); }
    });
  }

  function dispose() {
    stop(new DOMException('Map load worker disposed', 'AbortError'));
  }

  const jobs = {ready, run, dispose};
  if (signal?.aborted) {
    onAbort();
    return jobs;
  }
  signal?.addEventListener('abort', onAbort, {once: true});
  if (signal?.aborted) {
    onAbort();
    return jobs;
  }
  if (!source || typeof Worker !== 'function' || typeof Blob !== 'function' ||
      typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' ||
      typeof URL.revokeObjectURL !== 'function' || streamProbe && typeof ReadableStream !== 'function') {
    unsupported();
    return jobs;
  }
  try {
    objectURL = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
    worker = new Worker(objectURL);
    worker.onmessage = receive;
    worker.onerror = workerError;
    worker.onmessageerror = workerError;
    // This deadline covers startup and the disposable probe only. It is never
    // used after a native response has been transferred or while parsing data.
    timer = setTimeout(() => { if (state === 'starting') unsupported(); }, 10000);
  } catch { unsupported(); }
  return jobs;
}

// Bundled into the map worker. Pack bodies require a disposable stream probe;
// optional numeric analysis jobs transfer only their own compact buffers.
export function runMapLoadWorker({createVisualPackProcessor, decodeImage, decodeMesh, buildMapBoundsTree, buildPackedRampPreparation, writeMapCache, scope = globalThis}) {
  async function inflate(stream) {
    const reader = stream.getReader(), prefix = [];
    let count = 0, first = -1, second = -1;
    try {
      while (count < 2) {
        const part = await reader.read();
        if (part.done) break;
        const bytes = part.value;
        if (!bytes.length) continue;
        prefix.push(bytes);
        if (count === 0) {
          first = bytes[0];
          if (bytes.length > 1) second = bytes[1];
        } else second = bytes[0];
        count += bytes.length;
      }
    } catch (error) {
      try { reader.releaseLock(); } catch { /* Keep the original stream error. */ }
      throw error;
    }
    const rebuilt = new ReadableStream({
      start(controller) {
        for (const chunk of prefix) controller.enqueue(chunk);
        prefix.length = 0;
      },
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) { controller.close(); reader.releaseLock(); }
          else controller.enqueue(part.value);
        } catch (error) {
          controller.error(error);
          try { reader.releaseLock(); } catch { /* Keep the original stream error. */ }
        }
      },
      cancel(reason) {
        return reader.cancel(reason).finally(() => reader.releaseLock());
      },
    });
    return first === 31 && second === 139 ? rebuilt.pipeThrough(new DecompressionStream('gzip')) : rebuilt;
  }

  function emit(id, event, transfers = []) {
    try { scope.postMessage({id, event}, transfers); }
    catch (error) {
      // A failed transfer leaves the bitmap in this worker's ownership.
      if (typeof ImageBitmap === 'function') for (const value of transfers) {
        if (value instanceof ImageBitmap) try { value.close(); } catch { /* Preserve the transfer failure. */ }
      }
      throw error;
    }
  }

  const processor = createVisualPackProcessor({inflate, decodeImage, decodeMesh, emit});
  async function dispatch({id, type, payload}) {
    try {
      const task = type === 'map-bvh' ? buildMapBoundsTree : type === 'map-ramps' ? buildPackedRampPreparation :
        type === 'map-cache' && writeMapCache ? writeMapCache : null;
      const result = await (task ? task(payload) : processor.run(id, type, payload));
      const transfers = task ? [...new Set(Object.values(result ?? {}).filter(ArrayBuffer.isView).map(value => value.buffer))] : [];
      scope.postMessage({id, result}, transfers);
    } catch (error) {
      scope.postMessage({id, error: {
        name: typeof error?.name === 'string' ? error.name : 'Error',
        message: typeof error?.message === 'string' ? error.message : String(error),
      }});
    }
  }

  scope.onmessage = ({data}) => {
    if (data?.type === 'probe') {
      (async () => {
        try {
          const reader = data.stream.getReader();
          const first = await reader.read(), end = await reader.read();
          reader.releaseLock();
          scope.postMessage({type: 'probe', ok: !first.done && first.value?.length === 1 && first.value[0] === 81 && end.done});
        } catch { scope.postMessage({type: 'probe', ok: false}); }
      })();
    } else if (Number.isSafeInteger(data?.id)) dispatch(data);
  };

  let streams = typeof ReadableStream === 'function' && typeof DecompressionStream === 'function';
  if (streams) {
    try {
      const gzip = new DecompressionStream('gzip');
      streams = !!gzip.readable && !!gzip.writable;
    } catch { streams = false; }
  }
  scope.postMessage({type: 'ready', streams});
}
