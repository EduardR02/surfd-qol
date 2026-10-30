// Only the native practice snapshot schema crosses the room boundary. The result is rebuilt field by field, so nothing unvalidated from the wire survives.
const MAX_ITEMS = 1024, MAX_TICK = 0x7fffffff, MAX_SNAPSHOT_BYTES = 32768;
const encoder = new TextEncoder();
// Each player keeps 20 saves per map; a room holds at most 64 players' worth.
export const SAVELOC_RING = 20, MAX_ROOM_SAVELOCS = 64 * SAVELOC_RING;
const fail = () => { throw new Error('Invalid shared saveloc'); };
const check = value => { if (!value) fail(); };
const number = (value, min, max) => { check(Number.isFinite(value) && value >= min && value <= max); return value; };
const integer = (value, min = 0, max = MAX_TICK) => { check(Number.isSafeInteger(value)); return number(value, min, max); };
const bool = value => { check(typeof value === 'boolean'); return value; };
const text = (value, max = 256) => { check(typeof value === 'string' && value.length <= max); return value; };
function object(value, required, optional = []) {
  check(value && typeof value === 'object' && !Array.isArray(value));
  const keys = Object.keys(value);
  check(keys.length <= required.length + optional.length && required.every(key => Object.hasOwn(value, key))
    && keys.every(key => required.includes(key) || optional.includes(key)));
  return value;
}
function list(value, read, max = MAX_ITEMS) {
  check(Array.isArray(value) && value.length <= max);
  return value.map(read);
}
function vector(value, max = 131072) {
  object(value, ['x', 'y', 'z']);
  return {x: number(value.x, -max, max), y: number(value.y, -max, max), z: number(value.z, -max, max)};
}
function spawn(value) {
  object(value, ['position', 'yaw', 'pitch']);
  return {position: vector(value.position, 32768), yaw: number(value.yaw, -360, 360), pitch: number(value.pitch, -89, 89)};
}
function practiceKey(value, map) {
  text(value, 8192);
  const key = JSON.parse(value);
  check(Array.isArray(key) && key.length === 4 && text(key[0]).length && text(key[1]).length);
  text(key[2], 4096);
  const config = JSON.parse(key[2]);
  check(config && typeof config === 'object' && !Array.isArray(config) && Object.keys(config).length <= 40);
  for (const [name, field] of Object.entries(config)) {
    check(/^[A-Za-z][A-Za-z0-9]*$/.test(name) && name.length <= 40);
    check(typeof field === 'boolean' || typeof field === 'string' && field.length <= 128
      || typeof field === 'number' && Number.isFinite(field) && Math.abs(field) <= 1000000);
  }
  number(config.dt, 0.0001, 1);
  integer(key[3], 1, 8);
  if (map) check(key[0] === map.id && key[1] === map.version);
  // Config is an inert string, not installed into the destination simulation. Runtime rebases this key.
  return value;
}
function outputState(value, map, tick) {
  object(value, ['contacts', 'accepted', 'targetname'], ['pending', 'pendingVelocity']);
  const zones = map?.playerOutputZones ?? [];
  const zoneId = id => { text(id); if (map) check(zones.some(zone => zone.id === id)); return id; };
  const target = name => {
    text(name);
    if (map && name !== '') check(zones.some(zone => [...zone.onStart, ...zone.onEnd].some(event => event.property === 'targetname' && event.value === name)));
    return name;
  };
  const result = {contacts: list(value.contacts, zoneId), accepted: list(value.accepted, zoneId), targetname: target(value.targetname)};
  for (const key of ['contacts', 'accepted']) check(new Set(result[key]).size === result[key].length);
  for (const key of ['pending', 'pendingVelocity']) if (Object.hasOwn(value, key)) {
    let previous = tick;
    result[key] = list(value[key], item => {
      object(item, ['tick', key === 'pending' ? 'targetname' : 'value']);
      const at = integer(item.tick, tick, MAX_TICK);
      check(at >= previous); previous = at;
      if (key === 'pending') return {tick: at, targetname: target(item.targetname)};
      const velocity = vector(item.value, 32767);
      if (map) check(zones.some(zone => [...zone.onStart, ...zone.onEnd].some(event => event.property === 'velocity'
        && ['x', 'y', 'z'].every(axis => event.value[axis] === velocity[axis]))));
      return {tick: at, value: velocity};
    }, 128);
  }
  return result;
}

export function sanitizeSaveloc(snapshot, map = null) {
  object(snapshot, ['key', 'state', 'timer', 'checkpointSpeeds', 'startPosition', 'startJumps', 'startGroundTime',
    'startHopWarned', 'startRegion', 'rawJumpHeld', 'stageStartRecovery']);
  if (map) {
    check(typeof map.id === 'string' && typeof map.version === 'string' && Array.isArray(map.zones) && map.spawn
      && (map.stages === undefined || Array.isArray(map.stages)));
    // Restart must remain a safe native operation even for a snapshot without a custom start.
    vector(map.spawn.position);
    number(map.spawn.yaw, -360, 360);
    number(map.spawn.pitch, -89, 89);
  }
  const key = practiceKey(snapshot.key, map);
  const source = object(snapshot.state, ['position', 'velocity', 'grounded', 'groundId', 'ducked', 'duckFraction',
    'eyeHeight', 'jumpHeld', 'surfaceFriction', 'yaw', 'pitch', 'tick'],
  ['stage', 'pendingStageTeleport', 'baseVelocity', 'pendingMapPush', 'lastMapTeleportTick', 'mapGroundCheck', 'mapOutputState']);
  const state = {position: vector(source.position), velocity: vector(source.velocity, 32767), grounded: bool(source.grounded),
    groundId: source.groundId === null ? null : text(source.groundId), ducked: bool(source.ducked),
    duckFraction: number(source.duckFraction, 0, 1), eyeHeight: number(source.eyeHeight, 0, 128), jumpHeld: bool(source.jumpHeld),
    surfaceFriction: number(source.surfaceFriction, 0, 1), yaw: number(source.yaw, -360, 360),
    pitch: number(source.pitch, -89, 89), tick: integer(source.tick)};
  for (const name of ['stage', 'pendingStageTeleport']) if (Object.hasOwn(source, name)) {
    state[name] = integer(source[name], 1, map ? map.stages?.length ?? 0 : MAX_ITEMS);
    if (map) check(map.stages[state[name] - 1]?.spawn);
  }
  // A stage handoff may precede the next tick, including returns to earlier stages.
  if (map && state.pendingStageTeleport !== undefined) check(map.teleportZones?.some(zone => zone.velocity === 'stage' && zone.stage === state.pendingStageTeleport));
  for (const name of ['baseVelocity', 'pendingMapPush']) if (Object.hasOwn(source, name)) state[name] = vector(source[name], 32767);
  if (Object.hasOwn(source, 'lastMapTeleportTick')) state.lastMapTeleportTick = integer(source.lastMapTeleportTick, 0, state.tick);
  if (Object.hasOwn(source, 'mapGroundCheck')) {
    check(source.mapGroundCheck === 'push' || source.mapGroundCheck === 'teleport');
    state.mapGroundCheck = source.mapGroundCheck;
  }
  if (Object.hasOwn(source, 'mapOutputState')) state.mapOutputState = outputState(source.mapOutputState, map, state.tick);
  const sourceTimer = object(snapshot.timer, ['state', 'armed', 'prehops']);
  const timerState = object(sourceTimer.state, ['phase', 'startTick', 'endTick', 'splits', 'invalidReason', 'elapsed']);
  check(timerState.phase === 'ready' || timerState.phase === 'running');
  const checkpoints = map ? map.zones.filter(zone => zone.kind === 'checkpoint').length : MAX_ITEMS;
  const elapsed = number(timerState.elapsed, 0, 86400);
  let previous = 0;
  const splits = list(timerState.splits, split => { number(split, previous, elapsed); previous = split; return split; }, checkpoints);
  check(timerState.endTick === null);
  const startTick = timerState.startTick === null ? null : number(timerState.startTick, 0, state.tick);
  check(timerState.phase === 'ready' ? startTick === null && elapsed === 0 && !splits.length : startTick !== null);
  const timer = {state: {phase: timerState.phase, startTick, endTick: null, splits,
    invalidReason: timerState.invalidReason === null ? null : text(timerState.invalidReason), elapsed},
  armed: bool(sourceTimer.armed), prehops: integer(sourceTimer.prehops)};
  const startPosition = snapshot.startPosition === null ? null : spawn(snapshot.startPosition);
  const startRegion = text(snapshot.startRegion, 512);
  if (map && startRegion) check(map.zones.some(zone => zone.kind === 'start' && startRegion.endsWith(':' + zone.id))
    || map.stages?.some((stage, index) => stage.start && startRegion === `${index + 1}:${stage.start.id}`));
  // Runtime retains its own trusted reset origin when restoring a shared snapshot.
  const result = {key, state, timer, checkpointSpeeds: list(snapshot.checkpointSpeeds, speed => number(speed, 0, 65534), checkpoints),
    startPosition, startJumps: integer(snapshot.startJumps),
    startGroundTime: number(snapshot.startGroundTime, 0, 86400), startHopWarned: bool(snapshot.startHopWarned),
    startRegion, rawJumpHeld: bool(snapshot.rawJumpHeld), stageStartRecovery: bool(snapshot.stageStartRecovery)};
  // Half a control frame, so a save and its envelope always fit in one.
  check(encoder.encode(JSON.stringify(result)).byteLength <= MAX_SNAPSHOT_BYTES);
  return result;
}
