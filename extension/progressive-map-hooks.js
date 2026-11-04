import {loadProgressiveAssets} from './progressive-assets.js';
import {createProgressiveTextureBindings, nativeBspShaderSignature} from './progressive-textures.js';

// Match the loader, factories, preparation and failure path together. Never
// expose partial resources to a renderer whose delayed bindings are unknown.
export function nativeProgressiveMapHooks(source) {
  if (source.includes('__qolMapBindings') || !source.includes('__qolProgressiveMap') ||
      !source.includes('const __qolPrepareSky=')) return source;
  const id = '[\\w$]+';
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const one = matches => matches.length === 1 ? matches[0] : null;
  const loader = one([...source.matchAll(/async function (?<name>[\w$]+)\((?<slug>[\w$]+),(?<options>[\w$]+),(?<controller>[\w$]+)\)\{(?<prefix>const (?<path>[\w$]+)=Object\.hasOwn\((?<index>[\w$]+),\k<slug>\)\?\k<index>\[\k<slug>\]:void 0;if\(!\k<path>\)throw new Error\(`Unknown BSP visual map: \$\{\k<slug>\}`\);const (?<signal>[\w$]+)=\k<controller>\.signal,(?<response>[\w$]+)=await (?<fetch>[\w$]+)\(\k<path>,\k<signal>\),(?<manifest>[\w$]+)=await (?<json>[\w$]+)\(\k<response>\);(?<validate>[\w$]+)\(\k<manifest>,\k<slug>\);const (?<data>[\w$]+)=\k<manifest>\.data;(?<normalize>[\w$]+)\(\k<data>\);)const (?<meshes>[\w$]+)=new Map,(?<images>[\w$]+)=new Map,(?<compressed>[\w$]+)=new Map,(?<using>[\w$]+)=\k<options>\.compressedTextures!==!1&&Object\.keys\(\k<data>\.compressedTextures\?\?\{\}\)\.length>0&&(?<supported>[\w$]+)\(\),(?<packs>[\w$]+)=(?<select>[\w$]+)\(\k<manifest>,\k<using>\),[\s\S]{0,3500}?return \k<data>\.resources=\{meshes:\k<meshes>,images:\k<images>,compressed:\k<compressed>\},\k<data>\}/g)]);
  const dds = one([...source.matchAll(/function (?<name>[\w$]+)\((?<buffer>[\w$]+),(?<descriptor>[\w$]+)\)\{(?<validate>[\w$]+)\(\k<buffer>,\k<descriptor>\);const (?<parsed>[\w$]+)=new (?<parser>[\w$]+)\(\)\.parse\(\k<buffer>,!0\),(?<format>[\w$]+)=(?<formats>\{DXT1:[\w$]+,DXT1A:[\w$]+,DXT3:[\w$]+,DXT5:[\w$]+\})\[\k<descriptor>\.format\],(?<texture>[\w$]+)=new (?<type>[\w$]+)\(\k<parsed>\.mipmaps,\k<parsed>\.width,\k<parsed>\.height,\k<format>\);return \k<texture>\.generateMipmaps=!1,\k<texture>\}/g)]);
  const factory = one([...source.matchAll(/function (?<name>[\w$]+)\((?<canvas>[\w$]+),(?<data>[\w$]+),(?<map>[\w$]+)\)\{const (?<renderer>[\w$]+)=new (?<type>[\w$]+)\(\{canvas:\k<canvas>,antialias:!0,alpha:!1,powerPreference:"high-performance"\}\);/g)]);
  if (!loader || !dds || !factory) return source;
  const l = loader.groups, d = dds.groups, f = factory.groups;
  const packRead = loader[0].match(new RegExp(`await (${id})\\(await ${escape(l.fetch)}\\((${id})\\.url,${escape(l.signal)}\\),\\2\\.byteLength\\)`));
  const imageDecode = loader[0].match(new RegExp(`else ${escape(l.images)}\\.set\\((${id})\\.url,await (${id})\\((${id}),\\1\\.url,${escape(l.signal)}\\)\\)`));
  if (!packRead || !imageDecode || !loader[0].includes(`${d.validate}(`)) return source;
  const relay = one([...source.matchAll(/async function (?<name>[\w$]+)\((?<slug>[\w$]+),(?<options>[\w$]+)=\{\}\)\{const (?<controller>[\w$]+)=new AbortController,(?<listener>[\w$]+)=\(\)=>\k<controller>\.abort\(\k<options>\.signal\?\.reason\);\k<options>\.signal\?\.addEventListener\("abort",\k<listener>,\{once:!0\}\),\k<options>\.signal\?\.aborted&&\k<listener>\(\);try\{return await (?<load>[\w$]+)\(\k<slug>,\k<options>,\k<controller>\)\}finally\{\k<options>\.signal\?\.removeEventListener\("abort",\k<listener>\)\}\}/g)]);
  if (!relay || relay.groups.load !== l.name) return source;
  const footerText = `${f.renderer}.dispose();for(const image of ${f.data}.resources.images.values())if(typeof image.close==="function")image.close();}};return `;
  const footer = one([...source.matchAll(new RegExp(escape(footerText) + `(?<view>${id})\\}`, 'g'))]);
  if (!footer || footer.index < factory.index) return source;
  const scope = source.slice(factory.index, footer.index + footer[0].length);
  const branch = one([...scope.matchAll(/if\((?<url>[\w$]+)\)\{const (?<buffer>[\w$]+)=(?<owner>[\w$]+)\.resources\.compressed\?\.get\(\k<url>\),(?<descriptor>[\w$]+)=\k<owner>\.compressedTextures\?\.\[\k<url>\];if\(\k<buffer>&&\k<descriptor>\)(?<texture>[\w$]+)=(?<dds>[\w$]+)\(\k<buffer>,\k<descriptor>\);else\{const (?<image>[\w$]+)=\k<owner>\.resources\.images\.get\(\k<url>\);if\(!\k<image>\)throw new Error\(`Missing loaded image \$\{\k<url>\}`\);\k<texture>=new (?<imageType>[\w$]+)\(\k<image>\)\}\}else \k<texture>=new (?<dataType>[\w$]+)\(new Uint8Array\(\[255,255,255,255\]\),1,1\)/g)]);
  const textureFactory = one([...scope.matchAll(/(?<name>[\w$]+)=\((?<url>[\w$]+),(?<srgb>[\w$]+)=!0,(?<nearest>[\w$]+)=!1\)=>\{/g)]);
  const cube = one([...scope.matchAll(/(?<name>[\w$]+)=(?<urls>[\w$]+)=>\{const (?<key>[\w$]+)=\k<urls>\.join\("\|"\);let (?<texture>[\w$]+)=(?<cache>[\w$]+)\.get\(\k<key>\);return \k<texture>\|\|\(\k<texture>=new (?<type>[\w$]+)\(\[0,1,4,5,3,2\]\.map\((?<face>[\w$]+)=>(?<owner>[\w$]+)\.resources\.images\.get\(\k<urls>\[\k<face>\]\)\)\),\k<texture>\.colorSpace=(?<color>[\w$]+),\k<texture>\.needsUpdate=!0,\k<cache>\.set\(\k<key>,\k<texture>\),\k<texture>\)\}/g)]);
  const sky = one([...scope.matchAll(/(?<owner>[\w$]+)\.sky\.length===6&&\k<owner>\.sky\.every\(Boolean\)&&\((?<scene>[\w$]+)\.background=new (?<type>[\w$]+)\((?<call>(?<resample>[\w$]+)\(\k<owner>\.sky\.map\((?<face>[\w$]+)=>\k<owner>\.resources\.images\.get\(\k<face>\)\),\k<owner>\.skyTransforms\))\)\),\k<scene>\.background instanceof \k<type>&&\(\k<scene>\.background\.colorSpace=(?<color>[\w$]+),\k<scene>\.background\.needsUpdate=!0\)/g)]);
  const draw = one([...scope.matchAll(/const __qolProgressiveMap=(?<frame>[\w$]+)\?\?(?<previous>[\w$]+);if\(__qolProgressiveMap&&(?<alive>[\w$]+)\(\)\)(?<view>[\w$]+)\.render\(__qolProgressiveMap\)/g)]);
  const preparation = 'const __qolProgressiveMap=';
  const rampPreparation = 'globalThis.__SURFD_QOL__?.prepareMap?.();';
  if (!branch || !textureFactory || !cube || !sky || !draw || branch.groups.owner !== f.data ||
      branch.groups.dds !== d.name || textureFactory.groups.url !== branch.groups.url ||
      cube.groups.owner !== f.data || sky.groups.owner !== f.data || draw.groups.view !== footer.groups.view ||
      !source.includes(`function ${sky.groups.resample}(images,transforms=[])`) ||
      scope.split(preparation).length !== 2 || scope.split(rampPreparation).length !== 2) return source;
  const b = branch.groups, t = textureFactory.groups, c = cube.groups, s = sky.groups, v = draw.groups;
  const filter = scope.match(new RegExp(`${escape(b.texture)}\\.magFilter=${escape(t.nearest)}\\?(${id}):(${id}),${escape(b.texture)}\\.minFilter=${escape(t.nearest)}\\?\\1:(${id})&&${escape(b.texture)}\\.mipmaps\\.length===1\\?\\2:(${id})`));
  if (!filter) return source;
  const load = one([...source.matchAll(/async function (?<name>[\w$]+)\((?<entry>[\w$]+),(?<resume>[\w$]+)=!1,(?<bypass>[\w$]+)=!1\)\{(?<before>[\s\S]{0,1000}?)try\{const\[(?<collision>[\w$]+),(?<visual>[\w$]+)\]=await Promise\.all\(\[(?<geometry>[\w$]+)\(\k<entry>,(?<controller>[\w$]+)\.signal\),(?<visualLoad>[\w$]+)\(\k<entry>\.slug,\{signal:\k<controller>\.signal\}\)\]\);(?<ready>[\w$]+)=!1;const (?<frame>[\w$]+)=(?<install>[\w$]+)\(\k<collision>,\k<visual>,\k<resume>,\k<bypass>\);await (?<view>[\w$]+)\.prepare\?\.\(\k<frame>\),\k<ready>=!0,(?<success>[\s\S]{0,300}?)\}catch\((?<error>[\w$]+)\)\{(?<failure>[\s\S]{0,1400}?)\}finally\{(?<finalize>[\s\S]{0,200}?)\}(?<after>if[\s\S]{0,200}?)\}(?=async function)/g)]);
  if (!load || load.groups.visualLoad !== relay.groups.name) return source;
  const k = load.groups;
  const finalize = k.finalize.match(/^(?<loading>[\w$]+)=!1,(?<element>[\w$]+)\("play"\)\.disabled=!(?<ready>[\w$]+),(?<clock>[\w$]+)=performance\.now\(\),(?<input>[\w$]+)\.reset\(\)$/);
  const unlock = k.failure.match(/([\w$]+)\.unlock\(\),([\w$]+)\.hidden=!1,/);
  const abortPrefix = `if(${k.controller}.abort(${k.error}),`;
  if (!finalize || !unlock || finalize.groups.ready !== k.ready ||
      !k.failure.startsWith(abortPrefix) || k.failure.split(';return}').length !== 2) return source;

  const factoryHelpers = `let __qolSkyApplied=false;const __qolMapBindings=(${createProgressiveTextureBindings.toString()})(${f.data}.resources,(${nativeBspShaderSignature.toString()})());
    let __qolWhiteImage;const __qolDxtImages=new Map;
    function __qolWhite(){if(!__qolWhiteImage){const canvas=document.createElement("canvas");canvas.width=canvas.height=1;const context=canvas.getContext("2d");context.fillStyle="#fff";context.fillRect(0,0,1,1);__qolWhiteImage=canvas}return __qolWhiteImage}
    function __qolDxt(format){const size=format==="DXT1"||format==="DXT1A"?8:16;let levels=__qolDxtImages.get(size);if(!levels){const bytes=new Uint8Array(size);bytes.fill(255);bytes.fill(0,size-4);levels=[4,2,1].map(width=>({data:bytes,width,height:width}));__qolDxtImages.set(size,levels)}return levels}
  `;
  const textureBranch = `if(${b.url}){
    const ${b.buffer}=${f.data}.resources.compressed.get(${b.url}),${b.descriptor}=${f.data}.compressedTextures?.[${b.url}];
    if(${b.buffer}&&${b.descriptor})${b.texture}=${d.name}(${b.buffer},${b.descriptor});
    else if(${b.descriptor}&&${f.data}.resources.pendingCompressed.has(${b.url})){
      ${b.texture}=new ${d.type}(__qolDxt(${b.descriptor}.format),4,4,${d.formats}[${b.descriptor}.format]);
      __qolMapBindings.bind(${b.texture},${b.url},()=>{const parsed=new ${d.parser}().parse(${f.data}.resources.compressed.get(${b.url}),true);${b.texture}.dispose();${b.texture}.mipmaps=parsed.mipmaps;${b.texture}.image={width:parsed.width,height:parsed.height};${b.texture}.minFilter=${t.nearest}?${filter[1]}:parsed.mipmaps.length===1?${filter[2]}:${filter[4]};${b.texture}.needsUpdate=true});
    }else{
      const image=${f.data}.resources.images.get(${b.url});
      if(!image&&!${f.data}.resources.pendingImages.has(${b.url}))throw new Error(\`Missing loaded image \${${b.url}}\`);
      ${b.texture}=new ${b.imageType}(image??__qolWhite());
      if(!image)__qolMapBindings.bind(${b.texture},${b.url},()=>{${b.texture}.dispose();${b.texture}.image=${f.data}.resources.images.get(${b.url});${b.texture}.needsUpdate=true});
    }
  }else ${b.texture}=new ${b.dataType}(new Uint8Array([255,255,255,255]),1,1)`;
  const cubeFactory = `${c.name}=urls=>{const key=urls.join("|");let texture=${c.cache}.get(key);if(texture)return texture;
    const faces=[0,1,4,5,3,2];texture=new ${c.type}(faces.map(index=>${f.data}.resources.images.get(urls[index])??__qolWhite()));
    texture.colorSpace=${c.color};texture.needsUpdate=true;${c.cache}.set(key,texture);
    if(urls.some(url=>!${f.data}.resources.images.has(url)))__qolMapBindings.bind(texture,urls,()=>{texture.dispose();texture.image=faces.map(index=>${f.data}.resources.images.get(urls[index]));texture.needsUpdate=true});return texture}`;
  const skyConstruction = sky[0].replace(s.call,
    `${f.data}.resources.skyPreparation?${f.data}.sky.map(url=>${f.data}.resources.images.get(url)):${s.call}`);
  let renderer = scope.replace(branch[0], () => textureBranch).replace(cube[0], () => cubeFactory)
    .replace(sky[0], () => skyConstruction);
  renderer = renderer.replace(draw[0], () => `const __qolProgressiveMap=${v.frame}??${v.previous};
    if(!__qolSkyApplied&&${f.data}.resources.skyPreparation&&${v.alive}()){
      const faces=await ${f.data}.resources.skyPreparation.finish(()=>${s.call});
      if(${v.alive}()){${s.scene}.background.image=faces;${s.scene}.background.needsUpdate=true;__qolSkyApplied=true}
    }
    if(__qolProgressiveMap&&${v.alive}())${v.view}.render(__qolProgressiveMap)`);
  renderer = renderer.replace(factory[0], () => factory[0] + factoryHelpers);
  renderer = renderer.replace(rampPreparation, () => `const __qolFirstViewReady=__qolMapBindings.prepare(${f.renderer},()=>{const __qolProbeFrame=${v.frame}??${v.previous};if(__qolProbeFrame&&${v.alive}())${v.view}.render(__qolProbeFrame)});
    ${rampPreparation}`);
  renderer = renderer.replace(preparation, () => `await __qolFirstViewReady;\n${preparation}`);
  renderer = renderer.replace(footer[0], () => `${footerText.slice(0, footerText.lastIndexOf('return '))}
    const __qolAssetsReady=__qolMapBindings.complete();${footer.groups.view}.__qolAssetsReady=__qolAssetsReady;${footer.groups.view}.__qolTextureBindings=__qolMapBindings;
    let __qolRendererDisposed=false;const __qolDispose=${footer.groups.view}.dispose;
    ${footer.groups.view}.dispose=()=>{if(__qolRendererDisposed)return;__qolRendererDisposed=true;__qolMapBindings.dispose();return __qolDispose.call(${footer.groups.view})};
    return ${footer.groups.view}}`);

  const loaderText = `async function ${l.name}(${l.slug},${l.options},${l.controller}){${l.prefix}
    const ${l.using}=${l.options}.compressedTextures!==false&&Object.keys(${l.data}.compressedTextures??{}).length>0&&${l.supported}(),${l.packs}=${l.select}(${l.manifest},${l.using});
    ${l.data}.resources=await (${loadProgressiveAssets.toString()})(${l.data},${l.packs},${l.using},${l.signal},{
      fetchPack:pack=>${l.fetch}(pack.url,${l.signal}),
      readPack:async pack=>${packRead[1]}(await ${l.fetch}(pack.url,${l.signal}),pack.byteLength),
      decodeImage:(bytes,url)=>${imageDecode[2]}(bytes,url,${l.signal}),validateDDS:${d.validate},prepareSky:__qolPrepareSky,abort:error=>${l.controller}.abort(error)});return ${l.data}}`;
  const r = relay.groups;
  const relayText = `async function ${r.name}(${r.slug},${r.options}={}){const ${r.controller}=new AbortController,${r.listener}=()=>${r.controller}.abort(${r.options}.signal?.reason);${r.options}.signal?.addEventListener("abort",${r.listener},{once:true});if(${r.options}.signal?.aborted)${r.listener}();const remove=()=>${r.options}.signal?.removeEventListener("abort",${r.listener});try{const data=await ${r.load}(${r.slug},${r.options},${r.controller});const resources=data.resources,cancel=resources.cancel;resources.signal.addEventListener("abort",remove,{once:true});resources.cancel=()=>{remove();resources.signal.removeEventListener("abort",remove);cancel()};return data}catch(error){remove();throw error}}`;
  const errorBody = k.failure.slice(abortPrefix.length).replace(';return}', ';return true}');
  const j = finalize.groups;
  const loadText = `async function ${k.name}(${k.entry},${k.resume}=false,${k.bypass}=false){${k.before}
    let __qolAssets=null,__qolView=null,__qolEntered=false,__qolFailed=false,__qolFailure;
    function __qolMapFailure(${k.error}){${k.controller}.abort(${k.error});
      if(__qolView){${k.ready}=false;__qolView.dispose()}else if(__qolAssets){for(const image of __qolAssets.images.values())image.close?.();__qolAssets.cancel()}
      if(${errorBody};return false}
    function __qolPostFailure(error){if(!__qolEntered||${k.view}!==__qolView||error?.name==="AbortError")return;__qolEntered=false;
      if(${j.loading}){${k.controller}.abort(error);${k.ready}=false;__qolView.dispose();return}
      ${unlock[1]}.unlock();${unlock[2]}.hidden=false;__qolMapFailure(error);${j.element}("play").disabled=!${k.ready};${j.clock}=performance.now();${j.input}.reset()}
    try{
      const[${k.collision},${k.visual}]=await Promise.all([${k.geometry}(${k.entry},${k.controller}.signal),${k.visualLoad}(${k.entry}.slug,{signal:${k.controller}.signal}).then(data=>{
        if(${k.controller}.signal.aborted){data.resources.cancel();for(const image of data.resources.images.values())image.close?.();throw ${k.controller}.signal.reason}
        __qolAssets=data.resources;__qolAssets.ready.catch(error=>{if(!__qolView&&!${k.controller}.signal.aborted)${k.controller}.abort(error)});return data})]);
      if(${k.controller}.signal.aborted)throw ${k.controller}.signal.reason;
      ${k.ready}=false;const ${k.frame}=${k.install}(${k.collision},${k.visual},${k.resume},${k.bypass});__qolView=${k.view};
      __qolView.__qolAssetsReady?.catch(error=>{__qolFailed=true;__qolFailure=error;__qolPostFailure(error)});
      __qolView.__qolGpuReady?.catch(error=>{if(${k.view}!==__qolView||error?.name==="AbortError"||${k.controller}.signal.aborted||__qolAssets.signal.aborted)return;
        __qolFailed=true;__qolFailure=error;if(!__qolEntered){${k.controller}.abort(error);return}__qolPostFailure(error)});
      await ${k.view}.prepare?.(${k.frame});if(__qolFailed)throw __qolFailure;if(__qolAssets.signal.aborted)throw __qolAssets.signal.reason;${k.ready}=true;__qolEntered=true;${k.success}
    }catch(${k.error}){if(__qolMapFailure(${k.error}))return}finally{${k.finalize}}${k.after}}
  `;
  const changes = [
    {at: loader.index, length: loader[0].length, text: loaderText},
    {at: relay.index, length: relay[0].length, text: relayText},
    {at: factory.index, length: scope.length, text: renderer},
    {at: load.index, length: load[0].length, text: loadText},
  ].sort((a, b) => b.at - a.at);
  for (const change of changes) source = source.slice(0, change.at) + change.text + source.slice(change.at + change.length);
  return source;
}
