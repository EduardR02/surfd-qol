import { createRoomHost } from './host.js';
import { createRoomId, isPrivateRoomId } from './ids.js';
import { createLoopbackPair, createPeerSocket, listenRoom } from './socket.js';
import { createBroadcastSignalling } from './signalling.js';

const DISCOVERY_TIMEOUT = 5000;
const ROOM_LIFETIME = 15000;

// Discovery is deliberately same-origin and ephemeral. The native lobby still
// owns selection, loading screens, connecting, reconnecting and map loading.
export function createPrivateRooms({ getAdapter }) {
  const known = new Map();
  const pending = new Map();
  const sockets = new Set();
  const peerId = createRoomId();
  let signalling = null, unsubscribe = null, heartbeat = null;
  let hosted = null, stopListening = null, destroyed = false;

  function rooms() {
    if (destroyed) throw new Error('Private rooms have been closed.');
    const adapter = getAdapter()?.rooms;
    if (!adapter) throw new Error('Private rooms are unavailable in this game build.');
    return adapter;
  }

  function mergeRooms(rows) {
    const now = Date.now();
    for (const [id, entry] of known) {
      if (entry.expires <= now && id !== hosted?.state.roomId) known.delete(id);
    }
    return [...rows.filter(row => !isPrivateRoomId(row.id)), ...[...known.values()].map(entry => entry.row)];
  }

  function updateLobby() {
    const adapter = getAdapter()?.rooms;
    if (adapter && !destroyed) adapter.update(mergeRooms(adapter.rows()));
  }

  function remember(row) {
    if (!row || !isPrivateRoomId(row.id) || typeof row.name !== 'string' || row.name.length > 100 ||
        typeof row.mapId !== 'string' || !Number.isSafeInteger(row.players) || row.players < 0 ||
        !Number.isSafeInteger(row.capacity) || row.capacity < 1 || row.players > row.capacity ||
        !Number.isSafeInteger(row.epoch) || row.epoch < 1 ||
        !getAdapter()?.rooms?.maps().some(map => map.id === row.mapId)) return false;
    // BroadcastChannel is shared, not a public directory: only an explicit
    // join/invite, our own room, or an already-known room may become visible.
    if (row.id !== hosted?.state.roomId && !pending.has(row.id) && !known.has(row.id)) return false;
    const nativeRow = {
      id: row.id, name: row.name, region: 'Private', mapId: row.mapId,
      mapTitle: typeof row.mapTitle === 'string' ? row.mapTitle : '',
      players: row.players, capacity: row.capacity, epoch: row.epoch,
      endsAt: 0, untimed: true, online: row.online !== false, ping: 0,
      roster: Array.isArray(row.roster) ? row.roster.filter(player =>
        player && typeof player.name === 'string' && Number.isFinite(player.points)).map(player =>
        ({name: player.name, points: player.points})) : []
    };
    const previous = known.get(row.id)?.row;
    known.set(row.id, {row: nativeRow, expires: Date.now() + ROOM_LIFETIME});
    if (JSON.stringify(previous) !== JSON.stringify(nativeRow)) updateLobby();
    const waiting = pending.get(row.id);
    if (waiting) {
      pending.delete(row.id);
      clearTimeout(waiting.timer);
      if (nativeRow.online) waiting.resolve(nativeRow);
      else waiting.reject(new Error('The private room host has left.'));
    }
    return true;
  }

  function roomRow(online = true) {
    const state = hosted.state;
    return {
      id: state.roomId, name: state.name, mapId: state.mapId, mapTitle: state.mapTitle,
      epoch: state.epoch, endsAt: 0, untimed: true, capacity: state.capacity,
      players: hosted.players.length, online,
      roster: hosted.players.map(player => ({name: player.name, points: player.points}))
    };
  }

  function announce(online = true) {
    if (!hosted) return;
    const row = roomRow(online);
    remember(row);
    signalling.send({roomId: row.id, peerId, type: 'room-info', payload: row});
  }

  function setup() {
    if (signalling) return;
    signalling = createBroadcastSignalling();
    unsubscribe = signalling.subscribe(message => {
      if (!message || message.peerId === peerId) return;
      if (message.type === 'room-query' && hosted && message.roomId === hosted.state.roomId) announce();
      if (message.type === 'room-info' && message.payload?.id === message.roomId) remember(message.payload);
    });
    heartbeat = setInterval(() => {
      announce();
      const size = known.size;
      mergeRooms([]);
      if (size !== known.size) updateLobby();
    }, 5000);
  }

  function discover(id) {
    if (id === hosted?.state.roomId) {
      announce();
      return Promise.resolve(known.get(id).row);
    }
    if (pending.has(id)) return pending.get(id).promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Private room not found. Keep its host tab open on this browser origin.'));
    }, DISCOVERY_TIMEOUT);
    pending.set(id, {promise, resolve, reject, timer});
    signalling.send({roomId: id, peerId, type: 'room-query', payload: null});
    return promise;
  }

  function hello() {
    const adapter = rooms();
    return {name: adapter.displayName(), appearance: adapter.appearance(), guest: adapter.guest()};
  }

  function track(socket) {
    sockets.add(socket);
    socket.addEventListener('close', () => sockets.delete(socket), {once: true});
    return socket;
  }

  function closeHost() {
    if (!hosted) return;
    announce(false);
    const closing = hosted;
    hosted = null;
    closing.close();
    stopListening?.();
    stopListening = null;
  }

  async function join(id) {
    const adapter = rooms();
    if (!isPrivateRoomId(id)) throw new Error('Invalid private room identifier.');
    setup();
    await discover(id);
    rooms();
    // Register map metadata before native join reads its selected row.
    updateLobby();
    await adapter.join(id);
    return id;
  }

  return {
    async host() {
      const adapter = rooms();
      const mapId = adapter.currentMap()?.id;
      const maps = adapter.maps();
      if (!mapId || !maps.some(map => map.id === mapId)) throw new Error('Select a map before hosting a private room.');
      setup();
      closeHost();
      const roomId = createRoomId();
      hosted = createRoomHost({roomId, mapId, maps, name: `${adapter.displayName()}'s private room`});
      const roomHost = hosted;
      stopListening = listenRoom({roomId, signalling, onSocket: (socket, identity) => {
        roomHost.addClient(socket, identity);
        announce();
      }});
      announce();
      await join(roomId);
      return roomId;
    },
    join,
    // Null means native transport. These guards do not intercept public rooms.
    ticket: id => isPrivateRoomId(id) ? 'private-room' : null,
    measure: id => isPrivateRoomId(id) ? 0 : null,
    mergeRooms,
    roomSocket(id, url, protocols) {
      if (!isPrivateRoomId(id)) return null;
      rooms();
      setup();
      if (id === hosted?.state.roomId) {
        const [client, host] = createLoopbackPair();
        hosted.addClient(host, hello(), {host: true});
        client.addEventListener('message', event => {
          if (hosted?.state.roomId !== id || typeof event.data !== 'string' || event.data === 'pong') return;
          const message = JSON.parse(event.data);
          if (['welcome', 'state', 'roster'].includes(message.type)) announce();
        });
        client.addEventListener('close', () => {
          if (hosted?.state.roomId === id) closeHost();
        }, {once: true});
        return track(client);
      }
      return track(createPeerSocket({roomId: id, peerId: createRoomId(), signalling, hello: hello()}));
    },
    attach() {
      if (!getAdapter()?.rooms || destroyed) return;
      setup();
      // Native already reads ?join when choosing its highlighted row. Discover
      // the metadata, but never auto-connect or change the user's play intent.
      const invite = new URLSearchParams(globalThis.location?.search ?? '').get('join');
      if (isPrivateRoomId(invite)) discover(invite).catch(error => getAdapter()?.notice?.(error.message));
    },
    destroy() {
      if (destroyed) return;
      closeHost();
      destroyed = true;
      clearInterval(heartbeat);
      unsubscribe?.();
      for (const socket of sockets) socket.close(4004, 'Private rooms closed');
      sockets.clear();
      signalling?.close();
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error('Private rooms have been closed.'));
      }
      pending.clear();
      known.clear();
    }
  };
}
