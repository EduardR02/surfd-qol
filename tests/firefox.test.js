import {expect, test} from 'bun:test';
import {firefoxManifest} from '../firefox-manifest.js';

const chromeManifest = JSON.parse(await Bun.file(new URL('../extension/manifest.json', import.meta.url)).text());

test('the Firefox manifest drops the debugger for response filtering', () => {
  const manifest = firefoxManifest(chromeManifest);
  expect(manifest.permissions).not.toContain('debugger');
  expect(manifest.permissions).toEqual(expect.arrayContaining(['storage', 'webRequest', 'webRequestBlocking', 'webRequestFilterResponse']));
  expect(manifest.background).toEqual({scripts: ['background-firefox.js'], type: 'module'});
  expect(manifest.minimum_chrome_version).toBeUndefined();
  expect(manifest.browser_specific_settings.gecko.strict_min_version).toBe('128.0');
  expect(manifest.content_scripts).toEqual(chromeManifest.content_scripts);
  expect(manifest.version).toBe(chromeManifest.version);
});

// A fake of the WebExtension APIs the Firefox loader touches.
const sent = [], badges = [], filters = [];
let onHeaders, onMessage;
globalThis.chrome = {
  runtime: {getManifest: () => ({version: '1.0.0'}), onMessage: {addListener: listener => { onMessage = listener; }}},
  storage: {local: {get: async () => ({}), set: async () => {}}},
  tabs: {sendMessage: async (tabId, message) => { sent.push([tabId, message]); }, reload() {}},
  action: {setBadgeText: async badge => { badges.push(badge); }, setBadgeBackgroundColor: async () => {}, setTitle: async () => {}, onClicked: {addListener() {}}}
};
globalThis.browser = {webRequest: {
  onHeadersReceived: {addListener: (listener, filter, extra) => { onHeaders = {listener, filter, extra}; }},
  filterResponseData: requestId => {
    const filter = {requestId, written: [], closed: false, write(data) { this.written.push(new Uint8Array(data)); }, close() { this.closed = true; }};
    filters.push(filter);
    return filter;
  }
}};
await import('../extension/background-firefox.js');

const respond = async (url, body, statusCode = 200) => {
  const result = onHeaders.listener({requestId: String(filters.length), url, tabId: 7, statusCode,
    responseHeaders: [{name: 'Content-Length', value: '3'}, {name: 'Content-Type', value: 'text/javascript'}]});
  const filter = filters.at(-1);
  if (result) {
    filter.ondata({data: new TextEncoder().encode(body).buffer});
    await filter.onstop();
  }
  return {result, filter};
};
const text = filter => new TextDecoder().decode(new Uint8Array(filter.written.flatMap(chunk => [...chunk])));

test('the loader filters the game module and the native workers, blocking', () => {
  expect(onHeaders.filter.urls).toEqual([
    'https://surfd.net/assets/game-*.js',
    'https://surfd.net/assets/checkpoint-speed.worker-*.js',
    'https://surfd.net/assets/ghost.worker-*.js',
    'https://surfd.net/assets/replay-index.worker-*.js'
  ]);
  expect(onHeaders.extra).toEqual(['blocking', 'responseHeaders']);
});

test('an unrecognised game build passes through unchanged and flags the badge', async () => {
  const {result, filter} = await respond('https://surfd.net/assets/game-test.js', 'not the game');
  expect(text(filter)).toBe('not the game');
  expect(filter.closed).toBe(true);
  expect(result.responseHeaders).toEqual([{name: 'Content-Type', value: 'text/javascript'}]);
  expect(badges.at(-1)).toEqual({tabId: 7, text: '!'});
  expect(sent.at(-1)[1].error).toBe(true);
});

test('a worker without a recognised hook is left as it is, silently', async () => {
  const before = badges.length;
  const {filter} = await respond('https://surfd.net/assets/ghost.worker-test.js', 'self.onmessage = () => {};');
  expect(text(filter)).toBe('self.onmessage = () => {};');
  expect(badges.length).toBe(before);
});

test('error responses are not filtered', async () => {
  const count = filters.length;
  expect((await respond('https://surfd.net/assets/game-test.js', 'gone', 404)).result).toBeUndefined();
  expect(filters.length).toBe(count);
});

test('connect requests from the game page are answered without attaching', () => {
  const answers = [];
  onMessage({type: 'surfd-qol-connect'}, {tab: {id: 7}, url: 'https://surfd.net/'}, answer => answers.push(answer));
  onMessage({type: 'surfd-qol-connect'}, {tab: {id: 7}, url: 'https://example.com/'}, answer => answers.push(answer));
  expect(answers).toEqual([{ok: true}]);
});
