import {expect, test} from 'bun:test';
import {nativeMapEntryHooks} from '../extension/map-entry-hooks.js';

// The game's online controller, ticket buffer, catalogue and map load, with
// names unrelated to the live bundle's.
const nativeSource = `
const catalog=[{id:"surf_one",version:"v2",boardId:"board-one"},{id:"laboratory",version:"v1",boardId:null}];
class Tickets{constructor(api){this.api=api}api;calls=[];buffered=null;async prefetch(board,user){const key=\`\${user}:\${board.boardId}\`;this.calls.push(key);return this.api.attempt(board.boardId)}invalidate(){}async begin(){return!0}}
class Client{session=null;config={enabled:!0,guestRuns:!0,maps:[{id:"surf_one",boardId:"board-one"}]};attempts=[];attempt(board){this.attempts.push(board);return deps.attempt(board)}guestAttempt(board){this.attempts.push("guest:"+board);return deps.attempt(board)}
board(map){const found=catalog.find(item=>item.id===map.id&&item.version===map.version);return found?this.config.maps.find(item=>item.boardId===found.boardId):void 0}}
function makeOnline(options){const client=options.client??new Client,tickets=new Tickets(client),guests=new Tickets({attempt:board=>client.guestAttempt(board)});
let initialized=!1,failure="",generation=0,owned=Promise.resolve(),phase=null;const store={retained:0};
async function initialize(){initialized=!0}
const loaded=initialize(),controller={ready:loaded,setMap(map){tickets.invalidate(),guests.invalidate()},async beginAttempt(session){const token=++generation,current=()=>token===generation,status=value=>{phase=value};
if(status("preparing"),initialized||await loaded,!current())return;if(client.session){if(await owned,!current())return;if(store.retained>=6){tickets.invalidate(),status("blocked");return}}if(failure){tickets.invalidate(),guests.invalidate(),status("blocked");return}if(!client.config.enabled||!client.session&&!client.config.guestRuns){tickets.invalidate(),guests.invalidate(),status("local");return}const board=client.board(session.map);if(!board||session.practice){tickets.invalidate(),guests.invalidate();return}const guest=!client.session;try{const ok=guest?await guests.begin(session,board,"guest"):await tickets.begin(session,board,client.session.user.id,null);status(ok?"ready":"local")}catch(error){status("blocked")}}};
deps.state={client,tickets,guests,store,set initialized(value){initialized=value},set failure(value){failure=value}};return controller}
const online=makeOnline({client:new Client});
let busy=!1;const available=id=>id!=="closed";
async function loadGeometry(entry,signal){const record=catalog.find(item=>item.id===entry.id),path=record?record.version:entry.id;deps.events.push("geometry");return{id:entry.id}}
async function loadMap(entry,keep=!1,bypass=!1){if(!bypass&&!available(entry.id))throw Error("This map is temporarily unavailable for play.");if(busy)return;busy=!0;deps.events.push("loading");const signal=null;try{const[collision,visual]=await Promise.all([loadGeometry(entry,signal),Promise.resolve()]);online.setMap(collision)}finally{busy=!1}}
`;

function run(source = nativeSource) {
  const deps = {events: [], attempt: async board => { deps.events.push('attempt'); return {id: board}; }};
  const exports = new Function('deps', `${nativeMapEntryHooks(source).source};return {loadMap,online}`)(deps);
  return {deps, ...exports, ...deps.state, state: deps.state};
}

const entry = {id: 'surf_one', slug: 'one', title: 'One'};

test('a signed-in load asks for its ticket before the map loads', async () => {
  const game = run();
  game.client.session = {user: {id: 'user-a'}};
  await game.loadMap(entry);
  expect(game.tickets.calls).toEqual(['user-a:board-one']);
  expect(game.guests.calls).toEqual([]);
  expect(game.deps.events.slice(0, 3)).toEqual(['attempt', 'loading', 'geometry']);
});

test('a guest load asks for a guest ticket only while guest runs are on', async () => {
  const on = run();
  await on.loadMap(entry);
  expect(on.guests.calls).toEqual(['guest:board-one']);
  expect(on.client.attempts).toEqual(['guest:board-one']);
  const off = run();
  off.client.config.guestRuns = false;
  await off.loadMap(entry);
  expect(off.guests.calls).toEqual([]);
  expect(off.client.attempts).toEqual([]);
});

test('no ticket is asked for when beginAttempt would not ask either', async () => {
  const cases = {
    'no board': game => { game.client.config.maps = []; },
    'a practice-only map': () => {},
    'online records off': game => { game.client.config.enabled = false; },
    'online saving unavailable': game => { game.state.failure = 'offline'; },
    'not yet initialized': game => { game.state.initialized = false; },
    'six retained replays': game => { game.client.session = {user: {id: 'user-a'}}; game.store.retained = 6; },
  };
  for (const [name, setup] of Object.entries(cases)) {
    const game = run();
    setup(game);
    await game.loadMap(name === 'a practice-only map' ? {id: 'laboratory'} : entry);
    expect([name, game.client.attempts]).toEqual([name, []]);
  }
});

test('replay loads and loads already in progress ask for nothing', async () => {
  const game = run();
  await game.loadMap(entry, false, true);
  expect(game.client.attempts).toEqual([]);
  const first = game.loadMap(entry), second = game.loadMap(entry);
  await Promise.all([first, second]);
  expect(game.client.attempts).toEqual(['guest:board-one']);
});

test('a failed early request never surfaces from the load', async () => {
  const game = run();
  game.deps.attempt = async () => { throw new Error('offline'); };
  await game.loadMap(entry);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(game.client.attempts).toEqual(['guest:board-one']);
});

test('the start of a solo, practice or room load is reported, after its ticket is asked for', async () => {
  const previous = globalThis.__SURFD_QOL__, game = run();
  globalThis.__SURFD_QOL__ = {mapLoadStarted(map) { game.deps.events.push(`started ${map.id}`); }};
  try {
    await game.loadMap(entry);
    await game.loadMap(entry, false, true);
    expect(game.deps.events.slice(0, 3)).toEqual(['attempt', 'started surf_one', 'loading']);
    expect(game.deps.events.filter(event => event.startsWith('started'))).toEqual(['started surf_one']);
  } finally {
    globalThis.__SURFD_QOL__ = previous;
  }
  expect(nativeMapEntryHooks(nativeSource).controller).toBe('online');
});

test('an unfamiliar online controller keeps only the load report; an unfamiliar map load changes nothing', () => {
  for (const [from, to] of [['initialized||await loaded', 'await loaded'], ['catalog.find(item=>item.id===entry.id)', 'catalog.find(item=>item.slug===entry.slug)'],
    ['async prefetch(board,user){', 'async prefetch(user,board){']]) {
    const hooked = nativeMapEntryHooks(nativeSource.replace(from, to));
    expect([from, hooked.controller, hooked.source.includes('__qolPrefetchRun'), hooked.source.includes('mapLoadStarted')]).toEqual([from, null, false, true]);
  }
  const source = nativeSource.replace('if(busy)return;', 'if(busy){return}');
  expect(nativeMapEntryHooks(source)).toEqual({source, controller: null});
});
