import {expect, spyOn, test} from 'bun:test';
import worker from '../signal/src/worker.js';
import {ORIGIN} from '../signal/src/room.js';

const ROOM = 'p-abcdefghjkmn';
const listing = {name: "Host's room", mapId: 'surf_utopia', players: 1};

test('directory refreshes share requests, reject failures and expire', async () => {
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
      expect((await response.json()).rooms[0].id).toBe(ROOM);
    }
    now += 9999;
    expect((await worker.fetch(request(), env)).status).toBe(200);
    expect(requests).toHaveLength(2);
    now++;
    const refresh = worker.fetch(request(), env);
    expect(requests).toHaveLength(3);
    requests[2](Response.json({rooms: []}));
    expect(await (await refresh).json()).toEqual({rooms: []});
  } finally { clock.mockRestore(); }
});
