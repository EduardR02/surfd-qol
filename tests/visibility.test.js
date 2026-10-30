import { describe, expect, test } from 'bun:test';
import { isSurfContext } from '../src/visibility.js';

const state = { position: { x: 0, y: 0, z: 100 }, velocity: { x: 350, y: 0, z: 0 } };
const clearUi = {
  menuOpen: false, loading: false, finishOpen: false,
  blockingWindowOpen: false, blockingDialogOpen: false, pointerLocked: false
};
const contexts = [
  { name: 'live', snapshot: { active: true, playback: false, state }, view: null },
  { name: 'replay', snapshot: { active: false, playback: true, state }, view: null },
  { name: 'spectator', snapshot: { active: false, playback: false }, view: { target: 'watched', view: { pose: null } } }
];

describe('Surf context visibility', () => {
  test('active gameplay is visible whether or not the pointer is locked', () => {
    const snapshot = { active: true, playback: false, state };
    expect(isSurfContext(snapshot, null, null, clearUi)).toBe(true);
    expect(isSurfContext(snapshot, null, null, { ...clearUi, pointerLocked: true })).toBe(true);
  });

  for (const { name, snapshot, view } of contexts) {
    test(`${name} is blocked by each genuine UI blocker and recovers when it closes`, () => {
      const ui = { ...clearUi };
      expect(isSurfContext(snapshot, null, view, ui)).toBe(true);
      for (const blocker of ['menuOpen', 'loading', 'finishOpen', 'blockingWindowOpen', 'blockingDialogOpen']) {
        ui[blocker] = true;
        expect(isSurfContext(snapshot, null, view, ui)).toBe(false);
        ui[blocker] = false;
        expect(isSurfContext(snapshot, null, view, ui)).toBe(true);
      }
    });

    test(`${name} cannot override explicit lobby or loading state`, () => {
      for (const blocker of ['lobby', 'loading']) {
        expect(isSurfContext({ ...snapshot, [blocker]: true }, { state }, view, { ...clearUi, pointerLocked: true })).toBe(false);
        expect(isSurfContext({ ...snapshot, [blocker]: false }, { state }, view, clearUi)).toBe(true);
      }
    });
  }

  test('native replay does not require active gameplay or pointer lock', () => {
    expect(isSurfContext({ active: false, playback: true }, null, null, clearUi)).toBe(true);
    expect(isSurfContext({ playback: true }, null, null)).toBe(true);
  });

  test('a watched target remains in Surf context while its pose is pending', () => {
    const snapshot = { active: false, playback: false, spectator: { target: 0, view: { pose: null } } };
    expect(isSurfContext(snapshot, null, null, clearUi)).toBe(true);
    expect(isSurfContext(snapshot, { state }, null, clearUi)).toBe(true);
    expect(snapshot.spectator.view.pose).toBeNull();
  });

  test('the supplied spectator view takes precedence over the snapshot view', () => {
    const snapshot = { active: false, spectator: { target: 'stale' } };
    expect(isSurfContext(snapshot, { state }, { target: null }, { ...clearUi, pointerLocked: true })).toBe(false);
    expect(isSurfContext({ active: false }, null, { target: 'current' }, clearUi)).toBe(true);
    expect(isSurfContext(snapshot, null, undefined, clearUi)).toBe(true);
  });

  test('inactive flags prevent a local state or pointer lock from reviving the HUD', () => {
    for (const flags of [{ active: false }, { playback: false }, { active: false, playback: false }]) {
      expect(isSurfContext({ ...flags, state }, { state }, null, { ...clearUi, pointerLocked: true })).toBe(false);
    }
    expect(isSurfContext({ active: true, playback: false }, null, null, clearUi)).toBe(true);
    expect(isSurfContext({ active: false, playback: true }, null, null, clearUi)).toBe(true);
  });

  test('older snapshots require both a state and explicit pointer lock', () => {
    expect(isSurfContext({ state }, null, null, { ...clearUi, pointerLocked: true })).toBe(true);
    expect(isSurfContext({}, { state }, null, { ...clearUi, pointerLocked: true })).toBe(true);
    expect(isSurfContext(null, { state }, null, { ...clearUi, pointerLocked: true })).toBe(true);
    expect(isSurfContext({ state }, null, null, clearUi)).toBe(false);
    expect(isSurfContext({ state }, null, null, {})).toBe(false);
    expect(isSurfContext({ state }, null, null, { pointerLocked: 1 })).toBe(false);
    expect(isSurfContext({}, {}, null, { ...clearUi, pointerLocked: true })).toBe(false);
    expect(isSurfContext()).toBe(false);
  });

  test('fallback state and pointer lock never override a blocker', () => {
    for (const blocker of ['menuOpen', 'loading', 'finishOpen', 'blockingWindowOpen', 'blockingDialogOpen']) {
      expect(isSurfContext({ state }, null, null, { ...clearUi, pointerLocked: true, [blocker]: true })).toBe(false);
    }
    expect(isSurfContext({ state, lobby: true }, null, null, { ...clearUi, pointerLocked: true })).toBe(false);
    expect(isSurfContext({ state, loading: true }, null, null, { ...clearUi, pointerLocked: true })).toBe(false);
  });
});
