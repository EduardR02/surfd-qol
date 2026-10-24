// Playback control for any replay the game plays: your saved runs, which we
// start, and leaderboard runs, the record route and server replays, which the
// game starts from its own Watch buttons and we take over. Speed and pause
// scale the frame time the game's fixed stepper receives, so physics still
// advances in whole native ticks. Seeking re-simulates the deterministic
// replay to the target tick (adapter.replay.seek).
import {formatTime} from './hud-model.js';

export const SPEEDS = [0.25, 0.5, 1, 2, 4];
const MAX_FRAME = 0.25;

export function createReplayControl({getAdapter, getSession, archive, getMapName = () => null}) {
  let watching = null, speed = 1, paused = false, installed = null;
  const hooks = () => getAdapter?.()?.replay ?? null;

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
    return watching = {replay, session, length: replay.commands.length, dt: session.config?.dt ?? 0.015, start: null, markers: [], ...details};
  }
  function current() {
    const session = getSession?.();
    if (watching && session !== watching.session) watching = null;
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
      });
      // Begin a second before the run left the start, not at spawn.
      seek(lead(watched));
    },
    get active() { return !!current(); },
    status() {
      const watched = current();
      if (!watched) return null;
      learn(watched);
      const index = position();
      return {
        title: watched.title, index, length: watched.length, start: watched.start ?? 0, dt: watched.dt,
        playing: playing(), ended: index >= watched.length, speed, markers: watched.markers.filter(Number.isInteger),
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
    faster() { speed = SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)]; },
    slower() { speed = SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)]; },
  };
}
