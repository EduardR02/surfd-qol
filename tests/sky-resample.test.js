import {expect, test} from 'bun:test';
import {createSkyPreparation, createSkyResampler, runSkyResampleWorker} from '../extension/sky-resample.js';
import {nativeMapLoadHooks} from '../extension/map-load-hooks.js';

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

  test(`${name}: one-pixel faces fill every destination for finite transforms`, () => {
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

  test(`${name}: nonfinite one-pixel transforms retain native clamping and NaN behavior`, () => {
    const input = new Uint8ClampedArray([11, 203, 87, 19]);
    for (const size of [1, 3]) for (const transform of [
      [NaN, 0, 0, 0, 1, 0],
      [Infinity, 0, -Infinity, 0, 1, 0],
      [0, 0, Infinity, 0, 0, -Infinity],
      [1, 0, 0, 0, NaN, 0],
    ]) expectResample(resample, input, 1, 1, size, transform);
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

test('resampling reads changed source pixels on each call without retaining decoded faces', () => {
  const resample = createSkyResampler(), input = patternedInput(3, 2);
  const transform = [.8, .1, 0, -.1, .9, .1];
  const first = expectResample(resample, input, 3, 2, 5, transform).slice();
  for (let index = 0; index < input.length; index++) input[index] = 255 - input[index];
  const second = expectResample(resample, input, 3, 2, 5, transform);
  expect(second).not.toEqual(first);
});

test('mixed sky transforms convert all faces, including individually unchanged ones', () => {
  const native = `function qb(n,e=[]){const t=Math.max(...n.map(o=>Math.max(o.width,o.height))),i=[1,0,0,0,1,0],s=n.map((o,c)=>Wb(e[c]));if(n.every((o,c)=>o.width===t&&o.height===t&&s[c].every((l,d)=>Math.abs(l-i[d])<1e-12)))return n;const r=Array.from({length:256},(o,c)=>{const l=c/255;return l<=.04045?l/12.92:Math.pow((l+.055)/1.055,2.4)}),a=o=>Math.round(255*(o<=.0031308?o*12.92:1.055*Math.pow(o,1/2.4)-.055));return n.map((o,c)=>{const l=document.createElement("canvas");l.width=o.width,l.height=o.height;const d=l.getContext("2d",{willReadFrequently:!0});d.drawImage(o,0,0);const u=d.getImageData(0,0,o.width,o.height).data,h=document.createElement("canvas");h.width=h.height=t;const f=h.getContext("2d"),v=f.createImageData(t,t),g=s[c];for(let m=0;m<t;m++)for(let p=0;p<t;p++){const x=(p+.5)/t,b=(m+.5)/t,y=Math.min(o.width-1,Math.max(0,(g[0]*x+g[1]*b+g[2])*o.width-.5)),S=Math.min(o.height-1,Math.max(0,(g[3]*x+g[4]*b+g[5])*o.height-.5)),E=Math.floor(y),C=Math.floor(S),_=y-E,w=S-C,T=(C*o.width+E)*4,I=(C*o.width+Math.min(E+1,o.width-1))*4,O=(Math.min(C+1,o.height-1)*o.width+E)*4,H=(Math.min(C+1,o.height-1)*o.width+Math.min(E+1,o.width-1))*4,G=(m*t+p)*4;for(let N=0;N<4;N++){if(_===0&&w===0){v.data[G+N]=u[T+N];continue}const F=ae=>N===3?u[ae+N]/255:r[u[ae+N]],z=F(T)*(1-_)+F(I)*_,k=F(O)*(1-_)+F(H)*_,Q=z*(1-w)+k*w;v.data[G+N]=N===3?Math.round(Q*255):a(Q)}}return f.putImageData(v,0,0),h})}`;
  let canvases = 0;
  const document = {createElement() {
    canvases++;
    const canvas = {};
    let image;
    canvas.getContext = () => ({
      drawImage(value) { image = value; },
      getImageData() { return {data: image.data}; },
      createImageData(width, height) { return {data: new Uint8ClampedArray(width * height * 4)}; },
      putImageData(value) { canvas.data = value.data; },
    });
    return canvas;
  }};
  const resample = new Function('document', 'Wb', nativeMapLoadHooks(native) + ';return qb')
    (document, transform => transform ?? identity);
  const images = [{width: 2, height: 2, data: patternedInput(2, 2)},
    {width: 2, height: 2, data: patternedInput(2, 2)}];
  expect(resample(images, [identity, identity])).toBe(images);
  expect(canvases).toBe(0);
  const rotation = [0, 1, 0, -1, 0, 1];
  const output = resample(images, [identity, rotation]);
  expect(output[0]).not.toBe(images[0]);
  expect(output[0].data).toEqual(nativeResample(images[0].data, 2, 2, 2, identity));
  expect(output[1].data).toEqual(nativeResample(images[1].data, 2, 2, 2, rotation));
  expect(canvases).toBe(4);
  const sizes = [images[0], {width: 1, height: 1, data: patternedInput(1, 1)}];
  const resized = resample(sizes, [identity, identity]);
  expect(resized[0]).not.toBe(sizes[0]);
  expect(resized[1]).not.toBe(sizes[1]);
  expect(resized[0].data).toEqual(nativeResample(sizes[0].data, 2, 2, 2, identity));
  expect(resized[1].data).toEqual(nativeResample(sizes[1].data, 1, 1, 2, identity));
  expect(canvases).toBe(8);
});

function workerEnvironment({csp = false, cloneFailure = false, canvasFailure = false, bitmaps = false} = {}) {
  const blobs = new Map(), revoked = [], workers = [], clones = [], created = [];
  let nextUrl = 0;
  class ImageBitmap {
    constructor(width, height, data) {
      this.width = width;
      this.height = height;
      this.data = data;
      this.closed = 0;
    }
    close() { this.closed++; }
  }
  class Canvas {
    constructor(width = 0, height = 0) { this.width = width; this.height = height; }
    getContext() {
      if (canvasFailure) throw new Error('Offscreen canvas unavailable');
      let image;
      return {
        drawImage(value) { image = value; },
        getImageData() { return {data: image.data.slice()}; },
        createImageData: (width, height) => ({data: new Uint8ClampedArray(width * height * 4)}),
        putImageData: value => { this.data = value.data.slice(); },
      };
    }
  }
  class Worker {
    constructor(url) {
      if (csp) throw new Error('Blocked by CSP');
      this.terminated = 0;
      const owner = this;
      this.self = {postMessage(data) { queueMicrotask(() => {
        if (!owner.terminated) owner.onmessage?.({data});
      }); }};
      Function('self', 'OffscreenCanvas', 'createImageBitmap', 'ImageData', blobs.get(url))(this.self, Canvas,
        bitmaps ? async (data, options) => {
          expect(options).toEqual({premultiplyAlpha: 'none', colorSpaceConversion: 'none'});
          const bitmap = new ImageBitmap(data.width, data.height, data.data.slice());
          created.push(bitmap);
          return bitmap;
        } : undefined,
        bitmaps ? class { constructor(data, width, height) { Object.assign(this, {data, width, height}); } } : undefined);
      workers.push(this);
    }
    postMessage(data, ...transfers) {
      if (cloneFailure) throw new DOMException('Not serializable', 'DataCloneError');
      this.transfers = transfers;
      this.images = data.images.map(image => {
        if (!image) return null;
        const copy = new ImageBitmap(image.width, image.height, image.data.slice());
        clones.push(copy);
        return copy;
      });
      this.pending = {...data, images: this.images};
    }
    flush() {
      if (!this.terminated) this.self.onmessage({data: this.pending});
    }
    terminate() {
      this.terminated++;
      for (const image of this.images ?? []) if (image && !image.closed) image.close();
    }
    fail() {
      this.onerror({preventDefault() {}});
    }
  }
  return {
    ImageBitmap, Worker, OffscreenCanvas: Canvas,
    Blob: class { constructor(parts) { this.text = parts.join(''); } },
    ImageData: class { constructor(data, width, height) { Object.assign(this, {data, width, height}); } },
    URL: {
      createObjectURL(blob) { const url = `blob:test-${++nextUrl}`; blobs.set(url, blob.text); return url; },
      revokeObjectURL(url) { blobs.delete(url); revoked.push(url); },
    },
    document: {createElement: () => new Canvas()},
    workers, clones, revoked, created,
  };
}

function skyFaces(environment, opaque = false) {
  return [[3, 3], [3, 3], [1, 1], [3, 2], [2, 3], [3, 3]].map(([width, height]) => {
    const data = patternedInput(width, height);
    if (opaque) for (let offset = 3; offset < data.length; offset += 4) data[offset] = 255;
    return new environment.ImageBitmap(width, height, data);
  });
}

const preparations = [
  ['module', createSkyPreparation],
  ['standalone injected factory', Function(`return (${createSkyPreparation.toString()})`)()],
];

// Faces reach workers after a promise turn; let that happen.
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const pixelsOf = face => Array.from(face.image?.data ?? face.data);
const expected = (face, original, transform, size = 3) => Array.from(nativeResample(original, face.width, face.height, size, transform));

for (const [name, factory] of preparations) {
  test(`${name}: workers start before the faces arrive and receive only the faces they need`, async () => {
    const environment = workerEnvironment(), faces = skyFaces(environment);
    environment.navigator = {hardwareConcurrency: 12};
    let deliver;
    const pending = new Promise(resolve => { deliver = resolve; });
    const prepared = factory(pending, [identity, [0, 1, 0, -1, 0, 1]], new AbortController().signal,
      value => value ?? identity, createSkyResampler, runSkyResampleWorker, environment);
    expect(environment.workers).toHaveLength(3);
    expect(environment.revoked).toEqual(['blob:test-1']);
    expect(environment.workers.every(worker => worker.pending === undefined)).toBe(true);
    deliver(faces);
    await turn();
    for (const worker of environment.workers) {
      expect(worker.images.map(Boolean)).toEqual(worker.pending.images.map((_, face) => worker.pending.tasks.some(task => task.face === face)));
    }
    for (const worker of environment.workers) worker.flush();
    await prepared.ready;
    expect(environment.workers.every(worker => worker.terminated === 1)).toBe(true);
  });

  test(`${name}: identity transforms start workers only once a face size differs`, async () => {
    const environment = workerEnvironment(), faces = skyFaces(environment);
    let deliver;
    const prepared = factory(new Promise(resolve => { deliver = resolve; }), [], new AbortController().signal,
      value => value ?? identity, createSkyResampler, runSkyResampleWorker, environment);
    expect(environment.workers).toHaveLength(0);
    prepared.observe(faces[0]);
    prepared.observe(faces[1]);
    expect(environment.workers).toHaveLength(0);
    prepared.observe(faces[2]);
    expect(environment.workers).toHaveLength(1);
    prepared.observe(faces[3]);
    expect(environment.workers).toHaveLength(1);
    deliver(faces);
    await turn();
    environment.workers[0].flush();
    const output = await prepared.finish(() => { throw new Error('Unexpected native fallback'); });
    expect(output[2].data).toEqual(nativeResample(faces[2].data, 1, 1, 3, identity));
  });

  test(`${name}: worker pixels match native conversion and convert every face in a mixed sky`, async () => {
    const environment = workerEnvironment(), faces = skyFaces(environment), originals = faces.map(face => face.data.slice());
    const rotation = [0, 1, 0, -1, 0, 1], affine = [.8, .2, -.1, -.3, 1.1, .1];
    const transforms = [identity, rotation, affine, identity, rotation, affine];
    const prepared = factory(faces, transforms, new AbortController().signal, value => value ?? identity,
      createSkyResampler, runSkyResampleWorker, environment);
    await turn();
    const worker = environment.workers[0];
    let finished = false;
    const result = prepared.finish(() => { throw new Error('Unexpected native fallback'); })
      .then(value => { finished = true; return value; });
    await Promise.resolve();
    expect(finished).toBe(false);
    worker.flush();
    const output = await result;
    for (let index = 0; index < faces.length; index++) {
      expect(output[index]).not.toBe(faces[index]);
      expect(output[index].data).toEqual(nativeResample(originals[index], faces[index].width,
        faces[index].height, 3, transforms[index]));
    }
    expect(worker.terminated).toBe(1);
    expect(environment.clones.map(image => image.closed)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(faces.map(face => face.closed)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(faces.map(face => face.data)).toEqual(originals);
    expect(await prepared.finish(() => { throw new Error('Repeated fallback'); })).toBe(output);
  });

  test(`${name}: an opaque converted sky uploads as raw pixels`, async () => {
    const environment = workerEnvironment(), faces = skyFaces(environment, true);
    const originals = faces.map(face => face.data.slice());
    const rotation = [0, 1, 0, -1, 0, 1], affine = [.8, .2, -.1, -.3, 1.1, .1];
    const transforms = [identity, rotation, affine, identity, rotation, affine];
    const prepared = factory(faces, transforms, new AbortController().signal, value => value ?? identity,
      createSkyResampler, runSkyResampleWorker, environment);
    await turn();
    environment.workers[0].flush();
    const output = await prepared.finish(() => { throw new Error('Unexpected native fallback'); });
    for (let index = 0; index < faces.length; index++) {
      expect(output[index].isDataTexture).toBe(true);
      expect(output[index].image.data).toBeInstanceOf(Uint8Array);
      expect([output[index].image.width, output[index].image.height]).toEqual([3, 3]);
      expect(pixelsOf(output[index])).toEqual(expected(faces[index], originals[index], transforms[index]));
    }
    prepared.release();
    expect(faces.map(face => face.closed)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test(`${name}: a translucent pixel keeps the native canvas round trip for every face`, async () => {
    const environment = workerEnvironment(), faces = skyFaces(environment, true);
    faces[4].data[7] = 254;
    const prepared = factory(faces, [identity, [0, 1, 0, -1, 0, 1]], new AbortController().signal,
      value => value ?? identity, createSkyResampler, runSkyResampleWorker, environment);
    await turn();
    environment.workers[0].flush();
    const output = await prepared.finish(() => { throw new Error('Unexpected native fallback'); });
    expect(output.some(face => face.isDataTexture)).toBe(false);
    expect(output.every(face => face instanceof Object && 'width' in face && face.data)).toBe(true);
  });

  test(`${name}: a resampled face is split into row bands across workers`, async () => {
    const environment = workerEnvironment(), faces = skyFaces(environment, true);
    environment.navigator = {hardwareConcurrency: 12};
    const originals = faces.map(face => face.data.slice());
    const rotation = [0, 1, 0, -1, 0, 1], transforms = [identity, rotation, identity, rotation, identity, rotation];
    const prepared = factory(faces, transforms, new AbortController().signal, value => value ?? identity,
      createSkyResampler, runSkyResampleWorker, environment);
    await turn();
    expect(environment.workers).toHaveLength(3);
    const owners = face => environment.workers.filter(worker => worker.pending.tasks.some(task => task.face === face)).length;
    expect(owners(1)).toBe(3);
    expect(owners(0)).toBe(1);
    let finished = false;
    const result = prepared.finish(() => { throw new Error('Unexpected native fallback'); }).then(value => { finished = true; return value; });
    environment.workers[0].flush();
    environment.workers[2].flush();
    await turn();
    expect(finished).toBe(false);
    environment.workers[1].flush();
    const output = await result;
    for (let index = 0; index < 6; index++) expect(pixelsOf(output[index])).toEqual(expected(faces[index], originals[index], transforms[index]));
    expect(environment.workers.every(worker => worker.terminated === 1)).toBe(true);
  });

  test(`${name}: one failed worker discards the bands others returned and converts natively`, async () => {
    const environment = workerEnvironment(), faces = skyFaces(environment, true);
    environment.navigator = {hardwareConcurrency: 8};
    const prepared = factory(faces, [identity, [0, 1, 0, -1, 0, 1]], new AbortController().signal,
      value => value ?? identity, createSkyResampler, runSkyResampleWorker, environment);
    await turn();
    environment.workers[0].flush();
    await turn();
    environment.workers[1].fail();
    const native = [{native: true}];
    expect(await prepared.finish(() => native)).toBe(native);
    expect(environment.workers.every(worker => worker.terminated === 1)).toBe(true);
  });

  test(`${name}: an identity sky stops its workers and returns the original bitmaps`, async () => {
    const environment = workerEnvironment();
    const faces = Array.from({length: 6}, () => new environment.ImageBitmap(3, 3, patternedInput(3, 3)));
    const prepared = factory(faces, [], new AbortController().signal, value => value ?? identity,
      createSkyResampler, runSkyResampleWorker, environment);
    const started = [...environment.workers];
    expect(await prepared.finish(() => { throw new Error('Unexpected native fallback'); })).toBe(faces);
    expect(started.every(worker => worker.terminated === 1 && worker.pending === undefined)).toBe(true);
    expect(environment.clones).toEqual([]);
  });

  for (const failure of ['unsupported worker', 'unsupported canvas', 'native image', 'CSP', 'clone', 'worker', 'worker canvas', 'malformed result', 'sparse result']) {
    test(`${name}: ${failure} uses one deferred native conversion`, async () => {
      const environment = workerEnvironment({csp: failure === 'CSP', cloneFailure: failure === 'clone',
        canvasFailure: failure === 'worker canvas'});
      const faces = skyFaces(environment);
      if (failure === 'unsupported worker') environment.Worker = undefined;
      if (failure === 'unsupported canvas') environment.OffscreenCanvas = undefined;
      if (failure === 'native image') faces[1] = {width: 3, height: 3, data: patternedInput(3, 3)};
      const prepared = factory(faces, [identity, [0, 1, 0, -1, 0, 1]], new AbortController().signal,
        value => value ?? identity, createSkyResampler, runSkyResampleWorker, environment);
      const started = [...environment.workers];
      if (failure === 'worker') environment.workers[0].fail();
      await turn();
      if (failure === 'worker canvas') environment.workers[0].flush();
      if (failure === 'malformed result') environment.workers[0].onmessage({data: {bands: [{face: 0, start: 0, end: 1, opaque: true, buffer: new ArrayBuffer(1)}]}});
      if (failure === 'sparse result') environment.workers[0].onmessage({data: {bands: new Array(6)}});
      let calls = 0;
      const native = [{native: true}];
      const convert = () => { calls++; return native; };
      expect(calls).toBe(0);
      expect(await prepared.finish(convert)).toBe(native);
      expect(await prepared.finish(convert)).toBe(native);
      expect(calls).toBe(1);
      expect(faces.filter(face => face instanceof environment.ImageBitmap).map(face => face.closed))
        .toEqual(Array(faces.filter(face => face instanceof environment.ImageBitmap).length).fill(0));
      expect(started.every(worker => worker.terminated === 1)).toBe(true);
      expect(environment.clones.every(image => image.closed === 1)).toBe(true);
    });
  }

  test(`${name}: workers that stop replying are given up on and the draw converts natively`, async () => {
    const environment = workerEnvironment(), faces = skyFaces(environment), timers = [];
    environment.setTimeout = (callback, delay) => timers.push({callback, delay, live: true});
    environment.clearTimeout = id => { timers[id - 1].live = false; };
    const prepared = factory(faces, [identity, [0, 1, 0, -1, 0, 1]], new AbortController().signal,
      value => value ?? identity, createSkyResampler, runSkyResampleWorker, environment);
    await turn();
    const native = [{native: true}];
    let calls = 0;
    const result = prepared.finish(() => { calls++; return native; });
    expect(timers.map(timer => timer.delay)).toEqual([20000]);
    await turn();
    expect(calls).toBe(0);
    timers[0].callback();
    expect(await result).toBe(native);
    expect(calls).toBe(1);
    expect(environment.workers.every(worker => worker.terminated === 1)).toBe(true);
    expect(faces.map(face => face.closed)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test(`${name}: a sky that converts in time clears its deadline`, async () => {
    const environment = workerEnvironment(), faces = skyFaces(environment), timers = [];
    environment.setTimeout = (callback, delay) => timers.push({callback, delay, live: true});
    environment.clearTimeout = id => { timers[id - 1].live = false; };
    const prepared = factory(faces, [identity, [0, 1, 0, -1, 0, 1]], new AbortController().signal,
      value => value ?? identity, createSkyResampler, runSkyResampleWorker, environment);
    await turn();
    const result = prepared.finish(() => { throw new Error('Unexpected native fallback'); });
    environment.workers[0].flush();
    expect((await result)[1].data).toEqual(nativeResample(faces[1].data, 3, 3, 3, [0, 1, 0, -1, 0, 1]));
    expect(timers.map(timer => timer.live)).toEqual([false]);
  });

  test(`${name}: cancellation terminates pending work without closing renderer-owned faces`, async () => {
    const environment = workerEnvironment(), faces = skyFaces(environment), controller = new AbortController();
    const prepared = factory(faces, [identity, [0, 1, 0, -1, 0, 1]], controller.signal,
      value => value ?? identity, createSkyResampler, runSkyResampleWorker, environment);
    await turn();
    const worker = environment.workers[0], reason = new Error('map switched');
    const finished = prepared.finish(() => { throw new Error('Fallback after abort'); });
    controller.abort(reason);
    await expect(prepared.ready).rejects.toBe(reason);
    await expect(finished).rejects.toBe(reason);
    prepared.cancel();
    worker.onmessage({data: {bands: []}});
    expect(worker.terminated).toBe(1);
    expect(environment.clones.every(image => image.closed === 1)).toBe(true);
    expect(faces.map(face => face.closed)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test(`${name}: cancellation before the faces arrive never sends them`, async () => {
    const environment = workerEnvironment(), faces = skyFaces(environment), controller = new AbortController();
    let deliver;
    const prepared = factory(new Promise(resolve => { deliver = resolve; }), [identity, [0, 1, 0, -1, 0, 1]], controller.signal,
      value => value ?? identity, createSkyResampler, runSkyResampleWorker, environment);
    const started = [...environment.workers];
    controller.abort(new Error('map switched'));
    deliver(faces);
    await turn();
    await expect(prepared.ready).rejects.toThrow('map switched');
    expect(started.every(worker => worker.terminated === 1 && worker.pending === undefined)).toBe(true);
  });

  test(`${name}: an already-aborted load never starts a worker`, async () => {
    const environment = workerEnvironment(), faces = skyFaces(environment), controller = new AbortController();
    const reason = new Error('already cancelled');
    controller.abort(reason);
    const prepared = factory(faces, [identity, [0, 1, 0, -1, 0, 1]], controller.signal,
      value => value ?? identity, createSkyResampler, runSkyResampleWorker, environment);
    await expect(prepared.ready).rejects.toBe(reason);
    await expect(prepared.finish(() => { throw new Error('Fallback after abort'); })).rejects.toBe(reason);
    expect(environment.workers).toEqual([]);
    expect(faces.map(face => face.closed)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test(`${name}: cancellation after worker completion prevents late publication`, async () => {
    const environment = workerEnvironment(), faces = skyFaces(environment), controller = new AbortController();
    const prepared = factory(faces, [identity, [0, 1, 0, -1, 0, 1]], controller.signal,
      value => value ?? identity, createSkyResampler, runSkyResampleWorker, environment);
    await turn();
    environment.workers[0].flush();
    await prepared.ready;
    const reason = new Error('map disposed');
    prepared.cancel(reason);
    await expect(prepared.finish(() => { throw new Error('Fallback after disposal'); })).rejects.toBe(reason);
    expect(faces.map(face => face.closed)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test(`${name}: late worker errors cannot discard completed pixels`, async () => {
    const environment = workerEnvironment(), faces = skyFaces(environment);
    const rotation = [0, 1, 0, -1, 0, 1];
    const prepared = factory(faces, [identity, rotation], new AbortController().signal,
      value => value ?? identity, createSkyResampler, runSkyResampleWorker, environment);
    await turn();
    const worker = environment.workers[0];
    worker.flush();
    await prepared.ready;
    worker.fail();
    const result = await prepared.finish(() => { throw new Error('Unexpected native fallback'); });
    expect(result[0]).not.toBe(faces[0]);
    expect(result[0].data).toEqual(nativeResample(faces[0].data, 3, 3, 3, identity));
  });

  test(`${name}: finishing detaches the abort listener even if native conversion throws`, async () => {
    const environment = workerEnvironment(), faces = skyFaces(environment), controller = new AbortController();
    environment.Worker = undefined;
    let listeners = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => { listeners++; return add(...args); };
    controller.signal.removeEventListener = (...args) => { listeners--; return remove(...args); };
    const prepared = factory(faces, [identity, [0, 1, 0, -1, 0, 1]], controller.signal,
      value => value ?? identity, createSkyResampler, runSkyResampleWorker, environment);
    expect(listeners).toBe(1);
    const error = new Error('native conversion failed');
    await expect(prepared.finish(() => { throw error; })).rejects.toBe(error);
    expect(listeners).toBe(0);
  });
}
