import { createMetrics } from './metrics.js';
import { observePhysics } from './observer.js';
import { createStartFeedback } from './start.js';

const MAX_COMMANDS = 40000;
const MAX_ROUTES = 12;
const SLICE_COMMANDS = 32;
const defer = () => new Promise(resolve => setTimeout(resolve, 0));
const micros = seconds => Math.round(seconds * 1e6);
const validSpeeds = speeds => Array.isArray(speeds) && speeds.length <= 64 && speeds.every(speed => Number.isFinite(speed) && speed >= 0 && speed <= 100000);
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
  function observe(board) {
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
      pending = {key, loss: null, surfLoss: null, downLoss: null, upLoss: null, valid: complete};
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

function sameMovementConfig(left, right) {
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
  const feedbackCompatible = feedback && replay.commands.length > 0 && typeof adapter.Movement === 'function' && sameMovementConfig(replay.config, session.config);
  if (!checkpointCompatible && !feedbackCompatible) return null;
  await yieldTask();
  if (!isCurrent()) return null;
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
    let observer;
    try {
      if (metrics && !failed) {
        try {
          observer = observePhysics(shadowAdapter, observed, {
            onTick(_session, _command, events) {
              if (events.some(event => resetEvents.has(event))) failed = true;
              startFeedback.observe(shadow, events);
              const revision = metrics.boardRevision();
              if (revision !== boardRevision) { boardRevision = revision; collect.observe(metrics.boardSnapshot()); }
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
    route: collect.finish(),
    start: start.available && Number.isFinite(start.speed) ? {
      speed: start.speed, heightAboveFloor: Number.isFinite(start.heightAboveFloor) ? start.heightAboveFloor : null
    } : null
  } : null};
}

export function createReferenceReplayStore({getAdapter, yieldTask = defer}) {
  const pending = new Map(), cache = new Map();
  let adapter = null, destroyed = false;
  function clearPending() {
    for (const job of pending.values()) job.consumers.clear();
    pending.clear();
  }
  function acquire({key, session, entry = null, load, isCurrent = () => true}) {
    const nextAdapter = getAdapter();
    if (nextAdapter !== adapter) { clearPending(); cache.clear(); adapter = nextAdapter; }
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key); cache.set(key, cached);
      return {result: cached, promise: Promise.resolve(cached), release() {}};
    }
    const consumer = {isCurrent};
    let job = pending.get(key);
    if (job && !job.current()) { pending.delete(key); job = null; }
    if (!job && !destroyed) {
      const expectedAdapter = adapter, map = session.map, config = session.config, format = session.replayFormat;
      const mapId = map.id, mapVersion = map.version;
      job = {consumers: new Set(), promise: null, current() {
        if (destroyed || getAdapter() !== expectedAdapter || session.map !== map || session.config !== config ||
          session.replayFormat !== format || map.id !== mapId || map.version !== mapVersion) return false;
        for (const member of this.consumers) if (!member.isCurrent()) this.consumers.delete(member);
        return this.consumers.size > 0;
      }};
      pending.set(key, job);
      const work = job;
      work.promise = Promise.resolve().then(() => work.current() ? load?.() : null).then(async replay => {
        if (!work.current()) return null;
        if (!replay) return {checkpoint: null, feedback: null, status: 'missing'};
        const data = await reconstructReferenceReplay({adapter: expectedAdapter, session, replay, entry, isCurrent: () => work.current(), yieldTask});
        return work.current() ? {...data, status: 'unmatched'} : null;
      }).catch(() => work.current() ? {checkpoint: null, feedback: null, status: 'missing'} : null).then(result => {
        if (pending.get(key) === work) pending.delete(key);
        if (result && work.current() && (result.checkpoint || result.feedback)) {
          cache.set(key, result);
          while (cache.size > MAX_ROUTES) cache.delete(cache.keys().next().value);
        }
        return result;
      });
    }
    if (!job) return {result: null, promise: Promise.resolve(null), release() {}};
    job.consumers.add(consumer);
    return {result: null, promise: job.promise, release() {
      job.consumers.delete(consumer);
      if (!job.consumers.size && pending.get(key) === job) pending.delete(key);
    }};
  }
  return {acquire, destroy() { destroyed = true; clearPending(); cache.clear(); }};
}
