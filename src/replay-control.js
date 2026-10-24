// Playback control for any replay the game plays: your saved runs, which we
// start, and leaderboard runs, the record route and server replays, which the
// game starts from its own Watch buttons and we take over. Speed and pause
// scale the frame time the game's fixed stepper receives, so physics still
// advances in whole native ticks. Seeking re-simulates the deterministic
// replay to the target tick (adapter.replay.seek).
import {formatTime} from './hud-model.js';

export const SPEEDS = [0.25, 0.5, 1, 2, 4];
const MAX_FRAME = 0.25;
export const MAX_SPOTS = 20;
const NOTICE_MS = 4000;
// The game keeps this many savelocs per bank, dropping the oldest.
const BANK_SIZE = 20;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createReplayControl({getAdapter, getSession, archive, getMapName = () => null, onSpots = null, clock = () => performance.now()}) {
  let watching = null, speed = 1, paused = false, installed = null, notice = null;
  // Replay moments waiting to become practice savelocs: they are filed into
  // the bank of the game you return to, so they always load there.
  let pending = [];
  const replaySessions = new WeakSet();
  const hooks = () => getAdapter?.()?.replay ?? null;
  const practice = () => getAdapter?.()?.practice ?? null;
  const say = text => { notice = {text, at: clock()}; };

  // Wraps the stepper class once; only the game's main stepper, while it plays
  // the replay being watched, is ever scaled.
  function install(replay) {
    if (!replay?.Stepper || installed === replay.Stepper) return;
    const prototype = replay.Stepper.prototype, original = prototype.advance;
    prototype.advance = function (seconds, ...rest) {
      if (watching && Number.isFinite(seconds) && this === hooks()?.stepper?.() && hooks()?.playback?.()?.replay === watching.replay) {
        seconds = paused ? 0 : Math.min(MAX_FRAME, seconds * speed);
      }
      return original.call(this, seconds, ...rest);
    };
    installed = replay.Stepper;
  }
  function watch(replay, session, details) {
    speed = 1;
    paused = false;
    replaySessions.add(session);
    // Spots are bookmarks in this replay (a saveloc for watching): saved for
    // your own runs through onSpots, kept until you leave for anyone else's.
    return watching = {replay, session, length: replay.commands.length, dt: session.config?.dt ?? 0.015, start: null, markers: [],
      spots: [], lastSpot: null, runId: null, ...details};
  }
  function current() {
    const session = getSession?.();
    if (watching && session !== watching.session) watching = null;
    if (!watching && session && !hooks()?.playback?.()?.replay) file(session);
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
      if (Number.isFinite(split)) watched.markers[index] = clamp(watched.start + Math.round(split / watched.dt));
    });
  }
  function position() {
    const watched = current();
    if (!watched) return 0;
    const playback = hooks()?.playback?.();
    // Stopped (ended or Esc), the session may keep stepping on live input; the
    // cursor still says where the replay stopped.
    return Math.max(0, Math.min(Number.isFinite(playback?.index) ? playback.index : watched.length, watched.length));
  }
  function seek(index) {
    const watched = current();
    if (!watched) return false;
    return hooks()?.seek?.(watched.replay, Math.max(0, Math.min(watched.length, Math.round(index)))) === true;
  }
  const lead = watched => (watched.start ?? 0) - Math.round(1 / watched.dt);
  const practiceState = () => practice()?.store?.() instanceof Object ? 'ok' : 'unavailable';
  // Files pending moments into a live session's bank, the way the game's own
  // Save position does; the last one filed becomes the selected saveloc.
  // A saveloc is only position, speed, view and timer, so a replay made under
  // older rules still practices fine under today's.
  function file(session) {
    if (!pending.length || replaySessions.has(session) || typeof session.practiceKey !== 'function') return null;
    const store = practice()?.store?.();
    if (!(store?.banks instanceof Map)) return null;
    const key = session.practiceKey();
    let id = null;
    pending = pending.filter(entry => {
      if (entry.mapId !== session.map?.id || entry.mapVersion !== session.map?.version) return true;
      const bank = store.banks.get(key) ?? {entries: [], selected: null};
      if (bank.entries.length >= BANK_SIZE) bank.entries.shift();
      id = store.nextId++;
      bank.entries.push({id, snapshot: {...entry.snapshot, key}});
      bank.selected = id;
      store.banks.set(key, bank);
      store.revision++;
      return false;
    });
    return id;
  }
  // The session must sit exactly on the replay cursor before it is captured.
  function settle(watched) {
    if (hooks()?.playback?.()?.replay === watched.replay) return true;
    paused = true;
    return seek(position());
  }
  // Captures this moment of the replay for practice; null once the run has finished.
  function capture(watched) {
    if (practiceState() !== 'ok' || !settle(watched)) return null;
    let snapshot = null;
    try { snapshot = watched.session.capturePractice?.() ?? null; } catch { /* unsupported */ }
    if (!snapshot) return null;
    const entry = {mapId: watched.session.map?.id, mapVersion: watched.session.map?.version, snapshot};
    pending = [...pending, entry].slice(-BANK_SIZE);
    return entry;
  }
  function persist(watched) {
    if (watched.runId) { try { onSpots?.(watched.runId, watched.spots.slice()); } catch { /* optional */ } }
  }
  const playing = () => !!current() && !paused && hooks()?.playback?.()?.replay === watching.replay;

  return {
    // True when this game build exposes playback and the run's replay was kept.
    canWatch: run => !!hooks()?.watch && !!run?.replay && !!archive?.has(run.id),
    async watch(run) {
      const replay = hooks();
      if (!replay?.watch) throw new Error('Replays aren’t supported by this version of Surfd.');
      const data = await archive.get(run.id);
      if (!data) throw new Error('This run’s replay is no longer saved.');
      install(replay);
      await replay.watch(data, 'saved run');
      const session = getSession?.();
      if (!session || replay.playback()?.replay !== data) throw new Error('The replay didn’t start.');
      const watched = watch(data, session, {
        title: `Your run on ${run.mapName} · ${run.outcome === 'finished' ? `finished in ${formatTime(run.time)}` : `reset at ${formatTime(run.time)}`}${run.practice ? ' · practice' : ''}`,
        start: Math.min(run.replay.start ?? 0, data.commands.length),
        markers: (run.checkpoints ?? []).map(checkpoint => checkpoint.command).filter(Number.isInteger),
        spots: (run.spots ?? []).filter(tick => Number.isInteger(tick) && tick >= 0 && tick <= data.commands.length).slice(0, MAX_SPOTS),
        runId: run.id,
      });
      // Begin a second before the run left the start, not at spawn.
      seek(lead(watched));
    },
    get active() { return !!current(); },
    // Saves this moment as a practice saveloc, leaves the replay and loads it,
    // so you play on from exactly here.
    async practiceFromHere() {
      const watched = current(), hooks = practice();
      if (!watched || !hooks?.leaveReplay || practiceState() !== 'ok') throw new Error('Practicing from a replay isn’t supported by this version of Surfd.');
      if (!capture(watched)) throw new Error('The run has finished here; go back a little to practice from it.');
      hooks.leaveReplay();
      watching = null;
      // Going back to a server map can take a moment.
      for (let tries = 0; tries < 100 && !hooks.canLoad(); tries++) await wait(100);
      const session = getSession?.();
      if (!hooks.canLoad() || !session) throw new Error('Saved for practice; load it with your Load position bind once you’re back in the game.');
      if (file(session) == null) throw new Error('This moment is from a different map or map version than the one you’re on, so it can’t be loaded here.');
      hooks.load();
    },
    status() {
      const watched = current();
      if (!watched) return null;
      learn(watched);
      const index = position();
      return {
        title: watched.title, index, length: watched.length, start: watched.start ?? 0, dt: watched.dt,
        playing: playing(), ended: index >= watched.length, speed, markers: watched.markers.filter(Number.isInteger),
        spots: watched.spots.slice(), lastSpot: watched.lastSpot,
        practice: practiceState(), notice: notice && clock() - notice.at < NOTICE_MS ? notice.text : '',
      };
    },
    play() {
      const watched = current();
      if (!watched) return;
      paused = false;
      const index = position();
      if (index >= watched.length) seek(lead(watched));
      else if (hooks()?.playback?.()?.replay !== watched.replay) seek(index);
    },
    pause() { if (current()) paused = true; },
    toggle() { if (playing()) this.pause(); else this.play(); },
    seek,
    // skip() moves by seconds; step() moves by ticks and pauses.
    skip(seconds) { const watched = current(); if (watched) seek(position() + seconds / watched.dt); },
    step(ticks) { if (current()) { paused = true; seek(position() + ticks); } },
    setSpeed(next) { if (SPEEDS.includes(next)) speed = next; },
    // Saves the current tick as a spot; returns false when there is no room.
    saveSpot() {
      const watched = current();
      if (!watched) return false;
      const tick = position();
      if (!watched.spots.includes(tick)) {
        if (watched.spots.length >= MAX_SPOTS) { say(`You can keep up to ${MAX_SPOTS} locs; delete one first.`); return false; }
        watched.spots = [...watched.spots, tick].sort((a, b) => a - b);
        persist(watched);
        // Also a practice saveloc, so you can load it after leaving the replay.
        const n = watched.spots.indexOf(tick) + 1;
        say(practiceState() !== 'ok' ? `Saved loc ${n}`
          : capture(watched) ? `Saved loc ${n} · it’ll be in your practice savelocs when you leave the replay`
            : `Saved loc ${n} · not added to practice: the run has finished here`);
      }
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
