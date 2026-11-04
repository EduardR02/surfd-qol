import {expect, test} from 'bun:test';
import {gzipSync} from 'node:zlib';
import {createVisualPackProcessor} from '../extension/map-asset-worker.js';
import {decodeMapMesh} from '../extension/map-load-hooks.js';
import {loadProgressiveAssets} from '../extension/progressive-assets.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return {promise, resolve, reject};
}

function image(url) {
  const closed = deferred();
  return {url, closed: 0, closedPromise: closed.promise, close() { this.closed++; closed.resolve(); }};
}

function pack(url, fragments) {
  const bytes = [];
  const entries = fragments.map(({url, kind = 'image', bytes: fragment, assetOffset = 0, assetLength = fragment.length}) => {
    const entry = {url, kind, offset: bytes.length, length: fragment.length, assetOffset, assetLength};
    bytes.push(...fragment);
    return entry;
  });
  return {url, byteLength: bytes.length, entries, bytes: Uint8Array.from(bytes)};
}

function controlledStream() {
  let controller;
  const cancelled = deferred();
  const body = new ReadableStream({
    start(value) { controller = value; },
    cancel(reason) { cancelled.resolve(reason); },
  });
  return {body, cancelled: cancelled.promise,
    send(bytes) { controller.enqueue(Uint8Array.from(bytes)); }, end() { controller.close(); }};
}

// Exercise the real processor and page loader together without a browser. The
// transport mimics job lifetimes and closes bitmap events delivered after disposal.
function localBroker({available = true, inflate = async stream => stream,
  decodeImage = async (bytes, url) => image(url), decodeMesh = decodeMapMesh} = {}) {
  const pending = new Map(), done = new Map(), events = [], requests = [];
  let next = 0, disposed = false;
  function completed(type) {
    if (!done.has(type)) done.set(type, deferred());
    return done.get(type).promise;
  }
  const processor = createVisualPackProcessor({inflate, decodeImage, decodeMesh,
    emit(id, event, transfers = []) {
      events.push({event, transfers});
      const job = pending.get(id);
      if (!job) {
        if (event.kind === 'image') event.value.close?.();
      } else job.onEvent?.(event);
    },
  });
  return {
    ready: Promise.resolve(available), events, requests, completed,
    get disposed() { return disposed; },
    run(type, payload, transfers = [], onEvent) {
      requests.push({type, payload, transfers});
      if (disposed) return Promise.reject(new DOMException('Worker disposed', 'AbortError'));
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, {onEvent, reject});
        Promise.resolve().then(() => processor.run(id, type, payload)).then(result => {
          if (!pending.delete(id)) return;
          if (!done.has(type)) done.set(type, deferred());
          done.get(type).resolve();
          resolve(result);
        }, error => {
          if (pending.delete(id)) reject(error);
        });
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const error = new DOMException('Worker disposed', 'AbortError');
      for (const job of pending.values()) job.reject(error);
      pending.clear();
    },
  };
}

function harness(packs, {data = {}, useCompressed = false, broker = localBroker(),
  decodeImage = async (bytes, url) => image(url), validateDDS = () => {}, prepareSky, fetchPack} = {}) {
  const controller = new AbortController(), aborts = [], order = [], fallbackReads = [], starts = new Map(), streams = new Map();
  for (const value of packs) {
    starts.set(value.url, deferred());
    streams.set(value.url, controlledStream());
  }
  const loader = Function('__qolCreateMapLoadJobs', '__qolMapWorkerSource',
    `return (${loadProgressiveAssets.toString()})`)(() => broker, 'worker source');
  const initial = loader({sky: [], compressedTextures: {}, ...data}, packs, useCompressed, controller.signal, {
    fetchPack(value) {
      order.push(value.url);
      starts.get(value.url).resolve();
      return fetchPack ? fetchPack(value) : Promise.resolve({ok: true, body: streams.get(value.url).body});
    },
    readPack: async value => { fallbackReads.push(value.url); return value.bytes; },
    decodeImage, validateDDS, prepareSky,
    abort(error) { aborts.push(error); controller.abort(error); },
  });
  initial.catch(() => {});
  return {initial, controller, aborts, order, fallbackReads, broker, streams,
    started: url => starts.get(url).promise,
    send(url) { streams.get(url).send(packs.find(value => value.url === url).bytes); },
    end(url) { streams.get(url).end(); },
  };
}

function meshBytes() {
  const buffer = new ArrayBuffer(52);
  new Float32Array(buffer, 0, 12).set([1.25, -2.5, 3.75, .25, .5, .75, 0, 1, 2, 3, 4, 5]);
  new Uint32Array(buffer, 48, 1)[0] = 0;
  return new Uint8Array(buffer);
}

test('worker assembles out-of-order fragments, decodes before pack EOF, and transfers native plus prepared meshes', async () => {
  const mesh = meshBytes(), skyStarted = deferred(), skyResult = deferred(), inputs = new Map(), validations = [];
  const descriptor = {url: 'base.dds', format: 'DXT1', width: 4, height: 4};
  const packs = [
    pack('first', [
      {url: 'mesh', kind: 'mesh', bytes: mesh.slice(0, 21), assetLength: mesh.length},
      {url: 'sky', bytes: [11], assetLength: 3},
      {url: 'base.dds', kind: 'compressed-texture', bytes: [21, 22], assetLength: 4},
    ]),
    pack('second', [
      {url: 'mesh', kind: 'mesh', bytes: mesh.slice(21), assetOffset: 21, assetLength: mesh.length},
      {url: 'sky', bytes: [12, 13], assetOffset: 1, assetLength: 3},
      {url: 'base.dds', kind: 'compressed-texture', bytes: [23, 24], assetOffset: 2, assetLength: 4},
    ]),
  ];
  const broker = localBroker({decodeImage(bytes, url) {
    inputs.set(url, Array.from(bytes));
    skyStarted.resolve();
    return skyResult.promise;
  }});
  const run = harness(packs, {broker, useCompressed: true,
    data: {sky: Array(6).fill('sky'), world: [{url: 'mesh', vertexCount: 1}], compressedTextures: {'base.png': descriptor}},
    validateDDS(buffer, value) { validations.push([Array.from(new Uint8Array(buffer)), value]); },
  });
  await Promise.all([run.started('first'), run.started('second')]);
  run.send('second');
  const first = run.streams.get('first');
  for (let offset = 0; offset < packs[0].bytes.length; offset += 4) {
    first.send(packs[0].bytes.subarray(offset, offset + 4));
  }
  await skyStarted.promise;
  expect(inputs.get('sky')).toEqual([11, 12, 13]);
  const sky = image('sky');
  skyResult.resolve(sky);
  const resources = await run.initial;
  const original = resources.meshes.get('mesh'), prepared = resources.preparedMeshes.get('mesh');
  expect(Array.from(new Uint8Array(original))).toEqual(Array.from(mesh));
  expect(prepared).toEqual(decodeMapMesh(mesh.buffer.slice(0), 1));
  expect(resources.images.get('sky')).toBe(sky);
  expect(validations).toEqual([[[21, 22, 23, 24], descriptor]]);
  const meshEvent = broker.events.find(value => value.event.kind === 'mesh');
  expect(meshEvent.transfers).toEqual([original, prepared.vertices.buffer]);
  let ready = false;
  resources.ready.then(() => { ready = true; });
  await Promise.resolve();
  expect(ready).toBe(false);
  run.end('first');
  run.end('second');
  await resources.ready;
  expect(broker.disposed).toBe(true);
});

test('shared mesh URLs with different vertex counts retain native per-owner decoding', async () => {
  const mesh = meshBytes(), value = pack('mesh', [{url: 'shared', kind: 'mesh', bytes: mesh}]);
  const run = harness([value], {data: {world: [
    {url: 'shared', vertexCount: 1}, {url: 'shared', vertexCount: 0},
  ]}});
  await run.started('mesh');
  run.send('mesh');
  run.end('mesh');
  const resources = await run.initial;
  await resources.ready;
  expect([...new Uint8Array(resources.meshes.get('shared'))]).toEqual([...mesh]);
  expect(resources.preparedMeshes.has('shared')).toBe(false);
});

test('a corrupt late gzip CRC rejects ready and aborts the owner after an early mesh handoff', async () => {
  const mesh = meshBytes(), value = pack('mesh-pack', [{url: 'mesh', kind: 'mesh', bytes: mesh}]);
  const compressed = new Uint8Array(gzipSync(value.bytes));
  const broker = localBroker({inflate: async stream => stream.pipeThrough(new DecompressionStream('gzip'))});
  const run = harness([value], {broker, data: {world: [{url: 'mesh', vertexCount: 1}]}});
  await run.started('mesh-pack');
  const stream = run.streams.get('mesh-pack');
  stream.send(compressed.subarray(0, compressed.length - 8));
  const resources = await run.initial;
  expect(resources.preparedMeshes.has('mesh')).toBe(true);
  const trailer = compressed.slice(-8);
  trailer[0] ^= 255;
  stream.send(trailer);
  stream.end();
  await expect(resources.ready).rejects.toThrow();
  expect(run.aborts).toHaveLength(1);
  expect(run.controller.signal.aborted).toBe(true);
  expect(run.fallbackReads).toEqual([]);
  expect(broker.disposed).toBe(true);
});

test('native image fallback remains four-wide and first-view priority outranks queued baked lighting', async () => {
  const urls = ['a', 'b', 'c', 'd', 'background', 'light', 'wanted'];
  const gates = new Map(urls.map(url => [url, deferred()]));
  const starts = new Map(urls.map(url => [url, deferred()]));
  const order = [];
  const value = pack('images', urls.map(url => ({url, bytes: [url.charCodeAt(0)]})));
  const broker = localBroker({decodeImage: async (bytes, url, signal, fallback) => fallback()});
  const run = harness([value], {broker, data: {lightmaps: [{url: 'light'}]}, decodeImage(bytes, url) {
    order.push(url);
    starts.get(url).resolve();
    return gates.get(url).promise;
  }});
  const resources = await run.initial;
  await run.started('images');
  run.send('images');
  run.end('images');
  await starts.get('d').promise;
  expect(order).toEqual(['a', 'b', 'c', 'd']);
  resources.prioritize(['wanted']);
  await broker.completed('prioritize');
  gates.get('a').resolve(image('a'));
  await starts.get('wanted').promise;
  expect(order.slice(0, 5)).toEqual(['a', 'b', 'c', 'd', 'wanted']);
  for (const url of urls) gates.get(url).resolve(image(url));
  await resources.ready;
  expect(resources.images.size).toBe(urls.length);
  const fallbackEvent = broker.events.find(value => value.event.kind === 'image-bytes');
  expect(fallbackEvent.transfers).toEqual([fallbackEvent.event.value]);
});

test('selected unread packs overtake baked lighting after handoff and all background work continues', async () => {
  const packs = [
    pack('world', [{url: 'world', kind: 'mesh', bytes: [1]}]),
    pack('prop', [{url: 'prop', kind: 'mesh', bytes: [2]}]),
    pack('light', [{url: 'light.png', bytes: [3]}]),
    pack('background', [{url: 'background.png', bytes: [4]}]),
    pack('wanted', [{url: 'wanted.png', bytes: [5]}]),
  ];
  const run = harness(packs, {data: {lightmaps: [{url: 'light.png'}]}});
  for (const url of ['light', 'background', 'wanted']) { run.send(url); run.end(url); }
  await Promise.all([run.started('world'), run.started('prop')]);
  run.send('world');
  run.send('prop');
  const resources = await run.initial;
  resources.prioritize(new Set(['wanted.png']));
  await run.broker.completed('prioritize');
  run.end('world');
  await run.started('wanted');
  expect(run.order).not.toContain('light');
  run.end('prop');
  await resources.ready;
  expect(run.order).toEqual(expect.arrayContaining(['world', 'prop', 'wanted', 'light', 'background']));
  expect([...resources.images.keys()].sort()).toEqual(['background.png', 'light.png', 'wanted.png']);
});

test('base URL priority selects its compressed pack and validates DDS on the page before publication', async () => {
  const descriptor = {url: 'wanted.dds', format: 'DXT5', width: 4, height: 4};
  const packs = [
    pack('world', [{url: 'world', kind: 'mesh', bytes: [1]}]),
    pack('prop', [{url: 'prop', kind: 'mesh', bytes: [2]}]),
    pack('light', [{url: 'light.png', bytes: [3]}]),
    pack('wanted', [{url: 'wanted.dds', kind: 'compressed-texture', bytes: [4, 5]}]),
  ];
  let validated = false;
  const run = harness(packs, {useCompressed: true,
    data: {lightmaps: [{url: 'light.png'}], compressedTextures: {'wanted.png': descriptor}},
    validateDDS(buffer, value) {
      expect([...new Uint8Array(buffer)]).toEqual([4, 5]);
      expect(value).toBe(descriptor);
      validated = true;
    },
  });
  for (const url of ['light', 'wanted']) { run.send(url); run.end(url); }
  await Promise.all([run.started('world'), run.started('prop')]);
  run.send('world');
  run.send('prop');
  const resources = await run.initial;
  resources.prioritize(['wanted.png']);
  await run.broker.completed('prioritize');
  run.end('world');
  await run.started('wanted');
  expect(run.order).not.toContain('light');
  const buffer = await resources.pendingCompressed.get('wanted.png');
  expect(validated).toBe(true);
  expect(resources.compressed.get('wanted.png')).toBe(buffer);
  expect(resources.pendingImages.has('wanted.png')).toBe(false);
  run.end('prop');
  await resources.ready;
});

test('a late native DDS validation failure invalidates worker-owned background work', async () => {
  const error = new Error('invalid native DDS');
  const packs = [pack('world', [{url: 'world', kind: 'mesh', bytes: [1]}]),
    pack('dds', [{url: 'bad.dds', kind: 'compressed-texture', bytes: [2]}])];
  const run = harness(packs, {useCompressed: true, data: {compressedTextures: {'bad.png': {url: 'bad.dds'}}},
    validateDDS() { throw error; }});
  await Promise.all([run.started('world'), run.started('dds')]);
  run.send('world');
  run.end('world');
  const resources = await run.initial;
  run.send('dds');
  await expect(resources.ready).rejects.toBe(error);
  await expect(resources.pendingCompressed.get('bad.png')).rejects.toBe(error);
  expect(resources.compressed.size).toBe(0);
  expect(run.aborts).toEqual([error]);
  run.end('dds');
});

test('worker sky preparation starts on the sixth face before a blocked mesh handoff', async () => {
  const sky = Array.from({length: 6}, (_, index) => `sky-${index}`), started = deferred();
  const packs = [pack('sky', sky.map((url, index) => ({url, bytes: [index]}))),
    pack('mesh', [{url: 'mesh', kind: 'mesh', bytes: [7]}])];
  const preparation = {cancel() {}};
  const run = harness(packs, {data: {sky}, prepareSky(faces, transforms, signal) {
    started.resolve({faces, signal});
    return preparation;
  }});
  await Promise.all([run.started('sky'), run.started('mesh')]);
  run.send('sky');
  run.end('sky');
  const call = await started.promise;
  expect(call.faces.map(value => value.url)).toEqual(sky);
  expect(call.signal).toBe(run.controller.signal);
  let handedOff = false;
  run.initial.then(() => { handedOff = true; });
  await Promise.resolve();
  expect(handedOff).toBe(false);
  run.send('mesh');
  run.end('mesh');
  const resources = await run.initial;
  expect(resources.skyPreparation).toBe(preparation);
  await resources.ready;
});

test('cancel closes a bitmap that finishes in the worker after the page has disposed its jobs', async () => {
  const started = deferred(), decoded = deferred();
  const broker = localBroker({decodeImage() { started.resolve(); return decoded.promise; }});
  const run = harness([pack('image', [{url: 'late', bytes: [1]}])], {broker});
  const resources = await run.initial;
  await run.started('image');
  run.send('image');
  run.end('image');
  await started.promise;
  resources.cancel();
  await expect(resources.ready).rejects.toMatchObject({name: 'AbortError'});
  await expect(resources.pendingImages.get('late')).rejects.toMatchObject({name: 'AbortError'});
  const late = image('late');
  decoded.resolve(late);
  await late.closedPromise;
  expect(late.closed).toBe(1);
  expect(resources.images.has('late')).toBe(false);
});

test('a pack response arriving after cancellation is cancelled rather than transferred', async () => {
  const response = deferred(), value = pack('mesh', [{url: 'mesh', kind: 'mesh', bytes: [1]}]);
  const run = harness([value], {fetchPack: () => response.promise});
  await run.started('mesh');
  const reason = new Error('map switched');
  run.controller.abort(reason);
  await expect(run.initial).rejects.toBe(reason);
  const late = controlledStream();
  response.resolve({ok: true, body: late.body});
  await late.cancelled;
  expect(run.broker.requests.filter(request => request.type === 'pack')).toHaveLength(0);
});

test('an unavailable worker falls back before any native response is fetched or transferred', async () => {
  const broker = localBroker({available: false});
  const value = pack('mesh', [{url: 'mesh', kind: 'mesh', bytes: [1, 2]}]);
  const run = harness([value], {broker, fetchPack() { throw new Error('worker fetch must not run'); }});
  const resources = await run.initial;
  await resources.ready;
  expect([...new Uint8Array(resources.meshes.get('mesh'))]).toEqual([1, 2]);
  expect(resources.preparedMeshes).toBeUndefined();
  expect(run.order).toEqual([]);
  expect(run.fallbackReads).toEqual(['mesh']);
  expect(broker.requests).toEqual([]);
  expect(broker.disposed).toBe(true);
});

test('worker size bounds and incomplete fragments reject rather than hanging', async () => {
  const broker = localBroker();
  await expect(broker.run('init', {assets: [{url: 'huge', kind: 'image', assetLength: 64 * 1024 * 1024 + 1}]}))
    .rejects.toThrow('Invalid visual asset');
  const missing = localBroker();
  await missing.run('init', {assets: [{url: 'part', kind: 'image', assetLength: 2, priority: 0}]});
  await expect(missing.run('pack', {stream: new ReadableStream(),
    pack: {byteLength: 64 * 1024 * 1024 + 1, entries: []}})).rejects.toThrow('Invalid visual pack size');
  await expect(missing.run('finish', {})).rejects.toThrow('Incomplete visual assets');
  broker.dispose();
  missing.dispose();
});
