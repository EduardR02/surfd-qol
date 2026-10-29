import {describe, expect, test} from 'bun:test';
import {createSharedSavelocs} from '../src/private-rooms/shared-savelocs.js';

const OWN = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const map = {id: 'surf_test', version: 'v1', spawn: {position: {x: 0, y: 0, z: 0}, yaw: 0, pitch: 0}, zones: []};
const snapshot = (time = 1, version = map.version) => ({
  key: JSON.stringify([map.id, version, JSON.stringify({dt: 0.015}), 8]),
  state: {position: {x: 1, y: 2, z: 3}, velocity: {x: 100, y: 0, z: -20}, grounded: false,
    groundId: null, ducked: false, duckFraction: 0, eyeHeight: 64, jumpHeld: false,
    surfaceFriction: 1, yaw: 20, pitch: 10, tick: 100},
  timer: {state: {phase: 'running', startTick: 1, endTick: null, splits: [], invalidReason: null, elapsed: time}, armed: false, prehops: 0},
  checkpointSpeeds: [], startPosition: null, startJumps: 0, startGroundTime: 0,
  startHopWarned: false, startRegion: '', rawJumpHeld: false, stageStartRecovery: false,
});
const start = {position: {x: 5, y: 5, z: 5}, yaw: 90, pitch: 0};

function fixture() {
  let handlers = null, restored = null, invalid = 0, time = 0, refreshes = 0;
  const sent = [], notices = [];
  const live = {map, practiceKey: () => 'local-physics-bank', capturePractice: () => snapshot(1.25),
    restorePractice(value) { restored = value; this.practice = true; return true; }};
  const practice = {shared(value) { handlers = value; return () => { handlers = null; }; }, refresh() { refreshes++; },
    destination: () => ({map, mapId: map.id, mapVersion: map.version, startPosition: start})};
  const controller = createSharedSavelocs({practice, send: value => sent.push(value), invalid: () => { invalid++; },
    notice: text => notices.push(text), now: () => time});
  controller.state({mapId: map.id, epoch: 1});
  controller.receive({type: 'saveloc-init', mapId: map.id, epoch: 1, ownerId: OWN});
  const add = (id, ownerId = OWN, value = snapshot(id)) => controller.receive({type: 'saveloc-add', mapId: map.id, epoch: 1,
    entry: {id, ownerId, name: ownerId === OWN ? 'My_Name' : 'Their_Name', snapshot: value}});
  const remove = id => controller.receive({type: 'saveloc-remove', mapId: map.id, epoch: 1, id});
  return {controller, live, sent, notices, add, remove, handlers: () => handlers, restored: () => restored,
    invalid: () => invalid, refreshes: () => refreshes, advance: ms => { time += ms; },
    ids: () => handlers.entries(live).map(entry => entry.id)};
}

describe('shared native saveloc list', () => {
  test('lists every owner newest first, defaults to your latest and loads any selected save', () => {
    const f = fixture(), h = f.handlers();
    f.add(1); f.add(2, OTHER); f.add(3); f.add(4, OTHER);
    expect(h.entries(f.live)).toEqual([
      {id: 4, name: 'Their_Name', time: 4, stage: 1, checkpoints: 0}, {id: 3, name: 'My_Name', time: 3, stage: 1, checkpoints: 0},
      {id: 2, name: 'Their_Name', time: 2, stage: 1, checkpoints: 0}, {id: 1, name: 'My_Name', time: 1, stage: 1, checkpoints: 0}]);
    expect(h.selected(f.live)).toBe(3);
    expect(h.restore(f.live)).toBe(true);
    expect(f.restored().timer.state.elapsed).toBe(3);
    // Previous and next move up and down the list the game shows.
    expect(h.cycle(f.live, -1)).toBe(true);
    expect(h.selected(f.live)).toBe(4);
    expect(h.restore(f.live)).toBe(true);
    expect(f.restored().timer.state.elapsed).toBe(4);
    expect(f.restored().key).toBe('local-physics-bank');
    expect(f.live.practice).toBe(true);
    h.cycle(f.live, -1);
    expect(h.selected(f.live)).toBe(1);
    expect(h.select(f.live, 2)).toBe(true);
    expect(h.select(f.live, 99)).toBe(false);
    expect(h.selected(f.live)).toBe(2);
    expect(h.entries({...f.live, map: {...map, id: 'other'}})).toEqual([]);
    f.controller.close();
  });

  test('saving submits the native capture and reports the room number once the host confirms it', () => {
    const f = fixture(), h = f.handlers();
    f.add(1, OTHER);
    h.select(f.live, 1);
    expect(h.save(f.live)).toBe(null);
    expect(f.sent).toEqual([{type: 'saveloc-save', mapId: map.id, epoch: 1, snapshot: snapshot(1.25)}]);
    expect(f.notices).toEqual([]);
    f.add(2, OWN, snapshot(1.25));
    expect(f.notices).toEqual(['Saved location #2 · 00:01.250.']);
    expect(h.selected(f.live)).toBe(2);
    // The host evicts your oldest just before adding the 21st.
    for (let id = 3; id <= 21; id++) f.add(id);
    f.advance(60000);
    h.save(f.live);
    f.remove(2); f.add(22, OWN, snapshot(1.25));
    expect(f.notices.at(-1)).toBe('Saved location #22 · 00:01.250. Oldest save replaced.');
    f.controller.close();
  });

  test('a captured custom start stays private', () => {
    const f = fixture(), h = f.handlers();
    f.live.capturePractice = () => ({...snapshot(), startPosition: start});
    h.save(f.live);
    expect(f.sent[0].snapshot.startPosition).toBe(null);
    f.controller.close();
  });

  test('your saves retained from before a reconnect are listed without announcements', () => {
    const f = fixture(), h = f.handlers();
    f.add(1); f.add(2, OTHER); f.add(3);
    expect(f.notices).toEqual([]);
    expect(h.selected(f.live)).toBe(3);
    f.controller.close();
  });

  test('saving faster than the host allows says so instead of sending', () => {
    const f = fixture(), h = f.handlers();
    for (let index = 0; index < 4; index++) h.save(f.live);
    expect(f.sent).toHaveLength(3);
    expect(f.notices).toEqual(["You're saving locations too fast."]);
    f.advance(1000);
    h.save(f.live);
    expect(f.sent).toHaveLength(4);
    f.controller.close();
  });

  test('a capture that cannot be shared reports the game’s own failure', () => {
    const f = fixture(), h = f.handlers();
    f.live.capturePractice = () => null;
    h.save(f.live);
    f.live.capturePractice = () => ({...snapshot(), extra: true});
    h.save(f.live);
    expect(f.sent).toEqual([]);
    expect(f.notices).toEqual(['Could not save this location.', 'Could not save this location.']);
    expect(h.saveSnapshot({...snapshot(), extra: true})).toBe(false);
    f.controller.close();
  });

  test('deleting your save removes it for everyone; deleting another hides it for you alone', () => {
    const f = fixture(), h = f.handlers();
    f.add(1); f.add(2, OTHER); f.add(3);
    h.select(f.live, 2);
    expect(h.remove(f.live)).toBe(true);
    expect(f.sent).toEqual([]);
    expect(f.ids()).toEqual([3, 1]);
    h.select(f.live, 1);
    h.remove(f.live);
    expect(f.sent).toEqual([{type: 'saveloc-delete', mapId: map.id, epoch: 1, id: 1}]);
    expect(f.ids()).toEqual([3]);
    f.remove(1);
    expect(f.ids()).toEqual([3]);
    // An owner's deletion is not an eviction.
    f.add(4, OWN, snapshot(1.25));
    expect(f.notices).toEqual([]);
    f.controller.close();
  });

  test('like the game, the next save takes the selection after a delete, so hiding others never reaches your own', () => {
    const f = fixture(), h = f.handlers();
    f.add(1); f.add(2, OTHER); f.add(3, OTHER);
    h.select(f.live, 3);
    h.remove(f.live);
    expect(h.selected(f.live)).toBe(2);
    h.remove(f.live);
    expect(h.selected(f.live)).toBe(1);
    expect(f.sent).toEqual([]);
    f.controller.close();
  });

  test('a map change clears saves, hides, selection and ownership, and stale messages are ignored', () => {
    const f = fixture(), h = f.handlers();
    f.add(1); f.add(2, OTHER); h.select(f.live, 2); h.remove(f.live);
    f.controller.state({mapId: map.id, epoch: 2});
    f.add(3);
    expect(h.entries(f.live)).toEqual([]);
    expect(h.selected(f.live)).toBe(null);
    h.save(f.live);
    expect(f.sent).toEqual([]);
    f.controller.state({mapId: map.id, epoch: 1});
    f.controller.receive({type: 'saveloc-init', mapId: map.id, epoch: 2, ownerId: OWN});
    f.controller.receive({type: 'saveloc-add', mapId: map.id, epoch: 2, entry: {id: 4, ownerId: OTHER, name: 'Their_Name', snapshot: snapshot(4)}});
    expect(f.ids()).toEqual([4]);
    f.controller.close();
  });

  test('closing detaches from the game and ignores later messages', () => {
    const f = fixture();
    f.add(1);
    f.controller.close();
    expect(f.handlers()).toBe(null);
    f.add(2);
    expect(f.invalid()).toBe(0);
  });
});

describe('hostile shared saves', () => {
  test('a malformed save closes the room and never reaches the list', () => {
    const f = fixture(), h = f.handlers();
    const unsafe = snapshot(); unsafe.state.position.x = Infinity;
    f.add(1, OTHER, unsafe);
    expect(f.invalid()).toBe(1);
    expect(h.entries(f.live)).toEqual([]);
    expect(h.restore(f.live)).toBe(false);
    f.controller.close();
  });

  test('a save the local map refutes, such as another map version, stays out of the list without closing', () => {
    const f = fixture(), h = f.handlers();
    f.add(1, OTHER, snapshot(1, 'v2'));
    const staged = snapshot(2); staged.state.stage = 2;
    f.add(2, OTHER, staged);
    expect(f.invalid()).toBe(0);
    expect(h.entries(f.live)).toEqual([]);
    expect(h.select(f.live, 1)).toBe(false);
    expect(h.restore(f.live)).toBe(false);
    f.controller.close();
  });

  test('loading keeps the receiver’s own start position', () => {
    const f = fixture(), h = f.handlers();
    const value = snapshot(2); value.startPosition = {position: {x: 999, y: 999, z: 999}, yaw: 0, pitch: 0};
    f.add(2, OTHER, value); h.select(f.live, 2); h.restore(f.live);
    expect(f.restored().startPosition).toEqual(start);
    expect(f.restored().state.position).toEqual({x: 1, y: 2, z: 3});
    f.controller.close();
  });

  test('a host cannot overwrite a save, exceed an owner’s 20 or the room’s 1,280', () => {
    const f = fixture(), h = f.handlers();
    for (let id = 1; id <= 20; id++) f.add(id, OTHER);
    f.add(21, OTHER); f.add(1, OTHER, snapshot(999));
    expect(f.invalid()).toBe(2);
    h.select(f.live, 1); h.restore(f.live);
    expect(f.restored().timer.state.elapsed).toBe(1);
    let id = 100;
    for (let owner = 0; owner < 63; owner++) {
      const ownerId = `00000000-0000-4000-8000-${String(owner + 10).padStart(12, '0')}`;
      for (let count = 0; count < 20; count++) f.add(id++, ownerId, snapshot(1));
    }
    expect(f.invalid()).toBe(2);
    f.add(id, OWN);
    expect(f.invalid()).toBe(3);
    f.controller.close();
  });
});
