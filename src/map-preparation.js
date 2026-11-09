import {packMapBounds, unpackMapBoundsTree, adoptPreparedMapWorld} from '../extension/map-bvh-preparation.js';
import {packRampPreparation, installPreparedRampSurfaces, installCachedRampSurfaces, hasRampSurfaces, cancelRampPreparation} from './map-ramp-preparation.js';
import {openMapCache, hasMapCache, readMapCache, decodeVerifiedMapCacheCooperatively, decodeMapValueCooperatively, cachedWorld} from './map-cache.js';

// After entry, a worker rebuilds the cache record from the HTTP-cached file.
const PERSIST_DELAY = 3000;
// A Demise-sized rebuild holds a 70 MB JSON and its record, so rebuilds run
// one at a time and only the most recent missed maps wait.
const PERSIST_QUEUE = 4;
// Entry waits for the record read and the tree and ramp jobs. The largest,
// Demise's tree, takes about 1.6 s on a fast machine; this leaves room for a
// machine many times slower, so only a worker that stopped replying reaches
// it. The map then loads natively.
const WORKER_DEADLINE = 20000;

const timer = (start, delay) => { const id = setTimeout(start, delay); return () => clearTimeout(id); };

export function defaultCache(indexedDB = globalThis.indexedDB, schedule = timer) {
  let database;
  const db = () => database ??= openMapCache(indexedDB);
  async function stored(key) {
    try {
      const value = await db();
      return !!value && await hasMapCache(value, key);
    } catch {
      // A closed connection can't tell; the reader opens its own.
      database = null;
      return true;
    }
  }
  return {
    // The small index store decides first, so a miss starts the download at
    // once. A worker reads and verifies a stored record when one can start.
    async read(key, createJobs, signal) {
      let job = null;
      try {
        job = createJobs?.('map-cache-read');
        if (!await stored(key)) return null;
        if (job && await job.ready) {
          const stop = schedule(() => job.dispose(), WORKER_DEADLINE);
          try {
            const result = await job.run('map-cache-read', {key});
            return result?.bytes instanceof Uint8Array ? await decodeVerifiedMapCacheCooperatively(result.bytes.buffer, key, signal) : null;
          } finally { stop(); }
        }
      } catch { return null; } finally { job?.dispose(); }
      return readMapCache(await db(), key, signal);
    },
    schedule,
  };
}

// Start preparation while visuals load and join both workers before the native
// synchronous constructor can install the world.
export function createMapPreparation(cache = defaultCache()) {
  const worlds = new WeakMap(), ramps = new WeakMap(), active = new Set();
  // Record rebuilds of missed maps, newest first. They start a delay after the
  // player enters a map; a new load stops the running one and queues it again.
  const queue = [];
  let rebuild = null, resume = null, entered = false, storage = true, rebuildJobs = null;
  // Where the latest load's collision data came from: 'cache', 'download' or null.
  let recordSource = null;

  function queuePersist(payload) {
    if (!storage || rebuild?.payload.key === payload.key) return;
    const index = queue.findIndex(item => item.key === payload.key);
    if (index >= 0) queue.splice(index, 1);
    queue.unshift(payload);
    queue.length = Math.min(queue.length, PERSIST_QUEUE);
  }

  function pausePersist() {
    entered = false;
    resume?.();
    resume = null;
    if (!rebuild) return;
    const {payload, job} = rebuild;
    rebuild = null;
    job.dispose();
    queuePersist(payload);
  }

  function nextPersist() {
    if (!entered || rebuild || resume || !storage || !queue.length) return;
    const payload = queue.shift();
    let job;
    try { job = rebuildJobs('map-cache'); } catch { nextPersist(); return; }
    const current = rebuild = {payload, job};
    job.run('map-cache', payload).then(result => {
      if (rebuild !== current) return;
      // A blocked or full database would discard every later rebuild too.
      if (result?.unavailable) {
        storage = false;
        queue.length = 0;
      }
      finishPersist(current);
    }, () => { if (rebuild === current) finishPersist(current); });
  }

  function finishPersist(current) {
    current.job.dispose();
    rebuild = null;
    nextPersist();
  }

  // Called once the first frame of a newly loaded map is drawn.
  function enterMap() {
    if (entered) return;
    entered = true;
    if (queue.length && storage) resume = cache.schedule(() => { resume = null; nextPersist(); }, PERSIST_DELAY);
  }

  function createLoad(signal = new AbortController().signal, createJobs, lookup = false) {
    if (signal.aborted) return null;
    pausePersist();
    rebuildJobs = createJobs;
    recordSource = null;
    let treeJob, rampJob, treeRecord, rampRecord, prepared = false, disposed = false, finished = 0;
    let jobsStarted = false, cached = null, cancelParse = null;

    function startJobs() {
      if (jobsStarted || disposed) return jobsStarted;
      try {
        treeJob = createJobs('map-bvh');
        rampJob = createJobs('map-ramps');
      } catch {
        treeJob?.dispose();
        rampJob?.dispose();
        treeJob = rampJob = null;
        return false;
      }
      jobsStarted = true;
      return true;
    }
    if (!lookup && !startJobs()) return null;

    function dispose() {
      if (disposed) return;
      disposed = true;
      cancelParse?.();
      if (treeRecord) treeRecord.consumed = true;
      if (rampRecord) { rampRecord.consumed = true; rampRecord.cancel(); }
      treeJob?.dispose();
      rampJob?.dispose();
      cached = null;
      signal.removeEventListener('abort', dispose);
      active.delete(dispose);
    }

    function complete(job) {
      job.dispose();
      if (++finished === 2) {
        signal.removeEventListener('abort', dispose);
        active.delete(dispose);
      }
    }

    active.add(dispose);
    signal.addEventListener('abort', dispose, {once: true});

    // Resolves to the decoded map, or null when the native download must run.
    async function read(key) {
      if (disposed || signal.aborted) return null;
      let record = null;
      if (typeof key === 'string' && key) {
        try { record = await cache.read(key, createJobs, signal); } catch { record = null; }
      }
      if (disposed || signal.aborted) return null;
      if (typeof key === 'string' && key) recordSource = record ? 'cache' : 'download';
      if (record) {
        cached = {...record, key};
        return record.map;
      }
      startJobs();
      return null;
    }

    async function parse(response, nativeReader) {
      if (signal.aborted) throw signal.reason;
      if (disposed || !response?.body || typeof response.clone !== 'function' || !startJobs()) return nativeReader();
      const controller = new AbortController();
      let cancel;
      const cancelled = new Promise(resolve => { cancel = () => { controller.abort(); resolve(null); }; });
      cancelParse = cancel;
      let stop;
      const deadline = new Promise(resolve => {
        stop = cache.schedule(() => {
          cancel();
          treeJob.dispose();
          resolve(null);
        }, WORKER_DEADLINE);
      });
      try {
        const parsed = await Promise.race([deadline, cancelled, (async () => {
          if (!await treeJob.ready || controller.signal.aborted) return null;
          // Aborting the pipe cancels the clone's reader without consuming the
          // original response needed by the native fallback.
          const clone = response.clone(), pipe = new TransformStream();
          const piping = clone.body.pipeTo(pipe.writable, {signal: controller.signal});
          piping.catch(() => {});
          const bytes = await new Response(pipe.readable).arrayBuffer();
          await piping;
          if (controller.signal.aborted) return null;
          const packet = await treeJob.run('map-geometry', new Uint8Array(bytes), [bytes]);
          if (controller.signal.aborted || !packet) return null;
          const {strings, shapes, ...streams} = packet;
          const value = await decodeMapValueCooperatively({strings, shapes, streams}, controller.signal);
          return {value};
        })().catch(() => null)]);
        if (parsed && !disposed && !signal.aborted) return parsed.value;
      } finally {
        stop?.();
        if (cancelParse === cancel) cancelParse = null;
        controller.abort();
      }
      if (signal.aborted) throw signal.reason;
      return nativeReader();
    }

    function persist(map, groundNormal, source) {
      const key = source?.key, url = source?.url;
      if (typeof key === 'string' && typeof url === 'string') queuePersist({key, url, groundNormal, mapId: map.id});
    }

    async function prepareCached(map, groundNormal) {
      const record = cached;
      cached = null;
      // Separate verified map reconstruction, tree validation and native
      // world installation into distinct event-loop turns.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (disposed || signal.aborted) return;
      const world = cachedWorld(record, map);
      if (world) {
        worlds.set(map.brushes, {brushes: map.brushes, triangles: map.displacementTriangles, signal,
          consumed: false, consume() {}, triangleBounds: world.triangleBounds, root: world.root, itemCount: world.itemCount});
      }
      if (Object.is(record.header.groundNormal, groundNormal)) {
        ramps.set(map, {groundNormal, signal, consumed: false, consume() {}, cancel() {}, cached: record.sections});
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      if (!disposed && !signal.aborted) dispose();
    }

    function prepare(map, groundNormal, source) {
      if (cached && cached.map === map && !disposed && !signal.aborted && Array.isArray(map?.brushes)) {
        return prepareCached(map, groundNormal);
      }
      if (prepared || disposed || signal.aborted || !Array.isArray(map?.brushes) || !startJobs()) { dispose(); return; }
      prepared = true;
      persist(map, groundNormal, source);
      treeRecord = {brushes: map.brushes, triangles: map.displacementTriangles,
        signal, consumed: false, consume: () => treeJob.dispose()};
      rampRecord = {groundNormal, signal, consumed: false, result: null, consume: () => rampJob.dispose(),
        cancel() { if (this.requestId !== undefined) cancelRampPreparation(map, groundNormal, this.requestId); }};
      worlds.set(map.brushes, treeRecord);
      ramps.set(map, rampRecord);

      const treeTask = treeJob.ready.then(async available => {
        if (!available || disposed || signal.aborted || treeRecord.consumed) return;
        // Do not join both packing passes to the geometry decode's task.
        await new Promise(resolve => setTimeout(resolve, 0));
        if (disposed || signal.aborted || treeRecord.consumed) return;
        const packed = packMapBounds(map, true);
        if (!packed) return;
        Object.assign(treeRecord, packed);
        const bounds = treeRecord.packedBounds, count = bounds.length / 6;
        delete treeRecord.packedBounds;
        const packet = await treeJob.run('map-bvh', bounds, [bounds.buffer]);
        if (disposed || signal.aborted || treeRecord.consumed) return;
        const root = unpackMapBoundsTree(packet, count);
        if (root !== undefined) treeRecord.root = root;
      }).catch(() => {}).finally(() => complete(treeJob));

      const rampTask = rampJob.ready.then(async available => {
        if (!available || disposed || signal.aborted || rampRecord.consumed || hasRampSurfaces(map, groundNormal)) return;
        await new Promise(resolve => setTimeout(resolve, 0));
        if (disposed || signal.aborted || rampRecord.consumed) return;
        const packet = packRampPreparation(map, groundNormal);
        if (!packet) return;
        rampRecord.requestId = packet.requestId;
        const transfers = Object.values(packet).filter(ArrayBuffer.isView).map(value => value.buffer);
        const result = await rampJob.run('map-ramps', packet, transfers);
        if (!disposed && !signal.aborted && !rampRecord.consumed) rampRecord.result = result;
      }).catch(() => rampRecord.cancel()).finally(() => complete(rampJob));
      const joined = [treeTask, rampTask];
      // Disposal ends both jobs; the tree and ramps are then built natively.
      const stop = cache.schedule(() => { treeJob.dispose(); rampJob.dispose(); }, WORKER_DEADLINE);
      return Promise.all(joined).finally(stop);
    }

    return {read, parse, prepare, dispose};
  }

  function useWorld(world, brushes, triangles, feature, corner, Tree) {
    const record = worlds.get(brushes);
    if (!record || record.consumed) return false;
    if (record.signal.aborted) { record.consumed = true; record.consume(); return false; }
    if (record.triangles !== triangles &&
        !(record.triangles === undefined && Array.isArray(triangles) && triangles.length === 0)) return false;
    if (!record.triangleBounds) {
      record.consumed = true;
      record.consume();
      return false;
    }
    // Native constructors replace an omitted displacement array with a fresh
    // empty default; the prepared bounds still describe that exact empty set.
    if (record.triangles === undefined && Array.isArray(triangles)) record.triangles = triangles;
    return adoptPreparedMapWorld(world, brushes, triangles, feature, corner, Tree, worlds);
  }

  function useRamps(map, groundNormal) {
    const record = ramps.get(map);
    if (!record || record.consumed) return false;
    record.consumed = true;
    record.consume();
    // The cached arrays view the whole record buffer; never keep it with the map.
    const cached = record.cached;
    record.cached = null;
    try {
      if (record.signal.aborted || record.groundNormal !== groundNormal) return false;
      if (cached) {
        const {rampOrdinals, rampComponents, rampNormals} = cached;
        return installCachedRampSurfaces(map, groundNormal, rampOrdinals, rampComponents, rampNormals);
      }
      return record.result != null && installPreparedRampSurfaces(map, groundNormal, record.result);
    } finally { record.cancel(); }
  }

  function destroy() {
    for (const dispose of active) dispose();
    pausePersist();
    queue.length = 0;
    storage = false;
  }

  return {createLoad, useWorld, useRamps, enterMap, recordSource: () => recordSource, destroy};
}
