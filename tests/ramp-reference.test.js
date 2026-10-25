import {describe, expect, test} from 'bun:test';
import {createRampReference} from '../src/ramp-reference.js';

function rig({settings = {}} = {}) {
  const session = {map: {id: 'utopia', version: 3}, config: {dt: 0.015}, replayFormat: 8};
  const acquired = [];
  let finish;
  const replayStore = {
    acquire(request) {
      acquired.push(request);
      return {result: null, promise: new Promise(resolve => { finish = resolve; }), release() { request.released = true; }};
    },
  };
  const refs = {boardId: 'b1', own: {runId: 'pb1', timeUs: 41e6, splitsUs: [10e6]}, loadReplay: async () => ({}), loadRecordRoute: async () => ({})};
  const adapter = {Session: function () {}, Movement: function () {}};
  const reference = createRampReference({getSession: () => session, getReferences: () => refs, getAdapter: () => adapter, replayStore,
    settings: {boardColorReference: 'pb', referenceLossTolerance: 2, boardLossAmazing: 5, boardLossGood: 20, ...settings}});
  const route = {indices: new Map([['[7,0,1]', 0], ['[8,0,1]', 1]]), boards: [
    {valid: true, loss: 3, downLoss: 9, upLoss: 2, surfLoss: 11}, {valid: false, loss: 1}]};
  return {reference, acquired, finish: () => finish({feedback: {route}}), session};
}

describe('ramp reference', () => {
  test('loads the PB route for the map in the game and shares the HUD key', async () => {
    const {reference, acquired, finish} = rig();
    expect(reference.get('mesa:1', 'pb')).toBeNull();
    const slot = reference.get('utopia:3', 'pb');
    expect(slot).toMatchObject({status: 'loading', label: 'PB'});
    expect(acquired).toHaveLength(1);
    expect(acquired[0]).toMatchObject({feedback: true});
    expect(acquired[0].key).toEndWith(':official:' + JSON.stringify(['pb1', 41e6, [10e6]]));
    let heard = 0;
    reference.subscribe(() => heard++);
    finish();
    await Promise.resolve();
    expect(reference.get('utopia:3', 'pb')).toMatchObject({status: 'ready'});
    expect([...slot.ramps]).toEqual([['[7,0,1]', {board: 3, down: 9, up: 2, surf: 11}]]);
    expect(heard).toBe(1);
    // Asking again reuses the slot.
    expect(acquired).toHaveLength(1);
  });

  test('the KSF WR is the record route; a missing source has nothing to compare', () => {
    const {reference, acquired} = rig();
    expect(reference.get('utopia:3', 'wr')).toMatchObject({label: 'KSF WR'});
    expect(acquired[0].key).toEndWith(':ksf');
    const leaderboard = rig({settings: {wrSource: 'leaderboard'}});
    expect(leaderboard.reference.get('utopia:3', 'wr')).toBeNull();
  });

  test('board tones follow the HUD: against the reference, or fixed cutoffs', async () => {
    const {reference, finish} = rig();
    expect(reference.tone('[7,0,1]', 4)).toBe('muted');
    finish();
    await Promise.resolve();
    expect(reference.tone('[7,0,1]', 2)).toBe('good');
    expect(reference.tone('[7,0,1]', 4)).toBe('warn');
    expect(reference.tone('[7,0,1]', 9)).toBe('loss');
    expect(reference.tone('[9,0,1]', 2)).toBe('muted');
    const fixed = rig({settings: {boardColorReference: 'fixed'}});
    expect(fixed.reference.tone('[7,0,1]', 4)).toBe('good');
    expect(fixed.reference.tone('[7,0,1]', 30)).toBe('loss');
  });
});
