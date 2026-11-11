// Touch history belongs to the extension service worker, not the game's main
// thread. Only individual attempts and requested maps cross the bridge.
export const TOUCH_STORAGE_KEY = 'surfd-qol-touch-attempts-v1';
export const MAX_TOUCH_MAPS = 50;
export const MAX_TOUCH_RUNS = 200;
const MAX_TOUCHES = 120;
export const touchValue = (value, angle = false) => Number.isFinite(value) && value >= 0 && (!angle || value <= 90) ? value : null;

export function cleanTouchRun(run) {
  if (!run || typeof run.id !== 'string' || typeof run.map !== 'string' || !run.map ||
    !Number.isFinite(run.at) || !Number.isFinite(run.time) || run.time < 0 ||
    !Number.isSafeInteger(run.checkpoints) || run.checkpoints < 0 || run.checkpoints > 64 ||
    (run.outcome !== 'finished' && run.outcome !== 'reset') || !Array.isArray(run.touches)) return null;
  const touches = [], keys = new Set();
  for (const touch of run.touches.slice(0, MAX_TOUCHES)) {
    if (!touch || typeof touch.key !== 'string') continue;
    let parts;
    try { parts = JSON.parse(touch.key); } catch { continue; }
    if (!Array.isArray(parts) || parts.length !== 3 ||
      !(typeof parts[0] === 'string' || Number.isSafeInteger(parts[0])) ||
      !Number.isSafeInteger(parts[1]) || parts[1] < 0 ||
      !Number.isSafeInteger(parts[2]) || parts[2] <= 0 ||
      JSON.stringify(parts) !== touch.key || touch.checkpoint !== parts[1] || keys.has(touch.key)) continue;
    keys.add(touch.key);
    touches.push({key: touch.key, checkpoint: touch.checkpoint, speedBefore: touchValue(touch.speedBefore),
      speedAfter: touchValue(touch.speedAfter), angle: touchValue(touch.angle, true), crash: touch.crash === true});
  }
  return {id: run.id, map: run.map, at: run.at, time: run.time, outcome: run.outcome, checkpoints: run.checkpoints, touches};
}

const newest = (a, b) => a.at - b.at || a.id.localeCompare(b.id);
const result = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const committed = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Touch history transaction aborted'));
});

export function createTouchHistoryStorage({indexedDB = globalThis.indexedDB, name = 'surfd-qol-touch-history'} = {}) {
  let opened;
  function database() {
    return opened ??= (async () => {
      if (!indexedDB) throw new Error('IndexedDB unavailable');
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const attempts = db.createObjectStore('attempts', {keyPath: 'id'});
        attempts.createIndex('map', 'map');
        db.createObjectStore('maps', {keyPath: 'id'});
        db.createObjectStore('migration', {keyPath: 'id'});
      };
      const db = await result(request);
      db.onversionchange = () => { db.close(); opened = null; };
      return db;
    })().catch(error => { opened = null; throw error; });
  }
  async function transaction(names, work, mode = 'readwrite') {
    const db = await database(), tx = db.transaction(names, mode), completion = committed(tx);
    try {
      const value = await work(tx);
      await completion;
      return value;
    } catch (error) {
      try { tx.abort(); } catch { /* already settled */ }
      await completion.catch(() => {});
      throw error;
    }
  }
  return {
    async load(map) {
      if (typeof map !== 'string' || !map) throw new Error('Invalid touch-history map');
      return transaction(['attempts'], async tx => (await result(tx.objectStore('attempts').index('map').getAll(map))).sort(newest), 'readonly');
    },
    async append(value) {
      const run = cleanTouchRun(value);
      if (!run) throw new Error('Invalid touch-history attempt');
      return transaction(['attempts', 'maps'], async tx => {
        const attempts = tx.objectStore('attempts'), maps = tx.objectStore('maps');
        const [previous, known] = await Promise.all([result(attempts.index('map').getAll(run.map)), result(maps.getAll())]);
        const kept = [...previous.filter(entry => entry.id !== run.id), run].sort(newest).slice(-MAX_TOUCH_RUNS);
        const ids = new Set(kept.map(entry => entry.id));
        for (const entry of previous) if (!ids.has(entry.id)) attempts.delete(entry.id);
        if (ids.has(run.id)) attempts.put(run);
        const at = Math.max(run.at, known.find(entry => entry.id === run.map)?.at ?? -Infinity);
        maps.put({id: run.map, at});
        const expired = [...known.filter(entry => entry.id !== run.map), {id: run.map, at}].sort(newest).slice(0, -MAX_TOUCH_MAPS);
        for (const entry of expired) {
          maps.delete(entry.id);
          for (const id of await result(attempts.index('map').getAllKeys(entry.id))) attempts.delete(id);
        }
        return true;
      });
    },
    async migrate(legacy) {
      if (typeof legacy !== 'string') throw new Error('Invalid legacy touch history');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(legacy));
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      return transaction(['attempts', 'maps', 'migration'], async tx => {
        const migration = tx.objectStore('migration');
        if ((await result(migration.get('localStorage')))?.hash === hash) return true;
        const saved = JSON.parse(legacy);
        // Version 1 contained polluted measurements; the previous store also discarded it.
        if (!saved || ![1, 2].includes(saved.version) || !Array.isArray(saved.runs)) throw new Error('Invalid legacy touch history');
        const attempts = tx.objectStore('attempts'), maps = tx.objectStore('maps');
        const existing = await result(attempts.getAll());
        // Database records win duplicate IDs: migration cannot overwrite newer work.
        const combined = new Map();
        for (const value of saved.version === 2 ? saved.runs : []) {
          const run = cleanTouchRun(value);
          if (run) combined.set(run.id, run);
        }
        for (const run of existing) combined.set(run.id, run);
        const groups = new Map();
        for (const run of [...combined.values()].sort(newest)) {
          const records = groups.get(run.map) ?? [];
          records.push(run);
          if (records.length > MAX_TOUCH_RUNS) records.shift();
          groups.delete(run.map);
          groups.set(run.map, records);
        }
        while (groups.size > MAX_TOUCH_MAPS) groups.delete(groups.keys().next().value);
        attempts.clear();
        maps.clear();
        for (const [map, records] of groups) {
          for (const run of records) attempts.put(run);
          maps.put({id: map, at: records.at(-1).at});
        }
        migration.put({id: 'localStorage', hash});
        return true;
      });
    },
  };
}
