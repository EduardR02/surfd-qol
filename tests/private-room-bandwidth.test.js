import {describe, expect, test} from 'bun:test';
import {estimateBandwidth} from '../src/private-rooms/bandwidth.js';
import {MAX_ROOM_PLAYERS} from '../src/private-rooms/protocol.js';

describe('private room bandwidth', () => {
  test('excludes host loopback', () => {
    expect(estimateBandwidth(0)).toEqual({upload: 0, download: 0});
    expect(estimateBandwidth(1)).toEqual({upload: 0, download: 0});
  });

  test('scales upload quadratically and download linearly', () => {
    const eight = estimateBandwidth(8), sixteen = estimateBandwidth(16), thirtyTwo = estimateBandwidth(32);
    expect(sixteen.upload).toBeGreaterThan(eight.upload * 3);
    expect(thirtyTwo.upload).toBeGreaterThan(sixteen.upload * 3);
    expect(sixteen.download / eight.download).toBeCloseTo(15 / 7, 10);
    expect(thirtyTwo.download / sixteen.download).toBeCloseTo(31 / 15, 10);
  });

  test('counts IP, UDP, TURN ChannelData, DTLS and SCTP headers on every packet', () => {
    const overhead = 20 + 8 + 4 + 37 + 28;
    // One guest: a 76-byte pose batch every 98 ms and a 56-byte spectator frame 30 times a second.
    expect(estimateBandwidth(2).download).toBeCloseTo(((76 + overhead) / 0.098 + (56 + overhead) * 30) * 8 / 1e6, 10);
  });

  test('accepts a full room and rejects invalid counts', () => {
    expect(Number.isFinite(estimateBandwidth(MAX_ROOM_PLAYERS).upload)).toBe(true);
    for (const value of [-1, 1.5, NaN, Infinity, MAX_ROOM_PLAYERS + 1, '8', null]) expect(() => estimateBandwidth(value)).toThrow();
  });

  test('distinguishes typical movement-only demand from the conservative spectator budget', () => {
    for (const players of [2, 8, 16, 32, MAX_ROOM_PLAYERS]) {
      const guests = players - 1, streamMbps = (56 + 97) * 30 * 8 / 1e6;
      const typical = estimateBandwidth(players, {spectatorViewers: 0, spectatorSenders: 0});
      const budget = estimateBandwidth(players);
      expect(budget.upload - typical.upload).toBeCloseTo(guests * streamMbps, 10);
      expect(budget.download - typical.download).toBeCloseTo(guests * streamMbps, 10);
    }
  });

  test('counts guest viewers and distinct guest sources independently', () => {
    const none = estimateBandwidth(8, {spectatorViewers: 0, spectatorSenders: 0});
    const watched = estimateBandwidth(8, {spectatorViewers: 5, spectatorSenders: 1});
    const streamMbps = (56 + 97) * 30 * 8 / 1e6;
    expect(watched.upload - none.upload).toBeCloseTo(5 * streamMbps, 10);
    expect(watched.download - none.download).toBeCloseTo(streamMbps, 10);
    // A guest watching the host consumes host upload but no spectator download.
    expect(estimateBandwidth(8, {spectatorViewers: 1, spectatorSenders: 0}).download).toBe(none.download);
    // A host watching a guest consumes host download but no spectator upload.
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
