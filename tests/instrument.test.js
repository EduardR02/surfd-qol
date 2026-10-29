import {describe, expect, test} from 'bun:test';
import {ADAPTER_MARKER, ROOM_CHUNKS, ROOM_MESSAGE_CHARS, instrumentGame, isCurrentInstrumented} from '../extension/instrument.js';
import {MAX_ROOM_CHUNKS, MAX_ROOM_MESSAGE_CHARS} from '../src/private-rooms/protocol.js';

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
const client={session:{user:{id:'account-a'}},listeners:new Set(),onChange(listener){client.listeners.add(listener);return()=>client.listeners.delete(listener)},config:{maps:[{id:'map',slug:'test-map'}]},
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

// Native social presence arrives from the server; the client only posts menu/solo.
// Both the friend/profile Join actions and accepted notifications use these callbacks.
const nativeSocialSource = `
const officialNames={eu:{name:"Surfd EU"}},roomLabel=id=>officialNames[id]?.name??"Surfd "+id.toUpperCase();
let nativeRoomId=null,joinedState=false,menuKey="",wasJoined=false,wasVisible=false;
const nativeMenu={hidden:false},nativeLoading={isOpen:()=>false},nativeBackdrop={setActive(){}};
const nativePresence=[],nativeInvites=[],nativeToasts=[],nativeReplies=[],nativeQueries=[],nativeJoins=[];
const friendStore={entries:[],friends(){return this.entries},setPresence(value){nativePresence.push(value)},
  invite(userId,roomId){nativeInvites.push({userId,roomId})}};
class NativeNotifications {
  noteOf(note){const name=officialNames[note.roomId??"eu"]?.name??"Surfd EU",text=note.kind==="invite"?"invited you to "+name+".":"";return {...note,text}}
}
const roomController={roomId:()=>nativeRoomId,connected:()=>!!nativeRoomId};
const roomDisplay={connected:()=>!!nativeRoomId,title:()=> "Duplicate title"};
const nativeRows={rows:()=>lobby.servers.rows(),mapTitle:row=>row.mapTitle};
const friendWindows={close(){}},nativeOptions={toast:message=>nativeToasts.push(message),currentMap:()=> "map"};
function officialFriendJoin(id){nativeJoins.push(id);return fetch('/friend-ticket/'+id)}
function friendPresence(userId){const friend=friendStore.friends().find(item=>item.userId===userId);if(!friend)return null;const presence=friend.presence;return presence.kind==="server"?\`Playing on \${nativeRows.rows().find(item=>item.id===presence.roomId)?.name??roomLabel(presence.roomId)}\`:null}
const friendCallbacks={
  join:id=>{friendWindows.close(!1),officialFriendJoin(id)},
  invite:friend=>{const id=roomDisplay.connected()?nativeRows.rows().find(row=>row.name===roomDisplay.title())?.id:null;if(!id){nativeOptions.toast("Join a server first, then invite friends to it.");return}friendStore.invite(friend.userId,id),nativeOptions.toast("Invited "+friend.name)},
  myRoom:()=>roomDisplay.connected()?nativeRows.rows().find(row=>row.name===roomDisplay.title())?.id??null:null,
  roomName:id=>nativeRows.rows().find(row=>row.id===id)?.name??roomLabel(id),
  roomMap:id=>{const row=nativeRows.rows().find(entry=>entry.id===id);return row?nativeRows.mapTitle(row):"connecting"}
};
const profileCallbacks={join:id=>{friendWindows.close(!1),officialFriendJoin(id)}};
function acceptNativeInvite(note){friendCallbacks.join(note.roomId)}
function nativeSync(value){const key=\`\${value.joined}|\${value.visible}|\${value.roomId}|\${nativeLoading.isOpen()}\`;if(key===menuKey)return;const previousJoined=wasJoined,previousVisible=wasVisible;menuKey=key,wasJoined=value.joined,wasVisible=value.visible,nativeBackdrop.setActive(value.visible&&!value.joined&&!nativeLoading.isOpen());const map=nativeOptions.currentMap();friendStore.setPresence(value.joined&&value.roomId?null:value.joined&&map?{kind:"solo",mapId:map}:{kind:"menu"})}
function nativeFrame(){lobby.sync({joined:joinedState,visible:!nativeMenu.hidden,roomId:roomController?.roomId()??null})}
let chatRoom=null;
function localReply(text){nativeReplies.push(text)}
function nativeCommand(text){const[token,...parts]=text.trim().split(/\\s+/),argument=parts.join(" "),command=token.replace(/^[!/]/,"").toLowerCase();if(command==="played"){if(chatRoom?.status==="connected"&&!chatRoom.playtime){localReply("Playtime unavailable");return}nativeQueries.push(command);return}if(command==="vote"){localReply("Use /vote followed by one of the displayed numbers.");return}if(command==="help"){localReply("Official help");return}localReply("Unknown command")}
`;

// The fixture intentionally preserves only semantic/minified signatures, not
// any live private name. Its network spies make unintended private traffic fail.
const roomSource = nativeSource + `
const catalog=[{id:'map',title:'Fixture map'}],ranking={refresh(){}},options={currentMap:()=> 'map'};
let joined=null,listed=[{id:'public',mapId:'map',online:true}],joinCallback,refreshCallback;
const nativeToast={textContent:'',classList:{add(){}}};let toastExpiry=0;
const toastNode=id=>nativeToast;
function toast(text){toastNode("toast").textContent=text,toastNode("toast").classList.add("show"),toastExpiry=performance.now()+5e3}
const secondsLeft=(end,now)=>Math.max(0,Math.ceil((end-now)/1000));
function countdown(end,now){const seconds=secondsLeft(end,now);return seconds===0?"Changing map…":seconds+"s left"}
function clocks(row){const connection={state:row},offset=0;return [
  countdown(row.endsAt,Date.now()),countdown(row.endsAt,Date.now()),
  countdown(connection.state.endsAt,Date.now()+offset),countdown(row.endsAt,Date.now()+offset)
]}
function nativeBrowser(options){let entries=[],status="Checking servers…",selection=null;
  const eligible=row=>row.online&&!row.preview&&row.players<row.capacity;
  const ping=row=>row.ping, mapTitle=row=>row.mapTitle, all=()=>entries;
  const recommended=()=>entries.filter(eligible)[0]??null;
  let region="all",hideFull=false,hideEmpty=false,order="ping";
  const nodes=()=>[],regionNodes={},comparators={ping:(a,b)=>(ping(a)??9999)-(ping(b)??9999)};
  function visible(){let rows=all().filter(row=>(region==="all"||row.region===region)&&(!hideFull||row.players<row.capacity)&&(!hideEmpty||row.players>0));
    return rows=rows.sort((a,b)=>Number(b.online)-Number(a.online)||comparators[order](a,b)),rows}
  function groups(){return [...new Set(entries.map(row=>row.region))].map(key=>[key,visible().filter(row=>row.region===key)]).filter(([,rows])=>rows.length).sort((a,b)=>(ping(a[1][0])??9999)-(ping(b[1][0])??9999))}
  function render(){const regions=[...new Set(entries.map(row=>row.region))];regionNodes.hidden=regions.length<2,regionNodes.innerHTML=regions.length<2?"":"tabs";for(const node of nodes("[data-region]",regionNodes))node.onclick=()=>{region=node.dataset.region,render()}}
  let browserTimer;
  const view={el:{hidden:true},open(value){typeof value=="string"&&(selection=value);options.refresh()},close(){clearInterval(browserTimer)}};
  return{view:view,update(rows,note){const now=Date.now();entries=rows.map(row=>({...row,...row.endsAt===undefined?{}:{endsAt:row.endsAt+(row.serverTime===undefined?0:now-row.serverTime)}}));status=note},
    rows:()=>entries,best:recommended,visible,groups,filters(full,empty){hideFull=full;hideEmpty=empty},region(value){region=value},mapTitle:mapTitle}}
function lobbyFactory(){const servers=nativeBrowser({refresh:()=>{}});return {
  servers,sync:nativeSync,selected:()=>catalog[0],tab(value){this.tabbed=value},
  updateServers(rows,status){servers.update(rows,status);listed=servers.rows()},
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
  receive(data){if(data==="pong")return;if(typeof data!="string"||data.length>65536)throw Error("Invalid room data");const message=JSON.parse(data);this.message=message}
  disconnect(){this.watchTarget=null;this.roomId=null}
}
let connection=null,active=null;
const account={opened:0,openAccount(){account.opened++}},roomOptions={onSignIn:()=>account.openAccount()};
const social={available:true,block(){},isBlocked:()=>false},menuActions={opened:null,profile(id,name){menuActions.opened={id,name}}};
function playerMenu(_){return \`\${!_.guest&&social.available&&social.block?\`<button data-act="block">Block</button>\`:""}\`}
function playerAction(H,_){H==="profile"&&menuActions.profile(_.id,_.name)}
function leaveRoom(){connection?.disconnect(),active=null,connection=null}
const document={body:{lastElementChild:null,append(node){document.body.lastElementChild=node}},createElement:tag=>({tag,className:""})};
function mapChangeDialog(n){const e=document.createElement("dialog");e.className="nominate-window map-change-window",document.body.append(e);return{open(){e.opened=n.state()},state(m){e.state=m},error(){},close(){e.closed=!0}}}
let activeRoom=null,soloResets=0;
function resetSolo(){soloResets++}
const gameActions={leave:()=>{activeRoom?.roomId()&&activeRoom.leave(),resetSolo()},room:()=>activeRoom?.roomView??null};
function serverMenu(e,o){if(e.hidden=!1,o){e.innerHTML=\`\${o.guest()?'<button type="button" class="btn" data-act="signin" title="Sign in to chat">Sign in to chat</button>':'<button type="button" class="btn" data-act="chat">Chat</button>'}\`}return e.innerHTML}
function serverMenuAction(u,o){u.onclick=()=>{const h=u.dataset.act;if(h==="chat"&&o.openChat(),h==="rtv"&&o.rtv(),0)return};u.onclick()}
` + nativeSocialSource;

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
      guest:()=>{client.session=null},browser:lobby.servers,leave:room=>{connection=room;leaveRoom()},
      native:{friends:friendCallbacks,profile:profileCallbacks,presence:friendPresence,accept:acceptNativeInvite,
        notes:new NativeNotifications(),friendStore,nativePresence,nativeInvites,nativeToasts,nativeReplies,nativeQueries,nativeJoins,
        command:nativeCommand,setRoom:id=>{nativeRoomId=id;joinedState=!!id;chatRoom=id?{roomId:id,status:"connected",playtime:true}:null},
        menu:open=>{nativeMenu.hidden=!open;nativeFrame()},frame:nativeFrame,label:roomLabel},
      ui:{serverMenu,serverMenuAction,page:document,lobby,enter:room=>{activeRoom=room},soloResets:()=>soloResets},
      playerMenu,playerAction,menuActions,account,signOut:()=>{client.session=null;for(const listener of client.listeners)listener()}};
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

  test('private room players get View profile by account id and no Block', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    expect(runtime.playerMenu({id: 'private-1', guest: false})).toBe('');
    expect(runtime.playerMenu({id: 'account-1', guest: false})).toContain('Block');
    runtime.playerAction('profile', {id: 'private-1', userId: 'account-1', name: 'Surfer'});
    expect(runtime.menuActions.opened).toEqual({id: 'account-1', name: 'Surfer'});
    runtime.playerAction('profile', {id: 'account-2', name: 'Official'});
    expect(runtime.menuActions.opened).toEqual({id: 'account-2', name: 'Official'});
  });

  test('account changes reach room listeners until they unsubscribe', () => {
    const {adapter, runtime} = roomFixture(privateFixtureHooks());
    const changes = [];
    const stop = adapter.rooms.onAccountChange(() => changes.push(adapter.rooms.guest()));
    runtime.signOut();
    stop();
    runtime.signOut();
    expect(changes).toEqual([true]);
  });

  test('the room hook never receives the site ticket', async () => {
    const calls = [], hooks = privateFixtureHooks();
    hooks.roomSocket = (...args) => { calls.push(args); return null; };
    const fixture = roomFixture(hooks);
    await fixture.runtime.room.open('public');
    expect(calls).toEqual([['public']]);
    expect(fixture.sockets[0].protocols).toEqual(['surfd-v1', 'native-ticket']);
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
    expect(adapter.rooms.userId()).toBe('account-a');
    runtime.guest();
    expect(adapter.rooms.guest()).toBe(true);
    expect(adapter.rooms.userId()).toBeNull();
    adapter.rooms.signIn();
    expect(runtime.account.opened).toBe(1);
    expect(adapter.rooms.maps()).toEqual([{id: 'map', title: 'Fixture map'}]);
    expect(adapter.rooms.currentMap()).toBe(adapter.getSession().map);
  });

  test('the host’s room UI reuses the game’s map dialog, Leave, map change, status line and browser', () => {
    const {adapter, runtime, warnings} = roomFixture(privateFixtureHooks());
    expect(warnings).toEqual([]);
    const picker = adapter.rooms.mapPicker({state: () => ({mapId: null, epoch: 1})});
    expect(picker.dialog).toBe(runtime.ui.page.body.lastElementChild);
    expect(picker.dialog.className).toBe('nominate-window map-change-window');
    picker.open();
    expect(picker.dialog.opened).toEqual({mapId: null, epoch: 1});
    const calls = [];
    runtime.ui.enter({roomId: () => 'p-aaaaaaaaaaaa', leave: () => calls.push('leave'), roomView: {changeMap: () => calls.push('change')}});
    adapter.rooms.changeMap();
    adapter.rooms.leaveRoom();
    expect(calls).toEqual(['change', 'leave']);
    expect(runtime.ui.soloResets()).toBe(1);
    adapter.rooms.openBrowser();
    expect(runtime.ui.lobby.tabbed).toBe('servers');
    runtime.browser.update([{id: 'eu', endsAt: 1000, serverTime: Date.now()}], 'Ready');
    adapter.rooms.setStatus('This private room has closed.');
    expect(adapter.rooms.status()).toBe('This private room has closed.');
    expect(adapter.rooms.rows().map(row => row.id)).toEqual(['eu']);
  });

  test('only the host in its own room gets Your room in the room menu', () => {
    const hooks = privateFixtureHooks(), opened = [];
    let own = false;
    hooks.ownRoom = () => own;
    hooks.openRoom = () => opened.push('room');
    const {runtime} = roomFixture(hooks);
    const menu = {}, room = {guest: () => false, openChat: () => opened.push('chat')};
    expect(runtime.ui.serverMenu(menu, room)).not.toContain('qol-room');
    own = true;
    expect(runtime.ui.serverMenu(menu, room)).toStartWith('<button type="button" class="btn" data-act="qol-room">Your room</button><button type="button" class="btn" data-act="chat">');
    runtime.ui.serverMenuAction({dataset: {act: 'qol-room'}}, room);
    runtime.ui.serverMenuAction({dataset: {act: 'chat'}}, room);
    expect(opened).toEqual(['room', 'chat']);
    expect(roomFixture(undefined).runtime.ui.serverMenu({}, room)).not.toContain('qol-room');
  });

  test('a missing room UI hook warns on its own and leaves the others', () => {
    const source = roomSource.replace('className="nominate-window map-change-window"', () => 'className="map-change-window"');
    const {adapter, warnings} = roomFixture(privateFixtureHooks(), source);
    expect(warnings.map(args => args[0])).toEqual(['[Surfd QoL] Room map choice unavailable:']);
    expect(adapter.rooms.mapPicker).toBeUndefined();
    expect(adapter.rooms.leaveRoom).toBeFunction();
    expect(adapter.rooms.join).toBeFunction();
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

  test('old adapters require fresh source', () => {
    expect(isCurrentInstrumented(instrumentGame(nativeSource))).toBe(true);
    expect(() => instrumentGame(nativeSource + '\n/* surfd-qol-adapter-v6: stale */')).toThrow('Stale');
  });

  test('community never wins official recommendation', () => {
    const {adapter, runtime} = roomFixture(privateFixtureHooks());
    adapter.rooms.update([
      {id:'p-aaaaaaaaaaaa',region:'Public',players:300,capacity:1000,online:true,ping:1},
      {id:'eu',region:'Europe',players:2,capacity:64,online:true,ping:90},
      {id:'p-bbbbbbbbbbbb',region:'Private',players:0,online:true}
    ]);
    expect(runtime.browser.best().id).toBe('eu');
    runtime.browser.filters(true,true);
    expect(runtime.browser.visible().map(row=>row.id)).toEqual(['eu','p-aaaaaaaaaaaa']);
    expect(runtime.browser.groups().map(([region])=>region)).toEqual(['Europe','Community']);
    runtime.browser.region('Community');
    expect(runtime.browser.visible().map(row=>row.id)).toEqual(['p-aaaaaaaaaaaa']);
    runtime.browser.filters(true,false);
    expect(runtime.browser.visible().map(row=>row.id)).toEqual(['p-aaaaaaaaaaaa','p-bbbbbbbbbbbb']);
  });

  test('community rows with the room capacity keep their place in Play now, Hide full and the order', () => {
    const {adapter, runtime} = roomFixture(privateFixtureHooks());
    adapter.rooms.update([
      {id:'p-aaaaaaaaaaaa',region:'Public',players:256,capacity:256,online:true,ping:1},
      {id:'eu',region:'Europe',players:64,capacity:64,online:true,ping:90},
      {id:'na',region:'North America',players:3,capacity:64,online:true,ping:120},
      {id:'p-bbbbbbbbbbbb',region:'Private',players:2,capacity:256,online:true,ping:2}
    ]);
    expect(runtime.browser.best().id).toBe('na');
    expect(runtime.browser.visible().map(row=>row.id)).toEqual(['eu','na','p-aaaaaaaaaaaa','p-bbbbbbbbbbbb']);
    runtime.browser.filters(true,false);
    expect(runtime.browser.visible().map(row=>row.id)).toEqual(['na','p-aaaaaaaaaaaa','p-bbbbbbbbbbbb']);
    expect(runtime.browser.groups().map(([region])=>region)).toEqual(['North America','Community']);
  });

  test('identifiers containing $ survive instrumentation', () => {
    const source = roomSource.replaceAll(/(?<!\.)\bstatus\b/g, () => 's$1')
      .replace('receive(data){if(data==="pong")return;if(typeof data!="string"||data.length>65536)throw Error("Invalid room data");const message=JSON.parse(data);this.message=message}',
        () => 'receive(d$1){if(d$1==="pong")return;if(typeof d$1!="string"||d$1.length>65536)throw Error("Invalid room data");const m$$=JSON.parse(d$1);this.message=m$$}');
    const {adapter, runtime, warnings} = roomFixture(privateFixtureHooks(), source);
    expect(warnings).toEqual([]);
    runtime.browser.update([], 'Offline; try again.');
    expect(adapter.rooms.status()).toBe('Offline; try again.');
    runtime.room.roomId = 'p-aaaaaaaaaaaa';
    runtime.room.receive(JSON.stringify({type: 'roster', players: []}));
    expect(runtime.room.message).toEqual({type: 'roster', players: []});
  });

  test('row updates preserve clocks and status', () => {
    const {adapter,runtime} = roomFixture(privateFixtureHooks());
    runtime.browser.update([{id:'eu',endsAt:1000,serverTime:Date.now()-5000}], 'Offline; try again.');
    const end = adapter.rooms.rows()[0].endsAt;
    adapter.rooms.update(adapter.rooms.rows());
    adapter.rooms.update(adapter.rooms.rows());
    expect(adapter.rooms.rows()[0].endsAt).toBe(end);
    expect(adapter.rooms.status()).toBe('Offline; try again.');
    expect(adapter.rooms.rows()[0].serverTime).toBeUndefined();
    expect(adapter.rooms.browserOpen()).toBe(false);
    runtime.browser.view.el.hidden=false;
    expect(adapter.rooms.browserOpen()).toBe(true);
    adapter.rooms.select('p-aaaaaaaaaaaa');
    expect(adapter.rooms.selected()).toBe('p-aaaaaaaaaaaa');
  });

  test('private chunks deliver complete large rosters', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    const room=runtime.room;
    room.roomId='p-aaaaaaaaaaaa';
    const message={type:'roster',players:Array.from({length:2000},(_,slot)=>({slot,name:'Surfer '+slot,connectionId:'connection-'+slot}))};
    const json=JSON.stringify(message);
    expect(json.length).toBeGreaterThan(65536);
    for(let index=0;index<json.length;index+=8000)room.receive(JSON.stringify({type:'room-chunk',data:json.slice(index,index+8000),final:index+8000>=json.length}));
    expect(room.message).toEqual(message);
    expect(()=>room.receive(json)).toThrow('Invalid room data');
    room.receive(JSON.stringify({type:'room-chunk',data:'unfinished',final:false}));
    room.disconnect();
    expect(room.__qolChunks).toBeNull();
  });

  test('endless non-final chunks are bounded and a rejected stream releases its fragments', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    const room = runtime.room;
    room.roomId = 'p-aaaaaaaaaaaa';
    const fragment = JSON.stringify({type: 'room-chunk', data: '', final: false});
    for (let index = 0; index < ROOM_CHUNKS; index++) room.receive(fragment);
    expect(() => room.receive(fragment)).toThrow('Invalid room chunk');
    expect(room.message).toBeUndefined();
    room.receive(JSON.stringify({type: 'room-chunk', data: '{"type":"roster","players":[]}', final: true}));
    expect(room.message).toEqual({type: 'roster', players: []});
  });

  test('the game hook bounds chunks like the room protocol', () => {
    expect(ROOM_MESSAGE_CHARS).toBe(MAX_ROOM_MESSAGE_CHARS);
    expect(ROOM_CHUNKS).toBe(MAX_ROOM_CHUNKS);
  });

  test('chunk bytes are bounded independently of frame count', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    const room = runtime.room;
    room.roomId = 'p-aaaaaaaaaaaa';
    const fragment = JSON.stringify({type: 'room-chunk', data: 'x'.repeat(65000), final: false});
    expect(fragment.length).toBeLessThan(65536);
    for (let index = 0; index < Math.floor(ROOM_MESSAGE_CHARS / 65000); index++) room.receive(fragment);
    expect(() => room.receive(fragment)).toThrow('Invalid room chunk');
    room.receive(JSON.stringify({type: 'roster', players: []}));
    expect(room.message).toEqual({type: 'roster', players: []});
  });

  test('invalid, nested and interrupted chunks cannot contaminate a later message', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    const room = runtime.room;
    room.roomId = 'p-aaaaaaaaaaaa';
    const unfinished = JSON.stringify({type: 'room-chunk', data: '{"type":', final: false});
    const complete = JSON.stringify({type: 'roster', players: []});
    for (const invalid of [
      {type: 'room-chunk', data: 1, final: false},
      {type: 'room-chunk', data: '', final: null},
      {type: 'roster', players: []},
    ]) {
      room.receive(unfinished);
      expect(() => room.receive(JSON.stringify(invalid))).toThrow('Invalid room chunk');
      room.receive(complete);
      expect(room.message).toEqual({type: 'roster', players: []});
    }
    expect(() => room.receive(JSON.stringify({type: 'room-chunk', data: unfinished, final: true}))).toThrow('Invalid room chunk');
    room.receive(complete);
    expect(room.message).toEqual({type: 'roster', players: []});
  });

  test('late optional mismatches roll back every room hook without disabling other QoL', async () => {
    for (const [before, after] of [
      ['disconnect(){this.watchTarget=null', 'disconnect(){this.other=null;this.watchTarget=null'],
      ['if(data==="pong")', 'if("pong"===data)'],
      ['data.length>65536', 'data.length>65535'],
    ]) {
      const left = [];
      const fixture = roomFixture({...privateFixtureHooks(), leave: id => left.push(id)}, roomSource.replace(before, after));
      expect(fixture.adapter.rooms).toBeUndefined();
      expect(fixture.warnings).toHaveLength(1);
      expect(fixture.adapter.getSession()).toBeInstanceOf(fixture.adapter.Session);
      expect(fixture.adapter.practice.destination().mapId).toBe('map');
      const token = fixture.adapter.replay.reserve();
      expect(fixture.adapter.replay.isCurrent(token)).toBe(true);
      await fixture.runtime.room.open('public');
      await fixture.runtime.room.measure('public');
      expect(fixture.requests.some(request => request.url === '/room-ticket')).toBe(true);
      expect(fixture.requests.some(request => request.url.endsWith('/servers/public/ping'))).toBe(true);
      fixture.runtime.leave(fixture.runtime.room);
      expect(left).toEqual([]);
    }
  });

  test('community measurements never refresh the directory or call native endpoints', async () => {
    const refreshes = [], hooks = privateFixtureHooks();
    hooks.row.id = 'p-aaaaaaaaaaaa';
    hooks.refreshDirectory = options => refreshes.push(options);
    const fixture = roomFixture(hooks);
    expect(await fixture.runtime.room.measure(hooks.row.id)).toBe(0);
    expect(refreshes).toEqual([]);
    expect(fixture.requests).toEqual([]);
    fixture.adapter.rooms.refresh();
    expect(refreshes).toEqual([{open: false}]);
    fixture.runtime.browser.view.el.hidden = false;
    fixture.runtime.browser.view.open(hooks.row.id);
    expect(refreshes).toEqual([{open: false}, {open: true}]);
  });

  test('an unknown community ping remains unknown without a native fallback request', async () => {
    const hooks = privateFixtureHooks();
    hooks.measure = () => Promise.resolve(null);
    const fixture = roomFixture(hooks);
    expect(await fixture.runtime.room.measure('p-aaaaaaaaaaaa')).toBeNull();
    expect(fixture.requests).toEqual([]);
  });

  test('an official socket retains the native raw message limit', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    runtime.room.roomId = 'eu';
    const message = JSON.stringify({type: 'roster', players: [], padding: ' '.repeat(65536)});
    expect(() => runtime.room.receive(message)).toThrow('Invalid room data');
  });

  test('explicit leave notifies runtime', () => {
    const left=[],hooks={...privateFixtureHooks(),leave:id=>left.push(id)};
    const {runtime}=roomFixture(hooks);
    runtime.room.roomId='p-aaaaaaaaaaaa';
    runtime.leave(runtime.room);
    expect(left).toEqual(['p-aaaaaaaaaaaa']);
    expect(runtime.room.roomId).toBeNull();
  });
});

describe('native community behavior integration', () => {
  const communityId = 'p-aaaaaaaaaaaa';
  const publicId = 'p-bbbbbbbbbbbb';
  const rows = [
    {id: communityId, name: "Secret's room", visibility: 'private', mapId: 'map', mapTitle: 'Fixture map'},
    {id: publicId, name: "Public's room", visibility: 'public', mapId: 'map', mapTitle: 'Public map'},
    {id: 'eu', name: 'Surfd EU', mapId: 'map', mapTitle: 'Official map'}
  ];
  const socialHooks = extra => ({
    ...privateFixtureHooks(), menuVisibility() {}, refreshDirectory() {},
    roomInfo: id => rows.find(row => row.id === id) ?? null,
    ...extra
  });

  test('friend, profile and accepted invite joins route community IDs without official requests', async () => {
    const joins = [], fixture = roomFixture(socialHooks({join: id => { joins.push(id); }}));
    const native = fixture.runtime.native;
    await native.friends.join(communityId);
    await native.profile.join(publicId);
    native.accept({roomId: communityId});
    expect(joins).toEqual([communityId, publicId, communityId]);
    expect(fixture.requests).toEqual([]);
    expect(native.nativeJoins).toEqual([]);
    await native.friends.join('eu');
    expect(native.nativeJoins).toEqual(['eu']);
    expect(fixture.requests.map(request => request.url)).toEqual(['/friend-ticket/eu']);
    expect(fixture.warnings).toEqual([]);
  });

  test('failed community joins report once per native action without escaping accepted invites', async () => {
    const closed = 'This private room has closed.';
    for (const join of [() => Promise.reject(new Error(closed)), () => { throw new Error(closed); }]) {
      const fixture = roomFixture(socialHooks({join})), native = fixture.runtime.native;
      await native.friends.join(communityId);
      await native.profile.join(communityId);
      native.accept({roomId: communityId});
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(native.nativeToasts).toEqual([closed, closed, closed]);
      expect(fixture.requests).toEqual([]);
      expect(native.nativeJoins).toEqual([]);
    }
  });

  test('missing runtime never falls back to official friend tickets for community IDs', () => {
    const fixture = roomFixture(undefined);
    fixture.runtime.native.friends.join(communityId);
    fixture.runtime.native.profile.join(communityId);
    fixture.runtime.native.accept({roomId: communityId});
    expect(fixture.requests).toEqual([]);
  });

  test('native friend and profile status never displays private codes or private room names', () => {
    const fixture = roomFixture(socialHooks());
    fixture.runtime.browser.update(rows, 'Ready');
    const native = fixture.runtime.native;
    native.friendStore.entries = rows.map(row => ({userId: row.id, presence: {kind: 'server', roomId: row.id}}));
    expect(native.friends.roomName(communityId)).toBe('Private room');
    expect(native.friends.roomMap(communityId)).toBe('Fixture map');
    expect(native.presence(communityId)).toBe('Playing on Private room · Fixture map');
    expect(native.label(communityId)).toBe('Private room');
    expect(native.notes.noteOf({kind: 'invite', roomId: communityId}).text).toBe('invited you to Private room.');
    expect(native.friends.roomName(publicId)).toBe("Public's room");
    expect(native.presence(publicId)).toBe("Playing on Public's room · Public map");
    expect(native.friends.roomName('eu')).toBe('Surfd EU');
    expect(native.presence('eu')).toBe('Playing on Surfd EU');
    expect(native.friends.roomName('p-cccccccccccc')).toBe('Private room');
    expect(native.friends.roomMap('p-cccccccccccc')).toBe('connecting');
  });

  test('only explicit native invitation sends the private ID and does not claim delivery', () => {
    const fixture = roomFixture(socialHooks());
    fixture.runtime.browser.update(rows, 'Ready');
    const native = fixture.runtime.native;
    native.setRoom(communityId);
    expect(native.friends.myRoom()).toBeNull();
    expect(native.nativeInvites).toEqual([]);
    native.friends.invite({userId: 'friend', name: 'Friend'});
    expect(native.nativeInvites).toEqual([{userId: 'friend', roomId: communityId}]);
    expect(native.nativeToasts).toEqual([]);
    native.setRoom(publicId);
    expect(native.friends.myRoom()).toBe(publicId);
    native.setRoom('eu');
    native.friends.invite({userId: 'friend', name: 'Friend'});
    expect(native.nativeInvites.at(-1)).toEqual({userId: 'friend', roomId: 'eu'});
    expect(native.nativeToasts).toEqual(['Invited Friend']);
  });

  test('preserves server-controlled presence instead of publishing private IDs', () => {
    const {runtime} = roomFixture(socialHooks());
    runtime.native.frame();
    runtime.native.setRoom(communityId);
    runtime.native.frame();
    runtime.native.setRoom('eu');
    runtime.native.frame();
    expect(runtime.native.nativePresence).toEqual([{kind: 'menu'}, null, null]);
  });

  test('menu transitions notify once and the adapter reports actual visibility', async () => {
    const transitions = [], refreshes = [];
    const fixture = roomFixture(socialHooks({
      menuVisibility: open => transitions.push(open),
      refreshDirectory: options => refreshes.push(options)
    }));
    expect(fixture.adapter.rooms.menuOpen()).toBe(true);
    expect(fixture.adapter.rooms.browserOpen()).toBe(false);
    await fixture.runtime.room.list();
    expect(refreshes).toEqual([undefined]);
    fixture.runtime.native.frame();
    fixture.runtime.native.frame();
    fixture.runtime.native.menu(false);
    fixture.runtime.native.frame();
    expect(fixture.adapter.rooms.menuOpen()).toBe(false);
    fixture.runtime.native.setRoom(communityId);
    fixture.runtime.native.frame();
    expect(transitions).toEqual([true, false]);
    fixture.runtime.native.menu(true);
    expect(transitions).toEqual([true, false, true]);
  });

  test('browser visibility follows native open and post-close visibility without observers', async () => {
    const visibility = [], fixture = roomFixture(socialHooks({browserVisibility: open => visibility.push(open)}));
    const view = fixture.runtime.browser.view;
    view.el.hidden = false;
    view.open();
    expect(visibility).toEqual([true]);
    view.close();
    view.el.hidden = true;
    expect(visibility).toEqual([true]);
    await Promise.resolve();
    expect(visibility).toEqual([true, false]);
    view.el.hidden = false;
    view.open();
    view.close();
    view.el.hidden = true;
    view.el.hidden = false;
    view.open();
    await Promise.resolve();
    expect(visibility.at(-1)).toBe(true);
  });

  test('community command replies use native local chat; unhandled and official commands stay native', () => {
    const commands = [], fixture = roomFixture(socialHooks({
      commandReply: (command, id) => { commands.push({command, id}); return command === '/help' ? 'Community help' : null; }
    }));
    const native = fixture.runtime.native;
    native.setRoom(communityId);
    native.command('/help');
    native.command('/vote');
    native.command('/played');
    expect(native.nativeReplies).toEqual(['Community help', 'Use /vote followed by one of the displayed numbers.']);
    expect(native.nativeQueries).toEqual(['played']);
    expect(commands).toEqual(['/help', '/vote', '/played'].map(command => ({command, id: communityId})));
    native.setRoom('eu');
    native.command('/help');
    native.setRoom(null);
    native.command('/help');
    expect(commands).toHaveLength(3);
    expect(native.nativeReplies.slice(-2)).toEqual(['Official help', 'Official help']);
  });
});
