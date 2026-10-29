import {describe, expect, test} from 'bun:test';
import {estimateBandwidth} from '../src/private-rooms/bandwidth.js';
import {MAX_ROOM_PLAYERS, MAX_SNAPSHOT_BLOCKS, encodePoseBatch, encodeSnapshot, encodeSpectator} from '../src/private-rooms/protocol.js';

const BATCH_SECONDS = 98 / 1000;
const FRAGMENT_BYTES = 1100, FRAGMENT_OVERHEAD = 20 + 8 + 4 + 37 + 28;
const pose = {time: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, flags: 0, seconds: 0};
const pairedPose = encodePoseBatch({sequence: 1, epoch: 1, samples: [pose, pose]});
const spectatorFrame = encodeSpectator({slot: 1, sequence: 1, epoch: 1,
  pose: {...pose, eyeHeight: 0, phase: 'ready', untimed: false, checkpoints: 0, stage: 0}});
const wireBytes = packet => packet.byteLength + Math.ceil(packet.byteLength / FRAGMENT_BYTES) * FRAGMENT_OVERHEAD;

// Synchronized batches let each remote guest receive one native snapshot
// containing every other player's latest two-sample block.
function synchronizedMovement(players) {
  const guests = Math.max(0, players - 1);
  if (!guests) return {packets: [], upload: 0, download: 0};
  const destination = guests, sources = Array.from({length: players}, (_, slot) => ({
    slot, sequence: 1, epoch: 1, samples: [pose, pose],
  })).filter(({slot}) => slot !== destination);
  const packets = [];
  for (let offset = 0; offset < sources.length; offset += MAX_SNAPSHOT_BLOCKS) {
    packets.push(encodeSnapshot(sources.slice(offset, offset + MAX_SNAPSHOT_BLOCKS)));
  }
  const upload = guests * packets.reduce((sum, packet) => sum + wireBytes(packet), 0) / BATCH_SECONDS * 8 / 1e6;
  const download = guests * wireBytes(pairedPose) / BATCH_SECONDS * 8 / 1e6;
  return {packets, upload, download};
}

describe('private room bandwidth', () => {
  test('excludes host loopback', () => {
    expect(estimateBandwidth(0)).toEqual({upload: 0, download: 0});
    expect(estimateBandwidth(1)).toEqual({upload: 0, download: 0});
  });

  test('counts actual paired native packets in the synchronized one-guest scenario', () => {
    const expected = synchronizedMovement(2), actual = estimateBandwidth(2, {spectatorViewers: 0, spectatorSenders: 0});
    expect(actual.upload).toBeCloseTo(expected.upload, 10);
    expect(actual.download).toBeCloseTo(expected.download, 10);
  });

  test('sends complete snapshots at and across the 100-block chunk boundary', () => {
    const exactlyFull = synchronizedMovement(101);
    expect(estimateBandwidth(101, {spectatorViewers: 0, spectatorSenders: 0}).upload)
      .toBeCloseTo(exactlyFull.upload, 10);

    const oneOver = synchronizedMovement(102);
    expect(estimateBandwidth(102, {spectatorViewers: 0, spectatorSenders: 0}).upload)
      .toBeCloseTo(oneOver.upload, 10);
  });

  test('charges one or two MTU fragments on either side of a generated packet boundary', () => {
    const below = synchronizedMovement(15), above = synchronizedMovement(16);
    expect(below.packets[0].byteLength).toBeLessThan(FRAGMENT_BYTES);
    expect(above.packets[0].byteLength).toBeGreaterThan(FRAGMENT_BYTES);
    expect(estimateBandwidth(15, {spectatorViewers: 0, spectatorSenders: 0}).upload)
      .toBeCloseTo(below.upload, 10);
    expect(estimateBandwidth(16, {spectatorViewers: 0, spectatorSenders: 0}).upload)
      .toBeCloseTo(above.upload, 10);
  });

  test('accounts for every full-room snapshot chunk and its MTU fragments', () => {
    const expected = synchronizedMovement(MAX_ROOM_PLAYERS);
    const actual = estimateBandwidth(MAX_ROOM_PLAYERS, {spectatorViewers: 0, spectatorSenders: 0});
    expect(actual.upload).toBeCloseTo(expected.upload, 10);
    expect(actual.download).toBeCloseTo(expected.download, 10);
  });

  test('rejects invalid player counts', () => {
    for (const value of [-1, 1.5, NaN, Infinity, MAX_ROOM_PLAYERS + 1, '8', null]) expect(() => estimateBandwidth(value)).toThrow();
  });

  test('keeps the separately conservative spectator defaults distinct from movement demand', () => {
    const streamMbps = wireBytes(spectatorFrame) * 30 * 8 / 1e6;
    for (const players of [2, 8, 16, 32, MAX_ROOM_PLAYERS]) {
      const guests = players - 1;
      const movement = estimateBandwidth(players, {spectatorViewers: 0, spectatorSenders: 0});
      const defaults = estimateBandwidth(players);
      expect(defaults.upload - movement.upload).toBeCloseTo(guests * streamMbps, 10);
      expect(defaults.download - movement.download).toBeCloseTo(guests * streamMbps, 10);
    }
  });

  test('counts guest viewers and distinct guest sources independently', () => {
    const none = estimateBandwidth(8, {spectatorViewers: 0, spectatorSenders: 0});
    const watched = estimateBandwidth(8, {spectatorViewers: 5, spectatorSenders: 1});
    const streamMbps = wireBytes(spectatorFrame) * 30 * 8 / 1e6;
    expect(watched.upload - none.upload).toBeCloseTo(5 * streamMbps, 10);
    expect(watched.download - none.download).toBeCloseTo(streamMbps, 10);
    expect(estimateBandwidth(8, {spectatorViewers: 1, spectatorSenders: 0}).download).toBe(none.download);
    expect(estimateBandwidth(8, {spectatorViewers: 0, spectatorSenders: 1}).upload).toBe(none.upload);
  });

  test('rejects impossible spectator demand, including streams in a host-only room', () => {
    for (const value of [-1, 0.5, NaN, Infinity, 8, '1', null]) {
      expect(() => estimateBandwidth(8, {spectatorViewers: value})).toThrow();
      expect(() => estimateBandwidth(8, {spectatorSenders: value})).toThrow();
    }
    expect(() => estimateBandwidth(1, {spectatorViewers: 1})).toThrow();
    expect(() => estimateBandwidth(0, {spectatorSenders: 1})).toThrow();
    expect(estimateBandwidth(1, {spectatorViewers: 0, spectatorSenders: 0})).toEqual({upload: 0, download: 0});
  });
});
