import {describe, expect, test} from 'bun:test';
import {createReplayIndexJobs, createReplayIndexWorker} from '../extension/replay-index-worker.js';
import {instrumentGame, instrumentPhysicsWorker} from '../extension/instrument.js';
import {packCollisionWorld} from '../extension/collision-world.js';

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

const nativeWorker = `(()=>{
"use strict";
let loads=0,builds=0;const simulations=[],worlds=new WeakMap,geometry={id:"map",version:"v1",brushes:[],displacementTriangles:[]};
class World{constructor(b,t=[],f=!1,c=!1){this.brushes=b,this.triangles=t,this.vphysicsFeatureFix=f,this.bspCornerFix=c,this.triangleBounds=t.map(x=>x.bounds),this.tree={root:null};builds++}brushes;triangles;vphysicsFeatureFix;bspCornerFix;tree;triangleBounds;triangleCache=new Map;triangleBrush(){}}
function worldFor(o,e){const t=e>=7,a=e>=8,s=\`\${t}/\${a}\`;let i=worlds.get(o.brushes);i||(i=new Map,worlds.set(o.brushes,i));let c=i.get(s);return c||(c=new World(o.brushes,o.displacementTriangles,t,a),i.set(s,c)),c}
async function loadCurrent(entry){loads++;return geometry}
async function loadArchive(entry,version){loads++;return {...geometry,version,brushes:[]}}
class Index{constructor(map,replay){this.map=map,this.replay=replay;this.world=worldFor(map,replay.format);if(replay.failInit)throw Error("initialization failed");this.position=0;simulations.push(this)}run(alive){if(alive())this.position++;return {from:this.position,elapsed:new Float64Array([this.position]),phases:new Uint8Array([0]),markers:[],keyframes:[],finish:null,done:this.position>=this.replay.commands.length}}}
const q=self,Me=120;q.onmessage=o=>{process(o.data)};
async function process(o){try{const{entry:e,currentVersion:t,replay:a}=o;if(!a||a.mapId!==e.id)throw Error("wrong map");let s=null;a.mapVersion===t&&(s=await loadCurrent(e),s.version!==a.mapVersion&&(s=null)),s??=await loadArchive(e,a.mapVersion);const i=new Index(s,a);for(;;){const c=performance.now()+Me,r=i.run(()=>performance.now()<c);if(q.postMessage({ok:!0,batch:r},{transfer:[r.elapsed.buffer,r.phases.buffer]}),r.done)return}}catch(e){q.postMessage({ok:!1,error:e instanceof Error?e.message:String(e)})}}
self.probe={simulations,loads:()=>loads,builds:()=>builds};
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
  const source = nativeWorker.replace('triangleBrush(){}',
    'triangleBrush(i){const cached=this.triangleCache.get(i);if(cached)return cached;const brush={native:!0};return this.triangleCache.set(i,brush),brush}');
  const f = workerFixture(source), replay = {...replayFor(map), format: 8, commands: [{}]};
  f.send({type: 'run', job: 1, entry: {id: map.id}, currentVersion: map.version, replay, __surfdQolCollision: packet});
  await flush();
  const world = f.probe.simulations[0].world, first = world.triangleBrush(0), second = world.triangleBrush(0);
  expect(first).toBe(second); expect(world.triangleCache.get(0)).toBe(first);
  expect(first.id).toBe('disp-3-4'); expect(first.planes.length).toBeGreaterThan(0);
  expect(f.probe.builds()).toBe(0);
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
function playerFixture() {
  const warn = console.warn; let source;
  try { console.warn = () => {}; source = instrumentGame(nativePlayer); } finally { console.warn = warn; }
  const workers = [], timers = new Map();
  class NativeWorker extends WorkerStub { constructor() { super(); workers.push(this); } }
  const runtime = new Function('globalThis', 'Worker', 'setTimeout', 'clearTimeout', source.replaceAll('import.meta.url', '"https://surfd.net/game.js"') +
    ';return {player,install,dispose:()=>renderer.dispose(),map,fallbacks:()=>fallbacks};')({}, NativeWorker,
    callback => { const id = Symbol(); timers.set(id, callback); return id; }, id => timers.delete(id));
  return {...runtime, workers, timers};
}
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
