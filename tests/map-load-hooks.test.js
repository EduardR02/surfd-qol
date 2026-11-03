import {expect, test} from 'bun:test';
import {decodeMapImage, decodeMapMesh, nativeMapLoadHooks} from '../extension/map-load-hooks.js';

// Deliberately unrelated private names, but the complete native loading,
// constructor, preparation and disposal signatures. Execute the generated
// renderer rather than asserting details of its injected source.
const nativeFixture = `
function nativeImage(bytes,url,signal){const type=url.endsWith(".png")?"image/png":"image/jpeg";return Promise.resolve({})}async function loadAssets(slug,options={}){if(rejected?.status==="rejected")throw meshes.clear(),dds.clear(),images.clear(),buffers.clear(),failure.reason??rejected.reason}
function factory(canvas,data,map){const gpu=new Renderer({canvas:canvas,antialias:!0,alpha:!1,powerPreference:"high-performance"});
const sky=data.scenes[0],occluders=data.scenes[1],world=data.scenes[2],camera={},textureMap=data.textures,cubeMap=data.cubes,groups=data.groups,zero=data.zero;
if(data.compressedTextures&&!data.resources.compressed?.size){for(const entry of textureMap.values())gpu.initTexture(entry);for(const entry of cubeMap.values())gpu.initTexture(entry);sky.background instanceof Texture&&gpu.initTexture(sky.background)}
let previous=null,prepareMs=0,disposed=false;const draw=()=>gpu.drawAll();
const view={prepare:async frame=>{const started=performance.now(),scenes=[sky,occluders,world],context=gpu.getContext(),current=()=>!disposed&&!context.isContextLost(),yieldFrame=()=>Promise.resolve();try{
for(const node of scenes)gpu.compile(node,camera);
const textures=new Set([...textureMap.values(),...cubeMap.values()]);sky.background instanceof Texture&&textures.add(sky.background);for(const node of scenes)node.traverse(object=>{if(object.material)textures.add(object.material.map)});let time=performance.now();
for(const texture of textures)gpu.initTexture(texture);
for(const node of groups)for(const{object:mesh,matrices:matrices,offsets:offsets,attribute:attribute}of node.objects)mesh.count=offsets.length,mesh.instanceMatrix.array.set(matrices),attribute.array.set(offsets);try{draw()}finally{for(const group of groups)group.count=-1;zero.makeScale(0,0,0)}
}finally{prepareMs=performance.now()-started;const initial=frame??previous;initial&&!disposed&&view.render(initial)}},setTriggersVisible:()=>{},render(frame){previous=frame;gpu.drawVisible(frame)},getStats:()=>({prepareMs}),dispose(){disposed=true;gpu.dispose()}};return view}
`;

function nativeRenderer({unknown = false, drawError = null} = {}) {
  const calls = {compile: 0, upload: 0, all: 0, visible: [], disposed: 0, closed: 0, traverse: 0};
  class Texture {}
  let lost = false;
  class Renderer {
    compile() { calls.compile++; }
    initTexture() { calls.upload++; }
    getContext() { return {isContextLost: () => lost}; }
    drawAll() { calls.all++; }
    drawVisible(frame) { if (drawError) throw drawError; calls.visible.push(frame); }
    dispose() { calls.disposed++; }
  }
  const data = {
    scenes: Array.from({length: 3}, () => ({visible: false, frustumCulled: true,
      traverse(visit) { calls.traverse++; visit(this); }})),
    textures: new Map([['wall', new Texture()]]), cubes: new Map(), groups: [],
    zero: {makeScale() {}}, compressedTextures: {},
    resources: {compressed: new Map(), images: new Map([['image', {close() { calls.closed++; }}]])},
  };
  const input = unknown ? nativeFixture.replace('powerPreference:"high-performance"', 'powerPreference:"default"') : nativeFixture;
  const factory = new Function('Renderer', 'Texture', nativeMapLoadHooks(input) + ';return factory')(Renderer, Texture);
  return {view: factory({}, data, null), data, calls, loseContext() { lost = true; }};
}

test('native hook avoids constructor-wide uploads and all-map preparation, preserving scene visibility and cleanup', async () => {
  const {view, data, calls} = nativeRenderer();
  expect(calls.upload).toBe(0);
  const frame = {eyePosition: {x: 1, y: 2, z: 3}};
  await view.prepare(frame);
  expect(calls.visible).toEqual([frame]);
  expect(calls.compile).toBe(0);
  expect(calls.all).toBe(0);
  expect(calls.traverse).toBe(0);
  for (const scene of data.scenes) {
    expect(scene.visible).toBe(false);
    expect(scene.frustumCulled).toBe(true);
  }
  view.dispose();
  expect(calls.disposed).toBe(1);
  expect(calls.closed).toBe(1);
  await view.prepare(frame);
  expect(calls.visible).toEqual([frame]);
});

test('native hook retains previous-frame fallback and context-loss cancellation', async () => {
  const run = nativeRenderer(), frame = {eyePosition: {x: 5, y: 6, z: 7}};
  run.view.render(frame);
  await run.view.prepare();
  expect(run.calls.visible).toEqual([frame, frame]);
  run.loseContext();
  await run.view.prepare(frame);
  expect(run.calls.visible).toEqual([frame, frame]);
});

test('unknown native renderer layouts retain their complete native preparation', async () => {
  const {view, calls} = nativeRenderer({unknown: true});
  expect(calls.upload).toBe(1);
  await view.prepare({});
  expect(calls.compile).toBe(3);
  expect(calls.traverse).toBe(3);
  expect(calls.all).toBe(1);
  expect(calls.visible).toHaveLength(1);
});

test('native hook preserves first-frame failures instead of declaring a broken map ready', async () => {
  const failure = new Error('GPU failure');
  const {view} = nativeRenderer({drawError: failure});
  await expect(view.prepare({})).rejects.toBe(failure);
});

test('packed mesh decoding preserves immutable source bytes, normals, attributes and exact native bounds', () => {
  const source = new Float32Array([
    -3, 5, 2, .25, .5, -.75, 1, 2, 3, 4, 5, 6,
    7, -1, 4, -.5, .75, .25, 7, 8, 9, 10, 11, 12,
    2, 9, -6, 1, 0, -1, 13, 14, 15, 16, 17, 18,
  ]);
  const indices = new Uint32Array([2, 0, 1]);
  const buffer = new ArrayBuffer(source.byteLength + indices.byteLength);
  new Float32Array(buffer, 0, source.length).set(source);
  new Uint32Array(buffer, source.byteLength).set(indices);
  const original = new Uint8Array(buffer).slice();
  const decoded = decodeMapMesh(buffer, 3);
  expect(decoded.vertices).toEqual(new Float32Array([
    -3, 2, -5, .25, -.75, -.5, 1, 2, 3, 4, 5, 6,
    7, 4, 1, -.5, .25, -.75, 7, 8, 9, 10, 11, 12,
    2, -6, -9, 1, -1, -0, 13, 14, 15, 16, 17, 18,
  ]));
  expect([decoded.minX, decoded.minY, decoded.minZ]).toEqual([-3, -6, -9]);
  expect([decoded.maxX, decoded.maxY, decoded.maxZ]).toEqual([7, 4, 1]);
  expect([decoded.centerX, decoded.centerY, decoded.centerZ]).toEqual([2, -1, -4]);
  expect(decoded.radius).toBe(Math.sqrt(75));
  expect(new Uint8Array(buffer)).toEqual(original);
  decoded.vertices.fill(0);
  expect(new Uint8Array(buffer)).toEqual(original);
  expect(decodeMapMesh(buffer, 3).vertices).not.toEqual(decoded.vertices);
});

test('packed mesh bounds preserve empty geometry and signed-zero behavior', () => {
  const empty = decodeMapMesh(new ArrayBuffer(0), 0);
  expect([empty.minX, empty.minY, empty.minZ]).toEqual([Infinity, Infinity, Infinity]);
  expect([empty.maxX, empty.maxY, empty.maxZ]).toEqual([-Infinity, -Infinity, -Infinity]);
  expect([empty.centerX, empty.centerY, empty.centerZ, empty.radius]).toEqual([0, 0, 0, 0]);
  const source = new Float32Array(12);
  source[0] = -0;
  const decoded = decodeMapMesh(source.buffer, 1);
  expect(Object.is(decoded.minX, -0)).toBe(true);
  expect(Object.is(decoded.maxX, -0)).toBe(true);
  expect(Object.is(decoded.vertices[2], -0)).toBe(true);
  expect(decoded.radius).toBe(0);
  expect(() => decodeMapMesh(source.buffer, 2)).toThrow(RangeError);
});

async function withDecoder(decoder, run, imageDecoder = undefined) {
  const globals = {createImageBitmap: decoder, ImageDecoder: imageDecoder};
  const originals = new Map(Object.keys(globals).map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {value, configurable: true});
  }
  try { await run(); }
  finally {
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    }
  }
}

test('a map cancelled during bitmap decoding closes the completed bitmap and does not retry', async () => {
  const controller = new AbortController();
  let finish, closed = 0;
  await withDecoder(() => new Promise(resolve => { finish = resolve; }), async () => {
    const loading = decodeMapImage(new Uint8Array([1]), 'test.webp', controller.signal,
      () => { throw Error('Unexpected native retry'); });
    controller.abort(Error('Changed map'));
    finish({close() { closed++; }});
    await expect(loading).rejects.toThrow('Changed map');
    expect(closed).toBe(1);
  });
});

test('a decoder failure after cancellation preserves the cancellation rather than starting more work', async () => {
  const controller = new AbortController();
  let reject;
  await withDecoder(() => new Promise((_, fail) => { reject = fail; }), async () => {
    const loading = decodeMapImage(new Uint8Array([1]), 'test.png', controller.signal,
      () => { throw Error('Unexpected native retry'); });
    controller.abort(Error('Changed map'));
    reject(Error('Decode failed'));
    await expect(loading).rejects.toThrow('Changed map');
  });
});

test('unsupported bitmap decoding retains native image errors instead of swallowing them', async () => {
  for (const decoder of [undefined, () => Promise.reject(Error('Unsupported options'))]) {
    await withDecoder(decoder, async () => {
      await expect(decodeMapImage(new Uint8Array([1]), 'broken.webp', new AbortController().signal,
        () => Promise.reject(Error('Invalid image')))).rejects.toThrow('Invalid image');
    });
  }
});

test('cancelling a codec decode releases its frame and decoder without starting bitmap conversion', async () => {
  const controller = new AbortController();
  let finish, framesClosed = 0, decodersClosed = 0;
  await withDecoder(() => { throw Error('Unexpected bitmap conversion'); }, async () => {
    const loading = decodeMapImage(new Uint8Array([1]), 'test.webp', controller.signal,
      () => { throw Error('Unexpected native retry'); });
    controller.abort(Error('Changed map'));
    finish({image: {close() { framesClosed++; }}});
    await expect(loading).rejects.toThrow('Changed map');
    expect(framesClosed).toBe(1);
    expect(decodersClosed).toBe(1);
  }, class {
    decode() { return new Promise(resolve => { finish = resolve; }); }
    close() { decodersClosed++; }
  });
});

test('cancelling bitmap conversion releases both decoded and converted images', async () => {
  const controller = new AbortController();
  let finish, started, framesClosed = 0, bitmapsClosed = 0, decodersClosed = 0;
  const converting = new Promise(resolve => { started = resolve; });
  await withDecoder(() => new Promise(resolve => { finish = resolve; started(); }), async () => {
    const loading = decodeMapImage(new Uint8Array([1]), 'test.webp', controller.signal,
      () => { throw Error('Unexpected native retry'); });
    await converting;
    controller.abort(Error('Changed map'));
    finish({close() { bitmapsClosed++; }});
    await expect(loading).rejects.toThrow('Changed map');
    expect(framesClosed).toBe(1);
    expect(bitmapsClosed).toBe(1);
    expect(decodersClosed).toBe(1);
  }, class {
    async decode() { return {image: {close() { framesClosed++; }}}; }
    close() { decodersClosed++; }
  });
});

test('failed codec-to-bitmap conversion releases codec resources and preserves native image errors', async () => {
  let framesClosed = 0, decodersClosed = 0;
  await withDecoder(() => Promise.reject(Error('Unsupported bitmap conversion')), async () => {
    await expect(decodeMapImage(new Uint8Array([1]), 'broken.webp', new AbortController().signal,
      () => Promise.reject(Error('Invalid image')))).rejects.toThrow('Invalid image');
    expect(framesClosed).toBe(1);
    expect(decodersClosed).toBe(1);
  }, class {
    async decode() { return {image: {close() { framesClosed++; }}}; }
    close() { decodersClosed++; }
  });
});
