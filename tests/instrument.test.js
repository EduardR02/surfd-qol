import {describe, expect, test} from 'bun:test';
import {instrumentGame} from '../extension/instrument.js';
import {createPrivateRooms} from '../src/private-rooms/index.js';
import {isPrivateRoomId} from '../src/private-rooms/ids.js';
import {createBroadcastSignalling} from '../src/private-rooms/signalling.js';

// The private names are deliberately unrelated to the live bundle's names.
// This miniature native module keeps the signatures used by instrumentation
// and the game's pre-download generation / guarded startup behavior.
const nativeSource = `
let sessions=0;
class Movement {}
class Session{
  constructor(map={id:'map',version:1},config={rule:'legacy'},format=1) {
    sessions++; this.movement=new Movement(); this.timer={state:{}}; this.map=map; this.config=config; this.replayFormat=format;
  }
  checkpointSpeeds=[];startJumps=0;startPosition=null;
  practiceKey() { return JSON.stringify([this.map.id,this.map.version,this.config.rule,this.replayFormat]); }
  setStartPosition(start) { this.startPosition=start; return start; }
}
// Surfd's replay player: what plays and where.
const player={replay:null,position:0,host:{position:()=>player.position},open(data){player.replay=data;player.position=0;},snapshot(){return {open:!!player.replay};}};
let nativeSession=new Session(),generation=0,target=null,view=null;
let startup=()=>Promise.resolve();
const input={setBindings(){}},settings={bindings:{}};
input.setBindings(settings.bindings);
const currentFormat=8,liveRules=map=>({rule:settings.rule??'current'});
let replayMap=null;
let starts={};
function storedStart(map){return starts[map.id+':'+map.version]??null}
function fresh(map){const session=new Session(map,liveRules(map),currentFormat),saved=storedStart(map);return saved&&session.setStartPosition(saved),session;}
function restart(){nativeSession=fresh(replayMap??nativeSession.map);replayMap=null;return nativeSession;}
const client={session:{user:{id:'account-a'}},config:{maps:[{id:'map',slug:'test-map'}]},
  board:()=>({boardId:'board'}),replay:async()=>null};
const boards={key:'board:account-a',current:{boardId:'board',own:{runId:'pb-a'},entries:[]}};
const route={prepare(){}},bank={entries:()=>[],save(){}},limit=20;
function references() { const record=boards.current?.entries.find(entry=>entry.rank===1);route.prepare('map',()=>client.replay(record.runId)); }
function lookup() { return client.board(nativeSession.map); }
function snapshot() { return {state:nativeSession?.state,run:nativeSession?.timer.state,replay:player.snapshot(),spectator:{target:target,view:view}}; }
function save() { const full=bank.entries(nativeSession).length>=limit,result=bank.save(nativeSession); }
function notify() {}
function saveNotice() { if(false){notify("Return to play before saving a location.");return} }
async function watch(data,current,label,token=++generation){if(!current())return;
  await startup();
  if(token!==generation||!current())return;
  nativeSession=new Session();player.open(data);
}
function nativeWatch(load) {
  const token=++generation;
  return load().then(data=>watch(data,()=>true,'native',token));
}
`;

function fixture() {
  let adapter;
  const runtime = new Function('globalThis', instrumentGame(nativeSource) + `
    return {nativeWatch,generation:()=>generation,setStartup:fn=>{startup=fn;},
      setOwner:id=>{client.session=id?{user:{id}}:null;},
      sessions:()=>sessions,restart,setStart:(key,start)=>{starts[key]=start;},
      setRules:rule=>{settings.rule=rule;},setReplayMap:map=>{replayMap=map;}};
  `)({__SURFD_QOL__: {attach: value => { adapter = value; }}});
  return {adapter, runtime};
}

describe('native replay instrumentation', () => {
  test('extension reservation cancels an older native download without reserving again at startup', async () => {
    const {adapter, runtime} = fixture();
    let finishNative;
    const native = runtime.nativeWatch(() => new Promise(resolve => { finishNative = resolve; }));
    const token = adapter.replay.reserve();
    finishNative({commands: ['older']});
    await native;
    expect(adapter.replay.playback().replay).toBeNull();
    const data = {commands: ['newer']};
    await adapter.replay.watch(data, 'saved', () => adapter.replay.isCurrent(token), token);
    expect(adapter.replay.playback().replay).toBe(data);
    expect(runtime.generation()).toBe(token);
    expect(adapter.replay.isCurrent(token)).toBe(true);
  });

  test('a newer native intent cancels an already pending extension startup', async () => {
    const {adapter, runtime} = fixture();
    let finishStartup;
    runtime.setStartup(() => new Promise(resolve => { finishStartup = resolve; }));
    const token = adapter.replay.reserve();
    const pending = adapter.replay.watch({commands: ['older']}, 'saved', () => true, token);
    runtime.setStartup(() => Promise.resolve());
    const data = {commands: ['newer']};
    await runtime.nativeWatch(async () => data);
    expect(adapter.replay.isCurrent(token)).toBe(false);
    finishStartup();
    await pending;
    expect(adapter.replay.playback().replay).toBe(data);
  });

  test('reference ownership follows the current account and rejects another account’s board data', () => {
    const {adapter, runtime} = fixture();
    expect(adapter.getReferences()).toMatchObject({ownerKey: 'account-a', own: {runId: 'pb-a'}});
    runtime.setOwner('account-b');
    expect(adapter.getReferences()).toMatchObject({ownerKey: 'account-b', own: null});
    runtime.setOwner(null);
    expect(adapter.getReferences()).toMatchObject({ownerKey: 'guest', own: null});
  });
});

describe('native practice destinations', () => {
  test('a legacy replay uses Restart’s current rules and format without constructing or changing a Session', () => {
    const {adapter, runtime} = fixture();
    const legacy = adapter.getSession(), legacyKey = legacy.practiceKey(), count = runtime.sessions();
    const destination = adapter.practice.destination();
    expect(destination).toEqual({mapId: 'map', mapVersion: 1, key: JSON.stringify(['map', 1, 'current', 8]), startPosition: null});
    expect(runtime.sessions()).toBe(count);
    expect(adapter.getSession()).toBe(legacy);
    expect(legacy.practiceKey()).toBe(legacyKey);
    expect(runtime.restart().practiceKey()).toBe(destination.key);
  });

  test('destination metadata follows native map override and live movement settings rather than replay metadata', () => {
    const {adapter, runtime} = fixture();
    runtime.setReplayMap({id: 'map', version: 2});
    runtime.setRules('unrestricted');
    const destination = adapter.practice.destination();
    expect(destination).toEqual({mapId: 'map', mapVersion: 2,
      key: JSON.stringify(['map', 2, 'unrestricted', 8]), startPosition: null});
    expect(adapter.getSession().map.version).toBe(1);
    expect(runtime.restart().practiceKey()).toBe(destination.key);
    runtime.setRules('ranked');
    expect(adapter.practice.destination().key).toBe(JSON.stringify(['map', 2, 'ranked', 8]));
  });

  test('the destination carries the start position Restart applies: the one you set on that map version', () => {
    const {adapter, runtime} = fixture();
    const yours = {position: {x: 1, y: 2, z: 3}, yaw: 90, pitch: 0};
    runtime.setStart('map:1', yours);
    expect(adapter.practice.destination().startPosition).toEqual(yours);
    expect(runtime.restart().startPosition).toEqual(yours);
    runtime.setReplayMap({id: 'map', version: 2});
    expect(adapter.practice.destination().startPosition).toBeNull();
  });

  test('without a recognisable start loader, savelocs still file and keep the replay’s start position', () => {
    let adapter;
    const source = nativeSource.replace('return saved&&session.setStartPosition(saved),session;', 'return session;');
    new Function('globalThis', instrumentGame(source))({__SURFD_QOL__: {attach: value => { adapter = value; }}});
    const destination = adapter.practice.destination();
    expect(destination.key).toBe(JSON.stringify(['map', 1, 'current', 8]));
    expect('startPosition' in destination).toBe(false);
  });
});

// The fixture intentionally preserves only semantic/minified signatures, not
// any live private name. Its network spies make unintended private traffic fail.
const roomSource = nativeSource + `
const catalog=[{id:'map',title:'Fixture map'}],ranking={refresh(){}},options={currentMap:()=> 'map'};
let joined=null,listed=[{id:'public',mapId:'map',online:true}],joinCallback,refreshCallback;
const secondsLeft=(end,now)=>Math.max(0,Math.ceil((end-now)/1000));
function countdown(end,now){const seconds=secondsLeft(end,now);return seconds===0?"Changing map…":seconds+"s left"}
function clocks(row){const connection={state:row},offset=0;return [
  countdown(row.endsAt,Date.now()),countdown(row.endsAt,Date.now()),
  countdown(connection.state.endsAt,Date.now()+offset),countdown(row.endsAt,Date.now()+offset)
]}
function lobbyFactory(){return {
  servers:{rows:()=>listed},selected:()=>catalog[0],
  updateServers(rows){listed=rows},
  bindServers(connect,refresh){joinCallback=connect,refreshCallback=refresh,refresh()},
  refreshTop10(){ranking.refresh(catalog.find(entry=>entry.id===options.currentMap())??null)}
}}
const lobby=lobbyFactory();
lobby.bindServers(id=>{joined={id,row:listed.find(row=>row.id===id)}},()=>{});
class NativeRoom {
  baseUrl='https://public.example';roomId=null;
  ticket(){return fetch('/room-ticket',{method:'POST'}).then(response=>response.json()).then(data=>data.token)}
  async list(){const response=await fetch(this.baseUrl+"/servers",{signal:AbortSignal.timeout(8e3),cache:"no-store"});if(!response.ok)throw Error("Servers unavailable");const data=await response.json();if(!Array.isArray(data.servers))throw Error("Invalid server list");return data.servers}
  async measure(id){const started=performance.now();if(!(await fetch(this.baseUrl+"/servers/"+id+"/ping",{signal:AbortSignal.timeout(5e3),cache:"no-store"})).ok)throw Error("Server unavailable");return performance.now()-started}
  async open(id){this.roomId=id;const token=await this.ticket();const url=new URL('/servers/'+id+'/ws',this.baseUrl);return new WebSocket(url,["surfd-v1",token])}
  async refreshIdentity(){return await this.ticket()}
}
`;

function roomFixture(privateRooms, source = roomSource) {
  let adapter;
  const requests = [], sockets = [], warnings = [];
  let failList = false;
  const fetch = async (url, options) => {
    requests.push({url, options});
    if (String(url).endsWith('/servers')) {
      if (failList) throw new Error('offline');
      return {ok: true, json: async () => ({servers: [{id: 'public', mapId: 'map', online: true}]})};
    }
    return {ok: true, json: async () => ({token: 'native-ticket'})};
  };
  function WebSocket(url, protocols) { sockets.push({url: String(url), protocols}); }
  const warn = console.warn;
  let instrumented;
  try {
    console.warn = (...args) => warnings.push(args);
    instrumented = instrumentGame(source);
  } finally { console.warn = warn; }
  const runtime = new Function('globalThis', 'fetch', 'WebSocket', instrumented + `
    return {room:new NativeRoom(),clocks,joined:()=>joined,profile:value=>{client.profile=value},
      guest:()=>{client.session=null}};
  `)({__SURFD_QOL__: {privateRooms, attach: value => { adapter = value; }}}, fetch, WebSocket);
  return {adapter, runtime, requests, sockets, warnings, instrumented, failList: () => { failList = true; }};
}

function privateFixtureHooks() {
  const row = {id: 'private-fixture', name: 'Private fixture', mapId: 'map', online: true};
  const socket = {private: true};
  return {
    row, socket,
    ticket: id => id === row.id ? 'private-ticket' : null,
    measure: id => id === row.id ? 0 : null,
    roomSocket: id => id === row.id ? socket : null,
    mergeRooms: rows => [...rows, row]
  };
}

describe('optional native private room instrumentation', () => {
  test('public tickets, refresh, ping and WebSockets keep the native flow', async () => {
    const fixture = roomFixture(privateFixtureHooks());
    await fixture.runtime.room.open('public');
    await fixture.runtime.room.refreshIdentity();
    await fixture.runtime.room.measure('public');
    expect(fixture.requests.filter(request => request.url === '/room-ticket')).toHaveLength(2);
    expect(fixture.requests.some(request => request.url.endsWith('/servers/public/ping'))).toBe(true);
    expect(fixture.sockets).toEqual([{url: 'https://public.example/servers/public/ws', protocols: ['surfd-v1', 'native-ticket']}]);
    expect(fixture.warnings).toEqual([]);
  });

  test('private connect, identity refresh and measurement never touch site transport', async () => {
    const hooks = privateFixtureHooks();
    const fixture = roomFixture(hooks);
    expect(await fixture.runtime.room.open(hooks.row.id)).toBe(hooks.socket);
    expect(await fixture.runtime.room.refreshIdentity()).toBe('private-ticket');
    expect(await fixture.runtime.room.measure(hooks.row.id)).toBe(0);
    expect(fixture.requests).toEqual([]);
    expect(fixture.sockets).toEqual([]);
  });

  test('known private rows merge with public results and survive public list outages', async () => {
    const hooks = privateFixtureHooks();
    const fixture = roomFixture(hooks);
    expect(await fixture.runtime.room.list()).toEqual([{id: 'public', mapId: 'map', online: true}, hooks.row]);
    fixture.failList();
    expect(await fixture.runtime.room.list()).toEqual([hooks.row]);
  });

  test('adapter uses native join callback and selected row plus current identity and maps', () => {
    const hooks = privateFixtureHooks();
    const {adapter, runtime} = roomFixture(hooks);
    adapter.rooms.update([hooks.row]);
    adapter.rooms.join(hooks.row.id);
    expect(runtime.joined()).toEqual({id: hooks.row.id, row: hooks.row});
    const appearance = {title: '', nameColor: '#123456', titleColor: null, revision: 1};
    runtime.profile({username: 'Fixture player', appearance});
    expect(adapter.rooms.displayName()).toBe('Fixture player');
    expect(adapter.rooms.appearance()).toBe(appearance);
    expect(adapter.rooms.guest()).toBe(false);
    runtime.guest();
    expect(adapter.rooms.guest()).toBe(true);
    expect(adapter.rooms.maps()).toEqual([{id: 'map', title: 'Fixture map'}]);
    expect(adapter.rooms.currentMap()).toBe(adapter.getSession().map);
  });

  test('absent runtime hooks leave all native behavior available', async () => {
    const fixture = roomFixture(undefined);
    await fixture.runtime.room.open('public');
    expect(fixture.sockets).toHaveLength(1);
    expect(await fixture.runtime.room.list()).toEqual([{id: 'public', mapId: 'map', online: true}]);
    fixture.failList();
    await expect(fixture.runtime.room.list()).rejects.toThrow('offline');
  });

  test('an unrecognised optional hook warns and leaves the entire room transport unchanged', async () => {
    const source = roomSource.replace('cache:\"no-store\"', 'cache:\"reload\"');
    const fixture = roomFixture(privateFixtureHooks(), source);
    expect(fixture.adapter.rooms).toBeUndefined();
    expect(fixture.warnings).toHaveLength(1);
    expect(fixture.warnings[0][0]).toContain('Private rooms unavailable');
    await fixture.runtime.room.open('public');
    expect(fixture.requests[0].url).toBe('/room-ticket');
    expect(fixture.sockets).toHaveLength(1);
  });

  test('untimed private rows and room state show no time limit while public countdowns stay native', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    expect(runtime.clocks({endsAt: 0, untimed: true})).toEqual(Array(4).fill('No time limit'));
    expect(runtime.clocks({endsAt: 0})).toEqual(Array(4).fill('Changing map…'));
    for (const text of runtime.clocks({endsAt: Date.now() + 30000, untimed: false})) expect(text).toMatch(/^\d+s left$/);
  });

  test('instrumenting an instrumented bundle does not duplicate transport hooks', () => {
    const fixture = roomFixture(privateFixtureHooks());
    expect(instrumentGame(fixture.instrumented)).toBe(fixture.instrumented);
  });
});

function privateRuntimeFixture() {
  let rows = [{id: 'public', mapId: 'map'}], joined = null;
  const adapter = {rooms: {
    rows: () => rows,
    update: value => { rows = value; },
    join: id => { joined = {id, row: rows.find(row => row.id === id)}; },
    currentMap: () => ({id: 'map'}),
    maps: () => [{id: 'map', title: 'Fixture map'}],
    displayName: () => 'Guest',
    appearance: () => null,
    guest: () => true
  }};
  const runtime = createPrivateRooms({getAdapter: () => adapter});
  return {runtime, adapter, joined: () => joined};
}

describe('private room runtime native integration', () => {
  test('hosting registers map metadata before native join and opens the local loopback', async () => {
    const {runtime, joined} = privateRuntimeFixture();
    try {
      const id = await runtime.host();
      expect(isPrivateRoomId(id)).toBe(true);
      expect(joined()).toMatchObject({id, row: {id, mapId: 'map', region: 'Private', online: true, untimed: true}});
      const native = roomFixture(privateFixtureHooks());
      expect(native.runtime.clocks(joined().row)).toEqual(Array(4).fill('No time limit'));
      const socket = runtime.roomSocket(id);
      const welcome = await new Promise(resolve => {
        socket.addEventListener('message', event => {
          const message = JSON.parse(event.data);
          if (message.type === 'welcome') resolve(message);
        });
      });
      expect(welcome.state.mapId).toBe('map');
      expect(welcome.player.name).toBe('Guest');
      expect(runtime.ticket(id)).toBe('private-room');
      expect(runtime.measure(id)).toBe(0);
      expect(runtime.mergeRooms([{id: 'public'}]).filter(row => row.id === id)).toHaveLength(1);
      const closed = new Promise(resolve => socket.addEventListener('close', resolve, {once: true}));
      socket.close();
      await closed;
      expect(runtime.mergeRooms([]).find(row => row.id === id).online).toBe(false);
    } finally { runtime.destroy(); }
  });

  test('same-origin peer discovers host metadata before native join without choosing a fallback map', async () => {
    const host = privateRuntimeFixture(), peer = privateRuntimeFixture();
    try {
      const id = await host.runtime.host();
      expect(await peer.runtime.join(id)).toBe(id);
      expect(peer.joined()).toMatchObject({id, row: {mapId: 'map', name: "Guest's private room", online: true, untimed: true}});
      const row = peer.runtime.mergeRooms([]).find(room => room.id === id);
      expect(roomFixture(privateFixtureHooks()).runtime.clocks(row)).toEqual(Array(4).fill('No time limit'));
    } finally { peer.runtime.destroy(); host.runtime.destroy(); }
  });

  test('only explicitly requested rooms appear; unsolicited announcements and global discovery stay private', async () => {
    const {runtime, adapter, joined} = privateRuntimeFixture();
    const signalling = createBroadcastSignalling(), queries = [];
    const requested = 'p-aaaaaaaaaaaa', unrelated = 'p-bbbbbbbbbbbb';
    const announce = (id, name) => signalling.send({
      roomId: id, peerId: 'fixture-host', type: 'room-info',
      payload: {id, name, mapId: 'map', players: 0, capacity: 16, epoch: 1, online: true}
    });
    signalling.subscribe(message => {
      if (message.type !== 'room-query') return;
      queries.push(message.roomId);
      if (message.roomId === requested) {
        announce(unrelated, 'Not invited');
        announce(requested, 'Invited');
      }
    });
    try {
      runtime.attach();
      await runtime.join(requested);
      expect(queries).toEqual([requested]);
      expect(runtime.mergeRooms([]).map(row => row.id)).toEqual([requested]);
      expect(joined().row.name).toBe('Invited');
      const update = adapter.rooms.update;
      const changed = new Promise(resolve => {
        adapter.rooms.update = rows => {
          update(rows);
          if (rows.some(row => row.id === requested && row.name === 'Still known')) resolve();
        };
      });
      announce(unrelated, 'Still not invited');
      announce(requested, 'Still known');
      await changed;
      expect(runtime.mergeRooms([]).map(row => row.id)).toEqual([requested]);
    } finally { runtime.destroy(); signalling.close(); }
  });

  test('native invite metadata becomes known without auto-joining or discovering unrelated rooms', async () => {
    const {runtime, adapter, joined} = privateRuntimeFixture();
    const signalling = createBroadcastSignalling();
    const id = 'p-cccccccccccc';
    const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
    const update = adapter.rooms.update;
    const discovered = new Promise(resolve => {
      adapter.rooms.update = rows => {
        update(rows);
        if (rows.some(row => row.id === id)) resolve();
      };
    });
    signalling.subscribe(message => {
      if (message.type === 'room-query' && message.roomId === id) signalling.send({
        roomId: id, peerId: 'invited-host', type: 'room-info',
        payload: {id, name: 'Invite room', mapId: 'map', players: 0, capacity: 16, epoch: 1}
      });
    });
    try {
      Object.defineProperty(globalThis, 'location', {configurable: true, value: {search: '?join=' + id}});
      runtime.attach();
      if (location) Object.defineProperty(globalThis, 'location', location);
      else delete globalThis.location;
      await discovered;
      expect(runtime.mergeRooms([]).map(row => row.id)).toEqual([id]);
      expect(joined()).toBeNull();
    } finally {
      if (location) Object.defineProperty(globalThis, 'location', location);
      else delete globalThis.location;
      runtime.destroy();
      signalling.close();
    }
  });

  test('public transport is untouched and invalid private entrypoints reject', async () => {
    const {runtime, joined} = privateRuntimeFixture();
    try {
      expect(runtime.ticket('public')).toBeNull();
      expect(runtime.measure('public')).toBeNull();
      expect(runtime.roomSocket('public')).toBeNull();
      expect(runtime.mergeRooms([{id: 'public'}])).toEqual([{id: 'public'}]);
      await expect(runtime.join('public')).rejects.toThrow('Invalid private room');
      expect(joined()).toBeNull();
    } finally { runtime.destroy(); }
  });

  test('missing hooks or current map fail without invoking native join', async () => {
    const unavailable = createPrivateRooms({getAdapter: () => null});
    const {runtime, adapter, joined} = privateRuntimeFixture();
    try {
      await expect(unavailable.host()).rejects.toThrow('unavailable');
      adapter.rooms.currentMap = () => null;
      await expect(runtime.host()).rejects.toThrow('Select a map');
      expect(joined()).toBeNull();
      runtime.destroy();
      await expect(runtime.host()).rejects.toThrow('closed');
    } finally { runtime.destroy(); unavailable.destroy(); }
  });

  test('destroy cancels pending discovery and never invokes native join', async () => {
    const {runtime, joined} = privateRuntimeFixture();
    const pending = runtime.join('p-aaaaaaaaaaaa');
    runtime.destroy();
    await expect(pending).rejects.toThrow('closed');
    expect(joined()).toBeNull();
  });
});
