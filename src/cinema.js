// Ghosts in a replay: other runs of the map played alongside the one you're
// watching, with their lines, from a planned third-person camera. The watched
// run stays in the game's own player, so its bar, speeds, seeking and stage
// jumps work as usual; each added run follows it by the clock (Real time) or
// by place on the route (Side by side).
//
// Nothing here runs until a run is added: no timers, listeners, observers or
// frame work. With ghosts it wraps the game's map renderer, listens for drags
// on the game canvas and checks each frame that the replay still plays;
// removing the last ghost or close() puts all of it back.
import {createTrack, recordTrack, trackPoint, trackYaw} from './cinema-track.js';
import {alignByPlace, alignByTime, gapAt} from './cinema-sync.js';
import {planCamera, shotAt, adjust, viewAngles, FOV} from './cinema-camera.js';
import {createCinemaScene, RUN_COLORS} from './cinema-scene.js';
import {routeFingerprint} from './replay-store.js';

// Brush contents the camera can see through: player clips, grates, glass.
const SOLID = 0x1, SEE_THROUGH = 0x10000000 | 0x8;
const PROBE = {min: {x: -6, y: -6, z: -6}, max: {x: 6, y: 6, z: 6}};
const DRAG_RADIANS = 0.005;
const ZOOM_STEP = 1.12;
// The watched run and up to this many others: more stops being readable.
export const MAX_GHOSTS = RUN_COLORS.length - 1;
const idle = () => new Promise(resolve => typeof requestIdleCallback === 'function'
  ? requestIdleCallback(resolve, {timeout: 50}) : setTimeout(resolve, 0));

export const colorOf = index => RUN_COLORS[index]?.line ?? '#ffffff';

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
// load() giving its replay. record and createScene stand in for the game in tests.
export function createCinema({getAdapter, onChange = () => {}, loadIdle = idle, record = recordTrack, createScene = createCinemaScene}) {
  // The watched replay and its track, the added runs, and what's being added.
  let state = null;
  const notify = () => { try { onChange(); } catch { /* UI only */ } };
  const playing = () => { try { return getAdapter?.()?.replay?.playback?.()?.replay ?? null; } catch { return null; } };

  // A replay can have ghosts when this build exposes the map renderer and the replay is of the loaded map.
  function available() {
    const adapter = getAdapter?.(), replay = playing(), map = adapter?.getSession?.()?.map;
    return !!adapter?.cinema?.renderer?.()?.qolScene && !!replay && !!map && replay.mapId === map.id && replay.mapVersion === map.version;
  }

  // Runs added while another is loading wait their turn, so tracks and plans are made one at a time.
  let queue = Promise.resolve();
  function add(run) {
    if (!available()) return Promise.reject(new Error('Ghosts need a replay of the loaded map.'));
    const replay = playing();
    if (state && state.replay !== replay) close();
    state ??= createState(replay);
    const current = state;
    if (current.runs.some(item => item.id === run.id) || current.loading.some(item => item.id === run.id)) return Promise.resolve(false);
    if (current.runs.length + current.loading.length >= MAX_GHOSTS) return Promise.reject(new Error(`Up to ${MAX_GHOSTS} runs alongside this one.`));
    current.loading.push({id: run.id, label: run.label});
    notify();
    const step = queue.then(() => load(current, run));
    queue = step.catch(() => {});
    return step.finally(() => {
      if (state !== current) return;
      current.loading = current.loading.filter(item => item.id !== run.id);
      if (!current.runs.length && !current.loading.length) close();
      else notify();
    });
  }
  function createState(replay) {
    // sync and focus are the shown camera's: Real time or Side by side, and
    // null for the group shot, 'played' or a run's id for one run alone.
    return {replay, base: replay.initialState?.tick ?? 0, track: null, runs: [], loading: [], sync: 'time', focus: null, plan: null, plans: {}, view: {yaw: 0, pitch: 0, zoom: 1},
      room: Infinity, adjusted: false, shot: {eye: {x: 0, y: 0, z: 0}, target: {x: 0, y: 0, z: 0}}, at: [], tick: 0, pending: null, trace: undefined};
  }
  async function load(current, run) {
    const owned = () => state === current && playing() === current.replay;
    const adapter = getAdapter(), session = adapter.getSession();
    const replay = await run.load();
    if (!owned()) return false;
    if (!replay) throw new Error('That run’s replay isn’t available.');
    // Replays carry no run id: the run being watched is known by its contents.
    current.fingerprint ??= routeFingerprint(current.replay);
    if (replay === current.replay || replay.commands?.length === current.replay.commands.length && routeFingerprint(replay) === current.fingerprint)
      throw new Error('That’s the run you’re watching.');
    current.track ??= await record({adapter, session, replay: current.replay, isCurrent: owned, yieldTask: loadIdle});
    if (!owned()) return false;
    if (!current.track) throw new Error('This replay can’t have ghosts.');
    const track = await record({adapter, session, replay, isCurrent: owned, yieldTask: loadIdle});
    if (!owned()) return false;
    if (!track) throw new Error('That run couldn’t be read on this map.');
    if (current.trace === undefined) {
      const world = cameraWorld(session);
      current.trace = world ? (from, to) => {
        const hit = world.trace(from, to, PROBE);
        return hit.startSolid || hit.allSolid ? 1 : Math.max(0, Math.min(1, hit.fraction));
      } : null;
    }
    const entry = {id: run.id, label: run.label, track, maps: {time: alignByTime(current.track, track), place: null}, time: track.time};
    const runs = [...current.runs, entry];
    const plan = await planFor(current, runs, current.sync, current.focus, owned);
    if (!owned() || !plan) return false;
    current.runs = runs;
    current.plans = {[planKey(current.sync, current.focus)]: plan};
    current.plan = plan;
    if (!current.renderer) start(current);
    else rebuild(current);
    return true;
  }
  const planKey = (sync, focus) => `${sync}|${focus ?? ''}`;
  async function planFor(current, runs, sync, focus, owned) {
    for (const run of runs) run.maps[sync] ??= sync === 'place' ? alignByPlace(current.track, run.track) : alignByTime(current.track, run.track);
    const options = {trace: current.trace, yieldTask: loadIdle, isCurrent: owned};
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
      out.position.set([point.x, point.y, point.z], tick * 3);
      out.yaw[tick] = trackYaw(track, at);
      out.ducked[tick] = track.ducked[nearest];
      out.normal.set(track.normal.subarray(nearest * 3, nearest * 3 + 3), tick * 3);
      if (tick) for (let k = Math.floor(map[tick - 1]) + 1; k <= Math.ceil(at) && !out.cut[tick]; k++) out.cut[tick] = track.cut[k] ?? 0;
    }
    return out;
  }
  function remove(id) {
    const current = state;
    if (!current?.runs.some(run => run.id === id)) return;
    current.runs = current.runs.filter(run => run.id !== id);
    if (!current.runs.length) { close(); return; }
    current.plans = {};
    rebuild(current);
    void show(current, current.sync, current.focus === id ? null : current.focus, true);
  }
  // Shows the camera for these choices, planning it first if it's new; until
  // then the camera keeps the last one.
  async function show(current, sync, focus, fresh = false) {
    const key = planKey(sync, focus);
    if (current.plans[key] && !fresh) {
      Object.assign(current, {sync, focus, plan: current.plans[key], pending: null});
      notify();
      return;
    }
    const runs = current.runs, owned = () => state === current && current.runs === runs && current.pending === key;
    current.pending = key;
    notify();
    const plan = await planFor(current, runs, sync, focus, owned);
    if (!owned() || !plan) return;
    current.plans[key] = plan;
    Object.assign(current, {sync, focus, plan, pending: null});
    notify();
  }

  // From the first ghost until stop(): the renderer wrap, the canvas listeners
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
    current.scene = createScene(renderer, [{track: current.track}, ...current.runs.map(run => ({track: run.track}))]);
    current.renderer = renderer;
    const original = current.original = renderer.render;
    renderer.render = current.wrapper = function (view) {
      try { return original.call(this, frame(current, view) ?? view); }
      catch (error) { if (state === current) queueMicrotask(close); throw error; }
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
    attach(current, renderer);
  }

  // The played run's fractional index from the frame's state and interpolation.
  function frame(current, view) {
    if (playing() !== current.replay) { queueMicrotask(close); return null; }
    const a = current.track, plan = current.plan, sync = current.sync;
    if (!plan) return null;
    const tick = Math.max(0, Math.min(a.count - 1, (view.state?.tick ?? current.base) - current.base - 1 + (Number.isFinite(view.qolAlpha) ? view.qolAlpha : 1)));
    const low = Math.floor(tick), high = Math.min(a.count - 1, low + 1);
    current.at.length = current.runs.length + 1;
    current.at[0] = tick;
    for (const [index, run] of current.runs.entries()) {
      const map = run.maps[sync] ?? run.maps.time;
      current.at[index + 1] = map[low] + (map[high] - map[low]) * (tick - low);
    }
    current.tick = tick;
    const shot = adjust(shotAt(plan, tick, current.shot), current.view);
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
    return {...view, eyePosition: {x: shot.eye.x, y: shot.eye.y, z: shot.eye.z}, yaw: angles.yaw, pitch: angles.pitch, fov: FOV,
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
    await show(current, sync, current.focus);
  }
  // null for the group shot, 'played' for the watched run, or an added run's id;
  // choosing the focused run again goes back to the group.
  async function setFocus(focus) {
    const current = state;
    if (!current?.renderer || focus !== null && focus !== 'played' && !current.runs.some(run => run.id === focus)) return;
    await show(current, current.sync, focus === current.focus ? null : focus);
  }

  function close() {
    const current = state;
    if (!current) return;
    state = null;
    current.unlisten?.();
    cancelAnimationFrame(current.checking);
    detach(current);
    notify();
  }

  return {
    available,
    add,
    remove,
    close,
    resetView,
    setSync,
    setFocus,
    // True while ghosts play: the renderer is Compare's.
    get active() { return !!state?.renderer; },
    // For the dev console: the watched track, then each added run's.
    get tracks() { return state?.track ? [state.track, ...state.runs.map(run => run.track)] : null; },
    // What the UI shows, null with no ghosts: the watched run first, then each
    // added run with its colour, time and gap at this point (by place, in both
    // modes: in Real time the clocks match by definition), runs still loading,
    // where each ghost's name goes, and whether the view was moved.
    status() {
      const current = state;
      if (!current) return null;
      const tick = current.tick ?? 0;
      const runs = current.runs.map((run, index) => {
        run.maps.place ??= alignByPlace(current.track, run.track);
        return {id: run.id, label: run.label, color: colorOf(index + 1), time: run.time, gap: gapAt(current.track, run.track, run.maps.place, tick)};
      });
      let labels = [];
      try { labels = current.scene?.labels(innerWidth, innerHeight) ?? []; } catch { /* none this frame */ }
      return {active: !!current.renderer, played: {color: colorOf(0), time: current.track?.time ?? null}, runs, loading: current.loading.slice(),
        sync: current.sync, focus: current.focus, pending: current.pending?.split('|')[0] ?? null, adjusted: current.adjusted, labels};
    },
    destroy() { close(); },
  };
}
