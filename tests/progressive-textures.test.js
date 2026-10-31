import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProgressiveTextureBindings} from '../extension/progressive-textures.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return {promise, resolve, reject};
}

function fixture() {
  const controller = new AbortController(), finished = deferred();
  const gates = new Map(['visible', 'offscreen'].map(url => [url, deferred()]));
  const resources = {
    images: new Map(), compressed: new Map(), pendingCompressed: new Map(),
    pendingImages: new Map([...gates].map(([url, gate]) => [url, gate.promise])),
    signal: controller.signal, ready: finished.promise, prioritize() {},
    cancel() { controller.abort(new DOMException('Map disposed', 'AbortError')); }
  };
  const bindings = createProgressiveTextureBindings(resources);
  const textures = {};
  for (const url of gates.keys()) {
    const texture = textures[url] = {image: null};
    bindings.bind(texture, url, () => { texture.image = resources.images.get(url); });
  }
  const renderer = {renderBufferDirect() { throw new Error('Probe submitted a draw'); }};
  const nested = {value: {textures: [textures.visible]}};
  nested.value.cycle = nested;
  const draw = () => renderer.renderBufferDirect(null, null, null, {uniforms: {nested}});
  return {
    bindings, resources, textures, renderer, draw, finished, gates,
    publish(url) {
      const image = {url};
      resources.images.set(url, image);
      gates.get(url).resolve(image);
      return image;
    }
  };
}

test('the initial view waits for visible uniform textures but not offscreen resources', async () => {
  const run = fixture(), initial = run.bindings.prepare(run.renderer, run.draw);
  const visible = run.publish('visible');
  await initial;
  assert.equal(run.textures.visible.image, visible);
  assert.equal(run.textures.offscreen.image, null);
  const complete = run.bindings.complete();
  const offscreen = run.publish('offscreen');
  run.finished.resolve();
  await complete;
  assert.equal(run.textures.offscreen.image, offscreen);
});

test('a native traversal failure restores renderer submission before rejecting', async () => {
  const run = fixture(), original = run.renderer.renderBufferDirect;
  const failure = new Error('Native traversal failed');
  await assert.rejects(run.bindings.prepare(run.renderer, () => { throw failure; }), error => error === failure);
  assert.equal(run.renderer.renderBufferDirect, original);
  run.bindings.dispose();
});

test('disposing a waiting view rejects preparation and prevents late texture mutation', async () => {
  const run = fixture(), initial = run.bindings.prepare(run.renderer, run.draw);
  run.bindings.dispose();
  await assert.rejects(initial, {name: 'AbortError'});
  run.publish('visible');
  run.publish('offscreen');
  run.finished.resolve();
  await assert.rejects(run.bindings.complete(), {name: 'AbortError'});
  assert.equal(run.textures.visible.image, null);
  assert.equal(run.textures.offscreen.image, null);
});

test('a background decode failure remains observable after initial preparation succeeds', async () => {
  const run = fixture(), initial = run.bindings.prepare(run.renderer, run.draw);
  run.publish('visible');
  await initial;
  const failure = new Error('Offscreen decode failed');
  run.gates.get('offscreen').reject(failure);
  run.finished.reject(failure);
  await assert.rejects(run.bindings.complete(), error => error === failure);
  assert.equal(run.textures.offscreen.image, null);
});

test('an unsupported renderer keeps complete-resource readiness before returning', async () => {
  const run = fixture();
  let prepared = false;
  const initial = run.bindings.prepare({}, () => { throw new Error('Unsupported traversal'); })
    .then(() => { prepared = true; });
  run.publish('visible');
  await Promise.resolve();
  assert.equal(prepared, false);
  run.publish('offscreen');
  run.finished.resolve();
  await initial;
  assert.equal(run.textures.offscreen.image, run.resources.images.get('offscreen'));
});
