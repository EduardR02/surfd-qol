// Ghosts in a replay: other runs of the map played alongside the one you're
// watching, with their lines, from a planned third-person camera. The watched
// run stays in the game's own player, so its bar, speeds, seeking and stage
// jumps work as usual; each added run follows it by the clock (Real time) or
// by place on the route (Side by side).
//
// Nothing runs until cinematic viewing is enabled (directly or by adding a
// run). Solo and group shots use the same camera; close() restores the game.
import {createTrack, recordTrack, trackPoint, trackYaw} from './cinema-track.js';
import {alignByPlace, alignByTime, gapAt} from './cinema-sync.js';
import {planCamera, shotAt, adjust, viewAngles} from './cinema-camera.js';
import {createCinemaScene, runColors} from './cinema-scene.js';
import {routeFingerprint} from './replay-store.js';

// Brush contents the camera can see through: player clips, grates, glass.
const SOLID = 0x1, SEE_THROUGH = 0x10000000 | 0x8;
const PROBE = {min: {x: -6, y: -6, z: -6}, max: {x: 6, y: 6, z: 6}};
const DRAG_RADIANS = 0.005;
const ZOOM_STEP = 1.12;
// Scrolling sets the zoom to reach; the view closes on it with this time constant (ms).
const ZOOM_EASE = 100;
const idle = () => new Promise(resolve => typeof requestIdleCallback === 'function'
  ? requestIdleCallback(resolve, {timeout: 50}) : setTimeout(resolve, 0));

export const colorOf = index => runColors(index).line;

// The game's collision world without what the camera sees through.
function cameraWorld(session) {
  const world = session?.movement?.world, map = session?.map;
  if (!world || typeof world.trace !== 'function' || !Array.isArray(map?.brushes)) return null;
  const brushes = map.brushes.filter(brush => brush.contents == null || (brush.contents & SOLID) !== 0 && (brush.contents & SEE_THROUGH) === 0);
  try {
    const filtered = new world.constructor(brushes, map.displacementTriangles ?? [], world.vphysicsFeatureFix, world.bspCornerFix);
    return typeof filtered.trace === 'function' ? filtered : world;
  } catch { return world; }
}

// getAdapter() is the game adapter. A run given to add() is {id, label, load()},
// load() giving its replay. record, createScene and now stand in for the game in tests.
export function createCinema({getAdapter, onChange = () => {}, loadIdle = idle, record = recordTrack, createScene = createCinemaScene, now = () => performance.now()}) {
  // The watched replay and its track, the added runs, and what's being added.
  let state = null;
  const notify = () => { try { onChange(); } catch { /* UI only */ } };
  const playing = () => { try { return getAdapter?.()?.replay?.playback?.()?.replay ?? null; } catch { return null; } };

  // A replay can have ghosts when this build exposes the map renderer and the replay is of the loaded map.
  function available() {
    const adapter = getAdapter?.(), replay = playing(), map = adapter?.getSession?.()?.map;
    return !!adapter?.cinema?.renderer?.()?.qolScene && !!replay && !!map && replay.mapId === map.id && replay.mapVersion === map.version;
  }

  const owns = current => state === current && playing() === current.replay;
  function currentState() {
    if (!available()) throw new Error('Cinematic viewing needs a replay of the loaded map.');
    const replay = playing();
    if (state && state.replay !== replay) close();
    return state ??= createState(replay);
  }
  async function setEnabled(enabled) {
    if (!enabled) { close(); return false; }
    const current = currentState();
    return current.enabling ??= (async () => {
      try {
        await prepare(current);
        if (!owns(current)) return false;
        if (!current.renderer) await show(current, current.sync, current.focus);
        return owns(current) && !!current.renderer;
      } catch (error) {
        if (state === current && !current.renderer && !current.loading.length) close();
        throw error;
      }
    })().finally(() => { current.enabling = null; });
  }
  function add(run) {
    let current;
    try { current = currentState(); } catch (error) { return Promise.reject(error); }
    if (current.runs.some(item => item.id === run.id) || current.loading.some(item => item.id === run.id)) return Promise.resolve(false);
    const used = new Set([...current.runs, ...current.loading].map(item => item.colorIndex));
    let colorIndex = 1;
    while (used.has(colorIndex)) colorIndex++;
    const pending = {id: run.id, label: run.label, colorIndex};
    const cancelled = new Promise(resolve => { pending.cancel = () => resolve(false); });
    current.loading.push(pending);
    notify();
    const step = current.queue.then(() => Promise.race([load(current, run, pending), cancelled]));
    current.queue = step.catch(() => {});
    return step.finally(() => {
      if (state !== current) return;
      current.loading = current.loading.filter(item => item !== pending);
      if (!current.renderer && !current.runs.length && !current.loading.length) close();
      else notify();
    });
  }
  function createState(replay) {
    // sync, focus and style are the shown camera's: Real time or Side by side,
    // null for the group shot, 'played' or a run's id for one run alone, and
    // the camera style ('cinematic' or 'follow').
    return {replay, base: replay.initialState?.tick ?? 0, track: null, runs: [], loading: [], queue: Promise.resolve(), ready: null, sync: 'time', focus: null, style: 'cinematic', plan: null, plans: {}, view: {yaw: 0, pitch: 0, zoom: 1},
      applied: {yaw: 0, pitch: 0, zoom: 1}, drawnAt: null, room: Infinity, adjusted: false, shot: {eye: {x: 0, y: 0, z: 0}, target: {x: 0, y: 0, z: 0}}, at: [], tick: 0, pending: null, trace: undefined};
  }
  function prepare(current) {
    return current.ready ??= (async () => {
      const adapter = getAdapter(), session = adapter.getSession();
      current.track = await record({adapter, session, replay: current.replay, isCurrent: () => owns(current), yieldTask: loadIdle});
      if (!owns(current)) return;
      if (!current.track) throw new Error('This replay can’t use cinematic viewing.');
      const world = cameraWorld(session);
      current.trace = world ? (from, to) => {
        const hit = world.trace(from, to, PROBE);
        return hit.startSolid || hit.allSolid ? 1 : Math.max(0, Math.min(1, hit.fraction));
      } : null;
    })().catch(error => { current.ready = null; throw error; });
  }
  async function load(current, run, pending) {
    const owned = () => owns(current) && current.loading.includes(pending);
    if (!owned()) return false;
    const replay = await run.load();
    if (!owned()) return false;
    if (!replay) throw new Error('That run’s replay isn’t available.');
    current.fingerprint ??= routeFingerprint(current.replay);
    const fingerprint = routeFingerprint(replay);
    if (replay === current.replay || replay.commands?.length === current.replay.commands.length && fingerprint === current.fingerprint)
      throw new Error('That’s the run you’re watching.');
    if (current.runs.some(entry => entry.fingerprint === fingerprint)) throw new Error('That run is already added.');
    await prepare(current);
    if (!owned()) return false;
    const adapter = getAdapter(), session = adapter.getSession();
    const track = await record({adapter, session, replay, isCurrent: owned, yieldTask: loadIdle});
    if (!owned()) return false;
    if (!track) throw new Error('That run couldn’t be read on this map.');
    const entry = {id: run.id, label: run.label, colorIndex: pending.colorIndex, fingerprint, track,
      maps: {time: alignByTime(current.track, track), place: alignByPlace(current.track, track)}, time: track.time};
    current.runs = [...current.runs, entry];
    current.plans = {};
    if (current.renderer) rebuild(current);
    const request = current.pending;
    await show(current, request?.sync ?? current.sync, request ? request.focus : current.focus);
    return owned();
  }
  const planKey = (sync, focus, style) => `${sync}|${focus ?? ''}|${style}`;
  async function planFor(current, runs, sync, focus, style, owned) {
    for (const run of runs) run.maps[sync] ??= sync === 'place' ? alignByPlace(current.track, run.track) : alignByTime(current.track, run.track);
    const options = {style, trace: current.trace, yieldTask: loadIdle, isCurrent: owned};
    const chosen = runs.find(run => run.id === focus);
    if (!chosen) return planCamera({a: current.track, others: runs.map(run => ({track: run.track, map: run.maps[sync]})), group: focus !== 'played', ...options});
    // An added run is planned on the watched run's clock, so the plan's ticks stay the replay's.
    current.identity ??= Float32Array.from({length: current.track.count}, (_, tick) => tick);
    return planCamera({a: onClock(chosen.track, chosen.maps[sync], current.track), group: false, ...options,
      others: [{track: current.track, map: current.identity}, ...runs.filter(run => run !== chosen).map(run => ({track: run.track, map: run.maps[sync]}))]});
  }
  // A run resampled at each of the watched run's ticks.
  function onClock(track, map, clock) {
    const out = createTrack(clock.count, clock.dt), point = {x: 0, y: 0, z: 0};
    for (let tick = 0; tick < clock.count; tick++) {
      const at = map[tick], nearest = Math.round(Math.max(0, Math.min(track.count - 1, at)));
      trackPoint(track, at, point);
      out.position[tick * 3] = point.x; out.position[tick * 3 + 1] = point.y; out.position[tick * 3 + 2] = point.z;
      out.yaw[tick] = trackYaw(track, at);
      out.ducked[tick] = track.ducked[nearest];
      out.normal.set(track.normal.subarray(nearest * 3, nearest * 3 + 3), tick * 3);
      if (tick) for (let k = Math.floor(map[tick - 1]) + 1; k <= Math.floor(at) && !out.cut[tick]; k++) out.cut[tick] = track.cut[k] ?? 0;
    }
    // Its start and finish on the watched clock, which the camera's shots follow.
    const reached = tick => { let at = 0; while (at < clock.count - 1 && map[at] < tick) at++; return at; };
    if (track.start > 0) out.start = reached(track.start);
    if (track.finish < track.count - 1) out.finish = reached(track.finish);
    return out;
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
    current.runs = current.runs.filter(run => run.id !== id);
    current.plans = {};
    rebuild(current);
    const request = current.pending;
    const focus = request ? request.focus : current.focus;
    return show(current, request?.sync ?? current.sync, focus === id ? null : focus).catch(() => { if (owns(current)) close(); });
  }
  // A unique request token prevents an older plan (even for the same choices)
  // from replacing a newer selection after an idle-time yield.
  async function show(current, sync, focus, style = current.pending?.style ?? current.style) {
    const key = planKey(sync, focus, style), runs = current.runs;
    const request = {sync, focus, style};
    current.pending = request;
    const owned = () => owns(current) && current.runs === runs && current.pending === request;
    notify();
    try {
      const plan = current.plans[key] ?? await planFor(current, runs, sync, focus, style, owned);
      if (!owned() || !plan) return;
      current.plans[key] = plan;
      Object.assign(current, {sync, focus, style, plan, pending: null});
      if (!current.renderer) start(current);
      notify();
    } catch (error) {
      if (owned()) { current.pending = null; notify(); }
      if (owns(current) && !current.renderer) close();
      throw error;
    }
  }

  // While cinematic viewing is enabled: the renderer wrap, canvas listeners
  // and a check each frame that the replay still plays.
  function start(current) {
    attach(current, getAdapter().cinema.renderer());
    listen(current);
    const check = () => {
      if (state !== current) return;
      const adapter = getAdapter?.();
      if (playing() !== current.replay) { close(); return; }
      // The game makes a new renderer when it reloads the map, as Watch from the menu can.
      const renderer = adapter.cinema?.renderer?.();
      if (renderer !== current.renderer) {
        detach(current);
        if (!renderer?.qolScene) { close(); return; }
        try { attach(current, renderer); } catch { close(); return; }
      }
      current.checking = requestAnimationFrame(check);
    };
    current.checking = requestAnimationFrame(check);
  }
  function attach(current, renderer) {
    current.scene = createScene(renderer, [{track: current.track, colorIndex: 0}, ...current.runs.map(run => ({track: run.track, colorIndex: run.colorIndex}))]);
    current.renderer = renderer;
    const original = current.original = renderer.render;
    renderer.render = current.wrapper = function (view) {
      try { return original.call(this, frame(current, view) ?? view); }
      catch (error) { queueMicrotask(() => { if (state === current) close(); }); throw error; }
    };
  }
  function detach(current) {
    if (current.renderer && current.renderer.render === current.wrapper) current.renderer.render = current.original;
    try { current.scene?.dispose(); } catch { /* the map was unloaded with it */ }
    current.renderer = current.scene = null;
  }
  // The scene holds one ghost per run, so a change of runs builds it again.
  function rebuild(current) {
    const renderer = current.renderer;
    detach(current);
    try { attach(current, renderer); } catch (error) { if (state === current) close(); throw error; }
  }

  // The played run's fractional index from the frame's state and interpolation.
  function frame(current, view) {
    if (playing() !== current.replay) { queueMicrotask(() => { if (state === current) close(); }); return null; }
    const a = current.track, plan = current.plan, sync = current.sync;
    if (!plan) return null;
    const stateTick = view.state?.tick ?? current.base, previousTick = getAdapter()?.getSession?.()?.previous?.tick;
    // Seeking sets native previous=current but retains its interpolation alpha.
    // Interpolate the actual state pair, not an assumed preceding tick.
    const from = Number.isFinite(previousTick) && previousTick <= stateTick ? previousTick : stateTick - 1;
    const alpha = Number.isFinite(view.qolAlpha) ? Math.max(0, Math.min(1, view.qolAlpha)) : 1;
    let tick = Math.max(0, Math.min(a.count - 1, from - current.base + (stateTick - from) * alpha));
    // Native teleports set previous=current, so they bypass interpolation.
    if (a.cut[Math.ceil(tick)]) tick = Math.ceil(tick);
    const low = Math.floor(tick), high = Math.min(a.count - 1, low + 1);
    current.at.length = current.runs.length + 1;
    current.at[0] = tick;
    for (let index = 0; index < current.runs.length; index++) {
      const run = current.runs[index];
      const map = run.maps[sync] ?? run.maps.time;
      current.at[index + 1] = map[low] + (map[high] - map[low]) * (tick - low);
    }
    current.tick = tick;
    // Drag turns the view at once; zoom eases, so a wheel's steps glide without lagging.
    const time = now(), elapsed = current.drawnAt === null ? 0 : Math.max(0, time - current.drawnAt);
    current.drawnAt = time;
    const applied = current.applied;
    applied.yaw = current.view.yaw; applied.pitch = current.view.pitch;
    applied.zoom += (current.view.zoom - applied.zoom) * (1 - Math.exp(-elapsed / ZOOM_EASE));
    const shot = adjust(shotAt(plan, tick, current.shot), applied);
    if (current.adjusted && current.trace) {
      // Your own angle isn't in the plan: keep it out of walls as it plays.
      const clear = current.trace(shot.target, shot.eye);
      const dx = shot.eye.x - shot.target.x, dy = shot.eye.y - shot.target.y, dz = shot.eye.z - shot.target.z, d = Math.hypot(dx, dy, dz) || 1;
      const allowed = clear < 1 ? Math.max(40, clear * d - 12) : Infinity;
      current.room = allowed < current.room ? allowed : Math.min(allowed, current.room === Infinity ? Infinity : current.room * 1.04 + 4);
      if (current.room < d) {
        const k = current.room / d;
        shot.eye.x = shot.target.x + dx * k; shot.eye.y = shot.target.y + dy * k; shot.eye.z = shot.target.z + dz * k;
      }
    }
    const angles = viewAngles(shot.eye, shot.target);
    // The camera is placed here too so the ghosts size their outlines for this frame's view.
    current.renderer.qolCamera.position.set(shot.eye.x, shot.eye.z, -shot.eye.y);
    current.scene.update(current.at, innerWidth, innerHeight);
    return {...view, eyePosition: {x: shot.eye.x, y: shot.eye.y, z: shot.eye.z}, yaw: angles.yaw, pitch: angles.pitch, fov: shot.fov,
      ghost: null, remotePlayers: [], showPlayers: false};
  }

  function listen(current) {
    const canvas = document.querySelector('canvas');
    let drag = null;
    const onDown = event => {
      if (event.button !== 0 || event.target !== canvas) return;
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
      if (event.target !== canvas || event.ctrlKey) return;
      event.preventDefault(); event.stopImmediatePropagation();
      current.view.zoom = Math.max(0.35, Math.min(3, current.view.zoom * (event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
      if (!current.adjusted) { current.adjusted = true; notify(); }
    };
    const onDouble = event => { if (event.target === canvas) { event.preventDefault(); event.stopImmediatePropagation(); resetView(); } };
    // The game also listens for clicks on its canvas; a drag here is the camera's alone.
    const swallow = event => { if (event.target === canvas && event.button === 0) { event.preventDefault(); event.stopImmediatePropagation(); } };
    const listeners = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp],
      ['wheel', onWheel], ['dblclick', onDouble], ['mousedown', swallow], ['click', swallow]];
    for (const [type, listener] of listeners) addEventListener(type, listener, {capture: true, passive: false});
    current.unlisten = () => { for (const [type, listener] of listeners) removeEventListener(type, listener, {capture: true}); };
  }

  function resetView() {
    if (!state?.renderer) return;
    state.view = {yaw: 0, pitch: 0, zoom: 1};
    state.adjusted = false;
    state.room = Infinity;
    notify();
  }
  async function setSync(sync) {
    const current = state;
    if (!current?.renderer || !['place', 'time'].includes(sync) || current.sync === sync && !current.pending) return;
    await show(current, sync, current.pending ? current.pending.focus : current.focus);
  }
  // 'cinematic' or 'follow'.
  async function setStyle(style) {
    const current = state;
    if (!current?.renderer || !['cinematic', 'follow'].includes(style) || current.style === style && !current.pending) return;
    await show(current, current.pending?.sync ?? current.sync, current.pending ? current.pending.focus : current.focus, style);
  }
  // null for the group shot, 'played' for the watched run, or an added run's id;
  // choosing the focused run again goes back to the group.
  async function setFocus(focus) {
    const current = state;
    if (!current?.renderer || focus !== null && focus !== 'played' && !current.runs.some(run => run.id === focus)) return;
    const shown = current.pending ? current.pending.focus : current.focus;
    await show(current, current.pending?.sync ?? current.sync, focus !== null && focus === shown ? null : focus);
  }

  function close() {
    const current = state;
    if (!current) return;
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
    // Camera activity is independent of whether extra comparison runs exist.
    get active() { return !!state?.renderer; },
    get comparing() { return !!state?.renderer && state.runs.length > 0; },
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
      const runs = current.runs.map(run => ({
        id: run.id, label: run.label, colorIndex: run.colorIndex, color: colorOf(run.colorIndex),
        time: run.time, gap: gapAt(current.track, run.track, run.maps.place, tick),
      }));
      let labels = [];
      try { labels = current.scene?.labels(innerWidth, innerHeight) ?? []; } catch { /* none this frame */ }
      return {active: !!current.renderer, played: {colorIndex: 0, color: colorOf(0), time: current.track?.time ?? null}, runs,
        loading: current.loading.map(({id, label, colorIndex}) => ({id, label, colorIndex, color: colorOf(colorIndex)})),
        sync: current.sync, focus: current.focus, style: current.style, pending: current.pending?.sync ?? null, adjusted: current.adjusted, labels};
    },
    destroy() { close(); },
  };
}
