import {expect, test} from 'bun:test';
import {createEntryTiming, entryPhases, formatEntry} from '../src/entry-timing.js';

test('the phases split the time to the first step and always add up', () => {
  expect(entryPhases({start: 100, loaded: 740, step: 1284, attempt: {start: 600, end: 950}}))
    .toEqual({total: 1184, loading: 640, ticket: 210, rest: 334});
  // Answered while loading: nothing left to wait for.
  expect(entryPhases({start: 0, loaded: 500, step: 520, attempt: {start: 300, end: 450}})).toEqual({total: 520, loading: 500, ticket: 0, rest: 20});
  // Requested after loading, and still pending at the step.
  expect(entryPhases({start: 0, loaded: 500, step: 900, attempt: {start: 600, end: null}})).toEqual({total: 900, loading: 500, ticket: 300, rest: 100});
  expect(entryPhases({start: 0, loaded: 500, step: 700})).toEqual({total: 700, loading: 500, ticket: 0, rest: 200});
});

test('the line names the map, rounds each phase and says where the collision data came from', () => {
  const phases = {total: 1184.4, loading: 640.2, ticket: 209.6, rest: 334.6};
  expect(formatEntry('surf_demise', phases, 'cache')).toBe('[Surfd QoL] surf_demise ready in 1184 ms: loading 640, run ticket wait 210, first step 335; collision record from cache');
  expect(formatEntry('surf_demise', phases, 'download')).toBe('[Surfd QoL] surf_demise ready in 1184 ms: loading 640, run ticket wait 210, first step 335; no collision record yet');
  expect(formatEntry('surf_demise', phases, null)).toBe('[Surfd QoL] surf_demise ready in 1184 ms: loading 640, run ticket wait 210, first step 335');
});

function clock() {
  let time = 0;
  const lines = [];
  return {lines, at: value => { time = value; }, timing: createEntryTiming({now: () => time, log: line => lines.push(line)})};
}

test('an entry is reported once, at its first step', async () => {
  const {lines, at, timing} = clock();
  expect(timing.pending).toBe(false);
  timing.step();
  at(100);
  timing.start('surf_demise');
  expect(timing.pending).toBe(true);
  at(600);
  let answer;
  timing.attempt(new Promise(resolve => { answer = resolve; }));
  at(740);
  timing.loaded('cache');
  at(950);
  answer();
  await Promise.resolve();
  await Promise.resolve();
  at(1284);
  timing.step();
  at(1300);
  timing.step();
  expect(lines).toEqual(['[Surfd QoL] surf_demise ready in 1184 ms: loading 640, run ticket wait 210, first step 334; collision record from cache']);
  expect(timing.pending).toBe(false);
});

test('a load that never draws its first frame is not reported', () => {
  const {lines, at, timing} = clock();
  timing.start('surf_one');
  at(50);
  timing.step();
  timing.loaded('cache');
  timing.step();
  expect(lines).toEqual([]);
});

test('a newer ticket request replaces an older one, and requests outside an entry are ignored', async () => {
  const {lines, at, timing} = clock();
  timing.attempt(new Promise(() => {}));
  timing.start('surf_one');
  timing.attempt(Promise.reject(new Error('offline')));
  at(10);
  timing.attempt(new Promise(() => {}));
  at(400);
  timing.loaded('download');
  at(500);
  timing.step();
  expect(lines).toEqual(['[Surfd QoL] surf_one ready in 500 ms: loading 400, run ticket wait 100, first step 0; no collision record yet']);
});
