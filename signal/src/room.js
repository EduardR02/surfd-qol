// The relay for one private room, kept apart from the Workers runtime so it
// can be tested anywhere: worker.js keeps the room's record in Durable Object
// storage and its sockets in the hibernation API, and hands every event here.
//
// A host claims a room with a secret key; guests then join, and the relay
// passes JSON envelopes between the host and each guest, {to, type, data} in
// and {from, type, data} out. Guests only ever talk to the host. The relay
// never reads what a message carries, and nothing here logs it; the
// exceptions are a host's listing, which is for the public directory, and
// requests for TURN relay credentials, which the relay answers itself.
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
// How long a host has to send its key, its first message, after connecting.
export const AUTH_MS = 5000;
// Guests connected at once. They leave once their direct connection to the
// host is up, so this bounds joins in flight (and abuse), not a room's size.
export const MAX_GUESTS = 100;
// So that one client can't take a room's guest places by itself.
export const MAX_GUESTS_PER_CLIENT = 20;
export const MAX_MESSAGE = 16 * 1024;
export const RATE_MESSAGES = 50;
export const RATE_WINDOW_MS = 10000;
// How long a host whose socket dropped keeps the room for a reconnect.
export const GRACE_MS = 30000;
// How long an ended room's id stays unclaimable, so that nobody else can
// claim it and catch the guests of stale invite links.
export const TOMBSTONE_MS = 6 * 60 * 60 * 1000;
// The close codes (and reasons) the relay ends a socket with.
export const CLOSE = {
  unauthorized: 4401, // a host whose first message wasn't its key, in time
  'room-taken': 4403, // a host without the room's key
  'no-room': 4404, // a guest before any host, or after the room ended
  replaced: 4409, // the host reconnected on another socket
  'room-closed': 4410, // the host left for good
  'too-large': 4413,
  'rate-limited': 4429,
  'room-full': 4503,
};
// Envelope types only the relay sends, so no peer can pass one off as the relay's.
const NOTICES = new Set(['welcome', 'peer-joined', 'peer-left', 'error']);
// A peer asks for TURN relay credentials with this type, and gets its answer
// in the same type, or an error 'no-relay'. It never reaches another peer.
export const RELAY = 'ice-servers';
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

// What a request asks for, {roomId, role}, or why it is refused,
// {status, error}. The Worker checks before any room wakes, the room again.
export function parseRequest(request) {
  const url = new URL(request.url);
  const roomId = /^\/rooms\/([^/]+)$/.exec(url.pathname)?.[1];
  if (!roomId || !ROOM_ID.test(roomId)) return {status: 404, error: 'No such room'};
  if (request.headers.get('Origin') !== ORIGIN) return {status: 403, error: 'Origin not allowed'};
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return {status: 426, error: 'Expected a WebSocket'};
  const role = url.searchParams.get('role');
  return role === 'guest' || role === 'host' ? {roomId, role} : {status: 400, error: 'Expected role=guest or role=host'};
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
//   roomId} once claimed (key hashed, goneAt set while the host is away), a tombstone
//   {key, endedAt} for TOMBSTONE_MS once it ends, else null;
// - wake(at): run alarm() at that time, or never (null);
// - sockets(): the open sockets it accepted, and peerOf(socket): the peer
//   accept(socket, peer) attached to one, or attach(socket, peer) since;
//   refuse(socket, code, reason);
// - allowClient(client): whether a client (limits.js) may send one more message;
// - publish(roomId, listing, client): list the room in the public directory
//   for the host's client, or unlist it (null);
// - relay(client): a promise of TURN credentials for a client, {iceServers,
//   ttl}, or of null when it may not have them (relay.js).
// A socket needs send(text) and close(code, reason).
export function createRoom({record: stored = null, save, wake, sockets, peerOf, accept, attach, refuse, allowClient = () => true, publish = () => {}, relay = async () => null, hash = hashKey, now = Date.now}) {
  let record = null, tomb = null;
  if (stored?.endedAt != null) tomb = stored;
  else record = stored;
  // Message counts per connection live in memory: a room only hibernates
  // after a quiet spell, which would have reset them anyway.
  const rates = new Map(), departed = new Set(), hashing = new Set(), issuing = new Set();
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
  // Host sockets that have yet to send their key.
  function unproven() {
    const list = [];
    for (const socket of sockets()) {
      const peer = peerOf(socket);
      if (peer?.authBy != null && !departed.has(peer.conn)) list.push({socket, peer});
    }
    return list;
  }
  // When alarm() has work: a host's grace period or a tombstone running out,
  // or a new host's time to send its key.
  function due() {
    let at = record ? record.goneAt == null ? null : record.goneAt + GRACE_MS : tomb && tomb.endedAt + TOMBSTONE_MS;
    for (const {peer} of unproven()) at = Math.min(at ?? Infinity, peer.authBy);
    return at;
  }
  function store(next, ended = null) {
    record = next;
    tomb = ended;
    save(next ?? ended);
    wake(due());
  }
  function end() {
    for (const {socket} of members()) shut(socket, 'room-closed');
    if (record.roomId) publish(record.roomId, null);
    store(null, {key: record.key, endedAt: now()});
  }
  // A room whose host has been away longer than the grace period is over,
  // and a tombstone past its time goes.
  function expire() {
    if (record?.goneAt != null && now() >= record.goneAt + GRACE_MS) end();
    if (tomb && now() >= tomb.endedAt + TOMBSTONE_MS) store(null);
  }

  // client: who the socket's messages count against (limits.js).
  function connect(socket, {role, client = null, roomId = null}) {
    expire();
    if (role === 'host') {
      // The key comes in the first message, which keeps it out of URLs and
      // so out of logs.
      accept(socket, {role, conn: randomId(), client, roomId, authBy: now() + AUTH_MS});
      return wake(due());
    }
    if (!record) return refuse(socket, CLOSE['no-room'], 'no-room');
    const present = guests();
    if (present.length >= MAX_GUESTS || present.filter(guest => guest.peer.client === client).length >= MAX_GUESTS_PER_CLIENT) {
      return refuse(socket, CLOSE['room-full'], 'room-full');
    }
    const taken = new Set([record.host, ...present.map(guest => guest.peer.id)]);
    let id;
    do id = randomId(); while (taken.has(id));
    accept(socket, {id, role, conn: randomId(), client});
    post(socket, {type: 'welcome', data: {id, host: record.host}});
    // A host that is away learns of this guest from its welcome on return.
    const current = host();
    if (current) post(current.socket, {type: 'peer-joined', from: id});
  }

  // A new host's first message, {"type":"auth","key"}. Whatever else the
  // socket sends while its key is hashed is dropped.
  function authenticate(socket, peer, raw) {
    let value = null;
    if (!tooLarge(raw)) try { value = JSON.parse(raw); } catch { /* refused below */ }
    if (now() >= peer.authBy || value?.type !== 'auth' || typeof value.key !== 'string' || !HOST_KEY.test(value.key)) {
      return kick(socket, 'unauthorized');
    }
    hashing.add(peer.conn);
    return hash(value.key).then(key => {
      hashing.delete(peer.conn);
      if (!departed.has(peer.conn)) claim(socket, peer, key);
    });
  }
  function claim(socket, peer, key) {
    expire();
    // An ended room's key may claim its id again, as a new room: that is
    // its host coming back after the grace period.
    const holder = record ?? tomb;
    if (holder && holder.key !== key) return kick(socket, 'room-taken');
    // The key's holder takes over: a reconnecting host may arrive before
    // the relay notices its old socket is gone. Its peer id stays the same.
    const previous = host(), id = record?.host ?? randomId();
    attach(socket, {id, role: 'host', conn: peer.conn, client: peer.client});
    store({host: id, conn: peer.conn, key, goneAt: null, roomId: record?.roomId ?? peer.roomId});
    if (previous) shut(previous.socket, 'replaced');
    post(socket, {type: 'welcome', data: {id, peers: guests().map(guest => guest.peer.id)}});
  }

  // Only a host that proved its key and the guests of a live room get this
  // far; a socket gets its answer before it may ask again.
  function issue(socket, peer) {
    if (issuing.has(peer.conn)) return;
    issuing.add(peer.conn);
    return relay(peer.client).catch(() => null).then(servers => {
      issuing.delete(peer.conn);
      if (departed.has(peer.conn)) return;
      post(socket, servers ? {type: RELAY, data: servers} : {type: 'error', data: {code: 'no-relay'}});
    });
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
    if (!peer || departed.has(peer.conn) || hashing.has(peer.conn)) return;
    if (peer.authBy != null) return authenticate(socket, peer, raw);
    if (!record || peer.role === 'host' && peer.conn !== record.conn) return;
    if (tooLarge(raw)) return kick(socket, 'too-large');
    // A ping is a heartbeat, which the runtime usually answers without waking the room.
    const value = raw === 'ping' ? null : envelope(raw);
    if (peer.role === 'host') {
      // A listing addressed to no one is for the public directory.
      if (value?.type === 'listing' && value.to == null) {
        if (!allowClient(peer.client)) return kick(socket, 'rate-limited');
        if (!allow(peer)) return;
        if (value.data === null) return void publish(record.roomId, null);
        const listing = listingFrom(value.data);
        return listing && record.roomId ? void publish(record.roomId, listing, peer.client) : fail(socket, 'bad-message');
      }
      if (value?.type === RELAY) {
        if (!allowClient(peer.client)) return kick(socket, 'rate-limited');
        return allow(peer) ? issue(socket, peer) : undefined;
      }
      const target = value && guests().find(guest => guest.peer.id === value.to);
      if (target) {
        if (!allow(target.peer, true) || !allowClient(target.peer.client)) return kick(target.socket, 'rate-limited');
        return post(target.socket, {from: peer.id, type: value.type, data: value.data});
      }
      if (!allowClient(peer.client)) return kick(socket, 'rate-limited');
      // Mostly replies to guests that left before the reply arrived. Guests
      // can cause those at will, so past the host's share they are dropped,
      // never a reason to close the host.
      if (!allow(peer)) return;
      if (raw === 'ping') return void socket.send('pong');
      return value ? fail(socket, 'no-peer', value.to ?? null) : fail(socket, 'bad-message');
    }
    if (!allow(peer) || !allowClient(peer.client)) return kick(socket, 'rate-limited');
    if (raw === 'ping') return void socket.send('pong');
    if (!value) return fail(socket, 'bad-message');
    if (value.type === RELAY) return issue(socket, peer);
    const {to, type, data} = value;
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
    issuing.delete(peer.conn);
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
    for (const {socket, peer} of unproven()) if (now() >= peer.authBy) kick(socket, 'unauthorized');
    wake(due());
  }

  return {connect, message, disconnect, alarm};
}
