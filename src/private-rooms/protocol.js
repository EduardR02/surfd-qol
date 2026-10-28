export const VERSION = 1;
export const CLOSE = Object.freeze({invalid: 4002, gone: 4004});
export const MAX_CONTROL_BYTES = 65536;
// Large enough for every uint16 slot, including escaped names and appearances.
export const MAX_ROOM_MESSAGE_CHARS = 64 * 1024 * 1024;
export const MAX_SNAPSHOT_BLOCKS = 100;
export const POSE_HEADER_BYTES = 12;
export const POSE_SAMPLE_BYTES = 32;
export const SNAPSHOT_HEADER_BYTES = 4;
export const SNAPSHOT_BLOCK_BYTES = 14;
export const SPECTATOR_BYTES = 56;
export const SNAPSHOT_INTERVAL_MS = 50;
const encoder = new TextEncoder();
export const FLAGS = Object.freeze({grounded: 1, crouched: 2, teleport: 4, practice: 8, idle: 16, finished: 32});
export const DEFAULT_APPEARANCE = Object.freeze({title: '', titleColor: null, nameColor: null, revision: 0});
const PHASES = ['ready', 'running', 'finished'];
const uint = (value, max = 0xffffffff) => Number.isInteger(value) && value >= 0 && value <= max;
const bounded = (value, max) => Number.isFinite(value) && Math.abs(value) <= max;

function requireValid(valid, message) {
  if (!valid) throw new Error(message);
}

function validAppearance(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.title === 'string' && value.title.length <= 24 && value.title === value.title.trim()
    && /^[\p{L}\p{N} _.'!?-]*$/u.test(value.title)
    && [value.titleColor, value.nameColor].every(color => color === null || typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color))
    && Number.isSafeInteger(value.revision) && value.revision >= 0;
}

export function normalizeAppearance(value) {
  const valid = validAppearance(value);
  const appearance = valid ? value : DEFAULT_APPEARANCE;
  return {title: appearance.title, titleColor: appearance.titleColor, nameColor: appearance.nameColor, revision: appearance.revision};
}

export function validPose(pose) {
  return !!pose && uint(pose.time)
    && bounded(pose.x, 131072) && bounded(pose.y, 131072) && bounded(pose.z, 131072)
    && bounded(pose.vx, 32767) && bounded(pose.vy, 32767) && bounded(pose.vz, 32767)
    && bounded(pose.yaw, 360) && bounded(pose.pitch, 90) && uint(pose.flags, 63)
    && Number.isFinite(pose.seconds) && pose.seconds >= 0 && pose.seconds <= 86400;
}

function writePose(view, offset, pose) {
  requireValid(validPose(pose), 'Invalid pose');
  view.setUint32(offset, pose.time, true);
  view.setFloat32(offset + 4, pose.x, true);
  view.setFloat32(offset + 8, pose.y, true);
  view.setFloat32(offset + 12, pose.z, true);
  view.setInt16(offset + 16, Math.round(pose.vx), true);
  view.setInt16(offset + 18, Math.round(pose.vy), true);
  view.setInt16(offset + 20, Math.round(pose.vz), true);
  view.setUint16(offset + 22, Math.round((pose.yaw % 360 + 360) % 360 / 360 * 65535), true);
  view.setInt16(offset + 24, Math.round(pose.pitch / 90 * 32767), true);
  view.setUint8(offset + 26, pose.flags);
  view.setFloat32(offset + 28, pose.seconds, true);
}

function readPose(view, offset) {
  const pose = {
    time: view.getUint32(offset, true),
    x: view.getFloat32(offset + 4, true), y: view.getFloat32(offset + 8, true), z: view.getFloat32(offset + 12, true),
    vx: view.getInt16(offset + 16, true), vy: view.getInt16(offset + 18, true), vz: view.getInt16(offset + 20, true),
    yaw: view.getUint16(offset + 22, true) / 65535 * 360,
    pitch: view.getInt16(offset + 24, true) / 32767 * 90,
    flags: view.getUint8(offset + 26), seconds: view.getFloat32(offset + 28, true),
  };
  requireValid(validPose(pose) && view.getUint8(offset + 27) === 0, 'Invalid pose');
  return pose;
}

function validateBatch(batch) {
  requireValid(batch && uint(batch.sequence) && uint(batch.epoch)
    && Array.isArray(batch.samples) && batch.samples.length >= 1 && batch.samples.length <= 2, 'Invalid batch');
}

function dataView(buffer, min, max = min) {
  requireValid(buffer instanceof ArrayBuffer && buffer.byteLength >= min && buffer.byteLength <= max, 'Invalid packet size');
  return new DataView(buffer);
}

export function encodePoseBatch(batch) {
  validateBatch(batch);
  const buffer = new ArrayBuffer(POSE_HEADER_BYTES + POSE_SAMPLE_BYTES * batch.samples.length), view = new DataView(buffer);
  view.setUint8(0, VERSION);
  view.setUint8(1, 1);
  view.setUint8(2, batch.samples.length);
  view.setUint32(4, batch.sequence, true);
  view.setUint32(8, batch.epoch, true);
  batch.samples.forEach((pose, index) => writePose(view, 12 + index * 32, pose));
  return buffer;
}

export function decodePoseBatch(buffer) {
  const view = dataView(buffer, 12, 76), count = view.getUint8(2);
  requireValid(view.getUint8(0) === VERSION && view.getUint8(1) === 1 && view.getUint8(3) === 0
    && count >= 1 && count <= 2 && buffer.byteLength === 12 + count * 32, 'Invalid pose header');
  const samples = [];
  for (let index = 0; index < count; index++) samples.push(readPose(view, 12 + index * 32));
  return {sequence: view.getUint32(4, true), epoch: view.getUint32(8, true), samples};
}

export function encodeSnapshot(blocks) {
  requireValid(Array.isArray(blocks) && blocks.length <= MAX_SNAPSHOT_BLOCKS, 'Invalid snapshot');
  let length = SNAPSHOT_HEADER_BYTES;
  const slots = new Set();
  for (const block of blocks) {
    validateBatch(block);
    requireValid(uint(block.slot, 65535) && !slots.has(block.slot), 'Invalid snapshot slot');
    slots.add(block.slot);
    length += SNAPSHOT_BLOCK_BYTES + block.samples.length * POSE_SAMPLE_BYTES;
  }
  const buffer = new ArrayBuffer(length), view = new DataView(buffer);
  view.setUint8(0, VERSION);
  view.setUint8(1, 2);
  view.setUint16(2, blocks.length, true);
  let offset = 4;
  for (const block of blocks) {
    view.setUint16(offset, block.slot, true);
    view.setUint32(offset + 2, block.sequence, true);
    view.setUint32(offset + 6, block.epoch, true);
    view.setUint8(offset + 10, block.samples.length);
    offset += 14;
    for (const pose of block.samples) {
      writePose(view, offset, pose);
      offset += 32;
    }
  }
  return buffer;
}

export function decodeSnapshot(buffer) {
  const view = dataView(buffer, 4, 7804), count = view.getUint16(2, true);
  requireValid(view.getUint8(0) === VERSION && view.getUint8(1) === 2 && count <= 100, 'Invalid snapshot header');
  const blocks = [], slots = new Set();
  let offset = 4;
  for (let index = 0; index < count; index++) {
    requireValid(offset + 14 <= buffer.byteLength, 'Truncated block');
    const slot = view.getUint16(offset, true), sequence = view.getUint32(offset + 2, true);
    const epoch = view.getUint32(offset + 6, true), size = view.getUint8(offset + 10);
    requireValid(!slots.has(slot) && size >= 1 && size <= 2 && view.getUint8(offset + 11) === 0
      && view.getUint16(offset + 12, true) === 0, 'Invalid block');
    slots.add(slot);
    offset += 14;
    requireValid(offset + size * 32 <= buffer.byteLength, 'Truncated samples');
    const samples = [];
    for (let sample = 0; sample < size; sample++) samples.push(readPose(view, offset + sample * 32));
    offset += size * 32;
    blocks.push({slot, sequence, epoch, samples});
  }
  requireValid(offset === buffer.byteLength, 'Trailing snapshot data');
  return blocks;
}

function validSpectator(packet) {
  const pose = packet?.pose;
  return pose && uint(packet.slot, 65535) && uint(packet.sequence) && uint(packet.epoch) && validPose(pose)
    && Number.isFinite(pose.eyeHeight) && pose.eyeHeight >= 0 && pose.eyeHeight <= 128
    && (pose.inputs === undefined || uint(pose.inputs, 63))
    && (pose.inputPresses === undefined || pose.inputs !== undefined && uint(pose.inputPresses, 63))
    && PHASES.includes(pose.phase) && typeof pose.untimed === 'boolean'
    && uint(pose.checkpoints, 1024) && uint(pose.stage, 1024);
}

export function encodeSpectator(packet, forwarded = false) {
  requireValid(validSpectator(packet), 'Invalid spectator state');
  const buffer = new ArrayBuffer(SPECTATOR_BYTES), view = new DataView(buffer), pose = packet.pose;
  view.setUint8(0, VERSION);
  view.setUint8(1, forwarded ? 4 : 3);
  view.setUint16(2, packet.slot, true);
  view.setUint32(4, packet.sequence, true);
  view.setUint32(8, packet.epoch, true);
  writePose(view, 12, pose);
  view.setFloat32(44, pose.eyeHeight, true);
  view.setUint8(48, PHASES.indexOf(pose.phase));
  view.setUint8(49, Number(pose.untimed));
  view.setUint16(50, pose.checkpoints, true);
  view.setUint16(52, pose.stage, true);
  if (pose.inputs !== undefined) {
    view.setUint8(54, 128 | pose.inputs);
    view.setUint8(55, pose.inputPresses ?? 0);
  }
  return buffer;
}

export function decodeSpectator(buffer, forwarded = false) {
  const view = dataView(buffer, 56), inputs = view.getUint8(54), presses = view.getUint8(55);
  requireValid(view.getUint8(0) === VERSION && view.getUint8(1) === (forwarded ? 4 : 3)
    && view.getUint8(48) <= 2 && view.getUint8(49) <= 1
    && (inputs === 0 || (inputs & 128) !== 0) && !(inputs & 64)
    && presses <= 63 && (inputs !== 0 || presses === 0), 'Invalid spectator header');
  const packet = {slot: view.getUint16(2, true), sequence: view.getUint32(4, true), epoch: view.getUint32(8, true), pose: {
    ...readPose(view, 12), eyeHeight: view.getFloat32(44, true), phase: PHASES[view.getUint8(48)],
    untimed: !!view.getUint8(49), checkpoints: view.getUint16(50, true), stage: view.getUint16(52, true),
    ...(inputs & 128 ? {inputs: inputs & 63, inputPresses: presses} : {}),
  }};
  requireValid(validSpectator(packet), 'Invalid spectator state');
  return packet;
}

// The sender's bytes go on unchanged (no second rounding); only the slot is the host's.
export function relayPose(buffer, slot) {
  const batch = decodePoseBatch(buffer);
  requireValid(uint(slot, 65535), 'Invalid slot');
  const output = new ArrayBuffer(buffer.byteLength + 6), view = new DataView(output);
  view.setUint8(0, VERSION);
  view.setUint8(1, 2);
  view.setUint16(2, 1, true);
  view.setUint16(4, slot, true);
  view.setUint32(6, batch.sequence, true);
  view.setUint32(10, batch.epoch, true);
  view.setUint8(14, batch.samples.length);
  new Uint8Array(output, 18).set(new Uint8Array(buffer, 12));
  return {buffer: output, epoch: batch.epoch, sequence: batch.sequence};
}

export function relaySpectator(buffer, slot) {
  const packet = decodeSpectator(buffer);
  requireValid(uint(slot, 65535), 'Invalid slot');
  const output = buffer.slice(0), view = new DataView(output);
  view.setUint8(1, 4);
  view.setUint16(2, slot, true);
  return {buffer: output, epoch: packet.epoch};
}

export function encodeControlFrames(message) {
  const text = typeof message === 'string' ? message : JSON.stringify(message);
  if (text.length <= MAX_CONTROL_BYTES && controlWireSize(text) <= MAX_CONTROL_BYTES) return [text];
  const frames = [];
  // The transport JSON wrapper escapes these chunks a second time.
  for (let offset = 0; offset < text.length; offset += 4000) {
    frames.push(JSON.stringify({type: 'room-chunk', data: text.slice(offset, offset + 4000), final: offset + 4000 >= text.length}));
  }
  return frames;
}

export function decodeControl(text) {
  requireValid(typeof text === 'string' && text.length <= MAX_CONTROL_BYTES
    && encoder.encode(text).byteLength <= MAX_CONTROL_BYTES, 'Invalid room data');
  if (text === 'ping') return {type: 'ping'};
  const message = JSON.parse(text);
  requireValid(message && typeof message === 'object' && !Array.isArray(message) && typeof message.type === 'string', 'Invalid room message');
  switch (message.type) {
    case 'chat':
      requireValid(typeof message.text === 'string' && message.text.trim().length > 0, 'Invalid chat');
      return {type: 'chat', text: message.text.trim().slice(0, 240)};
    case 'change-map':
      requireValid(typeof message.mapId === 'string' && message.mapId.length > 0, 'Invalid map');
      return {type: 'change-map', mapId: message.mapId};
    case 'spectate':
      requireValid((message.connectionId === null || typeof message.connectionId === 'string')
        && Number.isSafeInteger(message.request) && message.request >= 0, 'Invalid spectator request');
      return {type: 'spectate', connectionId: message.connectionId, request: message.request};
  }
  return {type: message.type};
}

export function controlWireSize(text) {
  return encoder.encode(JSON.stringify({type: 'data', data: text})).byteLength;
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const textValue = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0);
const identifier = value => textValue(value, 256);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;

function validatePlayer(player) {
  requireValid(record(player) && identifier(player.id) && identifier(player.connectionId)
    && uint(player.slot, 65535) && textValue(player.name, 24)
    && player.rank === 'Guest' && player.points === 0 && player.guest === false
    && typeof player.moderator === 'boolean' && typeof player.spectating === 'boolean'
    && validAppearance(player.appearance), 'Invalid room player');
}

function validatePlayers(players) {
  requireValid(Array.isArray(players) && players.length <= 65536, 'Invalid room roster');
  const slots = new Set(), connections = new Set(), ids = new Set();
  for (const player of players) {
    validatePlayer(player);
    requireValid(!slots.has(player.slot) && !connections.has(player.connectionId) && !ids.has(player.id), 'Duplicate room player');
    slots.add(player.slot);
    connections.add(player.connectionId);
    ids.add(player.id);
  }
}

function validateState(state, roomId) {
  requireValid(record(state) && state.roomId === roomId && textValue(state.name, 256)
    && identifier(state.mapId) && textValue(state.mapTitle, 1024)
    && uint(state.epoch) && state.epoch > 0 && timestamp(state.startedAt)
    && state.endsAt === 0 && state.untimed === true
    && Array.isArray(state.recent) && state.recent.length <= 8 && state.recent.every(identifier)
    && record(state.nominations) && Object.keys(state.nominations).length === 0
    && Array.isArray(state.rtv) && state.rtv.length === 0
    && state.vote === null && state.nextMap === null, 'Invalid room state');
}

// Private peers cannot enable public-server services or supply ranked tokens.
export function validateRoomMessage(message, roomId) {
  requireValid(record(message), 'Invalid room message');
  switch (message.type) {
    case 'welcome': {
      validateState(message.state, roomId);
      validatePlayer(message.player);
      validatePlayers(message.players);
      const own = message.players.find(player => player.connectionId === message.player.connectionId);
      requireValid(own && Object.keys(message.player).every(key => JSON.stringify(message.player[key]) === JSON.stringify(own[key])),
        'Invalid own room player');
      requireValid(Array.isArray(message.maps) && message.maps.length <= 65536, 'Invalid room maps');
      const maps = new Set();
      for (const map of message.maps) {
        requireValid(record(map) && identifier(map.id) && textValue(map.title, 1024)
          && (map.tier === undefined || uint(map.tier, 8) && map.tier > 0) && !maps.has(map.id), 'Invalid room map');
        maps.add(map.id);
      }
      requireValid(maps.has(message.state.mapId) && timestamp(message.serverTime)
        && message.spectatorStream === true && message.playtime === false && message.activityTracking === false
        && Array.isArray(message.recentResults) && message.recentResults.length === 0 && message.chatMute === null,
      'Invalid room welcome');
      break;
    }
    case 'state':
      validateState(message.state, roomId);
      requireValid(timestamp(message.serverTime), 'Invalid room time');
      break;
    case 'roster':
      validatePlayers(message.players);
      break;
    case 'chat':
      requireValid(identifier(message.playerId) && textValue(message.name, 24) && textValue(message.text, 240)
        && (message.rank === undefined || message.rank === 'Guest')
        && (message.appearance === undefined || validAppearance(message.appearance)), 'Invalid room chat');
      break;
    case 'notice':
    case 'error':
      requireValid(textValue(message.text, 4096) && (message.spectatorRequest === undefined || timestamp(message.spectatorRequest)), 'Invalid room notice');
      break;
    case 'spectator-demand':
      requireValid(typeof message.active === 'boolean' && uint(message.count, 65535)
        && (message.count > 0) === message.active, 'Invalid spectator demand');
      break;
    case 'context':
      requireValid(uint(message.epoch) && message.token === null, 'Invalid room context');
      break;
    default:
      throw new Error('Invalid room message type');
  }
}

export function createRoomControlReader(validate = null) {
  let chunks = [], length = 0;
  const clear = () => { chunks = []; length = 0; };
  return {
    clear,
    read(text) {
      requireValid(typeof text === 'string' && text.length <= MAX_CONTROL_BYTES
        && encoder.encode(text).byteLength <= MAX_CONTROL_BYTES, 'Invalid room frame');
      let message;
      try { message = JSON.parse(text); } catch {
        requireValid(!chunks.length && (validate === null || text === 'pong'), 'Invalid room JSON');
        return text;
      }
      if (message?.type === 'room-chunk') {
        requireValid(typeof message.data === 'string' && message.data.length > 0
          && typeof message.final === 'boolean' && chunks.length < 32768
          && length + message.data.length <= MAX_ROOM_MESSAGE_CHARS, 'Invalid room chunk');
        chunks.push(message.data);
        length += message.data.length;
        if (!message.final) return null;
        text = chunks.join('');
        clear();
        message = JSON.parse(text);
        requireValid(message?.type !== 'room-chunk', 'Nested room chunk');
      } else requireValid(!chunks.length, 'Interrupted room chunks');
      validate?.(message);
      return text;
    },
  };
}

export function validateRoomBinary(buffer) {
  const view = dataView(buffer, 4, 7804);
  if (view.getUint8(1) === 4) decodeSpectator(buffer, true);
  else decodeSnapshot(buffer);
}
