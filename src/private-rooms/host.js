import {isPrivateRoomId} from './ids.js';
import {CAPACITY, CLOSE, decodeControl, normalizeAppearance, relayPose, relaySpectator} from './protocol.js';

export function createRoomHost({roomId, mapId, maps = [{id: mapId, title: mapId}], name = 'Private room'}) {
  if (!isPrivateRoomId(roomId)) throw new Error('Invalid private room ID');
  if (!Array.isArray(maps)) throw new Error('Invalid map catalog');
  const catalog = new Map();
  for (const map of maps) {
    if (!map || typeof map.id !== 'string' || !map.id) throw new Error('Invalid map catalog');
    catalog.set(map.id, {id: map.id, title: map.title ?? map.name ?? map.id, ...(map.tier !== undefined ? {tier: map.tier} : {})});
  }
  if (!catalog.has(mapId)) throw new Error('Map is not in the catalog');
  let state = {
    roomId, name, mapId, mapTitle: catalog.get(mapId).title, capacity: CAPACITY,
    epoch: 1, startedAt: Date.now(), endsAt: 0, untimed: true,
    recent: [], nominations: {}, rtv: [], vote: null, nextMap: null,
  };
  const clients = new Set();
  let closed = false;

  const players = () => [...clients].filter(client => client.open).map(client => client.player);
  function send(client, message) {
    if (!client.open || client.socket.readyState !== 1) return;
    try {
      client.socket.send(typeof message === 'string' || message instanceof ArrayBuffer ? message : JSON.stringify(message));
    } catch {
      client.socket.close(CLOSE.gone, 'Private room connection lost');
      leave(client);
    }
  }
  function broadcast(message, except) {
    const data = message instanceof ArrayBuffer ? message : JSON.stringify(message);
    for (const client of clients) if (client !== except) send(client, data);
  }
  function roster() {
    broadcast({type: 'roster', players: players()});
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
    if (client.host && !closed) {
      close();
      return;
    }
    unwatch(client);
    releaseWatchers(client);
    if (!closed) roster();
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const client of clients) {
      detach(client);
      client.open = false;
      client.socket.close(CLOSE.gone, 'Private room closed');
    }
    clients.clear();
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
          if (packet.epoch === state.epoch) broadcast(packet.buffer, client);
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
          broadcast({type: 'chat', playerId: client.player.id, name: client.player.name,
            rank: client.player.rank, appearance: client.player.appearance, text: message.text.trim()});
          break;
        case 'change-map':
          if (!client.host) {
            send(client, {type: 'error', text: 'Only the private room host can change maps.'});
          } else if (!catalog.has(message.mapId)) {
            send(client, {type: 'error', text: 'Map is not in the catalog.'});
          } else if (message.mapId !== state.mapId) {
            state = {...state, mapId: message.mapId, mapTitle: catalog.get(message.mapId).title,
              epoch: state.epoch + 1, startedAt: Date.now(), recent: [state.mapId, ...state.recent].slice(0, 8)};
            broadcast({type: 'state', state, serverTime: Date.now()});
            // The native client clears its viewer count on each epoch, not its demand flag.
            for (const peer of clients) demand(peer);
          }
          break;
        case 'spectate':
          spectate(client, message);
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
      socket.close(CLOSE.gone, 'Private room closed');
      return;
    }
    if (clients.size >= CAPACITY) {
      socket.close(CLOSE.full, 'Private room is full');
      return;
    }
    if (!hello || typeof hello.name !== 'string' || !hello.name.trim() || typeof hello.guest !== 'boolean') {
      socket.close(CLOSE.invalid, 'Invalid private room hello');
      return;
    }
    if (host && [...clients].some(client => client.host)) throw new Error('Private room already has a host');
    let slot = 0;
    const slots = new Set([...clients].map(client => client.player.slot));
    while (slots.has(slot)) slot++;
    const connectionId = crypto.randomUUID();
    const client = {socket, host, open: false, target: null, request: 0, watchers: new Set(), player: {
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
    socket.addEventListener('open', client.onOpen);
    socket.addEventListener('message', client.onMessage);
    socket.addEventListener('close', client.onClose);
    if (socket.readyState === 1) client.onOpen();
  }
  return {addClient, close, get state() { return state; }, get players() { return players(); }};
}
