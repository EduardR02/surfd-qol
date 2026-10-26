import { describe, expect, test } from 'bun:test';
import { buildFeedback, buildMeter, createHudModel } from '../src/hud-model.js';
import { defaults } from '../src/settings.js';

const surf = { available: true, tick: 40, loss: 30, downLoss: 18, upLoss: 12 };
const air = { available: true, tick: 20, loss: 9, brakingLoss: 4, missedGain: 5 };
const board = { available: true, tick: 30, loss: 3 };
const metrics = { air, surf, board, strafe: { mode: 'air' } };
const settings = patch => ({ ...defaults, surfColorReference: 'fixed', ...patch });

describe('HUD feedback slots', () => {
  test('after a ramp: Down in the shared slot, Board and Up of the same ramp', () => {
    const feedback = buildFeedback(metrics, null, settings());
    expect(feedback.result).toMatchObject({ hidden: false, label: 'DOWN', text: '−18.0', value: 18 });
    expect(feedback.board).toMatchObject({ hidden: false, label: 'BOARD', text: '−3.0' });
    expect(feedback.up).toMatchObject({ hidden: false, label: 'UP', text: '−12.0', stale: false });
    expect(feedback.result.value + feedback.up.value).toBe(surf.loss);
  });

  test('a newer flight takes the shared slot and marks Up stale', () => {
    const feedback = buildFeedback({ ...metrics, air: { ...air, tick: 50 } }, null, settings());
    expect(feedback.result).toMatchObject({ label: 'AIR', text: '−9.0' });
    expect(feedback.up.stale).toBe(true);
    expect(buildFeedback({ ...metrics, air: { ...air, tick: 50 } }, null, settings({ airMetric: 'missed' })).result)
      .toMatchObject({ label: 'MISSED', text: '−5.0' });
  });

  test('net mode keeps the single Surf slot and hides Up', () => {
    const feedback = buildFeedback(metrics, null, settings({ rampResult: 'total' }));
    expect(feedback.result).toMatchObject({ label: 'SURF', text: '−30.0' });
    expect(feedback.up.hidden).toBe(true);
  });

  test('each value hides independently and never borrows a hidden metric', () => {
    const boardOnly = buildFeedback(metrics, null, settings({ showAir: false, showSurf: false }));
    expect([boardOnly.result.hidden, boardOnly.board.hidden, boardOnly.up.hidden]).toEqual([true, false, true]);
    const rampOnly = buildFeedback({ ...metrics, air: { ...air, tick: 99 } }, null, settings({ showAir: false, showBoard: false }));
    expect(rampOnly.result.label).toBe('DOWN');
    expect(rampOnly.up.stale).toBe(false);
    const none = buildFeedback(metrics, null, settings({ showAir: false, showSurf: false, showBoard: false }));
    expect(none.hidden).toBe(true);
    const unavailable = buildFeedback({ ...metrics, surf: { ...surf, available: false, downLoss: null, upLoss: null } }, null, settings());
    expect([unavailable.result.text, unavailable.up.text, unavailable.result.tone]).toEqual(['—', '—', 'muted']);
  });

  test('Down and Up grade against their own matched PB/WR phase; fixed cutoffs otherwise', () => {
    const runRefs = { down: { status: 'ready', loss: 18.05 }, up: { status: 'ready', loss: 9 }, board: { status: 'loading' } };
    const feedback = buildFeedback(metrics, runRefs, settings({ surfColorReference: 'wr', boardColorReference: 'pb' }));
    expect(feedback.result.tone).toBe('good');
    expect(feedback.up.tone).toBe('loss');
    expect(feedback.board.tone).toBe('muted');
    const fixed = buildFeedback(metrics, null, settings());
    expect([fixed.result.tone, fixed.up.tone, fixed.board.tone]).toEqual(['warn', 'warn', 'good']);
  });

  test('live mode shows Strafe/Input and Clip, never a held Up', () => {
    const live = { ...metrics, strafe: { mode: 'surf', available: true, loss: 0.2 }, ramp: { available: true, kind: 'turn', loss: 7 } };
    const feedback = buildFeedback(live, null, settings({ continuousFeedback: true }));
    expect(feedback.result).toMatchObject({ label: 'INPUT', text: '−0.2', tone: 'good' });
    expect(feedback.board).toMatchObject({ label: 'CLIP', text: '−7.0' });
    expect(feedback.up.hidden).toBe(true);
  });
});

describe('HUD model', () => {
  test('spectating hides coaching rows and sync but keeps checkpoint progress', () => {
    let now = 0;
    const build = createHudModel(() => now);
    const view = { target: {}, view: { pose: { checkpoints: 2, phase: 'running', stage: 0 }, detailed: true, player: { name: 'KSF' } } };
    const model = build({ snapshot: {}, view, settings: settings() });
    expect(model.feedback.hidden).toBe(true);
    expect(model.sync.hidden).toBe(true);
    expect(model.runState.text).toBe('SPECTATING · KSF');
    expect(model.checkpoint).toMatchObject({ hidden: false, label: 'CP 2' });
    now = 7000;
    expect(build({ snapshot: {}, view, settings: settings() }).checkpoint.hidden).toBe(true);
  });

  test('zen keeps replay hull state while hiding run feedback', () => {
    const build = createHudModel(() => 0);
    const session = { timer: { state: { phase: 'running', splits: [12.5] } }, checkpointSpeeds: [1500], map: {}, state: { ducked: true } };
    const start = { available: true, speed: 349, speedDelta: -1, heightAboveFloor: 4, age: 100 };
    const model = build({ snapshot: { playback: true, strafeSync: { percentage: 90 } }, session, metrics: { ...metrics, start }, settings: settings({ zen: true }) });
    expect(model).toMatchObject({ zen: true, clock: { hidden: true }, sync: { hidden: true }, feedback: { hidden: true },
      checkpoint: { hidden: true }, hull: { hidden: false, crouched: true }, start: { hidden: false } });
    expect(build({ snapshot: {}, session, metrics: { ...metrics, start }, settings: settings({ zen: true, showStart: false }) }).start.hidden).toBe(true);
    expect(build({ snapshot: {}, session, metrics: { ...metrics, start }, settings: settings({ surfHud: 'full' }) })).toMatchObject({ zen: false, layout: 'full', clock: { hidden: false } });
    session.state.ducked = false;
    expect(build({ snapshot: { playback: true }, session, settings: settings({ zen: true }) }).hull).toEqual({ hidden: false, crouched: false });
    expect(build({ snapshot: {}, session, settings: settings({ zen: true }) }).hull.hidden).toBe(true);
    expect(build({ snapshot: { playback: true }, session, inSurf: false, settings: settings({ zen: true }) }).hull.hidden).toBe(true);
  });

  test('ranked runs show no run label; practice and replays do', () => {
    const build = createHudModel(() => 0);
    const session = { timer: { state: { phase: 'running' } }, checkpointSpeeds: [] };
    expect(build({ snapshot: {}, session, settings: settings() }).runState.text).toBe('');
    expect(build({ snapshot: {}, session: { ...session, practice: true }, settings: settings() }).runState.text).toBe('PRACTICE');
    expect(build({ snapshot: { playback: true }, session, settings: settings() }).runState.text).toBe('REPLAY');
  });

  test('checkpoint splits show PB and WR deltas for time and speed', () => {
    const build = createHudModel(() => 0);
    const session = { timer: { state: { phase: 'running', splits: [12.5] } }, checkpointSpeeds: [1500], map: {} };
    const refs = { own: [1490], ownSplitsUs: [12_600_000], record: [1520], recordSplitsUs: [12_400_000], recordSource: 'ksf' };
    const { checkpoint } = build({ snapshot: {}, session, refs, settings: settings() });
    expect(checkpoint).toMatchObject({ hidden: false, label: 'CP1', time: '00:12.500', speed: '1500' });
    expect(checkpoint.pb).toMatchObject({ label: 'PB', time: { text: '−0.100', tone: 'good' }, speed: { text: '+10', tone: 'good' } });
    expect(checkpoint.wr).toMatchObject({ label: 'KSF', time: { text: '+0.100', tone: 'loss' }, speed: { text: '−20', tone: 'loss' } });
  });
});

test('motion reports ramp contact for the speed tint, and unknown while analysis is idle or spectating', () => {
  const build = createHudModel(() => 0);
  const session = { timer: { state: {} }, checkpointSpeeds: [] };
  expect(build({ snapshot: {}, session, metrics: { ...metrics, strafe: { mode: 'surf' }, active: true }, settings: settings() }).motion).toBe('surf');
  expect(build({ snapshot: {}, session, metrics: { ...metrics, active: true }, settings: settings() }).motion).toBe('air');
  expect(build({ snapshot: {}, session, metrics: { ...metrics, active: false }, settings: settings() }).motion).toBe(null);
  expect(build({ snapshot: {}, view: { target: {}, view: {} }, settings: settings() }).motion).toBe(null);
});

describe('ramp meter and layouts', () => {
  const runRefs = { board: { status: 'ready', loss: 3 }, surf: { status: 'ready', loss: 46.6 }, down: { status: 'ready', loss: 15.2 }, up: { status: 'ready', loss: 31.4 } };
  const ramp = { air: { ...air, tick: 20 }, board: { ...board, tick: 30 }, surf: { ...surf, tick: 40 } };
  const meterSettings = patch => settings({ boardColorReference: 'wr', surfColorReference: 'wr', ...patch });

  test('the last flight, then the finished ramp: board included in Down and Surf', () => {
    const meter = buildMeter(ramp, runRefs, meterSettings());
    expect(meter).toMatchObject({ hidden: false, fresh: false, split: true, reference: 46.6,
      air: { text: '−9.0' }, board: { text: '−3.0', tone: 'good' }, down: { text: '−18.0', stale: false }, up: { text: '−12.0' },
      surf: { text: '−30.0', tone: 'good' }, ramp: { text: '−30.0' } });
  });

  test('right after boarding, the ramp so far is its board and the last ramp is a ghost', () => {
    const meter = buildMeter({ ...ramp, board: { ...board, tick: 50 } }, runRefs, meterSettings());
    expect(meter).toMatchObject({ fresh: true, reference: 46.6, ramp: { text: '−3.0' }, surf: { stale: true }, down: { stale: true } });
  });

  test('hidden values drop out, and everything hidden hides the meter', () => {
    expect(buildMeter(ramp, runRefs, meterSettings({ showAir: false })).air).toBeNull();
    expect(buildMeter(ramp, runRefs, meterSettings({ showSurf: false }))).toMatchObject({ surf: null, down: null, ramp: { text: '−3.0' } });
    expect(buildMeter(ramp, runRefs, meterSettings({ showBoard: false, showSurf: false, showAir: false })).hidden).toBe(true);
  });

  test('a live run is compact: the deltas or the start replace the clock, sync joins the start', () => {
    const build = createHudModel(() => 0);
    const session = { timer: { state: { phase: 'running', splits: [12.5] } }, checkpointSpeeds: [1500], map: {} };
    const start = { available: true, speed: 349, speedDelta: -1, heightAboveFloor: 4, age: 100 };
    const live = build({ snapshot: { strafeSync: { percentage: 91.3 } }, session, metrics: { ...ramp, start }, settings: settings() });
    expect(live).toMatchObject({ layout: 'surf', clock: { hidden: true }, sync: { hidden: true }, start: { hidden: false },
      startSync: { hidden: false, text: '91.3%' }, meter: { hidden: false }, feedback: { hidden: true } });
    const replay = build({ snapshot: { playback: true, strafeSync: { percentage: 91.3 } }, session, metrics: { ...ramp, start }, settings: settings() });
    expect(replay).toMatchObject({ layout: 'full', clock: { hidden: false }, sync: { hidden: false }, startSync: { hidden: true } });
    // No timer in Compact unless asked; a run label still shows on its own.
    const quiet = { snapshot: {}, session: { timer: { state: { phase: 'running', splits: [] } }, checkpointSpeeds: [], map: {} }, metrics: ramp };
    expect(build({ ...quiet, settings: settings() })).toMatchObject({ clock: { hidden: true }, time: { hidden: true } });
    expect(build({ ...quiet, settings: settings({ compactTimer: true }) })).toMatchObject({ clock: { hidden: false }, time: { hidden: false } });
    expect(build({ ...quiet, session: { ...quiet.session, practice: true }, settings: settings() }))
      .toMatchObject({ clock: { hidden: false }, time: { hidden: true }, runState: { text: 'PRACTICE' } });
    expect(build({ ...quiet, settings: settings({ surfHud: 'full' }) }).time.hidden).toBe(false);
    const noSync = build({ snapshot: {}, session, metrics: { ...ramp, start }, settings: settings({ showSync: false }) });
    expect(noSync.startSync.hidden).toBe(true);
    // Live feedback keeps its own row instead of the meter.
    expect(build({ snapshot: {}, session, metrics: ramp, settings: settings({ continuousFeedback: true }) }).meter.hidden).toBe(true);
  });
});

describe('ramp meter geometry', () => {
  const item = (value, tone = 'good', stale = false) => ({ value, tone, stale });
  const meter = { split: true, fresh: false, reference: 40, air: item(5), board: item(5), down: item(20), up: item(30, 'loss'), surf: item(50, 'loss') };
  const end = segment => segment.left + segment.width;

  test('one width, centred: the flight and the ramp share it; the tick marks the reference ramp', async () => {
    const { meterLayout } = await import('../src/hud-view.js');
    // 55 u/s lost in all fills the 172 px bar; the reference ramp (40) would have ended at 45.
    const { segments, tick, left, width, airCenter, rampCenter } = meterLayout(meter, false);
    expect([left, width]).toEqual([-86, 172]);
    expect(segments.air.left).toBeCloseTo(-86, 6);
    expect(segments.board.left).toBeCloseTo(-86 + 5 / 55 * 172, 6);
    expect(end(segments.up)).toBeCloseTo(86, 6);
    expect(tick).toBeCloseTo(-86 + 45 / 55 * 172 - 1, 6);
    expect(airCenter).toBeCloseTo(-51.6, 6);
    expect(rampCenter).toBeCloseTo(51.6, 6);
    // Beating the reference: your parts end early, and the tick sits at the bar's end.
    const better = meterLayout({ ...meter, reference: 80 }, false);
    expect(end(better.segments.up)).toBeCloseTo(-86 + 55 / 85 * 172, 6);
    expect(better.tick).toBeCloseTo(85, 6);
  });

  test('right after boarding: the flight and the board so far, no tick; without a reference, no tick', async () => {
    const { meterLayout } = await import('../src/hud-view.js');
    const fresh = meterLayout({ ...meter, fresh: true }, false);
    expect(fresh.tick).toBeNull();
    expect(fresh.segments.down).toBeUndefined();
    expect(end(fresh.segments.board)).toBeCloseTo(-86 + 10 / 50 * 172, 6);
    const fixed = meterLayout({ ...meter, reference: null }, false);
    expect(fixed.tick).toBeNull();
    expect(end(fixed.segments.up)).toBeCloseTo(86, 6);
    // Only one value under the bar: it centres.
    expect(meterLayout({ ...meter, air: null }, false).rampCenter).toBe(0);
  });
});
