import {expect, test} from 'bun:test';
import {CLOSE, GRACE_MS, MAX_GUESTS, MAX_MESSAGE, RATE_MESSAGES, RATE_WINDOW_MS, createRoom, hashKey, parseRequest, randomId, ROOM_ID} from '../signal/src/room.js';
import worker from '../signal/src/worker.js';

const KEY = 'a'.repeat(32), OTHER = 'b'.repeat(32), ROOM = 'p-abcdefghjkmn';
const request = (path, {origin = 'https://surfd.net', upgrade = 'websocket', method = 'GET'} = {}) =>
  new Request(`https://signal.example${path}`, {method, headers: {...origin ? {Origin: origin} : {}, ...upgrade ? {Upgrade: upgrade} : {}}});

// A Durable Object's worth of runtime: stored record, alarm, open sockets
// with their attachments, and a clock. restart() is a wake from hibernation.
function harness() {
  const world = {time: 1000, record: null, alarm: null, open: new Set()};
  let room;
  const restart = () => room = createRoom({
    record: structuredClone(world.record),
    save: record => { world.record = structuredClone(record); },
    wake: at => { world.alarm = at; },
    sockets: () => world.open,
    peerOf: socket => structuredClone(socket.peer),
    accept(socket, peer) { socket.peer = structuredClone(peer); world.open.add(socket); },
    refuse(socket, code, reason) { socket.closed = {code, reason}; },
    now: () => world.time,
  });
  restart();
  const socket = () => ({sent: [], closed: null,
    send(text) { this.sent.push(text); },
    close(code, reason) { this.closed = {code, reason}; world.open.delete(this); }});
  return {world, restart,
    connect(role, key = null) { const s = socket(); room.connect(s, {role, key}); return s; },
    // The peer's side closed; the runtime reports it.
    leave(s, code = 1006) { world.open.delete(s); room.disconnect(s, code); },
    say(s, value) { room.message(s, typeof value === 'string' ? value : JSON.stringify(value)); },
    raw(s, value) { room.message(s, value); },
    // The alarm fires at its time, or now when early.
    alarm(early = false) { if (!early) world.time = Math.max(world.time, world.alarm); room.alarm(); },
    // Everything a socket was sent since last asked.
    heard(s) { const messages = s.sent.map(text => text === 'pong' ? text : JSON.parse(text)); s.sent = []; return messages; },
  };
}
// A claimed room with n guests, their welcomes and the host's notices read.
function claimed(guests = 0) {
  const room = harness();
  const host = room.connect('host', KEY);
  const hostId = room.heard(host)[0].data.id;
  const list = Array.from({length: guests}, () => room.connect('guest'));
  const ids = list.map(guest => room.heard(guest)[0].data.id);
  room.heard(host);
  return {...room, host, hostId, guests: list, ids};
}

test('requests: only surfd.net WebSocket upgrades to well-formed rooms, with a role and a host key', () => {
  expect(parseRequest(request(`/rooms/${ROOM}?role=host&key=${KEY}`))).toEqual({roomId: ROOM, role: 'host', key: KEY});
  expect(parseRequest(request(`/rooms/${ROOM}?role=guest&key=x`))).toEqual({roomId: ROOM, role: 'guest', key: null});
  for (const id of ['p-abcdefghjkm', 'p-abcdefghjkmnp', 'q-abcdefghjkmn', 'p-ABCDEFGHJKMN', 'p-abcdefghjkm0', 'p-abcdefghjkmo', 'p-abcdefghjkm1', 'p-abcdefghjkml', 'p-abcdefghjkmi', 'p-abcdefghjk%20']) {
    expect(parseRequest(request(`/rooms/${id}?role=guest`)).status).toBe(404);
  }
  for (const path of ['/', '/rooms/', `/rooms/${ROOM}/x?role=guest`, `/room/${ROOM}?role=guest`]) expect(parseRequest(request(path)).status).toBe(404);
  for (const origin of [null, 'https://evil.example', 'http://surfd.net', 'https://www.surfd.net', 'https://surfd.net.evil.example', 'chrome-extension://abc']) {
    expect(parseRequest(request(`/rooms/${ROOM}?role=guest`, {origin}))).toEqual({status: 403, error: 'Origin not allowed'});
  }
  expect(parseRequest(request(`/rooms/${ROOM}?role=guest`, {upgrade: null})).status).toBe(426);
  expect(parseRequest(request(`/rooms/${ROOM}?role=guest`, {method: 'POST'})).status).toBe(426);
  for (const query of ['', '?role=host', `?role=host&key=${'a'.repeat(31)}`, `?role=host&key=${'A'.repeat(32)}`, `?role=admin&key=${KEY}`]) {
    expect(parseRequest(request(`/rooms/${ROOM}${query}`)).status).toBe(400);
  }
});

test('the Worker answers bad requests itself and sends good ones to the room named by the id', async () => {
  const asked = [];
  const env = {ROOMS: {idFromName: name => `id:${name}`, get: id => ({fetch: () => { asked.push(id); return new Response('room'); }})}};
  expect((await worker.fetch(request('/rooms/p-oooooooooo?role=guest'), env)).status).toBe(404);
  expect((await worker.fetch(request(`/rooms/${ROOM}?role=guest`, {origin: 'https://evil.example'}), env)).status).toBe(403);
  expect(asked).toEqual([]);
  expect(await (await worker.fetch(request(`/rooms/${ROOM}?role=guest`), env)).text()).toBe('room');
  expect(asked).toEqual([`id:${ROOM}`]);
});

test('ids and key hashes: unambiguous random ids, hashes that never echo the key', async () => {
  const ids = new Set(Array.from({length: 200}, () => randomId(12)));
  expect(ids.size).toBe(200);
  for (const id of ids) expect(ROOM_ID.test(`p-${id}`)).toBe(true);
  expect(randomId()).toHaveLength(8);
  expect(await hashKey(KEY)).toMatch(/^[0-9a-f]{64}$/);
  expect(await hashKey(KEY)).toBe(await hashKey(KEY));
  expect(await hashKey(KEY)).not.toBe(await hashKey(OTHER));
});

test('a host claims an empty room; a second claimant is refused and changes nothing', () => {
  const room = harness();
  const host = room.connect('host', KEY);
  const [welcome] = room.heard(host);
  expect(welcome).toEqual({type: 'welcome', data: {id: expect.any(String), peers: []}});
  expect(room.world.record).toEqual({host: welcome.data.id, conn: expect.any(String), key: KEY, goneAt: null});
  expect(room.world.alarm).toBeNull();
  const intruder = room.connect('host', OTHER);
  expect(intruder.closed).toEqual({code: CLOSE['room-taken'], reason: 'room-taken'});
  expect(intruder.sent).toEqual([]);
  expect(host.closed).toBeNull();
  const guest = room.connect('guest');
  expect(room.heard(host)).toEqual([{type: 'peer-joined', from: room.heard(guest)[0].data.id}]);
});

test('a guest before any host is told there is no room and closed', () => {
  const room = harness();
  const guest = room.connect('guest');
  expect(guest.closed).toEqual({code: CLOSE['no-room'], reason: 'no-room'});
  expect(room.world.open.size).toBe(0);
  expect(room.world.record).toBeNull();
});

test('the relay passes envelopes both ways and tells the host who joins and leaves', () => {
  const room = claimed(2);
  const [first, second] = room.guests;
  expect(room.ids[0]).not.toBe(room.ids[1]);
  room.say(first, {type: 'answer', data: {sdp: 'v=0'}});
  room.say(second, {to: room.hostId, type: 'candidate', data: {candidate: 'c'}});
  expect(room.heard(room.host)).toEqual([
    {from: room.ids[0], type: 'answer', data: {sdp: 'v=0'}},
    {from: room.ids[1], type: 'candidate', data: {candidate: 'c'}}]);
  room.say(room.host, {to: room.ids[1], type: 'offer', data: {sdp: 'v=0'}});
  expect(room.heard(second)).toEqual([{from: room.hostId, type: 'offer', data: {sdp: 'v=0'}}]);
  expect(room.heard(first)).toEqual([]);
  room.leave(first, 1001);
  expect(room.heard(room.host)).toEqual([{type: 'peer-left', from: room.ids[0]}]);
  // A reported error and close of the same socket count once.
  room.leave(first, 1006);
  expect(room.heard(room.host)).toEqual([]);
  room.say(room.host, {to: room.ids[0], type: 'offer'});
  expect(room.heard(room.host)).toEqual([{type: 'error', data: {code: 'no-peer', to: room.ids[0]}}]);
});

test('guests never reach each other, and nobody can send what only the relay sends', () => {
  const room = claimed(2);
  const [first, second] = room.guests;
  room.say(first, {to: room.ids[1], type: 'offer', data: 'x'});
  expect(room.heard(first)).toEqual([{type: 'error', data: {code: 'forbidden', to: room.ids[1]}}]);
  expect(room.heard(second)).toEqual([]);
  expect(room.heard(room.host)).toEqual([]);
  for (const type of ['welcome', 'peer-joined', 'peer-left', 'error']) room.say(first, {type});
  room.say(room.host, {to: room.ids[1], type: 'peer-left'});
  for (const bad of ['nope', '[]', 'null', '{"to":5,"type":"offer"}', '{"type":""}', `{"type":"${'x'.repeat(33)}"}`, '{"data":1}']) room.say(first, bad);
  room.raw(first, new Uint8Array([1, 2, 3]).buffer);
  expect(room.heard(first)).toEqual(Array(12).fill({type: 'error', data: {code: 'bad-message'}}));
  expect(room.heard(room.host)).toEqual([{type: 'error', data: {code: 'bad-message'}}]);
  expect(room.heard(second)).toEqual([]);
  // The host must name its guest.
  room.say(room.host, {type: 'offer'});
  expect(room.heard(room.host)).toEqual([{type: 'error', data: {code: 'no-peer', to: null}}]);
  room.say(first, 'ping');
  expect(room.heard(first)).toEqual(['pong']);
});

test('a dropped host keeps the room for its key: guests stay, an impostor is refused, the host returns', () => {
  const room = claimed(1);
  const [guest] = room.guests;
  room.leave(room.host, 1006);
  expect(room.world.record.goneAt).toBe(1000);
  expect(room.world.alarm).toBe(1000 + GRACE_MS);
  expect(guest.closed).toBeNull();
  room.say(guest, {type: 'answer'});
  expect(room.heard(guest)).toEqual([{type: 'error', data: {code: 'host-away'}}]);
  // A guest arriving meanwhile waits for the host's return.
  const late = room.connect('guest');
  const lateId = room.heard(late)[0].data.id;
  room.world.time += GRACE_MS - 1;
  expect(room.connect('host', OTHER).closed).toEqual({code: CLOSE['room-taken'], reason: 'room-taken'});
  const back = room.connect('host', KEY);
  expect(room.heard(back)).toEqual([{type: 'welcome', data: {id: room.hostId, peers: [room.ids[0], lateId]}}]);
  expect(room.world.record.goneAt).toBeNull();
  expect(room.world.alarm).toBeNull();
  room.say(guest, {type: 'answer'});
  expect(room.heard(back)).toEqual([{from: room.ids[0], type: 'answer'}]);
  room.say(back, {to: lateId, type: 'offer'});
  expect(room.heard(late)).toEqual([{from: room.hostId, type: 'offer'}]);
});

test('a host reconnecting before its old socket is noticed replaces it', () => {
  const room = claimed(1);
  const [guest] = room.guests;
  const back = room.connect('host', KEY);
  expect(room.host.closed).toEqual({code: CLOSE.replaced, reason: 'replaced'});
  expect(room.heard(back)[0].data).toEqual({id: room.hostId, peers: [room.ids[0]]});
  // The old socket's close arrives later and must not mark the host away.
  room.leave(room.host, 1006);
  room.say(room.host, {to: room.ids[0], type: 'stale'});
  expect(room.world.record.goneAt).toBeNull();
  expect(room.heard(guest)).toEqual([]);
  room.say(guest, {type: 'answer'});
  expect(room.heard(back)).toEqual([{from: room.ids[0], type: 'answer'}]);
});

test('a host that says goodbye ends the room at once', () => {
  const room = claimed(2);
  room.leave(room.host, 1000);
  for (const guest of room.guests) expect(guest.closed).toEqual({code: CLOSE['room-closed'], reason: 'room-closed'});
  expect(room.world.record).toBeNull();
  expect(room.world.alarm).toBeNull();
  expect(room.connect('guest').closed.reason).toBe('no-room');
});

test('a room evaporates once its host has been gone past the grace period', () => {
  const room = claimed(2);
  room.leave(room.host);
  room.alarm();
  for (const guest of room.guests) expect(guest.closed).toEqual({code: CLOSE['room-closed'], reason: 'room-closed'});
  expect(room.world.record).toBeNull();
  expect(room.world.alarm).toBeNull();
  expect(room.connect('guest').closed.reason).toBe('no-room');
  // The id is free again: whoever claims it gets a new, empty room.
  const next = room.connect('host', OTHER);
  expect(room.heard(next)[0].data.peers).toEqual([]);
});

test('expiry does not wait for a late alarm, and an early alarm is set again', () => {
  const room = claimed(1);
  room.leave(room.host);
  room.world.time += GRACE_MS - 5;
  room.world.alarm = null;
  room.alarm(true);
  expect(room.world.record).not.toBeNull();
  expect(room.world.alarm).toBe(1000 + GRACE_MS);
  room.world.time = 1000 + GRACE_MS;
  // No alarm ran, but the room is over when the old host comes back.
  const back = room.connect('host', KEY);
  expect(room.guests[0].closed.reason).toBe('room-closed');
  expect(room.heard(back)[0].data.id).not.toBe(room.hostId);
});

test('a room holds MAX_GUESTS guests on the meeting point at once and refuses more until one leaves', () => {
  const room = claimed(MAX_GUESTS);
  const extra = room.connect('guest');
  expect(extra.closed).toEqual({code: CLOSE['room-full'], reason: 'room-full'});
  expect(room.heard(room.host)).toEqual([]);
  // The runtime may still list a leaving socket while its close completes.
  room.leave(room.guests[0]);
  room.world.open.add(room.guests[0]);
  const next = room.connect('guest');
  expect(next.closed).toBeNull();
  expect(room.heard(room.host)).toEqual([{type: 'peer-left', from: room.ids[0]}, {type: 'peer-joined', from: room.heard(next)[0].data.id}]);
  expect(room.connect('guest').closed.reason).toBe('room-full');
});

test('messages over 16 KB close the sender, counting UTF-8 bytes', () => {
  const room = claimed(1);
  const [guest] = room.guests;
  const largest = JSON.stringify({type: 'offer', data: 'x'.repeat(MAX_MESSAGE - 26)});
  expect(largest).toHaveLength(MAX_MESSAGE);
  room.say(guest, largest);
  expect(room.heard(room.host)).toHaveLength(1);
  // Half as many characters, but each takes two bytes.
  room.say(guest, JSON.stringify({type: 'offer', data: 'é'.repeat(MAX_MESSAGE / 2)}));
  expect(guest.closed).toEqual({code: CLOSE['too-large'], reason: 'too-large'});
  expect(room.heard(room.host)).toEqual([{type: 'peer-left', from: room.ids[0]}]);
  room.raw(room.host, new Uint8Array(MAX_MESSAGE + 1).buffer);
  expect(room.host.closed.reason).toBe('too-large');
  expect(room.world.record.goneAt).toBe(room.world.time);
});

test('relay reply floods disconnect only the targeted guest', () => {
  const room = claimed(2);
  const [attacker, other] = room.guests;
  const send = room.host.send.bind(room.host);
  room.host.send = text => {
    send(text);
    const message = JSON.parse(text);
    if (message.type === 'room-info') room.say(room.host, {to: message.from, type: 'room-info', data: {id: ROOM}});
  };
  for (let i = 0; i < RATE_MESSAGES; i++) room.say(attacker, {type: 'room-info', data: null});
  expect(room.host.closed).toBeNull();
  expect(attacker.closed).toBeNull();
  room.say(room.host, {to: room.ids[0], type: 'room-info', data: {id: ROOM}});
  expect(attacker.closed).toEqual({code: CLOSE['rate-limited'], reason: 'rate-limited'});
  room.say(room.host, {to: room.ids[1], type: 'answer', data: {sdp: 'answer'}});
  expect(room.heard(other)).toEqual([{from: room.hostId, type: 'answer', data: {sdp: 'answer'}}]);
  expect(room.host.closed).toBeNull();
  expect(room.world.record.goneAt).toBeNull();
});

test('guest message budgets reset after ten seconds', () => {
  const room = claimed(2);
  const [guest, other] = room.guests;
  for (let i = 0; i < RATE_MESSAGES; i++) room.say(guest, {type: 'candidate'});
  room.say(guest, {type: 'candidate'});
  expect(guest.closed).toEqual({code: CLOSE['rate-limited'], reason: 'rate-limited'});
  for (let i = 0; i < RATE_MESSAGES; i++) room.say(other, {type: 'candidate'});
  room.world.time += RATE_WINDOW_MS;
  room.say(other, {type: 'candidate'});
  expect(other.closed).toBeNull();
  expect(room.host.closed).toBeNull();
});

test('a room woken from hibernation carries on from its record and sockets', () => {
  const room = claimed(1);
  const [guest] = room.guests;
  room.restart();
  room.say(guest, {type: 'answer'});
  room.say(room.host, {to: room.ids[0], type: 'offer'});
  expect(room.heard(room.host)).toEqual([{from: room.ids[0], type: 'answer'}]);
  expect(room.heard(guest)).toEqual([{from: room.hostId, type: 'offer'}]);
  room.leave(room.host);
  room.restart();
  expect(room.connect('host', OTHER).closed.reason).toBe('room-taken');
  const back = room.connect('host', KEY);
  expect(room.heard(back)[0].data).toEqual({id: room.hostId, peers: [room.ids[0]]});
  room.leave(back);
  room.restart();
  room.alarm();
  expect(guest.closed.reason).toBe('room-closed');
  expect(room.world.record).toBeNull();
});

test('a listing is an ordinary message: the host must name a guest, a guest sends it to the host', () => {
  const room = claimed(1);
  const data = {name: 'Room', mapId: 'surf_utopia', mapTitle: 'Utopia', players: 3};
  room.say(room.host, {type: 'listing', data});
  expect(room.heard(room.host)).toEqual([{type: 'error', data: {code: 'no-peer', to: null}}]);
  room.say(room.guests[0], {type: 'listing', data});
  expect(room.heard(room.host)).toEqual([{from: room.ids[0], type: 'listing', data}]);
});
