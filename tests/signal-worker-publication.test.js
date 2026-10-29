import {expect, test} from 'bun:test';
import {Room} from '../signal/src/worker.js';

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
