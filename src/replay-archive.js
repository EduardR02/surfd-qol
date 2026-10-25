// Everything this extension keeps beyond settings lives in one IndexedDB
// database on surfd.net: replay metadata, the replays themselves, runs, each
// map's bests and the analysis of PB/WR replays. Nothing goes in the game's localStorage, whose small
// quota it shares with the game's own saves.
const DB_NAME = 'surfd-qol';
const VERSION = 4;

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
    for (const name of ['meta', 'replays', 'runs', 'bests', 'analysis']) {
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
// Packing streams the commands in chunks, yielding between them, so a long
// replay never holds the page.
const PACK_COMMANDS = 1024;
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
export async function packReplay(replay, {chunk = PACK_COMMANDS, yieldTask = pause, isCurrent = () => true} = {}) {
  if (!isCurrent()) return null;
  const {commands, ...rest} = replay;
  const compression = new CompressionStream('gzip');
  const packed = new Response(compression.readable).arrayBuffer();
  const writer = compression.writable.getWriter(), encoder = new TextEncoder();
  let closed = false;
  try {
    const head = JSON.stringify(rest);
    await writer.write(encoder.encode(`${head.slice(0, -1)}${head.length > 2 ? ',' : ''}"commands":[`));
    for (let i = 0; i < commands.length; i += chunk) {
      if (i) await yieldTask();
      if (!isCurrent()) return null;
      const part = commands.slice(i, i + chunk).map(command => JSON.stringify(command)).join(',');
      await writer.write(encoder.encode(i ? `,${part}` : part));
    }
    if (!isCurrent()) return null;
    await writer.write(encoder.encode(']}'));
    await writer.close();
    closed = true;
    return await packed;
  } finally {
    if (!closed) await Promise.allSettled([writer.abort(), packed]);
  }
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

// Runs and per-map bests, one record each, so ending a run writes only that
// run and its map's bests.
export function createHistoryStore(database) {
  async function write(name, work) {
    const db = await database;
    if (!db) return;
    const transaction = db.transaction(name, 'readwrite');
    work(transaction.objectStore(name));
    await committed(transaction);
  }
  const getAll = (db, name) => done(db.transaction(name).objectStore(name).getAll());
  const removeAll = name => ids => ids.length ? write(name, store => { for (const id of ids) store.delete(id); }) : Promise.resolve();
  return {
    // null when there is no database to load from or save to.
    async load() {
      const db = await database;
      if (!db) return null;
      const [runs, bests] = await Promise.all([getAll(db, 'runs'), getAll(db, 'bests')]);
      return {runs, bests};
    },
    put: run => write('runs', store => store.put(run)),
    remove: removeAll('runs'),
    putBests: record => write('bests', store => store.put(record)),
    async clear(runs, bests) {
      const db = await database;
      if (!db) return;
      const transaction = db.transaction(['runs', 'bests'], 'readwrite');
      for (const id of runs) transaction.objectStore('runs').delete(id);
      for (const id of bests) transaction.objectStore('bests').delete(id);
      await committed(transaction);
    },
  };
}

// PB/WR replay analysis (replay-store.js), so a reference already analysed
// needs no download or re-simulation on the next visit. A few KB each; the
// least recently saved go beyond MAX_ANALYSES.
const MAX_ANALYSES = 40;
export function createAnalysisStore(database) {
  return {
    async get(id) {
      const db = await database;
      return db ? (await done(db.transaction('analysis').objectStore('analysis').get(id))) ?? null : null;
    },
    async put(id, {result, feedback}) {
      const db = await database;
      if (!db) return;
      const transaction = db.transaction('analysis', 'readwrite'), store = transaction.objectStore('analysis');
      store.put({id, result, feedback, at: Date.now()});
      const all = await done(store.getAll());
      if (all.length > MAX_ANALYSES) for (const old of all.sort((a, b) => a.at - b.at).slice(0, all.length - MAX_ANALYSES)) store.delete(old.id);
      await committed(transaction);
    },
  };
}

// Saved replays follow the run history: a replay is kept exactly while its
// run is (retain), so the archive has no limits of its own.
export function createReplayArchive({database = openSiteDatabase()} = {}) {
  const meta = new Map();
  // A run can be pruned while its replay waits for idle time or compression.
  // Cancelling its pending save prevents it from reappearing afterward.
  const pending = new Map();
  // Explicit history deletion pauses saves at their transaction boundary.
  // Jobs are cancelled only once all four stores have committed together.
  let clearing = null, loadError = null;
  let retained = null;
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* UI only */ } } };
  // Only the small metadata store is read at startup; replays are read to watch one.
  const opened = (async () => {
    const db = await database;
    if (!db) return null;
    for (const entry of await done(db.transaction('meta').objectStore('meta').getAll())) meta.set(entry.id, entry);
    notify();
    return db;
  })().catch(error => { loadError = error; console.warn('[Surfd QoL] Replay storage unavailable:', error); return null; });

  async function remove(ids) {
    const db = await opened;
    if (!db || !ids.length) return;
    const transaction = db.transaction(['meta', 'replays'], 'readwrite');
    for (const id of ids) {
      transaction.objectStore('meta').delete(id);
      transaction.objectStore('replays').delete(id);
    }
    await committed(transaction);
    for (const id of ids) meta.delete(id);
    notify();
  }
  async function clearSaved(runs, bests, map) {
    const jobs = [...pending].filter(([, job]) => !map || job.map === map);
    while (clearing) await clearing;
    let resume;
    clearing = new Promise(resolve => { resume = resolve; });
    try {
      const db = await opened;
      if (loadError) throw loadError;
      const ids = new Set(jobs.map(([id]) => id));
      for (const entry of meta.values()) if (!map || entry.map === map) ids.add(entry.id);
      if (db) {
        const names = runs ? ['runs', 'bests', 'meta', 'replays'] : ['meta', 'replays'];
        const transaction = db.transaction(names, 'readwrite');
        if (!map && runs) {
          for (const name of names) transaction.objectStore(name).clear();
        } else {
          for (const id of runs ?? []) transaction.objectStore('runs').delete(id);
          for (const id of bests ?? []) transaction.objectStore('bests').delete(id);
          for (const id of ids) {
            transaction.objectStore('meta').delete(id);
            transaction.objectStore('replays').delete(id);
          }
        }
        await committed(transaction);
      }
      for (const [id, job] of jobs) if (pending.get(id) === job) pending.delete(id);
      for (const id of ids) meta.delete(id);
      notify();
    } finally {
      clearing = null;
      resume();
    }
  }

  return {
    ready: opened.then(db => !!db),
    has: id => meta.has(id),
    // The trim belongs to the replay transaction, not the separately saved run.
    // null distinguishes legacy metadata from a replay known to be untrimmed.
    offset: id => {
      const offset = meta.get(id)?.offset;
      return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
    },
    // `prepare` may resolve to a trimmed replay; it runs with the packing, when idle.
    // Resolves to {offset} once saved (offset > 0 when trimmed), or null.
    async save(run, replay, prepare = null) {
      const job = {map: run.map};
      pending.set(run.id, job);
      const current = () => pending.get(run.id) === job;
      try {
        const db = await opened;
        if (!db || !current()) return null;
        while (clearing) await clearing;
        if (!current()) return null;
        await idle();
        if (!current()) return null;
        while (clearing) await clearing;
        if (!current()) return null;
        let offset = 0;
        try {
          const trimmed = await prepare?.();
          if (trimmed) { replay = trimmed.replay; offset = trimmed.offset; }
        } catch { /* keep the full replay */ }
        if (!current()) return null;
        while (clearing) await clearing;
        if (!current()) return null;
        let packed;
        try { packed = await packReplay(replay, {isCurrent: current}); } catch (error) {
          console.warn('[Surfd QoL] Could not pack replay:', error);
          return null;
        }
        if (!packed || !current()) return null;
        while (clearing) await clearing;
        if (!current()) return null;
        const entry = {id: run.id, map: run.map, at: run.at, bytes: packed.byteLength, offset};
        try {
          const transaction = db.transaction(['meta', 'replays'], 'readwrite');
          transaction.objectStore('replays').put({id: run.id, packed});
          transaction.objectStore('meta').put(entry);
          await committed(transaction);
        } catch (error) {
          console.warn('[Surfd QoL] Could not save replay:', error);
          return null;
        }
        if (!current()) return null;
        meta.set(entry.id, entry);
        notify();
        return {offset};
      } finally {
        if (current()) pending.delete(run.id);
      }
    },
    async get(id) {
      const db = await opened;
      if (!db || !meta.has(id)) return null;
      const record = await done(db.transaction('replays').objectStore('replays').get(id));
      return record?.packed ? unpackReplay(record.packed) : null;
    },
    // Only run history calls this; its completed runs are queued until we settle.
    clearHistory: clearSaved,
    clearMap: map => clearSaved(null, null, map),
    async retain(ids) {
      retained = new Set(ids);
      const cancelled = [...pending.keys()].filter(id => !retained.has(id));
      for (const id of cancelled) pending.delete(id);
      await opened;
      // Include cancelled IDs so an in-flight write is deleted after committing.
      return remove([...new Set([...meta.keys(), ...cancelled])].filter(id => !retained.has(id)));
    },
    usage() {
      let bytes = 0;
      for (const entry of meta.values()) bytes += entry.bytes ?? 0;
      return {bytes, count: meta.size};
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
