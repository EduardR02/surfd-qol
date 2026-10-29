import {afterEach, describe, expect, test} from 'bun:test';
import {createRunReferences} from '../src/run-references.js';
import {createMetrics} from '../src/metrics.js';
import {observePhysics} from '../src/observer.js';
import {createCheckpointReferences} from '../src/references.js';
import {createReferenceReplayStore, reconstructReferenceReplay, routeBoards} from '../src/replay-store.js';
import {selectFeedbackType} from '../src/hud-model.js';
import {createRampReference} from '../src/ramp-reference.js';
import {visitKey} from '../src/replay-store.js';

const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const normal = {x:0,y:.8,z:.6};
const vector = x => ({x,y:0,z:0});
const entry = {runId:'official-pb',timeUs:10000000,splitsUs:[]};
const contact = (brush = 'a', loss = 5) => ({brush,loss});
const finish = {finish:true};
const startZone = {id:'start',kind:'start',min:{x:-100,y:-100,z:100},max:{x:100,y:100,z:200}};
const startCommands = ({speed = 350, fromHeight = 180, toHeight = 160, grounded = true, brush = 'a'} = {}) => [
  ...(grounded ? [{ground:true,position:{x:0,y:0,z:100}}] : []),
  {speed,position:{x:122,y:0,z:toHeight},startFraction:.5,events:['start'],
    segments:[{from:{x:110,y:0,z:fromHeight},to:{x:122,y:0,z:toHeight},startFraction:0,endFraction:1}]},
  contact(brush),finish
];

// This boundary double performs the native method calls used by the observer,
// rather than mocking the metrics or reproducing its Board-entry formula.
function fixture({source = 'pb', startSource = 'fixed', surfSource = 'fixed', wrSource = 'ksf', commands = [contact(), finish],
  floorHeight = 100, platformEdge = 100, yieldTask = async () => {}, shared = false, saved = null, ownerKey = 'guest'} = {}) {
  const config = {dt:.015,gravity:800,airAccelerate:150,airCap:30,groundNormal:.7,float32:false,
    standHeight:62,duckHeight:45,stepSize:18,unrestrictedStart:false};
  const map = {id:'surf_test',version:'map-1',zones:[startZone],brushes:['a','b','c'].map((id,index) => ({
    id, vertices:[{x:index*100,y:0,z:0},{x:index*100+10,y:0,z:0},{x:index*100+10,y:6,z:-8},{x:index*100,y:6,z:-8}],
    faces:[[0,1,2,3]],planes:[{normal,distance:0}]
  }))};
  let nativeLoads = 0, nativeSteps = 0, feedbackSteps = 0;
  class Movement {
    constructor(config) {
      this.config = config;
      this.world = {trace(from, to, hull) {
        if (floorHeight === null || from.x + hull.min.x >= platformEdge || from.z < floorHeight || to.z >= floorHeight) {
          return {fraction:1,end:to,normal:{x:0,y:0,z:0}};
        }
        const fraction = (from.z - floorHeight) / (from.z - to.z);
        return {fraction,end:{x:from.x,y:from.y,z:from.z + fraction * (to.z - from.z)},normal:{x:0,y:0,z:1}};
      }};
    }
    accelerate() {}
    slide(state, result) {
      if (this.command.throw) throw new Error('native step failed');
      if (this.command.brush) result.contacts.push({brushId:this.command.brush,normal});
      if (this.command.wall) result.contacts.push({brushId:'wall',normal:{x:1,y:0,z:0}});
      state.velocity.x -= this.command.loss ?? 0;
    }
  }
  class Session {
    constructor(map, config, replayFormat) {
      this.map = map; this.config = config; this.replayFormat = replayFormat;
      this.state = {tick:0,grounded:false,ducked:false,position:{x:0,y:0,z:100},velocity:vector(100),surfaceFriction:1};
      this.timer = {state:{phase:'running',startTick:0,elapsed:0,splits:[],invalidReason:null},startSpeedCap:() => 350};
      this.checkpointSpeeds = []; this.movement = new Movement(config);
    }
    loadReplay(replay) {
      nativeLoads++;
      this.replay = replay;
      this.timer.state.invalidReason = replay.playbackInvalidReason ?? 'Recorded playback cannot be submitted';
    }
    restart() {}
    restorePractice() {}
    visitStation() {}
    step(command) {
      if (this !== session) {
        nativeSteps++;
        if (Session.prototype.step !== liveStep) feedbackSteps++;
      }
      if (command.position) this.state.position = {...command.position};
      this.state.ducked = !!command.ducked;
      this.lastResult = command.segments ? {segments:command.segments} : null;
      if (command.startFraction != null) this.timer.state.startTick = this.state.tick + command.startFraction;
      if (command.checkpoint != null) this.checkpointSpeeds.length = command.checkpoint;
      this.state.grounded = !!command.ground;
      this.state.velocity = vector(command.speed ?? 100);
      this.movement.command = command;
      this.movement.accelerate(this.state,vector(0),0,!this.state.grounded);
      this.movement.slide(this.state,{contacts:[],blocked:false});
      this.state.tick++;
      if (command.finish) this.timer.state = {...this.timer.state,phase:'finished',elapsed:command.elapsed ?? 10,splits:command.splits ?? []};
      return command.events ?? [];
    }
  }
  const session = new Session(map,config,8), settings = {boardColorReference:source,startColorReference:startSource,surfColorReference:surfSource,wrSource};
  let own = entry, record = {...entry,runId:'rank-one'}, replay = {mapId:map.id,mapVersion:map.version,config,format:7,commands};
  let replayCalls = [], routeCalls = 0;
  const adapter = {Session,Movement,getSession:() => session};
  const metrics = createMetrics();
  const originalStep = Session.prototype.step, originalSlide = Movement.prototype.slide;
  let observerErrors = [];
  const observer = observePhysics(adapter,metrics,{onTick() {},onReset() {},onError:error => observerErrors.push(error)});
  cleanups.push(() => observer.destroy());
  const liveStep = Session.prototype.step, liveSlide = Movement.prototype.slide;
  let loadReplay = async id => { replayCalls.push(id); return replay; };
  let loadRecordRoute = async () => { routeCalls++; return replay; };
  const getReferences = () => ({boardId:'board',ownerKey,own,record,loadReplay:id => loadReplay(id),loadRecordRoute:() => loadRecordRoute()});
  const replayStore = shared || saved ? createReferenceReplayStore({getAdapter:() => adapter,yieldTask,saved}) : undefined;
  if (replayStore) cleanups.push(() => replayStore.destroy());
  const controller = createRunReferences({getSession:() => session,getAdapter:() => adapter,
    getReferences,settings,yieldTask,replayStore});
  cleanups.push(() => controller.destroy());
  return {session,settings,adapter,metrics,controller,observer,originalStep,originalSlide,liveStep,liveSlide,observerErrors,getReferences,replayStore,
    step(command) { session.step(command); return metrics.snapshot().board; },
    update(board = metrics.snapshot().board) { return controller.update(board).board; },
    references(board = metrics.snapshot().board) { return controller.update(board, metrics.snapshot().surf); },
    native:() => ({loads:nativeLoads,steps:nativeSteps}),
    feedbackSteps:() => feedbackSteps,
    replay:() => replay, setReplay(value) { replay = value; }, setOwn(value) { own = value; }, setRecord(value) { record = value; },
    setOwner(value) { ownerKey = value; },
    setLoader(value) { loadReplay = value; }, setRouteLoader(value) { loadRecordRoute = value; }, calls:() => ({replay:replayCalls,route:routeCalls})};
}

// What IndexedDB would keep between page loads, as structured clones.
const savedAnalysis = () => {
  const data = new Map();
  return {data, async get(id) { return data.has(id) ? structuredClone(data.get(id)) : null; }, async put(id, value) { data.set(id, structuredClone(value)); }};
};

describe('Reference ramp entry ticks', () => {
  test('captures first contact command cursors once in the shared native pass, not later board revisions', async () => {
    const commands = [{}, {}, contact('a', 2), contact('a', 3), contact('b', 4), contact('a', 6), finish];
    const f = fixture({shared: true, commands});
    const first = f.step(contact('a'));
    f.update(first);
    const reference = createRampReference({getSession: () => f.session, getReferences: f.getReferences,
      getAdapter: () => f.adapter, replayStore: f.replayStore, settings: f.settings});
    cleanups.push(() => reference.destroy());
    const consumer = reference.createConsumer();
    const slot = consumer.get('surf_test:map-1', 'pb');
    await flush();
    expect(slot.status).toBe('ready');
    expect(slot.dt).toBe(.015);
    expect(slot.ramps.get(visitKey(first))).toMatchObject({tick: 3});
    expect(slot.ramps.get(visitKey({...first, visit: 2}))).toMatchObject({tick: 6});
    expect(f.native()).toEqual({loads: 1, steps: commands.length});
    expect(f.calls().replay).toEqual(['official-pb']);
    consumer.release();
    const cached = consumer.get('surf_test:map-1', 'pb');
    expect(cached.status).toBe('ready');
    expect(cached.ramps.get(visitKey(first)).tick).toBe(3);
    expect(f.native()).toEqual({loads: 1, steps: commands.length});
  });

  test('saved summaries retain entry cursors without replay download or native simulation', async () => {
    const saved = savedAnalysis(), commands = [{}, contact('a'), finish];
    const first = fixture({saved, commands});
    first.update(first.step(contact()));
    await flush();
    first.controller.destroy();
    const next = fixture({saved, commands});
    const key = visitKey(next.step(contact()));
    const reference = createRampReference({getSession: () => next.session, getReferences: next.getReferences,
      getAdapter: () => next.adapter, replayStore: next.replayStore, settings: next.settings});
    cleanups.push(() => reference.destroy());
    const slot = reference.createConsumer().get('surf_test:map-1', 'pb');
    await flush();
    expect(slot.status).toBe('ready');
    expect(slot.ramps.get(key).tick).toBe(2);
    expect(next.calls().replay).toEqual([]);
    expect(next.native()).toEqual({loads: 0, steps: 0});
  });
});

describe('Saved reference analysis', () => {
  test('a PB analysed on an earlier visit needs no download or re-simulation', async () => {
    const saved = savedAnalysis();
    const first = fixture({saved});
    const board = first.step(contact('a',20)); first.update(board); await flush();
    expect(first.update(board)).toEqual({loss:5,status:'ready',source:'pb'});
    expect(saved.data.size).toBe(1);
    first.controller.destroy();
    const next = fixture({saved});
    const again = next.step(contact('a',20)); next.update(again); await flush();
    expect(next.update(again)).toEqual({loss:5,status:'ready',source:'pb'});
    expect(next.calls().replay).toEqual([]);
    expect(next.native().loads).toBe(0);
  });
  test('a watched replay is analysed once: its boards are saved under its route key for the next visit', async () => {
    const saved = savedAnalysis();
    const watch = f => f.replayStore.acquire({key: 'map:route:fingerprint', session: f.session, load: async () => f.replay(),
      feedback: true, isCurrent: () => true}).promise;
    const first = fixture({saved});
    const boards = routeBoards(await watch(first));
    expect(boards).toEqual([{tick: expect.any(Number), board: 5, key: expect.any(String)}]);
    expect([first.native().loads, saved.data.size]).toEqual([1, 1]);
    first.replayStore.destroy();
    const next = fixture({saved});
    expect(routeBoards(await watch(next))).toEqual(boards);
    expect(next.native().loads).toBe(0);
  });

  test('a replay watched under other labels or format reuses the PB summary; other movement rules get none and cost nothing', async () => {
    const f = fixture({shared:true});
    const board = f.step(contact());
    f.update(board); await flush();
    expect(f.update(board)).toEqual({loss:5,status:'ready',source:'pb'});
    expect([f.calls().replay.length, f.native().loads]).toEqual([1, 1]);
    // Native Watch adopts another run's format and non-movement labels.
    f.session.config = {...f.session.config, version:'historical', unrestrictedStart:true};
    f.session.replayFormat = 7;
    expect(f.update(board)).toEqual({loss:5,status:'ready',source:'pb'});
    // Other movement rules: the PB's feedback doesn't apply, and isn't recomputed for them.
    f.session.config = {...f.session.config, dt:0.02};
    f.update(board); await flush();
    expect(f.update(board).status).not.toBe('ready');
    expect([f.calls().replay.length, f.native().loads]).toEqual([1, 1]);
  });

  test('the KSF route is fetched to check it is unchanged, and re-simulated only when it changed', async () => {
    const saved = savedAnalysis();
    const first = fixture({source:'wr',saved});
    first.update(first.step(contact())); await flush();
    first.controller.destroy();
    const same = fixture({source:'wr',saved});
    const board = same.step(contact()); same.update(board); await flush();
    expect(same.update(board)).toEqual({loss:5,status:'ready',source:'wr'});
    expect([same.calls().route, same.native().loads]).toEqual([1, 0]);
    same.controller.destroy();
    const changed = fixture({source:'wr',saved,commands:[contact('a',8),finish]});
    const other = changed.step(contact()); changed.update(other); await flush();
    expect(changed.update(other)).toEqual({loss:8,status:'ready',source:'wr'});
    expect(changed.native().loads).toBe(1);
    expect(saved.data.size).toBe(2);
  });
});

describe('Personal replay ownership', () => {
  test('A to guest to B replaces frozen board and start references mid-attempt and after restart', async () => {
    const f = fixture({ownerKey:'A',startSource:'pb',commands:startCommands()});
    const clips = new Map([
      ['A-pb',{speed:350,loss:5}],['B-pb',{speed:420,loss:12}],['B-new',{speed:450,loss:20}]
    ]);
    f.setLoader(async id => {
      const clip = clips.get(id);
      return {...f.replay(),commands:startCommands({speed:clip.speed}).map(command =>
        command.brush ? {...command,loss:clip.loss} : command)};
    });
    f.setOwn({...entry,runId:'A-pb'});
    const board = f.step(contact()); f.references(board); await flush();
    expect(f.references(board)).toMatchObject({board:{status:'ready',loss:5},start:{status:'ready',speed:350}});
    f.setOwner('guest'); f.setOwn(null);
    expect(f.references(board)).toMatchObject({board:{status:'missing',loss:null},start:{status:'missing',speed:null}});
    f.setOwner('B'); f.setOwn({...entry,runId:'B-pb'});
    expect(f.references(board)).toMatchObject({board:{status:'loading',loss:null},start:{status:'loading',speed:null}});
    await flush();
    expect(f.references(board)).toMatchObject({board:{status:'ready',loss:12},start:{status:'ready',speed:420}});
    f.setOwn({...entry,runId:'B-new'});
    expect(f.references(board)).toMatchObject({board:{status:'ready',loss:12},start:{status:'ready',speed:420}});
    f.session.state.tick = 0; f.session.checkpointSpeeds = [];
    f.session.timer.state.phase = 'ready'; f.session.timer.state.startTick = null;
    f.references(board); await flush();
    expect(f.references(board)).toMatchObject({board:{status:'ready',loss:20},start:{status:'ready',speed:450}});
  });

  test('an old owner response cannot publish after a mid-attempt account switch', async () => {
    const f = fixture({ownerKey:'A',startSource:'pb',commands:startCommands()});
    let release;
    f.setLoader(() => new Promise(resolve => { release = resolve; }));
    const board = f.step(contact()); f.references(board); await flush();
    f.setOwner('guest'); f.setOwn(null); f.references(board);
    f.setOwner('B'); f.setOwn({...entry,runId:'B-pb'});
    f.setLoader(async () => ({...f.replay(),commands:startCommands({speed:420}).map(command =>
      command.brush ? {...command,loss:12} : command)}));
    f.references(board); await flush();
    release(f.replay()); await flush();
    expect(f.references(board)).toMatchObject({board:{status:'ready',loss:12},start:{status:'ready',speed:420}});
  });

  test('ownership tags do not duplicate pending, completed or persisted official replay analysis', async () => {
    const saved = savedAnalysis();
    const f = fixture({ownerKey:'A',saved,startSource:'pb',commands:startCommands()});
    let release, loads = 0;
    f.setLoader(() => { loads++; return new Promise(resolve => { release = resolve; }); });
    const board = f.step(contact()); f.references(board); await flush();
    for (const owner of ['guest','B']) { f.setOwner(owner); f.references(board); }
    await flush(); expect(loads).toBe(1);
    release(f.replay()); await flush();
    expect(f.references(board)).toMatchObject({board:{status:'ready',loss:5},start:{status:'ready',speed:350}});
    const native = f.native();
    f.setOwner('A');
    expect(f.references(board)).toMatchObject({board:{status:'ready',loss:5},start:{status:'ready',speed:350}});
    expect(loads).toBe(1); expect(f.native()).toEqual(native); expect(saved.data.size).toBe(1);
    f.controller.destroy();
    const restored = fixture({ownerKey:'B',saved,startSource:'pb',commands:startCommands()});
    const nextBoard = restored.step(contact()); restored.references(nextBoard); await flush();
    expect(restored.references(nextBoard)).toMatchObject({board:{status:'ready',loss:5},start:{status:'ready',speed:350}});
    expect(restored.calls().replay).toEqual([]); expect(restored.native()).toEqual({loads:0,steps:0});
  });
});

describe('Native run replay references', () => {
  test('uses the native metrics, allows historical format, and returns the raw PB clip', async () => {
    const f = fixture();
    const board = f.step(contact('a',20));
    expect(f.update(board)).toEqual({loss:null,status:'loading',source:'pb'});
    await flush();
    expect(f.update(board)).toEqual({loss:5,status:'ready',source:'pb'});
    expect(board.loss).toBe(20);
    expect(f.calls()).toEqual({replay:['official-pb'],route:0});
    expect(f.adapter.Session.prototype.step).toBe(f.liveStep);
    expect(f.adapter.Movement.prototype.slide).toBe(f.liveSlide);
    expect(f.observerErrors).toEqual([]);
  });
  test('accepts finished native playback marked ineligible for submission for PB and KSF', async () => {
    for (const source of ['pb','wr']) {
      const f = fixture({source});
      f.setReplay({...f.replay(),playbackInvalidReason:`Native playback-only timer: ${source}`});
      const board = f.step(contact()); f.update(board); await flush();
      expect(f.update(board)).toEqual({loss:5,status:'ready',source});
      f.controller.destroy();
    }
  });
  test('collects the final entry clip after brief recontacts, not its initial snapshot', async () => {
    const f = fixture({commands:[contact('a',3),{},contact('a',4),finish]});
    const board = f.step(contact()); f.update(board); await flush();
    expect(f.update(board)).toMatchObject({status:'ready',loss:7});
  });
  test('finalizes the previous entry when the next board arrives', async () => {
    const f = fixture({commands:[contact('a',3),{},contact('a',4),contact('b',11),finish]});
    const first = f.step(contact()); f.update(first); await flush();
    expect(f.update(first)).toMatchObject({status:'ready',loss:7});
    const second = f.step(contact('b')); expect(f.update(second)).toMatchObject({status:'ready',loss:11});
  });
  test('loads actual KSF route and selected leaderboard without cross-source fallbacks', async () => {
    const f = fixture({source:'wr'});
    const board = f.step(contact()); f.update(board); await flush();
    expect(f.update(board)).toEqual({loss:5,status:'ready',source:'wr'});
    expect(f.calls()).toEqual({replay:[],route:1});
    f.settings.wrSource = 'leaderboard'; f.update(board); await flush();
    expect(f.update(board)).toMatchObject({status:'ready',loss:5});
    expect(f.calls()).toEqual({replay:['rank-one'],route:1});
    f.setRecord({...entry,runId:'unavailable'}); f.setLoader(async () => null); f.update(board); await flush();
    expect(f.update(board)).toMatchObject({status:'missing',loss:null});
    expect(f.calls().route).toBe(1);
  });
  test('fixed colors never request a replay and switching later still matches the current visit', async () => {
    const f = fixture({source:'fixed',commands:[contact(),contact('b',9),finish]});
    f.step(contact());
    const board = f.step(contact('b'));
    expect(f.update(board)).toEqual({loss:null,status:'ready',source:'fixed'});
    expect(f.calls()).toEqual({replay:[],route:0});
    f.settings.boardColorReference = 'pb'; f.update(board); await flush();
    expect(f.update(board)).toMatchObject({status:'ready',loss:9});
  });
  test('freezes the official PB for the run and never substitutes a local finished run', async () => {
    const f = fixture();
    f.session.timer.state.phase = 'ready'; f.session.timer.state.startTick = null; f.update();
    f.session.timer.state.phase = 'running'; f.session.timer.state.startTick = 0;
    const board = f.step(contact()); f.update(board); await flush();
    f.setOwn({...entry,runId:'new-pb'});
    f.step(finish); expect(f.update(board)).toMatchObject({status:'ready',loss:5});
    expect(f.calls().replay).toEqual(['official-pb']);
    f.session.state.tick = 0; f.session.checkpointSpeeds = []; f.session.timer.state.phase = 'ready'; f.session.timer.state.startTick = null;
    f.update({sequence:0}); await flush();
    expect(f.calls().replay).toEqual(['official-pb','new-pb']);
    f.setOwn(null); f.update({sequence:0}); await flush();
    expect(f.update({sequence:0})).toMatchObject({status:'missing',loss:null});
  });
  test('unavailable official PB is missing even after a local finish', async () => {
    const f = fixture(); f.setOwn(null);
    const board = f.step(contact()); f.step(finish); f.update(board); await flush();
    expect(f.update(board)).toMatchObject({status:'missing',loss:null});
    expect(f.calls().replay).toEqual([]);
  });
  test('requires exact map, config, finished time and splits before using official data', async () => {
    for (const mutate of [
      replay => ({...replay,mapId:'other'}), replay => ({...replay,mapVersion:'other'}),
      replay => ({...replay,config:{...replay.config,dt:.02}}), replay => ({...replay,format:NaN}),
      replay => ({...replay,commands:[contact(),{finish:true,elapsed:9}]}),
      replay => ({...replay,commands:[contact(),{finish:true,splits:[1]}]}),
      replay => ({...replay,commands:[contact()]}), replay => ({...replay,commands:Array(40001).fill({})}),
      replay => ({...replay,commands:[contact(),{events:['fall']},finish]}),
      replay => ({...replay,commands:[contact(),{events:['start']},contact(),finish]})
    ]) {
      const f = fixture(); f.setReplay(mutate(f.replay()));
      const board = f.step(contact()); f.update(board); await flush();
      expect(f.update(board).loss).toBeNull();
      f.controller.destroy();
    }
  });
  test('does not match unknown geometry, checkpoint changes or a different surface visit', async () => {
    const f = fixture(); const board = f.step(contact()); f.update(board); await flush();
    for (const change of [{surfaceId:null},{checkpoint:1},{visit:2},{available:false},{routePrefix:null}]) {
      expect(f.update({...board,...change})).toMatchObject({status:'unmatched',loss:null});
    }
  });
  test('matches the exact surface visit after a different earlier known ramp', async () => {
    const f = fixture({commands:[contact('a'),contact('c',8),finish]});
    f.update(f.step(contact('b'))); await flush();
    expect(f.update(f.step(contact('c')))).toMatchObject({status:'ready',loss:8});
  });
  test('an extra unrelated known detour does not force global ordinal alignment', async () => {
    const f = fixture({commands:[contact('a'),contact('c',8),finish]});
    f.update(f.step(contact('a'))); await flush();
    f.update(f.step(contact('b')));
    const current = f.step(contact('c'));
    expect(current.sequence).toBe(3);
    expect(current.visit).toBe(1);
    expect(f.update(current)).toMatchObject({status:'ready',loss:8});
  });
  test('an earlier unknown visit still prevents matching a later known surface', async () => {
    const f = fixture({commands:[contact('a'),contact('c',8),finish]});
    f.update(f.step(contact('missing'))); await flush();
    for (let tick = 0; tick < 4; tick++) f.step({});
    const current = f.step(contact('c'));
    expect(current.surfaceId).not.toBeNull();
    expect(current.routePrefix).toBeNull();
    expect(f.update(current)).toMatchObject({status:'unmatched',loss:null});
  });
  test('matches repeated surfaces by their visit, not by global board ordinal', async () => {
    const f = fixture({commands:[contact('a',2),contact('b',3),contact('a',7),finish]});
    f.update(f.step(contact('a'))); await flush();
    f.update(f.step(contact('b')));
    const third = f.step(contact('a'));
    expect(third.visit).toBe(2);
    expect(f.update(third)).toMatchObject({status:'ready',loss:7});
  });
  test('unknown reference geometry never borrows an ordinal clip', async () => {
    const f = fixture({commands:[contact('missing'),finish]});
    const board = f.step(contact()); f.update(board); await flush();
    expect(f.update(board)).toMatchObject({status:'unmatched',loss:null});
  });
  test('restores prototypes between slices while the live observer remains active', async () => {
    let yields = 0, resume;
    const f = fixture({commands:[contact(),...Array(40).fill({}),finish],yieldTask:async () => {
      if (++yields === 2) await new Promise(resolve => { resume = resolve; });
    }});
    const board = f.step(contact()); f.update(board); await flush();
    expect(yields).toBe(2);
    expect(f.adapter.Session.prototype.step).toBe(f.liveStep);
    expect(f.adapter.Movement.prototype.slide).toBe(f.liveSlide);
    expect(f.metrics.snapshot().board.loss).toBe(5);
    const liveSecond = f.step(contact('b',12));
    expect(liveSecond.loss).toBe(12);
    resume(); await flush();
    expect(f.observerErrors).toEqual([]);
    expect(f.adapter.Session.prototype.step).toBe(f.liveStep);
    expect(f.update(liveSecond)).toMatchObject({status:'unmatched',loss:null});
  });
  test('source switches and destroy discard stale asynchronous work', async () => {
    const f = fixture({source:'wr'}); let release;
    f.setRouteLoader(() => new Promise(resolve => { release = resolve; }));
    const board = f.step(contact()); f.update(board); await flush();
    f.settings.wrSource = 'leaderboard'; f.update(board); await flush();
    expect(f.update(board)).toMatchObject({status:'ready',loss:5});
    release({...f.replay(),commands:[contact('a',90),finish]}); await flush();
    expect(f.update(board)).toMatchObject({status:'ready',loss:5});
    f.controller.destroy();
    expect(f.update(board)).toMatchObject({status:'missing',loss:null});
    expect(f.adapter.Session.prototype.step).toBe(f.liveStep);
  });
  test('native replay exceptions restore wrappers and do not disable the real observer', async () => {
    const f = fixture({commands:[{throw:true},finish]});
    const board = f.step(contact()); f.update(board); await flush();
    expect(f.update(board)).toMatchObject({status:'missing',loss:null});
    expect(f.adapter.Session.prototype.step).toBe(f.liveStep);
    expect(f.adapter.Movement.prototype.slide).toBe(f.liveSlide);
    expect(f.step(contact('b',17)).loss).toBe(17);
    expect(f.observerErrors).toEqual([]);
  });
  test('does not add continuous clips or recontacts beyond the fixed entry deadline', async () => {
    for (const commands of [[contact('a',3),contact('a',40),finish], [contact('a',3),...Array(6).fill({}),contact('a',40),finish]]) {
      const f = fixture({commands});
      const board = f.step(contact()); f.update(board); await flush();
      expect(f.update(board)).toMatchObject({status:'ready',loss:3});
      f.controller.destroy();
    }
  });
  test('later unknown geometry does not invalidate an already matched route prefix', async () => {
    const f = fixture({commands:[contact('a',3),contact('missing'),finish]});
    const board = f.step(contact()); f.update(board); await flush();
    expect(f.update(board)).toMatchObject({status:'ready',loss:3});
  });
  test('cancellation during a slice yield leaves no wrappers installed', async () => {
    let yields = 0, resume;
    const f = fixture({commands:[contact(),...Array(40).fill({}),finish],yieldTask:async () => {
      if (++yields === 2) await new Promise(resolve => { resume = resolve; });
    }});
    const board = f.step(contact()); f.update(board); await flush();
    expect(yields).toBe(2);
    f.controller.destroy();
    f.observer.destroy();
    expect(f.adapter.Session.prototype.step).toBe(f.originalStep);
    expect(f.adapter.Movement.prototype.slide).toBe(f.originalSlide);
    resume(); await flush();
    expect(f.adapter.Session.prototype.step).toBe(f.originalStep);
    expect(f.adapter.Movement.prototype.slide).toBe(f.originalSlide);
    expect(f.update(board)).toMatchObject({status:'missing',loss:null});
  });
  test('evicts old map contexts from the bounded in-memory cache', async () => {
    const f = fixture(); const board = f.step(contact());
    for (let i = 0; i < 13; i++) {
      f.session.map = {...f.session.map,version:`map-${i}`};
      f.setReplay({...f.replay(),mapVersion:`map-${i}`});
      f.update(board); await flush();
      expect(f.update(board)).toMatchObject({status:'ready',loss:5});
    }
    expect(f.calls().replay).toHaveLength(13);
    f.session.map = {...f.session.map,version:'map-0'};
    f.setReplay({...f.replay(),mapVersion:'map-0'});
    expect(f.update(board)).toMatchObject({status:'loading',loss:null}); await flush();
    expect(f.calls().replay).toHaveLength(14);
    expect(f.update(board)).toMatchObject({status:'ready',loss:5});
  });
  test('uses bounded cached replay results across restarts without replay writes', async () => {
    const f = fixture(); let board = f.step(contact()); f.update(board); await flush();
    f.session.state.tick = 0; f.session.checkpointSpeeds = [];
    f.session.timer.state = {...f.session.timer.state,phase:'running',startTick:1};
    board = f.step(contact());
    expect(f.update(board)).toMatchObject({status:'ready',loss:5});
    expect(f.calls().replay).toEqual(['official-pb']);
  });

  test.each(['pb', 'wr'])('caches deterministic negative %s feedback across consumer visibility changes', async source => {
    // An otherwise valid download that never finishes is not a transient
    // download failure; the unchanged context cannot make it a valid baseline.
    const f = fixture({source, commands: [contact()]});
    const board = f.step(contact());
    f.update(board); await flush();
    expect(f.update(board)).toMatchObject({loss: null, status: 'unmatched', source});
    const native = f.native(), calls = structuredClone(f.calls());
    for (let i = 0; i < 3; i++) {
      f.controller.update(board, null, false);
      f.update(board); await flush();
      expect(f.update(board)).toMatchObject({loss: null, status: 'unmatched', source});
    }
    expect(f.native()).toEqual(native);
    expect(f.calls()).toEqual(calls);
    expect(native).toEqual({loads: 1, steps: 1});
  });
});

describe('Independent start and Board reference measurements', () => {
  test('returns the combined API and measures the fractional native start in the shared replay pass', async () => {
    const commands = startCommands();
    const f = fixture({startSource:'pb',commands});
    const board = f.step(contact('a',20));
    expect(f.references(board)).toMatchObject({
      board:{loss:null,status:'loading',source:'pb'},
      start:{speed:null,heightAboveFloor:null,status:'loading',source:'pb'}
    });
    await flush();
    expect(f.references(board)).toMatchObject({
      board:{loss:5,status:'ready',source:'pb'},
      start:{speed:350,heightAboveFloor:70,status:'ready',source:'pb'}
    });
    expect(f.calls()).toEqual({replay:['official-pb'],route:0});
    expect(f.native()).toEqual({loads:1,steps:commands.length});
  });

  test('starts loading before any Board exists and ignores continuous Board availability', async () => {
    const f = fixture({source:'fixed',startSource:'pb',commands:startCommands()});
    expect(f.references(null)).toMatchObject({
      board:{loss:null,status:'ready',source:'fixed'},
      start:{speed:null,heightAboveFloor:null,status:'loading',source:'pb'}
    });
    await flush();
    expect(f.references({available:false})).toMatchObject({
      board:{loss:null,status:'ready',source:'fixed'},
      start:{speed:350,heightAboveFloor:70,status:'ready',source:'pb'}
    });
    f.settings.boardColorReference = 'pb';
    expect(f.references(null)).toMatchObject({
      board:{loss:null,status:'unmatched',source:'pb'},
      start:{speed:350,heightAboveFloor:70,status:'ready',source:'pb'}
    });
    expect(f.native().loads).toBe(1);
  });

  test('uses grounded ticks before the start event when the exit is beyond platform support', async () => {
    const f = fixture({startSource:'pb',platformEdge:80,
      commands:startCommands({fromHeight:90,toHeight:90})});
    f.references(); await flush();
    expect(f.references().start).toEqual({speed:350,heightAboveFloor:-10,status:'ready',source:'pb'});
  });

  test('keeps known speed ready when neither a floor trace nor earlier ground support is available', async () => {
    const f = fixture({startSource:'pb',floorHeight:null,commands:startCommands({grounded:false})});
    f.references(); await flush();
    expect(f.references().start).toEqual({speed:350,heightAboveFloor:null,status:'ready',source:'pb'});
  });

  test('measures the actual solid platform, not the trigger bottom or the player hull height', async () => {
    for (const ducked of [false,true]) {
      const commands = startCommands({fromHeight:180,toHeight:160,grounded:false});
      commands[0].ducked = ducked;
      const f = fixture({startSource:'pb',floorHeight:150,commands});
      f.references(); await flush();
      expect(f.references().start).toEqual({speed:350,heightAboveFloor:20,status:'ready',source:'pb'});
      f.controller.destroy();
    }
  });

  test('unknown reference Board geometry does not invalidate a measured start', async () => {
    const f = fixture({startSource:'pb',commands:startCommands({brush:'missing'})});
    const board = f.step(contact());
    f.references(board); await flush();
    expect(f.references(board)).toMatchObject({
      board:{loss:null,status:'unmatched',source:'pb'},
      start:{speed:350,heightAboveFloor:70,status:'ready',source:'pb'}
    });
    expect(f.native().loads).toBe(1);
  });

  test('retains independent PB and selected WR measurements with one replay per source', async () => {
    for (const [source,startSource] of [['pb','wr'],['wr','pb']]) {
      const f = fixture({source,startSource,commands:startCommands()});
      f.setRouteLoader(async () => ({...f.replay(),commands:startCommands({speed:410,fromHeight:140,toHeight:120})}));
      const board = f.step(contact());
      f.references(board); await flush();
      expect(f.references(board)).toMatchObject({
        board:{loss:5,status:'ready',source},
        start:{speed:startSource === 'pb' ? 350 : 410,heightAboveFloor:startSource === 'pb' ? 70 : 30,status:'ready',source:startSource}
      });
      expect(f.native().loads).toBe(2);
      f.controller.destroy();
    }
  });

  test('deduplicates both selectors for the actual selected KSF or leaderboard route', async () => {
    for (const wrSource of ['ksf','leaderboard']) {
      const commands = startCommands({speed:390});
      const f = fixture({source:'wr',startSource:'wr',wrSource,commands});
      const board = f.step(contact());
      f.references(board); await flush();
      expect(f.references(board)).toMatchObject({
        board:{loss:5,status:'ready',source:'wr'},
        start:{speed:390,heightAboveFloor:70,status:'ready',source:'wr'}
      });
      expect(f.calls()).toEqual({replay:wrSource === 'leaderboard' ? ['rank-one'] : [],route:wrSource === 'ksf' ? 1 : 0});
      expect(f.native()).toEqual({loads:1,steps:commands.length});
      f.controller.destroy();
    }
  });

  test('switching WR source cancels its stale load without discarding ready PB work', async () => {
    const f = fixture({startSource:'wr',commands:startCommands()});
    let release;
    f.setRouteLoader(() => new Promise(resolve => { release = resolve; }));
    const loaded = [];
    f.setLoader(async id => {
      loaded.push(id);
      return {...f.replay(),commands:startCommands({speed:id === 'rank-one' ? 420 : 350})};
    });
    const board = f.step(contact());
    f.references(board); await flush();
    expect(f.references(board)).toMatchObject({
      board:{loss:5,status:'ready',source:'pb'},
      start:{speed:null,heightAboveFloor:null,status:'loading',source:'wr'}
    });
    f.settings.wrSource = 'leaderboard';
    expect(f.references(board).board).toEqual({loss:5,status:'ready',source:'pb'});
    await flush();
    expect(f.references(board).start).toEqual({speed:420,heightAboveFloor:70,status:'ready',source:'wr'});
    release({...f.replay(),commands:startCommands({speed:900})}); await flush();
    expect(f.references(board).start.speed).toBe(420);
    expect(loaded).toEqual(['official-pb','rank-one']);
    expect(f.native().loads).toBe(2);
  });

  test('cancels an in-progress WR native slice without invalidating the cached PB slot', async () => {
    let yields = 0, resume;
    const f = fixture({startSource:'wr',commands:startCommands(),yieldTask:async () => {
      if (++yields === 3) await new Promise(resolve => { resume = resolve; });
    }});
    f.setRouteLoader(async () => ({...f.replay(),commands:[...startCommands().slice(0,-1),...Array(40).fill({}),finish]}));
    const board = f.step(contact());
    f.references(board); await flush();
    expect(yields).toBe(3);
    expect(f.references(board).board.status).toBe('ready');
    f.settings.wrSource = 'leaderboard';
    expect(f.references(board).board.status).toBe('ready');
    expect(f.adapter.Session.prototype.step).toBe(f.liveStep);
    expect(f.adapter.Movement.prototype.slide).toBe(f.liveSlide);
    resume(); await flush();
    expect(f.references(board)).toMatchObject({
      board:{loss:5,status:'ready',source:'pb'},
      start:{speed:350,heightAboveFloor:70,status:'ready',source:'wr'}
    });
    expect(f.calls().replay).toEqual(['official-pb','rank-one']);
    expect(f.observerErrors).toEqual([]);
  });

  test('keeps the pre-run official PB start frozen through finish and refreshes only at ready', async () => {
    const f = fixture({source:'fixed',startSource:'pb',commands:startCommands()});
    const requested = [];
    f.setLoader(async id => {
      requested.push(id);
      return {...f.replay(),commands:startCommands({speed:id === 'new-pb' ? 430 : 350})};
    });
    f.session.timer.state = {...f.session.timer.state,phase:'ready',startTick:null};
    f.references(); await flush();
    f.session.timer.state = {...f.session.timer.state,phase:'running',startTick:0};
    f.references(); await flush();
    f.setOwn({...entry,runId:'new-pb'});
    f.step(finish);
    expect(f.references().start.speed).toBe(350);
    expect(requested).toEqual(['official-pb']);
    f.session.state.tick = 0; f.session.checkpointSpeeds = [];
    f.session.timer.state = {...f.session.timer.state,phase:'ready',startTick:null};
    f.references(); await flush();
    expect(f.references().start.speed).toBe(430);
    expect(requested).toEqual(['official-pb','new-pb']);
  });

  test('never invents a PB start from a local finish or an unrelated WR', async () => {
    const f = fixture({source:'wr',startSource:'pb',commands:startCommands()});
    f.setOwn(null);
    f.step(finish); f.references(); await flush();
    expect(f.references().start).toEqual({speed:null,heightAboveFloor:null,status:'missing',source:'pb'});
    expect(f.calls()).toEqual({replay:[],route:1});
    f.settings.startColorReference = 'fixed';
    expect(f.references().start).toEqual({speed:null,heightAboveFloor:null,status:'ready',source:'fixed'});
  });

  test('a completed replay without a native start never fabricates a start baseline', async () => {
    const f = fixture({startSource:'pb'});
    const board = f.step(contact());
    f.references(board); await flush();
    expect(f.references(board)).toMatchObject({
      board:{loss:5,status:'ready',source:'pb'},
      start:{speed:null,heightAboveFloor:null,status:'unmatched',source:'pb'}
    });
  });

  test('applies official replay validation before exposing an otherwise measured start', async () => {
    for (const mutate of [
      replay => ({...replay,mapId:'other'}),
      replay => ({...replay,mapVersion:'other'}),
      replay => ({...replay,config:{...replay.config,dt:.02}}),
      replay => ({...replay,format:NaN}),
      replay => ({...replay,commands:[...replay.commands.slice(0,-1),{finish:true,elapsed:9}]}),
      replay => ({...replay,commands:[...replay.commands.slice(0,-1),{finish:true,splits:[1]}]}),
      replay => ({...replay,commands:replay.commands.slice(0,-1)}),
      replay => ({...replay,commands:[...replay.commands.slice(0,-1),{events:['fall']},finish]})
    ]) {
      const f = fixture({startSource:'pb',commands:startCommands()});
      f.setReplay(mutate(f.replay()));
      f.references(); await flush();
      expect(f.references().start).toEqual({speed:null,heightAboveFloor:null,status:'unmatched',source:'pb'});
      f.controller.destroy();
    }
  });

  test('does not serialize an unchanged native map/config context on every HUD update', async () => {
    const f = fixture({startSource:'pb',commands:startCommands()});
    const values = {...f.session.config};
    let serializations = 0;
    f.session.config.toJSON = () => { serializations++; return values; };
    f.references(); await flush();
    serializations = 0;
    for (let frame = 0; frame < 40; frame++) f.references();
    expect(serializations).toBe(0);
    expect(f.native().loads).toBe(1);
  });

  test('reuses the finished start measurement from the bounded replay cache across restarts', async () => {
    const f = fixture({startSource:'pb',commands:startCommands()});
    f.references(); await flush();
    f.session.state.tick = 0; f.session.checkpointSpeeds = [];
    f.session.timer.state = {...f.session.timer.state,phase:'running',startTick:1};
    expect(f.references().start).toEqual({speed:350,heightAboveFloor:70,status:'ready',source:'pb'});
    expect(f.native().loads).toBe(1);
    f.controller.destroy();
    expect(f.references().start).toEqual({speed:null,heightAboveFloor:null,status:'missing',source:'pb'});
  });
});

describe('Shared official replay identities', () => {
  test('shares PB and leaderboard work when both selectors name the same official run', async () => {
    const commands = startCommands();
    const f = fixture({source:'pb',startSource:'wr',wrSource:'leaderboard',commands});
    f.setRecord({...entry,splitsUs:[]});
    const board = f.step(contact());
    f.references(board); await flush();
    expect(f.references(board)).toMatchObject({
      board:{loss:5,status:'ready',source:'pb'},
      start:{speed:350,heightAboveFloor:70,status:'ready',source:'wr'}
    });
    expect(f.calls()).toEqual({replay:['official-pb'],route:0});
    expect(f.native()).toEqual({loads:1,steps:commands.length});
    f.settings.startColorReference = 'fixed';
    f.references(board);
    f.settings.boardColorReference = 'wr';
    expect(f.references(board).board).toEqual({loss:5,status:'ready',source:'wr'});
    expect(f.native().loads).toBe(1);
  });
});

const surfCommands = (loss = 5, speed = 100, brush = 'a') => [
  ...Array.from({length:4}, () => ({...contact(brush,loss),speed})),
  {...finish,events:['finish']}
];
const finishLiveSurf = (f, loss = 20, speed = 100) => {
  for (const command of surfCommands(loss,speed)) f.step(command);
  return f.metrics.snapshot().surf;
};

describe('Matched completed Surf references', () => {
  test('compares completed endpoint Surf against the same PB ramp without changing the raw measurement', async () => {
    const f = fixture({surfSource:'pb',commands:surfCommands()});
    const actual = finishLiveSurf(f);
    expect(actual).toMatchObject({available:true,loss:20,visit:1,checkpoint:0});
    expect(f.references().surf).toEqual({loss:null,status:'loading',source:'pb'});
    await flush();
    expect(f.references()).toMatchObject({
      board:{loss:5,status:'ready',source:'pb'},
      surf:{loss:5,status:'ready',source:'pb'}
    });
    expect(f.metrics.snapshot().surf).toEqual(actual);
    expect(f.native().loads).toBe(1);
  });

  test('Down and Up compare against the same matched visit and add up to its Surf reference', async () => {
    const f = fixture({surfSource:'pb',commands:surfCommands()});
    const actual = finishLiveSurf(f);
    expect(actual.downLoss + actual.upLoss).toBeCloseTo(actual.loss, 9);
    expect(f.references()).toMatchObject({down:{status:'loading',source:'pb'},up:{status:'loading',source:'pb'}});
    await flush();
    const refs = f.references();
    expect(refs.down).toMatchObject({status:'ready',source:'pb'});
    expect(refs.up).toMatchObject({status:'ready',source:'pb'});
    expect(Number.isFinite(refs.down.loss) && Number.isFinite(refs.up.loss)).toBe(true);
    expect(refs.down.loss + refs.up.loss).toBeCloseTo(refs.surf.loss, 9);
    f.settings.showSurf = false;
    expect(f.references()).toMatchObject({down:{source:'fixed'},up:{source:'fixed'}});
  });

  test('retains signed reference gains rather than clamping them into zero-loss baselines', async () => {
    const f = fixture({source:'fixed',surfSource:'wr',commands:surfCommands(0,120)});
    const actual = finishLiveSurf(f,0,105);
    expect(actual.loss).toBe(-5);
    f.references(); await flush();
    expect(f.references().surf).toEqual({loss:-20,status:'ready',source:'wr'});
  });

  test('compares imported Boreas-style routes with different version labels and start caps', async () => {
    const f = fixture({source:'wr',surfSource:'wr',commands:surfCommands()});
    f.session.config.version = 'css-surf-capped-1';
    f.setReplay({...f.replay(),format:1,config:{...f.session.config,version:'css-surf-bhop-3',unrestrictedStart:true}});
    const actual = finishLiveSurf(f);
    f.references(); await flush();
    expect(f.references()).toMatchObject({board:{status:'ready',loss:5},surf:{status:'ready',loss:5}});
    expect(actual.loss).toBe(20);
  });

  test('still rejects real movement differences in imported reference configs', async () => {
    for (const patch of [{gravity:600},{airAccelerate:100},{startPolicy:'other'},{unexpectedMovementRule:true}]) {
      const f = fixture({source:'wr',surfSource:'wr',commands:surfCommands()});
      f.setReplay({...f.replay(),config:{...f.session.config,...patch}});
      finishLiveSurf(f);
      f.references(); await flush();
      expect(f.references()).toMatchObject({board:{status:'unmatched'},surf:{status:'unmatched'}});
    }
  });

  test('matches held Surf identity after the current Board has already moved onto another ramp', async () => {
    const commands = [...surfCommands().slice(0,-1),...surfCommands(8,100,'b')];
    const f = fixture({surfSource:'pb',commands});
    for (let i = 0; i < 4; i++) f.step(contact('a',20));
    f.step(contact('b',10));
    const m = f.metrics.snapshot();
    expect(m.board.surfaceId).not.toBe(m.surf.surfaceId);
    f.references(); await flush();
    expect(f.references()).toMatchObject({board:{loss:8,status:'ready'},surf:{loss:5,status:'ready'}});
  });

  test('never substitutes another visit, checkpoint, unknown geometry or untrusted route history', async () => {
    const f = fixture({surfSource:'pb',commands:surfCommands()});
    const actual = finishLiveSurf(f);
    f.references(); await flush();
    expect(f.references().surf.status).toBe('ready');
    for (const patch of [{visit:2},{checkpoint:1},{surfaceId:null},{routePrefix:null},{available:false}]) {
      const result = f.controller.update(f.metrics.snapshot().board,{...actual,...patch});
      expect(result.surf).toMatchObject({status:'unmatched',loss:null});
    }
  });

  test('a valid Board without a completed reference Surf stays unmatched, never a Board-loss fallback', async () => {
    const f = fixture({surfSource:'pb',commands:[contact(),{...finish,events:['finish']}]});
    finishLiveSurf(f);
    f.references(); await flush();
    expect(f.references()).toMatchObject({board:{status:'ready',loss:5},surf:{status:'unmatched',loss:null}});
    f.setOwn(null);
    f.session.timer.state.phase = 'ready'; f.references(); await flush();
    expect(f.references().surf).toMatchObject({status:'missing',loss:null,source:'pb'});
  });

  test('Surf WR source changes preserve independent PB Board work and never mix KSF with leaderboard', async () => {
    const f = fixture({surfSource:'wr',commands:surfCommands()});
    f.setRouteLoader(async () => ({...f.replay(),commands:surfCommands(7)}));
    f.setLoader(async id => ({...f.replay(),commands:surfCommands(id === 'rank-one' ? 9 : 5)}));
    finishLiveSurf(f); f.references(); await flush();
    expect(f.references()).toMatchObject({board:{loss:5,status:'ready'},surf:{loss:7,status:'ready',source:'wr'}});
    f.settings.wrSource = 'leaderboard';
    expect(f.references()).toMatchObject({board:{loss:5,status:'ready'},surf:{loss:null,status:'loading'}});
    await flush();
    expect(f.references()).toMatchObject({board:{loss:5,status:'ready'},surf:{loss:9,status:'ready'}});
  });

  test('disabled Surf and continuous analysis do not request it, and restoring the consumer reuses its route', async () => {
    const f = fixture({source:'fixed',surfSource:'pb',commands:surfCommands()});
    finishLiveSurf(f);
    f.settings.showSurf = false;
    expect(f.references().surf.source).toBe('fixed');
    await flush();
    expect(f.native().loads).toBe(0);
    f.settings.showSurf = true; f.references(); await flush();
    expect(f.references().surf).toMatchObject({loss:5,status:'ready',source:'pb'});
    f.settings.continuousFeedback = true;
    expect(f.references().surf.source).toBe('fixed');
    f.settings.continuousFeedback = false;
    expect(f.references().surf).toMatchObject({loss:5,status:'ready',source:'pb'});
    expect(f.native().loads).toBe(1);
  });
});

function checkpointsFor(f, settings = {checkpointReference:'pb'}) {
  const controller = createCheckpointReferences({getSession:() => f.session,getAdapter:() => f.adapter,
    getReferences:f.getReferences,replayStore:f.replayStore,settings,storage:null});
  cleanups.push(() => controller.destroy());
  return controller;
}

describe('Shared checkpoint and feedback replay lifecycle', () => {
  test('checkpoint-only passes skip feedback observation and later feedback upgrades stay cached', async () => {
    const f = fixture({shared:true,source:'fixed',commands:startCommands()});
    const checkpoints = checkpointsFor(f);
    const board = f.step(contact());
    checkpoints.update(); f.references(); await flush();
    expect(checkpoints.update()).toMatchObject({own:[],ownStatus:'ready'});
    expect(f.feedbackSteps()).toBe(0);
    f.settings.boardColorReference = 'pb';
    expect(f.update(board)).toMatchObject({status:'loading',loss:null});
    await flush();
    expect(f.update(board)).toMatchObject({status:'ready',loss:5});
    expect(f.feedbackSteps()).toBe(f.replay().commands.length);
    f.settings.showBoard = false; f.update(board);
    checkpoints.update();
    f.settings.showBoard = true;
    expect(f.update(board)).toMatchObject({status:'ready',loss:5});
    expect(f.feedbackSteps()).toBe(f.replay().commands.length);
  });

  test('feedback joining the initial yield shares one feedback-capable native pass', async () => {
    let resume;
    const f = fixture({shared:true,yieldTask:() => new Promise(resolve => { resume = resolve; })});
    const checkpoints = checkpointsFor(f);
    const board = f.step(contact());
    checkpoints.update(); await flush();
    expect(f.native()).toEqual({loads:0,steps:0});
    f.update(board);
    resume(); await flush();
    expect(checkpoints.update()).toMatchObject({ownStatus:'ready',own:[]});
    expect(f.update(board)).toMatchObject({status:'ready',loss:5});
    expect(f.calls().replay).toEqual(['official-pb']);
    expect(f.native()).toEqual({loads:1,steps:f.replay().commands.length});
    expect(f.feedbackSteps()).toBe(f.replay().commands.length);
  });

  test('feedback joining a running checkpoint pass upgrades its in-flight download', async () => {
    let yields = 0, resume;
    const commands = [contact(),...Array(40).fill({}),finish];
    const f = fixture({shared:true,commands,yieldTask:async () => {
      if (++yields === 2) await new Promise(resolve => { resume = resolve; });
    }});
    const checkpoints = checkpointsFor(f);
    const board = f.step(contact());
    checkpoints.update(); await flush();
    expect(f.native().steps).toBe(32);
    expect(f.feedbackSteps()).toBe(0);
    expect(f.update(board)).toMatchObject({status:'loading',loss:null});
    resume(); await flush();
    expect(checkpoints.update()).toMatchObject({ownStatus:'ready',own:[]});
    expect(f.update(board)).toMatchObject({status:'ready',loss:5});
    expect(f.calls().replay).toEqual(['official-pb']);
    expect(f.feedbackSteps()).toBe(commands.length);
  });

  test('one official load and pass serves checkpoints, Board, Surf, Start and equal PB/WR identities', async () => {
    const commands = [...startCommands().slice(0,-2),...surfCommands(5,350)];
    const f = fixture({shared:true,source:'pb',startSource:'wr',surfSource:'pb',wrSource:'leaderboard',commands});
    f.setRecord(entry);
    const checkpoints = checkpointsFor(f, {wrSource:'leaderboard'});
    finishLiveSurf(f);
    checkpoints.update(); f.references(); await flush();
    expect(checkpoints.update()).toMatchObject({own:[],record:[],ownStatus:'ready',recordStatus:'ready'});
    expect(f.references()).toMatchObject({
      board:{status:'ready',loss:5},surf:{status:'ready',loss:5},start:{status:'ready',speed:350}
    });
    for (let i = 0; i < 10; i++) { checkpoints.update(); f.references(); }
    expect(f.calls()).toEqual({replay:['official-pb'],route:0});
    expect(f.native()).toEqual({loads:1,steps:commands.length});
  });

  test('hiding either pending consumer leaves the other consumer on the original job', async () => {
    for (const hidden of ['checkpoint','feedback']) {
      const f = fixture({shared:true});
      const checkpoints = checkpointsFor(f);
      let release;
      f.setLoader(() => new Promise(resolve => { release = resolve; }));
      const board = f.step(contact());
      checkpoints.update(); f.update(board); await flush();
      if (hidden === 'checkpoint') checkpoints.update(false);
      else f.controller.update(board,null,false);
      release(f.replay()); await flush();
      if (hidden === 'checkpoint') {
        expect(checkpoints.update(false).ownStatus).toBe('missing');
        expect(f.update(board)).toMatchObject({status:'ready',loss:5});
        expect(checkpoints.update()).toMatchObject({ownStatus:'ready',own:[]});
      } else {
        expect(checkpoints.update()).toMatchObject({ownStatus:'ready',own:[]});
        f.setLoader(async () => f.replay());
        expect(f.update(board)).toMatchObject({status:'loading',loss:null});
        await flush();
        expect(f.update(board)).toMatchObject({status:'ready',loss:5});
      }
      checkpoints.destroy(); f.controller.destroy();
    }
  });

  test('hiding every consumer pauses before native construction; showing again resumes without downloading again', async () => {
    const f = fixture({shared:true}), checkpoints = checkpointsFor(f);
    let release, loads = 0;
    f.setLoader(() => { loads++; return new Promise(resolve => { release = resolve; }); });
    const board = f.step(contact());
    checkpoints.update(); f.update(board); await flush();
    checkpoints.update(false); f.controller.update(board,null,false);
    release(f.replay()); await flush();
    expect(f.native()).toEqual({loads:0,steps:0});
    expect(checkpoints.update(false).ownStatus).toBe('missing');
    f.controller.update(board,null,false); await flush();
    expect(loads).toBe(1);
    checkpoints.update(); f.update(board); await flush();
    expect(loads).toBe(1);
    expect(checkpoints.update().ownStatus).toBe('ready');
    expect(f.update(board)).toMatchObject({status:'ready',loss:5});
    expect(f.native().loads).toBe(1);
  });

  test('a sole hidden feedback consumer cancels a yielded pass without retaining prototype wrappers', async () => {
    let yields = 0, resume;
    const f = fixture({commands:[contact(),...Array(40).fill({}),finish],yieldTask:async () => {
      if (++yields === 2) await new Promise(resolve => { resume = resolve; });
    }});
    const board = f.step(contact()); f.update(board); await flush();
    expect(f.native().steps).toBe(32);
    f.controller.update(board,null,false);
    resume(); await flush();
    expect(f.native().steps).toBe(32);
    expect(f.adapter.Session.prototype.step).toBe(f.liveStep);
    expect(f.adapter.Movement.prototype.slide).toBe(f.liveSlide);
  });

  test('hiding feedback during a shared pass stops observation but completes checkpoint reconstruction', async () => {
    let yields = 0, resume;
    const commands = [contact(), ...Array(40).fill({}), finish];
    const f = fixture({shared: true, commands, yieldTask: async () => {
      if (++yields === 2) await new Promise(resolve => { resume = resolve; });
    }});
    const checkpoints = checkpointsFor(f);
    const board = f.step(contact());
    checkpoints.update(); f.update(board); await flush();
    expect(f.native().steps).toBe(32);
    expect(f.feedbackSteps()).toBe(32);
    f.settings.showBoard = false; f.update(board);
    resume(); await flush();
    expect(checkpoints.update()).toMatchObject({ownStatus: 'ready', own: []});
    expect(f.native()).toEqual({loads: 1, steps: commands.length});
    expect(f.feedbackSteps()).toBe(32);
    expect(f.adapter.Session.prototype.step).toBe(f.liveStep);
    expect(f.adapter.Movement.prototype.slide).toBe(f.liveSlide);
    f.settings.showBoard = true; f.update(board); await flush();
    expect(f.update(board)).toMatchObject({status: 'ready', loss: 5});
    expect(f.native()).toEqual({loads: 2, steps: commands.length * 2});
    expect(f.feedbackSteps()).toBe(32 + commands.length);
  });

  test('start ticks and checkpoint-array restarts preserve pending WR work and the frozen PB identity', async () => {
    const f = fixture({shared:true,source:'wr',startSource:'pb',commands:startCommands()});
    const checkpoints = checkpointsFor(f);
    let releaseOwn, releaseRoute, ownLoads = 0, routeLoads = 0;
    f.setLoader(() => { ownLoads++; return new Promise(resolve => { releaseOwn = resolve; }); });
    f.setRouteLoader(() => { routeLoads++; return new Promise(resolve => { releaseRoute = resolve; }); });
    const board = f.step(contact());
    checkpoints.update(); f.references(board); await flush();
    for (let i = 1; i <= 3; i++) {
      f.session.checkpointSpeeds = []; f.session.state.tick = 0; f.session.timer.state.startTick = i;
      checkpoints.update(); f.references(board); await flush();
    }
    f.setOwn({...entry,runId:'new-pb'});
    f.session.timer.state.phase = 'finished';
    checkpoints.update(); f.references(board);
    releaseOwn(f.replay()); releaseRoute(f.replay()); await flush();
    expect(ownLoads).toBe(1); expect(routeLoads).toBe(1);
    expect(checkpoints.update()).toMatchObject({ownStatus:'ready',ownEntry:entry});
    expect(f.references(board)).toMatchObject({board:{status:'ready',loss:5},start:{status:'ready',speed:350}});
    expect(f.native().loads).toBe(2);
  });

  test('KSF checkpoint cache survives source switches and map revisits and supplies late feedback', async () => {
    const f = fixture({shared:true,source:'fixed'});
    const settings = {checkpointReference:'wr',wrSource:'ksf'}, checkpoints = checkpointsFor(f,settings);
    const board = f.step(contact()), originalMap = f.session.map, originalReplay = f.replay();
    checkpoints.update(); await flush();
    settings.wrSource = 'leaderboard'; checkpoints.update(); await flush();
    settings.wrSource = 'ksf';
    expect(checkpoints.update()).toMatchObject({recordStatus:'ready',record:[]});
    f.session.map = {...originalMap,version:'map-2'};
    f.setReplay({...originalReplay,mapVersion:'map-2'});
    checkpoints.update(); await flush();
    f.session.map = originalMap; f.setReplay(originalReplay);
    expect(checkpoints.update()).toMatchObject({recordStatus:'ready',record:[]});
    f.settings.boardColorReference = 'wr';
    expect(f.update(board)).toMatchObject({status:'loading',loss:null});
    await flush();
    expect(f.update(board)).toMatchObject({status:'ready',loss:5});
  });

  test('checkpoint metadata stays usable when imported movement or feedback reset validation fails', async () => {
    for (const incompatible of ['physics','teleport','geometry']) {
      const f = fixture({shared:true,source:'wr'});
      const checkpoints = checkpointsFor(f,{checkpointReference:'wr'});
      f.setReplay(incompatible === 'physics' ? {...f.replay(),config:{...f.session.config,gravity:600}} :
        {...f.replay(),commands:incompatible === 'teleport' ? [contact(),{events:['teleport']},finish] : [contact('unknown'),finish]});
      const board = f.step(contact()); checkpoints.update(); f.update(board); await flush();
      expect(checkpoints.update()).toMatchObject({recordStatus:'ready',record:[],recordTimeUs:10000000});
      expect(f.update(board)).toMatchObject({status:'unmatched',loss:null});
      expect(f.native().loads).toBe(1);
      checkpoints.destroy(); f.controller.destroy();
    }
  });

  test('official exact-config checkpoint rejection does not reject movement-compatible feedback', async () => {
    const f = fixture({shared:true}), checkpoints = checkpointsFor(f);
    f.setReplay({...f.replay(),config:{...f.session.config,version:'historical-label',unrestrictedStart:true}});
    const board = f.step(contact()); checkpoints.update(); f.update(board); await flush();
    expect(checkpoints.update()).toMatchObject({ownStatus:'missing',own:null});
    expect(f.update(board)).toMatchObject({status:'ready',loss:5});
    expect(f.native()).toEqual({loads:1,steps:f.replay().commands.length});
  });

  test('native adoption reuses movement feedback across panel lifetimes while validating newly compatible checkpoints', async () => {
    const f = fixture({shared: true});
    f.setReplay({...f.replay(), config: {...f.session.config, version: 'historical-label', unrestrictedStart: true}});
    const reference = createRampReference({getSession: () => f.session, getReferences: f.getReferences,
      getAdapter: () => f.adapter, replayStore: f.replayStore, settings: f.settings});
    cleanups.push(() => reference.destroy());
    const consumer = reference.createConsumer(), key = `${f.session.map.id}:${f.session.map.version}`;
    const original = consumer.get(key, 'pb');
    await flush();
    expect([...original.ramps.values()][0].board).toBe(5);
    // Native Watch adopts the replay's format and labels: the summary is keyed
    // by the replay, so the movement feedback carries over as it is.
    f.session.config = f.replay().config;
    f.session.replayFormat = f.replay().format;
    consumer.release();
    const reopened = reference.createConsumer();
    expect([...reopened.get(key, 'pb').ramps.values()][0].board).toBe(5);
    expect(f.native().loads).toBe(1);
    const checkpoints = checkpointsFor(f);
    checkpoints.update();
    await flush();
    expect(checkpoints.update()).toMatchObject({ownStatus: 'ready', own: []});
    expect(f.native().loads).toBe(2);
    reopened.release();
    expect([...reopened.get(key, 'pb').ramps.values()][0].board).toBe(5);
    expect(f.native().loads).toBe(2);
  });

  test('switching feedback WR source cannot cancel KSF still required by checkpoints', async () => {
    const f = fixture({shared:true,source:'wr'});
    const checkpoints = checkpointsFor(f,{checkpointReference:'wr'});
    let release;
    f.setRouteLoader(() => new Promise(resolve => { release = resolve; }));
    const board = f.step(contact());
    checkpoints.update(); f.update(board); await flush();
    f.settings.wrSource = 'leaderboard'; f.update(board); await flush();
    expect(f.update(board)).toMatchObject({status:'ready',loss:5});
    release({...f.replay(),commands:[contact('a',9),finish]}); await flush();
    expect(checkpoints.update()).toMatchObject({recordStatus:'ready',record:[]});
    f.setRouteLoader(async () => ({...f.replay(),commands:[contact('a',9),finish]}));
    f.settings.wrSource = 'ksf';
    expect(f.update(board)).toMatchObject({status:'loading',loss:null});
    await flush();
    expect(f.update(board)).toMatchObject({status:'ready',loss:9});
  });
});

describe('Independent movement feedback visibility', () => {
  test('selects the newest enabled held type, never an unavailable or disabled fallback', () => {
    const metrics = {air:{tick:20,available:true},surf:{tick:10,available:true}};
    expect(selectFeedbackType(metrics, {})).toBe('air');
    expect(selectFeedbackType(metrics, {showAir:false})).toBe('surf');
    expect(selectFeedbackType({...metrics,surf:{tick:30,available:false}}, {})).toBe('surf');
    expect(selectFeedbackType({...metrics,surf:{tick:30}}, {showSurf:false})).toBe('air');
    expect(selectFeedbackType({...metrics,surf:{tick:20}}, {})).toBe('surf');
    expect(selectFeedbackType({air:metrics.air}, {showAir:false})).toBe('surf');
    expect(selectFeedbackType({surf:metrics.surf}, {showSurf:false})).toBe('air');
    expect(selectFeedbackType(metrics, {showAir:false,showSurf:false})).toBeNull();
  });

  test('maps live free-air to Air and ramp input to Surf without enabling the other type', () => {
    const settings = {continuousFeedback:true};
    expect(selectFeedbackType({strafe:{mode:'air'}}, settings)).toBe('air');
    expect(selectFeedbackType({strafe:{mode:'surf'}}, settings)).toBe('surf');
    expect(selectFeedbackType({strafe:{mode:'air'}}, {...settings,showAir:false})).toBe('surf');
    expect(selectFeedbackType({strafe:{mode:'surf'}}, {...settings,showSurf:false})).toBe('air');
    expect(selectFeedbackType({strafe:{mode:'surf'}}, {...settings,showAir:false,showSurf:false})).toBeNull();
  });

  test('Board, Air and Surf preferences gate only their own reference consumers', async () => {
    const f = fixture({source:'pb',surfSource:'wr',commands:surfCommands()});
    finishLiveSurf(f);
    f.settings.showBoard = false;
    f.settings.showAir = false;
    f.references(); await flush();
    expect(f.calls()).toEqual({replay:[],route:1});
    expect(f.references()).toMatchObject({
      board:{source:'fixed'},surf:{source:'wr',status:'ready',loss:5}
    });
    f.settings.showSurf = false;
    f.settings.showAir = true;
    f.references(); await flush();
    expect(f.calls()).toEqual({replay:[],route:1});
    f.settings.showBoard = true;
    f.references(); await flush();
    expect(f.references()).toMatchObject({
      board:{source:'pb',status:'ready',loss:5},surf:{source:'fixed'}
    });
    expect(f.calls()).toEqual({replay:['official-pb'],route:1});
    f.settings.showBoard = false; f.settings.showSurf = true;
    expect(f.references().surf).toMatchObject({source:'wr',status:'ready',loss:5});
    expect(f.native().loads).toBe(2);
  });

  test('hiding pending Board cancels its unused PB without cancelling active Surf and Start WR', async () => {
    const commands = [...startCommands().slice(0,-2),...surfCommands(5,350)];
    const f = fixture({source:'pb',surfSource:'wr',startSource:'wr',commands});
    let releaseBoard, releaseRoute, boardLoads = 0, routeLoads = 0;
    f.setLoader(() => { boardLoads++; return new Promise(resolve => { releaseBoard = resolve; }); });
    f.setRouteLoader(() => { routeLoads++; return new Promise(resolve => { releaseRoute = resolve; }); });
    finishLiveSurf(f);
    f.references(); await flush();
    f.settings.showBoard = false;
    f.references();
    releaseBoard(f.replay()); releaseRoute(f.replay()); await flush();
    expect(f.native()).toEqual({loads:1,steps:commands.length});
    expect(f.references()).toMatchObject({
      board:{source:'fixed'},surf:{source:'wr',status:'ready',loss:5},
      start:{source:'wr',status:'ready',speed:350}
    });
    // Shown again within the grace period: the PB already downloaded is analysed, not fetched again.
    f.settings.showBoard = true;
    expect(f.references().board.status).toBe('loading'); await flush();
    expect(f.references().board).toMatchObject({source:'pb',status:'ready',loss:5});
    expect(boardLoads).toBe(1); expect(routeLoads).toBe(1);
    expect(f.native().loads).toBe(2);
  });

  test('shared pending work survives each hidden feedback consumer and cached results survive hiding all', async () => {
    const commands = [...startCommands().slice(0,-2),...surfCommands(5,350)];
    const f = fixture({source:'pb',surfSource:'pb',startSource:'pb',commands});
    let release, loads = 0;
    f.setLoader(() => { loads++; return new Promise(resolve => { release = resolve; }); });
    finishLiveSurf(f);
    f.references(); await flush();
    f.settings.showBoard = false; f.references();
    f.settings.showSurf = false; f.references();
    release(f.replay()); await flush();
    expect(f.references().start).toMatchObject({source:'pb',status:'ready',speed:350});
    expect(f.native()).toEqual({loads:1,steps:commands.length});
    f.settings.showStart = false; f.references();
    f.settings.showBoard = f.settings.showSurf = f.settings.showStart = true;
    expect(f.references()).toMatchObject({
      board:{status:'ready',loss:5},surf:{status:'ready',loss:5},start:{status:'ready',speed:350}
    });
    expect(loads).toBe(1);
    expect(f.native().loads).toBe(1);
  });

  test('disabled Surf releases its WR consumer and reenabling selects the correct cached source', async () => {
    const f = fixture({source:'fixed',surfSource:'wr',commands:surfCommands()});
    finishLiveSurf(f);
    f.settings.showSurf = false; f.references(); await flush();
    expect(f.calls()).toEqual({replay:[],route:0});
    f.settings.showSurf = true; f.references(); await flush();
    expect(f.references().surf).toMatchObject({source:'wr',status:'ready',loss:5});
    f.settings.showSurf = false; f.references();
    f.settings.wrSource = 'leaderboard'; f.references(); await flush();
    expect(f.calls()).toEqual({replay:[],route:1});
    f.settings.showSurf = true; f.references(); await flush();
    expect(f.references().surf).toMatchObject({source:'wr',status:'ready',loss:5});
    f.settings.showSurf = false; f.references();
    f.settings.wrSource = 'ksf'; f.settings.showSurf = true;
    expect(f.references().surf).toMatchObject({source:'wr',status:'ready',loss:5});
    expect(f.calls()).toEqual({replay:['rank-one'],route:1});
    expect(f.native().loads).toBe(2);
  });

  test('enabled references prefetch before results and live mode leaves only the independent Start consumer', async () => {
    const f = fixture({source:'pb',surfSource:'pb',startSource:'wr',commands:startCommands()});
    f.settings.continuousFeedback = true;
    f.settings.showStart = false; f.references(null); await flush();
    expect(f.calls()).toEqual({replay:[],route:0});
    f.settings.showStart = true; f.references(null); await flush();
    expect(f.references(null)).toMatchObject({
      board:{source:'fixed'},surf:{source:'fixed'},start:{source:'wr',status:'ready',speed:350}
    });
    f.settings.continuousFeedback = false;
    f.settings.showStart = false; f.references(null); await flush();
    expect(f.references(null).board).toMatchObject({source:'pb',status:'unmatched'});
    expect(f.calls()).toEqual({replay:['official-pb'],route:1});
    const board = f.step(contact());
    expect(f.references(board).board).toMatchObject({source:'pb',status:'ready',loss:5});
    f.settings.showStart = true;
    expect(f.references(board).start).toMatchObject({source:'wr',status:'ready',speed:350});
    expect(f.native().loads).toBe(2);
  });

  test('hiding Board keeps the checkpoint consumer on its original pending replay', async () => {
    const f = fixture({shared:true}), checkpoints = checkpointsFor(f);
    let release;
    f.setLoader(() => new Promise(resolve => { release = resolve; }));
    const board = f.step(contact());
    checkpoints.update(); f.update(board); await flush();
    f.settings.showBoard = false; f.update(board);
    release(f.replay()); await flush();
    expect(checkpoints.update()).toMatchObject({ownStatus:'ready',own:[]});
    expect(f.update(board).source).toBe('fixed');
    f.settings.showBoard = true;
    f.update(board); await flush();
    release(f.replay()); await flush();
    expect(f.update(board)).toMatchObject({source:'pb',status:'ready',loss:5});
  });

  test('hiding Board alone pauses a yielded pass while core held measurements keep advancing', async () => {
    let yields = 0, resume;
    const f = fixture({commands:[contact(),...Array(40).fill({}),finish],yieldTask:async () => {
      if (++yields === 2) await new Promise(resolve => { resume = resolve; });
    }});
    const board = f.step(contact()); f.update(board); await flush();
    expect(f.native().steps).toBe(32);
    f.settings.showBoard = false; f.update(board);
    const newest = f.step(contact('b',17));
    expect(newest.loss).toBe(17);
    resume(); await flush();
    expect(f.native().steps).toBe(32);
    expect(f.adapter.Session.prototype.step).toBe(f.liveStep);
    expect(f.adapter.Movement.prototype.slide).toBe(f.liveSlide);
    // Shown again, the pass resumes where it stopped rather than starting over.
    f.settings.showBoard = true;
    f.update(newest); await flush();
    expect(f.metrics.snapshot().board.loss).toBe(17);
    expect(f.native().loads).toBe(1);
  });
});

describe('Raw KSF route cache identity', () => {
  test('a middle command change invalidates saved analysis without any extra native pass', async () => {
    const saved = savedAnalysis();
    const first = fixture({source: 'wr', saved, commands: [{}, contact('a', 5), finish]});
    first.update(first.step(contact()));
    await flush();
    expect(first.native()).toEqual({loads: 1, steps: 3});
    first.controller.destroy();
    const changed = fixture({source: 'wr', saved, commands: [{}, contact('a', 8), finish]});
    const board = changed.step(contact());
    changed.update(board);
    await flush();
    expect(changed.update(board)).toEqual({loss: 8, status: 'ready', source: 'wr'});
    expect(changed.calls().route).toBe(1);
    expect(changed.native()).toEqual({loads: 1, steps: 3});
    expect(saved.data.size).toBe(2);
    changed.controller.destroy();
    const cached = fixture({source: 'wr', saved, commands: [{}, contact('a', 8), finish]});
    const again = cached.step(contact());
    cached.update(again);
    await flush();
    expect(cached.update(again)).toEqual({loss: 8, status: 'ready', source: 'wr'});
    expect(cached.calls().route).toBe(1);
    expect(cached.native()).toEqual({loads: 0, steps: 0});
  });
});

describe('touch reference measurements', () => {
  test.each(['pb', 'wr'])('propagates %s entry speeds and angle through saved analysis and idle snapshots', async source => {
    const saved = savedAnalysis(), commands = [contact('a', 10), {}, {...contact('a', 5), speed: 120}, finish];
    const first = fixture({source, saved, commands, wrSource: 'leaderboard'});
    const key = visitKey(first.step(contact()));
    const read = f => {
      const reference = createRampReference({getSession: () => f.session, getReferences: f.getReferences,
        getAdapter: () => f.adapter, replayStore: f.replayStore, settings: f.settings});
      cleanups.push(() => reference.destroy());
      const slot = reference.createConsumer().get('surf_test:map-1', source);
      return {reference, slot};
    };
    const current = read(first);
    await flush();
    expect(current.slot.status).toBe('ready');
    expect(current.reference.peek('surf_test:map-1', source)).toBe(current.slot);
    expect(current.slot.ramps.get(key)).toMatchObject({board: 15, speedBefore: 100, speedAfter: 115, angle: 0});
    expect(saved.data.size).toBe(1);
    const stored = [...saved.data.values()][0].result.feedback.route;
    expect(stored.boards[stored.indices.get(key)]).toMatchObject({key, speedBefore: 100, speedAfter: 115, angle: 0});
    current.reference.destroy();
    const next = fixture({source, saved, commands, wrSource: 'leaderboard'}), cached = read(next);
    await flush();
    expect(cached.slot.ramps.get(key)).toEqual(current.slot.ramps.get(key));
    expect(next.calls().replay).toEqual([]);
    expect(next.native()).toEqual({loads: 0, steps: 0});
  });

  test('native clip angles survive per-visit reference collection, including recontacts and unknown direction', async () => {
    const f = fixture(), before = {x: 1000, y: 0, z: -300};
    const commands = [
      {brush: 'a', before}, {}, {brush: 'a', before: {x: 1200, y: -100, z: -200}},
      {brush: 'b', before: {x: 0, y: 0, z: 0}}, {finish: true},
    ];
    class Movement {
      constructor(config) { this.config = config; }
      accelerate() {}
      slide(state, result) {
        if (!this.command.brush) return;
        result.contacts.push({brushId: this.command.brush, normal});
        const v = state.velocity, projection = v.x * normal.x + v.y * normal.y + v.z * normal.z;
        state.velocity = {x: v.x - normal.x * projection, y: v.y - normal.y * projection, z: v.z - normal.z * projection};
      }
    }
    class Session {
      constructor(map, config, replayFormat) {
        Object.assign(this, {map, config, replayFormat, checkpointSpeeds: []});
        this.state = {tick: 0, grounded: false, position: {x: 0, y: 0, z: 100}, velocity: {...before}};
        this.timer = {state: {phase: 'running', startTick: 0, elapsed: 0, splits: []}};
        this.movement = new Movement(config);
      }
      loadReplay() {}
      restart() {}
      restorePractice() {}
      visitStation() {}
      step(command) {
        if (command.before) this.state.velocity = {...command.before};
        this.movement.command = command;
        this.movement.slide(this.state, {contacts: [], blocked: false});
        this.state.tick++;
        if (command.finish) Object.assign(this.timer.state, {phase: 'finished', elapsed: 10});
        return [];
      }
    }
    const data = await reconstructReferenceReplay({adapter: {Session, Movement}, session: f.session,
      replay: {...f.replay(), commands}, yieldTask: async () => {}});
    const boards = data.feedback.route.boards;
    expect(boards).toHaveLength(2);
    expect(boards[0].angle).toBeCloseTo(Math.asin(180 / Math.hypot(1000, 300)) * 180 / Math.PI, 10);
    expect(boards[0].speedBefore).toBeCloseTo(Math.hypot(1000, 300), 10);
    expect(boards[0].speedAfter).toBeCloseTo(Math.hypot(1200, 60, -80), 10);
    expect(boards[1]).toMatchObject({speedBefore: 0, speedAfter: 0, angle: null});
    for (let index = 0; index < boards.length; index++) expect(data.feedback.route.indices.get(boards[index].key)).toBe(index);
  });
});

test('pre-angle development summaries are reanalysed rather than reused without touch values', async () => {
  const saved = savedAnalysis(), first = fixture({saved});
  first.update(first.step(contact()));
  await flush();
  const [id, cached] = [...saved.data][0];
  for (const board of cached.result.feedback.route.boards) {
    delete board.speedBefore;
    delete board.speedAfter;
    delete board.angle;
  }
  saved.data.clear();
  saved.data.set(`dev${id.slice(id.indexOf('|'))}`, cached);
  first.controller.destroy();
  const next = fixture({saved}), board = next.step(contact());
  next.update(board);
  await flush();
  expect(next.calls().replay).toEqual(['official-pb']);
  expect(next.native().loads).toBe(1);
  const updated = [...saved.data].find(([key]) => key !== `dev${id.slice(id.indexOf('|'))}`)[1];
  expect(updated.result.feedback.route.boards[0]).toMatchObject({speedBefore: 100, speedAfter: 95, angle: 0});
});
