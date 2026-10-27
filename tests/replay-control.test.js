import { describe, expect, test } from 'bun:test';
import { createReplayControl, MAX_SPOTS, SPEEDS } from '../src/replay-control.js';
import { keyName, bindLabel } from '../src/key-names.js';
import {createMetrics} from '../src/metrics.js';
import {observePhysics} from '../src/observer.js';

const DT = 0.015;

// A miniature game with the same replay contract as the adapter: Surfd's
// player (transport) owns playback, speed and seeking. Like the game, it
// seeks only within what it has indexed, and going back restores its
// keyframe at or before the target (one every 128 ticks), then steps on.
function game(length = 400) {
  const replay = { mapId: 'utopia', commands: Array.from({ length }, (_, i) => ({ i })) };
  const world = { session: null, index: 0, seeks: 0, steps: 0, reloads: 0, restores: 0, notices: [], accumulator: 0 };
  // A replay session: its state is how many commands it has played.
  class Session {
    map = { id: 'utopia' }; config = { dt: DT }; commands = []; state = { x: 0, tick: 0 }; timer = { state: { phase: 'ready', splits: [] } };
    step(command) { this.commands.push(command); this.state.x++; this.state.tick++; world.steps++; return []; }
    loadReplay(data) { this.commands = []; this.state = {...(data.initialState ?? {x: 0, tick: 0})}; world.reloads++; }
    restorePractice(snapshot) { this.state = { ...snapshot.state }; this.commands = []; world.restores++; return true; }
  }
  const player = world.player = {
    replay: null, pending: null, revision: 0, clock: { speed: 1, paused: false }, index: null,
    host: {position: () => world.index, session: () => world.session, parked: () => false,
      exit() { world.exited = true; player.replay = null; }, returnToServer() { world.returned = true; player.replay = null; }},
    get paused() { return this.clock.paused; },
    open(data) {
      this.revision++;
      this.replay = data; this.clock = {speed: 1, paused: false};
      this.index = {markers: [], end: data.commands.length, indexed: data.commands.length, complete: true,
        get reachable() { return Math.max(0, Math.min(this.end, this.indexed)); }};
      world.index = 0; world.accumulator = 0;
    },
    atEnd() { return !this.replay || world.index >= this.index.end; },
    play() { if (!this.replay) return; if (this.atEnd()) { this.requestSeek(0); this.applyPending(); } this.clock.paused = false; },
    pause() { if (this.replay) this.clock.paused = true; },
    toggle() { if (this.clock.paused) this.play(); else this.pause(); },
    setSpeed(speed) { this.clock.speed = speed; },
    shiftSpeed(direction) { const at = SPEEDS.indexOf(this.clock.speed); this.clock.speed = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, at + direction))]; },
    seekBy(seconds) { this.requestSeek(world.index + Math.round(seconds / DT)); this.applyPending(); },
    stepTick(ticks) { this.clock.paused = true; this.requestSeek(world.index + ticks); this.applyPending(); },
    stage(direction) { world.staged = direction; },
    requestSeek(tick) { if (this.replay && Number.isFinite(tick)) this.pending = tick; },
    applyPending() {
      const target = this.pending;
      this.pending = null;
      if (!this.replay || target === null) return;
      // The native index refuses forward seeks when the cursor is already
      // beyond the indexed range. It uses a later keyframe for forward jumps too.
      if (target > world.index && world.index >= this.index.reachable) return;
      const to = Math.max(0, Math.min(this.index.reachable, Math.round(target)));
      if (to === world.index) return;
      world.seeks++;
      const key = to - to % 128;
      if (to < world.index || key > world.index) {
        const base = this.replay.initialState?.tick ?? 0;
        world.session.restorePractice({state: {x: key, tick: base + key}});
        world.index = key;
      }
      while (world.index < to) world.session.step(this.replay.commands[world.index++]);
    },
  };
  Object.defineProperty(world, 'playing', { get: () => player.replay, set: value => { player.replay = value; } });
  let generation = 0;
  world.hooks = {
    reserve: () => ++generation,
    isCurrent: token => token === generation,
    async watch(data, _label, isCurrent = () => true, token = ++generation) {
      if (token !== generation || !isCurrent()) return;
      world.session = new Session();
      world.session.loadReplay(data);
      player.open(data);
    },
    transport: () => player,
    playback: () => ({ replay: player.replay, index: player.replay ? world.index : 0 }),
  };
  // Native Watch reserves the same token before it downloads anything.
  world.watchNative = async load => {
    const token = world.hooks.reserve();
    const data = await load();
    await world.hooks.watch(data, 'native replay', () => true, token);
  };
  // One rendered frame: the player advances whole ticks at its speed and holds at the end.
  world.frame = seconds => {
    if (!player.replay || player.clock.paused) return;
    world.accumulator += seconds * player.clock.speed;
    for (; world.accumulator + 1e-12 >= DT; world.accumulator -= DT) {
      if (player.atEnd()) { player.clock.paused = true; world.accumulator = 0; return; }
      world.session.step(player.replay.commands[world.index++]);
    }
  };
  const run = { id: 'r1', mapName: 'Utopia', time: 4.5, outcome: 'finished', replay: { start: 100, dt: DT }, checkpoints: [{ command: 250 }] };
  const archive = { has: id => id === 'r1', get: async () => replay };
  world.adapter = { replay: world.hooks, Session, getSession: () => world.session, getBindings: () => world.bindings,
    get practice() { return world.practice; }, notice: text => world.notices.push(text) };
  const control = createReplayControl({ getAdapter: () => world.adapter, getSession: () => world.session, archive,
    onSpots: (id, spots) => { world.savedSpots = [id, spots]; } });
  return { world, replay, run, control };
}

function practiceBank(world, store) {
  return {store: () => store, destination: () => {
    const session = world.session;
    return typeof session?.practiceKey === 'function'
      ? {mapId: session.map.id, mapVersion: session.map.version, key: session.practiceKey()} : null;
  }};
}

describe('ramp replay navigation', () => {
  test('local navigation uses the exact visit, trim offset, lead time and existing frame cache', async () => {
    const {world, replay, run, control} = game(1200);
    replay.config = {dt: DT};
    run.replay.offset = 200;
    run.boards = [[230, 5, '[7,0,1]'], [1000, 4, '[7,0,2]']];
    expect(await control.watch(run, {rampKey: '[7,0,2]'})).toBe(true);
    expect(control.status()).toMatchObject({index: 767, playing: false, speed: 1});
    expect(world.steps).toBe(127);
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
    run.boards = [[205, null, 'entry'], [590, 2, 'end']];
    expect(await control.watch(run, {rampKey: 'entry'})).toBe(true);
    expect(control.status()).toMatchObject({index: 0, playing: false});
    expect(await control.watch(run, {rampKey: 'end', leadSeconds: 0, paused: false})).toBe(true);
    expect(control.status()).toMatchObject({index: 390, playing: true});
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
    // The game's index marks the start and checkpoints as it reads the replay.
    world.player.index.markers = [{kind: 'start', index: 120}, {kind: 'checkpoint', index: 220}, {kind: 'finish', index: 390}];
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
    const original = world.adapter.Session.prototype.restorePractice;
    const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session,
      archive: {has: () => true, get: () => { reads++; return new Promise(resolve => { resolveRead = resolve; }); }},
      coaching: {save() {}, restore() {}, reset() {}}});
    const request = control.watch(run);
    control.destroy();
    control.destroy();
    resolveRead(replay);
    await request;
    await control.watch(run);
    await control.watchLoaded(() => { throw Error('must not load'); }, {title: 'PB'});
    expect(reads).toBe(1);
    expect(world.playing).toBeNull();
    await world.hooks.watch(replay);
    expect(control.active).toBe(false);
    expect(control.status()).toBeNull();
    expect(control.canWatch(run)).toBe(false);
    expect(world.adapter.Session.prototype.restorePractice).toBe(original);
  });
  test('destroy cancels delayed native startup', async () => {
    const {world, replay, run} = game();
    let finishStartup, markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const nativeWatch = world.hooks.watch;
    world.hooks.watch = async (...args) => {
      markStarted();
      await new Promise(resolve => { finishStartup = resolve; });
      return nativeWatch(...args);
    };
    const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session,
      archive: {get: async () => replay}});
    const request = control.watch(run);
    await started;
    control.destroy();
    finishStartup();
    await request;
    expect(world.session).toBeNull();
    expect(world.playing).toBeNull();
    expect(world.seeks).toBe(0);
  });
  test('destroy removes only its owned restore wrapper and discards pending practice captures', async () => {
    for (const anotherWrapper of [false, true]) {
      const {world, replay, run} = game();
      const prototype = world.adapter.Session.prototype, original = prototype.restorePractice;
      let resets = 0;
      const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session,
        archive: {get: async () => replay}, coaching: {save() {}, restore() {}, reset() { resets++; }}});
      const store = {banks: new Map(), nextId: 1, revision: 0};
      world.practice = practiceBank(world, store);
      await control.watch(run);
      expect(prototype.restorePractice).not.toBe(original);
      const beforeDestroy = resets;
      world.session.capturePractice = () => ({tick: 0});
      control.saveSpot();
      const owned = prototype.restorePractice;
      const foreign = function (...args) { return owned.apply(this, args); };
      if (anotherWrapper) prototype.restorePractice = foreign;
      control.destroy();
      control.destroy();
      expect(prototype.restorePractice).toBe(anotherWrapper ? foreign : original);
      // Even a wrapper retained by another extension no longer touches the HUD's analysis.
      control.seek(300);
      world.player.requestSeek(10);
      world.player.applyPending();
      expect(resets).toBe(beforeDestroy);
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

  test('speed, pause and steps drive the game\'s player', async () => {
    const { world, run, control } = game();
    await control.watch(run);
    const before = control.status().index;
    world.frame(DT * 6);
    expect(control.status().index).toBe(before + 6);
    control.setSpeed(2);
    world.frame(DT * 6);
    expect(control.status()).toMatchObject({ index: before + 18, speed: 2 });
    control.slower(); control.slower();
    world.frame(DT * 6);
    expect(control.status()).toMatchObject({ index: before + 21, speed: 0.5 });
    control.setSpeed(3);
    expect(control.status().speed).toBe(0.5);
    control.faster(); control.faster(); control.faster(); control.faster(); control.faster();
    expect(control.status().speed).toBe(8);
    control.pause();
    world.frame(DT * 6);
    expect(control.status()).toMatchObject({ index: before + 21, playing: false });
    control.step(1);
    expect(control.status().index).toBe(before + 22);
    control.step(-1);
    expect(control.status().index).toBe(before + 21);
    control.skip(1);
    expect(control.status().index).toBe(before + 21 + Math.round(1 / DT));
    control.stage(1);
    expect(world.staged).toBe(1);
    control.exit();
    expect(world.exited).toBe(true);
  });
  test('seeking uses native keyframes in both directions, not a full extension re-simulation', async () => {
    const {world, run, control} = game();
    await control.watch(run);
    world.frame(DT);
    control.seek(300);
    expect(world.restores).toBe(1);
    expect(world.steps).toBe(45);
    world.steps = 0;
    control.skip(-1);
    // 233 is re-simulated from the keyframe at 128, not from the start.
    expect(world.steps).toBe(300 - Math.round(1 / DT) - 128);
    expect(control.status().index).toBe(300 - Math.round(1 / DT));
    expect(world.session.state).toMatchObject({x: control.status().index});
    control.seek(10);
    expect(world.session.state).toMatchObject({x: 10});
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

  test('seeks put the HUD analysis back to the keyframe the game restores, or clear it', async () => {
    const {world, replay, run} = game();
    let ticks = 0, resets = 0;
    const settings = {showBoard: true};
    const coaching = {save: () => ({ticks}), restore: state => { ticks = state.ticks; }, reset: () => { ticks = 0; resets++; }};
    const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session,
      archive: {get: async () => replay}, coaching, settings});
    await control.watch(run);
    resets = 0;
    // The HUD analyses every tick it sees, then the extension keeps it at keyframe ticks.
    const prototype = world.adapter.Session.prototype, step = prototype.step;
    prototype.step = function (...args) { const result = step.apply(this, args); ticks++; control.tick(this); return result; };
    // Natural playback collects every keyframe. A forward seek can instead
    // restore one indexed in the worker that this HUD has never observed.
    world.frame(DT * 300);
    expect(ticks).toBe(300);
    control.seek(200);
    expect([ticks, resets]).toEqual([200, 0]);
    // Presentation settings keep what was kept; analysis settings drop it.
    settings.speedColor = '#ffffff';
    control.settingsChanged();
    control.seek(130);
    expect([ticks, resets]).toEqual([130, 0]);
    settings.showBoard = false;
    control.settingsChanged();
    control.seek(100);
    expect([ticks, resets]).toEqual([100, 2]);
    control.destroy();
  });
  test('at the end the game holds the last frame: ended, not playing', async () => {
    const { world, run, control } = game();
    await control.watch(run);
    control.seek(395);
    world.frame(DT * 3.5);
    expect(control.status()).toMatchObject({ index: 398, playing: true, ended: false });
    world.frame(0.2);
    expect(control.status()).toMatchObject({ index: 400, playing: false, ended: true });
    expect(world.playing).not.toBeNull();
  });
  test('at the end, play starts over', async () => {
    const { world, run, control } = game();
    await control.watch(run);
    control.seek(400);
    world.frame(0.1);
    expect(control.status()).toMatchObject({ ended: true, playing: false });
    control.play();
    expect(control.status()).toMatchObject({index: 0, playing: true});
  });
  test('someone else\'s replay gets ramp boards from its analysis, started once the game has indexed it', async () => {
    const {world, replay} = game();
    const requests = [];
    let finish;
    const boardsFor = request => {
      requests.push(request);
      return {result: null, promise: new Promise(resolve => { finish = resolve; }), release() { request.released = true; }};
    };
    const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session, boardsFor});
    try {
      await world.hooks.watch(replay);
      // The game is still indexing: the analysis waits rather than compete with it.
      world.player.index.complete = false;
      control.status();
      expect(requests).toHaveLength(0);
      world.player.index.complete = true;
      control.status(); control.status();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({replay, session: world.session, analysis: null});
      expect(requests[0].isCurrent()).toBe(true);
      // Boards past the replay's end are dropped; a summary for other movement rules marks nothing.
      finish({config: {dt: DT}, feedback: {route: {boards: [{key: 'a', tick: 30, loss: 3}, {key: 'b', tick: 380, loss: null}, {key: 'c', tick: 900, loss: 1}]}}});
      await Promise.resolve();
      expect(requests[0].released).toBe(true);
      expect(control.status().ramps).toEqual([{tick: 30, label: 'Ramp', board: 3, tone: 'muted'}, {tick: 380, label: 'Ramp', board: null, tone: 'muted'}]);
      // A PB opened from the Runs view names its analysis; leaving releases an unfinished one.
      await control.watchLoaded(async () => ({...replay}), {title: 'Your PB', analysis: {key: 'pb-key', entry: {runId: 'pb'}}});
      control.status();
      expect(requests[1].analysis).toEqual({key: 'pb-key', entry: {runId: 'pb'}});
      expect(requests[1].isCurrent()).toBe(true);
      await world.hooks.watch({...replay});
      control.status();
      expect(requests[1]).toMatchObject({released: true});
      expect(requests[1].isCurrent()).toBe(false);
      finish({config: {dt: 0.02}, feedback: {route: {boards: [{key: 'a', tick: 30, loss: 3}]}}});
      await Promise.resolve();
      expect(control.status().ramps).toEqual([]);
    } finally { control.destroy(); }
  });

  test('a replay the game started itself is taken over, with its start and checkpoints from the game\'s index', async () => {
    const { world, replay, control } = game();
    expect(control.status()).toBeNull();
    await world.hooks.watch(replay); // e.g. the leaderboard's own Watch button
    expect(control.status()).toMatchObject({ title: 'Watching a replay', index: 0, start: 0, markers: [], ramps: [], run: null, playing: true });
    world.player.index.markers = [{ kind: 'start', index: 120 }, { kind: 'checkpoint', index: 220 }];
    expect(control.status()).toMatchObject({ start: 120, markers: [220] });
    control.setSpeed(4);
    world.frame(DT * 3);
    expect(control.status().index).toBe(12);
  });
  test('new checkpoints and editing bookmarks never mutate an earlier timeline snapshot', async () => {
    const {world, replay, control} = game();
    await control.watchLoaded(async () => replay, {title: 'Leaderboard run'});
    world.player.index.markers = [{kind: 'start', index: 120}, {kind: 'checkpoint', index: 220}];
    const first = control.status();
    world.player.index.markers = [...world.player.index.markers, {kind: 'checkpoint', index: 320}];
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
    world.practice = practiceBank(world, store);
    await control.watch({...run, spots: [180]});
    Object.assign(world.session, {capturePractice() { return {tick: this.state.tick}; }});
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

  test('native exit files locations when it keeps the replay session for practice', async () => {
    const {world, run, control} = game();
    const store = {banks: new Map(), nextId: 1, revision: 0};
    world.practice = practiceBank(world, store);
    try {
      await control.watch(run);
      const session = world.session;
      Object.assign(session, {practiceKey: () => 'practice',
        capturePractice() { return {state: {...this.state}}; }});
      control.seek(180);
      control.saveSpot();
      expect(control.active).toBe(true);
      expect(store.banks.size).toBe(0);
      control.exit();
      expect(world.session).toBe(session);
      expect(control.active).toBe(false);
      expect(store.banks.get('practice')).toMatchObject({selected: 1,
        entries: [{id: 1, snapshot: {key: 'practice', state: {x: 180, tick: 180}}}]});
      expect(control.status()).toBeNull();
      expect(store.revision).toBe(1);
    } finally { control.destroy(); }
  });


  test('saved locs become practice savelocs in the game you return to, under its rules', async () => {
    const { world, run, control } = game();
    const store = { banks: new Map(), nextId: 1, revision: 0 };
    world.practice = practiceBank(world, store);
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
      capturePractice() { return { key: 'utopia-v2-rules-5', tick: this.state.tick }; } });
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
    world.practice = practiceBank(world, store);
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

describe('native replay boundaries', () => {
  test('durable archive offsets repair stale run metadata without shifting an already-adjusted start twice', async () => {
    for (const recordedOffset of [0, 50, 200]) {
      const {world, replay, run} = game(1200);
      run.replay = {start: 300 - recordedOffset, offset: recordedOffset};
      run.checkpoints = [{command: 500}];
      run.boards = [[1000, 4, 'ramp']];
      const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session,
        archive: {get: async () => replay, offset: () => 200}});
      try {
        expect(await control.watch(run, {rampKey: 'ramp'})).toBe(true);
        control.setVisible(true);
        expect(control.status()).toMatchObject({index: 767, start: 100, markers: [300],
          ramps: [{tick: 800, board: 4}]});
      } finally { control.destroy(); }
    }
  });

  test('a first-click ramp jump waits paused for native indexing before seeking', async () => {
    const {world, run, control} = game(1200);
    run.boards = [[1000, 4, 'ramp']];
    let opened;
    const ready = new Promise(resolve => { opened = resolve; }), watch = world.hooks.watch;
    world.hooks.watch = async (...args) => {
      await watch(...args);
      world.player.index.indexed = 0;
      world.player.index.complete = false;
      opened();
    };
    try {
      const pending = control.watch(run, {rampKey: 'ramp'});
      await ready; await Promise.resolve();
      expect(control.adopting).toBe(true);
      expect(control.status()).toMatchObject({index: 0, reachable: 0, playing: false, complete: false});
      world.frame(DT * 100);
      expect(world.index).toBe(0);
      world.player.index.indexed = 1000;
      expect(await pending).toBe(true);
      expect(control.status()).toMatchObject({index: 967, playing: false, complete: false});
      expect(world.steps).toBeLessThan(128);
      expect(control.adopting).toBe(false);
    } finally { control.destroy(); }
  });

  test.each(['ownership', 'account', 'native-watch', 'exit', 'destroy'])('waiting ramp navigation cancels on %s without a late seek', async change => {
    const {world, replay, run, control} = game(1200);
    run.boards = [[1000, 4, 'ramp']];
    let current = true, account = 'a', opened;
    world.adapter.getReferences = () => ({ownerKey: account});
    const ready = new Promise(resolve => { opened = resolve; }), watch = world.hooks.watch;
    world.hooks.watch = async (...args) => {
      await watch(...args);
      world.player.index.indexed = 0;
      world.player.index.complete = false;
      opened();
    };
    try {
      const pending = control.watch(run, {rampKey: 'ramp', isCurrent: () => current});
      await ready; await Promise.resolve();
      const oldIndex = world.player.index;
      if (change === 'ownership') current = false;
      if (change === 'account') account = 'b';
      if (change === 'native-watch') await world.watchNative(async () => ({...replay}));
      if (change === 'exit') control.exit();
      if (change === 'destroy') control.destroy();
      oldIndex.indexed = 1200;
      expect(await pending).toBe(false);
      expect(world.seeks).toBe(0);
      expect(control.adopting).toBe(false);
    } finally { control.destroy(); }
  });

  test('completed native finish bounds replace the raw command count on both local and adopted runs', async () => {
    for (const local of [true, false]) {
      const {world, replay, run, control} = game(1000);
      try {
        if (local) await control.watch(run);
        else await world.watchNative(async () => replay);
        world.player.index.end = 390;
        expect(control.status()).toMatchObject({length: 390, reachable: 390, complete: true});
        control.seek(900);
        expect(control.status()).toMatchObject({index: 390, ended: true, playing: false});
        control.play();
        expect(control.status()).toMatchObject({index: 0, ended: false, playing: true});
      } finally { control.destroy(); }
    }
  });

  test('index completion before the requested ramp rejects an unreachable jump', async () => {
    const {world, run, control} = game(1200);
    run.boards = [[1000, 4, 'ramp']];
    const watch = world.hooks.watch;
    world.hooks.watch = async (...args) => { await watch(...args); world.player.index.end = 400; };
    try {
      expect(await control.watch(run, {rampKey: 'ramp'})).toBe(false);
      expect(world.seeks).toBe(0);
      expect(control.status()).toMatchObject({length: 400, index: 0, playing: false});
    } finally { control.destroy(); }
  });

  test('closing a native replay without changing session clears all control and metadata', async () => {
    const {world, run, control} = game();
    await control.watch(run);
    control.seek(100); control.saveSpot();
    const session = world.session;
    control.exit();
    expect(world.session).toBe(session);
    expect(control.active).toBe(false);
    expect(control.status()).toBeNull();
    expect(control.saveSpot()).toBe(false);
    expect(control.seek(200)).toBe(false);
  });

  test('replacing native replay in the same session drops local bookmarks and adopts the new native index', async () => {
    const {world, replay, run, control} = game();
    try {
      await control.watch(run);
      control.seek(100); control.saveSpot();
      world.player.open({...replay, commands: replay.commands.slice(0, 200)});
      world.player.index.markers = [{kind: 'start', index: 20}, {kind: 'checkpoint', index: 80}];
      expect(control.status()).toMatchObject({run: null, spots: [], start: 20, markers: [80], length: 200});
    } finally { control.destroy(); }
  });

  test('account changes and in-place map changes invalidate pending archive reads', async () => {
    for (const change of ['account', 'map']) {
      const {world, replay, run} = game();
      world.session = {map: {id: 'utopia', version: 1}};
      let account = 'a', finish;
      world.adapter.getReferences = () => ({ownerKey: account});
      const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session,
        archive: {get: () => new Promise(resolve => { finish = resolve; })}});
      try {
        const pending = control.watch(run);
        if (change === 'account') account = 'b';
        else world.session.map.version = 2;
        finish(replay);
        expect(await pending).toBe(false);
        expect(world.playing).toBeNull();
      } finally { control.destroy(); }
    }
  });

  test('real observer resets precede coaching restoration and uncached worker seeks cannot contaminate later caches', async () => {
    const {world, replay, run} = game(1000);
    replay.initialState = {x: 0, tick: 900};
    class Movement { accelerate() {} slide() {} }
    world.adapter.Movement = Movement;
    const prototype = world.adapter.Session.prototype;
    prototype.restart = prototype.visitStation = function () {};
    const originalRestore = prototype.restorePractice;
    const metrics = createMetrics();
    const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session,
      archive: {get: async () => replay}, coaching: {save: () => metrics.saveState(),
        restore: state => metrics.restoreState(state), reset: tick => metrics.reset({replayGap: tick > 0})}});
    const observer = observePhysics(world.adapter, metrics, {
      onBeforeTick: session => control.observe(session), onTick: session => control.tick(session),
    });
    try {
      await control.watch(run);
      world.frame(DT * 300);
      control.seek(200);
      expect(metrics.saveState().elapsed).toBeCloseTo(200 * DT, 8);
      expect(metrics.saveState().unknownRamp).toBe(false);
      control.seek(384); // Worker keyframe: HUD never played here.
      expect(metrics.saveState()).toMatchObject({elapsed: 0, unknownAir: true, unknownRamp: true});
      world.frame(DT * 128); // A partial continuation must not cache tick 512.
      control.seek(128);
      expect(metrics.saveState().elapsed).toBeCloseTo(128 * DT, 8);
      control.seek(512);
      expect(metrics.saveState()).toMatchObject({elapsed: 0, unknownAir: true, unknownRamp: true});
      control.seek(0);
      expect(metrics.saveState()).toMatchObject({elapsed: 0, unknownAir: false, unknownRamp: false});
      expect(observer.healthy).toBe(true);
    } finally { control.destroy(); observer.destroy(); }
    expect(prototype.restorePractice).toBe(originalRestore);
  });
});

test('disabled and Zen analysis never clone coaching frames, and changing settings requires a coherent anchor', async () => {
  for (const hidden of [{hud: false}, {zen: true}, {showBoard: false, showAir: false, showSurf: false, showStart: false}]) {
    const {world, replay, run} = game(1000);
    const settings = {...hidden};
    let saves = 0;
    const control = createReplayControl({getAdapter: () => world.adapter, getSession: () => world.session, settings,
      archive: {get: async () => replay}, coaching: {save: () => { saves++; return {}; }, restore() {}, reset() {}}});
    const prototype = world.adapter.Session.prototype, step = prototype.step;
    prototype.step = function (...args) { const result = step.apply(this, args); control.tick(this); return result; };
    try {
      await control.watch(run);
      world.frame(DT * 300);
      expect(saves).toBe(0);
      Object.assign(settings, {hud: true, zen: false, showBoard: true, showAir: true, showSurf: true, showStart: true});
      control.settingsChanged();
      world.frame(DT * 100);
      expect(saves).toBe(0);
      control.seek(0);
      world.frame(DT * 128);
      expect(saves).toBe(1);
    } finally { control.destroy(); }
  }
});

test('session replacement without native reopen cannot adopt a stale replay, but a real reopen of the same data can', async () => {
  const {world, replay, run, control} = game();
  try {
    await control.watch(run);
    control.seek(100); control.saveSpot();
    world.session = new world.adapter.Session();
    expect(control.active).toBe(false);
    expect(control.status()).toBeNull();
    expect(control.seek(200)).toBe(false);
    await world.watchNative(async () => replay); // Same cached data, a new native open/revision.
    expect(control.status()).toMatchObject({index: 0, run: null, spots: [], playing: true});
  } finally { control.destroy(); }
});

describe('replay locs under current native practice rules', () => {
  test('legacy Exit files exact snapshots once into the current bank, and native Load works after Restart', async () => {
    const {world, run, control} = game();
    const map = {id: 'utopia', version: 3};
    const key = format => JSON.stringify([map.id, map.version, 'current-rules', format]);
    const legacyEntry = {id: 1, snapshot: {key: key(7), state: {tick: 10}}};
    const currentEntry = {id: 2, snapshot: {key: key(8), state: {tick: 20}}};
    const legacyBank = {entries: [legacyEntry], selected: 1};
    const currentBank = {entries: [currentEntry], selected: 2};
    const store = {banks: new Map([[key(7), legacyBank], [key(8), currentBank]]), nextId: 3, revision: 0,
      restore(session) {
        const bank = this.banks.get(session.practiceKey());
        const entry = bank?.entries.find(entry => entry.id === bank.selected);
        return !!entry && session.restorePractice(entry.snapshot);
      }};
    world.practice = {store: () => store, destination: () => ({mapId: map.id, mapVersion: map.version, key: key(8)})};
    const snapshots = [];
    try {
      await control.watch(run);
      const legacy = world.session;
      Object.assign(legacy, {map, replayFormat: 7, practiceKey: () => key(7), capturePractice() {
        const snapshot = {key: key(7), state: {...this.state, velocity: {x: 456, y: 123, z: -50}},
          timer: {state: {phase: 'running', elapsed: 2.5, splits: [1]}},
          checkpointSpeeds: [1234], startPosition: {x: 1, y: 2, z: 3}, startJumps: 2,
          startGroundTime: 0.1, startHopWarned: false, startRegion: 'start', rawJumpHeld: true,
          stageStartRecovery: true};
        snapshots.push(snapshot);
        return snapshot;
      }});
      control.seek(180); control.saveSpot();
      control.seek(200); control.saveSpot();
      control.exit();
      expect(control.active).toBe(false);
      expect(world.session).toBe(legacy);
      expect(legacy.replayFormat).toBe(7);
      expect(legacyBank).toEqual({entries: [legacyEntry], selected: 1});
      expect(currentBank.entries).toEqual([currentEntry, ...snapshots.map((snapshot, index) =>
        ({id: index + 3, snapshot: {...snapshot, key: key(8)}}))]);
      expect(currentBank.selected).toBe(4);
      expect(store.revision).toBe(2);
      const live = world.session = {map, replayFormat: 8, practiceKey: () => key(8),
        restorePractice(snapshot) {
          if (snapshot.key !== this.practiceKey()) return false;
          this.snapshot = structuredClone(snapshot);
          return true;
        }};
      control.observe(live); control.status(); control.status();
      expect(store.restore(live)).toBe(true);
      expect(live.snapshot).toEqual({...snapshots[1], key: key(8)});
      expect(currentBank.entries).toHaveLength(3);
      expect(store.revision).toBe(2);
      expect(legacyBank.entries).toEqual([legacyEntry]);
    } finally { control.destroy(); }
  });

  test('a filed loc carries the start position Restart would use, not the replay’s, so loading it keeps yours', async () => {
    const {world, run, control} = game();
    const map = {id: 'utopia', version: 3};
    const store = {banks: new Map(), nextId: 1, revision: 0};
    const yours = {position: {x: 40, y: -12, z: 64}, yaw: 90, pitch: 0};
    let startPosition = yours;
    world.practice = {store: () => store, destination: () => ({mapId: map.id, mapVersion: map.version, key: 'live', startPosition})};
    const replaySession = () => Object.assign(world.session, {map, practiceKey: () => 'replay',
      capturePractice() { return {key: 'replay', state: {tick: this.state.tick}, startPosition: null, startJumps: 1}; }});
    try {
      await control.watch(run);
      replaySession();
      control.seek(180); control.saveSpot(); control.exit(); control.status();
      expect(store.banks.get('live').entries[0].snapshot).toEqual({key: 'live', state: {tick: expect.any(Number)}, startPosition: yours, startJumps: 1});
      // With no start of your own set, the loc restores the map's default, as Restart does.
      startPosition = null;
      await control.watch(run);
      replaySession();
      control.seek(200); control.saveSpot(); control.exit(); control.status();
      expect(store.banks.get('live').entries[1].snapshot.startPosition).toBeNull();
    } finally { control.destroy(); }
  });

  test('unavailable or different-version native destinations defer filing instead of using the replay bank', async () => {
    const {world, run, control} = game();
    const store = {banks: new Map(), nextId: 1, revision: 0};
    let destination = null;
    world.practice = {store: () => store, destination: () => destination};
    try {
      await control.watch(run);
      Object.assign(world.session, {map: {id: 'utopia', version: 1}, practiceKey: () => 'legacy',
        capturePractice: () => ({key: 'legacy', state: {tick: 100}})});
      control.saveSpot(); control.exit(); control.status();
      expect(store.banks.size).toBe(0);
      destination = {mapId: 'utopia', mapVersion: 2, key: 'current-v2'};
      control.status();
      expect(store.banks.size).toBe(0);
      destination = {mapId: 'utopia', mapVersion: 1, key: 'current-v1'};
      control.status(); control.status();
      expect(store.banks.get('current-v1')).toEqual({selected: 1,
        entries: [{id: 1, snapshot: {key: 'current-v1', state: {tick: 100}}}]});
      expect(store.banks.has('legacy')).toBe(false);
      expect(store.revision).toBe(1);
    } finally { control.destroy(); }
  });
});
