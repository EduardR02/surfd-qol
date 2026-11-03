import {captureTrack, trackSlice, TRACK_ARRAYS} from './cinema-recording.js';
import {planCamera} from './cinema-camera.js';
import {cameraWorld, PROBE} from './cinema-world.js';
import {onClock} from './cinema-clock.js';
import {alignByPlace} from './cinema-sync.js';

const protocol = 1;
function workerYield() {
  let channel = null;
  const waiting = [];
  return () => new Promise(resolve => {
    if (!channel) {
      channel = new MessageChannel();
      channel.port1.onmessage = () => waiting.shift()();
      channel.port1.unref?.(); channel.port2.unref?.();
    }
    waiting.push(resolve);
    channel.port2.postMessage(null);
  });
}

// createSession closes over the native physics implementation and retained
// world. Merely indexing POV installs no observer and allocates no track arrays.
export function createCinemaWorkerRuntime({post, createSession}) {
  const pause = workerYield();
  // This is a message responsiveness quantum, not a main-thread frame budget.
  async function yieldPlanner() {
    await pause();
    for (const record of records.values()) {
      if (record.indexing && record.position < record.replay.commands.length && record.finish == null &&
          record.heartbeat && performance.now() - record.lastHeartbeat > 120) {
        record.lastHeartbeat = performance.now();
        record.heartbeat();
      }
    }
    const until = performance.now() + 12;
    return {didTimeout: false, timeRemaining: () => Math.max(0, until - performance.now())};
  }
  const records = new Map(), requests = new Map();
  let map = null, primarySession = null, lastRecord = null, latestPlan = null, planning = null, priority = false;
  const send = (type, request, data = {}, transfer = []) => post({__surfdQolIndex: protocol, type, request, ...data}, {transfer});
  function trim() {
    for (const [id, record] of records) {
      if ((records.size > 8 || !record.capture) && !record.retained && !record.indexing && !record.running && !record.subscribers.size && record !== lastRecord) {
        record.capture?.dispose?.();
        record.region = null;
        records.delete(id);
        send('camera-forget', null, {id});
      }
    }
  }
  function publish(record) {
    const capture = record.capture;
    if (!capture || !capture.publishable && !record.done) return;
    if (record.region && capture.count >= record.region.end) record.region = null;
    const track = capture.track;
    for (const [request, subscriber] of record.subscribers) {
      const from = subscriber.sent, end = Math.min(capture.count, from + 256);
      if (end === from && !record.done) continue;
      const arrays = {}, transfer = [];
      for (const key of TRACK_ARRAYS) {
        const size = key === 'position' || key === 'normal' ? 3 : 1;
        arrays[key] = track[key].slice(from * size, end * size);
        transfer.push(arrays[key].buffer);
      }
      subscriber.sent = end;
      send('record-chunk', request, {id: record.id, from, end, total: track.count, dt: track.dt, arrays,
        start: track.start, startTick: track.startTick, finish: track.finish, splits: track.splits.slice(), time: track.time,
        done: record.done && end === track.count, duration: performance.now() - record.started}, transfer);
      if (record.done && end === track.count) { record.subscribers.delete(request); requests.delete(request); }
    }
    if (!record.emitting && [...record.subscribers.values()].some(subscriber => subscriber.sent < capture.count)) {
      record.emitting = true;
      void pause().then(() => { record.emitting = false; publish(record); });
    }
  }
  function stopUnused(record) {
    if (record.subscribers.size || record.done || record.running) return;
    record.capture?.dispose?.();
    record.capture = record.recordingSession = record.region = null;
    record.retained = false;
  }
  function complete(record) {
    if (record.running || record.done || !record.subscribers.size || record.indexing && !record.catchingUp) return;
    record.running = true;
    void (async () => {
      try {
        if (record.regionTask) { await record.regionTask; await pause(); }
        while (record.capture.count < record.capture.track.count && record.subscribers.size) {
          if (record.regionTask) { await record.regionTask; await pause(); }
          if (planning && priority) await planning;
          if (!record.subscribers.size) break;
          const limit = record.catchingUp ? record.position + 1 : record.capture.track.count;
          const end = Math.min(limit, record.capture.count + 64);
          while (record.capture.count < end) record.recordingSession.step(record.replay.commands[record.capture.count - 1]);
          if (record.catchingUp && record.capture.count === limit) {
            // The missing prefix is now exact, including landing, fractional
            // start-zone exits and contact normals. Reuse the native pass for
            // every remaining command; never re-simulate its future suffix.
            record.capture.follow(record.session);
            record.recordingSession = record.session;
            record.catchingUp = false;
            record.resolveCatchup();
          }
          if (record.capture.count === record.capture.track.count) {
            record.done = true;
            record.capture.finish();
          }
          publish(record);
          if (record.heartbeat && performance.now() - record.lastHeartbeat > 120) {
            record.lastHeartbeat = performance.now();
            record.heartbeat();
          }
          if (record.indexing && !record.catchingUp || record.done) break;
          await pause();
        }
      } catch (error) {
        for (const request of record.subscribers.keys()) {
          send('camera-error', request, {error: String(error?.message ?? error)});
          requests.delete(request);
        }
        record.subscribers.clear();
        record.capture?.dispose();
        record.capture = null;
      } finally {
        record.running = false;
        if (record.catchingUp) { record.catchingUp = false; record.resolveCatchup(); }
        stopUnused(record);
        trim();
      }
    })();
  }
  function ensureCapture(record) {
    if (record.capture) return;
    record.started = performance.now();
    if (record.position) {
      // Native index batches retain sparse snapshots, not per-tick poses or
      // slide contacts. Only this already-discarded prefix must be replayed.
      record.recordingSession = createSession(map, record.replay);
      record.capture = captureTrack(record.recordingSession, record.replay);
      record.catchingUp = true;
      record.catchup = new Promise(resolve => { record.resolveCatchup = resolve; });
    } else {
      record.recordingSession = record.session;
      record.capture = captureTrack(record.session, record.replay);
    }
  }
  function nearby(record, tick, request, token) {
    const dt = record.replay.config?.dt || 0.015, shoulder = Math.ceil(6 / dt);
    const from = Math.max(0, Math.floor((tick - shoulder) / 4) * 4);
    const end = Math.min(record.replay.commands.length + 1, tick + shoulder + 1);
    if (!from || end - from < 2 || record.capture.count >= end) return;
    let anchor = null;
    for (const frame of record.keyframes) { if (frame.index >= from) break; anchor = frame; }
    if (!anchor) return;
    const session = createSession(map, record.replay);
    if (typeof session.restorePractice !== 'function' || !session.restorePractice(anchor.session)) return;
    const capture = captureTrack(session, {...record.replay, commands: {length: end - anchor.index - 1}},
      {base: (record.replay.initialState?.tick ?? 0) + anchor.index, normalizeLanding: false});
    return (async () => {
    try {
      while (capture.count < capture.track.count && record.subscribers.has(request) && record.regionToken === token) {
        const stop = Math.min(capture.track.count, capture.count + 64);
        while (capture.count < stop) session.step(record.replay.commands[anchor.index + capture.count - 1]);
        if (capture.count < capture.track.count) await pause();
      }
      if (!record.subscribers.has(request) || record.regionToken !== token) return;
      const track = capture.finish(), nativeAhead = record.position >= end - 1;
      const timer = (nativeAhead ? record.session : session).timer?.state;
      const startTick = nativeAhead && Number.isFinite(timer?.startTick) && timer.phase !== 'ready'
        ? timer.startTick - (record.replay.initialState?.tick ?? 0)
        : track.startTick === null ? null : track.startTick + anchor.index;
      const splits = nativeAhead ? record.markers.filter(marker => marker.kind === 'checkpoint').map(marker => marker.index) :
        [...record.markers.filter(marker => marker.kind === 'checkpoint' && marker.index <= anchor.index &&
          (startTick === null || marker.index >= startTick)).map(marker => marker.index),
        ...track.splits.filter(at => at > 0).map(at => at + anchor.index)];
      const metadata = {startTick, start: Math.max(0, Math.min(record.replay.commands.length, Math.ceil(startTick ?? 0))),
        finish: nativeAhead ? record.finish ?? record.replay.commands.length :
          timer?.phase === 'finished' ? track.finish + anchor.index : record.replay.commands.length,
        splits, time: timer?.phase === 'finished' ? timer.elapsed : null};
      track.startTick = startTick === null ? null : startTick - anchor.index;
      track.start = Math.max(0, Math.min(track.count - 1, metadata.start - anchor.index));
      track.finish = Math.max(0, Math.min(track.count - 1, metadata.finish - anchor.index));
      track.splits = metadata.splits.filter(at => at >= anchor.index && at < end).map(at => at - anchor.index);
      track.time = metadata.time;
      record.region = {track, anchor: anchor.index, from, end};
      const arrays = {}, transfer = [];
      for (const key of TRACK_ARRAYS) {
        const size = key === 'position' || key === 'normal' ? 3 : 1;
        arrays[key] = track[key].slice((from - anchor.index) * size);
        transfer.push(arrays[key].buffer);
      }
      send('record-window', request, {id: record.id, from, end, total: record.replay.commands.length + 1,
        dt, arrays, ...metadata, duration: performance.now() - record.started}, transfer);
    } finally { capture.dispose(); }
    })();
  }
  function prioritize(record, tick, request) {
    const token = record.regionToken = {};
    const failed = error => {
      if (record.regionToken !== token || !record.subscribers.has(request)) return;
      record.subscribers.delete(request);
      requests.delete(request);
      send('camera-error', request, {error: String(error?.message ?? error)});
      stopUnused(record);
    };
    let work;
    try { work = nearby(record, tick, request, token); } catch (error) { failed(error); }
    const task = record.regionTask = work?.catch(failed) ?? null;
    if (task) void task.then(() => { if (record.regionTask === task) record.regionTask = null; });
  }
  function attach(session, replay, id, indexing = true) {
    map = session.map;
    if (indexing || !primarySession) primarySession = session;
    const record = {id, session, replay, position: 0, capture: null, recordingSession: null,
      subscribers: new Map(), keyframes: [], markers: [], finish: null, indexing, catchingUp: false, running: false, done: false, retained: false};
    records.set(id, record);
    lastRecord = record;
    trim();
    return record;
  }
  function resolveTrack(value) {
    if (!value?.handle) return value;
    const record = records.get(value.handle.id);
    const from = value.handle.from ?? 0, end = from + value.count;
    if (record?.capture && from >= 0 && end <= record.capture.count) return trackSlice(record.capture.track, from, end);
    if (record?.region && from >= record.region.from && end <= record.region.end)
      return trackSlice(record.region.track, from - record.region.anchor, end - record.region.anchor);
    throw new Error('Camera track is no longer retained');
  }
  async function plan(message, token) {
    const started = performance.now();
    try {
      const options = message.options;
      let a = resolveTrack(options.a), others = (options.others ?? []).map(other => ({track: resolveTrack(other.track), map: other.map}));
      if (Number.isInteger(options.focusIndex)) {
        const chosen = others[options.focusIndex], clock = a;
        if (!chosen) throw new Error('Camera focus is unavailable');
        a = onClock(chosen.track, chosen.map, clock);
        others = [{track: clock, map: Float32Array.from({length: clock.count}, (_, tick) => tick)},
          ...others.filter((_, index) => index !== options.focusIndex)];
      }
      const session = records.get(message.world)?.session ?? primarySession;
      if (!session) throw new Error('Camera world is no longer retained');
      const world = cameraWorld(session);
      const trace = world ? (from, to) => {
        const hit = world.trace(from, to, PROBE);
        return hit.allSolid ? 0 : Math.max(0, Math.min(1, hit.fraction));
      } : null;
      if (trace && world.cameraMayHit) trace.mayHit = world.cameraMayHit;
      const result = await planCamera({...options, a, others, trace, yieldTask: yieldPlanner, isCurrent: () => latestPlan === token});
      if (latestPlan !== token) return;
      const transfer = result ? Object.values(result).filter(ArrayBuffer.isView).map(value => value.buffer) : [];
      send('camera-plan', message.request, {plan: result, duration: performance.now() - started}, [...new Set(transfer)]);
    } catch (error) {
      if (latestPlan === token) send('camera-error', message.request, {error: String(error?.message ?? error)});
    } finally {
      requests.delete(message.request);
      if (latestPlan === token) latestPlan = null;
    }
  }
  return {
    pause,
    attach,
    before(id, heartbeat = null) {
      const record = records.get(id);
      if (record) { record.heartbeat = heartbeat; record.lastHeartbeat = performance.now(); }
      return record?.catchingUp ? record.catchup : null;
    },
    get active() { return requests.size > 0; },
    async batch(id, position, batch = null) {
      const record = records.get(id);
      if (!record) return;
      record.position = position;
      if (batch) {
        for (const frame of batch.keyframes ?? []) record.keyframes.push(frame);
        record.markers = batch.markers ?? [];
        record.finish = batch.finish;
      }
      if (!record.capture) return;
      if (record.capture.count === record.capture.track.count && !record.done) { record.done = true; record.capture.finish(); }
      publish(record);
      if (planning && priority) await planning;
    },
    detach(id) {
      const record = records.get(id);
      if (!record) return;
      record.indexing = false;
      complete(record);
      trim();
    },
    receive(message) {
      if (message?.__surfdQolIndex !== protocol) return false;
      if (message.type === 'record-priority') {
        const record = records.get(message.id);
        const request = record?.subscribers.keys().next().value;
        if (record?.capture && request !== undefined) prioritize(record, Math.max(0, Math.floor(message.tick)), request);
        return true;
      }
      if (message.type === 'camera-align') {
        const token = {};
        requests.set(message.request, {alignToken: token});
        void (async () => {
          try {
            const result = await alignByPlace(resolveTrack(message.a), resolveTrack(message.b), {
              isCurrent: () => requests.get(message.request)?.alignToken === token,
              yieldTask: async () => { if (planning && priority) await planning; return yieldPlanner(); },
            });
            if (requests.get(message.request)?.alignToken === token)
              send('camera-alignment', message.request, {map: result}, result ? [result.buffer] : []);
          } catch (error) {
            if (requests.get(message.request)?.alignToken === token) send('camera-error', message.request, {error: String(error?.message ?? error)});
          } finally { requests.delete(message.request); }
        })();
        return true;
      }
      if (message.type === 'camera-cancel') {
        const request = requests.get(message.request);
        if (request?.record) {
          request.record.subscribers.delete(message.request);
          stopUnused(request.record);
        }
        if (request?.token === latestPlan) latestPlan = null;
        requests.delete(message.request);
        trim();
        return true;
      }
      if (message.type === 'camera-store') {
        const track = message.track;
        if (!primarySession || !Number.isSafeInteger(track?.count) || track.count < 2 || track.count > 40001 ||
            !Number.isFinite(track.dt) || track.dt <= 0 || TRACK_ARRAYS.some(key =>
              !ArrayBuffer.isView(track[key]) || track[key].length !== track.count * (key === 'position' || key === 'normal' ? 3 : 1))) {
          send('camera-forget', null, {id: message.id});
          return true;
        }
        const record = {id: message.id, session: primarySession, capture: {track, count: track.count, publishable: true},
          replay: {commands: {length: track.count - 1}}, subscribers: new Map(), indexing: false, done: true, retained: true};
        records.set(message.id, record);
        trim();
        return true;
      }
      if (message.type === 'camera-retain') {
        const record = records.get(message.id);
        if (record) record.retained = true;
        return true;
      }
      if (message.type === 'camera-release') {
        for (const [request, value] of requests) if (message.ids.includes(value.record?.id)) {
          value.record.subscribers.delete(request);
          requests.delete(request);
        }
        for (const id of message.ids) {
          const record = records.get(id);
          if (record) { record.retained = false; stopUnused(record); }
        }
        trim();
        return true;
      }
      if (message.type === 'record') {
        try {
          let record = records.get(message.id);
          if (!record) {
            if (!map || message.replay?.mapId !== map.id || message.replay.mapVersion !== map.version ||
                !Array.isArray(message.replay.commands) || !message.replay.commands.length || message.replay.commands.length > 40000) throw new Error('Replay does not match retained world');
            record = attach(createSession(map, message.replay), message.replay, message.id, false);
          }
          record.retained = true;
          record.subscribers.set(message.request, {sent: 0});
          requests.set(message.request, {record});
          ensureCapture(record);
          prioritize(record, Math.max(0, Math.floor(message.tick ?? 0)), message.request);
          publish(record);
          complete(record);
        } catch (error) {
          const record = requests.get(message.request)?.record;
          record?.subscribers.delete(message.request);
          requests.delete(message.request);
          if (record) stopUnused(record);
          send('camera-error', message.request, {error: String(error?.message ?? error)});
        }
        return true;
      }
      if (message.type === 'camera-plan') {
        if (latestPlan) { send('camera-plan', latestPlan.request, {plan: null}); requests.delete(latestPlan.request); }
        const token = latestPlan = {request: message.request};
        priority = message.options.nearby === true;
        requests.set(message.request, {token});
        const previous = planning;
        const task = (async () => { if (previous) await previous; if (latestPlan === token) await plan(message, token); })();
        planning = task;
        void task.finally(() => { if (planning === task) planning = null; });
        return true;
      }
      return false;
    },
  };
}
