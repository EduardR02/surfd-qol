import { createMetrics } from './metrics.js';
import { observePhysics } from './observer.js';
import { createStartFeedback } from './start.js';

const MAX_COMMANDS = 40000;
const MAX_ROUTES = 12;
const SLICE_COMMANDS = 32;
const defer = () => new Promise(resolve => setTimeout(resolve, 0));
const micros = seconds => Math.round(seconds * 1e6);
const validSpeeds = speeds => Array.isArray(speeds) && speeds.length <= 64 && speeds.every(speed => Number.isFinite(speed) && speed >= 0 && speed <= 100000);
// Saved analysis outlives the page. Its key carries a hash of the extension's
// source (set by build.js), so changed analysis code never reuses old results.
const ANALYSIS = typeof __QOL_ANALYSIS__ === 'string' ? __QOL_ANALYSIS__ : 'dev';
// The KSF record route has no ID, so a saved analysis of it is matched by
// a fingerprint of the downloaded route.
export function routeFingerprint(replay) {
  const text = JSON.stringify([replay.format, replay.mapId, replay.mapVersion, replay.config, replay.initialState, replay.commands]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}
const resetEvents = new Set(['fall', 'teleport', 'restart', 'practice-restore', 'stage-restarted', 'start-return', 'stage-return']);

export function visitKey(measurement) {
  return measurement && measurement.surfaceId != null &&
    (typeof measurement.surfaceId === 'string' || Number.isSafeInteger(measurement.surfaceId)) &&
    Number.isSafeInteger(measurement.checkpoint) && measurement.checkpoint >= 0 &&
    Number.isSafeInteger(measurement.visit) && measurement.visit > 0
    ? JSON.stringify([measurement.surfaceId, measurement.checkpoint, measurement.visit]) : null;
}

function routeCollector() {
  const boards = [], indices = new Map();
  let sequence = 0, pending = null, complete = true, validRun = true;
  function observe(board, tick) {
    if (!board) return;
    if (!Number.isSafeInteger(board.sequence) || board.sequence < sequence) { validRun = complete = false; return; }
    if (!complete || !board.sequence) return;
    if (board.sequence !== sequence) {
      if (pending) boards.push(pending);
      if (board.sequence !== sequence + 1) complete = false;
      sequence = board.sequence;
      const key = visitKey(board);
      if (!key || typeof board.routePrefix !== 'string' || !board.routePrefix || indices.has(key)) complete = false;
      if (key) indices.set(key, indices.has(key) ? null : boards.length);
      pending = {key, tick, loss: null, surfLoss: null, downLoss: null, upLoss: null, valid: complete};
    }
    if (pending.key !== visitKey(board)) complete = false;
    pending.valid &&= complete;
    pending.loss = board.available && Number.isFinite(board.loss) && board.loss >= 0 ? board.loss : null;
  }
  function observeSurf(surf) {
    const key = visitKey(surf);
    if (!key || typeof surf.routePrefix !== 'string' || !surf.routePrefix) return;
    const index = indices.get(key);
    const visit = index == null ? null : boards[index] ?? pending;
    if (visit?.key !== key) return;
    const valid = surf.available && Number.isFinite(surf.loss);
    visit.surfLoss = valid ? surf.loss : null;
    visit.downLoss = valid && Number.isFinite(surf.downLoss) ? surf.downLoss : null;
    visit.upLoss = valid && Number.isFinite(surf.upLoss) ? surf.upLoss : null;
  }
  return {observe, observeSurf, finish() { if (pending) boards.push(pending); return validRun ? {boards, indices} : null; }};
}

export function sameMovementConfig(left, right) {
  if (!left || !right) return false;
  // These two native labels do not change ramp movement. All other settings do.
  const movementKeys = config => Object.keys(config).filter(key => key !== 'version' && key !== 'unrestrictedStart');
  const keys = movementKeys(left);
  return keys.length === movementKeys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

// Checkpoint and feedback validation are independent views of one native pass.
// A valid imported checkpoint route need not have compatible movement physics.
export async function reconstructReferenceReplay({adapter, session, replay, entry = null, isCurrent = () => true, yieldTask = defer, feedback = true}) {
  if (!isCurrent() || typeof adapter?.Session !== 'function' || !replay || !Array.isArray(replay.commands) ||
    replay.commands.length > MAX_COMMANDS || replay.mapId !== session.map.id || replay.mapVersion !== session.map.version ||
    !Number.isInteger(replay.format)) return null;
  const checkpointCompatible = !entry || JSON.stringify(replay.config) === JSON.stringify(session.config);
  await yieldTask();
  if (!isCurrent()) return null;
  // Shared consumers can join during the initial yield, before any native
  // state or movement observers are constructed.
  const wantsFeedback = typeof feedback === 'function' ? feedback() : feedback;
  const feedbackCompatible = wantsFeedback && replay.commands.length > 0 &&
    typeof adapter.Movement === 'function' && sameMovementConfig(replay.config, session.config);
  if (!checkpointCompatible && !feedbackCompatible) return null;
  const shadow = new adapter.Session(session.map, replay.config, replay.format);
  shadow.loadReplay(replay);
  const metrics = feedbackCompatible ? createMetrics({}, {referenceOnly: true}) : null;
  const collect = metrics ? routeCollector() : null;
  const startFeedback = metrics ? createStartFeedback() : null;
  // Restoring prototypes is not a run reset. No observer survives an await.
  const observed = metrics ? {...metrics, reset() {}} : null;
  let active = null, failed = false, fell = false, surfSequence = 0, boardRevision = -1;
  const shadowAdapter = {Session: adapter.Session, Movement: adapter.Movement, getSession: () => active};
  for (let index = 0; index < replay.commands.length;) {
    if (!isCurrent()) return null;
    // Checkpoint consumers may keep the native pass alive after all feedback
    // consumers hide. Stop observing rather than compute an unused summary.
    if (index && metrics && !failed && typeof feedback === 'function' && !feedback()) failed = true;
    let observer;
    try {
      if (metrics && !failed) {
        try {
          observer = observePhysics(shadowAdapter, observed, {
            onTick(_session, _command, events) {
              if (events.some(event => resetEvents.has(event))) failed = true;
              startFeedback.observe(shadow, events);
              const revision = metrics.boardRevision();
              if (revision !== boardRevision) { boardRevision = revision; collect.observe(metrics.boardSnapshot(), index); }
              const surf = metrics.surfSnapshot(surfSequence);
              if (surf) { surfSequence = surf.sequence; collect.observeSurf(surf); }
            },
            onReset() { if (active) failed = true; }, onError() { failed = true; }
          });
        } catch {
          // Unsupported observer hooks cannot invalidate native checkpoint data.
          failed = true;
        }
      }
      active = shadow;
      const end = Math.min(index + SLICE_COMMANDS, replay.commands.length);
      while (index < end) {
        const events = shadow.step(replay.commands[index++]);
        if (events.includes('fall')) { fell = true; break; }
        if (events.some(event => resetEvents.has(event))) failed = true;
      }
    } finally {
      active = null;
      observer?.destroy();
    }
    if (fell) return null;
    if (index < replay.commands.length) await yieldTask();
  }
  if (!isCurrent()) return null;
  const timer = shadow.timer?.state;
  // Playback invalidReason prevents submission, not use as a reference.
  if (timer?.phase !== 'finished' || !Number.isFinite(timer.elapsed) || timer.elapsed <= 0 ||
    !Array.isArray(timer.splits) || timer.splits.length > 64 || !timer.splits.every(value => Number.isFinite(value) && value >= 0)) return null;
  const timeUs = micros(timer.elapsed), splitsUs = timer.splits.map(micros);
  if (!Number.isSafeInteger(timeUs) || timeUs <= 0 || !splitsUs.every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  if (entry && (timeUs !== entry.timeUs || splitsUs.length !== entry.splitsUs.length || !splitsUs.every((value, index) => value === entry.splitsUs[index]))) return null;
  const checkpoint = checkpointCompatible && validSpeeds(shadow.checkpointSpeeds) && shadow.checkpointSpeeds.length === splitsUs.length
    ? {speeds: shadow.checkpointSpeeds.slice(), timeUs, splitsUs} : null;
  const start = metrics && !failed ? startFeedback.snapshot() : null;
  return {checkpoint, feedback: metrics && !failed ? {
    dt: replay.config.dt,
    route: collect.finish(),
    start: start.available && Number.isFinite(start.speed) ? {
      speed: start.speed, heightAboveFloor: Number.isFinite(start.heightAboveFloor) ? start.heightAboveFloor : null
    } : null
  } : null};
}

// Cache only summaries, not downloaded commands. A later feedback upgrade of
// a completed checkpoint-only result may fetch again; in-flight consumers
// share the download and request the highest active capability.
// Deterministic unmatched results are cached for this page/context as well.
// Missing downloads, exceptions and cancellation remain retryable on reacquire.
// saved: {get(id), put(id, {result, feedback})} keeps summaries across page
// loads (replay-archive.js): an official PB/WR replay is named by its run, so
// a saved one needs no download; the KSF route is fingerprinted once fetched.
export function createReferenceReplayStore({getAdapter, yieldTask = defer, saved = null}) {
  const pending = new Map(), cache = new Map();
  let adapter = null, destroyed = false;
  function clearPending() {
    for (const job of pending.values()) job.consumers.clear();
    pending.clear();
  }
  function acquire({key, session, entry = null, load, feedback = false, isCurrent = () => true}) {
    const nextAdapter = getAdapter();
    if (nextAdapter !== adapter) { clearPending(); cache.clear(); adapter = nextAdapter; }
    const cached = cache.get(key);
    if (cached && (!feedback || cached.feedback) && (feedback || !cached.feedbackOnly)) {
      cache.delete(key); cache.set(key, cached);
      return {result: cached.result, promise: Promise.resolve(cached.result), release() {}};
    }
    const consumer = {isCurrent, feedback};
    let job = pending.get(key);
    if (job && !job.current()) { pending.delete(key); job = null; }
    if (!job && !destroyed) {
      const expectedAdapter = adapter, map = session.map, config = session.config, format = session.replayFormat;
      const mapId = map.id, mapVersion = map.version;
      job = {consumers: new Set(), promise: null, feedback: false, current() {
        if (destroyed || getAdapter() !== expectedAdapter || session.map !== map || session.config !== config ||
          session.replayFormat !== format || map.id !== mapId || map.version !== mapVersion) return false;
        for (const member of this.consumers) if (!member.isCurrent()) this.consumers.delete(member);
        return this.consumers.size > 0;
      }, wantsFeedback() {
        if (!this.current()) return false;
        for (const member of this.consumers) if (member.feedback) return true;
        return false;
      }};
      pending.set(key, job);
      const work = job;
      const keep = summary => {
        const previous = cache.get(key);
        if (previous?.feedbackOnly && previous.result.feedback && !summary.result.feedback) {
          summary = {...summary, feedback: true, result: {...summary.result, feedback: previous.result.feedback}};
        }
        cache.set(key, summary);
        while (cache.size > MAX_ROUTES) cache.delete(cache.keys().next().value);
        return summary.result;
      };
      // A saved summary that covers what the consumers need.
      const stored = async id => {
        if (!saved || !id) return null;
        try {
          const summary = await saved.get(id);
          return summary?.result && (summary.feedback || !work.wantsFeedback()) ? summary : null;
        } catch { return null; }
      };
      work.promise = Promise.resolve().then(async () => {
        try {
          let id = key.includes(':official:') ? `${ANALYSIS}|${key}` : null, fingerprint = null;
          let found = work.current() ? await stored(id) : null;
          if (found) return work.current() ? keep(found) : null;
          const replay = work.current() ? await load?.() : null;
          if (!work.current()) return null;
          if (!replay) return {checkpoint: null, feedback: null, status: 'missing'};
          if (!Array.isArray(replay.commands) || replay.commands.length > MAX_COMMANDS) {
            return keep({result: {checkpoint: null, feedback: null, status: 'unmatched'}, feedback: work.wantsFeedback()});
          }
          if (key.endsWith(':ksf')) {
            fingerprint = routeFingerprint(replay);
            id = `${ANALYSIS}|${key}|${fingerprint}`;
            found = await stored(id);
            if (found) return work.current() ? keep(found) : null;
          }
          const reconstruct = () => reconstructReferenceReplay({
            adapter: expectedAdapter, session, replay, entry, isCurrent: () => work.current(), yieldTask,
            feedback: () => work.feedback = work.wantsFeedback()
          });
          let data = await reconstruct();
          // A feedback consumer joining after native simulation began needs an
          // upgrade, but shares this job's already-downloaded replay.
          if (!work.feedback && work.wantsFeedback()) data = await reconstruct();
          if (!work.current()) return null;
          const result = {...data, status: 'unmatched', ...(fingerprint ? {fingerprint} : {})};
          keep({result, feedback: work.feedback || (!data && work.wantsFeedback())});
          if (id && (result.checkpoint || result.feedback)) {
            Promise.resolve().then(() => saved?.put(id, {result, feedback: work.feedback})).catch(() => { /* kept for this page */ });
          }
          return result;
        } catch {
          return work.current() ? {checkpoint: null, feedback: null, status: 'missing'} : null;
        } finally {
          if (pending.get(key) === work) pending.delete(key);
        }
      });
    }
    if (!job) return {result: null, promise: Promise.resolve(null), release() {}};
    job.consumers.add(consumer);
    return {result: null, promise: job.promise, release() {
      job.consumers.delete(consumer);
      if (!job.consumers.size && pending.get(key) === job) pending.delete(key);
    }};
  }
  // Native Watch can change format and start-policy labels. Reuse the verified
  // movement summary after that adoption, without treating it as proof that an
  // official checkpoint summary passed the new exact-config requirement.
  function adoptFeedback({from, to, previous, session}) {
    if (destroyed || getAdapter() !== adapter || from === to || !previous?.map || !session?.map ||
      previous.map.id !== session.map.id || previous.map.version !== session.map.version ||
      !sameMovementConfig(previous.config, session.config)) return;
    const summary = cache.get(from), target = cache.get(to);
    if (!summary?.result.feedback || target?.result.feedback) return;
    const fullTarget = target && !target.feedbackOnly;
    const feedbackOnly = !fullTarget && (summary.feedbackOnly || JSON.stringify(previous.config) !== JSON.stringify(session.config));
    cache.set(to, {...summary, feedbackOnly, result: {...summary.result,
      checkpoint: fullTarget ? target.result.checkpoint : feedbackOnly ? null : summary.result.checkpoint}});
    while (cache.size > MAX_ROUTES) cache.delete(cache.keys().next().value);
  }
  return {acquire, adoptFeedback, destroy() { destroyed = true; clearPending(); cache.clear(); }};
}
