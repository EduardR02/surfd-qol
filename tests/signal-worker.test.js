import {expect, test} from 'bun:test';
import {Room} from '../signal/src/worker.js';
import {CLOSE, hashKey} from '../signal/src/room.js';

const KEY = 'a'.repeat(32);

// The Room Durable Object over a fake ctx: storage, alarm and hibernatable sockets.
async function durableObject() {
  const original = globalThis.WebSocketRequestResponsePair;
  globalThis.WebSocketRequestResponsePair = class {};
  const open = new Set(), stored = new Map(), state = {alarm: null};
  let ready;
  const ctx = {
    setWebSocketAutoResponse() {},
    blockConcurrencyWhile(callback) { ready = callback(); },
    storage: {
      get: async key => stored.get(key), put(key, value) { stored.set(key, structuredClone(value)); }, deleteAll() { stored.clear(); },
      setAlarm(at) { state.alarm = at; }, deleteAlarm() { state.alarm = null; },
    },
    getWebSockets: () => [...open],
    acceptWebSocket(socket) { open.add(socket); },
  };
  let object;
  try {
    object = new Room(ctx);
    await ready;
  } finally {
    if (original === undefined) delete globalThis.WebSocketRequestResponsePair;
    else globalThis.WebSocketRequestResponsePair = original;
  }
  const socket = () => ({readyState: 1, sent: [], closed: null,
    send(text) { this.sent.push(text); },
    close(code, reason) { this.closed = {code, reason}; this.readyState = 3; },
    serializeAttachment(peer) { this.attachment = structuredClone(peer); },
    deserializeAttachment() { return structuredClone(this.attachment); }});
  return {object, stored, state, socket};
}

test('the room object holds a new host in its socket attachment until its key arrives, then stores only its hash', async () => {
  const {object, stored, state, socket} = await durableObject();
  const host = socket();
  object.room.connect(host, {role: 'host'});
  expect(host.attachment).toEqual({role: 'host', conn: expect.any(String), authBy: state.alarm});
  expect(stored.size).toBe(0);
  await object.webSocketMessage(host, JSON.stringify({type: 'auth', key: KEY}));
  const [welcome] = host.sent.map(text => JSON.parse(text));
  expect(host.attachment).toEqual({id: welcome.data.id, role: 'host', conn: host.attachment.conn});
  expect(stored.get('room')).toEqual({host: welcome.data.id, conn: host.attachment.conn, key: await hashKey(KEY), goneAt: null});
  expect(JSON.stringify([...stored.values()])).not.toContain(KEY);
  expect(state.alarm).toBeNull();
  const intruder = socket();
  object.room.connect(intruder, {role: 'host'});
  await object.webSocketMessage(intruder, JSON.stringify({type: 'auth', key: 'b'.repeat(32)}));
  expect(intruder.closed).toEqual({code: CLOSE['room-taken'], reason: 'room-taken'});
});
