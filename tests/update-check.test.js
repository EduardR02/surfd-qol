import {expect, test} from 'bun:test';
import {createUpdateChecker, newerVersion, RELEASE_URL} from '../extension/update-check.js';

const memoryStorage = () => {
  const data = {};
  return {get: async key => ({[key]: data[key]}), set: async values => {Object.assign(data, values);}};
};
const release = tag_name => ({ok: true, json: async () => ({tag_name, draft: false, prerelease: false})});

test('release comparison is numeric, handles missing build parts and excludes prerelease tags', () => {
  expect(newerVersion('v1.10.0', '1.9.9')).toBe(true);
  expect(newerVersion('v2.0.0', '1.99.99')).toBe(true);
  expect(newerVersion('1.0.1.1', '1.0.1')).toBe(true);
  expect(newerVersion('1.0.1', '1.0.1.0')).toBe(false);
  expect(newerVersion('v1.0.0', '1.0.1')).toBe(false);
  expect(newerVersion('v2.0.0-beta', '1.0.1')).toBe(false);
  expect(newerVersion('<script>', '1.0.1')).toBe(false);
});

test('concurrent visits and worker restarts share an hourly cached notice', async () => {
  const storage = memoryStorage();
  let requests = 0, now = 1000;
  const fetcher = async () => {requests++; return release('v1.10.0');};
  const checker = createUpdateChecker({storage, version: '1.9.0', fetcher, clock: () => now});
  const expected = {version: '1.10.0', url: RELEASE_URL};
  expect(await Promise.all([checker(), checker()])).toEqual([expected, expected]);
  const restarted = createUpdateChecker({storage, version: '1.9.0', fetcher, clock: () => now});
  expect(await restarted()).toEqual(expected);
  expect(requests).toBe(1);
  now += 60 * 60 * 1000 - 1;
  expect(await restarted()).toEqual(expected);
  expect(requests).toBe(1);
  now++;
  expect(await restarted()).toEqual(expected);
  expect(requests).toBe(2);
  const upgraded = createUpdateChecker({storage, version: '1.10.0', fetcher, clock: () => now});
  expect(await upgraded()).toBeNull();
});

test('a startup check discovers a newer release even inside the cached hour and shares pending requests', async () => {
  const storage = memoryStorage();
  let requests = 0, latest = 'v1.10.0';
  const fetcher = async () => { requests++; return release(latest); };
  const checker = createUpdateChecker({storage, version: '1.9.0', fetcher, clock: () => 1000});
  expect((await checker()).version).toBe('1.10.0');
  latest = 'v1.11.0';
  const restarted = createUpdateChecker({storage, version: '1.9.0', fetcher, clock: () => 2000});
  expect((await restarted()).version).toBe('1.10.0');
  expect(requests).toBe(1);
  const expected = {version: '1.11.0', url: RELEASE_URL};
  expect(await Promise.all([restarted({force: true}), restarted({force: true})])).toEqual([expected, expected]);
  expect(requests).toBe(2);
  expect(await restarted()).toEqual(expected);
  expect(requests).toBe(2);
});

test('offline and draft release failures do not break setup or retry every visit', async () => {
  for (const fetcher of [async () => {throw new Error('offline');}, async () => ({ok: true, json: async () => ({tag_name: 'v9.0.0', draft: true})})]) {
    const storage = memoryStorage();
    let requests = 0;
    const checker = createUpdateChecker({storage, version: '1.0.1', fetcher: async (...args) => {requests++; return fetcher(...args);}, clock: () => 1000});
    expect(await checker()).toBeNull();
    expect(await checker()).toBeNull();
    expect(requests).toBe(1);
  }
});
