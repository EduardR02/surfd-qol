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
function rig(initial = null, getSources = () => ({}), stored = {}) {
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
  const section = node(), row = node(), strip = node(), runs = node(), pick = node(), tags = node(), hint = node(), menu = node();
  const viewButton = node({cn: 'view'}), add = node({cn: 'add'}), reset = node({cn: 'reset'}), seg = node();
  const items = ['pov', 'steady', 'cinematic'].map(view => node({view}));
  for (const item of items) { item.parentElement = menu; item.matches = () => false; }
  menu.querySelectorAll = () => items;
  const sync = [node({sync: 'time'}), node({sync: 'place'})];
  seg.querySelectorAll = () => sync;
  row.parentElement = section;
  for (const element of [viewButton, add, reset, seg]) element.parentElement = row;
  strip.parentElement = section; menu.parentElement = section;
  row.querySelectorAll = () => [viewButton, add, reset, ...sync];
  const selectors = {'.cn-row': row, '.cn-strip': strip, '.cn-runs': runs, '.cn-seg': seg, '.cn-pick': pick, '.cn-tags': tags, '.cn-hint': hint, '.cn-views': menu,
    '[data-cn="view"]': viewButton, '[data-cn="add"]': add, '[data-cn="reset"]': reset};
  section.querySelector = row.querySelector = selector => selectors[selector];
  const native = node(), custom = node(), nativeTools = node(), nativeActions = node(), customTools = node();
  native.prepend(nativeTools); nativeTools.prepend(nativeActions); custom.prepend(customTools);
  root = {activeElement: null, getElementById: id => ({cinema: section, replay: custom, 'native-replay-extras': native})[id],
    querySelector: selector => ({'.rb-tools': customTools, '.nr-tools': nativeTools, '.nr-actions': nativeActions})[selector]};
  let status = initial;
  const calls = [];
  const cinema = {available: () => true, get active() { return !!status?.active; }, status: () => status,
    async setView(view) { calls.push(['view', view]); status = view === 'pov' ? status?.runs.length ? {...status, view} : null : {...status ?? solo(), view}; },
    async setStyle(style) { calls.push(['style', style]); },
    async setFocus(value) { calls.push(['focus', value]); }, async setSync(value) { calls.push(['sync', value]); },
    async add(source) { calls.push(['add', source.id]); await source.load(); },
    remove(id) { calls.push(['remove', id]); status = solo(); }, resetView() { calls.push(['reset']); }};
  const storage = {getItem: name => name === 'surfd-qol.ghost-hint' ? '1' : stored[name] ?? null, setItem: (name, value) => { stored[name] = value; }};
  const ui = createCinemaUi({root, cinema, getSources, storage});
  const click = button => row.emit('click', button);
  const choose = view => section.emit('click', items.find(item => item.dataset.view === view));
  restorers.push(() => ui.destroy());
  return {ui, cinema, calls, root, section, row, strip, runs, seg, viewButton, menu, items, add, pick, sync, native, custom, nativeTools, nativeActions, customTools, click, choose, stored};
}
const solo = () => ({active: true, played: {time: 41.233}, runs: [], loading: [], sync: 'time', focus: null, view: 'cinematic', labels: []});
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const key = (type, name, path) => ({type, key: name, stopped: false, defaultPrevented: false, composedPath: () => path,
  preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }});

describe('cinematic replay controls', () => {
  test('the view menu turns a camera on and goes back to first person, in either toolbar, without an empty run strip', async () => {
    const r = rig();
    r.ui.render({visible: true});
    expect(r.viewButton.getAttribute('aria-label')).toBe('View: POV');
    expect(r.strip.hidden && r.seg.hidden).toBe(true);
    r.click(r.viewButton);
    expect(r.ui.choosing && !r.menu.hidden).toBe(true);
    r.choose('cinematic'); await settle();
    r.ui.render({visible: true});
    expect(r.ui.choosing).toBe(false);
    expect(r.viewButton.getAttribute('aria-label')).toBe('View: Cinematic');
    expect(r.viewButton.classList.contains('on')).toBe(true);
    expect(r.items.map(item => item.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
    expect(r.strip.hidden && r.seg.hidden).toBe(true);
    r.ui.render({visible: true, custom: true});
    r.click(r.viewButton); r.choose('pov'); await settle();
    r.ui.render({visible: true, custom: true});
    expect(r.viewButton.getAttribute('aria-label')).toBe('View: POV');
    expect(r.calls).toEqual([['view', 'cinematic'], ['view', 'pov']]);
    r.ui.render({visible: false});
    expect(r.row.hidden && r.section.hidden).toBe(true);
  });

  test('the view menu is keyboard-operable and its keys never reach playback', async () => {
    const r = rig(solo());
    r.ui.render({visible: true});
    r.viewButton.focus();
    r.ui.handleKey(key('keydown', 'ArrowDown', [r.viewButton]));
    expect(r.ui.choosing).toBe(true);
    expect(r.root.activeElement).toBe(r.items[2]);
    for (const [name, at] of [['ArrowDown', 0], ['ArrowUp', 2], ['Home', 0], ['End', 2]]) {
      const down = key('keydown', name, [r.root.activeElement, r.menu]);
      expect(r.ui.handleKey(down)).toBe(true);
      expect(down.stopped && down.defaultPrevented).toBe(true);
      expect(r.root.activeElement).toBe(r.items[at]);
    }
    for (const name of [' ', 'Enter']) {
      const press = key('keydown', name, [r.items[1], r.menu]);
      expect(r.ui.handleKey(press)).toBe(true);
      expect(press.stopped && !press.defaultPrevented).toBe(true);
    }
    for (const type of ['keydown', 'keyup']) expect(r.ui.handleKey(key(type, 'Escape', [r.items[1], r.menu]))).toBe(true);
    expect(r.menu.hidden).toBe(true);
    expect(r.root.activeElement).toBe(r.viewButton);
    expect(r.calls).toEqual([]);
  });

  test('the camera style chosen is remembered, and handed back when the controls start', async () => {
    const r = rig(null, () => ({}), {'surfd-qol.camera-style': 'steady'});
    expect(r.calls).toEqual([['style', 'steady']]);
    r.ui.render({visible: true});
    r.click(r.viewButton); r.choose('cinematic'); await settle();
    expect(r.stored['surfd-qol.camera-style']).toBe('cinematic');
    r.click(r.viewButton); r.choose('pov'); await settle();
    expect(r.stored['surfd-qol.camera-style']).toBe('cinematic');
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
    expect(r.viewButton.classList.contains('on')).toBe(true);
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
        const event = key(type, name, [r.viewButton]);
        expect(r.ui.handleKey(event)).toBe(true);
        expect(event.stopped).toBe(true);
        expect(event.defaultPrevented).toBe(false);
      }
    }
    expect(r.calls).toEqual([]);
  });

  test('a camera that can’t start shows the picker’s error without losing the controls', async () => {
    const r = rig();
    r.cinema.setView = async () => { throw new Error('Route unavailable.'); };
    r.ui.render({visible: true}); r.click(r.viewButton); r.choose('cinematic'); await settle();
    expect(r.ui.picking).toBe(true);
    expect(r.pick.hidden).toBe(false);
    expect(r.add.getAttribute('aria-expanded')).toBe('true');
    expect(r.viewButton.hasAttribute('aria-busy')).toBe(false);
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
    r.viewButton.focus();
    expect(r.ui.holding).toBe(true);
    r.root.activeElement = null;
    r.row.emit('pointerenter');
    expect(r.ui.holding).toBe(true);
    r.ui.render({visible: false});
    expect(r.strip.hidden).toBe(true);
    expect(r.ui.holding).toBe(false);
  });

});
