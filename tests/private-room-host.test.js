import {describe, expect, test} from 'bun:test';
import {createRoomHost} from '../src/private-rooms/host.js';
import {createRoomId, isPrivateRoomId} from '../src/private-rooms/ids.js';
import {CLOSE, DEFAULT_APPEARANCE, MAX_ROOM_PLAYERS, ROOM_TEXTS, bannedNotice, decodeSnapshot, decodeSpectator, encodePoseBatch, encodeSpectator, kickedNotice} from '../src/private-rooms/protocol.js';
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
const hello = {name: 'Surfer', appearance: null, guest: false, browserId: crypto.randomUUID()};
const guestHello = {...hello, name: 'Guest_0a1b2', guest: true};
const pose = {time: 100, x: 1, y: 2, z: 3, vx: 4, vy: 5, vz: 6, yaw: 90, pitch: -30, flags: 1, seconds: 2};
const detailed = {...pose, eyeHeight: 64, phase: 'running', untimed: true, checkpoints: 1, stage: 2, inputs: 1, inputPresses: 16};
function fixture(options = {}) {
  const room = createRoomHost({roomId: createRoomId(), mapId: 'one', maxPlayers: MAX_ROOM_PLAYERS, maps: [{id: 'one', title: 'One'}, {id: 'two', title: 'Two'}], ...options});
  const connect = (host = false, identity = hello, open = true) => {
    const socket = new Socket();
    room.addClient(socket, identity, {host});
    if (open && !socket.closed) socket.open();
    return socket;
  };
  return {room, connect};
}
const tick = () => new Promise(resolve => setTimeout(resolve, 70));
const rosterTick = () => new Promise(resolve => setTimeout(resolve, 110));
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
  test('waits for async open, welcomes using native schemas, and updates the roster', async () => {
    const {room, connect} = fixture(), host = connect(true, hello, false);
    expect(host.sent).toEqual([]);
    host.open();
    const welcome = host.messages('welcome')[0];
    expect(welcome).toMatchObject({type: 'welcome', spectatorStream: true, playtime: false, activityTracking: false, recentResults: [], chatMute: null});
    expect(welcome.player).toMatchObject({name: 'Surfer', guest: false, moderator: true, points: 0, rank: 'Unranked', spectating: false, slot: 0, appearance: DEFAULT_APPEARANCE});
    expect(welcome.state).toMatchObject({epoch: 1, mapId: 'one', endsAt: 0, untimed: true, vote: null, nextMap: null, nominations: {}, recent: []});
    const peer = connect();
    expect(peer.messages('welcome')[0].players).toHaveLength(2);
    await rosterTick();
    expect(host.messages('roster').at(-1).players).toHaveLength(2);
    expect(room.players[1].moderator).toBe(false);
    expect(room.players[0].id).not.toBe(room.players[1].id);
    expect(room.players[0].connectionId).not.toBe(room.players[1].connectionId);
  });

  test('welcomes sockets which are already open', () => {
    const {room} = fixture(), socket = new Socket();
    socket.open();
    room.addClient(socket, hello);
    expect(socket.messages('welcome')).toHaveLength(1);
    socket.open();
    expect(socket.messages('welcome')).toHaveLength(1);
  });

  test('reserves unique slots for connecting players and reuses departures', () => {
    const {room, connect} = fixture();
    const peers = Array.from({length: MAX_ROOM_PLAYERS - 1}, () => connect(false, hello, false));
    peers.forEach(peer => peer.open());
    expect(room.players).toHaveLength(MAX_ROOM_PLAYERS - 1);
    expect(new Set(room.players.map(player => player.slot)).size).toBe(MAX_ROOM_PLAYERS - 1);
    peers[4].close(1000, 'Left');
    expect(connect().messages('welcome')[0].player.slot).toBe(4);
    room.close();
  });

  test('uses the supplied appearance and falls back for invalid appearance', () => {
    const {connect} = fixture();
    const appearance = {title: 'Surfer', titleColor: '#ab12EF', nameColor: null, revision: 5};
    expect(connect(false, {...hello, appearance}).messages('welcome')[0].player.appearance).toEqual(appearance);
    expect(connect(false, {...hello, appearance: {...appearance, title: ' bad '}}).messages('welcome')[0].player.appearance).toEqual(DEFAULT_APPEARANCE);
    expect(connect(false, {...hello, guest: undefined}).closed.code).toBe(CLOSE.invalid);
    expect(connect(false, null).closed.code).toBe(CLOSE.invalid);
  });

  test('players carry their real guest status and guests cannot chat', () => {
    const {room, connect} = fixture();
    const userId = crypto.randomUUID();
    const member = connect(false, {...hello, userId}), guest = connect(false, guestHello);
    connect(false, {...guestHello, name: 'Lightcone', userId});
    connect(false, {...hello, name: '<b>x</b>', userId});
    const [own, visitor, claimed, invalid] = room.players;
    expect(own).toMatchObject({name: 'Surfer', guest: false, userId});
    expect(visitor).toMatchObject({name: 'Guest_0a1b2', guest: true});
    expect(controls(guest).find(message => message.type === 'welcome').player.guest).toBe(true);
    for (const player of [claimed, invalid]) {
      expect(player.guest).toBe(true);
      expect(player.name).toMatch(/^Guest_[0-9a-f]{5}$/);
    }
    for (const player of [visitor, claimed, invalid]) expect(player.userId).toBeUndefined();
    guest.receive({type: 'chat', text: 'hello'});
    expect(guest.messages('error').at(-1).text).toBe(ROOM_TEXTS.signInToChat);
    expect(member.messages('chat')).toEqual([]);
    member.receive({type: 'chat', text: 'hello'});
    expect(guest.messages('chat').at(-1)).toMatchObject({name: 'Surfer', text: 'hello'});
    room.close();
  });

  test('masks chat on the host before every recipient sees it, preserving sender fields and guest refusal', () => {
    const {room, connect} = fixture(), host = connect(true), member = connect(), guest = connect(false, guestHello);
    try {
      const player = member.messages('welcome')[0].player;
      member.receive({type: 'chat', text: ' Scunthorpe class: FUUUCK, sh1t! ', name: 'Forged'});
      const chat = {type: 'chat', playerId: player.id, name: player.name, rank: 'Unranked',
        appearance: DEFAULT_APPEARANCE, text: 'Scunthorpe class: ******, ****!'};
      for (const recipient of [host, member, guest]) expect(recipient.messages('chat')).toEqual([chat]);
      guest.receive({type: 'chat', text: 'FUUUCK'});
      expect(guest.messages('error').at(-1).text).toBe(ROOM_TEXTS.signInToChat);
      expect(host.messages('chat')).toEqual([chat]);
      host.receive({type: 'chat', text: 'fUcK'});
      expect(member.messages('chat').at(-1)).toMatchObject({name: host.messages('welcome')[0].player.name, text: '****'});
    } finally { room.close(); }
  });

  test('names follow the site rules and anything else becomes a guest name', () => {
    const {room, connect} = fixture();
    for (const name of ['<svg onload=alert(1)>', 'ab', 'a'.repeat(25), 'Surfd EU 2 · Frankfurt', '名前', '', undefined]) connect(false, {...hello, name});
    connect(false, {...hello, name: 'Lightcone_2-x'});
    const names = room.players.map(player => player.name);
    expect(names.slice(0, -1).every(name => /^Guest_[0-9a-f]{5}$/.test(name))).toBe(true);
    expect(names.at(-1)).toBe('Lightcone_2-x');
    room.close();
  });

  test('normalizes free-text room names and broadcasts renames without changing the map', () => {
    const {room, connect} = fixture({name: '  Evening   practice!  '}), host = connect(true), guest = connect();
    try {
      expect(host.messages('welcome')[0].state.name).toBe('Evening practice!');
      room.setName("  Timed & untimed (EU)  ");
      expect(guest.messages('state').at(-1).state).toMatchObject({name: 'Timed & untimed (EU)', mapId: 'one', epoch: 1});
      for (const invalid of ['ab', '<script>', 'Official practice', 'SURFD practice']) {
        expect(() => room.setName(invalid)).toThrow();
      }
      expect(room.state.name).toBe('Timed & untimed (EU)');
    } finally { room.close(); }
  });

  test('relays native chat sender fields and answers ping without public authority', () => {
    const {connect} = fixture(), host = connect(true), peer = connect();
    peer.receive({type: 'chat', text: ' hello ', playerId: 'spoof', name: 'Spoof'});
    const player = peer.messages('welcome')[0].player;
    expect(host.messages('chat')[0]).toEqual({type: 'chat', text: 'hello', playerId: player.id, name: player.name, rank: 'Unranked', appearance: DEFAULT_APPEARANCE});
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

  test('tracks spectator demand, rewrites forwarded slots, and cleans unsubscribe and leave', async () => {
    const {connect} = fixture(), host = connect(true), target = connect(), watcher = connect(), bystander = connect();
    const targetId = target.messages('welcome')[0].player.connectionId;
    watcher.receive({type: 'spectate', connectionId: targetId, request: 1});
    expect(target.messages('spectator-demand').at(-1)).toEqual({type: 'spectator-demand', active: true, count: 1});
    await rosterTick();
    expect(host.messages('roster').at(-1).players[2].spectating).toBe(true);
    target.receive(encodeSpectator({slot: MAX_ROOM_PLAYERS - 1, sequence: 0, epoch: 1, pose: detailed}));
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
    await rosterTick();
    expect(host.messages('roster').at(-1).players.find(player => player.slot === 3).spectating).toBe(false);
  });

  test('Stop clears a subscription after its burst is exhausted and redundant Stops stay silent', async () => {
    let time = 0;
    const {room, connect} = fixture({now: () => time}), host = connect(true), one = connect(), two = connect(), watcher = connect();
    const peers = [host, one, two, watcher], id = socket => socket.messages('welcome')[0].player.connectionId;
    const oneId = id(one), twoId = id(two), watcherId = id(watcher);
    for (let request = 1; request <= 4; request++) {
      watcher.receive({type: 'spectate', connectionId: request % 2 ? oneId : twoId, request});
    }
    two.receive(encodeSpectator({slot: 0, sequence: 1, epoch: 1, pose: detailed}));
    expect(watcher.sent.filter(value => value instanceof ArrayBuffer)).toHaveLength(1);
    await rosterTick();
    expect(host.messages('roster').at(-1).players.find(player => player.connectionId === watcherId).spectating).toBe(true);
    for (const peer of peers) peer.sent.length = 0;

    watcher.receive({type: 'spectate', connectionId: null, request: 5});
    expect(room.players.find(player => player.connectionId === watcherId).spectating).toBe(false);
    expect(two.messages('spectator-demand')).toEqual([{type: 'spectator-demand', active: false, count: 0}]);
    two.receive(encodeSpectator({slot: 0, sequence: 2, epoch: 1, pose: detailed}));
    expect(watcher.sent.filter(value => value instanceof ArrayBuffer)).toEqual([]);
    await rosterTick();
    expect(host.messages('roster').at(-1).players.find(player => player.connectionId === watcherId).spectating).toBe(false);
    for (const peer of peers) peer.sent.length = 0;

    for (let request = 6; request <= 100; request++) watcher.receive({type: 'spectate', connectionId: null, request});
    watcher.receive({type: 'spectate', connectionId: oneId, request: 101});
    await rosterTick();
    for (const peer of peers) expect(peer.sent).toEqual([]);
    expect(room.players.find(player => player.connectionId === watcherId).spectating).toBe(false);
    time = 500;
    watcher.receive({type: 'spectate', connectionId: oneId, request: 102});
    expect(one.messages('spectator-demand')).toEqual([{type: 'spectator-demand', active: true, count: 1}]);
    room.close();
  });

  test('target switches update demand without rosters and repeated targets retain the latest request', async () => {
    const {room, connect} = fixture({now: () => 0}), host = connect(true), one = connect(), two = connect(), watcher = connect(), other = connect();
    const peers = [host, one, two, watcher, other], id = socket => socket.messages('welcome')[0].player.connectionId;
    const oneId = id(one), twoId = id(two);
    watcher.receive({type: 'spectate', connectionId: oneId, request: 1});
    other.receive({type: 'spectate', connectionId: oneId, request: 1});
    await rosterTick();
    for (const peer of peers) peer.sent.length = 0;

    watcher.receive({type: 'spectate', connectionId: twoId, request: 2});
    expect(one.messages('spectator-demand')).toEqual([{type: 'spectator-demand', active: true, count: 1}]);
    expect(two.messages('spectator-demand')).toEqual([{type: 'spectator-demand', active: true, count: 1}]);
    await rosterTick();
    for (const peer of peers) {
      expect(peer.messages('roster')).toEqual([]);
      peer.sent.length = 0;
    }
    for (let request = 3; request <= 100; request++) watcher.receive({type: 'spectate', connectionId: twoId, request});
    for (const peer of peers) expect(peer.sent).toEqual([]);

    watcher.receive({type: 'spectate', connectionId: oneId, request: 101});
    expect(one.messages('spectator-demand').at(-1)).toEqual({type: 'spectator-demand', active: true, count: 2});
    expect(two.messages('spectator-demand').at(-1)).toEqual({type: 'spectator-demand', active: false, count: 0});
    watcher.receive({type: 'spectate', connectionId: twoId, request: 102});
    expect(one.messages('spectator-demand').at(-1)).toEqual({type: 'spectator-demand', active: true, count: 1});
    expect(two.messages('spectator-demand').at(-1)).toEqual({type: 'spectator-demand', active: true, count: 1});
    for (const peer of peers) peer.sent.length = 0;
    watcher.receive({type: 'spectate', connectionId: twoId, request: 103});
    watcher.receive({type: 'spectate', connectionId: oneId, request: 104});
    await rosterTick();
    for (const peer of peers) expect(peer.sent).toEqual([]);
    two.close(1000, 'Left');
    expect(watcher.messages('error')).toEqual([{
      type: 'error', text: ROOM_TEXTS.noLongerAvailable, spectatorRequest: 103,
    }]);
    expect(other.messages('error')).toEqual([]);
    room.close();
  });

  test('starting to spectate releases watchers and broadcasts all changed roster flags', async () => {
    const {room, connect} = fixture(), host = connect(true), target = connect(), one = connect(), two = connect();
    const id = socket => socket.messages('welcome')[0].player.connectionId;
    const hostId = id(host), targetId = id(target), oneId = id(one), twoId = id(two);
    one.receive({type: 'spectate', connectionId: hostId, request: 7});
    two.receive({type: 'spectate', connectionId: hostId, request: 8});
    await rosterTick();
    for (const peer of [host, target, one, two]) peer.sent.length = 0;

    host.receive({type: 'spectate', connectionId: targetId, request: 9});
    expect(host.messages('spectator-demand').at(-1)).toEqual({type: 'spectator-demand', active: false, count: 0});
    expect(target.messages('spectator-demand')).toEqual([{type: 'spectator-demand', active: true, count: 1}]);
    expect(one.messages('error').at(-1).spectatorRequest).toBe(7);
    expect(two.messages('error').at(-1).spectatorRequest).toBe(8);
    await rosterTick();
    for (const peer of [host, target, one, two]) {
      expect(peer.messages('roster')).toHaveLength(1);
      expect(peer.messages('roster')[0].players.map(player => [player.connectionId, player.spectating]))
        .toEqual([[hostId, true], [targetId, false], [oneId, false], [twoId, false]]);
    }
    room.close();
  });

  test('validates Stop and repeated-target payloads even when the subscription burst is exhausted', () => {
    for (const invalid of ['stop', 'repeat', 'target']) {
      const {room, connect} = fixture({now: () => 0}), one = connect(), two = connect(), watcher = connect();
      const oneId = one.messages('welcome')[0].player.connectionId, twoId = two.messages('welcome')[0].player.connectionId;
      for (let request = 1; request <= 4; request++) {
        watcher.receive({type: 'spectate', connectionId: request % 2 ? oneId : twoId, request});
      }
      watcher.receive(invalid === 'stop' ? {type: 'spectate', connectionId: null, request: -1}
        : invalid === 'repeat' ? {type: 'spectate', connectionId: twoId}
        : {type: 'spectate', connectionId: 123, request: 5});
      expect(watcher.closed?.code).toBe(CLOSE.invalid);
      expect(two.messages('spectator-demand').at(-1)).toEqual({type: 'spectator-demand', active: false, count: 0});
      room.close();
    }
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

  test('closes only a malformed sender; the room stays open when the host leaves until close()', () => {
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
    expect(remaining.closed).toEqual({code: CLOSE.gone, reason: ROOM_TEXTS.hostClosed});
    expect(room.players).toEqual([]);
    expect(connect().closed.code).toBe(CLOSE.gone);
    room.close();
  });

  test('visibility changes keep the current map and epoch', () => {
    const {room, connect} = fixture(), host = connect(true), guest = connect();
    room.setVisibility('public');
    for (const socket of [host, guest]) {
      expect(socket.messages('state').at(-1).state).toMatchObject({visibility: 'public', mapId: 'one', epoch: 1});
    }
    room.setVisibility('private');
    expect(guest.messages('state').at(-1).state.visibility).toBe('private');
    expect(room.players).toHaveLength(2);
    room.close();
  });

  test('explicit close shuts down connecting sockets too', () => {
    const {room, connect} = fixture(), waiting = connect(false, hello, false);
    room.close();
    expect(waiting.closed.code).toBe(CLOSE.gone);
    waiting.open();
    expect(waiting.messages('welcome')).toEqual([]);
  });

  test('refuses joins beyond 64 players but keeps a place for the host', () => {
    const {room, connect} = fixture();
    const peers = Array.from({length: MAX_ROOM_PLAYERS - 1}, () => connect());
    expect(connect().closed).toEqual({code: CLOSE.refused, reason: ROOM_TEXTS.full});
    const host = connect(true);
    expect(host.closed).toBeNull();
    expect(room.players).toHaveLength(MAX_ROOM_PLAYERS);
    expect(controls(host).find(message => message.type === 'welcome').player.slot).toBe(MAX_ROOM_PLAYERS - 1);
    peers[0].close(1000, 'Left');
    expect(controls(connect()).find(message => message.type === 'welcome').player.slot).toBe(0);
    room.close();
  });

  test('lowering capacity keeps players and stops admissions until a place opens', () => {
    const {room, connect} = fixture({maxPlayers: 4}), host = connect(true), peers = [connect(), connect(), connect()];
    try {
      room.setMaxPlayers(2);
      expect(room.players).toHaveLength(4);
      expect(peers.every(peer => peer.closed === null)).toBe(true);
      expect(host.messages('state').at(-1).state).toMatchObject({maxPlayers: 2, epoch: 1});
      expect(connect().closed).toEqual({code: CLOSE.refused, reason: ROOM_TEXTS.full});
      peers[0].close(1000, 'Left');
      peers[1].close(1000, 'Left');
      expect(connect().closed).toEqual({code: CLOSE.refused, reason: ROOM_TEXTS.full});
      peers[2].close(1000, 'Left');
      expect(connect().closed).toBeNull();
      for (const value of [1, 65, 2.5, '4', null]) expect(() => room.setMaxPlayers(value)).toThrow();
      expect(room.state.maxPlayers).toBe(2);
    } finally { room.close(); }
  });

  test('defaults to sixteen players and counts connecting guests toward admission', () => {
    const {room, connect} = fixture({maxPlayers: undefined});
    try {
      const peers = Array.from({length: 15}, () => connect(false, hello, false));
      expect(connect(false, hello, false).closed).toEqual({code: CLOSE.refused, reason: ROOM_TEXTS.full});
      expect(connect(true).closed).toBeNull();
      peers.forEach(peer => peer.open());
      expect(room.players).toHaveLength(16);
      expect(room.state.maxPlayers).toBe(16);
    } finally { room.close(); }
  });

  test('replaces live and connecting host registrations', () => {
    const {room, connect} = fixture(), host = connect(true), guest = connect();
    const invalid = connect(true, {...hello, guest: 'no'});
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

  test('notifies on membership changes, map changes and closure', () => {
    let changes = 0;
    const notified = () => { const fired = changes > 0; changes = 0; return fired; };
    const {room, connect} = fixture({onChange: () => changes++});
    const host = connect(true);
    expect(notified()).toBe(true);
    const guest = connect();
    expect(notified()).toBe(true);
    host.receive({type: 'change-map', mapId: 'two'});
    expect(notified()).toBe(true);
    guest.close(1000, 'Left');
    expect(notified()).toBe(true);
    room.close();
    expect(notified()).toBe(true);
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

  test('chunks complete large welcomes and rosters', async () => {
    const maps = Array.from({length: 1001}, (_, index) => ({id: index ? 'map-' + index : 'one', title: '名\"\\\\'.repeat(16)}));
    const {room} = fixture({maps});
    class Sink extends Socket { send() {} }
    for (let index = 0; index < MAX_ROOM_PLAYERS - 2; index++) {
      const socket = new Sink();
      room.addClient(socket, {...hello, name: '名\"\\\\'.repeat(8), memory: 'ignored'});
      socket.open();
    }
    const receiver = new Socket();
    room.addClient(receiver, hello);
    receiver.open();
    await rosterTick();
    const messages = controls(receiver), welcome = messages.find(message => message.type === 'welcome');
    expect(receiver.messages('room-chunk').length).toBeGreaterThan(1);
    expect(welcome.maps).toEqual(maps);
    expect(welcome.players).toEqual(room.players);
    expect(welcome.players).toHaveLength(MAX_ROOM_PLAYERS - 1);
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

  test('incoming poses flush an overdue batch without waiting for a hidden-tab timer', () => {
    let time = 0;
    const {room, connect} = fixture({now: () => time}), host = connect(true), guest = connect();
    const upload = sequence => guest.receive(encodePoseBatch({sequence, epoch: 1, samples: [{...pose, x: sequence}]}));
    try {
      upload(1);
      time = 49;
      upload(2);
      expect(snapshots(host)).toEqual([]);
      time = 98;
      upload(3);
      expect(snapshots(host).flat().map(block => [block.sequence, block.samples[0].x])).toEqual([[3, 3]]);
      expect(snapshots(guest)).toEqual([]);
      time = 196;
      upload(4);
      time = 294;
      upload(5);
      expect(snapshots(host).flat().map(block => block.sequence)).toEqual([3, 5]);
    } finally { room.close(); }
  });

  test('preserves every sender and sample in a full-room snapshot', async () => {
    const {room, connect} = fixture(), host = connect(true);
    const peers = Array.from({length: MAX_ROOM_PLAYERS - 1}, () => connect());
    const source = encodePoseBatch({sequence: 1, epoch: 1, samples: [pose, {...pose, yaw: 1.25, pitch: 35.5}]});
    peers.forEach(peer => peer.receive(source));
    await tick();
    expect(snapshots(host).map(blocks => blocks.length)).toEqual([MAX_ROOM_PLAYERS - 1]);
    expect(new Set(snapshots(host).flat().map(block => block.slot)).size).toBe(MAX_ROOM_PLAYERS - 1);
    expect(snapshots(peers[0]).map(blocks => blocks.length)).toEqual([MAX_ROOM_PLAYERS - 2]);
    expect(snapshots(peers[0]).flat().some(block => block.slot === 1)).toBe(false);
    const packet = host.sent.find(value => value instanceof ArrayBuffer);
    expect(new Uint8Array(packet, 18, 64)).toEqual(new Uint8Array(source, 12));
    room.close();
  });

  test('drops poses from departed players and old epochs, and sends none after close', async () => {
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

  test('preserves every native-permitted spectator sample, including the 1ms early-send tolerance', () => {
    let time = 0;
    const {room, connect} = fixture({now: () => time}), target = connect(), watcher = connect();
    watcher.receive({type: 'spectate', connectionId: room.players[0].connectionId, request: 1});
    const expected = [];
    for (let sequence = 0; sequence < 600; sequence++) {
      time = sequence * (1000 / 30 - 1);
      const packet = {slot: MAX_ROOM_PLAYERS - 1, sequence, epoch: 1, pose: {...detailed, time: sequence, x: sequence / 7}};
      const source = encodeSpectator(packet), forwarded = source.slice(0), view = new DataView(forwarded);
      view.setUint8(1, 4);
      view.setUint16(2, 0, true);
      expected.push(forwarded);
      target.receive(source);
    }
    expect(watcher.sent.filter(value => value instanceof ArrayBuffer)).toEqual(expected);
    expect(target.closed).toBeNull();
    room.close();
  });

  test('bounds spectator flood fanout to eight burst frames plus the native-permitted rate', () => {
    let time = 0;
    const {room, connect} = fixture({now: () => time}), target = connect();
    const watchers = Array.from({length: 3}, () => connect());
    for (const watcher of watchers) watcher.receive({type: 'spectate', connectionId: room.players[0].connectionId, request: 1});
    const send = sequence => target.receive(encodeSpectator({slot: 0, sequence, epoch: 1, pose: detailed}));
    for (let sequence = 0; sequence < 1000; sequence++) send(sequence);
    for (const watcher of watchers) expect(watcher.sent.filter(value => value instanceof ArrayBuffer)).toHaveLength(8);
    for (time = 1; time <= 1000; time++) send(1000 + time);
    for (const watcher of watchers) {
      const frames = watcher.sent.filter(value => value instanceof ArrayBuffer);
      expect(frames).toHaveLength(8 + Math.floor(1000 / (1000 / 30 - 1)));
    }
    expect(target.closed).toBeNull();
    room.close();
  });

  test('drops duplicate and stale spectator sequences without spending burst tokens and accepts wraparound', () => {
    const {room, connect} = fixture({now: () => 0}), target = connect(), watcher = connect();
    watcher.receive({type: 'spectate', connectionId: room.players[0].connectionId, request: 1});
    const send = sequence => target.receive(encodeSpectator({slot: 0, sequence, epoch: 1, pose: detailed}));
    send(0xfffffffe);
    for (let index = 0; index < 100; index++) {
      send(0xfffffffe);
      send(0xfffffffd);
    }
    send(0xffffffff);
    send(0);
    send(0xffffffff);
    send(0x80000000);
    for (let sequence = 1; sequence <= 5; sequence++) send(sequence);
    expect(watcher.sent.filter(value => value instanceof ArrayBuffer).map(frame => decodeSpectator(frame, true).sequence))
      .toEqual([0xfffffffe, 0xffffffff, 0, 1, 2, 3, 4, 5]);
    room.close();
  });

  test('resets spectator sequencing on epochs without refilling burst tokens on epoch or demand changes', () => {
    let time = 0;
    const {room, connect} = fixture({now: () => time}), host = connect(true), target = connect(), watcher = connect();
    const targetId = target.messages('welcome')[0].player.connectionId;
    watcher.receive({type: 'spectate', connectionId: targetId, request: 1});
    const send = (sequence, epoch) => target.receive(encodeSpectator({slot: 0, sequence, epoch, pose: detailed}));
    for (let sequence = 0; sequence < 8; sequence++) send(sequence, 1);
    watcher.receive({type: 'spectate', connectionId: null, request: 2});
    watcher.receive({type: 'spectate', connectionId: targetId, request: 3});
    send(8, 1);
    host.receive({type: 'change-map', mapId: 'two'});
    send(0, 2);
    expect(watcher.sent.filter(value => value instanceof ArrayBuffer)).toHaveLength(8);
    time = 34;
    send(100, 1);
    send(0, 2);
    send(1, 2);
    expect(watcher.sent.filter(value => value instanceof ArrayBuffer).map(frame => {
      const packet = decodeSpectator(frame, true);
      return [packet.sequence, packet.epoch];
    })).toEqual([...Array.from({length: 8}, (_, sequence) => [sequence, 1]), [1, 2]]);
    room.close();
  });

  test('still validates malformed spectator data when unwatched or rate limited', () => {
    for (const watched of [false, true]) {
      const {room, connect} = fixture({now: () => 0}), target = connect(), watcher = connect();
      if (watched) watcher.receive({type: 'spectate', connectionId: room.players[0].connectionId, request: 1});
      for (let sequence = 0; sequence < 8; sequence++) {
        target.receive(encodeSpectator({slot: 0, sequence, epoch: 1, pose: detailed}));
      }
      const invalid = encodeSpectator({slot: 0, sequence: 8, epoch: 1, pose: detailed});
      new DataView(invalid).setFloat32(44, NaN, true);
      target.receive(invalid);
      expect(target.closed?.code).toBe(CLOSE.invalid);
      expect(watcher.sent.filter(value => value instanceof ArrayBuffer)).toHaveLength(watched ? 8 : 0);
      room.close();
    }
  });

  test('a spectate and chat flood stays bounded', async () => {
    let time = 0, bytes = 0;
    const {room, connect} = fixture({now: () => time});
    const peers = Array.from({length: 50}, () => connect());
    await rosterTick();
    for (const peer of peers) {
      peer.sent.length = 0;
      const send = peer.send.bind(peer);
      peer.send = data => { bytes += typeof data === 'string' ? data.length : data.byteLength; send(data); };
    }
    const attacker = peers[0], target = room.players[1].connectionId;
    for (let request = 0; request < 100; request++) {
      attacker.receive({type: 'spectate', connectionId: request % 2 ? null : target, request});
      attacker.receive({type: 'chat', text: 'x'.repeat(240)});
    }
    await rosterTick();
    expect(bytes).toBeLessThan(1e6);
    expect(peers[1].messages('chat')).toHaveLength(3);
    expect(peers[1].messages('roster')).toHaveLength(1);
    expect(peers[1].messages('spectator-demand').at(-1)).toEqual({type: 'spectator-demand', active: false, count: 0});
    expect(attacker.messages('error')).toEqual([{type: 'error', text: ROOM_TEXTS.tooFast}]);
    time = 1000;
    attacker.receive({type: 'chat', text: 'later'});
    peers[2].receive({type: 'chat', text: 'unaffected'});
    expect(peers[1].messages('chat').map(message => message.text).slice(-2)).toEqual(['later', 'unaffected']);
    room.close();
  });
});

test('a congested player skips poses but keeps reliable messages', async () => {
  const {room, connect} = fixture(), sender = connect(), watcher = connect(), healthy = connect();
  watcher.receive({type: 'spectate', connectionId: room.players[0].connectionId, request: 1});
  watcher.bufferedAmount = 64 * 1024 + 1;
  sender.receive(encodePoseBatch({sequence: 1, epoch: 1, samples: [pose]}));
  sender.receive(encodeSpectator({slot: 0, sequence: 1, epoch: 1, pose: detailed}));
  sender.receive({type: 'chat', text: 'still here'});
  await tick();
  expect(watcher.sent.filter(value => value instanceof ArrayBuffer)).toHaveLength(0);
  expect(snapshots(healthy)).toHaveLength(1);
  expect(watcher.messages('chat')).toHaveLength(1);
  expect(watcher.closed).toBeNull();
  watcher.bufferedAmount = 0;
  sender.receive(encodeSpectator({slot: 0, sequence: 2, epoch: 1, pose: detailed}));
  expect(watcher.sent.filter(value => value instanceof ArrayBuffer)).toHaveLength(1);
  room.close();
});

test('congested recipients skip snapshots while healthy recipients continue and drained players resume', async () => {
  const {room, connect} = fixture(), growing = connect(true), backlogged = connect(), notReady = connect();
  const pending = connect(false, hello, false), healthy = connect();
  const senders = Array.from({length: MAX_ROOM_PLAYERS - 5}, () => connect());
  const slots = senders.map(sender => sender.messages('welcome')[0].player.slot);
  const source = encodePoseBatch({sequence: 1, epoch: 1, samples: [pose, {...pose, time: 101}]});
  const send = growing.send.bind(growing);
  let congestOnSnapshot = true;
  growing.send = data => {
    send(data);
    if (data instanceof ArrayBuffer && congestOnSnapshot) {
      congestOnSnapshot = false;
      growing.bufferedAmount = 64 * 1024 + 1;
    }
  };
  backlogged.bufferedAmount = 64 * 1024 + 1;
  notReady.readyState = 2;
  for (const sender of senders) sender.receive(source);
  await tick();
  expect(snapshots(growing).map(blocks => blocks.length)).toEqual([senders.length]);
  expect(snapshots(backlogged)).toEqual([]);
  expect(snapshots(notReady)).toEqual([]);
  expect(pending.sent).toEqual([]);
  expect(snapshots(healthy).map(blocks => blocks.length)).toEqual([senders.length]);
  expect(snapshots(healthy).flat().map(block => block.slot)).toEqual(slots);
  expect(snapshots(healthy)[0][0].samples.map(sample => sample.time)).toEqual([100, 101]);
  expect(snapshots(senders[0]).flat().map(block => block.slot)).toEqual(slots.slice(1));

  senders[0].receive({type: 'chat', text: 'control still arrives'});
  for (const recipient of [growing, backlogged, healthy]) {
    expect(recipient.messages('chat').map(message => message.text)).toEqual(['control still arrives']);
    expect(recipient.closed).toBeNull();
  }
  for (const recipient of [growing, backlogged, notReady, healthy, ...senders]) recipient.sent.length = 0;
  growing.bufferedAmount = 0;
  backlogged.bufferedAmount = 0;
  notReady.readyState = 1;
  senders[0].receive(encodePoseBatch({sequence: 2, epoch: 1, samples: [{...pose, x: 77}]}));
  await tick();
  for (const recipient of [growing, backlogged, notReady, healthy]) {
    expect(snapshots(recipient)).toHaveLength(1);
    expect(snapshots(recipient)[0]).toHaveLength(1);
    expect(snapshots(recipient)[0][0]).toMatchObject({slot: slots[0], sequence: 2, samples: [{x: 77}]});
  }
  expect(snapshots(senders[0])).toEqual([]);
  expect(pending.sent).toEqual([]);
  room.close();
});

test('only a backlog that lasts 5 seconds disconnects a player', () => {
  let time = 0;
  const {room, connect} = fixture({now: () => time}), peer = connect();
  const backlogged = 8 * 1024 * 1024 + 1;
  peer.bufferedAmount = backlogged;
  peer.receive('ping');
  time = 4999;
  peer.receive('ping');
  peer.bufferedAmount = 0;
  peer.receive('ping');
  peer.bufferedAmount = backlogged;
  time = 6000;
  peer.receive('ping');
  time = 10999;
  peer.receive('ping');
  expect(peer.closed).toBeNull();
  time = 11000;
  peer.receive('ping');
  expect(peer.closed).toEqual({code: CLOSE.congested, reason: ROOM_TEXTS.congested});
  expect(room.players).toHaveLength(0);
  room.close();
});

test('the host kicks and bans for an hour by browser, and only the host moderates', () => {
  let time = 0;
  const {room, connect} = fixture({now: () => time}), host = connect(true);
  const identity = {...hello, name: 'Rowdy', browserId: crypto.randomUUID()};
  const id = socket => controls(socket).find(message => message.type === 'welcome').player.id;
  const bystander = connect(), rowdy = connect(false, identity);
  rowdy.receive({type: 'moderate', playerId: id(host), action: 'ban', minutes: 60});
  bystander.receive({type: 'moderate', playerId: id(rowdy), action: 'kick', minutes: 60});
  host.receive({type: 'moderate', playerId: id(host), action: 'kick', minutes: 60});
  expect(host.closed).toBeNull();
  expect(rowdy.closed).toBeNull();
  host.receive({type: 'moderate', playerId: id(rowdy), action: 'kick', minutes: 60});
  expect(rowdy.closed).toEqual({code: CLOSE.refused, reason: ROOM_TEXTS.kicked});
  expect(bystander.messages('notice').at(-1).text).toBe(kickedNotice('Rowdy'));
  const back = connect(false, identity);
  expect(back.closed).toBeNull();
  host.receive({type: 'moderate', playerId: id(back), action: 'ban', minutes: 60});
  expect(back.closed).toEqual({code: CLOSE.refused, reason: ROOM_TEXTS.banned});
  expect(host.messages('notice').at(-1).text).toBe(bannedNotice('Rowdy'));
  time = 60 * 60 * 1000 - 1;
  expect(connect(false, identity).closed).toEqual({code: CLOSE.refused, reason: ROOM_TEXTS.stillBanned});
  expect(connect(false, {...identity, browserId: crypto.randomUUID()}).closed).toBeNull();
  expect(connect(true, identity).closed).toBeNull();
  expect(connect(false, {...identity, browserId: undefined}).closed.code).toBe(CLOSE.invalid);
  time = 60 * 60 * 1000;
  expect(connect(false, identity).closed).toBeNull();
  room.close();
});

test('over loopback sockets the host receives binary as ArrayBuffer and relays poses and spectator frames', async () => {
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
    sender.send(encodeSpectator({slot: MAX_ROOM_PLAYERS - 1, sequence: 1, epoch: 1, pose: detailed}));
    expect(decodeSpectator(await spectator, true).slot).toBe(welcome.player.slot);
  } finally {
    room.close();
  }
});

describe('community room ranks', () => {
  const member = (name = 'Surfer', extra = {}) => ({...hello, name, userId: crypto.randomUUID(), ...extra});
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  test('signed-in players start with their claimed rank and guests stay guests', () => {
    const {room, connect} = fixture();
    connect(true, member('Host', {rank: 'Skilled', points: 4200}));
    connect(false, member('Rookie_1', {rank: 'Rookie', points: 120}));
    connect(false, {...guestHello, rank: 'Legend', points: 30000});
    for (const [rank, points] of [['Admin', 10], ['<b>Legend</b>', 30000], ['Legend', -1], ['Legend', 1.5], ['Legend', '20000'],
      [undefined, 100], ['Guest', 0]]) connect(false, member('Claimer', {rank, points}));
    expect(room.players.map(player => [player.rank, player.points])).toEqual([['Skilled', 4200], ['Rookie', 120], ['Guest', 0],
      ...Array(7).fill(['Unranked', 0])]);
    room.close();
  });

  test('the site profile of the claimed account sets rank and points, once per join', async () => {
    const lookups = [];
    const profiles = {
      match: {username: 'Surfer', rank: 'Expert', points: 7300},
      renamed: {username: 'Someone_else', rank: 'Legend', points: 30000},
      unknown: {username: 'Surfer', rank: 'Mythic', points: 4500},
      none: null,
    };
    const ids = Object.fromEntries(Object.keys(profiles).map(key => [key, crypto.randomUUID()]));
    const {room, connect} = fixture({lookupProfile: userId => {
      lookups.push(userId);
      const key = Object.keys(ids).find(name => ids[name] === userId);
      return key ? Promise.resolve(profiles[key]) : Promise.reject(new Error('offline'));
    }});
    const host = connect(true, {...hello, userId: ids.match, rank: 'Skilled', points: 4000});
    for (const key of ['renamed', 'unknown', 'none']) connect(false, {...hello, userId: ids[key], rank: 'Legend', points: 25000});
    connect(false, member('Offline', {rank: 'Regular', points: 2100}));
    connect(false, guestHello);
    connect(false, {...hello, name: 'No_account'});
    expect(lookups).toEqual([]);
    await settle();
    expect(lookups).toHaveLength(5);
    expect(room.players.map(player => [player.name, player.rank, player.points])).toEqual([
      ['Surfer', 'Expert', 7300], ['Surfer', 'Unranked', 0], ['Surfer', 'Skilled', 4500], ['Surfer', 'Unranked', 0],
      ['Offline', 'Regular', 2100], ['Guest_0a1b2', 'Guest', 0], ['No_account', 'Unranked', 0]]);
    await rosterTick();
    expect(host.messages('roster').at(-1).players[0]).toMatchObject({rank: 'Expert', points: 7300});
    room.close();
  });

  test('a profile that arrives after the player left or the room closed changes nothing', async () => {
    let answer;
    const {room, connect} = fixture({lookupProfile: () => new Promise(resolve => { answer = resolve; })});
    connect(true);
    const peer = connect(false, member('Surfer', {rank: 'Rookie', points: 100}));
    const player = room.players[1];
    await settle();
    peer.close(1000);
    answer({username: 'Surfer', rank: 'Legend', points: 30000});
    await settle();
    expect(player).toMatchObject({rank: 'Rookie', points: 100});
    room.close();
  });
});
