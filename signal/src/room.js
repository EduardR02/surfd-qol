// The relay for one private room, kept apart from the Workers runtime so it
// can be tested anywhere: worker.js keeps the room's record in Durable Object
// storage and its sockets in the hibernation API, and hands every event here.
//
// A host claims a room with a secret key; guests then join, and the relay
// passes JSON envelopes between the host and each guest, {to, type, data} in
// and {from, type, data} out. Guests only ever talk to the host. The relay
// never reads what a message carries, and nothing here logs it; the one
// exception is a host's listing, which is for the public directory.
import {listingFrom} from './lobby.js';

// The extension's page script runs on surfd.net, so its sockets carry this
// Origin. Browsers set it themselves, which keeps other sites' pages out;
// scripts outside a browser can send anything, which the limits below cover.
export const ORIGIN = 'https://surfd.net';
// No 0/o or 1/l/i, since room ids get read out and retyped. The extension
// makes them (src/private-rooms/ids.js): p- and 12 of these characters.
export const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const ROOM_ID = new RegExp(`^p-[${ALPHABET}]{12}$`);
// At least 128 bits, as lowercase hex.
export const HOST_KEY = /^[0-9a-f]{32,128}$/;
// Guests connected at once. They leave once their direct connection to the
// host is up, so this bounds joins in flight (and abuse), not a room's size.
export const MAX_GUESTS = 100;
export const MAX_MESSAGE = 16 * 1024;
export const RATE_MESSAGES = 50;
export const RATE_WINDOW_MS = 10000;
// How long a host whose socket dropped keeps the room for a reconnect.
export const GRACE_MS = 30000;
// The close codes (and reasons) the relay ends a socket with.
export const CLOSE = {
  'room-taken': 4403, // a host without the room's key
  'no-room': 4404, // a guest before any host
  replaced: 4409, // the host reconnected on another socket
  'room-closed': 4410, // the host left for good
  'too-large': 4413,
  'rate-limited': 4429,
  'room-full': 4503,
};
// Envelope types only the relay sends, so no peer can pass one off as the relay's.
const NOTICES = new Set(['welcome', 'peer-joined', 'peer-left', 'error']);
const encoder = new TextEncoder();

export function randomId(length = 8) {
  // Bytes from 248 up are skipped, so each of the 31 characters is equally likely.
  const limit = 256 - 256 % ALPHABET.length;
  let id = '';
  while (id.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < limit && id.length < length) id += ALPHABET[byte % ALPHABET.length];
    }
  }
  return id;
}

// Rooms keep a hash of the host's key, never the key itself.
export async function hashKey(key) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(key));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// What a request asks for, {roomId, role, key}, or why it is refused,
// {status, error}. The Worker checks before any room wakes, the room again.
export function parseRequest(request) {
  const url = new URL(request.url);
  const roomId = /^\/rooms\/([^/]+)$/.exec(url.pathname)?.[1];
  if (!roomId || !ROOM_ID.test(roomId)) return {status: 404, error: 'No such room'};
  if (request.headers.get('Origin') !== ORIGIN) return {status: 403, error: 'Origin not allowed'};
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return {status: 426, error: 'Expected a WebSocket'};
  const role = url.searchParams.get('role'), key = url.searchParams.get('key');
  if (role === 'guest') return {roomId, role, key: null};
  if (role === 'host' && HOST_KEY.test(key ?? '')) return {roomId, role, key};
  return {status: 400, error: 'Expected role=guest, or role=host with a key'};
}

// An envelope worth relaying, or null.
function envelope(raw) {
  if (typeof raw !== 'string') return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  return value && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.type === 'string' && /^[\w-]{1,32}$/.test(value.type) && !NOTICES.has(value.type) &&
    (value.to == null || typeof value.to === 'string') ? value : null;
}
const tooLarge = raw => typeof raw === 'string'
  ? raw.length > MAX_MESSAGE || encoder.encode(raw).length > MAX_MESSAGE : raw.byteLength > MAX_MESSAGE;

// One room's relay. The caller provides:
// - record, save(record): the room's stored record, {host, conn, key, goneAt,
//   roomId} once claimed (key hashed, goneAt set while the host is away), else null;
// - wake(at): run alarm() at that time, or never (null);
// - sockets(): the open sockets it accepted, and peerOf(socket): the peer
//   accept(socket, peer) attached to one; refuse(socket, code, reason);
// - publish(roomId, listing): list the room in the public directory, or
//   unlist it (null).
// A socket needs send(text) and close(code, reason).
export function createRoom({record = null, save, wake, sockets, peerOf, accept, refuse, publish = () => {}, now = Date.now}) {
  // Message counts per connection live in memory: a room only hibernates
  // after a quiet spell, which would have reset them anyway.
  const rates = new Map(), departed = new Set();
  const post = (socket, message) => { try { socket.send(JSON.stringify(message)); } catch { /* closing */ } };
  const shut = (socket, reason) => { try { socket.close(CLOSE[reason], reason); } catch { /* closed */ } };
  const fail = (socket, code, to) => post(socket, {type: 'error', data: to === undefined ? {code} : {code, to}});
  // The room's open connections: its guests and its current host. A socket
  // of a host that reconnected elsewhere carries an older conn, and one
  // that left may linger while its close completes.
  function members() {
    const list = [];
    for (const socket of sockets()) {
      const peer = peerOf(socket);
      if (!peer || departed.has(peer.conn)) continue;
      if (peer.role === 'guest' || peer.role === 'host' && peer.conn === record?.conn) list.push({socket, peer});
    }
    return list;
  }
  const guests = () => members().filter(member => member.peer.role === 'guest');
  const host = () => members().find(member => member.peer.role === 'host');
  function store(next) {
    record = next;
    save(next);
    wake(next?.goneAt == null ? null : next.goneAt + GRACE_MS);
  }
  function end() {
    for (const {socket} of members()) shut(socket, 'room-closed');
    if (record?.roomId) publish(record.roomId, null);
    store(null);
  }
  // A room whose host has been away longer than the grace period is over.
  function expire() {
    if (record?.goneAt != null && now() >= record.goneAt + GRACE_MS) end();
  }

  function connect(socket, {role, key, roomId = null}) {
    expire();
    if (role === 'host') {
      if (record && record.key !== key) return refuse(socket, CLOSE['room-taken'], 'room-taken');
      // The key's holder takes over: a reconnecting host may arrive before
      // the relay notices its old socket is gone. Its peer id stays the same.
      const previous = host();
      store({host: record?.host ?? randomId(), conn: randomId(), key, goneAt: null, roomId: record?.roomId ?? roomId});
      if (previous) shut(previous.socket, 'replaced');
      accept(socket, {id: record.host, role, conn: record.conn});
      return post(socket, {type: 'welcome', data: {id: record.host, peers: guests().map(guest => guest.peer.id)}});
    }
    if (!record) return refuse(socket, CLOSE['no-room'], 'no-room');
    const present = guests();
    if (present.length >= MAX_GUESTS) return refuse(socket, CLOSE['room-full'], 'room-full');
    const taken = new Set([record.host, ...present.map(guest => guest.peer.id)]);
    let id;
    do id = randomId(); while (taken.has(id));
    accept(socket, {id, role, conn: randomId()});
    post(socket, {type: 'welcome', data: {id, host: record.host}});
    // A host that is away learns of this guest from its welcome on return.
    const current = host();
    if (current) post(current.socket, {type: 'peer-joined', from: id});
  }

  // Directed host replies spend the recipient's share, not the host's.
  function allow(peer, directed = false) {
    const time = now(), key = `${directed ? 'reply' : 'send'}:${peer.conn}`;
    let rate = rates.get(key);
    if (!rate || time - rate.start >= RATE_WINDOW_MS) rates.set(key, rate = {start: time, count: 0});
    return ++rate.count <= RATE_MESSAGES;
  }

  function message(socket, raw) {
    const peer = peerOf(socket);
    if (!record || !peer || departed.has(peer.conn) || peer.role === 'host' && peer.conn !== record.conn) return;
    if (tooLarge(raw)) return kick(socket, 'too-large');
    if (peer.role !== 'host' && !allow(peer)) return kick(socket, 'rate-limited');
    // Heartbeats; the runtime usually answers them without waking the room.
    if (raw === 'ping') {
      if (peer.role === 'host' && !allow(peer)) return kick(socket, 'rate-limited');
      return void socket.send('pong');
    }
    const value = envelope(raw);
    if (!value) return fail(socket, 'bad-message');
    const {to, type, data} = value;
    if (peer.role === 'host') {
      // A listing addressed to no one is for the public directory.
      if (type === 'listing' && to == null) {
        if (!allow(peer)) return kick(socket, 'rate-limited');
        if (data === null) return void publish(record.roomId, null);
        const listing = listingFrom(data);
        return listing && record.roomId ? void publish(record.roomId, listing) : fail(socket, 'bad-message');
      }
      const target = guests().find(guest => guest.peer.id === to);
      if (target) {
        if (!allow(target.peer, true)) return kick(target.socket, 'rate-limited');
        return post(target.socket, {from: peer.id, type, data});
      }
      if (!allow(peer)) return kick(socket, 'rate-limited');
      return fail(socket, 'no-peer', to ?? null);
    }
    if (to != null && to !== record.host) return fail(socket, 'forbidden', to);
    const current = host();
    if (!current) return fail(socket, 'host-away');
    post(current.socket, {from: peer.id, type, data});
  }

  // A socket closed (code from the peer, 1006 when it simply dropped). The
  // runtime may report one twice, as an error and a close.
  function disconnect(socket, code) {
    const peer = peerOf(socket);
    if (!peer || departed.has(peer.conn)) return;
    departed.add(peer.conn);
    rates.delete(`send:${peer.conn}`);
    rates.delete(`reply:${peer.conn}`);
    if (peer.role === 'guest') {
      const current = record && host();
      if (current) post(current.socket, {type: 'peer-left', from: peer.id});
    } else if (peer.conn === record?.conn) {
      // A host that closes normally has ended the room. Any other drop may
      // be a blip, so the key holds the room for the grace period.
      if (code === 1000) end();
      else store({...record, goneAt: now()});
    }
  }

  // A socket the relay closes leaves the room now, not when the runtime
  // reports the close (which may never come for a close it started).
  function kick(socket, reason) {
    shut(socket, reason);
    disconnect(socket, CLOSE[reason]);
  }

  function alarm() {
    expire();
    if (record?.goneAt != null) wake(record.goneAt + GRACE_MS);
  }

  return {connect, message, disconnect, alarm};
}
