import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createMapLoadJobs, runMapLoadWorker} from '../extension/map-load-worker.js';
import {createVisualPackProcessor} from '../extension/map-asset-worker.js';

const encoder = new TextEncoder();
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function signalFixture() {
  const listeners = new Set();
  return {
    aborted: false, reason: undefined, listeners,
    addEventListener(type, callback) { if (type === 'abort') listeners.add(callback); },
    removeEventListener(type, callback) { if (type === 'abort') listeners.delete(callback); },
    abort(reason) {
      if (this.aborted) return;
      this.aborted = true;
      this.reason = reason;
      for (const callback of [...listeners]) callback();
    },
  };
}

function brokerFixture(options = {}) {
  const workers = [], created = [], revoked = [], timers = [];
  class Bitmap {
    closed = 0;
    close() { this.closed++; }
  }
  class Worker {
    constructor(url) {
      if (options.constructionError) throw new Error('CSP blocked worker');
      this.url = url;
      this.posts = [];
      this.terminated = 0;
      workers.push(this);
    }
    postMessage(message, transfers = []) {
      if (options.probeTransferError && message.type === 'probe') throw new Error('Cannot transfer streams');
      this.posts.push({message, transfers});
    }
    terminate() { this.terminated++; }
    receive(data) { this.onmessage?.({data}); }
    crash(message = 'worker crashed') { this.onerror?.({message, preventDefault() {}}); }
  }
  const URL = {
    createObjectURL() { const url = `blob:map-${created.length + 1}`; created.push(url); return url; },
    revokeObjectURL(url) { revoked.push(url); },
  };
  const setTimer = (callback, delay) => { const timer = {callback, delay, cleared: false}; timers.push(timer); return timer; };
  const clearTimer = timer => { timer.cleared = true; };
  // Supplying globals lexically also proves that the injected factory has no
  // dependencies on its original module scope.
  const factory = Function('Worker', 'URL', 'Blob', 'ImageBitmap', 'ReadableStream', 'setTimeout', 'clearTimeout',
    `return (${createMapLoadJobs.toString()})`)(options.missingWorker ? undefined : Worker, URL, Blob, Bitmap,
    ReadableStream, setTimer, clearTimer);
  return {factory, workers, created, revoked, timers, Bitmap};
}

function completeHandshake(worker, images = true) {
  worker.receive({type: 'ready', streams: true, images});
  worker.receive({type: 'probe', ok: true});
}

function fragmented(bytes) {
  const chunks = [];
  let offset = 0, size = 1;
  while (offset < bytes.length) {
    const end = Math.min(bytes.length, offset + size);
    chunks.push(Uint8Array.from(bytes.subarray(offset, end)));
    offset = end;
    size = size === 7 ? 1 : size + 1;
  }
  return new ReadableStream({start(controller) {
    controller.enqueue(new Uint8Array());
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  }});
}


test('native streams stay untouched until the worker and real transfer probe are ready', async () => {
  const fixture = brokerFixture(), signal = signalFixture();
  const jobs = fixture.factory('worker code', signal), worker = fixture.workers[0];
  const stream = fragmented(encoder.encode('{"ok":true}'));
  const result = jobs.run('pack', {stream}, [stream]);
  assert.deepEqual(worker.posts, []);
  worker.receive({type: 'ready', streams: true, images: true});
  assert.equal(worker.posts.length, 1);
  assert.equal(worker.posts[0].message.type, 'probe');
  assert.deepEqual(worker.posts[0].transfers, [worker.posts[0].message.stream]);
  assert.equal(stream.locked, false);
  worker.receive({type: 'probe', ok: true});
  assert.equal(await jobs.ready, true);
  await flush();
  assert.equal(worker.posts[1].message.type, 'pack');
  assert.deepEqual(worker.posts[1].transfers, [stream]);
  // Even a startup timer callback already queued at readiness cannot turn a
  // transferred response into a native fallback or reject its active job.
  fixture.timers[0].callback();
  assert.equal(worker.terminated, 0);
  worker.receive({id: worker.posts[1].message.id, result: {ok: true}});
  assert.deepEqual(await result, {ok: true});
  assert.deepEqual(fixture.created, fixture.revoked);
  assert.equal(fixture.timers[0].cleared, true);
  jobs.dispose();
  assert.equal(worker.terminated, 1);
  assert.equal(worker.onmessage, null);
  assert.equal(worker.onerror, null);
  assert.equal(worker.onmessageerror, null);
  assert.equal(signal.listeners.size, 0);
  jobs.dispose();
  assert.equal(worker.terminated, 1);
});

for (const mode of ['missing', 'construction', 'decompressor', 'probe-transfer', 'probe-read', 'startup-error', 'startup-deadline']) {
  test(`${mode} unavailability leaves the original response readable`, async () => {
    const fixture = brokerFixture({missingWorker: mode === 'missing', constructionError: mode === 'construction',
      probeTransferError: mode === 'probe-transfer'});
    const signal = signalFixture(), jobs = fixture.factory('worker code', signal);
    const stream = fragmented(encoder.encode('{"native":-0}'));
    const outcome = jobs.run('pack', {stream}, [stream]).then(() => null, error => error);
    const worker = fixture.workers[0];
    if (mode === 'decompressor') worker.receive({type: 'ready', streams: false, images: false});
    if (mode === 'probe-transfer') worker.receive({type: 'ready', streams: true, images: false});
    if (mode === 'probe-read') {
      worker.receive({type: 'ready', streams: true, images: false});
      worker.receive({type: 'probe', ok: false});
    }
    if (mode === 'startup-error') worker.crash('CSP');
    if (mode === 'startup-deadline') {
      fixture.timers[0].callback();
    }
    assert.equal(await jobs.ready, false);
    assert.match((await outcome).message, /unavailable/);
    assert.equal(Object.is((await new Response(stream).json()).native, -0), true);
    assert.equal(worker?.posts.some(({message}) => message.type === 'pack') ?? false, false);
    assert.deepEqual(fixture.created, fixture.revoked);
    assert.equal(signal.listeners.size, 0);
    if (worker) assert.equal(worker.terminated, 1);
    jobs.dispose();
  });
}

test('disposing before readiness rejects waiting work and releases all startup resources', async () => {
  const fixture = brokerFixture(), signal = signalFixture(), jobs = fixture.factory('worker', signal);
  const ready = jobs.ready.catch(error => error), pending = jobs.run('pack', {}).catch(error => error);
  jobs.dispose();
  const failure = await ready;
  assert.equal(failure.name, 'AbortError');
  assert.equal(await pending, failure);
  assert.equal(fixture.workers[0].terminated, 1);
  assert.equal(fixture.workers[0].onmessage, null);
  assert.equal(fixture.timers[0].cleared, true);
  assert.deepEqual(fixture.created, fixture.revoked);
  assert.equal(signal.listeners.size, 0);
});

test('worker readiness rejects missing or unusable decompression before native transfer', () => {
  const broken = class { constructor() { throw new Error('unavailable'); } };
  for (const decompressor of [undefined, broken, class {}]) {
    const run = Function('DecompressionStream', `return (${runMapLoadWorker.toString()})`)(decompressor);
    const messages = [], scope = {postMessage(message) { messages.push(message); }};
    run({scope, decodeImage() {}, decodeMesh() {}, createVisualPackProcessor});
    assert.equal(messages[0].type, 'ready');
    assert.equal(messages[0].streams, false);
  }
});


test('abort immediately terminates startup and in-flight jobs with the exact signal reason', async () => {
  const reason = {kind: 'map replaced'};
  const early = brokerFixture(), earlySignal = signalFixture(), earlyJobs = early.factory('worker', earlySignal);
  const earlyReady = earlyJobs.ready.catch(error => error);
  const earlyRun = earlyJobs.run('pack', {}).catch(error => error);
  earlySignal.abort(reason);
  assert.equal(await earlyReady, reason);
  assert.equal(await earlyRun, reason);
  assert.equal(early.workers[0].terminated, 1);
  assert.equal(earlySignal.listeners.size, 0);
  assert.deepEqual(early.created, early.revoked);

  const fixture = brokerFixture(), signal = signalFixture(), jobs = fixture.factory('worker', signal);
  const worker = fixture.workers[0];
  completeHandshake(worker);
  await jobs.ready;
  const a = jobs.run('a', {}).catch(error => error), b = jobs.run('b', {}).catch(error => error);
  await flush();
  signal.abort(reason);
  assert.equal(await a, reason);
  assert.equal(await b, reason);
  assert.equal(await jobs.run('later', {}).catch(error => error), reason);
  assert.equal(worker.terminated, 1);
  assert.equal(signal.listeners.size, 0);

  const already = signalFixture(); already.abort(reason);
  const unused = brokerFixture(), cancelled = unused.factory('worker', already);
  assert.equal(await cancelled.ready.catch(error => error), reason);
  assert.equal(unused.workers.length, 0);
});

test('crashes reject all active jobs instead of falling back after transfer', async () => {
  const fixture = brokerFixture(), jobs = fixture.factory('worker', signalFixture()), worker = fixture.workers[0];
  completeHandshake(worker);
  await jobs.ready;
  const a = jobs.run('a', {}).catch(error => error), b = jobs.run('b', {}).catch(error => error);
  await flush();
  worker.crash('processor crashed');
  const error = await a;
  assert.match(error.message, /processor crashed/);
  assert.equal(await b, error);
  assert.equal(await jobs.run('later', {}).catch(error => error), error);
  assert.equal(worker.terminated, 1);
  assert.equal(await jobs.ready, true);
});

test('late, unhandled, and failed event bitmaps are closed while accepted images remain owned', async () => {
  const fixture = brokerFixture(), jobs = fixture.factory('worker', signalFixture()), worker = fixture.workers[0];
  completeHandshake(worker);
  await jobs.ready;
  const accepted = new fixture.Bitmap(), unhandled = new fixture.Bitmap(), late = new fixture.Bitmap();
  const received = [];
  const first = jobs.run('a', {}, [], event => received.push(event.value));
  const second = jobs.run('b', {});
  await flush();
  const a = worker.posts[1].message.id, b = worker.posts[2].message.id;
  worker.receive({id: a, event: {value: accepted}});
  worker.receive({id: b, event: {value: unhandled}});
  worker.receive({id: a, result: 1});
  worker.receive({id: b, result: 2});
  await Promise.all([first, second]);
  const stale = worker.onmessage;
  jobs.dispose();
  stale({data: {id: a, event: {value: late}}});
  assert.deepEqual(received, [accepted]);
  assert.equal(accepted.closed, 0);
  assert.equal(unhandled.closed, 1);
  assert.equal(late.closed, 1);

  const other = brokerFixture(), otherJobs = other.factory('worker', signalFixture()), otherWorker = other.workers[0];
  completeHandshake(otherWorker);
  await otherJobs.ready;
  const reason = new Error('publication failed'), failed = new other.Bitmap();
  const one = otherJobs.run('a', {}, [], () => { throw reason; }).catch(error => error);
  const two = otherJobs.run('b', {}).catch(error => error);
  await flush();
  otherWorker.receive({id: otherWorker.posts[1].message.id, event: {value: failed}});
  assert.equal(await one, reason);
  assert.equal(await two, reason);
  assert.equal(failed.closed, 1);
  assert.equal(otherWorker.terminated, 1);
});

function visualRuntime() {
  const pending = new Map(), events = [];
  let nextId = 0;
  const scope = {postMessage(message, transfers = []) {
    const data = structuredClone(message, {transfer: transfers});
    if (data.type === 'ready') return;
    if (Object.hasOwn(data, 'event')) { events.push(data.event); return; }
    const request = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) request.reject(Object.assign(new Error(data.error.message), {name: data.error.name}));
    else request.resolve(data.result);
  }};
  runMapLoadWorker({scope, createVisualPackProcessor,
    decodeImage() { throw new Error('Unexpected image'); },
    decodeMesh() { throw new Error('Unexpected mesh'); }});
  return {events, run(type, payload) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, {resolve, reject});
      scope.onmessage({data: {id, type, payload}});
    });
  }};
}

function nativePack(byteLength) {
  return {byteLength, entries: [{url: 'texture.dds', kind: 'compressed-texture',
    offset: 0, length: byteLength, assetOffset: 0, assetLength: byteLength}]};
}

test('the worker reconstructs identical native assets from plain and fragmented gzip streams', async () => {
  const bytes = Uint8Array.of(0, 255, 17, 31, 139, 0, 81);
  for (const input of [bytes, Uint8Array.from(gzipSync(bytes))]) {
    const runtime = visualRuntime();
    await runtime.run('init', {assets: [{url: 'texture.dds', kind: 'compressed-texture',
      assetLength: bytes.length, priority: 0}]});
    await runtime.run('pack', {stream: fragmented(input), pack: nativePack(bytes.length)});
    await runtime.run('finish', {});
    const asset = runtime.events.find(event => event.kind === 'compressed-texture');
    assert.deepEqual(new Uint8Array(asset.value), bytes);
    assert.equal(runtime.events.at(-1).kind, 'pack-eof');
  }
});

test('gzip CRC, truncation and source errors reject the pack even after an asset was decoded', async () => {
  const bytes = Uint8Array.of(1, 2, 3, 4), gzip = Uint8Array.from(gzipSync(bytes));
  const badCRC = gzip.slice(); badCRC[badCRC.length - 8] ^= 1;
  const streams = [
    fragmented(badCRC),
    fragmented(gzip.subarray(0, gzip.length - 1)),
    new ReadableStream({start(controller) { controller.error(new Error('source failed')); }}),
  ];
  for (const stream of streams) {
    const runtime = visualRuntime();
    await runtime.run('init', {assets: [{url: 'texture.dds', kind: 'compressed-texture',
      assetLength: bytes.length, priority: 0}]});
    await assert.rejects(runtime.run('pack', {stream, pack: nativePack(bytes.length)}));
    assert.equal(runtime.events.some(event => event.kind === 'pack-eof'), false);
  }
});
