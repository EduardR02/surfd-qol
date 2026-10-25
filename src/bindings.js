const validKey = code => typeof code === 'string' && /^(?:Key[A-Z]|Digit[0-9]|Space|Shift(?:Left|Right)|Control(?:Left|Right)|Alt(?:Left|Right)|Arrow(?:Up|Down|Left|Right)|Backquote|Minus|Equal|Bracket(?:Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash|CapsLock)$/.test(code);

// Resolve native command construction for every consumer, including live previews.
// Physical keys stay untouched; sampling adds one crouch tick per effective jump.
export function createBindings(getAdapter, settings, onSettings) {
  let adapter = null;
  let source = null;
  let signature = '';
  let input = null;
  let installedBindings = null;
  let sampledBindings = null;
  let removeSampler = null;
  let message = 'Waiting for native input';

  function release() {
    removeSampler?.();
    removeSampler = null;
    // setBindings clones its argument. Restore only our installed map, never a
    // newer native map, and use the current saved controls rather than a snapshot.
    if (installedBindings && input.bindings === installedBindings) {
      const saved = adapter.getBindings();
      if (adapter.getInput() === input) adapter.setInputBindings(saved);
      else input.setBindings(saved);
    }
    installedBindings = null;
    sampledBindings = null;
    signature = '';
  }
  function update() {
    const next = getAdapter();
    if (!next) {
      release();
      message = 'Waiting for native input';
      return;
    }
    const current = next.getBindings();
    const nextInput = next.getInput();
    const code = settings.crouchJumpKey;
    const nullAD = !!settings.nullAD, nullWSpace = !!settings.nullWSpace;
    const nextSignature = `${settings.crouchJump}:${code}:${nullAD}:${nullWSpace}`;
    if (adapter === next && input === nextInput && source === current && signature === nextSignature &&
      (!removeSampler || nextInput.bindings === sampledBindings)) return;
    release();
    adapter = next;
    input = nextInput;
    source = current;
    signature = nextSignature;
    let crouchJump = !!settings.crouchJump;
    const status = [];
    if (crouchJump && !validKey(code)) {
      status.push('Choose a keyboard key');
      crouchJump = false;
    }
    if (crouchJump) {
      const conflict = Object.entries(current).find(([action, codes]) => action !== 'jump' && action !== 'duck' && codes.includes(code));
      if (conflict) {
        status.push(`${code} is already bound to ${conflict[0]}; choose another key`);
        crouchJump = false;
      }
    }
    if (nullAD) status.push('Left/right null');
    if (nullWSpace) status.push('Forward/jump null');
    if (!crouchJump && !nullAD && !nullWSpace) {
      message = status.join(' · ') || 'Disabled';
      return;
    }
    if (typeof input?.sample !== 'function' || typeof input?.peek !== 'function') throw new Error('Native input sampling unavailable');
    if (crouchJump) {
      const bindings = Object.fromEntries(Object.entries(current).map(([action, codes]) => [action, [...codes]]));
      if (!bindings.jump.includes(code)) bindings.jump.push(code);
      bindings.duck = bindings.duck.filter(key => key !== code);
      adapter.setInputBindings(bindings);
      installedBindings = input.bindings;
      status.unshift(`${code}: jump + 1-tick crouch tap`);
    }
    const hookedInput = input;
    const nativeBindings = sampledBindings = input.bindings;
    const sample = input.sample;
    const peek = input.peek;
    const clear = input.clear;
    const ownSample = Object.getOwnPropertyDescriptor(input, 'sample');
    const ownPeek = Object.getOwnPropertyDescriptor(input, 'peek');
    const ownClear = Object.getOwnPropertyDescriptor(input, 'clear');
    let serial = 0, repeatSerial = 0, adWinner = 0, wsWinner = 0;
    let wasDown = crouchJump && input.keys.has(code);
    const keys = new Map();
    for (const [action, bit] of [['left', 1], ['right', 2], ['forward', 4], ['jump', 8]]) {
      if (!(bit & (nullAD ? 3 : 0) || bit & (nullWSpace ? 12 : 0))) continue;
      for (const key of nativeBindings[action] ?? []) {
        const entry = keys.get(key);
        if (entry) entry.bit |= bit;
        else keys.set(key, {bit, down: false, order: 0});
      }
    }
    const reset = () => {
      serial = repeatSerial = adWinner = wsWinner = 0;
      wasDown = false;
      for (const entry of keys.values()) { entry.down = false; entry.order = 0; }
    };
    const activate = (key, repeatCode) => {
      const entry = keys.get(key);
      if (entry && !entry.down) {
        entry.down = true;
        entry.order = key === repeatCode ? --repeatSerial : ++serial;
      }
    };
    const sync = repeatCode => {
      const wheel = !hookedInput.wheelReleaseTick ? hookedInput.wheelPending : null;
      for (const [key, entry] of keys) {
        if (!hookedInput.keys.has(key) && !wheel?.has(key)) entry.down = false;
      }
      // Insertion order recovers distinct presses made without DOM events too.
      for (const key of hookedInput.keys) activate(key, repeatCode);
      if (wheel) for (const key of wheel) activate(key);
      let adOrder = -Infinity, wsOrder = -Infinity;
      adWinner = wsWinner = 0;
      for (const entry of keys.values()) {
        if (!entry.down) continue;
        if (entry.bit & 3 && entry.order > adOrder) { adWinner = entry.bit & 3; adOrder = entry.order; }
        if (entry.bit & 12 && entry.order > wsOrder) { wsWinner = entry.bit & 12; wsOrder = entry.order; }
      }
    };
    const empty = [];
    const filteredBindings = {...nativeBindings};
    const peekFiltered = function () {
      if (this !== hookedInput || this.bindings !== nativeBindings || !this.locked || this.suppressed ||
        (!nullAD && !nullWSpace)) return peek.apply(this, arguments);
      sync();
      if ((!adWinner || adWinner === 3) && (!wsWinner || wsWinner === 12)) return peek.apply(this, arguments);
      // Filter actions, not physical keys: a shared duck/back/shortcut binding
      // must survive when its movement action loses priority.
      filteredBindings.left = adWinner === 2 ? empty : nativeBindings.left;
      filteredBindings.right = adWinner === 1 ? empty : nativeBindings.right;
      filteredBindings.forward = wsWinner === 8 ? empty : nativeBindings.forward;
      filteredBindings.jump = wsWinner === 4 ? empty : nativeBindings.jump;
      this.bindings = filteredBindings;
      try {
        return peek.apply(this, arguments);
      } finally {
        this.bindings = nativeBindings;
      }
    };
    const sampleFiltered = function () {
      if (this !== hookedInput) return sample.apply(this, arguments);
      if (!this.locked || this.suppressed) {
        reset();
        return sample.apply(this, arguments);
      }
      const command = sample.apply(this, arguments);
      const down = crouchJump && this.bindings === installedBindings &&
        command.jump && this.keys.has(code);
      if (down && !wasDown) command.duck = true;
      wasDown = down;
      return command;
    };
    const cleared = function () {
      if (this === hookedInput) reset();
      return clear.apply(this, arguments);
    };
    const pressed = event => {
      if (!hookedInput.locked || hookedInput.suppressed) { reset(); return; }
      if (event.type === 'wheel') {
        const key = event.deltaY > 0 ? 'WheelDown' : event.deltaY < 0 ? 'WheelUp' : null;
        const entry = keys.get(key);
        // Native wheel pulses may coalesce before sampling; a later scroll is
        // still the newest press, but previews must never consume the pulse.
        if (entry && !hookedInput.wheelReleaseTick && hookedInput.wheelPending?.has(key)) {
          entry.down = true;
          entry.order = ++serial;
        }
      }
      sync(event.repeat ? event.code : null);
      const bit = keys.get(code)?.bit ?? 0;
      if ((bit & 3 && !(adWinner & bit)) || (bit & 12 && !(wsWinner & bit))) wasDown = false;
    };
    const released = event => {
      sync();
      if (event.code === code) wasDown = false;
    };
    const lockChanged = () => { if (!hookedInput.locked) reset(); };
    const visibilityChanged = () => { if (hookedInput.doc.hidden) reset(); };
    hookedInput.sample = sampleFiltered;
    hookedInput.peek = peekFiltered;
    if (typeof clear === 'function') hookedInput.clear = cleared;
    hookedInput.doc.addEventListener('keydown', pressed);
    hookedInput.doc.addEventListener('keyup', released);
    if (nullAD || nullWSpace) {
      hookedInput.doc.addEventListener('mousedown', pressed);
      hookedInput.doc.addEventListener('mouseup', released);
      hookedInput.doc.addEventListener('wheel', pressed, {passive: true});
    }
    hookedInput.doc.addEventListener('pointerlockchange', lockChanged);
    hookedInput.doc.addEventListener('visibilitychange', visibilityChanged);
    hookedInput.win?.addEventListener('blur', reset);
    removeSampler = () => {
      if (hookedInput.sample === sampleFiltered) {
        if (ownSample) Object.defineProperty(hookedInput, 'sample', ownSample);
        else delete hookedInput.sample;
      }
      if (hookedInput.peek === peekFiltered) {
        if (ownPeek) Object.defineProperty(hookedInput, 'peek', ownPeek);
        else delete hookedInput.peek;
      }
      if (hookedInput.clear === cleared) {
        if (ownClear) Object.defineProperty(hookedInput, 'clear', ownClear);
        else delete hookedInput.clear;
      }
      hookedInput.doc.removeEventListener('keydown', pressed);
      hookedInput.doc.removeEventListener('keyup', released);
      hookedInput.doc.removeEventListener('pointerlockchange', lockChanged);
      hookedInput.doc.removeEventListener('mousedown', pressed);
      hookedInput.doc.removeEventListener('mouseup', released);
      hookedInput.doc.removeEventListener('wheel', pressed);
      hookedInput.doc.removeEventListener('visibilitychange', visibilityChanged);
      hookedInput.win?.removeEventListener('blur', reset);
      reset();
    };
    message = status.join(' · ');
  }
  return {
    update,
    release,
    setKey(code) { if (validKey(code)) { onSettings({ crouchJumpKey: code }); update(); return true; } return false; },
    status() { return message; }
  };
}
