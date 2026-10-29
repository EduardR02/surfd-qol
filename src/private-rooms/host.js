import {isPrivateRoomId} from './ids.js';
import {CLOSE, ROOM_TEXTS, VERSION, MAX_ROOM_PLAYERS, MAX_SNAPSHOT_BLOCKS, SNAPSHOT_HEADER_BYTES, SNAPSHOT_INTERVAL_MS,
  bannedNotice, catalogEntry, decodeControl, encodeControlFrames, isGuestName, isPlayerName, isUuid, kickedNotice,
  normalizeAppearance, normalizeRoomName, relayPose, relaySpectator, roomNameProblem} from './protocol.js';

const ROSTER_INTERVAL_MS = 100;
const CHAT_LIMIT = {rate: 1, burst: 3}, SPECTATE_LIMIT = {rate: 2, burst: 4};
// Native allows frames 1ms early at 30Hz. Keep that cadence plus ~259ms of jitter.
const SPECTATOR_LIMIT = {rate: 1000 / (1000 / 30 - 1), burst: 8};
const BAN_MS = 60 * 60 * 1000;
const LOSSY_BACKLOG = 64 * 1024, RELIABLE_BACKLOG = 8 * 1024 * 1024, BACKLOG_GRACE_MS = 5000;

const guestName = () => 'Guest_' + crypto.randomUUID().slice(0, 5);

export function createRoomHost({roomId, mapId, maps = [{id: mapId, title: mapId}], name = "Host's room", visibility = 'private', onChange = () => {}, now = Date.now}) {
  if (!isPrivateRoomId(roomId)) throw new Error('Invalid private room ID');
  name = normalizeRoomName(name);
  const problem = roomNameProblem(name);
  if (problem) throw new Error(problem);
  if (!Array.isArray(maps)) throw new Error('Invalid map catalog');
  const catalog = new Map();
  for (const map of maps) {
    if (!map || typeof map.id !== 'string' || !map.id) throw new Error('Invalid map catalog');
    catalog.set(map.id, catalogEntry(map));
  }
  if (!catalog.has(mapId)) throw new Error('Map is not in the catalog');
  let state = {
    roomId, name, visibility, mapId, mapTitle: catalog.get(mapId).title,
    epoch: 1, startedAt: Date.now(), endsAt: 0, untimed: true,
    recent: [], nominations: {}, rtv: [], vote: null, nextMap: null,
  };
  const clients = new Set();
  const slots = new Set(), pending = new Map(), bans = new Map();
  let nextSlot = 0, hostClient = null, flushTimer = null, rosterTimer = null;
  let flushAt = 0;
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
      client.socket.close(CLOSE.gone, ROOM_TEXTS.connectionLost);
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
    client.socket.close(CLOSE.congested, ROOM_TEXTS.congested);
    leave(client);
  }
  function send(client, message) {
    sendFrames(client, message instanceof ArrayBuffer ? [message] : encodeControlFrames(message));
  }
  function broadcast(message, except) {
    const frames = message instanceof ArrayBuffer ? [message] : encodeControlFrames(message);
    for (const client of clients) if (client !== except) sendFrames(client, frames);
  }
  // Roster-visible changes share one broadcast per interval to keep output bounded.
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
    clearTimeout(flushTimer);
    flushTimer = null;
    const batches = [...pending];
    pending.clear();
    for (const recipient of clients) {
      if (!recipient.open || recipient.socket.readyState !== 1 || recipient.socket.bufferedAmount > LOSSY_BACKLOG) continue;
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
        if (blocks.length === MAX_SNAPSHOT_BLOCKS) {
          flush();
          if (!recipient.open || recipient.socket.readyState !== 1 || recipient.socket.bufferedAmount > LOSSY_BACKLOG) break;
        }
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
      send(watcher, {type: 'error', text: ROOM_TEXTS.noLongerAvailable, spectatorRequest: watcher.request});
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
      client.socket.close(CLOSE.gone, ROOM_TEXTS.hostClosed);
    }
    clients.clear();
    slots.clear();
    hostClient = null;
    onChange();
  }
  function spectate(client, message) {
    if (message.connectionId === (client.target?.player.connectionId ?? null)) {
      client.request = message.request;
      return;
    }
    // Stopping and redundant requests do not subscribe to a stream or consume its flood budget.
    if (message.connectionId !== null && !take(client.spectate, SPECTATE_LIMIT)) return;
    const target = message.connectionId === null ? null
      : [...clients].find(peer => peer.open && peer.player.connectionId === message.connectionId);
    if (message.connectionId !== null && (!target || target === client || target.player.spectating)) {
      send(client, {type: 'error', text: ROOM_TEXTS.unavailable, spectatorRequest: message.request});
      return;
    }
    const rosterChanged = client.player.spectating !== Boolean(target) || client.watchers.size > 0;
    client.request = message.request;
    unwatch(client);
    if (target) {
      releaseWatchers(client);
      client.target = target;
      client.player.spectating = true;
      target.watchers.add(client);
      demand(target);
    }
    if (rosterChanged) roster();
  }
  function moderate(client, {playerId, action}) {
    const target = [...clients].find(peer => peer.player.id === playerId);
    if (!client.host || !target || target.host) return;
    // A ban covers this browser only: clearing its site data gives it a new id.
    if (action === 'ban') bans.set(target.browserId, now() + BAN_MS);
    target.socket.close(CLOSE.refused, action === 'ban' ? ROOM_TEXTS.banned : ROOM_TEXTS.kicked);
    leave(target);
    broadcast({type: 'notice', text: action === 'ban' ? bannedNotice(target.player.name) : kickedNotice(target.player.name)});
  }
  function banned(browserId) {
    for (const [id, until] of bans) if (until <= now()) bans.delete(id);
    return bans.has(browserId);
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
          // Hidden tabs delay timers to a second; uploads still arrive on the data channel.
          if (flushTimer !== null && now() >= flushAt) flushPoses();
          if (flushTimer === null && pending.size) {
            flushAt = now() + SNAPSHOT_INTERVAL_MS;
            flushTimer = setTimeout(flushPoses, SNAPSHOT_INTERVAL_MS);
          }
        } else if (type === 3) {
          const packet = relaySpectator(data, client.player.slot);
          if (packet.epoch !== state.epoch) return;
          if (client.spectatorSequence !== null) {
            const distance = (packet.sequence - client.spectatorSequence) >>> 0;
            if (distance === 0 || distance >= 0x80000000) return;
          }
          client.spectatorSequence = packet.sequence;
          if (!client.watchers.size || client.player.spectating || !take(client.spectator, SPECTATOR_LIMIT)) return;
          for (const watcher of client.watchers) send(watcher, packet.buffer);
        } else throw new Error('Invalid packet type');
        return;
      }
      const message = decodeControl(data);
      switch (message.type) {
        case 'ping':
          send(client, 'pong');
          break;
        case 'chat':
          if (client.player.guest) {
            send(client, {type: 'error', text: ROOM_TEXTS.signInToChat});
            break;
          }
          if (!take(client.chat, CHAT_LIMIT)) {
            if (!client.chat.limited) send(client, {type: 'error', text: ROOM_TEXTS.tooFast});
            client.chat.limited = true;
            break;
          }
          client.chat.limited = false;
          broadcast({type: 'chat', playerId: client.player.id, name: client.player.name,
            rank: client.player.rank, appearance: client.player.appearance, text: message.text});
          break;
        case 'change-map':
          if (!client.host) {
            send(client, {type: 'error', text: ROOM_TEXTS.hostChangesMaps});
          } else if (!catalog.has(message.mapId)) {
            send(client, {type: 'error', text: ROOM_TEXTS.unknownMap});
          } else if (message.mapId !== state.mapId) {
            state = {...state, mapId: message.mapId, mapTitle: catalog.get(message.mapId).title,
              epoch: state.epoch + 1, startedAt: Date.now(), recent: [state.mapId, ...state.recent].slice(0, 8)};
            clearPending();
            for (const peer of clients) {
              peer.sequence = null;
              peer.spectatorSequence = null;
            }
            broadcast({type: 'state', state, serverTime: Date.now()});
            // The native client clears its viewer count on each epoch, not its demand flag.
            for (const peer of clients) demand(peer);
            onChange();
          }
          break;
        case 'spectate':
          spectate(client, message);
          break;
        case 'context':
          // The game waits for this when a map starts; no token means no ranked runs.
          send(client, {type: 'context', epoch: state.epoch, token: null});
          break;
        case 'moderate':
          moderate(client, message);
          break;
        // Votes, refreshes, activity and reports belong to official servers.
      }
    } catch {
      client.socket.close(CLOSE.invalid, ROOM_TEXTS.invalidData);
      leave(client);
    }
  }
  function addClient(socket, hello, {host = false} = {}) {
    socket.binaryType = 'arraybuffer';
    if (closed) {
      socket.close(CLOSE.gone, ROOM_TEXTS.closed);
      return;
    }
    if (!hello || typeof hello !== 'object' || typeof hello.guest !== 'boolean' || !isUuid(hello.browserId)) {
      socket.close(CLOSE.invalid, ROOM_TEXTS.invalidHello);
      return;
    }
    if (!host && banned(hello.browserId)) {
      socket.close(CLOSE.refused, ROOM_TEXTS.stillBanned);
      return;
    }
    // One place stays free for the host's own connection.
    if (!host && [...clients].filter(client => !client.host).length >= MAX_ROOM_PLAYERS - 1) {
      socket.close(CLOSE.refused, ROOM_TEXTS.full);
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
    // Signed-in players are taken at their word; a hello that can't be one becomes a guest.
    const guest = hello.guest || !isPlayerName(hello.name);
    const userId = !guest && isUuid(hello.userId) ? hello.userId : undefined;
    const client = {socket, host, browserId: hello.browserId, open: false, sequence: null, target: null, request: 0, watchers: new Set(),
      spectatorSequence: null, spectator: {tokens: SPECTATOR_LIMIT.burst, at: now()},
      chat: {tokens: CHAT_LIMIT.burst, at: now(), limited: false}, spectate: {tokens: SPECTATE_LIMIT.burst, at: now()},
      backlogSince: null, player: {
      id: 'private-' + connectionId, connectionId, slot,
      name: guest ? (isGuestName(hello.name) ? hello.name : guestName()) : hello.name,
      appearance: normalizeAppearance(hello.appearance), guest, ...(userId ? {userId} : {}), rank: 'Guest', points: 0,
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
  function setVisibility(value) {
    if (value !== 'private' && value !== 'public') throw new Error('Invalid room visibility.');
    const problem = roomNameProblem(state.name);
    if (problem) throw new Error(problem);
    if (closed || state.visibility === value) return;
    state = {...state, visibility: value};
    broadcast({type: 'state', state, serverTime: Date.now()});
    onChange();
  }
  function setName(name) {
    name = normalizeRoomName(name);
    const problem = roomNameProblem(name);
    if (problem) throw new Error(problem);
    if (closed || state.name === name) return;
    state = {...state, name};
    broadcast({type: 'state', state, serverTime: Date.now()});
    onChange();
  }
  return {addClient, close, setVisibility, setName, get state() { return state; }, get players() { return players(); }};
}
