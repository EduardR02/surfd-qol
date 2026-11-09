// Worker-shaped leases preserve native validation and fallback. One completed
// camera-capable world stays with its renderer until replacement or disposal.
export function createReplayIndexJobs(prepare, createWorkerDefault = null) {
  let slot = null, rendererScope = null, generation = 0, workerFactory = createWorkerDefault;
  const protocol = 1;
  function evict(owner = slot) {
    if (!owner || owner.closed) return;
    owner.closed = true;
    clearTimeout(owner.startupTimeout);
    if (slot === owner) slot = null;
    for (const request of owner.requests.values()) {
      request.cleanup();
      request.reject(new Error('Replay job closed'));
    }
    owner.requests.clear();
    owner.readyResolve(false);
    owner.worldResolve(false);
    owner.worker.onmessage = owner.worker.onerror = owner.worker.onmessageerror = null;
    owner.worker.terminate();
    const lease = owner.lease;
    owner.lease = null;
    owner.replay = null;
    if (lease) lease.map = lease.session = lease.message = null;
    if (lease && !lease.closed) {
      lease.onclose?.();
      lease.closed = true;
    }
  }
  function fail(owner, event) {
    const lease = owner.lease, notify = lease && !lease.closed;
    evict(owner);
    if (notify) lease.onerror?.(event ?? {preventDefault() {}});
  }
  function current(owner, lease) {
    return slot === owner && owner.lease === lease && !lease.closed;
  }
  async function post(owner, lease) {
    if (!lease.message || lease.posting) return;
    lease.posting = true;
    const isCurrent = () => current(owner, lease);
    try {
      let packet = null;
      if (!owner.world) {
        try { packet = await prepare(lease.map, lease.session, lease.message, isCurrent); }
        catch { /* Native geometry loading remains the cold-path fallback. */ }
      }
      if (!owner.ready) await owner.readiness;
      if (!isCurrent()) return;
      const message = {...lease.message, __surfdQolIndex: protocol, type: 'run', job: lease.id};
      const transfer = [];
      if (packet) {
        message.__surfdQolCollision = packet;
        for (const value of Object.values(packet)) {
          if (ArrayBuffer.isView(value) && !transfer.includes(value.buffer)) transfer.push(value.buffer);
        }
      }
      lease.dispatched = true;
      try { owner.worker.postMessage(message, transfer); }
      catch (error) {
        if (!packet) throw error;
        delete message.__surfdQolCollision;
        owner.worker.postMessage(message);
      }
    } catch {
      if (isCurrent()) fail(owner);
    }
  }
  function camera(owner) {
    const handles = new Map();
    const live = () => !owner.closed && slot === owner && owner.scope === rendererScope;
    function rpc(type, data, {signal, onProgress} = {}) {
      if (!live() || signal?.aborted) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const id = ++generation;
        const abort = () => {
          owner.requests.delete(id);
          signal?.removeEventListener('abort', abort);
          try { owner.worker.postMessage({__surfdQolIndex: protocol, type: 'camera-cancel', request: id}); } catch {}
          resolve(null);
        };
        const request = {resolve, reject, onProgress, track: null, tick: data.tick, count: data.options?.a?.count, nearby: data.options?.nearby,
          cleanup: () => signal?.removeEventListener('abort', abort)};
        owner.requests.set(id, request);
        signal?.addEventListener('abort', abort, {once: true});
        owner.readiness.then(async supported => {
          if (!owner.requests.has(id)) return;
          if (supported && !await owner.worldReadiness) supported = false;
          if (!owner.requests.has(id)) return;
          if (!supported || !live()) { owner.requests.delete(id); request.cleanup(); resolve(null); return; }
          try { owner.worker.postMessage({__surfdQolIndex: protocol, type, request: id, ...data}); }
          catch (error) { owner.requests.delete(id); request.cleanup(); reject(error); }
        });
      });
    }
    function encode(track) {
      if (!track) return track;
      if (track._cinemaWorker === api && owner.knownTracks.has(track._cinemaHandle.id)) return {handle: track._cinemaHandle, count: track.count};
      const {_cinemaWorker, _cinemaHandle, ...data} = track;
      for (const key of ['position', 'normal', 'yaw', 'ducked', 'elapsed', 'phase', 'cut']) {
        const values = data[key], size = key === 'position' || key === 'normal' ? 3 : 1;
        if (values && (values.length > track.count * size || values.byteLength !== values.buffer.byteLength))
          data[key] = values.slice(0, track.count * size);
      }
      return data;
    }
    const api = {
      async record({replay, signal, onProgress, tick = 0}) {
        let id = owner.replays.get(replay);
        if (id === undefined || !owner.knownTracks.has(id)) {
          id = ++generation;
          owner.replays.set(replay, id);
          owner.knownTracks.add(id);
        }
        const handle = handles.get(id) ?? {pending: 0, retained: false};
        handles.set(id, handle);
        handle.pending++;
        try {
          const track = await rpc('record', {id, tick, replay}, {signal, onProgress});
          if (signal?.aborted) return null;
          if (track) {
            handle.retained = true;
            track._cinemaWorker = api;
            track._cinemaHandle = {id, from: 0};
          }
          return track;
        } finally {
          handle.pending--;
          if (handles.get(id) === handle && !handle.pending && !handle.retained) api.release(id);
        }
      },
      retain(id, track = null) {
        const handle = handles.get(id);
        if (handle) handle.retained = true;
        else handles.set(id, {pending: 0, retained: true});
        if (!live()) return;
        try {
          if (track && (track._cinemaWorker !== api || !owner.knownTracks.has(id))) {
            owner.worker.postMessage({__surfdQolIndex: protocol, type: 'camera-store', id, track: encode(track)});
            owner.knownTracks.add(id);
          } else owner.worker.postMessage({__surfdQolIndex: protocol, type: 'camera-retain', id});
        } catch { fail(owner); }
      },
      prioritize(id, tick) {
        if (live()) owner.worker.postMessage({__surfdQolIndex: protocol, type: 'record-priority', id, tick});
      },
      align(a, b, signal) { return rpc('camera-align', {a: encode(a), b: encode(b)}, {signal}); },
      plan(options, signal, world) {
        const data = {...options, a: encode(options.a), others: options.others?.map(other => ({track: encode(other.track),
          map: other.map && other.map.byteLength !== other.map.buffer.byteLength ? other.map.slice() : other.map}))};
        // Added recordings may be retained before the bootstrap world is ready.
        return rpc('camera-plan', {options: data, world: world ?? options.a._cinemaHandle?.id ?? owner.job}, {signal});
      },
      release(id = null) {
        if (id !== null) {
          handles.delete(id);
          if (live()) try { owner.worker.postMessage({__surfdQolIndex: protocol, type: 'camera-release', ids: [id]}); } catch {}
          return;
        }
        for (const [id, request] of owner.requests) {
          request.cleanup(); request.resolve(null); owner.requests.delete(id);
          try { owner.worker.postMessage({__surfdQolIndex: protocol, type: 'camera-cancel', request: id}); } catch {}
        }
        if (live()) try { owner.worker.postMessage({__surfdQolIndex: protocol, type: 'camera-release', ids: [...handles.keys()]}); } catch {}
        handles.clear();
        owner.viewOwned = false;
        if (owner.viewOnly && !owner.world) evict(owner);
      },
      get live() { return live() && owner.camera !== false; },
    };
    return api;
  }
  function cameraMessage(owner, data) {
    const request = owner.requests.get(data.request);
    if (!request) return;
    if (data.type === 'record-chunk' || data.type === 'record-window') {
      const regional = data.type === 'record-window';
      if (!request.track) {
        const count = data.total;
        if (!Number.isSafeInteger(count) || count < 2 || count > 40001 || !Number.isFinite(data.dt) || data.dt <= 0) throw new Error('Invalid worker track length');
        request.track = {count, dt: data.dt, position: new Float32Array(count * 3), normal: new Float32Array(count * 3),
          yaw: new Float32Array(count), ducked: new Uint8Array(count), elapsed: new Float64Array(count), phase: new Uint8Array(count), cut: new Uint8Array(count),
          _cinemaWorker: owner.api, _cinemaHandle: {id: data.id, from: 0}};
        request.received = 0;
        owner.api.lastFirstPositionsDuration = data.duration;
      }
      if (!Number.isSafeInteger(data.from) || !Number.isSafeInteger(data.end) || data.from < 0 || !regional && data.from !== request.received ||
          data.end < data.from || data.end > request.track.count) throw new Error('Invalid worker track range');
      for (const key of ['position', 'normal', 'yaw', 'ducked', 'elapsed', 'phase', 'cut']) {
        const size = key === 'position' || key === 'normal' ? 3 : 1, values = data.arrays?.[key];
        if (!ArrayBuffer.isView(values) || values.length !== (data.end - data.from) * size) throw new Error('Invalid worker track chunk');
        request.track[key].set(values, data.from * size);
      }
      if (!regional) request.received = data.end;
      for (const key of ['start', 'startTick', 'finish', 'splits', 'time']) request.track[key] = data[key];
      if (!request.nearPositions && Number.isFinite(request.tick) &&
          (regional || data.end > Math.min(data.total - 1, request.tick + Math.ceil(6 / data.dt)))) {
        request.nearPositions = true;
        owner.api.lastNearPositionsDuration = data.duration;
      }
      try { request.onProgress?.(request.track, data.end, regional ? {from: data.from, end: data.end} : null); } catch (error) {
        request.cleanup(); owner.requests.delete(data.request); request.reject(error);
        owner.worker.postMessage({__surfdQolIndex: protocol, type: 'camera-cancel', request: data.request});
        return;
      }
      if (!data.done || regional) return;
      if (data.end !== request.track.count) throw new Error('Incomplete worker recording');
      owner.api.lastRecordingDuration = data.duration;
      request.resolve(request.track);
    } else if (data.type === 'camera-plan') {
      owner.api.lastPlanDuration = data.duration;
      owner.api.lastPlanCount = request.count;
      owner.api.lastPlanNearby = request.nearby;
      request.resolve(data.plan);
    } else if (data.type === 'camera-alignment') {
      request.resolve(data.map);
    } else request.reject(new Error(data.error ?? 'Worker camera failed'));
    request.cleanup();
    owner.requests.delete(data.request);
  }
  function forgetPrimary(owner, id) {
    owner.knownTracks.delete(id);
  }
  return {
    acquire(map, replay, session, createWorker = workerFactory) {
      if (!slot || slot.lease || slot.scope !== rendererScope || slot.mapId !== replay.mapId ||
          slot.version !== replay.mapVersion || !slot.world) evict();
      workerFactory ??= createWorker;
      let owner = slot;
      if (owner) {
        owner.replay = replay;
        owner.job = ++generation;
        owner.viewOnly = false;
        if (!owner.knownTracks.has(owner.replays.get(replay))) owner.replays.set(replay, owner.job);
        owner.knownTracks.add(owner.job);
      } else {
        owner = {worker: createWorker(), scope: rendererScope, mapId: replay.mapId, version: replay.mapVersion,
          replay, job: ++generation, viewOwned: false, replays: new WeakMap(), knownTracks: new Set(),
          ready: false, world: false, lease: null, requests: new Map()};
        owner.replays.set(replay, owner.job);
        owner.knownTracks.add(owner.job);
        owner.readiness = new Promise(resolve => { owner.readyResolve = resolve; });
        owner.api = camera(owner);
        owner.worldReadiness = new Promise(resolve => { owner.worldResolve = resolve; });
        slot = owner;
        owner.worker.onmessage = event => {
          if (slot !== owner) return;
          const data = event.data;
          // An unpatched native worker rejects hello. Never run it as though it
          // supported job ownership, generation routing or cancellation.
          if (data?.__surfdQolIndex !== protocol) { fail(owner); return; }
          if (data.type === 'ready') {
            owner.ready = true;
            owner.camera = data.camera === true;
            owner.readyResolve(owner.camera);
            if (owner.viewOnly && !owner.camera) { evict(owner); return; }
            if (owner.lease) void post(owner, owner.lease);
            return;
          }
          if (data.type === 'camera-forget') { forgetPrimary(owner, data.id); return; }
          if (['record-chunk', 'record-window', 'camera-plan', 'camera-alignment', 'camera-error'].includes(data.type)) {
            try { cameraMessage(owner, data); } catch (error) { fail(owner, error); }
            return;
          }
          const lease = owner.lease;
          if (!lease || !current(owner, lease) || data.job !== lease.id) return;
          if (data.type === 'world') {
            if (data.mapId !== owner.mapId || data.mapVersion !== owner.version) { fail(owner); return; }
            owner.world = true;
            clearTimeout(owner.startupTimeout);
            if (owner.viewOwned) owner.api.retain(owner.job);
            owner.worldResolve(true);
            if (owner.viewOnly) { lease.complete = true; lease.terminate(); }
          } else if (data.type === 'batch' && data.ok === true) {
            if (data.batch?.done) lease.complete = true;
            lease.onmessage?.({data});
          } else {
            fail(owner);
          }
        };
        owner.worker.onerror = event => { event.preventDefault?.(); fail(owner, event); };
        owner.worker.onmessageerror = () => fail(owner);
      }
      const lease = {
        id: owner.job, map, session, closed: false, posting: false, dispatched: false, message: null,
        onmessage: null, onerror: null, onclose: null,
        postMessage(message) {
          if (!current(owner, lease)) return;
          lease.message = message;
          void post(owner, lease);
        },
        terminate(failed = false) {
          if (lease.closed) return;
          lease.closed = true;
          if (!currentOwner()) return;
          owner.lease = null;
          if (failed || !lease.complete && !owner.viewOwned && !owner.requests.size ||
              owner.camera === false || !owner.world) { evict(owner); return; }
          lease.map = lease.session = lease.message = null;
          try { owner.worker.postMessage({__surfdQolIndex: protocol, type: 'cancel', job: lease.id}); }
          catch { evict(owner); }
        },
      };
      function currentOwner() { return slot === owner && owner.lease === lease; }
      owner.lease = lease;
      if (!owner.ready) {
        try { owner.worker.postMessage({__surfdQolIndex: protocol, type: 'hello'}); }
        catch { evict(owner); throw new Error('Replay worker initialization failed'); }
      }
      return lease;
    },
    camera(session, replay = null, entry = session?.map) {
      if (!slot && session?.map && replay && workerFactory) {
        let lease;
        try { lease = this.acquire(session.map, replay, session); }
        catch { return null; }
        const owner = slot;
        owner.viewOnly = owner.viewOwned = true;
        // Native indexing has its own 120-second watchdog. A standalone view
        // needs the same bounded startup, including packing and world loading.
        owner.startupTimeout = setTimeout(() => {
          if (slot !== owner || owner.world) return;
          for (const request of owner.requests.values()) {
            request.cleanup();
            request.resolve(null);
          }
          owner.requests.clear();
          evict(owner);
        }, 120000);
        lease.postMessage({entry, currentVersion: session.map.version, replay, __surfdQolViewOnly: true});
      }
      if (!slot || slot.scope !== rendererScope || slot.mapId !== session?.map?.id ||
          slot.version !== session.map.version || slot.camera === false) return null;
      slot.viewOwned = true;
      if (slot.world) slot.api.retain(slot.job);
      return slot.api;
    },
    ownRenderer(renderer) {
      const scope = {};
      rendererScope = scope;
      evict();
      const dispose = renderer.dispose;
      renderer.dispose = function (...args) {
        if (slot?.scope === scope) evict();
        if (rendererScope === scope) rendererScope = null;
        return dispose.apply(this, args);
      };
    },
  };
}

// One active native simulation, with at most the newest pending request. The
// only scheduled task is a yield between active native indexing chunks.
export function createReplayIndexWorker(post, run, pause = () => new Promise(resolve => setTimeout(resolve, 0)), cinema = null) {
  let active = null, pending = null, running = false;
  const protocol = 1;
  async function drain() {
    running = true;
    while (pending) {
      const message = pending;
      pending = null;
      const job = {id: message.job};
      active = job;
      const current = () => active === job;
      const emit = (data, options) => {
        if (current()) post({...data, __surfdQolIndex: protocol, type: 'batch', job: job.id}, options);
      };
      try {
        await run(message, {
          current, emit, pause,
          world(map) {
            if (current()) post({__surfdQolIndex: protocol, type: 'world', job: job.id,
              mapId: map.id, mapVersion: map.version});
          },
        });
      } catch (error) {
        emit({ok: false, error: error instanceof Error ? error.message : String(error)});
      }
      if (current()) active = null;
    }
    running = false;
  }
  return message => {
    if (cinema?.receive(message)) return;
    if (message?.__surfdQolIndex !== protocol) {
      post({ok: false, error: 'Replay index worker protocol unavailable'});
      return;
    }
    if (message.type === 'hello') {
      post({__surfdQolIndex: protocol, type: 'ready', ...(cinema ? {camera: true} : {})});
    } else if (message.type === 'cancel') {
      if (active?.id === message.job) active = null;
      if (pending?.job === message.job) pending = null;
    } else if (message.type === 'run' && Number.isSafeInteger(message.job)) {
      active = null;
      pending = message;
      if (!running) void drain();
    }
  };
}
