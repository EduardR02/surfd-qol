import {CLOSE, MAX_CONTROL_BYTES, ROOM_TEXTS, createRoomControlReader, createRoomFilter, encodeControlFrames,
  roomCloseReason, validateRoomBinary} from './protocol.js';

const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
const PROTOCOL = 'surfd-v1';
const RTC_CONFIG = {iceServers: [{urls: 'stun:stun.l.google.com:19302'}]};
const DIRECT_FAILURE = "Couldn't connect to the host. Their network or yours may block direct connections.";
const encoder = new TextEncoder();

class RoomSocket extends EventTarget {
  constructor() {
    super();
    this._state = CONNECTING;
    this._binaryType = 'blob';
    this._buffered = 0;
    this._amount = () => this._buffered;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    for (const type of ['open', 'message', 'error', 'close']) {
      this.addEventListener(type, event => this['on' + type]?.call(this, event));
    }
  }
  get readyState() { return this._state; }
  get binaryType() { return this._binaryType; }
  set binaryType(value) {
    if (value === 'blob' || value === 'arraybuffer') this._binaryType = value;
  }
  get bufferedAmount() { return this._amount(); }
  get protocol() { return PROTOCOL; }
  get extensions() { return ''; }
  async getStats() { return new Map(); }
  send(data) {
    if (this._state === CONNECTING) throw new DOMException('Socket is connecting', 'InvalidStateError');
    if (this._state !== OPEN) return;
    this._send(data);
  }
  close(code = 1000, reason = '') {
    if (code !== 1000 && (!Number.isInteger(code) || code < 3000 || code > 4999)) {
      throw new DOMException('Invalid close code', 'InvalidAccessError');
    }
    reason = String(reason);
    if (encoder.encode(reason).byteLength > 123) throw new DOMException('Close reason is too long', 'SyntaxError');
    if (this._state >= CLOSING) return;
    this._close(code, reason);
  }
  _emit(type, fields = {}) { this.dispatchEvent(Object.assign(new Event(type), fields)); }
  _open() {
    if (this._state !== CONNECTING) return;
    this._state = OPEN;
    this._emit('open');
  }
  _finish(code, reason, wasClean) {
    if (this._state === CLOSED) return;
    this._state = CLOSED;
    this._buffered = 0;
    this._emit('close', {code, reason, wasClean});
  }
}
for (const [name, value] of Object.entries({CONNECTING, OPEN, CLOSING, CLOSED})) {
  Object.defineProperty(RoomSocket, name, {value});
  Object.defineProperty(RoomSocket.prototype, name, {value});
}

function binary(data) {
  return data instanceof ArrayBuffer || ArrayBuffer.isView(data) || data instanceof Blob;
}
function copyData(data) {
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (data instanceof Blob) return data;
  return String(data);
}
function dataSize(data) {
  return typeof data === 'string' ? encoder.encode(data).byteLength : data instanceof Blob ? data.size : data.byteLength;
}
async function receive(socket, data) {
  if (typeof data !== 'string') {
    if (socket.binaryType === 'blob' && !(data instanceof Blob)) data = new Blob([data]);
    else if (socket.binaryType === 'arraybuffer' && data instanceof Blob) data = await data.arrayBuffer();
  }
  if (socket.readyState !== CLOSED) socket._emit('message', {data});
}

function frameParts(data) {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 4) return [];
  const view = new DataView(data), type = view.getUint8(1);
  if (view.getUint8(0) !== 1) return [];
  if (type === 1 && (view.getUint8(2) === 1 || view.getUint8(2) === 2) &&
      data.byteLength === 12 + view.getUint8(2) * 32) {
    return [{key: '1', offset: 0, length: data.byteLength}];
  }
  if ((type === 3 || type === 4) && data.byteLength === 56) {
    return [{key: type + ':' + view.getUint16(2, true), offset: 0, length: data.byteLength}];
  }
  if (type !== 2) return [];
  const count = view.getUint16(2, true), parts = [], slots = new Set();
  if (count > 100) return [];
  let offset = 4;
  for (let index = 0; index < count; index++) {
    if (offset + 14 > data.byteLength) return [];
    const slot = view.getUint16(offset, true), samples = view.getUint8(offset + 10);
    const length = 14 + samples * 32;
    if (slots.has(slot) || samples < 1 || samples > 2 || offset + length > data.byteLength) return [];
    slots.add(slot);
    parts.push({key: '2:' + slot, offset, length});
    offset += length;
  }
  return offset === data.byteLength ? parts : [];
}

export function createLoopbackPair() {
  const sockets = [new RoomSocket(), new RoomSocket()], queue = new Set();
  const channel = new MessageChannel();
  let scheduled = false;
  const enqueue = entry => {
    queue.add(entry);
    if (!scheduled) {
      scheduled = true;
      channel.port2.postMessage(null);
    }
  };
  channel.port1.onmessage = async () => {
    try {
      for (const entry of queue) {
        queue.delete(entry);
        if (entry.run) {
          entry.run();
          continue;
        }
        const {socket, peer, pending, parts} = entry;
        for (const part of parts) if (!part.removed) pending.delete(part.key);
        let data = entry.data;
        if (parts.length && entry.size !== data.byteLength) {
          const compact = new Uint8Array(entry.size), source = new Uint8Array(data);
          compact.set(source.subarray(0, 4));
          let offset = 4, count = 0;
          for (const part of parts) if (!part.removed) {
            compact.set(source.subarray(part.offset, part.offset + part.length), offset);
            offset += part.length;
            count++;
          }
          new DataView(compact.buffer).setUint16(2, count, true);
          data = compact.buffer;
        }
        socket._buffered -= entry.size;
        await receive(peer, data);
      }
    } finally {
      scheduled = false;
    }
  };
  for (const [index, socket] of sockets.entries()) {
    const peer = sockets[1 - index], pending = new Map();
    socket._send = data => {
      const copy = copyData(data), parts = frameParts(copy);
      const entry = {socket, peer, pending, parts, data: copy, size: dataSize(copy), remaining: parts.length};
      for (const part of parts) {
        const previous = pending.get(part.key);
        if (previous) {
          const {entry: stale, part: old} = previous;
          old.removed = true;
          stale.remaining--;
          const removed = stale.remaining ? old.length : stale.size;
          stale.size -= removed;
          socket._buffered -= removed;
          if (!stale.remaining) queue.delete(stale);
        }
        pending.set(part.key, {entry, part});
      }
      socket._buffered += entry.size;
      enqueue(entry);
    };
    socket._close = (code, reason) => {
      const connecting = socket.readyState === CONNECTING;
      socket._state = CLOSING;
      peer._state = CLOSING;
      enqueue({run() {
        channel.port1.onmessage = null;
        channel.port1.close();
        channel.port2.close();
        if (connecting) socket._emit('error', {error: new Error('Socket closed while connecting')});
        socket._finish(connecting ? 1006 : code, connecting ? '' : reason, !connecting);
        peer._finish(connecting ? 1006 : code, connecting ? '' : reason, !connecting);
      }});
    };
  }
  enqueue({run() {
    // Both endpoints must be writable before either open callback can send.
    for (const socket of sockets) if (socket.readyState === CONNECTING) socket._state = OPEN;
    for (const socket of sockets) if (socket.readyState === OPEN) socket._emit('open');
  }});
  return sockets;
}

export function createClosedSocket(code, reason) {
  const socket = new RoomSocket();
  socket._state = CLOSING;
  queueMicrotask(() => socket._finish(code, reason, code !== 1006));
  return socket;
}

function createConnection({roomId, peerId, signalling, hello, maps, rtcConfig, host, onSocket, onDispose, onFailure}) {
  const socket = new RoomSocket();
  let pc, control, poses, remoteHello, helloReceived = false, helloSent = false;
  let disposed = false, closeTimer, closeInfo = null, cleanClose = false;
  let negotiationTimer, queuedNegotiations = 0, remoteReceived = false;
  const incoming = createRoomControlReader(host ? null : createRoomFilter({roomId, maps}));
  let negotiation = Promise.resolve();
  const candidates = [];
  const signal = (type, payload) => signalling.send({
    roomId, peerId: typeof peerId === 'function' ? peerId() : peerId, type, payload,
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(closeTimer);
    clearTimeout(negotiationTimer);
    candidates.length = 0;
    incoming.clear();
    pc?.close();
    onDispose?.();
  };
  const finish = (code, reason, wasClean) => {
    if (socket.readyState === CLOSED) return;
    // Dispose before emitting: a close handler may immediately start a new peer.
    dispose();
    socket._finish(code, reason, wasClean);
  };
  const fail = error => {
    if (disposed) return;
    if (closeInfo) { finish(closeInfo.code, closeInfo.reason, false); return; }
    const wasOpen = socket.readyState === OPEN;
    socket._state = CLOSING;
    socket._emit('error', {error});
    dispose();
    if (wasOpen && onFailure) {
      Promise.resolve().then(onFailure).then(info => {
        socket._finish(info?.code ?? 1006, info?.reason ?? DIRECT_FAILURE, false);
      }, () => socket._finish(1006, DIRECT_FAILURE, false));
    } else socket._finish(1006, DIRECT_FAILURE, false);
  };
  const invalid = error => {
    if (disposed) return;
    socket._state = CLOSING;
    socket._emit('error', {error});
    finish(CLOSE.invalid, 'Invalid private room data', false);
  };
  const sendControl = message => control.send(JSON.stringify(message));
  const drainClose = () => {
    cleanClose = true;
    control.close();
    poses.close();
  };
  const beginClose = () => {
    socket._state = CLOSING;
    closeTimer = setTimeout(() => fail(new Error('Room close acknowledgement timed out')), 2000);
  };
  const ready = () => {
    if (socket.readyState !== CONNECTING || control?.readyState !== 'open' || poses?.readyState !== 'open') return;
    if (host) {
      if (!helloReceived) return;
      sendControl({type: 'ready'});
      socket._open();
      clearTimeout(negotiationTimer);
      onSocket(socket, remoteHello);
    } else if (!helloSent) {
      helloSent = true;
      sendControl({type: 'hello', hello});
    }
  };
  const handleControl = event => {
    try {
      if (typeof event.data !== 'string' || event.data.length > MAX_CONTROL_BYTES ||
          encoder.encode(event.data).byteLength > MAX_CONTROL_BYTES) throw new Error('Invalid room control size');
      const message = JSON.parse(event.data);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid room control message');
      switch (message.type) {
        case 'hello':
          if (!host || helloReceived || !message.hello || typeof message.hello !== 'object') throw new Error('Invalid room hello');
          remoteHello = message.hello;
          helloReceived = true;
          ready();
          break;
        case 'ready':
          if (host || !helloSent || socket.readyState !== CONNECTING ||
              control.readyState !== 'open' || poses?.readyState !== 'open') throw new Error('Unexpected room ready');
          clearTimeout(negotiationTimer);
          socket._open();
          break;
        case 'data':
          if (typeof message.data !== 'string' || socket.readyState === CONNECTING) throw new Error('Unexpected room data');
          if (socket.readyState === OPEN) {
            const data = host ? message.data : incoming.read(message.data);
            if (data !== null) {
              const frames = host ? [data] : encodeControlFrames(data);
              for (const frame of frames) {
                if (socket.readyState !== OPEN) break;
                socket._emit('message', {data: frame});
              }
            }
          }
          break;
        case 'close':
          if ((message.code !== 1000 && (!Number.isInteger(message.code) || message.code < 3000 || message.code > 4999)) ||
              typeof message.reason !== 'string' || encoder.encode(message.reason).byteLength > 123) throw new Error('Invalid room close');
          closeInfo = {code: message.code, reason: host ? message.reason : roomCloseReason(message.code, message.reason)};
          if (socket.readyState < CLOSING) beginClose();
          sendControl({type: 'closed'});
          drainClose();
          break;
        case 'closed':
          if (!closeInfo || socket.readyState !== CLOSING) throw new Error('Unexpected room close acknowledgement');
          drainClose();
          break;
        default:
          throw new Error('Unknown room control message');
      }
    } catch (error) { invalid(error); }
  };
  const attach = channel => {
    if (channel.label === 'control' && !control) {
      control = channel;
      channel.onmessage = handleControl;
    } else if (channel.label === 'binary' && !poses) {
      poses = channel;
      channel.binaryType = 'arraybuffer';
      channel.onmessage = async event => {
        if (socket.readyState !== OPEN) return;
        try {
          if (!binary(event.data) || dataSize(event.data) > MAX_CONTROL_BYTES) throw new Error('Invalid room binary frame');
          const data = event.data instanceof Blob ? await event.data.arrayBuffer() :
            ArrayBuffer.isView(event.data) ? copyData(event.data) : event.data;
          if (!host) validateRoomBinary(data);
          if (socket.readyState === OPEN) await receive(socket, data);
        } catch (error) { invalid(error); }
      };
    } else {
      channel.close();
      invalid(new Error('Unexpected room data channel'));
      return;
    }
    channel.onopen = () => { try { ready(); } catch (error) { fail(error); } };
    channel.onerror = event => fail(event.error || new Error('Room data channel failed'));
    channel.onclosing = () => {
      if (!disposed && !closeInfo) fail(new Error('Room data channel is closing'));
    };
    channel.onclose = () => {
      if (disposed) return;
      if (channel === poses && socket.readyState === CLOSING && closeInfo) return;
      // A clean control close drains the reliable metadata before closing SCTP.
      if (cleanClose && closeInfo) {
        if (control.readyState === 'closed') finish(closeInfo.code, closeInfo.reason, true);
      } else fail(new Error('Room data channel closed'));
    };
    ready();
  };
  socket.getStats = () => pc ? pc.getStats() : Promise.resolve(new Map());
  socket._amount = () => disposed ? 0 : (control?.bufferedAmount || 0) + (poses?.bufferedAmount || 0);
  socket._send = data => {
    try {
      if (control?.readyState !== 'open' || poses?.readyState !== 'open') {
        throw new Error('Room data channels are not open');
      }
      if (binary(data)) poses.send(data);
      else sendControl({type: 'data', data: String(data)});
    } catch (error) { fail(error); }
  };
  socket._close = (code, reason) => {
    if (socket.readyState === CONNECTING) {
      socket._state = CLOSING;
      queueMicrotask(() => {
        if (code >= 3000) finish(code, reason, true);
        else fail(new Error('Socket closed while connecting'));
      });
      return;
    }
    closeInfo = {code, reason};
    beginClose();
    try { sendControl({type: 'close', code, reason}); } catch (error) { fail(error); }
  };
  const enqueue = callback => {
    if (disposed) return;
    if (++queuedNegotiations > 256) { invalid(new Error('Too much room negotiation')); return; }
    negotiation = negotiation.then(() => { if (!disposed) return callback(); }).catch(fail)
      .finally(() => { queuedNegotiations--; });
  };
  const setRemote = async description => {
    await pc.setRemoteDescription(description);
    if (disposed) return;
    for (const candidate of candidates.splice(0)) await pc.addIceCandidate(candidate);
  };
  const accept = message => {
    if (disposed) return;
    if (message.type === 'ice' && message.payload?.from === (host ? 'client' : 'host')) {
      enqueue(async () => {
        if (pc.remoteDescription) await pc.addIceCandidate(message.payload.candidate);
        else {
          if (candidates.length >= 256) { invalid(new Error('Too many ICE candidates')); return; }
          candidates.push(message.payload.candidate);
        }
      });
    } else if (host && message.type === 'offer') {
      if (remoteReceived) { invalid(new Error('Repeated room offer')); return; }
      remoteReceived = true;
      enqueue(async () => {
        await setRemote(message.payload);
        if (disposed) return;
        await pc.setLocalDescription(await pc.createAnswer());
        if (!disposed) signal('answer', pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription);
      });
    } else if (!host && message.type === 'answer') {
      if (remoteReceived) { invalid(new Error('Repeated room answer')); return; }
      remoteReceived = true;
      enqueue(() => setRemote(message.payload));
    }
  };
  try {
    negotiationTimer = setTimeout(() => fail(new Error('Room negotiation timed out')), 15000);
    pc = new RTCPeerConnection(rtcConfig ?? RTC_CONFIG);
    pc.onicecandidate = event => {
      if (disposed || !event.candidate) return;
      try {
        signal('ice', {from: host ? 'host' : 'client', candidate: event.candidate.toJSON()});
      } catch (error) { fail(error); }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') fail(new Error('Room peer connection failed'));
      else if (pc.connectionState === 'closed' && !disposed) fail(new Error('Room peer connection closed'));
    };
    if (host) pc.ondatachannel = event => attach(event.channel);
    else {
      attach(pc.createDataChannel('control', {ordered: true, protocol: PROTOCOL}));
      attach(pc.createDataChannel('binary', {ordered: false, maxRetransmits: 0, protocol: PROTOCOL}));
      enqueue(async () => {
        await pc.setLocalDescription(await pc.createOffer());
        if (!disposed) signal('offer', pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription);
      });
    }
  } catch (error) { queueMicrotask(() => fail(error)); }
  return {socket, accept};
}

export function createPeerSocket({roomId, peerId, signalling, hello, maps, rtcConfig, onFailure}) {
  let unsubscribe;
  const connection = createConnection({roomId, peerId, signalling, hello, maps, rtcConfig, onFailure, host: false,
    onDispose: () => unsubscribe?.()});
  unsubscribe = signalling.subscribe(message => {
    if (message.roomId === roomId && message.peerId === (typeof peerId === 'function' ? peerId() : peerId)) {
      connection.accept(message);
    }
  });
  return connection.socket;
}

export function listenRoom({roomId, signalling, onSocket, rtcConfig, now = Date.now}) {
  const peers = new Map(), offers = new Map();
  const unsubscribe = signalling.subscribe(message => {
    if (message.roomId !== roomId || typeof message.peerId !== 'string') return;
    if (message.type === 'peer-left') {
      offers.delete(message.peerId);
      const connection = peers.get(message.peerId);
      if (connection?.socket.readyState === CONNECTING) connection.socket.close(CLOSE.gone, ROOM_TEXTS.cancelled);
      return;
    }
    if (message.type !== 'offer' && !(message.type === 'ice' && message.payload?.from === 'client')) return;
    const time = now();
    for (const [id, rate] of offers) if (time - rate.start >= 60000) offers.delete(id);
    let rate = offers.get(message.peerId);
    if (message.type === 'offer') {
      if (!rate) {
        if (offers.size >= 4096) return;
        offers.set(message.peerId, rate = {start: time, count: 0});
      }
      if (++rate.count > 3) return;
    }
    let connection = peers.get(message.peerId);
    if (!connection) {
      if (rate?.count > 3 || peers.size >= 65536) return;
      const pending = [...peers.values()].filter(peer => peer.socket.readyState === CONNECTING);
      if (pending.length >= 32) pending[0].socket.close(CLOSE.gone, ROOM_TEXTS.cancelled);
      connection = createConnection({roomId, peerId: message.peerId, signalling, rtcConfig, host: true, onSocket,
        onDispose: () => { if (peers.get(message.peerId) === connection) peers.delete(message.peerId); }});
      peers.set(message.peerId, connection);
    }
    connection.accept(message);
  });
  return () => {
    unsubscribe();
    for (const {socket} of peers.values()) socket.close(CLOSE.gone, ROOM_TEXTS.hostClosed);
    peers.clear();
    offers.clear();
  };
}
