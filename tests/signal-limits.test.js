import {expect, spyOn, test} from 'bun:test';
import {CONNECTIONS, clientOf, createLimiter} from '../signal/src/limits.js';
import worker from '../signal/src/worker.js';

const ROOM = 'p-abcdefghjkmn';
const from = ip => new Request(`https://signal.example/rooms/${ROOM}?role=guest`,
  {headers: {Origin: 'https://surfd.net', Upgrade: 'websocket', ...ip ? {'CF-Connecting-IP': ip} : {}}});

test('a client gets its burst at once, then one more per interval; other clients are unaffected', () => {
  let time = 0;
  const allow = createLimiter({burst: 3, every: 1000, now: () => time});
  expect([allow('a'), allow('a'), allow('a'), allow('a')]).toEqual([true, true, true, false]);
  expect(allow('b')).toBe(true);
  time += 999;
  expect(allow('a')).toBe(false);
  time += 1;
  expect([allow('a'), allow('a')]).toEqual([true, false]);
  time += 60000;
  expect([allow('a'), allow('a'), allow('a'), allow('a')]).toEqual([true, true, true, false]);
});

test('the limiter forgets its least recent client when full', () => {
  const allow = createLimiter({burst: 1, every: 1000, clients: 2, now: () => 0});
  expect([allow('a'), allow('b'), allow('a')]).toEqual([true, true, false]);
  allow('c');
  // b was the least recent, so c pushed it out; a is still remembered.
  expect([allow('a'), allow('b')]).toEqual([false, true]);
});

test('clients are IPv4 addresses or IPv6 /64 networks', () => {
  expect(clientOf(from('203.0.113.7'))).toBe('203.0.113.7');
  expect(clientOf(from('2001:db8:1:2:aaaa:bbbb:cccc:dddd'))).toBe('2001:db8:1:2');
  expect(clientOf(from('2001:DB8:1:2::9'))).toBe('2001:db8:1:2');
  expect(clientOf(from('2001:db8::1'))).toBe('2001:db8:0:0');
  expect(clientOf(from('::1'))).toBe('0:0:0:0');
  expect(clientOf(from(null))).toBe('');
});

test('the Worker refuses connections past a client burst with 429, before any room wakes', async () => {
  let now = Date.now() + 10 ** 9;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const woken = [];
  const env = {ROOMS: {idFromName: name => name, get: id => ({fetch: () => { woken.push(id); return new Response('room'); }})}};
  try {
    for (let i = 0; i < CONNECTIONS.burst; i++) expect((await worker.fetch(from('198.51.100.1'), env)).status).toBe(200);
    expect((await worker.fetch(from('198.51.100.1'), env)).status).toBe(429);
    expect(woken).toHaveLength(CONNECTIONS.burst);
    expect((await worker.fetch(from('198.51.100.2'), env)).status).toBe(200);
    now += CONNECTIONS.every;
    expect((await worker.fetch(from('198.51.100.1'), env)).status).toBe(200);
  } finally { clock.mockRestore(); }
});
