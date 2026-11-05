import {createSkyPreparation, createSkyResampler, runSkyResampleWorker} from './sky-resample.js';
import {createMapGpuPreparation, loadNativeAtlas} from './progressive-textures.js';

// Keep ImageBitmap's upload/orientation behavior. WebCodecs can decode directly
// from packed bytes, avoiding a Blob read for each image; both fallbacks remain.
export async function decodeMapImage(bytes, url, signal, nativeDecode) {
  if (signal.aborted) throw signal.reason;
  if (typeof createImageBitmap !== 'function') return nativeDecode(bytes, url, signal);
  const type = url.endsWith('.png') ? 'image/png' : url.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  const options = {premultiplyAlpha: 'none', colorSpaceConversion: 'default', imageOrientation: 'none'};
  let image;
  if (typeof ImageDecoder === 'function') {
    let decoder, frame;
    try {
      decoder = new ImageDecoder({data: bytes, type, colorSpaceConversion: 'default', preferAnimation: false});
      frame = (await decoder.decode({frameIndex: 0, completeFramesOnly: true})).image;
      if (signal.aborted) throw signal.reason;
      image = await createImageBitmap(frame, options);
    } catch {
      if (signal.aborted) throw signal.reason;
    } finally {
      frame?.close();
      decoder?.close();
    }
  }
  if (!image) {
    try {
      image = await createImageBitmap(new Blob([bytes], {type}), options);
    } catch {
      if (signal.aborted) throw signal.reason;
      return nativeDecode(bytes, url, signal);
    }
  }
  if (signal.aborted) { image.close(); throw signal.reason; }
  return image;
}

// Native meshes retain packed source bytes for other renderer owners. Copy the
// vertex stream once, combining coordinate conversion with the bounds pass.
export function decodeMapMesh(buffer, vertexCount) {
  const vertices = new Float32Array(buffer, 0, vertexCount * 12).slice();
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let offset = 0; offset < vertices.length; offset += 12) {
    const x = vertices[offset], y = vertices[offset + 2], z = -vertices[offset + 1];
    const normalY = vertices[offset + 4];
    vertices[offset + 1] = y;
    vertices[offset + 2] = z;
    vertices[offset + 4] = vertices[offset + 5];
    vertices[offset + 5] = -normalY;
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  const empty = maxX < minX || maxY < minY || maxZ < minZ;
  const centerX = empty ? 0 : (minX + maxX) * .5;
  const centerY = empty ? 0 : (minY + maxY) * .5;
  const centerZ = empty ? 0 : (minZ + maxZ) * .5;
  let radiusSquared = 0;
  for (let offset = 0; offset < vertices.length; offset += 12) {
    const x = centerX - vertices[offset], y = centerY - vertices[offset + 1], z = centerZ - vertices[offset + 2];
    radiusSquared = Math.max(radiusSquared, x * x + y * y + z * z);
  }
  return {vertices, minX, minY, minZ, maxX, maxY, maxZ, centerX, centerY, centerZ, radius: Math.sqrt(radiusSquared)};
}

function nativeMapMeshHooks(source) {
  if (source.includes('__qolMapMesh')) return source;
  const meshes = [...source.matchAll(/const (?<buffer>[\w$]+)=(?<owner>[\w$]+)\.resources\.meshes\.get\((?<mesh>[\w$]+)\.url\),(?<vertices>[\w$]+)=new Float32Array\(\k<buffer>,0,\k<mesh>\.vertexCount\*12\)\.slice\(\);for\(let (?<offset>[\w$]+)=0;\k<offset><\k<vertices>\.length;\k<offset>\+=12\)\{const (?<y>[\w$]+)=\k<vertices>\[\k<offset>\+1\],(?<normal>[\w$]+)=\k<vertices>\[\k<offset>\+4\];\k<vertices>\[\k<offset>\+1\]=\k<vertices>\[\k<offset>\+2\],\k<vertices>\[\k<offset>\+2\]=-\k<y>,\k<vertices>\[\k<offset>\+4\]=\k<vertices>\[\k<offset>\+5\],\k<vertices>\[\k<offset>\+5\]=-\k<normal>\}const (?<interleaved>[\w$]+)=new [\w$]+\(\k<vertices>,12\),(?<geometry>[\w$]+)=new [\w$]+;for\(const\[[\w$]+,[\w$]+,[\w$]+\]of\[\["position",3,0\],\["normal",3,3\],\["uv",2,6\],\["uvLight",2,8\],\["blendAlpha",1,10\],\["lightIndex",1,11\]\]\)[\s\S]{0,150}?return \k<geometry>\.setIndex\(new [\w$]+\(new Uint32Array\(\k<buffer>,\k<mesh>\.vertexCount\*48,\k<mesh>\.indexCount\),1\)\),\k<geometry>\.computeBoundingSphere\(\),\k<geometry>\.computeBoundingBox\(\)/g)];
  const boxes = [...source.matchAll(/computeBoundingBox\(\)\{this\.boundingBox===null&&\(this\.boundingBox=new ([\w$]+)\);const ([\w$]+)=this\.attributes\.position,([\w$]+)=this\.morphAttributes\.position;/g)];
  const spheres = [...source.matchAll(/computeBoundingSphere\(\)\{this\.boundingSphere===null&&\(this\.boundingSphere=new ([\w$]+)\);const ([\w$]+)=this\.attributes\.position,([\w$]+)=this\.morphAttributes\.position;/g)];
  if (meshes.length !== 1 || boxes.length !== 1 || spheres.length !== 1) return source;
  const match = meshes[0], g = match.groups;
  const stream = match[0].indexOf(`const ${g.interleaved}=`);
  const boundStart = match[0].indexOf(`,${g.geometry}.computeBoundingSphere()`);
  const result = `const ${g.buffer}=${g.owner}.resources.meshes.get(${g.mesh}.url),__qolMapMesh=${g.owner}.resources.preparedMeshes?.get(${g.mesh}.url)??__qolDecodeMapMesh(${g.buffer},${g.mesh}.vertexCount),${g.vertices}=__qolMapMesh.vertices;` +
    match[0].slice(stream, boundStart) +
    `,${g.geometry}.boundingBox=new ${boxes[0][1]},${g.geometry}.boundingBox.min.set(__qolMapMesh.minX,__qolMapMesh.minY,__qolMapMesh.minZ),${g.geometry}.boundingBox.max.set(__qolMapMesh.maxX,__qolMapMesh.maxY,__qolMapMesh.maxZ),${g.geometry}.boundingSphere=new ${spheres[0][1]},${g.geometry}.boundingSphere.center.set(__qolMapMesh.centerX,__qolMapMesh.centerY,__qolMapMesh.centerZ),${g.geometry}.boundingSphere.radius=__qolMapMesh.radius`;
  return `const __qolDecodeMapMesh=(${decodeMapMesh.toString()});` + source.slice(0, match.index) + result + source.slice(match.index + match[0].length);
}

function nativeSkyResampleHooks(source) {
  if (source.includes('__qolSkyResample')) return source;
  const pattern = /function (?<name>[\w$]+)\((?<images>[\w$]+),(?<transforms>[\w$]+)=\[\]\)\{const (?<size>[\w$]+)=Math\.max\(\.\.\.\k<images>\.map\((?<image>[\w$]+)=>Math\.max\(\k<image>\.width,\k<image>\.height\)\)\),(?<identity>[\w$]+)=\[1,0,0,0,1,0\],(?<matrices>[\w$]+)=\k<images>\.map\(\((?<face>[\w$]+),(?<index>[\w$]+)\)=>(?<parse>[\w$]+)\(\k<transforms>\[\k<index>\]\)\);[\s\S]*?return [\w$]+\.putImageData\([\w$]+,0,0\),[\w$]+\}\)\}/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return source;
  const match = matches[0], body = match[0];
  if (body.length > 1800 || !body.includes('willReadFrequently:!0') ||
      !/Math\.pow\(\([\w$]+\+\.055\)\/1\.055,2\.4\)/.test(body) ||
      !/Math\.pow\([\w$]+,1\/2\.4\)/.test(body) ||
      !/[\w$]+===3\?Math\.round\([\w$]+\*255\):[\w$]+\([\w$]+\)/.test(body)) return source;
  const {name, parse} = match.groups;
  // Keep native transform parsing, dimensions and canvas colour handling.
  // Only the allocation-heavy per-pixel colour conversion changes.
  const replacement = `const __qolSkyResample=(${createSkyResampler.toString()})();
    const __qolPrepareSky=(images,transforms,signal)=>(${createSkyPreparation.toString()})(images,transforms,signal,${parse},${createSkyResampler.toString()},${runSkyResampleWorker.toString()});
    function ${name}(images,transforms=[]){
      const size=Math.max(...images.map(image=>Math.max(image.width,image.height)));
      const identity=[1,0,0,0,1,0],matrices=images.map((image,index)=>${parse}(transforms[index]));
      if(images.every((image,index)=>image.width===size&&image.height===size&&matrices[index].every((value,axis)=>Math.abs(value-identity[axis])<1e-12)))return images;
      return images.map((image,index)=>{
        const input=document.createElement("canvas");input.width=image.width;input.height=image.height;
        const reader=input.getContext("2d",{willReadFrequently:true});reader.drawImage(image,0,0);
        const pixels=reader.getImageData(0,0,image.width,image.height).data;
        const output=document.createElement("canvas");output.width=output.height=size;
        const writer=output.getContext("2d"),result=writer.createImageData(size,size);
        __qolSkyResample(pixels,image.width,image.height,size,matrices[index],result.data);
        writer.putImageData(result,0,0);return output;
      });
    }`;
  return source.slice(0, match.index) + replacement + source.slice(match.index + body.length);
}

// These aliases must come from the same Three renderer initialization. Upload
// through its object/attribute owners, not raw GL buffers with no disposal or
// version tracking. Unknown renderer internals retain native preparation.
function nativeGpuUploadHook(source) {
  const matches = [...source.matchAll(/(?<attributes>[\w$]+)=new [\w$]+\((?<gl>[\w$]+)\),(?<bindings>[\w$]+)=new [\w$]+\(\k<gl>,\k<attributes>\),(?<geometries>[\w$]+)=new [\w$]+\(\k<gl>,\k<attributes>,(?<info>[\w$]+),\k<bindings>\),(?<objects>[\w$]+)=new (?<objectType>[\w$]+)\(\k<gl>,\k<geometries>,\k<attributes>,\k<info>\)/g)];
  const submissions = [...source.matchAll(/this\.renderBufferDirect=function\([\w$,]+\)\{/g)];
  if (matches.length !== 1 || submissions.length !== 1) return null;
  const g = matches[0].groups;
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const owners = [...source.matchAll(new RegExp(`function ${escape(g.objectType)}\\((?<gl>[\\w$]+),(?<geometries>[\\w$]+),(?<attributes>[\\w$]+),(?<info>[\\w$]+)\\)\\{let (?<cache>[\\w$]+)=new WeakMap;function (?<update>[\\w$]+)\\((?<object>[\\w$]+)\\)\\{const (?<frame>[\\w$]+)=\\k<info>\\.render\\.frame,(?<original>[\\w$]+)=\\k<object>\\.geometry,(?<geometry>[\\w$]+)=\\k<geometries>\\.get\\(\\k<object>,\\k<original>\\);[\\s\\S]{0,1600}?return \\k<geometry>\\}[\\s\\S]{0,600}?return\\{update:\\k<update>,dispose:(?<dispose>[\\w$]+)\\}\\}`, 'g'))];
  if (owners.length !== 1) return null;
  const owner = owners[0], o = owner.groups;
  const ownerFooter = `return{update:${o.update},dispose:${o.dispose}}}`;
  // Native object uploads cache the current render.frame. Idle work runs
  // before the next traversal, whose PVS pass can rewrite instance streams.
  // Never let preparation stamp that traversal's geometry/object cache entries.
  const invalidate = `${o.cache}.delete(geometry);${o.cache}.delete(object);if(object.isSkinnedMesh)${o.cache}.delete(object.skeleton);`;
  const prepare = `__qolPrepare:object=>{const geometry=object.geometry;${invalidate}try{return ${o.update}(object)}finally{${invalidate}}}`;
  const ownerText = owner[0].replace(ownerFooter, `return{update:${o.update},dispose:${o.dispose},${prepare}}}`);
  // Confirm that the selected object owner is also the native render-list
  // uploader, and that binding-state setup owns the same geometry attributes.
  if (!new RegExp(`const [\\w$]+=${escape(g.objects)}\\.update\\([\\w$]+\\),[\\w$]+=[\\w$]+\\.material`).test(source) ||
      !new RegExp(`${escape(g.bindings)}\\.setup\\([\\w$,]+\\)`).test(source)) return null;
  let text = `this.__qolPrepareGeometry=object=>{${g.bindings}.reset();try{const geometry=${g.objects}.__qolPrepare(object);if(geometry.index!==null)${g.attributes}.update(geometry.index,${g.gl}.ELEMENT_ARRAY_BUFFER)}finally{${g.bindings}.reset()}};`;
  // The current native render state is valid during intercepted submissions.
  // Expose it only when its declaration, collection and setup all belong to
  // this renderer; otherwise shader preparation conservatively skips lights.
  const states = [...source.matchAll(/(?<state>[\w$]+)=(?<states>[\w$]+)\.get\((?<scene>[\w$]+),(?<stack>[\w$]+)\.length\),\k<state>\.init\((?<camera>[\w$]+)\),\k<stack>\.push\(\k<state>\)/g)];
  if (states.length === 1) {
    const state = escape(states[0].groups.state);
    const start = source.lastIndexOf('class ', submissions[0].index);
    const render = source.lastIndexOf('this.render=function(', states[0].index);
    const prefix = source.slice(start, submissions[0].index);
    const scope = source.slice(render, states[0].index + 8000);
    if (start !== -1 && render > submissions[0].index &&
        new RegExp(`\\blet [^;]{0,300}\\b${state}=null`).test(prefix) &&
        new RegExp(`\\b${state}\\.state\\.shadowsArray\\b`).test(scope) &&
        new RegExp(`\\b${state}\\.setupLights\\(\\)`).test(scope) &&
        new RegExp(`\\b${state}\\.pushLight\\((?<light>[\\w$]+)\\),\\k<light>\\.castShadow&&${state}\\.pushShadow\\(\\k<light>\\)`).test(scope)) {
      text += `this.__qolProbeLights=()=>${states[0].groups.state}?.state.lightsArray;`;
    }
  }
  return {anchor: submissions[0][0], text, owner: owner[0], ownerText};
}

function nativeZoneTextureHook(source, factory, end) {
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const selections = [...source.slice(factory.index, end).matchAll(new RegExp(`const (?<owner>[\\w$]+)=${escape(factory[4])}\\?(?<factory>[\\w$]+)\\(${escape(factory[4])}\\):null`, 'g'))];
  if (selections.length === 0) return source.includes('"Timer zone boundaries"') ? null : {parameter: 'undefined'};
  if (selections.length !== 1) return null;
  const selected = selections[0].groups;
  const owners = [...source.matchAll(new RegExp(`function ${escape(selected.factory)}\\((?<map>[\\w$]+)\\)\\{const (?<group>[\\w$]+)=new [\\w$]+;\\k<group>\\.name="Timer zone boundaries";const (?<resources>[\\w$]+)=\\[\\],[\\s\\S]{0,6000}?dispose\\(\\)\\{for\\(const (?<entry>[\\w$]+) of \\k<resources>\\)\\k<entry>\\.dispose\\(\\)\\}\\}\\}`, 'g'))];
  if (owners.length !== 1) return null;
  const owner = owners[0], o = owner.groups;
  const labels = [...owner[0].matchAll(/[\w$]+\.push\(\{sprite:[\w$]+,[\s\S]{0,500}?texture:(?<texture>[\w$]+),material:[\w$]+\}\)/g)];
  const returned = `return{group:${o.group},update(`;
  if (labels.length !== 1 || !owner[0].includes(`${o.resources}.push(${labels[0].groups.texture})`) ||
      owner[0].split(returned).length !== 2) return null;
  // Enumerate the native disposal owner's resources, including the original
  // label maps swapped out by the first view and its shared hi-res canvas.
  // No snapshot, extra texture ownership, or pre-entry scene traversal.
  return {parameter: selected.owner, owner: owner[0],
    text: owner[0].replace(returned, `return{*__qolZoneTextures(){yield* ${o.resources}},group:${o.group},update(`)};
}

function nativeAtlasHooks(source, factory, end, world) {
  const loaders = [...source.matchAll(/function (?<name>[\w$]+)\((?<success>[\w$]+),(?<failure>[\w$]+)\)\{const (?<texture>[\w$]+)=new (?<loader>[\w$]+)\(\)\.load\((?<url>new URL\("\/assets\/agent-atlas-[^"]+",import\.meta\.url\)\.href),\k<success>,void 0,\k<failure>\);return \k<texture>\.colorSpace=(?<color>[\w$]+),\k<texture>\.magFilter=(?<mag>[\w$]+),\k<texture>\.minFilter=(?<min>[\w$]+),\k<texture>\.anisotropy=1,\k<texture>\}/g)];
  if (loaders.length === 0) return source.includes('/assets/agent-atlas-') ? null : {parameter: '[]', changes: []};
  if (loaders.length !== 1) return null;
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const loader = loaders[0], l = loader.groups;
  const owners = [...source.matchAll(new RegExp(`function (?<name>[\\w$]+)\\((?<scene>[\\w$]+)\\)\\{(?<before>(?:(?!function )[\\s\\S]){0,1800}?)(?<texture>[\\w$]+)=${escape(l.name)}\\(\\(\\)=>\\{(?<success>[^{}]{0,300})\\},\\(\\)=>\\{(?<failure>[^{}]{0,100})\\}\\)(?<after>[\\s\\S]{0,10000}?)(?<footer>\\}\\}\\})(?=const |function )`, 'g'))];
  const accepted = owners.filter(owner => {
    const o = owner.groups;
    return new RegExp(`${escape(o.texture)}\\.dispose\\(\\)`).test(o.success) &&
      new RegExp(`${escape(o.texture)}\\.dispose\\(\\)`).test(o.after) &&
      (o.after.includes('return{set(') || o.after.includes('return{update('));
  });
  if (accepted.length !== 2) return null;
  const scope = source.slice(factory.index, end), parameters = [], changes = [];
  for (const owner of accepted) {
    const o = owner.groups;
    const calls = [...scope.matchAll(new RegExp(`(?<owner>[\\w$]+)=${escape(o.name)}\\(${escape(world)}\\)`, 'g'))];
    if (calls.length !== 1) return null;
    parameters.push(`${calls[0].groups.owner}.__qolAtlasTexture`);
    const returned = o.after.includes('return{set(') ? 'return{set(' : 'return{update(';
    changes.push({before: owner[0], after: owner[0].replace(returned, `return{__qolAtlasTexture:${o.texture},${returned.slice('return{'.length)}`)});
  }
  const replacement = `function ${l.name}(${l.success},${l.failure}){const ${l.texture}=(${loadNativeAtlas.toString()})((success,failure)=>new ${l.loader}().load(${l.url},success,void 0,failure),${l.success},${l.failure});return ${l.texture}.colorSpace=${l.color},${l.texture}.magFilter=${l.mag},${l.texture}.minFilter=${l.min},${l.texture}.anisotropy=1,${l.texture}}`;
  changes.push({before: loader[0], after: replacement});
  return {parameter: `[${parameters.join(',')}]`, changes};
}



// Optional, atomic hook for the native BSP renderer. An unknown layout keeps
// its original complete-before-play preparation.
export function nativeMapLoadHooks(source) {
  source = nativeSkyResampleHooks(source);
  source = nativeMapMeshHooks(source);
  if (source.includes('__qolProgressiveMap')) return source;
  const matches = [...source.matchAll(/prepare:async ([\w$]+)=>\{const ([\w$]+)=performance\.now\(\),([\w$]+)=\[([\w$]+),([\w$]+),([\w$]+)\],([\w$]+)=([\w$]+)\.getContext\(\),([\w$]+)=\(\)=>!([\w$]+)&&!\7\.isContextLost\(\),[\s\S]*?\},setTriggersVisible:/g)];
  if (matches.length !== 1) return source;
  const match = matches[0], body = match[0];
  const [all, frame, started, scenes, sky, occluders, world, context, renderer, current, disposed] = match;
  const collection = body.match(/const ([\w$]+)=new Set\(\[\.\.\.([\w$]+)\.values\(\),\.\.\.([\w$]+)\.values\(\)\]\);[\s\S]*?\}\);let [\w$]+=performance\.now\(\);/);
  const instances = body.match(/for\(const ([\w$]+) of ([\w$]+)\)for\(const\{object:([\w$]+),matrices:([\w$]+),offsets:([\w$]+),attribute:([\w$]+)\}of \1\.objects\)([\s\S]*?);try\{([\w$]+)\(\)\}finally\{/);
  const reset = body.match(/for\(const ([\w$]+) of ([\w$]+)\)\1\.count=-1;([\w$]+)\.makeScale\(0,0,0\)/);
  const finish = body.match(/finally\{([\w$]+)=performance\.now\(\)-([\w$]+);const ([\w$]+)=([\w$]+)\?\?([\w$]+);\3&&!([\w$]+)&&([\w$]+)\.render\(\3\)\}\},setTriggersVisible:$/);
  if (!collection || !instances || !reset || !finish || reset[2] !== instances[2] ||
      finish[2] !== started || finish[4] !== frame || finish[6] !== disposed ||
      !body.includes(`for(const ${instances[1]} of ${scenes})${renderer}.compile(${instances[1]},`)) return source;
  const compile = body.match(new RegExp(`for\\(const [\\w$]+ of ${scenes}\\)${renderer}\\.compile\\([\\w$]+,([\\w$]+)\\)`));
  if (!compile) return source;
  const decode = [...source.matchAll(/function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+)\)\{const ([\w$]+)=\3\.endsWith\("\.png"\)\?"image\/png":[\s\S]*?\}async function ([\w$]+)\(([\w$]+),([\w$]+)=\{\}\)/g)];
  const factory = [...source.matchAll(new RegExp(`function ([\\w$]+)\\(([\\w$]+),([\\w$]+),([\\w$]+)\\)\\{const ${renderer}=new [\\w$]+\\(\\{canvas:\\2,antialias:!0,alpha:!1,powerPreference:"high-performance"\\}\\)`, 'g'))];
  if (decode.length !== 1 || factory.length !== 1) return source;
  const dispose = `${renderer}.dispose()}};return ${finish[7]}}`;
  if (source.split(dispose).length !== 2) return source;
  const imageMap = [...source.matchAll(/if\(([\w$]+)\?\.status==="rejected"\)throw ([\w$]+)\.clear\(\),([\w$]+)\.clear\(\),([\w$]+)\.clear\(\),([\w$]+)\.clear\(\),([\w$]+)\.reason\?\?\1\.reason/g)];
  if (imageMap.length !== 1) return source;
  const eager = [...source.matchAll(/if\((?<data>[\w$]+)\.compressedTextures&&!\k<data>\.resources\.compressed\?\.size\)\{for\(const (?<texture>[\w$]+) of (?<textures>[\w$]+)\.values\(\)\)(?<renderer>[\w$]+)\.initTexture\(\k<texture>\);for\(const (?<cube>[\w$]+) of (?<cubes>[\w$]+)\.values\(\)\)\k<renderer>\.initTexture\(\k<cube>\);(?<sky>[\w$]+)\.background instanceof [\w$]+&&\k<renderer>\.initTexture\(\k<sky>\.background\)\}/g)];
  if (eager.length !== 1 || eager[0].groups.renderer !== renderer ||
      eager[0].groups.data !== factory[0][3] || eager[0].groups.sky !== sky ||
      eager[0].groups.textures !== collection[2] || eager[0].groups.cubes !== collection[3]) return source;
  const gpu = nativeGpuUploadHook(source);
  if (!gpu) return source;
  const zones = nativeZoneTextureHook(source, factory[0], source.indexOf(dispose));
  if (!zones) return source;
  const atlases = nativeAtlasHooks(source, factory[0], source.indexOf(dispose), world);
  if (!atlases) return source;
  const viewPattern = new RegExp(`(const |,)${finish[7].replace(/[$]/g, '\\$&')}=\\{`);
  const viewDeclaration = source.slice(factory[0].index, source.indexOf(dispose)).match(viewPattern);
  if (!viewDeclaration) return source;
  const text = `__qolGpuReady:__qolGpuPreparation.ready,prepare:async ${frame}=>{
    const ${started}=performance.now(),${context}=${renderer}.getContext(),${current}=()=>!${disposed}&&!${context}.isContextLost();
    globalThis.__SURFD_QOL__?.prepareMap?.();
    try{
    // Native rendering prepares only the PVS/frustum-selected first view.
    const __qolProgressiveMap=${frame}??${finish[5]};if(__qolProgressiveMap&&${current}())${finish[7]}.render(__qolProgressiveMap);
    if(${current}()){__qolGpuPreparation.start();globalThis.__SURFD_QOL__?.enteredMap?.()}
    }catch(error){__qolGpuPreparation.dispose(error);throw error}finally{${finish[1]}=performance.now()-${started}}
  },setTriggersVisible:`;
  source = source.slice(0, match.index) + text + source.slice(match.index + all.length);
  // Resource maps still own shared native textures and their disposal; only
  // the constructor's eager upload of every decoded texture is unnecessary.
  source = source.replace(eager[0][0], '');
  const decoder = decode[0], nativeName = '__qolNativeMapImage';
  const original = decoder[0].slice(0, decoder[0].lastIndexOf('async function '));
  const wrapper = `function ${decoder[1]}(${decoder[2]},${decoder[3]},${decoder[4]}){return (${decodeMapImage.toString()})(${decoder[2]},${decoder[3]},${decoder[4]},${nativeName})}`;
  source = source.replace(original, () => wrapper + original.replace(`function ${decoder[1]}(`, `function ${nativeName}(`));
  const close = map => `for(const image of ${map}.values())if(typeof image.close==="function")image.close();`;
  source = source.replace(dispose, () => `__qolGpuPreparation.dispose();${renderer}.dispose();${close(`${factory[0][3]}.resources.images`)}}};return ${finish[7]}}`);
  const factoryIndex = source.indexOf(factory[0][0]);
  const gpuDeclaration = `(${createMapGpuPreparation.toString()})(${renderer},[${sky},${occluders},${world}],${compile[1]},[${collection[2]},${collection[3]}],()=>${finish[7]}.__qolAssetsReady,${zones.parameter},${atlases.parameter},()=>${finish[7]}.__qolTextureBindings)`;
  const viewText = `${viewDeclaration[1]}__qolGpuPreparation=${gpuDeclaration},${finish[7]}={`;
  const factoryTail = source.slice(factoryIndex).replace(viewDeclaration[0], () => viewText)
    .replace(/setQuality:([\w$]+),setBrightness:/, (_, quality) => `setQuality:(...args)=>{try{return ${quality}(...args)}finally{__qolGpuPreparation.invalidateTextures()}},setBrightness:`);
  source = source.slice(0, factoryIndex) + factoryTail;
  source = source.replace(gpu.anchor, () => gpu.text + gpu.anchor);
  source = source.replace(gpu.owner, () => gpu.ownerText);
  if (zones.owner) source = source.replace(zones.owner, () => zones.text);
  for (const change of atlases.changes) source = source.replace(change.before, () => change.after);
  const failure = imageMap[0];
  return source.replace(failure[0], () => `if(${failure[1]}?.status==="rejected"){${close(failure[4])}throw ${failure[2]}.clear(),${failure[3]}.clear(),${failure[4]}.clear(),${failure[5]}.clear(),${failure[6]}.reason??${failure[1]}.reason}`);
}
