const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
const PROTOCOL = 'surfd-v1';
const RTC_CONFIG = {iceServers: [{urls: 'stun:stun.l.google.com:19302'}]};
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

export function createLoopbackPair() {
  const sockets = [new RoomSocket(), new RoomSocket()];
  let pending = Promise.resolve();
  const enqueue = callback => {
    pending = pending.then(() => new Promise(resolve => setTimeout(resolve, 0))).then(callback);
  };
  for (const [index, socket] of sockets.entries()) {
    const peer = sockets[1 - index];
    socket._send = data => {
      const copy = copyData(data), size = dataSize(copy);
      socket._buffered += size;
      enqueue(async () => {
        socket._buffered -= size;
        await receive(peer, copy);
      });
    };
    socket._close = (code, reason) => {
      const connecting = socket.readyState === CONNECTING;
      socket._state = CLOSING;
      peer._state = CLOSING;
      enqueue(() => {
        if (connecting) socket._emit('error', {error: new Error('Socket closed while connecting')});
        socket._finish(connecting ? 1006 : code, connecting ? '' : reason, !connecting);
        peer._finish(connecting ? 1006 : code, connecting ? '' : reason, !connecting);
      });
    };
  }
  enqueue(() => {
    // Both endpoints must be writable before either open callback can send.
    for (const socket of sockets) if (socket.readyState === CONNECTING) socket._state = OPEN;
    for (const socket of sockets) if (socket.readyState === OPEN) socket._emit('open');
  });
  return sockets;
}

function createConnection({roomId, peerId, signalling, hello, rtcConfig, host, onSocket, onDispose}) {
  const socket = new RoomSocket();
  let pc, control, poses, remoteHello, helloReceived = false, helloSent = false;
  let disposed = false, closeTimer, closeInfo = null, cleanClose = false;
  let negotiation = Promise.resolve();
  const candidates = [];
  const signal = (type, payload) => signalling.send({roomId, peerId, type, payload});
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(closeTimer);
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
    socket._emit('error', {error});
    finish(1006, '', false);
  };
  const sendControl = message => control.send(JSON.stringify(message));
  const drainClose = () => {
    cleanClose = true;
    control.close();
    poses.close();
  };
  const beginClose = () => {
    socket._state = CLOSING;
    closeTimer = setTimeout(() => finish(1006, '', false), 2000);
  };
  const ready = () => {
    if (socket.readyState !== CONNECTING || control?.readyState !== 'open' || poses?.readyState !== 'open') return;
    if (host) {
      if (!helloReceived) return;
      sendControl({type: 'ready'});
      socket._open();
      onSocket(socket, remoteHello);
    } else if (!helloSent) {
      helloSent = true;
      sendControl({type: 'hello', hello});
    }
  };
  const handleControl = event => {
    try {
      if (typeof event.data !== 'string') throw new Error('Expected room control text');
      const message = JSON.parse(event.data);
      if (!message || typeof message !== 'object') throw new Error('Invalid room control message');
      switch (message.type) {
        case 'hello':
          if (!host || helloReceived || !message.hello || typeof message.hello !== 'object') throw new Error('Invalid room hello');
          remoteHello = message.hello;
          helloReceived = true;
          ready();
          break;
        case 'ready':
          if (host || !helloSent || socket.readyState !== CONNECTING) throw new Error('Unexpected room ready');
          socket._open();
          break;
        case 'data':
          if (typeof message.data !== 'string' || socket.readyState === CONNECTING) throw new Error('Unexpected room data');
          if (socket.readyState === OPEN) socket._emit('message', {data: message.data});
          break;
        case 'close':
          if ((message.code !== 1000 && (!Number.isInteger(message.code) || message.code < 3000 || message.code > 4999)) ||
              typeof message.reason !== 'string' || encoder.encode(message.reason).byteLength > 123) throw new Error('Invalid room close');
          closeInfo = {code: message.code, reason: message.reason};
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
    } catch (error) { fail(error); }
  };
  const attach = channel => {
    if (channel.label === 'control' && !control) {
      control = channel;
      channel.onmessage = handleControl;
    } else if (channel.label === 'binary' && !poses) {
      poses = channel;
      channel.binaryType = 'arraybuffer';
      channel.onmessage = event => {
        if (!binary(event.data)) return fail(new Error('Expected room binary frame'));
        if (socket.readyState === OPEN) receive(socket, event.data).catch(fail);
      };
    } else {
      channel.close();
      fail(new Error('Unexpected room data channel'));
      return;
    }
    channel.onopen = () => { try { ready(); } catch (error) { fail(error); } };
    channel.onerror = event => fail(event.error || new Error('Room data channel failed'));
    channel.onclose = () => {
      if (disposed) return;
      if (channel === poses && socket.readyState === CLOSING && closeInfo) return;
      // A clean control close drains the reliable metadata before closing SCTP.
      if (cleanClose && closeInfo) {
        if (control.readyState === 'closed') finish(closeInfo.code, closeInfo.reason, true);
      } else finish(1006, '', false);
    };
    ready();
  };
  socket._amount = () => (control?.bufferedAmount || 0) + (poses?.bufferedAmount || 0);
  socket._send = data => {
    if (binary(data)) poses.send(data);
    else sendControl({type: 'data', data: String(data)});
  };
  socket._close = (code, reason) => {
    if (socket.readyState === CONNECTING) {
      socket._state = CLOSING;
      queueMicrotask(() => fail(new Error('Socket closed while connecting')));
      return;
    }
    closeInfo = {code, reason};
    beginClose();
    try { sendControl({type: 'close', code, reason}); } catch (error) { fail(error); }
  };
  const enqueue = callback => {
    negotiation = negotiation.then(() => { if (!disposed) return callback(); }).catch(fail);
  };
  const setRemote = async description => {
    await pc.setRemoteDescription(description);
    if (disposed) return;
    for (const candidate of candidates.splice(0)) await pc.addIceCandidate(candidate);
  };
  const accept = message => {
    if (message.type === 'ice' && message.payload?.from === (host ? 'client' : 'host')) {
      enqueue(async () => {
        if (pc.remoteDescription) await pc.addIceCandidate(message.payload.candidate);
        else candidates.push(message.payload.candidate);
      });
    } else if (host && message.type === 'offer') {
      enqueue(async () => {
        await setRemote(message.payload);
        if (disposed) return;
        await pc.setLocalDescription(await pc.createAnswer());
        if (!disposed) signal('answer', pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription);
      });
    } else if (!host && message.type === 'answer') {
      enqueue(() => setRemote(message.payload));
    }
  };
  try {
    pc = new RTCPeerConnection(rtcConfig ?? RTC_CONFIG);
    pc.onicecandidate = event => {
      if (disposed || !event.candidate) return;
      try {
        signal('ice', {from: host ? 'host' : 'client', candidate: event.candidate.toJSON()});
      } catch (error) { fail(error); }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') fail(new Error('Room peer connection failed'));
      else if (pc.connectionState === 'closed' && !disposed) finish(1006, '', false);
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

export function createPeerSocket({roomId, peerId, signalling, hello, rtcConfig}) {
  let unsubscribe;
  const connection = createConnection({roomId, peerId, signalling, hello, rtcConfig, host: false,
    onDispose: () => unsubscribe?.()});
  unsubscribe = signalling.subscribe(message => {
    if (message.roomId === roomId && message.peerId === peerId) connection.accept(message);
  });
  return connection.socket;
}

export function listenRoom({roomId, signalling, onSocket, rtcConfig}) {
  const peers = new Map();
  const unsubscribe = signalling.subscribe(message => {
    if (message.roomId !== roomId || typeof message.peerId !== 'string') return;
    if (message.type !== 'offer' && !(message.type === 'ice' && message.payload?.from === 'client')) return;
    let connection = peers.get(message.peerId);
    if (!connection) {
      connection = createConnection({roomId, peerId: message.peerId, signalling, rtcConfig, host: true, onSocket,
        onDispose: () => peers.delete(message.peerId)});
      peers.set(message.peerId, connection);
    }
    connection.accept(message);
  });
  return () => {
    unsubscribe();
    for (const {socket} of peers.values()) socket.close(4004, 'Room closed');
    peers.clear();
  };
}
