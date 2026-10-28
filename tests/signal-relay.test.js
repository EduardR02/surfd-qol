import {expect, spyOn, test} from 'bun:test';
import {RELAY_TTL, RELAY_TIMEOUT_MS, createRelay, turnServers} from '../signal/src/relay.js';
import {CLOSE, RELAY, createRoom} from '../signal/src/room.js';
import {RELAYS} from '../signal/src/limits.js';
import {Room} from '../signal/src/worker.js';

const KEY = 'a'.repeat(32), ROOM = 'p-abcdefghjkmn';
const ENV = {RELAY: 'on', TURN_KEY_ID: 'key-id-123', TURN_KEY_API_TOKEN: 'secret-token-456'};
const TURN = {
  urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp',
    'turn:turn.cloudflare.com:3478?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'],
  username: 'user-1', credential: 'credential-1'};
// Cloudflare's documented 201 answer.
const answer = () => new Response(JSON.stringify({iceServers: [{urls: ['stun:stun.cloudflare.com:3478']}, TURN]}), {status: 201});
const ISSUED = {iceServers: [{...TURN, urls: TURN.urls.filter(url => !url.includes(':53?'))}], ttl: RELAY_TTL};
const reserve = async () => ({issueBy: Date.now() + RELAY_TIMEOUT_MS});

function cloudflare(respond = answer) {
  const calls = [];
  return {calls, fetch: async (url, options) => { calls.push({url, ...options}); return respond(); }};
}

test('credentials come from the documented endpoint with the TURN key and one-hour TTL', async () => {
  const api = cloudflare();
  const issue = createRelay({env: ENV, allow: () => true, reserve, fetch: api.fetch});
  expect(await issue('203.0.113.7')).toEqual(ISSUED);
  expect(api.calls).toHaveLength(1);
  const [call] = api.calls;
  expect(call.url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key-id-123/credentials/generate-ice-servers');
  expect(call.method).toBe('POST');
  expect(call.headers).toEqual({Authorization: 'Bearer secret-token-456', 'Content-Type': 'application/json'});
  expect(JSON.parse(call.body)).toEqual({ttl: RELAY_TTL});
  expect(RELAY_TTL).toBe(60 * 60);
  expect(call.signal).toBeInstanceOf(AbortSignal);
});

test('only TURN servers are passed on, without port 53 or malformed entries', () => {
  expect(turnServers({iceServers: [
    {urls: 'stun:stun.cloudflare.com:3478'},
    {urls: 'turn:turn.cloudflare.com:3478?transport=udp', username: 'u', credential: 'c'},
    {urls: ['turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'], username: 'u', credential: 'c'},
    {urls: ['turn:turn.cloudflare.com:53'], username: 'u', credential: 'c'},
    {urls: ['turn:x:3478'], username: 'u'}, null, 'turn:x',
  ]})).toEqual([
    {urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c'},
    {urls: ['turns:turn.cloudflare.com:5349?transport=tcp'], username: 'u', credential: 'c'}]);
  for (const body of [null, {}, {iceServers: 'x'}, {iceServers: [{urls: ['stun:x']}]}]) expect(turnServers(body)).toEqual([]);
});

test('nothing is issued while RELAY is off, without the secrets, or past the client limit', async () => {
  for (const env of [{...ENV, RELAY: 'off'}, {...ENV, RELAY: undefined}, {...ENV, TURN_KEY_ID: undefined}, {...ENV, TURN_KEY_API_TOKEN: ''}]) {
    const api = cloudflare();
    expect(await createRelay({env, allow: () => true, reserve, fetch: api.fetch})('a')).toBeNull();
    expect(api.calls).toEqual([]);
  }
  const api = cloudflare(), asked = [];
  expect(await createRelay({env: ENV, allow: client => { asked.push(client); return false; }, reserve, fetch: api.fetch})('a')).toBeNull();
  expect(asked).toEqual(['a']);
  expect(api.calls).toEqual([]);
});

test('a failed or unexpected answer issues nothing and is never logged', async () => {
  const logs = ['log', 'warn', 'error', 'info', 'debug'].map(method => spyOn(console, method).mockImplementation(() => {}));
  try {
    for (const respond of [
      () => new Response('nope', {status: 401}),
      () => new Response('{', {status: 201}),
      () => new Response(JSON.stringify({iceServers: [{urls: ['stun:stun.cloudflare.com:3478']}]}), {status: 201}),
      () => { throw new Error(`fetch https://rtc.live.cloudflare.com/v1/turn/keys/${ENV.TURN_KEY_ID} with ${ENV.TURN_KEY_API_TOKEN} failed`); },
    ]) {
      expect(await createRelay({env: ENV, allow: () => true, reserve, fetch: cloudflare(respond).fetch})('a')).toBeNull();
    }
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally { for (const log of logs) log.mockRestore(); }
});

// A room's relay with sockets and a stand-in for relay.js.
async function room(issue) {
  const open = new Set(), asked = [];
  let record = null;
  const relay = createRoom({
    save: value => { record = value; }, wake() {}, sockets: () => open, peerOf: socket => socket.peer,
    accept(socket, peer) { socket.peer = peer; open.add(socket); }, attach(socket, peer) { socket.peer = peer; },
    refuse(socket, code, reason) { socket.closed = {code, reason}; },
    relay: client => { asked.push(client); return issue(client); },
  });
  const socket = () => ({sent: [], closed: null, send(text) { this.sent.push(JSON.parse(text)); },
    close(code, reason) { this.closed = {code, reason}; open.delete(this); }});
  const connect = (role, client) => { const s = socket(); relay.connect(s, {role, client, roomId: ROOM}); return s; };
  const host = connect('host', 'host-client');
  return {relay, asked, host, connect, record: () => record,
    say: (s, value) => relay.message(s, JSON.stringify(value)),
    heard(s) { const messages = s.sent; s.sent = []; return messages; }};
}

test('a host gets credentials once it has proved its key, and a guest of a live room', async () => {
  const r = await room(async () => ISSUED);
  await r.say(r.host, {type: RELAY});
  expect(r.host.closed).toEqual({code: CLOSE.unauthorized, reason: 'unauthorized'});
  expect(r.asked).toEqual([]);
  expect(r.connect('guest', 'early').closed.reason).toBe('no-room');

  const s = await room(async () => ISSUED);
  await s.say(s.host, {type: 'auth', key: KEY});
  s.heard(s.host);
  await s.say(s.host, {type: RELAY, data: null});
  expect(s.heard(s.host)).toEqual([{type: RELAY, data: ISSUED}]);
  const guest = s.connect('guest', 'guest-client');
  s.heard(guest); s.heard(s.host);
  await s.say(guest, {type: RELAY});
  expect(s.heard(guest)).toEqual([{type: RELAY, data: ISSUED}]);
  expect(s.asked).toEqual(['host-client', 'guest-client']);
  // Neither the request nor the answer ever reaches another peer.
  await s.say(s.host, {to: s.record().host, type: RELAY});
  await s.say(guest, {to: s.record().host, type: RELAY});
  expect(s.heard(s.host)).toEqual([{type: RELAY, data: ISSUED}]);
  expect(s.heard(guest)).toEqual([{type: RELAY, data: ISSUED}]);
});

test('a refused request gets no-relay, and a socket waits for one answer before asking again', async () => {
  let release;
  const r = await room(() => new Promise(resolve => { release = resolve; }));
  await r.say(r.host, {type: 'auth', key: KEY});
  r.heard(r.host);
  const pending = r.say(r.host, {type: RELAY});
  r.say(r.host, {type: RELAY});
  expect(r.asked).toHaveLength(1);
  release(null);
  await pending;
  expect(r.heard(r.host)).toEqual([{type: 'error', data: {code: 'no-relay'}}]);
  const guest = r.connect('guest', 'g');
  const asking = r.say(guest, {type: RELAY});
  r.relay.disconnect(guest, 1000);
  release(ISSUED);
  await asking;
  expect(r.heard(guest).filter(message => message.type !== 'welcome')).toEqual([]);
});

test('the room object issues credentials through Cloudflare under the per-client limit', async () => {
  const original = globalThis.WebSocketRequestResponsePair;
  globalThis.WebSocketRequestResponsePair = class {};
  const calls = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => { calls.push({url, ...options}); return answer(); });
  try {
    const open = new Set();
    let ready;
    const ctx = {setWebSocketAutoResponse() {}, blockConcurrencyWhile(callback) { ready = callback(); },
      storage: {get: async () => null, put() {}, deleteAll() {}, setAlarm() {}, deleteAlarm() {}},
      getWebSockets: () => [...open], acceptWebSocket(socket) { open.add(socket); }, waitUntil() {}};
    const reservations = [];
    const object = new Room(ctx, {...ENV, LOBBY: {
      idFromName(name) { expect(name).toBe('lobby'); return name; },
      get(id) {
        expect(id).toBe('lobby');
        return {async fetch(url, options) {
          if (url !== 'https://lobby/relay-reservation') return new Response(null, {status: 204});
          expect(options.method).toBe('POST');
          reservations.push(url);
          return Response.json(await reserve(), {status: 201});
        }};
      },
    }});
    await ready;
    const socket = () => ({readyState: 1, sent: [], send(text) { this.sent.push(JSON.parse(text)); }, close() { this.readyState = 3; },
      serializeAttachment(peer) { this.peer = structuredClone(peer); }, deserializeAttachment() { return structuredClone(this.peer); }});
    const host = socket();
    object.room.connect(host, {role: 'host', client: '198.51.100.250', roomId: ROOM});
    await object.webSocketMessage(host, JSON.stringify({type: 'auth', key: KEY}));
    for (let i = 0; i < RELAYS.burst; i++) await object.webSocketMessage(host, JSON.stringify({type: RELAY}));
    await object.webSocketMessage(host, JSON.stringify({type: RELAY}));
    const answers = host.sent.filter(message => message.type !== 'welcome');
    expect(answers.slice(0, RELAYS.burst)).toEqual(Array(RELAYS.burst).fill({type: RELAY, data: ISSUED}));
    expect(answers.at(-1)).toEqual({type: 'error', data: {code: 'no-relay'}});
    expect(calls).toHaveLength(RELAYS.burst);
    expect(reservations).toHaveLength(RELAYS.burst);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${ENV.TURN_KEY_API_TOKEN}`);
    expect(JSON.stringify(host.sent)).not.toContain(ENV.TURN_KEY_API_TOKEN);
    expect(JSON.stringify(host.sent)).not.toContain(ENV.TURN_KEY_ID);
  } finally {
    fetch.mockRestore();
    if (original === undefined) delete globalThis.WebSocketRequestResponsePair;
    else globalThis.WebSocketRequestResponsePair = original;
  }
});

test('missing, denied, failed and expired reservations never call the provider', async () => {
  for (const reserve of [
    undefined, async () => null, async () => false, async () => ({}),
    async () => ({issueBy: '5000'}), async () => ({issueBy: 1000}),
    async () => { throw new Error('Storage unavailable'); },
  ]) {
    const api = cloudflare();
    const issue = createRelay({env: ENV, allow: () => true, reserve, fetch: api.fetch, now: () => 1000});
    expect(await issue('a')).toBeNull();
    expect(api.calls).toEqual([]);
  }
});

test('the provider waits for a committed reservation and uses its remaining issuance window', async () => {
  let commit;
  const api = cloudflare(), pending = new Promise(resolve => { commit = resolve; });
  const issue = createRelay({env: ENV, allow: () => true, reserve: () => pending, fetch: api.fetch, now: () => 1000});
  const issuing = issue('a');
  expect(api.calls).toEqual([]);
  commit({issueBy: 2000});
  expect(await issuing).toEqual(ISSUED);
  expect(api.calls).toHaveLength(1);
});

test('provider responses after the reserved issuance window are not handed to clients', async () => {
  let at = 1000;
  const api = cloudflare(() => { at = 2000; return answer(); });
  const issue = createRelay({env: ENV, allow: () => true, reserve: async () => ({issueBy: 2000}), fetch: api.fetch, now: () => at});
  expect(await issue('a')).toBeNull();
  expect(api.calls).toHaveLength(1);
});
