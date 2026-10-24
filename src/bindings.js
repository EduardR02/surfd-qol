const validKey = code => typeof code === 'string' && /^(?:Key[A-Z]|Digit[0-9]|Space|Shift(?:Left|Right)|Control(?:Left|Right)|Alt(?:Left|Right)|Arrow(?:Up|Down|Left|Right)|Backquote|Minus|Equal|Bracket(?:Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash|CapsLock)$/.test(code);

// Resolve native command construction for every consumer, including live previews.
// Physical keys stay untouched; sampling adds one crouch tick per effective jump.
export function createBindings(getAdapter, settings, onSettings) {
  let adapter = null;
  let source = null;
  let signature = '';
  let input = null;
  let installedBindings = null;
  let removeSampler = null;
  let message = 'Waiting for native input';

  function release() {
    removeSampler?.();
    removeSampler = null;
    // setBindings clones its argument. Restore only our installed map, never a
    // newer native map, and use the current saved controls rather than a snapshot.
    if (installedBindings && input.bindings === installedBindings) adapter.setInputBindings(adapter.getBindings());
    installedBindings = null;
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
    if (adapter === next && input === nextInput && source === current && signature === nextSignature) return;
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
    if (nullAD) status.push('A/D null');
    if (nullWSpace) status.push('W/Space null');
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
    const sample = input.sample;
    const peek = input.peek;
    const clear = input.clear;
    const ownSample = Object.getOwnPropertyDescriptor(input, 'sample');
    const ownPeek = Object.getOwnPropertyDescriptor(input, 'peek');
    const ownClear = Object.getOwnPropertyDescriptor(input, 'clear');
    let held = 0, adWinner = 0, wsWinner = 0;
    let wasDown = crouchJump && input.keys.has(code);
    const keyBit = key => {
      switch (key) {
        case 'KeyA': return nullAD ? 1 : 0;
        case 'KeyD': return nullAD ? 2 : 0;
        case 'KeyW': return nullWSpace ? 4 : 0;
        case 'Space': return nullWSpace ? 8 : 0;
        default: return 0;
      }
    };
    const reset = () => { held = adWinner = wsWinner = 0; wasDown = false; };
    const sync = repeatCode => {
      const keys = hookedInput.keys;
      const down = (nullAD && keys.has('KeyA') ? 1 : 0) |
        (nullAD && keys.has('KeyD') ? 2 : 0) |
        (nullWSpace && keys.has('KeyW') ? 4 : 0) |
        (nullWSpace && keys.has('Space') ? 8 : 0);
      if (held === down) return;
      if (!(adWinner & down)) adWinner = down & 1 || down & 2;
      if (!(wsWinner & down)) wsWinner = down & 4 || down & 8;
      const added = down & ~held;
      // Native keys are insertion-ordered. This also handles keys already held
      // when enabling nulls, or native presses made without a DOM keydown.
      if (added) for (const key of keys) {
        const bit = keyBit(key);
        if (!(bit & added)) continue;
        if (bit & 3) {
          if (key !== repeatCode || !adWinner) adWinner = bit;
        } else if (key !== repeatCode || !wsWinner) wsWinner = bit;
      }
      held = down;
    };
    let physicalKeys = input.keys, keyIterator = null, hideAD = null, hideWS = null;
    const filteredIterator = {
      next() {
        let entry;
        do { entry = keyIterator.next(); } while (!entry.done && (entry.value === hideAD || entry.value === hideWS));
        return entry;
      }
    };
    // peek() already copies its key iterable. Reuse a view and its iterator so
    // filtering adds no tick-time copy/allocation or changes to physical order.
    const filteredKeys = {
      has: key => key !== hideAD && key !== hideWS && physicalKeys.has(key),
      [Symbol.iterator]() {
        keyIterator = physicalKeys[Symbol.iterator]();
        return filteredIterator;
      }
    };
    const peekFiltered = function () {
      if (this !== hookedInput || !this.locked || this.suppressed) return peek.apply(this, arguments);
      sync();
      physicalKeys = this.keys;
      hideAD = (held & 3) === 3 ? adWinner === 1 ? 'KeyD' : 'KeyA' : null;
      hideWS = (held & 12) === 12 ? wsWinner === 4 ? 'Space' : 'KeyW' : null;
      if (!hideAD && !hideWS) return peek.apply(this, arguments);
      this.keys = filteredKeys;
      try {
        return peek.apply(this, arguments);
      } finally {
        this.keys = physicalKeys;
      }
    };
    const sampleFiltered = function () {
      if (this !== hookedInput) return sample.apply(this, arguments);
      if (!this.locked || this.suppressed) {
        reset();
        return sample.apply(this, arguments);
      }
      const command = sample.apply(this, arguments);
      const down = crouchJump && command.jump && this.keys.has(code) && code !== hideAD && code !== hideWS;
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
      sync(event.repeat ? event.code : null);
      const bit = keyBit(code);
      if ((bit & 3 && adWinner !== bit) || (bit & 12 && wsWinner !== bit)) wasDown = false;
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
