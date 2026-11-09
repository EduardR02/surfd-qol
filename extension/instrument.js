import {nativeRoomHooks} from './native-room-hooks.js';
import {nativeSavelocHooks} from './native-saveloc-hooks.js';
import {packCollisionWorld, unpackCollisionWorld, scalarTriangleVertices, triangleCollisionBrush} from './collision-world.js';
import {nativeCollisionTreeHooks} from './collision-tree.js';
import {nativeStageResetHooks} from './stage-reset-hooks.js';
import {nativeMapLoadHooks} from './map-load-hooks.js';
import {nativeProgressiveMapHooks} from './progressive-map-hooks.js';
import {nativeMapWorkerHooks} from './map-worker-hooks.js';
import {nativeMapFloorHooks} from './map-floor-hooks.js';
import {nativeMapPreparationHooks} from './map-preparation-hooks.js';
import {nativeMapEntryHooks} from './map-entry-hooks.js';
import {createReplayIndexJobs, createReplayIndexWorker} from './replay-index-worker.js';

export const ADAPTER_MARKER = '\n/* surfd-qol-adapter-v41:';
export const isCurrentInstrumented = source => source.includes(ADAPTER_MARKER);

const identifier = '[A-Za-z_$][\\w$]*';
// Copies of MAX_ROOM_MESSAGE_CHARS and MAX_ROOM_CHUNKS in src/private-rooms/protocol.js, which extension/ cannot import.
export const ROOM_MESSAGE_CHARS = 262144, ROOM_CHUNKS = 66;
// A captured identifier, matched literally inside another pattern.
const literal = name => name.replace(/\$/g, () => '\\$');

function unique(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Unsupported Surfd build: ${label} (${matches.length} matches)`);
  return matches[0];
}
// Exact native vector helpers, BVH, axes, and complete world class. In
// particular, checking the entire class also rules out new constructor state,
// field initializers and changed methods before a prepared world skips it.
// A different bundle stays native until its complete contract is reviewed.
const nativeWorldContracts = [
  {name: 'k1', index: 'e', cached: 't', triangle: 'i', vertices: 's',
    signature: "nt=(n=0,e=0,t=0)=>({x:n,y:e,z:t}),gn=n=>({...n}),vn=(n,e)=>nt(n.x+e.x,n.y+e.y,n.z+e.z),us=(n,e)=>nt(n.x-e.x,n.y-e.y,n.z-e.z),ti=(n,e)=>nt(n.x*e,n.y*e,n.z*e),un=(n,e)" +
      "=>n.x*e.x+n.y*e.y+n.z*e.z,Xd=(n,e)=>nt(n.y*e.z-n.z*e.y,n.z*e.x-n.x*e.z,n.x*e.y-n.y*e.x),ir=n=>Math.hypot(n.x,n.y,n.z),Ri=n=>Math.hypot(n.x,n.y),rl=n=>{const e=ir(n);return e>1e-12?ti(n,1/e)" +
      ":nt()},A1=(n,e,t)=>vn(n,ti(us(e,n),t)),Ar=(n,e,t)=>Math.max(e,Math.min(t,n)),Y0=n=>nt(Math.fround(n.x),Math.fround(n.y),Math.fround(n.z)),jd=[\"x\",\"y\",\"z\"],df=(n,e)=>jd.every(t=>n.min[t]" +
      "<=e.max[t]&&n.max[t]>=e.min[t]);class K0{constructor(e,t=12){this.bounds=e;const i=s=>{const r={x:1/0,y:1/0,z:1/0},a={x:-1/0,y:-1/0,z:-1/0};for(const l of s)for(const d of jd)r[d]" +
      "=Math.min(r[d],e[l].min[d]),a[d]=Math.max(a[d],e[l].max[d]);if(s.length<=t)return{min:r,max:a,items:s};const o=jd.reduce((l,d)=>a[d]-r[d]>a[l]-r[l]?d:l);s.sort((l,d)=>e[l].min[o]+e[l].max[o]" +
      "-(e[d].min[o]+e[d].max[o])||l-d);const c=s.length>>1;return{min:r,max:a,left:i(s.slice(0,c)),right:i(s.slice(c))}};this.root=e.length?i(e.map((s,r)=>r)):null}bounds;root;query(e){const t=[]," +
      "i=s=>{if(df(s,e))if(s.items)for(const r of s.items)df(this.bounds[r],e)&&t.push(r);else i(s.left),i(s.right)};return this.root&&i(this.root),t.sort((s,r)=>s-r)}}const Un=.03125,Xs=[\"x\",\"y\"," +
      "\"z\"];class k1{constructor(e,t=[],i=!1,s=!1){this.brushes=e,this.triangles=t,this.vphysicsFeatureFix=i,this.bspCornerFix=s," +
      "this.triangleBounds=t.map(r=>({min:nt(...Xs.map(a=>Math.min(...r.vertices.map(o=>o[a])))),max:nt(...Xs.map(a=>Math.max(...r.vertices.map(o=>o[a]))))})),this.tree=new K0([...e," +
      "...this.triangleBounds])}brushes;triangles;vphysicsFeatureFix;bspCornerFix;tree;triangleBounds;triangleCache=new Map;triangleBrush(e){const t=this.triangleCache.get(e);if(t)return t;" +
      "const i=this.triangles[e],s=i.vertices,r=[nt(1,0,0),nt(0,1,0),nt(0,0,1)],o=[rl(Xd(us(s[1],s[0]),us(s[2],s[0]))),...r];for(let d=0;d<3;d++)for(const u of r)o.push(Xd(us(s[(d+1)%3],s[d]),u));" +
      "const c=[];for(const d of o)if(!(ir(d)<1e-8))for(const u of[1,-1]){const h=ti(rl(d),u);c.some(f=>un(f.normal,h)>1-1e-9)||c.push({normal:h,distance:Math.max(...s.map(f=>un(h,f)))})}" +
      "const l={id:`disp-${i.surfaceId}-${i.triangleId}`,vertices:s,faces:[[0,1,2]],planes:c,...this.triangleBounds[e],color:\"#d4dadd\",friction:1,kind:\"snow\"};return this.triangleCache.set(e,l),l}" +
      "trace(e,t,i){const s={fraction:1,end:{...t},normal:nt(),startSolid:!1,allSolid:!1,brush:null},r={min:nt(),max:nt()};for(const a of Xs)r.min[a]=Math.min(e[a],t[a])+i.min[a]-Un,r.max[a]" +
      "=Math.max(e[a],t[a])+i.max[a]+Un;for(const a of this.tree.query(r)){const o=a<this.brushes.length?this.brushes[a]:this.triangleBrush(a-this.brushes.length);if(Xs.some(y=>Math.max(e[y],t[y])" +
      "+i.max[y]<o.min[y]-Un||Math.min(e[y],t[y])+i.min[y]>o.max[y]+Un)||o.leafBounds&&!o.leafBounds.some(y=>Xs.every(S=>r.max[S]>=y.min[S]&&r.min[S]<=y.max[S])))continue;let c=-1,l=1,d=nt(),u=!1," +
      "h=!1,f=!1,v,g=-1/0,m=1/0,p=-1,x=nt();const b=this.bspCornerFix&&!o.collisionModel&&o.planes.length===6&&o.planes.every(y=>Xs.filter(S=>y.normal[S]!==0)" +
      ".length===1&&Xs.some(S=>Math.abs(y.normal[S])===1));for(const y of o.planes){const S=y.normal,E=S.x*(S.x<0?i.max.x:i.min.x)+S.y*(S.y<0?i.max.y:i.min.y)+S.z*(S.z<0?i.max.z:i.min.z)," +
      "C=y.distance-E,_=un(e,S)-C,w=un(t,S)-C;if(o.collisionModel===\"vphysics\"||b)if(_>w){const T=_/(_-w);T>g&&(g=T,p=Math.max(0,(_-Un)/(_-w)),x=S)}else _<w&&(m=Math.min(m,_/(_-w)));if(_>0&&(u=!0)," +
      "w>0&&(h=!0),_>0&&w>0&&(!o.collisionModel||w>=_-1e-5)){f=!0;break}if(!(_<=0&&w<=0))if(_>w){const T=Math.max(0,(_-Un)/(_-w));T>c&&(c=T,d=S,v=y.friction)}else l=Math.min(l,(_+Un)/(_-w))}" +
      "if(!(f||m<1&&g>m)){if(this.vphysicsFeatureFix&&o.collisionModel===\"vphysics\"&&(c=p,d=x),!u){if(s.startSolid=!0,!h)return s.allSolid=!0,s.fraction=0,s.end={...e},s.brush=o,s;continue}" +
      "c<l&&c>-1&&c<s.fraction&&(s.fraction=Math.max(0,c),s.normal={...d},s.brush=o,v!==void 0?s.friction=v:delete s.friction)}}return s.end=A1(e,t,s.fraction),s}}"},
  {name: 'ke', index: 'e', cached: 't', triangle: 'a', vertices: 's',
    signature: "m=(o=0,e=0,t=0)=>({x:o,y:e,z:t}),x=o=>({...o}),w=(o,e)=>m(o.x+e.x,o.y+e.y,o.z+e.z),P=(o,e)=>m(o.x-e.x,o.y-e.y,o.z-e.z),E=(o,e)=>m(o.x*e,o.y*e,o.z*e),S=(o,e)=>o.x*e.x+o.y*e.y+o.z*e.z,W=(o,e)" +
      "=>m(o.y*e.z-o.z*e.y,o.z*e.x-o.x*e.z,o.x*e.y-o.y*e.x),N=o=>Math.hypot(o.x,o.y,o.z),C=o=>Math.hypot(o.x,o.y),G=o=>{const e=N(o);return e>1e-12?E(o,1/e):m()},be=(o,e,t)=>w(o,E(P(e,o),t)),j=(o," +
      "e,t)=>Math.max(e,Math.min(t,o)),ye=o=>m(Math.fround(o.x),Math.fround(o.y),Math.fround(o.z)),$=[\"x\",\"y\",\"z\"],Z=(o,e)=>$.every(t=>o.min[t]<=e.max[t]&&o.max[t]>=e.min[t]);" +
      "class ve{constructor(e,t=12){this.bounds=e;const a=s=>{const i={x:1/0,y:1/0,z:1/0},c={x:-1/0,y:-1/0,z:-1/0};for(const u of s)for(const f of $)i[f]=Math.min(i[f],e[u].min[f]),c[f]" +
      "=Math.max(c[f],e[u].max[f]);if(s.length<=t)return{min:i,max:c,items:s};const r=$.reduce((u,f)=>c[f]-i[f]>c[u]-i[u]?f:u);s.sort((u,f)=>e[u].min[r]+e[u].max[r]-(e[f].min[r]+e[f].max[r])||u-f);" +
      "const n=s.length>>1;return{min:i,max:c,left:a(s.slice(0,n)),right:a(s.slice(n))}};this.root=e.length?a(e.map((s,i)=>i)):null}bounds;root;query(e){const t=[],a=s=>{if(Z(s,e))if(s.items)" +
      "for(const i of s.items)Z(this.bounds[i],e)&&t.push(i);else a(s.left),a(s.right)};return this.root&&a(this.root),t.sort((s,i)=>s-i)}}const T=.03125,M=[\"x\",\"y\",\"z\"];class ke{constructor(e,t=[]" +
      ",a=!1,s=!1){this.brushes=e,this.triangles=t,this.vphysicsFeatureFix=a,this.bspCornerFix=s,this.triangleBounds=t.map(i=>({min:m(...M.map(c=>Math.min(...i.vertices.map(r=>r[c]))))," +
      "max:m(...M.map(c=>Math.max(...i.vertices.map(r=>r[c]))))})),this.tree=new ve([...e,...this.triangleBounds])}brushes;triangles;vphysicsFeatureFix;bspCornerFix;tree;triangleBounds;" +
      "triangleCache=new Map;triangleBrush(e){const t=this.triangleCache.get(e);if(t)return t;const a=this.triangles[e],s=a.vertices,i=[m(1,0,0),m(0,1,0),m(0,0,1)],r=[G(W(P(s[1],s[0]),P(s[2],s[0]))" +
      "),...i];for(let f=0;f<3;f++)for(const l of i)r.push(W(P(s[(f+1)%3],s[f]),l));const n=[];for(const f of r)if(!(N(f)<1e-8))for(const l of[1,-1]){const d=E(G(f),l);n.some(h=>S(h.normal,d)" +
      ">1-1e-9)||n.push({normal:d,distance:Math.max(...s.map(h=>S(d,h)))})}const u={id:`disp-${a.surfaceId}-${a.triangleId}`,vertices:s,faces:[[0,1,2]],planes:n,...this.triangleBounds[e]," +
      "color:\"#d4dadd\",friction:1,kind:\"snow\"};return this.triangleCache.set(e,u),u}trace(e,t,a){const s={fraction:1,end:{...t},normal:m(),startSolid:!1,allSolid:!1,brush:null},i={min:m(),max:m()};" +
      "for(const c of M)i.min[c]=Math.min(e[c],t[c])+a.min[c]-T,i.max[c]=Math.max(e[c],t[c])+a.max[c]+T;for(const c of this.tree.query(i)){const r=c<this.brushes.length?this.brushes[c]" +
      ":this.triangleBrush(c-this.brushes.length);if(M.some(k=>Math.max(e[k],t[k])+a.max[k]<r.min[k]-T||Math.min(e[k],t[k])+a.min[k]>r.max[k]+T)" +
      "||r.leafBounds&&!r.leafBounds.some(k=>M.every(_=>i.max[_]>=k.min[_]&&i.min[_]<=k.max[_])))continue;let n=-1,u=1,f=m(),l=!1,d=!1,h=!1,g,p=-1/0,b=1/0,y=-1,I=m();" +
      "const F=this.bspCornerFix&&!r.collisionModel&&r.planes.length===6&&r.planes.every(k=>M.filter(_=>k.normal[_]!==0).length===1&&M.some(_=>Math.abs(k.normal[_])===1));for(const k of r.planes)" +
      "{const _=k.normal,Re=_.x*(_.x<0?a.max.x:a.min.x)+_.y*(_.y<0?a.max.y:a.min.y)+_.z*(_.z<0?a.max.z:a.min.z),se=k.distance-Re,A=S(e,_)-se,H=S(t,_)-se;if(r.collisionModel===\"vphysics\"||F)if(A>H)" +
      "{const B=A/(A-H);B>p&&(p=B,y=Math.max(0,(A-T)/(A-H)),I=_)}else A<H&&(b=Math.min(b,A/(A-H)));if(A>0&&(l=!0),H>0&&(d=!0),A>0&&H>0&&(!r.collisionModel||H>=A-1e-5)){h=!0;break}if(!(A<=0&&H<=0))" +
      "if(A>H){const B=Math.max(0,(A-T)/(A-H));B>n&&(n=B,f=_,g=k.friction)}else u=Math.min(u,(A+T)/(A-H))}if(!(h||b<1&&p>b)){if(this.vphysicsFeatureFix&&r.collisionModel===\"vphysics\"&&(n=y,f=I),!l)" +
      "{if(s.startSolid=!0,!d)return s.allSolid=!0,s.fraction=0,s.end={...e},s.brush=r,s;continue}n<u&&n>-1&&n<s.fraction&&(s.fraction=Math.max(0,n),s.normal={...f},s.brush=r," +
      "g!==void 0?s.friction=g:delete s.friction)}}return s.end=be(e,t,s.fraction),s}}"},
];

function knownNativeWorld(source) {
  let found = null;
  for (const contract of nativeWorldContracts) {
    const at = source.indexOf(contract.signature);
    if (at < 0) continue;
    if (found || source.indexOf(contract.signature, at + 1) >= 0) return null;
    found = contract;
  }
  return found;
}


// Keep the native BVH's inclusive comparisons and axis order, without an
// Array.every callback and dynamic property lookup for every visited box.
function collisionBoundsHook(source) {
  const pattern = new RegExp(`(${identifier})=\\["x","y","z"\\],(${identifier})=\\((${identifier}),(${identifier})\\)=>\\1\\.every\\((${identifier})=>\\3\\.min\\[\\5\\]<=\\4\\.max\\[\\5\\]&&\\3\\.max\\[\\5\\]>=\\4\\.min\\[\\5\\]\\)`, 'g');
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return source;
  const [match, axes, overlap, a, b, axis] = matches[0];
  if (new Set([axes, overlap, a, b, axis]).size !== 5) return source;
  const comparisons = ['x', 'y', 'z'].map(key => `${a}.min.${key}<=${b}.max.${key}&&${a}.max.${key}>=${b}.min.${key}`).join('&&');
  return source.slice(0, matches[0].index) + `${axes}=["x","y","z"],${overlap}=(${a},${b})=>${comparisons}` + source.slice(matches[0].index + match.length);
}
// Native displacement triangles have three vertices. Compute their AABBs
// directly instead of allocating six vertex arrays and two axis arrays each.
// Other vertex counts and sparse triples retain the original native path.
function nativeTriangleBoundsHooks(source, verified = false) {
  const pattern = /this\.triangleBounds=(?<triangles>[\w$]+)\.map\((?<triangle>[\w$]+)=>\((?<bounds>\{min:(?<vector>[\w$]+)\(\.\.\.(?<axes>[\w$]+)\.map\((?<minAxis>[\w$]+)=>Math\.min\(\.\.\.\k<triangle>\.vertices\.map\((?<minVertex>[\w$]+)=>\k<minVertex>\[\k<minAxis>\]\)\)\)\),max:\k<vector>\(\.\.\.\k<axes>\.map\((?<maxAxis>[\w$]+)=>Math\.max\(\.\.\.\k<triangle>\.vertices\.map\((?<maxVertex>[\w$]+)=>\k<maxVertex>\[\k<maxAxis>\]\)\)\)\)\})\)\)/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return source;
  const match = matches[0], {triangles, triangle, bounds, vector, axes} = match.groups;
  if (!verified) {
    // The small standalone form has the declaration and constructor adjacent,
    // so neither a global with the same name nor a shadowing parameter can
    // supply a different binding. Other layouts require the complete contract.
    const header = new RegExp(`const ${literal(axes)}=\\["x","y","z"\\];function ${literal(vector)}\\(x=0,y=0,z=0\\)\\{return\\{x,y,z\\}\\}\\s*class ${identifier}\\{constructor\\(${literal(triangles)}\\)\\{$`);
    if (triangles === axes || triangle === axes || !header.test(source.slice(0, match.index))) return source;
  }
  const names = ['__qolA', '__qolB', '__qolC'], axesNames = ['x', 'y', 'z'];
  const numeric = names.flatMap(vertex => axesNames.map(axis => `typeof ${vertex}.${axis}==="number"`)).join('&&');
  const components = operation => axesNames.map(axis => `Math.${operation}(__qolA.${axis},__qolB.${axis},__qolC.${axis})`).join(',');
  const replacement = `this.triangleBounds=(__qolSafe=>${triangles}.map(${triangle}=>{const __qolVertices=__qolSafe(${triangle});if(!__qolVertices)return ${bounds};const __qolA=__qolVertices[0],__qolB=__qolVertices[1],__qolC=__qolVertices[2];if(!(${numeric}))return ${bounds};return{min:${vector}(${components('min')}),max:${vector}(${components('max')})}}))((${scalarTriangleVertices.toString()}))`;
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

// Candidate rejection and corner-fix classification run on every sweep. Keep
// their native XYZ order without callback chains or per-plane filter arrays.
function nativeCollisionSweepHooks(source, verified = false) {
  const broadphase = /(?<axes>[\w$]+)\.some\((?<axis>[\w$]+)=>Math\.max\((?<start>[\w$]+)\[\k<axis>\],(?<end>[\w$]+)\[\k<axis>\]\)\+(?<hull>[\w$]+)\.max\[\k<axis>\]<(?<brush>[\w$]+)\.min\[\k<axis>\]-(?<epsilon>[\w$]+)\|\|Math\.min\(\k<start>\[\k<axis>\],\k<end>\[\k<axis>\]\)\+\k<hull>\.min\[\k<axis>\]>\k<brush>\.max\[\k<axis>\]\+\k<epsilon>\)/g;
  const matches = [...source.matchAll(broadphase)];
  if (matches.length !== 1) return source;
  const match = matches[0], {axes, start, end, hull, brush, epsilon} = match.groups;
  const corner = new RegExp(`${literal(brush)}\\.planes\\.every\\((${identifier})=>${literal(axes)}\\.filter\\((${identifier})=>\\1\\.normal\\[\\2\\]!==0\\)\\.length===1&&${literal(axes)}\\.some\\(\\2=>Math\\.abs\\(\\1\\.normal\\[\\2\\]\\)===1\\)\\)`, 'g');
  const corners = [...source.matchAll(corner)];
  if (corners.length !== 1) return source;
  if (!verified) {
    const header = new RegExp(`const ${literal(axes)}=\\["x","y","z"\\],${literal(epsilon)}=\\.03125;function ${identifier}\\(${literal(start)},${literal(end)},${literal(hull)},${literal(brush)}\\)\\{return\\{skip:$`);
    if ([start, end, hull, brush, corners[0][1]].includes(axes) ||
        !header.test(source.slice(0, match.index)) ||
        source.slice(match.index + match[0].length, corners[0].index) !== ',corner:' ||
        !source.startsWith('}}', corners[0].index + corners[0][0].length)) return source;
  }
  const checks = ['x', 'y', 'z'].map(axis =>
    `Math.max(${start}.${axis},${end}.${axis})+${hull}.max.${axis}<${brush}.min.${axis}-${epsilon}||Math.min(${start}.${axis},${end}.${axis})+${hull}.min.${axis}>${brush}.max.${axis}+${epsilon}`);
  const plane = corners[0][1];
  const changes = [
    {at: match.index, length: match[0].length, text: `(${checks.join('||')})`},
    {at: corners[0].index, length: corners[0][0].length,
      text: `${brush}.planes.every(${plane}=>{const __qolNormal=${plane}.normal;return(__qolNormal.x!==0)+(__qolNormal.y!==0)+(__qolNormal.z!==0)===1&&(Math.abs(__qolNormal.x)===1||Math.abs(__qolNormal.y)===1||Math.abs(__qolNormal.z)===1)})`},
  ].sort((a, b) => b.at - a.at);
  for (const change of changes) source = source.slice(0, change.at) + change.text + source.slice(change.at + change.length);
  return source;
}

// Only called on the exact, complete native world contract above. Insert the
// scalar path after the original cache and vertex lookup; every other input
// continues through the original native algorithm and cache insertion.
function nativeTriangleBrushHooks(source, contract) {
  const {index, cached, triangle, vertices} = contract;
  const prefix = `triangleBrush(${index}){const ${cached}=this.triangleCache.get(${index});if(${cached})return ${cached};const ${triangle}=this.triangles[${index}],${vertices}=${triangle}.vertices,`;
  const at = source.indexOf(prefix);
  if (at < 0) return source;
  const names = ['__qolA', '__qolB', '__qolC'];
  // The shared shape check also protects bounds and packet preparation from
  // accessor reads, custom mapping and non-native array species.
  const coordinates = names.flatMap(vertex => ['x', 'y', 'z'].map(axis => `Number.isFinite(${vertex}.${axis})`)).join('&&');
  const replacement = `triangleBrush(${index}){const ${cached}=this.triangleCache.get(${index});if(${cached})return ${cached};const ${triangle}=this.triangles[${index}],${vertices}=${triangle}.vertices;
const __qolSafe=(${scalarTriangleVertices.toString()})(${triangle});
if(__qolSafe&&__qolSafe===${vertices}){
const __qolA=${vertices}[0],__qolB=${vertices}[1],__qolC=${vertices}[2];
if(${coordinates}){const __qolBrush=(${triangleCollisionBrush.toString()})(${triangle},this.triangleBounds[${index}]);return this.triangleCache.set(${index},__qolBrush),__qolBrush}}
const `;
  return source.slice(0, at) + replacement + source.slice(at + prefix.length);
}

function nativeCollisionWorldHooks(source, contract) {
  if (contract) {
    const at = source.indexOf(contract.signature);
    if (at >= 0) {
      let world = nativeTriangleBoundsHooks(contract.signature, true);
      world = nativeCollisionSweepHooks(world, true);
      world = nativeTriangleBrushHooks(world, contract);
      source = source.slice(0, at) + world + source.slice(at + contract.signature.length);
    }
  }
  source = nativeTriangleBoundsHooks(source);
  return nativeCollisionSweepHooks(source);
}


// Leave the native player's validation, watchdog, fallback and outputs intact.
// A fresh worker receives a packed collision snapshot owned only by that job.
function preparedIndexHooks(source, state) {
  if (source.includes('__surfdQolIndexes')) return source;
  try {
    const index = unique(source, new RegExp(`startIndex\\((${identifier}),(${identifier}),(${identifier}),(${identifier})\\)\\{const (${identifier})=this\\.replay,(${identifier})=this\\.index,(${identifier})=this\\.revision,(${identifier})=\\(\\)=>\\{`, 'g'), 'index ownership');
    const end = source.indexOf('stopWorker(){', index.index);
    if (end < 0) return source;
    const body = source.slice(index.index, end);
    const creation = unique(body, new RegExp(`const (${identifier})=(new Worker\\(new URL\\("/assets/replay-index\\.worker-[^"]+\\.js",import\\.meta\\.url\\),\\{type:"module"\\}\\));this\\.worker=\\1`, 'g'), 'index worker');
    const worker = creation[1];
    const stop = unique(source, /stopWorker\(\)\{clearTimeout\(this\.workerTimeout\),this\.workerTimeout=void 0,this\.worker\?\.terminate\(\),this\.worker=null\}/g, 'index release');
    const fallback = unique(body, /this\.stopWorker\(\),this\.fallback=/g, 'index fallback');
    const map = unique(source, new RegExp(`(${identifier})&&\\1\\.dispose\\(\\),${literal(state)}=(${identifier})\\((${identifier})\\),`, 'g'), 'map ownership');
    const attach = unique(source, new RegExp(`${literal(map[1])}\\.setQuality\\?\\.\\(`, 'g'), 'map renderer ownership');
    const changes = [
      {at: index.index + creation.index, length: creation[0].length,
        text: `const ${worker}=__surfdQolIndexes().acquire(${index[1]},${index[5]},this.host.session(),()=>${creation[2]});this.worker=${worker},${worker}.onclose=()=>{if(this.worker===${worker})this.stopWorker()}`},
      {at: index.index + fallback.index, length: fallback[0].length, text: 'this.stopWorker(!0),this.fallback='},
      {at: stop.index, length: stop[0].length, text: 'stopWorker(__surfdQolFailed=!1){clearTimeout(this.workerTimeout),this.workerTimeout=void 0,this.worker?.terminate(__surfdQolFailed),this.worker=null}'},
      {at: attach.index, length: 0, text: `__surfdQolIndexes().ownRenderer(${map[1]}),`},
    ].sort((a, b) => b.at - a.at);
    for (const change of changes) source = source.slice(0, change.at) + change.text + source.slice(change.at + change.length);
    return source + `
function __surfdQolIndexes(){
  return __surfdQolIndexes.jobs??=(${createReplayIndexJobs.toString()})(async(map,session,message,isCurrent)=>{
    const compatible=session?.map===map&&map.id===message.replay.mapId&&map.version===message.replay.mapVersion;
    return compatible?await (${packCollisionWorld.toString()})(map,session.movement?.world,{isCurrent}):null;
  },()=>${creation[2]});
}
`;
  } catch { return source; }
}

function preparedIndexWorkerHooks(source, workerRuntime, contract) {
  if (source.includes('__surfdQolWorkerWorld')) return source;
  try {
    // Without the whole reviewed world contract, keep native geometry loading
    // and native construction. The independent worker protocol still works.
    const factories = contract ? [...source.matchAll(new RegExp(`new ${literal(contract.name)}\\((${identifier})\\.brushes,\\1\\.displacementTriangles,(${identifier}),(${identifier})\\)`, 'g'))] : [];
    // The factory must refer to that class, not a same-named local binding.
    // Additional occurrences are ambiguous, so leave preparation native.
    const names = contract ? [...source.matchAll(new RegExp(`(?<![\\w$])${literal(contract.name)}(?![\\w$])`, 'g'))] : [];
    const classAt = contract ? source.indexOf(`class ${contract.name}{`, source.indexOf(contract.signature)) : -1;
    const factory = factories.length === 1 && names.length === 2 && names[0].index === classAt + 6 &&
      names[1].index === factories[0].index + 4 ? factories[0] : null;
    const handler = unique(source, new RegExp(`async function (${identifier})\\((${identifier})\\)\\{try\\{const\\{entry:(${identifier}),currentVersion:(${identifier}),replay:(${identifier})\\}=\\2;`, 'g'), 'index worker request');
    const entry = literal(handler[3]), current = literal(handler[4]), replay = literal(handler[5]);
    const load = unique(source, new RegExp(`let (${identifier})=null;${replay}\\.mapVersion===${current}&&\\(\\1=await (${identifier})\\(${entry}\\),\\1\\.version!==${replay}\\.mapVersion&&\\(\\1=null\\)\\),\\1\\?\\?=await (${identifier})\\(${entry},${replay}\\.mapVersion\\);`, 'g'), 'index geometry load');
    const receiver = unique(source, new RegExp(`(${identifier})\\.onmessage=(${identifier})=>\\{${literal(handler[1])}\\(\\2\\.data\\)\\};`, 'g'), 'index worker receiver');
    const loop = unique(source, new RegExp(`const (${identifier})=new (${identifier})\\(${literal(load[1])},${replay}\\);for\\(;;\\)\\{const (${identifier})=performance\\.now\\(\\)\\+(${identifier}),(${identifier})=\\1\\.run\\(\\(\\)=>performance\\.now\\(\\)<\\3\\);if\\(${literal(receiver[1])}\\.postMessage\\(\\{ok:!0,batch:\\5\\},\\{transfer:\\[\\5\\.elapsed\\.buffer,\\5\\.phases\\.buffer\\]\\}\\),\\5\\.done\\)return\\}`, 'g'), 'index worker chunks');
    const failure = unique(source, new RegExp(`${literal(receiver[1])}\\.postMessage\\(\\{ok:!1,error:(${identifier}) instanceof Error\\?\\1\\.message:String\\(\\1\\)\\}\\)`, 'g'), 'index worker failure');
    const strict = unique(source, /"use strict";/g, 'worker scope');
    // Direct source instrumentation remains usable without a generated asset.
    // Only the recognized native Session can enable the cinema protocol.
    const session = [...source.matchAll(new RegExp(`this\\.session=new (${identifier})\\((${identifier}),(${identifier})\\.config\\)`, 'g'))];
    const cinema = workerRuntime && session.length === 1 ? `
${workerRuntime}
function __surfdQolCinemaSession(map,replay){const session=new ${session[0][1]}(map,replay.config,replay.format);session.loadReplay(replay);return session;}
const __surfdQolCinema=globalThis.__surfdQolCreateCinemaWorker({
  post:(data,options)=>${receiver[1]}.postMessage(data,options),
  createSession:__surfdQolCinemaSession
});
delete globalThis.__surfdQolCreateCinemaWorker;
` : 'const __surfdQolCinema=null;';
    const map = load[1];
    const prepare = `let ${map}=__surfdQolMap;
if(!${map}||${map}.id!==${handler[5]}.mapId||${map}.version!==${handler[5]}.mapVersion){
  ${map}=null;
  ${factory ? `let __surfdQolPrepared=null;
try{__surfdQolPrepared=(${unpackCollisionWorld.toString()})(${handler[2]}.__surfdQolCollision);}catch{}
if(__surfdQolPrepared?.map.id===${handler[5]}.mapId&&__surfdQolPrepared.map.version===${handler[5]}.mapVersion){
  ${map}=__surfdQolPrepared.map;
  Object.defineProperty(${map},"__surfdQolCollision",{value:__surfdQolPrepared});
}else{${load[0].slice(4)}}` : load[0].slice(4)}
  if(!__surfdQolJob.current())return;
  __surfdQolMap=${map};
}
if(!__surfdQolJob.current())return;
`;
    const helper = `
${cinema}
let __surfdQolMap=null;
${factory ? `function __surfdQolWorkerWorld(map,feature,corner,World){
  const prepared=map.__surfdQolCollision;
  const world=prepared?Object.create(World.prototype):new World(map.brushes,map.displacementTriangles,feature,corner);
  if(prepared){
    world.brushes=map.brushes;world.triangles=map.displacementTriangles;
    world.vphysicsFeatureFix=feature;world.bspCornerFix=corner;
    world.triangleBounds=prepared.triangleBounds;world.tree=prepared.tree;
    world.triangleCache=new Map;
  }
  return world;
}` : ''}
`;
    const viewOnly = session.length === 1 && workerRuntime ? `
if(${handler[2]}.__surfdQolViewOnly){
  const session=__surfdQolCinemaSession(${map},${handler[5]});
  __surfdQolCinema.attach(session,${handler[5]},${handler[2]}.job,!1);
  __surfdQolJob.world(${map});return;
}` : `if(${handler[2]}.__surfdQolViewOnly)throw Error("Worker cinema unavailable");`;
    const chunks = `${viewOnly}
const ${loop[1]}=new ${loop[2]}(${map},${handler[5]});
__surfdQolCinema?.attach(${loop[1]}.session,${handler[5]},${handler[2]}.job);
__surfdQolJob.world(${map});
let __surfdQolFirstBatch=!0;
try{for(;;){
  if(!__surfdQolJob.current())return;
  if(__surfdQolCinema)await __surfdQolCinema.before(${handler[2]}.job,()=>{
    const batch=${loop[1]}.run(()=>!1);
    __surfdQolJob.emit({ok:!0,batch},{transfer:[batch.elapsed.buffer,batch.phases.buffer]});
  });
  if(!__surfdQolJob.current())return;
  let __surfdQolSteps=0;const __surfdQolCameraActive=__surfdQolCinema?.active;
  // Worker messages cannot interleave a synchronous native run. Cancellation
  // stays checked at task/await boundaries, not redundantly on every tick.
  const ${loop[3]}=performance.now()+(__surfdQolCameraActive||__surfdQolFirstBatch?8:${loop[4]}),${loop[5]}=__surfdQolCameraActive?${loop[1]}.run(()=>__surfdQolSteps++<64&&performance.now()<${loop[3]}):${loop[1]}.run(()=>performance.now()<${loop[3]});
  __surfdQolFirstBatch=!1;
  const __surfdQolBatchReady=__surfdQolCinema?.batch(${handler[2]}.job,${loop[1]}.position,${loop[5]});
  __surfdQolJob.emit({ok:!0,batch:${loop[5]}},{transfer:[${loop[5]}.elapsed.buffer,${loop[5]}.phases.buffer]});
  if(__surfdQolBatchReady)await __surfdQolBatchReady;
  if(${loop[5]}.done)return;
  await __surfdQolJob.pause();
}}finally{__surfdQolCinema?.detach(${handler[2]}.job);}`;
    const changes = [
      ...(factory ? [{at: factory.index, length: factory[0].length, text: `__surfdQolWorkerWorld(${factory[1]},${factory[2]},${factory[3]},${contract.name})`}] : []),
      ...(session.length === 1 ? [{at: session[0].index, length: session[0][0].length,
        text: `${session[0][0].slice(0, -1)},${session[0][2]}.format)`}] : []),
      {at: load.index, length: load[0].length, text: prepare},
      {at: strict.index + strict[0].length, length: 0, text: helper},
      {at: receiver.index, length: receiver[0].length, text: `const __surfdQolReceive=(${createReplayIndexWorker.toString()})((data,options)=>${receiver[1]}.postMessage(data,options),${handler[1]},__surfdQolCinema?.pause,__surfdQolCinema);${receiver[1]}.onmessage=event=>__surfdQolReceive(event.data);`},
      {at: handler.index, length: handler[0].length, text: handler[0].replace(`(${handler[2]})`, `(${handler[2]},__surfdQolJob)`)},
      {at: loop.index, length: loop[0].length, text: chunks},
      {at: failure.index, length: failure[0].length, text: failure[0].replace(`${receiver[1]}.postMessage`, '__surfdQolJob.emit')},
    ].sort((a, b) => b.at - a.at);
    for (const change of changes) source = source.slice(0, change.at) + change.text + source.slice(change.at + change.length);
    return source;
  } catch { return source; }
}

function alreadyInstrumented(source) {
  if (!source.includes('\n/* surfd-qol-adapter-v')) return false;
  if (isCurrentInstrumented(source)) return true;
  throw new Error('Stale Surfd QoL adapter');
}

export function instrumentPhysicsWorker(source, workerRuntime = '') {
  if (alreadyInstrumented(source)) return source;
  const contract = knownNativeWorld(source);
  let patched = preparedIndexWorkerHooks(source, workerRuntime, contract);
  patched = nativeCollisionWorldHooks(patched, contract);
  patched = nativeCollisionTreeHooks(collisionBoundsHook(patched));
  return patched === source ? source : patched + `${ADAPTER_MARKER} native worker collision preparation */`;
}

// Replay hooks are optional: when the game's watch function or its replay
// player can't be found, Watch is unavailable and nothing else changes.
// Surfd's own player (the transport behind its replay bar) does playback,
// seeking, speed and the timeline; the extension drives it and adds to it.
function replayHooks(source) {
  try {
    const watch = unique(source, new RegExp(`async function (${identifier})\\((${identifier}),(${identifier}),(${identifier}),(${identifier})=\\+\\+(${identifier})\\)\\{if\\(!\\3\\(\\)\\)return;`, 'g'), 'replay watch');
    // The game's own debug snapshot reads the player: replay:<player>.snapshot().
    const transport = unique(source, new RegExp(`replay:(${identifier})\\.snapshot\\(\\)`, 'g'), 'replay player')[1];
    return `
    replay: {
      reserve: () => ++${watch[6]},
      isCurrent: token => token === ${watch[6]},
      watch: (replay, label, isCurrent, token) => ${watch[1]}(replay, isCurrent, label, token),
      transport: () => ${transport},
      // What's playing and where: index counts the commands played.
      playback: () => ({replay: ${transport}.replay ?? null, index: ${transport}.replay ? ${transport}.host.position() : 0}),
    },`;
  } catch (error) {
    console.warn('[Surfd QoL] Replay controls unavailable:', error.message);
    return '';
  }
}

// The game's practice savelocs, also optional: moments saved while watching
// a replay are filed into them when you leave it.
function practiceHooks(source, sessionClass, state) {
  try {
    const store = unique(source, new RegExp(`const ${identifier}=(${identifier})\\.entries\\((${identifier})\\)\\.length>=${identifier},${identifier}=\\1\\.save\\(\\2\\)`, 'g'), 'saveloc store')[1];
    // Use the same map, rules and replay format as native Restart. A replay
    // session can remain alive after Exit with an older format/rules bank.
    const fresh = unique(source, new RegExp(`function (${identifier})\\((${identifier})\\)\\{const ${identifier}=new ${sessionClass}\\(\\2,(${identifier})\\(\\2\\),(${identifier})\\),`, 'g'), 'live session factory');
    const maps = [...new Set([...source.matchAll(new RegExp(`${fresh[1]}\\((${identifier})\\?\\?${state}\\.map\\)`, 'g'))].map(match => match[1]))];
    if (maps.length !== 1) throw new Error('Unsupported Surfd build: practice destination map');
    // The start position the factory applies: yours if you set one, else none.
    let loadStart = null;
    try {
      const factory = new RegExp(`function ${literal(fresh[1])}\\((${identifier})\\)\\{const (${identifier})=new ${literal(sessionClass)}\\(\\1,${literal(fresh[3])}\\(\\1\\),${literal(fresh[4])}\\),(${identifier})=(${identifier})\\(\\1\\);return \\3&&\\2\\.setStartPosition\\(\\3\\)`, 'g');
      loadStart = unique(source, factory, 'start position loader')[4];
    } catch (error) {
      console.warn('[Surfd QoL] Savelocs from replays keep the replay’s start position:', error.message);
    }
    let shared = {source, setup: '', adapter: ''};
    try { shared = nativeSavelocHooks(source, store); }
    catch (error) { console.warn('[Surfd QoL] Shared practice savelocs unavailable:', error.message); }
    return {...shared, adapter: `
    practice: {
      // The saveloc store: one bank of snapshots per practice key (map and movement rules).
      store: () => ${store},
      destination: () => {
        const map = ${maps[0]} ?? ${state}?.map;
        if (!map) return null;
        // practiceKey is native's pure metadata key, not a synthetic Session.
        const key = ${sessionClass}.prototype.practiceKey.call({map, config: ${fresh[3]}(map), replayFormat: ${fresh[4]}});
        return {map, mapId: map.id, mapVersion: map.version, key${loadStart ? `, startPosition: ${loadStart}(map) ?? null` : ''}};
      },${shared.adapter}
    },`};
  } catch (error) {
    console.warn('[Surfd QoL] Practice savelocs from replays unavailable:', error.message);
    return {source, setup: '', adapter: ''};
  }
}
// The game's own notice line (where "Saved location #1" appears), optional.
function noticeHook(source) {
  try {
    const notice = unique(source, new RegExp(`\\{(${identifier})\\("Return to play before saving a location\\."\\);return\\}`, 'g'), 'notice')[1];
    return `
    notice: text => ${notice}(text),`;
  } catch (error) {
    console.warn('[Surfd QoL] Game notices unavailable:', error.message);
    return '';
  }
}

// Directory rosters are host claims, not verified rank or friend information.
// Keep the native official renderer intact and use only public community fields.
function roomRosterHooks(body, options) {
  const roster = unique(body, new RegExp(`(${identifier})=\\[\\.\\.\\.(${identifier})\\.roster\\?\\?\\[\\]\\]\\.sort\\(\\((${identifier}),(${identifier})\\)=>Number\\((${identifier})\\.has\\(\\4\\.name\\)\\)-Number\\(\\5\\.has\\(\\3\\.name\\)\\)\\|\\|\\4\\.points-\\3\\.points\\)`, 'g'), 'browser roster order');
  const row = roster[2], players = roster[1];
  const render = unique(body, new RegExp(`${literal(players)}\\.map\\((${identifier})=>\`([\\s\\S]*?)\`\\)\\.join\\(""\\)`, 'g'), 'browser roster rows');
  const escape = unique(render[2], new RegExp(`\\$\\{(${identifier})\\(${literal(render[1])}\\.name\\)\\}`, 'g'), 'browser roster name escaping')[1];
  const rank = unique(render[2], new RegExp(`class="rank-name \\$\\{(${identifier})\\(${literal(render[1])}\\.guest\\?"Guest":${literal(render[1])}\\.rank\\)\\}`, 'g'), 'browser guest style')[1];
  const empty = unique(body, new RegExp(`const (${identifier})=(${identifier})\\("p.empty",(${identifier})\\);`, 'g'), 'browser roster container');
  body = body.replace(roster[0], () => `${players}=__qolCommunity(${row})?(${row}.roster??[]):${roster[0].slice(players.length + 1)}`);
  body = body.replace(render[0], () => `(__qolCommunity(${row})?${players}.map(__qolRosterPlayer).join(""):${render[0]})`);
  // Bind after each native render so reused DOM cannot keep an old room's action.
  body = body.replace(empty[0], () => `${empty[2]}("tbody",${empty[3]}).onclick=__qolCommunity(${row})?event=>{const button=event.target.closest("button[data-qol-user]");if(button)${options}.__qolProfile(button.dataset.qolUser,button.dataset.qolName)}:null;${empty[0]}`);
  return {body, helpers: `
    const __qolPublicUser=player=>player.guest===false&&typeof player.userId==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(player.userId);
    function __qolRosterPlayer(player){
      const name=${escape}(player.name),who=__qolPublicUser(player)?'<button type="button" class="who" data-qol-user="'+player.userId+'" data-qol-name="'+name+'">'+name+'</button>':'<span class="who">'+name+'</span>';
      return '<tr><td>'+who+'</td><td class="c-min">'+(player.guest?'<span class="rank-name '+${rank}("Guest")+'">Guest</span>':'')+'</td><td></td></tr>';
    }
  `};
}

function roomBrowserHooks(source, hook) {
  const start = unique(source, new RegExp(`function (${identifier})\\((${identifier})\\)\\{let (${identifier})=\\[\\],(${identifier})="Checking servers…"`, 'g'), 'server browser');
  const end = unique(source.slice(start.index), new RegExp(`mapTitle:(${identifier})\\}\\}`, 'g'), 'server browser end');
  let body = source.slice(start.index, start.index + end.index + end[0].length);
  const replace = (pattern, replacement, label) => {
    const match = unique(body, pattern, label);
    body = body.replace(match[0], () => typeof replacement === 'function' ? replacement(match) : replacement);
    return match;
  };
  const joins = replace(new RegExp(`(${identifier})=(${identifier})=>\\2\\.online&&!\\2\\.preview&&\\2\\.players<\\2\\.capacity`, 'g'),
    m => `${m[1]}=${m[2]}=>${m[2]}.online&&!${m[2]}.preview&&(__qolCommunity(${m[2]})||${m[2]}.players<${m[2]}.capacity)`, 'server eligibility');
  replace(new RegExp(`${literal(start[3])}\\.filter\\(${literal(joins[1])}\\)`, 'g'),
    `${start[3]}.filter(row=>!__qolCommunity(row)&&${joins[1]}(row))`, 'official recommendation');
  replace(new RegExp(`\\(!(${identifier})\\|\\|(${identifier})\\.players<\\2\\.capacity\\)&&\\(!(${identifier})\\|\\|\\2\\.players>0\\)`, 'g'),
    m => `(__qolCommunity(${m[2]})||!${m[1]}||${m[2]}.players<${m[2]}.capacity)&&(!${m[3]}||${m[2]}.players>0)`, 'community filters');
  body = body.replace(new RegExp(`(?<![\\w$.])(${identifier})\\.region`, 'g'), (_, name) => `__qolRegion(${name})`);
  replace(new RegExp(`Number\\((${identifier})\\.online\\)-Number\\((${identifier})\\.online\\)\\|\\|`, 'g'),
    m => `Number(__qolCommunity(${m[2]}))-Number(__qolCommunity(${m[1]}))||Number(${m[1]}.online)-Number(${m[2]}.online)||`, 'official row order');
  replace(new RegExp(`\\.sort\\(\\((${identifier}),(${identifier})\\)=>\\((${identifier})\\(\\1\\[1\\]\\[0\\]\\)\\?\\?9999\\)-\\(\\3\\(\\2\\[1\\]\\[0\\]\\)\\?\\?9999\\)\\)`, 'g'),
    m => `.sort((${m[1]},${m[2]})=>Number(${m[1]}[0]==="Community")-Number(${m[2]}[0]==="Community")||(${m[3]}(${m[1]}[1][0])??9999)-(${m[3]}(${m[2]}[1][0])??9999))`, 'official group order');
  const tabs = unique(body, new RegExp(`(${identifier})\\.hidden=(${identifier})\\.length<2,\\1\\.innerHTML=\\2\\.length<2\\?"":`, 'g'), 'community tab visibility');
  body = body.replace(tabs[0], () => `${tabs[1]}.hidden=${tabs[2]}.length<2&&!${tabs[2]}.includes("Community"),${tabs[1]}.innerHTML=${tabs[2]}.length<2&&!${tabs[2]}.includes("Community")?"":`);
  replace(new RegExp('`Join \\$\\{(' + identifier + ')\\((' + identifier + ')\\.id\\)\\}`', 'g'),
    m => '`Join ${__qolCommunity(' + m[2] + ')?' + m[2] + '.name:' + m[1] + '(' + m[2] + '.id)}`', 'community join label');
  const render = unique(body, new RegExp(`for\\(const (${identifier}) of ${identifier}\\("\\[data-region\\]",${identifier}\\)\\)\\1\\.onclick=\\(\\)=>\\{(${identifier})=\\1\\.dataset\\.region,(${identifier})\\(\\)\\}`, 'g'), 'region selection');
  const selected = unique(body, new RegExp(`typeof (${identifier})=="string"&&\\((${identifier})=\\1\\)`, 'g'), 'selected server');
  const view = replace(new RegExp(`return\\{view:(${identifier}),update\\(`, 'g'),
    m => `return{view:${m[1]},status:()=>${start[4]},selected:()=>${selected[2]},selectRoom:id=>{${selected[2]}=id;${render[2]}="all";${render[3]}()},update(`, 'browser adapter')[1];
  replace(new RegExp(`open\\((${identifier})\\)\\{typeof \\1=="string"`, 'g'),
    m => `open(${m[1]}){${hook}?.browserVisibility?.(!${view}.el.hidden);typeof ${m[1]}=="string"`, 'browser open lifecycle');
  replace(new RegExp(`close\\(\\)\\{clearInterval\\((${identifier})\\)\\}`, 'g'),
    m => `close(){clearInterval(${m[1]});queueMicrotask(()=>${hook}?.browserVisibility?.(!${view}.el.hidden))}`, 'browser close lifecycle');
  body = body.replaceAll(`${start[2]}.refresh()`, () => `(${hook}?.refreshDirectory({open:!${view}.el.hidden}),${start[2]}.refresh())`);
  const roster = roomRosterHooks(body, start[2]);
  body = roster.body.replace(start[0], () => start[0].replace('{let ', () => '{const __qolCommunity=row=>/^p-[a-z0-9]{12}$/.test(row.id),__qolRegion=row=>__qolCommunity(row)?"Community":row.region;' + roster.helpers + 'let '));
  source = source.slice(0, start.index) + body + source.slice(start.index + end.index + end[0].length);
  // The ordinary profile callback also resolves friends by display name. Open
  // directly by the advertised UUID instead, never by a possibly spoofed name.
  const window = unique(source, new RegExp(`(${identifier})\\.setOpenHandler\\(\\(\\)=>(${identifier})\\.open\\("servers"\\)\\)`, 'g'), 'browser profile window')[2];
  const create = unique(source, new RegExp(`${literal(start[1])}\\(\\{`, 'g'), 'browser creation');
  return source.replace(create[0], () => `${create[0]}__qolProfile:(userId,name)=>${window}.open("profile",{userId,name}),`);
}

// Optional room UI hooks: map choice, leaving, the host's Your room button,
// and stable selectors for legacy scoreboard actions that community rooms hide.
function roomUiHooks(source, hook) {
  const adapter = [];
  const optional = (label, apply) => {
    try { apply(); } catch (error) { console.warn(`[Surfd QoL] ${label} unavailable:`, error.message); }
  };
  optional('Room map choice', () => {
    const picker = unique(source, new RegExp(`function (${identifier})\\((${identifier})\\)\\{const (${identifier})=document\\.createElement\\("dialog"\\);\\3\\.className="nominate-window map-change-window"`, 'g'), 'map change dialog')[1];
    // The factory appends its dialog to the page before it returns.
    adapter.push(`
      mapPicker: options => { const picker = ${picker}(options); return {open: picker.open, state: picker.state, close: picker.close, dialog: document.body.lastElementChild}; },`);
  });
  optional('Room leave and map change', () => {
    const leave = unique(source, new RegExp(`leave:\\(\\)=>\\{(${identifier})\\?\\.roomId\\(\\)&&\\1\\.leave\\(\\),(${identifier})\\(\\)\\}`, 'g'), 'room leave');
    adapter.push(`
      leaveRoom: () => { ${leave[1]}?.roomId() && ${leave[1]}.leave(); ${leave[2]}(); },
      changeMap: () => ${leave[1]}?.roomView?.changeMap?.(),`);
  });
  optional('Legacy room action visibility', () => {
    const report = unique(source, new RegExp(`if\\((${identifier})\\.textContent="Report",\\1\\.onclick=\\(\\)=>\\{`, 'g'), 'legacy player report');
    const moderate = unique(source, new RegExp(`(${identifier})\\.textContent="Moderate",\\1\\.onclick=\\(\\)=>\\{`, 'g'), 'legacy player moderation');
    source = source.replace(report[0], () => `if(${report[1]}.classList.add("qol-room-report"),${report[1]}.textContent="Report",${report[1]}.onclick=()=>{`);
    source = source.replace(moderate[0], () => `${moderate[1]}.classList.add("qol-room-moderate"),${moderate[1]}.textContent="Moderate",${moderate[1]}.onclick=()=>{`);
  });
  optional('Your room menu button', () => {
    const menu = unique(source, new RegExp(`(${identifier})\\.innerHTML=\`\\$\\{(${identifier})\\.guest\\(\\)\\?'<button type="button" class="btn" data-act="signin" `, 'g'), 'room menu');
    const click = unique(source, new RegExp(`\\{const (${identifier})=(${identifier})\\.dataset\\.act;if\\(\\1==="chat"&&`, 'g'), 'room menu actions');
    // The menu is rebuilt when the player connects, by which time the host's own room is known.
    source = source.replace(menu[0], () => `${menu[1]}.innerHTML=\`\${${hook}?.ownRoom?.()?'<button type="button" class="btn" data-act="qol-room">Your room</button>':""}\${${menu[2]}.guest()?'<button type="button" class="btn" data-act="signin" `);
    source = source.replace(click[0], () => `{const ${click[1]}=${click[2]}.dataset.act;if(${click[1]}==="qol-room"){${hook}?.openRoom?.();return}if(${click[1]}==="chat"&&`);
  });
  return {source, adapter: adapter.join('')};
}

// Room transport hooks are one optional unit: a partial match must never send
// a private identifier to the site's ticket, ping or WebSocket endpoints.
function roomHooks(source, client, state) {
  const original = source;
  try {
    const list = unique(source, new RegExp(`async list\\(\\)\\{const (${identifier})=await fetch\\(this\\.baseUrl\\+"/servers",\\{signal:AbortSignal\\.timeout\\(8e3\\),cache:"no-store"\\}\\);if\\(!\\1\\.ok\\)throw Error\\("Servers unavailable"\\);const (${identifier})=await \\1\\.json\\(\\);if\\(!Array\\.isArray\\(\\2\\.servers\\)\\)throw Error\\("Invalid server list"\\);return \\2\\.servers\\}`, 'g'), 'room list');
    const measure = unique(source, new RegExp(`async measure\\((${identifier})\\)\\{const (${identifier})=performance\\.now\\(\\);if\\(!\\(await fetch\\(this\\.baseUrl\\+"/servers/"\\+\\1\\+"/ping"`, 'g'), 'room ping');
    const socket = unique(source, new RegExp(`new WebSocket\\((${identifier}),\\["surfd-v1",(${identifier})\\]\\)`, 'g'), 'room socket');
    const tickets = [...source.matchAll(/await this\.ticket\(\)/g)];
    if (tickets.length !== 2) throw new Error(`Unsupported Surfd build: room tickets (${tickets.length} matches)`);
    const bind = unique(source, new RegExp(`bindServers\\((${identifier}),(${identifier})\\)\\{(${identifier})=\\1,(${identifier})=\\2,\\2\\(\\)\\}`, 'g'), 'room join callback');
    const lobby = unique(source, new RegExp(`(${identifier})\\.bindServers\\(`, 'g'), 'room lobby')[1];
    const maps = unique(source, new RegExp(`refreshTop10\\(\\)\\{${identifier}\\.refresh\\((${identifier})\\.find\\((${identifier})=>\\2\\.id===${identifier}\\.currentMap\\(\\)\\)\\?\\?null\\)\\}`, 'g'), 'room maps')[1];
    const countdown = unique(source, new RegExp(`function (${identifier})\\((${identifier}),(${identifier})\\)\\{const (${identifier})=(${identifier})\\(\\2,\\3\\);return \\4===0\\?"Changing map…":`, 'g'), 'room countdown')[1];
    const clocks = new RegExp(`${literal(countdown)}\\((${identifier}(?:\\.state)?)\\.endsAt,Date\\.now\\(\\)(?:\\+${identifier})?\\)`, 'g');
    const clockCount = [...source.matchAll(clocks)].length;
    if (clockCount !== 4) throw new Error(`Unsupported Surfd build: room countdown views (${clockCount} matches)`);
    const hook = 'globalThis.__SURFD_QOL__?.privateRooms';
    // In private rooms View profile needs the account id the player sent, and Block stays hidden:
    // the room can't confirm who a player is, so a block could land on someone else's account.
    const profile = unique(source, new RegExp(`(${identifier})==="profile"&&(${identifier})\\.profile\\((${identifier})\\.id,\\3\\.name\\)`, 'g'), 'player profile');
    const block = unique(source, new RegExp(`\\$\\{!(${identifier})\\.guest&&(${identifier})\\.available&&\\2\\.block\\?`, 'g'), 'player block');
    const account = unique(source, new RegExp(`onSignIn:\\(\\)=>(${identifier})\\.openAccount\\(\\)`, 'g'), 'sign in')[1];
    const toast = unique(source, new RegExp(`(${identifier})\\("toast"\\)\\.textContent=(${identifier}),\\1\\("toast"\\)\\.classList\\.add\\("show"\\),(${identifier})=performance\\.now\\(\\)\\+5e3`, 'g'), 'room notice');
    source = roomBrowserHooks(source, hook);
    source = source.replace(profile[0], () => `${profile[1]}==="profile"&&${profile[2]}.profile(${profile[3]}.userId??${profile[3]}.id,${profile[3]}.name)`);
    source = source.replace(block[0], () => '${!' + block[1] + '.guest&&!/^private-/.test(' + block[1] + '.id)&&' + block[2] + '.available&&' + block[2] + '.block?');
    const leave = unique(source, new RegExp(`function (${identifier})\\(\\)\\{(${identifier})\\?\\.disconnect\\(\\),(${identifier})=null,`, 'g'), 'explicit room leave');
    const receive = unique(source, new RegExp(`receive\\((${identifier})\\)\\{if\\(\\1==="pong"\\)`, 'g'), 'room receiver');
    const decode = unique(source, new RegExp(`if\\(typeof (${identifier})!="string"\\|\\|\\1\\.length>65536\\)throw Error\\("Invalid room data"\\);const (${identifier})=JSON\\.parse\\(\\1\\);`, 'g'), 'room JSON decoder');
    source = source.replace(leave[0], () => leave[0].replace('{', () => `{${hook}?.leave(${leave[2]}?.roomId);`));
    source = source.replace(receive[0], () => receive[0].replace('){', () => ',__qolAssembled=false){'));
    source = source.replace(decode[0], () => `if(typeof ${decode[1]}!="string"||${decode[1]}.length>(__qolAssembled&&/^p-[a-z0-9]{12}$/.test(this.roomId)?${ROOM_MESSAGE_CHARS}:65536)){this.__qolChunks=null;throw Error("Invalid room data")}const ${decode[2]}=JSON.parse(${decode[1]});if(${decode[2]}.type==="room-chunk"&&/^p-[a-z0-9]{12}$/.test(this.roomId)){if(__qolAssembled||typeof ${decode[2]}.data!=="string"||typeof ${decode[2]}.final!=="boolean"){this.__qolChunks=null;throw Error("Invalid room chunk")}const chunks=this.__qolChunks??={parts:[],length:0};if(chunks.parts.length>=${ROOM_CHUNKS}||chunks.length+${decode[2]}.data.length>${ROOM_MESSAGE_CHARS}){this.__qolChunks=null;throw Error("Invalid room chunk")}chunks.parts.push(${decode[2]}.data);chunks.length+=${decode[2]}.data.length;if(${decode[2]}.final){this.__qolChunks=null;this.receive(chunks.parts.join(""),true)}return}if(this.__qolChunks){this.__qolChunks=null;throw Error("Invalid room chunk")}`);
    const disconnect = unique(source, /disconnect\(\)\{this\.watchTarget=null/g, 'room disconnect');
    source = source.replace(disconnect[0], () => 'disconnect(){this.__qolChunks=null;this.watchTarget=null');
    const listBody = list[0].slice('async list(){'.length, -1).replace(`return ${list[2]}.servers`, () => `return ${hook}?.mergeRooms(${list[2]}.servers)??${list[2]}.servers`);
    source = source.replace(list[0], () => `async list(){${hook}?.refreshDirectory?.();try{${listBody}}catch(error){const rows=${hook}?.mergeRooms([]);if(rows?.length)return rows;throw error}}`);
    source = source.replace(measure[0], () => measure[0].replace('{const ', () => `{const privatePing=${hook}?.measure(${measure[1]});if(privatePing!=null)return privatePing;const `));
    source = source.replace(socket[0], () => `(this.__qolChunks=null,${hook}?.roomSocket(this.roomId)??${socket[0]})`);
    source = source.replace(/await this\.ticket\(\)/g, () => `(${hook}?.ticket(this.roomId)??await this.ticket())`);
    source = source.replace(bind[0], () => `${bind[0]},joinServer(id){return ${bind[3]}(id)},refreshServers(){return ${bind[4]}()}`);
    source = source.replace(clocks, (call, room) => `(${room}.untimed===true?"No time limit":${call})`);
    const native = nativeRoomHooks(source, hook, lobby);
    source = native.source;
    const ui = roomUiHooks(source, hook);
    source = ui.source;
    let ranks = '';
    try {
      const table = unique(source, new RegExp(`const (${identifier})=\\[\\{points:0,title:"Unranked"\\}`, 'g'), 'rank table')[1];
      ranks = `
      ranks: () => ${table},`;
    } catch (error) {
      console.warn('[Surfd QoL] Rank table unavailable:', error.message);
    }
    return {source, adapter: `
    rooms: {${ui.adapter}${ranks}
      // The server browser's own status line, kept until the game lists servers again.
      setStatus: text => ${lobby}.updateServers(${lobby}.servers.rows().map(({serverTime,...row})=>row), text),
      openBrowser: () => ${lobby}.tab?.("servers"),
      // The HUD is hidden while the menu is open.
      notice: text => {${toast[1]}("menu-status").textContent=text;${toast[1]}("toast").textContent=text;${toast[1]}("toast").classList.add("show");${toast[3]}=performance.now()+5e3},
      join: id => ${lobby}.joinServer(id),
      rows: () => ${lobby}.servers.rows(),
      update: rows => ${lobby}.updateServers(rows.map(({serverTime,...row})=>row), ${lobby}.servers.status()),
      status: () => ${lobby}.servers.status(),
      browserOpen: () => !${lobby}.servers.view.el.hidden,${native.adapter}
      root: () => ${lobby}.servers.view.el,
      refresh: () => {${hook}?.refreshDirectory({open:!${lobby}.servers.view.el.hidden});return ${lobby}.refreshServers()},
      select: id => ${lobby}.servers.selectRoom(id),
      selected: () => ${lobby}.servers.selected(),
      displayName: () => ${client}.session ? ${client}.profile?.username ?? ${hook}?.guestName?.() ?? "Guest" : ${hook}?.guestName?.() ?? "Guest",
      appearance: () => ${client}.profile?.appearance ?? null,
      guest: () => !${client}.session,
      userId: () => ${client}.session?.user?.id ?? null,
      // The signed-in player's rank and points as the game's own profile shows them.
      profile: () => { const me = ${lobby}.me?.get?.(); return me?.kind === "member" && me.userId === ${client}.session?.user?.id ? {rank: me.rank, points: me.points} : null; },
      onAccountChange: listener => ${client}.onChange?.(listener) ?? (() => {}),
      signIn: () => ${account}.openAccount(),
      maps: () => ${maps},
      currentMap: () => ${state}?.map ?? ${lobby}.selected(),
      boardId: mapId => (${client}.config.maps.find(map => map.id === mapId && !map.archived) ?? ${client}.config.maps.find(map => map.id === mapId))?.boardId ?? null,
      // Every answer the site gives about a submitted run, as listener(attemptId, submission), until stopped.
      onVerdict: __qolListener => {
        const __qolClient = ${client}, __qolRestore = [];
        for (const name of ["submit", "submission"]) {
          const original = __qolClient[name], own = Object.hasOwn(__qolClient, name);
          if (typeof original !== "function") continue;
          const wrapper = function (id, ...rest) {
            const reply = original.call(this, id, ...rest);
            Promise.resolve(reply).then(value => __qolListener(id, value), () => {});
            return reply;
          };
          __qolClient[name] = wrapper;
          __qolRestore.push(() => { if (__qolClient[name] === wrapper) own ? __qolClient[name] = original : delete __qolClient[name]; });
        }
        return () => { for (const undo of __qolRestore.splice(0)) undo(); };
      },
    },`};
  } catch (error) {
    console.warn('[Surfd QoL] Private rooms unavailable:', error.message);
    return {source: original, adapter: ''};
  }
}

function previewViewHook(source, input) {
  try {
    unique(source, new RegExp(`setView\\((${identifier})\\)\\{this\\.yaw=\\1\\.yaw,this\\.pitch=Math\\.max\\(-89,Math\\.min\\(89,\\1\\.pitch\\)\\)\\}`, 'g'), 'camera view setter');
    return `
    previewView: {
      get: () => ({yaw: ${input}.yaw, pitch: ${input}.pitch}),
      set: view => ${input}.setView(view),
    },`;
  } catch (error) {
    console.warn('[Surfd QoL] Strafe preview unavailable:', error.message);
    return '';
  }
}

// Compare's cinematic view, optional. The map renderer is a plain object the
// game calls once per frame with a view. The patch adds its scene, camera and
// record-ghost factory, so extra ghosts share the game's ghost look, and
// passes the frame's interpolation to render() as qolAlpha.
function cinemaHooks(source, client) {
  try {
    const factory = unique(source, new RegExp(`function (${identifier})\\((${identifier})\\)\\{const (${identifier})=new ${identifier};\\3\\.name="record-ghost"`, 'g'), 'record ghost')[1];
    const scene = unique(source, new RegExp(`(${identifier})=${literal(factory)}\\((${identifier})\\)`, 'g'), 'record ghost scene')[2];
    const camera = unique(source, new RegExp(`\\.fov!==${identifier}&&\\((${identifier})\\.fov=2\\*Math\\.atan`, 'g'), 'map camera')[1];
    const object = unique(source, new RegExp(`(${identifier})=\\{resize:(${identifier}),setQuality:`, 'g'), 'map renderer');
    const call = unique(source, new RegExp(`(${identifier})\\.render\\(\\{state:${identifier},eyePosition:`, 'g'), 'frame render')[1];
    const ghost = unique(source, new RegExp(`ghost:(${identifier})\\|\\|(${identifier})\\?null:(${identifier})\\.frame\\((${identifier}),(${identifier})\\)\\}\\)`, 'g'), 'frame interpolation');
    // Optional even within cinema: an unknown WebGL renderer layout must not
    // disable the camera. Unsupported GPUs keep the existing first-draw path.
    let compile = '';
    try {
      const webgl = unique(source, new RegExp(`(${identifier})\\.render\\(${literal(scene)},${literal(camera)}\\)`, 'g'), 'cinema WebGL renderer')[1];
      // Three's compileAsync has no cancellation: its internal polling can
      // outlive a disposed renderer. Submit the same parallel compilation,
      // but own the readiness wait so scene disposal can stop it safely.
      compile = `qolCompile:typeof ${webgl}.compile==="function"&&${webgl}.extensions?.has?.("KHR_parallel_shader_compile")&&typeof ${webgl}.properties?.get==="function"?(root,signal)=>{
        const materials=${webgl}.compile(root,${camera},${scene}),programs=new Set();
        for(const material of materials)for(const program of ${webgl}.properties.get(material).programs.values())programs.add(program);
        return new Promise(resolve=>{
          let timer;
          const done=()=>{clearTimeout(timer);signal?.removeEventListener("abort",done);resolve();};
          const check=()=>{
            if(signal?.aborted||${webgl}.getContext().isContextLost()){done();return;}
            for(const program of programs)if(!program.isReady()){timer=setTimeout(check,10);return;}
            done();
          };
          signal?.addEventListener("abort",done,{once:true});
          check();
        });
      }:null,`;
    } catch { /* Shader preparation is optional; the renderer hook still works. */ }
    source = source.replace(object[0], () => `${object[1]}={${compile}qolScene:${scene},qolCamera:${camera},qolGhost:()=>${factory}(${scene}),resize:${object[2]},setQuality:`);
    source = source.replace(ghost[0], () => `${ghost[0].slice(0, -2)},qolAlpha:${ghost[5]}})`);
    return {source, adapter: `
    cinema: {
      renderer: () => ${call} ?? null,
      worker: (session,replay) => typeof __surfdQolIndexes === "function" ? __surfdQolIndexes().camera(session,replay,${client}.config?.maps?.find(entry=>entry.id===session?.map?.id)??session?.map) : null,
    },`};
  } catch (error) {
    console.warn('[Surfd QoL] Compare view unavailable:', error.message);
    return {source, adapter: ''};
  }
}

// The adapter reads native objects. Optional hooks integrate UI, transport and
// rendering, and unroll an exactly recognised collision-box comparison without
// changing movement rules. Unrecognised hooks leave that native code unchanged.
// Newer builds create the movement through a factory that adds ladder and water state.
function movementClassOf(source, body) {
  const direct = [...body.matchAll(new RegExp(`this\\.movement=new (${identifier})\\(`, 'g'))];
  if (direct.length === 1) return direct[0][1];
  const factory = unique(body, new RegExp(`this\\.movement=(${identifier})\\(`, 'g'), 'movement class')[1];
  return unique(source, new RegExp(`function ${literal(factory)}\\(${identifier},${identifier},${identifier}\\)\\{return new (${identifier})\\(`, 'g'), 'movement factory')[1];
}

export function instrumentGame(source, mapWorkerSource = '') {
  if (alreadyInstrumented(source)) return source;
  const state = unique(source, new RegExp(`state:(${identifier})\\?\\.state,run:\\1\\?\\.timer\\.state`, 'g'), 'session snapshot')[1];
  const viewed = unique(source, new RegExp(`spectator:\\{target:(${identifier}),view:(${identifier})\\}`, 'g'), 'spectator view');
  const marker = unique(source, /checkpointSpeeds=\[\];startJumps=0/g, 'session fields').index;
  const classes = [...source.slice(0, marker).matchAll(new RegExp(`class (${identifier})\\{`, 'g'))];
  const sessionClass = classes.at(-1)?.[1];
  if (!sessionClass) throw new Error('Unsupported Surfd build: Session class');
  const body = source.slice(classes.at(-1).index, marker);
  const movementClass = movementClassOf(source, body);
  if (!body.includes('this.timer=') || !body.includes('this.map=')) throw new Error('Unsupported Surfd build: Session contract');
  const binding = unique(source, new RegExp(`(${identifier})\\.setBindings\\((${identifier})\\.bindings\\)`, 'g'), 'native input');
  const references = unique(source, new RegExp(`const (${identifier})=(${identifier})\\.current\\?\\.entries\\.find\\((${identifier})=>\\3\\.rank===1\\);(${identifier})\\.prepare\\(([^;]{1,200}?),\\(\\)=>(${identifier})\\.replay\\(\\1\\.runId\\)\\)`, 'g'), 'leaderboard references');
  const boardStore = references[2];
  const client = references[6];
  if (!source.includes(`${client}.board(${state}.map)`)) throw new Error('Unsupported Surfd build: board lookup');
  // Before the map hooks, which rewrite the loaders it recognises.
  const entry = nativeMapEntryHooks(source);
  source = entry.source;
  const worldContract = knownNativeWorld(source);
  source = nativeCollisionWorldHooks(source, worldContract);
  source = collisionBoundsHook(source);
  source = source.replace(new RegExp(`new ${literal(sessionClass)}\\((${identifier}),(${identifier})\\.config\\)`, 'g'),
    (_, map, replay) => `new ${sessionClass}(${map},${replay}.config,${replay}.format)`);
  source = nativeCollisionTreeHooks(source);
  if (mapWorkerSource) source = nativeMapFloorHooks(source, worldContract);
  if (mapWorkerSource) source = nativeMapPreparationHooks(source, worldContract, sessionClass);
  source = preparedIndexHooks(source, state);
  source = nativeStageResetHooks(source);
  source = nativeMapLoadHooks(source);
  source = nativeProgressiveMapHooks(source);
  const rooms = roomHooks(source, client, state);
  source = rooms.source;
  const practice = practiceHooks(source, sessionClass, state);
  source = practice.source;
  const cinema = cinemaHooks(source, client);
  source = cinema.source;
  return nativeMapWorkerHooks(source, mapWorkerSource) + `${ADAPTER_MARKER} native community rooms and optional room transport */
${practice.setup}
;(() => {
  const qol = globalThis.__SURFD_QOL__;
  if (!qol) return;
  const viewed = {target: null, view: null};
  qol.attach({
    Session: ${sessionClass}, Movement: ${movementClass},
    getSession: () => ${state},
    getView: () => { viewed.target = ${viewed[1]}; viewed.view = ${viewed[2]}; return viewed; },
    getInput: () => ${binding[1]},
    getBindings: () => ${binding[2]}.bindings,
    setInputBindings: bindings => ${binding[1]}.setBindings(bindings),${previewViewHook(source, binding[1])}${replayHooks(source)}${practice.adapter}${noticeHook(source)}${cinema.adapter}${rooms.adapter}${entry.controller ? `
    onlineRuns: () => ${entry.controller},` : ''}
    getReferences: () => {
      const session = ${state};
      if (!session) return null;
      const board = ${client}.board(session.map);
      const ownerKey = ${client}.session?.user.id ?? 'guest';
      const key = board ? board.boardId + ':' + ownerKey : '';
      const current = ${boardStore}.current;
      const refs = board && ${boardStore}.key === key && current?.boardId === board.boardId ? current : null;
      const mapInfo = ${client}.config.maps.find(entry => entry.id === session.map.id);
      const recordSlug = mapInfo?.slug ?? session.map.slug;
      const record = refs?.entries?.find(entry => entry.rank === 1) ?? null;
      return {ownerKey, boardId: board?.boardId ?? null, own: refs?.own ?? null, record, entries: refs?.entries ?? [], mapName: mapInfo?.title ?? (mapInfo?.slug ? String(mapInfo.slug).split(/[-_]/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') : mapInfo?.name) ?? null,
        loadReplay: runId => ${client}.replay(runId),
        loadRecordRoute: () => recordSlug ? fetch('/replays/' + encodeURIComponent(recordSlug) + '-complete.json', {signal: AbortSignal.timeout(3e4)}).then(response => response.ok ? response.json() : null) : Promise.resolve(null)};
    }
  });
})();
`;
}
