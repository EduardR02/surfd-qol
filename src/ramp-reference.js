// Per-ramp values of the PB or WR replay on the map you're on: what the Runs
// panel compares your best ramps against, and what colours ramp boards on the
// replay timeline. It shares the HUD's native re-simulation and cache
// (replay-store.js), so a reference the HUD already loaded costs nothing, and
// nothing loads until something asks.
import {referenceIdentity, sessionKey} from './references.js';
import {mapKey} from './run-history.js';
import {referenceTone, startTone} from './hud-model.js';

const copy = entry => referenceIdentity(entry) ? {runId: entry.runId, timeUs: entry.timeUs, splitsUs: entry.splitsUs.slice()} : null;

export function createRampReference({getSession, getReferences, getAdapter, replayStore, settings = {}}) {
  const slots = new Map(), listeners = new Set();
  let loads = 0;
  const changed = () => { loads++; for (const listener of listeners) { try { listener(); } catch { /* UI only */ } } };
  // {status, label, ramps: Map(rampKey → {board, down, up, surf})} for the map
  // loaded in the game; null for any other map or when the source has no replay.
  function get(key, source) {
    const session = getSession?.(), refs = getReferences?.(), adapter = getAdapter?.();
    if (!session?.map || mapKey(session.map) !== key || (source !== 'pb' && source !== 'wr') || !replayStore) return null;
    const leaderboard = settings.wrSource === 'leaderboard';
    const entry = source === 'pb' ? copy(refs?.own) : leaderboard ? copy(refs?.record) : null;
    const ksf = source === 'wr' && !leaderboard, identity = referenceIdentity(entry);
    const load = ksf ? refs?.loadRecordRoute?.bind(refs) : identity && typeof refs?.loadReplay === 'function' ? () => refs.loadReplay(entry.runId) : null;
    if (!load) return null;
    // The same key as the HUD's comparisons (run-references.js), so both share one pass.
    const slotKey = `${sessionKey(session, refs?.boardId)}:${ksf ? 'ksf' : `official:${identity}`}`;
    let slot = slots.get(source);
    if (slot?.key === slotKey) return slot;
    slot?.handle?.release();
    slot = {key: slotKey, status: 'loading', label: source === 'pb' ? 'PB' : leaderboard ? 'Site WR' : 'KSF WR', ramps: new Map(), handle: null};
    slots.set(source, slot);
    if (typeof adapter?.Session !== 'function' || typeof adapter?.Movement !== 'function') { slot.status = 'missing'; return slot; }
    const current = slot;
    const isCurrent = () => slots.get(source) === current && getSession?.() === session && getAdapter?.() === adapter;
    current.handle = replayStore.acquire({key: slotKey, session, entry, load, feedback: true, isCurrent});
    const publish = result => {
      if (slots.get(source) !== current) return;
      const route = result?.feedback?.route;
      for (const [rampKey, index] of route?.indices ?? []) {
        const visit = index == null ? null : route.boards[index];
        if (visit?.valid) current.ramps.set(rampKey, {board: visit.loss, down: visit.downLoss, up: visit.upLoss, surf: visit.surfLoss});
      }
      current.status = route ? 'ready' : 'missing';
      changed();
    };
    if (current.handle.result) publish(current.handle.result);
    else current.handle.promise.then(publish, () => publish(null));
    return current;
  }
  return {
    get,
    // A board's tone the way the HUD grades it: against the Board colour reference, or fixed cutoffs.
    tone(rampKey, loss) {
      const source = settings.boardColorReference;
      if (source !== 'pb' && source !== 'wr') return startTone(loss, settings.boardLossAmazing, settings.boardLossGood);
      const session = getSession?.();
      const slot = session?.map ? get(mapKey(session.map), source) : null;
      return referenceTone(loss, slot?.status === 'ready' ? slot.ramps.get(rampKey)?.board ?? null : null, settings.referenceLossTolerance);
    },
    // Changes whenever tones could: a reference finished loading or a grading setting changed.
    version: () => `${loads}:${settings.boardColorReference}:${settings.wrSource}:${settings.referenceLossTolerance}:${settings.boardLossAmazing}:${settings.boardLossGood}`,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { for (const slot of slots.values()) slot.handle?.release(); slots.clear(); listeners.clear(); },
  };
}
