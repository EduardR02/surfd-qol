// Fixture run history, replay playback and ramp references for the harness,
// in the exact shapes src/run-history.js (history.maps/view/usage),
// src/replay-control.js (status and controls) and src/ramp-reference.js
// hand to the UI.
import {SPEEDS, MAX_SPOTS} from '../src/replay-control.js';
import {referenceTone} from '../src/hud-model.js';

const DT = 0.015;
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
// A fixed "now" keeps dates in screenshots stable: Oct 24 2026, 21:40.
export const NOW = Date.parse('2026-10-24T21:40:00');

// Deterministic noise.
const noise = seed => { const x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x); };
const round = (value, digits = 1) => Number(value.toFixed(digits));

function makeRuns({key, kind = 'CP', total, best, count, at, gap = 95000, finishEvery = 3, seed = 1}) {
  const runs = [];
  for (let i = 0; i < count; i++) {
    const r = noise(seed + i);
    const finished = i % finishEvery === 1;
    const reached = finished ? total : Math.floor(noise(seed * 3 + i) * (total + 0.99));
    // A short reset now and then, to exercise "Skip short resets".
    const short = !finished && i % 5 === 3;
    const time = finished ? best + 0.3 + r * 3.1 : short ? 2 + r * 6 : (reached + 0.3 + noise(seed + i * 7) * 0.9) * (best / (total + 1));
    runs.push({
      id: `${key}-${i}`, at: at - i * gap, time: round(time, 3), outcome: finished ? 'finished' : 'reset',
      checkpoints: short ? 0 : reached, totalCheckpoints: total, kind,
      practice: i === 6, invalid: i === 9 ? 'Teleported' : '',
      start: {speed: round(331 + noise(seed + i * 5) * 19), height: round(2 + r * 16)},
      ...(i % 7 === 4 ? {} : {replay: {start: 333, length: Math.round(time / DT) + 333, dt: DT}}),
    });
  }
  return runs;
}
function rampsFor(sections, perSection, seed) {
  const ramps = [];
  for (let section = 0; section < sections; section++) {
    for (let i = 0; i < perSection(section); i++) {
      const n = ramps.length, down = round(4 + noise(seed * 2 + n) * 16), up = round(6 + noise(seed * 5 + n) * 30);
      ramps.push({key: `r${n}`, label: `Ramp ${n + 1}`, checkpoint: section,
        board: n % 7 === 5 ? null : round(noise(seed + n) * 9), down, up, surf: round(down + up)});
    }
  }
  return ramps;
}
const split = (label, time, speed, pb, at) => ({label, time, speed, at, pb});

const maps = {
  'utopia:3': {
    name: 'Utopia', kind: 'CP', total: 3, at: NOW - 6 * MINUTE, totals: {attempts: 124, finishes: 37},
    runs: makeRuns({key: 'utopia', total: 3, best: 41.233, count: 26, at: NOW - 6 * MINUTE, seed: 4}),
    pb: {id: 'utopia-pb', at: NOW - DAY - 2 * HOUR, time: 41.233, outcome: 'finished', checkpoints: 3, totalCheckpoints: 3, practice: false, invalid: '',
      start: {speed: 349.6, height: 3.1}, kind: 'CP', replay: {start: 333, length: 3082, dt: DT}},
    splits: [split('CP1', 10.12, 2412, 10.201, NOW - DAY), split('CP2', 21.233, 2950, 21.233, NOW - DAY), split('CP3', 30.871, 3104, 31.273, NOW - 3 * HOUR)],
    ramps: rampsFor(4, section => [3, 2, 3, 2][section], 11),
    start: {best: 349.6, average: 346.1, count: 124},
  },
  'kitsune:1': {
    name: 'Kitsune', kind: 'S', total: 9, at: NOW - 3 * DAY, totals: {attempts: 212, finishes: 18},
    runs: makeRuns({key: 'kitsune', kind: 'S', total: 9, best: 94.195, count: 44, at: NOW - 3 * DAY, gap: 160000, finishEvery: 5, seed: 9}),
    pb: {id: 'kitsune-pb', at: NOW - 3 * DAY - HOUR, time: 94.195, outcome: 'finished', checkpoints: 9, totalCheckpoints: 9, practice: false, invalid: '',
      start: {speed: 348.8, height: 4.0}, kind: 'S', replay: {start: 333, length: 6613, dt: DT}},
    splits: Array.from({length: 9}, (_, i) => {
      const time = round(9.7 * (i + 1) + noise(i) * 2, 3);
      return split(`S${i + 2}`, time, Math.round(2200 + noise(i + 3) * 1100), i % 3 === 1 ? time : round(time + 0.05 + noise(i + 9) * 0.6, 3), NOW - 3 * DAY);
    }),
    ramps: rampsFor(10, section => 2 + (section % 3), 23),
    start: {best: 348.8, average: 341.7, count: 212},
  },
  'mesa:2': {
    name: 'Mesa', kind: 'CP', total: 3, at: NOW - 30 * HOUR, totals: {attempts: 5, finishes: 0},
    runs: makeRuns({key: 'mesa', total: 3, best: 50.1, count: 5, at: NOW - 30 * HOUR, finishEvery: 99, seed: 2}).map((run, i) => ({...run, outcome: 'reset', checkpoints: [2, 1, 0, 1, 2][i]})),
    pb: null,
    splits: [split('CP1', 14.902, 2240, null, NOW - 30 * HOUR), split('CP2', 27.551, 2615, null, NOW - 30 * HOUR)],
    ramps: rampsFor(3, section => [2, 3, 1][section], 5),
    start: {best: 344.2, average: 339.9, count: 5},
  },
  'boreas:2': {
    name: 'Boreas', kind: 'CP', total: 2, at: Date.parse('2026-10-09T18:20:00'), totals: {attempts: 2, finishes: 2},
    runs: makeRuns({key: 'boreas', total: 2, best: 64.912, count: 2, at: Date.parse('2026-10-09T18:20:00'), finishEvery: 1, seed: 7})
      .map(run => ({...run, outcome: 'finished', checkpoints: 2})),
    pb: null, splits: [], ramps: [], start: {best: 347.2, average: 347.2, count: 2},
  },
};
// A bail on Utopia's Ramp 6: most of your speed gone where the PB and WR lose little.
Object.assign(maps['utopia:3'].ramps[5], {board: 38.6, down: 96.2, up: 238, surf: 334.2, clean: {board: 4.1, down: 12.6, up: 27.9, surf: 40.5}});
// ?bail=none: Ramp 6 surfed cleanly instead.
export function skipBail() {
  const ramp = maps['utopia:3'].ramps[5];
  Object.assign(ramp, ramp.clean);
  delete ramp.clean;
}
maps['boreas:2'].pb = maps['boreas:2'].runs[1];
maps['boreas:2'].splits = [split('CP1', 21.404, 2690, 21.404, 0), split('CP2', 43.118, 3010, 43.118, 0)];
for (const [key, map] of Object.entries(maps)) {
  if (map.pb) Object.assign(map.pb, {mapKey: key, mapName: map.name,
    boards: map.ramps.map((ramp, n) => [450 + n * 190, ramp.board, ramp.key])});
}

// Per-touch stats in the shape history.touchStats gives: reach falls along the
// route, speed grows, and the PB and WR touch a little flatter than your mean.
// touch=few has 23 runs recorded; touch=none has none.
function touchStatsFor(map, mode) {
  const runs = mode === 'few' ? 23 : mode === 'none' ? 0 : Math.min(200, map.totals.attempts);
  const touches = map.ramps.map((ramp, n) => {
    const reach = runs ? round(Math.max(0.18, 1 - n * 0.07 - noise(n + 40) * 0.05), 3) : null;
    const speed = 1900 + n * 120 + noise(n + 7) * 90, angle = ramp.clean ? 14.2 : 2.2 + noise(n + 21) * 3.4;
    const stat = (value, spread) => runs ? {best: round(value), last10: round(value + spread), avg: round(value + spread * 1.4)} : {best: null, last10: null, avg: null};
    const out = (into, a) => into * Math.cos(a * Math.PI / 180) - 2;
    const theirs = ramp.clean ? 3 : angle;
    const reference = factor => ({speedIn: round(speed + 8 * factor - noise(n + factor) * 20), speedOut: round(out(speed + 8 * factor, theirs * (1 - 0.15 * factor))),
      angle: round(theirs * (1 - 0.15 * factor) + (noise(n * 3 + factor) - 0.5) * 0.8)});
    return {key: ramp.key, index: n, checkpoint: ramp.checkpoint, reach, crashes: n === 5 ? 3 : n === 2 ? 1 : 0,
      speedIn: stat(speed + 30, -42), speedOut: stat(out(speed + 30, angle), -48),
      angle: runs ? {best: round(angle), last10: round(angle + 0.9 + noise(n + 3) * 0.6), avg: round(angle + 1.2 + noise(n + 5) * 0.5)} : {best: null, last10: null, avg: null},
      pb: n === 4 || n === 8 ? null : reference(1), wr: n === 8 ? null : reference(2.2)};
  });
  return {runs, touches};
}

export function createHistory({settings, empty = false, current = 'utopia:3', touch = null} = {}) {
  const shown = empty ? {} : maps;
  const listeners = new Set();
  const resetMaps = new Set();
  const highlights = new Map(Object.entries(shown).map(([key, map]) => {
    const run = map.runs.filter(run => run.outcome === 'finished' && !run.invalid && !run.practice && run.replay && run.at + run.time * 1000 > NOW - DAY)
      .sort((a, b) => a.time - b.time)[0];
    return [key, run ? {...run, finishedAt: run.at + run.time * 1000, expiresAt: run.at + run.time * 1000 + DAY,
      boards: map.ramps.slice(0, -1).map((ramp, n) => [450 + n * 190, ramp.board, ramp.key])} : null];
  }));
  // The newest attempt is `latest`; recent runs are the qualifying ones after it.
  const recentOf = map => {
    const qualifies = run => run.outcome === 'finished' || run.time >= settings.historyMinSeconds;
    return map.runs.slice(1).filter(qualifies).slice(0, settings.historyRunsPerMap);
  };
  return {
    currentMap: current,
    currentMapName: shown[current]?.name ?? 'Utopia',
    ready: Promise.resolve(),
    maps: () => Object.entries(shown).map(([key, map]) => ({key, name: map.name, at: map.at, runs: recentOf(map).length + 1 + (map.pb ? 1 : 0)}))
      .sort((a, b) => b.at - a.at),
    view(key = current, {rampMode = 'best'} = {}) {
      const map = shown[key];
      if (!map) return null;
      const ramps = rampMode === 'best' ? map.ramps : map.ramps.map((ramp, n) => {
        const result = {...ramp, counts: {}};
        for (const field of ['board', 'down', 'up', 'surf']) {
          const lag = field === 'board' ? 0 : field === 'down' ? 1 : 2;
          const count = resetMaps.has(key) || ramp[field] == null ? 0 : rampMode === 'recent' ? Math.max(1, 10 - n - lag) : 23 + n * 3 - lag;
          result.counts[field] = count;
          result[field] = count ? round(ramp[field] + (rampMode === 'recent' ? 2 : 4) + noise(n) * 4) : null;
        }
        // Ramp 6 is where runs crash into the edge now and then.
        result.crashes = resetMaps.has(key) ? 0 : n === 5 ? 2 : n === 2 ? 1 : 0;
        return result;
      });
      return {key, name: map.name, kind: map.kind, totals: map.totals, pb: map.pb, latest: map.runs[0] ?? null, recent: recentOf(map),
        recentBest: highlights.get(key), start: map.start, splits: map.splits.map((split, index) => ({...split, index})), ramps};
    },
    touchStats: key => shown[key] ? touchStatsFor(shown[key], key === 'mesa:2' ? 'few' : touch) : null,
    run: id => Object.values(shown).flatMap(map => [map.pb, ...map.runs]).find(run => run?.id === id) ?? null,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async resetRampAverages(key) { resetMaps.add(key); for (const listener of listeners) listener(); },
    async clear() {},
    usage: () => empty ? {bytes: 0, runs: 0, maps: 0} : {bytes: 61440, runs: 77, maps: 4},
  };
}
export const createReplays = ({empty = false} = {}) => ({
  usage: () => empty ? {bytes: 0, count: 0} : {bytes: 1.6 * 1024 * 1024, count: 26},
  subscribe: () => () => {}, clearMap: async () => {}, has: () => true,
});

// ?pb=official exercises native PB metadata independently of local history;
// ?pb=partial leaves later checkpoint references unavailable.
export function createLeaderboardReferences(params) {
  const mode = params.get('pb');
  if (mode !== 'official' && mode !== 'partial') return null;
  const own = {runId: 'utopia-official-pb', timeUs: 40800000,
    splitsUs: mode === 'partial' ? [10000000] : [10000000, 21233000, 31100000], createdAt: '2026-10-24T18:00:00'};
  return {boardId: 'utopia:3:default', mapName: 'Utopia', own,
    loadReplay: async () => {
      await new Promise(done => setTimeout(done, 700));
      return {mapId: 'utopia', mapVersion: 3, commands: Array(2800).fill({})};
    }};
}

// The PB and WR runs' ramps on the map loaded in the game (Utopia), as
// src/ramp-reference.js gives them. ?ref=loading|missing|pb|none.
export function createRampReference({params, settings, current = 'utopia:3'}) {
  const mode = params.get('ref') ?? 'ready';
  const listeners = new Set();
  const table = factor => new Map(maps[current].ramps.flatMap((ramp, n) => {
    // Ramp 9 is off both references' route.
    if (n === 8 || (mode === 'absent' && n === 0)) return [];
    const shift = (noise(n * 13 + factor) - .62) * 6 * factor, base = ramp.clean ?? ramp;
    return [[ramp.key, {tick: 450 + n * 190, board: Math.max(0, round((base.board ?? 4) + shift)), down: Math.max(0, round(base.down + shift)),
      up: Math.max(0, round(base.up + shift * 1.4)), surf: Math.max(0, round(base.surf + shift * 2.4))}]];
  }));
  const label = () => settings.wrSource === 'leaderboard' ? 'Site WR' : 'KSF WR';
  const entries = {pb: {status: 'ready', label: 'PB', ramps: table(1)}, wr: {status: 'ready', get label() { return label(); }, ramps: table(2.2)}};
  if (mode === 'loading' || mode === 'missing') for (const entry of Object.values(entries)) { entry.status = mode; entry.ramps = new Map(); }
  const get = (key, source) => {
    if (key !== current || mode === 'none' || (mode === 'pb' && source === 'wr')) return null;
    return entries[source] ?? null;
  };
  return {
    sources(key) { return ['pb', 'wr'].flatMap(name => { const entry = get(key, name); return entry ? [{name, label: entry.label}] : []; }); },
    createConsumer() {
      return {get, tone(key, loss) { return referenceTone(loss, entries.pb.ramps.get(key)?.board ?? null, settings.referenceLossTolerance); },
        async watchRamp(key, source, rampKey, control, {leadSeconds = 0.5, paused = true} = {}) {
          const entry = get(key, source), tick = entry?.ramps.get(rampKey)?.tick;
          if (entry?.status !== 'ready' || !Number.isInteger(tick)) return false;
          await control.watchLoaded(async () => ({fixture: true}), {title: `${entry.label} on Utopia`, tick: Math.max(0, tick - leadSeconds / DT), paused});
          return true;
        },
        version: () => mode, release() {}, destroy() {}};
    },
    version: () => mode,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    destroy() {},
  };
}

// The strafe preview as src/strafe-preview.js drives it, minus the camera:
// strokes alternate every 0.3 s while the speed grows. ?preview=error makes
// it refuse to start, as away from the start zone; any input stops it.
export function createStrafePreview(params) {
  const listeners = new Set(), inputs = ['keydown', 'mousedown', 'mousemove', 'wheel'];
  let run = null;
  const emit = value => { for (const listener of listeners) listener(value); };
  function stop() {
    if (!run) return;
    cancelAnimationFrame(run.frame);
    run = null;
    for (const type of inputs) removeEventListener(type, stop, true);
    emit({active: false});
  }
  function frame(now) {
    const seconds = (now - run.started) / 1000;
    const speed = run.mode === 'air' ? run.units + seconds * 120 : Math.min(run.units + seconds * 60, Math.max(run.units, 347));
    emit({active: true, key: Math.floor(seconds / 0.3) % 2 ? 'D' : 'A', speed, turnRate: (run.mode === 'air' ? 30000 : 48000) / Math.max(100, speed)});
    run.frame = requestAnimationFrame(frame);
  }
  return {
    get active() { return !!run; },
    async start({units, mode}) {
      if (params.get('preview') === 'error') throw new Error('Stand still in the start zone first.');
      if (!Number.isFinite(units) || units < 1 || units > 5000) throw new Error('Enter a speed from 1 to 5000 units.');
      stop();
      run = {units, mode, started: performance.now(), frame: 0};
      for (const type of inputs) addEventListener(type, stop, true);
      run.frame = requestAnimationFrame(frame);
    },
    stop,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

// The game's saveloc binds: ?binds=custom puts extras on the mouse and wheel.
export function createBinds(params) {
  if (params.get('binds') === 'custom') return {save: ['F5', 'Mouse4'], load: ['F9', 'Mouse3'], previousSave: ['WheelUp'], nextSave: ['WheelDown']};
  if (params.get('binds') === 'none') return {save: [], load: [], previousSave: [], nextSave: []};
  return {save: ['F5'], load: ['F9'], previousSave: [], nextSave: []};
}

// Playback over a fixture run: the controls work and the playhead moves; only
// the game behind them is still. ?play=paused|ended, ?locs=<n>, ?notice=<preset or text>.
const NOTICES = {saved: 'Saved location #3 · 00:21.233.', full: `You can keep up to ${MAX_SPOTS} locations in a replay; delete one first.`};
export function createReplayControl({params, active}) {
  const length = 3082, ownStart = 333, ownMarkers = [1008, 1748, 2391];
  const other = params.get('title') === 'other';
  let title = other ? 'Watching a replay on Utopia' : 'Your run on Utopia · finished in 00:41.233';
  // Ramp boards along the route, graded the way the lead's tone() does.
  const ramps = maps['utopia:3'].ramps.map((ramp, n) => {
    const section = [ownStart, ...ownMarkers, length - 40];
    const from = section[ramp.checkpoint], to = section[ramp.checkpoint + 1];
    const inSection = maps['utopia:3'].ramps.filter(entry => entry.checkpoint === ramp.checkpoint);
    const tick = Math.round(from + (to - from) * (inSection.indexOf(ramp) + 0.6) / (inSection.length + 0.4));
    return {tick, label: ramp.label, board: ramp.board, tone: ramp.board == null ? 'muted' : ['good', 'warn', 'loss', 'good', 'good', 'muted', 'warn', 'loss', 'good', 'warn'][n % 10]};
  });
  const play = params.get('play') ?? 'playing';
  let index = play === 'ended' ? length : Number(params.get('at') ?? 1590), playing = play === 'playing', speed = Number(params.get('speed') ?? 1);
  const count = Math.min(MAX_SPOTS, Number(params.get('locs') ?? 3));
  let spots = Array.from({length: count}, (_, i) => Math.round(ownStart + 150 + i * (length - ownStart - 300) / Math.max(1, count))), lastSpot = spots[1] ?? spots[0] ?? null;
  let notice = NOTICES[params.get('notice')] ?? params.get('notice') ?? '', noticeAt = performance.now(), last = performance.now();
  let run = other ? null : {id: 'utopia-pb', mapKey: 'utopia:3'};
  let external = false, visible = false, closed = false;
  const clamp = value => Math.max(0, Math.min(length, Math.round(value)));
  const say = text => { notice = text; noticeAt = performance.now(); };
  const tick = () => {
    const now = performance.now();
    if (playing && index < length) index = Math.min(length, index + (now - last) / 1000 / DT * speed);
    // Playback holds on the last frame.
    if (index >= length) playing = false;
    last = now;
  };
  return {
    canWatch: entry => !!entry?.replay,
    async watch(entry, {rampKey, leadSeconds = 0.5, paused = true, isCurrent = () => true} = {}) {
      const board = rampKey == null ? null : entry.boards?.find(([, , key]) => key === rampKey);
      if (rampKey != null && !board) return false;
      await new Promise(done => setTimeout(done, 700));
      if (!isCurrent()) return false;
      if (String(entry.id).endsWith('-5')) throw new Error('This run’s replay is no longer saved.');
      if (active()) {
        run = {id: entry.id, mapKey: 'utopia:3'};
        index = board ? clamp(board[0] - leadSeconds / DT) : ownStart - 66;
        playing = board ? !paused : true;
      }
      return true;
    },
    async watchLoaded(load, options) {
      const replay = await load();
      if (!replay) throw new Error('This replay is unavailable.');
      external = true; run = null; index = options.tick ?? 0; playing = !options.paused; title = options.title;
      spots = []; lastSpot = null;
    },
    setVisible(next) { visible = !!next; },
    get active() { return !closed && active(); },
    get visible() { return visible; },
    status() {
      if (closed || !active()) return null;
      tick();
      return {title, index: Math.round(index), length, start: external ? 0 : ownStart, dt: DT, playing, ended: index >= length, speed,
        parked: params.get('parked') === 'true', indexed: params.has('indexing') ? Math.round(length * .65) : length,
        reachable: params.has('indexing') ? Math.round(length * .65) : length, complete: !params.has('indexing'),
        markers: ownMarkers, ramps: visible ? ramps : ramps.map(ramp => ({...ramp, tone: 'muted'})), spots: spots.slice(), lastSpot,
        notice: notice && (params.has('notice') || performance.now() - noticeAt < 4000) ? notice : '', run};
    },
    play() { if (index >= length) index = ownStart - 66; playing = true; },
    pause() { playing = false; },
    toggle() { if (playing) this.pause(); else this.play(); },
    seek(value) { index = Math.min(clamp(value), params.has('indexing') ? Math.round(length * .65) : length); },
    skip(seconds) { index = clamp(index + seconds / DT); },
    step(ticks) { playing = false; index = clamp(index + ticks); },
    setSpeed(value) { if (SPEEDS.includes(value)) speed = value; },
    faster() { speed = SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)]; },
    slower() { speed = SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)]; },
    saveSpot() {
      const at = Math.round(index);
      if (!spots.includes(at)) {
        if (spots.length >= MAX_SPOTS) { say(NOTICES.full); return false; }
        spots = [...spots, at].sort((a, b) => a - b);
      }
      say(`Saved location #${spots.indexOf(at) + 1} · ${((at - ownStart) * DT).toFixed(3)} s.`);
      lastSpot = at;
      return true;
    },
    goToSpot(target = lastSpot ?? spots.at(-1)) { if (target == null) return false; lastSpot = target; index = target; return true; },
    cycleSpot(delta) {
      if (!spots.length) return false;
      const at = spots.indexOf(lastSpot);
      return this.goToSpot(spots[at < 0 ? (delta > 0 ? 0 : spots.length - 1) : (at + delta + spots.length) % spots.length]);
    },
    removeSpot(target) { spots = spots.filter(spot => spot !== target); if (lastSpot === target) lastSpot = null; },
    exit() { closed = true; },
    returnToServer() { closed = true; },
  };
}
