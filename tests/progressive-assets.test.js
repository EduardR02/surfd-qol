import {expect, test} from 'bun:test';
import {loadProgressiveAssets} from '../extension/progressive-assets.js';
import {nativeProgressiveMapHooks} from '../extension/progressive-map-hooks.js';

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

function harness(packs, {sky = [], skyTransforms, compressedTextures = {}, useCompressed = false, validateDDS = () => {}, prepareSky} = {}, loader = loadProgressiveAssets) {
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
  const initial = loader({sky, skyTransforms, compressedTextures}, packs, useCompressed, controller.signal, {
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
    validateDDS, prepareSky,
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

for (const [name, loader] of [
  ['module', loadProgressiveAssets],
  ['standalone injection', Function(`return (${loadProgressiveAssets.toString()})`)()],
]) {
  test(`${name}: sky processing starts on the final face, before mesh handoff, without awaiting it`, async () => {
    const urls = Array.from({length: 6}, (_, index) => `sky-${index}`);
    const transforms = ['rotate 90'], started = deferred(), skyReady = deferred(), cancellations = [];
    const preparation = {ready: skyReady.promise, cancel: reason => cancellations.push(reason)};
    const run = harness([
      pack('sky-pack', urls.map((url, index) => ({url, bytes: [index]}))),
      pack('mesh-pack', [{url: 'world', kind: 'mesh', bytes: [9]}]),
    ], {sky: urls, skyTransforms: transforms, prepareSky(faces, values, signal) {
      started.resolve({faces, values, signal});
      return preparation;
    }}, loader);
    run.read('sky-pack');
    await run.decodeStarted(urls[3]);
    const images = urls.slice(0, 4).map(url => run.decode(url));
    await run.decodeStarted(urls[5]);
    images.push(run.decode(urls[4]), run.decode(urls[5]));
    const call = await started.promise;
    expect(call.faces).toEqual(images);
    expect(call.values).toBe(transforms);
    expect(call.signal).toBe(run.controller.signal);

    let handedOff = false;
    run.initial.then(() => { handedOff = true; });
    await Promise.resolve();
    expect(handedOff).toBe(false);
    run.read('mesh-pack');
    const resources = await run.initial;
    expect(resources.skyPreparation).toBe(preparation);
    expect(handedOff).toBe(true);
    await resources.ready;
    const reason = new Error('map switched');
    run.controller.abort(reason);
    resources.cancel();
    expect(cancellations).toEqual([reason]);
    expect(images.map(value => value.closed)).toEqual([0, 0, 0, 0, 0, 0]);
    skyReady.resolve();
  });

  test(`${name}: aborting before handoff cancels sky work and closes its source images`, async () => {
    const started = deferred(), cancellations = [], face = image('shared-sky');
    const run = harness([
      pack('sky-pack', [{url: 'shared-sky', bytes: [1]}]),
      pack('mesh-pack', [{url: 'world', kind: 'mesh', bytes: [2]}]),
    ], {sky: Array(6).fill('shared-sky'), prepareSky(faces) {
      expect(faces).toEqual(Array(6).fill(face));
      started.resolve();
      return {cancel: reason => cancellations.push(reason)};
    }}, loader);
    run.read('sky-pack');
    await run.decodeStarted('shared-sky');
    run.decode('shared-sky', face);
    await started.promise;
    const reason = new Error('cancelled while installing');
    run.controller.abort(reason);
    await expect(run.initial).rejects.toBe(reason);
    expect(cancellations).toEqual([reason]);
    expect(face.closed).toBe(1);
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

// Complete, deliberately renamed native signatures. The generated functions
// execute, including their probe, CubeTexture construction and first draw.
const progressiveFixture = `
const __qolPrepareSky=(images,transforms,signal)=>deps.prepareSky(images,transforms,signal);
function qb(images,transforms=[]){return deps.nativeSky(images,transforms)}
function parseDDS(buffer,descriptor){validateDDS(buffer,descriptor);const parsed=new DDSParser().parse(buffer,!0),format={DXT1:D1,DXT1A:D1A,DXT3:D3,DXT5:D5}[descriptor.format],texture=new DDSTexture(parsed.mipmaps,parsed.width,parsed.height,format);return texture.generateMipmaps=!1,texture}
async function nativeLoader(slug,options,controller){const path=Object.hasOwn(index,slug)?index[slug]:void 0;if(!path)throw new Error(\`Unknown BSP visual map: \${slug}\`);const signal=controller.signal,response=await fetchNative(path,signal),manifest=await fetchJson(response);validateManifest(manifest,slug);const data=manifest.data;normalize(data);const meshes=new Map,images=new Map,compressed=new Map,using=options.compressedTextures!==!1&&Object.keys(data.compressedTextures??{}).length>0&&supported(),packs=selectPacks(manifest,using),unused=0;for(const pack of packs){const bytes=await readBytes(await fetchNative(pack.url,signal),pack.byteLength);for(const entry of pack.entries){if(entry.kind==="mesh")meshes.set(entry.url,bytes);else images.set(entry.url,await decodeImage(bytes,entry.url,signal));validateDDS(bytes,{})}}return data.resources={meshes:meshes,images:images,compressed:compressed},data}
async function relay(slug,options={}){const controller=new AbortController,listener=()=>controller.abort(options.signal?.reason);options.signal?.addEventListener("abort",listener,{once:!0}),options.signal?.aborted&&listener();try{return await nativeLoader(slug,options,controller)}finally{options.signal?.removeEventListener("abort",listener)}}
function factory(canvas,data,map){const gpu=new Renderer({canvas:canvas,antialias:!0,alpha:!1,powerPreference:"high-performance"});
let disposed=!1,previous=null;const alive=()=>!disposed,sky={},cache=new Map;
const makeTexture=(url,srgb=!0,nearest=!1)=>{let texture;if(url){const buffer=data.resources.compressed?.get(url),descriptor=data.compressedTextures?.[url];if(buffer&&descriptor)texture=parseDDS(buffer,descriptor);else{const image=data.resources.images.get(url);if(!image)throw new Error(\`Missing loaded image \${url}\`);texture=new ImageTexture(image)}}else texture=new DataTexture(new Uint8Array([255,255,255,255]),1,1);texture.magFilter=nearest?NEAR:LINEAR,texture.minFilter=nearest?NEAR:isDDS&&texture.mipmaps.length===1?LINEAR:MIP;return texture};
const makeCube=urls=>{const key=urls.join("|");let texture=cache.get(key);return texture||(texture=new CubeTexture([0,1,4,5,3,2].map(face=>data.resources.images.get(urls[face]))),texture.colorSpace=SRGB,texture.needsUpdate=!0,cache.set(key,texture),texture)};
data.sky.length===6&&data.sky.every(Boolean)&&(sky.background=new CubeTexture(qb(data.sky.map(face=>data.resources.images.get(face)),data.skyTransforms))),sky.background instanceof CubeTexture&&(sky.background.colorSpace=SRGB,sky.background.needsUpdate=!0);
const view={prepare:async frame=>{globalThis.__SURFD_QOL__?.prepareMap?.();const __qolProgressiveMap=frame??previous;if(__qolProgressiveMap&&alive())view.render(__qolProgressiveMap)},render(frame){previous=frame;gpu.draw(frame,sky.background)},dispose(){disposed=!0;gpu.dispose();for(const image of data.resources.images.values())if(typeof image.close==="function")image.close();}};return view}
async function startMap(entry,resume=!1,bypass=!1){const controller=new AbortController;try{const[collision,visual]=await Promise.all([geometry(entry,controller.signal),relay(entry.slug,{signal:controller.signal})]);ready=!1;const frame=install(collision,visual,resume,bypass);await currentView.prepare?.(frame),ready=!0,success()}catch(error){if(controller.abort(error),error instanceof Error){failed(error);return}error instanceof Error&&(controls.unlock(),overlay.hidden=!1,failed(error))}finally{loading=!1,element("play").disabled=!ready,clock=performance.now(),input.reset()}if(ready)done()}async function next(){}
`;

function progressiveFixtureRunner(prepareSky, {unknownSky = false} = {}) {
  const urls = Array.from({length: 6}, (_, index) => `face-${index}`);
  const faces = urls.map(image), selected = pack('visual', urls.map((url, index) => ({url, bytes: [index]})));
  const data = {sky: urls, skyTransforms: ['rotate 90'], compressedTextures: {}};
  const manifest = {data, packs: [selected]}, calls = {fallback: 0, real: [], passes: []}, probe = deferred();
  class CubeTexture { constructor(images) { this.image = images; } }
  class Renderer {
    constructor() {
      this.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
        calls.real.push({frame: this.frame, faces: this.sky.image});
      };
    }
    draw(frame, sky) {
      this.frame = frame;
      this.sky = sky;
      calls.passes.push(sky.image);
      probe.resolve();
      this.renderBufferDirect(null, null, null, {}, null, null);
    }
    dispose() {}
  }
  const deps = {prepareSky, nativeSky(images) { calls.fallback++; return images.map(face => ({native: face})); }};
  const source = unknownSky ? progressiveFixture.replace('sky.background.needsUpdate=!0', 'sky.background.generateMipmaps=!0') : progressiveFixture;
  const run = new Function('deps', 'Renderer', 'CubeTexture', 'manifest', 'faces', `
    const index={map:"manifest"},SRGB="srgb",validateDDS=()=>{},validateManifest=()=>{},normalize=()=>{};
    const fetchNative=async url=>url,fetchJson=async()=>manifest,supported=()=>false,selectPacks=value=>value.packs;
    const readBytes=async()=>manifest.packs[0].bytes,decodeImage=async(bytes,url)=>faces[Number(url.slice(5))];
    ${nativeProgressiveMapHooks(source)}
    return {relay,factory};
  `)(deps, Renderer, CubeTexture, manifest, faces);
  return {run, data, faces, calls, probe: probe.promise};
}

test('progressive sky delays the first real draw but not renderer construction or its visibility probe', async () => {
  const gate = deferred(), converted = Array.from({length: 6}, (_, index) => ({canvas: index}));
  const preparation = {ready: gate.promise, finish: async () => { await gate.promise; return converted; }, cancel() {}};
  const fixture = progressiveFixtureRunner(() => preparation);
  const data = await fixture.run.relay('map');
  const view = fixture.run.factory({}, data, {});
  expect(fixture.calls.fallback).toBe(0);
  const frame = {id: 'first'}, preparing = view.prepare(frame);
  await fixture.probe;
  expect(fixture.calls.passes[0]).toEqual(fixture.faces);
  expect(fixture.calls.real).toEqual([]);
  gate.resolve();
  await preparing;
  expect(fixture.calls.real).toEqual([{frame, faces: converted}]);
  expect(fixture.calls.real[0].faces).toBe(converted);
  expect(fixture.calls.fallback).toBe(0);
  view.dispose();
});

test('a failed worker falls back through native sky conversion exactly once before drawing', async () => {
  const preparation = {ready: Promise.resolve(), finish: async native => native(), cancel() {}};
  const fixture = progressiveFixtureRunner(() => preparation), data = await fixture.run.relay('map');
  const view = fixture.run.factory({}, data, {});
  expect(fixture.calls.fallback).toBe(0);
  await view.prepare({id: 'first'});
  await view.prepare({id: 'again'});
  expect(fixture.calls.fallback).toBe(1);
  expect(fixture.calls.real).toHaveLength(2);
  expect(fixture.calls.real[0].faces).toEqual(fixture.faces.map(face => ({native: face})));
  expect(fixture.calls.real[1].faces).toBe(fixture.calls.real[0].faces);
  view.dispose();
});

test('disposing while the sky worker is pending cancels it and prevents a real draw', async () => {
  const gate = deferred();
  gate.promise.catch(() => {});
  const preparation = {ready: gate.promise, finish: async () => { await gate.promise; return []; },
    cancel(reason) { gate.reject(reason); }};
  const fixture = progressiveFixtureRunner(() => preparation), data = await fixture.run.relay('map');
  const view = fixture.run.factory({}, data, {}), preparing = view.prepare({id: 'cancelled'});
  await fixture.probe;
  view.dispose();
  await expect(preparing).rejects.toMatchObject({name: 'AbortError'});
  expect(fixture.calls.real).toEqual([]);
  expect(fixture.faces.map(face => face.closed)).toEqual([1, 1, 1, 1, 1, 1]);
});

test('external map cancellation remains relayed after other assets finish while the sky is pending', async () => {
  const controller = new AbortController(), gate = deferred(), aborted = deferred();
  gate.promise.catch(() => {});
  const fixture = progressiveFixtureRunner((faces, transforms, signal) => {
    signal.addEventListener('abort', () => { aborted.resolve(signal.reason); gate.reject(signal.reason); }, {once: true});
    return {ready: gate.promise, finish: async () => gate.promise, cancel: reason => gate.reject(reason)};
  });
  const data = await fixture.run.relay('map', {signal: controller.signal});
  await data.resources.ready;
  const reason = new Error('external switch');
  controller.abort(reason);
  expect(await aborted.promise).toBe(reason);
  await expect(data.resources.skyPreparation.ready).rejects.toBe(reason);
  data.resources.cancel();
});

test('external cancellation also reaches a completed but not yet installed sky', async () => {
  const controller = new AbortController(), aborted = deferred();
  const fixture = progressiveFixtureRunner((faces, transforms, signal) => {
    signal.addEventListener('abort', () => aborted.resolve(signal.reason), {once: true});
    return {ready: Promise.resolve(), finish: async () => faces, cancel() {}};
  });
  const data = await fixture.run.relay('map', {signal: controller.signal});
  await Promise.all([data.resources.ready, data.resources.skyPreparation.ready]);
  const reason = new Error('cancel before installation');
  controller.abort(reason);
  expect(await aborted.promise).toBe(reason);
  data.resources.cancel();
});

test('an unknown native sky layout retains the complete original loader and draw', async () => {
  let preparations = 0;
  const fixture = progressiveFixtureRunner(() => { preparations++; }, {unknownSky: true});
  const data = await fixture.run.relay('map'), view = fixture.run.factory({}, data, {});
  await view.prepare({id: 'native'});
  expect(preparations).toBe(0);
  expect(fixture.calls.fallback).toBe(1);
  expect(fixture.calls.real).toHaveLength(1);
  expect(fixture.calls.real[0].faces).toEqual(fixture.faces.map(face => ({native: face})));
  view.dispose();
});
