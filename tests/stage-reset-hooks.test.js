import {describe, expect, test} from 'bun:test';
import {nativeStageResetHooks} from '../extension/stage-reset-hooks.js';

// Native stageRestartReason and the complete restart arm of Session.step, with
// renamed private identifiers. Ordinary movement is outside this fixture: a
// rejected command returns "ordinary" instead of running the collision engine.
// The timer's empty-segment step is the native restart arm's only timer work.
const source = `
const vector=(x=0,y=0,z=0)=>({x,y,z}),copy=p=>({...p});
function spawnState(n,e=0,t=0){return{position:copy(n),velocity:vector(),grounded:!1,groundId:null,ducked:!1,duckFraction:0,eyeHeight:64,jumpHeld:!1,surfaceFriction:1,yaw:e,pitch:t,tick:0}}
const hull=(n,e)=>({min:vector(-16,-16,0),max:vector(16,16,n.ducked?e.duckHeight:e.standHeight)});
class Session{
  constructor(){
    this.map={stages:[
      {spawn:{position:{x:10,y:20,z:30},yaw:40,pitch:5}},
      {spawn:{position:{x:100,y:200,z:300},yaw:140,pitch:-5}}
    ]};
    this.config={gravity:800,dt:0.015,duckHeight:45,standHeight:62};
    this.replayFormat=8;this.practice=true;
    this.state={...spawnState({x:999,y:999,z:999}),stage:2,tick:81,ducked:true,duckFraction:1,eyeHeight:47,pendingMapPush:{x:5},velocity:{x:50,y:60,z:70}};
    this.commands=[{forward:true}];this.lastResult={jumped:true};
    this.startJumps=3;this.startGroundTime=2;this.startHopWarned=true;this.startRegion="old";this.rawJumpHeld=true;
    this.timer={state:{phase:"ready",splits:[],invalidReason:"Practice station",elapsed:0,startTick:null},
      step(t,segments,hull,speed,grounded){const events=[];if(this.state.phase==="running")this.state.elapsed=(t+1-this.state.startTick)*0.015;return events;}};
  }
  stageRestartReason(){if(!this.map.stages?.length)return"This map has no stages. Use Restart run to return to the start.";if(this.replayFormat<7)return"Restart stage requires a new run in the current game version.";if(this.timer.state.phase!=="running")return"Restart stage is available during a run.";if(this.state.pendingStageTeleport)return"Finishing the stage transition. Try again in a moment.";const stage=this.state.stage??1;return!this.map.stages[stage-1]||stage!==this.timer.state.splits.length+1?"Stage progress is unavailable.":null}step(command){this.previous=structuredClone(this.state);const tick=this.state.tick;if(this.commands.push({...command}),this.replayFormat>=7&&command.restartStage&&this.stageRestartReason()===null){const stage=this.state.stage??1,spawn=this.map.stages[stage-1].spawn;return this.state=spawnState(spawn.position,spawn.yaw,spawn.pitch),this.state.stage=stage,this.state.tick=tick+1,this.state.velocity.z=Math.fround(-this.config.gravity*this.config.dt*.5),this.startJumps=0,this.startGroundTime=0,this.startHopWarned=!1,this.startRegion="",this.rawJumpHeld=!1,this.stageStartRecovery=stage===1,this.previous=structuredClone(this.state),this.lastResult=null,this.timer.step(tick,[],hull(this.state,this.config),0,!1),["teleport","stage-restarted"]}return["ordinary"]}
}
const current=new Session();let replay=false,spectating=false,queued=false,notices=[];
const input={sample:()=>queued?(queued=false,{restartStage:true}):{},queueStageRestart(){queued=true;}};
function notify(message){notices.push(message)}
const spectators={recordSpectatorInputs(){}},bits=()=>0,observer=()=>({observe(){}});
function action(name){if(name==="restartStage"){if(replay||spectating){notify("Return to play before restarting a stage.");return}const reason=current.stageRestartReason();reason?notify(reason):input.queueStageRestart()}}
function frame(){const command=input.sample(current.config.dt);command.restartStage&&current.stageRestartReason()&&delete command.restartStage,replay||spectators?.recordSpectatorInputs(bits(command));const view=observer(current),events=current.step(command);view.observe(command,events);return events;}
return {current,action,frame,queued:()=>queued,notices,view:(watching,observing=false)=>{replay=watching;spectating=observing;},queue:()=>input.queueStageRestart()};
`;

function fixture(transform = nativeStageResetHooks, fixtureSource = source) {
  return new Function(transform(fixtureSource))();
}

function restart(runtime) {
  runtime.action('restartStage');
  return runtime.frame();
}

function running(session, splits = []) {
  Object.assign(session.timer.state, {phase: 'running', splits, startTick: 0, elapsed: 1});
}

describe('live native practice stage restart', () => {
  test('restarts a practice station through input, live filter and native physics without ranking it', () => {
    const runtime = fixture(), session = runtime.current;
    const timer = structuredClone(session.timer.state), spawn = session.map.stages[1].spawn;
    expect(restart(runtime)).toEqual(['teleport', 'stage-restarted']);
    expect(runtime.notices).toEqual([]);
    expect(session.practice).toBe(true);
    expect(session.timer.state).toEqual(timer);
    expect(session.state.position).toEqual(spawn.position);
    expect(session.state.position).not.toBe(spawn.position);
    expect(session.state).toMatchObject({stage: 2, tick: 82, yaw: 140, pitch: -5,
      velocity: {x: 0, y: 0, z: Math.fround(-6)}, ducked: false, duckFraction: 0, eyeHeight: 64});
    expect(session.state.pendingMapPush).toBeUndefined();
    expect(session.previous).toEqual(session.state);
    expect(session.previous).not.toBe(session.state);
    expect(session.commands).toEqual([{forward: true}, {restartStage: true}]);
    expect(session.lastResult).toBeNull();
    expect(session.startJumps).toBe(0);
    expect(session.startGroundTime).toBe(0);
    expect(session.startHopWarned).toBe(false);
    expect(session.startRegion).toBe('');
    expect(session.rawJumpHeld).toBe(false);
    expect(session.stageStartRecovery).toBe(false);
  });

  for (const reason of ['Practice mode', 'Practice restore', 'Practice station']) {
    for (const phase of ['ready', 'running']) test(`${reason} can restart stage two with missing splits while ${phase}`, () => {
      const runtime = fixture(), session = runtime.current;
      session.timer.state.invalidReason = reason;
      if (phase === 'running') running(session);
      expect(restart(runtime)).toEqual(['teleport', 'stage-restarted']);
      expect(session.timer.state.invalidReason).toBe(reason);
      expect(session.timer.state.phase).toBe(phase);
      expect(session.timer.state.splits).toEqual([]);
      expect(session.state.stage).toBe(2);
    });
  }

  test('retains native first-stage recovery and can repeat a station reset', () => {
    const runtime = fixture(), session = runtime.current;
    session.state.stage = 1;
    expect(restart(runtime)).toContain('stage-restarted');
    expect(session.stageStartRecovery).toBe(true);
    session.state.position.x = -100;
    expect(restart(runtime)).toContain('stage-restarted');
    expect(session.state.position).toEqual(session.map.stages[0].spawn.position);
    expect(session.state.tick).toBe(83);
    expect(session.timer.state.invalidReason).toBe('Practice station');
  });

  for (const reason of [null, 'Frame stall', 'Stages completed out of order', 'Start speed exceeds 350 u/s']) {
    for (const phase of ['ready', 'running']) test(`does not bypass ${phase} restrictions for ${reason}`, () => {
      const runtime = fixture(), session = runtime.current;
      session.timer.state.invalidReason = reason;
      if (phase === 'running') running(session);
      expect(restart(runtime)).toEqual(['ordinary']);
      expect(runtime.notices).toHaveLength(1);
      expect(session.state.position).toEqual({x: 999, y: 999, z: 999});
      expect(session.timer.state.invalidReason).toBe(reason);
    });
  }

  const restricted = [
    ['unstaged map', session => { delete session.map.stages; }],
    ['empty stages', session => { session.map.stages = []; }],
    ['old replay format', session => { session.replayFormat = 6; }],
    ['pending handoff', session => { session.state.pendingStageTeleport = 2; }],
    ['finished timer', session => { session.timer.state.phase = 'finished'; }],
    ['unknown timer phase', session => { session.timer.state.phase = 'paused'; }],
    ['missing current stage', session => { session.state.stage = 3; }],
    ['non-practice session', session => { session.practice = false; }],
  ];
  for (const [label, configure] of restricted) test(`keeps ${label} blocked`, () => {
    const runtime = fixture(), session = runtime.current;
    configure(session);
    expect(restart(runtime)).toEqual(['ordinary']);
    expect(runtime.notices).toHaveLength(1);
    expect(session.state.position).toEqual({x: 999, y: 999, z: 999});
  });

  test('revalidates a queued reset if the practice invalidation changes before the frame', () => {
    const runtime = fixture(), session = runtime.current;
    runtime.action('restartStage');
    expect(runtime.queued()).toBe(true);
    session.timer.state.invalidReason = 'Frame stall';
    expect(runtime.frame()).toEqual(['ordinary']);
    expect(session.commands.at(-1).restartStage).toBeUndefined();
  });
});

describe('native ranked and replay stage restart isolation', () => {
  test('keeps an ordinary ranked restart identical to native', () => {
    const patched = fixture(), native = fixture(value => value);
    for (const runtime of [patched, native]) {
      runtime.current.practice = false;
      runtime.current.timer.state.invalidReason = null;
      running(runtime.current, [0.5]);
      expect(restart(runtime)).toEqual(['teleport', 'stage-restarted']);
    }
    expect(patched.current.state).toEqual(native.current.state);
    expect(patched.current.previous).toEqual(native.current.previous);
    expect(patched.current.timer.state).toEqual(native.current.timer.state);
    expect(patched.current.commands).toEqual(native.current.commands);
    expect(patched.current.practice).toBe(false);
    expect(patched.current.timer.state.invalidReason).toBeNull();
  });

  test('does not change direct simulation of a restored replay/indexing snapshot', () => {
    const patched = fixture(), native = fixture(value => value);
    for (const runtime of [patched, native]) {
      runtime.current.timer.state.invalidReason = 'Practice restore';
      running(runtime.current);
      expect(runtime.current.stageRestartReason()).toBe('Stage progress is unavailable.');
      expect(runtime.current.step({restartStage: true})).toEqual(['ordinary']);
    }
    expect(patched.current.state).toEqual(native.current.state);
    expect(patched.current.timer.state).toEqual(native.current.timer.state);
  });

  test('valid replay commands still execute the native restart arm even after practice restoration', () => {
    const patched = fixture(), native = fixture(value => value);
    for (const runtime of [patched, native]) {
      runtime.current.timer.state.invalidReason = 'Practice restore';
      running(runtime.current, [0.5]);
      expect(runtime.current.step({restartStage: true})).toEqual(['teleport', 'stage-restarted']);
    }
    expect(patched.current.state).toEqual(native.current.state);
    expect(patched.current.timer.state).toEqual(native.current.timer.state);
  });

  for (const [label, replay, spectator] of [['replay', true, false], ['spectator', false, true]]) {
    test(`does not queue a reset from ${label} input or grant practice permission in its live filter`, () => {
      const runtime = fixture();
      runtime.view(replay, spectator);
      runtime.action('restartStage');
      expect(runtime.queued()).toBe(false);
      expect(runtime.notices).toEqual(['Return to play before restarting a stage.']);
      runtime.queue();
      expect(runtime.frame()).toEqual(['ordinary']);
      expect(runtime.current.commands.at(-1).restartStage).toBeUndefined();
    });
  }

  test('skips all gates together when the native contract is unknown', () => {
    const runtime = fixture(nativeStageResetHooks, source.replace('this.replayFormat<7', 'this.replayFormat<8'));
    expect(restart(runtime)).toEqual(['ordinary']);
    expect(runtime.notices).toEqual(['Restart stage is available during a run.']);
    runtime.queue();
    expect(runtime.frame()).toEqual(['ordinary']);
    expect(runtime.current.step({restartStage: true})).toEqual(['ordinary']);
  });

  test('applying the optional hook twice leaves live practice behavior intact', () => {
    expect(restart(fixture(value => nativeStageResetHooks(nativeStageResetHooks(value)))))
      .toEqual(['teleport', 'stage-restarted']);
  });
});
