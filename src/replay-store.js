import { createMetrics } from './metrics.js';
import { observePhysics } from './observer.js';
import { createStartFeedback } from './start.js';

// Longer replays (about ten minutes) aren't analysed.
export const MAX_COMMANDS = 40000;
const MAX_ROUTES = 12;
// A job whose consumers all left (the HUD hid behind the menu) waits this
// long for one to return, keeping its download and progress.
const GRACE_MS = 30000;
// Analysis runs in the page's idle time, so it never holds up a frame of the
// game: a slice lasts while the idle period does, and at least this many
// commands. A page that is never idle still gets a slice every IDLE_WAIT_MS.
const SLICE_COMMANDS = 32;
const IDLE_WAIT_MS = 50;
const defer = () => new Promise(resolve => typeof requestIdleCallback === 'function'
  ? requestIdleCallback(resolve, {timeout: IDLE_WAIT_MS}) : setTimeout(resolve, 0));
const idleLeft = deadline => !!deadline && !deadline.didTimeout && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() > 2;
const micros = seconds => Math.round(seconds * 1e6);
const validSpeeds = speeds => Array.isArray(speeds) && speeds.length <= 64 && speeds.every(speed => Number.isFinite(speed) && speed >= 0 && speed <= 100000);
// Saved analysis outlives the page. Its key carries a hash of the extension's
// source (set by build.js), so changed analysis code never reuses old results.
const ANALYSIS = typeof __QOL_ANALYSIS__ === 'string' ? __QOL_ANALYSIS__ : 'dev-touch-exit';
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
      pending = {key, tick, loss: null,
        speedBefore: board.available && Number.isFinite(board.speedBefore) && board.speedBefore >= 0 ? board.speedBefore : null,
        speedAfter: null, exitSpeed: null, angle: null, surfLoss: null, downLoss: null, upLoss: null, valid: complete};
    }
    if (pending.key !== visitKey(board)) complete = false;
    pending.valid &&= complete;
    pending.loss = board.available && Number.isFinite(board.loss) && board.loss >= 0 ? board.loss : null;
    pending.speedAfter = board.available && Number.isFinite(board.speedAfter) && board.speedAfter >= 0 ? board.speedAfter : null;
    pending.angle = board.available && Number.isFinite(board.angle) && board.angle >= 0 && board.angle <= 90 ? board.angle : null;
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
    visit.exitSpeed = (surf.available || surf.reason === 'short-contact') &&
      Number.isFinite(surf.exitSpeed) && surf.exitSpeed >= 0 ? surf.exitSpeed : null;
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
const sameConfig = (left, right) => !!left && !!right && JSON.stringify(left) === JSON.stringify(right);

// A summary belongs to the replay alone, whatever session asked for it; what
// it offers a session depends on that session's rules. Checkpoints compare
// only under the exact config of an official run (any, for the KSF route),
// movement feedback under the same movement rules.
export const checkpointApplies = (result, session, entry) => !!result?.checkpoint && (!entry || sameConfig(result.config, session?.config));
export const feedbackApplies = (result, session) => !!result?.feedback && sameMovementConfig(result.config, session?.config);
// Ramp boards of an analysed replay, as timeline marks: [{tick, board, key}].
export const routeBoards = result => (result?.feedback?.route?.boards ?? [])
  .filter(visit => Number.isInteger(visit.tick) && typeof visit.key === 'string')
  .map(visit => ({tick: visit.tick, board: Number.isFinite(visit.loss) ? visit.loss : null, key: visit.key}));

// Whether a summary already holds everything a consumer could use from it.
// A part never computed for a compatible session (*Tried) is still owed.
function covers(result, session, entry, feedback) {
  if (!result) return false;
  // No config: the replay itself is unusable, so there is nothing to compute.
  if (!result.config) return true;
  if (feedback) return !sameMovementConfig(result.config, session.config) || result.feedbackTried === true;
  return !(!entry || sameConfig(result.config, session.config)) || result.checkpointTried === true;
}
// One replay's summaries from passes that computed different parts.
function merge(base, next) {
  if (!base?.config || !next?.config) return next ?? base;
  return {...base, ...next,
    ...(!next.checkpointTried && base.checkpointTried ? {checkpoint: base.checkpoint, checkpointTried: true} : {}),
    ...(!next.feedbackTried && base.feedbackTried ? {feedback: base.feedback, feedbackTried: true} : {})};
}

// Checkpoint and feedback validation are independent views of one native pass.
// A valid imported checkpoint route need not have compatible movement physics.
// wants(config) says which parts to compute (a shared store asks its
// consumers); by default, what this session can use. The result records the
// replay's config and which parts were tried, null only when the replay itself
// is unusable (it falls, never finishes, or doesn't match its entry).
// paused() is asked between slices once isCurrent() fails: true resumes, false stops.
export async function reconstructReferenceReplay({adapter, session, replay, entry = null, isCurrent = () => true, yieldTask = defer, feedback = true, wants = null, paused = null}) {
  if (!isCurrent() || typeof adapter?.Session !== 'function' || !replay || !Array.isArray(replay.commands) ||
    replay.commands.length > MAX_COMMANDS || replay.mapId !== session.map.id || replay.mapVersion !== session.map.version ||
    !Number.isInteger(replay.format)) return null;
  let deadline = await yieldTask();
  if (!isCurrent()) return null;
  // Shared consumers can join during the initial yield, before any native
  // state or movement observers are constructed.
  const asked = () => wants ? wants(replay.config) : {
    checkpoint: !entry || sameConfig(replay.config, session.config),
    feedback: (typeof feedback === 'function' ? feedback() : feedback) && sameMovementConfig(replay.config, session.config)};
  const first = asked();
  const checkpointCompatible = first.checkpoint;
  const feedbackCompatible = first.feedback && replay.commands.length > 0 && typeof adapter.Movement === 'function';
  const tried = {config: replay.config, checkpointTried: checkpointCompatible, feedbackTried: feedbackCompatible};
  if (!checkpointCompatible && !feedbackCompatible) return {...tried, checkpoint: null, feedback: null};
  const shadow = new adapter.Session(session.map, replay.config, replay.format);
  shadow.loadReplay(replay);
  const metrics = feedbackCompatible ? createMetrics({}, {referenceOnly: true}) : null;
  const collect = metrics ? routeCollector() : null;
  const startFeedback = metrics ? createStartFeedback() : null;
  // Restoring prototypes is not a run reset. No observer survives an await.
  const observed = metrics ? {...metrics, reset() {}} : null;
  let active = null, failed = false, dropped = false, fell = false, surfSequence = 0, boardRevision = -1;
  const shadowAdapter = {Session: adapter.Session, Movement: adapter.Movement, getSession: () => active};
  for (let index = 0; index < replay.commands.length;) {
    // No observer is installed between slices, so waiting here holds nothing.
    while (!isCurrent()) if (!paused || !await paused()) return null;
    // Checkpoint consumers may keep the native pass alive after all feedback
    // consumers hide. Stop observing rather than compute an unused summary.
    if (index && metrics && !failed && !dropped && !asked().feedback) dropped = true;
    let observer;
    try {
      if (metrics && !failed && !dropped) {
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
      while (index < replay.commands.length && (index < end || idleLeft(deadline))) {
        const events = shadow.step(replay.commands[index++]);
        if (events.includes('fall')) { fell = true; break; }
        if (events.some(event => resetEvents.has(event))) failed = true;
      }
    } finally {
      active = null;
      observer?.destroy();
    }
    if (fell) return null;
    if (index < replay.commands.length) deadline = await yieldTask();
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
  const start = metrics && !failed && !dropped ? startFeedback.snapshot() : null;
  // Feedback dropped part-way was never computed: a later consumer may ask again.
  return {...tried, feedbackTried: feedbackCompatible && !dropped, checkpoint, feedback: metrics && !failed && !dropped ? {
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
    for (const job of pending.values()) { job.consumers.clear(); job.wake?.(false); }
    pending.clear();
  }
  // key names the replay (see analysisKey in references.js), never the asking
  // session's rules: a replay watched under other rules reuses the summary,
  // and each consumer checks what applies to its session (checkpointApplies,
  // feedbackApplies). Only parts a compatible consumer still lacks are computed.
  function acquire({key, session, entry = null, load, feedback = false, isCurrent = () => true}) {
    const nextAdapter = getAdapter();
    if (nextAdapter !== adapter) { clearPending(); cache.clear(); adapter = nextAdapter; }
    const cached = cache.get(key);
    if (cached && covers(cached.result, session, entry, feedback)) {
      cache.delete(key); cache.set(key, cached);
      return {result: cached.result, promise: Promise.resolve(cached.result), release() {}};
    }
    const consumer = {isCurrent, feedback, session, entry};
    let job = pending.get(key);
    // A job outlives its last consumer until its next slice, so a consumer
    // handing over to another session's in the same tick keeps its progress.
    if (job && !job.valid()) { pending.delete(key); job = null; }
    if (!job && !destroyed) {
      const expectedAdapter = adapter, map = session.map, mapId = map.id, mapVersion = map.version;
      job = {consumers: new Set(), promise: null,
        valid() { return !destroyed && getAdapter() === expectedAdapter && session.map === map && map.id === mapId && map.version === mapVersion; },
        current() {
          if (!this.valid()) return false;
          for (const member of this.consumers) if (!member.isCurrent()) this.consumers.delete(member);
          return this.consumers.size > 0;
        },
        // Waits for a consumer to come back (true), or gives up (false).
        pause() {
          if (!this.valid()) return Promise.resolve(false);
          return new Promise(resolve => {
            const timer = setTimeout(() => wake(false), GRACE_MS);
            const wake = resumed => { clearTimeout(timer); if (this.wake === wake) this.wake = null; resolve(resumed); };
            this.wake = wake;
          });
        },
        // What the current consumers can use from a replay with this config.
        // Checkpoints come free with any pass, so they ride along with feedback.
        wants(config) {
          let exact = false, checkpoint = false, movement = false;
          if (this.current()) for (const member of this.consumers) {
            const applies = !member.entry || sameConfig(config, member.session.config);
            exact ||= applies;
            if (!member.feedback && applies) checkpoint = true;
            if (member.feedback && sameMovementConfig(config, member.session.config)) movement = true;
          }
          return {checkpoint: checkpoint || exact && movement, feedback: movement};
        }};
      pending.set(key, job);
      const work = job;
      const keep = result => {
        const merged = merge(cache.get(key)?.result, result);
        cache.delete(key);
        cache.set(key, {result: merged});
        while (cache.size > MAX_ROUTES) cache.delete(cache.keys().next().value);
        return merged;
      };
      const owed = result => {
        if (!result?.config) return false;
        const asked = work.wants(result.config);
        return asked.checkpoint && !result.checkpointTried || asked.feedback && !result.feedbackTried;
      };
      const stored = async id => {
        if (!saved || !id) return null;
        try { return (await saved.get(id))?.result ?? null; } catch { return null; }
      };
      work.promise = Promise.resolve().then(async () => {
        try {
          // Official runs and watched replays are named by their key; the KSF
          // route only once its download is fingerprinted.
          let id = key.includes(':official:') || key.includes(':route:') ? `${ANALYSIS}|${key}` : null, fingerprint = null;
          let found = work.current() ? await stored(id) : null;
          if (found) {
            if (!work.current()) return null;
            found = keep(found);
            if (!owed(found)) return found;
          }
          const replay = work.current() ? await load?.() : null;
          while (!work.current()) if (!await work.pause()) return null;
          if (!replay) return {checkpoint: null, feedback: null, status: 'missing'};
          if (!Array.isArray(replay.commands) || replay.commands.length > MAX_COMMANDS) {
            return keep({checkpoint: null, feedback: null, status: 'unmatched'});
          }
          if (key.endsWith(':ksf')) {
            fingerprint = routeFingerprint(replay);
            id = `${ANALYSIS}|${key}|${fingerprint}`;
            found = await stored(id);
            if (found) {
              if (!work.current()) return null;
              found = keep(found);
              if (!owed(found)) return found;
            }
          }
          const reconstruct = () => reconstructReferenceReplay({
            adapter: expectedAdapter, session, replay, entry, isCurrent: () => work.current(), yieldTask,
            wants: config => work.wants(config), paused: () => work.pause()
          });
          let data = merge(found, await reconstruct());
          // A consumer joining after the pass began may want a part it skipped;
          // the second pass shares the downloaded replay.
          if (owed(data)) data = merge(data, await reconstruct());
          if (!work.current()) return null;
          const result = keep({...(data ?? {checkpoint: null, feedback: null}), status: 'unmatched', ...(fingerprint ? {fingerprint} : {})});
          if (id && (result.checkpoint || result.feedback)) {
            Promise.resolve().then(() => saved?.put(id, {result, feedback: result.feedbackTried === true})).catch(() => { /* kept for this page */ });
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
    job.wake?.(true);
    return {result: null, promise: job.promise, release() { job.consumers.delete(consumer); }};
  }
  return {acquire, destroy() { destroyed = true; clearPending(); cache.clear(); }};
}
