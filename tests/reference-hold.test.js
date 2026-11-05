import {afterEach, beforeEach, expect, test} from 'bun:test';
import {createCheckpointReferences, referenceIdentity, sessionKey} from '../src/references.js';
import {createRunReferences} from '../src/run-references.js';

let idle;
beforeEach(() => {
  idle = {pending: new Map(), next: 0, timeouts: []};
  globalThis.requestIdleCallback = (callback, options) => { idle.timeouts.push(options?.timeout); idle.pending.set(++idle.next, callback); return idle.next; };
  globalThis.cancelIdleCallback = id => idle.pending.delete(id);
});
afterEach(() => {
  delete globalThis.requestIdleCallback;
  delete globalThis.cancelIdleCallback;
});
const runIdle = () => { const callbacks = [...idle.pending.values()]; idle.pending.clear(); for (const callback of callbacks) callback(); };

const pb = {runId: 'pb-1', timeUs: 10000000, splitsUs: [4000000]};
function fixture() {
  const adapter = {Session: class {}, Movement: class {}};
  const session = {map: {id: 'surf_one', version: 'v1'}, config: {dt: .015}, replayFormat: 8, commands: [],
    checkpointSpeeds: [], state: {tick: 0}, timer: {state: {phase: 'ready', startTick: 0, elapsed: 0, splits: []}}};
  const acquired = [];
  const replayStore = {acquire({key}) { acquired.push(key); return {result: null, promise: new Promise(() => {}), release() {}}; }, destroy() {}};
  const refs = {boardId: 'board', ownerKey: 'guest', own: pb, record: null, loadReplay: async () => null, loadRecordRoute: async () => null};
  return {adapter, session, acquired, replayStore, refs, get: {getSession: () => session, getReferences: () => refs, getAdapter: () => adapter}};
}

test('checkpoint references wait for the first step, then load in the next idle period', () => {
  const f = fixture();
  const references = createCheckpointReferences({...f.get, replayStore: f.replayStore, storage: null, settings: {}});
  const before = references.update(true);
  expect([before.ownStatus, before.recordStatus]).toEqual(['loading', 'loading']);
  references.update(true);
  expect(f.acquired).toEqual([]);
  expect(idle.pending.size).toBe(0);
  f.session.commands.push({});
  references.update(true);
  references.update(true);
  expect(idle.pending.size).toBe(2);
  expect(idle.timeouts.every(timeout => timeout > 0 && timeout <= 200)).toBe(true);
  expect(f.acquired).toEqual([]);
  runIdle();
  expect(f.acquired).toHaveLength(2);
  expect(f.acquired.some(key => key.endsWith(':ksf'))).toBe(true);
  // Later requests in a session that has stepped start at once.
  f.refs.own = {...pb, runId: 'pb-2'};
  references.update(true);
  expect(f.acquired).toHaveLength(3);
});

test('a checkpoint reference already kept shows at once', () => {
  const f = fixture();
  const storage = new Map([['surfd.qol.checkpoints.v1', JSON.stringify({cache: [[`${sessionKey(f.session, 'board')}:${referenceIdentity(pb)}`, [512]]], personal: []})]]);
  const references = createCheckpointReferences({...f.get, replayStore: f.replayStore, settings: {checkpointReference: 'pb'},
    storage: {getItem: key => storage.get(key) ?? null, setItem() {}}});
  const result = references.update(true);
  expect([result.ownStatus, result.own]).toEqual(['ready', [512]]);
  expect(f.acquired).toEqual([]);
});

test('a held reference that is no longer wanted never loads', () => {
  const f = fixture();
  const references = createCheckpointReferences({...f.get, replayStore: f.replayStore, storage: null, settings: {checkpointReference: 'pb'}});
  references.update(true);
  f.session.commands.push({});
  references.update(true);
  expect(idle.pending.size).toBe(1);
  references.destroy();
  expect(idle.pending.size).toBe(0);
  expect(f.acquired).toEqual([]);
});

test('ramp and start references wait for the first step, then load in the next idle period', () => {
  const f = fixture();
  const settings = {boardColorReference: 'pb', startColorReference: 'wr', surfColorReference: 'pb'};
  const run = createRunReferences({...f.get, replayStore: f.replayStore, settings});
  const before = run.update(null, null, true);
  expect([before.board.status, before.start.status]).toEqual(['loading', 'loading']);
  expect(f.acquired).toEqual([]);
  f.session.commands.push({});
  run.update(null, null, true);
  run.update(null, null, true);
  expect(f.acquired).toEqual([]);
  expect(idle.pending.size).toBe(2);
  runIdle();
  expect(f.acquired).toHaveLength(2);
  // A held slot replaced before its idle period never loads; its replacement,
  // asked for after the first step, loads at once.
  const g = fixture();
  const other = createRunReferences({...g.get, replayStore: g.replayStore, settings: {boardColorReference: 'pb'}});
  other.update(null, null, true);
  g.session.commands.push({});
  other.update(null, null, true);
  g.refs.own = {...pb, runId: 'pb-2'};
  other.update(null, null, true);
  expect(g.acquired.map(key => key.includes('pb-2'))).toEqual([true]);
  other.destroy();
  runIdle();
  expect(g.acquired).toHaveLength(1);
});
