// Playback control for any replay the game plays: your saved runs, which we
// start, and leaderboard runs, the record route and server replays, which the
// game starts from its own Watch buttons and we take over. Speed and pause
// scale the frame time the game's fixed stepper receives, so physics still
// advances in whole native ticks, and playback holds on the last frame instead
// of dropping to the game's menu. Seeking re-simulates the deterministic
// replay to the target tick (adapter.replay.seek), from the nearest snapshot
// playback and earlier seeks kept (replay-frames.js).
import {formatTime} from './hud-model.js';
import {bindLabel, savelocBinds} from './key-names.js';
import {createFrames} from './replay-frames.js';

export const SPEEDS = [0.25, 0.5, 1, 2, 4];
const MAX_FRAME = 0.25;
export const MAX_SPOTS = 20;
const NOTICE_MS = 4000;
// The game keeps this many savelocs per bank, dropping the oldest.
const BANK_SIZE = 20;
// Only settings that change collected analysis, not its presentation or colours.
const ANALYSIS_SETTINGS = ['hud', 'showBoard', 'showAir', 'showSurf', 'showStart',
  'continuousFeedback', 'strafeLookbackSeconds'];

// getRun(id) returns the stored run (its checkpoint ticks) for a run shown in the UI.
// grade is an owned ramp-reference consumer, released while the timeline is hidden.
// coaching: {save(), restore(state)} keeps HUD analysis with native replay frames.
// teach: {due(), done()} says when to explain that replay locs become practice savelocs.
// rampNumber(mapKey, rampKey) numbers ramp boards the way the Runs view does.
export function createReplayControl({getAdapter, getSession, archive, getMapName = () => null, getRun = null, onSpots = null,
  grade = null, coaching = null, settings = {}, teach = null, rampNumber = null, clock = () => performance.now()}) {
  let watching = null, speed = 1, paused = false, installed = null, notice = null;
  let requestVersion = 0, starting = null, destroyed = false, visible = false;
  let enabled = settings.replayControls !== false;
  const analysisSettings = ANALYSIS_SETTINGS.map(key => settings[key]);
  // Replay moments waiting to become practice savelocs: they are filed into
  // the bank of the game you return to, so they always load there.
  let pending = [];
  const replaySessions = new WeakSet();
  const hooks = () => getAdapter?.()?.replay ?? null;
  const practice = () => getAdapter?.()?.practice ?? null;
  // Messages go to the game's own notice line, like its saveloc messages.
  const say = text => {
    try {
      const adapter = getAdapter?.();
      if (typeof adapter?.notice === 'function') { adapter.notice(text); return; }
    } catch { /* shown on the bar instead */ }
    notice = {text, at: clock()};
  };
  const binds = () => {
    let bindings = null;
    try { bindings = getAdapter?.()?.getBindings?.(); } catch { /* defaults */ }
    return savelocBinds(bindings);
  };
  const due = () => { try { return teach?.due?.() !== false; } catch { return true; } };

  // Wraps the stepper class once; only the game's main stepper, while it plays
  // the replay being watched, is ever scaled.
  function uninstall() {
    if (!installed) return;
    const {prototype, original, wrapper} = installed;
    if (prototype.advance === wrapper) prototype.advance = original;
    installed = null;
  }
  function install(replay) {
    if (destroyed || !replay?.Stepper || installed?.prototype === replay.Stepper.prototype) return;
    uninstall();
    const prototype = replay.Stepper.prototype, original = prototype.advance;
    const wrapper = function (seconds, tick, ...rest) {
      const watched = watching, playback = hooks()?.playback?.();
      if (watched && Number.isFinite(seconds) && this === hooks()?.stepper?.() && playback?.replay === watched.replay) {
        seconds = paused ? 0 : Math.min(MAX_FRAME, seconds * speed);
        // Hold on the last frame: past it the game leaves the replay for its menu.
        const left = watched.length - playback.index;
        if (left <= 0) { paused = true; seconds = 0; }
        else seconds = Math.min(seconds, (left + 0.5) * (this.dt ?? watched.dt) - (this.accumulator ?? 0));
        const step = tick;
        tick = function () {
          const result = step.apply(this, arguments), index = hooks()?.playback?.()?.index;
          if (!watched.analysisDirty) watched.frames.keep(watched.session, index);
          if (index >= watched.length) paused = true;
          return result;
        };
      }
      return original.call(this, seconds, tick, ...rest);
    };
    prototype.advance = wrapper;
    installed = {prototype, original, wrapper};
  }
  function watch(replay, session, details) {
    speed = 1;
    paused = false;
    replaySessions.add(session);
    // Spots are bookmarks in this replay (a saveloc for watching): saved for
    // your own runs through onSpots, kept until you leave for anyone else's.
    const watched = watching = {replay, session, length: replay.commands.length, dt: session.config?.dt ?? 0.015,
      start: null, markers: [], boards: [], spots: [], lastSpot: null, run: null, frames: createFrames(replay, coaching), analysisDirty: false,
      ramps: [], rampsKey: '', publishedMarkers: null, ...details};
    if (!watched.boards.length) grade?.release?.();
    if (practice()?.store && due()) {
      const keys = bindLabel(binds().save);
      say(keys ? `Press ${keys} to save a moment of this replay as a practice location.`
        : 'Bind Save position in Controls to save moments of a replay as practice locations.');
    }
    return watched;
  }
  function current() {
    if (destroyed) return null;
    const session = getSession?.();
    if (watching && session !== watching.session) { watching = null; grade?.release?.(); }
    if (!watching && session && !hooks()?.playback?.()?.replay) file(session);
    if (!enabled) return null;
    if (!watching && session) {
      // A replay the game started itself (someone else's run): take it over.
      const replay = hooks()?.playback?.()?.replay;
      if (replay && Array.isArray(replay.commands)) {
        install(hooks());
        let name = null;
        try { name = getMapName?.(); } catch { /* optional */ }
        watch(replay, session, {title: `Watching a replay${name ? ` on ${name}` : ''}`, learn: true});
      }
    }
    return watching;
  }
  // Someone else's run has no recorded start or checkpoint ticks: read them off
  // the game's timer as playback passes them.
  function learn(watched) {
    const timer = watched.session.timer?.state;
    if (!watched.learn || !timer || timer.phase === 'ready' || !Number.isFinite(timer.startTick)) return;
    const clamp = value => Math.max(0, Math.min(watched.length, value));
    watched.start = clamp(Math.floor(timer.startTick) - (watched.replay.initialState?.tick ?? 0));
    timer.splits?.forEach((split, index) => {
      if (!Number.isFinite(split)) return;
      const tick = clamp(watched.start + Math.round(split / watched.dt));
      if (watched.markers[index] !== tick) {
        watched.markers[index] = tick;
        watched.publishedMarkers = null;
      }
    });
  }
  // Ramp boards on the timeline, recorded during your own runs.
  function ramps(watched) {
    const list = watched.boards;
    if (!visible || !list.length) grade?.release?.();
    let version = 0;
    try { version = grade?.version?.() ?? 0; } catch { /* uncoloured */ }
    const key = `${visible}:${list.length}:${list.at(-1)?.board}:${version}`;
    if (watched.rampsKey === key) return watched.ramps;
    watched.rampsKey = key;
    const tone = ramp => { try { return visible ? grade?.tone?.(ramp.key, ramp.board) ?? 'muted' : 'muted'; } catch { return 'muted'; } };
    // A board off the map's route (a repeat visit or another line) has no number.
    const number = ramp => { try { return rampNumber?.(watched.run?.mapKey, ramp.key) ?? null; } catch { return null; } };
    return watched.ramps = list.map(ramp => ({tick: ramp.tick, label: number(ramp) ? `Ramp ${number(ramp)}` : 'Ramp', board: ramp.board, tone: tone(ramp)}));
  }
  function position() {
    const watched = current();
    if (!watched) return 0;
    const playback = hooks()?.playback?.();
    // Stopped (Esc), the session may keep stepping on live input; the cursor
    // still says where the replay stopped.
    return Math.max(0, Math.min(Number.isFinite(playback?.index) ? playback.index : watched.length, watched.length));
  }
  function seek(index) {
    const watched = current();
    if (!watched) return false;
    const replay = hooks(), target = Math.max(0, Math.min(watched.length, Math.round(index)));
    // Clearing snapshots alone would let forward seeks reuse the current
    // analyzer state. Reload through the native hook so its observer resets
    // both coaching controllers, without taking ownership from another replay.
    if (watched.analysisDirty) {
      if (replay?.seek?.(watched.replay, 0, watched.frames) !== true) return false;
      watched.analysisDirty = false;
      if (!target) return true;
    }
    return replay?.seek?.(watched.replay, target, watched.frames) === true;
  }
  // Files pending moments into a live session's bank, the way the game's own
  // Save position does; the last one filed becomes the selected saveloc.
  // A saveloc is only position, speed, view and timer, so a replay made under
  // older rules still practices fine under today's.
  function file(session) {
    if (!pending.length || replaySessions.has(session) || typeof session.practiceKey !== 'function') return;
    const store = practice()?.store?.();
    if (!(store?.banks instanceof Map)) return;
    const key = session.practiceKey();
    pending = pending.filter(entry => {
      if (entry.mapId !== session.map?.id || entry.mapVersion !== session.map?.version) return true;
      const bank = store.banks.get(key) ?? {entries: [], selected: null};
      if (bank.entries.length >= BANK_SIZE) bank.entries.shift();
      const id = store.nextId++;
      bank.entries.push({id, snapshot: {...entry.snapshot, key}});
      bank.selected = id;
      store.banks.set(key, bank);
      store.revision++;
      return false;
    });
  }
  // The session must sit exactly on the replay cursor before it is captured.
  function settle(watched) {
    if (hooks()?.playback?.()?.replay === watched.replay) return true;
    paused = true;
    return seek(position());
  }
  // Captures this moment of the replay for practice; null once the run has finished.
  function capture(watched) {
    if (!(practice()?.store?.() instanceof Object) || !settle(watched)) return null;
    let snapshot = null;
    try { snapshot = watched.session.capturePractice?.() ?? null; } catch { /* unsupported */ }
    if (!snapshot) return null;
    const entry = {mapId: watched.session.map?.id, mapVersion: watched.session.map?.version, snapshot};
    pending = [...pending, entry].slice(-BANK_SIZE);
    return entry;
  }
  function persist(watched) {
    if (watched.run) { try { onSpots?.(watched.run.id, watched.spots.slice()); } catch { /* optional */ } }
  }
  const playing = () => !!current() && !paused && hooks()?.playback?.()?.replay === watching.replay;

  async function startPlayback(load, details, label) {
    if (destroyed || !enabled) return;
    const request = ++requestVersion, previousSession = getSession?.(), replay = hooks();
    if (!replay?.watch) throw new Error('Replays aren’t supported by this version of Surfd.');
    // Reserve the game's Watch generation before either archive or network I/O.
    // Native Watch buttons reserve the same generation before their downloads.
    const token = replay.reserve();
    const owned = () => !destroyed && enabled && request === requestVersion && hooks() === replay && replay.isCurrent(token);
    const intent = starting = {replay, token};
    try {
      const data = await load();
      // Session identity still rejects an actual map/context change while loading.
      if (!owned() || getSession?.() !== previousSession) return;
      if (!data) throw new Error('This run’s replay is no longer available.');
      install(replay);
      await replay.watch(data, label, owned, token);
      if (!owned()) return;
      const session = getSession?.();
      if (!session || replay.playback()?.replay !== data) throw new Error('The replay didn’t start.');
      watch(data, session, typeof details === 'function' ? details(data) : details);
      // Retain the prestrafe, including when replaying after the end.
      seek(0);
    } finally {
      if (starting === intent) starting = null;
    }
  }

  return {
    setEnabled(next) {
      if (destroyed || enabled === !!next) return;
      enabled = !!next;
      if (enabled) return;
      requestVersion++;
      if (starting?.replay.isCurrent(starting.token)) starting.replay.reserve();
      starting = null;
      watching = null;
      notice = null;
      visible = false;
      uninstall();
      grade?.release?.();
      // Already saved practice captures still file when native playback ends.
    },
    // Called after settings are applied, never from the per-tick hot path.
    settingsChanged() {
      this.setEnabled(settings.replayControls !== false);
      let changed = false;
      for (let i = 0; i < ANALYSIS_SETTINGS.length; i++) {
        const value = settings[ANALYSIS_SETTINGS[i]];
        if (analysisSettings[i] !== value) { analysisSettings[i] = value; changed = true; }
      }
      if (!changed || !watching) return;
      watching.frames.clear();
      watching.analysisDirty = true;
    },
    // True when this game build exposes playback and the run's replay was kept.
    canWatch: run => enabled && !destroyed && !!hooks()?.watch && !!run?.replay && !!archive?.has(run.id),
    watch(shown) {
      const run = getRun?.(shown.id) ?? shown;
      const offset = run.replay?.offset ?? 0;
      return startPlayback(() => archive.get(run.id), data => ({
        title: `Your run on ${run.mapName} · ${run.outcome === 'finished' ? `finished in ${formatTime(run.time)}` : `reset at ${formatTime(run.time)}`}${run.practice ? ' · practice' : ''}`,
        start: Math.min(run.replay.start ?? 0, data.commands.length),
        markers: (run.checkpoints ?? []).map(checkpoint => checkpoint.command - offset).filter(tick => Number.isInteger(tick) && tick >= 0),
        // [tick, board loss, ramp key] for each board of the run.
        boards: (run.boards ?? []).map(([tick, board, key]) => ({tick: tick - offset, board, key})).filter(ramp => Number.isInteger(ramp.tick) && ramp.tick >= 0),
        spots: (run.spots ?? []).filter(tick => Number.isInteger(tick) && tick >= 0 && tick <= data.commands.length).slice(0, MAX_SPOTS),
        run: {id: run.id, mapKey: run.map},
      }), 'saved run');
    },
    watchLoaded(load, {title}) {
      return startPlayback(load, {title, learn: true}, 'leaderboard replay');
    },
    setVisible(next) {
      const shown = !destroyed && enabled && !!next;
      if (visible !== shown && watching) watching.rampsKey = '';
      visible = shown;
      if (!visible) grade?.release?.();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      requestVersion++;
      if (starting?.replay.isCurrent(starting.token)) starting.replay.reserve();
      starting = null;
      watching = null;
      pending = [];
      notice = null;
      uninstall();
      grade?.destroy?.();
    },
    get active() { return !!current(); },
    status() {
      const watched = current();
      if (!watched) return null;
      learn(watched);
      const index = position();
      return {
        title: watched.title, index, length: watched.length, start: watched.start ?? 0, dt: watched.dt,
        playing: playing(), ended: index >= watched.length, speed,
        // Published arrays are read-only; marker learning invalidates its copy,
        // and bookmark edits replace their array instead of mutating it.
        markers: watched.publishedMarkers ??= watched.markers.filter(Number.isInteger), ramps: ramps(watched),
        spots: watched.spots, lastSpot: watched.lastSpot,
        notice: notice && clock() - notice.at < NOTICE_MS ? notice.text : '', run: watched.run,
      };
    },
    play() {
      const watched = current();
      if (!watched) return;
      paused = false;
      const index = position();
      if (index >= watched.length) seek(0);
      else if (hooks()?.playback?.()?.replay !== watched.replay) seek(index);
    },
    pause() { if (current()) paused = true; },
    toggle() { if (playing()) this.pause(); else this.play(); },
    seek,
    // skip() moves by seconds; step() moves by ticks and pauses.
    skip(seconds) { const watched = current(); if (watched) seek(position() + seconds / watched.dt); },
    step(ticks) { if (current()) { paused = true; seek(position() + ticks); } },
    setSpeed(next) { if (SPEEDS.includes(next)) speed = next; },
    // Saves the current tick as a spot, also kept for practice; false when there is no room.
    saveSpot() {
      const watched = current();
      if (!watched) return false;
      const tick = position();
      if (!watched.spots.includes(tick)) {
        if (watched.spots.length >= MAX_SPOTS) { say(`You can keep up to ${MAX_SPOTS} locations in a replay; delete one first.`); return false; }
        watched.spots = [...watched.spots, tick].sort((a, b) => a - b);
        persist(watched);
      }
      const saved = `Saved location #${watched.spots.indexOf(tick) + 1} · ${formatTime(watched.session.timer?.state?.elapsed ?? 0)}.`;
      if (!practice()?.store) say(saved);
      else if (!capture(watched)) say(`${saved} The run has finished here, so it can’t be practiced.`);
      else if (due()) {
        const keys = bindLabel(binds().load);
        say(`${saved} It’s added to your practice locations when you leave the replay${keys ? `; ${keys} loads it` : ''}.`);
        try { teach?.done?.(); } catch { /* shown again next time */ }
      } else say(saved);
      watched.lastSpot = tick;
      return true;
    },
    // Jumps to a spot (the last one saved or used when none is given), keeping play or pause.
    goToSpot(tick) {
      const watched = current();
      const target = tick ?? watched?.lastSpot ?? watched?.spots.at(-1);
      if (!watched || !Number.isInteger(target)) return false;
      watched.lastSpot = target;
      return seek(target);
    },
    // Selects the previous or next spot (wrapping) and jumps to it.
    cycleSpot(delta) {
      const watched = current();
      const count = watched?.spots.length ?? 0;
      if (!count) return false;
      const at = watched.spots.indexOf(watched.lastSpot);
      const next = at < 0 ? (delta > 0 ? 0 : count - 1) : (at + delta + count) % count;
      return this.goToSpot(watched.spots[next]);
    },
    removeSpot(tick) {
      const watched = current();
      if (!watched?.spots.includes(tick)) return;
      watched.spots = watched.spots.filter(spot => spot !== tick);
      if (watched.lastSpot === tick) watched.lastSpot = null;
      persist(watched);
    },
    faster() { speed = SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)]; },
    slower() { speed = SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)]; },
  };
}
