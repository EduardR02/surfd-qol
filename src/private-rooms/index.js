import { createRoomHost } from './host.js';
import { createRoomId, isPrivateRoomId } from './ids.js';
import { CLOSE, MAX_ROOM_PLAYERS, ROOM_TEXTS, catalogEntry, isPlayerName, isRoomName } from './protocol.js';
import { createClosedSocket, createLoopbackPair, createPeerSocket, listenRoom } from './socket.js';
import { connectSignal, newHostKey, SIGNAL_URL } from './signal-client.js';
import { createRoomUi } from './ui.js';

const CLOSED = ROOM_TEXTS.closed;
const SERVICE = "Couldn't reach the room service. Try again in a moment.";
const HOST_LEFT = ROOM_TEXTS.hostClosed;
const DISCOVERY_TIMEOUT = 15000;
const NAME_KEY = 'surfd-qol-room-guest-name';

export function createPrivateRooms({ getAdapter, signalFactory = connectSignal, now = Date.now,
  timers = globalThis, events = globalThis, storage,
  socketFactory = createPeerSocket, listen = listenRoom, uiFactory = createRoomUi } = {}) {
  const known = new Map(), guests = new Map(), gone = new Set();
  const sockets = new Map(), latestSockets = new Map();
  let uploadSamples = new WeakMap(), uploadTimer = null, showingDetails = false;
  let hosted = null, ui = null, destroyed = false, attached = false, listening = false;
  let sampling = false, browserVisible = null, pendingInvite = null, pendingJoin = null;
  const stored = key => { try { return (storage ?? globalThis.localStorage)?.getItem(key); } catch { return null; } };
  const store = (key, value) => { try { (storage ?? globalThis.localStorage)?.setItem(key, value); } catch { /* Storage may be disabled. */ } };
  let name = stored(NAME_KEY);

  function guestName() {
    if (!/^Guest_[0-9a-f]{5}$/.test(name ?? '')) {
      name = `Guest_${newHostKey().slice(0, 5)}`;
      store(NAME_KEY, name);
    }
    return name;
  }
  function rooms() {
    if (destroyed) throw new Error(CLOSED);
    const adapter = getAdapter()?.rooms;
    if (!adapter) throw new Error('Private rooms are unavailable in this game build.');
    return adapter;
  }
  function mergeRooms(rows) {
    return [...rows.filter(row => !isPrivateRoomId(row.id)), ...[...known.values()].filter(row => !gone.has(row.id))];
  }
  function updateLobby(force = false) {
    const adapter = getAdapter()?.rooms;
    if (destroyed || (!force && !adapter?.browserOpen?.())) return;
    if (adapter) adapter.update(mergeRooms(adapter.rows()));
    ui?.refresh();
  }
  // Rows come from the host, so names must look like a player's room and map titles are our own.
  function normalize(row) {
    const map = row && getAdapter()?.rooms?.maps().find(entry => entry.id === row.mapId);
    if (!map || !isPrivateRoomId(row.id) || !isRoomName(row.name) ||
        !Number.isSafeInteger(row.players) || row.players < 0 || row.players > MAX_ROOM_PLAYERS) return null;
    return {id: row.id, name: row.name, mapId: map.id, mapTitle: catalogEntry(map).title,
      players: row.players, region: 'Private', endsAt: 0, untimed: true,
      online: true, epoch: Number.isSafeInteger(row.epoch) && row.epoch > 0 ? row.epoch : 1,
      ping: known.get(row.id)?.ping ?? null,
      roster: Array.isArray(row.roster) ? row.roster.slice(0, MAX_ROOM_PLAYERS).filter(player => player &&
        isPlayerName(player.name) && Number.isSafeInteger(player.points)).map(player =>
        ({name: player.name, points: player.points})) : []};
  }
  function hostRow() {
    const {state, players} = hosted.room;
    return {id: state.roomId, name: state.name, mapId: state.mapId, mapTitle: state.mapTitle.slice(0, 64),
      epoch: state.epoch, players: players.length,
      roster: players.map(player => ({name: player.name, points: player.points}))};
  }
  function publish() {
    if (!hosted) return;
    updateHostTimers();
    const row = hostRow();
    known.set(row.id, normalize(row));
    updateLobby();
  }
  function relay(signal, id, host) {
    const subscribers = new Set(), peers = new Set(), queued = [];
    if (host) {
      signal.on('peer-joined', peer => peers.add(peer));
      signal.on('peer-left', peer => {
        peers.delete(peer);
        for (const callback of subscribers) callback({roomId: id, peerId: peer, type: 'peer-left'});
      });
    }
    signal.on('message', message => {
      if (typeof message.from !== 'string' || (!host && message.from !== signal.host)) return;
      if (host) peers.add(message.from);
      for (const callback of subscribers) callback({roomId: id,
        peerId: host ? message.from : signal.id, type: message.type, payload: message.data});
    });
    signal.on('ready', () => {
      for (const message of queued.splice(0)) {
        if (!host || peers.has(message.peerId)) signal.send(host ? message.peerId : null, message.type, message.payload);
      }
    });
    return {
      send(message) {
        if (signal.state === 'closed' || (host && !peers.has(message.peerId))) return false;
        if (signal.state !== 'open') { queued.push(message); return false; }
        return signal.send(host ? message.peerId : null, message.type, message.payload);
      },
      subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); }
    };
  }
  function markGone(id) {
    gone.add(id);
    known.delete(id);
    updateLobby();
  }
  function finishDiscovery(session, error, row) {
    if (!session.waiting) return;
    timers.clearTimeout(session.timer);
    const waiting = session.waiting;
    session.waiting = null;
    if (error) waiting.reject(error);
    else waiting.resolve(row);
  }
  function closeGuest(session) {
    if (guests.get(session.id) === session) guests.delete(session.id);
    timers.clearTimeout(session.idleTimer);
    session.intentional = true;
    session.signal.close();
    finishDiscovery(session, new Error(CLOSED));
  }
  function guestSession(id) {
    const existing = guests.get(id);
    if (existing && existing.signal.state !== 'closed') return existing;
    const signal = signalFactory({url: SIGNAL_URL, roomId: id, role: 'guest'});
    const session = {id, signal, socket: null, waiting: null, intentional: false};
    guests.set(id, session);
    signal.on('ready', () => signal.send(null, 'room-info', null));
    session.signalling = relay(signal, id, false);
    signal.on('message', message => {
      if (message.from !== signal.host || message.type !== 'room-info' || message.data?.id !== id) return;
      if (message.data.online === false) {
        markGone(id);
        finishDiscovery(session, new Error(CLOSED));
        session.socket?.close(4004, CLOSED);
        closeGuest(session);
        return;
      }
      const row = normalize(message.data);
      if (!row) return;
      known.set(id, row);
      finishDiscovery(session, null, row);
      updateLobby();
    });
    signal.on('closed', reason => {
      if (session.intentional) return;
      if (guests.get(id) === session) guests.delete(id);
      timers.clearTimeout(session.idleTimer);
      const terminal = reason === 'no-room' || reason === 'room-closed';
      if (terminal) markGone(id);
      finishDiscovery(session, new Error(terminal ? CLOSED : SERVICE));
      if (session.socket?.readyState < 2) session.socket.close(terminal ? 4004 : 4000, terminal ? CLOSED : SERVICE);
    });
    if (signal.state === 'open') signal.send(null, 'room-info', null);
    return session;
  }
  function discover(id) {
    if (destroyed || gone.has(id)) return Promise.reject(new Error(CLOSED));
    if (id === hosted?.id) return Promise.resolve(known.get(id));
    const session = guestSession(id);
    if (session.waiting) return session.waiting.promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    session.waiting = {promise, resolve, reject};
    session.timer = timers.setTimeout(() => {
      finishDiscovery(session, new Error(SERVICE));
      closeGuest(session);
    }, DISCOVERY_TIMEOUT);
    if (session.signal.state === 'open') session.signal.send(null, 'room-info', null);
    return promise;
  }
  function hello() {
    const adapter = rooms();
    const name = adapter.displayName(), guest = adapter.guest();
    return {name: isPlayerName(name) ? name : guestName(), appearance: adapter.appearance(), guest,
      userId: guest ? null : adapter.userId?.() ?? null};
  }
  function track(socket, id) {
    const ownHost = id === hosted?.id;
    sockets.set(socket, id);
    latestSockets.set(id, socket);
    socket.addEventListener('open', () => ui?.refresh(), {once: true});
    let pingAt = null;
    const send = socket.send.bind(socket);
    socket.send = data => {
      if (data === 'ping' && socket.readyState === 1) pingAt = now();
      return send(data);
    };
    socket.addEventListener('message', event => {
      if (latestSockets.get(id) !== socket) return;
      const previous = known.get(id);
      if (event.data === 'pong' && pingAt !== null) {
        const elapsed = now() - pingAt;
        pingAt = null;
        if (previous && elapsed >= 0 && Number.isFinite(elapsed)) { previous.ping = elapsed; updateLobby(); }
        return;
      }
      if (id === hosted?.id || !previous || typeof event.data !== 'string' || event.data === 'pong') return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || !['welcome', 'state', 'roster'].includes(message.type)) return;
      const state = message.state;
      const players = message.players;
      const row = normalize({...previous,
        ...(state ? {mapId: state.mapId, mapTitle: state.mapTitle, epoch: state.epoch} : {}),
        ...(Array.isArray(players) ? {players: players.length, roster: players} : {})});
      if (row) { known.set(id, row); updateLobby(); }
    });
    socket.addEventListener('close', event => {
      sockets.delete(socket);
      if (latestSockets.get(id) !== socket) return;
      latestSockets.delete(id);
      if (event.code === 4004) {
        markGone(id);
        if (!ownHost && !destroyed) getAdapter()?.rooms?.notice?.(event.reason === HOST_LEFT ? HOST_LEFT : CLOSED);
      } else if (!ownHost && !destroyed && event.reason &&
          (event.code === 1006 || event.code === CLOSE.refused || event.reason === SERVICE)) {
        getAdapter()?.rooms?.notice?.(event.reason);
      }
      ui?.refresh();
    }, {once: true});
    return socket;
  }
  function closeHost() {
    const closing = hosted;
    if (!closing) return;
    cancelJoin(closing.id);
    hosted = null;
    timers.clearInterval(uploadTimer);
    uploadTimer = null; showingDetails = false;
    uploadSamples = new WeakMap();
    markGone(closing.id);
    closing.room.close();
    closing.stop?.();
    closing.signal?.close();
  }
  async function sampleUpload() {
    const current = hosted, samples = uploadSamples;
    if (!current || sampling || !showingDetails || !getAdapter()?.rooms?.browserOpen?.() ||
        getAdapter()?.rooms?.selected?.() !== current.id) return;
    sampling = true;
    try {
      let total = 0, measured = false;
      await Promise.all([...current.sockets].map(async socket => {
        const report = await socket.getStats();
        let transport = 0, channels = 0, hasTransport = false;
        for (const stat of report.values()) {
          if (!Number.isFinite(stat.bytesSent)) continue;
          if (stat.type === 'transport') { transport += stat.bytesSent; hasTransport = true; }
          else if (stat.type === 'data-channel') channels += stat.bytesSent;
        }
        const bytes = hasTransport ? transport : channels, time = now();
        const previous = samples.get(socket);
        samples.set(socket, {bytes, time});
        if (previous && time > previous.time && bytes >= previous.bytes) {
          total += (bytes - previous.bytes) * 8 / ((time - previous.time) * 1000);
          measured = true;
        }
      }));
      if (hosted === current && samples === uploadSamples && showingDetails) {
        current.uploadMbps = measured ? total : null; ui?.refresh();
      }
    } catch { /* A peer may close while its stats are being collected. */ }
    finally { sampling = false; }
  }
  function setup() {
    if (listening) return;
    listening = true;
    events.addEventListener?.('pagehide', pagehide);
  }
  function updateHostTimers() {
    if (hosted && showingDetails) {
      uploadTimer ??= timers.setInterval(() => void sampleUpload(), 5000);
    } else {
      timers.clearInterval(uploadTimer);
      uploadTimer = null;
    }
  }
  function pagehide() { api.destroy(); }
  function cancelJoin(id) {
    if (!pendingJoin || (id != null && pendingJoin.id !== id)) return;
    const joining = pendingJoin;
    pendingJoin = null;
    const session = guests.get(joining.id);
    if (session && !session.socket) closeGuest(session);
  }
  async function join(id) {
    const adapter = rooms();
    if (!isPrivateRoomId(id)) throw new Error('Invalid private room identifier.');
    setup();
    cancelJoin();
    const attempt = pendingJoin = {id};
    let session;
    try {
      const discovery = discover(id);
      session = guests.get(id);
      if (session) session.preview = false;
      await discovery;
      rooms();
      if (pendingJoin !== attempt) throw new Error(CLOSED);
      updateLobby(true);
      await adapter.join(id);
      if (pendingJoin !== attempt) throw new Error(CLOSED);
      return id;
    } catch (error) {
      if (session && guests.get(id) === session && !session.socket) closeGuest(session);
      throw error;
    } finally {
      if (pendingJoin === attempt) pendingJoin = null;
    }
  }
  function browserVisibility(open) {
    if (destroyed || browserVisible === open) return;
    browserVisible = open;
    if (!open) {
      for (const session of guests.values()) if (session.preview && !session.socket) closeGuest(session);
      return;
    }
    updateLobby();
    if (!pendingInvite) return;
    const invite = pendingInvite;
    pendingInvite = null;
    const promise = discover(invite), session = guests.get(invite);
    if (session) session.preview = true;
    promise.then(() => {
      if (!destroyed && browserVisible) getAdapter()?.rooms?.select?.(invite);
    }).catch(error => {
      if (!destroyed && browserVisible) getAdapter()?.rooms?.notice?.(error.message);
      else if (!destroyed) pendingInvite = invite;
    }).finally(() => {
      if (session?.preview && !session.socket) closeGuest(session);
    });
  }
  const api = {
    async host() {
      const adapter = rooms();
      const mapId = adapter.currentMap()?.id, maps = adapter.maps();
      if (!mapId || !maps.some(map => map.id === mapId)) throw new Error('Select a map before hosting a room.');
      setup();
      closeHost();
      const id = createRoomId();
      const current = {id, sockets: new Set(), uploadMbps: null};
      current.room = createRoomHost({roomId: id, mapId, maps,
        name: `${hello().name}'s room`,
        onChange: () => { if (hosted === current) publish(); }});
      hosted = current;
      try {
        const signal = current.signal = signalFactory({url: SIGNAL_URL, roomId: id, role: 'host', key: newHostKey()});
        const signalling = relay(signal, id, true);
        const infoReplies = new Map();
        signal.on('peer-left', peer => infoReplies.delete(peer));
        current.stop = listen({roomId: id, signalling, onSocket: (socket, identity) => {
          if (hosted !== current) { socket.close(4004, HOST_LEFT); return; }
          current.sockets.add(socket);
          socket.addEventListener('close', () => current.sockets.delete(socket), {once: true});
          current.room.addClient(socket, identity);
        }});
        signal.on('message', message => {
          if (hosted === current && message.type === 'room-info' && message.data === null && typeof message.from === 'string') {
            const time = now();
            if (time - (infoReplies.get(message.from) ?? -Infinity) < 5000) return;
            infoReplies.set(message.from, time);
            // Rosters travel over the peer connection; the relay has a 16KB message limit.
            const {roster, ...row} = hostRow();
            signal.send(message.from, 'room-info', row);
          }
        });
        await new Promise((resolve, reject) => {
          const timer = timers.setTimeout(() => reject(new Error(SERVICE)), DISCOVERY_TIMEOUT);
          signal.on('ready', () => {
            if (hosted !== current) return;
            timers.clearTimeout(timer);
            publish();
            resolve();
          });
          signal.on('closed', () => {
            timers.clearTimeout(timer);
            reject(new Error(SERVICE));
            if (hosted === current) closeHost();
          });
          if (signal.state === 'open') { timers.clearTimeout(timer); publish(); resolve(); }
        });
        if (hosted !== current) throw new Error(CLOSED);
        await join(id);
        return id;
      } catch (error) {
        if (hosted === current) closeHost();
        throw error;
      }
    },
    join, guestName, mergeRooms, browserVisibility,
    hosting: () => hosted ? {id: hosted.id, players: hosted.room.players.length, uploadMbps: hosted.uploadMbps} : null,
    showHostDetails(visible) {
      visible = !!visible && !!hosted;
      if (showingDetails === visible) return;
      showingDetails = visible;
      uploadSamples = new WeakMap();
      if (hosted) hosted.uploadMbps = null;
      updateHostTimers();
    },
    ticket: id => isPrivateRoomId(id) ? 'private-room' : null,
    measure: id => isPrivateRoomId(id) ? Promise.resolve(known.get(id)?.ping ?? null) : null,
    currentRoom: () => {
      for (const [socket, id] of sockets) if (socket.readyState < 2) return id;
      return null;
    },
    roomSocket(id) {
      if (!isPrivateRoomId(id)) return null;
      if (destroyed || gone.has(id)) return createClosedSocket(4004, CLOSED);
      rooms();
      setup();
      if (id === hosted?.id) {
        const current = hosted;
        const [client, host] = createLoopbackPair();
        current.room.addClient(host, hello(), {host: true});
        return track(client, id);
      }
      const previous = guests.get(id);
      if (previous?.socket) {
        closeGuest(previous);
        previous.socket.close(1000, '');
      }
      const session = guestSession(id);
      timers.clearTimeout(session.idleTimer);
      const socket = session.socket = socketFactory({roomId: id,
        peerId: () => session.signal.id, signalling: session.signalling, hello: hello(), maps: rooms().maps(),
        async onFailure() {
          if (destroyed || latestSockets.get(id) !== socket) return null;
          // A closing tab can destroy SCTP before its final control frame arrives.
          try {
            await discover(id);
            if (destroyed || latestSockets.get(id) !== socket) return null;
            const retry = guests.get(id);
            if (retry && !retry.socket) retry.idleTimer = timers.setTimeout(() => closeGuest(retry), 30000);
          } catch {
            if (gone.has(id)) return {code: 4004, reason: HOST_LEFT};
          }
          return null;
        }});
      socket.addEventListener('open', () => closeGuest(session), {once: true});
      socket.addEventListener('close', () => closeGuest(session), {once: true});
      return track(socket, id);
    },
    leave(id) {
      cancelJoin(id);
      if (hosted && (id == null || id === hosted.id)) closeHost();
      for (const [roomId, session] of guests) if (id == null || id === roomId) closeGuest(session);
      for (const [socket, roomId] of sockets) if (id == null || id === roomId) {
        sockets.delete(socket);
        if (latestSockets.get(roomId) === socket) latestSockets.delete(roomId);
        socket.close(1000, '');
      }
      updateLobby();
      ui?.refresh();
    },
    attach() {
      if (!getAdapter()?.rooms || destroyed || attached) return;
      attached = true;
      setup();
      const invite = new URLSearchParams(globalThis.location?.search ?? '').get('join');
      pendingInvite = isPrivateRoomId(invite) ? invite : null;
      ui = uiFactory({rooms: api, getAdapter});
      browserVisibility(!!getAdapter()?.rooms?.browserOpen?.());
    },
    destroy() {
      if (destroyed) return;
      cancelJoin();
      closeHost();
      destroyed = true;
      events.removeEventListener?.('pagehide', pagehide);
      ui?.destroy();
      for (const session of guests.values()) closeGuest(session);
      for (const socket of sockets.keys()) socket.close(4004, HOST_LEFT);
      sockets.clear();
      latestSockets.clear();
      known.clear();
    }
  };
  return api;
}
