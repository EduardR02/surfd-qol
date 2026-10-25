// Per-ramp PB/WR summaries shared with the HUD's native analysis cache.
// Availability never acquires a replay. Each visible surface owns a consumer
// and releases it when its comparison is no longer needed.
import {referenceIdentity, sessionKey} from './references.js';
import {mapKey} from './run-history.js';
import {referenceTone, startTone} from './hud-model.js';

export function createRampReference({getSession, getReferences, getAdapter, replayStore, settings = {}}) {
  const consumers = new Set(), listeners = new Set();
  let loads = 0, destroyed = false, adapterVersion = 0, lastAdapter = null;
  const changed = () => { loads++; for (const listener of listeners) { try { listener(); } catch { /* UI only */ } } };
  const version = () => {
    const adapter = destroyed ? null : getAdapter?.();
    if (adapter !== lastAdapter) { lastAdapter = adapter; adapterVersion++; }
    return `${loads}:${adapterVersion}:${settings.boardColorReference}:${settings.wrSource}:${settings.referenceLossTolerance}:${settings.boardLossAmazing}:${settings.boardLossGood}`;
  };

  function describe(key, source) {
    const session = getSession?.(), refs = getReferences?.();
    if (destroyed || !session?.map || mapKey(session.map) !== key || !replayStore) return null;
    const leaderboard = settings.wrSource === 'leaderboard';
    const entry = source === 'pb' ? refs?.own : source === 'wr' && leaderboard ? refs?.record : null;
    const ksf = source === 'wr' && !leaderboard, identity = referenceIdentity(entry);
    if (ksf ? typeof refs?.loadRecordRoute !== 'function' : !identity || typeof refs?.loadReplay !== 'function') return null;
    return {session, refs, entry, identity, ksf, ownerKey: refs?.ownerKey,
      key: `${sessionKey(session, refs?.boardId)}:${ksf ? 'ksf' : `official:${identity}`}`,
      label: source === 'pb' ? 'PB' : leaderboard ? 'Site WR' : 'KSF WR'};
  }

  function createConsumer() {
    let slot = null, pending = null, closed = destroyed;
    function release() {
      const work = pending;
      pending = null; slot = null;
      work?.handle?.release();
    }
    function get(key, source) {
      const info = closed ? null : describe(key, source);
      if (!info) { release(); return null; }
      const adapter = getAdapter?.();
      if (slot?.key === info.key && slot.source === source && (slot.status !== 'loading' ||
        pending?.session === info.session && pending?.adapter === adapter && pending?.ownerKey === info.ownerKey)) return slot;
      release();
      slot = {key: info.key, source, status: 'loading', label: info.label, ramps: new Map()};
      if (typeof adapter?.Session !== 'function' || typeof adapter?.Movement !== 'function') { slot.status = 'missing'; return slot; }
      const current = slot, {session, refs, identity, ksf, ownerKey} = info;
      const entry = identity ? {runId: info.entry.runId, timeUs: info.entry.timeUs, splitsUs: info.entry.splitsUs.slice()} : null;
      const work = {session, adapter, ownerKey, handle: null};
      pending = work;
      const isCurrent = () => {
        if (pending !== work || getSession?.() !== session || getAdapter?.() !== adapter) return false;
        const next = describe(key, source);
        return next?.key === current.key && next.ownerKey === ownerKey;
      };
      work.handle = replayStore.acquire({key: info.key, session, entry,
        load: ksf ? () => refs.loadRecordRoute() : () => refs.loadReplay(entry.runId), feedback: true, isCurrent});
      const publish = result => {
        if (!isCurrent()) return;
        const route = result?.feedback?.route;
        for (const [rampKey, index] of route?.indices ?? []) {
          const visit = index == null ? null : route.boards[index];
          if (visit?.valid) current.ramps.set(rampKey, {board: visit.loss, down: visit.downLoss, up: visit.upLoss, surf: visit.surfLoss});
        }
        current.status = route ? 'ready' : 'missing';
        pending = null;
        work.handle.release();
        changed();
      };
      if (work.handle.result) publish(work.handle.result);
      else work.handle.promise.then(publish, () => publish(null));
      return current;
    }
    const consumer = {
      get,
      tone(rampKey, loss) {
        const source = settings.boardColorReference;
        if (source !== 'pb' && source !== 'wr') { release(); return startTone(loss, settings.boardLossAmazing, settings.boardLossGood); }
        const session = getSession?.();
        const reference = get(session?.map ? mapKey(session.map) : null, source);
        return referenceTone(loss, reference?.status === 'ready' ? reference.ramps.get(rampKey)?.board ?? null : null, settings.referenceLossTolerance);
      },
      version,
      release,
      destroy() { release(); closed = true; consumers.delete(consumer); },
    };
    if (!closed) consumers.add(consumer);
    return consumer;
  }

  return {
    createConsumer,
    sources(key) {
      return ['pb', 'wr'].flatMap(name => {
        const info = describe(key, name);
        return info ? [{name, label: info.label}] : [];
      });
    },
    version,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { destroyed = true; for (const consumer of consumers) consumer.destroy(); lastAdapter = null; listeners.clear(); },
  };
}
