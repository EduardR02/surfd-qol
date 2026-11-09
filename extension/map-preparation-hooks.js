// This optional path needs the reviewed world plus native validated map load
// and fresh-session config factory. Unknown layouts keep synchronous preparation.
export function nativeMapPreparationHooks(source, contract, Session) {
  if (!contract || source.includes('__qolMapPreparation')) return source;
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const id = '[\\w$]+';
  // Newer builds start live runs on a subclass of the Session.
  const live = [Session, ...[...source.matchAll(new RegExp(`class (${id}) extends ${escape(Session)}\\{`, 'g'))].map(match => match[1])].map(escape).join('|');
  const fresh = [...source.matchAll(new RegExp(`function (${id})\\((${id})\\)\\{const ${id}=new (?:${live})\\(\\2,(${id})\\(\\2\\),(${id})\\),`, 'g'))];
  const loads = [...source.matchAll(/async function (?<name>[\w$]+)\((?<entry>[\w$]+),(?<signal>[\w$]+)\)\{const (?<record>[\w$]+)=(?<catalog>[\w$]+)\.find\((?<candidate>[\w$]+)=>\k<candidate>\.id===\k<entry>\.id\),(?<path>[\w$]+)=\k<record>\?`\/packed\/\$\{\k<record>\.geometrySha256\}\.json\.gz`:`\/maps\/\$\{\k<entry>\.slug\}-collision\.json`,(?<response>[\w$]+)=await (?<fetch>[\w$]+)\(\k<path>,\k<signal>\),(?<map>[\w$]+)=await (?<json>[\w$]+)\(\k<response>\);if\(\k<map>\.id!==\k<entry>\.id\|\|!\k<map>\.brushes\?\.length\|\|!\k<map>\.zones\?\.some\((?<start>[\w$]+)=>\k<start>\.kind==="start"\)\|\|!\k<map>\.zones\.some\((?<finish>[\w$]+)=>\k<finish>\.kind==="finish"\)\)throw Error\(`Invalid \$\{\k<entry>\.name\} geometry`\);return \k<map>\}/g)];
  const header = contract.signature.match(new RegExp(`class ${escape(contract.name)}\\{constructor\\((?<brushes>${id}),(?<triangles>${id})=\\[\\],(?<feature>${id})=!1,(?<corner>${id})=!1\\)\\{`));
  const Tree = contract.signature.match(/class ([\w$]+)\{constructor\([\w$]+,[\w$]+=12\)/)?.[1];
  if (fresh.length !== 1 || loads.length !== 1 || !header || !Tree ||
      source.indexOf(header[0]) < 0 || source.indexOf(header[0]) !== source.lastIndexOf(header[0])) return source;
  const load = loads[0], l = load.groups, h = header.groups;
  // Looking up the ramp threshold adds an early factory call. Only the
  // reviewed, side-effect-free native config expression is safe to call here.
  const configFactory = new RegExp(`(?<![\\w$.])${escape(fresh[0][3])}=n=>\\(\\{\\.\\.\\.(${id})\\.unrestrictedStart\\?${id}:${id},\\.\\.\\.n\\?\\.physicsOverrides,autoBhop:\\1\\.autoBhop,unrestrictedStart:\\1\\.unrestrictedStart\\}\\)`, 'g');
  if ([...source.matchAll(configFactory)].length !== 1) return source;
  // Trusted packing skips per-coordinate accessor checks only for these
  // reviewed JSON readers (the bonus update renamed its locals). A changed
  // parser must keep native construction.
  const readers = [`async function ${l.json}(n){if(!n.body)return n.json();const e=n.body.getReader(),t=[];let i=0;for(;i<2;){const o=await e.read();if(o.done)break;t.push(o.value),i+=o.value.length}const s=t.flatMap(o=>Array.from(o.subarray(0,2))).slice(0,2),r=new ReadableStream({start(o){for(const c of t)o.enqueue(c)},async pull(o){try{const c=await e.read();c.done?o.close():o.enqueue(c.value)}catch(c){o.error(c)}},cancel(o){return e.cancel(o)}}),a=s[0]===31&&s[1]===139?r.pipeThrough(new DecompressionStream("gzip")):r;return new Response(a).json()}`,
    `async function ${l.json}(n){if(!n.body)return n.json();const e=n.body.getReader(),t=[];let i=0;for(;i<2;){const o=await e.read();if(o.done)break;t.push(o.value),i+=o.value.length}const a=t.flatMap(o=>Array.from(o.subarray(0,2))).slice(0,2),s=new ReadableStream({start(o){for(const c of t)o.enqueue(c)},async pull(o){try{const c=await e.read();c.done?o.close():o.enqueue(c.value)}catch(c){o.error(c)}},cancel(o){return e.cancel(o)}}),r=a[0]===31&&a[1]===139?s.pipeThrough(new DecompressionStream("gzip")):s;return new Response(r).json()}`];
  if (!readers.some(reader => source.indexOf(reader) >= 0 && source.indexOf(reader) === source.lastIndexOf(reader))) return source;
  const readerDeclarations = new RegExp(`\\b(?:async\\s+)?function\\s+${escape(l.json)}\\s*\\(`, 'g');
  if ([...source.matchAll(readerDeclarations)].length !== 1) return source;
  const begin = `async function ${l.name}(${l.entry},${l.signal}){`;
  const body = load[0].slice(begin.length, -1);
  // A cached record replaces the download and parse; the native validation
  // below still checks the decoded map.
  const download = `${l.response}=await ${l.fetch}(${l.path},${l.signal}),${l.map}=await ${l.json}(${l.response});`;
  if (body.split(download).length !== 2) return source;
  const prepared = body.replace(download, `__qolCached=await __qolMapPreparation?.read(${l.record}?.geometrySha256),${l.response}=__qolCached?null:await ${l.fetch}(${l.path},${l.signal}),${l.map}=__qolCached??await ${l.json}(${l.response});`)
    .replace(`return ${l.map}`, `let __qolThreshold;try{__qolThreshold=${fresh[0][3]}(${l.map}).groundNormal}catch{}await __qolMapPreparation?.prepare(${l.map},__qolThreshold,${l.response}&&${l.record}?{key:${l.record}.geometrySha256,url:${l.response}.url}:null);return ${l.map}`);
  const replacement = `${begin}const __qolMapPreparation=globalThis.__SURFD_QOL__?.createMapPreparationLoad?.(${l.signal},()=>__qolCreateMapLoadJobs(__qolMapWorkerSource,${l.signal},false),true);try{${prepared}}catch(error){__qolMapPreparation?.dispose();throw error}}`;
  source = source.slice(0, load.index) + replacement + source.slice(load.index + load[0].length);
  return source.replace(header[0], `${header[0]}if(globalThis.__SURFD_QOL__?.usePreparedMapWorld?.(this,${h.brushes},${h.triangles},${h.feature},${h.corner},${Tree})){__qolFloorWorlds.set(${h.brushes},this);return}`);
}
