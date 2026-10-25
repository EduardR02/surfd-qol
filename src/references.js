import { createReferenceReplayStore, reconstructReferenceReplay } from './replay-store.js';

const CACHE_KEY = 'surfd.qol.checkpoints.v1';
const defer = () => new Promise(resolve => setTimeout(resolve, 0));
const validSpeeds = speeds => Array.isArray(speeds) && speeds.length <= 64 && speeds.every(speed => Number.isFinite(speed) && speed >= 0 && speed <= 100000);
const micros = seconds => Math.round(seconds * 1e6);
const sameSplits = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);

export function referenceIdentity(entry) {
  return entry && entry.runId != null && Number.isSafeInteger(entry.timeUs) && entry.timeUs > 0 && Array.isArray(entry.splitsUs) && entry.splitsUs.length <= 64 && entry.splitsUs.every(value => Number.isSafeInteger(value) && value >= 0)
    ? JSON.stringify([entry.runId, entry.timeUs, entry.splitsUs]) : null;
}

export function sessionKey(session, boardId) {
  return JSON.stringify([boardId ?? null, session.map.id, session.map.version, session.config, session.replayFormat]);
}

async function replayCheckpointData({Session, session, replay, entry, isCurrent, yieldTask}) {
  const result = await reconstructReferenceReplay({adapter: {Session}, session, replay, entry, isCurrent, yieldTask, feedback: false});
  return result?.checkpoint ?? null;
}

export async function reconstructCheckpointSpeeds({Session, session, replay, entry, isCurrent = () => true, yieldTask = defer}) {
  if (!referenceIdentity(entry)) return null;
  const result = await replayCheckpointData({Session, session, replay, entry, isCurrent, yieldTask});
  return result?.speeds ?? null;
}

export async function reconstructRecordRoute({Session, session, replay, isCurrent = () => true, yieldTask = defer}) {
  return replayCheckpointData({Session, session, replay, isCurrent, yieldTask});
}

// This controller does no replay export/cloning during HUD updates. Only the
// tiny checkpoint arrays of completed runs and requested references are copied.
export function createCheckpointReferences({getSession, getReferences, getSessionClass = () => globalThis.__SURFD_QOL__?.adapter?.Session, getAdapter, replayStore, storage, settings = {}, yieldTask = defer}) {
  let fallbackAdapter = null;
  getAdapter ??= () => {
    const Session = getSessionClass();
    if (fallbackAdapter?.Session !== Session) fallbackAdapter = {Session};
    return fallbackAdapter;
  };
  const ownsStore = !replayStore;
  replayStore ??= createReferenceReplayStore({getAdapter, yieldTask});
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch { storage = null; }
  }
  const cache = new Map();
  const personal = new Map();
  try {
    const saved = JSON.parse(storage?.getItem(CACHE_KEY) ?? 'null');
    for (const [key, value] of saved?.cache ?? []) if (typeof key === 'string' && validSpeeds(value)) cache.set(key, value);
    for (const [key, value] of saved?.personal ?? []) {
      if (typeof key === 'string' && typeof value?.ownerKey === 'string' && Number.isSafeInteger(value.timeUs) && value.timeUs > 0 && validSpeeds(value.speeds) && value.speeds.length === value.splitsUs?.length) personal.set(key, value);
    }
  } catch { /* Private browsing or an incompatible cache must not affect play. */ }
  let live = null, adapter = null, context = '', map = null, mapId = null, mapVersion = null, config = null, format = null, board = null;
  let ownerKey = null, personalContext = '', runOwned = false;
  let runArray = null, startTick = null, previousTick = -1, phase = null, finished = false;
  let baseline = null, baselineLocal = null, completed = null, destroyed = false, recordSource = null, visible = true;
  let ownSlot = {key: '', speeds: null, status: 'missing'};
  let recordSlot = {key: '', speeds: null, splitsUs: null, timeUs: null, status: 'missing'};
  function save() {
    while (cache.size > 60) cache.delete(cache.keys().next().value);
    while (personal.size > 30) personal.delete(personal.keys().next().value);
    try { storage?.setItem(CACHE_KEY, JSON.stringify({cache: [...cache], personal: [...personal]})); } catch { /* Storage is optional. */ }
  }
  function copyEntry(entry) {
    return referenceIdentity(entry) ? {runId: entry.runId, timeUs: entry.timeUs, splitsUs: entry.splitsUs.slice()} : null;
  }
  function resetRun(session, refs) {
    runArray = session.checkpointSpeeds;
    startTick = session.timer.state.startTick;
    finished = false;
    completed = null;
    baseline = copyEntry(refs?.own);
    baselineLocal = personal.get(personalContext) ?? null;
    runOwned = true;
  }
  function choosePersonal(entry) {
    const local = baselineLocal;
    if (!local) return {entry, exact: null};
    if (!entry || local.timeUs < entry.timeUs || (local.runId != null && local.runId === entry.runId && local.timeUs === entry.timeUs && sameSplits(local.splitsUs, entry.splitsUs))) return {entry: local, exact: local.speeds};
    return {entry, exact: null};
  }
  function release(slot) {
    slot.handle?.release();
    slot.handle = null;
  }
  function clear(slot) {
    release(slot);
    Object.assign(slot, {key: '', speeds: null, splitsUs: null, timeUs: null, status: 'missing', retryable: false});
  }
  function request(slot, entry, exact, session, refs, ksf = false) {
    const identity = referenceIdentity(entry);
    const key = ksf ? `${context}:ksf` : identity ? `${context}:official:${identity}` : exact ? `${personalContext}:local:${entry.timeUs}` : '';
    if (slot.key === key) return;
    clear(slot);
    slot.key = key;
    const cacheKey = identity ? `${context}:${identity}` : '';
    slot.speeds = exact ?? (cacheKey ? cache.get(cacheKey) : null) ?? null;
    slot.splitsUs = entry?.splitsUs ?? null;
    slot.timeUs = entry?.timeUs ?? null;
    slot.status = slot.speeds ? 'ready' : key ? 'loading' : 'missing';
    if (slot.speeds || !key) return;
    const load = ksf ? refs?.loadRecordRoute?.bind(refs) : identity && typeof refs?.loadReplay === 'function' ? () => refs.loadReplay(entry.runId) : null;
    if (!load) { slot.status = 'missing'; return; }
    const expectedAdapter = adapter, expectedMap = session.map, expectedConfig = session.config, expectedFormat = session.replayFormat;
    const expectedMapId = session.map.id, expectedMapVersion = session.map.version;
    const source = recordSource;
    const isCurrent = () => !destroyed && visible && settings.hud !== false && settings.zen !== true && slot.key === key &&
      (slot === ownSlot ? settings.checkpointReference !== 'wr' : settings.checkpointReference !== 'pb' &&
        (settings.wrSource === 'leaderboard' ? 'leaderboard' : 'ksf') === source) &&
      getSession() === session && getAdapter() === expectedAdapter && session.map === expectedMap &&
      session.map.id === expectedMapId && session.map.version === expectedMapVersion &&
      session.config === expectedConfig && session.replayFormat === expectedFormat;
    const handle = replayStore.acquire({key, session, entry, load, feedback: false, isCurrent});
    slot.handle = handle;
    const publish = result => {
      if (slot.handle !== handle || !isCurrent()) return;
      const route = result?.checkpoint;
      slot.speeds = route?.speeds ?? null;
      slot.status = route ? 'ready' : 'missing';
      slot.retryable = result?.status === 'missing';
      if (route) {
        slot.splitsUs = route.splitsUs; slot.timeUs = route.timeUs;
        if (cacheKey) { cache.set(cacheKey, route.speeds); save(); }
      }
    };
    if (handle.result) publish(handle.result);
    else handle.promise.then(publish);
  }
  function update(active = true) {
    visible = active;
    // Zen hides checkpoints, so their references aren't loaded either.
    const enabled = active && settings.hud !== false && settings.zen !== true;
    const source = settings?.wrSource === 'leaderboard' ? 'leaderboard' : 'ksf';
    if (source !== recordSource) {
      recordSource = source;
      clear(recordSlot);
    }
    const session = getSession();
    const refs = getReferences?.();
    if (destroyed || !session?.timer?.state) {
      if (live) {
        clear(ownSlot); clear(recordSlot);
        live = null;
        context = '';
      }
      return {own: null, record: null, ownEntry: null, ownSplitsUs: null, recordSplitsUs: null, recordTimeUs: null, ownStatus: 'missing', recordStatus: 'missing', recordSource: source};
    }
    const timer = session.timer.state;
    const boardId = refs?.boardId ?? null;
    const nextAdapter = getAdapter();
    if (session !== live || nextAdapter !== adapter || map !== session.map || config !== session.config || format !== session.replayFormat || board !== boardId ||
      mapId !== session.map.id || mapVersion !== session.map.version) {
      clear(ownSlot); clear(recordSlot);
      live = session; adapter = nextAdapter; map = session.map; config = session.config; format = session.replayFormat; board = boardId;
      mapId = map.id; mapVersion = map.version;
      context = sessionKey(session, boardId);
      // Official summaries remain replay-keyed; only exact local PBs are owned.
      ownerKey = refs?.ownerKey ?? 'guest';
      personalContext = JSON.stringify([context, ownerKey]);
      resetRun(session, refs);
      phase = null;
    } else {
      const nextOwner = refs?.ownerKey ?? 'guest';
      if (ownerKey !== nextOwner) {
        ownerKey = nextOwner;
        personalContext = JSON.stringify([context, ownerKey]);
        baseline = copyEntry(refs?.own);
        baselineLocal = personal.get(personalContext) ?? null;
        completed = null;
        // A run spanning an account switch has no single personal owner.
        runOwned = false;
      }
      if (runArray !== session.checkpointSpeeds || session.state.tick < previousTick || timer.startTick !== startTick ||
        (phase === 'finished' && timer.phase !== 'finished')) resetRun(session, refs);
    }
    // Leaderboards may arrive while standing in start. Freeze the pre-run PB
    // once running, so a newly submitted PB never compares against itself.
    if (timer.phase === 'ready') {
      baseline = copyEntry(refs?.own);
      baselineLocal = personal.get(personalContext) ?? null;
      runOwned = true;
    }
    const chosen = choosePersonal(baseline);
    if (enabled && settings.checkpointReference !== 'wr') request(ownSlot, chosen.entry, chosen.exact, session, refs);
    else clear(ownSlot);
    if (enabled && settings.checkpointReference !== 'pb') {
      request(recordSlot, source === 'leaderboard' ? copyEntry(refs?.record) : null, null, session, refs, source === 'ksf');
    } else clear(recordSlot);
    const result = {
      own: ownSlot.speeds,
      record: recordSlot.speeds,
      ownEntry: chosen.entry,
      ownSplitsUs: chosen.entry?.splitsUs ?? null,
      recordSplitsUs: recordSlot.splitsUs,
      recordTimeUs: recordSlot.timeUs,
      ownTimeUs: chosen.entry?.timeUs ?? null,
      ownStatus: ownSlot.status,
      recordStatus: recordSlot.status,
      recordSource: source
    };
    if (timer.phase === 'finished' && !finished) {
      finished = true;
      const timeUs = micros(timer.elapsed), splitsUs = timer.splits.map(micros);
      const old = personal.get(personalContext);
      if (runOwned && !session.practice && !timer.invalidReason && timeUs > 0 && validSpeeds(session.checkpointSpeeds) && session.checkpointSpeeds.length === splitsUs.length && (!baseline || timeUs < baseline.timeUs) && (!old || timeUs < old.timeUs)) {
        completed = {ownerKey, timeUs, splitsUs, speeds: session.checkpointSpeeds.slice(), runId: null};
        personal.set(personalContext, completed);
        save();
      }
    }
    // Only link an official identity when it changed during this exact finished
    // run and all timing metadata agree; never combine checkpoint maxima.
    const own = refs?.own;
    if (completed && own?.runId != null && own.runId !== baseline?.runId && own.timeUs === completed.timeUs && sameSplits(own.splitsUs, completed.splitsUs)) {
      if (completed.runId !== own.runId) { completed.runId = own.runId; save(); }
    }
    previousTick = session.state.tick;
    phase = timer.phase;
    return result;
  }
  return {
    update,
    // Finish bookkeeping must not masquerade as hiding the HUD: keep active
    // reference slots (including pending and negative results) in their context.
    observeFinish() {
      // A failed download may recover on the next finish, as before. A
      // completed mismatch and an in-flight request need no new work.
      if (ownSlot.retryable) clear(ownSlot);
      if (recordSlot.retryable) clear(recordSlot);
      return update(visible);
    },
    destroy() { destroyed = true; clear(ownSlot); clear(recordSlot); if (ownsStore) replayStore.destroy(); },
  };
}
