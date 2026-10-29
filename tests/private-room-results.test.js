import {describe, expect, test} from 'bun:test';
import {createRoomHost} from '../src/private-rooms/host.js';
import {createRoomFilter, decodeControl} from '../src/private-rooms/protocol.js';
import {createLoopbackPair} from '../src/private-rooms/socket.js';

const rosterTick = () => new Promise(resolve => setTimeout(resolve, 110));

const roomId = 'p-abcdefghjkmn';
const maps = [{id: 'one', title: 'One'}, {id: 'two', title: 'Two'}];
const claim = {type: 'finish', mapId: 'one', epoch: 1, timeUs: 12000000, personalBest: true, previousBestUs: null};
const hello = name => ({name, guest: false, userId: crypto.randomUUID(), browserId: crypto.randomUUID()});
class Socket extends EventTarget {
  readyState = 1;
  sent = [];
  bufferedAmount = 0;
  send(data) { this.sent.push(JSON.parse(data)); }
  receive(message) { this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify(message)})); }
  close(code) { this.code = code; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  results() { return this.sent.filter(message => message.type === 'result').map(message => message.result); }
}
function fixture(options = {}) {
  let time = 0;
  const room = createRoomHost({roomId, mapId: 'one', maps, now: () => time, ...options});
  function connect(host = false, identity = hello(host ? 'Host' : 'Surfer')) {
    const socket = new Socket();
    room.addClient(socket, identity, {host});
    return socket;
  }
  return {room, connect, at: value => { time = value; }};
}

describe('private room finish claims', () => {
  test('uses room identity and catalog, broadcasts to sender and peers, and never awards ranked fields', () => {
    const {room, connect} = fixture(), host = connect(true), identity = hello('Surfer'), peer = connect(false, identity);
    try {
      peer.receive({...claim, id: 'forged', userId: 'forged', name: 'Impostor', rank: 'Legend', mapTitle: '<b>forged</b>',
        record: false, leaderboardRank: 1, pointsDelta: 9000, promoted: true, stageRecords: [{stage: 1}]});
      const result = peer.results()[0];
      expect(result).toEqual({id: expect.stringMatching(/^[0-9a-f-]{36}$/), userId: identity.userId,
        name: 'Surfer', rank: 'Unranked', mapId: 'one', mapTitle: 'One', timeUs: 12000000,
        record: true, roomRecord: true, personalBest: true, previousBestUs: null, pointsDelta: 0, promoted: false, verified: false});
      expect(host.results()).toEqual([result]);
    } finally { room.close(); }
  });

  test('records are per map for the room lifetime; ties do not win and nonrecords use the claimed own PB', () => {
    const {room, connect, at} = fixture(), host = connect(true), peer = connect();
    try {
      peer.receive(claim);
      at(3000);
      peer.receive({...claim, timeUs: 13000000, previousBestUs: 14000000});
      expect(host.results().at(-1)).toMatchObject({record: false, personalBest: true, previousBestUs: 14000000});
      at(6000);
      peer.receive({...claim, timeUs: 11000000, personalBest: false});
      expect(host.results().at(-1)).toMatchObject({record: true, personalBest: false, previousBestUs: 12000000});
      at(9000);
      peer.receive({...claim, timeUs: 11000000, personalBest: false});
      expect(host.results().at(-1)).toMatchObject({record: false, personalBest: false, previousBestUs: null});
      host.receive({type: 'change-map', mapId: 'two'});
      at(12000);
      peer.receive({...claim, mapId: 'two', epoch: 2, timeUs: 15000000});
      expect(host.results().at(-1)).toMatchObject({mapId: 'two', record: true, previousBestUs: null});
      host.receive({type: 'change-map', mapId: 'one'});
      at(15000);
      peer.receive({...claim, epoch: 3});
      expect(host.results().at(-1)).toMatchObject({mapId: 'one', record: false});
      expect(new Set(host.results().map(result => result.id)).size).toBe(6);
    } finally { room.close(); }
  });

  test('drops stale maps and epochs and bounds each sender to one accepted result every three seconds', () => {
    const {room, connect, at} = fixture(), host = connect(true), peer = connect();
    try {
      for (const invalid of [{mapId: 'two'}, {mapId: 'missing'}, {epoch: 2}]) peer.receive({...claim, ...invalid});
      expect(host.results()).toEqual([]);
      peer.receive(claim);
      at(2999);
      peer.receive({...claim, timeUs: 10000000});
      expect(host.results()).toHaveLength(1);
      host.receive({...claim, timeUs: 11500000});
      expect(host.results().at(-1)).toMatchObject({name: 'Host', record: true, previousBestUs: 12000000});
      at(3000);
      peer.receive({...claim, timeUs: 10000000});
      expect(host.results().at(-1)).toMatchObject({name: 'Surfer', record: true, previousBestUs: 11500000});
      host.receive({type: 'change-map', mapId: 'two'});
      peer.receive({...claim, mapId: 'two', epoch: 2});
      expect(host.results()).toHaveLength(3);
      at(6000);
      peer.receive({...claim, mapId: 'two', epoch: 1});
      expect(host.results()).toHaveLength(3);
    } finally { room.close(); }
  });

  test('malformed claims close only their sender and cannot alter the room record', () => {
    const {room, connect} = fixture(), host = connect(true);
    try {
      for (const invalid of [{timeUs: 0}, {timeUs: -1}, {timeUs: 1.5}, {timeUs: '1000'}, {timeUs: 86400000001},
        {timeUs: null}, {mapId: null}, {epoch: 0}, {epoch: 1.5}, {personalBest: 'yes'},
        {previousBestUs: 12000000}, {previousBestUs: 11000000}, {personalBest: false, previousBestUs: 14000000}]) {
        const peer = connect();
        peer.receive({...claim, ...invalid});
        expect(peer.code).toBe(4002);
      }
      expect(host.results()).toEqual([]);
      host.receive(claim);
      expect(host.results()[0]).toMatchObject({record: true, previousBestUs: null});
    } finally { room.close(); }
  });

  test('unsigned guest finishes use the room player id, not a claimed account', () => {
    const {room, connect} = fixture(), peer = connect(false, {...hello('Guest_abcde'), guest: true});
    try {
      peer.receive(claim);
      expect(peer.results()[0].userId).toBe(room.players[0].id);
    } finally { room.close(); }
  });
});

describe('incoming room results', () => {
  const result = {id: crypto.randomUUID(), userId: crypto.randomUUID(), name: 'Surfer', rank: 'Guest',
    mapId: 'one', mapTitle: 'Forged title', timeUs: 12000000, record: false, personalBest: true,
    previousBestUs: 13000000, pointsDelta: 0, promoted: false};
  test('rebuilds catalog titles and drops leaderboard, stage records and unknown data', () => {
    const read = createRoomFilter({roomId, maps});
    expect(read({type: 'result', result: {...result, leaderboardRank: 1, leaderboardTotal: 99,
      stageRecords: [{stage: 1, timeUs: 1}], unknown: '<b>payload</b>'}})).toEqual({type: 'result',
      result: {...result, mapTitle: 'One', verified: false}});
    expect(decodeControl(JSON.stringify({...claim, record: true, pointsDelta: 100}))).toEqual(claim);
  });
  test('rejects malformed or ranked results before the native client sees them', () => {
    const read = createRoomFilter({roomId, maps});
    for (const invalid of [{id: 'x'}, {userId: 'x'}, {name: '<b>Surfer</b>'}, {rank: 'Admin'}, {rank: '<b>Legend</b>'}, {mapId: 'unknown'},
      {timeUs: 0}, {timeUs: -1}, {timeUs: 0.5}, {timeUs: 86400000001}, {timeUs: null},
      {record: 'true'}, {personalBest: 1}, {previousBestUs: 12000000}, {previousBestUs: '13000000'},
      {personalBest: false}, {pointsDelta: 1}, {promoted: true}]) {
      expect(() => read({type: 'result', result: {...result, ...invalid}})).toThrow('Invalid room result');
    }
    for (const invalid of [null, [], {}, 'result']) expect(() => read({type: 'result', result: invalid})).toThrow();
  });
});

test('host and guest loopbacks deliver the same validated native result to both game sockets', async () => {
  const room = createRoomHost({roomId, mapId: 'one', maps});
  const received = [[], []], clients = [], welcomed = [], firstResult = [], finished = [];
  try {
    for (let index = 0; index < 2; index++) {
      const [client, server] = createLoopbackPair(index === 0 ? {roomId, maps} : {});
      const read = index === 0 ? value => value : createRoomFilter({roomId, maps});
      clients.push(client);
      let welcome, first, finish;
      welcomed.push(new Promise(resolve => { welcome = resolve; }));
      firstResult.push(new Promise(resolve => { first = resolve; }));
      finished.push(new Promise(resolve => { finish = resolve; }));
      client.addEventListener('message', event => {
        const message = read(JSON.parse(event.data));
        received[index].push(message);
        if (message.type === 'welcome') welcome();
        if (message.type === 'result') first();
        if (received[index].filter(value => value.type === 'result').length === 2) finish();
      });
      room.addClient(server, hello(index ? 'Surfer' : 'Host'), {host: index === 0});
    }
    await Promise.all(welcomed);
    clients[0].send(JSON.stringify(claim));
    await Promise.all(firstResult);
    clients[1].send(JSON.stringify(claim));
    await Promise.all(finished);
    const results = received.map(messages => messages.filter(message => message.type === 'result'));
    expect(results[0]).toEqual(results[1]);
    expect(results[0].map(message => [message.result.name, message.result.record])).toEqual([['Host', true], ['Surfer', false]]);
  } finally { room.close(); }
});

describe('verified runs', () => {
  const board = (entries, total = entries.length) => ({entries, total});
  const verified = {type: 'verified', id: crypto.randomUUID(), mapId: 'one', epoch: 1, timeUs: 12000000,
    personalBest: true, previousBestUs: 13000000, record: false, pointsDelta: 40, promoted: false,
    leaderboardRank: 2, leaderboardTotal: 10};
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  function room(answer = () => null) {
    const lookups = [];
    const f = fixture({lookupBoard: mapId => { lookups.push(mapId); return answer(mapId); }});
    const host = f.connect(true), identity = {...hello('Surfer'), rank: 'Rookie', points: 450}, peer = f.connect(false, identity);
    return {...f, host, peer, identity, lookups};
  }

  test('a personal best the board shows is announced to the others with the board\u2019s place and the site\u2019s points', async () => {
    const f = room(() => board([{rank: 1, userId: crypto.randomUUID(), timeUs: 11000000}, {rank: 3, userId: f.identity.userId, timeUs: 12000000}], 12));
    try {
      f.peer.receive(verified);
      expect(f.host.results()).toEqual([]);
      await settle();
      expect(f.lookups).toEqual(['one']);
      expect(f.host.results()).toEqual([{id: verified.id, userId: f.identity.userId, name: 'Surfer', rank: 'Rookie',
        mapId: 'one', mapTitle: 'One', timeUs: 12000000, record: true, roomRecord: true, personalBest: true,
        previousBestUs: null, pointsDelta: 40, promoted: false, leaderboardRank: 3, leaderboardTotal: 12, verified: true}]);
      expect(f.peer.results()).toEqual([]);
      expect(f.room.players[1].points).toBe(490);
    } finally { f.room.close(); }
  });

  test('a site record needs first place on the board and reads as a Surfd record, not a room record', async () => {
    let entries;
    const f = room(() => board(entries, 5));
    try {
      entries = [{rank: 1, userId: f.identity.userId, timeUs: 12000000}];
      f.peer.receive({...verified, record: true});
      await settle();
      expect(f.host.results()[0]).toMatchObject({record: true, verified: true, leaderboardRank: 1, leaderboardTotal: 5});
      expect(f.host.results()[0].roomRecord).toBeUndefined();
      entries = [{rank: 1, userId: crypto.randomUUID(), timeUs: 10000000}, {rank: 2, userId: f.identity.userId, timeUs: 11000000}];
      f.peer.receive({...verified, id: crypto.randomUUID(), timeUs: 11000000, record: true});
      await settle();
      expect(f.host.results()[1]).toMatchObject({record: true, roomRecord: true, verified: false, pointsDelta: 0});
    } finally { f.room.close(); }
  });

  test('a personal best the board contradicts, can\u2019t show or can\u2019t be read is announced as unverified', async () => {
    const other = crypto.randomUUID();
    for (const [answer, ranked] of [
      [() => null, true],
      [() => { throw new Error('offline'); }, true],
      [() => Promise.reject(new Error('offline')), true],
      [() => ({entries: 'x', total: 1}), true],
      [f => board([{rank: 1, userId: f.identity.userId, timeUs: 12500000}]), true],
      [() => board([{rank: 1, userId: other, timeUs: 11000000}]), true],
      [() => board([{rank: 1, userId: other, timeUs: 12500000}], 40), true],
      [() => board([{rank: 1, userId: other, timeUs: 11000000}, {rank: 2, userId: other, timeUs: 11500000}], 40), true],
      [() => board([{rank: 1, userId: other, timeUs: 11000000}], 1), false],
    ]) {
      const f = room(() => answer(f));
      try {
        f.peer.receive(ranked ? verified : {...verified, leaderboardRank: undefined, leaderboardTotal: undefined});
        await settle();
        expect(f.host.results()).toHaveLength(1);
        expect(f.host.results()[0]).toMatchObject({verified: false, pointsDelta: 0, promoted: false, personalBest: true});
        expect(f.host.results()[0].leaderboardRank).toBeUndefined();
        expect(f.room.players[1].points).toBe(450);
      } finally { f.room.close(); }
    }
  });

  test('a personal best below the listed places keeps its claimed place within the board\u2019s total', async () => {
    const other = crypto.randomUUID();
    const f = room(() => board([{rank: 1, userId: other, timeUs: 11000000}], 40));
    try {
      f.peer.receive({...verified, leaderboardRank: 30, leaderboardTotal: 39});
      await settle();
      expect(f.host.results()[0]).toMatchObject({verified: true, leaderboardRank: 30, leaderboardTotal: 40});
    } finally { f.room.close(); }
  });

  test('a slower run is announced at once without a board check, keeping only a standing the board agrees with', async () => {
    const slower = {...verified, personalBest: false, previousBestUs: null, pointsDelta: 0};
    let entries = null;
    const f = room(() => entries && board(entries, 20));
    try {
      f.peer.receive({...slower, leaderboardRank: undefined, leaderboardTotal: undefined});
      expect(f.lookups).toEqual([]);
      expect(f.host.results()[0]).toMatchObject({verified: true, personalBest: false, record: true, roomRecord: true});
      expect(f.host.results()[0].leaderboardRank).toBeUndefined();
      entries = [{rank: 4, userId: f.identity.userId, timeUs: 11500000}];
      f.peer.receive({...slower, id: crypto.randomUUID(), timeUs: 12500000});
      await settle();
      expect(f.host.results()[1]).toMatchObject({verified: true, record: false, leaderboardRank: 4, leaderboardTotal: 20});
      entries = [{rank: 4, userId: f.identity.userId, timeUs: 13000000}];
      f.peer.receive({...slower, id: crypto.randomUUID(), timeUs: 12500000});
      await settle();
      entries = null;
      f.at(3000);
      f.peer.receive({...slower, id: crypto.randomUUID(), timeUs: 12600000});
      await settle();
      for (const result of f.host.results().slice(2)) {
        expect(result).toMatchObject({verified: true});
        expect(result.leaderboardRank).toBeUndefined();
      }
      expect(f.host.results()).toHaveLength(4);
    } finally { f.room.close(); }
  });

  test('a confirmed best\u2019s promotion to a higher rank updates the player; other promotions and a slower run\u2019s points are dropped', async () => {
    const f = room(() => board([{rank: 1, userId: f.identity.userId, timeUs: 12000000}], 1));
    const best = {...verified, leaderboardRank: undefined, leaderboardTotal: undefined};
    try {
      f.peer.receive({...best, pointsDelta: 60, promoted: true, rank: 'Surfer'});
      await settle();
      expect(f.host.results()[0]).toMatchObject({rank: 'Surfer', promoted: true, pointsDelta: 60, verified: true});
      expect(f.room.players[1]).toMatchObject({rank: 'Surfer', points: 510});
      for (const [index, rank] of ['Rookie', 'Mythic', undefined].entries()) {
        f.at(10000 * (index + 1));
        f.peer.receive({...best, id: crypto.randomUUID(), pointsDelta: 0, promoted: true, ...(rank ? {rank} : {})});
        await settle();
        expect(f.host.results().at(-1)).toMatchObject({rank: 'Surfer', promoted: false, verified: true});
      }
      f.at(40000);
      f.peer.receive({...best, id: crypto.randomUUID(), personalBest: false, previousBestUs: null, pointsDelta: 500, promoted: true, rank: 'Legend'});
      expect(f.host.results().at(-1)).toMatchObject({rank: 'Surfer', promoted: false, pointsDelta: 0, verified: true});
      await rosterTick();
      expect(f.host.sent.filter(message => message.type === 'roster').at(-1).players[1]).toMatchObject({rank: 'Surfer', points: 510});
    } finally { f.room.close(); }
  });

  test('each verified run is announced once, three at a time and then one every three seconds', async () => {
    const f = room(() => null);
    const slower = {...verified, personalBest: false, previousBestUs: null, leaderboardRank: undefined, leaderboardTotal: undefined};
    try {
      f.peer.receive(slower);
      f.peer.receive(slower);
      expect(f.host.results()).toHaveLength(1);
      for (let index = 0; index < 3; index++) f.peer.receive({...slower, id: crypto.randomUUID()});
      expect(f.host.results()).toHaveLength(3);
      f.at(3000);
      f.peer.receive({...slower, id: crypto.randomUUID()});
      f.peer.receive({...slower, id: undefined});
      expect(f.host.results()).toHaveLength(4);
      f.at(6000);
      f.peer.receive({...slower, id: undefined});
      expect(f.host.results().at(-1).id).toMatch(/^[0-9a-f-]{36}$/);
    } finally { f.room.close(); }
  });

  test('guests, accounts without ids and unknown map epochs are refused; an earlier epoch of its map is not', async () => {
    const f = room(() => null);
    const slower = {...verified, personalBest: false, previousBestUs: null, leaderboardRank: undefined, leaderboardTotal: undefined};
    const guest = f.connect(false, {...hello('Guest_abcde'), guest: true}), anonymous = f.connect(false, {...hello('Nobody'), userId: undefined});
    try {
      guest.receive(slower);
      anonymous.receive({...slower, id: crypto.randomUUID()});
      for (const stale of [{epoch: 2}, {mapId: 'two'}]) f.peer.receive({...slower, id: crypto.randomUUID(), ...stale});
      expect(f.host.results()).toEqual([]);
      f.host.receive({type: 'change-map', mapId: 'two'});
      f.peer.receive({...slower, id: crypto.randomUUID()});
      expect(f.host.results()).toHaveLength(1);
      expect(f.host.results()[0].mapId).toBe('one');
    } finally { f.room.close(); }
  });

  test('malformed verified claims close only their sender', () => {
    const f = room();
    try {
      for (const invalid of [{id: 'run-1'}, {timeUs: 0}, {record: 'no'}, {personalBest: false, previousBestUs: 13000000},
        {previousBestUs: 11000000}, {pointsDelta: -1}, {pointsDelta: 1.5}, {pointsDelta: 1e7}, {promoted: 'yes'},
        {rank: 'Surfer'}, {promoted: true, rank: 7}, {leaderboardRank: 0}, {leaderboardRank: 11}, {leaderboardTotal: undefined},
        {leaderboardRank: 1.5}, {epoch: 0}, {mapId: ''}]) {
        const peer = f.connect();
        peer.receive({...verified, ...invalid});
        expect(peer.code).toBe(4002);
      }
      expect(f.host.results()).toEqual([]);
    } finally { f.room.close(); }
  });

  test('guests rebuild verified results and refuse ranked fields on unverified ones', () => {
    const read = createRoomFilter({roomId, maps});
    const result = {id: crypto.randomUUID(), userId: crypto.randomUUID(), name: 'Surfer', rank: 'Skilled', mapId: 'one',
      mapTitle: '<b>x</b>', timeUs: 12000000, record: false, personalBest: true, previousBestUs: 13000000,
      pointsDelta: 40, promoted: true, leaderboardRank: 3, leaderboardTotal: 12, verified: true, stageRecords: []};
    expect(read({type: 'result', result})).toEqual({type: 'result', result: {...result, mapTitle: 'One', stageRecords: undefined}});
    expect(read({type: 'result', result: {...result, record: true}}).result.roomRecord).toBeUndefined();
    expect(read({type: 'result', result: {...result, record: true, roomRecord: true}}).result.roomRecord).toBe(true);
    expect(read({type: 'result', result: {...result, record: true, verified: undefined, pointsDelta: 0, promoted: false}}).result)
      .toMatchObject({roomRecord: true, verified: false});
    for (const invalid of [{verified: 'yes'}, {roomRecord: 1}, {pointsDelta: -1}, {pointsDelta: 1e7}, {promoted: 1},
      {leaderboardRank: 13}, {leaderboardTotal: undefined}, {rank: 'Admin'},
      {verified: false}, {verified: false, pointsDelta: 0}]) {
      expect(() => read({type: 'result', result: {...result, ...invalid}})).toThrow('Invalid room result');
    }
  });
});
