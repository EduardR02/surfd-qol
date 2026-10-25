// Mounts the real HUD (src/hud.js + src/hud-model.js) with fixture inputs
// over a real gameplay backdrop. Everything is chosen by URL parameters:
//   ?state=ramp&bg=snow&scale=1&y=82&palette=custom&panel=feedback&shot
//   set.<settingKey>=<value> overrides any setting.
// Only the game and the reference loaders are faked; model, view, fast path
// and settings panel are the shipping code.
import {mountHud} from '../src/hud.js';
import {createHudModel} from '../src/hud-model.js';
import {applySettings, defaults, colorKeys} from '../src/settings.js';
import {NOW, createHistory, createReplays, createReplayControl, createRampReference, createBinds} from './fixtures.js';

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

// Run history, replays, playback and ramp references in the shapes the UI is
// given (dev/fixtures.js). The watching state reads ?play, ?locs, ?notice,
// ?title, ?speed, ?at and ?binds; the Runs panel's Ramps view reads ?ref.

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
// ?runs opens the Runs panel on the current map, ?runs=<map key> on another;
// ?maps opens its map list; ?history=empty has no runs at all.
const runsMap = params.get('runs');
const emptyHistory = params.get('history') === 'empty';
const history = createHistory({settings, empty: emptyHistory});
const replays = createReplays({empty: emptyHistory});
const replayControl = createReplayControl({params, active: () => scenario.watching === true});
const rampReference = createRampReference({params, settings});
const binds = createBinds(params);
const inMenu = scenario.menu || panelPage !== null || (runsMap !== null && !scenario.watching);
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
  // Only the saveloc binds; every service that would use the game is faked below.
  getAdapter: () => ({getBindings: () => binds}),
  settings,
  onSettings: patch => applySettings(settings, patch),
  onResetColors: () => applySettings(settings, Object.fromEntries(colorKeys.map(key => [key, defaults[key]]))),
  history,
  replays,
  replayControl,
  rampReference,
  bindings: {release() {}, setKey: code => !['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(code), status: () => 'Crouch-jump ready on Space'},
  services: {
    replayStore: {destroy() {}},
    references: {update: () => scenario.refs ?? null, destroy() {}},
    runReferences: {update: () => runRefs, destroy() {}},
    // A frozen clock keeps checkpoint splits on screen for screenshots.
    createModel: () => createHudModel(() => 0),
    // Run dates are shown against a fixed day.
    now: () => NOW,
  },
});
if (panelPage !== null) hud.showSettings(panelPage || 'display');
// With ?state=watching: ?pop=keys|speed opens that popover; ?runs opens the Runs panel over the bar.
if (params.has('pop')) setTimeout(() => hud.showReplayPopover(params.get('pop')), 50);
if (runsMap !== null && scenario.watching) setTimeout(() => hud.showReplayRuns(), 50);
else if (runsMap !== null) hud.showRuns(runsMap || undefined, {maps: params.has('maps'), view: params.get('view') ?? 'runs'});

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
