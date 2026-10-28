import {describe, expect, test} from 'bun:test';
import {createRoomHost} from '../src/private-rooms/host.js';
import {createRoomId, isPrivateRoomId} from '../src/private-rooms/ids.js';
import {CLOSE, DEFAULT_APPEARANCE, decodeSnapshot, decodeSpectator, encodePoseBatch, encodeSpectator} from '../src/private-rooms/protocol.js';
import {createLoopbackPair} from '../src/private-rooms/socket.js';

class Socket extends EventTarget {
  readyState = 0;
  sent = [];
  closed = null;
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  send(data) {
    if (typeof data === 'string' && (data.length > 65536 || new TextEncoder().encode(data).byteLength > 65536)) throw new Error('Oversized frame');
    this.sent.push(typeof data === 'string' && data !== 'pong' ? JSON.parse(data) : data);
  }
  receive(data) { this.dispatchEvent(new MessageEvent('message', {data: typeof data === 'object' && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data})); }
  close(code, reason) { this.closed = {code, reason}; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  messages(type) { return this.sent.filter(message => message?.type === type); }
}
const hello = {name: 'Guest', appearance: null, guest: true};
const pose = {time: 100, x: 1, y: 2, z: 3, vx: 4, vy: 5, vz: 6, yaw: 90, pitch: -30, flags: 1, seconds: 2};
const detailed = {...pose, eyeHeight: 64, phase: 'running', untimed: true, checkpoints: 1, stage: 2, inputs: 1, inputPresses: 16};
function fixture(options = {}) {
  const room = createRoomHost({roomId: createRoomId(), mapId: 'one', maps: [{id: 'one', title: 'One'}, {id: 'two', title: 'Two'}], ...options});
  const connect = (host = false, identity = hello, open = true) => {
    const socket = new Socket();
    room.addClient(socket, identity, {host});
    if (open && !socket.closed) socket.open();
    return socket;
  };
  return {room, connect};
}
const tick = () => new Promise(resolve => setTimeout(resolve, 70));
const snapshots = socket => socket.sent.filter(value => value instanceof ArrayBuffer).map(decodeSnapshot);
function controls(socket) {
  const messages = [];
  let pending = '';
  for (const message of socket.sent) {
    if (message.type !== 'room-chunk') messages.push(message);
    else {
      pending += message.data;
      if (message.final) {
        messages.push(JSON.parse(pending));
        pending = '';
      }
    }
  }
  expect(pending).toBe('');
  return messages;
}

 describe('private room identifiers', () => {
  test('random IDs are unambiguous and recognized without claiming public rooms', () => {
    const ids = new Set(Array.from({length: 100}, () => createRoomId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(isPrivateRoomId(id)).toBe(true);
    for (const value of ['eu', 'p-', 'p-000000000000', 'p-llllllllllll', 'P-abcdefghjkmn', null, 2]) expect(isPrivateRoomId(value)).toBe(false);
  });
});

describe('private room host', () => {
  test('waits for async open, welcomes using native schemas, and updates the roster', () => {
    const {room, connect} = fixture(), host = connect(true, hello, false);
    expect(host.sent).toEqual([]);
    host.open();
    const welcome = host.messages('welcome')[0];
    expect(welcome).toMatchObject({type: 'welcome', spectatorStream: true, playtime: false, activityTracking: false, recentResults: [], chatMute: null});
    expect(welcome.player).toMatchObject({name: 'Guest', guest: false, moderator: true, points: 0, rank: 'Guest', spectating: false, slot: 0, appearance: DEFAULT_APPEARANCE});
    expect(welcome.state).toMatchObject({epoch: 1, mapId: 'one', endsAt: 0, untimed: true, vote: null, nextMap: null, nominations: {}, recent: []});
    expect(welcome.state.capacity).toBeUndefined();
    const peer = connect();
    expect(peer.messages('welcome')[0].players).toHaveLength(2);
    expect(host.messages('roster').at(-1).players).toHaveLength(2);
    expect(room.players[1].moderator).toBe(false);
    expect(room.players[0].id).not.toBe(room.players[1].id);
    expect(room.players[0].connectionId).not.toBe(room.players[1].connectionId);
    expect(host.messages('check')).toEqual([]);
  });

  test('welcomes sockets which are already open', () => {
    const {room} = fixture(), socket = new Socket();
    socket.open();
    room.addClient(socket, hello);
    expect(socket.messages('welcome')).toHaveLength(1);
    socket.open();
    expect(socket.messages('welcome')).toHaveLength(1);
  });

  test('reserves unique slots beyond one hundred and reuses departures', () => {
    const {room, connect} = fixture();
    const peers = Array.from({length: 105}, () => connect(false, hello, false));
    peers.forEach(peer => peer.open());
    expect(room.players).toHaveLength(105);
    expect(new Set(room.players.map(player => player.slot)).size).toBe(105);
    peers[4].close(1000, 'Left');
    expect(connect().messages('welcome')[0].player.slot).toBe(4);
    room.close();
  });

  test('uses the supplied appearance and falls back for invalid appearance', () => {
    const {connect} = fixture();
    const appearance = {title: 'Surfer', titleColor: '#ab12EF', nameColor: null, revision: 5};
    expect(connect(false, {...hello, appearance}).messages('welcome')[0].player.appearance).toEqual(appearance);
    expect(connect(false, {...hello, appearance: {...appearance, title: ' bad '}}).messages('welcome')[0].player.appearance).toEqual(DEFAULT_APPEARANCE);
    expect(connect(false, {...hello, name: ''}).closed.code).toBe(CLOSE.invalid);
    expect(connect(false, {...hello, guest: undefined}).closed.code).toBe(CLOSE.invalid);
  });

  test('relays native chat sender fields and answers ping without public authority', () => {
    const {connect} = fixture(), host = connect(true), peer = connect();
    peer.receive({type: 'chat', text: ' hello ', playerId: 'spoof', name: 'Spoof'});
    const player = peer.messages('welcome')[0].player;
    expect(host.messages('chat')[0]).toEqual({type: 'chat', text: 'hello', playerId: player.id, name: player.name, rank: 'Guest', appearance: DEFAULT_APPEARANCE});
    expect(peer.messages('chat')).toHaveLength(1);
    peer.receive('ping');
    expect(peer.sent.at(-1)).toBe('pong');
    peer.receive({type: 'context'});
    expect(peer.sent.at(-1)).toEqual({type: 'context', epoch: 1, token: null});
    const length = peer.sent.length;
    for (const type of ['refresh', 'rtv', 'vote', 'nominate', 'extend', 'ack', 'activity', 'result', 'moderate']) peer.receive({type});
    expect(peer.sent).toHaveLength(length);
  });

  test('only host changes maps and rejects stale poses', async () => {
    const {room, connect} = fixture(), host = connect(true), peer = connect();
    peer.receive({type: 'change-map', mapId: 'two'});
    expect(peer.messages('error')).toHaveLength(1);
    host.receive({type: 'change-map', mapId: 'missing'});
    expect(host.messages('error')).toHaveLength(1);
    host.receive({type: 'change-map', mapId: 'one'});
    expect(room.state.epoch).toBe(1);
    host.receive({type: 'change-map', mapId: 'two'});
    expect(room.state).toMatchObject({mapId: 'two', mapTitle: 'Two', epoch: 2, recent: ['one'], endsAt: 0});
    expect(peer.messages('state')[0].state.epoch).toBe(2);
    peer.receive(encodePoseBatch({sequence: 1, epoch: 1, samples: [pose]}));
    expect(host.sent.filter(value => value instanceof ArrayBuffer)).toHaveLength(0);
    peer.receive(encodePoseBatch({sequence: 2, epoch: 2, samples: [pose, pose]}));
    await tick();
    const snapshot = host.sent.find(value => value instanceof ArrayBuffer);
    expect(decodeSnapshot(snapshot)[0]).toMatchObject({slot: 1, epoch: 2, sequence: 2});
    expect(peer.sent.filter(value => value instanceof ArrayBuffer)).toHaveLength(0);
    expect(() => createRoomHost({roomId: createRoomId(), mapId: 'missing', maps: []})).toThrow();
  });

  test('tracks spectator demand, rewrites forwarded slots, and cleans unsubscribe and leave', () => {
    const {connect} = fixture(), host = connect(true), target = connect(), watcher = connect(), bystander = connect();
    const targetId = target.messages('welcome')[0].player.connectionId;
    watcher.receive({type: 'spectate', connectionId: targetId, request: 1});
    expect(target.messages('spectator-demand').at(-1)).toEqual({type: 'spectator-demand', active: true, count: 1});
    expect(host.messages('roster').at(-1).players[2].spectating).toBe(true);
    target.receive(encodeSpectator({slot: 65535, sequence: 0, epoch: 1, pose: detailed}));
    expect(decodeSpectator(watcher.sent.find(value => value instanceof ArrayBuffer), true).slot).toBe(1);
    expect(bystander.sent.filter(value => value instanceof ArrayBuffer)).toHaveLength(0);
    host.receive({type: 'change-map', mapId: 'two'});
    expect(target.messages('spectator-demand').at(-1).count).toBe(1);
    watcher.receive({type: 'spectate', connectionId: null, request: 2});
    expect(target.messages('spectator-demand').at(-1)).toEqual({type: 'spectator-demand', active: false, count: 0});
    watcher.receive({type: 'spectate', connectionId: targetId, request: 3});
    bystander.receive({type: 'spectate', connectionId: targetId, request: 4});
    expect(target.messages('spectator-demand').at(-1).count).toBe(2);
    watcher.close(1000, 'Left');
    expect(target.messages('spectator-demand').at(-1).count).toBe(1);
    target.close(1000, 'Left');
    expect(bystander.messages('error').at(-1).spectatorRequest).toBe(4);
    expect(host.messages('roster').at(-1).players.find(player => player.slot === 3).spectating).toBe(false);
  });

  test('rejects self, missing, and already-spectating targets without changing demand', () => {
    const {connect} = fixture(), one = connect(), two = connect(), three = connect();
    const id = socket => socket.messages('welcome')[0].player.connectionId;
    one.receive({type: 'spectate', connectionId: id(one), request: 1});
    one.receive({type: 'spectate', connectionId: 'missing', request: 2});
    expect(one.messages('error').map(message => message.spectatorRequest)).toEqual([1, 2]);
    one.receive({type: 'spectate', connectionId: id(two), request: 3});
    three.receive({type: 'spectate', connectionId: id(one), request: 4});
    expect(three.messages('error').at(-1).spectatorRequest).toBe(4);
    two.receive({type: 'spectate', connectionId: id(three), request: 5});
    expect(one.messages('error').at(-1).spectatorRequest).toBe(3);
    expect(two.messages('spectator-demand').at(-1).count).toBe(0);
  });

  test('isolates malformed senders and leaves room closure to runtime', () => {
    const {room, connect} = fixture(), host = connect(true), peer = connect();
    peer.receive(new ArrayBuffer(1));
    expect(peer.closed.code).toBe(CLOSE.invalid);
    const malformed = connect();
    malformed.receive('{');
    expect(malformed.closed.code).toBe(CLOSE.invalid);
    const remaining = connect();
    host.close(1000, 'Left');
    expect(remaining.closed).toBeNull();
    expect(room.players).toHaveLength(1);
    room.close();
    expect(remaining.closed).toEqual({code: CLOSE.gone, reason: 'The host closed the private room.'});
    expect(room.players).toEqual([]);
    expect(connect().closed.code).toBe(CLOSE.gone);
    room.close();
  });

  test('explicit close shuts down connecting sockets too', () => {
    const {room, connect} = fixture(), waiting = connect(false, hello, false);
    room.close();
    expect(waiting.closed.code).toBe(CLOSE.gone);
    waiting.open();
    expect(waiting.messages('welcome')).toEqual([]);
  });

  test('uses the entire uint16 slot range', () => {
    const {room, connect} = fixture();
    const peers = Array.from({length: 65536}, () => connect(false, hello, false));
    peers.at(-1).open();
    expect(peers.at(-1).messages('welcome')[0].player.slot).toBe(65535);
    expect(connect().closed.code).toBe(CLOSE.invalid);
    peers[0].close(1000, 'Left');
    expect(connect().messages('welcome')[0].player.slot).toBe(0);
    expect(room.players).toHaveLength(2);
    room.close();
  }, 15000);

  test('replaces live and connecting host registrations', () => {
    const {room, connect} = fixture(), host = connect(true), guest = connect();
    const invalid = connect(true, {...hello, name: ''});
    expect(invalid.closed.code).toBe(CLOSE.invalid);
    expect(host.closed).toBeNull();
    const waiting = connect(true, hello, false);
    expect(host.closed.code).toBe(1000);
    expect(guest.closed).toBeNull();
    const replacement = connect(true);
    expect(waiting.closed.code).toBe(1000);
    waiting.open();
    expect(waiting.messages('welcome')).toEqual([]);
    expect(replacement.messages('welcome')[0].player.slot).toBe(0);
    expect(room.players).toHaveLength(2);
    room.close();
  });

  test('replaces host before a queued close without losing guests', () => {
    const {room, connect} = fixture(), host = connect(true), guest = connect(), watcher = connect();
    const previous = host.messages('welcome')[0].player;
    watcher.receive({type: 'spectate', connectionId: previous.connectionId, request: 9});
    host.readyState = 3;
    const replacement = connect(true);
    host.dispatchEvent(new Event('close'));
    expect(replacement.messages('welcome')[0].player.slot).toBe(previous.slot);
    expect(room.players).toHaveLength(3);
    expect(guest.closed).toBeNull();
    expect(watcher.messages('error').at(-1).spectatorRequest).toBe(9);
    expect(room.players.find(player => player.connectionId === previous.connectionId)).toBeUndefined();
    replacement.receive({type: 'change-map', mapId: 'two'});
    expect(room.state.mapId).toBe('two');
    room.close();
  });

  test('rejoins after host close and cleans spectator demand', () => {
    const {room, connect} = fixture(), host = connect(true), guest = connect();
    host.receive({type: 'spectate', connectionId: guest.messages('welcome')[0].player.connectionId, request: 1});
    host.close(1000, 'Reload');
    expect(guest.closed).toBeNull();
    expect(guest.messages('spectator-demand').at(-1).count).toBe(0);
    const newcomer = connect();
    const replacement = connect(true);
    expect(new Set(room.players.map(player => player.slot)).size).toBe(3);
    expect(replacement.messages('welcome')[0].player.moderator).toBe(true);
    expect(newcomer.closed).toBeNull();
    room.close();
  });

  test('notifies membership, map and explicit closure', () => {
    let changes = 0;
    const {room, connect} = fixture({onChange: () => changes++});
    const host = connect(true);
    expect(changes).toBe(1);
    const guest = connect();
    expect(changes).toBe(2);
    host.receive({type: 'change-map', mapId: 'two'});
    expect(changes).toBe(3);
    guest.close(1000, 'Left');
    expect(changes).toBe(4);
    room.close();
    expect(changes).toBe(5);
  });

  test('bounds malicious chat without disconnecting recipients', () => {
    const {room, connect} = fixture(), host = connect(true), guest = connect();
    guest.receive({type: 'chat', text: ' ' + 'x'.repeat(65000)});
    expect(host.messages('chat')[0].text).toBe('x'.repeat(240));
    expect(host.closed).toBeNull();
    expect(guest.closed).toBeNull();
    guest.receive(JSON.stringify({type: 'chat', text: '名'.repeat(23000)}));
    expect(guest.closed.code).toBe(CLOSE.invalid);
    expect(host.closed).toBeNull();
    room.close();
  });

  test('chunks complete large welcomes and rosters', () => {
    const maps = Array.from({length: 1001}, (_, index) => ({id: index ? 'map-' + index : 'one', title: '名\"\\\\'.repeat(16)}));
    const {room} = fixture({maps});
    class Sink extends Socket { send() {} }
    for (let index = 0; index < 1001; index++) {
      const socket = new Sink();
      room.addClient(socket, {...hello, name: '名\"\\\\'.repeat(8), memory: 'ignored'});
      socket.open();
    }
    const receiver = new Socket();
    room.addClient(receiver, hello);
    receiver.open();
    const messages = controls(receiver), welcome = messages.find(message => message.type === 'welcome');
    expect(receiver.messages('room-chunk').length).toBeGreaterThan(1);
    expect(welcome.maps).toEqual(maps);
    expect(welcome.players).toEqual(room.players);
    expect(welcome.players).toHaveLength(1002);
    expect(welcome.players[0].memory).toBeUndefined();
    expect(messages.find(message => message.type === 'roster').players).toEqual(room.players);
    expect(receiver.closed).toBeNull();
    room.close();
  });

  test('batches latest poses per sender without echoing', async () => {
    const {room, connect} = fixture(), host = connect(true), one = connect(), two = connect();
    const send = (socket, sequence, x) => socket.receive(encodePoseBatch({sequence, epoch: 1, samples: [{...pose, x}, pose]}));
    send(one, 0xfffffffe, 1);
    send(one, 0xffffffff, 2);
    send(one, 0, 3);
    send(one, 0xffffffff, 4);
    send(one, 0, 5);
    send(two, 7, 6);
    expect(snapshots(host)).toEqual([]);
    await tick();
    expect(snapshots(host)).toHaveLength(1);
    expect(snapshots(host)[0].map(block => [block.slot, block.sequence, block.samples[0].x])).toEqual([[1, 0, 3], [2, 7, 6]]);
    expect(snapshots(one)[0].map(block => block.slot)).toEqual([2]);
    expect(snapshots(two)[0].map(block => block.slot)).toEqual([1]);
    await tick();
    expect(snapshots(host)).toHaveLength(1);
    send(one, 0xffffffff, 9);
    await tick();
    expect(snapshots(host)).toHaveLength(1);
    room.close();
  });

  test('splits snapshots at one hundred blocks and preserves samples', async () => {
    const {room, connect} = fixture(), host = connect(true);
    const peers = Array.from({length: 102}, () => connect());
    const source = encodePoseBatch({sequence: 1, epoch: 1, samples: [pose, {...pose, yaw: 1.25, pitch: 35.5}]});
    peers.forEach(peer => peer.receive(source));
    await tick();
    expect(snapshots(host).map(blocks => blocks.length)).toEqual([100, 2]);
    expect(new Set(snapshots(host).flat().map(block => block.slot)).size).toBe(102);
    expect(snapshots(peers[0]).map(blocks => blocks.length)).toEqual([100, 1]);
    expect(snapshots(peers[0]).flat().some(block => block.slot === 1)).toBe(false);
    const packet = host.sent.find(value => value instanceof ArrayBuffer);
    expect(new Uint8Array(packet, 18, 64)).toEqual(new Uint8Array(source, 12));
    room.close();
  });

  test('discards departed and old epoch poses and cancels close flush', async () => {
    const {room, connect} = fixture(), host = connect(true), guest = connect();
    guest.receive(encodePoseBatch({sequence: 99, epoch: 1, samples: [pose]}));
    guest.close(1000, 'Left');
    const replacement = connect();
    expect(replacement.messages('welcome')[0].player.slot).toBe(1);
    await tick();
    expect(snapshots(host)).toEqual([]);
    replacement.receive(encodePoseBatch({sequence: 99, epoch: 1, samples: [pose]}));
    host.receive({type: 'change-map', mapId: 'two'});
    replacement.receive(encodePoseBatch({sequence: 0, epoch: 2, samples: [pose]}));
    replacement.receive(encodePoseBatch({sequence: 100, epoch: 1, samples: [pose]}));
    await tick();
    expect(snapshots(host).flat().map(block => [block.epoch, block.sequence])).toEqual([[2, 0]]);
    replacement.receive(encodePoseBatch({sequence: 1, epoch: 2, samples: [pose]}));
    room.close();
    await tick();
    expect(snapshots(host)).toHaveLength(1);
  });
});

test('real loopback host receives binary as ArrayBuffer and relays native packets', async () => {
  const room = createRoomHost({roomId: createRoomId(), mapId: 'one'});
  const [sender, hostSender] = createLoopbackPair();
  const [watcher, hostWatcher] = createLoopbackPair();
  sender.binaryType = watcher.binaryType = 'arraybuffer';
  const next = (socket, accepts) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Room message timed out')); }, 1000);
    const message = event => {
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (accepts(data)) { cleanup(); resolve(data); }
    };
    const closed = event => { cleanup(); reject(new Error('Unexpected close ' + event.code)); };
    function cleanup() {
      clearTimeout(timer);
      socket.removeEventListener('message', message);
      socket.removeEventListener('close', closed);
    }
    socket.addEventListener('message', message);
    socket.addEventListener('close', closed);
  });
  const senderWelcome = next(sender, data => data.type === 'welcome');
  const watcherWelcome = next(watcher, data => data.type === 'welcome');
  room.addClient(hostSender, hello, {host: true});
  room.addClient(hostWatcher, hello);
  try {
    const [welcome] = await Promise.all([senderWelcome, watcherWelcome]);
    expect(hostSender.binaryType).toBe('arraybuffer');
    expect(hostWatcher.binaryType).toBe('arraybuffer');
    const snapshot = next(watcher, data => data instanceof ArrayBuffer);
    sender.send(encodePoseBatch({sequence: 1, epoch: 1, samples: [pose]}));
    expect(decodeSnapshot(await snapshot)[0].slot).toBe(welcome.player.slot);
    const demand = next(sender, data => data.type === 'spectator-demand');
    watcher.send(JSON.stringify({type: 'spectate', connectionId: welcome.player.connectionId, request: 1}));
    expect((await demand).count).toBe(1);
    const spectator = next(watcher, data => data instanceof ArrayBuffer);
    sender.send(encodeSpectator({slot: 65535, sequence: 1, epoch: 1, pose: detailed}));
    expect(decodeSpectator(await spectator, true).slot).toBe(welcome.player.slot);
  } finally {
    room.close();
  }
});
