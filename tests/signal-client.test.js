import {expect, test} from 'bun:test';
import {GRACE_MS, REASONS, ROOM_ID, connectSignal, newHostKey, newRoomId} from '../src/private-rooms/signal-client.js';
import {createRoom, parseRequest} from '../signal/src/room.js';

const ROOM = 'p-abcdefghjkmn', KEY = 'a'.repeat(32), AUTH = JSON.stringify({type: 'auth', key: KEY});
const EVENTS = ['ready', 'message', 'peer-joined', 'peer-left', 'reconnecting', 'error', 'closed'];

// A socket the test plays the relay for.
class FakeSocket {
  static made = [];
  readyState = 0;
  sent = [];
  closedWith = null;
  constructor(url) { this.url = url; FakeSocket.made.push(this); }
  send(text) {
    if (this.readyState !== 1) throw new Error('Not open');
    this.sent.push(text);
  }
  close(code) { this.closedWith = code; this.readyState = 3; }
  accept(welcome) {
    this.readyState = 1;
    this.onopen?.();
    if (welcome) this.deliver({type: 'welcome', data: welcome});
  }
  deliver(value) { this.onmessage?.({data: typeof value === 'string' ? value : JSON.stringify(value)}); }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({code, reason: ''});
  }
  get last() { return JSON.parse(this.sent.at(-1)); }
}

// A manual clock and a log of every event a client emits.
function rig(Socket = FakeSocket) {
  FakeSocket.made = [];
  const timers = [], events = [];
  let time = 0;
  const timer = (callback, ms) => {
    const entry = {at: time + ms, callback};
    timers.push(entry);
    return () => { entry.done = true; };
  };
  function advance(ms) {
    const end = time + ms;
    for (;;) {
      const due = timers.filter(entry => !entry.done && entry.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.done = true;
      time = due.at;
      due.callback();
    }
    time = end;
  }
  function connect(options) {
    const client = connectSignal({url: 'https://signal.example', roomId: ROOM, WebSocket: Socket, timer, now: () => time, ...options});
    for (const name of EVENTS) client.on(name, value => events.push(value === undefined ? [name] : [name, value]));
    return client;
  }
  return {events, advance, connect, now: () => time, get sockets() { return FakeSocket.made; }, get socket() { return FakeSocket.made.at(-1); },
    heard() { return events.splice(0); }};
}

test('room ids use the unambiguous alphabet evenly; host keys carry 128 random bits', () => {
  const ids = Array.from({length: 500}, newRoomId);
  expect(new Set(ids).size).toBe(500);
  for (const id of ids) expect(id).toMatch(ROOM_ID);
  const used = new Set(ids.flatMap(id => [...id.slice(2)]));
  expect([...used].sort().join('')).toBe('23456789abcdefghjkmnpqrstuvwxyz');
  const keys = Array.from({length: 100}, newHostKey);
  expect(new Set(keys).size).toBe(100);
  for (const key of keys) expect(key).toMatch(/^[0-9a-f]{32}$/);
});

test('bad arguments throw before anything connects', () => {
  const base = {url: 'https://signal.example', roomId: ROOM, WebSocket: FakeSocket};
  FakeSocket.made = [];
  expect(() => connectSignal({...base, url: '', role: 'guest'})).toThrow(/SIGNAL_URL/);
  expect(() => connectSignal({...base, roomId: 'p-abcdefghjkm0', role: 'guest'})).toThrow(TypeError);
  expect(() => connectSignal({...base, role: 'host'})).toThrow(TypeError);
  expect(() => connectSignal({...base, role: 'host', key: 'short'})).toThrow(TypeError);
  expect(() => connectSignal({...base, role: 'admin'})).toThrow(TypeError);
  expect(FakeSocket.made).toEqual([]);
});

test('a host claims with its key, hears guests come and go, and sends to one', () => {
  const room = rig();
  const client = room.connect({role: 'host', key: KEY});
  expect(room.socket.url).toBe(`wss://signal.example/rooms/${ROOM}?role=host`);
  expect(client.send('g1', 'offer', {})).toBe(false);
  // The key is the first message, never part of the URL.
  room.socket.accept();
  expect(room.socket.sent).toEqual([AUTH]);
  room.socket.deliver({type: 'welcome', data: {id: 'h1', peers: []}});
  expect(client.state).toBe('open');
  room.socket.deliver({type: 'peer-joined', from: 'g1'});
  room.socket.deliver({from: 'g1', type: 'answer', data: {sdp: 'a'}});
  room.socket.deliver({from: 'g1', type: 'bye'});
  room.socket.deliver({type: 'error', data: {code: 'no-peer', to: 'g2'}});
  room.socket.deliver('pong');
  room.socket.deliver('not json');
  room.socket.deliver({type: 'peer-left', from: 'g1'});
  room.socket.deliver({type: 'peer-left', from: 'g1'});
  expect(room.heard()).toEqual([
    ['ready', {id: 'h1', host: 'h1'}], ['peer-joined', 'g1'],
    ['message', {from: 'g1', type: 'answer', data: {sdp: 'a'}}], ['message', {from: 'g1', type: 'bye', data: null}],
    ['error', {code: 'no-peer', to: 'g2'}], ['peer-left', 'g1']]);
  expect(client.send('g1', 'offer', {sdp: 'o'})).toBe(true);
  expect(room.socket.last).toEqual({to: 'g1', type: 'offer', data: {sdp: 'o'}});
  // The relay would close the socket for this, so it never leaves.
  expect(() => client.send('g1', 'offer', 'x'.repeat(16 * 1024))).toThrow(RangeError);
  expect(room.socket.sent).toHaveLength(2);
});

test('a guest talks only to the host, which is implied', () => {
  const room = rig();
  const client = room.connect({role: 'guest', url: 'wss://signal.example/'});
  expect(room.socket.url).toBe(`wss://signal.example/rooms/${ROOM}?role=guest`);
  room.socket.accept({id: 'g1', host: 'h1'});
  expect(room.socket.sent).toEqual([]);
  room.socket.deliver({type: 'peer-joined', from: 'g2'});
  room.socket.deliver({from: 'h1', type: 'offer', data: {sdp: 'o'}});
  expect(room.heard()).toEqual([['ready', {id: 'g1', host: 'h1'}], ['message', {from: 'h1', type: 'offer', data: {sdp: 'o'}}]]);
  expect([client.id, client.host]).toEqual(['g1', 'h1']);
  expect(client.send(null, 'answer', {sdp: 'a'})).toBe(true);
  expect(room.socket.last).toEqual({type: 'answer', data: {sdp: 'a'}});
});

test('relay refusals end guest connections without retrying', () => {
  for (const [code, reason] of Object.entries(REASONS)) {
    const room = rig();
    room.connect({role: 'guest'});
    room.socket.accept({id: 'x', host: 'x'});
    room.socket.drop(Number(code));
    room.advance(GRACE_MS * 2);
    expect(room.heard()).toEqual([['ready', {id: 'x', host: 'x'}], ['closed', reason]]);
    expect(room.sockets).toHaveLength(1);
  }
});

test('hosts reconnect after every unexpected relay close', () => {
  for (const code of [1000, 1006, ...Object.keys(REASONS).map(Number)]) {
    const room = rig();
    const client = room.connect({role: 'host', key: KEY});
    room.socket.accept({id: 'h', peers: ['g']});
    room.socket.drop(code);
    room.advance(250);
    expect(client.state).toBe('reconnecting');
    room.socket.accept({id: 'h', peers: ['g']});
    expect(client.state).toBe('open');
    expect(room.heard().filter(([name]) => name === 'closed')).toEqual([]);
    client.close();
  }
});

test('a guest whose socket drops is closed; a first connection that fails is unreachable', () => {
  const guest = rig();
  guest.connect({role: 'guest'});
  guest.socket.accept({id: 'g1', host: 'h1'});
  guest.socket.drop(1006);
  guest.advance(GRACE_MS);
  expect(guest.heard().at(-1)).toEqual(['closed', 'lost']);
  expect(guest.sockets).toHaveLength(1);
  for (const fail of [socket => socket.drop(1006), () => {}]) {
    const host = rig();
    host.connect({role: 'host', key: KEY});
    fail(host.socket);
    // One that never answers is given up after one heartbeat interval.
    host.advance(10000);
    expect(host.heard()).toEqual([['closed', 'unreachable']]);
    expect(host.sockets).toHaveLength(1);
  }
});

test('a host that drops reconnects with its key and catches up on its guests', () => {
  const room = rig();
  const client = room.connect({role: 'host', key: KEY});
  const first = room.socket;
  first.accept({id: 'h1', peers: ['g1', 'g2']});
  first.drop(1006);
  expect(room.heard()).toEqual([['ready', {id: 'h1', host: 'h1'}], ['peer-joined', 'g1'], ['peer-joined', 'g2'], ['reconnecting']]);
  expect(client.state).toBe('reconnecting');
  expect(client.send('g1', 'offer')).toBe(false);
  room.advance(249);
  expect(room.sockets).toHaveLength(1);
  room.advance(1);
  // The first retry fails too; the next waits longer.
  room.socket.drop(1006);
  room.advance(499);
  expect(room.sockets).toHaveLength(2);
  room.advance(1);
  const back = room.socket;
  expect(back.url).toBe(first.url);
  back.accept({id: 'h1', peers: ['g2', 'g3']});
  expect(room.heard()).toEqual([['ready', {id: 'h1', host: 'h1'}], ['peer-left', 'g1'], ['peer-joined', 'g3']]);
  expect(client.send('g3', 'offer')).toBe(true);
  expect(back.last).toEqual({to: 'g3', type: 'offer', data: null});
  expect(back.sent[0]).toBe(AUTH);
  expect(first.sent).toEqual([AUTH]);
  // A later drop starts again from the shortest wait.
  back.drop(1006);
  room.advance(250);
  expect(room.sockets).toHaveLength(4);
});

test('a relay outage does not end the hosted room', () => {
  const room = rig();
  const client = room.connect({role: 'host', key: KEY});
  room.socket.accept({id: 'h1', peers: []});
  room.socket.drop(4429);
  room.advance(GRACE_MS * 3);
  expect(client.state).toBe('reconnecting');
  expect(room.events.some(([name]) => name === 'closed')).toBe(false);
  room.socket.accept({id: 'h1', peers: []});
  expect(client.state).toBe('open');
  client.close();
});

test('heartbeats keep the socket honest: one gone quiet is replaced without ending the room', () => {
  const room = rig();
  room.connect({role: 'host', key: KEY});
  const first = room.socket;
  first.accept({id: 'h1', peers: []});
  room.advance(10000);
  expect(first.sent).toEqual([AUTH, 'ping']);
  first.deliver('pong');
  room.advance(10000);
  expect(first.sent).toEqual([AUTH, 'ping', 'ping']);
  room.advance(10000);
  // 4000, not 1000: the relay keeps the room for the reconnect.
  expect(first.closedWith).toBe(4000);
  expect(room.heard()).toEqual([['ready', {id: 'h1', host: 'h1'}], ['reconnecting']]);
  room.advance(250);
  expect(room.sockets).toHaveLength(2);
});

test('close() says goodbye once and silences the client', () => {
  const room = rig();
  const client = room.connect({role: 'host', key: KEY});
  const socket = room.socket;
  socket.accept({id: 'h1', peers: []});
  const quiet = [];
  const off = client.on('message', value => quiet.push(value));
  off();
  client.close();
  client.close();
  expect(socket.closedWith).toBe(1000);
  socket.deliver({from: 'g1', type: 'answer'});
  socket.drop(1000);
  room.advance(GRACE_MS);
  expect(room.heard()).toEqual([['ready', {id: 'h1', host: 'h1'}], ['closed', 'closed']]);
  expect(quiet).toEqual([]);
  expect(client.send('g1', 'offer')).toBe(false);
  expect(client.state).toBe('closed');
  // Closing while reconnecting stops the retries.
  const other = rig();
  const again = other.connect({role: 'host', key: KEY});
  other.socket.accept({id: 'h1', peers: []});
  other.socket.drop(1006);
  again.close();
  other.advance(GRACE_MS);
  expect(other.sockets).toHaveLength(1);
  expect(other.heard().at(-1)).toEqual(['closed', 'closed']);
});

// The real relay (room.js) behind each client's socket, as the Worker runs it.
function relay() {
  const open = new Set();
  const room = createRoom({save() {}, wake() {}, sockets: () => open, peerOf: server => server.peer,
    accept(server, peer) { server.peer = peer; open.add(server); },
    attach(server, peer) { server.peer = peer; },
    refuse(server, code, reason) { server.close(code, reason); }});
  class BridgeSocket {
    readyState = 0;
    constructor(url) {
      // The Worker would let this request through.
      const asked = parseRequest(new Request(url.replace(/^ws/, 'http'), {headers: {Origin: 'https://surfd.net', Upgrade: 'websocket'}}));
      if (asked.error) throw new Error(asked.error);
      this.server = {
        send: text => queueMicrotask(() => this.onmessage?.({data: text})),
        close: (code, reason) => { open.delete(this.server); this.readyState = 3; queueMicrotask(() => this.onclose?.({code, reason})); },
      };
      FakeSocket.made.push(this);
      queueMicrotask(() => {
        room.connect(this.server, {role: asked.role});
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(text) { room.message(this.server, text); }
    close(code) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      open.delete(this.server);
      room.disconnect(this.server, code);
    }
    // The network gives way under both ends.
    cut() {
      this.close(1006);
      this.onclose?.({code: 1006, reason: ''});
    }
  }
  return BridgeSocket;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('end to end: clients and the relay agree on claiming, relaying, reconnecting and closing', async () => {
  const room = rig(relay());
  const roomId = newRoomId(), key = newHostKey();
  const host = room.connect({role: 'host', roomId, key});
  await settle();
  const hostSocket = room.socket;
  const guest = room.connect({role: 'guest', roomId});
  await settle();
  expect(guest.host).toBe(host.id);
  host.send(guest.id, 'offer', {sdp: 'o'});
  guest.send(null, 'answer', {sdp: 'a'});
  await settle();
  expect(room.heard()).toEqual([
    ['ready', {id: host.id, host: host.id}], ['ready', {id: guest.id, host: host.id}], ['peer-joined', guest.id],
    ['message', {from: host.id, type: 'offer', data: {sdp: 'o'}}], ['message', {from: guest.id, type: 'answer', data: {sdp: 'a'}}]]);
  // Someone else's tab can't take the room.
  const impostor = room.connect({role: 'host', roomId, key: newHostKey()});
  await settle();
  expect(room.heard()).toEqual([['closed', 'room-taken']]);
  expect(impostor.state).toBe('closed');
  // The host's network blips; a guest arrives meanwhile; the host comes back.
  hostSocket.cut();
  const late = room.connect({role: 'guest', roomId});
  await settle();
  expect(guest.send(null, 'candidate', {})).toBe(true);
  await settle();
  room.advance(250);
  await settle();
  expect(room.heard()).toEqual([
    ['reconnecting'], ['ready', {id: late.id, host: host.id}], ['error', {code: 'host-away'}],
    ['ready', {id: host.id, host: host.id}], ['peer-joined', late.id]]);
  host.send(late.id, 'offer', {});
  await settle();
  expect(room.heard()).toEqual([['message', {from: host.id, type: 'offer', data: {}}]]);
  // A guest naming another guest is refused by the relay.
  guest.send(late.id, 'offer', {});
  await settle();
  expect(room.heard()).toEqual([['error', {code: 'forbidden', to: late.id}]]);
  host.close();
  await settle();
  expect(room.heard()).toEqual([['closed', 'closed'], ['closed', 'room-closed'], ['closed', 'room-closed']]);
});

test('the game, the client and the Worker agree on room ids', async () => {
  const {createRoomId, isPrivateRoomId} = await import('../src/private-rooms/ids.js');
  const {ROOM_ID: WORKER} = await import('../signal/src/room.js');
  const ids = [...Array.from({length: 200}, createRoomId), ...Array.from({length: 200}, newRoomId)];
  for (const id of ids) expect([isPrivateRoomId(id), ROOM_ID.test(id), WORKER.test(id)]).toEqual([true, true, true]);
});
