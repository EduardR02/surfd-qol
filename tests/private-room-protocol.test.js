import {describe, expect, test} from 'bun:test';
import {decodeControl, decodePoseBatch, decodeSnapshot, decodeSpectator, encodePoseBatch, encodeSnapshot, encodeSpectator, normalizeAppearance, relayPose, relaySpectator, validPose} from '../src/private-rooms/protocol.js';

const pose = {time: 0xffffffff, x: 131072, y: -131072, z: 0, vx: 32767, vy: -32767, vz: 0, yaw: -90, pitch: -90, flags: 63, seconds: 86400};
const batch = {sequence: 0xffffffff, epoch: 0xffffffff, samples: [pose]};
const detailed = {...pose, eyeHeight: 128, phase: 'finished', untimed: true, checkpoints: 1024, stage: 1024, inputs: 63, inputPresses: 63};
const packet = {sequence: 0xffffffff, epoch: 0xffffffff, slot: 65535, pose: detailed};
function changed(buffer, offset, value, method = 'setUint8') {
  const copy = buffer.slice(0);
  new DataView(copy)[method](offset, value, true);
  return copy;
}

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
    const blocks = Array.from({length: 100}, (_, slot) => ({...batch, slot, samples: [pose, pose]}));
    const encoded = encodeSnapshot(blocks);
    expect(encoded.byteLength).toBe(7804);
    expect(decodeSnapshot(encoded)).toHaveLength(100);
    expect(() => encodeSnapshot([...blocks, blocks[0]])).toThrow();
    expect(() => encodeSnapshot([{...batch, slot: 0}, {...batch, slot: 0}])).toThrow();
    expect(() => encodeSnapshot([{...batch, slot: 65536}])).toThrow();
    const two = encodeSnapshot([{...batch, slot: 0}, {...batch, slot: 1}]);
    expect(() => decodeSnapshot(changed(two, 50, 0, 'setUint16'))).toThrow();
    const one = encodeSnapshot([{...batch, slot: 0}]);
    for (const [offset, value] of [[0, 0], [1, 1], [2, 101], [14, 0], [14, 3], [15, 1], [16, 1], [17, 1]]) expect(() => decodeSnapshot(changed(one, offset, value))).toThrow();
    expect(() => decodeSnapshot(one.slice(0, 17))).toThrow();
    expect(() => decodeSnapshot(one.slice(0, -1))).toThrow();
    const trailing = new Uint8Array(one.byteLength + 1);
    trailing.set(new Uint8Array(one));
    expect(() => decodeSnapshot(trailing.buffer)).toThrow();
  });

  test('spectator layout includes uint16 slot, timer detail and optional input bits', () => {
    const encoded = encodeSpectator(packet);
    expect(encoded.byteLength).toBe(56);
    expect([...new Uint8Array(encoded, 0, 4)]).toEqual([1, 3, 255, 255]);
    expect([...new Uint8Array(encoded, 48)]).toEqual([2, 1, 0, 4, 0, 4, 191, 63]);
    expect(decodeSpectator(encoded)).toMatchObject({slot: 65535, sequence: 0xffffffff, epoch: 0xffffffff, pose: {eyeHeight: 128, phase: 'finished', untimed: true, checkpoints: 1024, stage: 1024, inputs: 63, inputPresses: 63}});
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
    expect(() => encodeSpectator({...packet, slot: -1})).toThrow();
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
    expect(() => relayPose(source, -1)).toThrow();
    expect(() => relaySpectator(spectator, 65536)).toThrow();
  });
});

describe('private room control boundaries', () => {
  test('parses only bounded object JSON or the native ping literal', () => {
    expect(decodeControl('ping')).toEqual({type: 'ping'});
    expect(decodeControl('{"type":"chat","text":"hello"}')).toMatchObject({type: 'chat', text: 'hello'});
    for (const input of [null, '{}', 'null', '[]', '1', '{', ' '.repeat(65537), '{"type":"chat","text":" "}', '{"type":"change-map","mapId":0}', '{"type":"spectate","connectionId":null,"request":-1}']) expect(() => decodeControl(input)).toThrow();
    expect(decodeControl('{"type":"spectate","connectionId":null,"request":1}').connectionId).toBeNull();
    expect(decodeControl('{"type":"refresh"}')).toEqual({type: 'refresh'});
  });
  test('validates the exact native appearance grammar', () => {
    const appearance = {title: 'Élite 2!?', titleColor: '#ABC123', nameColor: '#000000', revision: 0};
    expect(normalizeAppearance(appearance)).toEqual(appearance);
    for (const invalid of [{title: 'x'.repeat(25)}, {title: '<b>'}, {title: ' padded'}, {titleColor: 'red'}, {nameColor: undefined}, {revision: -1}, {revision: 0.5}]) expect(normalizeAppearance({...appearance, ...invalid}).title).toBe('');
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
