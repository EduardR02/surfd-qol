import { describe, expect, test } from 'bun:test';
import { createReplayControl, MAX_SPOTS } from '../src/replay-control.js';
import { keyName, bindLabel } from '../src/key-names.js';

const DT = 0.015;

// A miniature game loop with the same playback contract as the adapter:
// a fixed stepper, a playback cursor and a replay session that logs commands.
function game(length = 400) {
  class Stepper {
    dt = DT;
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
  const world = { session: null, playing: null, index: 0, stepper: new Stepper(), seeks: 0, steps: 0, reloads: 0, notices: [] };
  // A replay session: its state is how many commands it has played.
  class Session {
    map = { id: 'utopia' }; config = { dt: DT }; commands = []; state = { x: 0 }; timer = { state: { phase: 'ready', splits: [] } };
    step(command) { this.commands.push(command); this.state = { x: this.state.x + 1 }; world.steps++; return []; }
    loadReplay() { this.commands = []; this.state = { x: 0 }; world.reloads++; }
  }
  const newSession = () => new Session();
  world.hooks = {
    Stepper,
    stepper: () => world.stepper,
    playback: () => ({ replay: world.playing, index: world.index }),
    async watch(data) { world.session = newSession(); world.playing = data; world.index = 0; world.stepper = new Stepper(); },
    seek(data, index, frames = null) {
      const session = world.session;
      world.seeks++;
      if (world.playing && world.playing !== data) return false;
      index = Math.max(0, Math.min(data.commands.length, Math.floor(index)));
      const at = session.commands.length;
      let from = at > data.commands.length || at !== Math.min(world.index, data.commands.length) || index < at ? 0 : at;
      if (!from) session.loadReplay(data);
      from = Math.max(from, frames?.resume(session, from, index) ?? -1);
      world.index = from;
      while (world.index < index) { session.step(data.commands[world.index++]); frames?.keep(session, world.index); }
      world.playing = data;
      world.stepper.reset();
      return true;
    },
  };
  // One rendered frame of the game loop.
  world.frame = seconds => world.stepper.advance(seconds, () => {
    const command = world.playing ? world.playing.commands[world.index++] : { live: true };
    // Past the last command the game drops the replay for its menu.
    if (!command) { world.playing = null; world.menu = true; return; }
    world.session.step(command);
  });
  const run = { id: 'r1', mapName: 'Utopia', time: 4.5, outcome: 'finished', replay: { start: 100, dt: DT }, checkpoints: [{ command: 250 }] };
  const archive = { has: id => id === 'r1', get: async () => replay };
  world.adapter = { replay: world.hooks, Session, getBindings: () => world.bindings,
    get practice() { return world.practice; }, notice: text => world.notices.push(text) };
  const control = createReplayControl({ getAdapter: () => world.adapter, getSession: () => world.session, archive,
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

  test('a slow archive read cannot replace the latest requested replay', async () => {
    const {world, replay, run} = game();
    const second = {...replay, commands: replay.commands.slice(0, 300)};
    let resolveFirst;
    const archive = {get: id => id === run.id ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve(second)};
    const control = createReplayControl({getAdapter: () => ({replay: world.hooks}), getSession: () => world.session, archive});
    const firstWatch = control.watch(run);
    await control.watch({...run, id: 'r2', mapName: 'Latest'});
    control.pause();
    control.setSpeed(2);
    const seeks = world.seeks;
    resolveFirst(replay);
    await firstWatch;
    expect(world.playing).toBe(second);
    expect(world.seeks).toBe(seeks);
    expect(control.status()).toMatchObject({title: 'Your run on Latest · finished in 00:04.500', playing: false, speed: 2});
  });

  test('archive reads are cancelled when the session or replay adapter changes', async () => {
    for (const changed of ['session', 'adapter']) {
      const {world, replay, run} = game();
      let resolveRead;
      const archive = {get: () => new Promise(resolve => { resolveRead = resolve; })};
      const control = createReplayControl({getAdapter: () => ({replay: world.hooks}), getSession: () => world.session, archive});
      const loading = control.watch(run);
      if (changed === 'session') world.session = {map: {id: 'another-map'}};
      else world.hooks = {...world.hooks};
      const session = world.session;
      resolveRead(replay);
      await loading;
      expect(world.session).toBe(session);
      expect(world.playing).toBeNull();
      expect(world.seeks).toBe(0);
    }
  });

  test('an earlier native watch completion cannot seek or relabel a newer replay', async () => {
    const {world, replay, run} = game();
    const second = {...replay, commands: replay.commands.slice(0, 300)};
    let finishFirst, startedFirst;
    const started = new Promise(resolve => { startedFirst = resolve; });
    const nativeWatch = world.hooks.watch;
    world.hooks.watch = async data => {
      await nativeWatch(data);
      if (data === replay) {
        startedFirst();
        await new Promise(resolve => { finishFirst = resolve; });
      }
    };
    const archive = {get: async id => id === run.id ? replay : second};
    const control = createReplayControl({getAdapter: () => ({replay: world.hooks}), getSession: () => world.session, archive});
    const firstWatch = control.watch(run);
    await started;
    await control.watch({...run, id: 'r2', mapName: 'Latest'});
    control.pause();
    const seeks = world.seeks;
    finishFirst();
    await firstWatch;
    expect(world.playing).toBe(second);
    expect(world.seeks).toBe(seeks);
    expect(control.status()).toMatchObject({title: 'Your run on Latest · finished in 00:04.500', playing: false});
  });

  test('a newer Watch intent cancels delayed native startup before its own archive read completes', async () => {
    const {world, replay, run} = game();
    const second = {...replay, commands: replay.commands.slice(0, 300)};
    let finishFirst, startedFirst, resolveSecond;
    const started = new Promise(resolve => { startedFirst = resolve; });
    const nativeWatch = world.hooks.watch;
    world.hooks.watch = async (data, _label, isCurrent = () => true) => {
      if (data === replay) {
        startedFirst();
        await new Promise(resolve => { finishFirst = resolve; });
      }
      if (!isCurrent()) return;
      await nativeWatch(data);
      // Native startup legitimately replaces the session; ownership must
      // follow the request and adapter, not the previous session object.
      expect(isCurrent()).toBe(true);
    };
    const archive = {get: id => id === run.id ? Promise.resolve(replay) : new Promise(resolve => { resolveSecond = resolve; })};
    const control = createReplayControl({getAdapter: () => ({replay: world.hooks}), getSession: () => world.session, archive});
    const firstWatch = control.watch(run);
    await started;
    const secondWatch = control.watch({...run, id: 'r2', mapName: 'Latest'});
    finishFirst();
    await firstWatch;
    expect(world.session).toBeNull();
    expect(world.playing).toBeNull();
    expect(world.seeks).toBe(0);
    resolveSecond(second);
    await secondWatch;
    expect(world.playing).toBe(second);
    expect(control.status()).toMatchObject({title: 'Your run on Latest · finished in 00:04.500', playing: true});
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

  test('seeking forward continues; back resumes from the nearest snapshot', async () => {
    const { world, run, control } = game();
    await control.watch(run);
    const reloads = world.reloads;
    control.seek(300);
    expect(world.reloads).toBe(reloads);
    world.steps = 0;
    control.skip(-1);
    // 233 is re-simulated from the snapshot at 128, not from the start.
    expect(world.steps).toBe(300 - Math.round(1 / DT) - 128);
    expect(control.status().index).toBe(300 - Math.round(1 / DT));
    expect(world.session.commands).toHaveLength(control.status().index);
    expect(world.session.state).toEqual({ x: control.status().index });
    control.seek(10);
    expect(world.session.state).toEqual({ x: 10 });
  });

  test('your runs mark their ramp boards, graded and shifted by a trimmed start', async () => {
    const { world, run, control: _ } = game();
    const grade = { tone: (key, loss) => loss === null ? 'muted' : loss < 5 ? 'good' : 'loss', version: () => 1 };
    const archive = { has: () => true, get: async () => world.replay };
    world.replay = { mapId: 'utopia', commands: Array.from({ length: 400 }, (_, i) => ({ i })) };
    const rampNumber = (mapKey, key) => mapKey === 'utopia:3' && key === '[7,0,1]' ? 4 : null;
    const control = createReplayControl({ getAdapter: () => world.adapter, getSession: () => world.session, archive, grade, rampNumber,
      getRun: () => ({ ...run, map: 'utopia:3', replay: { start: 100, offset: 50 }, checkpoints: [{ command: 300 }],
        boards: [[40, 9, 'a'], [170, 2.5, '[7,0,1]'], [260, null, '[8,0,1]']] }) });
    await control.watch({ ...run, map: 'utopia:3' });
    const status = control.status();
    expect(status.markers).toEqual([250]);
    // Numbered like the Runs view; a board off the map's route has no number.
    expect(status.ramps).toEqual([
      { tick: 120, label: 'Ramp 4', board: 2.5, tone: 'good' }, { tick: 210, label: 'Ramp', board: null, tone: 'muted' }]);
    expect(control.status().ramps).toBe(status.ramps);
  });

  test('playback holds on the last frame instead of leaving the replay', async () => {
    const { world, run, control } = game();
    await control.watch(run);
    control.seek(395);
    world.frame(DT * 3.5);
    expect(control.status()).toMatchObject({ index: 398, playing: true, ended: false });
    world.frame(0.2);
    expect(control.status()).toMatchObject({ index: 400, playing: false, ended: true });
    world.frame(0.2);
    expect(world.menu).toBeUndefined();
    expect(world.playing).not.toBeNull();
    expect(world.session.commands).toHaveLength(400);
  });

  test('at the end, play starts over; after Esc, play resumes where it stopped', async () => {
    const { world, run, control } = game();
    await control.watch(run);
    control.seek(400);
    world.frame(0.1);
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
    expect(control.status()).toMatchObject({ title: 'Watching a replay', index: 0, start: 0, markers: [], ramps: [], run: null, playing: true });
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
    world.practice = { store: () => store };
    world.bindings = { save: ['F5', 'Mouse2'], load: ['F9'] };
    const taught = [];
    let due = true;
    const teach = { due: () => due, done: () => { due = false; taught.push('done'); } };
    const archive = { has: () => true, get: async () => world.replay };
    world.replay = { mapId: 'utopia', commands: Array.from({ length: 400 }, (_, i) => ({ i })) };
    const live = { commands: [], map: { id: 'utopia', version: 2 }, practiceKey: () => 'utopia-v2-rules-8' };
    const control2 = createReplayControl({ getAdapter: () => world.adapter, getSession: () => world.session, archive, teach });
    await control2.watch(run);
    expect(world.notices).toEqual(['Press F5 / Mouse 2 to save a moment of this replay as a practice location.']);
    // The replay session: older rules, same map. Snapshots are what the game would capture.
    Object.assign(world.session, { map: { id: 'utopia', version: 2 }, practiceKey: () => 'utopia-v2-rules-5',
      capturePractice() { return { key: 'utopia-v2-rules-5', tick: this.commands.length }; } });
    world.session.timer.state.elapsed = 2.5;
    control2.seek(200);
    control2.saveSpot();
    control2.seek(260);
    control2.saveSpot();
    expect(world.notices.slice(1)).toEqual([
      'Saved location #1 · 00:02.500. It’s added to your practice locations when you leave the replay; F9 loads it.',
      'Saved location #2 · 00:02.500.']);
    expect(taught).toEqual(['done']);
    expect(store.banks.size).toBe(0);
    // Leaving the replay: filed under the live game's key, newest selected, so Load position loads it.
    world.session = live;
    world.playing = null;
    control2.status();
    const bank = store.banks.get('utopia-v2-rules-8');
    expect(bank.entries.map(entry => entry.snapshot)).toEqual([
      { key: 'utopia-v2-rules-8', tick: 200 }, { key: 'utopia-v2-rules-8', tick: 260 }]);
    expect(bank.selected).toBe(2);
    expect(store.revision).toBe(2);
    expect(control.status()).toBeNull();
  });

  test('a loc from another map waits until you are on that map', async () => {
    const { world, run, control } = game();
    const store = { banks: new Map(), nextId: 1, revision: 0 };
    world.practice = { store: () => store };
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
    expect(bindLabel(['F5', 'Mouse2'])).toBe('F5 / Mouse 2');
    expect(bindLabel(undefined)).toBe('');
  });
});
