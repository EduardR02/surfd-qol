import {formatTime} from '../hud-model.js';
import {MAX_ROOM_SAVELOCS, SAVELOC_RING, sanitizeSaveloc} from './saveloc-validation.js';

const LIMIT = {rate: 1, burst: 3};
const TOO_FAST = "You're saving locations too fast.";

// One room connection's saves, served to the game's saveloc store in place of its local banks.
export function createSharedSavelocs({practice, send, invalid, notice = () => {}, now = Date.now}) {
  const saves = new Map(), hidden = new Set(), deleting = new Set(), placed = new WeakMap();
  const bucket = {tokens: LIMIT.burst, at: now()};
  let state = null, ownerId = null, selection = null, submitted = 0, evicted = false, closed = false, batch = 0;
  const refresh = () => practice.refresh?.();
  // A save the local map can't place (another map version, or a hostile claim) stays out of the list.
  function placement(save, map) {
    const cached = placed.get(save);
    if (cached?.map === map) return cached.snapshot;
    let snapshot = null;
    try { snapshot = sanitizeSaveloc(save.snapshot, map); } catch { /* not listed */ }
    placed.set(save, {map, snapshot});
    return snapshot;
  }
  function list(session) {
    if (!state || session?.map?.id !== state.mapId) return [];
    const rows = [];
    for (const save of saves.values()) {
      const snapshot = hidden.has(save.id) ? null : placement(save, session.map);
      if (snapshot) rows.push({save, snapshot});
    }
    return rows.sort((a, b) => b.save.id - a.save.id);
  }
  // Your latest save by default, else the room's newest: the game disables Load and its bind
  // reports no saves while nothing is selected.
  function selected(session) {
    const rows = list(session);
    return (rows.find(row => row.save.id === selection) ?? rows.find(row => row.save.ownerId === ownerId) ?? rows[0])?.save.id ?? null;
  }
  function choose(id) {
    selection = id;
    refresh();
    return true;
  }
  function take() {
    const time = now();
    bucket.tokens = Math.min(LIMIT.burst, bucket.tokens + Math.max(0, time - bucket.at) * LIMIT.rate / 1000);
    bucket.at = time;
    if (bucket.tokens < 1) return false;
    bucket.tokens--;
    return true;
  }
  // False leaves the capture to the caller's local fallback.
  function saveSnapshot(snapshot) {
    const map = practice.destination?.()?.map;
    if (closed || !ownerId || map?.id !== state.mapId) return false;
    let safe;
    // Receivers restore their own start position, so the sender's stays private.
    try { safe = sanitizeSaveloc({...snapshot, startPosition: null}, map); } catch { return false; }
    if (!take()) {
      notice(TOO_FAST);
      return true;
    }
    submitted++;
    send({type: 'saveloc-save', mapId: state.mapId, epoch: state.epoch, snapshot: safe});
    return true;
  }
  function add(entry) {
    let snapshot = null, owned = 0;
    try { snapshot = sanitizeSaveloc(entry.snapshot); } catch { /* refused below */ }
    for (const save of saves.values()) if (save.ownerId === entry.ownerId) owned++;
    // The host removes before it adds, so these limits hold after every message.
    if (!snapshot || saves.has(entry.id) || owned >= SAVELOC_RING || saves.size >= MAX_ROOM_SAVELOCS) {
      invalid();
      return;
    }
    saves.set(entry.id, {id: entry.id, ownerId: entry.ownerId, name: entry.name, snapshot});
    const replaced = evicted;
    evicted = false;
    // Retained saves sent on joining are not news, and the list redraws once they are all in.
    if (batch) {
      if (!--batch) refresh();
      return;
    }
    if (entry.ownerId === ownerId && submitted) {
      submitted--;
      selection = entry.id;
      notice(`Saved location #${entry.id} · ${formatTime(snapshot.timer.state.elapsed)}.${replaced ? ' Oldest save replaced.' : ''}`);
    }
    refresh();
  }
  const handlers = {
    entries: session => list(session).map(({save, snapshot}) => ({id: save.id, name: save.name, own: save.ownerId === ownerId,
      time: snapshot.timer.state.elapsed, stage: snapshot.state.stage ?? 1, checkpoints: snapshot.timer.state.splits.length})),
    selected,
    saveSnapshot,
    // The host's confirmation carries the room-wide number, so success is reported on arrival.
    save(session) {
      let snapshot = null;
      try { snapshot = session.capturePractice(); } catch { /* reported below */ }
      if (!snapshot || !saveSnapshot(snapshot)) notice('Could not save this location.');
      return null;
    },
    select: (session, id) => list(session).some(row => row.save.id === id) && choose(id),
    cycle(session, delta) {
      const rows = list(session);
      if (!rows.length) return false;
      const index = rows.findIndex(row => row.save.id === selected(session));
      return choose(rows[(index + delta + rows.length) % rows.length].save.id);
    },
    remove(session) {
      const rows = list(session), index = rows.findIndex(row => row.save.id === selected(session));
      if (index < 0) return false;
      const {save} = rows[index];
      if (save.ownerId === ownerId) {
        deleting.add(save.id);
        send({type: 'saveloc-delete', mapId: state.mapId, epoch: state.epoch, id: save.id});
      }
      hidden.add(save.id);
      // As in the game, the next save takes the selection. Falling back to your latest would let a second delete remove it.
      return choose((rows[index + 1] ?? rows[index - 1])?.save.id ?? null);
    },
    restore(session) {
      const id = selected(session), row = list(session).find(value => value.save.id === id);
      if (!row) return false;
      const destination = practice.destination?.();
      const startPosition = destination?.startPosition !== undefined ? destination.startPosition : session.startPosition ?? null;
      return session.restorePractice({...row.snapshot, key: session.practiceKey(), startPosition});
    },
  };
  const detach = practice.shared(handlers);
  return {
    state(next) {
      if (closed || state && (next.epoch < state.epoch || next.epoch === state.epoch && next.mapId === state.mapId)) return;
      state = {mapId: next.mapId, epoch: next.epoch};
      const shown = saves.size > 0;
      saves.clear(); hidden.clear(); deleting.clear();
      ownerId = null; selection = null; submitted = 0; evicted = false; batch = 0;
      if (shown) refresh();
    },
    receive(message) {
      if (closed || !state || message.mapId !== state.mapId || message.epoch !== state.epoch) return;
      // An epoch's saves start empty, so ownership alone changes nothing on screen.
      if (message.type === 'saveloc-init') {
        ownerId = message.ownerId;
        batch = message.count;
      } else if (message.type === 'saveloc-add') add(message.entry);
      else if (message.type === 'saveloc-remove') {
        evicted = saves.get(message.id)?.ownerId === ownerId && !deleting.has(message.id);
        saves.delete(message.id); hidden.delete(message.id); deleting.delete(message.id);
        batch = 0;
        refresh();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      saves.clear(); hidden.clear(); deleting.clear();
      detach();
    },
  };
}
