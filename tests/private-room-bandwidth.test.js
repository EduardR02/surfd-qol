import {describe, expect, test} from 'bun:test';
import {estimateBandwidth} from '../src/private-rooms/bandwidth.js';

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

  test('accepts the uint16 slot limit and rejects invalid counts', () => {
    expect(Number.isFinite(estimateBandwidth(65536).upload)).toBe(true);
    for (const value of [-1, 1.5, NaN, Infinity, 65537, '8', null]) expect(() => estimateBandwidth(value)).toThrow();
  });
});
