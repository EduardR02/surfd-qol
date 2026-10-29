import {describe, expect, test} from 'bun:test';
import {createRoomHost} from '../src/private-rooms/host.js';
import {createRoomFilter, decodeControl} from '../src/private-rooms/protocol.js';
import {createLoopbackPair} from '../src/private-rooms/socket.js';

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
function fixture() {
  let time = 0;
  const room = createRoomHost({roomId, mapId: 'one', maps, now: () => time});
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
        record: true, personalBest: true, previousBestUs: null, pointsDelta: 0, promoted: false});
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
      result: {...result, mapTitle: 'One'}});
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
