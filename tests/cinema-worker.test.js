import {describe, expect, test} from 'bun:test';
import {createReplayIndexJobs, createReplayIndexWorker} from '../extension/replay-index-worker.js';
import {createCinemaWorkerRuntime} from '../src/cinema-worker-runtime.js';
import {recordTrack} from '../src/cinema-track.js';
import {TRACK_ARRAYS, trackSlice} from '../src/cinema-recording.js';
import {planCamera} from '../src/cinema-camera.js';
import {alignByTime} from '../src/cinema-sync.js';
import {PROBE} from '../src/cinema-world.js';
import {onClock} from '../src/cinema-clock.js';
import {createCinema} from '../src/cinema.js';

const protocol = data => ({__surfdQolIndex: 1, ...data});
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const turn = () => new Promise(resolve => setTimeout(resolve, 0));

function physics() {
  const map = {id: 'map', version: 'v1', brushes: [], displacementTriangles: []};
  let constructions = 0, steps = 0;
  class Movement {
    slide(state, result) { if (state.ramp) result.contacts.push({normal: {x: 0, y: -0.8, z: 0.6}}); }
  }
  class Session {
    constructor(map, config) {
      constructions++;
      this.map = map; this.config = config; this.movement = new Movement();
      this.timer = {state: {phase: 'ready', elapsed: 0, splits: []}};
    }
    loadReplay(replay) { this.state = structuredClone(replay.initialState); }
    capturePractice() { return structuredClone({state: this.state, timer: this.timer.state}); }
    restorePractice(snapshot) { this.state = structuredClone(snapshot.state); this.timer.state = structuredClone(snapshot.timer); return true; }
    step(command) {
      steps++;
      this.state.tick++;
      this.state.position.x = command.x ?? this.state.position.x + 10;
      this.state.position.z = command.z ?? this.state.position.z;
      this.state.yaw = command.yaw ?? this.state.yaw;
      this.state.grounded = command.grounded ?? this.state.grounded;
      this.state.ducked = command.ducked ?? false;
      this.state.ramp = command.ramp ?? false;
      this.movement.slide(this.state, {contacts: []});
      if (command.timer) this.timer.state = structuredClone(command.timer);
      return command.events ?? [];
    }
  }
  const replay = (count = 12) => ({mapId: map.id, mapVersion: map.version, format: 8, config: {dt: 0.01, groundNormal: 0.7},
    initialState: {tick: 100, position: {x: 0, y: 0, z: 50}, yaw: 0, grounded: true},
    commands: Array.from({length: count}, () => ({}))});
  const createSession = (map, replay) => { const session = new Session(map, replay.config); session.loadReplay(replay); return session; };
  return {map, Movement, Session, replay, createSession, counts: () => ({constructions, steps})};
}

// A structured-clone boundary, including real transfer detachment. Consumers
// run the real recording/planning implementation, not an echo RPC substitute.
function bridge(f, count = 12, batchSize = 1) {
  const pool = createReplayIndexJobs(async () => { throw new Error('Warm geometry must not be packed for camera'); });
  const nativePauses = [], posted = [], batches = [];
  let nativeJob = null, runtime, receive;
  const worker = {
    terminated: false,
    postMessage(message) {
      posted.push(message);
      const data = structuredClone(message);
      queueMicrotask(() => { if (!this.terminated) receive(data); });
    },
    terminate() { this.terminated = true; },
  };
  const post = (message, options) => {
    const data = structuredClone(message, {transfer: options?.transfer ?? []});
    queueMicrotask(() => { if (!worker.terminated) worker.onmessage?.({data}); });
  };
  runtime = createCinemaWorkerRuntime({post, createSession: f.createSession});
  receive = createReplayIndexWorker(post, async (message, job) => {
    const session = f.createSession(f.map, message.replay);
    nativeJob = {session, job, replay: message.replay};
    runtime.attach(session, message.replay, message.job);
    job.world(f.map);
    try {
      let index = 0;
      while (index < message.replay.commands.length && job.current()) {
        await runtime.before(message.job);
        if (!job.current()) break;
        const end = Math.min(message.replay.commands.length, index + batchSize);
        while (index < end) session.step(message.replay.commands[index++]);
        job.emit({ok: true, batch: {done: index === message.replay.commands.length}});
        await runtime.batch(message.job, index);
        if (index < message.replay.commands.length) await job.pause();
      }
    } finally { runtime.detach(message.job); }
  }, () => new Promise(resolve => nativePauses.push(resolve)), runtime);
  const replay = f.replay(count);
  const lease = pool.acquire(f.map, replay, {map: f.map}, () => worker);
  lease.onmessage = event => batches.push(event.data.batch);
  lease.postMessage({entry: f.map, currentVersion: f.map.version, replay});
  return {pool, worker, replay, lease, posted, batches, nativePauses, runtime,
    get nativeJob() { return nativeJob; },
    async advance() { nativePauses.shift()?.(); await flush(); }};
}

function numeric(track) {
  return Object.fromEntries([...TRACK_ARRAYS, 'dt', 'count', 'start', 'startTick', 'finish', 'splits', 'time'].map(key => [key, track[key]]));
}

describe('retained cinematic worker consumers', () => {
  test('releasing a shared recording keeps its active subscribers completing with exact positions', async () => {
    const f = physics(), b = bridge(f, 12);
    await flush();
    const camera = b.pool.camera({map: f.map});
    const first = camera.record({replay: b.replay}), second = camera.record({replay: b.replay});
    await flush();
    camera.release(b.lease.id);
    await flush();
    for (let i = 0; i < b.replay.commands.length + 1; i++) await b.advance();
    const result = await Promise.race([Promise.all([first, second]), turn().then(() => null)]);
    camera.release(); b.lease.terminate();
    expect(result).not.toBeNull();
    expect(result.map(track => trackPointForLast(track))).toEqual([120, 120]);
    function trackPointForLast(track) { return track.position[(track.count - 1) * 3]; }
  });
  test('failed worker acquisition records the exact native trajectory through the fallback', async () => {
    const f = physics(), replay = f.replay(4);
    replay.commands[1].x = 75;
    const track = await recordTrack({adapter: {...f, cinema: {worker() { throw new Error('Worker blocked'); }}},
      session: {map: f.map}, replay, yieldTask: async () => null});
    expect([...track.position].filter((_, index) => index % 3 === 0)).toEqual([0, 10, 75, 85, 95]);
    expect(track.dt).toBe(replay.config.dt);
  });
  test('late-window keyframe resume precedes discarded-prefix reconstruction and includes the tick before the playhead', async () => {
    const f = physics(), replay = f.replay(12000), session = f.createSession(f.map, replay), posts = [];
    let record, firstRegionCount, stepsAtWindow;
    const runtime = createCinemaWorkerRuntime({post: (message, options) => {
      if (message.type === 'record-window') { firstRegionCount = record.capture.count; stepsAtWindow = f.counts().steps; }
      posts.push(structuredClone(message, {transfer: options?.transfer ?? []}));
    }, createSession: f.createSession});
    record = runtime.attach(session, replay, 1);
    const frames = [{index: 0, session: session.capturePractice()}];
    for (let index = 1; index <= replay.commands.length; index++) {
      session.step(replay.commands[index - 1]);
      if (index % 128 === 0) frames.push({index, session: session.capturePractice()});
    }
    await runtime.batch(1, replay.commands.length, {keyframes: frames, markers: [], finish: null});
    runtime.detach(1);
    expect(record.capture).toBeNull();
    const before = f.counts().steps;
    runtime.receive(protocol({type: 'record', request: 9, id: 1, tick: 9000}));
    while (!posts.some(message => message.type === 'record-window')) await turn();
    const window = posts.find(message => message.type === 'record-window');
    expect(window.from).toBe(8400);
    expect(window.end).toBe(9601);
    expect(firstRegionCount).toBeLessThan(9000);
    expect(window.arrays.position[(8999 - window.from) * 3]).toBe(89990);
    expect(stepsAtWindow - before).toBeLessThan(4000);
    runtime.receive(protocol({type: 'camera-plan', request: 10, world: 1,
      options: {a: {handle: {id: 1, from: window.from}, count: window.end - window.from}, style: 'steady', nearby: true}}));
    while (!posts.some(message => message.request === 10)) await turn();
    expect(posts.find(message => message.request === 10).plan.eye.length).toBeGreaterThan(0);
    while (!posts.some(message => message.type === 'record-chunk' && message.done)) await turn();
    const fallback = await recordTrack({adapter: f, session: {map: f.map}, replay, yieldTask: async () => null});
    expect(numeric(record.capture.track)).toEqual(numeric(fallback));
    expect(window.arrays.position.buffer.byteLength).toBe((window.end - window.from) * 3 * 4);
  });

  test('a pre-final-departure keyframe preserves the original absolute clock and later checkpoint metadata', async () => {
    const f = physics(), replay = f.replay(2000), session = f.createSession(f.map, replay), posts = [];
    replay.commands[19].timer = {phase: 'running', startTick: 119.75, elapsed: 0.0025, splits: []};
    replay.commands[159].timer = {phase: 'ready', elapsed: 0, splits: []};
    replay.commands[230].timer = {phase: 'running', startTick: 330.75, elapsed: 0.0025, splits: []};
    replay.commands[399].timer = {phase: 'running', startTick: 330.75, elapsed: 1.6925, splits: [1.6925]};
    replay.commands[1800].timer = {phase: 'finished', startTick: 330.75, elapsed: 15.7, splits: [1.6925, 15.7]};
    replay.commands[199] = {grounded: false, ramp: true};
    const runtime = createCinemaWorkerRuntime({post: (message, options) => posts.push(structuredClone(message, {transfer: options?.transfer ?? []})),
      createSession: f.createSession});
    runtime.attach(session, replay, 1);
    session.step(replay.commands[0]);
    for (let index = 2; index <= 128; index++) session.step(replay.commands[index - 1]);
    const keyframe = {index: 128, session: session.capturePractice()};
    await runtime.batch(1, 128, {keyframes: [keyframe], markers: [], finish: null});
    runtime.receive(protocol({type: 'record', request: 9, id: 1, tick: 800}));
    while (!posts.some(message => message.type === 'record-window')) await turn();
    const window = posts.find(message => message.type === 'record-window');
    expect(window.startTick).toBe(230.75);
    expect(window.start).toBe(231);
    expect(window.splits).toEqual([400]);
    expect(window.finish).toBe(2000);
    expect(window.time).toBeNull();
    await runtime.before(1);
    for (let index = 129; index <= 2000; index++) session.step(replay.commands[index - 1]);
    await runtime.batch(1, 2000, {keyframes: [], markers: [{kind: 'checkpoint', index: 400}], finish: 1801});
    runtime.detach(1);
    while (!posts.some(message => message.type === 'record-chunk' && message.done)) await turn();
    const expected = await recordTrack({adapter: f, session: {map: f.map}, replay, yieldTask: async () => null});
    expect(expected.startTick).toBe(window.startTick);
    for (const key of TRACK_ARRAYS) {
      const size = key === 'position' || key === 'normal' ? 3 : 1;
      expect(window.arrays[key]).toEqual(expected[key].slice(window.from * size, window.end * size));
    }
  });

  test('a replacement seek to the start cancels an obsolete late-region job without cancelling canonical recording', async () => {
    const f = physics(), replay = f.replay(2000), session = f.createSession(f.map, replay), posts = [];
    const runtime = createCinemaWorkerRuntime({post: (message, options) => posts.push(structuredClone(message, {transfer: options?.transfer ?? []})),
      createSession: f.createSession});
    const record = runtime.attach(session, replay, 1), keyframes = [];
    for (let index = 1; index <= 2000; index++) {
      session.step(replay.commands[index - 1]);
      if (index % 128 === 0) keyframes.push({index, session: session.capturePractice()});
    }
    await runtime.batch(1, 2000, {keyframes, markers: [], finish: null});
    runtime.detach(1);
    runtime.receive(protocol({type: 'record', request: 9, id: 1, tick: 1200}));
    runtime.receive(protocol({type: 'record-priority', id: 1, tick: 0}));
    while (!posts.some(message => message.type === 'record-chunk' && message.done)) await turn();
    expect(posts.some(message => message.type === 'record-window')).toBe(false);
    expect(record.done).toBe(true);
    expect(record.capture.track.position).toEqual((await recordTrack({adapter: f, session: {map: f.map}, replay, yieldTask: async () => null})).position);
  });

  test('POV indexing does not allocate cinematic tracks or install slide observers', async () => {
    const f = physics(), replay = f.replay(3), session = f.createSession(f.map, replay);
    const step = session.step, slide = session.movement.slide, posts = [];
    const runtime = createCinemaWorkerRuntime({post: message => posts.push(message), createSession: f.createSession});
    const record = runtime.attach(session, replay, 1);
    for (let at = 0; at < replay.commands.length; at++) {
      session.step(replay.commands[at]);
      await runtime.batch(1, at + 1);
    }
    runtime.detach(1);
    expect(record.capture).toBeNull();
    expect(session.step).toBe(step);
    expect(session.movement.slide).toBe(slide);
    expect(posts).toEqual([]);
    expect(f.counts()).toEqual({constructions: 1, steps: 3});
  });

  test('controller activates a worker-planned current window before the full native index or recording', async () => {
    const keys = ['addEventListener', 'removeEventListener', 'document', 'innerWidth', 'innerHeight', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    let cinema;
    const f = physics(), b = bridge(f, 1800, 64);
    try {
      globalThis.addEventListener = globalThis.removeEventListener = () => {};
      globalThis.document = {querySelector: () => ({})};
      globalThis.innerWidth = 1280; globalThis.innerHeight = 720;
      globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
      await flush();
      const renderer = {qolScene: {}, qolCamera: {position: {set() {}}}, render(view) { return view; }};
      const session = {map: f.map}, playback = {replay: b.replay, index: 0};
      const adapter = {...f, getSession: () => session, replay: {playback: () => playback},
        cinema: {renderer: () => renderer, worker: (session, replay) => b.pool.camera(session, replay)}};
      cinema = createCinema({getAdapter: () => adapter, loadIdle() { throw new Error('Supported recording/planning must stay in worker'); },
        createScene: () => ({show() {}, update() {}, dispose() {}, labels: () => []})});
      const enabling = cinema.setView('cinematic');
      await flush();
      for (let i = 0; i < 9; i++) await b.advance();
      expect(await enabling).toBe(true);
      expect(cinema.camera).toBe(true);
      expect(b.batches.at(-1).done).toBe(false);
      expect(cinema.tracks[0].count).toBeLessThan(1801);
      expect(b.posted.some(message => message.type === 'camera-plan')).toBe(true);
      expect(b.posted.find(message => message.type === 'camera-plan').options.a.position).toBeUndefined();
    } finally {
      cinema?.close(); b.lease.terminate(); await b.advance();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });
  for (const watchedFormat of [6, 8]) test(`cached CPU cinema plans in the watched format ${watchedFormat} world after adding a different format`, async () => {
    const keys = ['addEventListener', 'removeEventListener', 'document', 'innerWidth', 'innerHeight', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const f = physics(), watched = f.replay(64), added = f.replay(64), traces = [], posted = [], workers = [];
    watched.format = watchedFormat;
    added.format = watchedFormat === 6 ? 8 : 6;
    watched.commands.forEach(command => { command.dy = 5; });
    added.commands.forEach(command => { command.dy = 5; });
    f.map.bspCornerFix = f.map.vphysicsFeatureFix = true;

    // Native swept-box clipping: the newer corner fix rejects near misses
    // whose epsilon-expanded entry and exit overlap only outside the box.
    function sweep(from, to, hull, box, corner) {
      let enter = -1, leave = 1, exactEnter = -Infinity, exactLeave = Infinity;
      let startsOutside = false, endsOutside = false;
      for (const axis of ['x', 'y', 'z']) for (const sign of [1, -1]) {
        const plane = sign > 0 ? box.max[axis] : -box.min[axis];
        const support = sign * (sign < 0 ? hull.max[axis] : hull.min[axis]);
        const a = sign * from[axis] - (plane - support), b = sign * to[axis] - (plane - support);
        if (corner && a > b) exactEnter = Math.max(exactEnter, a / (a - b));
        else if (corner && a < b) exactLeave = Math.min(exactLeave, a / (a - b));
        startsOutside ||= a > 0;
        endsOutside ||= b > 0;
        if (a > 0 && b > 0) return {fraction: 1, startSolid: false, allSolid: false};
        if (a <= 0 && b <= 0) continue;
        if (a > b) enter = Math.max(enter, Math.max(0, (a - 0.03125) / (a - b)));
        else leave = Math.min(leave, (a + 0.03125) / (a - b));
      }
      if (corner && exactLeave < 1 && exactEnter > exactLeave) return {fraction: 1, startSolid: false, allSolid: false};
      if (!startsOutside) return {fraction: endsOutside ? 1 : 0, startSolid: true, allSolid: !endsOutside};
      return {fraction: enter < leave && enter > -1 ? Math.min(1, enter) : 1, startSolid: false, allSolid: false};
    }
    class World {
      constructor(brushes, triangles = [], feature = false, corner = false) {
        Object.assign(this, {brushes, triangles, vphysicsFeatureFix: feature, bspCornerFix: corner});
      }
      trace(from, to, hull) {
        const hit = sweep(from, to, hull, this.brushes[0], this.bspCornerFix);
        const other = sweep(from, to, hull, this.brushes[0], !this.bspCornerFix);
        traces.push({corner: this.bspCornerFix, fraction: hit.fraction, other: other.fraction});
        return hit;
      }
    }
    class Session extends f.Session {
      constructor(map, config, format) {
        super(map, config);
        this.movement.world = new World(map.brushes, map.displacementTriangles,
          format >= 7 && map.vphysicsFeatureFix, format >= 7 && map.bspCornerFix);
      }
      step(command) {
        const events = super.step(command);
        this.state.position.y += command.dy;
        return events;
      }
    }
    const createSession = (map, replay) => {
      const session = new Session(map, replay.config, replay.format);
      session.loadReplay(replay);
      return session;
    };
    const session = createSession(f.map, watched);
    const adapter = {...f, Session, getSession: () => session, replay: {playback: () => ({replay: watched, index: 0})}};
    const cpuTrack = replay => recordTrack({adapter, session, replay, worker: null, yieldTask: async () => null});
    const a = await cpuTrack(watched), b = await cpuTrack(added);
    let sample;
    await planCamera({a, others: [{track: b, map: alignByTime(a, b)}], style: 'steady',
      trace(from, to) { sample ??= {from: {...from}, to: {...to}}; return 1; }});
    const dx = sample.to.x - sample.from.x, dy = sample.to.y - sample.from.y;
    expect(Math.abs(dx)).toBeGreaterThan(1);
    expect(Math.abs(dy)).toBeGreaterThan(1);
    const enterAxis = Math.abs(dx) < Math.abs(dy) ? 'x' : 'y', exitAxis = enterAxis === 'x' ? 'y' : 'x';
    const delta = {x: dx, y: dy};
    const gap = 0.002 * (1 / Math.abs(delta[enterAxis]) - 1 / Math.abs(delta[exitAxis]));
    expect(gap).toBeGreaterThan(0);
    const span = 1000 + 4 * Math.max(Math.abs(dx), Math.abs(dy));
    const box = {min: {z: Math.min(sample.from.z, sample.to.z) - span},
      max: {z: Math.max(sample.from.z, sample.to.z) + span}};
    for (const axis of ['x', 'y']) {
      const entering = axis === enterAxis, boundary = sample.from[axis] + delta[axis] * (0.5 + (entering ? gap : -gap));
      const lowSide = entering === (delta[axis] > 0);
      box.min[axis] = lowSide ? boundary + 6 : boundary - 6 - span;
      box.max[axis] = lowSide ? boundary + 6 + span : boundary - 6;
    }
    expect(sweep(sample.from, sample.to, PROBE, box, false).fraction).toBeLessThan(1);
    expect(sweep(sample.from, sample.to, PROBE, box, true).fraction).toBe(1);
    f.map.brushes = [box];
    session.movement.world = new World(f.map.brushes, f.map.displacementTriangles, watchedFormat >= 7, watchedFormat >= 7);

    let cinema, available = false, attempts = 0, time = 0;
    const jobs = createReplayIndexJobs(async () => null, () => {
      let receive;
      const worker = {
        terminated: false,
        postMessage(message) {
          const data = structuredClone(message);
          posted.push(data);
          queueMicrotask(() => { if (!this.terminated) receive(data); });
        },
        terminate() { this.terminated = true; },
      };
      const post = (message, options) => {
        const data = structuredClone(message, {transfer: options?.transfer ?? []});
        queueMicrotask(() => { if (!worker.terminated) worker.onmessage?.({data}); });
      };
      const runtime = createCinemaWorkerRuntime({post, createSession});
      receive = createReplayIndexWorker(post, async (message, job) => {
        runtime.attach(createSession(f.map, message.replay), message.replay, message.job, false);
        job.world(f.map);
      }, undefined, runtime);
      workers.push(worker);
      return worker;
    });
    const scope = {dispose() {}};
    jobs.ownRenderer(scope);
    try {
      globalThis.addEventListener = globalThis.removeEventListener = () => {};
      globalThis.document = {querySelector: () => ({})};
      globalThis.innerWidth = 1280; globalThis.innerHeight = 720;
      globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
      const renderer = {qolScene: {}, qolCamera: {position: {set() {}}}, render(view) { this.drawn = view; }};
      adapter.cinema = {renderer: () => renderer, worker: (session, replay) => {
        attempts++;
        return available ? jobs.camera(session, replay) : null;
      }};
      cinema = createCinema({getAdapter: () => adapter, loadIdle: async () => null, now: () => time,
        createScene: () => ({show() {}, update() {}, dispose() {}, labels: () => []})});
      expect(await cinema.setView('steady')).toBe(true);
      const cached = cinema.tracks[0];
      expect(cached.count).toBe(65);
      expect(cached._cinemaWorker).toBeUndefined();
      cinema.close();
      available = true;
      expect(await cinema.setView('steady')).toBe(true);
      expect(cinema.tracks[0]).toBe(cached);
      expect(attempts).toBe(1);
      expect(workers).toHaveLength(0);
      traces.length = 0;
      expect(await cinema.add({id: 'other', label: 'other', load: async () => added})).toBe(true);
      const differing = traces.filter(event => event.fraction !== event.other);
      expect(differing.length).toBeGreaterThan(0);
      expect(differing.every(event => event.corner === (watchedFormat >= 7))).toBe(true);
      const startup = posted.find(message => message.type === 'run');
      const recording = posted.find(message => message.type === 'record');
      const planning = posted.filter(message => message.type === 'camera-plan');
      expect(startup.replay).toEqual(watched);
      expect(recording.replay).toEqual(added);
      expect(planning.length).toBeGreaterThan(0);
      expect(planning.every(message => message.world === startup.job)).toBe(true);
      expect(planning[0].options.a.position).toBeInstanceOf(Float32Array);
      const frame = {state: {tick: 130}, eyePosition: {x: 300, y: 150, z: 114}, yaw: 0, pitch: 0, fov: 90};
      renderer.render(frame); time = 2000; renderer.render(frame);
      expect(cinema.camera).toBe(true);
      expect(renderer.drawn).not.toBe(frame);
      expect(Number.isFinite(renderer.drawn.eyePosition.x)).toBe(true);
      const before = traces.length;
      await cinema.remove('other');
      expect(posted.some(message => message.type === 'camera-release' && message.ids.includes(recording.id))).toBe(true);
      expect(traces.length).toBeGreaterThan(before);
      expect(traces.slice(before).some(event => event.fraction !== event.other)).toBe(true);
      expect(traces.slice(before).every(event => event.corner === (watchedFormat >= 7))).toBe(true);
      expect(posted.filter(message => message.type === 'camera-plan').at(-1).world).toBe(startup.job);
    } finally {
      cinema?.close();
      scope.dispose();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
      }
    }
  });
  test('time-group current window joins before either canonical recording and retimes a final fractional start departure', async () => {
    const keys = ['addEventListener', 'removeEventListener', 'document', 'innerWidth', 'innerHeight', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const f = physics(), b = bridge(f, 1800, 64);
    let cinema, releaseAdded;
    const held = new Promise(resolve => { releaseAdded = resolve; });
    try {
      globalThis.addEventListener = globalThis.removeEventListener = () => {};
      globalThis.document = {querySelector: () => ({})};
      globalThis.innerWidth = 1280; globalThis.innerHeight = 720;
      globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
      await flush();
      const renderer = {qolScene: {}, qolCamera: {position: {set() {}}}, render(view) { return view; }};
      const session = {map: f.map}, playback = {replay: b.replay, index: 0};
      const adapter = {...f, getSession: () => session, replay: {playback: () => playback},
        cinema: {renderer: () => renderer, worker: session => b.pool.camera(session)}};
      cinema = createCinema({getAdapter: () => adapter, loadIdle: async () => null,
        record: async options => {
          const track = await recordTrack(options);
          if (options.replay !== b.replay) await held;
          return track;
        }, createScene: () => ({show() {}, update() {}, dispose() {}, labels: () => []})});
      const enabling = cinema.setView('cinematic');
      await flush();
      for (let i = 0; i < 9; i++) await b.advance();
      await enabling;
      const other = f.replay(1800);
      other.commands[0] = {timer: {phase: 'running', startTick: 100.25, elapsed: 0.0075, splits: []}};
      other.commands[1] = {timer: {phase: 'ready', elapsed: 0, splits: []}};
      other.commands[2] = {x: 35, timer: {phase: 'running', startTick: 102.75, elapsed: 0.0025, splits: []}};
      expect(await cinema.add({id: 'other', label: 'other', load: async () => other})).toBe(true);
      expect(cinema.tracks).toHaveLength(2);
      expect(cinema.tracks[1].startTick).toBe(2.75);
      expect(cinema.status().runs[0].gap).toBeNull();
      expect(b.batches.at(-1).done).toBe(false);
      expect(b.posted.some(message => message.type === 'camera-align')).toBe(false);
      expect(b.posted.filter(message => message.type === 'camera-plan').at(-1).options.others[0].track.position).toBeUndefined();
    } finally {
      cinema?.close(); releaseAdded(); b.lease.terminate(); await b.advance();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
      }
    }
  });


  test('positions and nearby plans arrive before indexing completes; only discarded prefix steps are repeated', async () => {
    const f = physics(), b = bridge(f);
    await flush();
    const api = b.pool.camera({map: f.map}), prefixes = [];
    let finished = false;
    const recorded = api.record({replay: b.replay, onProgress: (track, count) => prefixes.push({track, count})}).then(track => { finished = true; return track; });
    await flush();
    expect(prefixes.at(-1).count).toBe(2);
    expect(finished).toBe(false);
    expect(b.batches.at(-1).done).toBe(false);
    const first = prefixes[0].track;
    const window = {...trackSlice(first, 0, 2), _cinemaHandle: {id: b.lease.id, from: 0}};
    const plan = await api.plan({a: window, style: 'steady', nearby: true});
    expect(plan.eye.length).toBeGreaterThan(0);
    expect([...plan.eye].every(Number.isFinite)).toBe(true);
    expect(finished).toBe(false);
    expect(f.counts()).toEqual({constructions: 2, steps: 2});
    const planMessage = b.posted.find(message => message.type === 'camera-plan');
    expect(planMessage.options.a).toEqual({handle: {id: b.lease.id, from: 0}, count: 2});
    expect(planMessage.__surfdQolCollision).toBeUndefined();
    for (let i = 1; i < b.replay.commands.length; i++) await b.advance();
    const track = await recorded;
    expect(f.counts()).toEqual({constructions: 2, steps: b.replay.commands.length + 1});
    expect(track.position.at(-3)).toBe(120);
    expect(track.position.buffer.byteLength).toBeGreaterThan(0);
    expect(api.lastPlanDuration).toBeGreaterThanOrEqual(0);
    api.release();
    b.lease.terminate();
  });

  test('camera cancellation never cancels native indexing; native cancellation never kills subscribed recording', async () => {
    const f = physics(), b = bridge(f);
    await flush();
    const api = b.pool.camera({map: f.map}), abort = new AbortController();
    const cancelled = api.record({replay: b.replay, signal: abort.signal});
    await flush();
    abort.abort();
    expect(await cancelled).toBeNull();
    expect(b.posted.filter(message => message.type === 'cancel')).toHaveLength(0);
    await b.advance();
    expect(b.nativeJob.job.current()).toBe(true);
    const recording = api.record({replay: b.replay});
    await flush();
    b.lease.terminate();
    await b.advance();
    const track = await recording;
    expect(track.count).toBe(b.replay.commands.length + 1);
    expect(f.counts()).toEqual({constructions: 3, steps: b.replay.commands.length + 3});
    expect(b.batches.at(-1).done).toBe(false);
    api.release();
  });

  test('finish-shortened native indexing resumes the same simulation to retain the post-finish tail', async () => {
    const f = physics(), posts = [];
    const replay = f.replay(6), session = f.createSession(f.map, replay);
    const runtime = createCinemaWorkerRuntime({post: message => posts.push(message), createSession: f.createSession});
    runtime.attach(session, replay, 1);
    runtime.receive(protocol({type: 'record', id: 1, request: 10}));
    session.step(replay.commands[0]);
    await runtime.batch(1, 1);
    runtime.detach(1);
    while (!posts.some(message => message.type === 'record-chunk' && message.done)) await turn();
    expect(f.counts()).toEqual({constructions: 1, steps: 6});
    expect(posts.at(-1).end).toBe(7);
    expect(posts.at(-1).arrays.position.at(-3)).toBe(60);
  });

  test('added runs simulate once in the retained worker; numeric recording semantics match native capture and fallback', async () => {
    const f = physics(), b = bridge(f);
    await flush();
    const added = f.replay(6);
    added.initialState.grounded = false;
    added.commands = [
      {x: 3, z: 30}, {x: 8, z: 0, grounded: true},
      {grounded: false, ramp: true, timer: {phase: 'running', startTick: 102.25, elapsed: 0.0075, splits: []}},
      {timer: {phase: 'ready', elapsed: 0, splits: []}},
      {x: 900, yaw: 350, ducked: true, events: ['teleport'], timer: {phase: 'running', startTick: 104.75, elapsed: 0.0025, splits: []}},
      {timer: {phase: 'finished', startTick: 104.75, elapsed: 0.0125, splits: [0.0125]}},
    ];
    const api = b.pool.camera({map: f.map}), before = f.counts();
    const track = await api.record({replay: added});
    expect(f.counts()).toEqual({constructions: before.constructions + 1, steps: before.steps + 6});
    const fallback = await recordTrack({adapter: f, session: {map: f.map}, replay: added, yieldTask: async () => null});
    expect(numeric(track)).toEqual(numeric(fallback));
    expect([...track.position.slice(0, 9)]).toEqual([8, 0, 0, 8, 0, 0, 8, 0, 0]);
    expect(track.startTick).toBe(4.75);
    expect(track.start).toBe(5);
    expect(track.finish).toBe(6);
    expect(track.splits).toEqual([]);
    expect(track.cut[5]).toBe(1);
    expect([...track.normal.slice(9, 12)]).toEqual([0, Math.fround(-0.8), Math.fround(0.6)]);
    const plan = await api.plan({a: track, style: 'steady'});
    const expected = await planCamera({a: fallback, style: 'steady'});
    expect(plan).toEqual(expected);
    api.release(); b.lease.terminate(); await b.advance();
  });

  test('newest camera plan drains its predecessor and focus resampling remains worker-side', async () => {
    const f = physics(), b = bridge(f);
    await flush();
    const api = b.pool.camera({map: f.map});
    const a = await api.record({replay: f.replay(10)});
    const otherReplay = f.replay(10);
    otherReplay.commands.forEach((command, index) => { command.x = index * 25; });
    const other = await api.record({replay: otherReplay});
    const mapping = Float32Array.from({length: a.count}, (_, index) => index);
    const first = api.plan({a, style: 'steady'});
    const second = api.plan({a, others: [{track: other, map: mapping}], focusIndex: 0, group: false, style: 'cinematic'});
    expect(await first).toBeNull();
    const result = await second;
    const expected = await planCamera({a: onClock(other, mapping, a), others: [{track: a, map: mapping}], group: false, style: 'cinematic'});
    expect(result).toEqual(expected);
    expect(b.posted.filter(message => message.type === 'camera-plan').at(-1).options.a.position).toBeUndefined();
    api.release(); b.lease.terminate(); await b.advance();
  });

  test('reopening a main-cached recording after handle eviction uploads positions once without replaying or resending geometry', async () => {
    const f = physics(), b = bridge(f);
    await flush();
    const api = b.pool.camera({map: f.map}), cached = await api.record({replay: f.replay(10)});
    for (let i = 0; i < 8; i++) await api.record({replay: f.replay(10)});
    api.release(); await flush();
    const before = f.counts(), original = cached.position.slice();
    api.retain(cached._cinemaHandle.id, cached); await flush();
    const first = await api.plan({a: cached, style: 'steady'});
    const second = await api.plan({a: cached, style: 'cinematic'});
    expect(first).toEqual(await planCamera({a: cached, style: 'steady'}));
    expect(second).toEqual(await planCamera({a: cached, style: 'cinematic'}));
    expect(cached.position).toEqual(original);
    expect(f.counts()).toEqual(before);
    expect(b.posted.filter(message => message.type === 'camera-store')).toHaveLength(1);
    for (const message of b.posted.filter(message => message.type === 'camera-plan')) expect(message.options.a.position).toBeUndefined();
    api.release(); b.lease.terminate(); await b.advance();
  });

  test('worker crashes drain concurrent promises and renderer disposal evicts all camera ownership', async () => {
    const f = physics(), b = bridge(f);
    await flush();
    const api = b.pool.camera({map: f.map});
    const one = api.record({replay: b.replay}).then(() => false, () => true);
    const two = api.record({replay: b.replay}).then(() => false, () => true);
    await flush();
    b.worker.onerror({preventDefault() {}});
    expect(await one).toBe(true);
    expect(await two).toBe(true);
    expect(api.live).toBe(false);
    expect(b.worker.terminated).toBe(true);
    await b.advance();
  });

  test('recordTrack delegates supported recording before constructing any main-thread shadow Session', async () => {
    const f = physics(), b = bridge(f);
    await flush();
    const pending = recordTrack({adapter: {...f, cinema: {worker: session => b.pool.camera(session)}}, session: {map: f.map}, replay: b.replay, yieldTask() { throw new Error('Main recording must not run'); }});
    await flush();
    for (let i = 1; i < b.replay.commands.length; i++) await b.advance();
    const track = await pending;
    expect(track._cinemaWorker).toBe(b.pool.camera({map: f.map}));
    expect(f.counts()).toEqual({constructions: 2, steps: b.replay.commands.length + 1});
    track._cinemaWorker.release(); b.lease.terminate();
  });
});


  test('a fresh view-only worker records once without a separate native indexing pass', async () => {
    const f = physics(), replay = f.replay(4), session = f.createSession(f.map, replay), posts = [];
    const runtime = createCinemaWorkerRuntime({post: message => posts.push(message), createSession: f.createSession});
    const record = runtime.attach(session, replay, 1, false);
    expect(record.capture).toBeNull();
    expect(f.counts()).toEqual({constructions: 1, steps: 0});
    runtime.receive(protocol({type: 'camera-retain', id: 1}));
    runtime.receive(protocol({type: 'record', id: 1, request: 2, replay}));
    while (!posts.some(message => message.type === 'record-chunk' && message.done)) await turn();
    expect(f.counts()).toEqual({constructions: 1, steps: 4});
    expect(record.capture.track.position.at(-3)).toBe(40);
    runtime.receive(protocol({type: 'camera-plan', request: 3, world: 1,
      options: {a: {handle: {id: 1, from: 0}, count: 5}, style: 'steady'}}));
    while (!posts.some(message => message.request === 3)) await turn();
    expect(posts.find(message => message.request === 3).plan.count).toBeGreaterThan(0);
    runtime.receive(protocol({type: 'camera-release', ids: [1]}));
    expect(record.capture.track.count).toBe(5);
    expect(posts.some(message => message.type === 'camera-forget')).toBe(false);
  });
  test('releasing an uploaded track preserves the independently owned primary world', async () => {
    const f = physics(), replay = f.replay(4), session = f.createSession(f.map, replay), posts = [];
    const runtime = createCinemaWorkerRuntime({post: message => posts.push(message), createSession: f.createSession});
    const record = runtime.attach(session, replay, 1);
    runtime.receive(protocol({type: 'record', id: 1, request: 2}));
    for (let index = 0; index < replay.commands.length; index++) session.step(replay.commands[index]);
    await runtime.batch(1, replay.commands.length);
    runtime.detach(1);
    const track = structuredClone(record.capture.track);
    runtime.receive(protocol({type: 'camera-store', id: 3, track}));
    runtime.receive(protocol({type: 'camera-release', ids: [3]}));
    runtime.receive(protocol({type: 'camera-store', id: 4, track}));
    expect(posts.some(message => message.type === 'camera-forget' && message.id === 4)).toBe(false);
    runtime.receive(protocol({type: 'camera-plan', request: 5, world: 1,
      options: {a: {handle: {id: 4, from: 0}, count: track.count}, style: 'steady'}}));
    while (!posts.some(message => message.request === 5)) await turn();
    expect(posts.find(message => message.request === 5).plan.count).toBeGreaterThan(0);
    runtime.receive(protocol({type: 'camera-release', ids: [1, 4]}));
  });
