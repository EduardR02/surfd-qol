import {expect, test} from 'bun:test';
import {decodeMapImage, decodeMapMesh, nativeMapLoadHooks} from '../extension/map-load-hooks.js';

// Deliberately unrelated private names, but the complete native loading,
// constructor, preparation and disposal signatures. Execute the generated
// renderer rather than asserting details of its injected source.
const nativeFixture = `
function Labels(map){const group=new Group;group.name="Timer zone boundaries";const resources=[],high=new Texture;high.name="hi-res";resources.push(high);const originals=[];for(const name of map.labels){const texture=new Texture;texture.name=name;resources.push(texture);const material={map:texture,dispose(){}};resources.push(material);const sprite={isSprite:true,visible:false,children:[],material:material};group.children.push(sprite);originals.push({sprite:sprite,texture:texture,material:material})}return{group:group,update(){if(originals.length)originals[0].material.map=high},dispose(){for(const resource of resources)resource.dispose()}}}
function Objects(gl,geometries,attributes,info){let frames=new WeakMap;function update(object){const frame=info.render.frame,original=object.geometry,geometry=geometries.get(object,original);if(frames.get(geometry)!==frame){geometries.update(geometry);frames.set(geometry,frame)}if(object.isInstancedMesh&&frames.get(object)!==frame){attributes.update(object.instanceMatrix,gl.ARRAY_BUFFER);frames.set(object,frame)}return geometry}function dispose(){frames=new WeakMap}return{update:update,dispose:dispose}}
class Renderer extends Driver{constructor(options){super(options);const gl=this.getContext(),info={render:{frame:0}};let attributes,bindings,geometries,objects;attributes=new Attributes(gl),bindings=new Bindings(gl,attributes),geometries=new Geometries(gl,attributes,info,bindings),objects=new Objects(gl,geometries,attributes,info);this.renderBufferDirect=function(camera,scene,geometry,material,object,group){bindings.setup(object,material,geometry);};this.nativeUpdate=object=>{const geometry=objects.update(object),material=object.material;return geometry}}}
function nativeImage(bytes,url,signal){const type=url.endsWith(".png")?"image/png":"image/jpeg";return Promise.resolve({})}async function loadAssets(slug,options={}){if(rejected?.status==="rejected")throw meshes.clear(),dds.clear(),images.clear(),buffers.clear(),failure.reason??rejected.reason}
function factory(canvas,data,map){const gpu=new Renderer({canvas:canvas,antialias:!0,alpha:!1,powerPreference:"high-performance"});
const sky=data.scenes[0],occluders=data.scenes[1],world=data.scenes[2],camera={},textureMap=data.textures,cubeMap=data.cubes,groups=data.groups,zero=data.zero;
const zones=map?Labels(map):null;if(zones){world.children.push(zones.group);zones.group.parent=world;for(const child of zones.group.children)child.parent=zones.group}const quality=value=>{for(const texture of textureMap.values())texture.version++;return value};
if(data.compressedTextures&&!data.resources.compressed?.size){for(const entry of textureMap.values())gpu.initTexture(entry);for(const entry of cubeMap.values())gpu.initTexture(entry);sky.background instanceof Texture&&gpu.initTexture(sky.background)}
let previous=null,prepareMs=0,disposed=false;const draw=()=>gpu.drawAll();
const view={setQuality:quality,setBrightness:()=>{},prepare:async frame=>{const started=performance.now(),scenes=[sky,occluders,world],context=gpu.getContext(),current=()=>!disposed&&!context.isContextLost(),yieldFrame=()=>Promise.resolve();try{
for(const node of scenes)gpu.compile(node,camera);
const textures=new Set([...textureMap.values(),...cubeMap.values()]);sky.background instanceof Texture&&textures.add(sky.background);for(const node of scenes)node.traverse(object=>{if(object.material)textures.add(object.material.map)});let time=performance.now();
for(const texture of textures)gpu.initTexture(texture);
for(const node of groups)for(const{object:mesh,matrices:matrices,offsets:offsets,attribute:attribute}of node.objects)mesh.count=offsets.length,mesh.instanceMatrix.array.set(matrices),attribute.array.set(offsets);try{draw()}finally{for(const group of groups)group.count=-1;zero.makeScale(0,0,0)}
}finally{prepareMs=performance.now()-started;const initial=frame??previous;initial&&!disposed&&view.render(initial)}},setTriggersVisible:()=>{},render(frame){zones?.update();previous=frame;gpu.drawVisible(frame)},getStats:()=>({prepareMs}),dispose(){disposed=true;zones?.dispose();gpu.dispose()}};return view}
`;

function nativeRenderer({unknown = false, unknownGpu = false, unknownZones = false, drawError = null, map = null, probeLights = false, unknownLights = false, bonuses = false} = {}) {
  const calls = {compile: 0, upload: 0, all: 0, visible: [], disposed: 0, closed: 0, traverse: 0,
    geometry: [], indices: [], streams: [], textures: [], resets: 0};
  class Texture { isTexture = true; version = 0; dispose() {} }
  class Group { children = []; }
  let lost = false, instance;
  class Renderer {
    constructor() { instance = this; this.domElement = new EventTarget(); this.extensions = {get: () => null}; }
    compile() { calls.compile++; return new Set(); }
    initTexture(texture) { calls.upload++; calls.textures.push(texture); this.onTextureUpload?.(texture); }
    getContext() { return {ARRAY_BUFFER: 34962, ELEMENT_ARRAY_BUFFER: 34963, isContextLost: () => lost}; }
    drawAll() { calls.all++; }
    drawVisible(frame) { if (drawError) throw drawError; calls.visible.push(frame); }
    dispose() { calls.disposed++; }
  }
  class Attributes {
    update(attribute, target) {
      if (target === 34963) calls.indices.push([attribute, target]);
      else calls.streams.push({attribute, version: attribute.version, values: [...attribute.array]});
    }
  }
  class Bindings { setup() {} reset() { calls.resets++; } }
  class Geometries {
    constructor(gl, attributes) { this.gl = gl; this.attributes = attributes; }
    get(object, geometry) { calls.geometry.push(object); return geometry; }
    update(geometry) {
      for (const attribute of Object.values(geometry.attributes ?? {})) this.attributes.update(attribute, this.gl.ARRAY_BUFFER);
    }
  }
  const data = {
    scenes: Array.from({length: 3}, () => ({visible: false, frustumCulled: true, children: [],
      traverse(visit) { calls.traverse++; visit(this); }})),
    textures: new Map([['wall', new Texture()]]), cubes: new Map(), groups: [],
    zero: {makeScale() {}}, compressedTextures: {},
    resources: {compressed: new Map(), images: new Map([['image', {close() { calls.closed++; }}]])},
  };
  let input = unknown ? nativeFixture.replace('powerPreference:"high-performance"', 'powerPreference:"default"') : nativeFixture;
  // The bonus update passes the map's bonus courses to the renderer and its zone labels.
  if (bonuses) input = input.replace('function factory(canvas,data,map){', 'function factory(canvas,data,map,options={}){')
    .replace('const zones=map?Labels(map):null', 'const zones=map?Labels(map,options.bonuses):null').replace('function Labels(map){', 'function Labels(map,bonuses){');
  if (unknownGpu) input = input.replace('new Objects(gl,geometries,attributes,info)', 'new Objects(gl,geometries,attributes,{})');
  if (unknownZones) input = input.replace('texture:texture,material:material', 'source:texture,material:material');
  if (probeLights) {
    input = input.replace('this.renderBufferDirect=function',
      'let previousState=null,currentState=null;const lightStack=[],lightStates={get:()=>this.testLightState};this.renderBufferDirect=function');
    input = input.replace('this.nativeUpdate=',
      `this.render=function(scene,camera){currentState=lightStates.get(scene,lightStack.length),currentState.init(camera),lightStack.push(currentState);const shadows=currentState.state.shadowsArray;currentState.setupLights();const light=camera.light;if(light.isLight)currentState.${unknownLights ? 'collectLight' : 'pushLight'}(light),light.castShadow&&currentState.pushShadow(light);this.onProbe?.();lightStack.pop();currentState=null};this.nativeUpdate=`);
  }
  const factory = new Function('Driver', 'Texture', 'Group', 'Attributes', 'Bindings', 'Geometries',
    nativeMapLoadHooks(input) + ';return factory')(Renderer, Texture, Group, Attributes, Bindings, Geometries);
  const view = factory({}, data, map, {bonuses: null});
  return {view, renderer: instance, data, calls, loseContext() { lost = true; }};
}

for (const bonuses of [false, true]) test(`native hook avoids constructor-wide uploads and all-map preparation, preserving scene visibility and cleanup${bonuses ? ' (bonus update)' : ''}`, async () => {
  const {view, data, calls} = nativeRenderer({bonuses});
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
  await expect(run.view.__qolGpuReady).rejects.toMatchObject({name: 'AbortError'});
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

test('only a drawn first frame reports that the player entered the map', async () => {
  const entries = [], previous = globalThis.__SURFD_QOL__;
  globalThis.__SURFD_QOL__ = {enteredMap() { entries.push('entered'); }};
  try {
    const drawn = nativeRenderer();
    await drawn.view.prepare({});
    expect(entries).toEqual(['entered']);
    await expect(nativeRenderer({drawError: new Error('GPU failure')}).view.prepare({})).rejects.toThrow('GPU failure');
    const lost = nativeRenderer();
    lost.loseContext();
    await lost.view.prepare({});
    expect(entries).toEqual(['entered']);
  } finally {
    globalThis.__SURFD_QOL__ = previous;
  }
});

test('native hook preserves first-frame failures instead of declaring a broken map ready', async () => {
  const failure = new Error('GPU failure');
  const {view} = nativeRenderer({drawError: failure});
  await expect(view.prepare({})).rejects.toBe(failure);
  await expect(view.__qolGpuReady).rejects.toBe(failure);
  view.dispose();
});

test('unknown Three upload ownership retains complete native preparation', async () => {
  const {view, calls} = nativeRenderer({unknownGpu: true});
  await view.prepare({});
  expect(calls.compile).toBe(3);
  expect(calls.all).toBe(1);
  expect(view.__qolGpuReady).toBeUndefined();
  view.dispose();
});

test('native GPU upload uses owned geometry and index resources without drawing or changing instances', () => {
  const {view, renderer, calls} = nativeRenderer();
  const object = {geometry: {index: {}}, count: 2, visible: false, frustumCulled: true,
    instanceMatrix: {array: Float32Array.from([1, 2, 3, 4])}};
  renderer.__qolPrepareGeometry(object);
  expect(calls.geometry).toEqual([object]);
  expect(calls.indices).toEqual([[object.geometry.index, 34963]]);
  expect(calls.resets).toBe(2);
  expect(calls.all).toBe(0);
  expect(calls.visible).toEqual([]);
  expect(object.count).toBe(2);
  expect(object.visible).toBe(false);
  expect(object.frustumCulled).toBe(true);
  expect([...object.instanceMatrix.array]).toEqual([1, 2, 3, 4]);
  view.dispose();
});

test('native probe exposes the active render-state light array without copying it', () => {
  const {view, renderer} = nativeRenderer({probeLights: true});
  const lights = [{name: 'sun'}], seen = [];
  renderer.testLightState = {state: {lightsArray: lights, shadowsArray: []},
    init() {}, setupLights() {}, pushLight() {}, pushShadow() {}};
  expect(renderer.__qolProbeLights()).toBeUndefined();
  renderer.onProbe = () => seen.push(renderer.__qolProbeLights());
  renderer.render({}, {light: {isLight: true, castShadow: true}});
  expect(seen).toHaveLength(1);
  expect(seen[0]).toBe(lights);
  expect(renderer.__qolProbeLights()).toBeUndefined();
  view.dispose();
});

test('unknown native light-state collection leaves the optional accessor absent', () => {
  const {view, renderer} = nativeRenderer({probeLights: true, unknownLights: true});
  expect(renderer.__qolProbeLights).toBeUndefined();
  expect(typeof renderer.__qolPrepareGeometry).toBe('function');
  view.dispose();
});

test('a native uploader exception restores binding state without swallowing the failure', () => {
  const {view, renderer, calls} = nativeRenderer();
  const failure = new Error('Native geometry failed');
  const object = {get geometry() { throw failure; }};
  expect(() => renderer.__qolPrepareGeometry(object)).toThrow(failure);
  expect(calls.resets).toBe(2);
  expect(calls.all).toBe(0);
  view.dispose();
});

test('idle uploads cannot suppress next-traversal PVS instance and light-offset updates', () => {
  const {view, renderer, calls} = nativeRenderer();
  const matrix = {array: Float32Array.from([1, 2, 3, 4]), version: 1};
  const offsets = {array: Float32Array.from([5]), version: 1};
  const object = {isInstancedMesh: true, geometry: {index: {}, attributes: {lightOffset: offsets}},
    instanceMatrix: matrix};
  renderer.__qolPrepareGeometry(object);
  // Native PVS/LOD compaction runs before traversal, without advancing the
  // renderer's frame counter until traversal has already uploaded its streams.
  matrix.array[0] = 9;
  offsets.array[0] = 10;
  matrix.version++;
  offsets.version++;
  renderer.nativeUpdate(object);
  expect(calls.streams.filter(stream => stream.attribute === matrix).map(stream => stream.values)).toEqual([
    [1, 2, 3, 4], [9, 2, 3, 4]
  ]);
  expect(calls.streams.filter(stream => stream.attribute === offsets).map(stream => stream.values)).toEqual([[5], [10]]);
  view.dispose();
});

for (const bonuses of [false, true]) test(`GPU completion includes original and shared zone canvases after the native first-view map swap${bonuses ? ' (bonus update)' : ''}`, async () => {
  const {view, data, calls} = nativeRenderer({map: {labels: ['near-original', 'far-original']}, bonuses});
  await view.prepare({});
  const labelGroup = data.scenes[2].children[0];
  expect(labelGroup.children[0].material.map.name).toBe('hi-res');
  const result = await view.__qolGpuReady;
  expect(new Set(calls.textures.map(texture => texture.name))).toEqual(new Set([
    undefined, 'hi-res', 'near-original', 'far-original'
  ]));
  expect(calls.all).toBe(0);
  expect(labelGroup.children[0].material.map.name).toBe('hi-res');
  expect(result.completion).toBe('submitted');
  view.dispose();
});

test('unknown native zone-resource ownership keeps native complete preparation', async () => {
  const {view, calls} = nativeRenderer({unknownZones: true});
  await view.prepare({});
  expect(view.__qolGpuReady).toBeUndefined();
  expect(calls.all).toBe(1);
  view.dispose();
});

test('native quality changes during an upload invalidate its pending GPU completion', async () => {
  const {view, renderer, data, calls} = nativeRenderer();
  const wall = data.textures.get('wall');
  let changed = false;
  renderer.onTextureUpload = texture => {
    if (texture === wall && !changed) { changed = true; expect(view.setQuality('native')).toBe('native'); }
  };
  await view.prepare({});
  await view.__qolGpuReady;
  expect(calls.textures.filter(texture => texture === wall)).toHaveLength(2);
  expect(wall.version).toBe(1);
  view.dispose();
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
