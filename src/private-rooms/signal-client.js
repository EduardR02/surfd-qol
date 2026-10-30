// connectSignal({url, roomId, role, key}) joins a room on the signalling
// Worker (signal/) and returns {send(to, type, data), on(event, handler)
// (returning an unsubscribe), off(event, handler), close(), id, host, state};
// a guest sends with to = null, as it only ever talks to the host, and send()
// returns false while not connected. Events: 'ready' {id, host} on each
// (re)connection, 'message' {from, type, data}, 'peer-joined' and 'peer-left'
// (host only, with a guest's id), 'reconnecting', 'ice-servers' with the TURN
// credentials sent for an 'ice-servers' request, 'error' {code, to} for a
// message the relay refused, and 'closed' with a reason (REASONS, 'closed',
// 'unreachable' or 'lost'), once and last. A host whose socket drops
// reconnects with its key; existing peer connections do not depend on the relay.

// The deployed signalling Worker (see signal/README.md). Public, as players connect anonymously.
export const SIGNAL_URL = 'https://surfd-signal.lightconelabs.workers.dev';
// Matches signal/src/room.js, and the ids ids.js makes.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const ROOM_ID = new RegExp(`^p-[${ALPHABET}]{12}$`);
const HOST_KEY = /^[0-9a-f]{32,128}$/;
export const GRACE_MS = 30000;
const MAX_MESSAGE = 16 * 1024;
export const REASONS = {4401: 'unauthorized', 4403: 'room-taken', 4404: 'no-room', 4409: 'replaced', 4410: 'room-closed', 4413: 'too-large', 4429: 'rate-limited', 4503: 'room-full'};
// A heartbeat every PING_MS. A socket that hears nothing for a whole
// interval is dead, which also bounds how long a connection attempt takes.
const PING_MS = 10000;
const RETRY_MS = [250, 500, 1000, 2000, 4000];
const OPEN = 1;
const encoder = new TextEncoder();

function randomString(length) {
  // Bytes from 248 up are skipped, so each of the 31 characters is equally likely.
  const limit = 256 - 256 % ALPHABET.length;
  let text = '';
  while (text.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < limit && text.length < length) text += ALPHABET[byte % ALPHABET.length];
    }
  }
  return text;
}
export const newRoomId = () => `p-${randomString(12)}`;
// 128 random bits, as hex: what lets a host, and only it, reclaim its room.
export const newHostKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

// The meeting point's TURN credentials as {config, ttl}: an RTCConfiguration
// that only ever connects through the relay, and how many seconds it lasts.
// Null for anything else.
export function relayServers(data) {
  const servers = data?.iceServers, ttl = data?.ttl;
  if (!Array.isArray(servers) || !servers.length || servers.length > 8 || !Number.isSafeInteger(ttl) || ttl < 60) return null;
  const iceServers = [];
  for (const server of servers) {
    const urls = server?.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > 16 ||
        !urls.every(url => typeof url === 'string' && url.length <= 256 && /^turns?:/.test(url)) ||
        typeof server.username !== 'string' || typeof server.credential !== 'string') return null;
    iceServers.push({urls: [...urls], username: server.username, credential: server.credential});
  }
  return {config: {iceServers, iceTransportPolicy: 'relay'}, ttl};
}

const after = (callback, ms) => {
  const id = setTimeout(callback, ms);
  return () => clearTimeout(id);
};

export function connectSignal({url = SIGNAL_URL, roomId, role, key = null, WebSocket: Socket = globalThis.WebSocket, timer = after, now = Date.now}) {
  if (!url) throw new Error('Private rooms need the signalling Worker: deploy signal/ and set SIGNAL_URL');
  if (!ROOM_ID.test(roomId ?? '')) throw new TypeError(`Not a room id: ${roomId}`);
  if (role !== 'guest' && !(role === 'host' && HOST_KEY.test(key ?? ''))) throw new TypeError('Expected role guest, or host with a key from newHostKey()');
  const address = new URL(`/rooms/${roomId}`, url);
  address.protocol = address.protocol.replace(/^http/, 'ws');
  address.searchParams.set('role', role);
  const handlers = new Map();
  // pending cancels the live socket's heartbeat or the next reconnect.
  let socket = null, pending = null, state = 'connecting', id = null, host = null, peers = new Set(), attempt = 0;
  const emit = (event, value) => { for (const handler of [...handlers.get(event) ?? []]) handler(value); };

  function open() {
    let ws;
    try { ws = socket = new Socket(address.href); } catch { pending = timer(() => drop(1006), 0); return; }
    let heard = false;
    const beat = () => {
      if (!heard) return drop(1006);
      heard = false;
      try { ws.send('ping'); } catch { /* closing: onclose follows */ }
      pending = timer(beat, PING_MS);
    };
    pending = timer(beat, PING_MS);
    // A host's key goes in its first message, never the URL, which could end up in logs.
    if (role === 'host') ws.onopen = () => { if (ws === socket) ws.send(JSON.stringify({type: 'auth', key})); };
    ws.onmessage = event => { if (ws === socket) { heard = true; receive(event.data); } };
    ws.onclose = event => { if (ws === socket) drop(event.code); };
  }
  // Lets go of the socket. 1000 tells the relay it's a goodbye, which for a
  // host ends the room; 4000 leaves a host's room waiting for its return.
  function release(code) {
    pending?.();
    pending = null;
    const ws = socket;
    socket = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      try { ws.close(code); } catch { /* already closed */ }
    }
  }
  // The socket closed, or went quiet.
  function drop(code) {
    if (state === 'closed') return;
    release(4000);
    if (role !== 'host' || id === null) return finish(REASONS[code] ?? (id === null ? 'unreachable' : 'lost'));
    pending = timer(open, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
    if (state !== 'reconnecting') {
      state = 'reconnecting';
      emit('reconnecting');
    }
  }
  function finish(reason) {
    if (state === 'closed') return;
    state = 'closed';
    release(1000);
    emit('closed', reason);
  }

  function receive(text) {
    if (text === 'pong') return;
    let message;
    try { message = JSON.parse(text); } catch { return; }
    const {from, type, data = null} = message ?? {};
    if (type === 'welcome') return welcome(data);
    if (state !== 'open' || typeof type !== 'string') return;
    if (type === 'peer-joined') {
      if (role === 'host' && !peers.has(from)) { peers.add(from); emit('peer-joined', from); }
    } else if (type === 'peer-left') {
      if (peers.delete(from)) emit('peer-left', from);
    } else if (type === 'ice-servers') emit('ice-servers', data);
    else if (type === 'error') emit('error', data);
    else emit('message', {from, type, data});
  }
  function welcome(data) {
    id = data.id;
    host = role === 'host' ? data.id : data.host;
    state = 'open';
    attempt = 0;
    // A returning host catches up on guests that came or went meanwhile.
    const present = new Set(role === 'host' ? data.peers : []);
    const left = [...peers].filter(peer => !present.has(peer)), joined = [...present].filter(peer => !peers.has(peer));
    peers = present;
    emit('ready', {id, host});
    for (const peer of left) emit('peer-left', peer);
    for (const peer of joined) emit('peer-joined', peer);
  }

  function send(to, type, data = null) {
    if (state !== 'open' || socket?.readyState !== OPEN) return false;
    const text = JSON.stringify(to == null ? {type, data} : {to, type, data});
    // The relay closes a socket that sends more.
    if (encoder.encode(text).length > MAX_MESSAGE) throw new RangeError(`Signal message over ${MAX_MESSAGE} bytes`);
    socket.send(text);
    return true;
  }
  function off(event, handler) { handlers.get(event)?.delete(handler); }
  function on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
    return () => off(event, handler);
  }

  open();
  return {send, on, off, close: () => finish('closed'),
    get id() { return id; }, get host() { return host; }, get state() { return state; }};
}
