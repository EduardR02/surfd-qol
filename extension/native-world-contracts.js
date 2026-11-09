// Exact native vector helpers, BVH, axes, and complete world class, one entry
// per reviewed bundle (the game and each physics worker). Checking the entire
// class also rules out new constructor state, field initializers and changed
// methods before a prepared world skips it. A different bundle stays native
// until its complete contract is reviewed.
export const nativeWorldContracts = [
  // Surfd before the bonus update: the game, then its physics workers.
  {name: 'k1', index: 'e', cached: 't', triangle: 'i', vertices: 's',
    signature: "nt=(n=0,e=0,t=0)=>({x:n,y:e,z:t}),gn=n=>({...n}),vn=(n,e)=>nt(n.x+e.x,n.y+e.y,n.z+e.z),us=(n,e)=>nt(n.x-e.x,n.y-e.y,n.z-e.z),ti=(n,e)=>nt(n.x*e,n.y*e,n.z*e),un=(n,e)=>n.x*e.x+n.y*e" +
      ".y+n.z*e.z,Xd=(n,e)=>nt(n.y*e.z-n.z*e.y,n.z*e.x-n.x*e.z,n.x*e.y-n.y*e.x),ir=n=>Math.hypot(n.x,n.y,n.z),Ri=n=>Math.hypot(n.x,n.y),rl=n=>{const e=ir(n);return e>1e-12?ti(n,1/e):nt()}" +
      ",A1=(n,e,t)=>vn(n,ti(us(e,n),t)),Ar=(n,e,t)=>Math.max(e,Math.min(t,n)),Y0=n=>nt(Math.fround(n.x),Math.fround(n.y),Math.fround(n.z)),jd=[\"x\",\"y\",\"z\"],df=(n,e)=>jd.every(t=>n.min[t]<" +
      "=e.max[t]&&n.max[t]>=e.min[t]);class K0{constructor(e,t=12){this.bounds=e;const i=s=>{const r={x:1/0,y:1/0,z:1/0},a={x:-1/0,y:-1/0,z:-1/0};for(const l of s)for(const d of jd)r[d]=M" +
      "ath.min(r[d],e[l].min[d]),a[d]=Math.max(a[d],e[l].max[d]);if(s.length<=t)return{min:r,max:a,items:s};const o=jd.reduce((l,d)=>a[d]-r[d]>a[l]-r[l]?d:l);s.sort((l,d)=>e[l].min[o]+e[l" +
      "].max[o]-(e[d].min[o]+e[d].max[o])||l-d);const c=s.length>>1;return{min:r,max:a,left:i(s.slice(0,c)),right:i(s.slice(c))}};this.root=e.length?i(e.map((s,r)=>r)):null}bounds;root;qu" +
      "ery(e){const t=[],i=s=>{if(df(s,e))if(s.items)for(const r of s.items)df(this.bounds[r],e)&&t.push(r);else i(s.left),i(s.right)};return this.root&&i(this.root),t.sort((s,r)=>s-r)}}c" +
      "onst Un=.03125,Xs=[\"x\",\"y\",\"z\"];class k1{constructor(e,t=[],i=!1,s=!1){this.brushes=e,this.triangles=t,this.vphysicsFeatureFix=i,this.bspCornerFix=s,this.triangleBounds=t.map(r=>({" +
      "min:nt(...Xs.map(a=>Math.min(...r.vertices.map(o=>o[a])))),max:nt(...Xs.map(a=>Math.max(...r.vertices.map(o=>o[a]))))})),this.tree=new K0([...e,...this.triangleBounds])}brushes;tri" +
      "angles;vphysicsFeatureFix;bspCornerFix;tree;triangleBounds;triangleCache=new Map;triangleBrush(e){const t=this.triangleCache.get(e);if(t)return t;const i=this.triangles[e],s=i.vert" +
      "ices,r=[nt(1,0,0),nt(0,1,0),nt(0,0,1)],o=[rl(Xd(us(s[1],s[0]),us(s[2],s[0]))),...r];for(let d=0;d<3;d++)for(const u of r)o.push(Xd(us(s[(d+1)%3],s[d]),u));const c=[];for(const d of" +
      " o)if(!(ir(d)<1e-8))for(const u of[1,-1]){const h=ti(rl(d),u);c.some(f=>un(f.normal,h)>1-1e-9)||c.push({normal:h,distance:Math.max(...s.map(f=>un(h,f)))})}const l={id:`disp-${i.sur" +
      "faceId}-${i.triangleId}`,vertices:s,faces:[[0,1,2]],planes:c,...this.triangleBounds[e],color:\"#d4dadd\",friction:1,kind:\"snow\"};return this.triangleCache.set(e,l),l}trace(e,t,i){con" +
      "st s={fraction:1,end:{...t},normal:nt(),startSolid:!1,allSolid:!1,brush:null},r={min:nt(),max:nt()};for(const a of Xs)r.min[a]=Math.min(e[a],t[a])+i.min[a]-Un,r.max[a]=Math.max(e[a" +
      "],t[a])+i.max[a]+Un;for(const a of this.tree.query(r)){const o=a<this.brushes.length?this.brushes[a]:this.triangleBrush(a-this.brushes.length);if(Xs.some(y=>Math.max(e[y],t[y])+i.m" +
      "ax[y]<o.min[y]-Un||Math.min(e[y],t[y])+i.min[y]>o.max[y]+Un)||o.leafBounds&&!o.leafBounds.some(y=>Xs.every(S=>r.max[S]>=y.min[S]&&r.min[S]<=y.max[S])))continue;let c=-1,l=1,d=nt()," +
      "u=!1,h=!1,f=!1,v,g=-1/0,m=1/0,p=-1,x=nt();const b=this.bspCornerFix&&!o.collisionModel&&o.planes.length===6&&o.planes.every(y=>Xs.filter(S=>y.normal[S]!==0).length===1&&Xs.some(S=>" +
      "Math.abs(y.normal[S])===1));for(const y of o.planes){const S=y.normal,E=S.x*(S.x<0?i.max.x:i.min.x)+S.y*(S.y<0?i.max.y:i.min.y)+S.z*(S.z<0?i.max.z:i.min.z),C=y.distance-E,_=un(e,S)" +
      "-C,w=un(t,S)-C;if(o.collisionModel===\"vphysics\"||b)if(_>w){const T=_/(_-w);T>g&&(g=T,p=Math.max(0,(_-Un)/(_-w)),x=S)}else _<w&&(m=Math.min(m,_/(_-w)));if(_>0&&(u=!0),w>0&&(h=!0),_>" +
      "0&&w>0&&(!o.collisionModel||w>=_-1e-5)){f=!0;break}if(!(_<=0&&w<=0))if(_>w){const T=Math.max(0,(_-Un)/(_-w));T>c&&(c=T,d=S,v=y.friction)}else l=Math.min(l,(_+Un)/(_-w))}if(!(f||m<1" +
      "&&g>m)){if(this.vphysicsFeatureFix&&o.collisionModel===\"vphysics\"&&(c=p,d=x),!u){if(s.startSolid=!0,!h)return s.allSolid=!0,s.fraction=0,s.end={...e},s.brush=o,s;continue}c<l&&c>-1" +
      "&&c<s.fraction&&(s.fraction=Math.max(0,c),s.normal={...d},s.brush=o,v!==void 0?s.friction=v:delete s.friction)}}return s.end=A1(e,t,s.fraction),s}}"},
  {name: 'ke', index: 'e', cached: 't', triangle: 'a', vertices: 's',
    signature: "m=(o=0,e=0,t=0)=>({x:o,y:e,z:t}),x=o=>({...o}),w=(o,e)=>m(o.x+e.x,o.y+e.y,o.z+e.z),P=(o,e)=>m(o.x-e.x,o.y-e.y,o.z-e.z),E=(o,e)=>m(o.x*e,o.y*e,o.z*e),S=(o,e)=>o.x*e.x+o.y*e.y+o.z*e." +
      "z,W=(o,e)=>m(o.y*e.z-o.z*e.y,o.z*e.x-o.x*e.z,o.x*e.y-o.y*e.x),N=o=>Math.hypot(o.x,o.y,o.z),C=o=>Math.hypot(o.x,o.y),G=o=>{const e=N(o);return e>1e-12?E(o,1/e):m()},be=(o,e,t)=>w(o," +
      "E(P(e,o),t)),j=(o,e,t)=>Math.max(e,Math.min(t,o)),ye=o=>m(Math.fround(o.x),Math.fround(o.y),Math.fround(o.z)),$=[\"x\",\"y\",\"z\"],Z=(o,e)=>$.every(t=>o.min[t]<=e.max[t]&&o.max[t]>=e.mi" +
      "n[t]);class ve{constructor(e,t=12){this.bounds=e;const a=s=>{const i={x:1/0,y:1/0,z:1/0},c={x:-1/0,y:-1/0,z:-1/0};for(const u of s)for(const f of $)i[f]=Math.min(i[f],e[u].min[f])," +
      "c[f]=Math.max(c[f],e[u].max[f]);if(s.length<=t)return{min:i,max:c,items:s};const r=$.reduce((u,f)=>c[f]-i[f]>c[u]-i[u]?f:u);s.sort((u,f)=>e[u].min[r]+e[u].max[r]-(e[f].min[r]+e[f]." +
      "max[r])||u-f);const n=s.length>>1;return{min:i,max:c,left:a(s.slice(0,n)),right:a(s.slice(n))}};this.root=e.length?a(e.map((s,i)=>i)):null}bounds;root;query(e){const t=[],a=s=>{if(" +
      "Z(s,e))if(s.items)for(const i of s.items)Z(this.bounds[i],e)&&t.push(i);else a(s.left),a(s.right)};return this.root&&a(this.root),t.sort((s,i)=>s-i)}}const T=.03125,M=[\"x\",\"y\",\"z\"]" +
      ";class ke{constructor(e,t=[],a=!1,s=!1){this.brushes=e,this.triangles=t,this.vphysicsFeatureFix=a,this.bspCornerFix=s,this.triangleBounds=t.map(i=>({min:m(...M.map(c=>Math.min(...i" +
      ".vertices.map(r=>r[c])))),max:m(...M.map(c=>Math.max(...i.vertices.map(r=>r[c]))))})),this.tree=new ve([...e,...this.triangleBounds])}brushes;triangles;vphysicsFeatureFix;bspCorner" +
      "Fix;tree;triangleBounds;triangleCache=new Map;triangleBrush(e){const t=this.triangleCache.get(e);if(t)return t;const a=this.triangles[e],s=a.vertices,i=[m(1,0,0),m(0,1,0),m(0,0,1)]" +
      ",r=[G(W(P(s[1],s[0]),P(s[2],s[0]))),...i];for(let f=0;f<3;f++)for(const l of i)r.push(W(P(s[(f+1)%3],s[f]),l));const n=[];for(const f of r)if(!(N(f)<1e-8))for(const l of[1,-1]){con" +
      "st d=E(G(f),l);n.some(h=>S(h.normal,d)>1-1e-9)||n.push({normal:d,distance:Math.max(...s.map(h=>S(d,h)))})}const u={id:`disp-${a.surfaceId}-${a.triangleId}`,vertices:s,faces:[[0,1,2" +
      "]],planes:n,...this.triangleBounds[e],color:\"#d4dadd\",friction:1,kind:\"snow\"};return this.triangleCache.set(e,u),u}trace(e,t,a){const s={fraction:1,end:{...t},normal:m(),startSolid" +
      ":!1,allSolid:!1,brush:null},i={min:m(),max:m()};for(const c of M)i.min[c]=Math.min(e[c],t[c])+a.min[c]-T,i.max[c]=Math.max(e[c],t[c])+a.max[c]+T;for(const c of this.tree.query(i)){" +
      "const r=c<this.brushes.length?this.brushes[c]:this.triangleBrush(c-this.brushes.length);if(M.some(k=>Math.max(e[k],t[k])+a.max[k]<r.min[k]-T||Math.min(e[k],t[k])+a.min[k]>r.max[k]+" +
      "T)||r.leafBounds&&!r.leafBounds.some(k=>M.every(_=>i.max[_]>=k.min[_]&&i.min[_]<=k.max[_])))continue;let n=-1,u=1,f=m(),l=!1,d=!1,h=!1,g,p=-1/0,b=1/0,y=-1,I=m();const F=this.bspCor" +
      "nerFix&&!r.collisionModel&&r.planes.length===6&&r.planes.every(k=>M.filter(_=>k.normal[_]!==0).length===1&&M.some(_=>Math.abs(k.normal[_])===1));for(const k of r.planes){const _=k." +
      "normal,Re=_.x*(_.x<0?a.max.x:a.min.x)+_.y*(_.y<0?a.max.y:a.min.y)+_.z*(_.z<0?a.max.z:a.min.z),se=k.distance-Re,A=S(e,_)-se,H=S(t,_)-se;if(r.collisionModel===\"vphysics\"||F)if(A>H){c" +
      "onst B=A/(A-H);B>p&&(p=B,y=Math.max(0,(A-T)/(A-H)),I=_)}else A<H&&(b=Math.min(b,A/(A-H)));if(A>0&&(l=!0),H>0&&(d=!0),A>0&&H>0&&(!r.collisionModel||H>=A-1e-5)){h=!0;break}if(!(A<=0&" +
      "&H<=0))if(A>H){const B=Math.max(0,(A-T)/(A-H));B>n&&(n=B,f=_,g=k.friction)}else u=Math.min(u,(A+T)/(A-H))}if(!(h||b<1&&p>b)){if(this.vphysicsFeatureFix&&r.collisionModel===\"vphysic" +
      "s\"&&(n=y,f=I),!l){if(s.startSolid=!0,!d)return s.allSolid=!0,s.fraction=0,s.end={...e},s.brush=r,s;continue}n<u&&n>-1&&n<s.fraction&&(s.fraction=Math.max(0,n),s.normal={...f},s.bru" +
      "sh=r,g!==void 0?s.friction=g:delete s.friction)}}return s.end=be(e,t,s.fraction),s}}"},
  // The bonus update (game-DqSy0aFU.js): the game, then the replay-index, ghost and checkpoint-speed workers.
  {name: 'w0', index: 'e', cached: 't', triangle: 'i', vertices: 'a',
    signature: "ze=(n=0,e=0,t=0)=>({x:n,y:e,z:t}),Gt=n=>({...n}),fn=(n,e)=>ze(n.x+e.x,n.y+e.y,n.z+e.z),gi=(n,e)=>ze(n.x-e.x,n.y-e.y,n.z-e.z),ai=(n,e)=>ze(n.x*e,n.y*e,n.z*e),gn=(n,e)=>n.x*e.x+n.y*e" +
      ".y+n.z*e.z,ku=(n,e)=>ze(n.y*e.z-n.z*e.y,n.z*e.x-n.x*e.z,n.x*e.y-n.y*e.x),ys=n=>Math.hypot(n.x,n.y,n.z),vi=n=>Math.hypot(n.x,n.y),Ad=n=>{const e=ys(n);return e>1e-12?ai(n,1/e):ze()}" +
      ",x0=(n,e,t)=>fn(n,ai(gi(e,n),t)),Ni=(n,e,t)=>Math.max(e,Math.min(t,n)),Jm=n=>ze(Math.fround(n.x),Math.fround(n.y),Math.fround(n.z)),Au=[\"x\",\"y\",\"z\"],th=(n,e)=>Au.every(t=>n.min[t]<" +
      "=e.max[t]&&n.max[t]>=e.min[t]);class Zm{constructor(e,t=12){this.bounds=e;const i=a=>{const s={x:1/0,y:1/0,z:1/0},r={x:-1/0,y:-1/0,z:-1/0};for(const d of a)for(const l of Au)s[l]=M" +
      "ath.min(s[l],e[d].min[l]),r[l]=Math.max(r[l],e[d].max[l]);if(a.length<=t)return{min:s,max:r,items:a};const o=Au.reduce((d,l)=>r[l]-s[l]>r[d]-s[d]?l:d);a.sort((d,l)=>e[d].min[o]+e[d" +
      "].max[o]-(e[l].min[o]+e[l].max[o])||d-l);const c=a.length>>1;return{min:s,max:r,left:i(a.slice(0,c)),right:i(a.slice(c))}};this.root=e.length?i(e.map((a,s)=>s)):null}bounds;root;qu" +
      "ery(e){const t=[],i=a=>{if(th(a,e))if(a.items)for(const s of a.items)th(this.bounds[s],e)&&t.push(s);else i(a.left),i(a.right)};return this.root&&i(this.root),t.sort((a,s)=>a-s)}}c" +
      "onst En=.03125,ds=[\"x\",\"y\",\"z\"];class w0{constructor(e,t=[],i=!1,a=!1){this.brushes=e,this.triangles=t,this.vphysicsFeatureFix=i,this.bspCornerFix=a,this.triangleBounds=t.map(s=>({" +
      "min:ze(...ds.map(r=>Math.min(...s.vertices.map(o=>o[r])))),max:ze(...ds.map(r=>Math.max(...s.vertices.map(o=>o[r]))))})),this.tree=new Zm([...e,...this.triangleBounds])}brushes;tri" +
      "angles;vphysicsFeatureFix;bspCornerFix;tree;triangleBounds;triangleCache=new Map;triangleBrush(e){const t=this.triangleCache.get(e);if(t)return t;const i=this.triangles[e],a=i.vert" +
      "ices,s=[ze(1,0,0),ze(0,1,0),ze(0,0,1)],o=[Ad(ku(gi(a[1],a[0]),gi(a[2],a[0]))),...s];for(let l=0;l<3;l++)for(const u of s)o.push(ku(gi(a[(l+1)%3],a[l]),u));const c=[];for(const l of" +
      " o)if(!(ys(l)<1e-8))for(const u of[1,-1]){const f=ai(Ad(l),u);c.some(h=>gn(h.normal,f)>1-1e-9)||c.push({normal:f,distance:Math.max(...a.map(h=>gn(f,h)))})}const d={id:`disp-${i.sur" +
      "faceId}-${i.triangleId}`,vertices:a,faces:[[0,1,2]],planes:c,...this.triangleBounds[e],color:\"#d4dadd\",friction:1,kind:\"snow\"};return this.triangleCache.set(e,d),d}trace(e,t,i){con" +
      "st a={fraction:1,end:{...t},normal:ze(),startSolid:!1,allSolid:!1,brush:null},s={min:ze(),max:ze()};for(const r of ds)s.min[r]=Math.min(e[r],t[r])+i.min[r]-En,s.max[r]=Math.max(e[r" +
      "],t[r])+i.max[r]+En;for(const r of this.tree.query(s)){const o=r<this.brushes.length?this.brushes[r]:this.triangleBrush(r-this.brushes.length);if(ds.some(v=>Math.max(e[v],t[v])+i.m" +
      "ax[v]<o.min[v]-En||Math.min(e[v],t[v])+i.min[v]>o.max[v]+En)||o.leafBounds&&!o.leafBounds.some(v=>ds.every(x=>s.max[x]>=v.min[x]&&s.min[x]<=v.max[x])))continue;let c=-1,d=1,l=ze()," +
      "u=!1,f=!1,h=!1,b,g=-1/0,m=1/0,p=-1,S=ze();const y=this.bspCornerFix&&!o.collisionModel&&o.planes.length===6&&o.planes.every(v=>ds.filter(x=>v.normal[x]!==0).length===1&&ds.some(x=>" +
      "Math.abs(v.normal[x])===1));for(const v of o.planes){const x=v.normal,M=x.x*(x.x<0?i.max.x:i.min.x)+x.y*(x.y<0?i.max.y:i.min.y)+x.z*(x.z<0?i.max.z:i.min.z),k=v.distance-M,_=gn(e,x)" +
      "-k,w=gn(t,x)-k;if(o.collisionModel===\"vphysics\"||y)if(_>w){const T=_/(_-w);T>g&&(g=T,p=Math.max(0,(_-En)/(_-w)),S=x)}else _<w&&(m=Math.min(m,_/(_-w)));if(_>0&&(u=!0),w>0&&(f=!0),_>" +
      "0&&w>0&&(!o.collisionModel||w>=_-1e-5)){h=!0;break}if(!(_<=0&&w<=0))if(_>w){const T=Math.max(0,(_-En)/(_-w));T>c&&(c=T,l=x,b=v.friction)}else d=Math.min(d,(_+En)/(_-w))}if(!(h||m<1" +
      "&&g>m)){if(this.vphysicsFeatureFix&&o.collisionModel===\"vphysics\"&&(c=p,l=S),!u){if(a.startSolid=!0,!f)return a.allSolid=!0,a.fraction=0,a.end={...e},a.brush=o,a;continue}c<d&&c>-1" +
      "&&c<a.fraction&&(a.fraction=Math.max(0,c),a.normal={...l},a.brush=o,b!==void 0?a.friction=b:delete a.friction)}}return a.end=x0(e,t,a.fraction),a}}"},
  {name: 'Ce', index: 'e', cached: 't', triangle: 'a', vertices: 'c',
    signature: "p=(i=0,e=0,t=0)=>({x:i,y:e,z:t}),z=i=>({...i}),A=(i,e)=>p(i.x+e.x,i.y+e.y,i.z+e.z),C=(i,e)=>p(i.x-e.x,i.y-e.y,i.z-e.z),P=(i,e)=>p(i.x*e,i.y*e,i.z*e),B=(i,e)=>i.x*e.x+i.y*e.y+i.z*e." +
      "z,K=(i,e)=>p(i.y*e.z-i.z*e.y,i.z*e.x-i.x*e.z,i.x*e.y-i.y*e.x),$=i=>Math.hypot(i.x,i.y,i.z),V=i=>Math.hypot(i.x,i.y),L=i=>{const e=$(i);return e>1e-12?P(i,1/e):p()},He=(i,e,t)=>A(i," +
      "P(C(e,i),t)),N=(i,e,t)=>Math.max(e,Math.min(t,i)),Me=i=>p(Math.fround(i.x),Math.fround(i.y),Math.fround(i.z)),X=[\"x\",\"y\",\"z\"],ne=(i,e)=>X.every(t=>i.min[t]<=e.max[t]&&i.max[t]>=e.m" +
      "in[t]);class Pe{constructor(e,t=12){this.bounds=e;const a=c=>{const s={x:1/0,y:1/0,z:1/0},r={x:-1/0,y:-1/0,z:-1/0};for(const n of c)for(const l of X)s[l]=Math.min(s[l],e[n].min[l])" +
      ",r[l]=Math.max(r[l],e[n].max[l]);if(c.length<=t)return{min:s,max:r,items:c};const o=X.reduce((n,l)=>r[l]-s[l]>r[n]-s[n]?l:n);c.sort((n,l)=>e[n].min[o]+e[n].max[o]-(e[l].min[o]+e[l]" +
      ".max[o])||n-l);const d=c.length>>1;return{min:s,max:r,left:a(c.slice(0,d)),right:a(c.slice(d))}};this.root=e.length?a(e.map((c,s)=>s)):null}bounds;root;query(e){const t=[],a=c=>{if" +
      "(ne(c,e))if(c.items)for(const s of c.items)ne(this.bounds[s],e)&&t.push(s);else a(c.left),a(c.right)};return this.root&&a(this.root),t.sort((c,s)=>c-s)}}const F=.03125,D=[\"x\",\"y\",\"" +
      "z\"];class Ce{constructor(e,t=[],a=!1,c=!1){this.brushes=e,this.triangles=t,this.vphysicsFeatureFix=a,this.bspCornerFix=c,this.triangleBounds=t.map(s=>({min:p(...D.map(r=>Math.min(." +
      "..s.vertices.map(o=>o[r])))),max:p(...D.map(r=>Math.max(...s.vertices.map(o=>o[r]))))})),this.tree=new Pe([...e,...this.triangleBounds])}brushes;triangles;vphysicsFeatureFix;bspCor" +
      "nerFix;tree;triangleBounds;triangleCache=new Map;triangleBrush(e){const t=this.triangleCache.get(e);if(t)return t;const a=this.triangles[e],c=a.vertices,s=[p(1,0,0),p(0,1,0),p(0,0," +
      "1)],o=[L(K(C(c[1],c[0]),C(c[2],c[0]))),...s];for(let l=0;l<3;l++)for(const b of s)o.push(K(C(c[(l+1)%3],c[l]),b));const d=[];for(const l of o)if(!($(l)<1e-8))for(const b of[1,-1]){" +
      "const f=P(L(l),b);d.some(u=>B(u.normal,f)>1-1e-9)||d.push({normal:f,distance:Math.max(...c.map(u=>B(f,u)))})}const n={id:`disp-${a.surfaceId}-${a.triangleId}`,vertices:c,faces:[[0," +
      "1,2]],planes:d,...this.triangleBounds[e],color:\"#d4dadd\",friction:1,kind:\"snow\"};return this.triangleCache.set(e,n),n}trace(e,t,a){const c={fraction:1,end:{...t},normal:p(),startSo" +
      "lid:!1,allSolid:!1,brush:null},s={min:p(),max:p()};for(const r of D)s.min[r]=Math.min(e[r],t[r])+a.min[r]-F,s.max[r]=Math.max(e[r],t[r])+a.max[r]+F;for(const r of this.tree.query(s" +
      ")){const o=r<this.brushes.length?this.brushes[r]:this.triangleBrush(r-this.brushes.length);if(D.some(g=>Math.max(e[g],t[g])+a.max[g]<o.min[g]-F||Math.min(e[g],t[g])+a.min[g]>o.max[" +
      "g]+F)||o.leafBounds&&!o.leafBounds.some(g=>D.every(k=>s.max[k]>=g.min[k]&&s.min[k]<=g.max[k])))continue;let d=-1,n=1,l=p(),b=!1,f=!1,u=!1,h,m=-1/0,y=1/0,S=-1,v=p();const w=this.bsp" +
      "CornerFix&&!o.collisionModel&&o.planes.length===6&&o.planes.every(g=>D.filter(k=>g.normal[k]!==0).length===1&&D.some(k=>Math.abs(g.normal[k])===1));for(const g of o.planes){const k" +
      "=g.normal,E=k.x*(k.x<0?a.max.x:a.min.x)+k.y*(k.y<0?a.max.y:a.min.y)+k.z*(k.z<0?a.max.z:a.min.z),T=g.distance-E,_=B(e,k)-T,I=B(t,k)-T;if(o.collisionModel===\"vphysics\"||w)if(_>I){con" +
      "st M=_/(_-I);M>m&&(m=M,S=Math.max(0,(_-F)/(_-I)),v=k)}else _<I&&(y=Math.min(y,_/(_-I)));if(_>0&&(b=!0),I>0&&(f=!0),_>0&&I>0&&(!o.collisionModel||I>=_-1e-5)){u=!0;break}if(!(_<=0&&I" +
      "<=0))if(_>I){const M=Math.max(0,(_-F)/(_-I));M>d&&(d=M,l=k,h=g.friction)}else n=Math.min(n,(_+F)/(_-I))}if(!(u||y<1&&m>y)){if(this.vphysicsFeatureFix&&o.collisionModel===\"vphysics\"" +
      "&&(d=S,l=v),!b){if(c.startSolid=!0,!f)return c.allSolid=!0,c.fraction=0,c.end={...e},c.brush=o,c;continue}d<n&&d>-1&&d<c.fraction&&(c.fraction=Math.max(0,d),c.normal={...l},c.brush" +
      "=o,h!==void 0?c.friction=h:delete c.friction)}}return c.end=He(e,t,c.fraction),c}}"},
  {name: 'Pe', index: 'e', cached: 't', triangle: 'a', vertices: 'i',
    signature: "p=(c=0,e=0,t=0)=>({x:c,y:e,z:t}),z=c=>({...c}),E=(c,e)=>p(c.x+e.x,c.y+e.y,c.z+e.z),C=(c,e)=>p(c.x-e.x,c.y-e.y,c.z-e.z),P=(c,e)=>p(c.x*e,c.y*e,c.z*e),T=(c,e)=>c.x*e.x+c.y*e.y+c.z*e." +
      "z,K=(c,e)=>p(c.y*e.z-c.z*e.y,c.z*e.x-c.x*e.z,c.x*e.y-c.y*e.x),$=c=>Math.hypot(c.x,c.y,c.z),V=c=>Math.hypot(c.x,c.y),q=c=>{const e=$(c);return e>1e-12?P(c,1/e):p()},Fe=(c,e,t)=>E(c," +
      "P(C(e,c),t)),N=(c,e,t)=>Math.max(e,Math.min(t,c)),He=c=>p(Math.fround(c.x),Math.fround(c.y),Math.fround(c.z)),X=[\"x\",\"y\",\"z\"],ne=(c,e)=>X.every(t=>c.min[t]<=e.max[t]&&c.max[t]>=e.m" +
      "in[t]);class Me{constructor(e,t=12){this.bounds=e;const a=i=>{const s={x:1/0,y:1/0,z:1/0},r={x:-1/0,y:-1/0,z:-1/0};for(const n of i)for(const f of X)s[f]=Math.min(s[f],e[n].min[f])" +
      ",r[f]=Math.max(r[f],e[n].max[f]);if(i.length<=t)return{min:s,max:r,items:i};const o=X.reduce((n,f)=>r[f]-s[f]>r[n]-s[n]?f:n);i.sort((n,f)=>e[n].min[o]+e[n].max[o]-(e[f].min[o]+e[f]" +
      ".max[o])||n-f);const d=i.length>>1;return{min:s,max:r,left:a(i.slice(0,d)),right:a(i.slice(d))}};this.root=e.length?a(e.map((i,s)=>s)):null}bounds;root;query(e){const t=[],a=i=>{if" +
      "(ne(i,e))if(i.items)for(const s of i.items)ne(this.bounds[s],e)&&t.push(s);else a(i.left),a(i.right)};return this.root&&a(this.root),t.sort((i,s)=>i-s)}}const F=.03125,D=[\"x\",\"y\",\"" +
      "z\"];class Pe{constructor(e,t=[],a=!1,i=!1){this.brushes=e,this.triangles=t,this.vphysicsFeatureFix=a,this.bspCornerFix=i,this.triangleBounds=t.map(s=>({min:p(...D.map(r=>Math.min(." +
      "..s.vertices.map(o=>o[r])))),max:p(...D.map(r=>Math.max(...s.vertices.map(o=>o[r]))))})),this.tree=new Me([...e,...this.triangleBounds])}brushes;triangles;vphysicsFeatureFix;bspCor" +
      "nerFix;tree;triangleBounds;triangleCache=new Map;triangleBrush(e){const t=this.triangleCache.get(e);if(t)return t;const a=this.triangles[e],i=a.vertices,s=[p(1,0,0),p(0,1,0),p(0,0," +
      "1)],o=[q(K(C(i[1],i[0]),C(i[2],i[0]))),...s];for(let f=0;f<3;f++)for(const b of s)o.push(K(C(i[(f+1)%3],i[f]),b));const d=[];for(const f of o)if(!($(f)<1e-8))for(const b of[1,-1]){" +
      "const l=P(q(f),b);d.some(u=>T(u.normal,l)>1-1e-9)||d.push({normal:l,distance:Math.max(...i.map(u=>T(l,u)))})}const n={id:`disp-${a.surfaceId}-${a.triangleId}`,vertices:i,faces:[[0," +
      "1,2]],planes:d,...this.triangleBounds[e],color:\"#d4dadd\",friction:1,kind:\"snow\"};return this.triangleCache.set(e,n),n}trace(e,t,a){const i={fraction:1,end:{...t},normal:p(),startSo" +
      "lid:!1,allSolid:!1,brush:null},s={min:p(),max:p()};for(const r of D)s.min[r]=Math.min(e[r],t[r])+a.min[r]-F,s.max[r]=Math.max(e[r],t[r])+a.max[r]+F;for(const r of this.tree.query(s" +
      ")){const o=r<this.brushes.length?this.brushes[r]:this.triangleBrush(r-this.brushes.length);if(D.some(g=>Math.max(e[g],t[g])+a.max[g]<o.min[g]-F||Math.min(e[g],t[g])+a.min[g]>o.max[" +
      "g]+F)||o.leafBounds&&!o.leafBounds.some(g=>D.every(k=>s.max[k]>=g.min[k]&&s.min[k]<=g.max[k])))continue;let d=-1,n=1,f=p(),b=!1,l=!1,u=!1,h,m=-1/0,y=1/0,S=-1,v=p();const w=this.bsp" +
      "CornerFix&&!o.collisionModel&&o.planes.length===6&&o.planes.every(g=>D.filter(k=>g.normal[k]!==0).length===1&&D.some(k=>Math.abs(g.normal[k])===1));for(const g of o.planes){const k" +
      "=g.normal,_=k.x*(k.x<0?a.max.x:a.min.x)+k.y*(k.y<0?a.max.y:a.min.y)+k.z*(k.z<0?a.max.z:a.min.z),A=g.distance-_,I=T(e,k)-A,B=T(t,k)-A;if(o.collisionModel===\"vphysics\"||w)if(I>B){con" +
      "st H=I/(I-B);H>m&&(m=H,S=Math.max(0,(I-F)/(I-B)),v=k)}else I<B&&(y=Math.min(y,I/(I-B)));if(I>0&&(b=!0),B>0&&(l=!0),I>0&&B>0&&(!o.collisionModel||B>=I-1e-5)){u=!0;break}if(!(I<=0&&B" +
      "<=0))if(I>B){const H=Math.max(0,(I-F)/(I-B));H>d&&(d=H,f=k,h=g.friction)}else n=Math.min(n,(I+F)/(I-B))}if(!(u||y<1&&m>y)){if(this.vphysicsFeatureFix&&o.collisionModel===\"vphysics\"" +
      "&&(d=S,f=v),!b){if(i.startSolid=!0,!l)return i.allSolid=!0,i.fraction=0,i.end={...e},i.brush=o,i;continue}d<n&&d>-1&&d<i.fraction&&(i.fraction=Math.max(0,d),i.normal={...f},i.brush" +
      "=o,h!==void 0?i.friction=h:delete i.friction)}}return i.end=Fe(e,t,i.fraction),i}}"},
  {name: 'ft', index: 't', cached: 'e', triangle: 'i', vertices: 'n',
    signature: "p=(a=0,t=0,e=0)=>({x:a,y:t,z:e}),S=a=>({...a}),C=(a,t)=>p(a.x+t.x,a.y+t.y,a.z+t.z),j=(a,t)=>p(a.x-t.x,a.y-t.y,a.z-t.z),G=(a,t)=>p(a.x*t,a.y*t,a.z*t),P=(a,t)=>a.x*t.x+a.y*t.y+a.z*t." +
      "z,U=(a,t)=>p(a.y*t.z-a.z*t.y,a.z*t.x-a.x*t.z,a.x*t.y-a.y*t.x),O=a=>Math.hypot(a.x,a.y,a.z),E=a=>Math.hypot(a.x,a.y),q=a=>{const t=O(a);return t>1e-12?G(a,1/t):p()},ht=(a,t,e)=>C(a," +
      "G(j(t,a),e)),N=(a,t,e)=>Math.max(t,Math.min(e,a)),dt=a=>p(Math.fround(a.x),Math.fround(a.y),Math.fround(a.z)),K=[\"x\",\"y\",\"z\"],tt=(a,t)=>K.every(e=>a.min[e]<=t.max[e]&&a.max[e]>=t.m" +
      "in[e]);class ut{constructor(t,e=12){this.bounds=t;const i=n=>{const s={x:1/0,y:1/0,z:1/0},o={x:-1/0,y:-1/0,z:-1/0};for(const h of n)for(const d of K)s[d]=Math.min(s[d],t[h].min[d])" +
      ",o[d]=Math.max(o[d],t[h].max[d]);if(n.length<=e)return{min:s,max:o,items:n};const r=K.reduce((h,d)=>o[d]-s[d]>o[h]-s[h]?d:h);n.sort((h,d)=>t[h].min[r]+t[h].max[r]-(t[d].min[r]+t[d]" +
      ".max[r])||h-d);const c=n.length>>1;return{min:s,max:o,left:i(n.slice(0,c)),right:i(n.slice(c))}};this.root=t.length?i(t.map((n,s)=>s)):null}bounds;root;query(t){const e=[],i=n=>{if" +
      "(tt(n,t))if(n.items)for(const s of n.items)tt(this.bounds[s],t)&&e.push(s);else i(n.left),i(n.right)};return this.root&&i(this.root),e.sort((n,s)=>n-s)}}const J=.03125,D=[\"x\",\"y\",\"" +
      "z\"];class ft{constructor(t,e=[],i=!1,n=!1){this.brushes=t,this.triangles=e,this.vphysicsFeatureFix=i,this.bspCornerFix=n,this.triangleBounds=e.map(s=>({min:p(...D.map(o=>Math.min(." +
      "..s.vertices.map(r=>r[o])))),max:p(...D.map(o=>Math.max(...s.vertices.map(r=>r[o]))))})),this.tree=new ut([...t,...this.triangleBounds])}brushes;triangles;vphysicsFeatureFix;bspCor" +
      "nerFix;tree;triangleBounds;triangleCache=new Map;triangleBrush(t){const e=this.triangleCache.get(t);if(e)return e;const i=this.triangles[t],n=i.vertices,s=[p(1,0,0),p(0,1,0),p(0,0," +
      "1)],r=[q(U(j(n[1],n[0]),j(n[2],n[0]))),...s];for(let d=0;d<3;d++)for(const l of s)r.push(U(j(n[(d+1)%3],n[d]),l));const c=[];for(const d of r)if(!(O(d)<1e-8))for(const l of[1,-1]){" +
      "const u=G(q(d),l);c.some(f=>P(f.normal,u)>1-1e-9)||c.push({normal:u,distance:Math.max(...n.map(f=>P(u,f)))})}const h={id:`disp-${i.surfaceId}-${i.triangleId}`,vertices:n,faces:[[0," +
      "1,2]],planes:c,...this.triangleBounds[t],color:\"#d4dadd\",friction:1,kind:\"snow\"};return this.triangleCache.set(t,h),h}trace(t,e,i){const n={fraction:1,end:{...e},normal:p(),startSo" +
      "lid:!1,allSolid:!1,brush:null},s={min:p(),max:p()};for(const o of D)s.min[o]=Math.min(t[o],e[o])+i.min[o]-J,s.max[o]=Math.max(t[o],e[o])+i.max[o]+J;for(const o of this.tree.query(s" +
      ")){const r=o<this.brushes.length?this.brushes[o]:this.triangleBrush(o-this.brushes.length);if(D.some(y=>Math.max(t[y],e[y])+i.max[y]<r.min[y]-J||Math.min(t[y],e[y])+i.min[y]>r.max[" +
      "y]+J)||r.leafBounds&&!r.leafBounds.some(y=>D.every(w=>s.max[w]>=y.min[w]&&s.min[w]<=y.max[w])))continue;let c=-1,h=1,d=p(),l=!1,u=!1,f=!1,g,m=-1/0,v=1/0,z=-1,x=p();const M=this.bsp" +
      "CornerFix&&!r.collisionModel&&r.planes.length===6&&r.planes.every(y=>D.filter(w=>y.normal[w]!==0).length===1&&D.some(w=>Math.abs(y.normal[w])===1));for(const y of r.planes){const w" +
      "=y.normal,R=w.x*(w.x<0?i.max.x:i.min.x)+w.y*(w.y<0?i.max.y:i.min.y)+w.z*(w.z<0?i.max.z:i.min.z),T=y.distance-R,F=P(t,w)-T,b=P(e,w)-T;if(r.collisionModel===\"vphysics\"||M)if(F>b){con" +
      "st I=F/(F-b);I>m&&(m=I,z=Math.max(0,(F-J)/(F-b)),x=w)}else F<b&&(v=Math.min(v,F/(F-b)));if(F>0&&(l=!0),b>0&&(u=!0),F>0&&b>0&&(!r.collisionModel||b>=F-1e-5)){f=!0;break}if(!(F<=0&&b" +
      "<=0))if(F>b){const I=Math.max(0,(F-J)/(F-b));I>c&&(c=I,d=w,g=y.friction)}else h=Math.min(h,(F+J)/(F-b))}if(!(f||v<1&&m>v)){if(this.vphysicsFeatureFix&&r.collisionModel===\"vphysics\"" +
      "&&(c=z,d=x),!l){if(n.startSolid=!0,!u)return n.allSolid=!0,n.fraction=0,n.end={...t},n.brush=r,n;continue}c<h&&c>-1&&c<n.fraction&&(n.fraction=Math.max(0,c),n.normal={...d},n.brush" +
      "=r,g!==void 0?n.friction=g:delete n.friction)}}return n.end=ht(t,e,n.fraction),n}}"},
];
