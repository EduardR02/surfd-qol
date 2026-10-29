import {expect, test} from 'bun:test';
import {Lobby, Room} from '../signal/src/worker.js';
import {RATE_MESSAGES} from '../signal/src/room.js';

const ROOM = 'p-abcdefghjkmn';
const listing = {name: "Host's room", mapId: 'surf_utopia', players: 1, capacity: 16};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const lobbyBinding = fetch => ({idFromName: name => name, get: () => ({fetch})});

async function roomHarness() {
  const original = globalThis.WebSocketRequestResponsePair;
  globalThis.WebSocketRequestResponsePair = class {};
  const requests = [], pending = [], open = new Set();
  let ready;
  const ctx = {
    setWebSocketAutoResponse() {},
    blockConcurrencyWhile(callback) { ready = callback(); },
    storage: {get: async () => null, put() {}, deleteAll() {}, deleteAlarm() {}, setAlarm() {}},
    getWebSockets: () => [...open],
    acceptWebSocket(socket) { open.add(socket); },
    waitUntil(promise) { pending.push(promise); },
  };
  let room;
  try {
    room = new Room(ctx, {LOBBY: lobbyBinding((url, options) => {
      const response = deferred();
      requests.push({url, ...options, ...response});
      return response.promise;
    })});
    await ready;
  } finally {
    if (original === undefined) delete globalThis.WebSocketRequestResponsePair;
    else globalThis.WebSocketRequestResponsePair = original;
  }
  const host = {readyState: 1, send() {}, close() { this.readyState = 3; },
    serializeAttachment(peer) { this.peer = peer; }, deserializeAttachment() { return this.peer; }};
  room.room.connect(host, {role: 'host', roomId: ROOM});
  await room.webSocketMessage(host, JSON.stringify({type: 'auth', key: 'a'.repeat(32)}));
  return {room, host, requests, pending,
    publish(data) { room.webSocketMessage(host, JSON.stringify({type: 'listing', data})); }};
}

for (const end of ['private', 'closed']) test(`unlisting stays last when a room becomes ${end}`, async () => {
  const fixture = await roomHarness();
  fixture.publish(listing);
  await Promise.resolve();
  expect(fixture.requests.map(request => request.method)).toEqual(['PUT']);
  if (end === 'private') fixture.publish(null);
  else fixture.room.webSocketClose(fixture.host, 1000);
  await Promise.resolve();
  expect(fixture.requests).toHaveLength(1);
  fixture.requests[0].resolve(new Response(null, {status: 204}));
  await Promise.resolve();
  expect(fixture.requests.map(request => request.method)).toEqual(['PUT', 'DELETE']);
  fixture.requests[1].resolve(new Response(null, {status: 204}));
  await Promise.all(fixture.pending);
});

test('failed listing does not block unlisting', async () => {
  const fixture = await roomHarness();
  fixture.publish(listing);
  await Promise.resolve();
  fixture.publish(null);
  await Promise.resolve();
  fixture.requests[0].reject(new Error('network failure'));
  await Promise.resolve();
  expect(fixture.requests.map(request => request.method)).toEqual(['PUT', 'DELETE']);
  fixture.requests[1].resolve(new Response(null, {status: 204}));
  await Promise.all(fixture.pending);
});

test('slow publication coalesces a burst to its final unlisting', async () => {
  const fixture = await roomHarness();
  fixture.publish(listing);
  await Promise.resolve();
  for (let players = 2; players < 42; players++) fixture.publish({...listing, players});
  fixture.publish(null);
  await Promise.resolve();
  expect(fixture.requests.map(request => request.method)).toEqual(['PUT']);
  expect(fixture.pending).toHaveLength(1);
  fixture.requests[0].resolve(new Response(null, {status: 204}));
  await Promise.resolve();
  expect(fixture.requests.map(request => request.method)).toEqual(['PUT', 'DELETE']);
  fixture.requests[1].resolve(new Response(null, {status: 204}));
  await Promise.all(fixture.pending);
  expect(fixture.requests).toHaveLength(2);

  fixture.publish({...listing, players: 3});
  await Promise.resolve();
  expect(fixture.requests.map(request => request.method)).toEqual(['PUT', 'DELETE', 'PUT']);
  fixture.requests[2].resolve(new Response(null, {status: 204}));
  await Promise.all(fixture.pending);
});

test('a private transition unlists after a rename and capacity flood', async () => {
  const entries = new Map();
  let ready;
  const lobby = new Lobby({
    blockConcurrencyWhile(callback) { ready = callback(); },
    storage: {list: async () => entries, put: (id, entry) => entries.set(id, entry), delete: id => entries.delete(id)},
  }, {});
  await ready;
  const apply = request => lobby.fetch(new Request(request.url, {method: request.method, body: request.body}));
  const fixture = await roomHarness();
  fixture.publish(listing);
  await Promise.resolve();
  for (let index = 1; index < RATE_MESSAGES; index++) {
    fixture.publish({...listing, name: `Practice ${index}`, capacity: index % 2 ? 2 : 64});
  }
  fixture.publish(null);
  fixture.requests[0].resolve(await apply(fixture.requests[0]));
  await Promise.resolve();
  expect(fixture.requests.map(request => request.method)).toEqual(['PUT', 'DELETE']);
  fixture.requests[1].resolve(await apply(fixture.requests[1]));
  await Promise.all(fixture.pending);
  expect(await (await lobby.fetch(new Request('https://lobby/rooms'))).json()).toEqual({rooms: []});
});

test('Worker publication drops malformed guest claims and local-only roster fields', async () => {
  const fixture = await roomHarness();
  const userId = '123e4567-e89b-12d3-a456-426614174000';
  fixture.publish({...listing, roster: [
    {name: 'MemberName', guest: true, you: true},
    {name: 'Guest_abcde', guest: true, userId},
    {name: 'Guest_123ab', guest: true, you: true},
    {name: 'MemberName', guest: false, userId, you: true, connectionId: userId},
  ]});
  await Promise.resolve();
  expect(JSON.parse(fixture.requests[0].body).listing.roster).toEqual([
    {name: 'Guest_123ab', guest: true},
    {name: 'MemberName', guest: false, userId},
  ]);
  fixture.requests[0].resolve(new Response(null, {status: 204}));
  await Promise.all(fixture.pending);
});
