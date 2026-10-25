const noop = () => {};
const vector = () => ({ x: 0, y: 0, z: 0 });

function copyVector(target, source) {
  target.x = source.x;
  target.y = source.y;
  target.z = source.z;
}

export function observePhysics(adapter, metrics, { onBeforeTick = noop, onTick = noop, onReset = noop, onError = noop } = {}) {
  const sessionPrototype = adapter.Session.prototype;
  const movementPrototype = adapter.Movement.prototype;
  const originals = [];
  // Payloads are borrowed for the synchronous callback only. Each observer
  // owns its scratch storage, including observers nested around shadow runs.
  const acceleration = { before: vector(), after: null, direction: null,
    wishSpeed: 0, airborne: false, config: null, surfaceFriction: 0 };
  const collision = { before: vector(), after: null, contacts: null, firstContact: 0, blocked: false, config: null };
  let active = null;
  let healthy = true;

  function fail(error) {
    healthy = false;
    // Diagnostics must not turn an analysis failure into a native failure.
    try { onError(error); } catch {}
  }
  function wrap(prototype, name, factory) {
    const original = prototype[name];
    if (typeof original !== 'function') throw new Error(`Unsupported Surfd observer method: ${name}`);
    const wrapper = factory(original);
    prototype[name] = wrapper;
    originals.push(() => { if (prototype[name] === wrapper) prototype[name] = original; });
  }
  function restore() {
    for (let i = originals.length - 1; i >= 0; i--) originals[i]();
  }
  try {
    wrap(sessionPrototype, 'step', original => function (command) {
      if (!healthy || this !== adapter.getSession()) return original.apply(this, arguments);
      const previousActive = active;
      active = this;
      try {
        try { onBeforeTick(this); metrics.begin(this, command); } catch (error) { fail(error); }
        const events = original.apply(this, arguments);
        if (healthy) {
          try { metrics.end(this, command, events); onTick(this, command, events); }
          catch (error) { fail(error); }
        }
        return events;
      } finally { active = previousActive; }
    });
    wrap(movementPrototype, 'accelerate', original => function (state, direction, wishSpeed, airborne) {
      if (!healthy || !active || this !== active.movement) return original.apply(this, arguments);
      try {
        copyVector(acceleration.before, state.velocity);
        acceleration.surfaceFriction = state.surfaceFriction;
      } catch (error) { fail(error); }
      const result = original.apply(this, arguments);
      if (healthy) {
        try {
          acceleration.after = state.velocity;
          acceleration.direction = direction;
          acceleration.wishSpeed = wishSpeed;
          acceleration.airborne = airborne;
          acceleration.config = this.config;
          metrics.acceleration(acceleration);
        } catch (error) { fail(error); }
      }
      return result;
    });
    wrap(movementPrototype, 'slide', original => function (state, result) {
      // walk() probes multiple alternative slide branches. They are not real
      // airborne motion, and observing them would double-count discarded losses.
      if (!healthy || !active || this !== active.movement || state.grounded) return original.apply(this, arguments);
      try {
        copyVector(collision.before, state.velocity);
        collision.firstContact = result.contacts.length;
      } catch (error) { fail(error); }
      const returned = original.apply(this, arguments);
      if (healthy) {
        try {
          collision.after = state.velocity;
          collision.contacts = result.contacts;
          collision.blocked = result.blocked;
          collision.config = this.config;
          metrics.collision(collision);
        } catch (error) { fail(error); }
      }
      return returned;
    });
    for (const name of ['restart', 'restorePractice', 'loadReplay', 'visitStation']) {
      wrap(sessionPrototype, name, original => function () {
        const result = original.apply(this, arguments);
        if (healthy && this === adapter.getSession() && result !== false) {
          try { metrics.reset(); onReset(); } catch (error) { fail(error); }
        }
        return result;
      });
    }
  } catch (error) {
    restore();
    throw error;
  }
  return {
    get healthy() { return healthy; },
    destroy() { restore(); metrics.reset(); onReset(); }
  };
}
