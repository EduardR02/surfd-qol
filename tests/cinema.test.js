import {afterEach, describe, expect, test} from 'bun:test';
import {createTrack, recordTrack, trackPoint, trackYaw} from '../src/cinema-track.js';
import {alignByPlace, alignByTime, gapAt} from '../src/cinema-sync.js';
import {adjust, blur, planCamera, shotAt, STEP, viewAngles} from '../src/cinema-camera.js';
import {createCinema} from '../src/cinema.js';
import {gapText, createCinemaUi} from '../src/cinema-ui.js';
import {boardSource, ghostSources} from '../src/ghost-sources.js';

// A run along +x at `speed` units per tick, starting after `lead` ticks in the start zone.
function straight({count = 400, speed = 20, lead = 20, dt = 0.015, y = 0, normal = null} = {}) {
  const track = createTrack(count, dt);
  for (let i = 0; i < count; i++) {
    const x = Math.max(0, i - lead) * speed;
    track.position.set([x, y, 0], i * 3);
    track.yaw[i] = 0;
    track.elapsed[i] = Math.max(0, i - lead) * dt;
    if (normal) track.normal.set(normal, i * 3);
  }
  track.start = lead;
  track.finish = count - 1;
  track.time = (count - 1 - lead) * dt;
  return track;
}

describe('tracks', () => {
  test('interpolate between ticks but never across a teleport', () => {
    const track = straight({count: 10, lead: 0});
    expect(trackPoint(track, 2.5).x).toBeCloseTo(50);
    track.position.set([5000, 0, 0], 3 * 3);
    track.cut[3] = 1;
    expect(trackPoint(track, 2.5).x).toBeCloseTo(40);
  });
  test('turn the short way round', () => {
    const track = straight({count: 2, lead: 0});
    track.yaw[0] = 170; track.yaw[1] = -170;
    expect(trackYaw(track, 0.5)).toBeCloseTo(180);
  });
  test('record where the player was, the ramp they surfed, the start, checkpoints and finish', async () => {
    class Movement { slide(state, result) { if (state.ramp) result.contacts.push({normal: {x: 0, y: -0.8, z: 0.6}}); return result; } accelerate() {} }
    class Session {
      constructor(map, config) { this.map = map; this.config = config; this.movement = new Movement(); this.state = {position: {x: 0, y: 0, z: 0}, velocity: {x: 0, y: 0, z: 0}, yaw: 0, ducked: false}; this.timer = {state: {phase: 'ready', splits: [], elapsed: 0}}; this.tick = 0; }
      loadReplay() {}
      step(command) {
        this.tick++;
        this.state.position = {x: this.tick * 10, y: 0, z: 0};
        this.state.ramp = !!command.ramp;
        this.movement.slide(this.state, {contacts: []});
        if (this.tick === 2) this.timer.state.phase = 'running';
        if (this.tick === 4) this.timer.state.splits.push(0.03);
        if (this.tick === 6) { this.timer.state.phase = 'finished'; this.timer.state.elapsed = 0.06; this.timer.state.splits.push(0.06); }
        return [];
      }
      restart() {} restorePractice() {} visitStation() {}
    }
    const map = {id: 'm', version: 1};
    const replay = {mapId: 'm', mapVersion: 1, config: {dt: 0.01, groundNormal: 0.7}, format: 8,
      commands: [{}, {}, {ramp: true}, {}, {}, {}, {}]};
    const track = await recordTrack({adapter: {Session, Movement}, session: {map}, replay, yieldTask: async () => null});
    expect(track.count).toBe(8);
    expect(trackPoint(track, 3).x).toBe(30);
    expect([...track.normal.slice(9, 12)].map(value => Math.round(value * 10) / 10)).toEqual([0, -0.8, 0.6]);
    expect(track.normal[4 * 3 + 1]).toBe(0);
    expect(track.start).toBe(2);
    expect(track.splits).toEqual([4]);
    expect(track.finish).toBe(6);
    expect(track.time).toBe(0.06);
    expect(track.elapsed[6]).toBe(0.06);
  });
  test('a replay of another map is not read', async () => {
    const replay = {mapId: 'other', mapVersion: 1, commands: [{}]};
    expect(await recordTrack({adapter: {Session() {}, Movement() {}}, session: {map: {id: 'm', version: 1}}, replay})).toBeNull();
  });
});

describe('matching the runs', () => {
  test('side by side pairs the same place on the route, so the faster run waits', () => {
    const slow = straight({count: 401, speed: 10}), fast = straight({count: 221, speed: 20});
    const map = alignByPlace(slow, fast);
    for (const tick of [60, 120, 220, 300]) {
      const here = trackPoint(slow, tick).x, there = trackPoint(fast, map[tick]).x;
      expect(Math.abs(here - there)).toBeLessThan(25);
    }
    for (let i = 1; i < map.length; i++) expect(map[i]).toBeGreaterThanOrEqual(map[i - 1]);
  });
  test('real time pairs the same time since each start', () => {
    const a = straight({lead: 20}), b = straight({lead: 50});
    expect(alignByTime(a, b)[120]).toBe(150);
  });
  test('the gap is how much sooner the other run got here', () => {
    const slow = straight({count: 401, speed: 10}), fast = straight({count: 221, speed: 20});
    const gap = gapAt(slow, fast, alignByPlace(slow, fast), 220);
    // 200 ticks of the slow run cover what the fast one does in 100.
    expect(gap).toBeCloseTo(-100 * slow.dt, 1);
    // Shown from the watched run: it is 1.5 s behind here.
    expect(gapText(gap)).toMatchObject({value: `+${(-gap).toFixed(3)}`, tone: 'loss'});
    expect(gapText(-gap)).toMatchObject({value: `−${(-gap).toFixed(3)}`, tone: 'good'});
    expect(gapAt(slow, fast, alignByPlace(slow, fast), 5)).toBeNull();
  });
});

describe('the planned camera', () => {
  const plan = async (normal, trace = null) => {
    const a = straight({normal}), b = straight({normal, y: 40});
    return {a, plan: await planCamera({a, b, map: alignByPlace(a, b), trace})};
  };
  const at = (result, tick) => shotAt(result.plan, tick);
  test('sits behind and above the ghosts between ramps', async () => {
    const result = await plan(null);
    const {eye, target} = at(result, 200);
    expect(eye.x).toBeLessThan(target.x - 100);
    expect(Math.abs(eye.y - target.y)).toBeLessThan(30);
    expect(eye.z).toBeGreaterThan(target.z + 40);
  });
  test('swings to the open side of the ramp they surf, short of side-on', async () => {
    // Travelling +x, a face whose normal points -y faces the runners' right.
    const result = await plan([0, -0.8, 0.6]);
    const {eye, target} = at(result, 200);
    const angle = Math.atan2(target.y - eye.y, target.x - eye.x) * 180 / Math.PI;
    expect(eye.y).toBeLessThan(target.y - 60);
    expect(angle).toBeGreaterThan(25);
    expect(angle).toBeLessThan(65);
    const other = at(await plan([0, 0.8, 0.6]), 200);
    expect(other.eye.y).toBeGreaterThan(other.target.y + 60);
  });
  test('keeps out of walls: blocked spots turn or pull the camera in before it gets there', async () => {
    // Everything further than 90 units from the ghosts is solid.
    const trace = (from, to) => Math.min(1, 90 / Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z));
    const result = await plan(null, trace);
    const {eye, target} = at(result, 200);
    const focus = {x: target.x, y: target.y, z: target.z};
    expect(Math.hypot(eye.x - focus.x, eye.y - focus.y, eye.z - focus.z)).toBeLessThan(260);
  });
  test('with a wall between the two lines, the camera stays on the played run’s side', async () => {
    const a = straight(), b = straight({y: 600});
    // A solid slab from y 200 to 400; a trace that starts inside it is ignored, as the game's startSolid is.
    const trace = (from, to) => {
      if (from.y > 200 && from.y < 400) return 1;
      const crossing = [200, 400].map(y => (y - from.y) / (to.y - from.y)).filter(t => t > 0 && t < 1);
      return crossing.length ? Math.min(...crossing) : 1;
    };
    const planned = await planCamera({a, b, map: alignByPlace(a, b), trace});
    const {eye} = shotAt(planned, 200);
    expect(eye.y).toBeLessThan(200);
  });
  test('never blends across a teleport', () => {
    const values = Float32Array.from([0, 0, 0, 100, 100, 100]), segment = Uint32Array.from([0, 0, 0, 1, 1, 1]);
    expect([...blur(values, 2, segment)]).toEqual([0, 0, 0, 100, 100, 100]);
  });
  test('your own angle turns round the ghosts and zooms without moving them', () => {
    const shot = {eye: {x: -100, y: 0, z: 0}, target: {x: 0, y: 0, z: 0}};
    adjust(shot, {yaw: Math.PI / 2, zoom: 2});
    expect(shot.eye.x).toBeCloseTo(0);
    expect(shot.eye.y).toBeCloseTo(-200);
    expect(viewAngles(shot.eye, shot.target).yaw).toBeCloseTo(90);
  });
  test('frames several runs at once, each counting while it stays near', async () => {
    const a = straight(), near = straight({y: 120}), far = straight({y: 5000});
    const planned = await planCamera({a, others: [{track: near, map: alignByTime(a, near)}, {track: far, map: alignByTime(a, far)}]});
    const {target} = shotAt(planned, 200);
    expect(target.y).toBeGreaterThan(30);
    expect(target.y).toBeLessThan(90);
  });
  test('samples every STEP ticks', async () => {
    const {a, plan: planned} = await plan(null);
    expect(planned.count).toBe(Math.ceil(a.count / STEP) + 1);
  });
});

describe('picking runs', () => {
  const refs = {record: {runId: 'wr', username: 'fast', timeUs: 40e6}, loadReplay: async id => ({id}), loadRecordRoute: async () => ({ksf: true}),
    entries: [{rank: 1, runId: 'wr', username: 'fast', timeUs: 40e6}]};
  test('offers your PB, recent best and both records, saying why one is missing', () => {
    const list = ghostSources({best: null, recentBest: null, refs});
    expect(list.map(source => source.label)).toEqual(['PB', 'Site WR', 'KSF WR']);
    expect(list[0]).toMatchObject({load: null, reason: 'No finish on this map yet'});
    expect(ghostSources({best: {official: true, runId: 'mine', time: 42}, refs})[0]).toMatchObject({label: 'PB', time: 42});
  });
  test('the site WR and the leaderboard’s #1 are the same run', () => {
    expect(ghostSources({refs})[1].id).toBe(boardSource(refs.entries[0], refs).id);
  });
});

// Standing rule: until a run is added, ghosts cost nothing.
describe('ghosts are idle until a run is added', () => {
  const originals = {};
  const calls = [];
  const keep = (...names) => { for (const name of names) if (!(name in originals)) originals[name] = globalThis[name]; };
  const spy = name => { keep(name); const original = originals[name]; globalThis[name] = (...args) => { calls.push(name); return original?.(...args); }; };
  afterEach(() => {
    for (const [name, value] of Object.entries(originals)) globalThis[name] = value;
    for (const name of Object.keys(originals)) delete originals[name];
    calls.length = 0;
  });
  test('no timers, frames, listeners, observers or fetches without ghosts', () => {
    for (const name of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'fetch', 'addEventListener']) spy(name);
    keep('MutationObserver');
    const observed = [];
    globalThis.MutationObserver = class { constructor() { observed.push('MutationObserver'); } observe() {} disconnect() {} };
    const renderer = {qolScene: {}, render() {}}, native = renderer.render;
    const cinema = createCinema({getAdapter: () => ({cinema: {renderer: () => renderer}, getSession: () => ({map: {}}), replay: {playback: () => ({replay: null})}})});
    const node = () => ({hidden: true, classList: {add() {}, remove() {}, toggle() {}}, style: {}, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null,
      addEventListener: () => calls.push('ui listener')});
    const section = {...node(), querySelector: node, querySelectorAll: () => []};
    const ui = createCinemaUi({root: {getElementById: () => section}, cinema});
    calls.length = 0;
    for (let i = 0; i < 20; i++) { ui.render({visible: true, track: {left: 0, top: 0, bottom: 0}}); ui.render({visible: false}); cinema.status(); }
    expect(cinema.active).toBe(false);
    expect(cinema.status()).toBeNull();
    expect(renderer.render).toBe(native);
    cinema.close();
    expect(calls).toEqual([]);
    expect(observed).toEqual([]);
    expect(section.hidden).toBe(true);
  });

  function rig() {
    const tracks = [straight({count: 60, lead: 5}), straight({count: 60, lead: 5, y: 30}), straight({count: 60, lead: 5, y: -30})];
    const listeners = new Map();
    keep('addEventListener', 'removeEventListener', 'document', 'innerWidth', 'innerHeight', 'requestAnimationFrame', 'cancelAnimationFrame');
    globalThis.addEventListener = (type, listener) => listeners.set(type, listener);
    globalThis.removeEventListener = type => listeners.delete(type);
    globalThis.document = {querySelector: () => ({})};
    globalThis.innerWidth = 1280; globalThis.innerHeight = 720;
    globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
    const native = function (view) { this.drawn = view; };
    const renderer = {qolScene: {}, qolCamera: {position: {set() {}}}, render: native};
    const played = {mapId: 'm', mapVersion: 1, commands: new Array(59).fill({}), initialState: {tick: 0}};
    let disposed = 0, scenes = 0;
    const control = {playback: {replay: played}};
    const adapter = {cinema: {renderer: () => renderer}, getSession: () => ({map: {id: 'm', version: 1}}), replay: {playback: () => control.playback}};
    const cinema = createCinema({getAdapter: () => adapter, loadIdle: async () => null, record: async () => tracks.shift(),
      createScene: (_, runs) => { scenes = runs.length; return {update() {}, labels: () => [], dispose() { disposed++; }}; }});
    return {cinema, renderer, native, listeners, control, counts: () => ({disposed, scenes})};
  }
  const run = id => ({id, label: id, load: async () => ({commands: []})});
  test('adding a run wraps the renderer and listens on the canvas; removing the last undoes both', async () => {
    const {cinema, renderer, native, listeners, counts} = rig();
    expect(cinema.available()).toBe(true);
    expect(await cinema.add(run('wr'))).toBe(true);
    expect(cinema.active).toBe(true);
    expect(renderer.render).not.toBe(native);
    expect(listeners.has('pointerdown') && listeners.has('wheel')).toBe(true);
    renderer.render({state: {tick: 30}, qolAlpha: 0.5, eyePosition: {x: 0, y: 0, z: 0}, yaw: 0, pitch: 0, fov: 90, ghost: {}, remotePlayers: [{}]});
    expect(renderer.drawn).toMatchObject({ghost: null, remotePlayers: []});
    expect(cinema.status()).toMatchObject({active: true, sync: 'time', runs: [{id: 'wr', label: 'wr'}]});
    cinema.remove('wr');
    expect(renderer.render).toBe(native);
    expect(listeners.size).toBe(0);
    expect(counts().disposed).toBe(1);
    expect(cinema.status()).toBeNull();
  });
  test('more runs join the same replay; the same run twice is ignored', async () => {
    const {cinema, counts} = rig();
    await cinema.add(run('wr'));
    expect(await cinema.add(run('wr'))).toBe(false);
    expect(await cinema.add(run('pb'))).toBe(true);
    expect(cinema.status().runs.map(item => item.id)).toEqual(['wr', 'pb']);
    expect(counts().scenes).toBe(3);
    cinema.remove('wr');
    expect(cinema.status().runs.map(item => item.id)).toEqual(['pb']);
    expect(counts().scenes).toBe(2);
  });
  test('leaving the replay ends the ghosts on the next frame', async () => {
    const {cinema, renderer, native, control} = rig();
    await cinema.add(run('wr'));
    control.playback = {replay: null};
    renderer.render({state: {tick: 3}});
    await Promise.resolve();
    expect(renderer.render).toBe(native);
    expect(cinema.active).toBe(false);
  });
});
