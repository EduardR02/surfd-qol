import {expect, test} from 'bun:test';
import {ADAPTER_MARKER} from '../extension/instrument.js';
import {loadGameSource} from '../extension/source-loader.js';

const url = 'https://surfd.net/assets/game-test.js';

test('old patches and conditional responses fetch clean source', async () => {
  for (const source of [null, 'patched module\n/* surfd-qol-adapter-v1: old */']) {
    const requests = [];
    const loaded = await loadGameSource(url, source, async (...args) => {
      requests.push(args);
      return {ok: true, text: async () => 'clean module'};
    });
    expect(loaded).toBe('clean module');
    expect(requests).toEqual([[url, {cache: 'no-store', credentials: 'omit'}]]);
  }
});

test('current and unmodified modules keep their response body', async () => {
  const unavailable = () => { throw new Error('Unexpected fetch'); };
  for (const source of ['clean module', `patched module${ADAPTER_MARKER} current */`]) {
    expect(await loadGameSource(url, source, unavailable)).toBe(source);
  }
});

test('a failed or still-patched refetch throws instead of returning stale code', async () => {
  await expect(loadGameSource(url, null, async () => ({ok: false, status: 503}))).rejects.toThrow('HTTP 503');
  await expect(loadGameSource(url, null, async () => ({ok: true, text: async () => 'old\n/* surfd-qol-adapter-v1: old */'}))).rejects.toThrow('unmodified');
});
