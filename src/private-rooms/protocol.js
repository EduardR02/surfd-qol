export const VERSION = 1;
export const CLOSE = Object.freeze({invalid: 4002, gone: 4004, refused: 4008, congested: 4013});
// Everything a host may show its players. Guests replace or drop any other notice or close text.
export const ROOM_TEXTS = Object.freeze({
  closed: 'This private room has closed.',
  hostClosed: 'The host closed the private room.',
  connectionLost: 'Private room connection lost',
  cancelled: 'Room connection cancelled',
  invalidData: 'Invalid private room data',
  invalidHello: 'Invalid private room hello',
  full: 'This room is full.',
  congested: "Your connection couldn't keep up with the room.",
  unavailable: 'That player is not available to spectate.',
  noLongerAvailable: 'That player is no longer available to spectate.',
  hostChangesMaps: 'Only the private room host can change maps.',
  unknownMap: 'Map is not in the catalog.',
  tooFast: "You're sending messages too fast.",
  signInToChat: 'Sign in to send chat messages. You can still read chat.',
});
const roomTexts = new Set(Object.values(ROOM_TEXTS));
export function roomCloseReason(code, reason) {
  if (roomTexts.has(reason)) return reason;
  return code === CLOSE.gone ? ROOM_TEXTS.closed : code === CLOSE.invalid ? ROOM_TEXTS.invalidData : '';
}
export const MAX_CONTROL_BYTES = 65536;
export const MAX_ROOM_PLAYERS = 256;
// A player's JSON stays under 512 characters; the rest leaves room for the map catalog.
export const MAX_ROOM_MESSAGE_CHARS = MAX_ROOM_PLAYERS * 4096;
export const ROOM_CHUNK_CHARS = 4000;
export const MAX_ROOM_CHUNKS = Math.ceil(MAX_ROOM_MESSAGE_CHARS / ROOM_CHUNK_CHARS);
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
  for (let offset = 0; offset < text.length; offset += ROOM_CHUNK_CHARS) {
    frames.push(JSON.stringify({type: 'room-chunk', data: text.slice(offset, offset + ROOM_CHUNK_CHARS),
      final: offset + ROOM_CHUNK_CHARS >= text.length}));
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The site's username rules, which Guest_ names also meet.
export const isPlayerName = value => typeof value === 'string' && /^[A-Za-z0-9_-]{3,24}$/.test(value);
export const isGuestName = value => typeof value === 'string' && /^Guest_[0-9a-f]{5}$/.test(value);
export const isUserId = value => typeof value === 'string' && UUID.test(value);
export const isRoomName = value => typeof value === 'string' && value.endsWith("'s room") && isPlayerName(value.slice(0, -7));
const playerId = value => typeof value === 'string' && value.startsWith('private-') && UUID.test(value.slice(8));

export function catalogEntry(map) {
  return {id: map.id, title: map.title ?? map.name ?? map.id, ...(map.tier !== undefined ? {tier: map.tier} : {})};
}

function readPlayer(player) {
  requireValid(record(player) && typeof player.connectionId === 'string' && UUID.test(player.connectionId)
    && player.id === 'private-' + player.connectionId && uint(player.slot, 65535) && isPlayerName(player.name)
    && player.rank === 'Guest' && player.points === 0
    && (player.guest === true ? isGuestName(player.name) && player.userId === undefined
      : player.guest === false && (player.userId === undefined || isUserId(player.userId)))
    && typeof player.moderator === 'boolean' && typeof player.spectating === 'boolean'
    && validAppearance(player.appearance), 'Invalid room player');
  return {id: player.id, connectionId: player.connectionId, slot: player.slot, name: player.name,
    rank: 'Guest', points: 0, guest: player.guest, ...(player.userId === undefined ? {} : {userId: player.userId}),
    moderator: player.moderator, appearance: normalizeAppearance(player.appearance), spectating: player.spectating};
}

// Each host message is rebuilt from the fields the game reads, so nothing else a host sends reaches it.
// Maps come from the receiver's own catalog; host is true for the host's own view of its room.
export function createRoomFilter({roomId, maps = [], host = false}) {
  const catalog = new Map(maps.map(map => [map.id, catalogEntry(map)]));
  let own = null;
  function readPlayers(players) {
    requireValid(Array.isArray(players) && players.length <= MAX_ROOM_PLAYERS, 'Invalid room roster');
    const slots = new Set(), connections = new Set();
    let moderators = 0;
    const result = players.map(value => {
      const player = readPlayer(value);
      requireValid(!slots.has(player.slot) && !connections.has(player.connectionId), 'Duplicate room player');
      slots.add(player.slot);
      connections.add(player.connectionId);
      if (player.moderator) moderators++;
      requireValid(!player.moderator || own === null || (player.connectionId === own) === host, 'Invalid room moderator');
      return player;
    });
    requireValid(moderators <= 1, 'Invalid room moderator');
    return result;
  }
  function readState(state) {
    requireValid(record(state) && state.roomId === roomId && isRoomName(state.name) && catalog.has(state.mapId)
      && uint(state.epoch) && state.epoch > 0 && timestamp(state.startedAt)
      && state.endsAt === 0 && state.untimed === true
      && Array.isArray(state.recent) && state.recent.length <= 8 && state.recent.every(identifier)
      && record(state.nominations) && Object.keys(state.nominations).length === 0
      && Array.isArray(state.rtv) && state.rtv.length === 0
      && state.vote === null && state.nextMap === null, 'Invalid room state');
    return {roomId, name: state.name, mapId: state.mapId, mapTitle: catalog.get(state.mapId).title,
      epoch: state.epoch, startedAt: state.startedAt, endsAt: 0, untimed: true,
      recent: state.recent.filter(id => catalog.has(id)), nominations: {}, rtv: [], vote: null, nextMap: null};
  }
  return message => {
    requireValid(record(message), 'Invalid room message');
    switch (message.type) {
      case 'welcome': {
        const state = readState(message.state), player = readPlayer(message.player);
        own = player.connectionId;
        const players = readPlayers(message.players);
        const entry = players.find(value => value.connectionId === own);
        requireValid(entry && JSON.stringify(entry) === JSON.stringify(player), 'Invalid own room player');
        requireValid(Array.isArray(message.maps) && timestamp(message.serverTime)
          && message.spectatorStream === true && message.playtime === false && message.activityTracking === false
          && Array.isArray(message.recentResults) && message.recentResults.length === 0 && message.chatMute === null,
        'Invalid room welcome');
        const ids = new Set(message.maps.map(map => record(map) ? map.id : null));
        return {type: 'welcome', state, player, players, maps: [...ids].filter(id => catalog.has(id)).map(id => catalog.get(id)),
          serverTime: message.serverTime, spectatorStream: true, playtime: false, activityTracking: false,
          recentResults: [], chatMute: null};
      }
      case 'state':
        requireValid(timestamp(message.serverTime), 'Invalid room time');
        return {type: 'state', state: readState(message.state), serverTime: message.serverTime};
      case 'roster':
        return {type: 'roster', players: readPlayers(message.players)};
      case 'chat':
        requireValid(playerId(message.playerId) && isPlayerName(message.name) && textValue(message.text, 240)
          && (message.rank === undefined || message.rank === 'Guest')
          && (message.appearance === undefined || validAppearance(message.appearance)), 'Invalid room chat');
        return {type: 'chat', playerId: message.playerId, name: message.name, text: message.text,
          ...(message.rank === undefined ? {} : {rank: 'Guest'}),
          ...(message.appearance === undefined ? {} : {appearance: normalizeAppearance(message.appearance)})};
      case 'notice':
      case 'error': {
        requireValid(textValue(message.text, 4096)
          && (message.spectatorRequest === undefined || timestamp(message.spectatorRequest)), 'Invalid room notice');
        if (message.spectatorRequest === undefined) return roomTexts.has(message.text) ? {type: message.type, text: message.text} : null;
        // An error for the current spectate request is what stops spectating, so it keeps a text of our own.
        return {type: message.type, text: roomTexts.has(message.text) ? message.text : ROOM_TEXTS.unavailable,
          spectatorRequest: message.spectatorRequest};
      }
      case 'spectator-demand':
        requireValid(typeof message.active === 'boolean' && uint(message.count, MAX_ROOM_PLAYERS)
          && (message.count > 0) === message.active, 'Invalid spectator demand');
        return {type: 'spectator-demand', active: message.active, count: message.count};
      case 'context':
        requireValid(uint(message.epoch) && message.token === null, 'Invalid room context');
        return {type: 'context', epoch: message.epoch, token: null};
      default:
        throw new Error('Invalid room message type');
    }
  };
}

export function createRoomControlReader(filter = null) {
  let chunks = [], length = 0;
  const clear = () => { chunks = []; length = 0; };
  return {
    clear,
    read(text) {
      requireValid(typeof text === 'string' && text.length <= MAX_CONTROL_BYTES
        && encoder.encode(text).byteLength <= MAX_CONTROL_BYTES, 'Invalid room frame');
      let message;
      try { message = JSON.parse(text); } catch {
        requireValid(!chunks.length && (filter === null || text === 'pong'), 'Invalid room JSON');
        return text;
      }
      if (message?.type === 'room-chunk') {
        requireValid(typeof message.data === 'string' && message.data.length > 0
          && typeof message.final === 'boolean' && chunks.length < MAX_ROOM_CHUNKS
          && length + message.data.length <= MAX_ROOM_MESSAGE_CHARS, 'Invalid room chunk');
        chunks.push(message.data);
        length += message.data.length;
        if (!message.final) return null;
        text = chunks.join('');
        clear();
        message = JSON.parse(text);
        requireValid(message?.type !== 'room-chunk', 'Nested room chunk');
      } else requireValid(!chunks.length, 'Interrupted room chunks');
      if (!filter) return text;
      const rebuilt = filter(message);
      return rebuilt === null ? null : JSON.stringify(rebuilt);
    },
  };
}

export function validateRoomBinary(buffer) {
  const view = dataView(buffer, 4, 7804);
  if (view.getUint8(1) === 4) decodeSpectator(buffer, true);
  else decodeSnapshot(buffer);
}
