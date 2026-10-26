import {describe, expect, test} from 'bun:test';
import {instrumentGame} from '../extension/instrument.js';

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
