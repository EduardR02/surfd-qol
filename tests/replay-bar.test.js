import { describe, expect, test } from 'bun:test';
import { bindAction, createReplayBar, createWheelGate, keyRows, markTip, pointerCode, railTime, timelineMarks } from '../src/replay-bar.js';
import { savelocBinds } from '../src/key-names.js';
import {createReplayBindRouter} from '../src/native-replay-ui.js';

const status = {
  title: 'Your run on Utopia · finished in 00:41.233', index: 1590, length: 3082, start: 333, dt: 0.015,
  markers: [1008, 1748, 2391],
  ramps: [{tick: 600, label: 'Ramp 1', board: 5.9, tone: 'loss'}, {tick: 900, label: 'Ramp 2', board: null, tone: 'muted'}, {tick: 1200, label: 'Ramp 3', board: 1.2, tone: 'odd'}],
  spots: [500, 2000], lastSpot: 2000,
};

// Small owned-DOM fixture: records annotation replacements and retains child
// identities, so a stable frame cannot pass by rebuilding equal markup.
function barFixture() {
  class Node {
    children = []; dataset = {}; style = {}; attributes = {}; listeners = {};
    hidden = false; title = ''; textContent = ''; html = ''; writes = 0;
    clientWidth = 800; offsetHeight = 46;
    classes = new Set();
    classList = {
      contains: name => this.classes.has(name),
      toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
      add: name => this.classes.add(name), remove: name => this.classes.delete(name),
    };
    addEventListener(type, fn) { this.listeners[type] = fn; }
    removeEventListener(type) { delete this.listeners[type]; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    contains(node) { return this.children.includes(node); }
    getBoundingClientRect() { return {left: 0, width: this.clientWidth}; }
    get firstElementChild() { return this.children[0]; }
    set innerHTML(value) {
      this.html = value; this.writes++;
      this.children = [];
      if (this === nodes['.rb-track']) {
        this.children = [...value.matchAll(/<span /g)].map(() => {
          const section = new Node(); section.children = [new Node()]; return section;
        });
      } else if (this === nodes['.rb-pins']) {
        this.children = [...value.matchAll(/<button [^>]*aria-label="([^"]*)"[^>]*>/g)].map(match => {
          const pin = new Node(); pin.setAttribute('aria-label', match[1]); return pin;
        });
      }
    }
    get innerHTML() { return this.html; }
  }
  const nodes = Object.fromEntries(['.rb-play', '.rb-rail', '.rb-track', '.rb-headway', '.rb-marks', '.rb-pins', '.rb-tip',
    '[data-rb="total"]', '[data-rb="notice"]', '.rb-speed', '.rb-runs', '[data-act="save"]', '.rb-indexed', '[data-act="return"]'].map(selector => [selector, new Node()]));
  nodes['.rb-tip'].children = [new Node(), new Node(), new Node()];
  const keys = new Node(), speed = new Node(), keysOpener = new Node();
  keys.dataset.popover = 'keys'; speed.dataset.popover = 'speed';
  keysOpener.dataset.pop = 'keys'; nodes['.rb-speed'].dataset.pop = 'speed';
  const bar = new Node();
  bar.hidden = true;
  bar.querySelector = selector => nodes[selector] ?? null;
  bar.querySelectorAll = selector => selector === '[data-popover]' ? [keys, speed] : [keysOpener, nodes['.rb-speed']];
  const root = {getElementById: () => bar, activeElement: null};
  let value = {...status, playing: true, ended: false, speed: 1, complete: true}, kind = 'CP', resize;
  let id = 0;
  const frames = new Map();
  const globals = Object.fromEntries(['window', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.assign(globalThis, {
    window: new Node(),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; },
    cancelAnimationFrame: key => frames.delete(key),
    ResizeObserver: class { constructor(fn) { resize = fn; } observe() {} disconnect() {} },
  });
  const ui = createReplayBar({root, control: {status: () => value}, getKind: () => kind, now: () => 0});
  return {
    ui, nodes, bar,
    set: patch => { value = {...value, ...patch}; },
    kind: next => { kind = next; },
    resize: width => { nodes['.rb-rail'].clientWidth = width; resize(); },
    frame() { const [key, fn] = frames.entries().next().value; frames.delete(key); fn(); },
    close() {
      ui.destroy();
      for (const [name, descriptor] of Object.entries(globals)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

describe('replay bar', () => {
  test('fresh equal annotations and moving playback retain DOM; live edits update hover and geometry', () => {
    const fixture = barFixture(), {ui, nodes} = fixture;
    try {
      ui.render(true);
      const track = nodes['.rb-track'], layer = nodes['.rb-marks'], pins = nodes['.rb-pins'];
      const firstSection = track.children[0], firstPin = pins.children[0];
      const writes = [track.writes, layer.writes, pins.writes];
      for (let index = 0; index < 10; index++) {
        fixture.set({index: 1600 + index, ramps: status.ramps.map(ramp => ({...ramp})), markers: [...status.markers], spots: [...status.spots]});
        fixture.frame();
      }
      expect([track.writes, layer.writes, pins.writes]).toEqual(writes);
      expect(track.children[0]).toBe(firstSection);
      expect(pins.children[0]).toBe(firstPin);
      fixture.set({ramps: [{...status.ramps[0], label: 'Updated ramp', tone: 'good', board: 1.5}]});
      fixture.frame();
      expect(layer.innerHTML).toContain('class="good"');
      nodes['.rb-rail'].listeners.pointermove({clientX: 600 / status.length * 800});
      expect(nodes['.rb-tip'].children[0].textContent).toBe('Updated ramp');
      expect(nodes['.rb-tip'].children[1].textContent).toBe('−1.5');
      fixture.kind('S'); fixture.frame();
      expect(layer.innerHTML).toContain('Stage 2');
      fixture.set({markers: [1008, 1010]}); fixture.frame();
      expect(layer.classList.contains('dense')).toBe(true);
      const beforeResize = track.writes;
      fixture.resize(100000); fixture.frame();
      expect(layer.classList.contains('dense')).toBe(false);
      expect(track.writes).toBe(beforeResize);
      fixture.set({dt: 0.03}); fixture.frame();
      expect(pins.children[0].getAttribute('aria-label')).toContain(railTime((500 - status.start) * 0.03));
      fixture.set({title: 'Renamed replay'}); const beforeTitle = track.writes; fixture.frame();
      expect(nodes['.rb-rail'].title).toBe('Renamed replay');
      expect(track.writes).toBe(beforeTitle);
    } finally { fixture.close(); }
  });

  test('ghost suppression, selection and replay length update marks without stale annotation state', () => {
    const fixture = barFixture(), {ui, nodes} = fixture;
    try {
      ui.render(true);
      fixture.set({ghosts: true, ramps: [], spots: []}); fixture.frame();
      expect(nodes['.rb-pins'].innerHTML).toBe('');
      expect(nodes['.rb-marks'].innerHTML).not.toContain('<i ');
      const hiddenWrites = nodes['.rb-track'].writes;
      fixture.set({index: 1700, ramps: [], spots: []}); fixture.frame();
      expect(nodes['.rb-track'].writes).toBe(hiddenWrites);
      fixture.set({ghosts: false, ramps: status.ramps, spots: status.spots, lastSpot: 500}); fixture.frame();
      expect(nodes['.rb-pins'].innerHTML).toContain('class="sel" data-spot="500"');
      fixture.set({length: 1008}); fixture.frame();
      expect(nodes['.rb-rail'].getAttribute('aria-valuemax')).toBe('1008');
      expect(nodes['.rb-pins'].innerHTML).not.toContain('data-spot="2000"');
      expect(nodes['.rb-marks'].innerHTML).not.toContain('CP2');
      ui.render(false); ui.render(true);
      const reopenedWrites = nodes['.rb-track'].writes;
      fixture.frame();
      expect(nodes['.rb-track'].writes).toBe(reopenedWrites);
    } finally { fixture.close(); }
  });

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
    expect(markTip(marks.find(mark => mark.label === 'Ramp 1'), status)).toMatchObject({title: 'Ramp 1', value: '−5.9', tone: 'loss'});
    expect(markTip(marks.find(mark => mark.label === 'Ramp 2'), status)).toMatchObject({value: '—', tone: 'muted'});
    expect(markTip(marks.find(mark => mark.label === 'CP1'), status)).toMatchObject({title: 'CP1', value: '00:10.125'});
    expect(markTip(marks.find(mark => mark.label === 'Loc 2'), status)).toMatchObject({title: 'Loc 2', tone: 'loc', label: expect.stringContaining('right-click')});
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
