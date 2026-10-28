import {expect, test} from 'bun:test';
import {AUTH_MS, CLOSE, GRACE_MS, MAX_GUESTS, MAX_GUESTS_PER_CLIENT, MAX_MESSAGE, RATE_MESSAGES, RATE_WINDOW_MS, TOMBSTONE_MS, createRoom, hashKey, parseRequest, randomId, ROOM_ID} from '../signal/src/room.js';
import worker from '../signal/src/worker.js';
import {CONNECTIONS, MESSAGES, createLimiter} from '../signal/src/limits.js';

const KEY = 'a'.repeat(32), OTHER = 'b'.repeat(32), ROOM = 'p-abcdefghjkmn';
const HASH = await hashKey(KEY), OTHER_HASH = await hashKey(OTHER);
const request = (path, {origin = 'https://surfd.net', upgrade = 'websocket', method = 'GET'} = {}) =>
  new Request(`https://signal.example${path}`, {method, headers: {...origin ? {Origin: origin} : {}, ...upgrade ? {Upgrade: upgrade} : {}}});

// A Durable Object's worth of runtime: stored record, alarm, open sockets
// with their attachments, and a clock. restart() is a wake from hibernation.
// Each socket is its own client unless told otherwise.
function harness({allowClient} = {}) {
  const world = {time: 1000, record: null, alarm: null, open: new Set(), published: []};
  let room, clients = 0;
  const restart = () => room = createRoom({
    record: structuredClone(world.record),
    save: record => { world.record = structuredClone(record); },
    wake: at => { world.alarm = at; },
    sockets: () => world.open,
    peerOf: socket => structuredClone(socket.peer),
    accept(socket, peer) { socket.peer = structuredClone(peer); world.open.add(socket); },
    attach(socket, peer) { socket.peer = structuredClone(peer); },
    refuse(socket, code, reason) { socket.closed = {code, reason}; },
    allowClient,
    publish(...args) { world.published.push(args); },
    now: () => world.time,
  });
  restart();
  const socket = () => ({sent: [], closed: null,
    send(text) { this.sent.push(text); },
    close(code, reason) { this.closed = {code, reason}; world.open.delete(this); }});
  const harnessed = {world, restart,
    connect(role, client = `client-${++clients}`) { const s = socket(); room.connect(s, {role, client, roomId: ROOM}); return s; },
    // A host connects and sends its key first.
    async claim(key = KEY, client) {
      const s = harnessed.connect('host', client);
      await harnessed.say(s, {type: 'auth', key});
      return s;
    },
    // The peer's side closed; the runtime reports it.
    leave(s, code = 1006) { world.open.delete(s); room.disconnect(s, code); },
    say(s, value) { return room.message(s, typeof value === 'string' ? value : JSON.stringify(value)); },
    raw(s, value) { return room.message(s, value); },
    // The alarm fires at its time, or now when early.
    alarm(early = false) { if (!early) world.time = Math.max(world.time, world.alarm); room.alarm(); },
    // Everything a socket was sent since last asked.
    heard(s) { const messages = s.sent.map(text => text === 'pong' ? text : JSON.parse(text)); s.sent = []; return messages; },
  };
  return harnessed;
}
// A claimed room with n guests, their welcomes and the host's notices read.
async function claimed(guests = 0, options) {
  const room = harness(options);
  const host = await room.claim(KEY);
  const hostId = room.heard(host)[0].data.id;
  const list = Array.from({length: guests}, () => room.connect('guest'));
  const ids = list.map(guest => room.heard(guest)[0].data.id);
  room.heard(host);
  return {...room, host, hostId, guests: list, ids};
}

test('requests: only surfd.net WebSocket upgrades to well-formed rooms, as a guest or a host', () => {
  expect(parseRequest(request(`/rooms/${ROOM}?role=host`))).toEqual({roomId: ROOM, role: 'host'});
  expect(parseRequest(request(`/rooms/${ROOM}?role=guest&key=x`))).toEqual({roomId: ROOM, role: 'guest'});
  for (const id of ['p-abcdefghjkm', 'p-abcdefghjkmnp', 'q-abcdefghjkmn', 'p-ABCDEFGHJKMN', 'p-abcdefghjkm0', 'p-abcdefghjkmo', 'p-abcdefghjkm1', 'p-abcdefghjkml', 'p-abcdefghjkmi', 'p-abcdefghjk%20']) {
    expect(parseRequest(request(`/rooms/${id}?role=guest`)).status).toBe(404);
  }
  for (const path of ['/', '/rooms', '/rooms/', `/rooms/${ROOM}/x?role=guest`, `/room/${ROOM}?role=guest`]) expect(parseRequest(request(path)).status).toBe(404);
  for (const origin of [null, 'https://evil.example', 'http://surfd.net', 'https://www.surfd.net', 'https://surfd.net.evil.example', 'chrome-extension://abc']) {
    expect(parseRequest(request(`/rooms/${ROOM}?role=guest`, {origin}))).toEqual({status: 403, error: 'Origin not allowed'});
  }
  expect(parseRequest(request(`/rooms/${ROOM}?role=guest`, {upgrade: null})).status).toBe(426);
  expect(parseRequest(request(`/rooms/${ROOM}?role=guest`, {method: 'POST'})).status).toBe(426);
  for (const query of ['', '?role=', `?role=admin&key=${KEY}`]) expect(parseRequest(request(`/rooms/${ROOM}${query}`)).status).toBe(400);
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
  expect(HASH).toMatch(/^[0-9a-f]{64}$/);
  expect(await hashKey(KEY)).toBe(HASH);
  expect(HASH).not.toBe(OTHER_HASH);
});

test('a host claims an empty room; a second claimant is refused and changes nothing', async () => {
  const room = harness();
  const host = await room.claim(KEY);
  const [welcome] = room.heard(host);
  expect(welcome).toEqual({type: 'welcome', data: {id: expect.any(String), peers: []}});
  expect(room.world.record).toEqual({host: welcome.data.id, conn: expect.any(String), key: HASH, goneAt: null, roomId: ROOM});
  expect(room.world.alarm).toBeNull();
  const intruder = await room.claim(OTHER);
  expect(intruder.closed).toEqual({code: CLOSE['room-taken'], reason: 'room-taken'});
  expect(intruder.sent).toEqual([]);
  expect(host.closed).toBeNull();
  const guest = room.connect('guest');
  expect(room.heard(host)).toEqual([{type: 'peer-joined', from: room.heard(guest)[0].data.id}]);
});

test('a host must send its key first: anything else is refused and claims nothing', async () => {
  for (const first of ['ping', 'nope', {type: 'offer', key: KEY}, {type: 'auth'}, {type: 'auth', key: 'a'.repeat(31)},
    {type: 'auth', key: 'A'.repeat(32)}, {type: 'auth', key: ['a'.repeat(32)]}, {type: 'auth', key: KEY, pad: 'x'.repeat(MAX_MESSAGE)}]) {
    const room = harness();
    const host = room.connect('host');
    expect(host.closed).toBeNull();
    await room.say(host, first);
    expect(host.closed).toEqual({code: CLOSE.unauthorized, reason: 'unauthorized'});
    expect(host.sent).toEqual([]);
    expect(room.world.record).toBeNull();
    expect(room.connect('guest').closed.reason).toBe('no-room');
  }
  const room = harness();
  const host = room.connect('host');
  await room.raw(host, new Uint8Array(32).buffer);
  expect(host.closed.reason).toBe('unauthorized');
});

test('a host has AUTH_MS to send its key, and what it sends while the key is checked is dropped', async () => {
  const room = harness();
  const silent = room.connect('host');
  expect(room.world.alarm).toBe(1000 + AUTH_MS);
  room.world.time += 1000;
  const late = room.connect('host');
  expect(room.world.alarm).toBe(1000 + AUTH_MS);
  room.alarm();
  expect(silent.closed).toEqual({code: CLOSE.unauthorized, reason: 'unauthorized'});
  expect(late.closed).toBeNull();
  expect(room.world.alarm).toBe(2000 + AUTH_MS);
  room.world.time = 2000 + AUTH_MS;
  await room.say(late, {type: 'auth', key: KEY});
  expect(late.closed.reason).toBe('unauthorized');
  expect(room.world.record).toBeNull();

  const host = room.connect('host');
  const claiming = room.say(host, {type: 'auth', key: KEY});
  room.say(host, {type: 'auth', key: OTHER});
  room.say(host, {to: 'x', type: 'offer'});
  await claiming;
  expect(room.heard(host)).toEqual([{type: 'welcome', data: {id: expect.any(String), peers: []}}]);
  expect(room.world.record.key).toBe(HASH);
  expect(room.world.alarm).toBeNull();
});

test('a guest before any host is told there is no room and closed', () => {
  const room = harness();
  const guest = room.connect('guest');
  expect(guest.closed).toEqual({code: CLOSE['no-room'], reason: 'no-room'});
  expect(room.world.open.size).toBe(0);
  expect(room.world.record).toBeNull();
  // A host still sending its key has no room yet either.
  room.connect('host');
  expect(room.connect('guest').closed.reason).toBe('no-room');
});

test('the relay passes envelopes both ways and tells the host who joins and leaves', async () => {
  const room = await claimed(2);
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

test('guests never reach each other, and nobody can send what only the relay sends', async () => {
  const room = await claimed(2);
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

test('a dropped host keeps the room for its key: guests stay, an impostor is refused, the host returns', async () => {
  const room = await claimed(1);
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
  expect((await room.claim(OTHER)).closed).toEqual({code: CLOSE['room-taken'], reason: 'room-taken'});
  const back = await room.claim(KEY);
  expect(room.heard(back)).toEqual([{type: 'welcome', data: {id: room.hostId, peers: [room.ids[0], lateId]}}]);
  expect(room.world.record.goneAt).toBeNull();
  expect(room.world.alarm).toBeNull();
  room.say(guest, {type: 'answer'});
  expect(room.heard(back)).toEqual([{from: room.ids[0], type: 'answer'}]);
  room.say(back, {to: lateId, type: 'offer'});
  expect(room.heard(late)).toEqual([{from: room.hostId, type: 'offer'}]);
});

test('a host reconnecting before its old socket is noticed replaces it', async () => {
  const room = await claimed(1);
  const [guest] = room.guests;
  // Until the new socket proves its key, the old one is still the host.
  const back = room.connect('host');
  room.say(guest, {type: 'answer'});
  expect(room.heard(room.host)).toEqual([{from: room.ids[0], type: 'answer'}]);
  await room.say(back, {type: 'auth', key: KEY});
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

test('a host that says goodbye ends the room at once', async () => {
  const room = await claimed(2);
  room.leave(room.host, 1000);
  for (const guest of room.guests) expect(guest.closed).toEqual({code: CLOSE['room-closed'], reason: 'room-closed'});
  expect(room.world.record).toEqual({key: HASH, endedAt: 1000});
  expect(room.connect('guest').closed.reason).toBe('no-room');
});

test('the id of an ended room stays unclaimable by other keys for six hours, then nothing of it is stored', async () => {
  const room = await claimed(1);
  room.leave(room.host, 1000);
  expect(room.world.alarm).toBe(1000 + TOMBSTONE_MS);
  room.world.time += TOMBSTONE_MS - 1;
  room.restart();
  expect((await room.claim(OTHER)).closed).toEqual({code: CLOSE['room-taken'], reason: 'room-taken'});
  expect(room.connect('guest').closed.reason).toBe('no-room');
  room.alarm();
  expect(room.world.record).toBeNull();
  expect(room.world.alarm).toBeNull();
  const next = await room.claim(OTHER);
  expect(room.heard(next)[0].data).toEqual({id: expect.any(String), peers: []});
  expect(room.world.record.key).toBe(OTHER_HASH);
});

test('a room evaporates once its host has been gone past the grace period', async () => {
  const room = await claimed(2);
  room.leave(room.host);
  room.alarm();
  for (const guest of room.guests) expect(guest.closed).toEqual({code: CLOSE['room-closed'], reason: 'room-closed'});
  expect(room.world.record).toEqual({key: HASH, endedAt: 1000 + GRACE_MS});
  expect(room.connect('guest').closed.reason).toBe('no-room');
  expect((await room.claim(OTHER)).closed.reason).toBe('room-taken');
  // Its host, returning late, gets a new, empty room under the same id.
  const back = await room.claim(KEY);
  expect(room.heard(back)[0].data).toEqual({id: expect.any(String), peers: []});
  expect(room.world.record).toEqual({host: expect.any(String), conn: expect.any(String), key: HASH, goneAt: null, roomId: ROOM});
  expect(room.world.alarm).toBeNull();
});

test('expiry does not wait for a late alarm, and an early alarm is set again', async () => {
  const room = await claimed(1);
  room.leave(room.host);
  room.world.time += GRACE_MS - 5;
  room.world.alarm = null;
  room.alarm(true);
  expect(room.world.record).not.toBeNull();
  expect(room.world.alarm).toBe(1000 + GRACE_MS);
  room.world.time = 1000 + GRACE_MS;
  // No alarm ran, but the room is over when the old host comes back.
  const back = await room.claim(KEY);
  expect(room.guests[0].closed.reason).toBe('room-closed');
  expect(room.heard(back)[0].data.id).not.toBe(room.hostId);
});

test('a room holds MAX_GUESTS guests on the meeting point at once and refuses more until one leaves', async () => {
  const room = await claimed(MAX_GUESTS);
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

test('messages over 16 KB close the sender, counting UTF-8 bytes', async () => {
  const room = await claimed(1);
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

test('relay reply floods disconnect only the targeted guest', async () => {
  const room = await claimed(2);
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

test('guest message budgets reset after ten seconds', async () => {
  const room = await claimed(2);
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

test('a room woken from hibernation carries on from its record and sockets', async () => {
  const room = await claimed(1);
  const [guest] = room.guests;
  room.restart();
  room.say(guest, {type: 'answer'});
  room.say(room.host, {to: room.ids[0], type: 'offer'});
  expect(room.heard(room.host)).toEqual([{from: room.ids[0], type: 'answer'}]);
  expect(room.heard(guest)).toEqual([{from: room.hostId, type: 'offer'}]);
  room.leave(room.host);
  room.restart();
  expect((await room.claim(OTHER)).closed.reason).toBe('room-taken');
  const back = room.connect('host');
  room.restart();
  await room.say(back, {type: 'auth', key: KEY});
  expect(room.heard(back)[0].data).toEqual({id: room.hostId, peers: [room.ids[0]]});
  room.leave(back);
  room.restart();
  room.alarm();
  expect(guest.closed.reason).toBe('room-closed');
  expect(room.world.record).toEqual({key: HASH, endedAt: room.world.time});
});

test('a host lists its room for the directory, updates and unlists it; guests cannot', async () => {
  const room = await claimed(1);
  room.say(room.host, {type: 'listing', data: {name: ' Nebula\u0007 room ', mapId: 'surf_utopia', mapTitle: 'Utopia', players: 3}});
  room.say(room.host, {type: 'listing', data: null});
  expect(room.world.published).toEqual([[ROOM, {name: 'Nebula room', mapId: 'surf_utopia', mapTitle: 'Utopia', players: 3}, room.host.peer.client], [ROOM, null]]);
  for (const data of [{name: '', mapId: 'x', players: 1}, {name: 'x', mapId: 'x', players: -1}, {name: 'x', players: 1}, 'x', []]) {
    room.say(room.host, {type: 'listing', data});
    expect(room.heard(room.host)).toEqual([{type: 'error', data: {code: 'bad-message'}}]);
  }
  // A guest's listing is just a message for the host.
  room.say(room.guests[0], {type: 'listing', data: {name: 'x', mapId: 'x', players: 1}});
  expect(room.heard(room.host)).toEqual([{from: room.ids[0], type: 'listing', data: {name: 'x', mapId: 'x', players: 1}}]);
  expect(room.world.published).toHaveLength(2);
});

test('a room that ends unlists itself, whether its host left or never came back', async () => {
  const left = await claimed();
  left.leave(left.host, 1000);
  expect(left.world.published).toEqual([[ROOM, null]]);
  const gone = await claimed();
  gone.leave(gone.host);
  expect(gone.world.published).toEqual([]);
  gone.alarm();
  expect(gone.world.published).toEqual([[ROOM, null]]);
});

test('one client takes at most MAX_GUESTS_PER_CLIENT guest places in a room', async () => {
  const room = await claimed();
  const home = Array.from({length: MAX_GUESTS_PER_CLIENT}, () => room.connect('guest', 'home'));
  for (const guest of home) expect(guest.closed).toBeNull();
  expect(room.connect('guest', 'home').closed).toEqual({code: CLOSE['room-full'], reason: 'room-full'});
  expect(room.connect('guest', 'elsewhere').closed).toBeNull();
  room.leave(home[0]);
  expect(room.connect('guest', 'home').closed).toBeNull();
});

test('messages from one client share a budget across its sockets, and host replies count against their guest', async () => {
  const time = {now: 0};
  const allowClient = createLimiter({burst: 10, every: 1000, now: () => time.now});
  const room = await claimed(0, {allowClient});
  const [first, second, other] = [room.connect('guest', 'flood'), room.connect('guest', 'flood'), room.connect('guest', 'calm')];
  const ids = [first, second, other].map(guest => room.heard(guest)[0].data.id);
  room.heard(room.host);
  for (let i = 0; i < 5; i++) room.say(first, {type: 'candidate'});
  for (let i = 0; i < 4; i++) room.say(room.host, {to: ids[1], type: 'candidate'});
  room.say(second, {type: 'candidate'});
  expect([first.closed, second.closed]).toEqual([null, null]);
  room.say(room.host, {to: ids[1], type: 'candidate'});
  expect(second.closed).toEqual({code: CLOSE['rate-limited'], reason: 'rate-limited'});
  room.say(first, {type: 'candidate'});
  expect(first.closed.reason).toBe('rate-limited');
  room.say(other, {type: 'candidate'});
  room.say(room.host, {to: ids[2], type: 'candidate'});
  expect(other.closed).toBeNull();
  expect(room.host.closed).toBeNull();
  time.now += 1000;
  expect(room.connect('guest', 'flood').closed).toBeNull();
});

test('a host and a dozen guests on one home network, joining and reconnecting, stay inside the limits', async () => {
  const time = {now: 0};
  const connections = createLimiter({...CONNECTIONS, now: () => time.now});
  const allowClient = createLimiter({...MESSAGES, now: () => time.now});
  const room = harness({allowClient});
  room.world.time = time.now;
  const join = () => {
    expect(connections('home')).toBe(true);
    const guest = room.connect('guest', 'home');
    const id = room.heard(guest)[0].data.id;
    // A generous WebRTC exchange: twenty messages each way.
    for (let i = 0; i < 20; i++) {
      room.say(guest, {type: 'candidate', data: {i}});
      room.say(host, {to: id, type: 'candidate', data: {i}});
    }
    expect(guest.closed).toBeNull();
    return guest;
  };
  expect(connections('home')).toBe(true);
  let host = await room.claim(KEY, 'home');
  for (let round = 0; round < 3; round++) {
    const guests = Array.from({length: 12}, join);
    for (const guest of guests) room.leave(guest, 1000);
    // The host's network blips and it reconnects a few times.
    for (let i = 0; i < 4; i++) {
      room.leave(host);
      expect(connections('home')).toBe(true);
      host = await room.claim(KEY, 'home');
      expect(host.closed).toBeNull();
    }
    time.now += 60000;
    room.world.time = time.now;
  }
  expect(room.world.record.goneAt).toBeNull();
});

test('guests that leave before the host answers never get the host closed', async () => {
  const room = await claimed();
  const asked = [];
  for (let i = 0; i < 3 * RATE_MESSAGES; i++) {
    const guest = room.connect('guest');
    asked.push(room.heard(guest)[0].data.id);
    room.say(guest, {type: 'room-info', data: null});
    room.leave(guest, 1000);
  }
  room.heard(room.host);
  for (const id of asked) room.say(room.host, {to: id, type: 'room-info', data: {id: ROOM}});
  expect(room.host.closed).toBeNull();
  expect(room.world.record.goneAt).toBeNull();
  // The relay answers within the host's share and drops the rest.
  expect(room.heard(room.host)).toEqual(asked.slice(0, RATE_MESSAGES).map(to => ({type: 'error', data: {code: 'no-peer', to}})));
  const guest = room.connect('guest');
  const id = room.heard(guest)[0].data.id;
  room.say(guest, {type: 'answer'});
  room.say(room.host, {to: id, type: 'offer'});
  expect(room.heard(room.host)).toEqual([{type: 'peer-joined', from: id}, {from: id, type: 'answer'}]);
  expect(room.heard(guest)).toEqual([{from: room.hostId, type: 'offer'}]);
});

test('a host past its client limit is closed, so its dropped messages are still bounded', async () => {
  const allowClient = createLimiter({burst: 5, every: 1000, now: () => 0});
  const room = await claimed(0, {allowClient});
  for (let i = 0; i < 5; i++) room.say(room.host, {to: 'gone', type: 'offer'});
  expect(room.host.closed).toBeNull();
  room.say(room.host, 'junk');
  expect(room.host.closed).toEqual({code: CLOSE['rate-limited'], reason: 'rate-limited'});
});
