// Replays play in Surfd's own player (the transport behind its replay bar):
// playback, seeking, speed, frame steps, stage jumps and the timeline's
// markers are the game's. This adds what it lacks: watching your saved runs
// (and a given ramp in them, your PB or the WR), ramp boards and savelocs on
// the timeline, savelocs that become practice savelocs, and a status the
// optional custom replay bar renders. Replays the game starts itself
// (leaderboard, record route, server) are taken over the same way.
import {formatTime} from './hud-model.js';
import {bindLabel, savelocBinds} from './key-names.js';
import {createCoachingFrames} from './replay-frames.js';
import {feedbackApplies, routeBoards} from './replay-store.js';
import {mapKey} from './run-history.js';

// The game's playback speeds.
export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
export const MAX_SPOTS = 20;
const NOTICE_MS = 4000;
// Bars cache annotation geometry by identity, including while it is suppressed.
const EMPTY_MARKS = Object.freeze([]);
// The game keeps this many savelocs per bank, dropping the oldest.
const BANK_SIZE = 20;
// The furthest a seek may skip ahead to a keyframe the analysis then steps to.
const CATCH_UP_TICKS = 256;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const idle = work => typeof requestIdleCallback === 'function' ? requestIdleCallback(work, {timeout: 1000}) : setTimeout(work, 0);
// Only settings that change collected analysis, not its presentation or colours.
const ANALYSIS_SETTINGS = ['hud', 'zen', 'showBoard', 'showAir', 'showSurf', 'showStart', 'continuousFeedback', 'strafeLookbackSeconds'];

// getRun(id) returns the stored run (its checkpoint ticks) for a run shown in the UI.
// grade is an owned ramp-reference consumer, released while the timeline is hidden.
// teach: {due(), done()} says when to explain that replay locs become practice savelocs.
// rampNumber(mapKey, rampKey) numbers ramp boards the way the Runs view does.
// coaching: {save(), restore(state), reset(commandIndex)} is the HUD's analysis.
// Missing native keyframes reset with a replay gap; only coherent playback is cached.
// boardsFor({replay, session, analysis, isCurrent}) acquires the analysis of a
// replay you didn't record (a store handle: {result, promise, release}), whose
// ramp boards then mark the timeline; analysis {key, entry} names a PB/WR.
// ghosts() is true while other runs play alongside this one: the timeline's
// touches and locs are this run's alone, so they and saving step aside.
export function createReplayControl({getAdapter, getSession, archive, getMapName = () => null, getRun = null, onSpots = null,
  grade = null, teach = null, rampNumber = null, coaching = null, boardsFor = null, settings = {}, clock = () => performance.now(), ghosts = () => false}) {
  let watching = null, notice = null, requestVersion = 0, starting = null, destroyed = false, visible = false, wrapped = null;
  let detached = null, watches = 0;
  const analysisSettings = ANALYSIS_SETTINGS.map(key => settings[key]);
  // Replay moments waiting to become practice savelocs: they are filed into
  // the bank of the game you return to, so they always load there.
  let pending = [];
  const hooks = () => getAdapter?.()?.replay ?? null;
  const player = () => { try { return hooks()?.transport?.() ?? null; } catch { return null; } };
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
  const samePlayer = (watched, t) => watched?.replay === t?.replay && watched.transport === t && watched.revision === t?.revision;
  // The player while it plays this replay, else null.
  const playing = watched => {
    const t = player();
    return t && watched && getSession?.() === watched.session && t.replay === watched.replay &&
      (!t.host?.session || t.host.session() === watched.session) && t === watched.transport && t.revision === watched.revision ? t : null;
  };

  // A seek in the game's player restores a keyframe with restorePractice and
  // steps on from it: put the HUD's analysis back to that same tick, or clear
  // it when it wasn't kept, rather than show values from before the seek.
  function uninstall() {
    if (!wrapped) return;
    if (wrapped.prototype.restorePractice === wrapped.wrapper) wrapped.prototype.restorePractice = wrapped.original;
    wrapped = null;
  }
  function install() {
    const prototype = getAdapter?.()?.Session?.prototype;
    if (destroyed || !coaching || typeof prototype?.restorePractice !== 'function' || wrapped?.prototype === prototype) return;
    uninstall();
    const original = prototype.restorePractice;
    const wrapper = function (snapshot) {
      // A forward step or slow drag across a keyframe restores it rather than
      // stepping there, and paused playback never kept it. Step the few ticks
      // up to it first: the analysis runs through them and keeps that frame,
      // instead of resetting for the rest of the replay.
      const ahead = watching;
      if (ahead && this === ahead.session && ahead.coherent) {
        const from = (this.state?.tick ?? 0) - ahead.base, to = (snapshot?.state?.tick ?? NaN) - ahead.base;
        if (Number.isInteger(from) && Number.isInteger(to) && to > from && to - from <= CATCH_UP_TICKS && !ahead.frames.has(to)) {
          try { for (let index = from; index < to; index++) this.step(ahead.replay.commands[index]); }
          catch { /* the restore below still applies */ }
        }
      }
      const restored = original.apply(this, arguments);
      const watched = watching;
      if (restored && watched && this === watched.session) {
        const tick = (this.state?.tick ?? 0) - watched.base;
        watched.coherent = watched.frames.restore(tick);
        if (!watched.coherent) {
          try { coaching.reset?.(tick); } catch { /* analysis restarts on its own */ }
          watched.coherent = tick === 0;
        }
      }
      return restored;
    };
    prototype.restorePractice = wrapper;
    wrapped = {prototype, original, wrapper};
  }
  function watch(replay, session, details) {
    detached = null;
    const transport = player();
    install();
    // Spots are bookmarks in this replay (a saveloc for watching): saved for
    // your own runs through onSpots, kept until you leave for anyone else's.
    const watched = watching = {id: ++watches, replay, session, transport, revision: transport?.revision, length: replay.commands.length, dt: session.config?.dt ?? 0.015,
      start: null, markers: [], boards: [], spots: [], lastSpot: null, run: null,
      ramps: [], rampsKey: '', nativeMarkers: null, base: replay.initialState?.tick ?? 0, coherent: true,
      frames: createCoachingFrames(coaching ?? {save() {}, restore() {}}), ...details};
    const tick = (session.state?.tick ?? 0) - watched.base;
    watched.coherent = tick === 0;
    try { coaching?.reset?.(tick); } catch { /* analysis restarts on its own */ }
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
    const session = getSession?.(), t = player();
    const replay = t?.replay;
    const nativeSession = !t?.host?.session || t.host.session() === session;
    if (detached && !samePlayer(detached, t)) detached = null;
    if (watching && (session !== watching.session || !samePlayer(watching, t) || !nativeSession)) {
      // Session replacement without native open/close is not another Watch.
      // Do not attach an old player to a new live session.
      if (session !== watching.session && samePlayer(watching, t))
        detached = {replay, transport: t, revision: t?.revision};
      leave(watching);
      watching = null;
      grade?.release?.();
    }
    if (!watching && session && !replay) file();
    if (!watching && session && nativeSession && !detached) {
      // A replay the game started itself (someone else's run): augment it.
      if (replay && Array.isArray(replay.commands)) {
        let name = null;
        try { name = getMapName?.(); } catch { /* optional */ }
        watch(replay, session, {title: `Watching a replay${name ? ` on ${name}` : ''}`});
      }
    }
    return watching;
  }
  // Someone else's run has no recorded ticks: the game's index marks its start
  // and checkpoints as it reads the replay.
  function marks(watched) {
    if (watched.run) return;
    const native = playing(watched)?.index?.markers;
    if (!Array.isArray(native) || native === watched.nativeMarkers) return;
    watched.nativeMarkers = native;
    watched.start = native.find(marker => marker.kind === 'start')?.index ?? null;
    watched.markers = native.filter(marker => marker.kind === 'checkpoint').map(marker => marker.index).filter(Number.isInteger);
  }
  // Anyone else's run (or your PB) gets its ramp boards from the analysis the
  // PB/WR comparisons use. It starts once the game has indexed the replay, so
  // it never competes with that, runs in idle time and is saved, so watching
  // the replay again shows them at once.
  function analyse(watched) {
    if (watched.run || watched.analysing || watched.boards.length || !boardsFor || !playing(watched)?.index?.complete) return;
    watched.analysing = true;
    // Naming an unknown replay reads all of it: that waits for idle time too.
    idle(() => { if (!destroyed && watching === watched) acquire(watched); });
  }
  function acquire(watched) {
    let handle = null;
    try {
      handle = boardsFor({replay: watched.replay, session: watched.session, analysis: watched.analysis ?? null,
        isCurrent: () => !destroyed && watching === watched});
    } catch { return; }
    if (!handle) return;
    watched.handle = handle;
    const publish = result => {
      if (watched.handle !== handle) return;
      leave(watched);
      if (watching !== watched || !feedbackApplies(result, watched.session)) return;
      const length = end(watched);
      watched.boards = routeBoards(result).filter(ramp => ramp.tick <= length);
      watched.rampsKey = '';
    };
    if (handle.result) publish(handle.result);
    else handle.promise.then(publish, () => leave(watched));
  }
  function leave(watched) {
    const handle = watched?.handle;
    if (!handle) return;
    watched.handle = null;
    try { handle.release(); } catch { /* released with the store */ }
  }
  // Ramp boards on the timeline: recorded during your own runs, analysed for others.
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
    const number = ramp => { try { return rampNumber?.(watched.run?.mapKey ?? mapKey(watched.session.map), ramp.key) ?? null; } catch { return null; } };
    return watched.ramps = list.map(ramp => ({tick: ramp.tick, label: number(ramp) ? `Ramp ${number(ramp)}` : 'Ramp', board: ramp.board, tone: tone(ramp)}));
  }
  const end = watched => Math.max(0, Math.min(watched.length, playing(watched)?.index?.end ?? watched.length));
  function position(watched = current()) {
    const t = playing(watched);
    if (!t) return 0;
    try { return Math.max(0, Math.min(t.host.position(), end(watched))); } catch { return 0; }
  }
  function seek(index) {
    const watched = current(), t = playing(watched);
    if (!t || !Number.isFinite(index)) return false;
    t.requestSeek(Math.max(0, Math.min(end(watched), Math.round(index))));
    t.applyPending();
    return true;
  }
  // The game seeks only as far as it has indexed the replay; a jump right
  // after Watch waits for it.
  async function reach(watched, tick, owned) {
    // Native indexing owns its watchdog/fallback; wait while this jump owns
    // playback instead of timing out before the worker fallback can run.
    for (;;) {
      const t = playing(watched);
      if (!t || !owned()) return false;
      if (t.index?.complete && tick > end(watched)) return false;
      if ((t.index?.reachable ?? 0) >= tick) return seek(tick);
      await wait(50);
    }
  }
  // In a community room a loc goes to the room's shared list instead of the local bank.
  function share(entry, native, destination) {
    return entry.mapId === destination?.mapId && entry.mapVersion === destination.mapVersion
      && native?.shareSnapshot?.(entry.snapshot) === true;
  }
  // File once into native Restart's authoritative practice bank, even if Exit
  // retains a legacy replay Session. Rebase only the key and the start
  // position: loading a saveloc restores its start position, and a replay's
  // session has none of yours, so the loc carries the one Restart would use.
  function file() {
    if (!pending.length) return;
    const native = practice(), store = native?.store?.(), destination = native?.destination?.();
    if (typeof destination?.key !== 'string') return;
    const {key, mapId, mapVersion} = destination;
    const start = destination.startPosition !== undefined ? {startPosition: destination.startPosition} : {};
    pending = pending.filter(entry => {
      if (entry.mapId !== mapId || entry.mapVersion !== mapVersion) return true;
      if (share(entry, native, destination)) return false;
      if (!(store?.banks instanceof Map)) return true;
      const bank = store.banks.get(key) ?? {entries: [], selected: null};
      if (bank.entries.length >= BANK_SIZE) bank.entries.shift();
      const id = store.nextId++;
      bank.entries.push({id, snapshot: {...entry.snapshot, key, ...start}});
      bank.selected = id;
      store.banks.set(key, bank);
      store.revision++;
      return false;
    });
  }
  // Captures this moment of the replay for practice; null once the run has finished.
  // The entry, or why there is none: 'finished' or 'outdated'.
  function capture(watched, tick) {
    // While the game plays this replay its session sits exactly on the cursor.
    if (!(practice()?.store?.() instanceof Object) || !playing(watched)) return 'finished';
    const mapId = watched.session.map?.id, mapVersion = watched.session.map?.version;
    // A replay of an older version of the map plays on that version, but you
    // practise on the current one: its locations would never load.
    let destination = null;
    try { destination = practice().destination?.() ?? null; } catch { /* checked again when filing */ }
    if (destination && destination.mapId === mapId && destination.mapVersion !== mapVersion) return 'outdated';
    let snapshot = null;
    try { snapshot = watched.session.capturePractice?.() ?? null; } catch { /* unsupported */ }
    if (!snapshot) return 'finished';
    // One loc per moment: saving the same tick again replaces it.
    const entry = {mapId, mapVersion, snapshot, watch: watched.id, tick};
    pending = pending.filter(other => other.watch !== watched.id || other.tick !== tick);
    if (share(entry, practice(), destination)) entry.shared = true;
    else pending = [...pending, entry].slice(-BANK_SIZE);
    return entry;
  }
  function persist(watched) {
    if (watched.run) { try { onSpots?.(watched.run.id, watched.spots.slice()); } catch { /* optional */ } }
  }

  async function startPlayback(load, details, label, {navigation = null, isCurrent = () => true} = {}) {
    if (destroyed) return false;
    const request = ++requestVersion, previousSession = getSession?.(), replay = hooks();
    const previousMap = previousSession?.map, mapId = previousMap?.id, mapVersion = previousMap?.version;
    const owner = getAdapter?.()?.getReferences?.()?.ownerKey;
    const contextCurrent = () => getAdapter?.()?.getReferences?.()?.ownerKey === owner;
    if (!replay?.watch) throw new Error('Replays aren’t supported by this version of Surfd.');
    // Reserve the game's Watch generation before either archive or network I/O.
    // Native Watch buttons reserve the same generation before their downloads.
    const token = replay.reserve();
    const owned = () => !destroyed && request === requestVersion && hooks() === replay && replay.isCurrent(token) && contextCurrent();
    const intent = starting = {replay, token, adopting: false};
    try {
      const data = await load(owned);
      // Session identity still rejects an actual map/context change while loading.
      if (!owned() || getSession?.() !== previousSession || previousSession?.map?.id !== mapId ||
        previousSession?.map?.version !== mapVersion || !isCurrent()) return false;
      if (!data) {
        if (navigation) return false;
        throw new Error('This run’s replay is no longer available.');
      }
      const destination = typeof navigation === 'function' ? navigation(data) : navigation;
      const dt = data.config?.dt ?? previousSession?.config?.dt ?? 0.015;
      if (navigation && (!destination || !Number.isInteger(destination.tick) || destination.tick < 0 ||
        destination.tick > data.commands.length || !Number.isFinite(dt) || dt <= 0 ||
        !Number.isFinite(destination.leadSeconds) || destination.leadSeconds < 0)) return false;
      intent.adopting = true;
      await replay.watch(data, label, () => owned() && isCurrent(), token);
      if (!owned()) return false;
      const session = getSession?.();
      if (!isCurrent(session)) return false;
      if (!session || replay.playback()?.replay !== data) {
        if (!isCurrent()) return false;
        throw new Error('The replay didn’t start.');
      }
      const watched = watch(data, session, typeof details === 'function' ? details(data) : details);
      // Ordinary Watch plays from the very start, prestrafe included.
      if (!destination) return true;
      const t = playing(watched);
      t?.pause();
      const target = Math.max(0, destination.tick - Math.round(destination.leadSeconds / dt));
      if (!await reach(watched, target, () => owned() && watching === watched && isCurrent(session))) return false;
      if (!destination.paused) playing(watched)?.play();
      return true;
    } finally {
      if (starting === intent) starting = null;
    }
  }

  return {
    // True when this game build exposes playback and the run's replay was kept.
    canWatch: run => !destroyed && !!hooks()?.watch && !!run?.replay && !!archive?.has(run.id),
    watch(shown, {rampKey, leadSeconds = 0.5, paused = true, isCurrent} = {}) {
      const run = getRun?.(shown.id) ?? shown;
      const recordedOffset = run.replay?.offset ?? 0;
      let offset = recordedOffset;
      const board = rampKey == null ? null : run.boards?.find(([, , key]) => key === rampKey);
      const navigation = rampKey == null ? null : () => board && Number.isInteger(board[0]) && board[0] >= offset
        ? {tick: board[0] - offset, leadSeconds, paused} : null;
      return startPlayback(async () => {
        const data = await archive.get(run.id);
        offset = archive.offset?.(run.id) ?? recordedOffset;
        return data;
      }, data => ({
        title: `Your run on ${run.mapName} · ${run.outcome === 'finished' ? `finished in ${formatTime(run.time)}` : `reset at ${formatTime(run.time)}`}${run.practice ? ' · practice' : ''}`,
        start: Math.max(0, Math.min((run.replay.start ?? 0) + recordedOffset - offset, data.commands.length)),
        markers: (run.checkpoints ?? []).map(checkpoint => checkpoint.command - offset).filter(tick => Number.isInteger(tick) && tick >= 0 && tick <= data.commands.length),
        // [tick, board loss, ramp key] for each board of the run.
        boards: (run.boards ?? []).map(([tick, board, key]) => ({tick: tick - offset, board, key})).filter(ramp => Number.isInteger(ramp.tick) && ramp.tick >= 0 && ramp.tick <= data.commands.length),
        spots: (run.spots ?? []).filter(tick => Number.isInteger(tick) && tick >= 0 && tick <= data.commands.length).slice(0, MAX_SPOTS),
        run: {id: run.id, mapKey: run.map},
      }), 'saved run', {navigation, isCurrent});
    },
    watchLoaded(load, {title, navigation = null, isCurrent, analysis = null} = {}) {
      return startPlayback(load, {title, analysis}, 'leaderboard replay', {navigation, isCurrent});
    },
    setVisible(next) {
      const shown = !destroyed && !!next;
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
      leave(watching);
      watching = null;
      detached = null;
      pending = [];
      notice = null;
      uninstall();
      grade?.destroy?.();
    },
    // Adopt native Watch before metrics.begin, including the very first tick.
    observe(session) { if (session === getSession?.()) current(); },
    // After each tick of the watched replay: keep the HUD's analysis at keyframe ticks.
    tick(session) {
      const watched = watching;
      if (!watched || session !== watched.session || !coaching || !watched.coherent ||
        settings.hud === false || settings.zen === true) return;
      if (settings.showBoard !== false || settings.showAir !== false || settings.showSurf !== false || settings.showStart !== false)
        watched.frames.keep((session.state?.tick ?? 0) - watched.base);
    },
    // Called after settings are applied, never from the per-tick hot path: analysis
    // kept under other settings no longer matches what the HUD collects.
    settingsChanged() {
      let changed = false;
      for (let i = 0; i < ANALYSIS_SETTINGS.length; i++) {
        const value = settings[ANALYSIS_SETTINGS[i]];
        if (analysisSettings[i] !== value) { analysisSettings[i] = value; changed = true; }
      }
      if (changed && watching) {
        watching.frames.clear();
        watching.coherent = position(watching) === 0;
        try { coaching?.reset?.(position(watching)); } catch { /* analysis restarts on its own */ }
      }
    },
    get active() { return !!current(); },
    // Protect an owned UI handoff from the native menu-hiding observer until
    // Watch has started and sought the new replay.
    get adopting() { return !destroyed && !!starting?.adopting &&
      hooks() === starting.replay && starting.replay.isCurrent(starting.token); },
    status() {
      const watched = current();
      if (!watched) return null;
      marks(watched);
      analyse(watched);
      const t = playing(watched);
      const length = end(watched);
      if (length < watched.length && watched.boundedEnd !== length) {
        watched.boundedEnd = length;
        watched.markers = watched.markers.filter(tick => tick <= length);
        watched.boards = watched.boards.filter(ramp => ramp.tick <= length);
        watched.spots = watched.spots.filter(tick => tick <= length);
        if (watched.lastSpot > length) watched.lastSpot = null;
        watched.rampsKey = '';
      }
      let ended = true, speed = 1, paused = true, parked = false, reachable = 0;
      try {
        if (t) {
          ended = t.atEnd(); paused = t.paused; speed = t.clock?.speed ?? 1;
          parked = !!t.host?.parked?.(); reachable = t.index?.reachable ?? 0;
        }
      } catch { /* the player changed shape */ }
      let others = false;
      try { others = ghosts() === true; } catch { /* none */ }
      return {
        title: watched.title, index: position(watched), length, start: Math.min(watched.start ?? 0, length), dt: watched.dt, ghosts: others,
        playing: !!t && !paused && !ended, ended, speed, parked, reachable,
        indexed: t?.index?.indexed ?? reachable, complete: t?.index?.complete ?? false,
        markers: watched.markers, ramps: others ? EMPTY_MARKS : ramps(watched),
        spots: others ? EMPTY_MARKS : watched.spots, lastSpot: others ? null : watched.lastSpot,
        notice: notice && clock() - notice.at < NOTICE_MS ? notice.text : '', run: watched.run,
      };
    },
    play() { playing(current())?.play(); },
    pause() { playing(current())?.pause(); },
    toggle() { playing(current())?.toggle(); },
    seek,
    // skip() moves by seconds; step() moves by ticks and pauses; stage() jumps a stage or checkpoint.
    skip(seconds) { playing(current())?.seekBy(seconds); },
    step(ticks) { playing(current())?.stepTick(ticks); },
    stage(direction) { playing(current())?.stage(direction); },
    setSpeed(next) { if (SPEEDS.includes(next)) playing(current())?.setSpeed(next); },
    faster() { playing(current())?.shiftSpeed(1); },
    slower() { playing(current())?.shiftSpeed(-1); },
    exit() { playing(current())?.host?.exit?.(); },
    returnToServer() { playing(current())?.host?.returnToServer?.(); },
    // Saves the current tick as a spot, also kept for practice; false when there is no room.
    saveSpot() {
      const watched = current();
      try { if (ghosts() === true) return false; } catch { /* saving as usual */ }
      if (!watched) return false;
      const tick = position(watched);
      if (!watched.spots.includes(tick)) {
        if (watched.spots.length >= MAX_SPOTS) { say(`You can keep up to ${MAX_SPOTS} locations in a replay; delete one first.`); return false; }
        watched.spots = [...watched.spots, tick].sort((a, b) => a - b);
        persist(watched);
      }
      const saved = `Saved location #${watched.spots.indexOf(tick) + 1} · ${formatTime(watched.session.timer?.state?.elapsed ?? 0)}.`;
      const captured = practice()?.store ? capture(watched, tick) : null;
      watched.lastSpot = tick;
      // The room reports a shared save with its room-wide number.
      if (captured?.shared) return true;
      if (!captured) say(saved);
      else if (captured === 'finished') say(`${saved} The run has finished here, so it can’t be practiced.`);
      else if (captured === 'outdated') say(`${saved} This replay is from an older version of the map, so it can’t be practiced.`);
      else if (due()) {
        const keys = bindLabel(binds().load);
        say(`${saved} It’s added to your practice locations when you leave the replay${keys ? `; ${keys} loads it` : ''}.`);
        try { teach?.done?.(); } catch { /* shown again next time */ }
      } else say(saved);
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
      // Nor does it become a practice location.
      pending = pending.filter(entry => entry.watch !== watched.id || entry.tick !== tick);
      persist(watched);
    },
  };
}
