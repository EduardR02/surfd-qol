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
  send(data) { this.sent.push(typeof data === 'string' && data !== 'pong' ? JSON.parse(data) : data); }
  receive(data) { this.dispatchEvent(new MessageEvent('message', {data: typeof data === 'object' && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data})); }
  close(code, reason) { this.closed = {code, reason}; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  messages(type) { return this.sent.filter(message => message?.type === type); }
}
const hello = {name: 'Guest', appearance: null, guest: true};
const pose = {time: 100, x: 1, y: 2, z: 3, vx: 4, vy: 5, vz: 6, yaw: 90, pitch: -30, flags: 1, seconds: 2};
const detailed = {...pose, eyeHeight: 64, phase: 'running', untimed: true, checkpoints: 1, stage: 2, inputs: 1, inputPresses: 16};
function fixture() {
  const room = createRoomHost({roomId: createRoomId(), mapId: 'one', maps: [{id: 'one', title: 'One'}, {id: 'two', title: 'Two'}]});
  const connect = (host = false, identity = hello, open = true) => {
    const socket = new Socket();
    room.addClient(socket, identity, {host});
    if (open && !socket.closed) socket.open();
    return socket;
  };
  return {room, connect};
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
    expect(welcome.state).toMatchObject({epoch: 1, mapId: 'one', endsAt: 0, untimed: true, capacity: 16, vote: null, nextMap: null, nominations: {}, recent: []});
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

  test('caps occupied and connecting slots at sixteen and reuses departed slots', () => {
    const {room, connect} = fixture();
    const peers = Array.from({length: 16}, () => connect(false, hello, false));
    const overflow = connect();
    expect(overflow.closed.code).toBe(CLOSE.full);
    peers.forEach(peer => peer.open());
    expect(room.players).toHaveLength(16);
    peers[4].close(1000, 'Left');
    expect(connect().messages('welcome')[0].player.slot).toBe(4);
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

  test('only host changes to catalog maps, advances epochs, and rejects stale poses', () => {
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

  test('malformed data closes its sender and host loss closes the whole room', () => {
    const {room, connect} = fixture(), host = connect(true), peer = connect();
    peer.receive(new ArrayBuffer(1));
    expect(peer.closed.code).toBe(CLOSE.invalid);
    const malformed = connect();
    malformed.receive('{');
    expect(malformed.closed.code).toBe(CLOSE.invalid);
    const remaining = connect();
    host.close(1000, 'Left');
    expect(remaining.closed.code).toBe(CLOSE.gone);
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
