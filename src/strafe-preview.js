const DEGREES = 180 / Math.PI;
const STILL_MESSAGE = 'Stand still in the start zone first.';
const SPEED_MESSAGE = 'Enter a speed from 1 to 5000 units.';
const INPUT_EVENTS = ['keydown', 'keyup', 'mousedown', 'mouseup', 'pointerdown', 'mousemove', 'pointermove', 'wheel', 'blur'];

function insideStart(session) {
  const state = session.state, config = session.config;
  const height = state.ducked ? config.duckHeight : config.standHeight;
  return session.map?.zones?.some(zone => {
    if (zone.kind !== 'start') return false;
    const hulls = zone.hulls?.length ? zone.hulls.map(hull => hull.planes) : zone.min && zone.max ? [[
      {normal: {x: 1, y: 0, z: 0}, distance: zone.max.x},
      {normal: {x: -1, y: 0, z: 0}, distance: -zone.min.x},
      {normal: {x: 0, y: 1, z: 0}, distance: zone.max.y},
      {normal: {x: 0, y: -1, z: 0}, distance: -zone.min.y},
      {normal: {x: 0, y: 0, z: 1}, distance: zone.max.z},
      {normal: {x: 0, y: 0, z: -1}, distance: -zone.min.z},
    ]] : [];
    return hulls.some(planes => planes.length && planes.every(({normal: n, distance}) => {
      const support = n.x * (n.x < 0 ? 16 : -16) + n.y * (n.y < 0 ? 16 : -16) + n.z * (n.z < 0 ? height : 0);
      const p = state.position;
      return p.x * n.x + p.y * n.y + p.z * n.z <= distance - support;
    }));
  }) === true;
}

export function strafeTick(speed, mode, config, surfaceFriction = 1) {
  const round = config.float32 ? Math.fround : value => value;
  let before = speed;
  if (mode === 'ground' && speed >= 0.1) {
    const drop = Math.max(speed, config.stopSpeed) * config.friction * surfaceFriction * config.dt;
    before = round(Math.max(0, speed - drop));
  }
  const wishSpeed = round(config.maxSpeed);
  const cap = mode === 'air' ? Math.min(wishSpeed, config.airCap) : wishSpeed;
  const budget = round(round(round((mode === 'air' ? config.airAccelerate : config.accelerate) * config.dt) * wishSpeed) * surfaceFriction);
  // Maximizing v² + 2at + a² with a=min(budget, cap-t) puts the wish projection at clamp(cap-budget, 0, v).
  const projection = Math.min(before, Math.max(0, cap - budget));
  const cosine = before > 0 ? projection / before : 1;
  const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  const amount = Math.min(round(cap - round(before * round(cosine))), budget);
  const x = round(before + round(cosine) * amount), y = round(round(sine) * amount);
  const turn = Math.atan2(y, x) * DEGREES;
  return {speed: Math.hypot(x, y), turn, turnRate: turn / config.dt};
}

function validConfig(config) {
  return config && ['dt', 'maxSpeed', 'airCap', 'airAccelerate', 'accelerate', 'friction', 'stopSpeed']
    .every(key => Number.isFinite(config[key]) && config[key] >= 0) && config.dt > 0 && config.dt <= 0.1 && config.maxSpeed > 0;
}

export function createStrafePreview({getAdapter, events = globalThis.window,
  requestFrame = callback => requestAnimationFrame(callback), cancelFrame = id => cancelAnimationFrame(id)} = {}) {
  const listeners = new Set();
  let active = null, frame = null;
  const emit = value => { for (const listener of listeners) { try { listener(value); } catch { /* UI only */ } } };
  function eligible(adapter, session) {
    const state = session?.state, input = adapter?.getInput?.(), view = adapter?.getView?.();
    return adapter?.previewView && state && validConfig(session.config) && !session.practice && !session.config.unrestrictedStart &&
      session.timer?.state?.phase === 'ready' && !session.timer.state.invalidReason &&
      state.grounded === true && !state.ducked && !(state.duckFraction > 0) && !state.jumpHeld &&
      state.velocity?.x === 0 && state.velocity?.y === 0 && state.velocity?.z === 0 &&
      !input?.keys?.size && !input?.wheelPending?.size && !input?.stageRestartPending &&
      !input?.turnLeft?.held?.size && !input?.turnRight?.held?.size && !view?.target && !view?.view &&
      !adapter.replay?.playback?.()?.replay && insideStart(session);
  }
  function stop() {
    if (!active) return;
    const previous = active;
    active = null;
    if (frame !== null) cancelFrame(frame);
    frame = null;
    for (const type of INPUT_EVENTS) events?.removeEventListener(type, stop, true);
    events?.document?.removeEventListener('visibilitychange', stop, true);
    try { previous.adapter.previewView.set(previous.view); } catch { /* An optional camera hook cannot break native input. */ }
    emit({active: false});
  }
  function check() {
    if (!active) return false;
    try {
      if (getAdapter?.() === active.adapter && active.adapter.getSession?.() === active.session && eligible(active.adapter, active.session)) return true;
    } catch { /* A changed native layout ends the preview. */ }
    stop();
    return false;
  }
  function animate(now) {
    frame = null;
    if (!check()) return;
    const run = active;
    if (run.last !== null) run.accumulator += Math.max(0, Math.min(0.1, (now - run.last) / 1000));
    run.last = now;
    while (run.accumulator >= run.config.dt) {
      const tick = strafeTick(run.speed, run.mode, run.config, run.friction);
      run.speed = tick.speed;
      run.turnRate = tick.turnRate;
      run.yaw += run.direction * tick.turn;
      run.stroke += tick.turn;
      run.ticks++;
      run.accumulator -= run.config.dt;
      if (run.stroke >= run.limit || run.ticks * run.config.dt >= run.duration) {
        run.direction *= -1;
        run.stroke = run.ticks = 0;
        run.limit = 18;
        run.duration = 0.3;
      }
    }
    try { run.adapter.previewView.set({yaw: run.yaw, pitch: run.view.pitch}); }
    catch { stop(); return; }
    emit({active: true, key: run.direction > 0 ? 'A' : 'D', speed: run.speed, turnRate: run.turnRate});
    if (active === run) frame = requestFrame(animate);
  }
  return {
    get active() { return active !== null; },
    async start({units, mode} = {}) {
      if (!Number.isFinite(units) || units < 1 || units > 5000) throw new Error(SPEED_MESSAGE);
      if (mode !== 'air' && mode !== 'ground') throw new Error('Choose air or ground strafing.');
      stop();
      const adapter = getAdapter?.(), session = adapter?.getSession?.();
      let view;
      try { if (eligible(adapter, session)) view = adapter.previewView.get(); } catch { /* Fail closed when optional hooks change. */ }
      if (!Number.isFinite(view?.yaw) || !Number.isFinite(view?.pitch)) throw new Error(STILL_MESSAGE);
      const config = {...session.config};
      active = {adapter, session, view: {...view}, config, mode, speed: units, friction: session.state.surfaceFriction ?? 1,
        yaw: view.yaw, direction: 1, stroke: 0, ticks: 0, limit: 9, duration: 0.15,
        turnRate: strafeTick(units, mode, config, session.state.surfaceFriction ?? 1).turnRate, last: null, accumulator: 0};
      for (const type of INPUT_EVENTS) events?.addEventListener(type, stop, true);
      events?.document?.addEventListener('visibilitychange', stop, true);
      frame = requestFrame(animate);
    },
    stop,
    check,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { stop(); listeners.clear(); },
  };
}
