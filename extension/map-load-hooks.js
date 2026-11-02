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

// The visible frame prepares its own textures first. Remaining uploads and
// geometry are warmed in short idle batches, without changing the framebuffer.
export function prepareMapRenderer({renderer, scenes, camera, textures, alive, render, warm, ready,
  schedule = callback => typeof requestIdleCallback === 'function'
    ? requestIdleCallback(callback, {timeout: 50})
    : setTimeout(() => callback(null), 0),
  now = () => performance.now(),
}) {
  if (!alive()) return;
  const programs = new Set();
  const parallel = renderer.extensions?.has?.('KHR_parallel_shader_compile') && renderer.properties?.get;
  for (const scene of scenes) {
    const materials = renderer.compile(scene, camera);
    if (parallel && materials) for (const material of materials)
      for (const program of renderer.properties.get(material).programs?.values() ?? [])
        if (typeof program.isReady === 'function') programs.add(program);
  }
  render();
  if (!alive()) return;
  const pendingTextures = [...textures], objects = [];
  for (const scene of scenes) scene.traverse(object => {
    if (object.isMesh || object.isLine || object.isPoints || object.isSprite) objects.push(object);
  });
  let textureIndex = 0, objectIndex = 0;
  function batch(deadline) {
    if (!alive()) return;
    if (deadline && !deadline.didTimeout && deadline.timeRemaining() < 2) { schedule(batch); return; }
    const end = now() + 2;
    // Always allow one unit after a timeout, but never one large all-map draw.
    let worked = false;
    while (textureIndex < pendingTextures.length && alive()) {
      if (worked && (now() >= end || deadline && !deadline.didTimeout && deadline.timeRemaining() < 2)) break;
      renderer.initTexture(pendingTextures[textureIndex++]);
      worked = true;
    }
    while (textureIndex === pendingTextures.length && objectIndex < objects.length && alive()) {
      if (worked && (now() >= end || deadline && !deadline.didTimeout && deadline.timeRemaining() < 2)) break;
      // Drawing an unfinished program synchronises the driver even with a
      // parallel compiler. Leave uploads running, but defer off-screen draws.
      for (const program of programs) {
        if (!program.isReady()) { schedule(batch); return; }
        programs.delete(program);
      }
      const selected = new Set(objects.slice(objectIndex, objectIndex + 8));
      objectIndex += selected.size;
      // A zero-area scissor submits buffers/programs without painting over the
      // live view. Restore it even if the native warm-up throws.
      const scissor = renderer.getScissor({copy(value) {
        this.x = value.x; this.y = value.y; this.z = value.z; this.w = value.w;
        return this;
      }}), tested = renderer.getScissorTest();
      try {
        renderer.setScissor(0, 0, 0, 0);
        renderer.setScissorTest(true);
        warm(selected);
      } finally {
        renderer.setScissor(scissor.x, scissor.y, scissor.z, scissor.w);
        renderer.setScissorTest(tested);
      }
      worked = true;
    }
    if (alive() && (textureIndex < pendingTextures.length || objectIndex < objects.length)) schedule(batch);
  }
  function startBackground() {
    if (!alive() || !(pendingTextures.length || objects.length)) return;
    // The load owner reports ready's failure; never warm incomplete textures.
    if (ready) Promise.resolve(ready).then(() => { if (alive()) schedule(batch); }, () => {});
    else schedule(batch);
  }
  startBackground();
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

// Optional, atomic hook for the native BSP renderer. An unknown layout keeps
// its original complete-before-play preparation.
export function nativeMapLoadHooks(source) {
  source = nativeSkyResampleHooks(source);
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
  const camera = compile[1], object = instances[3];
  const collect = collection[0].slice(0, collection[0].lastIndexOf('let '));
  const decode = [...source.matchAll(/function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+)\)\{const ([\w$]+)=\3\.endsWith\("\.png"\)\?"image\/png":[\s\S]*?\}async function ([\w$]+)\(([\w$]+),([\w$]+)=\{\}\)/g)];
  const factory = [...source.matchAll(new RegExp(`function ([\\w$]+)\\(([\\w$]+),([\\w$]+),([\\w$]+)\\)\\{const ${renderer}=new [\\w$]+\\(\\{canvas:\\2,antialias:!0,alpha:!1,powerPreference:"high-performance"\\}\\)`, 'g'))];
  if (decode.length !== 1 || factory.length !== 1) return source;
  const dispose = `${renderer}.dispose()}};return ${finish[7]}}`;
  if (source.split(dispose).length !== 2) return source;
  const imageMap = [...source.matchAll(/if\(([\w$]+)\?\.status==="rejected"\)throw ([\w$]+)\.clear\(\),([\w$]+)\.clear\(\),([\w$]+)\.clear\(\),([\w$]+)\.clear\(\),([\w$]+)\.reason\?\?\1\.reason/g)];
  if (imageMap.length !== 1) return source;
  const text = `prepare:async ${frame}=>{
    const ${started}=performance.now(),${scenes}=[${sky},${occluders},${world}],${context}=${renderer}.getContext(),${current}=()=>!${disposed}&&!${context}.isContextLost();
    globalThis.__SURFD_QOL__?.prepareMap?.();
    ${collect}
    const __qolNodes=[];for(const scene of ${scenes})scene.traverse(node=>__qolNodes.push(node));
    const __qolSaved=new Array(__qolNodes.length*2);
    (${prepareMapRenderer.toString()})({renderer:${renderer},scenes:${scenes},camera:${camera},textures:${collection[1]},alive:${current},
      render:()=>{const __qolFrame=${frame}??${finish[5]};if(__qolFrame&&${current}())${finish[7]}.render(__qolFrame)},
      warm:__qolProgressiveMap=>{
        for(let index=0;index<__qolNodes.length;index++){
          const node=__qolNodes[index];__qolSaved[index*2]=node.visible;__qolSaved[index*2+1]=node.frustumCulled;
          node.visible=!(node.isMesh||node.isLine||node.isPoints||node.isSprite)||__qolProgressiveMap.has(node);
          node.frustumCulled=false;
        }
        for(const node of __qolProgressiveMap)for(let parent=node.parent;parent;parent=parent.parent)parent.visible=true;
        try{
          for(const ${instances[1]} of ${instances[2]})for(const {object:${object},matrices:${instances[4]},offsets:${instances[5]},attribute:${instances[6]}} of ${instances[1]}.objects)if(__qolProgressiveMap.has(${object})){${instances[7]};}
          ${instances[8]}();
        }finally{
          for(let index=0;index<__qolNodes.length;index++){const node=__qolNodes[index];node.visible=__qolSaved[index*2];node.frustumCulled=__qolSaved[index*2+1];}
          for(const ${reset[1]} of ${reset[2]})if(${reset[1]}.objects.some(row=>__qolProgressiveMap.has(row.object)))${reset[1]}.count=-1;
          ${reset[3]}.makeScale(0,0,0);
        }
      }
    });
    ${finish[1]}=performance.now()-${started};
  },setTriggersVisible:`;
  source = source.slice(0, match.index) + text + source.slice(match.index + all.length);
  const decoder = decode[0], nativeName = '__qolNativeMapImage';
  const original = decoder[0].slice(0, decoder[0].lastIndexOf('async function '));
  const wrapper = `function ${decoder[1]}(${decoder[2]},${decoder[3]},${decoder[4]}){return (${decodeMapImage.toString()})(${decoder[2]},${decoder[3]},${decoder[4]},${nativeName})}`;
  source = source.replace(original, () => wrapper + original.replace(`function ${decoder[1]}(`, `function ${nativeName}(`));
  const close = map => `for(const image of ${map}.values())if(typeof image.close==="function")image.close();`;
  source = source.replace(dispose, () => `${renderer}.dispose();${close(`${factory[0][3]}.resources.images`)}}};return ${finish[7]}}`);
  const failure = imageMap[0];
  return source.replace(failure[0], () => `if(${failure[1]}?.status==="rejected"){${close(failure[4])}throw ${failure[2]}.clear(),${failure[3]}.clear(),${failure[4]}.clear(),${failure[5]}.clear(),${failure[6]}.reason??${failure[1]}.reason}`);
}
