import {describe, expect, test} from 'bun:test';
import {createReplayIndexJobs, createReplayIndexWorker} from '../extension/replay-index-worker.js';
import {instrumentGame, instrumentPhysicsWorker} from '../extension/instrument.js';
import {packCollisionWorld, unpackCollisionWorld} from '../extension/collision-world.js';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return {promise, resolve}; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const protocol = data => ({__surfdQolIndex: 1, ...data});
const replayFor = (map, version = map.version) => ({mapId: map.id, mapVersion: version, commands: []});
class WorkerStub {
  posts = []; terminated = 0;
  postMessage(message, transfer) { this.posts.push({message, transfer}); }
  terminate() { this.terminated++; }
  receive(data) { this.onmessage?.({data}); }
  ready(camera = false) { this.receive(protocol({type: 'ready', camera})); }
  world(lease, replay) { this.receive(protocol({type: 'world', job: lease.id, mapId: replay.mapId, mapVersion: replay.mapVersion})); }
  batch(lease, batch = {done: false}) { this.receive(protocol({type: 'batch', job: lease.id, ok: true, batch})); }
  runs() { return this.posts.filter(post => post.message.type === 'run'); }
}

for (const [kind, makeJobs, makeWorker] of [
  ['module', createReplayIndexJobs, createReplayIndexWorker],
  ['injected source', Function(`return (${createReplayIndexJobs.toString()})`)(), Function(`return (${createReplayIndexWorker.toString()})`)()],
]) describe(`replay job ownership: ${kind}`, () => {
  function fixture(prepare = async () => null) {
    const jobs = makeJobs(prepare), workers = [], map = {id: 'map', version: 'v1'}, session = {map};
    const create = () => { const worker = new WorkerStub(); workers.push(worker); return worker; };
    const acquire = (replay = replayFor(map)) => jobs.acquire(map, replay, session, create);
    return {jobs, workers, map, session, acquire};
  }
  test('every replay job prepares and transfers fresh geometry; completion destroys unowned workers', async () => {
    let preparations = 0;
    const f = fixture(async () => { preparations++; const vertices = new Float64Array([1, 2, 3]); return {vertices, alias: vertices.subarray(1)}; });
    for (let i = 0; i < 2; i++) {
      const replay = replayFor(f.map), lease = f.acquire(replay), worker = f.workers[i];
      lease.postMessage({replay}); worker.ready(); await flush();
      const [{message, transfer}] = worker.runs();
      expect(transfer).toEqual([message.__surfdQolCollision.vertices.buffer]);
      worker.world(lease, replay); lease.onmessage = () => lease.terminate(); worker.batch(lease, {done: true});
      expect(worker.terminated).toBe(1);
    }
    expect(preparations).toBe(2);
    expect(f.workers).toHaveLength(2);
  });
  test('an active cinema view releases recordings while its completed world remains renderer-owned', async () => {
    const f = fixture(), replay = replayFor(f.map), lease = f.acquire(replay), worker = f.workers[0];
    const camera = f.jobs.camera(f.session);
    lease.postMessage({replay}); worker.ready(true); await flush(); worker.world(lease, replay);
    expect(worker.posts.some(({message}) => message.type === 'camera-retain' && message.id === lease.id)).toBe(true);
    worker.batch(lease, {done: true}); lease.terminate();
    expect(worker.terminated).toBe(0); expect(camera.live).toBe(true);
    camera.release(); expect(worker.terminated).toBe(0); expect(camera.live).toBe(true);
    expect(f.jobs.camera(f.session)).toBe(camera);
    f.jobs.ownRenderer({dispose() {}}); expect(worker.terminated).toBe(1); expect(camera.live).toBe(false);
  });
  test('releasing a view during indexing keeps the completed world available for late camera', async () => {
    const f = fixture(), replay = replayFor(f.map), lease = f.acquire(replay), worker = f.workers[0];
    const camera = f.jobs.camera(f.session);
    lease.postMessage({replay}); worker.ready(true); await flush(); worker.world(lease, replay);
    camera.release(); expect(worker.terminated).toBe(0);
    worker.batch(lease, {done: true}); lease.terminate(); expect(worker.terminated).toBe(0);
    expect(f.jobs.camera(f.session)).toBe(camera);
    f.jobs.ownRenderer({dispose() {}}); expect(worker.terminated).toBe(1);
  });
  test('replacement cancels preparation and stale callbacks cannot affect the new job', async () => {
    const preparation = deferred(); let current;
    const f = fixture((map, session, message, isCurrent) => { current = isCurrent; return preparation.promise; });
    const first = f.acquire(), old = f.workers[0]; first.postMessage({replay: replayFor(f.map)}); old.ready();
    expect(current()).toBe(true);
    const stale = old.onmessage, second = f.acquire(), next = f.workers[1], batches = [];
    second.onmessage = event => batches.push(event.data.batch);
    expect(current()).toBe(false); expect(first.closed).toBe(true); expect(old.terminated).toBe(1);
    preparation.resolve(null); await flush(); expect(old.runs()).toHaveLength(0);
    stale({data: protocol({type: 'batch', job: first.id, ok: false})});
    second.postMessage({replay: replayFor(f.map)}); next.ready(); await flush();
    next.batch(second, {done: false}); expect(batches).toEqual([{done: false}]);
  });
  test('renderer scopes and archived revisions never share jobs', () => {
    const f = fixture(), oldRenderer = {dispose() {}}, renderer = {dispose() {}};
    f.jobs.ownRenderer(oldRenderer); const first = f.acquire();
    f.jobs.ownRenderer(renderer); expect(first.closed).toBe(true);
    const archived = f.acquire(replayFor(f.map, 'archive'));
    oldRenderer.dispose(); expect(f.workers[1].terminated).toBe(0);
    renderer.dispose(); expect(archived.closed).toBe(true); expect(f.workers[1].terminated).toBe(1);
  });
  test('clone errors retry native geometry, and worker/protocol failures notify fallback once', async () => {
    const f = fixture(async () => ({vertices: new Float64Array(1)}));
    const lease = f.acquire(), worker = f.workers[0], posts = [];
    worker.postMessage = message => { if (message.__surfdQolCollision) throw Error('clone'); posts.push(message); };
    lease.postMessage({replay: replayFor(f.map)}); worker.ready(); await flush();
    expect(posts.filter(message => message.type === 'run')).toHaveLength(1);
    expect(posts.find(message => message.type === 'run').__surfdQolCollision).toBeUndefined();
    for (const mode of ['worker', 'message', 'protocol', 'world', 'batch']) {
      const f = fixture(), lease = f.acquire(), worker = f.workers[0], events = [];
      lease.onclose = () => events.push('close'); lease.onerror = () => events.push('fallback');
      lease.postMessage({replay: replayFor(f.map)}); worker.ready(); await flush();
      if (mode === 'worker') worker.onerror({preventDefault() {}});
      else if (mode === 'message') worker.onmessageerror();
      else if (mode === 'protocol') worker.receive({ok: false});
      else if (mode === 'world') worker.world(lease, replayFor(f.map, 'wrong'));
      else worker.receive(protocol({type: 'batch', job: lease.id, ok: false}));
      expect(events).toEqual(['close', 'fallback']); expect(worker.terminated).toBe(1);
    }
  });
  test('opening cinema after indexing reuses its world without repacking or a view-only job', async () => {
    const f = fixture(), replay = replayFor(f.map), first = f.acquire(replay), old = f.workers[0];
    first.postMessage({replay}); old.ready(true); await flush(); old.world(first, replay);
    old.batch(first, {done: true}); first.terminate(); expect(old.terminated).toBe(0);
    const camera = f.jobs.camera(f.session, replay, {id: f.map.id, slug: 'map'});
    expect(f.workers).toHaveLength(1); expect(old.runs()).toHaveLength(1);
    expect(camera.live).toBe(true);
    camera.release(); expect(old.terminated).toBe(0);
    f.jobs.ownRenderer({dispose() {}}); expect(old.terminated).toBe(1);
  });
  test('completed same-revision jobs reuse a worker and skip collision packet preparation', async () => {
    let preparations = 0;
    const f = fixture(async () => { preparations++; return null; });
    const renderer = {dispose() {}};
    f.jobs.ownRenderer(renderer);
    const replay = replayFor(f.map), first = f.acquire(replay), worker = f.workers[0];
    first.postMessage({replay}); worker.ready(true); await flush(); worker.world(first, replay);
    worker.batch(first, {done: true}); first.terminate();
    const secondReplay = replayFor(f.map), second = f.acquire(secondReplay);
    second.postMessage({replay: secondReplay}); await flush();
    expect(f.workers).toHaveLength(1); expect(preparations).toBe(1);
    expect(worker.runs()).toHaveLength(2);
    expect(worker.runs()[1].message.__surfdQolCollision).toBeUndefined();
    expect(second.id).not.toBe(first.id);
    renderer.dispose(); expect(worker.terminated).toBe(1);
  });
  test('handleless camera plans select the primary world even when an added recording starts first', async () => {
    const f = fixture(), watched = replayFor(f.map), added = replayFor(f.map), lease = f.acquire(watched), worker = f.workers[0];
    const camera = f.jobs.camera(f.session), abort = new AbortController();
    const recording = camera.record({replay: added, signal: abort.signal});
    const pending = [recording];
    try {
      lease.postMessage({replay: watched});
      worker.ready(true); await flush(); worker.world(lease, watched); await flush();
      const record = worker.posts.find(({message}) => message.type === 'record').message;
      expect(record.id).not.toBe(lease.id);
      const track = {_cinemaWorker: camera, _cinemaHandle: {id: record.id, from: 0}, count: 2};
      pending.push(camera.plan({a: {count: 2}}, abort.signal));
      pending.push(camera.plan({a: track}, abort.signal));
      pending.push(camera.plan({a: track}, abort.signal, lease.id));
      await flush();
      const plans = worker.posts.filter(({message}) => message.type === 'camera-plan').map(({message}) => message);
      expect(plans.map(message => message.world)).toEqual([lease.id, record.id, lease.id]);
      camera.release(record.id);
      pending.push(camera.plan({a: {count: 2}}, abort.signal));
      await flush();
      expect(worker.posts.filter(({message}) => message.type === 'camera-plan').at(-1).message.world).toBe(lease.id);
    } finally {
      abort.abort();
      await Promise.all(pending);
      camera.release();
      lease.terminate(true);
    }
  });
  test('worker recording eviction invalidates replay identity without losing the retained world', async () => {
    const f = fixture(), replay = replayFor(f.map), lease = f.acquire(replay), worker = f.workers[0];
    const camera = f.jobs.camera(f.session);
    lease.postMessage({replay}); worker.ready(true); await flush(); worker.world(lease, replay);
    const abort = new AbortController();
    const first = camera.record({replay, signal: abort.signal}); await flush();
    worker.receive(protocol({type: 'camera-forget', id: lease.id}));
    const second = camera.record({replay, signal: abort.signal}); await flush();
    const records = worker.posts.filter(({message}) => message.type === 'record');
    expect(records[0].message.id).toBe(lease.id); expect(records[1].message.id).not.toBe(lease.id);
    abort.abort(); expect(await Promise.all([first, second])).toEqual([null, null]);
    lease.terminate(); expect(worker.terminated).toBe(0);
    f.jobs.ownRenderer({dispose() {}}); expect(worker.terminated).toBe(1);
  });
  test('camera can initialize a view-only worker when no index job exists', async () => {
    const workers = [], map = {id: 'map', version: 'v1'}, session = {map}, replay = replayFor(map);
    const jobs = makeJobs(async () => null, () => { const worker = new WorkerStub(); workers.push(worker); return worker; });
    const renderer = {dispose() {}};
    jobs.ownRenderer(renderer);
    const camera = jobs.camera(session, replay, {id: map.id, slug: 'map'}), worker = workers[0];
    worker.ready(true); await flush();
    const run = worker.runs()[0].message;
    expect(run.__surfdQolViewOnly).toBe(true);
    worker.receive(protocol({type: 'world', job: run.job, mapId: map.id, mapVersion: map.version}));
    camera.release(); expect(worker.terminated).toBe(0);
    renderer.dispose(); expect(worker.terminated).toBe(1);
  });
  test('view-only worker construction or handshake-post failure leaves cinema able to use native fallback', () => {
    for (const mode of ['construct', 'post']) {
      const map = {id: 'map', version: 'v1'}, session = {map};
      const worker = new WorkerStub();
      const jobs = makeJobs(async () => null, () => {
        if (mode === 'construct') throw new Error('Worker blocked');
        worker.postMessage = () => { throw new Error('Post blocked'); };
        return worker;
      });
      expect(jobs.camera(session, replayFor(map))).toBeNull();
      if (mode === 'post') expect(worker.terminated).toBe(1);
    }
  });
  test('silent view-only startup expires at either handshake stage and settles recordings', async () => {
    for (const ready of [false, true]) {
      const timers = new Map();
      const timedJobs = Function('setTimeout', 'clearTimeout', `return (${makeJobs.toString()})`)(
        callback => { const id = Symbol(); timers.set(id, callback); return id; }, id => timers.delete(id));
      const map = {id: 'map', version: 'v1'}, session = {map}, replay = replayFor(map), worker = new WorkerStub();
      const jobs = timedJobs(async () => null, () => worker), camera = jobs.camera(session, replay);
      const recording = camera.record({replay});
      if (ready) worker.ready(true);
      await flush();
      expect(timers.size).toBe(1);
      [...timers.values()][0]();
      expect(await recording).toBeNull();
      expect(camera.live).toBe(false);
      expect(worker.terminated).toBe(1);
      expect(timers.size).toBe(0);
    }
  });
  test('closing view-only cinema cancels unfinished packing and ignores its eventual packet', async () => {
    const prepared = deferred(), map = {id: 'map', version: 'v1'}, session = {map}, replay = replayFor(map), worker = new WorkerStub();
    let current;
    const jobs = makeJobs((map, session, message, isCurrent) => { current = isCurrent; return prepared.promise; }, () => worker);
    const camera = jobs.camera(session, replay), recording = camera.record({replay});
    worker.ready(true);
    camera.release();
    expect(current()).toBe(false);
    expect(await recording).toBeNull();
    prepared.resolve({vertices: new Float64Array(3)});
    await flush();
    expect(worker.runs()).toEqual([]);
    expect(worker.terminated).toBe(1);
  });
  test('native index cancellation preserves explicit camera ownership and pending recordings', async () => {
    for (const subscribed of [false, true]) {
      const f = fixture(), replay = replayFor(f.map), lease = f.acquire(replay), worker = f.workers[0];
      const camera = f.jobs.camera(f.session);
      lease.postMessage({replay}); worker.ready(true); await flush(); worker.world(lease, replay);
      const abort = new AbortController();
      let recording;
      if (subscribed) {
        camera.release();
        recording = camera.record({replay, signal: abort.signal});
        await flush();
      }
      lease.terminate();
      expect(worker.terminated).toBe(0); expect(camera.live).toBe(true);
      expect(worker.posts.some(({message}) => message.type === 'cancel' && message.job === lease.id)).toBe(true);
      if (subscribed) {
        abort.abort();
        expect(await recording).toBeNull();
      }
      camera.release();
      f.jobs.ownRenderer({dispose() {}}); expect(worker.terminated).toBe(1);
    }
  });

  test('camera recordings reuse replay identity and individual release leaves the view live', async () => {
    const f = fixture(), replay = replayFor(f.map), lease = f.acquire(replay), worker = f.workers[0];
    const camera = f.jobs.camera(f.session);
    lease.postMessage({replay}); worker.ready(true); await flush(); worker.world(lease, replay);
    const aborts = [new AbortController(), new AbortController()];
    const records = aborts.map(({signal}) => camera.record({replay, signal})); await flush();
    const messages = worker.posts.filter(({message}) => message.type === 'record').map(({message}) => message);
    expect(messages).toHaveLength(2); expect(messages[0].id).toBe(lease.id); expect(messages[1].id).toBe(lease.id);
    camera.release(messages[1].id); expect(camera.live).toBe(true);
    aborts.forEach(abort => abort.abort()); expect(await Promise.all(records)).toEqual([null, null]);
    camera.release(); lease.terminate();
  });
  test('worker yields between chunks and only the newest pending job runs', async () => {
    const posts = [], pauses = [], starts = [];
    const receive = makeWorker(data => posts.push(data), async (message, job) => {
      starts.push(message.job); job.world({id: 'map', version: 'v1'});
      for (let chunk = 0; chunk < 3; chunk++) {
        if (!job.current()) return;
        job.emit({ok: true, batch: {chunk, done: chunk === 2}});
        if (chunk < 2) await job.pause();
      }
    }, () => { const pause = deferred(); pauses.push(pause); return pause.promise; });
    receive(protocol({type: 'hello'})); expect(posts).toEqual([protocol({type: 'ready'})]);
    receive(protocol({type: 'run', job: 1})); receive(protocol({type: 'cancel', job: 1}));
    receive(protocol({type: 'run', job: 2})); receive(protocol({type: 'run', job: 3}));
    pauses[0].resolve(); await flush(); expect(starts).toEqual([1, 3]);
    pauses[1].resolve(); await flush(); pauses[2].resolve(); await flush();
    expect(posts.filter(post => post.job === 1 && post.type === 'batch').map(post => post.batch.chunk)).toEqual([0]);
    expect(posts.filter(post => post.job === 3 && post.type === 'batch').map(post => post.batch.chunk)).toEqual([0, 1, 2]);
  });
  test('cancelled asynchronous loads emit neither stale worlds nor errors', async () => {
    const load = deferred(), posts = [];
    const receive = makeWorker(data => posts.push(data), async (message, job) => {
      await load.promise; job.world({id: 'map', version: 'v1'}); throw Error('obsolete');
    });
    receive(protocol({type: 'run', job: 1})); receive(protocol({type: 'cancel', job: 1}));
    load.resolve(); await flush(); expect(posts).toEqual([]);
    receive({entry: {id: 'map'}}); expect(posts[0].ok).toBe(false);
  });
});

// The supported native worker's actual vector, BVH, axis and world contracts.
const nativeCollisionFixture = "m=(o=0,e=0,t=0)=>({x:o,y:e,z:t}),x=o=>({...o}),w=(o,e)=>m(o.x+e.x,o.y+e.y,o.z+e.z),P=(o,e)=>m(o.x-e.x,o.y-e.y,o.z-e.z),E=(o,e)=>m(o.x*e,o.y*e,o.z*e),S=(o,e)=>o.x*e.x+o.y*e.y+o.z*e.z,W=(o,e)" +
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
  "g!==void 0?s.friction=g:delete s.friction)}}return s.end=be(e,t,s.fraction),s}}";

const nativeWorker = `(()=>{
"use strict";
let loads=0;const simulations=[],worlds=new WeakMap,geometry={id:"map",version:"v1",brushes:[],displacementTriangles:[]};
const ${nativeCollisionFixture}
function worldFor(o,e){const t=e>=7,a=e>=8,s=\`\${t}/\${a}\`;let i=worlds.get(o.brushes);i||(i=new Map,worlds.set(o.brushes,i));let c=i.get(s);return c||(c=new ke(o.brushes,o.displacementTriangles,t,a),i.set(s,c)),c}
async function loadCurrent(entry){loads++;return geometry}
async function loadArchive(entry,version){loads++;return {...geometry,version,brushes:[]}}
class Index{constructor(map,replay){this.map=map,this.replay=replay;this.world=worldFor(map,replay.format);if(replay.failInit)throw Error("initialization failed");this.position=0;simulations.push(this)}run(alive){if(alive())this.position++;return {from:this.position,elapsed:new Float64Array([this.position]),phases:new Uint8Array([0]),markers:[],keyframes:[],finish:null,done:this.position>=this.replay.commands.length}}}
const q=self,Me=120;q.onmessage=o=>{process(o.data)};
async function process(o){try{const{entry:e,currentVersion:t,replay:a}=o;if(!a||a.mapId!==e.id)throw Error("wrong map");let s=null;a.mapVersion===t&&(s=await loadCurrent(e),s.version!==a.mapVersion&&(s=null)),s??=await loadArchive(e,a.mapVersion);const i=new Index(s,a);for(;;){const c=performance.now()+Me,r=i.run(()=>performance.now()<c);if(q.postMessage({ok:!0,batch:r},{transfer:[r.elapsed.buffer,r.phases.buffer]}),r.done)return}}catch(e){q.postMessage({ok:!1,error:e instanceof Error?e.message:String(e)})}}
self.probe={simulations,loads:()=>loads,builds:()=>new Set(simulations.filter(sim=>sim.world.tree instanceof ve).map(sim=>sim.world)).size};
})();`;
function workerFixture(native = nativeWorker, clock = performance, runtime = '') {
  const posts = [], scheduled = [], self = {postMessage: data => posts.push(data)};
  new Function('self', 'setTimeout', 'performance', instrumentPhysicsWorker(native, runtime))(self, callback => scheduled.push(callback), clock);
  return {posts, scheduled, probe: self.probe, send: data => self.onmessage({data: protocol(data)}),
    async resume() { scheduled.shift()(); await flush(); }};
}
test('native jobs reuse map/world variants while respecting revisions and collision flags', async () => {
  const f = workerFixture(), replay = {mapId: 'map', mapVersion: 'v1', format: 8, commands: [{}]};
  for (const [job, format] of [[1, 8], [2, 8], [3, 6]]) { f.send({type: 'run', job, entry: {id: 'map'}, currentVersion: 'v1', replay: {...replay, format}}); await flush(); }
  expect(f.probe.loads()).toBe(1); expect(f.probe.builds()).toBe(2);
  const [first, second, legacy] = f.probe.simulations;
  expect(first.world).toBe(second.world); expect(first.world.vphysicsFeatureFix).toBe(true);
  expect(legacy.world.vphysicsFeatureFix).toBe(false); expect(legacy.world.bspCornerFix).toBe(false);
  f.send({type: 'run', job: 4, entry: {id: 'map'}, currentVersion: 'v1', replay: {...replay, mapVersion: 'archive'}}); await flush();
  expect(f.probe.simulations.at(-1).map.version).toBe('archive');
});
test('the first exact prefix is published promptly without shortening later throughput chunks', async () => {
  let now = 0;
  const source = nativeWorker.replace('if(alive())this.position++', 'while(this.position<this.replay.commands.length&&alive())this.position++');
  const f = workerFixture(source, {now: () => now++});
  const replay = {mapId: 'map', mapVersion: 'v1', format: 8, commands: Array.from({length: 80}, () => ({}))};
  f.send({type: 'run', job: 1, entry: {id: 'map'}, currentVersion: 'v1', replay}); await flush();
  const first = f.posts.find(post => post.type === 'batch').batch;
  expect(first.done).toBe(false); expect(first.from).toBeGreaterThan(0); expect(first.from).toBeLessThan(20);
  await f.resume();
  expect(f.posts.filter(post => post.type === 'batch').map(post => post.batch.done)).toEqual([false, true]);
});

test('packed jobs bypass native geometry and collision-tree construction', async () => {
  const map = {id: 'map', version: 'v1', brushes: [], displacementTriangles: []};
  const packet = await packCollisionWorld(map, {brushes: map.brushes, triangles: map.displacementTriangles, triangleBounds: [], tree: {bounds: [], root: null}});
  const f = workerFixture(), replay = {...replayFor(map), format: 8, commands: [{}]};
  f.send({type: 'run', job: 1, entry: {id: 'map'}, currentVersion: 'v1', replay, __surfdQolCollision: packet}); await flush();
  expect(f.probe.loads()).toBe(0); expect(f.probe.builds()).toBe(0);
  expect(f.probe.simulations[0].world.tree.query({min: {}, max: {}})).toEqual([]);
  expect(f.posts.some(post => post.type === 'batch' && post.batch.done)).toBe(true);
});
test('prepared worlds memoize exact scalar triangle SAT brushes on native world ownership', async () => {
  const triangle = {surfaceId: 3, triangleId: 4, vertices: [
    {x: 0, y: 0, z: 0}, {x: 16, y: 0, z: 0}, {x: 0, y: 16, z: 0},
  ]};
  const bounds = {min: {x: 0, y: 0, z: 0}, max: {x: 16, y: 16, z: 0}};
  const map = {id: 'map', version: 'v1', brushes: [], displacementTriangles: [triangle]};
  const packet = await packCollisionWorld(map, {brushes: map.brushes, triangles: map.displacementTriangles,
    triangleBounds: [bounds], tree: {bounds: [bounds], root: {...bounds, items: [0]}}});
  const f = workerFixture(), replay = {...replayFor(map), format: 8, commands: [{}]};
  f.send({type: 'run', job: 1, entry: {id: map.id}, currentVersion: map.version, replay, __surfdQolCollision: packet});
  await flush();
  const world = f.probe.simulations[0].world, first = world.triangleBrush(0), second = world.triangleBrush(0);
  expect(first).toBe(second); expect(world.triangleCache.get(0)).toBe(first);
  expect(first.id).toBe('disp-3-4'); expect(first.planes.length).toBeGreaterThan(0);
  expect(f.probe.builds()).toBe(0);
});
test('unknown constructor state and private initializers use native loading and construction', async () => {
  const map = {id: 'map', version: 'v1', brushes: [], displacementTriangles: []};
  const packet = await packCollisionWorld(map, {brushes: map.brushes, triangles: map.displacementTriangles,
    triangleBounds: [], tree: {bounds: [], root: null}});
  const replay = {...replayFor(map), format: 8, commands: [{}]};
  const variants = [
    [nativeWorker.replace('this.bspCornerFix=s,this.triangleBounds=', 'this.bspCornerFix=s,this.mask=37,this.triangleBounds='), world => world.mask],
    [nativeWorker.replace('triangleCache=new Map;triangleBrush', 'mask=38;triangleCache=new Map;triangleBrush'), world => world.mask],
    [nativeWorker.replace('triangleCache=new Map;triangleBrush', '#mask=39;readMask(){return this.#mask}triangleCache=new Map;triangleBrush'), world => world.readMask()],
  ];
  for (const [index, [source, readMask]] of variants.entries()) {
    const f = workerFixture(source);
    f.send({type: 'run', job: 1, entry: {id: map.id}, currentVersion: map.version, replay, __surfdQolCollision: packet});
    await flush();
    expect(f.probe.loads()).toBe(1);
    expect(f.probe.builds()).toBe(1);
    expect(readMask(f.probe.simulations[0].world)).toBe(37 + index);
    expect(f.posts.some(post => post.type === 'batch' && post.batch.done)).toBe(true);
  }
});

test('an altered cached triangle method remains native even with a valid packet', async () => {
  const map = {id: 'map', version: 'v1', brushes: [], displacementTriangles: []};
  const packet = await packCollisionWorld(map, {brushes: map.brushes, triangles: map.displacementTriangles,
    triangleBounds: [], tree: {bounds: [], root: null}});
  const source = nativeWorker.replace('const a=this.triangles[e],s=a.vertices,i=[m(1,0,0)',
    'const native={native:!0};return this.triangleCache.set(e,native),native;const a=this.triangles[e],s=a.vertices,i=[m(1,0,0)');
  const f = workerFixture(source), replay = {...replayFor(map), format: 8, commands: [{}]};
  f.send({type: 'run', job: 1, entry: {id: map.id}, currentVersion: map.version, replay, __surfdQolCollision: packet});
  await flush();
  const world = f.probe.simulations[0].world, brush = world.triangleBrush(0);
  expect(brush).toEqual({native: true});
  expect(world.triangleBrush(0)).toBe(brush);
  expect(f.probe.loads()).toBe(1);
  expect(f.probe.builds()).toBe(1);
});

test('view-only native jobs initialize camera physics without simulating an unused index', async () => {
  const source = nativeWorker.replace('class Index{',
    'class Session{constructor(map,config,format){this.map=map;this.world=worldFor(map,format)}loadReplay(replay){this.replay=replay}}class Index{')
    .replace('this.map=map,this.replay=replay;', 'this.session=new Session(map,replay.config),this.map=map,this.replay=replay;');
  let attached;
  globalThis.__surfdQolViewProbe = (...args) => { attached = args; };
  const runtime = `globalThis.__surfdQolCreateCinemaWorker=()=>({attach:(...args)=>globalThis.__surfdQolViewProbe(...args),receive:()=>false});`;
  try {
    const f = workerFixture(source, performance, runtime), replay = {mapId: 'map', mapVersion: 'v1', format: 8, config: {}, commands: [{}]};
    f.send({type: 'run', job: 1, entry: {id: 'map'}, currentVersion: 'v1', replay, __surfdQolViewOnly: true}); await flush();
    expect(f.probe.simulations).toHaveLength(0);
    expect(attached[0].replay).toBe(replay); expect(attached.slice(1)).toEqual([replay, 1, false]);
    expect(attached[0].world.vphysicsFeatureFix).toBe(true);
    expect(f.posts.filter(post => post.type === 'world')).toHaveLength(1);
    expect(f.posts.filter(post => post.type === 'batch')).toHaveLength(0);
  } finally { delete globalThis.__surfdQolViewProbe; }
});

test('native chunks permit cancellation and suppress initialization acknowledgments on failure', async () => {
  const f = workerFixture(), replay = {mapId: 'map', mapVersion: 'v1', format: 8, commands: [{}, {}, {}]};
  f.send({type: 'run', job: 1, entry: {id: 'map'}, currentVersion: 'v1', replay}); await flush();
  expect(f.probe.simulations[0].position).toBe(1); f.send({type: 'cancel', job: 1});
  f.send({type: 'run', job: 2, entry: {id: 'map'}, currentVersion: 'v1', replay: {...replay, commands: [{}]}}); await f.resume();
  expect(f.probe.simulations[0].position).toBe(1); expect(f.probe.loads()).toBe(1);
  f.send({type: 'run', job: 3, entry: {id: 'map'}, currentVersion: 'v1', replay: {...replay, failInit: true}}); await flush();
  expect(f.posts.some(post => post.type === 'world' && post.job === 3)).toBe(false);
  expect(f.posts.find(post => post.type === 'batch' && post.job === 3).ok).toBe(false);
});

const nativePlayer = `
class Movement{}
class Session{constructor(map){this.movement=new Movement();this.timer={state:{}};this.map=map}checkpointSpeeds=[];startJumps=0;}
const map={id:"map",version:"v1"},input={setBindings(){}},settings={bindings:{}},route={prepare(){}},boards={current:{entries:[]}},client={board(){},replay(){}};
let nativeSession=new Session(map),target=null,view=null,renderer=null,loaded=false,fallbacks=0;
input.setBindings(settings.bindings);
function references(){const record=boards.current?.entries.find(entry=>entry.rank===1);route.prepare("map",()=>client.replay(record.runId))}
function lookup(){return client.board(nativeSession.map)}
function snapshot(){return {state:nativeSession?.state,run:nativeSession?.timer.state,spectator:{target:target,view:view}}}
function makeSession(map){return new Session(map)}
function makeRenderer(){return {dispose(){},setQuality(){}}}
function install(map){renderer&&renderer.dispose(),nativeSession=makeSession(map),loaded=!1,renderer=makeRenderer(),renderer.setQuality?.(1)}
class Fallback{constructor(){fallbacks++}}
const timeout=1000;
class Player{
constructor(){this.host={session:()=>nativeSession};this.revision=0;this.worker=null}
begin(replay){this.stopWorker();this.replay=replay;this.revision++;this.fallback=null;this.index={complete:false,batches:[],apply(batch){this.batches.push(batch);this.complete=batch.done}};this.startIndex(nativeSession.map,{id:replay.mapId},nativeSession.map.version,"key")}
startIndex(e,t,i,s){const r=this.replay,a=this.index,o=this.revision,c=()=>{o!==this.revision||a.complete||(this.stopWorker(),this.fallback=new Fallback(e,r))};if(!a.complete){if(typeof Worker>"u"||!t){c();return}try{const l=new Worker(new URL("/assets/replay-index.worker-fixture.js",import.meta.url),{type:"module"});this.worker=l,this.workerTimeout=setTimeout(c,timeout),l.onmessage=d=>{if(o!==this.revision)return;const u=d.data;if(!u?.ok||!valid(u.batch,s,r.commands.length)){c();return}a.apply(u.batch),u.batch.done?this.stopWorker():(clearTimeout(this.workerTimeout),this.workerTimeout=setTimeout(c,timeout))},l.onerror=d=>{d.preventDefault(),c()},l.postMessage({entry:t,currentVersion:i,replay:r})}catch{c()}}}
stopWorker(){clearTimeout(this.workerTimeout),this.workerTimeout=void 0,this.worker?.terminate(),this.worker=null}}
function valid(batch){return batch&&typeof batch.done==="boolean"}
const player=new Player();install(map);
`;
function playerFixture(collision = '') {
  const warn = console.warn; let source;
  try { console.warn = () => {}; source = instrumentGame(nativePlayer + collision); } finally { console.warn = warn; }
  const workers = [], timers = new Map();
  class NativeWorker extends WorkerStub { constructor() { super(); workers.push(this); } }
  const runtime = new Function('globalThis', 'Worker', 'setTimeout', 'clearTimeout', source.replaceAll('import.meta.url', '"https://surfd.net/game.js"') +
    `;return {player,install,dispose:()=>renderer.dispose(),session:()=>nativeSession,map,fallbacks:()=>fallbacks${collision ? ',World:ke' : ''}};`)({}, NativeWorker,
    callback => { const id = Symbol(); timers.set(id, callback); return id; }, id => timers.delete(id));
  return {...runtime, workers, timers};
}
test('instrumented native player and worker preserve packed and unsupported triangle physics', async () => {
  for (const variant of ['ordinary', 'map', 'species', 'coordinates']) {
    const f = playerFixture(`;const ${nativeCollisionFixture}`), vertices = [
      {x: 0, y: 0, z: 0}, {x: 1, y: 0, z: 0}, {x: 0, y: 1, z: 0},
    ];
    if (variant === 'map') vertices.map = callback => Array.prototype.map.call(vertices, callback).map(value => value + 17);
    if (variant === 'species') vertices.constructor = {[Symbol.species]: class extends Array {
      *[Symbol.iterator]() { for (let i = 0; i < this.length; i++) yield this[i] + 29; }
    }};
    if (variant === 'coordinates') Object.defineProperty(vertices[0], 'x', {enumerable: true, get: () => 0});
    const triangle = {surfaceId: 3, triangleId: 4, vertices};
    f.map.brushes = []; f.map.displacementTriangles = [triangle];
    const mainWorld = f.session().movement.world = new f.World(f.map.brushes, f.map.displacementTriangles);
    const shift = variant === 'map' ? 17 : variant === 'species' ? 29 : 0;
    const query = {min: {x: shift, y: shift, z: shift}, max: {x: shift + 1, y: shift + 1, z: shift}};
    expect(mainWorld.triangleBounds[0]).toEqual(query);
    expect(mainWorld.tree.query(query)).toEqual([0]);

    const replay = {...replayFor(f.map), format: 8, commands: [{}]};
    f.player.begin(replay);
    const worker = f.workers[0];
    worker.ready(); await flush();
    const run = worker.runs()[0];
    expect(run).toBeDefined();
    if (variant !== 'ordinary') expect(run.message.__surfdQolCollision).toBeUndefined();
    else {
      const packet = run.message.__surfdQolCollision, snapshot = unpackCollisionWorld(packet);
      expect(snapshot.map.displacementTriangles[0]).toEqual(triangle);
      expect(snapshot.tree.query(query)).toEqual([0]);
      expect(run.transfer.length).toBeGreaterThan(0);
    }

    // Deliver the player's real job to the instrumented native worker. Its
    // geometry represents a fresh native load when packing is unsupported.
    const index = workerFixture(nativeWorker.replace('self.probe={simulations,', 'self.probe={geometry,simulations,'));
    index.probe.geometry.displacementTriangles = [triangle];
    index.send(run.message); await flush();
    expect(index.probe.loads()).toBe(variant === 'ordinary' ? 0 : 1);
    expect(index.probe.builds()).toBe(variant === 'ordinary' ? 0 : 1);
    const workerWorld = index.probe.simulations[0].world;
    expect(workerWorld.triangleBounds[0]).toEqual(mainWorld.triangleBounds[0]);
    expect(workerWorld.tree.query(query)).toEqual([0]);
    expect(workerWorld.triangleBrush(0)).toEqual(mainWorld.triangleBrush(0));
    for (const message of index.posts) worker.receive(message);
    expect(f.player.index.complete).toBe(true);
    expect(f.fallbacks()).toBe(0);
  }
});

test('native player retains validation/watchdogs while completed jobs release resources', async () => {
  const f = playerFixture(), replay = {...replayFor(f.map), commands: [{}]};
  f.player.begin(replay); const first = f.player.worker, worker = f.workers[0];
  worker.ready(); await flush(); worker.world(first, replay); worker.batch(first, {done: true});
  expect(f.player.index.complete).toBe(true); expect(worker.terminated).toBe(1); expect(f.timers.size).toBe(0);
  f.player.begin(replay); const second = f.player.worker, next = f.workers[1];
  next.ready(); await flush(); next.batch(second, {done: false}); expect(f.timers.size).toBe(1);
  next.receive(protocol({type: 'batch', job: second.id, ok: false}));
  expect(f.fallbacks()).toBe(1); expect(next.terminated).toBe(1); expect(f.timers.size).toBe(0);
  f.player.begin(replay); f.dispose(); expect(f.workers[2].terminated).toBe(1); expect(f.timers.size).toBe(0);
});
test('unpatched workers fail immediately and silent workers expire into native fallback', () => {
  for (const mode of ['protocol', 'watchdog']) {
    const f = playerFixture(); f.player.begin(replayFor(f.map));
    if (mode === 'protocol') f.workers[0].receive({ok: false}); else [...f.timers.values()][0]();
    expect(f.fallbacks()).toBe(1); expect(f.workers[0].terminated).toBe(1); expect(f.timers.size).toBe(0);
  }
});
