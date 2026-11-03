import {expect, test} from 'bun:test';
import {loadProgressiveAssets} from '../extension/progressive-assets.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function pack(url, entries) {
  const bytes = [];
  const selected = entries.map(({url, kind = 'image', bytes: fragment, assetOffset = 0, assetLength = fragment.length}) => {
    const entry = {url, kind, offset: bytes.length, length: fragment.length, assetOffset, assetLength};
    bytes.push(...fragment);
    return entry;
  });
  // Nonzero source view offsets catch accidental publication of backing packs.
  const storage = new Uint8Array(bytes.length + 8).fill(239);
  storage.set(bytes, 3);
  return {url, entries: selected, byteLength: bytes.length, bytes: storage.subarray(3, 3 + bytes.length)};
}

function image(url) {
  return {url, closed: 0, close() { this.closed++; }};
}

function harness(packs, {sky = [], compressedTextures = {}, useCompressed = false, validateDDS = () => {}} = {}, loader = loadProgressiveAssets) {
  const controller = new AbortController();
  const reads = new Map(packs.map(value => [value.url, deferred()]));
  const readStarts = new Map(packs.map(value => [value.url, deferred()]));
  const decodes = new Map(), decodeStarts = new Map(), decodedBytes = new Map();
  for (const value of packs) for (const entry of value.entries) {
    if (entry.kind === 'image') {
      decodes.set(entry.url, deferred());
      decodeStarts.set(entry.url, deferred());
    }
  }
  const readOrder = [], decodeOrder = [], aborts = [];
  const initial = loader({sky, compressedTextures}, packs, useCompressed, controller.signal, {
    readPack(value) {
      readOrder.push(value.url);
      readStarts.get(value.url).resolve();
      return reads.get(value.url).promise;
    },
    decodeImage(bytes, url) {
      decodedBytes.set(url, Array.from(bytes));
      decodeOrder.push(url);
      decodeStarts.get(url).resolve();
      return decodes.get(url).promise;
    },
    validateDDS,
    abort(error) {
      aborts.push(error);
      controller.abort(error);
    },
  });
  initial.catch(() => {});
  return {
    initial, controller, aborts, readOrder, decodeOrder, decodedBytes, reads, decodes,
    read(url) { reads.get(url).resolve(packs.find(value => value.url === url).bytes); },
    readStarted(url) { return readStarts.get(url).promise; },
    decodeStarted(url) { return decodeStarts.get(url).promise; },
    decode(url, value = image(url)) { decodes.get(url).resolve(value); return value; },
    finish() {
      for (const value of packs) reads.get(value.url).resolve(value.bytes);
      for (const [url, gate] of decodes) gate.resolve(image(url));
    },
  };
}

for (const [name, loader] of [
  ['module', loadProgressiveAssets],
  ['standalone injection', Function(`return (${loadProgressiveAssets.toString()})`)()],
]) {
  test(`${name}: assembles real out-of-order multi-pack mesh, image and DDS fragments`, async () => {
    const descriptor = {url: 'base.dds', format: 'DXT1', width: 4, height: 4};
    const packs = [
      pack('first', [
        {url: 'mesh', kind: 'mesh', bytes: [1, 2], assetLength: 5},
        {url: 'sky', bytes: [11], assetLength: 3},
        {url: 'base.dds', kind: 'compressed-texture', bytes: [21, 22], assetLength: 4},
      ]),
      pack('second', [
        {url: 'mesh', kind: 'mesh', bytes: [3, 4, 5], assetOffset: 2, assetLength: 5},
        {url: 'sky', bytes: [12, 13], assetOffset: 1, assetLength: 3},
        {url: 'base.dds', kind: 'compressed-texture', bytes: [23, 24], assetOffset: 2, assetLength: 4},
      ]),
    ];
    const validations = [];
    const run = harness(packs, {
      sky: Array(6).fill('sky'), useCompressed: true, compressedTextures: {'base.png': descriptor},
      validateDDS(buffer, value) { validations.push([Array.from(new Uint8Array(buffer)), value]); },
    }, loader);
    run.read('second');
    run.read('first');
    await run.decodeStarted('sky');
    expect(run.decodedBytes.get('sky')).toEqual([11, 12, 13]);
    const skyImage = run.decode('sky');
    const resources = await run.initial;
    await resources.ready;
    expect(Array.from(new Uint8Array(resources.meshes.get('mesh')))).toEqual([1, 2, 3, 4, 5]);
    expect(resources.images.get('sky')).toBe(skyImage);
    expect(Array.from(new Uint8Array(resources.compressed.get('base.png')))).toEqual([21, 22, 23, 24]);
    expect(validations).toEqual([[[21, 22, 23, 24], descriptor]]);
    expect([...resources.pendingImages.keys()]).toEqual(['sky']);
    expect([...resources.pendingCompressed.keys()]).toEqual(['base.png']);
    expect(resources.signal).toBe(run.controller.signal);
  });

  for (const [label, sky] of [
    ['null sky', null],
    ['empty sky', []],
    ['incomplete sky', ['sky']],
    ['null faces', Array(6).fill(null)],
    ['missing face', ['sky', 'sky', null, 'sky', 'sky', 'sky']],
    ['empty face', ['sky', 'sky', '', 'sky', 'sky', 'sky']],
    ['undefined face', ['sky', 'sky', undefined, 'sky', 'sky', 'sky']],
    ['too many faces', Array(7).fill('sky')],
  ]) {
    test(`${name}: native fog fallback accepts ${label} without waiting for sky decoding`, async () => {
      const run = harness([
        pack('mesh', [{url: 'world', kind: 'mesh', bytes: [1]}]),
        pack('images', [{url: 'sky', bytes: [2]}]),
      ], {sky}, loader);
      run.read('mesh');
      const resources = await run.initial;
      expect(resources.images.size).toBe(0);
      expect(run.aborts).toEqual([]);
      run.read('images');
      await run.decodeStarted('sky');
      const value = run.decode('sky');
      await resources.ready;
      expect(resources.images.get('sky')).toBe(value);
    });
  }

  test(`${name}: a complete native sky still rejects a missing packed image`, async () => {
    const run = harness([], {sky: Array(6).fill('missing')}, loader);
    await expect(run.initial).rejects.toThrow('Missing sky image');
    expect(run.aborts).toHaveLength(1);
  });
}

test('initial readiness requires every mesh and every sky image, not background decoding', async () => {
  const packs = [
    pack('background', [{url: 'wall', bytes: [9]}]),
    pack('geometry', [{url: 'world', kind: 'mesh', bytes: [1]}, {url: 'prop', kind: 'mesh', bytes: [2]}]),
    pack('sky-pack', [{url: 'sky', bytes: [3]}]),
  ];
  const run = harness(packs, {sky: Array(6).fill('sky')});
  run.read('geometry');
  await run.readStarted('background');
  run.read('background');
  await run.decodeStarted('wall');
  run.read('sky-pack');
  await run.decodeStarted('sky');
  const skyImage = run.decode('sky');
  const resources = await run.initial;
  expect([...resources.meshes.keys()]).toEqual(['world', 'prop']);
  expect(resources.images.get('sky')).toBe(skyImage);
  expect(resources.images.has('wall')).toBe(false);
  const observed = resources.pendingImages.get('wall').then(value => {
    expect(resources.images.get('wall')).toBe(value);
    return value;
  });
  const wall = run.decode('wall');
  expect(await observed).toBe(wall);
  await resources.ready;
});

test('pack reading progresses while image decode work is bounded', async () => {
  const packs = [
    pack('many-images', Array.from({length: 9}, (_, index) => ({url: `image-${index}`, bytes: [index]}))),
    pack('blocked-read', [{url: 'other', bytes: [10]}]),
    pack('next-read', [{url: 'last', bytes: [11]}]),
  ];
  const run = harness(packs);
  const resources = await run.initial;
  run.read('many-images');
  await run.readStarted('next-read');
  expect(run.decodeOrder).toEqual(['image-0', 'image-1', 'image-2', 'image-3']);
  expect(resources.images.size).toBe(0);
  run.finish();
  await resources.ready;
  expect(resources.images.size).toBe(11);
});

test('requested images jump ahead of already queued background decodes', async () => {
  const packs = [pack('images', ['a', 'b', 'c', 'd', 'background', 'requested'].map(url => ({url, bytes: [1]})))];
  const run = harness(packs);
  const resources = await run.initial;
  run.read('images');
  await run.decodeStarted('d');
  resources.prioritize(['requested']);
  run.decode('a');
  await run.decodeStarted('requested');
  expect(run.decodeOrder).toEqual(['a', 'b', 'c', 'd', 'requested']);
  run.finish();
  await resources.ready;
});

test('requested base texture URLs prioritize unread compressed packs and retain native DDS validation', async () => {
  const descriptor = {url: 'wanted.dds', format: 'DXT5', width: 4, height: 4};
  const packs = [
    pack('mesh', [{url: 'world', kind: 'mesh', bytes: [1]}]),
    pack('active', [{url: 'active-image', bytes: [2]}]),
    pack('next-active', [{url: 'next-image', bytes: [3]}]),
    ...Array.from({length: 8}, (_, i) => pack(`blocked-${i}`, [{url: `blocked-image-${i}`, bytes: [i]}])),
    pack('background', [{url: 'background-image', bytes: [4]}]),
    pack('requested', [{url: 'wanted.dds', kind: 'compressed-texture', bytes: [5, 6]}]),
  ];
  let validated = false;
  const run = harness(packs, {
    useCompressed: true, compressedTextures: {'wanted.png': descriptor},
    validateDDS() {
      validated = true;
    },
  });
  run.read('mesh');
  const resources = await run.initial;
  await run.readStarted('next-active');
  resources.prioritize(['wanted.png']);
  run.read('active');
  await run.readStarted('requested');
  expect(run.readOrder).not.toContain('background');
  expect(resources.pendingImages.has('wanted.png')).toBe(false);
  const observed = resources.pendingCompressed.get('wanted.png').then(buffer => {
    expect(validated).toBe(true);
    expect(resources.compressed.get('wanted.png')).toBe(buffer);
  });
  run.read('requested');
  await observed;
  expect(Array.from(new Uint8Array(resources.compressed.get('wanted.png')))).toEqual([5, 6]);
  run.finish();
  await resources.ready;
});

test('decoded selection ignores unselected compressed alternatives and publishes exact asset buffers', async () => {
  const packs = [pack('decoded', [
    {url: 'world', kind: 'mesh', bytes: [1, 2]},
    {url: 'base.png', bytes: [3, 4]},
  ])];
  const run = harness(packs, {compressedTextures: {'base.png': {url: 'base.dds'}}});
  run.read('decoded');
  const resources = await run.initial;
  await run.decodeStarted('base.png');
  expect(Array.from(new Uint8Array(resources.meshes.get('world')))).toEqual([1, 2]);
  expect(resources.pendingCompressed.size).toBe(0);
  expect(run.decodedBytes.get('base.png')).toEqual([3, 4]);
  const value = run.decode('base.png');
  expect(await resources.pendingImages.get('base.png')).toBe(value);
  await resources.ready;
});

test('cancel rejects every outstanding asset and ready, closes late images, but not renderer-owned images', async () => {
  const packs = [pack('images', ['visible', 'late', 'queued-a', 'queued-b', 'queued-c', 'never-started'].map(url => ({url, bytes: [1]})))];
  const run = harness(packs);
  const resources = await run.initial;
  run.read('images');
  await run.decodeStarted('queued-b');
  const visible = run.decode('visible');
  await resources.pendingImages.get('visible');
  await run.decodeStarted('queued-c');
  resources.cancel();
  const reason = run.controller.signal.reason;
  expect(reason.name).toBe('AbortError');
  await expect(resources.ready).rejects.toBe(reason);
  for (const url of ['late', 'queued-a', 'queued-b', 'queued-c', 'never-started']) {
    await expect(resources.pendingImages.get(url)).rejects.toBe(reason);
  }
  expect(resources.images.get('visible')).toBe(visible);
  expect(run.decodeOrder.includes('never-started')).toBe(false);
  expect(resources.meshes.size).toBe(0);
  expect(resources.compressed.size).toBe(0);
  expect(visible.closed).toBe(0);
  const late = image('late');
  const closed = deferred();
  late.close = () => { late.closed++; closed.resolve(); };
  run.decode('late', late);
  await closed.promise;
  expect(late.closed).toBe(1);
  expect(resources.images.has('late')).toBe(false);
  run.finish();
});

test('external cancellation settles initial readiness even when an in-flight pack never resolves', async () => {
  const run = harness([pack('blocked', [{url: 'world', kind: 'mesh', bytes: [1]}])]);
  const reason = new Error('owner stopped loading');
  run.controller.abort(reason);
  await expect(run.initial).rejects.toBe(reason);
  expect(run.aborts).toEqual([reason]);
});

test('failure before handoff closes loader-owned images and rejects initial readiness', async () => {
  const run = harness([
    pack('sky', [{url: 'sky', bytes: [1]}]),
    pack('mesh', [{url: 'world', kind: 'mesh', bytes: [2]}]),
  ], {sky: Array(6).fill('sky')});
  run.read('sky');
  await run.decodeStarted('sky');
  const owned = image('sky');
  const closed = deferred();
  owned.close = () => { owned.closed++; closed.resolve(); };
  run.decode('sky', owned);
  // The next microtask observes completion of the decode, not elapsed time.
  await Promise.resolve();
  const error = new Error('pack read failed');
  run.reads.get('mesh').reject(error);
  await expect(run.initial).rejects.toBe(error);
  await closed.promise;
  expect(owned.closed).toBe(1);
  expect(run.aborts).toEqual([error]);
});

for (const kind of ['decode', 'read', 'DDS validation']) {
  test(`${kind} failure rejects all background promises without publishing partial or invalid resources`, async () => {
    const error = new Error(`${kind} failed`);
    const packs = [
      pack('mesh', [{url: 'world', kind: 'mesh', bytes: [1]}]),
      pack('failing', kind === 'DDS validation'
        ? [{url: 'bad.dds', kind: 'compressed-texture', bytes: [2]}]
        : [{url: 'bad.png', bytes: [2]}]),
      pack('partial', [{url: 'split', bytes: [3], assetLength: 2}]),
      pack('unread', [{url: 'split', bytes: [4], assetOffset: 1, assetLength: 2}, {url: 'waiting.png', bytes: [5]}]),
    ];
    const run = harness(packs, {
      useCompressed: true, compressedTextures: {'bad.png': {url: 'bad.dds'}},
      validateDDS() { throw error; },
    });
    run.read('mesh');
    const resources = await run.initial;
    await run.readStarted('partial');
    run.read('partial');
    await run.readStarted('unread');
    if (kind === 'read') run.reads.get('failing').reject(error);
    else {
      run.read('failing');
      if (kind === 'decode') {
        await run.decodeStarted('bad.png');
        run.decodes.get('bad.png').reject(error);
      }
    }
    await expect(resources.ready).rejects.toBe(error);
    for (const promise of [...resources.pendingImages.values(), ...resources.pendingCompressed.values()]) {
      await expect(promise).rejects.toBe(error);
    }
    expect(Array.from(new Uint8Array(resources.meshes.get('world')))).toEqual([1]);
    expect(resources.images.size).toBe(0);
    expect(resources.compressed.size).toBe(0);
    expect(run.decodeOrder.includes('split')).toBe(false);
    expect(run.aborts).toEqual([error]);
    // A read finishing after failure must not resurrect partially assembled assets.
    run.read('unread');
    run.finish();
  });
}

test('requested image priority promotes every unread fragment pack and accepts iterable URLs', async () => {
  const packs = [
    pack('active-a', [{url: 'a', bytes: [1]}]),
    pack('active-b', [{url: 'b', bytes: [2]}]),
    ...Array.from({length: 8}, (_, i) => pack(`blocked-${i}`, [{url: `blocked-image-${i}`, bytes: [i]}])),
    pack('background', [{url: 'background', bytes: [3]}]),
    pack('wanted-first', [{url: 'wanted', bytes: [4, 5], assetLength: 4}]),
    pack('wanted-last', [{url: 'wanted', bytes: [6, 7], assetOffset: 2, assetLength: 4}]),
  ];
  const run = harness(packs);
  const resources = await run.initial;
  resources.prioritize(new Set(['wanted']));
  run.read('active-a');
  await run.readStarted('wanted-first');
  run.read('active-b');
  await run.readStarted('wanted-last');
  expect(run.readOrder).not.toContain('background');
  run.read('wanted-last');
  run.read('wanted-first');
  await run.decodeStarted('wanted');
  expect(run.decodedBytes.get('wanted')).toEqual([4, 5, 6, 7]);
  expect(resources.images.has('wanted')).toBe(false);
  const value = run.decode('wanted');
  expect(await resources.pendingImages.get('wanted')).toBe(value);
  run.finish();
  await resources.ready;
});

test('a required sky decode failure rejects initial readiness and aborts the owner', async () => {
  const run = harness([
    pack('mesh', [{url: 'world', kind: 'mesh', bytes: [1]}]),
    pack('sky', [{url: 'sky', bytes: [2]}]),
  ], {sky: Array(6).fill('sky')});
  run.read('mesh');
  run.read('sky');
  await run.decodeStarted('sky');
  const error = new Error('sky could not decode');
  run.decodes.get('sky').reject(error);
  await expect(run.initial).rejects.toBe(error);
  expect(run.aborts).toEqual([error]);
});

test('published meshes keep native vertex and index offsets for whole packs and unaligned subviews', async () => {
  for (const prefix of [0, 3]) {
    const storage = new Uint8Array(16 + prefix);
    const mesh = new ArrayBuffer(16);
    new Float32Array(mesh, 0, 3).set([1.25, -2.5, 3.75]);
    new Uint32Array(mesh, 12, 1)[0] = 2;
    storage.set(new Uint8Array(mesh), prefix);
    const entry = {url: 'mesh', kind: 'mesh', offset: prefix, length: 16, assetOffset: 0, assetLength: 16};
    const resources = await loadProgressiveAssets({}, [{url: 'pack', byteLength: storage.length, entries: [entry]}],
      false, new AbortController().signal, {
        readPack: async () => storage,
        decodeImage() { throw Error('Unexpected image decode'); },
        validateDDS() { throw Error('Unexpected DDS validation'); },
        abort(error) { throw error; },
      });
    await resources.ready;
    const buffer = resources.meshes.get('mesh');
    expect(buffer.byteLength).toBe(16);
    expect([...new Float32Array(buffer, 0, 3)]).toEqual([1.25, -2.5, 3.75]);
    expect([...new Uint32Array(buffer, 12, 1)]).toEqual([2]);
  }
});

test('DDS publication excludes unrelated pack bytes for whole buffers and subviews', async () => {
  const descriptor = {url: 'image.dds', format: 'DXT1', width: 4, height: 4};
  for (const offset of [0, 3]) {
    const storage = new Uint8Array(4 + offset).fill(99);
    const bytes = storage.subarray(offset);
    bytes.set([1, 2, 3, 4]);
    const entry = {url: descriptor.url, kind: 'compressed-texture', offset: 0, length: 4, assetOffset: 0, assetLength: 4};
    const resources = await loadProgressiveAssets({compressedTextures: {'image.png': descriptor}},
      [{url: 'single', byteLength: 4, entries: [entry]}], true, new AbortController().signal, {
        readPack: async () => bytes,
        decodeImage() { throw Error('Unexpected image decode'); },
        validateDDS() {},
        abort(error) { throw error; },
      });
    await resources.ready;
    const buffer = resources.compressed.get('image.png');
    expect(buffer.byteLength).toBe(4);
    expect(Array.from(new Uint8Array(buffer))).toEqual([1, 2, 3, 4]);
  }
});
