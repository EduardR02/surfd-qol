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
});
