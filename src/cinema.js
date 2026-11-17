// Ghosts in a replay: other runs of the map played alongside the one you're
// watching, with their lines, from a planned third-person camera. The watched
// run stays in the game's own player, so its bar, speeds, seeking and stage
// jumps work as usual; each added run follows it by the clock (Real time) or
// by place on the route (Side by side).
//
// Nothing runs until cinematic viewing is enabled (directly or by adding a
// run). The view is the game's own first person (POV) or the planned camera
// in a style (Steady or Cinematic); switching between them flies the camera
// there rather than cutting. Solo and group shots use the same camera;
// close() restores the game.
import {recordTrack, trackPoint, trackYaw} from './cinema-track.js';
import {alignByPlace, alignByTime, gapAt} from './cinema-sync.js';
import {planCamera, shotAt, adjust, viewAngles} from './cinema-camera.js';
import {createCinemaScene, runColors} from './cinema-scene.js';
import {routeFingerprint} from './replay-store.js';
import {cameraWorld, cameraTrace} from './cinema-world.js';
import {onClock} from './cinema-clock.js';
import {trackSlice} from './cinema-recording.js';

const DRAG_RADIANS = 0.005;
const ZOOM_STEP = 1.12;
// Scrolling sets the zoom to reach; the view closes on it with this time constant (ms).
const ZOOM_EASE = 100;
// The planned camera's styles; a switch of view flies there over MOVE ms.
const STYLES = ['steady', 'cinematic'];
const MOVE = 1000;
const LOOK_AHEAD = 6, LOOK_BEHIND = 6;
const VIEW_CLEARANCE = 12, VIEW_STEPS = 12, MIN_SIGHT = 0.001;
const noSafeCamera = () => Object.assign(new Error('No safe camera path is available for this view.'), {name: 'NoSafeCameraPath'});
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - (2 - 2 * t) ** 3 / 2;
const idle = () => new Promise(resolve => typeof requestIdleCallback === 'function'
  ? requestIdleCallback(resolve, {timeout: 50}) : setTimeout(resolve, 0));

export const colorOf = index => runColors(index).line;


// Replanning a tracking shot blends an offset from the moving destination,
// not a fixed world position that the surfers would leave behind.
function blend(from, to, through, velocity, duration, offset) {
  const k = velocity ? through * through * (3 - 2 * through) : ease(through);
  const tangent = velocity ? through * (1 - through) ** 2 * duration : 0;
  const origin = offset ? to : from, weight = offset ? 1 - k : k;
  const turn = offset?.yaw ?? ((to.yaw - from.yaw) % 360 + 540) % 360 - 180;
  return {x: origin.x + (offset?.x ?? to.x - from.x) * weight + (velocity?.x ?? 0) * tangent,
    y: origin.y + (offset?.y ?? to.y - from.y) * weight + (velocity?.y ?? 0) * tangent,
    z: origin.z + (offset?.z ?? to.z - from.z) * weight + (velocity?.z ?? 0) * tangent,
    yaw: origin.yaw + turn * weight + (velocity?.yaw ?? 0) * tangent,
    pitch: origin.pitch + (offset?.pitch ?? to.pitch - from.pitch) * weight + (velocity?.pitch ?? 0) * tangent,
    fov: origin.fov + (offset?.fov ?? to.fov - from.fov) * weight + (velocity?.fov ?? 0) * tangent,
    roll: (from.roll ?? 0) * (1 - k) + (to.roll ?? 0) * k};
}

// Move only an obscured eye towards its target, past each surface the game
// actually draws. Starting inside a brush and terrain backfaces remain clear.
// Bound work on pathological layered geometry, then use an almost coincident
// eye (or the target itself) so no untested obstacle remains in the sightline.
function keepVisible(view, eye, target) {
  const dx = eye.x - target.x, dy = eye.y - target.y, dz = eye.z - target.z;
  const distance = Math.hypot(dx, dy, dz);
  if (!distance) return false;
  let hit = view(eye, target);
  if (hit >= 1) return false;
  const ux = dx / distance, uy = dy / distance, uz = dz / distance;
  let room = distance;
  for (let pass = 0; pass < VIEW_STEPS; pass++) {
    const next = Math.max(Math.min(MIN_SIGHT, distance), room * (1 - hit) - VIEW_CLEARANCE);
    if (next >= room) break;
    room = next;
    eye.x = target.x + ux * room; eye.y = target.y + uy * room; eye.z = target.z + uz * room;
    hit = view(eye, target);
    if (hit >= 1) return true;
  }
  room = Math.min(room, MIN_SIGHT);
  for (let pass = 0; pass < 8; pass++, room *= 0.5) {
    eye.x = target.x + ux * room; eye.y = target.y + uy * room; eye.z = target.z + uz * room;
    if (view(eye, target) >= 1) return true;
  }
  eye.x = target.x; eye.y = target.y; eye.z = target.z;
  return true;
}

// getAdapter() is the game adapter. A run given to add() is {id, label, load()},
// load() giving its replay. record, createScene and now stand in for the game in tests.
export function createCinema({getAdapter, onChange = () => {}, loadIdle = idle, record = recordTrack, createScene = createCinemaScene, now = () => performance.now()}) {
  // The watched replay and its track, the added runs, and what's being added;
  // and the camera style last chosen, which adding a run switches to.
  let state = null, preferred = 'cinematic';
  // Cache CPU-only results by replay, map and collision-world identity.
  // Exiting still releases every ghost and GPU resource.
  const recordings = new WeakMap();
  const notify = () => { try { onChange(); } catch { /* UI only */ } };
  const playing = () => { try { return getAdapter?.()?.replay?.playback?.()?.replay ?? null; } catch { return null; } };

  // A replay can have ghosts when this build exposes the map renderer and the replay is of the loaded map.
  function available() {
    const adapter = getAdapter?.(), replay = playing(), map = adapter?.getSession?.()?.map;
    return !!adapter?.cinema?.renderer?.()?.qolScene && !!replay && !!map && replay.mapId === map.id && replay.mapVersion === map.version;
  }

  const owns = current => {
    if (state !== current || playing() !== current.replay) return false;
    const session = getAdapter().getSession();
    return !!session && session.map === current.map && (session.movement?.world ?? session.map) === current.world;
  };
  function currentState() {
    if (!available()) throw new Error('Cinematic viewing needs a replay of the loaded map.');
    const replay = playing();
    if (state && !owns(state)) close();
    if (!state) {
      state = createState(replay);
      watch(state);
    }
    return state;
  }
  // true: the camera in the remembered style; false: everything off.
  async function setEnabled(enabled) {
    if (!enabled) { close(); return false; }
    return setView(preferred);
  }
  // 'pov' keeps any added runs in the game's own view (with none, it's all
  // off); 'steady' or 'cinematic' is the planned camera, remembered for next time.
  function setView(view) { return activateView(view, true); }
  async function activateView(view, selected) {
    if (view === 'pov') {
      const current = state;
      if (current && !current.runs.length && !current.loading.length) close();
      else if (current) {
        current.selection++;
        current.cameraRequested = false;
        current.planAbort?.abort();
        current.enabling = null;
        current.planRequest = null;
        current.previewRequest = null;
        current.pending = null;
        current.resolvePreview(false);
        current.firstPreview = new Promise(resolve => { current.resolvePreview = resolve; });
        if (current.camera) { current.camera = false; retarget(current); }
        notify();
      }
      return true;
    }
    if (!STYLES.includes(view)) return false;
    preferred = view;
    const current = currentState();
    if (selected) current.selection++;
    current.cameraRequested = true;
    if (current.enabling?.view === view) return current.enabling.promise;
    if (current.previewError) {
      current.previewError = null;
      current.firstPreview = new Promise(resolve => { current.resolvePreview = resolve; });
    }
    if (current.planRequest && current.planRequest.style !== view) {
      current.planAbort?.abort();
      current.planRequest = null;
      current.pending = null;
    }
    if (!current.complete && current.track && !current.runs.length && (!current.camera || current.style !== view)) {
      current.previewRequest = null;
      current.resolvePreview(false);
      current.firstPreview = new Promise(resolve => { current.resolvePreview = resolve; });
      const tick = Math.max(0, Math.floor(getAdapter().replay.playback().index ?? 0));
      preview(current, tick);
    }
    const enabling = {view, promise: (async () => {
      try {
        const ready = prepare(current);
        if (!current.complete && current.track && current.runs.length) {
          const choice = current.pending ?? current;
          const published = await show(current, choice.sync, choice.focus, view);
          if (!published || !owns(current) || current.enabling !== enabling || !current.cameraRequested ||
              current.pending || current.style !== view || !current.plan || current.planInvalid) return false;
          if (!current.camera) { current.camera = true; retarget(current); notify(); }
          return !!current.renderer;
        }
        const first = await Promise.race([ready.then(() => 'ready'), current.firstPreview.then(shown => shown ? 'preview' : 'cancelled')]);
        if (!owns(current) || current.enabling !== enabling) return false;
        if (first === 'cancelled') {
          if (current.previewError) throw current.previewError;
          return false;
        }
        if (first === 'preview' && !current.complete) {
          ready.then(() => {
            if (owns(current) && current.cameraRequested && (current.enabling === null || current.enabling === enabling) && preferred === view && !current.pending)
              return show(current, current.sync, current.focus, view);
          }).catch(() => { if (owns(current) && !current.plan) close(); });
          return true;
        }
        if (current.previewing) await current.previewing;
        if (current.previewError) throw current.previewError;
        if (!owns(current) || current.enabling !== enabling) return false;
        const shown = current.pending ?? current;
        if (!current.renderer || !current.plan || current.planInvalid || current.style !== view || current.pending || current.warming || current.partialPlan || current.sceneTrack !== current.track) await show(current, shown.sync, shown.focus, view);
        if (current.pending || current.style !== view || !current.plan || current.planInvalid) return false;
        if (!owns(current) || current.enabling !== enabling) return false;
        if (!current.camera) { current.camera = true; retarget(current); notify(); }
        return !!current.renderer;
      } catch (error) {
        current.failed = !(error?.name === 'NoSafeCameraPath' && current.plan) && (!current.complete || current.partialPlan || !current.plan);
        if (state === current && !current.loading.length && current.failed) close();
        throw error;
      }
    })().finally(() => { if (current.enabling === enabling) current.enabling = null; })};
    current.enabling = enabling;
    return enabling.promise;
  }
  function add(run) {
    let current;
    try { current = currentState(); } catch (error) { return Promise.reject(error); }
    if (current.runs.some(item => item.id === run.id) || current.loading.some(item => item.id === run.id)) return Promise.resolve(false);
    current.cameraRequested = true;
    const used = new Set([...current.runs, ...current.loading].map(item => item.colorIndex));
    let colorIndex = 1;
    while (used.has(colorIndex)) colorIndex++;
    const pending = {id: run.id, label: run.label, colorIndex, controller: new AbortController()};
    const cancelled = new Promise(resolve => { pending.cancel = () => {
      if (!pending.adopted) {
        pending.controller.abort();
        const track = pending.track;
        pending.track = null;
        if (!pending.released && track?._cinemaWorker && track._cinemaHandle) {
          pending.released = true;
          if (state === current) track._cinemaWorker.release(track._cinemaHandle.id);
        }
      }
      resolve(false);
    }; });
    current.loading.push(pending);
    notify();
    const activation = activateView(preferred, false);
    const loading = current.queue.then(() => Promise.race([load(current, run, pending, activation), cancelled]));
    const step = Promise.race([Promise.all([loading, activation]).then(([added]) => added), cancelled]);
    current.queue = step.catch(() => {});
    return step.finally(() => {
      pending.cancel();
      if (state !== current) return;
      current.loading = current.loading.filter(item => item !== pending);
      if ((!current.renderer || current.failed) && !current.runs.length && !current.loading.length) close();
      else notify();
    });
  }
  function createState(replay) {
    // sync, focus and style are the shown camera's: Real time or Side by side,
    // null for the group shot, 'played' or a run's id for one run alone, and
    // the camera style ('cinematic' or 'steady').
    // camera is whether the planned camera shows (else first person); pose
    // is the view last drawn and move a flight from one pose to the next.
    let resolvePreview;
    const firstPreview = new Promise(resolve => { resolvePreview = resolve; });
    const session = getAdapter().getSession();
    const lifetime = new AbortController();
    return {replay, lifetime, map: session.map, world: session.movement?.world ?? session.map, base: replay.initialState?.tick ?? 0, track: null, runs: [], loading: [], queue: Promise.resolve(), ready: null, firstPreview, resolvePreview, sync: 'time', focus: null, style: preferred, plan: null, plans: {}, view: {yaw: 0, pitch: 0, zoom: 1},
      applied: {yaw: 0, pitch: 0, zoom: 1}, drawnAt: null, room: Infinity, adjusted: false, shot: {eye: {x: 0, y: 0, z: 0}, target: {x: 0, y: 0, z: 0}}, body: {x: 0, y: 0, z: 0}, at: [], tick: 0, pending: null, trace: undefined,
      camera: false, cameraRequested: false, pose: null, banked: null, roll: 0, velocity: {x: 0, y: 0, z: 0, yaw: 0, pitch: 0, fov: 0}, motionRate: 0, motionStep: 0, move: null, retired: [], sceneSize: 0,
      complete: false, partialPlan: false, planInvalid: false, planBase: 0, planEnd: Infinity, failed: false, selection: 0};
  }
  function prepare(current) {
    return current.ready ??= (async () => {
      const adapter = getAdapter(), session = adapter.getSession(), cacheWorld = session.movement?.world ?? session.map;
      let cached = recordings.get(current.replay);
      if (cached?.map.deref() !== session.map || cached?.world.deref() !== cacheWorld) cached = null;
      if (cached?.track._cinemaWorker?.live) cached.track._cinemaWorker.retain(cached.track._cinemaHandle.id, cached.track);
      // Capture ownership before a first progress callback can arrive, but a
      // completed CPU recording/plan does not need a replacement worker.
      try {
        current.worker = cached?.track._cinemaWorker?.live ? cached.track._cinemaWorker
          : cached ? null : adapter.cinema?.worker?.(session, current.replay) ?? null;
        if (!cached && !current.worker) current.workerFailed = true;
      } catch {
        current.worker = null;
        current.workerFailed = true;
      }
      const world = cameraWorld(session);
      current.trace = cameraTrace(world);
      const track = cached?.track ?? await record({adapter, session, replay: current.replay, worker: current.worker, isCurrent: () => owns(current), yieldTask: loadIdle,
        signal: current.lifetime.signal, onProgress: (track, count, range) => progress(current, track, count, range)});
      if (!owns(current)) return;
      if (!track) throw new Error('This replay can’t use cinematic viewing.');
      if (current.previewError) throw current.previewError;
      const retimed = current.track && current.track.startTick !== track.startTick;
      current.track = track;
      current.complete = true;
      if (!cached) recordings.set(current.replay, cached = {map: new WeakRef(session.map), world: new WeakRef(cacheWorld), track, plans: {}});
      current.plans = cached.plans;
      for (const run of current.runs) run.maps = {time: alignByTime(current.track, run.track)};
      if (retimed && current.runs.length) current.runs = current.runs.slice();
    })().catch(error => { current.ready = null; throw error; });
  }
  // Publish only recorded positions, growing path geometry geometrically rather
  // than rebuilding the whole prefix at every physics batch.
  function progress(current, track, count, range = null) {
    if (!owns(current) || !current.cameraRequested && !current.runs.length || count === track.count && !range) return;
    const tick = Math.max(0, Math.floor(getAdapter().replay.playback().index ?? 0));
    const ahead = Math.ceil(LOOK_AHEAD / track.dt);
    // Once a shown prefix approaches its end, use any newer real samples
    // rather than waiting for the next geometric doubling of the path.
    const nearingEnd = current.track && tick >= current.track.count - 1 - ahead / 2;
    if (count <= Math.min(track.count - 1, tick + ahead) && (!nearingEnd || count <= tick + 1)) return;
    const regional = current.track?._recordedFrom > 0;
    const retimed = current.track && current.track.startTick !== track.startTick;
    if (retimed || range || !current.track || regional && (count >= current.track.count || tick < current.track._recordedFrom) ||
        !regional && (count >= current.track.count * 2 || nearingEnd && !current.pending && count > current.track.count)) {
      current.track = {...track, count, _recordedFrom: range?.from ?? 0, finish: Math.min(track.finish, count - 1), splits: track.splits.slice()};
      for (const run of current.runs) run.maps = {time: alignByTime(current.track, run.track)};
      if (retimed && current.runs.length) current.runs = current.runs.slice();
      // The initial scene already covers the requested planning window.
      // Growing its future prefix while its shaders compile only recreates
      // ghosts, paths and compile waits; publish the latest geometry afterwards.
      if (current.renderer && (!current.warming || retimed || range) &&
          (current.sceneRunSet === current.runs || !current.plan)) rebuild(current);
      current.plans = {};
    }
    if (retimed || range && tick >= range.from && tick < range.end) {
      const interrupted = current.pending;
      current.previewRequest = null;
      current.planAbort?.abort();
      current.previewing = null;
      if (interrupted) {
        current.planRequest = current.pending = null;
        if (current.cameraRequested)
          void show(current, interrupted.sync, interrupted.focus, interrupted.style, true)
            .catch(error => { if (owns(current)) current.planError = error; });
      }
    }
    if (!current.cameraRequested) return;
    const renewal = current.plan && current.partialPlan && current.track &&
      (tick < current.planBase || tick > current.planEnd - ahead / 2 &&
        current.planEnd < recordedEnd(current.track, current.runs, current.sync) - 1);
    if (!current.previewing && !current.pending && (retimed || !current.plan || renewal)) {
      if (current.runs.length || current.camera && current.plan && !retimed)
        void show(current, current.sync, current.focus, current.style, !!renewal).catch(error => { if (owns(current)) current.planError = error; });
      else preview(current, tick);
    }
  }
  // End-exclusive clock coverage shared by every unfinished time-aligned run.
  function recordedEnd(track, runs, sync) {
    let end = track.count;
    if (sync === 'time') for (const run of runs) if (run.complete === false) {
      const other = run.track, start = track.startTick ?? track.start, otherStart = other.startTick ?? other.start;
      end = Math.min(end, Math.floor(start + (other.count - 1 - otherStart) * (other.dt / track.dt)) + 1);
    }
    return end;
  }
  function trackWindow(track, tick, runs = [], sync = 'time') {
    let from = Math.max(track._recordedFrom ?? 0, Math.floor((tick - Math.ceil(LOOK_BEHIND / track.dt)) / 4) * 4);
    const end = Math.min(recordedEnd(track, runs, sync), tick + Math.ceil(LOOK_AHEAD / track.dt) + 1);
    // Time maps clamp to the last sample. That is correct for a finished run,
    // but an unfinished run has no positions outside its recorded range.
    if (sync === 'time') for (const run of runs) if (run.complete === false && (run.track._recordedFrom ?? 0) > 0) {
      const other = run.track, start = track.startTick ?? track.start, otherStart = other.startTick ?? other.start;
      from = Math.max(from, Math.ceil(start + (other._recordedFrom - otherStart) * (other.dt / track.dt)));
    }
    const count = end - from;
    if (count < 2) return null;
    const window = {...track, count,
      start: Math.max(0, Math.min(count - 1, track.start - from)), startTick: track.startTick === null ? null : track.startTick - from,
      finish: Math.max(0, Math.min(count - 1, track.finish - from)), splits: track.splits.filter(at => at >= from && at < end).map(at => at - from),
      position: track.position.subarray(from * 3, end * 3), normal: track.normal.subarray(from * 3, end * 3),
      yaw: track.yaw.subarray(from, end), cut: track.cut.subarray(from, end), ducked: track.ducked.subarray(from, end),
      elapsed: track.elapsed.subarray(from, end), phase: track.phase?.subarray(from, end)};
    if (track._cinemaHandle) window._cinemaHandle = {id: track._cinemaHandle.id, from: track._cinemaHandle.from + from};
    return {window, from, end};
  }
  function preview(current, tick) {
    const track = current.track, style = preferred;
    const slice = trackWindow(track, tick);
    if (!slice) return;
    const {window, from, end} = slice;
    const request = current.previewRequest = {};
    current.previewError = null;
    current.planAbort?.abort();
    current.planAbort = new AbortController();
    const owned = () => owns(current) && current.previewRequest === request && current.cameraRequested && !current.pending && preferred === style;
    const preparing = (async () => {
      if (!current.renderer) start(current);
      const plan = await cameraPlan(current, {a: window, style}, owned, true);
      if (!owned()) return;
      if (!plan) throw noSafeCamera();
      while (owned() && current.warming) await current.warming;
      if (!owned()) return;
      const at = getAdapter().replay.playback().index ?? 0;
      if (at < from || at >= end) return;
      Object.assign(current, {plan, planRuns: current.runs, style, planBase: from, planEnd: end - 1, partialPlan: true, planInvalid: false, camera: true, planError: null, failedWindow: null});
      retarget(current);
      current.resolvePreview(true);
      notify();
    })().catch(error => {
      if (owned()) {
        current.previewError = current.planError = error;
        if (error?.name === 'NoSafeCameraPath' && !current.camera) current.cameraRequested = false;
        current.resolvePreview(false);
        notify();
      }
    })
      .finally(() => { if (current.previewing === preparing) current.previewing = null; });
    current.previewing = preparing;
  }
  async function load(current, run, pending, activation) {
    let entry = null;
    const owned = () => owns(current) && (current.loading.includes(pending) || entry && current.runs.includes(entry));
    if (!owned()) return false;
    const replay = await run.load();
    if (!owned()) return false;
    if (!replay) throw new Error('That run’s replay isn’t available.');
    if (replay.mapId !== current.replay.mapId || replay.mapVersion !== current.replay.mapVersion)
      throw new Error('That replay is for a different course or map revision.');
    current.fingerprint ??= routeFingerprint(current.replay);
    const fingerprint = routeFingerprint(replay);
    if (replay === current.replay || replay.commands?.length === current.replay.commands.length && fingerprint === current.fingerprint)
      throw new Error('That’s the run you’re watching.');
    if (current.runs.some(entry => entry.fingerprint === fingerprint)) throw new Error('That run is already added.');
    const prepared = prepare(current), adapter = getAdapter(), session = adapter.getSession();
    let latest = null, joining = null, resolveJoined, rejectJoined, committed = false;
    let savedRuns, savedPlans, stagedRuns;
    const joined = new Promise((resolve, reject) => { resolveJoined = resolve; rejectJoined = reject; });
    const stage = next => {
      savedRuns = current.runs; savedPlans = current.plans;
      entry = next;
      pending.adopted = true; pending.track = null;
      current.runs = stagedRuns = [...savedRuns, entry];
      current.plans = {};
    };
    const rollback = () => {
      if (committed || !entry) return;
      const rejected = entry;
      entry = null;
      pending.adopted = false;
      pending.track = rejected.track;
      if (!owns(current)) return;
      if (!current.runs.includes(rejected)) {
        // remove() already released this entry while its plan was pending.
        pending.released = true;
        pending.track = null;
        return;
      }
      if (current.runs === stagedRuns) {
        current.runs = savedRuns; current.plans = savedPlans;
      } else {
        current.runs = current.runs.filter(item => item !== rejected);
        current.plans = {};
      }
      if (current.renderer && current.sceneRunSet !== savedRuns &&
          (current.sceneRunSet !== current.runs || current.sceneTrack !== current.track)) rebuild(current);
      notify();
    };
    const showEntry = async () => {
      while (owned() && entry && current.runs.includes(entry) && current.cameraRequested) {
        const choice = current.pending;
        const planning = show(current, choice?.sync ?? current.sync, choice ? choice.focus : current.focus,
          current.camera ? choice?.style ?? current.style : preferred);
        const issued = current.planRequest;
        if (await planning) return true;
        if (!owned() || !current.cameraRequested || !current.runs.includes(entry)) return false;
        if (current.planRequest === issued) return false;
      }
      return false;
    };
    const joinReady = () => {
      if (!latest || latest.done || !current.track || !current.camera || !owned() || (current.pending?.sync ?? current.sync) !== 'time') return null;
      const tick = Math.max(0, Math.floor(adapter.replay.playback().index ?? 0));
      const through = Math.min(current.replay.commands.length, tick + Math.ceil(LOOK_AHEAD / current.track.dt));
      if (current.track.count <= through) return null;
      const other = latest.track, mapped = (other.startTick ?? other.start) +
        (through - (current.track.startTick ?? current.track.start)) * current.track.dt / other.dt;
      if (mapped >= latest.count - 1) return null;
      const track = {...other, count: latest.count, finish: Math.min(other.finish, latest.count - 1), splits: other.splits.slice()};
      return track;
    };
    const publish = () => {
      if (joining || entry || !joinReady()) return;
      joining = (async () => {
        await loadIdle();
        if (!owned()) return;
        const ready = joinReady();
        if (!ready) { joining = null; return; }
        stage({id: run.id, label: run.label, colorIndex: pending.colorIndex, fingerprint,
          controller: pending.controller, recorded: recording, track: ready, maps: {time: alignByTime(current.track, ready)}, time: ready.time, complete: false});
        const shown = await showEntry();
        if (!owned()) { resolveJoined(false); return; }
        if (!shown && current.cameraRequested) {
          // Playback overtook this prefix while it was planned. Leave the
          // existing scene in place and retry when more positions arrive.
          rollback(); joining = null; return;
        }
        if (!current.cameraRequested && current.renderer && current.sceneRunSet !== current.runs) rebuild(current);
        if (current.cameraRequested && !current.camera) { current.camera = true; retarget(current); notify(); }
        committed = true;
        resolveJoined(true);
      })().catch(error => {
        try { rollback(); } catch (cleanup) { error = cleanup; }
        rejectJoined(error);
        throw error;
      });
      void joining.catch(error => { if (owned()) current.planError = error; });
    };
    void activation.then(publish).catch(() => {});
    // A worker that died during recording must not start another watchdog.
    let worker = current.workerFailed ? null : current.worker;
    if (worker && !worker.live) { current.workerFailed = true; worker = null; }
    if (!current.workerFailed && !worker) {
      try {
        // The worker's primary collision world must use the watched replay's format.
        worker = current.worker = adapter.cinema?.worker?.(session, current.replay) ?? null;
        if (!worker) current.workerFailed = true;
      } catch {
        worker = null;
        current.workerFailed = true;
      }
    }
    if (!owned()) return false;
    const recording = record({adapter, session, replay, worker, isCurrent: owned, yieldTask: loadIdle,
      signal: AbortSignal.any([current.lifetime.signal, pending.controller.signal]),
      onProgress: (track, count) => {
        latest = {track, count, done: count === track.count};
        const tick = Math.max(0, Math.floor(adapter.replay.playback().index ?? 0));
        const old = entry?.track;
        const mappedAhead = old && (old.startTick ?? old.start) +
          (tick + Math.ceil(LOOK_AHEAD / current.track.dt) - (current.track.startTick ?? current.track.start)) * current.track.dt / old.dt;
        if (entry && committed && !current.pending && (old.startTick !== track.startTick || count >= old.count * 2 ||
            count > old.count && mappedAhead >= old.count - 1)) {
          entry.track = {...track, count, finish: Math.min(track.finish, count - 1), splits: track.splits.slice()};
          entry.maps = {time: alignByTime(current.track, entry.track)};
          current.runs = current.runs.slice();
          current.plans = {};
          if (current.renderer && !current.cameraRequested) rebuild(current);
          if (current.cameraRequested && !current.pending) void show(current, current.sync, current.focus).catch(error => { if (owned()) current.planError = error; });
        }
        publish();
      }});
    const completed = (async () => {
      const track = await recording;
      if (!pending.adopted) pending.track = track;
      if (!owned()) { pending.cancel(); return false; }
      if (!track) throw new Error('That run couldn’t be read on this map.');
      latest = {track, count: track.count, done: true};
      await prepared;
      await activation;
      if (!owned()) return false;
      if (joining) await joining;
      if (!entry) {
        const place = track._cinemaWorker?.live ? null : await alignByPlace(current.track, track, {yieldTask: loadIdle, isCurrent: owned});
        if (!owned()) return false;
        await loadIdle();
        if (!owned()) return false;
        stage({id: run.id, label: run.label, colorIndex: pending.colorIndex, fingerprint, track, complete: true,
          controller: pending.controller, maps: {time: alignByTime(current.track, track), ...(place ? {place} : {})}, time: track.time});
      } else {
        entry.track = track; entry.time = track.time; entry.complete = true;
        entry.maps = {time: alignByTime(current.track, track)};
        current.runs = current.runs.slice();
      }
      current.plans = {};
      if (!current.cameraRequested) {
        if (!current.renderer) start(current);
        else rebuild(current);
      }
      const shown = await showEntry();
      if (!owned()) return false;
      if (!shown && current.cameraRequested) throw new Error('The recorded camera window is no longer available.');
      if (!current.cameraRequested && current.renderer && current.sceneRunSet !== current.runs) rebuild(current);
      if (current.cameraRequested && !current.camera) { current.camera = true; retarget(current); notify(); }
      committed = true;
      void placeFor(current, entry).catch(error => { if (owned()) { current.planError = error; notify(); } });
      return true;
    })().catch(error => {
      try { rollback(); } catch (cleanup) { error = cleanup; }
      throw error;
    });
    void completed.catch(error => { if (owned()) { current.planError = error; notify(); } });
    return Promise.race([joined, completed]);
  }
  const planKey = (sync, focus, style) => `${sync}|${focus ?? ''}|${style}`;
  async function cameraPlan(current, options, owned, nearby = false) {
    const signal = current.planAbort?.signal;
    if (!owned() || signal?.aborted) return null;
    if (!current.workerFailed) {
      try {
        const retained = current.track?._cinemaWorker;
        // Keep a dead owned worker here: falling through starts another one.
        let worker = retained?.live ? retained : current.worker;
        if (!worker) {
          const adapter = getAdapter();
          worker = adapter.cinema?.worker?.(adapter.getSession(), current.replay) ?? null;
        }
        current.worker = worker;
        if (!owned() || signal?.aborted) return null;
        if (worker?.live) {
          const plan = await worker.plan({...options, nearby}, signal, retained === worker ? current.track._cinemaHandle.id : undefined);
          if (!owned() || signal?.aborted) return null;
          // An active worker can complete without a safe plan; retrying that
          // geometry on the main thread would only block and return the same.
          if (plan || worker.live) return plan;
        }
        current.workerFailed = true;
      } catch {
        if (!owned() || signal?.aborted) return null;
        current.workerFailed = true;
      }
    }
    if (!owned() || signal?.aborted) return null;
    if (Number.isInteger(options.focusIndex)) {
      const clock = options.a, chosen = options.others[options.focusIndex];
      options = {...options, a: onClock(chosen.track, chosen.map, clock),
        others: [{track: clock, map: Float32Array.from({length: clock.count}, (_, tick) => tick)},
          ...options.others.filter((_, index) => index !== options.focusIndex)]};
    }
    return planCamera({...options, trace: current.trace, yieldTask: loadIdle, isCurrent: () => !signal?.aborted && owned()});
  }
  function placeFor(current, run) {
    if (run.maps.place) return Promise.resolve(run.maps.place);
    const maps = run.maps, a = current.track, b = run.track;
    if (run.placing?.maps === maps) return run.placing.promise;
    run.placing?.controller.abort();
    const job = run.placing = {maps, controller: new AbortController()};
    const owned = () => owns(current) && current.runs.includes(run) && run.maps === maps && current.track === a && run.track === b;
    job.promise = (async () => {
      const worker = a._cinemaWorker;
      let map;
      if (worker?.live) {
        try { map = await worker.align(a, b, AbortSignal.any([current.lifetime.signal, run.controller.signal, job.controller.signal])); }
        catch { if (!owned()) return null; }
      }
      if (!map && owned()) map = await alignByPlace(a, b, {yieldTask: loadIdle, isCurrent: owned});
      if (!owned() || !map) return null;
      maps.place = map;
      notify();
      return map;
    })().finally(() => { if (run.placing === job) run.placing = null; });
    return job.promise;
  }
  async function preparePlanRuns(current, runs, sync, owned) {
    for (const run of runs) {
      if (!run.maps[sync]) {
        if (sync === 'place' && (!current.complete || run.complete === false)) {
          await current.ready;
          const track = await run.recorded;
          if (track) { run.track = track; run.complete = true; run.time = track.time; }
          if (!owned()) return false;
        }
        const map = sync === 'place' ? await placeFor(current, run) : alignByTime(current.track, run.track);
        if (!owned() || !map) return false;
        run.maps[sync] = map;
      }
    }
    return true;
  }
  async function planFor(current, track, runs, sync, focus, style, owned, slice = null) {
    const options = {style};
    const clock = slice?.window ?? track;
    const mapped = runs.map(run => ({track: run.track, map: slice ? run.maps[sync].subarray(slice.from, slice.end) : run.maps[sync]}));
    const chosen = runs.findIndex(run => run.id === focus);
    if (chosen < 0) return cameraPlan(current, {a: clock, others: mapped, group: focus !== 'played', ...options}, owned, !!slice);
    if (track._cinemaWorker?.live && !current.workerFailed)
      return cameraPlan(current, {a: clock, others: mapped, focusIndex: chosen, group: false, ...options}, owned, !!slice);
    // An added run is planned on the watched run's clock, so the plan's ticks stay the replay's.
    const identity = slice ? Float32Array.from({length: clock.count}, (_, tick) => tick) :
      (current.identity ??= Float32Array.from({length: clock.count}, (_, tick) => tick));
    return cameraPlan(current, {a: onClock(runs[chosen].track, mapped[chosen].map, clock), group: false, ...options,
      others: [{track: clock, map: identity}, ...mapped.filter((_, index) => index !== chosen)]}, owned, !!slice);
  }
  function remove(id) {
    const current = state;
    if (!current) return;
    const before = current.loading.length;
    for (const pending of current.loading) if (pending.id === id) pending.cancel();
    current.loading = current.loading.filter(run => run.id !== id);
    if (!current.runs.some(run => run.id === id)) {
      if (!current.renderer && !current.runs.length && !current.loading.length) { close(); return; }
      if (current.loading.length !== before) notify();
      return;
    }
    const removed = current.runs.find(run => run.id === id);
    const request = current.pending;
    const focus = request ? request.focus : current.focus;
    if (current.focus === id) {
      // Keep the outgoing shot during its normal reframe, but it can no
      // longer be reused as a destination if the replacement is cancelled.
      current.focus = null;
      current.planInvalid = !!current.plan;
    }
    removed?.controller?.abort();
    if (removed?.track._cinemaHandle) removed.track._cinemaWorker?.release(removed.track._cinemaHandle.id);
    current.runs = current.runs.filter(run => run.id !== id);
    current.plans = {};
    // First person with no runs left is everything off; a camera stays.
    if (!current.camera && !current.runs.length && !current.loading.length) { close(); return; }
    const visible = current.sceneRunSet.filter(run => run.id !== id);
    rebuild(current, visible, current.sceneTrack, current.sceneRuns.filter(run => run.id !== id));
    return show(current, request?.sync ?? current.sync, focus === id ? null : focus).catch(error => {
      if (error?.name === 'NoSafeCameraPath' && owns(current)) {
        // The old shot may follow the run just released. It is no longer a
        // valid fallback, so keep the remaining ghosts in the actual POV.
        current.camera = current.cameraRequested = false;
        current.plan = current.planRuns = current.move = current.pose = null;
        current.focus = null;
        current.partialPlan = current.planInvalid = false;
        current.failedWindow = null;
        level(current);
        notify();
        throw error;
      }
      if (owns(current)) close();
    });
  }
  // A unique request token prevents an older plan (even for the same choices)
  // from replacing a newer selection after an idle-time yield.
  async function show(current, sync, focus, style = current.pending?.style ?? current.style, forceNearby = false, runs = current.runs) {
    if (!current.cameraRequested) return false;
    const selection = current.selection;
    if (!forceNearby && current.renewing) {
      await current.renewing.promise;
      if (!owns(current) || !current.cameraRequested || current.selection !== selection ||
          runs.some(run => !current.runs.includes(run))) return false;
    }
    const pending = current.pending;
    if (!forceNearby && pending?.sync === sync && pending.focus === focus && pending.style === style &&
        pending.runs.length === runs.length && pending.runs.every((run, index) => run === runs[index])) {
      await pending.done;
      if (!owns(current) || !current.cameraRequested || current.selection !== selection ||
          runs.some(run => !current.runs.includes(run))) return false;
      const tick = getAdapter().replay.playback().index ?? 0;
      if (!current.pending && current.plan && !current.planInvalid && current.sync === sync && current.focus === focus && current.style === style &&
          (!current.partialPlan || tick >= current.planBase && tick <= current.planEnd) &&
          current.sceneRunSet.length === runs.length && current.sceneRunSet.every((run, index) => run === runs[index]) &&
          tick >= (current.sceneTrack._recordedFrom ?? 0) && tick < recordedEnd(current.sceneTrack, current.sceneRuns, sync)) return true;
      if (current.planError) throw current.planError;
      const latest = current.pending ?? current.planRequest;
      if (latest && (latest.sync !== sync || latest.focus !== focus || latest.style !== style)) return false;
      return show(current, sync, focus, style, forceNearby);
    }
    const cameraRequested = current.cameraRequested;
    const key = planKey(sync, focus, style), visibleOnly = runs !== current.runs;
    const at = getAdapter().replay.playback().index ?? 0;
    if (!forceNearby && current.fullPlanning?.request === current.planRequest && current.planRequest?.sync === sync &&
        current.planRequest.focus === focus && current.planRequest.style === style && runs === current.planRequest.runs &&
        current.plan && !current.planInvalid && (!current.partialPlan || at >= current.planBase && at <= current.planEnd) &&
        at >= (current.sceneTrack?._recordedFrom ?? 0) && at < recordedEnd(current.sceneTrack, current.sceneRuns, current.sync)) return true;
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const request = current.planRequest = {sync, focus, style, runs, done};
    current.planAbort?.abort();
    current.planAbort = new AbortController();
    current.pending = request;
    current.planError = null;
    current.previewRequest = null;
    const retained = () => current.runs === runs || (visibleOnly
      ? current.sceneRunSet === runs && runs.every(run => current.runs.includes(run))
      : current.runs.length === runs.length && runs.every((run, index) => current.runs[index] === run));
    const intentOwned = () => owns(current) && current.cameraRequested === cameraRequested && current.planRequest === request && retained();
    let track = null, plannedRuns = null, complete = false;
    const sameClock = () => !track || (current.track.startTick ?? current.track.start) === (track.startTick ?? track.start) &&
      current.track.dt === track.dt && runs.every((run, index) =>
        (run.track.startTick ?? run.track.start) === (plannedRuns[index].track.startTick ?? plannedRuns[index].track.start));
    const owned = () => intentOwned() && sameClock();
    notify();
    try {
      if (!current.renderer) start(current);
      if (!await preparePlanRuns(current, runs, sync, intentOwned) || !intentOwned()) return false;
      track = current.track;
      complete = current.complete;
      plannedRuns = runs.map(run => ({...run}));
      const publish = async (plan, slice) => {
        while (owned() && current.warming) await current.warming;
        if (!owned()) return false;
        if (slice) {
          const tick = getAdapter().replay.playback().index ?? 0;
          if (tick < slice.from || tick >= slice.end) return false;
        }
        const published = visibleOnly ? runs : current.runs;
        if (current.sceneRunSet !== published || current.sceneTrack !== track ||
            current.sceneRuns.some((shown, index) => shown.track !== plannedRuns[index].track ||
              shown.maps !== plannedRuns[index].maps || shown.complete !== plannedRuns[index].complete))
          rebuild(current, published, track, plannedRuns);
        const changed = current.plan !== plan;
        const promoted = !current.planInvalid && !slice && current.partialPlan && current.camera && current.sync === sync && current.focus === focus && current.style === style;
        Object.assign(current, {sync, focus, style, plan, planRuns: published, partialPlan: !!slice, planInvalid: false, failedWindow: null,
          planBase: slice?.from ?? 0, planEnd: slice ? slice.end - 1 : track.count - 1});
        request.runs = published;
        if (current.pending === request) current.pending = null;
        if (changed && current.camera) retarget(current, promoted);
        notify();
        return true;
      };
      const cached = !visibleOnly && current.plans[key];
      if (cached) return await publish(cached, null);
      let bounded = false, published = false;
      for (let attempt = 0; attempt < 2 && owned(); attempt++) {
        const tick = Math.max(0, Math.min(track.count - 1, Math.floor(getAdapter().replay.playback().index ?? 0)));
        const center = forceNearby ? Math.min(track.count - 1, tick + Math.ceil(LOOK_AHEAD / track.dt / 2)) : tick;
        let slice = trackWindow(track, center, plannedRuns, sync);
        if (!slice || tick < slice.from || tick >= slice.end) slice = trackWindow(track, tick, plannedRuns, sync);
        if (!slice || tick < slice.from || tick >= slice.end) break;
        bounded = visibleOnly || !complete || plannedRuns.some(run => run.complete === false) || slice.from > 0 || slice.end < track.count;
        if (!bounded) break;
        const shown = current.sceneTrack;
        const compatiblePrefix = shown === track || shown && shown.count <= track.count && shown.position === track.position &&
          shown.normal === track.normal && shown.cut === track.cut && shown.dt === track.dt &&
          (shown.startTick ?? shown.start) === (track.startTick ?? track.start);
        const matching = !forceNearby && !current.planInvalid && current.partialPlan && current.planRuns === runs &&
          current.sync === sync && current.focus === focus && current.style === style && current.sceneRunSet === runs && compatiblePrefix &&
          current.sceneRuns.every((run, index) => run.track === plannedRuns[index].track && run.maps === plannedRuns[index].maps &&
            run.complete === plannedRuns[index].complete) && tick >= current.planBase && tick <= current.planEnd;
        if (matching) {
          if (current.pending === request) current.pending = null;
          published = true;
        } else {
          const nearby = await planFor(current, track, plannedRuns, sync, focus, style, owned, slice);
          if (!owned()) return false;
          if (!nearby) {
            current.failedWindow = {from: slice.from, end: slice.end, track, runs, sync, focus, style};
            throw noSafeCamera();
          }
          published = await publish(nearby, slice);
        }
        if (published) break;
      }
      if (!owned()) return false;
      if (visibleOnly || !complete || plannedRuns.some(run => run.complete === false)) {
        if (current.pending === request) current.pending = null;
        return published;
      }
      const full = async () => {
        const plan = await planFor(current, track, plannedRuns, sync, focus, style, owned);
        if (!owned()) return false;
        if (!plan) throw noSafeCamera();
        current.plans[key] = plan;
        if (!runs.length) recordings.get(current.replay).plans = current.plans;
        return publish(plan, null);
      };
      if (bounded && published) {
        const job = {request};
        current.fullPlanning = job;
        job.promise = full().catch(error => {
          if (!owned()) return;
          if (!current.plan) { close(); return; }
          if (current.pending === request) current.pending = null;
          current.planError = error;
          notify();
        }).finally(() => { if (current.fullPlanning === job) current.fullPlanning = null; });
        return true;
      }
      return await full();
    } catch (error) {
      if (owned()) {
        current.pending = null;
        current.planError = error;
        if (error?.name === 'NoSafeCameraPath' && !current.camera) current.cameraRequested = false;
        notify();
      }
      if (owns(current) && !current.plan) close();
      throw error;
    } finally {
      if (current.pending === request) current.pending = null;
      try {
        const renewal = request.renewal;
        if (renewal) await renewal.promise;
        const resumed = renewal && current.planRequest === renewal.request;
        if (owns(current) && current.cameraRequested === cameraRequested && retained() &&
            (resumed || !visibleOnly && intentOwned() && !sameClock()))
          return await show(current, sync, focus, style, forceNearby, visibleOnly ? current.sceneRunSet : current.runs);
      } finally { resolveDone(); }
    }
  }
  // A staged addition must yield the worker to a deadline on the view that
  // is actually on screen. Its caller resumes the same choice afterwards.
  function renewVisible(current) {
    const job = {request: null, promise: null};
    if (current.pending) current.pending.renewal = job;
    current.renewing = job;
    const planning = show(current, current.sync, current.focus, current.style, true, current.sceneRunSet);
    job.request = current.planRequest;
    job.promise = planning.catch(() => false).finally(() => {
      if (current.renewing === job) current.renewing = null;
    });
  }

  // Monitor ownership from activation, including before recording has produced
  // a preview. Losing playback must abort preparation as well as a shown view.
  function watch(current) {
    const check = () => {
      if (state !== current) return;
      const adapter = getAdapter?.();
      if (!owns(current)) { close(); return; }
      // The game makes a new renderer when it reloads the map, as Watch from the menu can.
      const renderer = adapter.cinema?.renderer?.();
      if (current.renderer && renderer !== current.renderer) {
        const published = current.plan && {track: current.sceneTrack, runs: current.sceneRunSet, entries: current.sceneRuns};
        detach(current);
        if (!renderer?.qolScene) { close(); return; }
        try { attach(current, renderer, published); } catch { close(); return; }
      }
      current.checking = requestAnimationFrame(check);
    };
    current.checking = requestAnimationFrame(check);
  }
  function start(current) {
    attach(current, getAdapter().cinema.renderer());
    listen(current);
  }
  function sceneFor(current, renderer, runs = current.runs, track = current.track, entries = null) {
    current.sceneSize = runs.length + 1;
    current.sceneTrack = track;
    current.sceneRunSet = runs;
    // Keep the shown scene's tracks and maps stable while a replacement plans.
    current.sceneRuns = entries ?? runs.map(run => ({...run}));
    current.sceneBase = track._recordedFrom ?? 0;
    const played = current.sceneBase ? trackSlice(track, current.sceneBase, track.count) : track;
    const scene = createScene(renderer, [{track: played, colorIndex: 0}, ...current.sceneRuns.map(run => ({track: run.track, colorIndex: run.colorIndex}))]);
    // Preparation may finish before the first plan. Nothing is visible until
    // frame() has a valid shot and has positioned each ghost and path.
    for (let index = 0; index < current.sceneSize; index++) scene.show?.(index, false);
    return scene;
  }
  function attach(current, renderer, published = null) {
    current.scene = published
      ? sceneFor(current, renderer, published.runs, published.track, published.entries)
      : sceneFor(current, renderer);
    current.renderer = renderer;
    warm(current);
    const original = current.original = renderer.render;
    renderer.render = current.wrapper = function (view) {
      try {
        if (current.warming) { level(current); return original.call(this, view); }
        const drawn = original.call(this, frame(current, view) ?? view);
        // A replaced scene goes once its successor has drawn (see rebuild).
        for (const scene of current.retired.splice(0)) { try { scene.dispose(); } catch { /* already gone */ } }
        return drawn;
      } catch (error) { queueMicrotask(() => { if (state === current) close(); }); throw error; }
    };
  }
  function warm(current) {
    current.cancelWarm?.();
    const pending = current.scene.prepare?.();
    let cancel;
    const cancelled = pending ? new Promise(resolve => { cancel = () => resolve(false); }) : null;
    const warming = pending ? Promise.race([Promise.resolve(pending).then(() => true), cancelled]).then(ready => {
      if (!ready || current.warming !== warming || !owns(current)) return;
      current.warming = current.cancelWarm = null;
      // Reuse the shaders just prepared, and catch up once to the latest
      // recorded prefix before a preview or frame can expose its geometry.
      if (current.sceneTrack !== current.track && (current.sceneRunSet === current.runs || !current.plan)) rebuild(current);
    }).finally(() => {
      if (current.warming === warming) current.warming = current.cancelWarm = null;
    }) : null;
    current.warming = warming;
    current.cancelWarm = cancel;
  }
  function detach(current) {
    current.cancelWarm?.();
    level(current);
    if (current.renderer && current.renderer.render === current.wrapper) current.renderer.render = current.original;
    for (const scene of [current.scene, ...current.retired.splice(0)]) { try { scene?.dispose(); } catch { /* the map was unloaded with it */ } }
    current.renderer = current.scene = current.warming = current.cancelWarm = null;
  }
  // The scene holds one ghost per run, so a change of runs builds it again.
  // The new one comes first and the old one stays, hidden, until the new one
  // has drawn: disposing it first would free the shared shader programs and
  // the new scene would compile them all again, a stall of a second or more.
  function rebuild(current, runs = current.runs, track = current.track, entries = null) {
    const old = current.scene, size = current.sceneSize;
    try { current.scene = sceneFor(current, current.renderer, runs, track, entries); } catch (error) { if (state === current) close(); throw error; }
    for (let index = 0; index < size; index++) old?.show?.(index, false);
    if (current.warming) warm(current);
    if (old) current.retired.push(old);
  }
  function retarget(current, promoted = false) {
    if (!current.pose) return;
    const time = now(), previous = current.move;
    const initialFlight = current.camera && previous?.from.eye && time < previous.start + previous.duration;
    const continuing = promoted && initialFlight;
    const following = current.camera && !current.pose.eye && !previous?.from.eye && current.drawnAt !== null;
    const start = following ? current.drawnAt : time;
    const duration = continuing ? Math.max(MOVE * 0.25, previous.start + previous.duration - start) : MOVE;
    const velocity = initialFlight || following ? {...current.velocity} : null;
    let offset = null;
    if (following) {
      const tick = current.tick - current.planBase, step = current.motionStep || 16;
      // Sample without advancing zoom or collision clearance. Relative velocity
      // preserves an interrupted flight as well as ordinary replay tracking.
      const target = aim(current, current.plan, tick, 0, false);
      const before = aim(current, current.plan, tick - current.motionRate * step, 0, false);
      const from = current.pose;
      offset = {x: from.x - target.x, y: from.y - target.y, z: from.z - target.z,
        yaw: ((from.yaw - target.yaw) % 360 + 540) % 360 - 180,
        pitch: from.pitch - target.pitch, fov: from.fov - target.fov};
      velocity.x -= (target.x - before.x) / step;
      velocity.y -= (target.y - before.y) / step;
      velocity.z -= (target.z - before.z) / step;
      velocity.yaw -= (((target.yaw - before.yaw) % 360 + 540) % 360 - 180) / step;
      velocity.pitch -= (target.pitch - before.pitch) / step;
      velocity.fov -= (target.fov - before.fov) / step;
    }
    current.move = {from: {...current.pose}, start, duration, offset,
      began: continuing ? previous.began : start, revealEnd: continuing ? previous.revealEnd : start + duration, velocity};
    if (continuing) current.move.from.eye = true;
  }

  // The played run's fractional index from the frame's state and interpolation.
  function frame(current, view) {
    if (playing() !== current.replay) { level(current); queueMicrotask(() => { if (state === current) close(); }); return null; }
    const a = current.sceneTrack, runs = current.sceneRuns, plan = current.plan, sync = current.sync;
    if (!a || !plan && current.camera) { level(current); return null; }
    const eye = view.eyePosition ?? {x: 0, y: 0, z: 0};
    const own = {x: eye.x, y: eye.y, z: eye.z, yaw: view.yaw ?? 0, pitch: view.pitch ?? 0, fov: view.fov ?? 90, eye: true};
    const stateTick = view.state?.tick ?? current.base, previousTick = getAdapter()?.getSession?.()?.previous?.tick;
    // Seeking sets native previous=current but retains its interpolation alpha.
    // Interpolate the actual state pair, not an assumed preceding tick.
    const from = Number.isFinite(previousTick) && previousTick <= stateTick ? previousTick : stateTick - 1;
    const alpha = Number.isFinite(view.qolAlpha) ? Math.max(0, Math.min(1, view.qolAlpha)) : 1;
    const at = from - current.base + (stateTick - from) * alpha;
    let missing = at < (a._recordedFrom ?? 0) || at > a.count - 1;
    if (!missing) for (const run of runs) {
      if (run.complete) continue;
      const mapped = sync === 'place' && run.maps.place
        ? run.maps.place[Math.ceil(at)]
        : (run.track.startTick ?? run.track.start) + (at - (a.startTick ?? a.start)) * a.dt / run.track.dt;
      if (!Number.isFinite(mapped) || mapped > run.track.count - 1 || mapped >= 0 && mapped < (run.track._recordedFrom ?? 0)) {
        missing = true;
        break;
      }
    }
    // An out-of-window seek must never clamp the view to stale geometry.
    if (missing || current.camera && current.partialPlan && (at < current.planBase || at > current.planEnd)) {
      level(current);
      current.previewRequest = null;
      const worker = current.track?._cinemaWorker;
      const wanted = Math.max(0, Math.floor(at));
      const failed = current.failedWindow;
      const failedHere = failed && failed.track === current.track && failed.runs === current.runs && failed.sync === current.sync &&
        failed.focus === current.focus && failed.style === current.style && at >= failed.from && at < failed.end;
      if (!current.complete && worker?.live && (!Number.isFinite(current.priorityTick) || Math.abs(current.priorityTick - wanted) > LOOK_AHEAD / a.dt / 2)) {
        current.priorityTick = wanted;
        worker.prioritize(current.track._cinemaHandle.id, wanted);
      } else if (current.camera && current.complete && !current.pending && !failedHere &&
          at >= (current.track._recordedFrom ?? 0) && at <= recordedEnd(current.track, current.runs, current.sync) - 1) {
        void show(current, current.sync, current.focus, current.style, !!worker?.live).catch(() => { if (owns(current) && !current.plan) close(); });
      }
      for (let index = 0; index < current.sceneSize; index++) current.scene.show?.(index, false);
      current.pose = own;
      current.move = null;
      return null;
    }
    // Pending group preparation cannot monopolize the worker past the
    // visible camera's deadline. A renewal itself is never restarted here.
    if (current.camera && current.partialPlan && !current.renewing &&
        at >= current.planEnd - LOOK_AHEAD / a.dt / 2 &&
        current.planEnd < recordedEnd(current.track, current.sceneRunSet, sync) - 1) {
      const failed = current.failedWindow;
      const failedHere = failed && failed.track === current.track && failed.runs === current.sceneRunSet &&
        failed.sync === sync && failed.focus === current.focus && failed.style === current.style &&
        at >= failed.from && at < failed.end;
      if (!failedHere) renewVisible(current);
    }
    let tick = Math.max(0, Math.min(a.count - 1, at));
    const discontinuity = a.cut[Math.ceil(tick)] || previousTick === stateTick && tick !== current.tick;
    // Native teleports set previous=current, so they bypass interpolation.
    if (a.cut[Math.ceil(tick)]) tick = Math.ceil(tick);
    const low = Math.floor(tick), high = Math.min(a.count - 1, low + 1);
    current.at.length = runs.length + 1;
    current.at[0] = tick;
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index];
      const map = run.maps[sync] ?? run.maps.time;
      current.at[index + 1] = map[low] + (map[high] - map[low]) * (tick - low);
      current.scene.show?.(index + 1, true);
    }
    const lastTick = current.tick;
    current.tick = tick;
    // Drag turns the view at once; zoom eases, so a wheel's steps glide without lagging.
    const time = now(), elapsed = current.drawnAt === null ? 0 : Math.max(0, time - current.drawnAt);
    current.drawnAt = time;
    if (elapsed > 0) {
      current.motionRate = discontinuity ? 0 : (tick - lastTick) / elapsed;
      current.motionStep = elapsed;
    }
    // The first planned frame flies out of the player's own eyes.
    if (!current.pose && current.camera) current.move = {from: own, start: time, duration: MOVE, began: time, revealEnd: time + MOVE, velocity: null};
    let pose = current.camera ? aim(current, plan, tick - current.planBase, elapsed) : own;
    const move = current.move, through = move ? Math.min(1, (time - move.start) / move.duration) : 1;
    const revealed = move ? Math.min(1, (time - move.began) / (move.revealEnd - move.began)) : 1;
    if (move && through >= 1) current.move = null;
    else if (move) pose = blend(move.from, pose, through, move.velocity, move.duration, move.offset);
    if (current.camera || current.trace && move && through < 1) {
      // Safe plan samples can interpolate or blend through a corner. Check the
      // actual frame from the subject, not the smoothed/led camera target.
      let focus = -1;
      if (current.focus && current.focus !== 'played') {
        for (let index = 0; index < runs.length; index++) {
          if (runs[index].id === current.focus) { focus = index; break; }
        }
      }
      const body = trackPoint(focus < 0 ? a : runs[focus].track, current.at[focus + 1], current.body);
      body.z += 40;
      // Steady avoids solid geometry. Cinematic instead tests only the faces
      // drawn from this actual fractional/blended eye, including for a flight
      // back to POV; a clear inside-solid or backface view is left untouched.
      if (current.trace && current.style === 'steady') {
        const clear = current.trace(body, pose);
        if (clear < 1) {
          const dx = pose.x - body.x, dy = pose.y - body.y, dz = pose.z - body.z, distance = Math.hypot(dx, dy, dz);
          const k = distance > 0 ? Math.max(0, clear * distance - VIEW_CLEARANCE) / distance : 0;
          pose.x = body.x + dx * k; pose.y = body.y + dy * k; pose.z = body.z + dz * k;
        }
      } else if (current.trace?.view) keepVisible(current.trace.view, pose, body);
      if (current.camera && !current.adjusted && (focus >= 0 || !move?.from.eye || revealed > 0.25)) {
        // Interpolated angles and mode flights can lose a subject even when
        // their endpoints frame it. Keep an already visible composition intact.
        // Turn only as far as brings the subject back inside the edge, so the
        // view never jumps as it leaves or re-enters the frame. Yaw and pitch
        // are not the frame's own axes, hence the margin and the second pass.
        const dx = body.x - pose.x, dy = body.y - pose.y, dz = body.z - pose.z;
        const tall = Math.tan(pose.fov * Math.PI / 360) * 0.75;
        const wide = Math.atan(tall * innerWidth / innerHeight) * 0.96, high = Math.atan(tall) * 0.96;
        // A banked frame's edges are tilted: the subject is measured against them and the turn made on the view's own axes.
        const tilt = pose.roll ?? 0, ct = Math.cos(tilt), st = Math.sin(tilt);
        for (let pass = 0; pass < 3; pass++) {
          const yaw = pose.yaw * Math.PI / 180, pitch = pose.pitch * Math.PI / 180;
          const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
          const depth = (dx * cy + dy * sy) * cp - dz * sp;
          if (depth < 1) {
            const angles = dx || dy || dz ? viewAngles(pose, body) : pose;
            pose.yaw = angles.yaw; pose.pitch = angles.pitch;
            break;
          }
          const side = Math.atan2(dx * sy - dy * cy, depth), rise = Math.atan2((dx * cy + dy * sy) * sp + dz * cp, depth);
          const across = side * ct - rise * st, above = rise * ct + side * st;
          if (Math.abs(across) <= wide && Math.abs(above) <= high) break;
          const sideways = Math.abs(across) > wide ? across - Math.sign(across) * wide : 0, upward = Math.abs(above) > high ? above - Math.sign(above) * high : 0;
          pose.yaw -= (sideways * ct + upward * st) * 180 / Math.PI;
          pose.pitch -= (upward * ct - sideways * st) * 180 / Math.PI;
        }
      }
    }
    const velocity = current.velocity, previousPose = current.pose;
    if (previousPose && elapsed > 0 && !discontinuity) {
      velocity.x = (pose.x - previousPose.x) / elapsed;
      velocity.y = (pose.y - previousPose.y) / elapsed;
      velocity.z = (pose.z - previousPose.z) / elapsed;
      velocity.yaw = (((pose.yaw - previousPose.yaw) % 360 + 540) % 360 - 180) / elapsed;
      velocity.pitch = (pose.pitch - previousPose.pitch) / elapsed;
      velocity.fov = (pose.fov - previousPose.fov) / elapsed;
    } else if (!previousPose || discontinuity) velocity.x = velocity.y = velocity.z = velocity.yaw = velocity.pitch = velocity.fov = 0;
    current.pose = pose;
    // First person hides the watched run's own ghost and path: flying out of
    // the eyes it shows once clear of them, flying back in once nearly there.
    current.scene.show?.(0, current.camera ? !move?.from.eye || revealed > 0.25 : revealed < 0.8);
    // The camera is placed here too so the ghosts size their outlines for this frame's view.
    current.renderer.qolCamera.position.set(pose.x, pose.z, -pose.y);
    if (pose.roll) bank(current, pose.roll); else level(current);
    const absolute = current.at[0];
    current.at[0] -= current.sceneBase;
    current.scene.update(current.at, innerWidth, innerHeight);
    current.at[0] = absolute;
    if (!current.camera && !current.move) return null;
    return {...view, eyePosition: {x: pose.x, y: pose.y, z: pose.z}, yaw: pose.yaw, pitch: pose.pitch, fov: pose.fov,
      ghost: null, remotePlayers: [], showPlayers: false};
  }
  // The planned camera's pose at a tick, with your own angle and zoom.
  function aim(current, plan, tick, elapsed, advance = true) {
    const applied = current.applied;
    if (advance) {
      applied.yaw = current.view.yaw; applied.pitch = current.view.pitch;
      applied.zoom += (current.view.zoom - applied.zoom) * (1 - Math.exp(-elapsed / ZOOM_EASE));
    }
    const shot = adjust(shotAt(plan, tick, current.shot), applied);
    // Clipping can put the eye at the target in impossible geometry. Keep the
    // original line of sight rather than deriving arbitrary zero angles there.
    const angles = viewAngles(shot.eye, shot.target);
    if (current.adjusted && current.trace) {
      // Your own angle isn't in the plan. Steady avoids solid geometry;
      // Cinematic checks every drawn surface, including after eased recovery.
      const drawn = current.style !== 'steady' && current.trace.view;
      const dx = shot.eye.x - shot.target.x, dy = shot.eye.y - shot.target.y, dz = shot.eye.z - shot.target.z, d = Math.hypot(dx, dy, dz) || 1;
      const released = current.room === Infinity ? Infinity : advance ? current.room * 1.04 + 4 : current.room;
      let allowed;
      if (drawn) {
        if (released < d) {
          const k = released / d;
          shot.eye.x = shot.target.x + dx * k; shot.eye.y = shot.target.y + dy * k; shot.eye.z = shot.target.z + dz * k;
        }
        allowed = keepVisible(drawn, shot.eye, shot.target)
          ? Math.hypot(shot.eye.x - shot.target.x, shot.eye.y - shot.target.y, shot.eye.z - shot.target.z) : Infinity;
      } else {
        const clear = current.trace(shot.target, shot.eye);
        allowed = clear < 1 ? Math.max(0, clear * d - VIEW_CLEARANCE) : Infinity;
      }
      const room = allowed < current.room ? allowed : Math.min(allowed, released);
      if (advance) current.room = room;
      if (!drawn && room < d) {
        const k = room / d;
        shot.eye.x = shot.target.x + dx * k; shot.eye.y = shot.target.y + dy * k; shot.eye.z = shot.target.z + dz * k;
      }
    }
    return {x: shot.eye.x, y: shot.eye.y, z: shot.eye.z, yaw: angles.yaw, pitch: angles.pitch, fov: shot.fov, roll: shot.roll};
  }
  // The game aims its camera with lookAt just before it draws. Shadow it
  // only while banking, and restore the exact own descriptor on exit.
  function bank(current, roll) {
    const camera = current.renderer.qolCamera;
    if (current.banked && (current.banked.camera !== camera || camera.lookAt !== current.banked.wrapper)) level(current);
    current.roll = roll;
    if (current.banked) return;
    const aimAt = camera?.lookAt;
    if (typeof aimAt !== 'function') return;
    const descriptor = Object.getOwnPropertyDescriptor(camera, 'lookAt');
    if (descriptor && !descriptor.configurable && (!('value' in descriptor) || !descriptor.writable) ||
        !descriptor && !Object.isExtensible(camera)) return;
    const banked = {camera, descriptor, applied: 0};
    const wrapper = function (...at) {
      const result = aimAt.apply(this, at);
      if (this === camera) banked.applied = 0;
      if (current.banked === banked && current.roll) {
        this.rotateZ(-current.roll);
        if (this === camera) banked.applied = current.roll;
      }
      return result;
    };
    Object.defineProperty(camera, 'lookAt', {value: wrapper, writable: true,
      configurable: descriptor?.configurable ?? true, enumerable: descriptor?.enumerable ?? false});
    banked.wrapper = wrapper;
    current.banked = banked;
  }
  function level(current) {
    const banked = current.banked;
    current.banked = null;
    current.roll = 0;
    if (!banked) return;
    // Removing lookAt alone leaves the last drawn quaternion tilted until
    // another render. Undo only the bank actually applied to this camera.
    if (banked.applied) banked.camera.rotateZ(banked.applied);
    if (Object.getOwnPropertyDescriptor(banked.camera, 'lookAt')?.value !== banked.wrapper) return;
    if (banked.descriptor) Object.defineProperty(banked.camera, 'lookAt', banked.descriptor);
    else delete banked.camera.lookAt;
  }

  function listen(current) {
    const canvas = document.querySelector('canvas');
    let drag = null;
    // In first person the game keeps its own mouse; these steer the planned camera only.
    const onDown = event => {
      if (event.button !== 0 || event.target !== canvas || !current.camera) return;
      event.preventDefault(); event.stopImmediatePropagation();
      drag = {x: event.clientX, y: event.clientY, id: event.pointerId};
      try { canvas.setPointerCapture(event.pointerId); } catch { /* still follows the window */ }
    };
    const onMove = event => {
      if (!drag || event.pointerId !== drag.id) return;
      event.preventDefault(); event.stopImmediatePropagation();
      current.view.yaw -= (event.clientX - drag.x) * DRAG_RADIANS;
      current.view.pitch += (event.clientY - drag.y) * DRAG_RADIANS;
      drag.x = event.clientX; drag.y = event.clientY;
      if (!current.adjusted) { current.adjusted = true; notify(); }
    };
    const onUp = event => {
      if (!drag || event.pointerId !== drag.id) return;
      event.preventDefault(); event.stopImmediatePropagation();
      drag = null;
    };
    const onWheel = event => {
      if (event.target !== canvas || event.ctrlKey || !current.camera) return;
      event.preventDefault(); event.stopImmediatePropagation();
      current.view.zoom = Math.max(0.35, Math.min(3, current.view.zoom * (event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
      if (!current.adjusted) { current.adjusted = true; notify(); }
    };
    const onDouble = event => { if (event.target === canvas && current.camera) { event.preventDefault(); event.stopImmediatePropagation(); resetView(); } };
    // The game also listens for clicks on its canvas; a drag here is the camera's alone.
    const swallow = event => { if (event.target === canvas && event.button === 0 && current.camera) { event.preventDefault(); event.stopImmediatePropagation(); } };
    const listeners = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp],
      ['wheel', onWheel], ['dblclick', onDouble], ['mousedown', swallow], ['click', swallow]];
    for (const [type, listener] of listeners) addEventListener(type, listener, {capture: true, passive: false});
    current.unlisten = () => { for (const [type, listener] of listeners) removeEventListener(type, listener, {capture: true}); };
  }

  function resetView() {
    if (!state?.renderer) return;
    if (state.adjusted && state.camera) retarget(state);
    state.view = {yaw: 0, pitch: 0, zoom: 1};
    state.adjusted = false;
    state.room = Infinity;
    notify();
  }
  async function setSync(sync) {
    const current = state;
    if (!current?.renderer || !['place', 'time'].includes(sync) || current.sync === sync && !current.pending) return;
    const selection = ++current.selection;
    if (!current.complete) { await prepare(current); if (!owns(current)) return; }
    if (current.selection !== selection || !current.cameraRequested) return;
    await show(current, sync, current.pending ? current.pending.focus : current.focus);
  }
  // 'cinematic' or 'steady'.
  // Remembered for when the camera next shows; shown now if it already is.
  async function setStyle(style) {
    if (!STYLES.includes(style)) return;
    if (state?.camera) await setView(style);
    else preferred = style;
  }
  // null for the group shot, 'played' for the watched run, or an added run's id;
  // choosing the focused run again goes back to the group.
  // In first person, choosing a run switches to the remembered camera on it.
  async function setFocus(focus) {
    const current = state;
    if (!current?.renderer || focus !== null && focus !== 'played' && !current.runs.some(run => run.id === focus)) return;
    const selected = focus !== null && focus !== 'played' ? current.runs.find(run => run.id === focus) : null;
    const selection = ++current.selection;
    current.cameraRequested = true;
    if (!current.complete) { await prepare(current); if (!owns(current)) return; }
    if (current.selection !== selection || !current.cameraRequested || selected && !current.runs.includes(selected)) return;
    const shown = current.pending ? current.pending.focus : current.focus, sync = current.pending?.sync ?? current.sync;
    if (current.camera) { await show(current, sync, focus !== null && focus === shown ? null : focus); return; }
    const published = await show(current, sync, focus, preferred);
    if (published && owns(current) && current.selection === selection && current.cameraRequested &&
        current.plan && !current.planInvalid && !current.pending && !current.camera) {
      current.camera = true; retarget(current); notify();
    }
  }

  function close() {
    const current = state;
    if (!current) return;
    current.resolvePreview(false);
    current.lifetime.abort();
    current.planAbort?.abort();
    (current.worker ?? current.track?._cinemaWorker)?.release();
    state = null;
    for (const pending of current.loading) pending.cancel();
    current.unlisten?.();
    cancelAnimationFrame(current.checking);
    detach(current);
    notify();
  }

  return {
    available,
    setEnabled,
    add,
    remove,
    close,
    resetView,
    setSync,
    setFocus,
    setStyle,
    setView,
    // Whether the planned camera shows (else the game's own first person), and the view by name.
    get camera() { return !!state?.renderer && state.camera; },
    get view() { return state?.renderer && state.camera ? state.pending?.style ?? state.style : 'pov'; },
    get preferred() { return preferred; },
    // Camera activity is independent of whether extra comparison runs exist.
    get active() { return !!state?.renderer; },
    get comparing() { return !!state?.renderer && state.sceneRuns.length > 0; },
    // For the dev console: the watched track, then each added run's.
    get tracks() { return state?.track ? [state.track, ...state.runs.map(run => run.track)] : null; },
    // What the UI shows, null while cinematic viewing is disabled: the watched run first, then each
    // added run with its colour, time and gap at this point (by place, in both
    // modes: in Real time the clocks match by definition), runs still loading,
    // where each ghost's name goes, the camera style and whether the view was moved.
    status() {
      const current = state;
      if (!current) return null;
      const tick = current.tick ?? 0;
      const runs = (current.sceneRuns ?? current.runs).map(run => ({
        id: run.id, label: run.label, colorIndex: run.colorIndex, color: colorOf(run.colorIndex),
        time: run.time, gap: run.maps.place ? gapAt(current.sceneTrack ?? current.track, run.track, run.maps.place, tick) : null,
      }));
      let labels = [];
      try { labels = current.scene?.labels(innerWidth, innerHeight) ?? []; } catch { /* none this frame */ }
      return {active: !!current.renderer, played: {colorIndex: 0, color: colorOf(0), time: current.track?.time ?? null}, runs,
        loading: current.loading.map(({id, label, colorIndex}) => ({id, label, colorIndex, color: colorOf(colorIndex)})),
        sync: current.sync, focus: current.focus, style: current.style, view: current.camera ? current.pending?.style ?? current.style : 'pov', preferred,
        pending: current.pending?.sync ?? null, adjusted: current.adjusted && current.camera, planError: current.planError?.message ?? null, labels};
    },
    destroy() { close(); },
  };
}
