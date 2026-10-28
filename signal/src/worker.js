// The signalling Worker for Surfd QoL rooms: one Durable Object per room,
// holding its sockets through the hibernation API so a quiet room costs
// nothing. The relay is room.js; this file only wires it up.
import {createRoom, parseRequest} from './room.js';

const OPEN = 1;
const refusal = ({status, error}) => new Response(error, {status});

export default {
  fetch(request, env) {
    const asked = parseRequest(request);
    // Bad requests never wake a room.
    return asked.error ? refusal(asked) : env.ROOMS.get(env.ROOMS.idFromName(asked.roomId)).fetch(request);
  },
};

export class Room {
  constructor(ctx) {
    // Heartbeats are answered by the runtime, without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      const {storage} = ctx;
      this.room = createRoom({
        record: await storage.get('room') ?? null,
        // An expired tombstone deletes everything, so nothing of the room stays stored.
        save: record => record ? storage.put('room', record) : storage.deleteAll(),
        wake: at => at == null ? storage.deleteAlarm() : storage.setAlarm(at),
        sockets: () => ctx.getWebSockets().filter(socket => socket.readyState === OPEN),
        peerOf: socket => socket.deserializeAttachment(),
        accept(socket, peer) { ctx.acceptWebSocket(socket); socket.serializeAttachment(peer); },
        attach: (socket, peer) => socket.serializeAttachment(peer),
        // A refused socket still opens, so the browser gets the close code and reason.
        refuse(socket, code, reason) { socket.accept(); socket.close(code, reason); },
      });
    });
  }
  fetch(request) {
    const asked = parseRequest(request);
    if (asked.error) return refusal(asked);
    const [client, server] = Object.values(new WebSocketPair());
    this.room.connect(server, {role: asked.role});
    return new Response(null, {status: 101, webSocket: client});
  }
  webSocketMessage(socket, message) { return this.room.message(socket, message); }
  webSocketClose(socket, code) {
    this.room.disconnect(socket, code);
    try { socket.close(1000); } catch { /* already closed */ }
  }
  webSocketError(socket) { this.room.disconnect(socket, 1006); }
  alarm() { this.room.alarm(); }
}
