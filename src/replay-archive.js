// Everything this extension keeps beyond settings lives in one IndexedDB
// database on surfd.net: replay metadata, the replays themselves and the run
// history. Nothing goes in the game's localStorage, whose small quota it
// shares with the game's own saves.
const DB_NAME = 'surfd-qol';
const VERSION = 2;
export const REPLAYS_PER_MAP = 30;

const done = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const committed = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = transaction.onabort = () => reject(transaction.error);
});

// Resolves to null when IndexedDB is unavailable (some private modes).
export function openSiteDatabase(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) return Promise.resolve(null);
  const request = indexedDB.open(DB_NAME, VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    for (const name of ['meta', 'replays', 'runs']) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, {keyPath: 'id'});
    }
  };
  return done(request).then(db => {
    // Another tab upgrading the database must not wait on this one.
    db.onversionchange = () => db.close();
    return db;
  }).catch(error => { console.warn('[Surfd QoL] Site storage unavailable:', error); return null; });
}

// Saved replays are gzipped JSON: exact for every value, about an eighth of
// the size of the game's command objects, and unpacked in about a millisecond.
export async function packReplay(replay) {
  const stream = new Blob([JSON.stringify(replay)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
export async function unpackReplay(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}
// Packing runs when the browser has a spare moment, not on the restart frame.
const idle = () => new Promise(resolve => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), {timeout: 2000});
  else setTimeout(resolve, 0);
});

// One record per run, so ending a run writes only that run.
export function createRunStore(database) {
  async function write(work) {
    const db = await database;
    if (!db) return;
    const transaction = db.transaction('runs', 'readwrite');
    work(transaction.objectStore('runs'));
    await committed(transaction);
  }
  return {
    // null when there is no database to load from or save to.
    async load() {
      const db = await database;
      return db ? done(db.transaction('runs').objectStore('runs').getAll()) : null;
    },
    put: run => write(store => store.put(run)),
    remove: ids => ids.length ? write(store => { for (const id of ids) store.delete(id); }) : Promise.resolve(),
  };
}

// Newest `perMap` per map, plus each map's fastest clean finish when `keepBest`.
export function pruneList(entries, perMap = REPLAYS_PER_MAP, keepBest = true) {
  const keep = new Set(), counts = new Map(), best = new Map();
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    const count = counts.get(entry.map) ?? 0;
    if (count < perMap) keep.add(entry.id);
    counts.set(entry.map, count + 1);
    if (Number.isFinite(entry.best) && !(best.get(entry.map)?.best <= entry.best)) best.set(entry.map, entry);
  }
  if (keepBest) for (const entry of best.values()) keep.add(entry.id);
  return entries.filter(entry => !keep.has(entry.id)).map(entry => entry.id);
}

export function createReplayArchive({database = openSiteDatabase(), limits = () => ({})} = {}) {
  const limit = () => {
    let value = {};
    try { value = limits() ?? {}; } catch { /* defaults */ }
    return {perMap: value.perMap ?? REPLAYS_PER_MAP, keepBest: value.keepBest !== false};
  };
  const meta = new Map();
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* UI only */ } } };
  // Only the small metadata store is read at startup; replays are read to watch one.
  const opened = (async () => {
    const db = await database;
    if (!db) return null;
    for (const entry of await done(db.transaction('meta').objectStore('meta').getAll())) meta.set(entry.id, entry);
    notify();
    return db;
  })().catch(error => { console.warn('[Surfd QoL] Replay storage unavailable:', error); return null; });

  async function remove(ids) {
    const db = await opened;
    if (!db || !ids.length) return;
    const transaction = db.transaction(['meta', 'replays'], 'readwrite');
    for (const id of ids) {
      transaction.objectStore('meta').delete(id);
      transaction.objectStore('replays').delete(id);
      meta.delete(id);
    }
    await committed(transaction);
    notify();
  }

  return {
    ready: opened.then(db => !!db),
    has: id => meta.has(id),
    async save(run, replay) {
      const db = await opened;
      if (!db) return false;
      await idle();
      let packed;
      try { packed = await packReplay(replay); } catch (error) {
        console.warn('[Surfd QoL] Could not pack replay:', error);
        return false;
      }
      const clean = run.outcome === 'finished' && !run.practice && !run.invalid;
      const entry = {id: run.id, map: run.map, at: run.at, best: clean ? run.time : null, bytes: packed.byteLength};
      try {
        const transaction = db.transaction(['meta', 'replays'], 'readwrite');
        transaction.objectStore('replays').put({id: run.id, packed});
        transaction.objectStore('meta').put(entry);
        await committed(transaction);
      } catch (error) {
        // Most likely over quota: drop this map's oldest replays and give up on this one.
        console.warn('[Surfd QoL] Could not save replay:', error);
        await remove(pruneList([...meta.values()], Math.max(1, Math.floor(limit().perMap / 2)), limit().keepBest));
        return false;
      }
      meta.set(entry.id, entry);
      notify();
      await remove(pruneList([...meta.values()], limit().perMap, limit().keepBest));
      return true;
    },
    async get(id) {
      const db = await opened;
      if (!db || !meta.has(id)) return null;
      const record = await done(db.transaction('replays').objectStore('replays').get(id));
      // Replays saved before packing are plain objects.
      return record?.packed ? unpackReplay(record.packed) : record?.replay ?? null;
    },
    clearMap: map => remove([...meta.values()].filter(entry => !map || entry.map === map).map(entry => entry.id)),
    // Re-applies the History limits after they change.
    async prune() { await opened; return remove(pruneList([...meta.values()], limit().perMap, limit().keepBest)); },
    // Drops replays whose run is no longer in the history.
    async retain(ids) { await opened; return remove([...meta.keys()].filter(id => !ids.has(id))); },
    usage() {
      let bytes = 0;
      for (const entry of meta.values()) bytes += entry.bytes ?? 0;
      return {bytes, count: meta.size};
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
