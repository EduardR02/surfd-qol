// Replays of your own runs, in surfd.net's IndexedDB. A replay is the game's
// own format (initial state plus one input command per tick), roughly half a
// megabyte a minute, so it lives here rather than in localStorage. A small
// metadata store is read once at startup; replays are only read to watch one.
const DB_NAME = 'surfd-qol';
const VERSION = 1;
export const REPLAYS_PER_MAP = 30;

const done = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const committed = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = transaction.onabort = () => reject(transaction.error);
});

// Newest REPLAYS_PER_MAP per map, plus each map's fastest clean finish.
export function pruneList(entries, perMap = REPLAYS_PER_MAP) {
  const keep = new Set(), counts = new Map(), best = new Map();
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    const count = counts.get(entry.map) ?? 0;
    if (count < perMap) keep.add(entry.id);
    counts.set(entry.map, count + 1);
    if (Number.isFinite(entry.best) && !(best.get(entry.map)?.best <= entry.best)) best.set(entry.map, entry);
  }
  for (const entry of best.values()) keep.add(entry.id);
  return entries.filter(entry => !keep.has(entry.id)).map(entry => entry.id);
}

export function createReplayArchive({indexedDB = globalThis.indexedDB, perMap = REPLAYS_PER_MAP} = {}) {
  const meta = new Map();
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* UI only */ } } };
  const opened = (async () => {
    if (!indexedDB) return null;
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', {keyPath: 'id'});
      if (!db.objectStoreNames.contains('replays')) db.createObjectStore('replays', {keyPath: 'id'});
    };
    const db = await done(request);
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
      const clean = run.outcome === 'finished' && !run.practice && !run.invalid;
      const entry = {id: run.id, map: run.map, at: run.at, best: clean ? run.time : null};
      try {
        const transaction = db.transaction(['meta', 'replays'], 'readwrite');
        transaction.objectStore('replays').put({id: run.id, replay});
        transaction.objectStore('meta').put(entry);
        await committed(transaction);
      } catch (error) {
        // Most likely over quota: drop this map's oldest replays and give up on this one.
        console.warn('[Surfd QoL] Could not save replay:', error);
        await remove(pruneList([...meta.values()], Math.max(1, Math.floor(perMap / 2))));
        return false;
      }
      meta.set(entry.id, entry);
      notify();
      await remove(pruneList([...meta.values()], perMap));
      return true;
    },
    async get(id) {
      const db = await opened;
      if (!db || !meta.has(id)) return null;
      return (await done(db.transaction('replays').objectStore('replays').get(id)))?.replay ?? null;
    },
    clearMap: map => remove([...meta.values()].filter(entry => !map || entry.map === map).map(entry => entry.id)),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
