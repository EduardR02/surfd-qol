import {createSkyResampler} from './sky-resample.js';

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
  const result = `const ${g.buffer}=${g.owner}.resources.meshes.get(${g.mesh}.url),__qolMapMesh=__qolDecodeMapMesh(${g.buffer},${g.mesh}.vertexCount),${g.vertices}=__qolMapMesh.vertices;` +
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
    function ${name}(images,transforms=[]){
      const size=Math.max(...images.map(image=>Math.max(image.width,image.height)));
      const identity=[1,0,0,0,1,0],matrices=images.map((image,index)=>${parse}(transforms[index]));
      return images.map((image,index)=>{
        if(image.width===size&&image.height===size&&matrices[index].every((value,axis)=>Math.abs(value-identity[axis])<1e-12))return image;
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
  const text = `prepare:async ${frame}=>{
    const ${started}=performance.now(),${context}=${renderer}.getContext(),${current}=()=>!${disposed}&&!${context}.isContextLost();
    globalThis.__SURFD_QOL__?.prepareMap?.();
    // Native rendering prepares only the PVS/frustum-selected first view.
    const __qolProgressiveMap=${frame}??${finish[5]};if(__qolProgressiveMap&&${current}())${finish[7]}.render(__qolProgressiveMap);
    ${finish[1]}=performance.now()-${started};
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
  source = source.replace(dispose, () => `${renderer}.dispose();${close(`${factory[0][3]}.resources.images`)}}};return ${finish[7]}}`);
  const failure = imageMap[0];
  return source.replace(failure[0], () => `if(${failure[1]}?.status==="rejected"){${close(failure[4])}throw ${failure[2]}.clear(),${failure[3]}.clear(),${failure[4]}.clear(),${failure[5]}.clear(),${failure[6]}.reason??${failure[1]}.reason}`);
}
