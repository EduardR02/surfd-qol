// Per-ramp PB/WR summaries shared with the HUD's native analysis cache.
// Availability never acquires a replay. Each visible surface owns a consumer
// and releases it when its comparison is no longer needed.
import {analysisKey, referenceIdentity} from './references.js';
import {mapKey} from './run-history.js';
import {referenceTone, startTone} from './hud-model.js';
import {feedbackApplies, routeFingerprint, sameMovementConfig} from './replay-store.js';

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
    if (destroyed || (source !== 'pb' && source !== 'wr') || !session?.map || mapKey(session.map) !== key || !replayStore) return null;
    const leaderboard = settings.wrSource === 'leaderboard';
    const entry = source === 'pb' ? refs?.own : source === 'wr' && leaderboard ? refs?.record : null;
    const ksf = source === 'wr' && !leaderboard, identity = referenceIdentity(entry);
    if (ksf ? typeof refs?.loadRecordRoute !== 'function' : !identity || typeof refs?.loadReplay !== 'function') return null;
    return {session, refs, entry, identity, ksf, ownerKey: refs?.ownerKey, boardId: refs?.boardId,
      key: `${analysisKey(session, refs?.boardId)}:${ksf ? 'ksf' : `official:${identity}`}`,
      label: source === 'pb' ? 'PB' : leaderboard ? 'Site WR' : 'KSF WR'};
  }

  function createConsumer() {
    let slot = null, slotAdapter = null, slotOwnerKey = null, pending = null, navigation = null, closed = destroyed;
    function release() {
      const work = pending;
      pending = null; slot = null; slotAdapter = null; slotOwnerKey = null; navigation = null;
      work?.handle?.release();
    }
    function peek(key, source) {
      if (closed || slot?.status !== 'ready') return null;
      const info = describe(key, source);
      return info && slot.key === info.key && slot.source === source && slotAdapter === getAdapter?.() &&
        slotOwnerKey === info.ownerKey && sameMovementConfig(slot.config, info.session.config) ? slot : null;
    }
    function get(key, source, owns = () => true) {
      const info = closed ? null : describe(key, source);
      if (!info) { release(); return null; }
      const adapter = getAdapter?.();
      // A summary kept under one session's rules applies to another's only if it moves the same way.
      if (slot?.key === info.key && slot.source === source && slotAdapter === adapter && slotOwnerKey === info.ownerKey &&
        (slot.status !== 'loading' || pending?.session === info.session && pending.owns()) &&
        (slot.status !== 'ready' || sameMovementConfig(slot.config, info.session.config))) return slot;
      release();
      slot = {key: info.key, source, status: 'loading', label: info.label, ramps: new Map()};
      slotAdapter = adapter; slotOwnerKey = info.ownerKey;
      if (typeof adapter?.Session !== 'function' || typeof adapter?.Movement !== 'function') { slot.status = 'missing'; return slot; }
      const current = slot, {session, refs, identity, ksf, ownerKey} = info;
      const entry = identity ? {runId: info.entry.runId, timeUs: info.entry.timeUs, splitsUs: info.entry.splitsUs.slice()} : null;
      const work = {session, adapter, ownerKey, owns, handle: null, replay: null, promise: null};
      pending = work;
      const isCurrent = () => {
        if (!owns() || pending !== work || getSession?.() !== session || getAdapter?.() !== adapter) return false;
        const next = describe(key, source);
        return next?.key === current.key && next.ownerKey === ownerKey;
      };
      work.handle = replayStore.acquire({key: info.key, session, entry,
        load: async () => work.replay = await (ksf ? refs.loadRecordRoute() : refs.loadReplay(entry.runId)), feedback: true, isCurrent});
      const publish = result => {
        if (!isCurrent()) {
          if (pending === work) release();
          else work.handle.release();
          return;
        }
        const route = feedbackApplies(result, session) ? result.feedback.route : null;
        for (const [rampKey, index] of route?.indices ?? []) {
          const visit = index == null ? null : route.boards[index];
          if (visit?.valid) current.ramps.set(rampKey, {board: visit.loss, down: visit.downLoss, up: visit.upLoss, surf: visit.surfLoss,
            speedBefore: visit.speedBefore ?? null, speedAfter: visit.speedAfter ?? null, angle: visit.angle ?? null,
            ...(Number.isInteger(visit.tick) ? {tick: visit.tick} : {})});
        }
        current.dt = result?.feedback?.dt;
        current.config = result?.config ?? null;
        current.fingerprint = result?.fingerprint;
        current.status = route ? 'ready' : 'missing';
        pending = null;
        work.handle.release();
        changed();
      };
      if (work.handle.result) publish(work.handle.result);
      else work.promise = work.handle.promise.then(publish, () => publish(null));
      return current;
    }
    const consumer = {
      get,
      peek,
      async watchRamp(key, source, rampKey, replayControl, {leadSeconds = 0.5, paused = true} = {}) {
        const info = closed ? null : describe(key, source), adapter = getAdapter?.();
        if (!info || typeof rampKey !== 'string' || typeof replayControl?.watchLoaded !== 'function' ||
          typeof adapter?.replay?.watch !== 'function' || !Number.isFinite(leadSeconds) || leadSeconds < 0) return false;
        const intent = {}, entry = info.entry ? {...info.entry} : null;
        let reference = null, destination = null;
        const context = (session = info.session) => {
          const next = closed ? null : describe(key, source);
          if (getSession?.() !== session || getAdapter?.() !== adapter || !next || next.ownerKey !== info.ownerKey) return false;
          if (session === info.session) return next.key === info.key;
          // Native Watch adopts the replay's format and non-movement labels.
          return next.boardId === info.boardId && next.identity === info.identity && next.ksf === info.ksf &&
            sameMovementConfig(session.config, info.session.config);
        };
        // watchLoaded reserves native Watch ownership before any analysis or I/O.
        const played = await replayControl.watchLoaded(async owns => {
          if (!context() || !owns()) return null;
          reference = get(key, source, owns);
          const work = pending;
          navigation = intent;
          if (work?.promise) await work.promise;
          if (!context() || !owns() || navigation !== intent || slot !== reference) return null;
          const ramp = reference?.status === 'ready' ? reference.ramps.get(rampKey) : null;
          if (!Number.isInteger(ramp?.tick) || ramp.tick < 0) return null;
          destination = {tick: ramp.tick, leadSeconds, paused};
          // A newly indexed route already downloaded these commands. Completed
          // summaries deliberately retain no replays: fetch only on Watch intent.
          const data = work?.replay ?? await (info.ksf ? info.refs.loadRecordRoute() : info.refs.loadReplay(entry.runId));
          if (!context() || !owns() || navigation !== intent || !data ||
            data.mapId !== info.session.map.id || data.mapVersion !== info.session.map.version ||
            !Number.isInteger(data.format) || !Array.isArray(data.commands) || data.commands.length > 40000 ||
            !sameMovementConfig(data.config, info.session.config) ||
            (info.ksf && (!reference.fingerprint || routeFingerprint(data) !== reference.fingerprint))) return null;
          return data;
        }, {title: `${info.label} on ${info.session.map.name ?? info.session.map.id}`,
          navigation: () => destination, isCurrent: session => navigation === intent && context(session),
          // The same summary marks the replay's ramp boards on the timeline.
          analysis: {key: info.key, entry}});
        // The summary is keyed by the replay, not the session, so the replay's
        // own session keeps it: no second analysis on another click.
        return played;
      },
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
    peek(key, source) {
      for (const consumer of consumers) {
        const slot = consumer.peek(key, source);
        if (slot) return slot;
      }
      return null;
    },
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
