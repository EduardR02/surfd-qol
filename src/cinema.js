// Compare: two runs through the map at once, as ghosts with their lines, from
// a planned third-person camera. The first run plays in the game's own replay
// player, so its bar, speeds, seeking and stage jumps all work as usual; the
// second follows it, matched by place (Side by side) or by clock (Real time).
//
// Nothing here runs until open(): no timers, listeners, observers or frame
// work. While open it wraps the game's map renderer and listens for drags on
// the game canvas; close() puts both back.
import {recordTrack} from './cinema-track.js';
import {alignByPlace, alignByTime, gapAt} from './cinema-sync.js';
import {planCamera, shotAt, adjust, viewAngles, FOV} from './cinema-camera.js';
import {createCinemaScene, RUN_COLORS} from './cinema-scene.js';

// Brush contents the camera can see through: player clips, grates, glass.
const SOLID = 0x1, SEE_THROUGH = 0x10000000 | 0x8;
const PROBE = {min: {x: -6, y: -6, z: -6}, max: {x: 6, y: 6, z: 6}};
const DRAG_RADIANS = 0.005;
const ZOOM_STEP = 1.12;
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

// getAdapter() is the game adapter; replayControl starts and watches the
// played run. Each run given to open() is {label, load()} with load() giving a replay.
// record and createScene stand in for the game in tests.
export function createCinema({getAdapter, replayControl, onChange = () => {}, loadIdle = idle, record = recordTrack, createScene = createCinemaScene}) {
  let state = null, request = 0;
  const notify = () => { try { onChange(); } catch { /* UI only */ } };

  async function open(runs) {
    close();
    const id = ++request, adapter = getAdapter?.(), session = adapter?.getSession?.();
    if (!adapter?.cinema?.renderer?.()?.qolScene) throw new Error('Compare isn’t supported by this version of Surfd.');
    if (!session?.map) throw new Error('Load the map first.');
    const current = state = {phase: 'loading', runs: runs.map(({label}) => ({label})), id};
    const owned = () => state === current && request === id;
    notify();
    try {
      const replays = await Promise.all(runs.map(run => run.load()));
      if (!owned()) return false;
      if (replays.some(replay => !replay)) throw new Error('A replay isn’t available.');
      current.phase = 'preparing';
      notify();
      const tracks = [];
      for (const replay of replays) {
        const track = await record({adapter, session, replay, isCurrent: owned, yieldTask: loadIdle});
        if (!owned()) return false;
        if (!track) throw new Error('A run couldn’t be read on this map.');
        tracks.push(track);
      }
      const [a, b] = tracks;
      current.tracks = tracks;
      current.maps = {place: alignByPlace(a, b), time: null};
      current.sync = 'place';
      const world = cameraWorld(session);
      current.trace = world ? (from, to) => {
        const hit = world.trace(from, to, PROBE);
        return hit.startSolid || hit.allSolid ? 1 : Math.max(0, Math.min(1, hit.fraction));
      } : null;
      current.plans = {place: await planCamera({a, b, map: current.maps.place, trace: current.trace, yieldTask: loadIdle, isCurrent: owned}), time: null};
      if (!owned() || !current.plans.place) return false;
      current.times = tracks.map(track => track.time);
      const played = replays[0];
      const started = await replayControl.watchLoaded(async () => played, {title: `${runs[0].label} and ${runs[1].label}`, isCurrent: owned});
      if (!owned() || started === false) return false;
      start(current, played);
      return true;
    } catch (error) {
      if (!owned()) return false;
      close();
      throw error;
    }
  }

  // From here until stop(): the renderer wrap and the canvas listeners.
  function start(current, replay) {
    const adapter = getAdapter(), renderer = adapter.cinema.renderer();
    current.scene = createScene(renderer, current.tracks.map(track => ({track})));
    current.renderer = renderer;
    current.replay = replay;
    current.base = replay.initialState?.tick ?? 0;
    current.view = {yaw: 0, pitch: 0, zoom: 1};
    current.room = Infinity;
    current.shot = {eye: {x: 0, y: 0, z: 0}, target: {x: 0, y: 0, z: 0}};
    current.at = [0, 0];
    current.phase = 'playing';
    const original = renderer.render;
    current.original = original;
    renderer.render = current.wrapper = function (view) {
      try { return original.call(this, frame(current, view) ?? view); }
      catch (error) { if (state === current) queueMicrotask(close); throw error; }
    };
    listen(current);
    notify();
  }

  // The played run's fractional index from the frame's state and interpolation.
  function frame(current, view) {
    const adapter = getAdapter?.(), playback = adapter?.replay?.playback?.();
    if (playback?.replay !== current.replay || getAdapter()?.cinema?.renderer?.() !== current.renderer) { queueMicrotask(close); return null; }
    const [a, b] = current.tracks;
    const tick = Math.max(0, Math.min(a.count - 1, (view.state?.tick ?? current.base) - current.base - 1 + (Number.isFinite(view.qolAlpha) ? view.qolAlpha : 1)));
    const map = current.maps[current.sync], plan = current.plans[current.sync];
    const low = Math.floor(tick), high = Math.min(a.count - 1, low + 1);
    current.at[0] = tick;
    current.at[1] = map[low] + (map[high] - map[low]) * (tick - low);
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
    const width = innerWidth, height = innerHeight;
    // The camera is placed here too so the ghosts fade and size their outlines for this frame's view.
    current.renderer.qolCamera.position.set(shot.eye.x, shot.eye.z, -shot.eye.y);
    current.scene.update(current.at, width, height);
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
      current.adjusted = true;
    };
    const onUp = event => {
      if (!drag || event.pointerId !== drag.id) return;
      event.preventDefault(); event.stopImmediatePropagation();
      drag = null;
      notify();
    };
    const onWheel = event => {
      if (event.target !== canvas || event.ctrlKey) return;
      event.preventDefault(); event.stopImmediatePropagation();
      current.view.zoom = Math.max(0.35, Math.min(3, current.view.zoom * (event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
      current.adjusted = true;
      notify();
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
    if (state?.phase !== 'playing') return;
    state.view = {yaw: 0, pitch: 0, zoom: 1};
    state.adjusted = false;
    state.room = Infinity;
    notify();
  }

  // Real time's alignment and camera are made the first time it is chosen.
  async function setSync(sync) {
    const current = state;
    if (current?.phase !== 'playing' || !['place', 'time'].includes(sync) || current.sync === sync) return;
    if (!current.plans[sync]) {
      const [a, b] = current.tracks;
      current.maps[sync] ??= alignByTime(a, b);
      current.pending = sync;
      notify();
      const plan = await planCamera({a, b, map: current.maps[sync], trace: current.trace, yieldTask: loadIdle, isCurrent: () => state === current});
      if (state !== current || !plan) return;
      current.plans[sync] = plan;
      current.pending = null;
    }
    current.sync = sync;
    notify();
  }

  function stop() {
    const current = state;
    if (!current) return;
    current.unlisten?.();
    if (current.renderer && current.renderer.render === current.wrapper) current.renderer.render = current.original;
    try { current.scene?.dispose(); } catch { /* the map was unloaded with it */ }
    state = null;
  }
  function close() {
    if (!state) return;
    request++;
    stop();
    notify();
  }

  return {
    open,
    close,
    resetView,
    setSync,
    get active() { return state?.phase === 'playing'; },
    // What the UI shows: the phase, both runs (label, colour, time) and, while
    // playing, the gap here, where each ghost's name goes, and whether the view was moved.
    status() {
      const current = state;
      if (!current) return null;
      const runs = current.runs.map((run, index) => ({...run, color: colorOf(index), time: current.times?.[index] ?? null}));
      if (current.phase !== 'playing') return {phase: current.phase, runs};
      const [a, b] = current.tracks;
      // The gap is by place in both modes: in Real time the clocks match by definition.
      const gap = gapAt(a, b, current.maps.place, current.tick ?? 0);
      let labels = [null, null];
      try { labels = current.scene.labels(innerWidth, innerHeight); } catch { /* none this frame */ }
      return {phase: 'playing', runs, sync: current.sync, pending: current.pending ?? null, gap, labels, adjusted: !!current.adjusted};
    },
    destroy() { close(); },
    // For the dev console: the prepared tracks.
    get tracks() { return state?.tracks ?? null; },
  };
}
