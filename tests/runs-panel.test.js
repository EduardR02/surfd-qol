import { describe, expect, test } from 'bun:test';
import { compareRamp, paceCells, rampSections, reached, surfBars, versusPb, when } from '../src/runs-panel.js';

describe('runs panel', () => {
  test('checkpoint bests are coloured against the PB’s own splits', () => {
    const cells = paceCells({splits: [
      {label: 'CP1', time: 10.12, speed: 2412, pb: 10.201},
      {label: 'CP2', time: 21.233, speed: 2950, pb: 21.233},
      {label: 'CP3', time: 31.5, speed: 3104, pb: 31.273},
      {label: 'CP4', time: 40.1, speed: 3200, pb: null},
    ]});
    expect(cells.map(cell => [cell.delta, cell.tone])).toEqual([['−0.081', 'good'], ['pb pace', 'pb'], ['+0.227', 'loss'], ['', 'muted']]);
    expect(paceCells({})).toEqual([]);
  });

  test('a finished run against the PB; resets have nothing to compare', () => {
    const pb = {id: 'pb', outcome: 'finished', time: 41.233};
    expect(versusPb({id: 'a', outcome: 'finished', time: 41.869}, pb)).toEqual({text: '+0.636', tone: 'loss'});
    expect(versusPb({id: 'b', outcome: 'finished', time: 41.0}, pb)).toEqual({text: '−0.233', tone: 'good'});
    expect(versusPb(pb, pb)).toEqual({text: 'pb', tone: 'pb'});
    expect(versusPb({id: 'c', outcome: 'reset', time: 20}, pb)).toBeNull();
    expect(versusPb({id: 'd', outcome: 'finished', time: 50}, null)).toBeNull();
  });

  test('ramps group in route order under the checkpoint that opens each section', () => {
    const view = {kind: 'CP', splits: [{label: 'CP1'}, {label: 'CP2'}], ramps: [
      {key: 'a', label: 'Ramp 1', checkpoint: 0}, {key: 'b', label: 'Ramp 2', checkpoint: 0},
      {key: 'c', label: 'Ramp 3', checkpoint: 2}, {key: 'd', label: 'Ramp 4', checkpoint: 1},
    ]};
    expect(rampSections(view).map(section => [section.label, section.ramps.map(ramp => ramp.key)]))
      .toEqual([['Start', ['a', 'b']], ['CP1', ['d']], ['CP2', ['c']]]);
    expect(rampSections({...view, kind: 'S'}).map(section => section.label)).toEqual(['Stage 1', 'Stage 2', 'Stage 3']);
    expect(rampSections({ramps: []})).toEqual([]);
  });

  test('a ramp value reads like the HUD, with its difference from the reference in speed', () => {
    // 5.9 lost where the reference lost 2.4: 3.5 u/s worse.
    expect(compareRamp(5.9, 2.4, 2)).toEqual({text: '−5.9', diff: '−3.5', tone: 'loss'});
    expect(compareRamp(3.4, 2.4, 2)).toEqual({text: '−3.4', diff: '−1.0', tone: 'warn'});
    expect(compareRamp(1.2, 2.4, 2)).toEqual({text: '−1.2', diff: '+1.2', tone: 'good'});
    // No reference: the value alone, uncoloured. No value: a dash.
    expect(compareRamp(5.9, null, 2)).toEqual({text: '−5.9', diff: '', tone: 'plain'});
    expect(compareRamp(null, 2.4, 2)).toEqual({text: '—', diff: '', tone: 'muted'});
  });

  test('surf bars diverge around the reference, or grow with the loss without one', () => {
    const ramps = [{key: 'a', surf: 40}, {key: 'b', surf: 20}, {key: 'c', surf: null}, {key: 'd', surf: 30}];
    const reference = {a: 30, b: 25, c: 10};
    const vs = surfBars(ramps, ramp => reference[ramp.key], 2);
    expect(vs.map(bar => bar && [bar.side, bar.tone, bar.size])).toEqual([['left', 'loss', 1], ['right', 'good', .5], null, null]);
    const raw = surfBars(ramps);
    expect(raw.map(bar => bar && [bar.side, bar.size])).toEqual([['raw', 1], ['raw', .5], null, ['raw', .75]]);
  });

  test('how far a run got', () => {
    expect(reached({outcome: 'finished', checkpoints: 3, kind: 'CP'})).toBe('Finished');
    expect(reached({outcome: 'reset', checkpoints: 0, kind: 'CP', totalCheckpoints: 3})).toBe('Before CP1');
    expect(reached({outcome: 'reset', checkpoints: 2, kind: 'CP', totalCheckpoints: 3})).toBe('CP2');
    expect(reached({outcome: 'reset', checkpoints: 2, kind: 'S', totalCheckpoints: 8})).toBe('Stage 3');
    expect(reached({outcome: 'reset', checkpoints: 0, kind: 'CP', totalCheckpoints: 0})).toBe('Reset');
  });

  test('today shows the time, yesterday and older the day', () => {
    const now = new Date(2026, 9, 24, 21, 40).getTime();
    expect(when(new Date(2026, 9, 24, 9, 5).getTime(), now)).toBe('09:05');
    expect(when(new Date(2026, 9, 23, 23, 59).getTime(), now)).toBe('Yesterday');
    expect(when(new Date(2026, 9, 9, 18, 20).getTime(), now)).toMatch(/9/);
    expect(when(new Date(2025, 9, 9).getTime(), now)).toMatch(/2025/);
    expect(when(NaN, now)).toBe('');
  });
});
