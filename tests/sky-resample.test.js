import {expect, test} from 'bun:test';
import {createSkyResampler} from '../extension/sky-resample.js';

const identity = [1, 0, 0, 0, 1, 0];

function decode(value) {
  const normalized = value / 255;
  return normalized <= .04045 ? normalized / 12.92 : Math.pow((normalized + .055) / 1.055, 2.4);
}

function encode(value) {
  return Math.round(255 * (value <= .0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - .055));
}

// Independent, deliberately unoptimized transcription of the native pixel formula.
function nativeResample(input, width, height, size, transform) {
  const output = new Uint8ClampedArray(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const x = (column + .5) / size, y = (row + .5) / size;
      const sourceX = Math.min(width - 1, Math.max(0,
        (transform[0] * x + transform[1] * y + transform[2]) * width - .5));
      const sourceY = Math.min(height - 1, Math.max(0,
        (transform[3] * x + transform[4] * y + transform[5]) * height - .5));
      const left = Math.floor(sourceX), top = Math.floor(sourceY);
      const fx = sourceX - left, fy = sourceY - top;
      const right = Math.min(left + 1, width - 1), bottom = Math.min(top + 1, height - 1);
      const a = (top * width + left) * 4, b = (top * width + right) * 4;
      const c = (bottom * width + left) * 4, d = (bottom * width + right) * 4;
      const target = (row * size + column) * 4;
      for (let channel = 0; channel < 4; channel++) {
        if (fx === 0 && fy === 0) {
          output[target + channel] = input[a + channel];
          continue;
        }
        const av = channel === 3 ? input[a + channel] / 255 : decode(input[a + channel]);
        const bv = channel === 3 ? input[b + channel] / 255 : decode(input[b + channel]);
        const cv = channel === 3 ? input[c + channel] / 255 : decode(input[c + channel]);
        const dv = channel === 3 ? input[d + channel] / 255 : decode(input[d + channel]);
        const upper = av * (1 - fx) + bv * fx;
        const lower = cv * (1 - fx) + dv * fx;
        const value = upper * (1 - fy) + lower * fy;
        output[target + channel] = channel === 3 ? Math.round(value * 255) : encode(value);
      }
    }
  }
  return output;
}

function expectResample(resample, input, width, height, size, transform, expected = undefined) {
  const before = input.slice();
  const storage = new Uint8ClampedArray(size * size * 4 + 8).fill(173);
  const output = storage.subarray(4, storage.length - 4);
  expect(resample(input, width, height, size, transform, output)).toBe(output);
  expect(output).toEqual(nativeResample(input, width, height, size, transform));
  if (expected !== undefined) expect(output).toEqual(new Uint8ClampedArray(expected));
  expect(input).toEqual(before);
  expect(storage.subarray(0, 4)).toEqual(new Uint8ClampedArray(4).fill(173));
  expect(storage.subarray(storage.length - 4)).toEqual(new Uint8ClampedArray(4).fill(173));
  return output;
}

function patternedInput(width, height) {
  const input = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    input.set([i % 256, (i * 73 + 10) % 256, (i * 151 + 11) % 256, (i * 197 + 17) % 256], i * 4);
  }
  return input;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const factories = [
  ['module', createSkyResampler],
  ['standalone injected factory', Function(`return (${createSkyResampler.toString()})`)()],
];

for (const [name, factory] of factories) {
  const resample = factory();

  test(`${name}: identity preserves every byte, including all alpha values`, () => {
    for (const size of [1, 2, 3, 8, 16]) {
      const input = patternedInput(size, size);
      expectResample(resample, input, size, size, size, identity, input);
    }
  });

  test(`${name}: one-pixel faces fill every destination regardless of transform`, () => {
    for (const pixel of [[0, 255, 10, 0], [11, 203, 87, 19], [255, 0, 255, 255]]) {
      const input = new Uint8ClampedArray(pixel);
      for (const size of [1, 2, 7]) {
        for (const transform of [identity, [0, -1, 1, 1, 0, 0], [3, -7, 12, -9, 2, -4]]) {
          const expected = new Uint8ClampedArray(size * size * 4);
          for (let offset = 0; offset < expected.length; offset += 4) expected.set(input, offset);
          expectResample(resample, input, 1, 1, size, transform, expected);
        }
      }
    }
  });

  test(`${name}: non-square and one-dimensional faces retain native strides and sampling`, () => {
    for (const [width, height] of [[5, 2], [2, 5], [1, 7], [7, 1]]) {
      const input = patternedInput(width, height);
      for (const size of [1, 3, 8]) {
        for (const transform of [identity, [0, 1, 0, -1, 0, 1], [.8, .2, -.1, -.3, 1.1, .1]]) {
          expectResample(resample, input, width, height, size, transform);
        }
      }
    }
  });

  test(`${name}: rotations, flips and translations preserve face orientation and alpha`, () => {
    const input = patternedInput(3, 3);
    const cases = [
      [[-1, 0, 1, 0, 1, 0], [2, 1, 0, 5, 4, 3, 8, 7, 6]],
      [[1, 0, 0, 0, -1, 1], [6, 7, 8, 3, 4, 5, 0, 1, 2]],
      [[0, 1, 0, -1, 0, 1], [6, 3, 0, 7, 4, 1, 8, 5, 2]],
      [[0, -1, 1, 1, 0, 0], [2, 5, 8, 1, 4, 7, 0, 3, 6]],
      [[-1, 0, 1, 0, -1, 1], [8, 7, 6, 5, 4, 3, 2, 1, 0]],
      [[1, 0, 1 / 3, 0, 1, -1 / 3], [1, 2, 2, 1, 2, 2, 4, 5, 5]],
    ];
    for (const [transform, pixels] of cases) {
      const expected = pixels.flatMap(index => Array.from(input.subarray(index * 4, index * 4 + 4)));
      expectResample(resample, input, 3, 3, 3, transform, expected);
    }
  });

  test(`${name}: clamped borders do not wrap or bleed opposite face edges`, () => {
    const input = new Uint8ClampedArray([
      0, 0, 0, 0, 255, 0, 0, 64,
      0, 255, 0, 128, 255, 255, 255, 255,
    ]);
    expectResample(resample, input, 2, 2, 3, [2, 0, -.5, 0, 2, -.5], [
      0, 0, 0, 0, 188, 0, 0, 32, 255, 0, 0, 64,
      0, 188, 0, 64, 188, 188, 137, 112, 255, 188, 188, 160,
      0, 255, 0, 128, 188, 255, 188, 192, 255, 255, 255, 255,
    ]);
    for (const x of [-1000, -(2 ** -40), 0, 1, 1 + 2 ** -40, 1000]) {
      for (const y of [-1000, 0, 1, 1000]) {
        expectResample(resample, input, 2, 2, 2, [0, 0, x, 0, 0, y]);
      }
    }
  });

  test(`${name}: RGB blends in linear light while alpha stays linear and unpremultiplied`, () => {
    const center = [0, 0, .5, 0, 0, .5];
    expectResample(resample, new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 255]),
      2, 1, 1, center, [188, 188, 188, 128]);
    expectResample(resample, new Uint8ClampedArray([255, 0, 0, 0, 0, 0, 255, 255]),
      2, 1, 1, center, [188, 0, 188, 128]);
    expectResample(resample, new Uint8ClampedArray([9, 10, 11, 127, 12, 11, 10, 128]),
      2, 1, 1, center);
  });

  test(`${name}: gamma rounding boundaries use exact encoding, not quantized LUT values`, () => {
    const input = new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 255]);
    for (let byte = 0; byte < 255; byte++) {
      const normalized = (byte + .5) / 255;
      const boundary = normalized <= .04045 ? normalized / 12.92 :
        Math.pow((normalized + .055) / 1.055, 2.4);
      for (const delta of [-1e-12, 1e-12]) {
        const weight = boundary + delta;
        const output = expectResample(resample, input, 2, 1, 1, [0, 0, (weight + .5) / 2, 0, 0, .5]);
        expect(output[0]).toBe(byte + (delta > 0 ? 1 : 0));
      }
    }
    // Exercise both sides of the piecewise encoding knee as well as byte thresholds.
    for (const weight of [.0031308 - 1e-12, .0031308, .0031308 + 1e-12]) {
      expectResample(resample, input, 2, 1, 1, [0, 0, (weight + .5) / 2, 0, 0, .5]);
    }
  });

  test(`${name}: alpha half-byte boundaries retain native round-up arithmetic`, () => {
    const input = new Uint8ClampedArray([7, 31, 253, 0, 219, 193, 13, 255]);
    for (let byte = 0; byte < 255; byte++) {
      const boundary = (byte + .5) / 255;
      for (const delta of [-1e-12, 1e-12]) {
        const weight = boundary + delta;
        const output = expectResample(resample, input, 2, 1, 1, [0, 0, (weight + .5) / 2, 0, 0, .5]);
        expect(output[3]).toBe(byte + (delta > 0 ? 1 : 0));
      }
    }
    const midpoint = expectResample(resample, input, 2, 1, 1, [0, 0, .5, 0, 0, .5]);
    expect(midpoint[3]).toBe(128);
  });

  test(`${name}: deterministic random affine samples match every native output byte`, () => {
    const random = seededRandom(0x51c0ffee);
    for (let sample = 0; sample < 96; sample++) {
      const width = 1 + Math.floor(random() * 7), height = 1 + Math.floor(random() * 7);
      const size = 1 + Math.floor(random() * 8);
      const input = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < input.length; i++) input[i] = Math.floor(random() * 256);
      const transform = Array.from({length: 6}, () => random() * 4 - 2);
      expectResample(resample, input, width, height, size, transform);
      // Keep a second set inside the face so interpolation is not dominated by clamping.
      expectResample(resample, input, width, height, size,
        [.6 + random() * .4, random() * .2 - .1, random() * .1,
          random() * .2 - .1, .6 + random() * .4, random() * .1]);
    }
  });
}
