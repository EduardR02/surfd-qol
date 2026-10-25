import { describe, expect, test } from 'bun:test';
import { bindAction, createWheelGate, keyRows, markTip, pointerCode, railTime, timelineMarks } from '../src/replay-bar.js';
import { savelocBinds } from '../src/key-names.js';
import {createReplayBindRouter} from '../src/native-replay-ui.js';

const status = {
  title: 'Your run on Utopia · finished in 00:41.233', index: 1590, length: 3082, start: 333, dt: 0.015,
  markers: [1008, 1748, 2391],
  ramps: [{tick: 600, label: 'Ramp 1', board: 5.9, tone: 'loss'}, {tick: 900, label: 'Ramp 2', board: null, tone: 'muted'}, {tick: 1200, label: 'Ramp 3', board: 1.2, tone: 'odd'}],
  spots: [500, 2000], lastSpot: 2000,
};

describe('replay bar', () => {
  test('run time runs negative before the start and never shows −0', () => {
    expect(railTime(12.41)).toBe('00:12.410');
    expect(railTime(0)).toBe('00:00.000');
    expect(railTime(-0.0002)).toBe('00:00.000');
    expect(railTime(-1.25)).toBe('−00:01.250');
    expect(railTime(NaN)).toBe('—');
  });

  test('the timeline carries the start, checkpoints, graded ramp boards and locs', () => {
    const marks = timelineMarks(status);
    expect(marks.filter(mark => mark.type === 'start').map(mark => mark.label)).toEqual(['Start']);
    expect(marks.filter(mark => mark.type === 'cp').map(mark => mark.label)).toEqual(['CP1', 'CP2', 'CP3']);
    // Unknown tones fall back to muted rather than an unstyled mark.
    expect(marks.filter(mark => mark.type === 'ramp').map(mark => mark.tone)).toEqual(['loss', 'muted', 'muted']);
    expect(marks.filter(mark => mark.type === 'loc').map(mark => [mark.label, mark.selected])).toEqual([['Loc 1', false], ['Loc 2', true]]);
    expect(marks.find(mark => mark.type === 'cp').at).toBeCloseTo(1008 / 3082, 6);
    // No start yet (someone else's replay before the background pass): no start mark.
    expect(timelineMarks({...status, start: 0}).some(mark => mark.type === 'start')).toBe(false);
    expect(timelineMarks(status, 'S').filter(mark => mark.type === 'cp')[0].label).toBe('Stage 2');
  });

  test('hovering a mark says what it is, the way the HUD would', () => {
    const marks = timelineMarks(status);
    expect(markTip(marks.find(mark => mark.label === 'Ramp 1'), status)).toEqual({title: 'Ramp 1', value: '−5.9', label: 'board', tone: 'loss'});
    expect(markTip(marks.find(mark => mark.label === 'Ramp 2'), status)).toMatchObject({value: '—', tone: 'muted'});
    expect(markTip(marks.find(mark => mark.label === 'CP1'), status)).toMatchObject({title: 'CP1', value: '00:10.125'});
    expect(markTip(marks.find(mark => mark.label === 'Loc 2'), status)).toMatchObject({title: 'Loc 2', tone: 'loc', label: 'right-click removes'});
    expect(markTip(null, {...status, hover: 333 - 100})).toMatchObject({title: '', value: '−00:01.500'});
  });

  test('the keyboard sheet lists every key bound to each saveloc action, and leaves unbound ones out', () => {
    const rows = keyRows(savelocBinds({save: ['F5', 'Mouse2'], load: ['F9'], previousSave: [], nextSave: ['WheelDown']}));
    const text = Object.fromEntries(rows.map(([keys, label]) => [label, keys]));
    expect(text['Save a loc']).toBe('F5 / Mouse 2');
    expect(text['Go to the selected loc']).toBe('F9');
    expect(text['Next loc']).toBe('Wheel Down');
    expect('Previous loc' in text).toBe(false);
    expect(text['Play or pause']).toBe('Space');
    expect(keyRows(savelocBinds(null)).find(([, label]) => label === 'Save a loc')[0]).toBe('F5');
  });

  test('loc actions follow the game binds, with its defaults when it has none', () => {
    const defaults = savelocBinds(null);
    expect(bindAction(defaults, 'F5')).toBe('save');
    expect(bindAction(defaults, 'F9')).toBe('load');
    expect(bindAction(defaults, 'KeyQ')).toBeNull();
    const custom = savelocBinds({save: ['Mouse4'], load: ['KeyE'], previousSave: ['WheelUp'], nextSave: ['WheelDown'], jump: ['Space']});
    expect(bindAction(custom, 'F5')).toBeNull();
    expect(bindAction(custom, 'Mouse4')).toBe('save');
    expect(bindAction(custom, 'WheelUp')).toBe('previousSave');
    expect(bindAction(custom, 'WheelDown')).toBe('nextSave');
    expect(bindAction(custom, 'Space')).toBeNull();
    expect(bindAction(custom, null)).toBeNull();
  });

  test('mouse buttons and wheel notches map to bind codes', () => {
    expect(pointerCode({type: 'mousedown', button: 3})).toBe('Mouse3');
    expect(pointerCode({type: 'wheel', deltaY: -120})).toBe('WheelUp');
    expect(pointerCode({type: 'wheel', deltaY: 53})).toBe('WheelDown');
    expect(pointerCode({type: 'wheel', deltaY: 0})).toBeNull();
  });

  test('one wheel notch, several events, one action', () => {
    const gate = createWheelGate(150);
    expect([0, 16, 32, 48].map(gate)).toEqual([true, false, false, false]);
    expect(gate(300)).toBe(true);
    expect(gate(320)).toBe(false);
  });

  test('a native finish before the recorded command tail excludes later marks instead of stacking them at the end', () => {
    const marks = timelineMarks({...status, length: 1008});
    expect(marks.filter(mark => mark.type === 'cp').map(mark => mark.tick)).toEqual([1008]);
    expect(marks.filter(mark => mark.type === 'ramp').map(mark => mark.tick)).toEqual([600, 900]);
    expect(marks.filter(mark => mark.type === 'loc').map(mark => mark.tick)).toEqual([500]);
    expect(marks.find(mark => mark.type === 'cp').at).toBe(1);
    expect(timelineMarks({...status, length: 0})).toEqual([]);
  });

  const input = (type, values = {}) => ({
    type, defaultPrevented: false, stopped: false, ...values,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  });

  test('native playback shortcuts pass through while configured loc binds consume down, repeat and up only once', () => {
    const route = createReplayBindRouter();
    const binds = savelocBinds(null);
    for (const code of ['Space', 'KeyK', 'ArrowLeft', 'ArrowRight', 'KeyJ', 'KeyL', 'Comma', 'Period', 'BracketLeft', 'BracketRight', 'PageUp', 'PageDown', 'Home', 'End', 'Digit5']) {
      const event = input('keydown', {code});
      expect(route(event, binds)).toBeNull();
      expect(event.defaultPrevented).toBe(false);
      expect(event.stopped).toBe(false);
    }
    const first = input('keydown', {code: 'F5'});
    expect(route(first, binds)).toBe('save');
    expect(first.defaultPrevented && first.stopped).toBe(true);
    for (const event of [input('keydown', {code: 'F5', repeat: true}), input('keyup', {code: 'F5'})]) {
      expect(route(event, binds)).toBeNull();
      expect(event.defaultPrevented && event.stopped).toBe(true);
    }
  });

  test('the shared loc router follows live rebinding, ignores modified/claimed input and gates wheel bursts', () => {
    let time = 0;
    const route = createReplayBindRouter(() => time);
    const defaults = savelocBinds(null);
    const custom = savelocBinds({save: ['Mouse4'], load: ['KeyE'], previousSave: ['WheelUp'], nextSave: ['WheelDown']});
    expect(route(input('keydown', {code: 'F5'}), defaults)).toBe('save');
    expect(route(input('keydown', {code: 'F5'}), custom)).toBeNull();
    expect(route(input('keydown', {code: 'KeyE'}), custom)).toBe('load');
    const modified = input('keydown', {code: 'KeyE', ctrlKey: true});
    expect(route(modified, custom)).toBeNull();
    expect(modified.stopped).toBe(false);
    expect(route(input('keydown', {code: 'KeyE', defaultPrevented: true}), custom)).toBeNull();
    expect(route(input('mousedown', {button: 4}), custom)).toBe('save');
    const up = input('mouseup', {button: 4});
    expect(route(up, custom)).toBeNull();
    expect(up.stopped).toBe(true);
    expect(route(input('wheel', {deltaY: -100}), custom)).toBe('previousSave');
    time = 40;
    const repeated = input('wheel', {deltaY: -30});
    expect(route(repeated, custom)).toBeNull();
    expect(repeated.stopped).toBe(true);
    time = 220;
    expect(route(input('wheel', {deltaY: 100}), custom)).toBe('nextSave');
  });
});
