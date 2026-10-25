import {describe, expect, test} from 'bun:test';
import {createRampReference} from '../src/ramp-reference.js';
import {createReplayControl} from '../src/replay-control.js';
import {routeFingerprint} from '../src/replay-store.js';

function rig({settings = {}} = {}) {
  let session = {map: {id: 'utopia', version: 3}, config: {dt: 0.015}, replayFormat: 8};
  let adapter = {Session: function () {}, Movement: function () {}};
  const acquired = [], completed = new Map();
  const replayStore = {
    acquire(request) {
      const result = completed.get(request.key) ?? null;
      const work = {...request, result, released: false, finish: null};
      acquired.push(work);
      return {result, promise: new Promise(resolve => { work.finish = result => {
        if (request.isCurrent() && result?.feedback) completed.set(request.key, result);
        resolve(result);
      }; }), release() { work.released = true; }};
    },
  };
  const refs = {boardId: 'b1', ownerKey: 'account', own: {runId: 'pb1', timeUs: 41e6, splitsUs: [10e6]}, loadReplay: async () => ({}), loadRecordRoute: async () => ({})};
  const options = {boardColorReference: 'pb', referenceLossTolerance: 2, boardLossAmazing: 5, boardLossGood: 20, ...settings};
  const reference = createRampReference({getSession: () => session, getReferences: () => refs, getAdapter: () => adapter, replayStore, settings: options});
  const consumer = reference.createConsumer();
  const route = {indices: new Map([['[7,0,1]', 0], ['[8,0,1]', 1]]), boards: [
    {valid: true, loss: 3, downLoss: 9, upLoss: 2, surfLoss: 11}, {valid: false, loss: 1}]};
  return {reference, consumer, acquired, refs, settings: options,
    finish: (index = acquired.length - 1, result = {feedback: {route}}) => acquired[index].finish(result),
    get session() { return session; }, set session(value) { session = value; },
    get adapter() { return adapter; }, set adapter(value) { adapter = value; }};
}

function navigationRig(settings) {
  const f = rig({settings});
  const data = {mapId: 'utopia', mapVersion: 3, format: 8, config: {dt: .015}, commands: Array(400).fill({})};
  const route = {indices: new Map([['[7,0,1]', 0], ['[7,0,2]', 1]]), boards: [
    {valid: true, tick: 5, loss: 3}, {valid: true, tick: 300, loss: 4}]};
  const summary = {feedback: {route, dt: .015}, fingerprint: routeFingerprint(data)};
  let generation = 0, playing = null, index = 0, starts = 0, reads = [];
  f.seeks = 0;
  // Surfd's player: the game plays, pauses and seeks; it has indexed the whole replay.
  const player = {
    get replay() { return playing; }, clock: {speed: 1, paused: false}, pending: null,
    index: {markers: [], get reachable() { return playing?.commands.length ?? 0; }, complete: true},
    host: {position: () => index, parked: () => false},
    get paused() { return this.clock.paused; },
    atEnd: () => !playing || index >= playing.commands.length,
    play() { this.clock.paused = false; },
    pause() { this.clock.paused = true; },
    requestSeek(tick) { this.pending = tick; },
    applyPending() { if (this.pending === null || !playing) return; f.seeks++; index = this.pending; this.pending = null; },
  };
  f.adapter.replay = {
    reserve: () => ++generation, isCurrent: token => token === generation,
    playback: () => ({replay: playing, index}),
    async watch(replay, _label, isCurrent, token) {
      if (token !== generation || !isCurrent()) return;
      starts++; playing = replay; index = 0; player.clock.paused = false; f.session = {...f.session};
    },
    transport: () => player,
  };
  f.refs.loadReplay = async id => { reads.push(id); return data; };
  f.refs.loadRecordRoute = async () => { reads.push('ksf'); return data; };
  f.refs.record = {runId: 'wr1', timeUs: 40e6, splitsUs: [10e6]};
  const control = createReplayControl({getAdapter: () => f.adapter, getSession: () => f.session});
  return {f, data, summary, control, reads, get starts() { return starts; }};
}

describe('reference ramp navigation', () => {
  test.each(['pb', 'wr', 'leaderboard'])('loads only requested %s and starts at its exact visit', async source => {
    const n = navigationRig({wrSource: source === 'leaderboard' ? 'leaderboard' : 'ksf'});
    const {f, summary, control, reads} = n;
    expect(f.acquired).toHaveLength(0);
    const request = f.consumer.watchRamp('utopia:3', source === 'pb' ? 'pb' : 'wr', '[7,0,2]', control);
    expect(f.acquired).toHaveLength(1);
    f.finish(0, summary);
    expect(await request).toBe(true);
    expect(control.status()).toMatchObject({index: 267, playing: false});
    expect(reads).toEqual([source === 'pb' ? 'pb1' : source === 'leaderboard' ? 'wr1' : 'ksf']);
    expect(n.starts).toBe(1);
    control.destroy(); f.reference.destroy();
  });

  test('uses the commands downloaded during new indexing rather than fetching them again', async () => {
    const {f, summary, control, reads} = navigationRig();
    const request = f.consumer.watchRamp('utopia:3', 'pb', '[7,0,1]', control);
    await f.acquired[0].load();
    f.finish(0, summary);
    expect(await request).toBe(true);
    expect(reads).toEqual(['pb1']);
    expect(control.status()).toMatchObject({index: 0, playing: false});
    control.destroy(); f.reference.destroy();
  });

  test('completed summaries reuse their index after same-map Watch without reacquiring analysis', async () => {
    const {f, summary, control, reads} = navigationRig();
    const slot = f.consumer.get('utopia:3', 'pb');
    f.finish(0, summary);
    await Promise.resolve();
    expect(slot.ramps.get('[7,0,2]').tick).toBe(300);
    expect(await f.consumer.watchRamp('utopia:3', 'pb', '[7,0,2]', control)).toBe(true);
    expect(await f.consumer.watchRamp('utopia:3', 'pb', '[7,0,1]', control, {leadSeconds: 0, paused: false})).toBe(true);
    expect(control.status()).toMatchObject({index: 5, playing: true});
    expect(f.acquired).toHaveLength(1);
    expect(reads).toEqual(['pb1', 'pb1']);
    control.destroy(); f.reference.destroy();
  });

  test('ready missing visits never download or start a nearby replay', async () => {
    const n = navigationRig(), {f, summary, control, reads} = n;
    f.consumer.get('utopia:3', 'pb');
    f.finish(0, summary);
    await Promise.resolve();
    expect(await f.consumer.watchRamp('utopia:3', 'pb', '[7,1,1]', control)).toBe(false);
    expect(await f.consumer.watchRamp('utopia:3', 'unknown', '[7,0,1]', control)).toBe(false);
    expect(await f.consumer.watchRamp('other:3', 'pb', '[7,0,1]', control)).toBe(false);
    expect(reads).toEqual([]);
    expect(n.starts).toBe(0);
    control.destroy(); f.reference.destroy();
  });

  test.each(['account', 'map', 'version', 'config', 'source', 'identity', 'session', 'adapter', 'release', 'native'])(
    '%s changes during indexing cannot start or seek a stale destination', async change => {
      const n = navigationRig(), {f, summary, control, reads} = n;
      const request = f.consumer.watchRamp('utopia:3', 'wr', '[7,0,2]', control);
      if (change === 'account') f.refs.ownerKey = 'new-account';
      if (change === 'map') f.session.map.id = 'other';
      if (change === 'version') f.session.map.version++;
      if (change === 'config') f.session.config.dt = .01;
      if (change === 'source') f.settings.wrSource = 'leaderboard';
      if (change === 'identity') { f.settings.wrSource = 'leaderboard'; f.refs.record.runId = 'new'; }
      if (change === 'session') f.session = {...f.session};
      if (change === 'adapter') f.adapter = {...f.adapter};
      if (change === 'release') f.consumer.release();
      if (change === 'native') f.adapter.replay.reserve();
      expect(f.acquired[0].isCurrent()).toBe(false);
      f.finish(0, summary);
      expect(await request).toBe(false);
      expect(reads).toEqual([]);
      expect(n.starts).toBe(0);
      control.destroy(); f.reference.destroy();
    });

  test('stale download context and changed KSF fingerprints never start the wrong route', async () => {
    for (const change of ['owner', 'config', 'fingerprint', 'map', 'bounds']) {
      const n = navigationRig(), {f, summary, control, data} = n;
      f.consumer.get('utopia:3', 'wr');
      f.finish(0, summary);
      await Promise.resolve();
      let finish;
      f.refs.loadRecordRoute = () => new Promise(resolve => { finish = resolve; });
      const request = f.consumer.watchRamp('utopia:3', 'wr', '[7,0,2]', control);
      if (change === 'owner') f.refs.ownerKey = 'other';
      const downloaded = {...data,
        ...(change === 'map' ? {mapVersion: 4} : {}),
        ...(change === 'config' ? {config: {dt: .02}} : {}),
        ...(change === 'fingerprint' ? {commands: [...data.commands, {}]} : {}),
        ...(change === 'bounds' ? {commands: []} : {})};
      finish(downloaded);
      expect(await request).toBe(false);
      expect(n.starts).toBe(0);
      control.destroy(); f.reference.destroy();
    }
  });

  test('navigation cancellation releases only its own analysis consumer and can retry', async () => {
    const n = navigationRig(), {f, summary, control} = n;
    const hud = f.reference.createConsumer();
    hud.get('utopia:3', 'pb');
    const request = f.consumer.watchRamp('utopia:3', 'pb', '[7,0,2]', control);
    f.adapter.replay.reserve();
    f.finish(1, summary);
    expect(await request).toBe(false);
    expect(f.acquired[0].isCurrent()).toBe(true);
    f.finish(0, summary);
    await Promise.resolve();
    expect(hud.get('utopia:3', 'pb').status).toBe('ready');
    expect(await f.consumer.watchRamp('utopia:3', 'pb', '[7,0,2]', control)).toBe(true);
    expect(f.acquired[1].released).toBe(true);
    control.destroy(); f.reference.destroy();
  });
});

describe('ramp reference', () => {
  test('loads the PB route for the map in the game and shares the HUD key', async () => {
    const {reference, consumer, acquired, finish} = rig();
    expect(consumer.get('mesa:1', 'pb')).toBeNull();
    const slot = consumer.get('utopia:3', 'pb');
    expect(slot).toMatchObject({status: 'loading', label: 'PB'});
    expect(acquired).toHaveLength(1);
    expect(acquired[0]).toMatchObject({feedback: true});
    expect(acquired[0].key).toEndWith(':official:' + JSON.stringify(['pb1', 41e6, [10e6]]));
    let heard = 0;
    reference.subscribe(() => heard++);
    finish();
    await Promise.resolve();
    expect(consumer.get('utopia:3', 'pb')).toMatchObject({status: 'ready'});
    expect([...slot.ramps]).toEqual([['[7,0,1]', {board: 3, down: 9, up: 2, surf: 11}]]);
    expect(heard).toBe(1);
    expect(acquired).toHaveLength(1);
    expect(acquired[0].released).toBe(true);
  });

  test('availability never acquires either source and only the requested source loads', () => {
    const {reference, consumer, acquired} = rig();
    expect(reference.sources('utopia:3')).toEqual([{name: 'pb', label: 'PB'}, {name: 'wr', label: 'KSF WR'}]);
    expect(reference.sources('mesa:1')).toEqual([]);
    expect(acquired).toHaveLength(0);
    consumer.get('utopia:3', 'wr');
    expect(acquired).toHaveLength(1);
    expect(acquired[0].key).toEndWith(':ksf');
    const leaderboard = rig({settings: {wrSource: 'leaderboard'}});
    expect(leaderboard.reference.sources('utopia:3')).toEqual([{name: 'pb', label: 'PB'}]);
    expect(leaderboard.consumer.get('utopia:3', 'wr')).toBeNull();
  });

  test('source switches and release cancel only their separately owned consumer', async () => {
    const {reference, consumer, acquired, finish} = rig();
    const timeline = reference.createConsumer();
    consumer.get('utopia:3', 'pb');
    timeline.tone('[7,0,1]', 4);
    consumer.get('utopia:3', 'wr');
    expect(acquired.map(work => work.released)).toEqual([true, false, false]);
    consumer.release();
    consumer.release();
    expect(acquired.map(work => work.isCurrent())).toEqual([false, true, false]);
    finish(0);
    finish(2);
    await Promise.resolve();
    expect(timeline.tone('[7,0,1]', 4)).toBe('muted');
    finish(1);
    await Promise.resolve();
    expect(timeline.tone('[7,0,1]', 4)).toBe('warn');
    reference.destroy();
    expect(timeline.get('utopia:3', 'pb')).toBeNull();
    expect(reference.sources('utopia:3')).toEqual([]);
  });

  test.each(['session', 'adapter'])('pending same-key references reacquire after native %s replacement', async owner => {
    const fixture = rig();
    const {consumer, acquired, finish} = fixture;
    const old = consumer.get('utopia:3', 'pb');
    fixture[owner] = {...fixture[owner]};
    expect(acquired[0].isCurrent()).toBe(false);
    const current = consumer.get('utopia:3', 'pb');
    expect(current).not.toBe(old);
    expect(current.status).toBe('loading');
    expect(acquired).toHaveLength(2);
    expect(acquired[0].released).toBe(true);
    finish(0, null);
    await Promise.resolve();
    expect(consumer.get('utopia:3', 'pb')).toBe(current);
    expect(current.status).toBe('loading');
    finish(1);
    await Promise.resolve();
    expect(consumer.get('utopia:3', 'pb').status).toBe('ready');
  });

  test('completed summaries survive same-map Watch and can be reused after release', async () => {
    const fixture = rig();
    const {consumer, acquired, finish} = fixture;
    const slot = consumer.get('utopia:3', 'pb');
    finish();
    await Promise.resolve();
    fixture.session = {...fixture.session};
    expect(consumer.get('utopia:3', 'pb')).toBe(slot);
    expect(acquired).toHaveLength(1);
    consumer.release();
    expect(consumer.get('utopia:3', 'pb').status).toBe('ready');
    expect(acquired).toHaveLength(2);
    expect(acquired[1].result.feedback).toBeDefined();
  });

  test('changing map or account invalidates pending ownership before publication', async () => {
    const fixture = rig();
    const {consumer, acquired, finish, refs} = fixture;
    consumer.get('utopia:3', 'pb');
    refs.ownerKey = 'other-account';
    expect(acquired[0].isCurrent()).toBe(false);
    consumer.get('utopia:3', 'pb');
    finish(0);
    await Promise.resolve();
    expect(consumer.get('utopia:3', 'pb').status).toBe('loading');
    fixture.session.map = {id: 'mesa', version: 1};
    expect(consumer.get('utopia:3', 'pb')).toBeNull();
    expect(acquired[1].released).toBe(true);
    finish(1);
    await Promise.resolve();
    expect(consumer.get('utopia:3', 'pb')).toBeNull();
  });

  test('board tones follow the HUD: against the reference, or fixed cutoffs', async () => {
    const {consumer, finish, settings, acquired} = rig();
    expect(consumer.tone('[7,0,1]', 4)).toBe('muted');
    finish();
    await Promise.resolve();
    expect(consumer.tone('[7,0,1]', 2)).toBe('good');
    expect(consumer.tone('[7,0,1]', 4)).toBe('warn');
    expect(consumer.tone('[7,0,1]', 9)).toBe('loss');
    expect(consumer.tone('[9,0,1]', 2)).toBe('muted');
    settings.boardColorReference = 'wr';
    consumer.tone('[7,0,1]', 4);
    settings.boardColorReference = 'fixed';
    expect(consumer.tone('[7,0,1]', 4)).toBe('good');
    expect(acquired[1].released).toBe(true);
    expect(consumer.tone('[7,0,1]', 30)).toBe('loss');
  });
});

describe('ramp Watch ownership regressions', () => {
  test.each(['account', 'adapter'])('a completed index rebinds its %s owner before reuse', async owner => {
    const {f, summary, control} = navigationRig();
    const first = f.consumer.get('utopia:3', 'pb');
    f.finish(0, summary);
    await Promise.resolve();
    if (owner === 'account') f.refs.ownerKey = 'other-account';
    else f.adapter = {...f.adapter};
    const rebound = f.consumer.get('utopia:3', 'pb');
    expect(rebound).not.toBe(first);
    expect(rebound.status).toBe('ready');
    expect(f.acquired).toHaveLength(2);
    expect(await f.consumer.watchRamp('utopia:3', 'pb', '[7,0,2]', control)).toBe(true);
    control.destroy(); f.reference.destroy();
  });

  test.each([false, true])('competing cached ramp clicks honor the latest intent (older first: %s)', async olderFirst => {
    const n = navigationRig(), {f, summary, control, data} = n;
    f.consumer.get('utopia:3', 'pb');
    f.finish(0, summary);
    await Promise.resolve();
    const downloads = [];
    f.refs.loadReplay = () => new Promise(resolve => downloads.push(resolve));
    const older = f.consumer.watchRamp('utopia:3', 'pb', '[7,0,2]', control);
    const newer = f.consumer.watchRamp('utopia:3', 'pb', '[7,0,1]', control, {leadSeconds: 0});
    if (olderFirst) {
      downloads[0](data);
      expect(await older).toBe(false);
      expect(n.starts).toBe(0);
    }
    downloads[1](data);
    expect(await newer).toBe(true);
    if (!olderFirst) {
      downloads[0](data);
      expect(await older).toBe(false);
    }
    expect(n.starts).toBe(1);
    expect(control.status()).toMatchObject({index: 5, playing: false});
    expect(f.acquired).toHaveLength(1);
    control.destroy(); f.reference.destroy();
  });

  test('a superseded indexing response cannot clear the winning index or navigation', async () => {
    const n = navigationRig(), {f, summary, control} = n;
    const older = f.consumer.watchRamp('utopia:3', 'pb', '[7,0,2]', control);
    const newer = f.consumer.watchRamp('utopia:3', 'pb', '[7,0,1]', control, {leadSeconds: 0});
    expect(f.acquired).toHaveLength(2);
    f.finish(1, summary);
    expect(await newer).toBe(true);
    f.finish(0, summary);
    expect(await older).toBe(false);
    expect(f.consumer.get('utopia:3', 'pb').status).toBe('ready');
    expect(f.acquired).toHaveLength(2);
    expect(f.acquired.every(work => work.released)).toBe(true);
    expect(n.starts).toBe(1);
    expect(control.status()).toMatchObject({index: 5, playing: false});
    control.destroy(); f.reference.destroy();
  });

  test('release invalidates navigation even when its index was already ready', async () => {
    const n = navigationRig(), {f, summary, control, data} = n;
    f.consumer.get('utopia:3', 'pb');
    f.finish(0, summary);
    await Promise.resolve();
    let finish;
    f.refs.loadReplay = () => new Promise(resolve => { finish = resolve; });
    const request = f.consumer.watchRamp('utopia:3', 'pb', '[7,0,2]', control);
    f.consumer.release();
    finish(data);
    expect(await request).toBe(false);
    expect(n.starts).toBe(0);
    control.destroy(); f.reference.destroy();
  });

  test('KSF playback rejects an unsampled command change with unchanged length and endpoints', async () => {
    const n = navigationRig(), {f, summary, control, data} = n;
    f.consumer.get('utopia:3', 'wr');
    f.finish(0, summary);
    await Promise.resolve();
    const changed = {...data, commands: data.commands.slice()};
    changed.commands[17] = {yaw: 180};
    f.refs.loadRecordRoute = async () => changed;
    expect(await f.consumer.watchRamp('utopia:3', 'wr', '[7,0,2]', control)).toBe(false);
    expect(n.starts).toBe(0);
    control.destroy(); f.reference.destroy();
  });

  test('native adoption can change replay format and non-movement config labels', async () => {
    const {f, summary, control, data} = navigationRig();
    data.config = {...data.config, version: 'legacy', unrestrictedStart: true};
    data.format = 7;
    summary.fingerprint = routeFingerprint(data);
    const nativeWatch = f.adapter.replay.watch;
    f.adapter.replay.watch = async (...args) => {
      await nativeWatch(...args);
      f.session = {...f.session, config: data.config, replayFormat: data.format};
    };
    const request = f.consumer.watchRamp('utopia:3', 'wr', '[7,0,2]', control);
    f.finish(0, summary);
    expect(await request).toBe(true);
    expect(control.status()).toMatchObject({index: 267, playing: false});
    control.destroy(); f.reference.destroy();
  });

  test.each(['account', 'release', 'config'])('post-start %s changes cannot seek a stale ramp', async change => {
    const {f, summary, control} = navigationRig();
    const nativeWatch = f.adapter.replay.watch;
    f.adapter.replay.watch = async (...args) => {
      await nativeWatch(...args);
      if (change === 'account') f.refs.ownerKey = 'other-account';
      if (change === 'release') f.consumer.release();
      if (change === 'config') f.session = {...f.session, config: {dt: .02}};
    };
    const request = f.consumer.watchRamp('utopia:3', 'pb', '[7,0,2]', control);
    f.finish(0, summary);
    expect(await request).toBe(false);
    expect(f.seeks).toBe(0);
    control.destroy(); f.reference.destroy();
  });
});

describe('official ramp download identity', () => {
  test.each(['pb', 'wr'])('a changed %s entry invalidates an already-indexed pending download', async source => {
    const n = navigationRig({wrSource: 'leaderboard'}), {f, summary, control, data} = n;
    f.consumer.get('utopia:3', source);
    f.finish(0, summary);
    await Promise.resolve();
    let finish;
    f.refs.loadReplay = () => new Promise(resolve => { finish = resolve; });
    const request = f.consumer.watchRamp('utopia:3', source, '[7,0,2]', control);
    f.refs[source === 'pb' ? 'own' : 'record'].runId = 'replacement';
    finish(data);
    expect(await request).toBe(false);
    expect(n.starts).toBe(0);
    control.destroy(); f.reference.destroy();
  });
});

describe('imported native replay adoption', () => {
  test('repeated cached ramp clicks do not reanalyze after adopting the replay format and labels', async () => {
    const n = navigationRig(), {f, summary, control, data, reads} = n;
    data.config = {...data.config, version: 'legacy', unrestrictedStart: true};
    data.format = 7;
    summary.fingerprint = routeFingerprint(data);
    const nativeWatch = f.adapter.replay.watch;
    f.adapter.replay.watch = async (...args) => {
      await nativeWatch(...args);
      f.session = {...f.session, config: data.config, replayFormat: data.format};
    };
    const first = f.consumer.watchRamp('utopia:3', 'wr', '[7,0,2]', control);
    f.finish(0, summary);
    expect(await first).toBe(true);
    expect(await f.consumer.watchRamp('utopia:3', 'wr', '[7,0,1]', control, {leadSeconds: 0})).toBe(true);
    expect(f.acquired).toHaveLength(1);
    expect(reads).toEqual(['ksf', 'ksf']);
    expect(n.starts).toBe(2);
    expect(control.status()).toMatchObject({index: 5, playing: false});
    control.destroy(); f.reference.destroy();
  });
});
