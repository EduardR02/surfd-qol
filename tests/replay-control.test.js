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
  let generation = 0;
  world.hooks = {
    Stepper,
    stepper: () => world.stepper,
    playback: () => ({ replay: world.playing, index: world.index }),
    reserve: () => ++generation,
    isCurrent: token => token === generation,
    async watch(data, _label, isCurrent = () => true, token = ++generation) {
      if (token !== generation || !isCurrent()) return;
      world.session = newSession(); world.playing = data; world.index = 0; world.stepper = new Stepper();
    },
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
  // Native Watch reserves the same token before it downloads anything.
  world.watchNative = async load => {
    const token = world.hooks.reserve();
    const data = await load();
    await world.hooks.watch(data, 'native replay', () => true, token);
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

describe('ramp replay navigation', () => {
  test('local navigation uses the exact visit, trim offset, lead time and existing frame cache', async () => {
    const {world, replay, run, control} = game(1200);
    replay.config = {dt: DT};
    run.replay.offset = 200;
    run.boards = [[230, 5, '[7,0,1]'], [1000, 4, '[7,0,2]']];
    expect(await control.watch(run, {rampKey: '[7,0,2]'})).toBe(true);
    expect(control.status()).toMatchObject({index: 767, playing: false, speed: 1});
    expect(world.steps).toBe(767);
    world.frame(DT * 10);
    expect(world.index).toBe(767);
    control.seek(900);
    const steps = world.steps;
    control.seek(767);
    expect(world.steps - steps).toBeLessThan(767);
    expect(await control.watch(run)).toBe(true);
    expect(control.status()).toMatchObject({index: 0, playing: true});
    control.destroy();
  });

  test('lead time clamps at the retained start and can opt into playing at the board', async () => {
    const {run, control} = game();
    run.replay.offset = 200;
    run.boards = [[205, null, 'entry'], [600, 2, 'end']];
    expect(await control.watch(run, {rampKey: 'entry'})).toBe(true);
    expect(control.status()).toMatchObject({index: 0, playing: false});
    expect(await control.watch(run, {rampKey: 'end', leadSeconds: 0, paused: false})).toBe(true);
    expect(control.status()).toMatchObject({index: 400, playing: true});
    control.destroy();
  });

  test('absent, trimmed-out and out-of-bounds boards never start another replay', async () => {
    for (const tick of [null, 199, 601, NaN]) {
      const {world, run, control} = game();
      run.replay.offset = 200;
      run.boards = tick === null ? [[250, 3, 'other']] : [[tick, 3, 'wanted']];
      expect(await control.watch(run, {rampKey: 'wanted'})).toBe(false);
      expect(world.playing).toBeNull();
      expect(world.seeks).toBe(0);
      control.destroy();
    }
  });

  test('navigation validates lead time and never changes normal Watch defaults', async () => {
    for (const leadSeconds of [-1, Infinity, NaN]) {
      const {world, run, control} = game();
      run.boards = [[200, 2, 'ramp']];
      expect(await control.watch(run, {rampKey: 'ramp', leadSeconds})).toBe(false);
      expect(world.playing).toBeNull();
      await control.watch(run);
      expect(control.status()).toMatchObject({index: 0, playing: true});
      control.destroy();
    }
  });

  test('local navigation resolves current archived board metadata rather than the UI snapshot', async () => {
    const {world, replay, run} = game();
    const currentRun = {...run, boards: [[200, 4, 'ramp']]};
    const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session,
      getRun: id => id === run.id ? currentRun : null, archive: {get: async () => replay}});
    expect(await control.watch(run, {rampKey: 'ramp', leadSeconds: 0})).toBe(true);
    expect(control.status()).toMatchObject({index: 200, playing: false});
    control.destroy();
  });

  test('cancelling local ramp ownership during an archive read leaves native playback untouched', async () => {
    const {world, replay, run} = game();
    run.boards = [[200, 4, 'ramp']];
    let resolveReplay, current = true;
    const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session,
      archive: {get: () => new Promise(resolve => { resolveReplay = resolve; })}});
    try {
      const pending = control.watch(run, {rampKey: 'ramp', isCurrent: () => current});
      current = false;
      resolveReplay(replay);
      expect(await pending).toBe(false);
      expect(world.playing).toBeNull();
      expect(world.seeks).toBe(0);
    } finally { control.destroy(); }
  });

  test('native Watch cancels navigation while its route is loading without a late seek', async () => {
    const {world, replay, control} = game();
    let finish;
    const request = control.watchLoaded(() => new Promise(resolve => { finish = resolve; }),
      {title: 'Ramp PB', navigation: {tick: 200, leadSeconds: 0, paused: true}});
    const native = {...replay};
    await world.watchNative(async () => native);
    finish(replay);
    expect(await request).toBe(false);
    expect(world.playing).toBe(native);
    expect(world.seeks).toBe(0);
    control.destroy();
  });

  test('reference context changes during native startup prevent playback and seeking', async () => {
    const {world, replay, control} = game();
    let valid = true, finish, started;
    const beginning = new Promise(resolve => { started = resolve; });
    const nativeWatch = world.hooks.watch;
    world.hooks.watch = async (...args) => {
      started();
      await new Promise(resolve => { finish = resolve; });
      return nativeWatch(...args);
    };
    const request = control.watchLoaded(async () => replay, {title: 'Ramp PB',
      navigation: {tick: 200, leadSeconds: 0, paused: true}, isCurrent: () => valid});
    await beginning;
    valid = false;
    finish();
    expect(await request).toBe(false);
    expect(world.playing).toBeNull();
    expect(world.seeks).toBe(0);
    control.destroy();
  });
});

describe('replay control', () => {
  test('watching preserves the full recorded prestrafe before the start marker', async () => {
    const { world, run, control } = game();
    expect(control.canWatch(run)).toBe(true);
    expect(control.canWatch({ ...run, id: 'gone' })).toBe(false);
    await control.watch(run);
    expect(control.status()).toMatchObject({index: 0, length: 400, start: 100, playing: true, speed: 1, markers: [250]});
    expect(world.session.commands).toEqual([]);
    world.frame(DT);
    expect(world.session.commands).toEqual([{i: 0}]);
    expect(control.status().index).toBe(1);
  });

  test('loaded leaderboard replays start at zero and never persist spots as a local run', async () => {
    const {world, replay, control} = game();
    await control.watchLoaded(async () => replay, {title: 'Leaderboard PB'});
    expect(control.status()).toMatchObject({index: 0, start: 0, run: null, playing: true});
    world.session.timer.state = {phase: 'running', startTick: 120.4, splits: [1.5]};
    expect(control.status()).toMatchObject({start: 120, markers: [220]});
    control.seek(180);
    control.saveSpot();
    expect(control.status()).toMatchObject({spots: [180], lastSpot: 180});
    expect(world.savedSpots).toBeUndefined();
  });

  test('saved and downloaded replays share cancellation before either read completes', async () => {
    for (const firstSource of ['saved', 'downloaded']) {
      const {world, replay, run} = game();
      let finishOld, finishNew;
      const oldData = new Promise(resolve => { finishOld = resolve; });
      const newData = new Promise(resolve => { finishNew = resolve; });
      const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session,
        archive: {get: () => firstSource === 'saved' ? oldData : newData}});
      const older = firstSource === 'saved' ? control.watch(run) : control.watchLoaded(() => oldData, {title: 'Old PB'});
      const newer = firstSource === 'saved' ? control.watchLoaded(() => newData, {title: 'New PB'}) : control.watch(run);
      finishOld({...replay});
      await older;
      expect(world.session).toBeNull();
      finishNew(replay);
      await newer;
      expect(world.playing).toBe(replay);
      expect(control.status()).toMatchObject({index: 0, run: firstSource === 'saved' ? null : {id: run.id}});
    }
  });

  test('native and extension Watch share ownership before loading, whichever starts or finishes first', async () => {
    for (const extensionFirst of [false, true]) for (const olderFinishesFirst of [false, true]) for (const saved of [false, true]) {
      const {world, replay, run} = game();
      let finishExtension, finishNative;
      const extensionData = new Promise(resolve => { finishExtension = resolve; });
      const nativeData = new Promise(resolve => { finishNative = resolve; });
      const nativeReplay = {...replay, commands: replay.commands.slice(0, 300)};
      const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session,
        archive: {get: () => extensionData}});
      const extensionWatch = () => saved ? control.watch(run) : control.watchLoaded(() => extensionData, {title: 'PB'});
      let extensionRequest, nativeRequest;
      if (extensionFirst) { extensionRequest = extensionWatch(); nativeRequest = world.watchNative(() => nativeData); }
      else { nativeRequest = world.watchNative(() => nativeData); extensionRequest = extensionWatch(); }
      const finish = async extension => {
        if (extension) { finishExtension(replay); await extensionRequest; }
        else { finishNative(nativeReplay); await nativeRequest; }
      };
      await finish(olderFinishesFirst ? extensionFirst : !extensionFirst);
      if (olderFinishesFirst) expect(world.playing).toBeNull();
      await finish(olderFinishesFirst ? !extensionFirst : extensionFirst);
      expect(world.playing).toBe(extensionFirst ? nativeReplay : replay);
      expect(control.status().length).toBe(extensionFirst ? 300 : 400);
      control.destroy();
    }
  });

  test('destroy cancels delayed archive reads and cannot start or take over another replay', async () => {
    const {world, replay, run} = game();
    let resolveRead, reads = 0;
    const original = world.hooks.Stepper.prototype.advance;
    const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session,
      archive: {has: () => true, get: () => { reads++; return new Promise(resolve => { resolveRead = resolve; }); }}});
    const request = control.watch(run);
    control.destroy();
    control.destroy();
    resolveRead(replay);
    await request;
    await control.watch(run);
    await control.watchLoaded(() => { throw Error('must not load'); }, {title: 'PB'});
    expect(reads).toBe(1);
    expect(world.playing).toBeNull();
    expect(world.hooks.Stepper.prototype.advance).toBe(original);
    await world.hooks.watch(replay);
    expect(control.active).toBe(false);
    expect(control.status()).toBeNull();
    expect(control.canWatch(run)).toBe(false);
    expect(world.hooks.Stepper.prototype.advance).toBe(original);
  });

  test('destroy cancels delayed native startup and restores its Stepper wrapper', async () => {
    const {world, replay, run} = game();
    let finishStartup, markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const nativeWatch = world.hooks.watch, original = world.hooks.Stepper.prototype.advance;
    world.hooks.watch = async (...args) => {
      markStarted();
      await new Promise(resolve => { finishStartup = resolve; });
      return nativeWatch(...args);
    };
    const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session,
      archive: {get: async () => replay}});
    const request = control.watch(run);
    await started;
    expect(world.hooks.Stepper.prototype.advance).not.toBe(original);
    control.destroy();
    expect(world.hooks.Stepper.prototype.advance).toBe(original);
    finishStartup();
    await request;
    expect(world.session).toBeNull();
    expect(world.playing).toBeNull();
    expect(world.seeks).toBe(0);
  });

  test('destroy removes only its owned wrapper and discards pending practice captures', async () => {
    for (const anotherWrapper of [false, true]) {
      const {world, run, control} = game();
      const original = world.hooks.Stepper.prototype.advance;
      const store = {banks: new Map(), nextId: 1, revision: 0};
      world.practice = {store: () => store};
      await control.watch(run);
      world.session.capturePractice = () => ({tick: 0});
      control.saveSpot();
      control.pause();
      control.setSpeed(4);
      const owned = world.hooks.Stepper.prototype.advance;
      const foreign = function (...args) { return owned.apply(this, args); };
      if (anotherWrapper) world.hooks.Stepper.prototype.advance = foreign;
      control.destroy();
      control.destroy();
      expect(world.hooks.Stepper.prototype.advance).toBe(anotherWrapper ? foreign : original);
      // Even a wrapper retained by another extension no longer scales or pauses.
      world.frame(DT * 2);
      expect(world.index).toBe(2);
      world.playing = null;
      world.session = {map: {id: 'utopia'}, practiceKey: () => 'live'};
      expect(control.status()).toBeNull();
      expect(store.banks.size).toBe(0);
    }
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
    world.hooks.watch = async (data, label, isCurrent, token) => {
      await nativeWatch(data, label, isCurrent, token);
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
    world.hooks.watch = async (data, label, isCurrent = () => true, token) => {
      if (data === replay) {
        startedFirst();
        await new Promise(resolve => { finishFirst = resolve; });
      }
      if (!isCurrent()) return;
      await nativeWatch(data, label, isCurrent, token);
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

  test('disabling replay controls restores native speed and permits later takeover without reloading', async () => {
    const {world, run, control} = game();
    const nativeAdvance = world.hooks.Stepper.prototype.advance;
    await control.watch(run);
    control.setSpeed(4);
    control.pause();
    control.setEnabled(false);
    expect(control.status()).toBeNull();
    expect(control.canWatch(run)).toBe(false);
    expect(world.hooks.Stepper.prototype.advance).toBe(nativeAdvance);
    world.frame(DT * 3);
    expect(world.index).toBe(3);
    control.setEnabled(true);
    expect(control.status()).toMatchObject({index: 3, speed: 1, playing: true});
    control.pause();
    world.frame(DT * 3);
    expect(world.index).toBe(3);
    control.seek(2);
    expect(control.status().index).toBe(2);
  });

  test('disabled replay controls cancel pending loads without reserving over newer native Watch requests', async () => {
    const {world, replay} = game();
    const settings = {replayControls: true};
    const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session, settings});
    let finish;
    const pending = control.watchLoaded(() => new Promise(resolve => { finish = resolve; }), {title: 'Old extension request'});
    const native = {...replay};
    await world.watchNative(async () => native);
    settings.replayControls = false;
    control.settingsChanged();
    finish(replay);
    await pending;
    expect(world.playing).toBe(native);
    expect(control.status()).toBeNull();
    let loads = 0;
    await control.watchLoaded(() => { loads++; return replay; }, {title: 'Disabled'});
    expect(loads).toBe(0);
    settings.replayControls = true;
    control.settingsChanged();
    expect(control.status()).toMatchObject({title: 'Watching a replay', index: 0, playing: true});
  });

  test('seeking forward continues; back resumes from the nearest snapshot', async () => {
    const { world, run, control } = game();
    await control.watch(run);
    world.frame(DT);
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
    control.setVisible(true);
    const status = control.status();
    expect(status.markers).toEqual([250]);
    // Numbered like the Runs view; a board off the map's route has no number.
    expect(status.ramps).toEqual([
      { tick: 120, label: 'Ramp 4', board: 2.5, tone: 'good' }, { tick: 210, label: 'Ramp', board: null, tone: 'muted' }]);
    expect(control.status().ramps).toBe(status.ramps);
  });

  test('timeline grading acquires only while visible and releases when hidden or without boards', async () => {
    const {world, replay, run} = game();
    let tones = 0, held = false, destroyed = 0;
    const grade = {tone: () => { tones++; held = true; return 'good'; }, version: () => 1,
      release: () => { held = false; }, destroy: () => { held = false; destroyed++; }};
    const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session,
      archive: {get: async () => replay}, grade});
    await control.watch({...run, boards: [[128, 3, 'ramp']]});
    expect(control.status().ramps[0].tone).toBe('muted');
    expect(tones).toBe(0);
    control.setVisible(true);
    expect(control.status().ramps[0].tone).toBe('good');
    expect(held).toBe(true);
    control.setVisible(false);
    expect(held).toBe(false);
    // Reopening without an intervening hidden status still reacquires.
    control.setVisible(true);
    control.status();
    expect(tones).toBe(2);
    await control.watchLoaded(async () => replay, {title: 'No board markers'});
    expect(held).toBe(false);
    control.destroy();
    control.destroy();
    expect(destroyed).toBe(1);
  });

  test('cached replay seeks restore coaching at exact boundaries and continue from it', async () => {
    const {world, replay, run} = game();
    let ticks = 0;
    const coaching = {save: () => ({ticks}), restore: state => { ticks = state.ticks; }};
    const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session,
      archive: {get: async () => replay}, coaching});
    await control.watch(run);
    const prototype = world.adapter.Session.prototype, step = prototype.step, load = prototype.loadReplay;
    prototype.step = function (...args) { ticks++; return step.apply(this, args); };
    prototype.loadReplay = function (...args) { ticks = 0; return load.apply(this, args); };
    control.seek(300);
    expect(ticks).toBe(300);
    control.seek(128);
    expect(ticks).toBe(128);
    control.seek(130);
    expect(ticks).toBe(130);
    control.destroy();
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
    expect(control.status()).toMatchObject({index: 0, playing: true});
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

  test('learning checkpoints and editing bookmarks never mutates an earlier timeline snapshot', async () => {
    const {world, replay, control} = game();
    await control.watchLoaded(async () => replay, {title: 'Leaderboard run'});
    world.session.timer.state = {phase: 'running', startTick: 120.4, splits: [1.5]};
    const first = control.status();
    world.session.timer.state.splits.push(3);
    const later = control.status();
    expect(first.markers).toEqual([220]);
    expect(later.markers).toEqual([220, 320]);
    control.seek(150);
    control.saveSpot();
    const saved = control.status();
    control.removeSpot(150);
    expect(first.spots).toEqual([]);
    expect(saved.spots).toEqual([150]);
    expect(control.status().spots).toEqual([]);
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
  test('explicitly resaving a persisted bookmark captures fresh practice without duplicating the marker', async () => {
    const {world, run, control} = game();
    const store = {banks: new Map(), nextId: 1, revision: 0};
    world.practice = {store: () => store};
    await control.watch({...run, spots: [180]});
    Object.assign(world.session, {capturePractice() { return {tick: this.commands.length}; }});
    control.goToSpot(180);
    world.notices.length = 0;
    expect(control.saveSpot()).toBe(true);
    expect(control.status().spots).toEqual([180]);
    expect(world.savedSpots).toBeUndefined();
    expect(world.notices).toHaveLength(1);
    expect(world.notices[0]).toContain('Saved location #1');
    expect(world.notices[0]).toContain('added to your practice locations');
    world.playing = null;
    world.session = {map: {id: 'utopia'}, practiceKey: () => 'fresh'};
    control.status();
    expect(store.banks.get('fresh').entries).toEqual([{id: 1, snapshot: {key: 'fresh', tick: 180}}]);
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

  test('presentation changes and unchanged analysis settings keep cached seeks and playback controls', async () => {
    const {world, replay, run} = game();
    const settings = {hud: true, showStart: true, continuousFeedback: false};
    const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session,
      archive: {get: async () => replay}, settings});
    try {
      await control.watch(run);
      control.seek(350);
      control.setSpeed(2);
      Object.assign(settings, {
        hud: true, showStart: true, continuousFeedback: false, showSync: false,
        speedColor: '#ffffff', goodColor: '#ffffff', opacity: 0.5, scale: 1.5, speedFps: 30, timerFps: 15,
        rampResult: 'total', airMetric: 'missed', boardColorReference: 'wr', startColorReference: 'pb',
        surfColorReference: 'fixed', referenceLossTolerance: 10, startHeightAmazing: 5,
        startDeficitGood: 20, boardLossGood: 30, airLossGood: 30, checkpointReference: 'pb', wrSource: 'leaderboard',
      });
      control.settingsChanged();
      world.steps = 0;
      const reloads = world.reloads;
      expect(control.seek(300)).toBe(true);
      expect(world.steps).toBe(300 - 256);
      expect(world.reloads - reloads).toBe(1);
      expect(control.status()).toMatchObject({index: 300, playing: true, speed: 2});
      world.steps = 0;
      control.seek(380);
      expect(world.steps).toBe(80);
      expect(world.reloads - reloads).toBe(1);
    } finally { control.destroy(); }
  });

  test('invalidated coaching never takes native ownership and does not disturb practice captures', async () => {
    const {world, replay, run} = game();
    const settings = {continuousFeedback: true};
    const store = {banks: new Map(), nextId: 1, revision: 0};
    world.practice = {store: () => store};
    const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session,
      archive: {get: async () => replay}, settings});
    try {
      await control.watch(run);
      control.seek(300);
      world.session.capturePractice = () => ({tick: world.session.state.x});
      settings.continuousFeedback = false;
      control.settingsChanged();
      const reloads = world.reloads;
      // Saving still captures the current physical moment without a seek.
      control.saveSpot();
      expect(world.reloads).toBe(reloads);
      const foreign = {...replay};
      world.playing = foreign;
      expect(control.seek(380)).toBe(false);
      expect(world.playing).toBe(foreign);
      expect(world.session.state.x).toBe(300);
      expect(world.reloads).toBe(reloads);
      world.playing = replay;
      world.steps = 0;
      control.setSpeed(4);
      expect(control.seek(380)).toBe(true);
      expect(world.steps).toBe(380);
      expect(control.status()).toMatchObject({index: 380, playing: true, speed: 4});
      world.playing = null;
      world.session = {map: {id: 'utopia'}, practiceKey: () => 'live'};
      control.status();
      expect(store.banks.get('live').entries[0].snapshot).toMatchObject({tick: 300});
    } finally { control.destroy(); }
  });
});

describe('saveloc bind names', () => {
  test('read like the game shows them', () => {
    expect(['F5', 'KeyV', 'Digit4', 'Mouse3', 'WheelUp', 'ShiftLeft'].map(keyName)).toEqual(['F5', 'V', '4', 'Mouse 3', 'Wheel Up', 'Shift Left']);
    expect(bindLabel(['F5', 'Mouse2'])).toBe('F5 / Mouse 2');
    expect(bindLabel(undefined)).toBe('');
  });
});
