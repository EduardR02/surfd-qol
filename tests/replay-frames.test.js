import {describe, expect, test} from 'bun:test';
import {createFrames, freeze, thaw, FRAME_TICKS} from '../src/replay-frames.js';

// A replay session whose state is how many commands it has played.
class Session {
  map = {id: 'utopia'}; config = {dt: 0.015}; commands = []; lastResult = {brush: {}};
  state = {x: 0, velocity: {x: 1}}; checkpointSpeeds = [];
  timer = {zones: ['start'], dt: 0.015, state: {phase: 'ready', splits: []}, prehops: 0};
  loadReplay() { this.commands = []; this.state = {x: 0, velocity: {x: 1}}; this.timer.state = {phase: 'ready', splits: []}; }
  step(command) {
    this.commands.push(command);
    this.state = {x: this.state.x + 1, velocity: {x: this.state.x}};
    if (this.commands.length === 300) { this.timer.state.splits.push(4.2); this.checkpointSpeeds.push(2500); }
    return this.commands.length === 50 ? ['start'] : [];
  }
}
const replay = {mapId: 'utopia', commands: Array.from({length: 600}, (_, i) => ({i}))};
const played = ticks => { const session = new Session(); for (let i = 0; i < ticks; i++) session.step(replay.commands[i]); return session; };

describe('replay snapshots', () => {
  test('restore everything a step depends on, and leave fixed fields alone', () => {
    const frame = freeze(played(200));
    const session = played(20);
    const zones = session.timer.zones;
    thaw(session, frame, replay, 200);
    expect(session).toMatchObject({state: {x: 200, velocity: {x: 199}}, commands: {length: 200}});
    expect(session.timer.zones).toBe(zones);
    // Restoring twice from one snapshot gives independent copies.
    session.state.velocity.x = -1;
    thaw(session, frame, replay, 200);
    expect(session.state.velocity.x).toBe(199);
  });

  test('a seek resumes from the latest snapshot after where it starts and up to the target', () => {
    const frames = createFrames(replay);
    const source = new Session();
    for (let i = 0; i < 500; i++) { source.step(replay.commands[i]); frames.keep(source, i + 1); }
    expect(frames.size).toBe(Math.floor(500 / FRAME_TICKS));
    const session = new Session();
    expect(frames.resume(session, 0, 300)).toBe(256);
    expect(session.state.x).toBe(256);
    expect(frames.resume(session, 256, 300)).toBe(-1);
    expect(frames.resume(session, 0, 100)).toBe(-1);
  });

  test('a session that cannot be copied just goes without snapshots', () => {
    const frames = createFrames(replay);
    const session = played(FRAME_TICKS);
    session.callback = () => {};
    frames.keep(session, FRAME_TICKS);
    expect(frames.size).toBe(0);
  });
});
