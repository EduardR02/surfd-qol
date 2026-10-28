// connectSignal({url, roomId, role, key}) joins a room on the signalling
// Worker (signal/) and returns {send(to, type, data), on(event, handler)
// (returning an unsubscribe), off(event, handler), close(), id, host, state};
// a guest sends with to = null, as it only ever talks to the host, and send()
// returns false while not connected. Events: 'ready' {id, host} on each
// (re)connection, 'message' {from, type, data}, 'peer-joined' and 'peer-left'
// (host only, with a guest's id), 'reconnecting', 'error' {code, to} for a
// message the relay refused, and 'closed' with a reason (REASONS, 'closed',
// 'unreachable' or 'lost'), once and last. A host whose socket drops
// reconnects with its key for up to GRACE_MS, keeping the room and its guests.

// The deployed Worker's URL, such as 'https://surfd-signal.<subdomain>.workers.dev'
// (see signal/README.md).
export const SIGNAL_URL = '';
// Matches signal/src/room.js, and the ids ids.js makes.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const ROOM_ID = new RegExp(`^p-[${ALPHABET}]{12}$`);
const HOST_KEY = /^[0-9a-f]{32,128}$/;
export const GRACE_MS = 30000;
const MAX_MESSAGE = 16 * 1024;
export const REASONS = {4403: 'room-taken', 4404: 'no-room', 4409: 'replaced', 4410: 'room-closed', 4413: 'too-large', 4429: 'rate-limited', 4503: 'room-full'};
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
  if (role === 'host') address.searchParams.set('key', key);
  const handlers = new Map();
  // pending cancels the live socket's heartbeat or the next reconnect.
  let socket = null, pending = null, state = 'connecting', id = null, host = null, peers = new Set(), droppedAt = null, attempt = 0;
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
      ws.onmessage = ws.onclose = null;
      try { ws.close(code); } catch { /* already closed */ }
    }
  }
  // The socket closed, or went quiet.
  function drop(code) {
    if (state === 'closed') return;
    release(4000);
    if (REASONS[code]) return finish(REASONS[code]);
    // Only the host holds its room across a drop; a guest would come back as someone new.
    if (role !== 'host' || id === null) return finish(id === null ? 'unreachable' : 'lost');
    droppedAt ??= now();
    const left = droppedAt + GRACE_MS - now();
    if (left <= 0) return finish('lost');
    pending = timer(open, Math.min(RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)], left));
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
    } else if (type === 'error') emit('error', data);
    else emit('message', {from, type, data});
  }
  function welcome(data) {
    id = data.id;
    host = role === 'host' ? data.id : data.host;
    state = 'open';
    droppedAt = null;
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
