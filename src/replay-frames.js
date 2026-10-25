// Snapshots of a replay session while it's watched, so seeking back never
// re-simulates more than FRAME_TICKS. Replays store only inputs, so a
// moment's position exists only by simulating up to it; playback and seeks
// already do that, and keep a snapshot every FRAME_TICKS on the way.
export const FRAME_TICKS = 128;

// Session fields that are fixed while a replay plays, or rebuilt by every step
// (lastResult, which can reference map geometry).
const FIXED = new Set(['map', 'config', 'movement', 'replayFormat', 'timer', 'commands', 'lastResult']);
const TIMER_FIXED = new Set(['zones', 'dt', 'restrictStart', 'startPolicy', 'restartOnStartEntry']);

// A copy of everything the session's next step depends on, except its command log.
export function freeze(session) {
  const fields = {}, timer = {};
  for (const key of Object.keys(session)) if (!FIXED.has(key)) fields[key] = session[key];
  for (const key of Object.keys(session.timer)) if (!TIMER_FIXED.has(key)) timer[key] = session.timer[key];
  return structuredClone({fields, timer});
}
// Puts a session back to a frozen moment `tick` commands into `replay`.
export function thaw(session, frame, replay, tick) {
  const {fields, timer} = structuredClone(frame);
  Object.assign(session, fields);
  Object.assign(session.timer, timer);
  session.commands = replay.commands.slice(0, tick);
}

// Snapshots of one replay, keyed by how many commands had been played.
export function createFrames(replay, coaching) {
  const frames = new Map();
  let broken = false;
  return {
    get size() { return frames.size; },
    clear() { frames.clear(); },
    keep(session, tick) {
      if (broken || !tick || tick % FRAME_TICKS || frames.has(tick)) return;
      try {
        frames.set(tick, { native: freeze(session), coaching: coaching?.save() });
      } catch { broken = true; frames.clear(); }
    },
    // Restores the latest snapshot after `from` and at or before `to`; returns its tick, or -1.
    resume(session, from, to) {
      for (let tick = to - to % FRAME_TICKS; tick > from; tick -= FRAME_TICKS) {
        if (!frames.has(tick)) continue;
        const frame = frames.get(tick);
        thaw(session, frame.native, replay, tick);
        coaching?.restore(frame.coaching);
        return tick;
      }
      return -1;
    },
  };
}
