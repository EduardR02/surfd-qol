import {isPrivateRoomId} from './ids.js';
import {CLOSE, VERSION, MAX_ROOM_PLAYERS, MAX_SNAPSHOT_BLOCKS, SNAPSHOT_HEADER_BYTES, SNAPSHOT_INTERVAL_MS,
  catalogEntry, decodeControl, encodeControlFrames, normalizeAppearance, relayPose, relaySpectator} from './protocol.js';

const ROSTER_INTERVAL_MS = 100;
const CHAT_LIMIT = {rate: 1, burst: 3}, SPECTATE_LIMIT = {rate: 2, burst: 4};
const LOSSY_BACKLOG = 64 * 1024, RELIABLE_BACKLOG = 8 * 1024 * 1024, BACKLOG_GRACE_MS = 5000;

export function createRoomHost({roomId, mapId, maps = [{id: mapId, title: mapId}], name = 'Private room', onChange = () => {}, now = Date.now}) {
  if (!isPrivateRoomId(roomId)) throw new Error('Invalid private room ID');
  if (!Array.isArray(maps)) throw new Error('Invalid map catalog');
  const catalog = new Map();
  for (const map of maps) {
    if (!map || typeof map.id !== 'string' || !map.id) throw new Error('Invalid map catalog');
    catalog.set(map.id, catalogEntry(map));
  }
  if (!catalog.has(mapId)) throw new Error('Map is not in the catalog');
  let state = {
    roomId, name, mapId, mapTitle: catalog.get(mapId).title,
    epoch: 1, startedAt: Date.now(), endsAt: 0, untimed: true,
    recent: [], nominations: {}, rtv: [], vote: null, nextMap: null,
  };
  const clients = new Set();
  const slots = new Set(), pending = new Map();
  let nextSlot = 0, hostClient = null, flushTimer = null, rosterTimer = null;
  let closed = false;

  const players = () => [...clients].filter(client => client.open).map(client => client.player);
  function sendFrames(client, frames) {
    if (!client.open || client.socket.readyState !== 1) return;
    const lossy = frames[0] instanceof ArrayBuffer;
    // The next snapshot or spectator frame supersedes this one, so a congested player just skips it.
    if (lossy && client.socket.bufferedAmount > LOSSY_BACKLOG) return;
    try {
      for (const frame of frames) client.socket.send(frame);
    } catch {
      client.socket.close(CLOSE.gone, 'Private room connection lost');
      leave(client);
      return;
    }
    if (!lossy) checkBacklog(client);
  }
  function checkBacklog(client) {
    if (!(client.socket.bufferedAmount > RELIABLE_BACKLOG)) {
      client.backlogSince = null;
      return;
    }
    client.backlogSince ??= now();
    if (now() - client.backlogSince < BACKLOG_GRACE_MS) return;
    client.socket.close(CLOSE.congested, "Your connection couldn't keep up with the room.");
    leave(client);
  }
  function send(client, message) {
    sendFrames(client, message instanceof ArrayBuffer ? [message] : encodeControlFrames(message));
  }
  function broadcast(message, except) {
    const frames = message instanceof ArrayBuffer ? [message] : encodeControlFrames(message);
    for (const client of clients) if (client !== except) sendFrames(client, frames);
  }
  // Every spectate toggle changes the roster; one broadcast per interval keeps output bounded.
  function roster() {
    rosterTimer ??= setTimeout(() => {
      rosterTimer = null;
      if (!closed) broadcast({type: 'roster', players: players()});
    }, ROSTER_INTERVAL_MS);
    onChange();
  }
  function take(bucket, {rate, burst}) {
    const time = now();
    bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, time - bucket.at) * rate / 1000);
    bucket.at = time;
    if (bucket.tokens < 1) return false;
    bucket.tokens--;
    return true;
  }
  function clearPending() {
    clearTimeout(flushTimer);
    flushTimer = null;
    pending.clear();
  }
  function flushPoses() {
    flushTimer = null;
    const batches = [...pending];
    pending.clear();
    for (const recipient of clients) {
      if (!recipient.open) continue;
      let blocks = [], length = SNAPSHOT_HEADER_BYTES;
      const flush = () => {
        if (!blocks.length) return;
        const buffer = new ArrayBuffer(length), view = new DataView(buffer);
        view.setUint8(0, VERSION);
        view.setUint8(1, 2);
        view.setUint16(2, blocks.length, true);
        let offset = SNAPSHOT_HEADER_BYTES;
        for (const block of blocks) {
          const bytes = new Uint8Array(block, SNAPSHOT_HEADER_BYTES);
          new Uint8Array(buffer, offset, bytes.length).set(bytes);
          offset += bytes.length;
        }
        send(recipient, buffer);
        blocks = [];
        length = SNAPSHOT_HEADER_BYTES;
      };
      for (const [sender, packet] of batches) {
        if (sender === recipient || !sender.open || packet.epoch !== state.epoch) continue;
        blocks.push(packet.buffer);
        length += packet.buffer.byteLength - SNAPSHOT_HEADER_BYTES;
        if (blocks.length === MAX_SNAPSHOT_BLOCKS) flush();
      }
      flush();
    }
  }
  function demand(client) {
    send(client, {type: 'spectator-demand', active: client.watchers.size > 0, count: client.watchers.size});
  }
  function unwatch(client) {
    if (!client.target) return;
    const target = client.target;
    client.target = null;
    client.player.spectating = false;
    target.watchers.delete(client);
    demand(target);
  }
  function releaseWatchers(client) {
    for (const watcher of [...client.watchers]) {
      unwatch(watcher);
      send(watcher, {type: 'error', text: 'That player is no longer available to spectate.', spectatorRequest: watcher.request});
    }
  }
  function detach(client) {
    client.socket.removeEventListener('open', client.onOpen);
    client.socket.removeEventListener('message', client.onMessage);
    client.socket.removeEventListener('close', client.onClose);
  }
  function leave(client) {
    if (!clients.delete(client)) return;
    detach(client);
    client.open = false;
    slots.delete(client.player.slot);
    nextSlot = Math.min(nextSlot, client.player.slot);
    if (hostClient === client) hostClient = null;
    pending.delete(client);
    if (!pending.size) clearPending();
    unwatch(client);
    releaseWatchers(client);
    if (!closed) roster();
  }
  function close() {
    if (closed) return;
    closed = true;
    clearPending();
    clearTimeout(rosterTimer);
    rosterTimer = null;
    for (const client of clients) {
      detach(client);
      client.open = false;
      client.socket.close(CLOSE.gone, 'The host closed the private room.');
    }
    clients.clear();
    slots.clear();
    hostClient = null;
    onChange();
  }
  function spectate(client, message) {
    const target = message.connectionId === null ? null
      : [...clients].find(peer => peer.open && peer.player.connectionId === message.connectionId);
    if (message.connectionId !== null && (!target || target === client || target.player.spectating)) {
      send(client, {type: 'error', text: 'That player is not available to spectate.', spectatorRequest: message.request});
      return;
    }
    client.request = message.request;
    unwatch(client);
    if (target) {
      releaseWatchers(client);
      client.target = target;
      client.player.spectating = true;
      target.watchers.add(client);
      demand(target);
    }
    roster();
  }
  function receive(client, data) {
    if (!client.open || closed) return;
    try {
      if (data instanceof ArrayBuffer) {
        const type = data.byteLength >= 2 ? new Uint8Array(data)[1] : 0;
        if (type === 1) {
          const packet = relayPose(data, client.player.slot);
          if (packet.epoch !== state.epoch) return;
          if (client.sequence !== null) {
            const distance = (packet.sequence - client.sequence) >>> 0;
            if (distance === 0 || distance >= 0x80000000) return;
          }
          client.sequence = packet.sequence;
          pending.set(client, packet);
          if (flushTimer === null) flushTimer = setTimeout(flushPoses, SNAPSHOT_INTERVAL_MS);
        } else if (type === 3) {
          const packet = relaySpectator(data, client.player.slot);
          if (packet.epoch === state.epoch && !client.player.spectating) {
            for (const watcher of client.watchers) send(watcher, packet.buffer);
          }
        } else throw new Error('Invalid packet type');
        return;
      }
      const message = decodeControl(data);
      switch (message.type) {
        case 'ping':
          send(client, 'pong');
          break;
        case 'chat':
          if (!take(client.chat, CHAT_LIMIT)) {
            if (!client.chat.limited) send(client, {type: 'error', text: "You're sending messages too fast."});
            client.chat.limited = true;
            break;
          }
          client.chat.limited = false;
          broadcast({type: 'chat', playerId: client.player.id, name: client.player.name,
            rank: client.player.rank, appearance: client.player.appearance, text: message.text});
          break;
        case 'change-map':
          if (!client.host) {
            send(client, {type: 'error', text: 'Only the private room host can change maps.'});
          } else if (!catalog.has(message.mapId)) {
            send(client, {type: 'error', text: 'Map is not in the catalog.'});
          } else if (message.mapId !== state.mapId) {
            state = {...state, mapId: message.mapId, mapTitle: catalog.get(message.mapId).title,
              epoch: state.epoch + 1, startedAt: Date.now(), recent: [state.mapId, ...state.recent].slice(0, 8)};
            clearPending();
            for (const peer of clients) peer.sequence = null;
            broadcast({type: 'state', state, serverTime: Date.now()});
            // The native client clears its viewer count on each epoch, not its demand flag.
            for (const peer of clients) demand(peer);
            onChange();
          }
          break;
        case 'spectate':
          if (take(client.spectate, SPECTATE_LIMIT)) spectate(client, message);
          break;
        case 'context':
          // The game waits for this when a map starts; no token means no ranked runs.
          send(client, {type: 'context', epoch: state.epoch, token: null});
          break;
        // Votes, refreshes, activity, reports and moderation belong to public servers.
      }
    } catch {
      client.socket.close(CLOSE.invalid, 'Invalid private room data');
      leave(client);
    }
  }
  function addClient(socket, hello, {host = false} = {}) {
    socket.binaryType = 'arraybuffer';
    if (closed) {
      socket.close(CLOSE.gone, 'This private room has closed.');
      return;
    }
    if (!hello || typeof hello.name !== 'string' || !hello.name.trim() || typeof hello.guest !== 'boolean') {
      socket.close(CLOSE.invalid, 'Invalid private room hello');
      return;
    }
    // One place stays free for the host's own connection.
    if (!host && [...clients].filter(client => !client.host).length >= MAX_ROOM_PLAYERS - 1) {
      socket.close(CLOSE.refused, 'This room is full.');
      return;
    }
    if (hostClient && host) {
      const stale = hostClient;
      leave(stale);
      stale.socket.close(1000, 'Host connection replaced');
    }
    while (slots.has(nextSlot)) nextSlot++;
    const slot = nextSlot++;
    slots.add(slot);
    const connectionId = crypto.randomUUID();
    const client = {socket, host, open: false, sequence: null, target: null, request: 0, watchers: new Set(),
      chat: {tokens: CHAT_LIMIT.burst, at: now(), limited: false}, spectate: {tokens: SPECTATE_LIMIT.burst, at: now()},
      backlogSince: null, player: {
      id: 'private-' + connectionId, connectionId, slot, name: hello.name.trim().slice(0, 24),
      appearance: normalizeAppearance(hello.appearance), guest: false, rank: 'Guest', points: 0,
      moderator: host, spectating: false,
    }};
    client.onOpen = () => {
      if (client.open || closed || !clients.has(client)) return;
      client.open = true;
      send(client, {type: 'welcome', state, player: client.player, players: players(), maps: [...catalog.values()],
        serverTime: Date.now(), spectatorStream: true, playtime: false, activityTracking: false,
        recentResults: [], chatMute: null});
      roster();
    };
    client.onMessage = event => receive(client, event.data);
    client.onClose = () => leave(client);
    clients.add(client);
    if (host) hostClient = client;
    socket.addEventListener('open', client.onOpen);
    socket.addEventListener('message', client.onMessage);
    socket.addEventListener('close', client.onClose);
    if (socket.readyState === 1) client.onOpen();
  }
  return {addClient, close, get state() { return state; }, get players() { return players(); }};
}
