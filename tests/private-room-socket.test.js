import {afterEach, describe, expect, test} from 'bun:test';
import {createClosedSocket, createLoopbackPair, createPeerSocket, listenRoom} from '../src/private-rooms/socket.js';
import {createBroadcastSignalling} from '../src/private-rooms/signalling.js';
import {CLOSE, DEFAULT_APPEARANCE, MAX_CONTROL_BYTES, MAX_ROOM_PLAYERS, decodePoseBatch, decodeSnapshot, decodeSpectator, encodeControlFrames, encodePoseBatch, encodeSnapshot, encodeSpectator} from '../src/private-rooms/protocol.js';

const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));
const once = (target, type) => new Promise(resolve => target.addEventListener(type, resolve, {once: true}));
const originalRTC = globalThis.RTCPeerConnection;
const originalBroadcast = globalThis.BroadcastChannel;
const cleanups = [];
const directFailure = "Couldn't connect to the host. Their network or yours may block direct connections.";
const pose = {time: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, flags: 0, seconds: 0};
const batch = (sequence, slot = 0) => ({sequence, slot, epoch: 1, samples: [pose]});
const spectator = (sequence, slot) => ({
  sequence, slot, epoch: 1,
  pose: {...pose, eyeHeight: 1, phase: 'ready', untimed: false, checkpoints: 0, stage: 0},
});
const uuid = slot => '00000000-0000-4000-8000-' + String(slot).padStart(12, '0');
const roomPlayer = (slot = 0) => ({
  id: 'private-' + uuid(slot), connectionId: uuid(slot), slot, name: 'Guest',
  rank: 'Guest', points: 0, guest: false, moderator: false, appearance: DEFAULT_APPEARANCE, spectating: false,
});
const maps = [{id: 'one', title: 'One', tier: 1}];
const roomState = {roomId: 'room-a', name: "Host's room", mapId: 'one', mapTitle: 'One',
  epoch: 1, startedAt: 1, endsAt: 0, untimed: true, recent: [], nominations: {}, rtv: [], vote: null, nextMap: null};
const welcome = () => ({type: 'welcome', state: {...roomState}, player: roomPlayer(), players: [roomPlayer()],
  maps: [{id: 'one', title: 'One', tier: 1}], serverTime: 1, spectatorStream: true,
  playtime: false, activityTracking: false, recentResults: [], chatMute: null});
const notice = text => JSON.stringify({type: 'notice', text});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await nextTask();
  globalThis.RTCPeerConnection = originalRTC;
  globalThis.BroadcastChannel = originalBroadcast;
});

function signalBus() {
  const callbacks = new Set(), messages = [];
  return {
    messages,
    get subscribers() { return callbacks.size; },
    send(message) {
      const copy = structuredClone(message);
      messages.push(copy);
      queueMicrotask(() => { for (const callback of callbacks) callback(copy); });
    },
    subscribe(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },
  };
}

class FakeChannel {
  constructor(label, options) {
    Object.assign(this, options);
    this.label = label;
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this.sent = [];
  }
  open() {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    this.onopen?.({});
  }
  send(data) {
    if (this.readyState !== 'open') throw new DOMException('Channel is not open', 'InvalidStateError');
    const copy = typeof data === 'string' ? data : data instanceof ArrayBuffer ? data.slice(0) :
      data instanceof Blob ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const size = typeof copy === 'string' ? new TextEncoder().encode(copy).length : copy.size ?? copy.byteLength;
    this.sent.push(copy);
    this.bufferedAmount += size;
    queueMicrotask(() => {
      this.bufferedAmount -= size;
      if (this.peer.readyState !== 'closed') this.peer.onmessage?.({data: copy});
    });
  }
  close() {
    if (this.readyState === 'closed' || this.readyState === 'closing') return;
    this.readyState = 'closing';
    this.onclosing?.({});
    queueMicrotask(() => {
      this.readyState = 'closed';
      this.onclose?.({});
      if (this.peer && this.peer.readyState !== 'closed') {
        this.peer.readyState = 'closing';
        this.peer.onclosing?.({});
        this.peer.readyState = 'closed';
        this.peer.onclose?.({});
      }
    });
  }
}

function fakeRTC({holdHostBinary = false, holdClientBinary = false, rejectRemote = false} = {}) {
  const connections = [];
  class FakeRTC {
    constructor(config) {
      this.config = config;
      this.id = connections.length;
      this.channels = [];
      this.candidates = [];
      this.connectionState = 'new';
      this.stats = new Map([['transport', {type: 'transport', bytesSent: 1200, bytesReceived: 900}]]);
      connections.push(this);
    }
    createDataChannel(label, options) {
      const channel = new FakeChannel(label, options);
      this.channels.push(channel);
      return channel;
    }
    async createOffer() { return {type: 'offer', sdp: String(this.id)}; }
    async createAnswer() { return {type: 'answer', sdp: this.remoteDescription.sdp}; }
    async setLocalDescription(description) {
      this.localDescription = description;
      // ICE deliberately races ahead of offer/answer publication.
      this.onicecandidate?.({candidate: {toJSON: () => ({candidate: 'candidate-' + this.id})}});
    }
    async setRemoteDescription(description) {
      if (rejectRemote) throw new Error('Rejected remote description');
      this.remoteDescription = description;
      if (description.type === 'offer') {
        this.client = connections[Number(description.sdp)];
        this.client.host = this;
        for (const clientChannel of this.client.channels) {
          const channel = new FakeChannel(clientChannel.label, {
            ordered: clientChannel.ordered, maxRetransmits: clientChannel.maxRetransmits, protocol: clientChannel.protocol,
          });
          channel.peer = clientChannel;
          clientChannel.peer = channel;
          this.channels.push(channel);
          this.ondatachannel?.({channel});
        }
      } else {
        this.channels[0].open();
        if (!holdClientBinary) this.channels[1].open();
        this.host.channels[0].open();
        // Client hello arrives before the host's binary channel is ready.
        if (!holdHostBinary) queueMicrotask(() => this.host.channels[1].open());
      }
    }
    async addIceCandidate(candidate) {
      if (!this.remoteDescription) throw new Error('ICE arrived before remote description');
      this.candidates.push(candidate);
    }
    async getStats() { return this.stats; }
    close() {
      this.connectionState = 'closed';
      for (const channel of this.channels) channel.close();
    }
  }
  globalThis.RTCPeerConnection = FakeRTC;
  return connections;
}

function rtcPair(options = {}) {
  const connections = fakeRTC(options), signalling = signalBus(), accepted = [], events = [];
  const stop = listenRoom({roomId: 'room-a', signalling, onSocket(socket, hello) {
    accepted.push({socket, hello});
    events.push('accept');
    socket.send(JSON.stringify(welcome()));
  }});
  cleanups.push(stop);
  const client = createPeerSocket({roomId: 'room-a', peerId: 'peer-a', signalling, maps, onFailure: options.onFailure,
    hello: {name: 'Guest', appearance: {color: 'blue'}, guest: true}});
  client.onopen = () => events.push('open');
  client.onmessage = event => events.push(event.data);
  cleanups.push(() => client.close());
  return {connections, signalling, accepted, client, events, stop};
}

describe('private room loopback socket', () => {
  test('opens asynchronously with a WebSocket surface and delivers welcome after open', async () => {
    const [client, host] = createLoopbackPair(), events = [];
    cleanups.push(() => client.close());
    expect(client.readyState).toBe(client.CONNECTING);
    expect(client.protocol).toBe('surfd-v1');
    expect(client.binaryType).toBe('blob');
    expect(() => client.send('early')).toThrow();
    client.binaryType = 'invalid';
    expect(client.binaryType).toBe('blob');
    client.onopen = event => { expect(event.target).toBe(client); events.push('open'); };
    host.onopen = () => host.send('welcome');
    client.onmessage = event => events.push(event.data);
    await once(client, 'message');
    expect(events).toEqual(['open', 'welcome']);
    expect(host.readyState).toBe(host.OPEN);
  });

  test('copies ArrayBuffer and typed view ownership and accounts for queued bytes', async () => {
    const [client, host] = createLoopbackPair();
    cleanups.push(() => client.close());
    host.binaryType = 'arraybuffer';
    await once(client, 'open');
    const received = [];
    host.onmessage = event => received.push(event.data);
    const original = new Uint8Array([1, 2, 3, 4]);
    client.send(original.subarray(1, 3));
    client.send(original.buffer);
    original.fill(9);
    expect(client.bufferedAmount).toBe(6);
    expect(received).toEqual([]);
    const closed = once(host, 'close');
    client.close(4001, 'Leaving');
    expect(client.readyState).toBe(client.CLOSING);
    expect(host.readyState).toBe(host.CLOSING);
    client.send('discarded');
    const event = await closed;
    expect(received.map(data => [...new Uint8Array(data)])).toEqual([[2, 3], [1, 2, 3, 4]]);
    expect(client.bufferedAmount).toBe(0);
    expect(event).toMatchObject({code: 4001, reason: 'Leaving', wasClean: true});
    expect(client.readyState).toBe(client.CLOSED);
  });

  test('honors binaryType and preserves asynchronous Blob/text ordering', async () => {
    const [client, host] = createLoopbackPair();
    cleanups.push(() => client.close());
    await once(client, 'open');
    let incoming = once(host, 'message');
    client.send(new Uint8Array([7]));
    expect((await incoming).data).toBeInstanceOf(Blob);
    host.binaryType = 'arraybuffer';
    const received = [];
    host.onmessage = event => received.push(event.data);
    client.send(new Blob([new Uint8Array([8])]));
    client.send('after');
    incoming = once(host, 'close');
    client.close();
    await incoming;
    expect([...new Uint8Array(received[0])]).toEqual([8]);
    expect(received[1]).toBe('after');
  });

  test('validates close metadata and cancels a connecting socket without opening', async () => {
    const [client, host] = createLoopbackPair(), events = [];
    client.onopen = () => events.push('open');
    client.onerror = () => events.push('error');
    client.onclose = () => events.push('close');
    expect(() => client.close(1006)).toThrow();
    expect(() => client.close(4000, 'é'.repeat(62))).toThrow();
    expect(client.readyState).toBe(client.CONNECTING);
    const closed = once(client, 'close');
    client.close();
    client.close();
    expect(await closed).toMatchObject({code: 1006, reason: '', wasClean: false});
    expect(events).toEqual(['error', 'close']);
    expect(host.readyState).toBe(host.CLOSED);
  });

  test('batches bursts in one task and releases both ports', async () => {
    const NativeMessageChannel = globalThis.MessageChannel;
    let channel, posts = 0, closedPorts = 0;
    globalThis.MessageChannel = class {
      constructor() {
        channel = this;
        this.port1 = {onmessage: null, close() { closedPorts++; }};
        this.port2 = {postMessage() { posts++; }, close() { closedPorts++; }};
      }
    };
    let client, host;
    try { [client, host] = createLoopbackPair(); }
    finally { globalThis.MessageChannel = NativeMessageChannel; }
    cleanups.push(() => client.close());
    const events = [];
    client.onopen = () => events.push('open');
    host.onmessage = event => events.push(event.data);
    await channel.port1.onmessage();
    expect(events).toEqual(['open']);
    for (let index = 0; index < 200; index++) client.send('control-' + index);
    client.close(4004, 'Room closed');
    host.onclose = () => events.push('close');
    expect(posts).toBe(2);
    expect(events).toEqual(['open']);
    await channel.port1.onmessage();
    expect(events).toEqual(['open', ...Array.from({length: 200}, (_, index) => 'control-' + index), 'close']);
    expect(client.bufferedAmount).toBe(0);
    expect(closedPorts).toBe(2);
    expect(channel.port1.onmessage).toBeNull();
  });

  test('retains latest poses without dropping reliable controls', async () => {
    const [client, host] = createLoopbackPair();
    cleanups.push(() => client.close());
    host.binaryType = 'arraybuffer';
    await once(client, 'open');
    const received = [];
    host.onmessage = event => received.push(event.data);
    client.send('chat');
    for (let sequence = 0; sequence < 2000; sequence++) client.send(encodePoseBatch(batch(sequence)));
    client.send('state');
    client.send(encodePoseBatch(batch(2000)));
    client.send('control');
    expect(client.bufferedAmount).toBe(44 + 4 + 5 + 7);
    const closed = once(host, 'close');
    client.close();
    await closed;
    expect(received.filter(data => typeof data === 'string')).toEqual(['chat', 'state', 'control']);
    expect(decodePoseBatch(received[2]).sequence).toBe(2000);
    expect(received).toHaveLength(4);
    expect(client.bufferedAmount).toBe(0);
  });

  test('coalesces snapshot blocks by slot without losing disjoint chunks', async () => {
    const [client, host] = createLoopbackPair();
    cleanups.push(() => client.close());
    host.binaryType = 'arraybuffer';
    await once(client, 'open');
    const received = [];
    host.onmessage = event => received.push(decodeSnapshot(event.data));
    client.send(encodeSnapshot(Array.from({length: 100}, (_, slot) => batch(1, slot))));
    client.send(encodeSnapshot([batch(1, 100), batch(1, 65535)]));
    client.send(encodeSnapshot([batch(2, 2), batch(2, 65535)]));
    expect(client.bufferedAmount).toBe(3 * 4 + 102 * 46);
    const closed = once(host, 'close');
    client.close();
    await closed;
    expect(received.map(blocks => blocks.length)).toEqual([99, 1, 2]);
    const blocks = received.flat(), slots = new Map(blocks.map(block => [block.slot, block.sequence]));
    expect(blocks).toHaveLength(102);
    expect(slots.size).toBe(102);
    expect(slots.get(2)).toBe(2);
    expect(slots.get(65535)).toBe(2);
    expect(slots.get(100)).toBe(1);
    expect(client.bufferedAmount).toBe(0);
  });

  test('keeps spectator senders and directions independent', async () => {
    const [client, host] = createLoopbackPair();
    cleanups.push(() => client.close());
    client.binaryType = host.binaryType = 'arraybuffer';
    await once(client, 'open');
    const incoming = [], outgoing = [];
    host.onmessage = event => incoming.push(decodeSpectator(event.data, true));
    client.onmessage = event => outgoing.push(decodeSpectator(event.data, true));
    client.send(encodeSpectator(spectator(1, 1), true));
    client.send(encodeSpectator(spectator(1, 2), true));
    host.send(encodeSpectator(spectator(3, 1), true));
    client.send(encodeSpectator(spectator(2, 1), true));
    expect(client.bufferedAmount).toBe(112);
    expect(host.bufferedAmount).toBe(56);
    const closed = once(host, 'close');
    client.close();
    await closed;
    expect(incoming.map(packet => [packet.slot, packet.sequence])).toEqual([[2, 1], [1, 2]]);
    expect(outgoing.map(packet => [packet.slot, packet.sequence])).toEqual([[1, 3]]);
  });

  test('does not coalesce unknown or malformed binary frames', async () => {
    const [client, host] = createLoopbackPair();
    cleanups.push(() => client.close());
    host.binaryType = 'arraybuffer';
    await once(client, 'open');
    const frames = [[1, 9, 0, 0], [1, 2, 1, 0], [1, 1, 1, 0]], received = [];
    host.onmessage = event => received.push([...new Uint8Array(event.data)]);
    for (const frame of frames) {
      client.send(new Uint8Array(frame));
      client.send(new Uint8Array(frame));
    }
    expect(client.bufferedAmount).toBe(24);
    const closed = once(host, 'close');
    client.close();
    await closed;
    expect(received).toEqual(frames.flatMap(frame => [frame, frame]));
  });

  test('returns empty loopback stats', async () => {
    const [client] = createLoopbackPair();
    cleanups.push(() => client.close());
    expect(await client.getStats()).toEqual(new Map());
  });
});

describe('private room WebRTC socket', () => {
  test('waits for both channels and hello, then opens before the host welcome', async () => {
    const {client, connections, accepted, events} = rtcPair({holdHostBinary: true});
    await nextTask();
    expect(accepted).toEqual([]);
    expect(client.readyState).toBe(client.CONNECTING);
    expect(connections[1].channels[0].readyState).toBe('open');
    connections[1].channels[1].open();
    await nextTask();
    expect(accepted).toHaveLength(1);
    expect(accepted[0].hello).toEqual({name: 'Guest', appearance: {color: 'blue'}, guest: true});
    expect(accepted[0].socket.readyState).toBe(client.OPEN);
    expect(events).toEqual(['accept', 'open', JSON.stringify(welcome())]);
    expect(connections[0].config).toEqual({iceServers: [{urls: 'stun:stun.l.google.com:19302'}]});
    expect(connections[0].channels[0]).toMatchObject({ordered: true, protocol: 'surfd-v1'});
    expect(connections[0].channels[1]).toMatchObject({ordered: false, maxRetransmits: 0, protocol: 'surfd-v1'});
    expect(connections[0].candidates).toEqual([{candidate: 'candidate-1'}]);
    expect(connections[1].candidates).toEqual([{candidate: 'candidate-0'}]);
  });

  test('routes strings reliably and binary poses/spectator frames unreliably in both directions', async () => {
    const {client, accepted, connections} = rtcPair();
    await nextTask();
    const host = accepted[0].socket, hostMessages = [], clientMessages = [];
    host.binaryType = client.binaryType = 'arraybuffer';
    host.onmessage = event => hostMessages.push(event.data);
    client.onmessage = event => clientMessages.push(event.data);
    client.send('{"type":"map"}');
    client.send(new Uint8Array([1, 2]).buffer);
    host.send(new Uint8Array(encodeSnapshot([batch(1, 1)])));
    host.send(notice('Map is not in the catalog.'));
    expect(client.bufferedAmount).toBeGreaterThan(0);
    await nextTask();
    expect(hostMessages[0]).toBe('{"type":"map"}');
    expect([...new Uint8Array(hostMessages[1])]).toEqual([1, 2]);
    expect(decodeSnapshot(clientMessages[0])).toEqual([batch(1, 1)]);
    expect(clientMessages[1]).toBe(notice('Map is not in the catalog.'));
    expect(connections[0].channels[0].sent.map(JSON.parse).map(message => message.type)).toEqual(['hello', 'data']);
    expect(connections[0].channels[1].sent).toHaveLength(1);
    expect(client.bufferedAmount).toBe(0);
  });

  test('propagates clean close metadata and tolerates binary closing before reliable acknowledgement', async () => {
    const {client, accepted, connections, signalling} = rtcPair();
    await nextTask();
    const host = accepted[0].socket, clientClosed = once(client, 'close'), hostClosed = once(host, 'close');
    client.close(4002, 'Room ended');
    expect(client.readyState).toBe(client.CLOSING);
    connections[0].channels[1].onclose({});
    expect(client.readyState).toBe(client.CLOSING);
    expect(await clientClosed).toMatchObject({code: 4002, reason: 'Room ended', wasClean: true});
    expect(await hostClosed).toMatchObject({code: 4002, reason: 'Room ended', wasClean: true});
    expect(signalling.subscribers).toBe(1);
    expect(connections.every(connection => connection.connectionState === 'closed')).toBe(true);
    expect(connections[0].channels[0].sent.map(JSON.parse)).toContainEqual({type: 'close', code: 4002, reason: 'Room ended'});
  });

  test('cleans up listeners and accepted sockets when the host listener stops', async () => {
    const {client, stop, signalling} = rtcPair();
    await nextTask();
    const closed = once(client, 'close');
    stop();
    expect(await closed).toMatchObject({code: 4004, reason: 'The host closed the private room.', wasClean: true});
    expect(signalling.subscribers).toBe(0);
  });

  test('reports channel errors once and closes abnormally', async () => {
    const {client, connections} = rtcPair(), errors = [];
    await nextTask();
    client.onerror = event => errors.push(event.error.message);
    const closed = once(client, 'close');
    connections[0].channels[0].onerror({error: new Error('SCTP failed')});
    connections[0].channels[0].onerror({error: new Error('Duplicate')});
    expect(await closed).toMatchObject({code: 1006, reason: directFailure, wasClean: false});
    expect(errors).toEqual(['SCTP failed']);
  });

  test('reports negotiation rejection and ignores unrelated rooms, peers, and discovery messages', async () => {
    const connections = fakeRTC({rejectRemote: true}), signalling = signalBus();
    const client = createPeerSocket({roomId: 'a', peerId: 'p', signalling, hello: {guest: true}});
    const errors = [];
    client.onerror = event => errors.push(event.error.message);
    signalling.send({roomId: 'other', peerId: 'p', type: 'answer', payload: {}});
    signalling.send({roomId: 'a', peerId: 'other', type: 'answer', payload: {}});
    signalling.send({roomId: 'a', peerId: 'p', type: 'room-info', payload: {name: 'Room'}});
    await nextTask();
    expect(client.readyState).toBe(client.CONNECTING);
    expect(connections[0].remoteDescription).toBeUndefined();
    const closed = once(client, 'close');
    signalling.send({roomId: 'a', peerId: 'p', type: 'answer', payload: {type: 'answer', sdp: '0'}});
    expect(await closed).toMatchObject({code: 1006, wasClean: false});
    expect(errors).toEqual(['Rejected remote description']);
    expect(signalling.subscribers).toBe(0);
  });

  test('rejects malformed control messages without exposing them as game data', async () => {
    const {client, connections} = rtcPair();
    await nextTask();
    const errors = [], messages = [];
    client.onerror = event => errors.push(event.error);
    client.onmessage = event => messages.push(event.data);
    const closed = once(client, 'close');
    connections[0].channels[0].onmessage({data: 'not-json'});
    expect(await closed).toMatchObject({code: CLOSE.invalid, wasClean: false});
    expect(errors).toHaveLength(1);
    expect(messages).toEqual([]);
  });

  test('isolates room and peer signalling and honors supplied RTC configuration', async () => {
    const connections = fakeRTC(), signalling = signalBus(), accepted = new Map();
    const rtcConfig = {iceServers: []};
    const stop = listenRoom({roomId: 'a', signalling, rtcConfig, onSocket(socket, hello) {
      accepted.set(hello.name, socket);
    }});
    cleanups.push(stop);
    signalling.send({roomId: 'other', peerId: 'unused', type: 'offer', payload: {}});
    signalling.send({roomId: 'a', peerId: 'unused', type: 'room-query'});
    const clients = ['first', 'second'].map(name => createPeerSocket({
      roomId: 'a', peerId: name, signalling, rtcConfig, hello: {name, guest: true},
    }));
    cleanups.push(() => { for (const client of clients) client.close(); });
    await nextTask();
    expect(connections).toHaveLength(4);
    expect(connections.every(connection => connection.config === rtcConfig)).toBe(true);
    expect(accepted.size).toBe(2);
    const messages = [];
    clients.forEach((client, index) => { client.onmessage = event => messages.push([index, event.data]); });
    accepted.get('second').send(notice('That player is not available to spectate.'));
    await nextTask();
    expect(messages).toEqual([[1, notice('That player is not available to spectate.')]]);
  });

  test('reports peer connection failures as errors and abnormal closes', async () => {
    const {client, connections} = rtcPair();
    await nextTask();
    let error;
    client.onerror = event => { error = event.error; };
    const closed = once(client, 'close');
    connections[0].connectionState = 'failed';
    connections[0].onconnectionstatechange();
    expect(await closed).toMatchObject({code: 1006, wasClean: false});
    expect(error.message).toBe('Room peer connection failed');
  });

  test('checks room closure before reporting an interrupted peer', async () => {
    let resolve;
    const result = new Promise(done => { resolve = done; });
    const {client, connections} = rtcPair({onFailure: () => result});
    await nextTask();
    const closed = once(client, 'close');
    connections[0].connectionState = 'failed';
    connections[0].onconnectionstatechange();
    expect(client.readyState).toBe(client.CLOSING);
    expect(connections[0].connectionState).toBe('closed');
    resolve({code: 4004, reason: 'The host closed the private room.'});
    expect(await closed).toMatchObject({code: 4004, reason: 'The host closed the private room.'});
  });

  test('surfaces unavailable RTC asynchronously so callers can attach error handlers', async () => {
    globalThis.RTCPeerConnection = class {
      constructor() { throw new Error('RTC unavailable'); }
    };
    const signalling = signalBus();
    const client = createPeerSocket({roomId: 'a', peerId: 'p', signalling, hello: {guest: true}});
    let error;
    client.onerror = event => { error = event.error; };
    expect(await once(client, 'close')).toMatchObject({code: 1006, wasClean: false});
    expect(error.message).toBe('RTC unavailable');
    expect(signalling.subscribers).toBe(0);
  });

  test('closing during negotiation cancels subsequent open and offer publication', async () => {
    const connections = fakeRTC(), signalling = signalBus();
    const client = createPeerSocket({roomId: 'a', peerId: 'p', signalling, hello: {guest: true}});
    const events = [];
    client.onopen = () => events.push('open');
    client.onerror = () => events.push('error');
    const closed = once(client, 'close');
    client.close();
    expect(await closed).toMatchObject({code: 1006, wasClean: false});
    await nextTask();
    expect(events).toEqual(['error']);
    expect(signalling.messages).toEqual([]);
    expect(signalling.subscribers).toBe(0);
    expect(connections[0].connectionState).toBe('closed');
  });

  test('waits for the guest binary channel before sending hello', async () => {
    const {client, connections, accepted} = rtcPair({holdClientBinary: true});
    await nextTask();
    expect(client.readyState).toBe(client.CONNECTING);
    expect(connections[0].channels[0].sent).toEqual([]);
    expect(accepted).toEqual([]);
    connections[0].channels[1].open();
    await nextTask();
    expect(client.readyState).toBe(client.OPEN);
    expect(accepted).toHaveLength(1);
  });

  test('refuses all sends if either channel stops being open', async () => {
    for (const index of [0, 1]) {
      for (const data of ['chat', new Uint8Array([1])]) {
        const {client, connections} = rtcPair();
        await nextTask();
        const channels = connections[0].channels, sent = channels.map(channel => channel.sent.length);
        const errors = [], closed = once(client, 'close');
        client.onerror = event => errors.push(event.error);
        channels[index].readyState = 'closing';
        expect(() => client.send(data)).not.toThrow();
        expect(await closed).toMatchObject({code: 1006, reason: directFailure, wasClean: false});
        expect(channels.map(channel => channel.sent.length)).toEqual(sent);
        expect(errors).toHaveLength(1);
        expect(client.readyState).toBe(client.CLOSED);
        expect(client.bufferedAmount).toBe(0);
      }
    }
  });

  test('contains datachannel send failures', async () => {
    for (const index of [0, 1]) {
      const {client, connections} = rtcPair();
      await nextTask();
      const error = new Error('SCTP send rejected'), errors = [], closed = once(client, 'close');
      client.onerror = event => errors.push(event.error);
      connections[0].channels[index].send = () => { throw error; };
      expect(() => client.send(index ? new Uint8Array([1]) : 'chat')).not.toThrow();
      expect(await closed).toMatchObject({code: 1006, reason: directFailure, wasClean: false});
      expect(errors).toEqual([error]);
      expect(() => client.send('after close')).not.toThrow();
    }
  });

  test('closes immediately when a channel starts closing unexpectedly', async () => {
    for (const index of [0, 1]) {
      const {client, connections} = rtcPair();
      await nextTask();
      const channel = connections[0].channels[index], errors = [], closed = once(client, 'close');
      client.onerror = event => errors.push(event.error);
      channel.readyState = 'closing';
      channel.onclosing({});
      expect(client.readyState).toBe(client.CLOSED);
      expect(() => client.send('late')).not.toThrow();
      channel.onclose({});
      expect(await closed).toMatchObject({code: 1006, reason: directFailure, wasClean: false});
      expect(errors).toHaveLength(1);
    }
  });

  test('preserves application close metadata during negotiation', async () => {
    const connections = fakeRTC(), signalling = signalBus();
    const client = createPeerSocket({roomId: 'a', peerId: 'p', signalling, hello: {guest: true}});
    const events = [], closed = once(client, 'close');
    client.onopen = () => events.push('open');
    client.onerror = () => events.push('error');
    client.close(4004, 'This private room has closed.');
    expect(client.readyState).toBe(client.CLOSING);
    expect(await closed).toMatchObject({code: 4004, reason: 'This private room has closed.', wasClean: true});
    expect(events).toEqual([]);
    expect(signalling.subscribers).toBe(0);
    expect(signalling.messages).toEqual([]);
    expect(connections[0].connectionState).toBe('closed');
  });

  test('returns the native RTC stats report', async () => {
    const {client, connections} = rtcPair();
    await nextTask();
    expect(await client.getStats()).toBe(connections[0].stats);
    expect((await client.getStats()).get('transport')).toMatchObject({bytesSent: 1200, bytesReceived: 900});
  });

  test('keeps RTC connected after signalling peer departure', async () => {
    const {client, signalling, accepted} = rtcPair();
    await nextTask();
    signalling.send({roomId: 'room-a', peerId: 'peer-a', type: 'peer-left'});
    await nextTask();
    expect(client.readyState).toBe(client.OPEN);
    expect(accepted[0].socket.readyState).toBe(client.OPEN);
    const incoming = once(client, 'message');
    accepted[0].socket.send(notice('Only the private room host can change maps.'));
    expect((await incoming).data).toBe(notice('Only the private room host can change maps.'));
  });

  test('resolves a deferred signalling peer identity', async () => {
    fakeRTC({rejectRemote: true});
    const signalling = signalBus();
    let peerId = null;
    const client = createPeerSocket({roomId: 'a', peerId: () => peerId, signalling, hello: {guest: true}});
    cleanups.push(() => client.close());
    peerId = 'p';
    await nextTask();
    expect(signalling.messages.every(message => message.peerId === 'p')).toBe(true);
    const closed = once(client, 'close');
    signalling.send({roomId: 'a', peerId: 'p', type: 'answer', payload: {type: 'answer', sdp: '0'}});
    expect(await closed).toMatchObject({code: 1006, wasClean: false});
    expect(signalling.subscribers).toBe(0);
  });
  test('delivers valid state, text, demand, context and split native binary flows', async () => {
    const {client, accepted} = rtcPair();
    await nextTask();
    client.binaryType = 'arraybuffer';
    const messages = [], host = accepted[0].socket;
    client.onmessage = event => messages.push(event.data);
    const controls = [
      {type: 'state', state: {...roomState, epoch: 2}, serverTime: 2},
      {type: 'chat', playerId: roomPlayer().id, name: 'Guest', text: '名'.repeat(240), rank: 'Guest', appearance: DEFAULT_APPEARANCE},
      {type: 'notice', text: 'This room is full.'},
      {type: 'error', text: 'That player is no longer available to spectate.', spectatorRequest: 12},
      {type: 'spectator-demand', active: true, count: 255},
      {type: 'spectator-demand', active: false, count: 0},
      {type: 'context', epoch: 2, token: null},
    ];
    for (const control of controls) host.send(JSON.stringify(control));
    const blocks = Array.from({length: 102}, (_, slot) => batch(1, slot));
    host.send(encodeSnapshot(blocks.slice(0, 100)));
    host.send(encodeSnapshot(blocks.slice(100)));
    host.send(encodeSpectator(spectator(1, 1), true));
    await nextTask();
    expect(messages.slice(0, controls.length).map(JSON.parse)).toEqual(controls);
    expect(messages.slice(controls.length, -1).map(decodeSnapshot).flat()).toEqual(blocks);
    expect(decodeSpectator(messages.at(-1), true)).toEqual(spectator(1, 1));
    expect(client.readyState).toBe(client.OPEN);
  });

  test('rejects hostile host JSON before consumers see it and never probes reconnect liveness', async () => {
    const invalidMessages = [
      {...welcome(), players: null},
      {...welcome(), player: {...roomPlayer(), id: 'account-1'}, players: [{...roomPlayer(), id: 'account-1'}]},
      {...welcome(), player: {...roomPlayer(), moderator: true}, players: [{...roomPlayer(), moderator: true}]},
      {type: 'roster', players: [{...roomPlayer(1), moderator: true}, {...roomPlayer(2), moderator: true}]},
      {type: 'roster', players: [{...roomPlayer(), moderator: true}]},
      {...welcome(), player: {...roomPlayer(), slot: 65536}},
      {...welcome(), player: {...roomPlayer(), appearance: {...DEFAULT_APPEARANCE, nameColor: 'red;position:fixed'}}},
      {type: 'roster', players: [roomPlayer(), roomPlayer()]},
      {type: 'roster', players: [{...roomPlayer(), points: '<img src=x>'}]},
      {type: 'state', state: {...roomState, nominations: null}, serverTime: 1},
      {type: 'state', state: {...roomState, mapId: 'not-in-welcome'}, serverTime: 1},
      {type: 'state', state: {...roomState, epoch: 0x100000000}, serverTime: 1},
      {type: 'chat', playerId: 'p', name: 'Guest', text: 'x'.repeat(241)},
      {type: 'chat', playerId: 'p', name: {}, text: 'hi'},
      {type: 'chat', playerId: roomPlayer().id, name: '<Guest>', text: 'hi'},
      {type: 'roster', players: [{...roomPlayer(), name: 'Surfd EU 2 · Frankfurt'}]},
      {type: 'roster', players: [{...roomPlayer(), guest: true}]},
      {type: 'roster', players: [{...roomPlayer(), name: 'Guest_0a1b2', guest: true, userId: uuid(9)}]},
      {type: 'roster', players: [{...roomPlayer(), userId: 'account-1'}]},
      {type: 'state', state: {...roomState, name: 'Official Surfd server'}, serverTime: 1},
      {type: 'notice', text: {}}, {type: 'error', text: 'bad', spectatorRequest: -1},
      {type: 'spectator-demand', active: true, count: 0},
      {type: 'context', epoch: 1, token: 'host-supplied-ranked-token'},
      {type: 'result', result: {}},
    ];
    for (const message of invalidMessages) {
      let probes = 0;
      const {client, connections} = rtcPair({onFailure: () => { probes++; }});
      await nextTask();
      const messages = [], closed = once(client, 'close');
      client.onmessage = event => messages.push(event.data);
      connections[0].channels[0].onmessage({data: JSON.stringify({type: 'data', data: JSON.stringify(message)})});
      expect(await closed).toMatchObject({code: CLOSE.invalid});
      expect(messages).toEqual([]);
      expect(probes).toBe(0);
      expect(connections[0].connectionState).toBe('closed');
    }
  });

  test('rebuilds host messages from known fields and the local catalog', async () => {
    const {client, accepted} = rtcPair();
    await nextTask();
    const messages = [];
    client.onmessage = event => messages.push(JSON.parse(event.data));
    accepted[0].socket.send(JSON.stringify({...welcome(), extra: '<img>',
      maps: [{id: 'one', title: '<b>Spoof</b>', tier: '"><img src=x>'}, {id: 'unknown', title: 'Unknown'}],
      state: {...roomState, mapTitle: '<b>Spoof</b>', extra: 1}, player: {...roomPlayer(), extra: 1}, players: [{...roomPlayer(), extra: 1}]}));
    accepted[0].socket.send(JSON.stringify({type: 'state', state: {...roomState, recent: ['one', 'unknown']}, serverTime: 2, extra: 1}));
    const visitor = {...roomPlayer(2), name: 'Guest_0a1b2', guest: true};
    accepted[0].socket.send(JSON.stringify({type: 'roster', players: [{...roomPlayer(), memory: 'x'.repeat(1000)},
      {...roomPlayer(1), moderator: true, userId: uuid(7)}, visitor]}));
    await nextTask();
    expect(messages).toEqual([welcome(), {type: 'state', state: {...roomState, recent: ['one']}, serverTime: 2},
      {type: 'roster', players: [roomPlayer(), {...roomPlayer(1), moderator: true, userId: uuid(7)}, visitor]}]);
  });

  test('guests see only the extension\'s own notice, error and close texts', async () => {
    const {client, accepted} = rtcPair();
    await nextTask();
    const messages = [];
    client.onmessage = event => messages.push(JSON.parse(event.data));
    const host = accepted[0].socket;
    host.send(notice('Surfd: your account will be deleted. Visit surfd-support.example'));
    host.send(notice("You're sending messages too fast."));
    host.send(notice('Rowdy was kicked.'));
    host.send(notice('<b>Surfd</b> was kicked.'));
    host.send(JSON.stringify({type: 'error', text: 'Moderator: you are banned from Surfd', spectatorRequest: 3}));
    await nextTask();
    expect(messages).toEqual([{type: 'notice', text: "You're sending messages too fast."}, {type: 'notice', text: 'Rowdy was kicked.'},
      {type: 'error', text: 'That player is not available to spectate.', spectatorRequest: 3}]);
    const closed = once(client, 'close');
    host.close(4004, 'Surfd staff ended this session. Sign in again at surfd-login.example');
    expect(await closed).toMatchObject({code: 4004, reason: 'This private room has closed.'});
  });

  test('rejects invalid snapshots and spectator values before the game receives binary', async () => {
    const snapshot = encodeSnapshot([batch(1, 1)]);
    new DataView(snapshot).setFloat32(22, NaN, true);
    const detailed = encodeSpectator(spectator(1, 1), true);
    new DataView(detailed).setUint8(55, 64);
    for (const data of [snapshot, detailed, encodePoseBatch(batch(1)), new ArrayBuffer(65537), 'binary text']) {
      const {client, connections} = rtcPair();
      await nextTask();
      const messages = [], closed = once(client, 'close');
      client.onmessage = event => messages.push(event.data);
      await connections[0].channels[1].onmessage({data});
      expect(await closed).toMatchObject({code: CLOSE.invalid});
      expect(messages).toEqual([]);
    }
  });

  test('buffers and validates complete large rosters before emitting bounded game frames', async () => {
    const {client, accepted, connections} = rtcPair();
    await nextTask();
    const appearance = {title: 'T'.repeat(24), titleColor: '#ffffff', nameColor: '#ffffff', revision: 1};
    const players = Array.from({length: MAX_ROOM_PLAYERS}, (_, slot) => ({...roomPlayer(slot), appearance}));
    const frames = encodeControlFrames({type: 'roster', players}), messages = [];
    client.onmessage = event => messages.push(event.data);
    for (const frame of frames.slice(0, -1)) accepted[0].socket.send(frame);
    await nextTask();
    expect(messages).toEqual([]);
    accepted[0].socket.send(frames.at(-1));
    await nextTask();
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every(frame => frame.length <= MAX_CONTROL_BYTES)).toBe(true);
    expect(JSON.parse(messages.map(frame => JSON.parse(frame).data).join(''))).toEqual({type: 'roster', players});
    expect(connections[1].channels[0].sent.every(frame => new TextEncoder().encode(frame).length <= MAX_CONTROL_BYTES)).toBe(true);
    const bad = encodeControlFrames({type: 'roster', players: [...players, players[0]]});
    messages.length = 0;
    const closed = once(client, 'close');
    for (const frame of bad) accepted[0].socket.send(frame);
    expect(await closed).toMatchObject({code: CLOSE.invalid});
    expect(messages).toEqual([]);
  });

  test('rejects oversized raw envelopes and interrupted chunks without game delivery', async () => {
    for (const frames of [
      [JSON.stringify({type: 'data', data: notice('名'.repeat(22000))})],
      [JSON.stringify({type: 'data', data: JSON.stringify({type: 'room-chunk', data: '{', final: false})}),
        JSON.stringify({type: 'data', data: 'pong'})],
      [JSON.stringify({type: 'data', data: JSON.stringify({type: 'room-chunk', data: '', final: false})})],
    ]) {
      const {client, connections} = rtcPair();
      await nextTask();
      const messages = [], closed = once(client, 'close');
      client.onmessage = event => messages.push(event.data);
      for (const data of frames) connections[0].channels[0].onmessage({data});
      expect(await closed).toMatchObject({code: CLOSE.invalid});
      expect(messages).toEqual([]);
    }
  });

  test('releases ICE-only negotiations on departure and bounds queued candidates', async () => {
    const connections = fakeRTC(), signalling = signalBus();
    const stop = listenRoom({roomId: 'a', signalling, onSocket() {}});
    cleanups.push(stop);
    signalling.send({roomId: 'a', peerId: 'left', type: 'ice', payload: {from: 'client', candidate: {}}});
    await nextTask();
    expect(connections).toHaveLength(1);
    signalling.send({roomId: 'a', peerId: 'left', type: 'peer-left'});
    await nextTask();
    expect(connections[0].connectionState).toBe('closed');
    for (let index = 0; index < 258; index++) {
      signalling.send({roomId: 'a', peerId: 'flood', type: 'ice', payload: {from: 'client', candidate: {}}});
    }
    await nextTask();
    expect(connections[1].connectionState).toBe('closed');
  });

  test('offer floods stop creating connections for one peer', async () => {
    const connections = fakeRTC({rejectRemote: true}), signalling = signalBus();
    let time = 0;
    const stop = listenRoom({roomId: 'a', signalling, onSocket() {}, now: () => time});
    cleanups.push(stop);
    for (let i = 0; i < 20; i++) {
      signalling.send({roomId: 'a', peerId: 'flood', type: 'offer', payload: {}});
      await nextTask();
    }
    expect(connections).toHaveLength(3);
    expect(connections.every(connection => connection.connectionState === 'closed')).toBe(true);
    time = 60000;
    signalling.send({roomId: 'a', peerId: 'flood', type: 'offer', payload: {}});
    await nextTask();
    expect(connections).toHaveLength(4);
  });

  test('pending negotiations drop the oldest at the bound', async () => {
    const connections = fakeRTC(), signalling = signalBus();
    const stop = listenRoom({roomId: 'a', signalling, onSocket() {}});
    cleanups.push(stop);
    for (let i = 0; i < 33; i++) {
      signalling.send({roomId: 'a', peerId: 'p' + i, type: 'ice', payload: {from: 'client', candidate: {}}});
    }
    await nextTask();
    expect(connections[0].connectionState).toBe('closed');
    expect(connections.slice(1).every(connection => connection.connectionState !== 'closed')).toBe(true);
  });

  test('expires unfinished negotiations but clears the deadline once connected', async () => {
    const originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
    const deadlines = new Set();
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay === 15000) { deadlines.add(callback); return callback; }
      return originalTimeout(callback, delay, ...args);
    };
    globalThis.clearTimeout = timer => {
      if (typeof timer === 'function') deadlines.delete(timer);
      else originalClear(timer);
    };
    try {
      const {client} = rtcPair();
      await nextTask();
      expect(deadlines.size).toBe(0);
      expect(client.readyState).toBe(client.OPEN);
      const signalling = signalBus(), connections = fakeRTC();
      const stop = listenRoom({roomId: 'a', signalling, onSocket() {}});
      cleanups.push(stop);
      signalling.send({roomId: 'a', peerId: 'waiting', type: 'ice', payload: {from: 'client', candidate: {}}});
      await nextTask();
      expect(deadlines.size).toBe(1);
      for (const expire of [...deadlines]) expire();
      expect(connections[0].connectionState).toBe('closed');
      expect(deadlines.size).toBe(0);
    } finally {
      globalThis.setTimeout = originalTimeout;
      globalThis.clearTimeout = originalClear;
    }
  });
});

describe('terminal private room socket', () => {
  test('closes asynchronously without opening or losing terminal metadata', async () => {
    const socket = createClosedSocket(4004, 'This private room has closed.'), events = [];
    socket.onopen = () => events.push('open');
    socket.onerror = () => events.push('error');
    socket.onclose = () => events.push('close');
    expect(socket.readyState).toBe(socket.CLOSING);
    expect(events).toEqual([]);
    expect(() => socket.send('ignored')).not.toThrow();
    socket.close();
    expect(await once(socket, 'close')).toMatchObject({
      code: 4004, reason: 'This private room has closed.', wasClean: true,
    });
    expect(socket.readyState).toBe(socket.CLOSED);
    expect(events).toEqual(['close']);
    expect(await socket.getStats()).toEqual(new Map());
  });

  test('marks direct failures as unclean', async () => {
    const socket = createClosedSocket(1006, directFailure);
    expect(await once(socket, 'close')).toMatchObject({code: 1006, reason: directFailure, wasClean: false});
  });
});

describe('private room broadcast signalling', () => {
  test('clones asynchronous local and cross-tab delivery, unsubscribes, and closes', async () => {
    const channels = new Set();
    globalThis.BroadcastChannel = class {
      constructor(name) { this.name = name; channels.add(this); }
      postMessage(message) {
        for (const channel of channels) if (channel !== this && channel.name === this.name) {
          const copy = structuredClone(message);
          queueMicrotask(() => channel.onmessage?.({data: copy}));
        }
      }
      close() { channels.delete(this); }
    };
    const first = createBroadcastSignalling(), second = createBroadcastSignalling();
    cleanups.push(() => first.close(), () => second.close());
    const local = [], remote = [];
    const unsubscribe = first.subscribe(message => local.push(message));
    second.subscribe(message => remote.push(message));
    const message = {roomId: 'r', peerId: 'p', type: 'offer', payload: {sdp: 'original'}};
    first.send(message);
    message.payload.sdp = 'changed';
    expect(local).toEqual([]);
    expect(remote).toEqual([]);
    await nextTask();
    expect(local[0].payload.sdp).toBe('original');
    expect(remote[0].payload.sdp).toBe('original');
    unsubscribe();
    first.send({roomId: 'r', peerId: 'p', type: 'room-query'});
    await nextTask();
    expect(local).toHaveLength(1);
    expect(remote).toHaveLength(2);
    first.send({type: 'invalid'});
    await nextTask();
    expect(remote).toHaveLength(2);
    second.close();
    first.send({roomId: 'r', peerId: 'p', type: 'room-query'});
    await nextTask();
    expect(remote).toHaveLength(2);
    expect(() => second.send(message)).toThrow();
    expect(() => second.subscribe(() => {})).toThrow();
    first.close();
    expect(channels.size).toBe(0);
  });
});
