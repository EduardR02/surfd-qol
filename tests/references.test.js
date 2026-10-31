import {describe, test, expect} from 'bun:test';
import {createCheckpointReferences, reconstructCheckpointSpeeds, reconstructRecordRoute, referenceIdentity, sessionKey} from '../src/references.js';
import {formatTime, formatDelta, formatSplitDelta, startTone, referenceTone} from '../src/hud-model.js';

const makeSession = () => ({map:{id:'surf_test',version:'map-1'},config:{version:'physics-1',dt:.015},replayFormat:8,state:{tick:0},timer:{state:{phase:'ready',startTick:null,elapsed:0,splits:[],invalidReason:null}},checkpointSpeeds:[],practice:false});
const entry = {runId:'old-pb',timeUs:10000000,splitsUs:[5000000,8000000]};
function replayFor(session, speeds = [900,1200], finish = {}) {
  return {mapId:session.map.id,mapVersion:session.map.version,config:session.config,format:7,commands:[{speed:speeds[0]},{speed:speeds[1],finish:true,...finish}]};
}
// Stands in for the game's Session class. Reconstruction runs the class it is
// given, so results follow the game's own physics; the real Session only exists in the game.
class ReplaySession {
  constructor(map, config, format) {
    this.checkpointSpeeds = [];
    this.timer = {state:{phase:'ready',elapsed:0,splits:[]}};
  }
  loadReplay(replay) { this.loaded = replay; }
  step(command) {
    if (command.fall) return ['fall'];
    this.checkpointSpeeds.push(command.speed);
    if (command.finish) this.timer.state = {phase:'finished',elapsed:command.elapsed ?? 10,splits:command.splits ?? [5,8]};
    return [];
  }
}
function memoryStorage() {
  const values = new Map();
  return {getItem:key => values.get(key) ?? null,setItem:(key,value) => values.set(key,value)};
}
const microtasks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const instantYield = async () => {};
function finish(session, time, speeds) {
  session.state.tick += 20;
  session.checkpointSpeeds.push(...speeds);
  session.timer.state = {phase:'finished',startTick:0,elapsed:time,splits:[time / 2,time * .8],invalidReason:null};
}
function restart(session) {
  session.state.tick = 0;
  session.checkpointSpeeds = [];
  session.timer.state = {phase:'ready',startTick:null,elapsed:0,splits:[],invalidReason:null};
}

describe('replay reference boundary', () => {
  test('rejects mismatched map, config, completion time and checkpoint splits', async () => {
    const session = makeSession();
    for (const replay of [{...replayFor(session),mapVersion:'other'},{...replayFor(session),config:{version:'other'}}]) {
      expect(await reconstructCheckpointSpeeds({Session:ReplaySession,session,replay,entry,yieldTask:instantYield})).toBeNull();
    }
    for (const invalid of [{...entry,timeUs:10000001},{...entry,splitsUs:[5000000,8000001]}]) {
      expect(await reconstructCheckpointSpeeds({Session:ReplaySession,session,replay:replayFor(session),entry:invalid,yieldTask:instantYield})).toBeNull();
    }
  });
  test('rejects reset, invalid checkpoint speeds and excessively long replay', async () => {
    const session = makeSession();
    for (const replay of [{...replayFor(session),commands:[{fall:true}]},replayFor(session,[NaN,1200]),{...replayFor(session),commands:Array(40001).fill({})}]) {
      expect(await reconstructCheckpointSpeeds({Session:ReplaySession,session,replay,entry,yieldTask:instantYield})).toBeNull();
    }
  });
  test('reconstructs imported record route time and speeds with the route physics config', async () => {
    const session = makeSession();
    const replay = {...replayFor(session),config:{version:'record-physics',dt:.015}};
    expect(await reconstructRecordRoute({Session:ReplaySession,session,replay,yieldTask:instantYield})).toEqual({
      speeds:[900,1200],timeUs:10000000,splitsUs:[5000000,8000000]
    });
    expect(await reconstructRecordRoute({Session:ReplaySession,session,replay:{...replay,mapVersion:'other'},yieldTask:instantYield})).toBeNull();
  });
  test('yields before construction and ignores cancellation', async () => {
    const session = makeSession();
    let current = true, yielded = false;
    const result = await reconstructCheckpointSpeeds({Session:ReplaySession,session,replay:replayFor(session),entry,isCurrent:() => current,yieldTask:async () => { yielded = true; current = false; }});
    expect(yielded).toBe(true);
    expect(result).toBeNull();
  });
  test('identity separates replay run, map version, config and format', () => {
    const session = makeSession();
    const key = sessionKey(session,'board');
    expect(sessionKey({...session,map:{...session.map,version:'map-2'}},'board')).not.toBe(key);
    expect(sessionKey({...session,replayFormat:7},'board')).not.toBe(key);
    expect(sessionKey({...session,config:{...session.config,dt:.02}},'board')).not.toBe(key);
    expect(referenceIdentity({...entry,runId:'another'})).not.toBe(referenceIdentity(entry));
    expect(referenceIdentity({...entry,splitsUs:[NaN]})).toBeNull();
  });
});

describe('personal checkpoint references', () => {
  test('keeps exact local PB bookkeeping while the HUD is disabled', async () => {
    const session = makeSession(), settings = {hud:false,checkpointReference:'pb'};
    const refs = createCheckpointReferences({
      getSession:() => session,getReferences:() => ({boardId:'board',own:entry}),
      getSessionClass:() => ReplaySession,storage:memoryStorage(),settings,yieldTask:instantYield
    });
    refs.update();
    session.timer.state.startTick = 0; session.timer.state.phase = 'running';
    refs.update();
    finish(session,9,[1100,1300]); refs.update();
    restart(session); settings.hud = true;
    expect(refs.update()).toMatchObject({own:[1100,1300],ownStatus:'ready',record:null,recordStatus:'missing'});
    refs.destroy();
  });

  test('a hidden WR cannot publish a stale reconstruction and resumes when selected again', async () => {
    const session = makeSession(), settings = {checkpointReference:'wr'};
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const refs = createCheckpointReferences({
      getSession:() => session,getReferences:() => ({boardId:'board',loadRecordRoute:() => pending}),
      getSessionClass:() => ReplaySession,storage:memoryStorage(),settings,yieldTask:instantYield
    });
    refs.update(); await microtasks();
    settings.checkpointReference = 'pb'; refs.update();
    release(replayFor(session,[500,600])); await microtasks();
    expect(refs.update()).toMatchObject({record:null,recordStatus:'missing'});
    settings.checkpointReference = 'wr'; refs.update(); await microtasks();
    expect(refs.update()).toMatchObject({record:[500,600],recordStatus:'ready'});
    refs.destroy();
  });
  test('freezes old PB at finish, persists exact complete run, never checkpoint maxima', async () => {
    const session = makeSession(), storage = memoryStorage();
    let own = entry;
    const refs = createCheckpointReferences({getSession:() => session,getReferences:() => ({boardId:'board',own,loadReplay:async () => replayFor(session)}),getSessionClass:() => ReplaySession,storage,yieldTask:instantYield});
    refs.update(); await microtasks();
    session.timer.state.startTick = 0; session.timer.state.phase = 'running';
    refs.update(); await microtasks();
    expect(refs.update().own).toEqual([900,1200]);
    finish(session,9,[800,1400]);
    expect(refs.update().own).toEqual([900,1200]);
    own = {runId:'new-pb',timeUs:9000000,splitsUs:[4500000,7200000]};
    expect(refs.update().own).toEqual([900,1200]);
    restart(session);
    expect(refs.update().own).toEqual([800,1400]);
    session.timer.state.startTick = 0; session.timer.state.phase = 'running'; refs.update();
    finish(session,11,[2000,2000]); refs.update(); restart(session);
    expect(refs.update().own).toEqual([800,1400]);
    refs.destroy();
    const restored = createCheckpointReferences({getSession:() => session,getReferences:() => ({boardId:'board',own}),storage});
    expect(restored.update().own).toEqual([800,1400]); restored.destroy();
  });
  test('uses the imported KSF route by default rather than the rank-one Surfd run', async () => {
    const session = makeSession();
    const route = replayFor(session,[500,600],{elapsed:11,splits:[5.5,8.8]});
    const leaderboardRecord = {...entry,runId:'surfd-rank-one'};
    const refs = createCheckpointReferences({
      getSession:() => session,
      getReferences:() => ({boardId:'board',record:leaderboardRecord,loadReplay:async () => replayFor(session),loadRecordRoute:async () => route}),
      getSessionClass:() => ReplaySession,storage:memoryStorage(),yieldTask:instantYield
    });
    refs.update(); await microtasks();
    expect(refs.update()).toMatchObject({record:[500,600],recordTimeUs:11000000,recordSplitsUs:[5500000,8800000],recordStatus:'ready',recordSource:'ksf'});
    refs.destroy();
  });
  test('uses the selected rank-one replay and its leaderboard timing metadata', async () => {
    const session = makeSession(), settings = {wrSource:'leaderboard'};
    const leaderboardRecord = {...entry,runId:'surfd-rank-one'};
    let replayCalls = 0, routeCalls = 0;
    const refs = createCheckpointReferences({
      getSession:() => session,
      getReferences:() => ({
        boardId:'board',record:leaderboardRecord,
        loadReplay:async runId => { replayCalls++; expect(runId).toBe(leaderboardRecord.runId); return replayFor(session); },
        loadRecordRoute:async () => { routeCalls++; return replayFor(session,[500,600],{elapsed:11,splits:[5.5,8.8]}); }
      }),
      settings,getSessionClass:() => ReplaySession,storage:memoryStorage(),yieldTask:instantYield
    });
    refs.update(); await microtasks();
    expect(refs.update()).toMatchObject({record:[900,1200],recordTimeUs:10000000,recordSplitsUs:[5000000,8000000],recordStatus:'ready',recordSource:'leaderboard'});
    expect(replayCalls).toBe(1);
    expect(routeCalls).toBe(0);
    refs.destroy();
  });
  test('missing leaderboard replay never falls back to KSF', async () => {
    const session = makeSession(), settings = {wrSource:'leaderboard'};
    let routeCalls = 0;
    const refs = createCheckpointReferences({
      getSession:() => session,
      getReferences:() => ({
        boardId:'board',record:{...entry,runId:'missing-rank-one'},
        loadReplay:async () => null,
        loadRecordRoute:async () => { routeCalls++; return replayFor(session,[500,600]); }
      }),
      settings,getSessionClass:() => ReplaySession,storage:memoryStorage(),yieldTask:instantYield
    });
    refs.update(); await microtasks();
    expect(refs.update()).toMatchObject({record:null,recordTimeUs:10000000,recordSplitsUs:[5000000,8000000],recordStatus:'missing',recordSource:'leaderboard'});
    expect(routeCalls).toBe(0);
    refs.destroy();
  });
  test('source changes set reference work aside and resume it on return, never corrupting the PB reference', async () => {
    const session = makeSession(), settings = {wrSource:'ksf'};
    const rankOne = {...entry,runId:'rank-one'};
    const route = replayFor(session,[500,600],{elapsed:11,splits:[5.5,8.8]});
    const staleKsfRoute = replayFor(session,[100,200],{elapsed:12,splits:[6,9.6]});
    let resolveKsf, resolveOwn, releaseLeaderboard, ksfRequests = 0, holdLeaderboard = false;
    const refs = createCheckpointReferences({
      getSession:() => session,
      getReferences:() => ({
        boardId:'board',own:entry,record:rankOne,
        loadReplay:runId => runId === entry.runId
          ? new Promise(resolve => { resolveOwn = resolve; })
          : Promise.resolve(replayFor(session)),
        loadRecordRoute:() => ksfRequests++ === 0
          ? new Promise(resolve => { resolveKsf = resolve; })
          : Promise.resolve(route)
      }),
      settings,getSessionClass:() => ReplaySession,storage:memoryStorage(),
      yieldTask:() => holdLeaderboard ? new Promise(resolve => { releaseLeaderboard = resolve; }) : instantYield()
    });
    refs.update(); await microtasks();
    settings.wrSource = 'leaderboard';
    refs.update(); holdLeaderboard = true; await microtasks();
    resolveKsf(staleKsfRoute);
    await microtasks();
    expect(refs.update()).toMatchObject({record:null,recordTimeUs:10000000,recordSplitsUs:[5000000,8000000],recordStatus:'loading',recordSource:'leaderboard'});
    // Back on KSF within the grace period: the route already fetched is used, not fetched again.
    settings.wrSource = 'ksf';
    holdLeaderboard = false;
    refs.update(); await microtasks();
    expect(refs.update()).toMatchObject({record:[100,200],recordTimeUs:12000000,recordSplitsUs:[6000000,9600000],recordSource:'ksf'});
    expect(ksfRequests).toBe(1);
    releaseLeaderboard();
    resolveOwn(replayFor(session,[700,800]));
    await microtasks();
    expect(refs.update()).toMatchObject({own:[700,800],ownEntry:entry,ownStatus:'ready',record:[100,200],recordTimeUs:12000000,recordSplitsUs:[6000000,9600000],recordSource:'ksf'});
    refs.destroy();
  });
  test('a changed rank-one identity refreshes its replay and ignores the old response', async () => {
    const session = makeSession(), settings = {wrSource:'leaderboard'};
    let leaderboardRecord = {...entry,runId:'rank-one-old'}, resolveOld;
    const refs = createCheckpointReferences({
      getSession:() => session,
      getReferences:() => ({
        boardId:'board',record:leaderboardRecord,
        loadReplay:runId => runId === 'rank-one-old'
          ? new Promise(resolve => { resolveOld = resolve; })
          : Promise.resolve(replayFor(session,[300,400]))
      }),
      settings,getSessionClass:() => ReplaySession,storage:memoryStorage(),yieldTask:instantYield
    });
    refs.update(); await microtasks();
    leaderboardRecord = {...entry,runId:'rank-one-new'};
    refs.update(); await microtasks();
    expect(refs.update()).toMatchObject({record:[300,400],recordStatus:'ready',recordSource:'leaderboard'});
    resolveOld(replayFor(session,[100,200]));
    await microtasks();
    expect(refs.update()).toMatchObject({record:[300,400],recordStatus:'ready',recordSource:'leaderboard'});
    refs.destroy();
  });
  test('unknown or faster official PB never borrows speeds from a different run', () => {
    const session = makeSession();
    let own = null;
    const refs = createCheckpointReferences({getSession:() => session,getReferences:() => ({boardId:'board',own}),storage:memoryStorage()});
    refs.update(); session.timer.state.phase = 'running'; session.timer.state.startTick = 0; refs.update();
    finish(session,10,[900,1200]); refs.update(); restart(session);
    own = {runId:'other',timeUs:9000000,splitsUs:[4500000,7200000]};
    expect(refs.update().own).toBeNull();
    own = {...entry,runId:'unproven-tied-run'};
    expect(refs.update().own).toBeNull(); refs.destroy();
  });
  test('practice and invalid completed runs do not become PB references', () => {
    for (const invalid of ['practice','reason']) {
      const session = makeSession();
      const refs = createCheckpointReferences({getSession:() => session,getReferences:() => null,storage:memoryStorage()});
      refs.update(); session.timer.state.phase = 'running'; session.timer.state.startTick = 0; refs.update();
      finish(session,9,[500,700]);
      if (invalid === 'practice') session.practice = true; else session.timer.state.invalidReason = 'Practice restore';
      refs.update(); restart(session); expect(refs.update().own).toBeNull(); refs.destroy();
    }
  });
  test('ignores stale map replay responses and destruction', async () => {
    let session = makeSession(), resolveReplay;
    const oldSession = session;
    const refs = createCheckpointReferences({getSession:() => session,getReferences:() => ({boardId:'board',own:entry,loadReplay:() => new Promise(resolve => { resolveReplay = resolve; })}),getSessionClass:() => ReplaySession,storage:null,yieldTask:instantYield});
    refs.update(); await microtasks();
    session = {...makeSession(),map:{id:'another',version:'map-1'}};
    refs.update(); refs.destroy(); resolveReplay(replayFor(oldSession)); await microtasks();
    expect(refs.update().own).toBeNull();
  });
  test('unavailable replay resolves to missing, not an invented zero', async () => {
    const session = makeSession();
    const refs = createCheckpointReferences({getSession:() => session,getReferences:() => ({boardId:'board',own:entry,loadReplay:async () => { throw Error('Unavailable'); }}),getSessionClass:() => ReplaySession,storage:null,yieldTask:instantYield});
    refs.update(); await microtasks();
    expect(refs.update()).toMatchObject({own:null,ownStatus:'missing'}); refs.destroy();
  });

  test.each(['pb', 'leaderboard', 'ksf'])('unchanged unusable %s references survive finish bookkeeping and visibility changes without repeated work', async source => {
    const session = makeSession();
    const settings = {checkpointReference: source === 'pb' ? 'pb' : 'wr', wrSource: source === 'leaderboard' ? 'leaderboard' : 'ksf'};
    let downloads = 0, steps = 0;
    class CountedSession extends ReplaySession {
      step(command) { steps++; return super.step(command); }
    }
    const load = async () => { downloads++; return replayFor(session, [-1, 1200]); };
    const refs = createCheckpointReferences({
      getSession: () => session, getSessionClass: () => CountedSession,
      getReferences: () => ({boardId: 'board', own: entry, record: entry, loadReplay: load, loadRecordRoute: load}),
      settings, storage: null, yieldTask: instantYield,
    });
    const status = source === 'pb' ? 'ownStatus' : 'recordStatus';
    refs.update(); await microtasks();
    expect(refs.update()[status]).toBe('missing');
    expect({downloads, steps}).toEqual({downloads: 1, steps: 2});
    for (let attempt = 0; attempt < 3; attempt++) {
      session.timer.state.phase = 'running'; session.timer.state.startTick = 0;
      refs.update();
      finish(session, 11, [1000, 1200]);
      refs.observeFinish();
      refs.update(false); refs.update(); await microtasks();
      restart(session); refs.update(); await microtasks();
      expect(refs.update()[status]).toBe('missing');
    }
    expect({downloads, steps}).toEqual({downloads: 1, steps: 2});
    refs.destroy();
  });

  test('a negative PB result never blocks a new official identity or a changed map context', async () => {
    const session = makeSession(), settings = {checkpointReference: 'pb'};
    let own = entry, downloads = [];
    const refs = createCheckpointReferences({
      getSession: () => session, getSessionClass: () => ReplaySession,
      getReferences: () => ({boardId: 'board', own, loadReplay: async runId => {
        downloads.push([runId, session.map.version]);
        return replayFor(session, runId === entry.runId && session.map.version === 'map-1' ? [-1, 1200] : [700, 800]);
      }}),
      settings, storage: null, yieldTask: instantYield,
    });
    refs.update(); await microtasks();
    expect(refs.update().ownStatus).toBe('missing');
    own = {...entry, runId: 'new-pb'};
    refs.update(); await microtasks();
    expect(refs.update()).toMatchObject({own: [700, 800], ownStatus: 'ready'});
    own = entry; session.map = {...session.map, version: 'map-2'};
    refs.update(); await microtasks();
    expect(refs.update()).toMatchObject({own: [700, 800], ownStatus: 'ready'});
    expect(downloads).toEqual([['old-pb', 'map-1'], ['new-pb', 'map-1'], ['old-pb', 'map-2']]);
    refs.destroy();
  });

  test.each(['missing', 'exception'])('a transient %s replay load can retry after references become visible again', async failure => {
    const session = makeSession(), settings = {checkpointReference: 'pb'};
    let downloads = 0;
    const refs = createCheckpointReferences({
      getSession: () => session, getSessionClass: () => ReplaySession,
      getReferences: () => ({boardId: 'board', own: entry, loadReplay: async () => {
        if (++downloads === 1) {
          if (failure === 'exception') throw new Error('Network unavailable');
          return null;
        }
        return replayFor(session);
      }}),
      settings, storage: null, yieldTask: instantYield,
    });
    refs.update(); await microtasks();
    expect(refs.update().ownStatus).toBe('missing');
    refs.update(false); refs.update(); await microtasks();
    expect(refs.update()).toMatchObject({own: [900, 1200], ownStatus: 'ready'});
    expect(downloads).toBe(2);
    refs.destroy();
  });

  test('finish bookkeeping retains a pending reference rather than cancelling and downloading it again', async () => {
    const session = makeSession(), settings = {checkpointReference: 'pb'};
    let downloads = 0, release;
    const refs = createCheckpointReferences({
      getSession: () => session, getSessionClass: () => ReplaySession,
      getReferences: () => ({boardId: 'board', own: entry, loadReplay: () => {
        downloads++;
        return new Promise(resolve => { release = resolve; });
      }}),
      settings, storage: null, yieldTask: instantYield,
    });
    refs.update(); await microtasks();
    session.timer.state.phase = 'running'; session.timer.state.startTick = 0;
    refs.update();
    finish(session, 11, [1000, 1200]);
    expect(refs.observeFinish().ownStatus).toBe('loading');
    release(replayFor(session)); await microtasks();
    expect(refs.update()).toMatchObject({own: [900, 1200], ownStatus: 'ready'});
    expect(downloads).toBe(1);
    refs.destroy();
  });

  test('finish bookkeeping retries a transient download failure without discarding an unchanged baseline', async () => {
    const session = makeSession(), settings = {checkpointReference: 'pb'};
    let downloads = 0;
    const refs = createCheckpointReferences({
      getSession: () => session, getSessionClass: () => ReplaySession,
      getReferences: () => ({boardId: 'board', own: entry, loadReplay: async () => {
        if (++downloads === 1) throw new Error('Temporary download failure');
        return replayFor(session);
      }}),
      settings, storage: null, yieldTask: instantYield,
    });
    refs.update(); await microtasks();
    expect(refs.update().ownStatus).toBe('missing');
    session.timer.state.phase = 'running'; session.timer.state.startTick = 0;
    refs.update();
    finish(session, 11, [1000, 1200]);
    refs.observeFinish(); await microtasks();
    expect(refs.update()).toMatchObject({own: [900, 1200], ownStatus: 'ready'});
    expect(downloads).toBe(2);
    refs.destroy();
  });
});

describe('Personal checkpoint ownership', () => {
  test('isolates equal-time local baselines across A, guest and B while running and after reload', () => {
    const session = makeSession(), storage = memoryStorage();
    let ownerKey = 'A';
    const getReferences = () => ({boardId:'board',ownerKey});
    const create = () => createCheckpointReferences({getSession:() => session,getReferences,storage,settings:{checkpointReference:'pb'}});
    let refs = create();
    const records = [
      {owner:'A',time:9,speeds:[800,1400]},
      {owner:'guest',time:11,speeds:[600,1000]},
      {owner:'B',time:9,speeds:[1000,1300]}
    ];
    for (const record of records) {
      ownerKey = record.owner; restart(session); refs.update();
      session.timer.state.phase = 'running'; session.timer.state.startTick = 0; refs.update();
      finish(session,record.time,record.speeds); refs.update();
    }
    ownerKey = 'A'; restart(session); refs.update();
    session.timer.state.phase = 'running'; session.timer.state.startTick = 0; refs.update();
    for (const record of records) {
      ownerKey = record.owner;
      expect(refs.update()).toMatchObject({
        own:record.speeds,ownTimeUs:record.time * 1e6,
        ownSplitsUs:[record.time * .5e6,record.time * .8e6],ownStatus:'ready'
      });
    }
    // The current attempt crossed owners, so its finish cannot become B's PB.
    finish(session,8,[2000,2200]); refs.update(); restart(session);
    expect(refs.update()).toMatchObject({own:[1000,1300],ownTimeUs:9000000});
    refs.destroy();
    for (const record of records) {
      ownerKey = record.owner; restart(session); refs = create();
      expect(refs.update()).toMatchObject({own:record.speeds,ownTimeUs:record.time * 1e6,ownStatus:'ready'});
      refs.destroy();
    }
  });

  test('a finished A run is never credited or linked to guest or B and B uses its own slower official PB', async () => {
    const session = makeSession(), storage = memoryStorage();
    let ownerKey = 'A', own = null;
    const officialB = {runId:'B-pb',timeUs:12000000,splitsUs:[6000000,9600000]};
    const getReferences = () => ({
      boardId:'board',ownerKey,own,
      loadReplay:async () => replayFor(session,[700,1100],{elapsed:12,splits:[6,9.6]})
    });
    const create = () => createCheckpointReferences({
      getSession:() => session,getReferences,getSessionClass:() => ReplaySession,
      storage,settings:{checkpointReference:'pb'},yieldTask:instantYield
    });
    let refs = create(); refs.update();
    session.timer.state.phase = 'running'; session.timer.state.startTick = 0; refs.update();
    finish(session,9,[900,1500]); refs.update();
    ownerKey = 'guest';
    expect(refs.update()).toMatchObject({own:null,ownTimeUs:null,ownStatus:'missing'});
    ownerKey = 'B'; own = officialB; refs.update(); await microtasks();
    expect(refs.update()).toMatchObject({own:[700,1100],ownEntry:officialB,ownTimeUs:12000000,ownSplitsUs:[6000000,9600000]});
    restart(session);
    expect(refs.update()).toMatchObject({own:[700,1100],ownTimeUs:12000000});
    refs.destroy();
    for (const owner of ['A','guest','B']) {
      ownerKey = owner; own = owner === 'B' ? officialB : null; refs = create();
      refs.update(); await microtasks();
      expect(refs.update()).toMatchObject(owner === 'A'
        ? {own:[900,1500],ownTimeUs:9000000}
        : owner === 'B' ? {own:[700,1100],ownTimeUs:12000000} : {own:null,ownTimeUs:null});
      refs.destroy();
    }
  });

  test('discards legacy unowned personal records rather than assigning them to guest or an account', () => {
    const session = makeSession(), storage = memoryStorage();
    storage.setItem('surfd.qol.checkpoints.v1',JSON.stringify({
      cache:[],personal:[[sessionKey(session,'board'),{timeUs:9000000,splitsUs:[4500000,7200000],speeds:[900,1500],runId:null}]]
    }));
    for (const ownerKey of ['A','guest','B']) {
      const refs = createCheckpointReferences({
        getSession:() => session,getReferences:() => ({boardId:'board',ownerKey}),storage,settings:{checkpointReference:'pb'}
      });
      expect(refs.update()).toMatchObject({own:null,ownTimeUs:null,ownStatus:'missing'});
      refs.destroy();
    }
  });

  test('ownership changes retain pending and completed analysis for the same immutable official replay', async () => {
    const session = makeSession(), storage = memoryStorage();
    let ownerKey = 'A', release, loads = 0, steps = 0;
    class CountedSession extends ReplaySession {
      step(command) { steps++; return super.step(command); }
    }
    const getReferences = () => ({
      boardId:'board',ownerKey,own:entry,
      loadReplay:() => { loads++; return new Promise(resolve => { release = resolve; }); }
    });
    const create = () => createCheckpointReferences({
      getSession:() => session,getReferences,getSessionClass:() => CountedSession,
      storage,settings:{checkpointReference:'pb'},yieldTask:instantYield
    });
    const refs = create(); refs.update(); await microtasks();
    session.timer.state.phase = 'running'; session.timer.state.startTick = 0; refs.update();
    ownerKey = 'guest'; refs.update(); ownerKey = 'B'; refs.update(); await microtasks();
    expect(loads).toBe(1);
    release(replayFor(session)); await microtasks();
    expect(refs.update()).toMatchObject({own:[900,1200],ownTimeUs:10000000,ownStatus:'ready'});
    ownerKey = 'A';
    expect(refs.update()).toMatchObject({own:[900,1200],ownStatus:'ready'});
    expect({loads,steps}).toEqual({loads:1,steps:2});
    refs.destroy();
    ownerKey = 'B'; const restored = create();
    expect(restored.update()).toMatchObject({own:[900,1200],ownStatus:'ready'});
    expect({loads,steps}).toEqual({loads:1,steps:2});
    restored.destroy();
  });
  test('switches frozen official timing and speeds together during a running attempt and ignores A replies', async () => {
    const session = makeSession();
    let ownerKey = 'A', own = entry, releaseA;
    const officialB = {runId:'B-pb',timeUs:12000000,splitsUs:[6000000,9600000]};
    const refs = createCheckpointReferences({
      getSession:() => session,
      getReferences:() => ({
        boardId:'board',ownerKey,own,
        loadReplay:id => id === entry.runId
          ? new Promise(resolve => { releaseA = resolve; })
          : Promise.resolve(replayFor(session,[700,1100],{elapsed:12,splits:[6,9.6]}))
      }),
      getSessionClass:() => ReplaySession,storage:memoryStorage(),settings:{checkpointReference:'pb'},yieldTask:instantYield
    });
    refs.update(); await microtasks();
    session.timer.state.phase = 'running'; session.timer.state.startTick = 0; refs.update();
    ownerKey = 'guest'; own = null;
    expect(refs.update()).toMatchObject({own:null,ownTimeUs:null,ownSplitsUs:null,ownStatus:'missing'});
    ownerKey = 'B'; own = officialB;
    expect(refs.update()).toMatchObject({own:null,ownTimeUs:12000000,ownSplitsUs:[6000000,9600000],ownStatus:'loading'});
    await microtasks(); releaseA(replayFor(session)); await microtasks();
    expect(refs.update()).toMatchObject({own:[700,1100],ownTimeUs:12000000,ownSplitsUs:[6000000,9600000],ownStatus:'ready'});
    own = {runId:'B-new',timeUs:11000000,splitsUs:[5500000,8800000]};
    expect(refs.update()).toMatchObject({own:[700,1100],ownTimeUs:12000000,ownSplitsUs:[6000000,9600000]});
    refs.destroy();
  });

});

describe('Shared checkpoint job lifecycle', () => {
  test('a PB and leaderboard record with the same identity share one download and one reconstruction', async () => {
    const session = makeSession();
    let loads = 0, steps = 0, constructions = 0;
    class CountedSession extends ReplaySession {
      constructor(...args) { super(...args); constructions++; }
      step(command) { steps++; return super.step(command); }
    }
    const refs = createCheckpointReferences({
      getSession:() => session,getReferences:() => ({boardId:'board',own:entry,record:entry,
        loadReplay:async () => { loads++; return replayFor(session); }}),
      getSessionClass:() => CountedSession,settings:{wrSource:'leaderboard'},storage:null,yieldTask:instantYield
    });
    refs.update(); await microtasks();
    expect(refs.update()).toMatchObject({own:[900,1200],record:[900,1200],ownStatus:'ready',recordStatus:'ready'});
    expect({loads,steps,constructions}).toEqual({loads:1,steps:2,constructions:1});
    refs.destroy();
  });

  test('checkpoint-only pending work survives leaving start and repeated checkpoint-array resets', async () => {
    const session = makeSession();
    let loads = 0, release;
    const refs = createCheckpointReferences({
      getSession:() => session,getReferences:() => ({boardId:'board',own:entry,
        loadReplay:() => { loads++; return new Promise(resolve => { release = resolve; }); }}),
      getSessionClass:() => ReplaySession,settings:{checkpointReference:'pb'},storage:null,yieldTask:instantYield
    });
    refs.update(); await microtasks();
    for (let i = 0; i < 3; i++) {
      session.checkpointSpeeds = [];
      session.timer.state.phase = 'running'; session.timer.state.startTick = i;
      refs.update(); await microtasks();
    }
    expect(loads).toBe(1);
    release(replayFor(session)); await microtasks();
    expect(refs.update()).toMatchObject({own:[900,1200],ownStatus:'ready'});
    refs.destroy();
  });

  test('finishing while inactive persists the PB without loading and keeps its pre-run comparison frozen', async () => {
    const session = makeSession(), storage = memoryStorage();
    let loads = 0, own = entry;
    const refs = createCheckpointReferences({
      getSession:() => session,getReferences:() => ({boardId:'board',own,
        loadReplay:async () => { loads++; return replayFor(session); }}),
      getSessionClass:() => ReplaySession,settings:{checkpointReference:'pb'},storage,yieldTask:instantYield
    });
    refs.update(false);
    session.timer.state.startTick = 0; session.timer.state.phase = 'running'; refs.update(false);
    finish(session,9,[850,1400]);
    refs.observeFinish();
    own = {runId:'finished-pb',timeUs:9000000,splitsUs:[4500000,7200000]};
    expect(refs.update(false)).toMatchObject({ownEntry:entry,ownStatus:'missing'});
    await microtasks();
    expect(loads).toBe(0);
    restart(session);
    expect(refs.update()).toMatchObject({own:[850,1400],ownStatus:'ready'});
    refs.destroy();
    const restored = createCheckpointReferences({getSession:() => session,getReferences:() => ({boardId:'board',own}),storage});
    expect(restored.update()).toMatchObject({own:[850,1400],ownStatus:'ready'});
    restored.destroy();
  });
});

describe('HUD numeric formatting', () => {
  test('formats times and signed deltas, with a dash for missing values', () => {
    expect(formatTime(65.125)).toBe('01:05.125');
    expect(formatTime(Math.fround(.015))).toBe('00:00.015');
    expect(formatTime(59.9996)).toBe('01:00.000');
    expect(formatTime(0)).toBe('00:00.000');
    expect(formatTime(undefined)).toBe('—');
    expect(formatDelta(42)).toBe('+42');
    expect(formatDelta(-12.34,1)).toBe('−12.3');
    expect(formatDelta(-.01)).toBe('±0');
    expect(formatDelta(null)).toBe('—');
    expect(formatSplitDelta(5.125, 5000000)).toEqual({text:'+0.125',tone:'loss'});
    expect(formatSplitDelta(4.875, 5000000)).toEqual({text:'−0.125',tone:'good'});
    expect(formatSplitDelta(5.125, null)).toBeNull();
  });
  test('uses strict Amazing and Good boundaries for start thresholds', () => {
    expect(startTone(7.49, 7.5, 15)).toBe('good');
    expect(startTone(7.5, 7.5, 15)).toBe('warn');
    expect(startTone(14.99, 7.5, 15)).toBe('warn');
    expect(startTone(15, 7.5, 15)).toBe('loss');
    expect(startTone(0, 10, 17.5)).toBe('good');
    expect(startTone(undefined, 7.5, 15)).toBe('muted');
  });
  test('compares signed PB/WR losses without clamping gains', () => {
    expect(referenceTone(60.6, 50.6)).toBe('loss');
    expect(referenceTone(50.6, 60.6)).toBe('good');
    expect(referenceTone(50.6, 50.6)).toBe('good');
    expect(referenceTone(-5, -20)).toBe('loss');
    expect(referenceTone(-20, -5)).toBe('good');
    expect(referenceTone(0, 0)).toBe('good');
  });
  test('ignores sub-display-precision differences but not visible deficits', () => {
    expect(referenceTone(10.0000000001, 10)).toBe('good');
    expect(referenceTone(10.04, 10)).toBe('good');
    expect(referenceTone(10.06, 10)).toBe('loss');
    expect(referenceTone(9.94, 10)).toBe('good');
  });
  test('allows a narrow configurable worse-than-reference band only when requested', () => {
    expect(referenceTone(10, 10, 2)).toBe('good');
    expect(referenceTone(10.1, 10, 2)).toBe('warn');
    expect(referenceTone(12, 10, 2)).toBe('warn');
    expect(referenceTone(12.1, 10, 2)).toBe('loss');
    expect(referenceTone(-18, -20, 2)).toBe('warn');
    expect(referenceTone(10.1, 10, 0)).toBe('loss');
    expect(referenceTone(10.6, 10, .5)).toBe('loss');
    expect(referenceTone(10, null, 2)).toBe('muted');
  });
  test('keeps unavailable references neutral rather than comparing against zero', () => {
    expect(referenceTone(null, 10)).toBe('muted');
    expect(referenceTone(10, null)).toBe('muted');
    expect(referenceTone(undefined, 10)).toBe('muted');
    expect(referenceTone(10, NaN)).toBe('muted');
    expect(referenceTone(Infinity, 10)).toBe('muted');
  });
});
