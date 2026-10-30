import { createReferenceReplayStore, feedbackApplies, visitKey } from './replay-store.js';
import { analysisKey, referenceIdentity } from './references.js';
const defer = () => new Promise(resolve => setTimeout(resolve, 0));
const copyEntry = entry => referenceIdentity(entry) ? {runId: entry.runId, timeUs: entry.timeUs, splitsUs: entry.splitsUs.slice()} : null;

// Only completed native replays supply baselines: a local finish or checkpoint
// maxima are not an official personal best.
export function createRunReferences({getSession, getReferences, getAdapter, replayStore, settings = {}, yieldTask = defer}) {
  const ownsStore = !replayStore;
  replayStore ??= createReferenceReplayStore({getAdapter, yieldTask});
  const slots = new Map();
  let live = null, adapter = null, context = '', map = null, config = null, format = null, boardId = null;
  let mapId = null, mapVersion = null, ownerKey = null;
  let runArray = null, startTick = null, previousTick = -1, phase = null;
  let baseline = null, baselineIdentity = null, destroyed = false, visible = true;
  function invalidate() {
    for (const slot of slots.values()) slot.handle?.release();
    slots.clear();
  }
  function freezePersonal(entry) {
    const identity = referenceIdentity(entry);
    if (identity === baselineIdentity) return;
    baselineIdentity = identity;
    baseline = copyEntry(entry);
  }
  function resetRun(session, refs) {
    freezePersonal(refs?.own);
    runArray = session.checkpointSpeeds;
    startTick = session.timer.state.startTick;
  }
  function request(session, refs, source) {
    const wrSource = settings.wrSource === 'leaderboard' ? 'leaderboard' : 'ksf';
    const entry = source === 'pb' ? baseline : wrSource === 'leaderboard' ? copyEntry(refs?.record) : null;
    const identity = referenceIdentity(entry);
    const ksf = source === 'wr' && wrSource === 'ksf';
    // The imported KSF route has no run ID: its identity is the versioned map
    // route. Either applies to this session only under its movement rules.
    const key = `${context}:${ksf ? 'ksf' : `official:${identity ?? 'missing'}`}`;
    let requested = slots.get(source);
    if (requested?.key === key) return requested;
    requested?.handle?.release();
    requested = {key, status: 'loading', reference: null, handle: null};
    slots.set(source, requested);
    const load = ksf ? refs?.loadRecordRoute?.bind(refs) : identity && typeof refs?.loadReplay === 'function' ? () => refs.loadReplay(entry.runId) : null;
    if (!load || typeof adapter?.Session !== 'function' || typeof adapter?.Movement !== 'function') {
      requested.status = 'missing';
      return requested;
    }
    const expectedAdapter = adapter;
    const expectedMap = session.map, expectedConfig = session.config, expectedFormat = session.replayFormat;
    const expectedMapId = session.map.id, expectedMapVersion = session.map.version;
    const selected = () => visible && settings.hud !== false && (
      settings.continuousFeedback !== true && settings.zen !== true &&
        (settings.showBoard !== false && settings.boardColorReference === source ||
          settings.showSurf !== false && settings.surfColorReference === source) ||
      settings.showStart !== false && settings.startColorReference === source);
    const isCurrent = () => !destroyed && selected() && slots.get(source) === requested &&
      (source !== 'wr' || (settings.wrSource === 'leaderboard' ? 'leaderboard' : 'ksf') === wrSource) &&
      getSession() === session && getAdapter() === expectedAdapter && session.map === expectedMap &&
      session.map.id === expectedMapId && session.map.version === expectedMapVersion &&
      session.config === expectedConfig && session.replayFormat === expectedFormat;
    const handle = replayStore.acquire({key, session, entry, load, feedback: true, isCurrent});
    requested.handle = handle;
    const publish = result => {
      if (!isCurrent()) return;
      requested.reference = feedbackApplies(result, session) ? result.feedback : null;
      requested.status = requested.reference ? 'ready' : result?.status ?? 'missing';
    };
    if (handle.result) publish(handle.result);
    else handle.promise.then(publish);
    return requested;
  }
  function visitResult(measurement, source, field) {
    const result = (status, loss = null) => ({loss, status, source});
    if (destroyed) return result('missing');
    if (source === 'fixed') return result('ready');
    const slot = slots.get(source);
    if (!slot || slot.status !== 'ready') return result(slot?.status ?? 'missing');
    const key = visitKey(measurement), route = slot.reference.route;
    if (!route || !measurement?.available || !Number.isFinite(measurement.loss) || !key ||
      typeof measurement.routePrefix !== 'string' || !measurement.routePrefix) return result('unmatched');
    const index = route.indices.get(key);
    const reference = index == null ? null : route.boards[index];
    // Non-null authoritative prefixes establish complete visit identities, not
    // identical routes: an unrelated known detour does not change this visit.
    if (!reference?.valid || !Number.isFinite(reference[field])) return result('unmatched');
    return result('ready', reference[field]);
  }
  function startResult(source) {
    const result = (status, start = null) => ({
      speed: start?.speed ?? null, heightAboveFloor: start?.heightAboveFloor ?? null, status, source
    });
    if (destroyed) return result('missing');
    if (source === 'fixed') return result('ready');
    const slot = slots.get(source);
    if (!slot || slot.status !== 'ready') return result(slot?.status ?? 'missing');
    const start = slot.reference.start;
    return start ? result('ready', start) : result('unmatched');
  }
  function update(board, surf, active = true) {
    visible = active;
    const enabled = active && settings.hud !== false;
    const boardSource = enabled && settings.zen !== true && settings.showBoard !== false && settings.continuousFeedback !== true &&
      ['pb', 'wr'].includes(settings.boardColorReference) ? settings.boardColorReference : 'fixed';
    const startSource = enabled && settings.showStart !== false &&
      ['pb', 'wr'].includes(settings.startColorReference) ? settings.startColorReference : 'fixed';
    const surfSource = enabled && settings.zen !== true && settings.showSurf !== false &&
      settings.continuousFeedback !== true && ['pb', 'wr'].includes(settings.surfColorReference)
      ? settings.surfColorReference : 'fixed';
    const result = () => ({
      board: visitResult(board, boardSource, 'loss'), start: startResult(startSource),
      surf: visitResult(surf, surfSource, 'surfLoss'),
      down: visitResult(surf, surfSource, 'downLoss'), up: visitResult(surf, surfSource, 'upLoss')
    });
    if (destroyed) return result();
    const session = getSession(), refs = getReferences?.(), nextAdapter = getAdapter();
    if (!session?.map || !session.timer?.state || !session.state) {
      invalidate(); live = null; context = '';
      return result();
    }
    const timer = session.timer.state;
    // Configs and maps are immutable native identities: compare them by identity
    // and rebuild the context only on change, not by stringifying the config every update.
    if (session !== live || nextAdapter !== adapter || session.map !== map || session.config !== config ||
      session.replayFormat !== format || refs?.boardId !== boardId || session.map.id !== mapId || session.map.version !== mapVersion) {
      invalidate();
      live = session; adapter = nextAdapter; map = session.map; config = session.config; format = session.replayFormat;
      boardId = refs?.boardId; mapId = map.id; mapVersion = map.version;
      context = analysisKey(session, boardId);
      ownerKey = refs?.ownerKey ?? 'guest';
      resetRun(session, refs); phase = null;
    } else if (runArray !== session.checkpointSpeeds || session.state.tick < previousTick || timer.startTick !== startTick ||
      (phase === 'finished' && timer.phase !== 'finished')) resetRun(session, refs);
    if (ownerKey !== (refs?.ownerKey ?? 'guest')) {
      ownerKey = refs?.ownerKey ?? 'guest';
      freezePersonal(refs?.own);
    }
    if (timer.phase === 'ready') freezePersonal(refs?.own);
    previousTick = session.state.tick; phase = timer.phase;
    for (const [source, slot] of slots) if (source !== boardSource && source !== startSource && source !== surfSource) {
      slot.handle?.release(); slots.delete(source);
    }
    if (boardSource !== 'fixed') request(session, refs, boardSource);
    if (startSource !== 'fixed' && startSource !== boardSource) request(session, refs, startSource);
    if (surfSource !== 'fixed' && surfSource !== boardSource && surfSource !== startSource) request(session, refs, surfSource);
    return result();
  }
  return {update, destroy() { destroyed = true; invalidate(); if (ownsStore) replayStore.destroy(); }};
}
