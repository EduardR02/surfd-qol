import {describe, expect, test} from 'bun:test';
import {DEFAULT_APPEARANCE, RANKS, rankFor, rankTable, DEFAULT_MAX_PLAYERS, MAX_CONTROL_BYTES, MAX_ROOM_CHUNKS, MAX_ROOM_MESSAGE_CHARS, MAX_ROOM_PLAYERS, MAX_SNAPSHOT_BLOCKS, controlWireSize, createRoomControlReader, createRoomFilter, decodeControl, decodePoseBatch, decodeSnapshot, decodeSpectator, encodeControlFrames, encodePoseBatch, encodeSnapshot, encodeSpectator, isMaxPlayers, isRoomName, normalizeAppearance, normalizeRoomName, relayPose, relaySpectator, roomNameProblem, validPose} from '../src/private-rooms/protocol.js';

const pose = {time: 0xffffffff, x: 131072, y: -131072, z: 0, vx: 32767, vy: -32767, vz: 0, yaw: -90, pitch: -90, flags: 63, seconds: 86400};
const batch = {sequence: 0xffffffff, epoch: 0xffffffff, samples: [pose]};
const detailed = {...pose, eyeHeight: 128, phase: 'finished', untimed: true, checkpoints: 1024, stage: 1024, inputs: 63, inputPresses: 63};
const packet = {sequence: 0xffffffff, epoch: 0xffffffff, slot: MAX_ROOM_PLAYERS - 1, pose: detailed};
function changed(buffer, offset, value, method = 'setUint8') {
  const copy = buffer.slice(0);
  new DataView(copy)[method](offset, value, true);
  return copy;
}

describe('private room names', () => {
  test('normalizes surrounding whitespace and repeated literal spaces', () => {
    expect(normalizeRoomName("  My   room#1: (Main)!  ")).toBe('My room#1: (Main)!');
    expect(normalizeRoomName('\t My room \n')).toBe('My room');
    expect(normalizeRoomName('My\troom')).toBe('My\troom');
    for (const value of [undefined, null, 16, {}, []]) expect(normalizeRoomName(value)).toBe('');
  });

  test('accepts free names and the shared ASCII punctuation at canonical lengths', () => {
    for (const name of ['abc', 'A'.repeat(32), "Host's room", "A-z_0. !?&#:()"]) {
      expect(roomNameProblem(name)).toBeNull();
      expect(isRoomName(name)).toBe(true);
    }
    expect(roomNameProblem('  My   room  ')).toBeNull();
    for (const name of [' My room', 'My room ', 'My  room']) {
      expect(isRoomName(name)).toBe(false);
    }
  });

  test('reports exact length, character and impersonation errors', () => {
    for (const value of [undefined, null, 3, '', '  ', 'ab', 'A'.repeat(33)]) {
      expect(roomNameProblem(value)).toBe('Room names need 3–32 characters.');
      expect(isRoomName(value)).toBe(false);
    }
    for (const name of ['My\troom', 'My\nroom', 'My\u00a0room', 'Café', '<room>', 'room/name', 'room"name', 'room\\name']) {
      expect(roomNameProblem(name)).toBe('Use letters, numbers, spaces and simple punctuation.');
      expect(isRoomName(name)).toBe(false);
    }
    for (const name of ['Surfd', "surFD's room", 'UnoFFicial room', 'OFFICIAL']) {
      expect(roomNameProblem(name)).toBe("Room names can't include Surfd or official.");
      expect(isRoomName(name)).toBe(false);
    }
  });
});

describe('private room binary protocol', () => {
  test('compact pose roundtrips native quantization and extrema', () => {
    const encoded = encodePoseBatch(batch), decoded = decodePoseBatch(encoded);
    expect(encoded.byteLength).toBe(44);
    expect([...new Uint8Array(encoded, 0, 4)]).toEqual([1, 1, 1, 0]);
    expect(decoded).toMatchObject({sequence: 0xffffffff, epoch: 0xffffffff, samples: [{...pose, yaw: decoded.samples[0].yaw}]});
    expect(decoded.samples[0].yaw).toBeCloseTo(270, 2);
    const two = encodePoseBatch({...batch, samples: [pose, {...pose, vx: 1.6, pitch: 90, yaw: 360}]});
    expect(two.byteLength).toBe(76);
    expect(decodePoseBatch(two).samples[1]).toMatchObject({vx: 2, pitch: 90, yaw: 0});
  });

  test('rejects invalid pose values before encoding and on binary input', () => {
    for (const invalid of [{time: -1}, {time: 0x100000000}, {x: 131073}, {y: Infinity}, {z: NaN}, {vx: 32768}, {vy: -32768}, {yaw: 361}, {pitch: -91}, {flags: 64}, {seconds: -1}, {seconds: 86401}]) {
      expect(validPose({...pose, ...invalid})).toBe(false);
      expect(() => encodePoseBatch({...batch, samples: [{...pose, ...invalid}]})).toThrow();
    }
    const encoded = encodePoseBatch(batch);
    for (const [offset, value, method] of [[16, NaN, 'setFloat32'], [28, -32768, 'setInt16'], [36, -32768, 'setInt16'], [38, 64], [39, 1], [40, -1, 'setFloat32']]) {
      expect(() => decodePoseBatch(changed(encoded, offset, value, method))).toThrow();
    }
  });

  test('checks pose size, version, type, count, reserved bytes and batch integers', () => {
    const encoded = encodePoseBatch(batch);
    for (const [offset, value] of [[0, 2], [1, 2], [2, 0], [2, 3], [3, 1]]) expect(() => decodePoseBatch(changed(encoded, offset, value))).toThrow();
    for (const size of [0, 11, 12, 43, 45, 77]) expect(() => decodePoseBatch(new ArrayBuffer(size))).toThrow();
    for (const invalid of [{sequence: -1}, {epoch: 0x100000000}, {samples: []}, {samples: [pose, pose, pose]}]) expect(() => encodePoseBatch({...batch, ...invalid})).toThrow();
    expect(() => decodePoseBatch(new Uint8Array(encoded))).toThrow();
  });

  test('snapshots have native 14-byte blocks, support empty/max batches, and reject duplicate slots', () => {
    expect(decodeSnapshot(encodeSnapshot([]))).toEqual([]);
    const blocks = Array.from({length: MAX_SNAPSHOT_BLOCKS}, (_, slot) => ({...batch, slot, samples: [pose, pose]}));
    const encoded = encodeSnapshot(blocks);
    expect(encoded.byteLength).toBe(4996);
    expect(decodeSnapshot(encoded)).toHaveLength(64);
    expect(() => encodeSnapshot([...blocks, blocks[0]])).toThrow();
    expect(() => encodeSnapshot([{...batch, slot: 0}, {...batch, slot: 0}])).toThrow();
    for (const slot of [-1, MAX_ROOM_PLAYERS, 65535, 65536, 1.5]) expect(() => encodeSnapshot([{...batch, slot}])).toThrow();
    const two = encodeSnapshot([{...batch, slot: 0}, {...batch, slot: 1}]);
    expect(() => decodeSnapshot(changed(two, 50, 0, 'setUint16'))).toThrow();
    const one = encodeSnapshot([{...batch, slot: 0}]);
    expect(() => decodeSnapshot(changed(one, 4, MAX_ROOM_PLAYERS, 'setUint16'))).toThrow('Invalid block');
    for (const [offset, value] of [[0, 0], [1, 1], [2, MAX_SNAPSHOT_BLOCKS + 1], [14, 0], [14, 3], [15, 1], [16, 1], [17, 1]]) expect(() => decodeSnapshot(changed(one, offset, value))).toThrow();
    expect(() => decodeSnapshot(one.slice(0, 17))).toThrow();
    expect(() => decodeSnapshot(one.slice(0, -1))).toThrow();
    const trailing = new Uint8Array(one.byteLength + 1);
    trailing.set(new Uint8Array(one));
    expect(() => decodeSnapshot(trailing.buffer)).toThrow();
  });

  test('spectator layout includes uint16 slot, timer detail and optional input bits', () => {
    const encoded = encodeSpectator(packet);
    expect(encoded.byteLength).toBe(56);
    expect([...new Uint8Array(encoded, 0, 4)]).toEqual([1, 3, 63, 0]);
    expect([...new Uint8Array(encoded, 48)]).toEqual([2, 1, 0, 4, 0, 4, 191, 63]);
    expect(decodeSpectator(encoded)).toMatchObject({slot: 63, sequence: 0xffffffff, epoch: 0xffffffff, pose: {eyeHeight: 128, phase: 'finished', untimed: true, checkpoints: 1024, stage: 1024, inputs: 63, inputPresses: 63}});
    const noInputs = encodeSpectator({...packet, pose: {...detailed, inputs: undefined, inputPresses: undefined}}, true);
    expect(decodeSpectator(noInputs, true).pose.inputs).toBeUndefined();
    expect(new Uint8Array(noInputs)[54]).toBe(0);
    const zeroInputs = encodeSpectator({...packet, pose: {...detailed, inputs: 0, inputPresses: undefined}});
    expect(new Uint8Array(zeroInputs)[54]).toBe(128);
    expect(decodeSpectator(zeroInputs).pose.inputPresses).toBe(0);
  });

  test('rejects every spectator header and detailed state boundary violation', () => {
    const encoded = encodeSpectator(packet);
    for (const [offset, value, method] of [[0, 2], [1, 4], [44, 129, 'setFloat32'], [44, NaN, 'setFloat32'], [48, 3], [49, 2], [50, 1025, 'setUint16'], [52, 1025, 'setUint16'], [54, 1], [54, 192], [55, 64]]) expect(() => decodeSpectator(changed(encoded, offset, value, method))).toThrow();
    expect(() => decodeSpectator(changed(encoded, 54, 0))).toThrow();
    expect(() => decodeSpectator(encoded.slice(0, 55))).toThrow();
    expect(() => decodeSpectator(new ArrayBuffer(57))).toThrow();
    for (const invalid of [{eyeHeight: -1}, {phase: 'invalid'}, {untimed: 1}, {checkpoints: -1}, {stage: 1025}, {inputs: 64}, {inputPresses: 64}, {inputs: undefined}]) expect(() => encodeSpectator({...packet, pose: {...detailed, ...invalid}})).toThrow();
    for (const slot of [-1, MAX_ROOM_PLAYERS, 65535, 65536, 1.5]) expect(() => encodeSpectator({...packet, slot})).toThrow();
    expect(() => decodeSpectator(changed(encoded, 2, MAX_ROOM_PLAYERS, 'setUint16'))).toThrow('Invalid spectator state');
  });

  test('relay assigns trusted slots without mutating or requantizing source bytes', () => {
    const source = encodePoseBatch(batch), before = source.slice(0), relayed = relayPose(source, 7);
    expect(decodeSnapshot(relayed.buffer)[0]).toMatchObject({slot: 7, epoch: batch.epoch, sequence: batch.sequence});
    expect([...new Uint8Array(relayed.buffer, 18)]).toEqual([...new Uint8Array(source, 12)]);
    expect(source).toEqual(before);
    const spectator = encodeSpectator(packet), forwarded = relaySpectator(spectator, 8);
    expect(decodeSpectator(forwarded.buffer, true).slot).toBe(8);
    expect(new Uint8Array(spectator)[1]).toBe(3);
    expect([...new Uint8Array(forwarded.buffer, 4)]).toEqual([...new Uint8Array(spectator, 4)]);
    for (const slot of [-1, MAX_ROOM_PLAYERS, 65535, 65536, 1.5]) {
      expect(() => relayPose(source, slot)).toThrow();
      expect(() => relaySpectator(spectator, slot)).toThrow();
    }
  });
});

const uuid = slot => '00000000-0000-4000-8000-' + String(slot).padStart(12, '0');
const filter = () => createRoomFilter({roomId: 'room'});

describe('private room control boundaries', () => {
  test('parses only bounded object JSON or the native ping literal', () => {
    expect(decodeControl('ping')).toEqual({type: 'ping'});
    expect(decodeControl('{"type":"chat","text":"hello"}')).toMatchObject({type: 'chat', text: 'hello'});
    for (const input of [null, '{}', 'null', '[]', '1', '{', ' '.repeat(65537), '{"type":"chat","text":" "}', '{"type":"change-map","mapId":0}', '{"type":"spectate","connectionId":null,"request":-1}']) expect(() => decodeControl(input)).toThrow();
    expect(decodeControl('{"type":"spectate","connectionId":null,"request":1}').connectionId).toBeNull();
    expect(decodeControl('{"type":"refresh"}')).toEqual({type: 'refresh'});
    expect(decodeControl('{"type":"moderate","playerId":"private-x","action":"ban","minutes":60}')).toEqual({type: 'moderate', playerId: 'private-x', action: 'ban'});
    expect(() => decodeControl('{"type":"moderate","playerId":"private-x","action":"mute"}')).toThrow();
  });
  test('trims chat and drops obsolete fields', () => {
    expect(decodeControl(JSON.stringify({type: 'chat', text: ' ' + 'x'.repeat(1000) + ' ', memory: 'unused'}))).toEqual({type: 'chat', text: 'x'.repeat(240)});
    expect(decodeControl(JSON.stringify({type: 'context', memory: {retained: false}}))).toEqual({type: 'context'});
    expect(decodeControl(JSON.stringify({type: 'spectate', connectionId: null, request: 1, memory: 'unused'}))).toEqual({type: 'spectate', connectionId: null, request: 1});
  });

  test('bounds UTF-8 control input', () => {
    const prefix = JSON.stringify({type: 'chat', text: ''}).length;
    expect(decodeControl(JSON.stringify({type: 'chat', text: 'x'.repeat(MAX_CONTROL_BYTES - prefix)})).text).toHaveLength(240);
    expect(() => decodeControl(JSON.stringify({type: 'chat', text: 'x'.repeat(MAX_CONTROL_BYTES - prefix + 1)}))).toThrow();
    expect(() => decodeControl(JSON.stringify({type: 'chat', text: '名'.repeat(22000)}))).toThrow();
  });

  test('keeps exact-size transport envelopes intact', () => {
    const base = {type: 'roster', text: ''};
    const message = {...base, text: 'x'.repeat(MAX_CONTROL_BYTES - controlWireSize(JSON.stringify(base)))};
    expect(encodeControlFrames(message)).toEqual([JSON.stringify(message)]);
    expect(encodeControlFrames({...message, text: message.text + 'x'}).length).toBeGreaterThan(1);
  });

  test('chunks escaped and Unicode controls losslessly', () => {
    const encoder = new TextEncoder();
    for (const type of ['welcome', 'roster']) {
      const message = {type, text: '名😀\"\\\\\\n\\t'.repeat(12000)};
      const frames = encodeControlFrames(message);
      expect(frames.length).toBeGreaterThan(1);
      for (const frame of frames) {
        expect(frame.length).toBeLessThanOrEqual(MAX_CONTROL_BYTES);
        expect(encoder.encode(frame).byteLength).toBeLessThanOrEqual(MAX_CONTROL_BYTES);
        expect(controlWireSize(frame)).toBeLessThanOrEqual(MAX_CONTROL_BYTES);
      }
      const parts = frames.map(JSON.parse);
      expect(parts.every(part => part.type === 'room-chunk')).toBe(true);
      expect(parts.filter(part => part.final)).toEqual([parts.at(-1)]);
      expect(JSON.parse(parts.map(part => part.data).join(''))).toEqual(message);
    }
  });
  test('validates the exact native appearance grammar', () => {
    const appearance = {title: 'Élite 2!?', titleColor: '#ABC123', nameColor: '#000000', revision: 0};
    expect(normalizeAppearance(appearance)).toEqual(appearance);
    for (const invalid of [{title: 'x'.repeat(25)}, {title: '<b>'}, {title: ' padded'}, {titleColor: 'red'}, {nameColor: undefined}, {revision: -1}, {revision: 0.5}]) expect(normalizeAppearance({...appearance, ...invalid}).title).toBe('');
  });
  test('validates a full 64-player roster through bounded control frames', () => {
    const players = Array.from({length: MAX_ROOM_PLAYERS}, (_, slot) => ({
      id: 'private-' + uuid(slot), connectionId: uuid(slot), slot,
      name: 'Player_' + slot, rank: 'Unranked', points: 0, guest: false,
      moderator: false, spectating: false, appearance: DEFAULT_APPEARANCE,
    }));
    const message = {type: 'roster', players};
    const reader = createRoomControlReader(filter());
    let received = null;
    for (const frame of encodeControlFrames(message)) {
      expect(controlWireSize(frame)).toBeLessThanOrEqual(MAX_CONTROL_BYTES);
      const value = reader.read(frame);
      if (value !== null) {
        expect(received).toBeNull();
        received = JSON.parse(value);
      }
    }
    expect(received).toEqual(message);
  });

  test('refuses rosters over 64 players and slots outside the room limit', () => {
    const player = slot => ({id: 'private-' + uuid(slot), connectionId: uuid(slot), slot, name: 'Guest', rank: 'Unranked',
      points: 0, guest: false, moderator: false, spectating: false, appearance: DEFAULT_APPEARANCE});
    const roster = length => ({type: 'roster', players: Array.from({length}, (_, slot) => player(slot))});
    expect(() => filter()(roster(MAX_ROOM_PLAYERS))).not.toThrow();
    expect(() => filter()(roster(MAX_ROOM_PLAYERS + 1))).toThrow('Invalid room roster');
    for (const slot of [-1, MAX_ROOM_PLAYERS, 65535, 65536, 1.5]) {
      expect(() => filter()({type: 'roster', players: [player(slot)]})).toThrow('Invalid room player');
    }
  });

  test('a host cannot make a guest assemble more than 256 KiB', () => {
    const message = {type: 'notice', text: 'x'.repeat(MAX_ROOM_MESSAGE_CHARS)};
    const reader = createRoomControlReader(filter());
    let assembled = 0;
    expect(() => {
      for (const frame of encodeControlFrames(message)) {
        reader.read(frame);
        assembled += JSON.parse(frame).data.length;
      }
    }).toThrow('Invalid room chunk');
    expect(assembled).toBeLessThanOrEqual(MAX_ROOM_MESSAGE_CHARS);
  });

  test('shares exact room, message and capacity bounds', () => {
    expect(MAX_ROOM_PLAYERS).toBe(64);
    expect(DEFAULT_MAX_PLAYERS).toBe(16);
    expect(MAX_SNAPSHOT_BLOCKS).toBe(64);
    expect(MAX_ROOM_MESSAGE_CHARS).toBe(262144);
    expect(MAX_ROOM_CHUNKS).toBe(66);
    for (const value of [2, DEFAULT_MAX_PLAYERS, MAX_ROOM_PLAYERS]) expect(isMaxPlayers(value)).toBe(true);
    for (const value of [undefined, null, 0, 1, 65, 2.5, NaN, Infinity, '16']) expect(isMaxPlayers(value)).toBe(false);
  });

  test('requires and rebuilds state capacity without restricting an existing roster to it', () => {
    const state = {roomId: 'room', name: 'My room', visibility: 'private', maxPlayers: DEFAULT_MAX_PLAYERS,
      mapId: 'one', mapTitle: 'One', epoch: 1, startedAt: 1, endsAt: 0, untimed: true,
      recent: [], nominations: {}, rtv: [], vote: null, nextMap: null};
    const read = createRoomFilter({roomId: 'room', maps: [{id: 'one', title: 'One'}]});
    for (const maxPlayers of [2, DEFAULT_MAX_PLAYERS, MAX_ROOM_PLAYERS]) {
      expect(read({type: 'state', state: {...state, maxPlayers, ignored: true}, serverTime: 1}))
        .toEqual({type: 'state', state: {...state, maxPlayers}, serverTime: 1});
    }
    for (const maxPlayers of [undefined, null, 1, 65, 2.5, '16']) {
      expect(() => read({type: 'state', state: {...state, maxPlayers}, serverTime: 1})).toThrow('Invalid room state');
    }
    read({type: 'state', state: {...state, maxPlayers: 2}, serverTime: 1});
    const players = Array.from({length: MAX_ROOM_PLAYERS}, (_, slot) => ({
      id: 'private-' + uuid(slot), connectionId: uuid(slot), slot, name: 'Player_' + slot,
      rank: 'Unranked', points: 0, guest: false, moderator: false, spectating: false, appearance: DEFAULT_APPEARANCE,
    }));
    expect(read({type: 'roster', players}).players).toHaveLength(MAX_ROOM_PLAYERS);
    expect(() => read({type: 'spectator-demand', active: true, count: MAX_ROOM_PLAYERS})).not.toThrow();
    expect(() => read({type: 'spectator-demand', active: true, count: MAX_ROOM_PLAYERS + 1})).toThrow();
  });

  test('bounds unfinished chunk memory and clears it on disposal', () => {
    const reader = createRoomControlReader();
    const frame = JSON.stringify({type: 'room-chunk', data: 'x'.repeat(65000), final: false});
    const count = Math.floor(MAX_ROOM_MESSAGE_CHARS / 65000);
    for (let index = 0; index < count; index++) expect(reader.read(frame)).toBeNull();
    expect(() => reader.read(frame)).toThrow();
    reader.clear();
    expect(reader.read('pong')).toBe('pong');
    const tiny = JSON.stringify({type: 'room-chunk', data: 'x', final: false});
    for (let index = 0; index < MAX_ROOM_CHUNKS; index++) reader.read(tiny);
    expect(() => reader.read(tiny)).toThrow();
    reader.clear();
    expect(reader.read(JSON.stringify({type: 'room-chunk', data: '{"type":"notice","text":"ok"}', final: true})))
      .toBe('{"type":"notice","text":"ok"}');
  });

  test('rejects nested chunks and raw over-limit messages', () => {
    const reader = createRoomControlReader(filter());
    const nested = {type: 'room-chunk', data: '{"type":"notice","text":"ok"}', final: true};
    expect(() => reader.read(JSON.stringify({type: 'room-chunk', data: JSON.stringify(nested), final: true}))).toThrow();
    expect(() => reader.read(' '.repeat(65537))).toThrow();
    expect(() => reader.read(JSON.stringify({type: 'notice', text: '名'.repeat(22000)}))).toThrow();
  });
});

// Independent native validators, transcribed from game-CjfdKdJo.js (r0/a0/Kx/Jx/nw).
// Keep their wire reads independent of the extension codecs to catch layout drift.
function nativePose(view, offset) {
  const value = {time: view.getUint32(offset, true), x: view.getFloat32(offset + 4, true),
    y: view.getFloat32(offset + 8, true), z: view.getFloat32(offset + 12, true),
    vx: view.getInt16(offset + 16, true), vy: view.getInt16(offset + 18, true), vz: view.getInt16(offset + 20, true),
    yaw: view.getUint16(offset + 22, true) / 65535 * 360, pitch: view.getInt16(offset + 24, true) / 32767 * 90,
    flags: view.getUint8(offset + 26), seconds: view.getFloat32(offset + 28, true)};
  if (![value.x, value.y, value.z].every(number => Number.isFinite(number) && Math.abs(number) <= 131072)
    || ![value.vx, value.vy, value.vz].every(number => Number.isFinite(number) && Math.abs(number) <= 32767)
    || !Number.isFinite(value.yaw) || Math.abs(value.yaw) > 360 || !Number.isFinite(value.pitch) || Math.abs(value.pitch) > 90
    || value.flags > 63 || !Number.isFinite(value.seconds) || value.seconds < 0 || value.seconds > 86400
    || view.getUint8(offset + 27) !== 0) throw Error('Invalid pose');
  return value;
}

function nativeSnapshot(buffer) {
  if (buffer.byteLength < 4 || buffer.byteLength > 7804) throw Error('Invalid snapshot size');
  const view = new DataView(buffer), count = view.getUint16(2, true), slots = new Set(), blocks = [];
  if (view.getUint8(0) !== 1 || view.getUint8(1) !== 2 || count > 100) throw Error('Invalid snapshot header');
  let offset = 4;
  for (let index = 0; index < count; index++) {
    if (offset + 14 > buffer.byteLength) throw Error('Truncated block');
    const slot = view.getUint16(offset, true), sequence = view.getUint32(offset + 2, true);
    const epoch = view.getUint32(offset + 6, true), size = view.getUint8(offset + 10);
    if (slots.has(slot) || size < 1 || size > 2 || view.getUint8(offset + 11) !== 0 || view.getUint16(offset + 12, true) !== 0) throw Error('Invalid block');
    slots.add(slot);
    offset += 14;
    if (offset + size * 32 > buffer.byteLength) throw Error('Truncated samples');
    const samples = Array.from({length: size}, (_, sample) => nativePose(view, offset + sample * 32));
    offset += size * 32;
    blocks.push({slot, sequence, epoch, samples});
  }
  if (offset !== buffer.byteLength) throw Error('Trailing snapshot data');
  return blocks;
}

function nativeSpectator(buffer) {
  if (buffer.byteLength !== 56) throw Error('Invalid spectator size');
  const view = new DataView(buffer), inputs = view.getUint8(54), presses = view.getUint8(55);
  if (view.getUint8(0) !== 1 || view.getUint8(1) !== 4 || view.getUint8(48) > 2 || view.getUint8(49) > 1
    || inputs !== 0 && !(inputs & 128) || inputs & 64 || presses > 63 || inputs === 0 && presses !== 0) throw Error('Invalid spectator header');
  const pose = {...nativePose(view, 12), eyeHeight: view.getFloat32(44, true), phase: ['ready', 'running', 'finished'][view.getUint8(48)],
    untimed: !!view.getUint8(49), checkpoints: view.getUint16(50, true), stage: view.getUint16(52, true),
    ...(inputs & 128 ? {inputs: inputs & 63, inputPresses: presses} : {})};
  if (!Number.isFinite(pose.eyeHeight) || pose.eyeHeight < 0 || pose.eyeHeight > 128 || pose.checkpoints > 1024 || pose.stage > 1024) throw Error('Invalid spectator state');
  return {slot: view.getUint16(2, true), sequence: view.getUint32(4, true), epoch: view.getUint32(8, true), pose};
}

test('host binary output roundtrips the independent native client validators', () => {
  for (const samples of [[pose], [pose, {...pose, time: 0, yaw: 1.25, pitch: 35.5, vx: 2.6}]]) {
    const output = relayPose(encodePoseBatch({...batch, samples}), 15).buffer;
    expect(nativeSnapshot(output)).toEqual(decodeSnapshot(output));
  }
  for (const inputs of [undefined, 0, 63]) {
    const output = relaySpectator(encodeSpectator({...packet, pose: {...detailed, inputs, inputPresses: inputs}}), 15).buffer;
    expect(nativeSpectator(output)).toEqual(decodeSpectator(output, true));
  }
  expect(nativeSnapshot(encodeSnapshot([]))).toEqual([]);
  expect(() => nativeSnapshot(changed(relayPose(encodePoseBatch(batch), 0).buffer, 15, 1))).toThrow();
  expect(() => nativeSpectator(changed(relaySpectator(encodeSpectator(packet), 0).buffer, 54, 64))).toThrow();
});

describe('community ranks', () => {
  const uuid = slot => '00000000-0000-4000-8000-' + String(slot).padStart(12, '0');
  const player = {id: 'private-' + uuid(1), connectionId: uuid(1), slot: 1, name: 'Surfer', rank: 'Skilled', points: 4200,
    guest: false, moderator: false, spectating: false, appearance: DEFAULT_APPEARANCE};
  const table = [{points: 0, title: 'Unranked'}, {points: 50, title: 'Skilled'}];

  test('the game’s rank table is used when it reads as one, else the built-in table', () => {
    expect(rankTable(table)).toEqual(table);
    for (const invalid of [undefined, null, [], [{points: 10, title: 'Unranked'}], [...table, {points: 50, title: 'Expert'}],
      [...table, {points: 60, title: 'Skilled'}], [...table, {points: 60, title: 'Guest'}], [...table, {points: 60, title: '<b>X</b>'}],
      [...table, {points: -1, title: 'Expert'}], [table[0], null]]) expect(rankTable(invalid)).toBe(RANKS);
    expect([0, 99, 100, 4000, 19999, 20000, 1e9].map(points => rankFor(points, RANKS)))
      .toEqual(['Unranked', 'Unranked', 'Rookie', 'Skilled', 'Master', 'Legend', 'Legend']);
  });

  test('rosters and chat carry ranks from the receiver’s own table', () => {
    const read = createRoomFilter({roomId: 'p-abcdefghjkmn', maps: [{id: 'one'}], ranks: table});
    expect(read({type: 'roster', players: [player]}).players[0]).toMatchObject({rank: 'Skilled', points: 4200});
    expect(() => read({type: 'roster', players: [{...player, rank: 'Legend'}]})).toThrow('Invalid room player');
    expect(read({type: 'chat', playerId: player.id, name: 'Surfer', text: 'hi', rank: 'Skilled'}).rank).toBe('Skilled');
    expect(() => read({type: 'chat', playerId: player.id, name: 'Surfer', text: 'hi', rank: 'Legend'})).toThrow('Invalid room chat');
    expect(createRoomFilter({roomId: 'p-abcdefghjkmn'})({type: 'roster', players: [{...player, rank: 'Legend'}]}).players[0].rank).toBe('Legend');
  });
});
