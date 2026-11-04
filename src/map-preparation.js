import {packMapBounds, unpackMapBoundsTree, adoptPreparedMapWorld} from '../extension/map-bvh-preparation.js';
import {packRampPreparation, installPreparedRampSurfaces, installCachedRampSurfaces, hasRampSurfaces, cancelRampPreparation} from './map-ramp-preparation.js';
import {openMapCache, readMapCache, cachedWorld} from './map-cache.js';

// After entry, a worker rebuilds the cache record from the HTTP-cached file.
const PERSIST_DELAY = 3000;

function defaultCache() {
  let database;
  const db = () => database ??= openMapCache();
  return {
    read: async key => readMapCache(await db(), key),
    schedule: (start, delay) => { const timer = setTimeout(start, delay); return () => clearTimeout(timer); },
  };
}

// Pack only derived data while visuals load. Join workers which have already
// started; unsupported or still-starting workers never add an entry-time wait.
// A cached load skips the download, parse and both workers.
export function createMapPreparation(cache = defaultCache()) {
  const worlds = new WeakMap(), ramps = new WeakMap(), active = new Set(), persisting = new Set();
  const cancelPersist = new Set();

  function createLoad(signal = new AbortController().signal, createJobs, lookup = false) {
    if (signal.aborted) return null;
    let treeJob, rampJob, treeRecord, rampRecord, prepared = false, disposed = false, finished = 0;
    let treeAvailable = false, rampAvailable = false, jobsStarted = false, cached = null;

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
      treeJob.ready.then(value => { treeAvailable = !!value; }, () => {});
      rampJob.ready.then(value => { rampAvailable = !!value; }, () => {});
      return true;
    }
    if (!lookup && !startJobs()) return null;

    function dispose() {
      if (disposed) return;
      disposed = true;
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
        try { record = await cache.read(key); } catch { record = null; }
      }
      if (disposed || signal.aborted) return null;
      if (record) {
        cached = {...record, key};
        return record.map;
      }
      startJobs();
      return null;
    }

    function persist(map, groundNormal, source) {
      const key = source?.key, url = source?.url;
      if (typeof key !== 'string' || typeof url !== 'string' || persisting.has(key)) return;
      persisting.add(key);
      const entry = {job: null, stop: null};
      const finish = () => {
        entry.job?.dispose();
        cancelPersist.delete(entry);
        persisting.delete(key);
      };
      entry.stop = cache.schedule(() => {
        try { entry.job = createJobs('map-cache'); } catch { finish(); return; }
        entry.job.run('map-cache', {key, url, groundNormal, mapId: map.id}).catch(() => {}).finally(finish);
      }, PERSIST_DELAY);
      entry.cancel = () => { entry.stop(); finish(); };
      cancelPersist.add(entry);
    }

    function prepareCached(map, groundNormal) {
      const record = cached;
      cached = null;
      dispose();
      const world = cachedWorld(record, map);
      if (world) {
        worlds.set(map.brushes, {brushes: map.brushes, triangles: map.displacementTriangles, signal,
          consumed: false, consume() {}, triangleBounds: world.triangleBounds, root: world.root, itemCount: world.itemCount});
      }
      if (Object.is(record.header.groundNormal, groundNormal)) {
        ramps.set(map, {groundNormal, signal, consumed: false, consume() {}, cancel() {}, cached: record.sections});
      }
    }

    function prepare(map, groundNormal, source) {
      if (cached && cached.map === map && !disposed && !signal.aborted && Array.isArray(map?.brushes)) {
        prepareCached(map, groundNormal);
        return;
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
        const packet = packRampPreparation(map, groundNormal);
        if (!packet) return;
        rampRecord.requestId = packet.requestId;
        const transfers = Object.values(packet).filter(ArrayBuffer.isView).map(value => value.buffer);
        const result = await rampJob.run('map-ramps', packet, transfers);
        if (!disposed && !signal.aborted && !rampRecord.consumed) rampRecord.result = result;
      }).catch(() => rampRecord.cancel()).finally(() => complete(rampJob));
      const joined = [];
      if (treeAvailable) joined.push(treeTask);
      if (rampAvailable) joined.push(rampTask);
      if (joined.length) return Promise.all(joined);
    }

    return {read, prepare, dispose};
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
    for (const entry of [...cancelPersist]) entry.cancel();
  }

  return {createLoad, useWorld, useRamps, destroy};
}
