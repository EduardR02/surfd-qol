import {expect, spyOn, test} from 'bun:test';
import worker from '../signal/src/worker.js';
import {ORIGIN} from '../signal/src/room.js';

const ROOM = 'p-abcdefghjkmn';
const listing = {name: "Host's room", mapId: 'surf_utopia', players: 1, capacity: 16,
  roster: [{name: 'Host_1', guest: false, userId: '123e4567-e89b-12d3-a456-426614174000'}]};

test('concurrent directory reads share one Lobby request, a failure gives 503, and the cached answer goes stale', async () => {
  let now = Date.now() + 100000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const requests = [];
  const env = {LOBBY: {idFromName: name => name, get: () => ({
    fetch: () => new Promise(resolve => { requests.push(resolve); }),
  })}};
  const request = (origin = ORIGIN, method = 'GET') => new Request('https://signal.example/rooms', {method, headers: {Origin: origin}});
  try {
    expect((await worker.fetch(request('https://other.example'), env)).status).toBe(403);
    expect((await worker.fetch(request(ORIGIN, 'POST'), env)).status).toBe(405);
    expect(requests).toHaveLength(0);
    const failed = [worker.fetch(request(), env), worker.fetch(request(), env)];
    expect(requests).toHaveLength(1);
    requests[0](new Response('upstream failed', {status: 500}));
    for (const response of await Promise.all(failed)) expect(response.status).toBe(503);

    const loading = [worker.fetch(request(), env), worker.fetch(request(), env)];
    expect(requests).toHaveLength(2);
    requests[1](Response.json({rooms: [{id: ROOM, ...listing}]}));
    for (const response of await Promise.all(loading)) {
      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
      expect((await response.json()).rooms[0]).toEqual({id: ROOM, ...listing});
    }
    now += 1000;
    expect((await worker.fetch(request(), env)).status).toBe(200);
    expect(requests).toHaveLength(2);
    now += 60000;
    const refresh = worker.fetch(request(), env);
    expect(requests).toHaveLength(3);
    requests[2](Response.json({rooms: []}));
    expect(await (await refresh).json()).toEqual({rooms: []});
  } finally { clock.mockRestore(); }
});
