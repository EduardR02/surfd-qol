import {packMapBounds, unpackMapBoundsTree, adoptPreparedMapWorld} from '../extension/map-bvh-preparation.js';
import {packRampPreparation, installPreparedRampSurfaces, hasRampSurfaces, cancelRampPreparation} from './map-ramp-preparation.js';

// Pack only derived data while visuals load. Join workers which have already
// started; unsupported or still-starting workers never add an entry-time wait.
export function createMapPreparation() {
  const worlds = new WeakMap(), ramps = new WeakMap(), active = new Set();

  function createLoad(signal, createJobs) {
    if (signal.aborted) return null;
    let treeJob, rampJob, treeRecord, rampRecord, prepared = false, disposed = false, finished = 0;
    let treeAvailable = false, rampAvailable = false;
    try {
      treeJob = createJobs('map-bvh');
      rampJob = createJobs('map-ramps');
    } catch {
      treeJob?.dispose();
      rampJob?.dispose();
      return null;
    }
    treeJob.ready.then(value => { treeAvailable = !!value; }, () => {});
    rampJob.ready.then(value => { rampAvailable = !!value; }, () => {});

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (treeRecord) treeRecord.consumed = true;
      if (rampRecord) { rampRecord.consumed = true; rampRecord.cancel(); }
      treeJob.dispose();
      rampJob.dispose();
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

    function prepare(map, groundNormal) {
      if (prepared || disposed || signal.aborted || !Array.isArray(map?.brushes)) { dispose(); return; }
      prepared = true;
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

    return {prepare, dispose};
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
    return adoptPreparedMapWorld(world, brushes, triangles, feature, corner, Tree, worlds);
  }

  function useRamps(map, groundNormal) {
    const record = ramps.get(map);
    if (!record || record.consumed) return false;
    record.consumed = true;
    record.consume();
    try {
      return !record.signal.aborted && record.groundNormal === groundNormal && record.result != null &&
        installPreparedRampSurfaces(map, groundNormal, record.result);
    } finally { record.cancel(); }
  }

  function destroy() {
    for (const dispose of active) dispose();
  }

  return {createLoad, useWorld, useRamps, destroy};
}
