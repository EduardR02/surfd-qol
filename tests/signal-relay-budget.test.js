import {expect, test} from 'bun:test';
import {RELAY_BUDGET_KEY, reserveRelay} from '../signal/src/relay-budget.js';
import {RELAY_TTL, RELAY_TIMEOUT_MS, createRelay} from '../signal/src/relay.js';
import worker, {Lobby} from '../signal/src/worker.js';

const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const ENV = {RELAY: 'on', RELAY_GRANTS_PER_HOUR: '4', RELAY_GRANTS_PER_DAY: '8', RELAY_MAX_UNEXPIRED: '4'};

// Model Durable Object atomic transactions, including isolation and rollback.
// A new object/helper shares only committed storage, never in-memory counters.
function storage() {
  const values = new Map();
  let pending = Promise.resolve();
  return {
    values,
    async list() { return structuredClone(values); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { return values.delete(key); },
    transaction(callback) {
      const result = pending.then(async () => {
        const working = structuredClone(values);
        const answer = await callback({
          async get(key) { return structuredClone(working.get(key)); },
          async put(key, value) { working.set(key, structuredClone(value)); },
        });
        values.clear();
        for (const [key, value] of working) values.set(key, value);
        return answer;
      });
      pending = result.catch(() => {});
      return result;
    },
  };
}

async function lobby(store, env = ENV) {
  let ready;
  const object = new Lobby({storage: store, blockConcurrencyWhile(callback) { ready = callback(); }}, env);
  await ready;
  return object;
}
const requestReservation = object => object.fetch(new Request('https://lobby/relay-reservation', {method: 'POST'}));

test('concurrent reservations share atomically persisted limits across helper restarts', async () => {
  const store = storage(), at = DAY;
  const results = await Promise.all(Array.from({length: 20}, () => reserveRelay(store, ENV, () => at)));
  expect(results.filter(Boolean)).toHaveLength(4);
  expect(store.values.get(RELAY_BUDGET_KEY).grants).toHaveLength(4);
  expect(await reserveRelay(store, {...ENV}, () => at + 1)).toBeNull();
  expect(results.filter(Boolean)).toEqual(Array(4).fill({issueBy: at + RELAY_TIMEOUT_MS}));
});

test('the hourly grant window rolls from each reservation, not clock-hour boundaries', async () => {
  const store = storage(), env = {...ENV, RELAY_GRANTS_PER_HOUR: '1'};
  let at = HOUR - 1;
  const reserve = () => reserveRelay(store, env, () => at);
  expect(await reserve()).not.toBeNull();
  at = HOUR;
  expect(await reserve()).toBeNull();
  at = 2 * HOUR - 2;
  expect(await reserve()).toBeNull();
  at = 2 * HOUR - 1;
  expect(await reserve()).not.toBeNull();
});

test('daily grants remain spent after credentials expire and roll off after 24 hours', async () => {
  const store = storage(), env = {...ENV, RELAY_GRANTS_PER_DAY: '2'};
  let at = DAY;
  const reserve = () => reserveRelay(store, env, () => at);
  expect(await reserve()).not.toBeNull();
  at += 2 * HOUR;
  expect(await reserve()).not.toBeNull();
  at = 2 * DAY - 1;
  expect(await reserve()).toBeNull();
  at = 2 * DAY;
  expect(await reserve()).not.toBeNull();
  expect(store.values.get(RELAY_BUDGET_KEY).grants).toHaveLength(2);
});

test('unexpired reservations include provider time and survive a new helper instance', async () => {
  const store = storage(), env = {...ENV, RELAY_MAX_UNEXPIRED: '1'};
  const at = DAY, expires = at + RELAY_TIMEOUT_MS + RELAY_TTL * 1000;
  expect(await reserveRelay(store, env, () => at)).not.toBeNull();
  expect(store.values.get(RELAY_BUDGET_KEY).grants).toEqual([{at, expires}]);
  expect(await reserveRelay(store, {...env}, () => expires - 1)).toBeNull();
  expect(await reserveRelay(store, {...env}, () => expires)).not.toBeNull();
});

test('every budget limit must be an explicit positive safe integer', async () => {
  const invalid = [undefined, null, '', ' ', '0', 0, -1, '-1', 1.5, '1.5', true, [], {}, NaN, Infinity,
    Number.MAX_SAFE_INTEGER + 1, '9007199254740992', '1e3', '0x10', ' 4 ', '04'];
  for (const key of ['RELAY_GRANTS_PER_HOUR', 'RELAY_GRANTS_PER_DAY', 'RELAY_MAX_UNEXPIRED']) {
    for (const value of invalid) {
      const store = storage();
      expect(await reserveRelay(store, {...ENV, [key]: value})).toBeNull();
      expect(store.values.size).toBe(0);
    }
    expect(await reserveRelay(storage(), {...ENV, [key]: 4})).not.toBeNull();
    expect(await reserveRelay(storage(), {...ENV, [key]: String(Number.MAX_SAFE_INTEGER)})).not.toBeNull();
  }
  expect(await reserveRelay(storage(), undefined)).toBeNull();
  expect(await reserveRelay(storage(), {...ENV, RELAY: 'off'})).toBeNull();
});

test('corrupt records, invalid clocks and storage failures fail closed', async () => {
  for (const record of [null, {}, {version: 2, grants: []}, {version: 1, grants: {}},
    {version: 1, grants: [null]}, {version: 1, grants: [{at: DAY + 1, expires: DAY + HOUR}]},
    {version: 1, grants: [{at: DAY, expires: DAY}]}, {version: 1, grants: [{at: -1, expires: DAY}]}]) {
    const store = storage();
    store.values.set(RELAY_BUDGET_KEY, record);
    expect(await reserveRelay(store, ENV, () => DAY)).toBeNull();
    expect(store.values.get(RELAY_BUDGET_KEY)).toEqual(record);
  }
  for (const at of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER, 1.5]) {
    expect(await reserveRelay(storage(), ENV, () => at)).toBeNull();
  }
  const fail = () => { throw new Error('Storage unavailable'); };
  for (const store of [undefined, {}, {transaction: fail},
    {transaction: callback => callback({get: fail})},
    {transaction: callback => callback({get: async () => undefined, put: fail})},
    {async transaction(callback) {
      await callback({get: async () => undefined, put: async () => {}});
      throw new Error('Commit failed');
    }}]) {
    expect(await reserveRelay(store, ENV)).toBeNull();
  }
});

test('failed provider requests burn reservations and budget denial never calls the provider', async () => {
  const store = storage(), at = DAY, calls = [];
  const env = {...ENV, RELAY_MAX_UNEXPIRED: '1', TURN_KEY_ID: 'key', TURN_KEY_API_TOKEN: 'secret'};
  const issue = createRelay({env, allow: () => true, now: () => at,
    reserve: () => reserveRelay(store, env, () => at),
    fetch: async () => { calls.push('provider'); return new Response(null, {status: 503}); }});
  expect(await issue('host')).toBeNull();
  expect(await issue('guest')).toBeNull();
  expect(await issue('renewal')).toBeNull();
  expect(calls).toEqual(['provider']);
  expect(store.values.get(RELAY_BUDGET_KEY).grants).toHaveLength(1);
});

test('independent issuers share one committed budget for successful concurrent grants', async () => {
  const store = storage(), at = DAY, calls = [];
  const env = {...ENV, TURN_KEY_ID: 'key', TURN_KEY_API_TOKEN: 'secret'};
  const issuers = Array.from({length: 20}, () => createRelay({env, allow: () => true, now: () => at,
    reserve: () => reserveRelay(store, env, () => at),
    fetch: async () => {
      expect(store.values.get(RELAY_BUDGET_KEY).grants.length).toBeGreaterThan(0);
      calls.push('provider');
      return Response.json({iceServers: [{urls: ['turn:relay.example:3478'], username: 'user', credential: 'password'}]});
    }}));
  const issued = await Promise.all(issuers.map((issue, index) => issue(`client-${index}`)));
  expect(issued.filter(Boolean)).toHaveLength(4);
  expect(calls).toHaveLength(4);
  expect(store.values.get(RELAY_BUDGET_KEY).grants).toHaveLength(4);
});

test('invalid deployment limits and unavailable budget storage never reach the provider', async () => {
  const calls = [], at = DAY;
  for (const [store, limits] of [[storage(), {...ENV, RELAY_GRANTS_PER_DAY: undefined}],
    [storage(), {...ENV, RELAY_MAX_UNEXPIRED: 'unlimited'}], [{}, ENV]]) {
    const env = {...limits, TURN_KEY_ID: 'key', TURN_KEY_API_TOKEN: 'secret'};
    const issue = createRelay({env, allow: () => true, now: () => at,
      reserve: () => reserveRelay(store, env, () => at),
      fetch: async () => { calls.push('provider'); return new Response(); }});
    expect(await issue('client')).toBeNull();
  }
  expect(calls).toEqual([]);
});

test('Lobby restarts and directory cleanup cannot reset the singleton budget', async () => {
  const store = storage(), env = {...ENV, RELAY_MAX_UNEXPIRED: '1'};
  const first = await lobby(store, env);
  expect((await requestReservation(first)).status).toBe(201);
  const committed = structuredClone(store.values.get(RELAY_BUDGET_KEY));
  const second = await lobby(store, env);
  expect(await (await second.fetch(new Request('https://lobby/rooms'))).json()).toEqual({rooms: []});
  await second.fetch(new Request('https://lobby/listing/p-abcdefghjkmn', {method: 'DELETE'}));
  expect(store.values.get(RELAY_BUDGET_KEY)).toEqual(committed);
  expect((await requestReservation(second)).status).toBe(503);
  expect((await second.fetch(new Request('https://lobby/relay-reservation'))).status).toBe(405);
});

test('the public Worker never forwards requests to the internal reservation endpoint', async () => {
  const calls = [];
  const binding = {idFromName() { calls.push('id'); }, get() { calls.push('get'); }};
  const response = await worker.fetch(new Request('https://signal/relay-reservation', {
    method: 'POST', headers: {Origin: 'https://surfd.net'},
  }), {LOBBY: binding, ROOMS: binding});
  expect(response.status).toBe(404);
  expect(calls).toEqual([]);
});
