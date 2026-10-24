import { describe, expect, test } from 'bun:test';
import { createReplayControl } from '../src/replay-control.js';
import { pruneList } from '../src/replay-archive.js';

const DT = 0.015;

// A miniature game loop with the same playback contract as the adapter:
// a fixed stepper, a playback cursor and a replay session that logs commands.
function game(length = 400) {
  class Stepper {
    accumulator = 0;
    reset() { this.accumulator = 0; }
    advance(seconds, tick) {
      this.accumulator += seconds;
      let steps = 0;
      for (; this.accumulator + 1e-12 >= DT; steps++) { tick(); this.accumulator -= DT; }
      return steps;
    }
  }
  const replay = { mapId: 'utopia', commands: Array.from({ length }, (_, i) => ({ i })) };
  const world = { session: null, playing: null, index: 0, stepper: new Stepper(), seeks: 0 };
  const newSession = () => ({ map: { id: 'utopia' }, config: { dt: DT }, commands: [],
    step(command) { this.commands.push(command); }, loadReplay() { this.commands = []; world.reloads++; } });
  world.reloads = 0;
  world.hooks = {
    Stepper,
    stepper: () => world.stepper,
    playback: () => ({ replay: world.playing, index: world.index }),
    async watch(data) { world.session = newSession(); world.playing = data; world.index = 0; world.stepper = new Stepper(); },
    seek(data, index) {
      const session = world.session;
      world.seeks++;
      if (world.playing && world.playing !== data) return false;
      index = Math.max(0, Math.min(data.commands.length, Math.floor(index)));
      const at = session.commands.length;
      if (at > data.commands.length || at !== Math.min(world.index, data.commands.length) || index < at) { session.loadReplay(data); world.index = 0; }
      else world.index = at;
      while (world.index < index) session.step(data.commands[world.index++]);
      world.playing = index < data.commands.length ? data : null;
      world.stepper.reset();
      return true;
    },
  };
  // One rendered frame of the game loop.
  world.frame = seconds => world.stepper.advance(seconds, () => {
    const command = world.playing ? world.playing.commands[world.index++] : { live: true };
    if (!command) { world.playing = null; return; }
    world.session.step(command);
  });
  const run = { id: 'r1', mapName: 'Utopia', time: 4.5, outcome: 'finished', replay: { start: 100, dt: DT }, checkpoints: [{ command: 250 }] };
  const archive = { has: id => id === 'r1', get: async () => replay };
  const control = createReplayControl({ getAdapter: () => ({ replay: world.hooks }), getSession: () => world.session, archive });
  return { world, replay, run, control };
}

describe('replay control', () => {
  test('watching starts a second before the run left the start', async () => {
    const { world, run, control } = game();
    expect(control.canWatch(run)).toBe(true);
    expect(control.canWatch({ ...run, id: 'gone' })).toBe(false);
    await control.watch(run);
    expect(control.status()).toMatchObject({ index: 100 - Math.round(1 / DT), length: 400, start: 100, playing: true, speed: 1, markers: [250],
      title: 'Your run on Utopia · finished in 00:04.500' });
    expect(world.session.commands).toHaveLength(33);
  });

  test('speed scales whole native ticks and pause stops them', async () => {
    const { world, run, control } = game();
    await control.watch(run);
    const before = control.status().index;
    world.frame(DT * 6);
    expect(control.status().index).toBe(before + 6);
    control.setSpeed(2);
    world.frame(DT * 6);
    expect(control.status().index).toBe(before + 18);
    control.setSpeed(0.5);
    world.frame(DT * 6);
    expect(control.status().index).toBe(before + 21);
    control.pause();
    world.frame(DT * 6);
    expect(control.status()).toMatchObject({ index: before + 21, playing: false });
    control.step(1);
    expect(control.status().index).toBe(before + 22);
    control.step(-1);
    expect(control.status().index).toBe(before + 21);
  });

  test('seeking back re-simulates from the start; forward continues', async () => {
    const { world, run, control } = game();
    await control.watch(run);
    const reloads = world.reloads;
    control.seek(300);
    expect(world.reloads).toBe(reloads);
    control.skip(-1);
    expect(world.reloads).toBe(reloads + 1);
    expect(control.status().index).toBe(300 - Math.round(1 / DT));
    expect(world.session.commands).toHaveLength(control.status().index);
  });

  test('at the end, play starts over; after Esc, play resumes where it stopped', async () => {
    const { world, run, control } = game();
    await control.watch(run);
    control.seek(400);
    expect(control.status()).toMatchObject({ ended: true, playing: false });
    control.play();
    expect(control.status()).toMatchObject({ index: 100 - Math.round(1 / DT), playing: true });
    control.seek(200);
    world.playing = null; // the game's Esc
    world.frame(0.15);    // live input keeps stepping the session
    expect(control.status().playing).toBe(false);
    control.play();
    expect(control.status()).toMatchObject({ index: 200, playing: true });
    expect(world.session.commands).toHaveLength(200);
  });

  test('a replay the game started itself is taken over, learning its start and checkpoints from the timer', async () => {
    const { world, replay, control } = game();
    expect(control.status()).toBeNull();
    await world.hooks.watch(replay); // e.g. the leaderboard's own Watch button
    world.session.timer = { state: { phase: 'ready', splits: [] } };
    expect(control.status()).toMatchObject({ title: 'Watching a replay', index: 0, start: 0, markers: [], playing: true });
    world.session.timer.state = { phase: 'running', startTick: 120.4, splits: [1.5] };
    expect(control.status()).toMatchObject({ start: 120, markers: [220] });
    control.setSpeed(4);
    world.frame(DT * 3);
    expect(control.status().index).toBe(12);
  });

  test('leaving the replay session ends control', async () => {
    const { world, run, control } = game();
    await control.watch(run);
    world.session = { commands: [] }; // back to your own session; the game clears playback
    world.playing = null;
    expect(control.active).toBe(false);
    expect(control.status()).toBeNull();
  });
});

describe('replay archive pruning', () => {
  test('keeps the newest per map and each map’s best clean finish', () => {
    const entries = [
      { id: 'a1', map: 'a', at: 1, best: 40 }, { id: 'a2', map: 'a', at: 2, best: 45 }, { id: 'a3', map: 'a', at: 3, best: null },
      { id: 'a4', map: 'a', at: 4, best: null }, { id: 'b1', map: 'b', at: 1, best: null },
    ];
    expect(pruneList(entries, 2).sort()).toEqual(['a2']);
  });
});
