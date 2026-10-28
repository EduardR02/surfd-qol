// The signalling Worker for Surfd QoL rooms: one Durable Object per room,
// holding its sockets through the hibernation API so a quiet room costs
// nothing, and one Lobby object for the directory of public rooms. The relay
// is room.js and the directory lobby.js; this file only wires them up.
import {createLobby} from './lobby.js';
import {ORIGIN, createRoom, hashKey, parseRequest} from './room.js';

const OPEN = 1;
const refusal = ({status, error}) => new Response(error, {status});
// Each isolate keeps the directory this long, so an open server browser
// rarely wakes the Lobby.
const DIRECTORY_MS = 10000;
let directory = null;
const lobbyOf = env => env.LOBBY.get(env.LOBBY.idFromName('lobby'));

async function listRooms(request, env) {
  if (request.headers.get('Origin') !== ORIGIN) return refusal({status: 403, error: 'Origin not allowed'});
  if (request.method !== 'GET') return refusal({status: 405, error: 'Expected GET'});
  if (!directory || Date.now() - directory.at > DIRECTORY_MS) {
    directory = {at: Date.now(), body: await (await lobbyOf(env).fetch('https://lobby/rooms')).text()};
  }
  return new Response(directory.body, {headers: {
    'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ORIGIN,
    'Cache-Control': `public, max-age=${DIRECTORY_MS / 1000}`,
  }});
}

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname === '/rooms') return listRooms(request, env);
    const asked = parseRequest(request);
    // Bad requests never wake a room.
    return asked.error ? refusal(asked) : env.ROOMS.get(env.ROOMS.idFromName(asked.roomId)).fetch(request);
  },
};

export class Room {
  constructor(ctx, env) {
    // Heartbeats are answered by the runtime, without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      const {storage} = ctx;
      this.room = createRoom({
        record: await storage.get('room') ?? null,
        // An ended room deletes everything, so nothing of it stays stored.
        save: record => record ? storage.put('room', record) : storage.deleteAll(),
        wake: at => at == null ? storage.deleteAlarm() : storage.setAlarm(at),
        sockets: () => ctx.getWebSockets().filter(socket => socket.readyState === OPEN),
        peerOf: socket => socket.deserializeAttachment(),
        accept(socket, peer) { ctx.acceptWebSocket(socket); socket.serializeAttachment(peer); },
        // A refused socket still opens, so the browser gets the close code and reason.
        refuse(socket, code, reason) { socket.accept(); socket.close(code, reason); },
        // A lost update is fixed by the host's next one, at most 30 s later.
        publish(roomId, listing) {
          ctx.waitUntil(lobbyOf(env).fetch(`https://lobby/listing/${roomId}`, listing
            ? {method: 'PUT', body: JSON.stringify(listing)} : {method: 'DELETE'}).catch(() => {}));
        },
      });
    });
  }
  async fetch(request) {
    const asked = parseRequest(request);
    if (asked.error) return refusal(asked);
    // Hashed before the room is touched, so nothing runs between its checks and a claim.
    const key = asked.key && await hashKey(asked.key);
    const [client, server] = Object.values(new WebSocketPair());
    this.room.connect(server, {role: asked.role, key, roomId: asked.roomId});
    return new Response(null, {status: 101, webSocket: client});
  }
  webSocketMessage(socket, message) { this.room.message(socket, message); }
  webSocketClose(socket, code) {
    this.room.disconnect(socket, code);
    try { socket.close(1000); } catch { /* already closed */ }
  }
  webSocketError(socket) { this.room.disconnect(socket, 1006); }
  alarm() { this.room.alarm(); }
}

// The directory of public rooms. Only this Worker reaches it: rooms list and
// unlist themselves, and /rooms reads it.
export class Lobby {
  constructor(ctx) {
    ctx.blockConcurrencyWhile(async () => {
      const {storage} = ctx;
      this.lobby = createLobby({
        entries: await storage.list(),
        save: (id, entry) => storage.put(id, entry),
        drop: id => storage.delete(id),
      });
    });
  }
  async fetch(request) {
    const {pathname} = new URL(request.url);
    if (pathname === '/rooms') return Response.json({rooms: this.lobby.rooms()});
    const id = /^\/listing\/(p-[a-z0-9]+)$/.exec(pathname)?.[1];
    if (id && request.method === 'PUT') return new Response(null, {status: this.lobby.put(id, await request.json()) ? 204 : 507});
    if (id && request.method === 'DELETE') { this.lobby.remove(id); return new Response(null, {status: 204}); }
    return new Response(null, {status: 404});
  }
}
