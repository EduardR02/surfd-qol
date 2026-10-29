import { describe, expect, spyOn, test } from 'bun:test';
import { barScale, bestFinish, compareRamp, createRunsPanel, detailRows, paceCells, rampMetric, rampSections, scaleBars, reachText, reached, touchCells, versusPb, when } from '../src/runs-panel.js';
import {createRampReference} from '../src/ramp-reference.js';
import {createReplayControl} from '../src/replay-control.js';

function panelRig({data = {key: 'utopia:3', name: 'Utopia', pb: {id: 'local', time: 45, outcome: 'finished'}}, control = {}, rampStore = null, reference = null, settings = {}, onSettings = null, now} = {}) {
  const nodes = new Map();
  const root = {getElementById(id) {
    if (!nodes.has(id)) {
      const classes = new Set(), events = new Map();
      nodes.set(id, {
        hidden: true, textContent: '', innerHTML: '', scrollTop: 0, dataset: {},
        classList: {add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
          toggle(name, value) { if (value) classes.add(name); else classes.delete(name); }},
        style: {setProperty() {}}, setAttribute() {}, focus() {}, querySelectorAll: () => [], querySelector: () => null,
        addEventListener: (name, listener) => events.set(name, listener),
        emit: (name, event) => events.get(name)?.(event),
      });
    }
    return nodes.get(id);
  }};
  let session = {map: {id: 'utopia', version: 3}, config: {dt: 0.015}, replayFormat: 8};
  let downloads = 0, refs = {boardId: 'board', ownerKey: 'account', own: {runId: 'native', timeUs: 41000000, splitsUs: []},
    loadReplay: async () => { downloads++; return {native: true}; }};
  const history = {currentMap: 'utopia:3', currentMapName: 'Utopia',
    view: () => data, maps: () => [], subscribe: () => () => {}};
  const loaded = [], watched = [];
  const rampReference = reference ?? (rampStore ? createRampReference({getSession: () => session, getReferences: () => refs,
    getAdapter: () => adapter, replayStore: rampStore, settings}) : null);
  const adapter = {Session: function () {}, Movement: function () {}};
  const panel = createRunsPanel({root, history, rampReference, settings, onSettings, now, getSession: () => session, getReferences: () => refs,
    replayControl: Object.defineProperties({watchLoaded: async (load, options) => {
      loaded.push({replay: await load(), options});
      // Native Watch installs a fresh Session for every playback.
      session = {...session};
    },
      canWatch: () => true, watch: async run => watched.push(run)}, Object.getOwnPropertyDescriptors(control))});
  const body = root.getElementById('rn-body');
  const click = id => body.emit('click', {target: {closest: () => ({dataset: {watch: id}})}});
  const action = dataset => body.emit('click', {target: {closest: () => ({dataset})}});
  return {panel, body, nodes, history, rampReference, loaded, watched, click, action, get downloads() { return downloads; },
    get session() { return session; }, set session(value) { session = value; },
    get refs() { return refs; }, set refs(value) { refs = value; },
    watchId: () => body.innerHTML.match(/data-watch="([^"]+)"/)?.[1]};
}

describe('runs panel', () => {
  test('checkpoint bests are coloured against the PB’s own splits', () => {
    const cells = paceCells({pb: {id: 'local', time: 41.233}, splits: [
      {label: 'CP1', time: 10.12, speed: 2412, pb: 10.201},
      {label: 'CP2', time: 21.233, speed: 2950, pb: 21.233},
      {label: 'CP3', time: 31.5, speed: 3104, pb: 31.273},
      {label: 'CP4', time: 40.1, speed: 3200, pb: null},
    ]});
    expect(cells.map(cell => [cell.delta, cell.tone])).toEqual([['−0.081', 'good'], ['±0.000', 'muted'], ['+0.227', 'loss'], ['', 'muted']]);
    expect(paceCells({})).toEqual([]);
  });

  test('a finished run against the PB; resets have nothing to compare', () => {
    const pb = {id: 'pb', outcome: 'finished', time: 41.233};
    expect(versusPb({id: 'a', outcome: 'finished', time: 41.869}, pb)).toEqual({text: '+0.636', tone: 'loss'});
    expect(versusPb({id: 'b', outcome: 'finished', time: 41.0}, pb)).toEqual({text: '−0.233', tone: 'good'});
    expect(versusPb(pb, pb)).toEqual({text: 'best', tone: 'muted'});
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

  test('touch values follow the statistic; speed counts higher as better, the angle lower', () => {
    const touch = {reach: 0.29, speedIn: {best: 2412, last10: 2380.4, avg: 2371}, speedOut: {best: 2405, last10: 2366, avg: null},
      angle: {best: 2.04, last10: 3.5, avg: 4}};
    const best = touchCells(touch, 'best');
    expect([best.reach.text, best.speedIn.text, best.speedOut.text, best.angle.text]).toEqual(['29%', '2412', '2405', '2.0°']);
    expect([best.speedIn.tone, best.angle.tone, best.angle.diff]).toEqual(['plain', 'plain', '']);
    const recent = touchCells(touch, 'recent');
    expect([recent.speedIn.text, recent.angle.text]).toEqual(['2380', '3.5°']);
    expect(touchCells(touch, 'average').speedOut).toEqual({value: null, text: '—', diff: '', tone: 'muted'});
    // Against a reference: faster is better, and a flatter touch is better.
    const versus = touchCells(touch, 'best', {speedIn: 2400, speedOut: 2410, angle: 2.5});
    expect(versus.speedIn).toMatchObject({diff: '+12', tone: 'good'});
    expect(versus.speedOut).toMatchObject({diff: '−5', tone: 'loss'});
    expect(versus.angle).toMatchObject({diff: '−0.5°', tone: 'good'});
    expect(touchCells(touch, 'best', {speedIn: 2414, speedOut: 2406, angle: 2}, 2).speedIn.tone).toBe('warn');
    // The angle is near within half a degree, whatever the u/s margin.
    expect(touchCells(touch, 'best', {angle: 1.6}, 0).angle.tone).toBe('warn');
    expect(touchCells(touch, 'best', {angle: 1}, 5).angle.tone).toBe('loss');
    expect(touchCells(null).reach).toMatchObject({text: '—', tone: 'muted'});
    // Reach rounds down so 100% only ever means every run.
    expect([reachText(0.999), reachText(1), reachText(0), reachText(null)]).toEqual(['99%', '100%', '0%', '—']);
  });

  test('each ramp is one row: reach and the whole ramp against the reference; the chevron opens the rest', () => {
    const data = {key: 'utopia:3', name: 'Utopia', ramps: [{key: 'a', label: 'Ramp 1', checkpoint: 0, board: 2, down: 10, up: 20, surf: 30},
      {key: 'b', label: 'Ramp 2', checkpoint: 0, board: 3, down: 100, up: 234, surf: 334}]};
    const slot = {status: 'ready', label: 'PB', ramps: new Map([['a', {board: 1.5, down: 9, up: 15, surf: 24}]])};
    const reference = {sources: () => [{name: 'pb', label: 'PB'}, {name: 'wr', label: 'KSF WR'}], version: () => 1,
      createConsumer: () => ({get: () => slot, release() {}, destroy() {}})};
    const stat = value => ({best: value, last10: value + 1, avg: value + 2});
    let stats = {runs: 12, collecting: true, touches: []};
    const settings = {}, saved = [];
    const rig = panelRig({reference, data, settings, onSettings: patch => { saved.push(patch); Object.assign(settings, patch); }});
    rig.history.touchStats = key => key === 'utopia:3' ? stats : null;
    const html = () => rig.body.innerHTML;
    try {
      rig.panel.show(); rig.panel.showView('ramps');
      expect(html()).toContain('Collecting touch stats: 12 of 50 runs.');
      // One graded number per ramp, the whole ramp against the PB; Ramp 2 isn't on the PB's route.
      expect(html()).toContain('<span class="rn-hero loss" role="cell" title="The whole ramp, touch included: −30.0. PB: −24.0">−6.0</span>');
      expect(html()).toContain('not in PB');
      expect(html()).toContain('Surf vs PB');
      expect(html()).not.toContain('class="rn-detail"');
      stats = {runs: 64, collecting: false, touches: [
        {key: 'a', index: 0, checkpoint: 0, reach: 0.43, speedIn: stat(2400), speedOut: stat(2390), angle: stat(2),
          pb: {speedIn: 2410, speedOut: 2380, angle: 3}, wr: {speedIn: 2500, speedOut: 2490, angle: 1}},
      ]};
      rig.panel.showView('ramps');
      expect(html()).not.toContain('Collecting');
      expect(html()).toContain('>43%</span>');
      // Clicking anywhere on the row opens it, as its chevron does.
      rig.body.emit('click', {target: {closest: selector => selector === 'button' ? null : {dataset: {ramp: 'a'}}}});
      expect(html()).toContain('class="rn-detail"');
      expect(html()).toContain('aria-expanded="true"');
      expect(html()).toContain('<span role="rowheader">Speed in</span><b role="cell">2400</b><span role="cell">2410</span><b role="cell" class="loss">−10</b>');
      expect(html()).toContain('Reached in 43% of runs');
      rig.action({rampMode: 'recent'});
      expect(html()).toContain('<b role="cell">2401</b>');
      // While the reference loads, the row shows the loss itself and the open table only You.
      slot.status = 'loading';
      rig.panel.showView('ramps');
      expect(html()).toContain('>Surf<');
      expect(html()).toContain('class="rn-x solo"');
      slot.status = 'ready';
      rig.panel.showView('ramps');
      rig.action({rampMetric: 'speedIn'});
      expect(saved).toEqual([{rampMetric: 'speedIn'}]);
      expect(html()).toContain('In vs PB');
      expect(html()).toContain('aria-checked="true" tabindex="0" data-ramp-metric="speedIn"');
      expect(html()).toContain('title="Speed as you touched the ramp: 2401. PB: 2410">−9</span>');
      rig.action({rampMetric: 'angle'});
      expect(html()).toContain('Angle vs PB');
      expect(html()).toContain('>±0.0°</span>');
      rig.history.touchStats = () => { throw new Error('unavailable'); };
      rig.panel.showView('ramps');
      expect(html()).not.toContain('Speed in');
    } finally { rig.panel.destroy(); }
  });

  test('touch values show from the first run while collecting, and Angle names its own near band', () => {
    const data = {key: 'utopia:3', name: 'Utopia', ramps: [{key: 'a', label: 'Ramp 1', checkpoint: 0, surf: 30}]};
    const slot = {status: 'ready', label: 'PB', ramps: new Map([['a', {surf: 24}]])};
    const reference = {sources: () => [{name: 'pb', label: 'PB'}], version: () => 1, createConsumer: () => ({get: () => slot, release() {}, destroy() {}})};
    const rig = panelRig({reference, data, settings: {rampMetric: 'angle', referenceLossTolerance: 2}});
    rig.history.touchStats = () => ({runs: 23, collecting: true, touches: [{key: 'a', reach: 0.61,
      speedIn: {best: 2400}, speedOut: {best: 2390}, angle: {best: 3.1}, pb: {speedIn: 2410, speedOut: 2380, angle: 2.8}}]});
    try {
      rig.panel.show(); rig.panel.showView('ramps');
      expect(rig.body.innerHTML).toContain('Collecting touch stats: 23 of 50 runs. Reach firms up as runs come in.');
      expect(rig.body.innerHTML).toContain('>61%</span>');
      expect(rig.body.innerHTML).toContain('<span class="rn-hero warn"');
      expect(rig.body.innerHTML).toContain('>+0.3°</span>');
      expect(rig.body.innerHTML).toContain('within 0.5°');
      rig.action({rampMetric: 'speedIn'});
      expect(rig.body.innerHTML).toContain('within 2.0 u/s');
    } finally { rig.panel.destroy(); }
  });

  test('the open ramp lists Touch with its angle, Surf with Down and Up, then the speeds, grading only the difference', () => {
    const ramp = {board: 7.5, down: 14.6, up: 38.1, surf: 52.7};
    const reference = {board: 5.1, down: 13.5, up: 30, surf: 44};
    const touch = {reach: 0.5, speedIn: {best: 1929}, speedOut: {best: 1918}, angle: {best: 3.7}};
    const rows = detailRows({ramp, reference, touch, touchReference: {speedIn: 1951, speedOut: 1955, angle: 2.1}, tolerance: 2});
    expect(rows.map(row => [row.label, row.sub, row.you, row.ref, row.diff, row.tone])).toEqual([
      ['Touch', false, '−7.5', '−5.1', '−2.4', 'loss'],
      ['angle', true, '3.7°', '2.1°', '+1.6°', 'loss'],
      ['Surf', false, '−52.7', '−44.0', '−8.7', 'loss'],
      ['down', true, '−14.6', '−13.5', '−1.1', 'warn'],
      ['up', true, '−38.1', '−30.0', '−8.1', 'loss'],
      ['Speed in', false, '1929', '1951', '−22', 'loss'],
      ['Speed out', false, '1918', '1955', '−37', 'loss'],
    ]);
    // Net Surf and no touch stats: Touch and Surf only; no reference: nothing graded.
    expect(detailRows({ramp, split: false}).map(row => [row.label, row.ref, row.diff, row.tone])).toEqual([['Touch', '—', '', 'muted'], ['Surf', '—', '', 'muted']]);
  });

  test('each ramp’s number is its metric against the reference, on one bar scale for the map', () => {
    const ramps = [{key: 'a', surf: 40}, {key: 'b', surf: 20}, {key: 'c', surf: null}, {key: 'd', surf: 30}, {key: 'e', surf: 334}];
    const reference = {a: 30, b: 25, c: 10, e: 40};
    const surf = (list, compared) => scaleBars(list.map(ramp => rampMetric('surf', {ramp, reference: {surf: reference[ramp.key]}, tolerance: 2, compared})));
    const vs = surf(ramps, true);
    expect(vs.map(hero => [hero.text, hero.tone])).toEqual([['−10.0', 'loss'], ['+5.0', 'good'], ['—', 'muted'], ['', 'muted'], ['−294.0', 'loss']]);
    expect(vs[3].absent).toBe(true);
    // The bail runs off the end of the scale the other ramps set, so their bars still differ.
    expect(vs.map(hero => [hero.size, hero.over])).toEqual([[1, false], [.5, false], [0, false], [0, false], [1, true]]);
    const raw = surf(ramps.slice(0, 4), false);
    expect(raw.map(hero => [hero.text, hero.tone, hero.size])).toEqual([['−40.0', 'plain', 1], ['−20.0', 'plain', .5], ['—', 'muted', 0], ['−30.0', 'plain', .75]]);
    // The scale: the largest value within three times the median, never under 5 u/s.
    expect(barScale([6.8, 4.4, 11.9, 6.8, 6, 299.5, 1.7, 9.3, 0.3])).toBe(11.9);
    expect(barScale([300, 280, 8, 10, 12, 9, 7])).toBe(12);
    expect(barScale([13.4, 29.9, 46.9, 27.4, 40.2])).toBe(46.9);
    expect(barScale([0.4, -0.2, null])).toBe(5);
    expect(barScale([])).toBe(5);
    expect(barScale([0.4, 0.2], 1)).toBe(1);

    // Touch metrics come from the touch stats: speeds better higher, the angle lower, in degrees.
    const touch = {speedIn: {best: 2400, last10: 2390}, speedOut: {best: 2380}, angle: {best: 3.2, last10: 4}};
    const against = {speedIn: 2410, speedOut: 2370, angle: 2.4};
    expect(rampMetric('speedIn', {touch, touchReference: against, compared: true})).toMatchObject({text: '−10', tone: 'loss', bar: -10, you: '2400', ref: '2410'});
    expect(rampMetric('speedOut', {touch, touchReference: against, compared: true})).toMatchObject({text: '+10', tone: 'good', bar: 10});
    expect(rampMetric('angle', {touch, touchReference: against, compared: true})).toMatchObject({text: '+0.8°', tone: 'loss', you: '3.2°', ref: '2.4°'});
    expect(rampMetric('angle', {touch, mode: 'recent'})).toMatchObject({text: '4.0°', tone: 'plain', bar: 4});
    expect(rampMetric('angle', {touch, touchReference: null, compared: true})).toMatchObject({absent: true, tone: 'muted'});
    expect(rampMetric('speedIn', {touch: null, compared: true})).toMatchObject({text: '—', tone: 'muted', bar: null});
    expect(rampMetric('board', {ramp: {board: 7.5}, reference: {board: 5.1}, compared: true, tolerance: 2})).toMatchObject({text: '−2.4', tone: 'loss', you: '−7.5', ref: '−5.1'});
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

  test('the displayed native PB drives both checkpoint and finished-run comparisons', () => {
    const data = {key: 'utopia:3', pb: {id: 'local', time: 45}, splits: [
      {index: 0, label: 'CP1', time: 10.12, pb: 10.201},
      {index: 1, label: 'CP2', time: 21.233, pb: 22},
      {index: 2, label: 'CP3', time: 30, pb: 31},
      {index: 3, label: 'CP4', time: 35, pb: 36},
    ]};
    const session = {map: {id: 'utopia', version: 3}};
    const own = {runId: 'official', timeUs: 41000000, splitsUs: [10000000, 21233000, 30500000], createdAt: '2026-10-24T12:00:00Z'};
    const best = bestFinish(data, {session, refs: {own}});
    expect(best).toMatchObject({official: true, runId: 'official', time: 41, at: Date.parse(own.createdAt)});
    // The old local split says this was faster; the actual PB says slower.
    expect(paceCells(data, best).map(cell => [cell.delta, cell.tone])).toEqual([
      ['+0.120', 'loss'], ['±0.000', 'muted'], ['−0.500', 'good'], ['', 'muted'],
    ]);
    expect(versusPb({id: 'local', outcome: 'finished', time: 45}, best)).toEqual({text: '+4.000', tone: 'loss'});
    expect(versusPb({outcome: 'finished', time: 40}, best)).toEqual({text: '−1.000', tone: 'good'});
    expect(versusPb({outcome: 'finished', time: 41}, best)).toEqual({text: '±0.000', tone: 'muted'});
    expect(paceCells(data, bestFinish(data))[0]).toMatchObject({delta: '−0.081', tone: 'good'});
  });

  test('native PB ownership is limited to the current map/version and current account entry', () => {
    const data = {key: 'utopia:3', pb: {id: 'local', time: 45}};
    const refs = {own: {runId: 'native', timeUs: 41000000, splitsUs: []}};
    expect(bestFinish(data, {session: {map: {id: 'other', version: 3}}, refs}).official).toBe(false);
    expect(bestFinish(data, {session: {map: {id: 'utopia', version: 4}}, refs}).official).toBe(false);
    expect(bestFinish(data, {session: {map: {id: 'utopia', version: 3}}, refs: {own: null}}).official).toBe(false);
    expect(bestFinish(null, {key: 'utopia:3', session: {map: {id: 'utopia', version: 3}}, refs})).toMatchObject({official: true, time: 41});
    expect(bestFinish(null)).toBeNull();
    expect(bestFinish(data, {session: {map: {id: 'utopia', version: 3}}, refs: {own: {...refs.own, timeUs: NaN}}}).official).toBe(false);
  });

  test('stage splits stay cumulative and retain their native index when earlier bests are missing', () => {
    const data = {kind: 'S', splits: [{index: 1, label: 'S2', time: 25, pb: 26}, {index: 2, label: 'S3', time: 40, pb: 42}]};
    const best = {official: true, splitsUs: [10000000, 24000000, 41000000]};
    expect(paceCells(data, best).map(cell => [cell.delta, cell.tone])).toEqual([['+1.000', 'loss'], ['−1.000', 'good']]);
    expect(paceCells(data, null).map(cell => cell.tone)).toEqual(['muted', 'muted']);
    const unindexed = {splits: [undefined, -1, 0.5, '0', NaN].map(index => ({index, label: 'S2', time: 25, pb: 26}))};
    expect(paceCells(unindexed, best).map(cell => [cell.delta, cell.tone])).toEqual(Array(5).fill(['', 'muted']));
    expect(paceCells(unindexed, {official: false}).map(cell => [cell.delta, cell.tone])).toEqual(Array(5).fill(['−1.000', 'good']));
  });

  test('negative ramp losses are speed gains, compared without discarding their signs', () => {
    expect(compareRamp(-5, -2)).toEqual({text: '+5.0', diff: '+3.0', tone: 'good'});
    expect(compareRamp(-2, -5)).toEqual({text: '+2.0', diff: '−3.0', tone: 'loss'});
    expect(compareRamp(-2, -2)).toMatchObject({diff: '±0.0', tone: 'good'});
    expect([-5, -2].map(own => rampMetric('surf', {ramp: {surf: own}, reference: {surf: -3}, compared: true})).map(value => [value.text, value.tone])).toEqual([['+2.0', 'good'], ['−1.0', 'loss']]);
  });

  test('official Watch loads native replay only on demand and reuses it, while local fallback keeps its run id', async () => {
    const rig = panelRig();
    const originalSession = rig.session;
    rig.panel.show();
    for (let i = 0; i < 3; i++) rig.panel.setContext({menu: true});
    expect(rig.downloads).toBe(0);
    await rig.click(rig.watchId());
    expect(rig.loaded).toHaveLength(1);
    expect(rig.loaded[0].replay).toEqual({native: true});
    expect(rig.watched).toEqual([]);
    expect(rig.panel.open).toBe(false);
    expect(rig.session).not.toBe(originalSession);
    rig.panel.show();
    await rig.click(rig.watchId());
    expect(rig.downloads).toBe(1);
    expect(rig.loaded).toHaveLength(2);
    rig.panel.show();
    rig.refs = null;
    rig.panel.setContext({menu: true});
    expect(rig.watchId()).toBe('local');
    await rig.click(rig.watchId());
    expect(rig.watched.map(run => run.id)).toEqual(['local']);
    rig.panel.destroy();
  });

  test('an official PB remains watchable without any locally recorded history', async () => {
    const rig = panelRig({data: null});
    rig.panel.show();
    expect(rig.watchId()).toBeDefined();
    await rig.click(rig.watchId());
    expect(rig.loaded).toHaveLength(1);
    expect(rig.watched).toEqual([]);
    rig.panel.destroy();
  });

  test('a pending native download cannot apply after account ownership disappears', async () => {
    const rig = panelRig();
    let finish;
    rig.refs.loadReplay = () => new Promise(resolve => { finish = resolve; });
    rig.panel.show();
    const pending = rig.click(rig.watchId());
    await Promise.resolve();
    rig.refs = null;
    rig.panel.setContext({menu: true});
    finish({stale: true});
    await pending;
    expect(rig.loaded).toEqual([]);
    expect(rig.panel.open).toBe(true);
    expect(rig.watchId()).toBe('local');
    expect(rig.nodes.get('rn-status').textContent).toBe('');
    rig.panel.destroy();
  });

  test('a duplicate click shares the in-flight request and a new map invalidates its result', async () => {
    const rig = panelRig();
    let finish, count = 0;
    rig.refs.loadReplay = () => { count++; return new Promise(resolve => { finish = resolve; }); };
    rig.panel.show();
    const id = rig.watchId(), pending = rig.click(id);
    await rig.click(id);
    await Promise.resolve();
    expect(count).toBe(1);
    rig.session.map = {id: 'utopia', version: 4};
    rig.panel.setContext({menu: true});
    finish({stale: true});
    await pending;
    expect(rig.loaded).toEqual([]);
    expect(rig.panel.open).toBe(true);
    expect(rig.watchId()).toBe('local');
    rig.panel.destroy();
  });

  test('failed official downloads report an error and can be requested again', async () => {
    const rig = panelRig();
    let attempts = 0;
    rig.refs.loadReplay = async () => {
      if (++attempts === 1) throw new Error('Replay unavailable');
      return {native: true};
    };
    rig.panel.show();
    await rig.click(rig.watchId());
    expect(rig.panel.open).toBe(true);
    expect(rig.nodes.get('rn-status').textContent.length).toBeGreaterThan(0);
    expect(rig.loaded).toEqual([]);
    await rig.click(rig.watchId());
    expect(attempts).toBe(2);
    expect(rig.loaded).toHaveLength(1);
    rig.panel.destroy();
  });

  test('a newer account PB can start while an old download is pending, without its completion closing a reopened panel', async () => {
    const rig = panelRig();
    let finishOld;
    rig.refs.loadReplay = () => new Promise(resolve => { finishOld = resolve; });
    rig.panel.show();
    const old = rig.click(rig.watchId());
    await Promise.resolve();
    rig.refs = {...rig.refs, own: {...rig.refs.own, runId: 'new-account-pb', timeUs: 40000000},
      loadReplay: async () => ({current: true})};
    rig.panel.setContext({menu: true});
    await rig.click(rig.watchId());
    expect(rig.loaded.map(entry => entry.replay)).toEqual([{current: true}]);
    rig.panel.show();
    finishOld({stale: true});
    await old;
    expect(rig.panel.open).toBe(true);
    expect(rig.loaded.map(entry => entry.replay)).toEqual([{current: true}]);
    rig.panel.destroy();
  });


  test('Ramps loads only its selected source and releases ownership on source, view, map and visibility changes', () => {
    const acquired = [];
    const rampStore = {acquire(request) {
      const work = {...request, released: false};
      acquired.push(work);
      return {result: null, promise: new Promise(() => {}), release() { work.released = true; }};
    }};
    const rig = panelRig({data: {key: 'utopia:3', name: 'Utopia', ramps: [{key: 'ramp', checkpoint: 0, board: 4}]}, rampStore});
    rig.refs.loadRecordRoute = async () => ({});
    const select = source => rig.body.emit('click', {target: {closest: () => ({dataset: {source}})}});
    rig.panel.show();
    expect(acquired).toHaveLength(0);
    rig.panel.showView('ramps');
    expect(acquired).toHaveLength(1);
    expect(acquired[0].key).toContain(':official:');
    expect(rig.body.innerHTML).toContain('data-source=\"wr\"');
    select('wr');
    expect(acquired).toHaveLength(2);
    expect(acquired[0].released).toBe(true);
    expect(acquired[1].key).toEndWith(':ksf');
    rig.panel.showView('runs');
    expect(acquired[1].released).toBe(true);
    rig.panel.showView('ramps');
    rig.panel.close();
    expect(acquired[2].released).toBe(true);
    rig.panel.show();
    expect(acquired).toHaveLength(4);
    rig.nodes.get('rn-maps').emit('click', {target: {closest: () => ({dataset: {map: 'mesa:1'}})}});
    expect(acquired[3].released).toBe(true);
    expect(acquired).toHaveLength(4);
    rig.panel.show('utopia:3');
    expect(acquired).toHaveLength(5);
    rig.panel.setContext({menu: false, replay: false});
    expect(acquired[4].released).toBe(true);
    rig.panel.destroy();
    rig.rampReference.destroy();
  });

  test('an open Ramps comparison reacquires a cancelled same-key load after native Watch replaces Session', async () => {
    const acquired = [];
    const rampStore = {acquire(request) {
      const work = {...request, released: false, finish: null};
      acquired.push(work);
      return {result: null, promise: new Promise(resolve => { work.finish = resolve; }), release() { work.released = true; }};
    }};
    const rig = panelRig({data: {key: 'utopia:3', name: 'Utopia', ramps: [{key: 'ramp', checkpoint: 0, board: 4}]}, rampStore});
    rig.panel.show();
    rig.panel.showView('ramps');
    rig.session = {...rig.session};
    rig.panel.setContext({menu: true});
    expect(acquired).toHaveLength(2);
    expect(acquired[0].released).toBe(true);
    acquired[0].finish(null);
    await Promise.resolve();
    expect(rig.body.innerHTML).toContain('Reading the PB run');
    acquired[1].finish({config: {dt: 0.015}, feedback: {route: {indices: new Map([['ramp', 0]]), boards: [{valid: true, loss: 3}]}}});
    await Promise.resolve();
    expect(rig.body.innerHTML).toContain('at or better than PB');
    rig.panel.destroy();
    rig.rampReference.destroy();
  });

  test('ramp statistics change independently of comparison and reset only after confirmation', async () => {
    const data = {key: 'utopia:3', name: 'Utopia', ramps: [{key: 'ramp', label: 'Ramp 1', checkpoint: 0, board: 2}]};
    const rig = panelRig({data});
    const calls = [], resets = [];
    rig.history.view = (key, {rampMode = 'best'} = {}) => {
      calls.push([key, rampMode]);
      return {...data, ramps: data.ramps.map(ramp => ({...ramp, board: rampMode === 'best' ? 2 : 8, counts: {board: 3, down: 0, up: 1}}))};
    };
    rig.history.resetRampAverages = async key => { resets.push(key); };
    rig.panel.show();
    rig.panel.showView('ramps');
    rig.action({rampMode: 'recent'});
    expect(calls.at(-1)).toEqual(['utopia:3', 'recent']);
    rig.action({ramp: 'ramp'});
    expect(rig.body.innerHTML).toContain('3 runs');
    rig.action({rampMode: 'average'});
    expect(calls.at(-1)).toEqual(['utopia:3', 'average']);
    rig.action({resetAverages: 'ask'});
    expect(resets).toEqual([]);
    rig.action({resetAverages: 'cancel'});
    await rig.action({resetAverages: 'confirm'});
    expect(resets).toEqual([]);
    rig.action({resetAverages: 'ask'});
    await rig.action({resetAverages: 'confirm'});
    expect(resets).toEqual(['utopia:3']);
    expect(calls.at(-1)[1]).toBe('average');
    rig.action({rampMode: 'best'});
    expect(calls.at(-1)[1]).toBe('best');
    rig.panel.destroy();
  });

  test('reset failure stays on the map with a retryable confirmation and does not clear history', async () => {
    const rig = panelRig({data: {key: 'utopia:3', name: 'Utopia', ramps: []}});
    let attempts = 0;
    rig.history.resetRampAverages = async () => { if (++attempts === 1) throw new Error('Storage unavailable'); };
    rig.panel.show(); rig.panel.showView('ramps');
    rig.action({resetAverages: 'ask'});
    await rig.action({resetAverages: 'confirm'});
    expect(rig.panel.open).toBe(true);
    expect(rig.nodes.get('rn-status').textContent).toBe('Storage unavailable');
    await rig.action({resetAverages: 'confirm'});
    expect(attempts).toBe(2);
    rig.panel.destroy();
  });

  test('ramp playback follows comparison, acquires other destinations only on Watch, and keeps watch ownership through renders', async () => {
    const gets = [], watches = [];
    let finish;
    const slot = {status: 'ready', label: 'PB', ramps: new Map([['ramp', {tick: 500, board: 2}]])};
    const reference = {
      sources: () => [{name: 'pb', label: 'PB'}, {name: 'wr', label: 'Site WR'}],
      version: () => 1,
      createConsumer: () => ({get: (key, source) => { gets.push(source); return slot; },
        watchRamp: (...args) => { watches.push(args); return new Promise(resolve => { finish = resolve; }); },
        release() {}, destroy() {}}),
    };
    const rig = panelRig({reference, data: {key: 'utopia:3', name: 'Utopia', ramps: [{key: 'ramp', label: 'Ramp 1', checkpoint: 0, board: 4}]}});
    rig.panel.show();
    expect(gets).toEqual([]);
    rig.panel.showView('ramps');
    rig.action({ramp: 'ramp'});
    rig.action({source: 'wr'});
    const pending = rig.action({rampWatch: 'ramp'});
    expect(watches[0].slice(0, 3)).toEqual(['utopia:3', 'wr', 'ramp']);
    const before = gets.length;
    rig.action({rampMode: 'recent'});
    expect(gets).toHaveLength(before);
    finish(false); await pending;
    expect(rig.panel.open).toBe(true);
    rig.action({playSource: 'pb'});
    expect(watches).toHaveLength(1);
    const second = rig.action({rampWatch: 'ramp'});
    expect(watches[1][1]).toBe('pb');
    finish(true); await second;
    expect(rig.panel.open).toBe(false);
    rig.panel.destroy();
  });

  test('ready references without the exact ramp never start playback; Recent best uses its own boards', async () => {
    const calls = [];
    const reference = {sources: () => [{name: 'pb', label: 'PB'}], version: () => 1,
      createConsumer: () => ({get: () => ({status: 'ready', label: 'PB', ramps: new Map()}),
        watchRamp: async () => { calls.push('wrong'); return true; }, release() {}, destroy() {}})};
    const recentBest = {id: 'highlight', time: 42, outcome: 'finished', boards: [[700, 4, 'ramp']], replay: {start: 300}};
    const rig = panelRig({reference, data: {key: 'utopia:3', name: 'Utopia', recentBest, ramps: [
      {key: 'ramp', label: 'Ramp 1', checkpoint: 0, board: 4}, {key: 'absent', label: 'Ramp 2', checkpoint: 0, board: 3},
    ]}, control: {watch: async (...args) => { calls.push(args); return true; }}});
    rig.panel.show(); rig.panel.showView('ramps');
    rig.action({ramp: 'ramp'});
    await rig.action({rampWatch: 'ramp'});
    expect(calls).toEqual([]);
    expect(rig.nodes.get('rn-status').textContent).toContain('absent');
    rig.action({playSource: 'recentBest'});
    await rig.action({rampWatch: 'absent'});
    expect(calls).toEqual([]);
    await rig.action({rampWatch: 'ramp'});
    expect(rig.panel.open).toBe(false);
    rig.panel.destroy();
  });

  test('local Watch cancels changed ramp/map selections but completes its own menu-to-replay handoff', async () => {
    let rig, pendingRead, generation = 0, playing = null, index = 0;
    const replay = {mapId: 'boreas', mapVersion: 2, config: {dt: .015}, commands: Array(1000).fill({})};
    const player = {
      get replay() { return playing; }, index: null, pending: null, clock: {speed: 1, paused: false},
      host: {position: () => index, session: () => rig.session},
      get paused() { return this.clock.paused; }, atEnd() { return !playing || index >= this.index.end; },
      pause() { this.clock.paused = true; }, play() { this.clock.paused = false; },
      requestSeek(tick) { this.pending = tick; },
      applyPending() {
        if (this.pending === null) return;
        index = Math.max(0, Math.min(this.index.reachable, Math.round(this.pending)));
        this.pending = null;
      },
    };
    const hooks = {
      reserve: () => ++generation, isCurrent: token => token === generation,
      playback: () => ({replay: playing, index}),
      async watch(data, label, current, token) {
        if (token !== generation || !current()) return;
        rig.session = {map: {id: data.mapId, version: data.mapVersion}, config: data.config};
        playing = data; index = 0;
        player.clock.paused = false;
        player.index = {end: data.commands.length, indexed: data.commands.length, complete: true, markers: [],
          get reachable() { return Math.min(this.end, this.indexed); }};
        // The native menu observer runs before Watch's promise continuation,
        // while the bar can still report its previous visibility.
        rig.panel.setContext({menu: false, replay: false});
        await Promise.resolve();
      },
      transport: () => player,
    };
    const control = createReplayControl({getAdapter: () => adapter, getSession: () => rig?.session,
      archive: {has: () => true, get: () => new Promise(resolve => { pendingRead = resolve; })}});
    const adapter = {replay: hooks};
    const run = {id: 'highlight', map: 'boreas:2', mapName: 'Boreas', time: 42, outcome: 'finished',
      boards: [[700, 4, 'ramp']], replay: {start: 0}};
    rig = panelRig({data: {key: 'boreas:2', name: 'Boreas', recentBest: run, ramps: [{key: 'ramp', label: 'Ramp 1'}]}, control});
    rig.refs = null;
    try {
      rig.panel.show('boreas:2'); rig.panel.showView('ramps');
      rig.action({ramp: 'ramp'}); rig.action({playSource: 'recentBest'});
      const cancelled = rig.action({rampWatch: 'ramp'});
      rig.action({playSource: 'wr'});
      pendingRead(replay); await cancelled;
      expect(playing).toBeNull();
      expect(rig.panel.open).toBe(true);
      const moved = rig.click(run.id);
      rig.nodes.get('rn-maps').emit('click', {target: {closest: () => ({dataset: {map: 'utopia:3'}})}});
      pendingRead(replay); await moved;
      expect(playing).toBeNull();
      rig.panel.show('boreas:2'); rig.panel.showView('ramps'); rig.action({ramp: 'ramp'});
      rig.action({playSource: 'recentBest'});
      const accepted = rig.action({rampWatch: 'ramp'});
      pendingRead(replay); await accepted;
      expect(rig.session.map.id).toBe('boreas');
      expect(control.status()).toMatchObject({index: 667, playing: false});
      expect(rig.panel.open).toBe(false);
    } finally { rig.panel.destroy(); control.destroy(); }
  });


  test('Recent best is watchable outside the recent list and expiry refresh stops while hidden', async () => {
    const timers = [];
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay) => { timers.push({callback, delay}); return 0; });
    let now = 1000, reads = 0;
    const run = {id: 'highlight', time: 42, outcome: 'finished', expiresAt: 2000};
    const rig = panelRig({now: () => now});
    rig.history.view = () => { reads++; return {key: 'utopia:3', name: 'Utopia', recentBest: now < 2000 ? run : null}; };
    try {
      rig.panel.show();
      expect(timers).toHaveLength(1);
      expect(timers[0].delay).toBe(1001);
      await rig.click('highlight');
      expect(rig.watched).toEqual([run]);
      const closedReads = reads;
      timers[0].callback();
      expect(reads).toBe(closedReads);
      rig.panel.show();
      now = 2001;
      timers.at(-1).callback();
      expect(rig.body.innerHTML).not.toContain('data-watch="highlight"');
    } finally { rig.panel.destroy(); timer.mockRestore(); }
  });

  test('subscription renders preserve an alternate replay request until a new destination cancels it', async () => {
    const gets = [], calls = [], releases = [];
    let notify, finish;
    const reference = {
      sources: () => [{name: 'pb', label: 'PB'}, {name: 'wr', label: 'KSF WR'}],
      version: () => 1,
      subscribe(listener) { notify = listener; return () => {}; },
      createConsumer: () => ({
        get(key, source) { gets.push(source); return {status: 'ready', label: source, ramps: new Map([['ramp', {tick: 500}]])}; },
        watchRamp(...args) { calls.push(args); return new Promise(resolve => { finish = resolve; }); },
        release() { releases.push(true); }, destroy() {},
      }),
    };
    const rig = panelRig({reference, data: {key: 'utopia:3', name: 'Utopia', ramps: [{key: 'ramp', label: 'Ramp 1'}]}});
    try {
      rig.panel.show(); rig.panel.showView('ramps');
      rig.action({ramp: 'ramp'}); rig.action({playSource: 'wr'});
      expect(gets.every(source => source === 'pb')).toBe(true);
      const pending = rig.action({rampWatch: 'ramp'}), acquired = gets.length, released = releases.length;
      notify(); rig.body.scrollTop = 123; rig.action({rampMode: 'average'}); notify();
      expect(gets).toHaveLength(acquired);
      expect(releases).toHaveLength(released);
      expect(rig.body.scrollTop).toBe(123);
      expect(calls[0][1]).toBe('wr');
      rig.action({playSource: 'pb'});
      expect(releases.length).toBeGreaterThan(released);
      expect(gets.at(-1)).toBe('pb');
      finish(true); await pending;
      expect(rig.panel.open).toBe(true);
      expect(rig.nodes.get('rn-status').textContent).toBe('');
    } finally { rig.panel.destroy(); }
  });

  test.each(['source', 'account', 'board', 'config', 'view'])('pending ramp navigation loses ownership when %s changes', async change => {
    const settings = {wrSource: 'ksf'};
    let finish, releases = 0;
    const reference = {
      sources: () => [{name: 'pb', label: 'PB'}, {name: 'wr', label: settings.wrSource === 'ksf' ? 'KSF WR' : 'Site WR'}],
      version: () => settings.wrSource,
      createConsumer: () => ({
        get: () => ({status: 'ready', label: 'PB', ramps: new Map([['ramp', {tick: 500}]])}),
        watchRamp: () => new Promise(resolve => { finish = resolve; }),
        release() { releases++; }, destroy() {},
      }),
    };
    const rig = panelRig({reference, settings, data: {key: 'utopia:3', name: 'Utopia', ramps: [{key: 'ramp', label: 'Ramp 1'}]}});
    try {
      rig.panel.show(); rig.panel.showView('ramps'); rig.action({ramp: 'ramp'});
      const pending = rig.action({rampWatch: 'ramp'}), before = releases;
      if (change === 'source') settings.wrSource = 'leaderboard';
      if (change === 'account') rig.refs = {...rig.refs, ownerKey: 'another-account'};
      if (change === 'board') rig.refs = {...rig.refs, boardId: 'another-board'};
      if (change === 'config') rig.session = {...rig.session, config: {dt: 0.01}};
      if (change === 'view') rig.panel.showView('runs');
      else rig.panel.setContext({menu: true});
      expect(releases).toBeGreaterThan(before);
      finish(true); await pending;
      expect(rig.panel.open).toBe(true);
      expect(rig.nodes.get('rn-status').textContent).toBe('');
    } finally { rig.panel.destroy(); }
  });

  test('native replay format labels do not cancel movement-compatible ramp playback', async () => {
    let finish, releases = 0;
    const reference = {
      sources: () => [{name: 'wr', label: 'KSF WR'}], version: () => 1,
      createConsumer: () => ({
        get: () => ({status: 'ready', label: 'KSF WR', ramps: new Map([['ramp', {tick: 500}]])}),
        watchRamp: () => new Promise(resolve => { finish = resolve; }),
        release() { releases++; }, destroy() {},
      }),
    };
    const rig = panelRig({reference, data: {key: 'utopia:3', name: 'Utopia', ramps: [{key: 'ramp', label: 'Ramp 1'}]}});
    try {
      rig.panel.show(); rig.panel.showView('ramps'); rig.action({ramp: 'ramp'});
      const pending = rig.action({rampWatch: 'ramp'}), before = releases;
      rig.session = {...rig.session, replayFormat: 7, config: {...rig.session.config, version: 'legacy', unrestrictedStart: true}};
      rig.panel.setContext({menu: true});
      expect(releases).toBe(before);
      finish(true); await pending;
      expect(rig.panel.open).toBe(false);
    } finally { rig.panel.destroy(); }
  });

  test('segmented radios use arrow keys and Home/End to select without passing keys to the game', () => {
    const rig = panelRig({data: {key: 'utopia:3', name: 'Utopia', ramps: [{key: 'ramp', label: 'Ramp 1'}]}});
    const selected = [], focused = [];
    const buttons = ['best', 'recent', 'average'].map(mode => ({
      focus: () => focused.push(mode),
      click: () => { selected.push(mode); rig.action({rampMode: mode}); },
      closest: () => group,
    }));
    const group = {querySelectorAll: () => buttons};
    let prevented = 0, stopped = 0;
    const press = (index, key) => rig.panel.handleKey({
      type: 'keydown', key, code: key,
      composedPath: () => [{closest: () => buttons[index]}, rig.nodes.get('runs-panel')],
      preventDefault() { prevented++; }, stopPropagation() { stopped++; },
    });
    try {
      rig.panel.show(); rig.panel.showView('ramps');
      press(0, 'ArrowLeft'); press(2, 'Home'); press(0, 'End'); press(2, 'ArrowRight');
      expect(selected).toEqual(['average', 'best', 'average', 'best']);
      expect(focused).toEqual(selected);
      expect(prevented).toBe(4);
      expect(stopped).toBe(4);
    } finally { rig.panel.destroy(); }
  });
});
