import { describe, expect, test } from 'bun:test';
import { createReplayControl, MAX_SPOTS } from '../src/replay-control.js';
import { pruneList } from '../src/replay-archive.js';
import { keyName } from '../src/replay-bar.js';

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
  const control = createReplayControl({ getAdapter: () => ({ replay: world.hooks, practice: world.practice }), getSession: () => world.session, archive,
    onSpots: (id, spots) => { world.savedSpots = [id, spots]; } });
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

  test('spots bookmark ticks, jump back keeping play state, and persist for your own runs', async () => {
    const { world, run, control } = game();
    await control.watch({ ...run, spots: [300, 9999] });
    expect(control.status().spots).toEqual([300]);
    control.seek(150);
    control.saveSpot();
    expect(control.status()).toMatchObject({ spots: [150, 300], lastSpot: 150 });
    expect(world.savedSpots).toEqual(['r1', [150, 300]]);
    control.seek(350);
    control.goToSpot();
    expect(control.status()).toMatchObject({ index: 150, playing: true });
    control.pause();
    control.goToSpot(300);
    expect(control.status()).toMatchObject({ index: 300, lastSpot: 300, playing: false });
    control.cycleSpot(-1);
    expect(control.status()).toMatchObject({ index: 150, lastSpot: 150 });
    control.cycleSpot(-1);
    expect(control.status()).toMatchObject({ index: 300, lastSpot: 300 });
    control.cycleSpot(1);
    expect(control.status().lastSpot).toBe(150);
    control.goToSpot(300);
    control.removeSpot(300);
    expect(control.status()).toMatchObject({ spots: [150], lastSpot: null });
    expect(world.savedSpots).toEqual(['r1', [150]]);
  });

  test("spots on someone else's replay are not persisted, and are capped", async () => {
    const { world, replay, control } = game();
    await world.hooks.watch(replay);
    for (let tick = 0; tick < MAX_SPOTS + 5; tick++) { control.seek(tick * 10); control.saveSpot(); }
    expect(control.status().spots).toHaveLength(MAX_SPOTS);
    expect(world.savedSpots).toBeUndefined();
    expect(control.goToSpot()).toBe(true);
  });

  test('saved locs become practice savelocs in the game you return to, under its rules', async () => {
    const { world, run, control } = game();
    const store = { banks: new Map(), nextId: 1, revision: 0 };
    const calls = [];
    let playable = false;
    world.practice = {
      store: () => store, canLoad: () => playable,
      leaveReplay: () => { calls.push('leave'); world.session = live(); world.playing = null; playable = true; },
      load: () => calls.push('load'),
    };
    const live = () => ({ commands: [], map: { id: 'utopia', version: 2 }, practiceKey: () => 'utopia-v2-rules-8' });
    await control.watch(run);
    // The replay session: older rules, same map. Snapshots are what the game would capture.
    Object.assign(world.session, { map: { id: 'utopia', version: 2 }, practiceKey: () => 'utopia-v2-rules-5',
      capturePractice() { return { key: 'utopia-v2-rules-5', tick: this.commands.length }; } });
    control.seek(200);
    control.saveSpot();
    expect(control.status().notice).toBe('Saved loc 1 · it’ll be in your practice savelocs when you leave the replay');
    expect(store.banks.size).toBe(0);
    control.seek(260);
    await control.practiceFromHere();
    expect(calls).toEqual(['leave', 'load']);
    // Filed under the live game's key, newest selected, so Load position loads it.
    const bank = store.banks.get('utopia-v2-rules-8');
    expect(bank.entries.map(entry => entry.snapshot)).toEqual([
      { key: 'utopia-v2-rules-8', tick: 200 }, { key: 'utopia-v2-rules-8', tick: 260 }]);
    expect(bank.selected).toBe(2);
    expect(store.revision).toBe(2);
  });

  test('a loc from another map waits until you are on that map', async () => {
    const { world, run, control } = game();
    const store = { banks: new Map(), nextId: 1, revision: 0 };
    world.practice = { store: () => store, canLoad: () => true, leaveReplay() {}, load() {} };
    await control.watch(run);
    Object.assign(world.session, { map: { id: 'utopia', version: 2 }, capturePractice: () => ({ tick: 1 }) });
    control.saveSpot();
    world.playing = null;
    world.session = { commands: [], map: { id: 'mesa', version: 1 }, practiceKey: () => 'mesa' };
    control.status();
    expect(store.banks.size).toBe(0);
    world.session = { commands: [], map: { id: 'utopia', version: 2 }, practiceKey: () => 'utopia' };
    control.status();
    expect(store.banks.get('utopia').entries).toHaveLength(1);
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

describe('saveloc bind names', () => {
  test('read like the game shows them', () => {
    expect(['F5', 'KeyV', 'Digit4', 'Mouse3', 'WheelUp', 'ShiftLeft'].map(keyName)).toEqual(['F5', 'V', '4', 'Mouse 3', 'Wheel Up', 'Shift Left']);
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
