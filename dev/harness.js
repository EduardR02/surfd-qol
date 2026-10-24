// Mounts the real HUD (src/hud.js + src/hud-model.js) with fixture inputs
// over a real gameplay backdrop. Everything is chosen by URL parameters:
//   ?state=ramp&bg=snow&scale=1&y=82&palette=custom&panel=feedback&shot
//   set.<settingKey>=<value> overrides any setting.
// Only the game and the reference loaders are faked; model, view, fast path
// and settings panel are the shipping code.
import {mountHud} from '../src/hud.js';
import {createHudModel} from '../src/hud-model.js';
import {applySettings, defaults, colorKeys} from '../src/settings.js';

const params = new URLSearchParams(location.search);
const DT = 0.015, GRAVITY = 800;

// Held results of one ramp: Board 3.2, Down 14.6, Up 38.1 (Surf 52.7), then a flight.
const ramp = {
  metrics: {
    air: {available: true, tick: 10, loss: 9.8, brakingLoss: 4.1, missedGain: 5.7},
    surf: {available: true, tick: 20, loss: 52.7, downLoss: 14.6, upLoss: 38.1},
    board: {available: true, tick: 19, loss: 3.2},
    strafe: {mode: 'air'},
  },
};
const runRefs = {
  board: {status: 'ready', loss: 2.4}, surf: {status: 'ready', loss: 44.0},
  down: {status: 'ready', loss: 13.5}, up: {status: 'ready', loss: 30.0}, start: {status: 'ready', speed: 349, heightAboveFloor: 4.0},
};
const landed = {metrics: {...ramp.metrics, air: {available: true, tick: 30, loss: 4.2, brakingLoss: 1.6, missedGain: 2.6}, board: {available: true, tick: 29, loss: 11.4}}};
const checkpoint = {
  session: {checkpointSpeeds: [2412, 2950]}, splits: [10.12, 21.233],
  refs: {own: [2400, 2912], record: [2450, 3070], ownSplitsUs: [10200000, 21447000], recordSplitsUs: [10000000, 20131000], recordSource: 'ksf', ownStatus: 'ready', recordStatus: 'ready'},
};

export const scenarios = {
  ramp: {note: 'After a ramp: Board, Down, Up of the same ramp', ...ramp},
  air: {note: 'Landed: Air in the shared slot, Board of the new ramp, Up stale', ...landed},
  net: {note: 'Net mode: one Surf value', ...ramp, settings: {rampResult: 'total'}},
  sole: {note: 'Only Air enabled: a sole slot centres', ...landed, settings: {showBoard: false, showSurf: false}},
  pair: {note: 'Board + Ramp, Air off', ...ramp, settings: {showAir: false}},
  none: {note: 'All feedback hidden', ...ramp, settings: {showBoard: false, showAir: false, showSurf: false}},
  unavailable: {note: 'Nothing measured yet', metrics: {strafe: {mode: 'air'}}},
  live: {note: 'Live feedback: Strafe + Clip', metrics: {strafe: {mode: 'air', available: true, loss: 0.4}, ramp: {available: true, loss: 7.2, kind: 'turn'}}, settings: {continuousFeedback: true}},
  'start-good': {note: 'Start flash, good', ...ramp, metrics: {...ramp.metrics, start: {available: true, speed: 348, speedDelta: -2, targetSpeed: 350, heightAboveFloor: 5.1, age: 0}}, elapsed: 0.412, speed: 348},
  'start-bad': {note: 'Start flash, bad', ...ramp, metrics: {...ramp.metrics, start: {available: true, speed: 331, speedDelta: -19, targetSpeed: 350, heightAboveFloor: 18.2, age: 0}}, elapsed: 0.452, speed: 331},
  checkpoint: {note: 'Checkpoint with PB and KSF', ...ramp, ...checkpoint, elapsed: 21.91},
  'checkpoint-start': {note: 'Checkpoint and start flash together', ...checkpoint, metrics: {...ramp.metrics, start: {available: true, speed: 348, speedDelta: -2, targetSpeed: 350, heightAboveFloor: 5.1, age: 0}}},
  practice: {note: 'Practice run', ...ramp, session: {practice: true}},
  replay: {note: 'Replay', ...ramp, snapshot: {playback: true}},
  invalid: {note: 'Invalid run', ...ramp, timer: {invalidReason: 'Teleported'}},
  spectating: {note: 'Spectating another player', spectate: true},
  'energy-good': {note: 'Speed tint: gaining', ...ramp, energy: 1, settings: {speedEnergyColor: true}},
  'energy-loss': {note: 'Speed tint: losing', ...ramp, energy: -1, settings: {speedEnergyColor: true}},
  'energy-neutral': {note: 'Speed tint: neutral', ...ramp, energy: 0, settings: {speedEnergyColor: true}},
  menu: {note: 'In a menu (settings entry point)', ...ramp, menu: true},
  watching: {note: 'Watching a saved run with replay controls', ...ramp, ...checkpoint, snapshot: {playback: true}, watching: true},
};

// A session of runs on two maps for the Runs popup (?runs=session|map).
function fixtureRuns() {
  const session = 1, at = Date.parse('2026-10-24T19:00:00');
  const ramps = (n, seed) => Array.from({length: n}, (_, i) => ({checkpoint: Math.floor(i / 2), board: [3.2, 11.4, 0.8, 6.1][(i + seed) % 4],
    down: [14.6, 22.0, 9.4, 18.3][(i + seed) % 4], up: [38.1, 16.2, 24.9, 30.5][(i + seed) % 4], exit: 2380 + 140 * i}));
  const run = (index, map, mapName, time, outcome, splits, extra = {}) => {
    const list = ramps(splits.length * 2 + (outcome === 'finished' ? 1 : 0), index);
    const sum = key => list.reduce((total, ramp) => total + ramp[key], 0);
    return {id: `fixture-${index}`, session: extra.session ?? session, map, mapName, at: at + index * 95000, kind: 'CP', outcome, practice: false, invalid: '', time,
      start: {speed: [348.4, 342.1, 349.6, 331.8, 347.2][index % 5], height: [4.2, 9.8, 2.6, 18.4, 5.5][index % 5]},
      topSpeed: 3020 + 37 * index, sync: [93.4, 89.1, 95.2, 84.6, 92.0][index % 5],
      checkpoints: splits.map((split, i) => ({split, speed: 2410 + 260 * i - 7 * index})), ramps: list,
      board: {total: Number(sum('board').toFixed(1)), count: list.length},
      surf: {down: Number(sum('down').toFixed(1)), up: Number(sum('up').toFixed(1)), loss: Number((sum('down') + sum('up')).toFixed(1)), count: list.length, unavailable: 0},
      air: {loss: 31.4 + index, braking: 12.2, missed: 19.2 + index, seconds: 9.5, count: list.length}, ...extra};
  };
  return [
    run(0, 'boreas:2', 'Boreas', 64.912, 'finished', [21.404, 43.118], {session: 0}),
    run(1, 'utopia:3', 'Utopia', 43.551, 'finished', [10.31, 21.62]),
    run(2, 'utopia:3', 'Utopia', 12.874, 'reset', [10.48]),
    run(3, 'utopia:3', 'Utopia', 41.233, 'finished', [10.12, 21.233]),
    run(4, 'utopia:3', 'Utopia', 6.02, 'reset', []),
    run(5, 'utopia:3', 'Utopia', 42.807, 'finished', [10.2, 21.49], {practice: true}),
    run(6, 'utopia:3', 'Utopia', 42.016, 'finished', [10.15, 21.38]),
  ];
}
const runsFixture = fixtureRuns();
const history = {session: 1, currentMap: 'utopia:3', runs: () => runsFixture, subscribe: () => () => {}, clear() {},
  usage: () => ({bytes: 9800, runs: runsFixture.length, maps: 2})};
const replays = {usage: () => ({bytes: 1.6 * 1024 * 1024, count: 6}), subscribe: () => () => {}, clearMap: async () => {}};
// Replay controls over a fixture run: the controls work, only the game behind them is still.
const replayControl = (() => {
  const run = runsFixture[6], length = 2870, start = 66;
  let index = 1480, playing = true, speed = 1, spots = [430, 1120], lastSpot = 1120;
  const clamp = value => Math.max(0, Math.min(length, Math.round(value)));
  return {
    canWatch: entry => entry.id !== 'fixture-4',
    async watch() {},
    get active() { return scenario.watching === true; },
    status: () => scenario.watching ? {title: `Your run on ${run.mapName} · finished in 00:42.016`, index, length, start, dt: DT, playing, ended: index >= length, speed, markers: [742, 1488], spots, lastSpot, practice: 'ok', notice: ''} : null,
    play() { playing = true; }, pause() { playing = false; }, toggle() { playing = !playing; },
    seek(value) { index = clamp(value); },
    skip(seconds) { index = clamp(index + seconds / DT); },
    step(ticks) { playing = false; index = clamp(index + ticks); },
    setSpeed(value) { speed = value; },
    saveSpot() { if (!spots.includes(index)) spots = [...spots, index].sort((a, b) => a - b); lastSpot = index; return true; },
    goToSpot(tick) { const target = tick ?? lastSpot ?? spots.at(-1); if (target == null) return false; lastSpot = target; index = target; return true; },
    async practiceFromHere() {},
    removeSpot(tick) { spots = spots.filter(spot => spot !== tick); if (lastSpot === tick) lastSpot = null; },
    faster() { speed = Math.min(4, speed * 2); }, slower() { speed = Math.max(0.25, speed / 2); },
  };
})();

const palettes = {custom: {speedColor: '#f4f1ea', goodColor: '#6fe0b0', warnColor: '#ffcf5c', badColor: '#ff5f6d'}};
const backdrops = ['snow', 'fog', 'ice', 'neon', 'warm', 'dark', 'menu'];

const name = params.get('state') ?? 'ramp';
const scenario = scenarios[name] ?? scenarios.ramp;
const settings = {...defaults};
applySettings(settings, {...scenario.settings, ...palettes[params.get('palette')]});
for (const [key, value] of params) {
  const field = key.startsWith('set.') ? key.slice(4) : ['scale', 'y', 'opacity'].includes(key) ? key : null;
  if (!field || !(field in defaults)) continue;
  applySettings(settings, {[field]: typeof defaults[field] === 'number' ? Number(value) : typeof defaults[field] === 'boolean' ? value === 'true' : value});
}
const panelPage = params.get('panel');
const runsScope = params.get('runs');
const inMenu = scenario.menu || panelPage !== null || runsScope !== null;
const bg = params.get('bg') ?? (inMenu ? 'menu' : 'snow');
// Backdrops are local game screenshots (gitignored); a neutral sky stands in when one is missing.
document.body.style.backgroundImage = `url(./backdrops/${bg}.jpg), linear-gradient(#1b2430, #4a566a 55%, #b8a09c)`;
if (params.has('shot')) document.body.classList.add('shot');

// A moving local session: the energy scenarios gain or lose 140 u/s per
// second at constant height so the real energy trend reacts.
const started = performance.now();
const baseSpeed = scenario.speed ?? 2950;
const session = {
  practice: false, ...scenario.session,
  config: {dt: DT, gravity: GRAVITY},
  map: {stages: []},
  get state() {
    const seconds = (performance.now() - started) / 1000;
    const speed = scenario.energy ? baseSpeed + scenario.energy * 140 * (seconds % 4) : baseSpeed;
    return {position: {x: speed * seconds, y: 0, z: 512}, velocity: {x: speed, y: 0, z: 0}, tick: Math.floor(seconds / DT), ducked: false};
  },
  timer: {state: {elapsed: scenario.elapsed ?? 72.483, phase: 'running', splits: scenario.splits ?? [], ...scenario.timer}},
};
const snapshot = () => ({active: !inMenu, playback: false, ...scenario.snapshot, state: session.state, run: session.timer.state, strafeSync: {percentage: 96.4}});
const spectatorView = {target: 7, view: {player: {name: 'GPT-7-Nebula'}, detailed: true, stale: false,
  pose: {vx: 2104, vy: 980, vz: 0, x: 0, y: 0, z: 0, seconds: 48.215, checkpoints: 2, stage: 0, phase: 'running'}}};

const hud = mountHud({
  getState: snapshot,
  getView: () => scenario.spectate ? spectatorView : null,
  getMetrics: () => ({active: true, status: '', ...scenario.metrics}),
  getSession: () => scenario.spectate ? null : session,
  getReferences: () => null,
  getAdapter: () => null,
  settings,
  onSettings: patch => applySettings(settings, patch),
  onResetColors: () => applySettings(settings, Object.fromEntries(colorKeys.map(key => [key, defaults[key]]))),
  history,
  replays,
  replayControl,
  bindings: {release() {}, setKey: code => !['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(code), status: () => 'Crouch-jump ready on Space'},
  services: {
    replayStore: {destroy() {}},
    references: {update: () => scenario.refs ?? null, destroy() {}},
    runReferences: {update: () => runRefs, destroy() {}},
    // A frozen clock keeps checkpoint splits on screen for screenshots.
    createModel: () => createHudModel(() => 0),
  },
});
if (panelPage !== null) hud.showSettings(panelPage || 'display');
if (params.has('keys')) hud.showReplayKeys();
if (runsScope !== null) {
  hud.showRuns(runsScope || 'session');
  // ?expand=<run id> opens that run's splits and ramps.
  if (params.has('expand')) document.getElementById('surfd-qol').shadowRoot.querySelector(`tr.run[data-run="${params.get('expand')}"]`)?.click();
}

// Small picker for manual browsing; hidden in screenshot mode.
const picker = document.getElementById('picker');
const select = (label, options, current, key) => {
  const element = document.createElement('select');
  element.ariaLabel = label;
  for (const option of options) element.add(new Option(option, option, false, option === current));
  element.onchange = () => { params.set(key, element.value); location.search = params; };
  picker.append(element);
};
select('Scenario', Object.keys(scenarios), name, 'state');
select('Backdrop', backdrops, bg, 'bg');
window.__harness = {hud, settings, scenario: name, note: scenario.note};

// Design experiments: ?css=<rules> is appended to the HUD's shadow root.
if (params.has('css')) {
  const style = document.createElement('style');
  style.textContent = params.get('css');
  document.getElementById('surfd-qol').shadowRoot.append(style);
}
