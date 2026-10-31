import {afterEach, describe, expect, test} from 'bun:test';
import {createTrack, recordTrack, trackPoint, trackYaw} from '../src/cinema-track.js';
import {alignByPlace, alignByTime, gapAt} from '../src/cinema-sync.js';
import {adjust, blur, planCamera, shotAt, viewAngles} from '../src/cinema-camera.js';
import {createCinema} from '../src/cinema.js';
import {gapText} from '../src/cinema-ui.js';
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

// Script native post-step states so timer transitions stay independent of
// map geometry while recording still goes through the real observer path.
async function recorded(commands, {base = 100, dt = 0.01, initialTimer = {phase: 'ready', elapsed: 0, splits: [], startTick: null}} = {}) {
  class Movement { accelerate() {} slide() {} }
  class Session {
    constructor(map, config) { this.map = map; this.config = config; this.movement = new Movement(); this.timer = {state: structuredClone(initialTimer)}; }
    loadReplay(replay) { this.state = structuredClone(replay.initialState); }
    step(command) {
      this.state.tick++;
      this.state.position.x = command.x ?? this.state.position.x + 10;
      if (command.timer) this.timer.state = structuredClone(command.timer);
      return command.events ?? [];
    }
    restart() {} restorePractice() {} visitStation() {}
  }
  const map = {id: 'm', version: 1};
  const replay = {mapId: 'm', mapVersion: 1, config: {dt}, commands,
    initialState: {tick: base, position: {x: 5, y: 0, z: 0}, velocity: {x: 0, y: 0, z: 0}, yaw: 0}};
  return recordTrack({adapter: {Session, Movement}, session: {map}, replay, yieldTask: async () => null});
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
  test('uses the final fractional departure after popping out and returning to start', async () => {
    const timer = (phase, startTick, elapsed, splits = []) => ({phase, startTick, elapsed, splits});
    const track = await recorded([
      {timer: timer('running', 100.5, 0.005, [0.003]), events: ['start']},
      {timer: timer('ready', null, 0), events: ['start-return']},
      {timer: timer('running', 102.25, 0.0075), events: ['start']},
      {timer: timer('running', 102.25, 0.0175, [0.015])},
      {timer: timer('finished', 102.25, 0.025, [0.015, 0.025]), events: ['finish']},
    ]);
    expect(track.startTick).toBe(2.25);
    expect(track.start).toBe(3);
    expect(track.splits).toEqual([4]);
    expect(track.time).toBe(0.025);
    expect(track.elapsed[1]).toBe(0.005);
    expect(track.elapsed[2]).toBe(0);
    expect(track.cut[2]).toBe(0);
    expect(trackPoint(track, 1.5).x).toBe(20);
  });
  test('detects a return and second departure within the same physics command', async () => {
    const track = await recorded([
      {timer: {phase: 'running', startTick: 100.1, elapsed: 0.009, splits: [0.004]}, events: ['start']},
      {timer: {phase: 'running', startTick: 101.8, elapsed: 0.002, splits: []}, events: ['start-return', 'start']},
    ]);
    expect(track.startTick).toBeCloseTo(1.8);
    expect(track.splits).toEqual([]);
    expect(track.time).toBeNull();
    expect(track.cut[2]).toBe(0);
  });
  test('records the initial state and clock before any command, and keeps real teleports cut', async () => {
    const track = await recorded([{x: 1000, events: ['teleport']}], {
      initialTimer: {phase: 'running', startTick: 99.5, elapsed: 0.005, splits: []},
    });
    expect(trackPoint(track, 0).x).toBe(5);
    expect(track.elapsed[0]).toBe(0.005);
    expect(track.startTick).toBe(-0.5);
    expect(track.cut[1]).toBe(1);
    expect(trackPoint(track, 0.5).x).toBe(5);
  });
  test('an opening drop from the spawn onto the floor is held where they land', async () => {
    class Movement { accelerate() {} slide() {} }
    class Session {
      constructor(map, config) { this.map = map; this.config = config; this.movement = new Movement(); this.timer = {state: {phase: 'ready', splits: [], elapsed: 0}}; }
      loadReplay(replay) { this.state = structuredClone(replay.initialState); }
      step() {
        const p = this.state.position;
        this.state.tick++;
        if (p.z > 0) p.z = Math.max(0, p.z - 40); else p.x += 10;
        this.state.grounded = p.z === 0;
        return [];
      }
      restart() {} restorePractice() {} visitStation() {}
    }
    const replay = {mapId: 'm', mapVersion: 1, config: {dt: 0.01}, commands: new Array(8).fill({}),
      initialState: {tick: 0, position: {x: 0, y: 0, z: 134}, velocity: {x: 0, y: 0, z: 0}, yaw: 0, grounded: false}};
    const track = await recordTrack({adapter: {Session, Movement}, session: {map: {id: 'm', version: 1}}, replay, yieldTask: async () => null});
    // It falls for four ticks, then walks along x.
    expect([0, 1, 2, 3, 4].map(tick => trackPoint(track, tick).z)).toEqual([0, 0, 0, 0, 0]);
    expect(trackPoint(track, 6).x).toBe(20);
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
    // The faster added run's chip shows its lead over the watched run.
    expect(gapText(gap)).toMatchObject({value: `−${(-gap).toFixed(3)}`, tone: 'good'});
    expect(gapText(-gap)).toMatchObject({value: `+${(-gap).toFixed(3)}`, tone: 'loss'});
    expect(gapAt(slow, fast, alignByPlace(slow, fast), 5)).toBeNull();
  });
  test('close finish deltas retain the correct sign and colour through route smoothing', () => {
    const watched = straight({count: 1001, speed: 10});
    const slower = straight({count: 1007, speed: 9800 / 986});
    const map = alignByPlace(watched, slower);
    expect(map[watched.start]).toBe(slower.start);
    expect(map[watched.finish]).toBe(slower.finish);
    const gap = gapAt(watched, slower, map, watched.finish);
    expect(gap).toBeCloseTo(0.09, 6);
    expect(gapText(gap)).toMatchObject({value: '+0.090', tone: 'loss'});
    const reverse = gapAt(slower, watched, alignByPlace(slower, watched), slower.finish);
    expect(gapText(reverse)).toMatchObject({value: '−0.090', tone: 'good'});
  });

  test('route smoothing preserves checkpoints and stays monotonic between anchors', () => {
    const a = straight({count: 801}), b = straight({count: 901, speed: 17.5});
    a.splits = [200, 500]; b.splits = [240, 560];
    const map = alignByPlace(a, b);
    for (const [from, to] of [[a.start, b.start], [200, 240], [500, 560], [a.finish, b.finish]]) expect(map[from]).toBe(to);
    for (let tick = 1; tick < map.length; tick++) expect(map[tick]).toBeGreaterThanOrEqual(map[tick - 1]);
  });
  test('real time preserves fractional starts and different physics tick durations', () => {
    const a = straight({dt: 0.01}), b = straight({dt: 0.02});
    a.startTick = 19.2; b.startTick = 49.8;
    const map = alignByTime(a, b);
    expect(map[20]).toBeCloseTo(50.2);
    expect(map[100]).toBeCloseTo(90.2);
    expect((map[100] - b.startTick) * b.dt).toBeCloseTo((100 - a.startTick) * a.dt);
  });
  test('gaps use the true partial start tick and stop reporting after an unfinished reset', () => {
    const a = straight({count: 20, lead: 1, dt: 0.01}), b = straight({count: 20, lead: 1, dt: 0.01});
    a.startTick = 0.9; b.startTick = 0.1;
    expect(gapAt(a, b, Float32Array.from({length: 20}, (_, i) => i), 1)).toBeCloseTo(0.008);
    a.phase = new Uint8Array(20).fill(1);
    a.phase.fill(0, 10);
    a.time = null;
    expect(gapAt(a, b, alignByTime(a, b), 12)).toBeNull();
  });
  test('a replay that never starts has no meaningful comparison gap', async () => {
    const ready = await recorded([{}, {}, {}]);
    const other = straight({count: 4, lead: 0});
    expect(gapAt(ready, other, alignByTime(ready, other), 2)).toBeNull();
  });
});

describe('the planned camera', () => {
  // Where the camera is round the ghosts at a tick: degrees from behind the
  // travel (+x) towards its right (-y), and above them.
  const angles = (planned, tick) => {
    const {eye, target} = shotAt(planned, tick), dx = eye.x - target.x, dy = eye.y - target.y, dz = eye.z - target.z;
    return {swing: Math.atan2(-dy, -dx) * 180 / Math.PI, elevation: Math.asin(dz / Math.hypot(dx, dy, dz)) * 180 / Math.PI};
  };
  // A run along +x surfing ramps between the given ticks, each open to the
  // right of travel (the face looks to -y).
  const surfing = (spans, options = {}) => {
    const track = straight({count: 900, ...options});
    for (const [from, to] of spans) for (let i = from; i <= to; i++) track.normal.set([0, -0.8, 0.6], i * 3);
    return track;
  };
  const plan = async (normal, trace = null, style) => {
    const a = straight({normal}), b = straight({normal, y: 40});
    return {a, plan: await planCamera({a, b, map: alignByPlace(a, b), trace, style})};
  };
  const at = (result, tick) => shotAt(result.plan, tick);
  for (const style of ['cinematic', 'steady']) describe(style, () => {
    test('sits behind and above the ghosts between ramps', async () => {
      const result = await plan(null, null, style);
      const {eye, target} = at(result, 200);
      expect(eye.x).toBeLessThan(target.x - 100);
      expect(Math.abs(eye.y - target.y)).toBeLessThan(30);
      expect(eye.z).toBeGreaterThan(target.z + 40);
    });
    test('looks onto the open side of the ramp they surf', async () => {
      // Travelling +x, a face whose normal points -y faces the runners' right.
      const result = await plan([0, -0.8, 0.6], null, style);
      const {eye, target} = at(result, 200);
      expect(eye.y).toBeLessThan(target.y - 60);
      const other = at(await plan([0, 0.8, 0.6], null, style), 200);
      expect(other.eye.y).toBeGreaterThan(other.target.y + 60);
    });
    test('keeps out of walls: blocked spots turn or pull the camera in before it gets there', async () => {
      // Everything further than 90 units from the ghosts is solid.
      const trace = (from, to) => Math.min(1, 90 / Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z));
      const result = await plan(null, trace, style);
      const {eye, target} = at(result, 200);
      expect(Math.hypot(eye.x - target.x, eye.y - target.y, eye.z - target.z)).toBeLessThan(260);
    });
    test('with a wall between the two lines, the camera stays on the played run’s side', async () => {
      const a = straight(), b = straight({y: 600});
      // A solid slab from y 200 to 400; a trace that starts inside it is ignored, as the game's startSolid is.
      const trace = (from, to) => {
        if (from.y > 200 && from.y < 400) return 1;
        const crossing = [200, 400].map(y => (y - from.y) / (to.y - from.y)).filter(t => t > 0 && t < 1);
        return crossing.length ? Math.min(...crossing) : 1;
      };
      const planned = await planCamera({a, b, map: alignByPlace(a, b), trace, style});
      expect(shotAt(planned, 200).eye.y).toBeLessThan(200);
    });
    test('an odd-tick teleport changes the camera at the cut, not the following sample', async () => {
      const a = straight({count: 12, lead: 0});
      for (let i = 3; i < a.count; i++) a.position[i * 3] += 5000;
      a.cut[3] = 1;
      const planned = await planCamera({a, others: [], style});
      expect(shotAt(planned, 2.9).target.x).toBeLessThan(1000);
      expect(shotAt(planned, 3).target.x).toBeGreaterThan(4000);
    });
    test('frames several runs at once, each counting while it stays near', async () => {
      const a = straight(), near = straight({y: 120}), far = straight({y: 9000});
      const planned = await planCamera({a, others: [{track: near, map: alignByTime(a, near)}, {track: far, map: alignByTime(a, far)}], style});
      const {target} = shotAt(planned, 200);
      expect(target.y).toBeGreaterThan(30);
      expect(target.y).toBeLessThan(90);
    });
    test('focused on one run, the others don’t pull the framing', async () => {
      const a = straight(), near = straight({y: 400});
      const planned = await planCamera({a, others: [{track: near, map: alignByTime(a, near)}], group: false, style});
      expect(Math.abs(shotAt(planned, 200).target.y)).toBeLessThan(5);
    });
    test('another run’s teleport doesn’t cut the shot: that run eases out of the framing around it', async () => {
      const a = straight(), b = straight({y: 200});
      for (let i = 200; i < b.count; i++) b.position[i * 3 + 1] += 3000;
      b.cut[200] = 1;
      const planned = await planCamera({a, others: [{track: b, map: alignByTime(a, b)}], style});
      expect([...planned.segment].every(segment => segment === 0)).toBe(true);
      expect(shotAt(planned, 120).target.y).toBeGreaterThan(70);
      expect(Math.abs(shotAt(planned, 200).target.y)).toBeLessThan(40);
      const before = shotAt(planned, 199).target, after = shotAt(planned, 201).target;
      expect(Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z)).toBeLessThan(80);
    });
  });
  test('cinematic gives long ramps shots of their own in turn; steady keeps one', async () => {
    const a = surfing([[100, 300], [380, 580], [660, 860]]);
    const cinematic = await planCamera({a, style: 'cinematic'}), steady = await planCamera({a, style: 'steady'});
    const first = angles(cinematic, 200), second = angles(cinematic, 480);
    expect(Math.abs(first.swing - second.swing) + Math.abs(first.elevation - second.elevation)).toBeGreaterThan(20);
    // Every shot is still from the open side.
    for (const tick of [200, 480, 760]) expect(angles(cinematic, tick).swing).toBeGreaterThan(20);
    const held = [200, 480, 760].map(tick => angles(steady, tick));
    for (const shot of held) {
      expect(shot.swing).toBeGreaterThan(20);
      expect(shot.swing).toBeLessThan(60);
      expect(Math.abs(shot.elevation - held[0].elevation)).toBeLessThan(3);
    }
  });
  test('cinematic drifts round the prestrafe to behind them as they leave; steady waits behind', async () => {
    const a = straight({lead: 200});
    const cinematic = await planCamera({a, style: 'cinematic'}), steady = await planCamera({a, style: 'steady'});
    expect(Math.abs(angles(cinematic, 10).swing)).toBeGreaterThan(25);
    expect(Math.abs(angles(cinematic, 195).swing)).toBeLessThan(10);
    expect(Math.abs(angles(steady, 10).swing)).toBeLessThan(5);
  });
  test('after a teleport the cinematic camera opens higher and wider, then settles; steady cuts straight to its shot', async () => {
    const a = straight({count: 700});
    for (let i = 300; i < a.count; i++) a.position[i * 3 + 1] += 20000;
    a.cut[300] = 1;
    const distance = (planned, tick) => { const {eye, target} = shotAt(planned, tick); return Math.hypot(eye.x - target.x, eye.y - target.y, eye.z - target.z); };
    const cinematic = await planCamera({a, style: 'cinematic'}), steady = await planCamera({a, style: 'steady'});
    expect(angles(cinematic, 304).elevation).toBeGreaterThan(angles(cinematic, 500).elevation + 8);
    expect(distance(cinematic, 304)).toBeGreaterThan(distance(cinematic, 500) * 1.3);
    expect(Math.abs(angles(steady, 304).elevation - angles(steady, 500).elevation)).toBeLessThan(3);
  });
  test('the view widens with speed, more in the cinematic style', async () => {
    const fov = async (speed, style) => shotAt(await planCamera({a: straight({speed}), style}), 200).fov;
    expect(await fov(5, 'cinematic')).toBeCloseTo(74);
    expect(await fov(60, 'cinematic')).toBeGreaterThan(82);
    expect(await fov(60, 'steady')).toBeGreaterThan(77);
    expect(await fov(60, 'steady')).toBeLessThan(await fov(60, 'cinematic'));
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
});

describe('picking runs', () => {
  const refs = {record: {runId: 'wr', username: 'fast', timeUs: 40e6}, loadReplay: async id => ({id}), loadRecordRoute: async () => ({ksf: true}),
    entries: [{rank: 1, runId: 'wr', username: 'fast', timeUs: 40e6}]};
  test('the site WR and the leaderboard’s #1 are the same run', () => {
    expect(ghostSources({refs})[1].id).toBe(boardSource(refs.entries[0], refs).id);
  });
});

// Disabled cinematic viewing must cost nothing.
describe('cinematic replay lifecycle', () => {
  const originals = {};
  const calls = [];
  const keep = (...names) => { for (const name of names) if (!(name in originals)) originals[name] = globalThis[name]; };
  const spy = name => { keep(name); globalThis[name] = () => { calls.push(name); }; };
  afterEach(() => {
    for (const [name, value] of Object.entries(originals)) globalThis[name] = value;
    for (const name of Object.keys(originals)) delete originals[name];
    calls.length = 0;
  });
  test('no timers, frames, listeners, observers or fetches while disabled', () => {
    for (const name of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'fetch', 'addEventListener']) spy(name);
    keep('MutationObserver');
    const observed = [];
    globalThis.MutationObserver = class { constructor() { observed.push('MutationObserver'); } observe() {} disconnect() {} };
    const renderer = {qolScene: {}, render() {}}, native = renderer.render;
    const cinema = createCinema({getAdapter: () => ({cinema: {renderer: () => renderer}, getSession: () => ({map: {}}), replay: {playback: () => ({replay: null})}})});
    for (let i = 0; i < 20; i++) { cinema.available(); cinema.status(); }
    expect(cinema.active).toBe(false);
    expect(cinema.status()).toBeNull();
    expect(renderer.render).toBe(native);
    cinema.close();
    expect(calls).toEqual([]);
    expect(observed).toEqual([]);
  });

  function rig(options = {}) {
    let recorded = 0;
    const listeners = new Map();
    keep('addEventListener', 'removeEventListener', 'document', 'innerWidth', 'innerHeight', 'requestAnimationFrame', 'cancelAnimationFrame');
    globalThis.addEventListener = (type, listener) => listeners.set(type, listener);
    globalThis.removeEventListener = type => listeners.delete(type);
    const canvas = {};
    globalThis.document = {querySelector: () => canvas};
    globalThis.innerWidth = 1280; globalThis.innerHeight = 720;
    globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
    const native = function (view) { this.drawn = view; };
    const renderer = {qolScene: {}, qolCamera: {position: {set() {}}}, render: native};
    const played = {mapId: 'm', mapVersion: 1, commands: new Array(59).fill({}), initialState: {tick: 0}};
    let disposed = 0, scenes = 0, colors = [], positions = [], made = [];
    const control = {renderer, playback: {replay: played}, session: {map: {id: 'm', version: 1}}};
    const adapter = {cinema: {renderer: () => control.renderer}, getSession: () => control.session, replay: {playback: () => control.playback}};
    const cinema = createCinema({getAdapter: () => adapter, loadIdle: options.loadIdle ?? (async () => null), now: options.now,
      record: async args => { recorded++; return options.record ? options.record(args) : straight({count: 60, lead: 5, y: (recorded - 1) * 30}); },
      createScene: (_, runs) => {
        scenes = runs.length; colors = runs.map(run => run.colorIndex);
        const scene = {shown: runs.map(() => true), disposed: false, update(at) { positions = at.slice(); }, labels: () => [],
          show(index, value) { scene.shown[index] = value; }, dispose() { disposed++; scene.disposed = true; }};
        if (options.prepareScene) scene.prepare = () => options.prepareScene(scene);
        made.push(scene);
        return scene;
      }});
    return {cinema, renderer, native, listeners, control, canvas, counts: () => ({disposed, scenes, recorded, colors, positions, made})};
  }
  const run = id => ({id, label: id, load: async () => ({commands: [{run: id}]})});
  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {promise, resolve};
  };
  test('solo viewing supports explicit group and focus choices without extra runs', async () => {
    const {cinema, counts} = rig();
    expect(await cinema.setEnabled(true)).toBe(true);
    expect(cinema.active).toBe(true);
    expect(cinema.comparing).toBe(false);
    expect(counts().scenes).toBe(1);
    await cinema.setFocus('played');
    expect(cinema.status().focus).toBe('played');
    await cinema.setFocus(null);
    await cinema.setFocus(null);
    await cinema.setSync('place');
    expect(cinema.status()).toMatchObject({active: true, focus: null, sync: 'place', runs: []});
    await cinema.setEnabled(true);
    expect(counts().recorded).toBe(1);
    cinema.close();
  });
  test('POV keeps drawing during shader preparation and the camera starts only when ready', async () => {
    const entered = deferred(), ready = deferred();
    const {cinema, renderer} = rig({prepareScene: () => { entered.resolve(); return ready.promise; }});
    const enabling = cinema.setEnabled(true);
    await entered.promise;
    const pov = {state: {tick: 30}, eyePosition: {x: 1, y: 2, z: 3}, yaw: 0, pitch: 0, fov: 90};
    renderer.render(pov);
    expect(renderer.drawn).toBe(pov);
    expect(cinema.camera).toBe(false);
    ready.resolve();
    expect(await enabling).toBe(true);
    renderer.render(pov);
    expect(cinema.camera).toBe(true);
    expect(renderer.drawn).not.toBe(pov);
    cinema.close();
  });

  test('returning to solo POV while shaders prepare cancels activation and restores native rendering', async () => {
    const entered = deferred(), ready = deferred();
    const {cinema, renderer, native, counts} = rig({prepareScene: () => { entered.resolve(); return ready.promise; }});
    const enabling = cinema.setEnabled(true);
    await entered.promise;
    await cinema.setView('pov');
    expect(await enabling).toBe(false);
    expect(cinema.camera).toBe(false);
    expect(cinema.status()).toBeNull();
    expect(renderer.render).toBe(native);
    expect(counts().made[0].disposed).toBe(true);
    ready.resolve();
  });

  test('a replacement renderer can activate without waiting for the obsolete compiler', async () => {
    const entered = deferred(), oldReady = deferred(), newReady = deferred();
    let preparations = 0;
    const {cinema, renderer, native, control} = rig({prepareScene: () => {
      if (++preparations === 1) { entered.resolve(); return oldReady.promise; }
      return newReady.promise;
    }});
    const frames = [];
    globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    const enabling = cinema.setEnabled(true);
    await entered.promise;
    const replacement = control.renderer = {qolScene: {}, qolCamera: {position: {set() {}}}, render: native};
    frames.shift()();
    newReady.resolve();
    expect(await enabling).toBe(true);
    expect(renderer.render).toBe(native);
    const pov = {state: {tick: 30}, eyePosition: {x: 0, y: 0, z: 0}, yaw: 0, pitch: 0, fov: 90};
    replacement.render(pov);
    expect(cinema.camera).toBe(true);
    expect(replacement.drawn).not.toBe(pov);
    cinema.close();
    oldReady.resolve();
  });

  test('choosing POV during an added run’s shader preparation keeps its ghosts without enabling the camera', async () => {
    const entered = deferred(), ready = deferred();
    const {cinema, renderer, counts} = rig({prepareScene: () => { entered.resolve(); return ready.promise; }});
    const adding = cinema.add(run('other'));
    await entered.promise;
    await cinema.setView('pov');
    ready.resolve();
    expect(await adding).toBe(true);
    const pov = {state: {tick: 30}, eyePosition: {x: 0, y: 0, z: 0}, yaw: 0, pitch: 0, fov: 90};
    renderer.render(pov);
    expect(cinema.status()).toMatchObject({view: 'pov', runs: [{id: 'other'}]});
    expect(renderer.drawn).toBe(pov);
    expect(counts().made.at(-1).shown).toEqual([false, true]);
    cinema.close();
  });

  test('a replay changed during shader preparation cannot activate the previous camera', async () => {
    const entered = deferred(), ready = deferred();
    const {cinema, control, renderer, native} = rig({prepareScene: () => { entered.resolve(); return ready.promise; }});
    const enabling = cinema.setEnabled(true);
    await entered.promise;
    control.playback.replay = null;
    cinema.close();
    ready.resolve();
    expect(await enabling).toBe(false);
    expect(renderer.render).toBe(native);
    expect(cinema.camera).toBe(false);
  });
  test('reopening never restores removed comparison runs or a track recorded on a replaced map or world', async () => {
    const time = {now: 0};
    const {cinema, renderer, control} = rig({now: () => time.now});
    const frame = {state: {tick: 30}, eyePosition: {x: 0, y: 0, z: 0}, yaw: 0, pitch: 0, fov: 90};
    await cinema.setEnabled(true);
    renderer.render(frame); time.now += 2000; renderer.render(frame);
    const soloEye = {...renderer.drawn.eyePosition};
    await cinema.add(run('other'));
    cinema.close();
    await cinema.setEnabled(true);
    renderer.render(frame); time.now += 2000; renderer.render(frame);
    expect(cinema.status().runs).toEqual([]);
    expect(renderer.drawn.eyePosition).toEqual(soloEye);
    cinema.close();
    // A new map object may have the same id/version but a new collision world.
    control.session.map = {...control.session.map};
    await cinema.setEnabled(true);
    expect(cinema.tracks[0].position[1]).toBe(60);
    cinema.close();
    control.session.movement = {world: {}};
    await cinema.setEnabled(true);
    expect(cinema.tracks[0].position[1]).toBe(90);
    cinema.close();
  });
  test('color slots remain stable when another run is removed and its slot reused', async () => {
    const {cinema, counts} = rig();
    await cinema.add(run('first'));
    await cinema.add(run('second'));
    const color = cinema.status().runs[1].color;
    cinema.remove('first');
    await cinema.add(run('third'));
    expect(cinema.status().runs).toMatchObject([
      {id: 'second', colorIndex: 2, color},
      {id: 'third', colorIndex: 1},
    ]);
    expect(counts().colors).toEqual([0, 2, 1]);
    expect(counts().recorded).toBe(4);
    cinema.close();
  });
  test('aliases of an already added replay are rejected before resimulation', async () => {
    const {cinema, counts} = rig();
    await cinema.add(run('first'));
    await expect(cinema.add({...run('alias'), load: run('first').load})).rejects.toThrow('already added');
    expect(counts().recorded).toBe(2);
    expect(cinema.status().runs).toHaveLength(1);
    cinema.close();
  });
  test('a failed addition preserves an existing solo camera and later additions work', async () => {
    const {cinema} = rig();
    await cinema.setEnabled(true);
    await expect(cinema.add({id: 'missing', load: async () => null})).rejects.toThrow('isn’t available');
    expect(cinema.status()).toMatchObject({active: true, runs: [], loading: []});
    expect(await cinema.add(run('valid'))).toBe(true);
    cinema.close();
  });
  test('disabling cancels an in-flight solo recording without attaching later', async () => {
    const entered = deferred(), release = deferred();
    const {cinema, renderer, native} = rig({record: async () => { entered.resolve(); await release.promise; return straight({count: 60}); }});
    const enabled = cinema.setEnabled(true);
    await entered.promise;
    await cinema.setEnabled(false);
    release.resolve();
    expect(await enabled).toBe(false);
    expect(cinema.status()).toBeNull();
    expect(renderer.render).toBe(native);
  });
  test('a closed session’s unresolved download cannot block a newly enabled camera', async () => {
    const entered = deferred(), release = deferred();
    const {cinema} = rig();
    const adding = cinema.add({id: 'slow', load: async () => { entered.resolve(); await release.promise; return {commands: [{slow: true}]}; }});
    await entered.promise;
    cinema.close();
    expect(await cinema.setEnabled(true)).toBe(true);
    expect(await cinema.add(run('new'))).toBe(true);
    release.resolve();
    expect(await adding).toBe(false);
    expect(cinema.status().runs.map(item => item.id)).toEqual(['new']);
    cinema.close();
  });
  test('removing a pending download cancels it without inserting a stale run', async () => {
    const entered = deferred(), release = deferred();
    const {cinema, counts} = rig();
    await cinema.setEnabled(true);
    const adding = cinema.add({id: 'slow', load: async () => { entered.resolve(); await release.promise; return {commands: [{slow: true}]}; }});
    await entered.promise;
    expect(cinema.status().loading[0]).toMatchObject({id: 'slow', colorIndex: 1});
    cinema.remove('slow');
    release.resolve();
    expect(await adding).toBe(false);
    expect(cinema.status()).toMatchObject({active: true, runs: [], loading: []});
    expect(counts().recorded).toBe(1);
    cinema.close();
  });
  test('a cancelled download does not hold up the next addition in the same session', async () => {
    const entered = deferred(), release = deferred();
    const {cinema} = rig();
    await cinema.setEnabled(true);
    const adding = cinema.add({id: 'slow', load: async () => { entered.resolve(); await release.promise; return {commands: [{slow: true}]}; }});
    await entered.promise;
    cinema.remove('slow');
    expect(await adding).toBe(false);
    expect(await cinema.add(run('next'))).toBe(true);
    release.resolve();
    expect(cinema.status().runs.map(item => item.id)).toEqual(['next']);
    cinema.close();
  });
  test('a recording failure cleans up activation and allows a clean retry', async () => {
    let fail = true;
    const {cinema, renderer, native} = rig({record: async () => {
      if (fail) { fail = false; throw new Error('Physics failed'); }
      return straight({count: 60});
    }});
    await expect(cinema.setEnabled(true)).rejects.toThrow('Physics failed');
    expect(cinema.status()).toBeNull();
    expect(renderer.render).toBe(native);
    expect(await cinema.setEnabled(true)).toBe(true);
    cinema.close();
  });
  test('queued and loaded runs can exceed the old palette-sized limit', async () => {
    const {cinema} = rig();
    const ids = Array.from({length: 9}, (_, index) => `run-${index}`);
    await Promise.all(ids.map(id => cinema.add(run(id))));
    const colors = new Map(cinema.status().runs.map(run => [run.id, run.color]));
    expect([...colors.keys()]).toEqual(ids);
    await cinema.remove(ids[3]);
    await cinema.add(run('replacement'));
    for (const entry of cinema.status().runs) {
      if (entry.id !== 'replacement') expect(entry.color).toBe(colors.get(entry.id));
    }
    expect(cinema.status().runs.find(entry => entry.id === 'replacement').colorIndex).toBe(4);
    cinema.close();
  });
  test('rendering and seeks use the native fractional clock relative to a clipped initial tick', async () => {
    const {cinema, renderer, control, counts} = rig();
    control.playback.replay.initialState.tick = 100;
    await cinema.add(run('other'));
    renderer.render({state: {tick: 130}, qolAlpha: 0.25});
    expect(counts().positions).toEqual([29.25, 29.25]);
    renderer.render({state: {tick: 110}, qolAlpha: 0.5});
    expect(counts().positions).toEqual([9.5, 9.5]);
    // Native seeking collapses previous=current without clearing its accumulator.
    control.session.previous = {tick: 110};
    renderer.render({state: {tick: 110}, qolAlpha: 0.5});
    expect(counts().positions).toEqual([10, 10]);
    renderer.render({state: {tick: 111}, qolAlpha: 0.5});
    expect(counts().positions).toEqual([10.5, 10.5]);
    cinema.close();
  });
  test('scroll zoom eases in quickly and the same at any frame rate; the plan sets the fov', async () => {
    const time = {now: 0};
    const {cinema, renderer, listeners, canvas} = rig({now: () => time.now});
    await cinema.setEnabled(true);
    const eye = () => { renderer.render({state: {tick: 30}, qolAlpha: 1}); return {...renderer.drawn.eyePosition}; };
    const wheel = deltaY => listeners.get('wheel')({target: canvas, deltaY, preventDefault() {}, stopImmediatePropagation() {}});
    // Past the flight out of first person first.
    eye(); time.now += 2000;
    const start = eye(), moved = point => Math.hypot(point.x - start.x, point.y - start.y, point.z - start.z);
    expect(renderer.drawn.fov).toBeGreaterThanOrEqual(74);
    wheel(100);
    time.now += 16;
    const early = moved(eye());
    time.now += 2000;
    const full = moved(eye());
    expect(early / full).toBeGreaterThan(0.08);
    expect(early / full).toBeLessThan(0.3);
    // Back out in two 8 ms frames: the same share as one 16 ms frame.
    wheel(-100);
    time.now += 8; eye();
    time.now += 8;
    expect(1 - moved(eye()) / full).toBeCloseTo(early / full, 3);
    cinema.close();
  });
  test('a new set of runs replaces the scene only after the new one has drawn, so shaders are reused', async () => {
    const {cinema, renderer, counts} = rig();
    await cinema.setEnabled(true);
    await cinema.add(run('wr'));
    const [first, second] = counts().made;
    expect(first.disposed).toBe(false);
    expect(first.shown.every(value => !value)).toBe(true);
    renderer.render({state: {tick: 20}, qolAlpha: 1});
    expect(first.disposed).toBe(true);
    expect(second.disposed).toBe(false);
    cinema.close();
    expect(second.disposed).toBe(true);
  });
  test('first person keeps the game’s view with the added runs, and hides the watched run’s ghost', async () => {
    const time = {now: 0};
    const {cinema, renderer, counts} = rig({now: () => time.now});
    await cinema.add(run('wr'));
    expect(cinema.status()).toMatchObject({view: 'cinematic'});
    expect(cinema.camera).toBe(true);
    const own = {state: {tick: 30}, qolAlpha: 1, eyePosition: {x: 5, y: 6, z: 7}, yaw: 10, pitch: 5, fov: 90, ghost: {}};
    renderer.render(own); time.now += 2000; renderer.render(own);
    const camera = {...renderer.drawn.eyePosition};
    await cinema.setView('pov');
    expect(cinema.status()).toMatchObject({view: 'pov', active: true});
    expect(cinema.camera).toBe(false);
    // The way back into the eyes is a flight, then the game's own view.
    time.now += 500; renderer.render(own);
    const halfway = renderer.drawn.eyePosition;
    expect(Math.hypot(halfway.x - 5, halfway.y - 6, halfway.z - 7)).toBeGreaterThan(1);
    expect(Math.hypot(halfway.x - camera.x, halfway.y - camera.y, halfway.z - camera.z)).toBeGreaterThan(1);
    time.now += 1000; renderer.render(own);
    expect(renderer.drawn).toBe(own);
    expect(counts().made.at(-1).shown[0]).toBe(false);
    expect(counts().made.at(-1).shown[1]).toBe(true);
    // Flying out of the eyes again, the watched ghost waits until the camera is clear of them.
    await cinema.setView('cinematic');
    time.now += 100; renderer.render(own);
    expect(counts().made.at(-1).shown[0]).toBe(false);
    time.now += 400; renderer.render(own);
    expect(counts().made.at(-1).shown[0]).toBe(true);
    cinema.close();
  });
  test('first person leaves the mouse to the game; choosing a run there follows it with the camera', async () => {
    const {cinema, listeners, canvas} = rig();
    await cinema.add(run('wr'));
    await cinema.setView('pov');
    const wheel = {target: canvas, deltaY: 100, prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {}};
    listeners.get('wheel')(wheel);
    expect(wheel.prevented).toBe(false);
    expect(cinema.status().adjusted).toBe(false);
    await cinema.setFocus('wr');
    expect(cinema.status()).toMatchObject({view: 'cinematic', focus: 'wr'});
    cinema.close();
  });
  test('adding a run from first person switches to the remembered style; first person with none is all off', async () => {
    const {cinema} = rig();
    await cinema.setView('steady');
    expect(cinema.status().view).toBe('steady');
    await cinema.setView('pov');
    expect(cinema.status()).toBeNull();
    await cinema.add(run('wr'));
    expect(cinema.status()).toMatchObject({view: 'steady', runs: [{id: 'wr'}]});
    // Removing the last run keeps the view it was in.
    await cinema.remove('wr');
    expect(cinema.status()).toMatchObject({view: 'steady', runs: []});
    await cinema.setView('pov');
    expect(cinema.status()).toBeNull();
  });
  test('a camera style plans its own shots and is kept with the others', async () => {
    const {cinema, renderer} = rig();
    await cinema.setEnabled(true);
    expect(cinema.status().style).toBe('cinematic');
    renderer.render({state: {tick: 40}, qolAlpha: 1});
    const cinematic = {...renderer.drawn.eyePosition};
    await cinema.setStyle('steady');
    expect(cinema.status().style).toBe('steady');
    renderer.render({state: {tick: 40}, qolAlpha: 1});
    expect(renderer.drawn.eyePosition).not.toEqual(cinematic);
    await cinema.setStyle('nonsense');
    await cinema.setSync('place');
    expect(cinema.status()).toMatchObject({style: 'steady', sync: 'place'});
    cinema.close();
  });
  test('concurrent solo activation shares recording and enables both callers', async () => {
    const {cinema, counts} = rig();
    expect(await Promise.all([cinema.setEnabled(true), cinema.setEnabled(true)])).toEqual([true, true]);
    expect(counts().recorded).toBe(1);
    cinema.close();
  });
  test('removing the final extra retains solo viewing until explicitly disabled', async () => {
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
    expect(renderer.render).not.toBe(native);
    expect(listeners.size).toBeGreaterThan(0);
    expect(cinema.status()).toMatchObject({active: true, runs: []});
    expect(cinema.comparing).toBe(false);
    await cinema.setEnabled(false);
    expect(renderer.render).toBe(native);
    expect(listeners.size).toBe(0);
    expect(counts().disposed).toBe(2);
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
  test('a run’s chip follows that run alone; choosing it again goes back to everyone', async () => {
    const {cinema} = rig();
    await cinema.add(run('wr'));
    await cinema.setFocus('wr');
    expect(cinema.status().focus).toBe('wr');
    await cinema.setFocus('played');
    expect(cinema.status().focus).toBe('played');
    await cinema.setFocus('played');
    expect(cinema.status().focus).toBeNull();
    await cinema.setFocus('wr');
    await cinema.remove('wr');
    expect(cinema.status()).toMatchObject({active: true, focus: null, runs: []});
  });
  test('the run being watched can’t be added to itself', async () => {
    const {cinema, control} = rig();
    await expect(cinema.add({id: 'same', label: 'same', load: async () => ({...control.playback.replay})})).rejects.toThrow('That’s the run you’re watching.');
    expect(cinema.status()).toBeNull();
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
