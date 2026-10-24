import { expect, test } from 'bun:test';
import { createBindings } from '../src/bindings.js';

function controls(key = 'Space') {
  let native = { jump: ['Space'], duck: ['ControlLeft', 'KeyC'], forward: ['KeyW'] };
  const settings = { crouchJump: true, crouchJumpKey: key };
  const input = {
    doc: new EventTarget(), keys: new Set(), locked: true, suppressed: false,
    bindings: native,
    sample() { return this.peek(); },
    peek() {
      const held = action => this.locked && !this.suppressed && this.bindings[action].some(code => this.keys.has(code));
      return { jump: held('jump'), duck: held('duck'), forward: held('forward') ? 400 : 0 };
    }
  };
  const adapter = {
    getInput: () => input,
    getBindings: () => native,
    setInputBindings(bindings) { input.bindings = bindings; input.keys.clear(); }
  };
  const binding = createBindings(() => adapter, settings, patch => Object.assign(settings, patch));
  binding.update();
  return {
    input, binding, settings,
    releaseKey(code) {
      input.keys.delete(code);
      const event = new Event('keyup');
      Object.defineProperty(event, 'code', { value: code });
      input.doc.dispatchEvent(event);
    },
    changeNative(bindings) { native = bindings; adapter.setInputBindings(bindings); binding.update(); }
  };
}

test('holding jump crouches for one tick, then keeps jumping without crouching', () => {
  const c = controls();
  c.input.keys.add('Space');
  expect(c.input.sample()).toMatchObject({ jump: true, duck: true });
  for (let tick = 0; tick < 5; tick++) expect(c.input.sample()).toMatchObject({ jump: true, duck: false });
  // Release/repress between samples still begins a fresh pulse.
  c.releaseKey('Space'); c.input.keys.add('Space');
  expect(c.input.sample()).toMatchObject({ jump: true, duck: true });
  expect(c.input.sample()).toMatchObject({ jump: true, duck: false });
  c.binding.release();
});

test('manual crouch can remain held independently of the jump pulse', () => {
  const c = controls();
  c.input.keys.add('Space'); c.input.keys.add('ControlLeft');
  c.input.sample();
  expect(c.input.sample()).toMatchObject({ jump: true, duck: true });
  c.releaseKey('Space');
  expect(c.input.sample()).toMatchObject({ jump: false, duck: true });
  c.releaseKey('ControlLeft');
  expect(c.input.sample()).toMatchObject({ jump: false, duck: false });
  c.binding.release();
});

test('a crouch-only key becomes a tap bind and disabling restores held crouch', () => {
  const c = controls('KeyC');
  c.input.keys.add('KeyC');
  expect(c.input.sample()).toMatchObject({ jump: true, duck: true });
  expect(c.input.sample()).toMatchObject({ jump: true, duck: false });
  c.settings.crouchJump = false; c.binding.update();
  c.input.keys.add('KeyC');
  expect(c.input.sample()).toMatchObject({ jump: false, duck: true });
  expect(c.input.sample()).toMatchObject({ jump: false, duck: true });
});

test('suppressed or uncaptured input cannot emit a crouch pulse', () => {
  const c = controls();
  c.input.keys.add('Space'); c.input.suppressed = true;
  expect(c.input.sample()).toMatchObject({ jump: false, duck: false });
  c.input.suppressed = false; c.input.locked = false;
  expect(c.input.sample()).toMatchObject({ jump: false, duck: false });
  c.binding.release();
});

test('a changed native binding retains its action rather than restoring stale controls', () => {
  const c = controls();
  c.changeNative({ jump: ['KeyJ'], duck: ['ControlLeft'], forward: ['Space'] });
  c.input.keys.add('Space');
  expect(c.input.sample()).toMatchObject({ jump: false, duck: false, forward: 400 });
  c.input.keys.clear(); c.input.keys.add('KeyJ');
  expect(c.input.sample()).toMatchObject({ jump: true, duck: false, forward: 0 });
  c.binding.release();
});

// Match the native boundary: key handlers run before the extension's listeners,
// setBindings clones and clears, and sample -> peek copies the pressed Set.
function nullControls(options = {}, nativeBindings = {}) {
  let native = {
    jump: ['Space'], duck: ['ControlLeft', 'KeyC'], forward: ['KeyW'],
    back: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
    ...nativeBindings
  };
  const settings = { crouchJump: false, crouchJumpKey: 'Space', nullAD: false, nullWSpace: false, ...options };
  const input = {
    doc: new EventTarget(), win: new EventTarget(), keys: new Set(),
    locked: true, suppressed: false, bindings: native,
    wheelPending: new Set(), wheelReleaseTick: false,
    clear() { this.keys.clear(); this.wheelPending.clear(); this.wheelReleaseTick = false; },
    setSuppressed(value) { this.suppressed = value; this.clear(); },
    setBindings(bindings) {
      this.bindings = Object.fromEntries(Object.entries(bindings).map(([action, codes]) => [action, [...codes]]));
      this.clear();
    },
    peek() {
      const keys = this.locked && !this.suppressed ? new Set(this.keys) : new Set();
      if (this.locked && !this.suppressed && !this.wheelReleaseTick) {
        for (const key of this.wheelPending) keys.add(key);
      }
      const held = action => this.bindings[action].some(key => keys.has(key));
      return {
        jump: held('jump'), duck: held('duck'),
        forward: (Number(held('forward')) - Number(held('back'))) * 400,
        side: (Number(held('right')) - Number(held('left'))) * 400
      };
    },
    sample() {
      const command = this.peek();
      if (this.wheelReleaseTick) this.wheelReleaseTick = false;
      else if (this.wheelPending.size) { this.wheelPending.clear(); this.wheelReleaseTick = true; }
      return command;
    }
  };
  input.doc.addEventListener('keydown', event => {
    if (input.locked && !input.suppressed && Object.values(input.bindings).some(codes => codes.includes(event.code))) input.keys.add(event.code);
  });
  input.doc.addEventListener('keyup', event => { input.keys.delete(event.code); });
  input.doc.addEventListener('pointerlockchange', () => { if (!input.locked) input.clear(); });
  input.doc.addEventListener('visibilitychange', () => { if (input.doc.hidden) input.clear(); });
  input.win.addEventListener('blur', () => { input.clear(); input.locked = false; });
  const nativeSample = input.sample, nativeClear = input.clear;
  const adapter = {
    getInput: () => input,
    getBindings: () => native,
    setInputBindings: bindings => input.setBindings(bindings)
  };
  const binding = createBindings(() => adapter, settings, patch => Object.assign(settings, patch));
  const keyEvent = (type, code, repeat = false) => {
    const event = new Event(type);
    Object.defineProperties(event, { code: { value: code }, repeat: { value: repeat } });
    input.doc.dispatchEvent(event);
  };
  binding.update();
  return {
    input, binding, settings, nativeSample, nativeClear,
    press: (code, repeat = false) => keyEvent('keydown', code, repeat),
    release: code => keyEvent('keyup', code),
    changeNative(patch, update = true) {
      native = { ...native, ...patch };
      input.setBindings(native);
      if (update) binding.update();
    }
  };
}

test('A/D nulls use the newest distinct press in either order and release falls back', () => {
  for (const [first, second, side] of [['KeyA', 'KeyD', 400], ['KeyD', 'KeyA', -400]]) {
    const c = nullControls({ nullAD: true });
    c.press(first);
    expect(c.input.sample().side).toBe(-side);
    c.press(second);
    expect(c.input.sample().side).toBe(side);
    c.press(first, true);
    expect(c.input.sample().side).toBe(side);
    c.press(first); // Duplicate non-repeat events cannot steal priority either.
    expect(c.input.sample().side).toBe(side);
    expect(c.input.keys.has(first)).toBe(true);
    expect(c.input.keys.has(second)).toBe(true);
    c.release(second);
    expect(c.input.sample().side).toBe(-side);
    c.release(first);
    expect(c.input.sample().side).toBe(0);
    c.binding.release();
  }
});

test('native command previews and sampled movement agree without consuming jump or wheel edges', () => {
  const c = nullControls({ nullAD: true, nullWSpace: true, crouchJump: true }, { back: ['KeyS', 'WheelDown'] });
  c.press('KeyA'); c.press('KeyD'); c.press('KeyW'); c.press('Space');
  c.input.wheelPending.add('WheelDown');
  const physical = c.input.keys, order = [...physical];
  for (let frame = 0; frame < 3; frame++) {
    expect(c.input.peek()).toEqual({ side:400,forward:-400,jump:true,duck:false });
  }
  expect(c.input.sample()).toEqual({ side:400,forward:-400,jump:true,duck:true });
  expect(c.input.peek()).toEqual({ side:400,forward:0,jump:true,duck:false });
  expect(c.input.sample()).toEqual({ side:400,forward:0,jump:true,duck:false });
  c.release('Space'); c.release('KeyD');
  expect(c.input.peek()).toEqual({ side:-400,forward:400,jump:false,duck:false });
  expect(c.input.sample()).toEqual({ side:-400,forward:400,jump:false,duck:false });
  expect(c.input.keys).toBe(physical);
  expect([...physical]).toEqual(order.filter(key => key !== 'Space' && key !== 'KeyD'));
  c.binding.release();
  c.press('KeyA'); c.press('KeyW'); c.press('Space'); c.press('KeyD');
  expect(c.input.peek()).toEqual({ side:0,forward:400,jump:true,duck:false });
});

test('both null pairs are independent and work with crouch-jump disabled', () => {
  const c = nullControls({ nullAD: true, nullWSpace: true });
  c.press('KeyA'); c.press('KeyW'); c.press('KeyD'); c.press('Space');
  expect(c.input.sample()).toEqual({ side: 400, forward: 0, jump: true, duck: false });
  expect(c.input.sample()).toEqual({ side: 400, forward: 0, jump: true, duck: false });
  c.press('KeyW', true);
  expect(c.input.sample()).toMatchObject({ forward: 0, jump: true });
  c.release('KeyD');
  expect(c.input.sample()).toMatchObject({ side: -400, forward: 0, jump: true });
  c.release('Space');
  expect(c.input.sample()).toMatchObject({ side: -400, forward: 400, jump: false });
  c.release('KeyW'); c.release('KeyA');
  expect(c.input.sample()).toEqual({ side: 0, forward: 0, jump: false, duck: false });
  c.binding.release();
});

test('W/Space crouch pulses follow effective jump reactivation, including release fallback', () => {
  const c = nullControls({ crouchJump: true, nullWSpace: true });
  c.press('KeyW');
  expect(c.input.sample()).toMatchObject({ forward: 400, jump: false, duck: false });
  c.press('Space');
  expect(c.input.sample()).toMatchObject({ forward: 0, jump: true, duck: true });
  c.press('Space', true);
  expect(c.input.sample()).toMatchObject({ forward: 0, jump: true, duck: false });
  c.release('KeyW'); c.press('KeyW');
  expect(c.input.sample()).toMatchObject({ forward: 400, jump: false, duck: false });
  c.release('KeyW');
  expect(c.input.sample()).toMatchObject({ forward: 0, jump: true, duck: true });
  expect(c.input.sample()).toMatchObject({ forward: 0, jump: true, duck: false });
  // A suppression/reactivation edge wholly between samples is still a new edge.
  c.press('KeyW'); c.release('KeyW');
  expect(c.input.sample()).toMatchObject({ forward: 0, jump: true, duck: true });
  expect(c.input.sample()).toMatchObject({ jump: true, duck: false });
  c.binding.release();
});

test('a Space press overridden before sampling does not emit a duck pulse', () => {
  const c = nullControls({ crouchJump: true, nullWSpace: true });
  c.press('Space'); c.press('KeyW');
  expect(c.input.sample()).toMatchObject({ forward: 400, jump: false, duck: false });
  c.release('KeyW');
  expect(c.input.sample()).toMatchObject({ forward: 0, jump: true, duck: true });
  c.press('ControlLeft');
  expect(c.input.sample()).toMatchObject({ jump: true, duck: true });
  c.release('Space');
  expect(c.input.sample()).toMatchObject({ jump: false, duck: true });
  c.binding.release();
});

test('crouch conflicts and invalid crouch keys do not disable unrelated null filters', () => {
  for (const crouchJumpKey of ['KeyW', 'Mouse0']) {
    const c = nullControls({ crouchJump: true, crouchJumpKey, nullAD: true, nullWSpace: true });
    c.press('KeyA'); c.press('KeyD'); c.press('Space'); c.press('KeyW');
    expect(c.input.sample()).toEqual({ side: 400, forward: 400, jump: false, duck: false });
    expect(c.binding.status()).toContain('A/D null');
    expect(c.binding.status()).toContain('W/Space null');
    expect(c.binding.status()).toContain(crouchJumpKey === 'KeyW' ? 'already bound to forward' : 'Choose a keyboard key');
    c.binding.release();
  }
});

test('native clear, suppression, blur, visibility and lock loss cannot retain stale priority', () => {
  for (const reset of [
    c => c.input.clear(),
    c => { c.input.setSuppressed(true); c.input.setSuppressed(false); },
    c => { c.input.win.dispatchEvent(new Event('blur')); c.input.locked = true; },
    c => {
      c.input.locked = false;
      c.input.doc.dispatchEvent(new Event('pointerlockchange'));
      c.input.locked = true;
    },
    c => {
      c.input.doc.hidden = true;
      c.input.doc.dispatchEvent(new Event('visibilitychange'));
      c.input.doc.hidden = false;
    }
  ]) {
    const c = nullControls({ crouchJump: true, nullAD: true, nullWSpace: true });
    c.press('KeyA'); c.press('KeyD'); c.press('KeyW'); c.press('Space');
    expect(c.input.sample()).toMatchObject({ side: 400, jump: true, duck: true });
    reset(c);
    // No intermediate sample: reset must clear priority and crouch edge state.
    c.press('KeyD'); c.press('KeyA'); c.press('Space'); c.press('KeyW');
    expect(c.input.sample()).toEqual({ side: -400, forward: 400, jump: false, duck: false });
    c.release('KeyW');
    expect(c.input.sample()).toMatchObject({ jump: true, duck: true });
    c.input.setSuppressed(true);
    c.press('KeyD');
    expect(c.input.sample()).toEqual({ side: 0, forward: 0, jump: false, duck: false });
    c.input.setSuppressed(false);
    expect(c.input.sample()).toEqual({ side: 0, forward: 0, jump: false, duck: false });
    c.binding.release();
  }
});

test('disabled nulls and teardown restore native sampling without losing physical held keys', () => {
  for (const destroy of [false, true]) {
    const c = nullControls({ nullAD: true, nullWSpace: true });
    c.press('KeyA'); c.press('KeyD'); c.press('KeyW'); c.press('Space');
    expect(c.input.sample()).toMatchObject({ side: 400, forward: 0, jump: true });
    if (destroy) c.binding.release();
    else { c.settings.nullAD = c.settings.nullWSpace = false; c.binding.update(); }
    expect(c.input.sample()).toEqual({ side: 0, forward: 400, jump: true, duck: false });
    expect(c.input.sample).toBe(c.nativeSample);
    expect(c.input.clear).toBe(c.nativeClear);
    c.release('KeyA'); c.release('KeyD'); c.release('KeyW'); c.release('Space');
    expect(c.input.sample()).toEqual({ side: 0, forward: 0, jump: false, duck: false });
    c.binding.release();
  }
});

test('nulls keep fixed physical pairs and preserve changed native controls on release', () => {
  for (const update of [false, true]) {
    const c = nullControls({ crouchJump: true, nullAD: true, nullWSpace: true });
    c.changeNative({ left: ['KeyD'], right: ['KeyA'], forward: ['Space'], jump: ['KeyW'] }, update);
    c.press('KeyA'); c.press('KeyD'); c.press('Space'); c.press('KeyW');
    expect(c.input.sample()).toMatchObject({ side: -400, forward: 0, jump: true, duck: false });
    c.binding.release();
    expect(c.input.sample()).toEqual({ side: 0, forward: 400, jump: true, duck: false });
    c.release('KeyD'); c.release('Space');
    expect(c.input.sample()).toMatchObject({ side: 400, forward: 0, jump: true });
  }
});

test('other keys, native mouse binds and wheel command consumption stay independent', () => {
  const c = nullControls({ crouchJump: true, nullAD: true, nullWSpace: true }, {
    left: ['KeyA', 'ArrowLeft'], forward: ['KeyW', 'Mouse0'], jump: ['Space', 'WheelUp']
  });
  c.press('KeyA'); c.press('KeyD'); c.press('Space');
  c.input.sample(); // Consume only the physical Space duck edge.
  c.press('KeyW'); c.press('ArrowLeft'); c.input.keys.add('Mouse0');
  c.input.wheelPending.add('WheelUp');
  expect(c.input.sample()).toEqual({ side: 0, forward: 400, jump: true, duck: false });
  expect(c.input.sample()).toEqual({ side: 0, forward: 400, jump: false, duck: false });
  expect(c.input.keys.has('Space')).toBe(true);
  expect(c.input.keys.has('Mouse0')).toBe(true);
  c.binding.release();
});

test('native sampler failures still restore every temporarily filtered physical key', () => {
  const c = nullControls({ nullAD: true, nullWSpace: true });
  c.press('KeyA'); c.press('KeyD'); c.press('KeyW'); c.press('Space');
  const peek = c.input.peek;
  c.input.peek = () => { throw new Error('native sample failure'); };
  expect(() => c.input.sample()).toThrow('native sample failure');
  for (const key of ['KeyA', 'KeyD', 'KeyW', 'Space']) expect(c.input.keys.has(key)).toBe(true);
  c.input.peek = peek;
  expect(c.input.sample()).toMatchObject({ side: 400, forward: 0, jump: true });
  c.binding.release();
});

test('enabling nulls reconciles already held native keys without inventing a new press', () => {
  const c = nullControls();
  c.press('KeyD'); c.press('KeyA'); c.press('Space'); c.press('KeyW');
  c.settings.nullAD = c.settings.nullWSpace = true;
  c.binding.update();
  expect(c.input.sample()).toEqual({ side: -400, forward: 400, jump: false, duck: false });
  c.release('KeyA'); c.release('KeyW');
  expect(c.input.sample()).toEqual({ side: 400, forward: 0, jump: true, duck: false });
  c.binding.release();
});

test('sampling preserves the original key Set identity and insertion order across reconfiguration', () => {
  const c = nullControls({ nullAD: true });
  c.press('KeyD'); c.press('KeyA'); c.press('Space'); c.press('KeyW');
  const physicalKeys = c.input.keys;
  const order = [...physicalKeys];
  expect(c.input.sample()).toMatchObject({ side: -400, forward: 400, jump: true });
  expect(c.input.keys).toBe(physicalKeys);
  expect([...physicalKeys]).toEqual(order);
  c.settings.nullWSpace = true;
  c.binding.update();
  expect(c.input.sample()).toMatchObject({ side: -400, forward: 400, jump: false });
  expect(c.input.keys).toBe(physicalKeys);
  expect([...physicalKeys]).toEqual(order);
  c.binding.release();
});

test('each null toggle leaves the disabled pair and default native commands untouched', () => {
  for (const options of [{}, { nullAD: true }, { nullWSpace: true }]) {
    const c = nullControls(options);
    c.press('KeyA'); c.press('KeyD'); c.press('Space'); c.press('KeyW');
    expect(c.input.sample()).toEqual({
      side: options.nullAD ? 400 : 0, forward: 400,
      jump: !options.nullWSpace, duck: false
    });
    c.binding.release();
  }
});

test('an unbound physical pair key is not injected into native controls or commands', () => {
  const c = nullControls({ nullAD: true, nullWSpace: true }, { left: ['ArrowLeft'], jump: ['KeyJ'] });
  c.press('KeyD'); c.press('KeyA'); c.press('KeyW'); c.press('Space');
  expect(c.input.sample()).toEqual({ side: 400, forward: 400, jump: false, duck: false });
  expect(c.input.keys.has('KeyA')).toBe(false);
  expect(c.input.keys.has('Space')).toBe(false);
  c.press('ArrowLeft'); c.press('KeyJ');
  expect(c.input.sample()).toEqual({ side: 0, forward: 400, jump: true, duck: false });
  c.binding.release();
});

test('releasing a crouch map restores current saved controls even before the next update', () => {
  const c = nullControls({ crouchJump: true, crouchJumpKey: 'KeyC', nullAD: true });
  c.press('KeyC');
  expect(c.input.sample()).toMatchObject({ jump: true, duck: true });
  expect(c.input.sample()).toMatchObject({ jump: true, duck: false });
  c.changeNative({ jump: ['KeyJ'], duck: ['KeyC'], forward: ['Space'] }, false);
  c.binding.release();
  c.press('KeyC'); c.press('Space');
  expect(c.input.sample()).toMatchObject({ jump: false, duck: true, forward: 400 });
  c.release('KeyC'); c.press('KeyJ');
  expect(c.input.sample()).toMatchObject({ jump: true, duck: false, forward: 400 });
});
