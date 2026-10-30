import {afterEach, describe, expect, test} from 'bun:test';
import {createCinemaUi} from '../src/cinema-ui.js';

const restorers = [];
afterEach(() => { while (restorers.length) restorers.pop()(); });
function globalValue(name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
  restorers.push(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
}

// Static controls expose just the DOM operations the UI uses. Dynamic chip/tag
// markup isn't parsed: these tests cover actions and lifecycle, not strings.
function rig(initial = null, getSources = () => ({})) {
  let root;
  function node(dataset = {}) {
    const attributes = new Map(), classes = new Set(), listeners = new Map();
    return {dataset, hidden: true, disabled: false, children: [], style: {}, textContent: '', parentElement: null,
      classList: {toggle(name, value) { value ? classes.add(name) : classes.delete(name); }, contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name)},
      setAttribute: (name, value) => attributes.set(name, value), getAttribute: name => attributes.get(name) ?? null,
      removeAttribute: name => attributes.delete(name), hasAttribute: name => attributes.has(name),
      toggleAttribute(name, value) { value ? attributes.set(name, '') : attributes.delete(name); },
      addEventListener: (name, listener) => listeners.set(name, listener),
      emit(name, target, values = {}) {
        const event = {target, ...values, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }};
        listeners.get(name)?.(event);
        return event;
      },
      querySelector: () => null, querySelectorAll: () => [],
      prepend(child) {
        if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child);
        this.children = [child, ...this.children.filter(item => item !== child)];
        child.parentElement = this;
      },
      remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this);
        this.parentElement = null;
      },
      contains(target) { return target != null && (target === this || target.parentElement === this); },
      getBoundingClientRect: () => ({left: 20, right: 1000, top: 600, bottom: 630}),
      offsetWidth: 300, offsetHeight: 28,
      focus() { root.activeElement = this; },
      closest(selector) { return selector === 'button' ? this : null; },
      matches(selector) { return selector.includes('.cn-row button'); },
    };
  }
  globalValue('innerWidth', 1024); globalValue('innerHeight', 768);
  globalValue('requestAnimationFrame', () => 1); globalValue('cancelAnimationFrame', () => {});
  globalValue('addEventListener', () => {}); globalValue('removeEventListener', () => {});
  globalValue('ResizeObserver', undefined);
  const section = node(), row = node(), strip = node(), runs = node(), pick = node(), tags = node(), hint = node();
  const enable = node({cn: 'enable'}), add = node({cn: 'add'}), reset = node({cn: 'reset'}), seg = node();
  const sync = [node({sync: 'time'}), node({sync: 'place'})];
  seg.querySelectorAll = () => sync;
  row.parentElement = section;
  for (const element of [enable, add, reset, seg]) element.parentElement = row;
  strip.parentElement = section;
  row.querySelectorAll = () => [enable, add, reset, ...sync];
  const selectors = {'.cn-row': row, '.cn-strip': strip, '.cn-runs': runs, '.cn-seg': seg, '.cn-pick': pick, '.cn-tags': tags, '.cn-hint': hint,
    '[data-cn="enable"]': enable, '[data-cn="add"]': add, '[data-cn="reset"]': reset};
  section.querySelector = row.querySelector = selector => selectors[selector];
  const native = node(), custom = node(), nativeTools = node(), nativeActions = node(), customTools = node();
  native.prepend(nativeTools); nativeTools.prepend(nativeActions); custom.prepend(customTools);
  root = {activeElement: null, getElementById: id => ({cinema: section, replay: custom, 'native-replay-extras': native})[id],
    querySelector: selector => ({'.rb-tools': customTools, '.nr-tools': nativeTools, '.nr-actions': nativeActions})[selector]};
  let status = initial;
  const calls = [];
  const cinema = {available: () => true, get active() { return !!status?.active; }, status: () => status,
    async setEnabled(value) { calls.push(['enabled', value]); status = value ? solo() : null; },
    async setFocus(value) { calls.push(['focus', value]); }, async setSync(value) { calls.push(['sync', value]); },
    async add(source) { calls.push(['add', source.id]); await source.load(); },
    remove(id) { calls.push(['remove', id]); status = solo(); }, resetView() { calls.push(['reset']); }};
  const ui = createCinemaUi({root, cinema, getSources, storage: {getItem: () => '1'}});
  const click = button => row.emit('click', button);
  restorers.push(() => ui.destroy());
  return {ui, cinema, calls, root, section, row, strip, runs, seg, enable, add, pick, sync, native, custom, nativeTools, nativeActions, customTools, click};
}
const solo = () => ({active: true, played: {time: 41.233}, runs: [], loading: [], sync: 'time', focus: null, labels: []});
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const key = (type, name, path) => ({type, key: name, stopped: false, defaultPrevented: false, composedPath: () => path,
  preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }});

describe('cinematic replay controls', () => {
  test('enables and disables solo in either existing toolbar without an empty run strip', async () => {
    const r = rig();
    r.ui.render({visible: true});
    expect(r.strip.hidden && r.seg.hidden).toBe(true);
    r.click(r.enable); await settle();
    r.ui.render({visible: true});
    expect(r.enable.getAttribute('aria-pressed')).toBe('true');
    expect(r.strip.hidden && r.seg.hidden).toBe(true);
    r.ui.render({visible: true, custom: true});
    r.click(r.enable); await settle();
    r.ui.render({visible: true, custom: true});
    expect(r.enable.getAttribute('aria-pressed')).toBe('false');
    r.ui.render({visible: false});
    expect(r.row.hidden && r.section.hidden).toBe(true);
  });

  test('picker remains keyboard-operable across native/custom switches', async () => {
    const r = rig({...solo(), runs: [{id: 'wr', label: 'WR', color: '#9ccfd8'}]});
    for (const custom of [false, true, false, true]) {
      r.ui.render({visible: true, custom});
      r.click(r.add);
      expect(r.ui.picking).toBe(true);
      const escape = key('keydown', 'Escape', [r.pick]);
      r.ui.handleKey(escape);
      r.ui.handleKey(key('keyup', 'Escape', [r.add]));
      expect(r.pick.hidden).toBe(true);
      expect(r.root.activeElement).toBe(r.add);
    }
    r.ui.hide();
    expect(r.ui.holding).toBe(false);
    expect(r.row.hidden && r.strip.hidden && r.pick.hidden).toBe(true);
  });

  test('shows matching only with extras and returns to solo after the last removal', async () => {
    const r = rig({...solo(), runs: [{id: 'wr', label: 'Site WR', color: '#9ccfd8', time: 40.533}], focus: 'wr'});
    r.ui.render({visible: true});
    expect(r.strip.hidden || r.seg.hidden).toBe(false);
    r.click({disabled: false, dataset: {remove: 'wr'}, closest() { return this; }});
    r.ui.render({visible: true});
    expect(r.strip.hidden && r.seg.hidden).toBe(true);
    expect(r.enable.getAttribute('aria-pressed')).toBe('true');
    expect(r.root.activeElement).toBe(r.add);
  });

  test('picker Escape consumes both halves, restores focus, and button Space/Enter do not reach playback', () => {
    const r = rig();
    r.ui.render({visible: true}); r.click(r.add);
    expect(r.pick.hidden).toBe(false);
    for (const type of ['keydown', 'keyup']) {
      const event = key(type, 'Escape', [r.pick]);
      expect(r.ui.handleKey(event)).toBe(true);
      expect(event.stopped && event.defaultPrevented).toBe(true);
    }
    expect(r.pick.hidden).toBe(true);
    expect(r.root.activeElement).toBe(r.add);
    for (const name of [' ', 'Enter']) {
      for (const type of ['keydown', 'keyup']) {
        const event = key(type, name, [r.enable]);
        expect(r.ui.handleKey(event)).toBe(true);
        expect(event.stopped).toBe(true);
        expect(event.defaultPrevented).toBe(false);
      }
    }
    expect(r.calls).toEqual([]);
  });

  test('failed cinematic activation exposes the picker error state without losing the controls', async () => {
    const r = rig();
    r.cinema.setEnabled = async () => { throw new Error('Route unavailable.'); };
    r.ui.render({visible: true}); r.click(r.enable); await settle();
    expect(r.ui.picking).toBe(true);
    expect(r.pick.hidden).toBe(false);
    expect(r.add.getAttribute('aria-expanded')).toBe('true');
    expect(r.enable.hasAttribute('aria-busy')).toBe(false);
    expect(r.row.hidden).toBe(false);
  });

  test('holding the bar for the Runs panel closes the picker and hides the run strip until released', () => {
    const r = rig({...solo(), runs: [{id: 'wr', label: 'WR', color: '#9ccfd8'}]});
    r.ui.render({visible: true}); r.click(r.add);
    expect(r.ui.picking).toBe(true);
    r.ui.render({visible: true, held: true});
    expect(r.ui.picking).toBe(false);
    expect(r.strip.hidden).toBe(true);
    r.ui.render({visible: true, held: false});
    expect(r.strip.hidden).toBe(false);
  });


  test('mouse wheels scroll overflowing chips horizontally without stealing trackpad scrolling', () => {
    const r = rig({...solo(), runs: [{id: 'wr', label: 'WR', color: '#9ccfd8'}]});
    r.ui.render({visible: true, custom: true});
    Object.assign(r.runs, {scrollWidth: 1200, clientWidth: 300, scrollLeft: 0});
    const wheel = r.strip.emit('wheel', r.runs, {deltaX: 0, deltaY: 3, deltaMode: 1});
    expect(wheel.defaultPrevented).toBe(true);
    expect(r.runs.scrollLeft).toBeGreaterThan(0);
    const trackpad = r.strip.emit('wheel', r.runs, {deltaX: 60, deltaY: 2, deltaMode: 0});
    expect(trackpad.defaultPrevented).toBe(false);
    r.runs.scrollWidth = 200;
    const fitting = r.strip.emit('wheel', r.runs, {deltaX: 0, deltaY: 100, deltaMode: 0});
    expect(fitting.defaultPrevented).toBe(false);
  });

  test('hovering or focusing relocated chips and controls holds idle until interaction ends', () => {
    const r = rig({...solo(), runs: [{id: 'wr', label: 'WR', color: '#9ccfd8'}]});
    r.ui.render({visible: true, custom: true});
    expect(r.ui.holding).toBe(false);
    r.strip.emit('pointerenter');
    expect(r.ui.holding).toBe(true);
    r.strip.emit('pointerleave');
    expect(r.ui.holding).toBe(false);
    r.enable.focus();
    expect(r.ui.holding).toBe(true);
    r.root.activeElement = null;
    r.row.emit('pointerenter');
    expect(r.ui.holding).toBe(true);
    r.ui.render({visible: false});
    expect(r.strip.hidden).toBe(true);
    expect(r.ui.holding).toBe(false);
  });

});
