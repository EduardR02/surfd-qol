import {describe, expect, test} from 'bun:test';
import {createReplayIndexPool, createReplayIndexWorker} from '../extension/replay-index-worker.js';
import {instrumentGame, instrumentPhysicsWorker} from '../extension/instrument.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const protocol = data => ({__surfdQolIndex: 1, ...data});
const replayFor = (map, version = map.version) => ({mapId: map.id, mapVersion: version, commands: []});

class WorkerStub {
  posts = [];
  terminated = 0;
  postMessage(message, transfer) { this.posts.push({message, transfer}); }
  terminate() { this.terminated++; }
  receive(data) { this.onmessage?.({data}); }
  ready() { this.receive(protocol({type: 'ready'})); }
  world(lease, replay) { this.receive(protocol({type: 'world', job: lease.id, mapId: replay.mapId, mapVersion: replay.mapVersion})); }
  batch(lease, batch = {done: false}) { this.receive(protocol({type: 'batch', job: lease.id, ok: true, batch})); }
  runs() { return this.posts.filter(post => post.message.type === 'run'); }
}

for (const [kind, makePool, makeWorker] of [
  ['module', createReplayIndexPool, createReplayIndexWorker],
  ['standalone injected source', Function(`return (${createReplayIndexPool.toString()})`)(),
    Function(`return (${createReplayIndexWorker.toString()})`)()],
]) describe(`replay index lifecycle: ${kind}`, () => {
  function fixture(prepare = async () => null) {
    const pool = makePool(prepare), workers = [], map = {id: 'map', version: 'v1'};
    const session = {map};
    const create = () => { const worker = new WorkerStub(); workers.push(worker); return worker; };
    const acquire = (owner = map, replay = replayFor(owner)) => pool.acquire(owner, replay, session, create);
    return {pool, workers, map, session, acquire};
  }

  test('map setup is lazy; completed watches reuse worker/world without packing or transferring again', async () => {
    const buffer = new Float64Array([1, 2, 3]), packet = {vertices: buffer, sameBuffer: buffer.subarray(1)};
    let preparations = 0, disposed = 0;
    const f = fixture(async () => { preparations++; return packet; });
    const renderer = {dispose() { disposed++; }};
    f.pool.ownMap(f.map, renderer);
    expect(f.workers).toHaveLength(0);
    expect(preparations).toBe(0);
    const first = f.acquire(), replay = replayFor(f.map), batches = [];
    first.onmessage = event => { batches.push(event.data.batch); if (event.data.batch.done) first.terminate(); };
    first.postMessage({entry: f.map, currentVersion: 'v1', replay});
    const worker = f.workers[0];
    expect(worker.posts.map(post => post.message.type)).toEqual(['hello']);
    worker.ready();
    await flush();
    expect(preparations).toBe(1);
    expect(worker.runs()[0].message.__surfdQolCollision).toBe(packet);
    expect(worker.runs()[0].transfer).toEqual([buffer.buffer]);
    worker.world(first, replay);
    worker.batch(first, {done: true});
    expect(batches).toEqual([{done: true}]);
    expect(worker.terminated).toBe(0);
    const second = f.acquire();
    second.postMessage({entry: f.map, currentVersion: 'v1', replay});
    await flush();
    expect(f.workers).toHaveLength(1);
    expect(preparations).toBe(1);
    expect(worker.runs()).toHaveLength(2);
    expect(worker.runs()[1].message.__surfdQolCollision).toBeUndefined();
    expect(worker.runs()[1].transfer).toEqual([]);
    expect(worker.runs()[1].message.job).not.toBe(worker.runs()[0].message.job);
    second.terminate();
    renderer.dispose();
    expect(disposed).toBe(1);
    expect(worker.terminated).toBe(1);
  });

  test('native geometry loading retains the same warm world when preparation is bypassed', async () => {
    let preparations = 0;
    const f = fixture(async () => { preparations++; return null; });
    const replay = replayFor(f.map), first = f.acquire();
    first.postMessage({replay});
    const worker = f.workers[0];
    worker.ready();
    await flush();
    expect(worker.runs()[0].message.__surfdQolCollision).toBeUndefined();
    worker.world(first, replay);
    first.terminate();
    const second = f.acquire();
    second.postMessage({replay});
    await flush();
    expect(preparations).toBe(1);
    expect(f.workers).toHaveLength(1);
    expect(worker.runs()).toHaveLength(2);
  });

  test('canceling async preparation prevents its replay from ever being queued', async () => {
    const preparation = deferred();
    let alive;
    const f = fixture((map, session, message, isCurrent) => { alive = isCurrent; return preparation.promise; });
    const first = f.acquire();
    first.postMessage({replay: replayFor(f.map)});
    const worker = f.workers[0];
    worker.ready();
    expect(alive()).toBe(true);
    first.terminate();
    expect(alive()).toBe(false);
    preparation.resolve({vertices: new Float64Array(1)});
    await flush();
    expect(worker.runs()).toHaveLength(0);
    expect(worker.posts.at(-1).message).toEqual(protocol({type: 'cancel', job: first.id}));
  });

  test('stale batches, world acknowledgments and failures never reach the replacement job', async () => {
    const f = fixture(), first = f.acquire(), replay = replayFor(f.map);
    first.postMessage({replay});
    const worker = f.workers[0];
    worker.ready();
    await flush();
    worker.world(first, replay);
    first.terminate();
    const second = f.acquire(), batches = [], errors = [];
    second.onmessage = event => batches.push(event.data.batch);
    second.onerror = event => errors.push(event);
    second.postMessage({replay});
    worker.batch(first, {done: true});
    worker.world(first, {...replay, mapVersion: 'wrong'});
    worker.receive(protocol({type: 'batch', job: first.id, ok: false, error: 'obsolete'}));
    worker.batch(second, {done: false});
    expect(batches).toEqual([{done: false}]);
    expect(errors).toHaveLength(0);
    expect(worker.terminated).toBe(0);
  });

  test('map identity, revision and archived replay versions own separate workers', () => {
    const f = fixture(), first = f.acquire();
    const renderer = {dispose() {}};
    f.pool.ownMap(f.map, renderer);
    let closed = 0;
    first.onclose = () => { closed++; first.terminate(); };
    const archived = f.acquire(f.map, replayFor(f.map, 'archive-v0'));
    expect(f.workers[0].terminated).toBe(1);
    expect(closed).toBe(1);
    archived.terminate();
    const current = f.acquire();
    expect(f.workers[1].terminated).toBe(1);
    current.terminate();
    f.map.version = 'v2';
    f.acquire();
    expect(f.workers[2].terminated).toBe(1);
    const replacement = {...f.map};
    f.acquire(replacement);
    expect(f.workers[3].terminated).toBe(1);
    renderer.dispose();
    expect(f.workers[4].terminated).toBe(0);
  });

  test('worker, protocol and batch failures evict state and notify native fallback once', async () => {
    for (const failure of ['worker', 'messageerror', 'native', 'world', 'batch', 'validation']) {
      const f = fixture(), lease = f.acquire(), replay = replayFor(f.map), events = [];
      lease.onclose = () => { events.push('close'); lease.terminate(); };
      lease.onerror = () => events.push('fallback');
      lease.postMessage({replay});
      const worker = f.workers[0];
      worker.ready();
      await flush();
      if (failure === 'worker') worker.onerror({preventDefault() {}});
      else if (failure === 'messageerror') worker.onmessageerror();
      else if (failure === 'native') worker.receive({ok: false, error: 'unpatched worker'});
      else if (failure === 'world') worker.world(lease, {...replay, mapVersion: 'wrong'});
      else if (failure === 'validation') lease.terminate(true);
      else worker.receive(protocol({type: 'batch', job: lease.id, ok: false, error: 'failed'}));
      expect(worker.terminated).toBe(1);
      expect(events).toEqual(failure === 'validation' ? [] : ['close', 'fallback']);
      f.acquire();
      expect(f.workers).toHaveLength(2);
    }
  });

  test('packet clone failure falls back to native geometry, while failed posts evict', async () => {
    const f = fixture(async () => ({vertices: new Float64Array(1)}));
    const lease = f.acquire(), worker = f.workers[0], messages = [];
    worker.postMessage = message => {
      if (message.__surfdQolCollision) throw new Error('clone');
      messages.push(message);
    };
    lease.postMessage({replay: replayFor(f.map)});
    worker.ready();
    await flush();
    expect(messages.filter(message => message.type === 'run')).toHaveLength(1);
    expect(messages.find(message => message.type === 'run').__surfdQolCollision).toBeUndefined();
    lease.terminate();
    const next = f.acquire();
    let failures = 0;
    next.onerror = () => failures++;
    worker.postMessage = () => { throw new Error('closed port'); };
    next.postMessage({replay: replayFor(f.map)});
    await flush();
    expect(failures).toBe(1);
    expect(worker.terminated).toBe(1);
  });

  test('worker cancellation interrupts between chunks and only the newest pending job runs', async () => {
    const posts = [], pauses = [], starts = [];
    const receive = makeWorker(data => posts.push(data), async (message, job) => {
      starts.push(message.job);
      job.world({id: 'map', version: 'v1'});
      for (let chunk = 0; chunk < 3; chunk++) {
        if (!job.current()) return;
        job.emit({ok: true, batch: {chunk, done: chunk === 2}});
        if (chunk < 2) await job.pause();
      }
    }, () => { const pause = deferred(); pauses.push(pause); return pause.promise; });
    receive(protocol({type: 'hello'}));
    expect(posts).toEqual([protocol({type: 'ready'})]);
    expect(pauses).toHaveLength(0);
    receive(protocol({type: 'run', job: 1}));
    expect(starts).toEqual([1]);
    receive(protocol({type: 'cancel', job: 1}));
    receive(protocol({type: 'run', job: 2}));
    receive(protocol({type: 'run', job: 3}));
    pauses[0].resolve();
    await flush();
    expect(starts).toEqual([1, 3]);
    expect(posts.filter(post => post.job === 1 && post.type === 'batch').map(post => post.batch.chunk)).toEqual([0]);
    expect(posts.some(post => post.job === 2)).toBe(false);
    pauses[1].resolve();
    await flush();
    pauses[2].resolve();
    await flush();
    expect(posts.filter(post => post.job === 3 && post.type === 'batch').map(post => post.batch)).toEqual([
      {chunk: 0, done: false}, {chunk: 1, done: false}, {chunk: 2, done: true},
    ]);
    expect(pauses).toHaveLength(3);
  });

  test('canceling an asynchronous load suppresses all stale errors and world ownership', async () => {
    const load = deferred(), posts = [];
    const receive = makeWorker(data => posts.push(data), async (message, job) => {
      await load.promise;
      job.world({id: 'old', version: 'old'});
      throw new Error('cancelled load');
    });
    receive(protocol({type: 'run', job: 1}));
    receive(protocol({type: 'cancel', job: 1}));
    load.resolve();
    await flush();
    expect(posts).toEqual([]);
    receive(protocol({type: 'hello'}));
    expect(posts).toEqual([protocol({type: 'ready'})]);
  });
});

// A native-shaped worker fixture exercises the actual source cutover without
// site/network access. Geometry, simulation and flag caching stay independent.
const nativeWorker = `(()=>{
"use strict";
let loads=0,builds=0;const simulations=[],worlds=new WeakMap,geometry={id:"map",version:"v1",brushes:[],displacementTriangles:[]};
class World{constructor(b,t=[],f=!1,c=!1){this.brushes=b,this.triangles=t,this.vphysicsFeatureFix=f,this.bspCornerFix=c,this.triangleBounds=t.map(x=>x.bounds),this.tree={root:null};builds++}brushes;triangles;vphysicsFeatureFix;bspCornerFix;tree;triangleBounds;triangleCache=new Map;triangleBrush(){}}
function worldFor(o,t,a){let variants=worlds.get(o.brushes);if(!variants)worlds.set(o.brushes,variants=new Map);const key=t+"/"+a;let world=variants.get(key);if(!world){world=new World(o.brushes,o.displacementTriangles,t,a);variants.set(key,world)}return world}
async function loadCurrent(entry){loads++;return geometry}
async function loadArchive(entry,version){loads++;return {...geometry,version,brushes:[]}}
class Index{constructor(map,replay){this.map=map,this.replay=replay;this.world=worldFor(map,replay.format>=7,replay.format>=8);if(replay.failInit)throw Error("initialization failed");this.position=0;simulations.push(this)}run(alive){if(alive())this.position++;return {from:this.position,elapsed:new Float64Array([this.position]),phases:new Uint8Array([0]),markers:[],keyframes:[],finish:null,done:this.position>=this.replay.commands.length}}}
const q=self,Me=120;q.onmessage=o=>{process(o.data)};
async function process(o){try{const{entry:e,currentVersion:t,replay:a}=o;if(!a||a.mapId!==e.id)throw Error("wrong map");let s=null;a.mapVersion===t&&(s=await loadCurrent(e),s.version!==a.mapVersion&&(s=null)),s??=await loadArchive(e,a.mapVersion);const i=new Index(s,a);for(;;){const c=performance.now()+Me,r=i.run(()=>performance.now()<c);if(q.postMessage({ok:!0,batch:r},{transfer:[r.elapsed.buffer,r.phases.buffer]}),r.done)return}}catch(e){q.postMessage({ok:!1,error:e instanceof Error?e.message:String(e)})}}
self.probe={simulations,loads:()=>loads,builds:()=>builds};
})();`;

function instrumentedWorkerFixture() {
  const posts = [], scheduled = [], self = {postMessage: data => posts.push(data)};
  const source = instrumentPhysicsWorker(nativeWorker);
  expect(source).toContain('__surfdQolReceive');
  new Function('self', 'setTimeout', source)(self, callback => scheduled.push(callback));
  return {posts, scheduled, probe: self.probe,
    send: data => self.onmessage({data: protocol(data)}),
    async resume() { scheduled.shift()(); await flush(); }};
}

test('patched native worker retains geometry and flag variants but starts fresh simulations', async () => {
  const f = instrumentedWorkerFixture(), replay = {mapId: 'map', mapVersion: 'v1', format: 8, commands: [{}]};
  f.send({type: 'hello'});
  expect(f.scheduled).toHaveLength(0);
  expect(f.probe.loads()).toBe(0);
  for (const [job, format] of [[1, 8], [2, 8], [3, 6], [4, 8]]) {
    f.send({type: 'run', job, entry: {id: 'map'}, currentVersion: 'v1', replay: {...replay, format}});
    await flush();
  }
  expect(f.probe.loads()).toBe(1);
  expect(f.probe.builds()).toBe(2);
  const [first, second, oldFlags, fourth] = f.probe.simulations;
  expect(first).not.toBe(second);
  expect(first.world).toBe(second.world);
  expect(first.world).toBe(fourth.world);
  expect(oldFlags.world).not.toBe(first.world);
  expect(first.world.vphysicsFeatureFix).toBe(true);
  expect(first.world.bspCornerFix).toBe(true);
  expect(oldFlags.world.vphysicsFeatureFix).toBe(false);
  expect(oldFlags.world.bspCornerFix).toBe(false);
  expect(f.posts.filter(post => post.type === 'batch').map(post => [post.job, post.batch.elapsed[0], post.batch.done]))
    .toEqual([[1, 1, true], [2, 1, true], [3, 1, true], [4, 1, true]]);
  expect(f.scheduled).toHaveLength(0);
  f.send({type: 'run', job: 5, entry: {id: 'map'}, currentVersion: 'v1', replay: {...replay, mapVersion: 'archive'}});
  await flush();
  expect(f.probe.loads()).toBe(2);
  expect(f.probe.simulations.at(-1).map.version).toBe('archive');
});

test('patched native run yields between batches, allowing cancellation before its next tick', async () => {
  const f = instrumentedWorkerFixture(), replay = {mapId: 'map', mapVersion: 'v1', format: 8, commands: [{}, {}, {}]};
  f.send({type: 'run', job: 1, entry: {id: 'map'}, currentVersion: 'v1', replay});
  await flush();
  expect(f.scheduled).toHaveLength(1);
  expect(f.probe.simulations[0].position).toBe(1);
  f.send({type: 'cancel', job: 1});
  f.send({type: 'run', job: 2, entry: {id: 'map'}, currentVersion: 'v1', replay: {...replay, commands: [{}]}});
  await f.resume();
  expect(f.probe.simulations[0].position).toBe(1);
  expect(f.probe.simulations[1].position).toBe(1);
  expect(f.posts.filter(post => post.type === 'batch').map(post => [post.job, post.batch.done]))
    .toEqual([[1, false], [2, true]]);
  expect(f.probe.loads()).toBe(1);
  expect(f.scheduled).toHaveLength(0);
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

function instrumentedPlayerFixture() {
  let source;
  const warn = console.warn;
  try { console.warn = () => {}; source = instrumentGame(nativePlayer); }
  finally { console.warn = warn; }
  expect(source).toContain('__surfdQolIndexes().acquire');
  const workers = [], timers = new Map();
  class NativeWorker extends WorkerStub { constructor() { super(); workers.push(this); } }
  const runtime = new Function('globalThis', 'Worker', 'setTimeout', 'clearTimeout',
    source.replaceAll('import.meta.url', '"https://surfd.net/game.js"') +
    ';return {player,install,dispose:()=>renderer.dispose(),map,fallbacks:()=>fallbacks};')(
    {}, NativeWorker, callback => { const id = Symbol(); timers.set(id, callback); return id; }, id => timers.delete(id));
  return {...runtime, workers, timers};
}

test('native player completion retains its worker, while native failure and map disposal clear watchdogs', async () => {
  const f = instrumentedPlayerFixture(), replay = {...replayFor(f.map), commands: [{}]};
  expect(f.workers).toHaveLength(0);
  expect(f.timers.size).toBe(0);
  f.player.begin(replay);
  const worker = f.workers[0], first = f.player.worker;
  worker.ready();
  await flush();
  worker.world(first, replay);
  worker.batch(first, {done: true});
  expect(f.player.index.complete).toBe(true);
  expect(f.player.worker).toBeNull();
  expect(f.timers.size).toBe(0);
  expect(worker.terminated).toBe(0);
  f.player.begin(replay);
  const second = f.player.worker;
  worker.batch(first, {done: true});
  expect(f.player.index.complete).toBe(false);
  worker.batch(second, {done: false});
  expect(f.timers.size).toBe(1);
  worker.receive(protocol({type: 'batch', job: second.id, ok: false, error: 'failure'}));
  expect(f.fallbacks()).toBe(1);
  expect(f.player.worker).toBeNull();
  expect(worker.terminated).toBe(1);
  expect(f.timers.size).toBe(0);
  f.player.begin(replay);
  expect(f.workers).toHaveLength(2);
  f.dispose();
  expect(f.workers[1].terminated).toBe(1);
  expect(f.player.worker).toBeNull();
  expect(f.timers.size).toBe(0);
  f.install({id: 'map-two', version: 'v2'});
  expect(f.workers).toHaveLength(2);
});

test('an unpatched worker fails the handshake into native fallback without indexing or a leaked watchdog', () => {
  const f = instrumentedPlayerFixture(), replay = replayFor(f.map);
  f.player.begin(replay);
  const worker = f.workers[0];
  worker.receive({ok: false, error: 'Native worker rejected hello'});
  expect(worker.runs()).toHaveLength(0);
  expect(worker.terminated).toBe(1);
  expect(f.fallbacks()).toBe(1);
  expect(f.timers.size).toBe(0);
});

test('native watchdog expiry evicts a silent worker and a later watch creates a fresh one', () => {
  const f = instrumentedPlayerFixture(), replay = replayFor(f.map);
  f.player.begin(replay);
  const expire = [...f.timers.values()][0];
  expire();
  expect(f.fallbacks()).toBe(1);
  expect(f.workers[0].terminated).toBe(1);
  expect(f.timers.size).toBe(0);
  f.player.begin(replay);
  expect(f.workers).toHaveLength(2);
  f.dispose();
  expect(f.timers.size).toBe(0);
});

test('world readiness is not acknowledged when native simulation initialization fails', async () => {
  const f = instrumentedWorkerFixture(), replay = {mapId: 'map', mapVersion: 'v1', format: 8, commands: [{}], failInit: true};
  f.send({type: 'run', job: 1, entry: {id: 'map'}, currentVersion: 'v1', replay});
  await flush();
  expect(f.posts.some(post => post.type === 'world')).toBe(false);
  expect(f.posts.filter(post => post.type === 'batch')).toEqual([
    protocol({type: 'batch', job: 1, ok: false, error: 'initialization failed'}),
  ]);
  expect(f.scheduled).toHaveLength(0);
});
