import {describe, expect, test} from 'bun:test';
import {createPrivateRooms} from '../src/private-rooms/index.js';

const ROOM = 'p-abcdefghjkmn';
const OTHER = 'p-nmkjhgfedcba';
const CLOSED = 'This private room has closed.';
const SERVICE = "Couldn't reach the room service. Try again in a moment.";
const row = (id = ROOM) => ({id, name: "Guest's room", mapId: 'map', mapTitle: 'Map', players: 2, epoch: 1, updatedAt: 100});

class Signal {
  state = 'connecting';
  id = null;
  host = null;
  sent = [];
  handlers = new Map();
  constructor(options) { this.options = options; }
  on(type, callback) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(callback);
    return () => this.handlers.get(type).delete(callback);
  }
  emit(type, value) { for (const callback of this.handlers.get(type) ?? []) callback(value); }
  ready() {
    this.state = 'open';
    this.id = this.options.role === 'host' ? 'host' : 'guest';
    this.host = 'host';
    this.emit('ready', {id: this.id, host: this.host});
  }
  send(to, type, data) {
    if (this.state !== 'open') return false;
    this.sent.push({to, type, data});
    return true;
  }
  message(type, data, from = 'host') { this.emit('message', {from, type, data}); }
  end(reason) { this.state = 'closed'; this.emit('closed', reason); }
  close() { if (this.state !== 'closed') this.end('closed'); }
}
class Socket extends EventTarget {
  readyState = 0;
  sent = [];
  statsCalls = 0;
  stats = new Map();
  send(data) { this.sent.push(data); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(data) { this.dispatchEvent(Object.assign(new Event('message'), {data})); }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = {code, reason};
    this.dispatchEvent(Object.assign(new Event('close'), this.closed));
  }
  getStats() { this.statsCalls++; return Promise.resolve(this.stats); }
}
function clock() {
  let time = 1000, next = 0;
  const jobs = new Map();
  const add = (callback, delay, repeat) => { const id = ++next; jobs.set(id, {callback, at: time + delay, repeat}); return id; };
  return {now: () => time,
    pending: () => jobs.size,
    setTimeout: (callback, delay) => add(callback, delay, 0), clearTimeout: id => jobs.delete(id),
    setInterval: (callback, delay) => add(callback, delay, delay), clearInterval: id => jobs.delete(id),
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const entry = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        const [id, job] = entry;
        time = job.at;
        if (job.repeat) job.at += job.repeat;
        else jobs.delete(id);
        job.callback();
      }
      time = end;
    }
  };
}
function fixture({storage = new Map(), displayName = 'Surfer'} = {}) {
  const signals = [], peers = [], listeners = [], notices = [];
  const events = new EventTarget(), timers = clock();
  let rows = [{id: 'official', name: 'Official', mapId: 'map', serverTime: 123}], open = false;
  let updates = 0;
  const joined = [], ui = {refreshes: 0, destroyed: false, refresh() { this.refreshes++; }, destroy() { this.destroyed = true; }};
  const adapter = {rooms: {notice: value => notices.push(value),
    rows: () => rows, update: value => { updates++; rows = value; },
    maps: () => [{id: 'map', title: 'Map'}, {id: 'other', title: 'Other'}],
    currentMap: () => ({id: 'map'}), displayName: () => displayName,
    appearance: () => ({}), guest: () => !displayName,
    browserOpen: () => open, join: id => joined.push({id, row: rows.find(value => value.id === id)})
  }};
  const runtime = createPrivateRooms({getAdapter: () => adapter, events, timers, now: timers.now,
    storage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
    signalFactory: options => { const signal = new Signal(options); signals.push(signal); return signal; },
    socketFactory: options => {
      const socket = new Socket();
      socket.options = options;
      socket.inbound = [];
      options.signalling.subscribe(message => socket.inbound.push(message));
      options.signalling.send({roomId: options.roomId, peerId: options.peerId(), type: 'offer', payload: {sdp: 'offer'}});
      peers.push(socket);
      return socket;
    },
    listen: options => { listeners.push(options); return () => {}; },
    uiFactory: () => ui
  });
  return {runtime, signals, peers, listeners, notices, events, timers, adapter, joined, ui,
    updates: () => updates,
    rows: () => rows, open: value => { open = value; },
    async host(options) { const promise = runtime.host(options); signals.at(-1).ready(); return promise; },
    async join(id = ROOM) {
      const promise = runtime.join(id), signal = signals.at(-1);
      signal.ready(); signal.message('room-info', row(id));
      await promise;
      return signal;
    }
  };
}
const opened = socket => socket.readyState === 1 ? Promise.resolve() : new Promise(resolve => socket.addEventListener('open', resolve, {once: true}));
const closed = socket => new Promise(resolve => socket.addEventListener('close', resolve, {once: true}));
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('private room runtime', () => {
  test('closed browser holds no room connections or timers', async () => {
    const f = fixture();
    try {
      f.runtime.attach();
      f.timers.advance(60000);
      await f.runtime.measure(ROOM);
      expect(f.signals).toEqual([]);
      expect(f.timers.pending()).toBe(0);
      await f.join();
      const socket = f.runtime.roomSocket(ROOM); socket.open();
      expect(f.signals[0].state).toBe('closed');
      expect(f.timers.pending()).toBe(0);
      f.runtime.leave();
      expect(f.timers.pending()).toBe(0);
    } finally { f.runtime.destroy(); }
  });

  test('room traffic leaves the hidden browser untouched', async () => {
    const f = fixture();
    try {
      f.runtime.attach();
      await f.join();
      const socket = f.runtime.roomSocket(ROOM); socket.open();
      const updates = f.updates(), refreshes = f.ui.refreshes;
      socket.send('ping'); f.timers.advance(24); socket.message('pong');
      socket.message(JSON.stringify({type: 'state', state: {mapId: 'other', mapTitle: 'Other', epoch: 2}}));
      socket.message(JSON.stringify({type: 'roster', players: [{name: 'Visitor', points: 0}]}));
      expect(f.updates()).toBe(updates);
      expect(f.ui.refreshes).toBe(refreshes);
      f.open(true); f.runtime.browserVisibility(true);
      expect(f.rows().find(value => value.id === ROOM)).toMatchObject({mapId: 'other', players: 1, ping: 24});
    } finally { f.runtime.destroy(); }
  });

  test('invite discovery waits for the browser and closes after preview', async () => {
    const previous = globalThis.location;
    const f = fixture();
    try {
      globalThis.location = {search: `?join=${ROOM}`};
      f.runtime.attach();
      expect(f.signals).toHaveLength(0);
      expect(f.timers.pending()).toBe(0);
      f.open(true);
      f.runtime.browserVisibility(true);
      const signal = f.signals[0];
      signal.ready(); signal.message('room-info', row());
      await flush();
      expect(signal.state).toBe('closed');
      expect(f.timers.pending()).toBe(0);
      f.runtime.browserVisibility(false);
      expect(f.signals).toHaveLength(1);
    } finally { globalThis.location = previous; f.runtime.destroy(); }
  });

  test('closing the browser cancels invite discovery', async () => {
    const previous = globalThis.location;
    const f = fixture();
    try {
      globalThis.location = {search: `?join=${ROOM}`};
      f.runtime.attach(); f.open(true); f.runtime.browserVisibility(true);
      f.open(false); f.runtime.browserVisibility(false);
      expect(f.signals[0].state).toBe('closed');
      expect(f.timers.pending()).toBe(0);
      await flush();
      expect(f.runtime.mergeRooms([])).toEqual([]);
      expect(f.notices).toEqual([]);
    } finally { globalThis.location = previous; f.runtime.destroy(); }
  });

  test('leaving or failing hosting leaves no timers', async () => {
    const f = fixture();
    try {
      await f.host();
      expect(f.timers.pending()).toBe(0);
      f.runtime.leave();
      expect(f.timers.pending()).toBe(0);
      const pending = f.runtime.host();
      f.signals.at(-1).end('unreachable');
      await expect(pending).rejects.toThrow(SERVICE);
      expect(f.timers.pending()).toBe(0);
    } finally { f.runtime.destroy(); }
  });

  test('leave cancels a discovered join before native entry', async () => {
    const f = fixture();
    try {
      const pending = f.runtime.join(ROOM);
      f.signals[0].ready(); f.signals[0].message('room-info', row());
      f.runtime.leave(ROOM);
      await expect(pending).rejects.toThrow(CLOSED);
      expect(f.joined).toEqual([]);
      expect(f.timers.pending()).toBe(0);
    } finally { f.runtime.destroy(); }
  });

  test('a newer join cancels older discovery', async () => {
    const f = fixture();
    try {
      const first = f.runtime.join(ROOM);
      const firstResult = first.catch(error => error);
      const second = f.runtime.join(OTHER);
      f.signals[1].ready(); f.signals[1].message('room-info', row(OTHER));
      await second;
      expect((await firstResult).message).toBe(CLOSED);
      expect(f.signals[0].state).toBe('closed');
      expect(f.joined.map(entry => entry.id)).toEqual([OTHER]);
      expect(f.timers.pending()).toBe(0);
    } finally { f.runtime.destroy(); }
  });

  test('native join failure closes discovery', async () => {
    const f = fixture();
    try {
      f.adapter.rooms.join = () => { throw new Error('Map unavailable'); };
      const pending = f.runtime.join(ROOM);
      f.signals[0].ready(); f.signals[0].message('room-info', row());
      await expect(pending).rejects.toThrow('Map unavailable');
      expect(f.signals[0].state).toBe('closed');
      expect(f.timers.pending()).toBe(0);
    } finally { f.runtime.destroy(); }
  });

  test('pagehide cancels guest discovery', async () => {
    const f = fixture();
    try {
      const pending = f.runtime.join(ROOM);
      f.events.dispatchEvent(new Event('pagehide'));
      await expect(pending).rejects.toThrow(CLOSED);
      expect(f.signals[0].state).toBe('closed');
      expect(f.timers.pending()).toBe(0);
      expect(f.joined).toEqual([]);
    } finally { f.runtime.destroy(); }
  });

  test('host waits for keyed relay readiness before native join', async () => {
    const f = fixture();
    try {
      const pending = f.runtime.host();
      expect(f.joined).toEqual([]);
      expect(f.signals[0].options).toMatchObject({role: 'host', key: expect.stringMatching(/^[0-9a-f]{32}$/)});
      f.signals[0].ready();
      const id = await pending;
      expect(f.joined[0]).toMatchObject({id, row: {id, name: "Surfer's room", region: 'Private'}});
      expect(f.runtime.hosting()).toEqual({id, players: 0, uploadMbps: null});
      expect(f.signals[0].sent).toEqual([]);
    } finally { f.runtime.destroy(); }
  });

  test('room-info replies address only the requesting guest', async () => {
    const f = fixture();
    try {
      const id = await f.host();
      const signal = f.signals[0];
      signal.message('room-info', null, 'visitor');
      expect(signal.sent.at(-1)).toMatchObject({to: 'visitor', type: 'room-info', data: {id, players: 0}});
      const count = signal.sent.length;
      signal.message('room-info', row(), 'visitor');
      signal.emit('peer-left', 'visitor');
      expect(signal.sent).toHaveLength(count);
      expect(f.runtime.hosting().id).toBe(id);
      signal.message('room-info', null, 'visitor');
      signal.message('room-info', null, 'visitor');
      expect(signal.sent).toHaveLength(count + 1);
      f.timers.advance(4999);
      signal.message('room-info', null, 'visitor');
      expect(signal.sent).toHaveLength(count + 1);
      f.timers.advance(1);
      signal.message('room-info', null, 'visitor');
      expect(signal.sent).toHaveLength(count + 2);
    } finally { f.runtime.destroy(); }
  });

  test('discovery and negotiation share one guest relay', async () => {
    const f = fixture();
    try {
      const signal = await f.join();
      expect(signal.options.role).toBe('guest');
      expect(signal.options.key).toBeUndefined();
      expect(signal.sent).toContainEqual({to: null, type: 'room-info', data: null});
      const socket = f.runtime.roomSocket(ROOM);
      expect(f.signals).toHaveLength(1);
      expect(socket.options.peerId()).toBe('guest');
      expect(signal.sent.at(-1)).toEqual({to: null, type: 'offer', data: {sdp: 'offer'}});
      signal.message('answer', {sdp: 'answer'});
      expect(socket.inbound.at(-1)).toMatchObject({roomId: ROOM, peerId: 'guest', type: 'answer'});
      socket.open();
      expect(signal.state).toBe('closed');
      expect(socket.readyState).toBe(1);
      expect(f.runtime.currentRoom()).toBe(ROOM);
      expect(f.runtime.mergeRooms([])[0].id).toBe(ROOM);
    } finally { f.runtime.destroy(); }
  });

  test('retry opens a new relay and queues offer until ready', async () => {
    const f = fixture();
    try {
      await f.join();
      const first = f.runtime.roomSocket(ROOM);
      first.open(); first.close(1006);
      const retry = f.runtime.roomSocket(ROOM), signal = f.signals.at(-1);
      expect(f.signals).toHaveLength(2);
      expect(signal.sent).toEqual([]);
      signal.ready();
      expect(signal.sent.map(message => message.type)).toEqual(['room-info', 'offer']);
      retry.open();
      expect(signal.state).toBe('closed');
    } finally { f.runtime.destroy(); }
  });

  test('terminal discovery prevents native retries', async () => {
    for (const reason of ['no-room', 'room-closed']) {
      const f = fixture();
      try {
        const joining = f.runtime.join(ROOM);
        f.signals[0].end(reason);
        await expect(joining).rejects.toThrow(CLOSED);
        const socket = f.runtime.roomSocket(ROOM), event = await closed(socket);
        expect(event.code).toBe(4004);
        expect(event.reason).toBe(CLOSED);
        expect(f.signals).toHaveLength(1);
        expect(f.joined).toEqual([]);
      } finally { f.runtime.destroy(); }
    }
  });

  test('service failure permits retry without marking the room gone', async () => {
    const f = fixture();
    try {
      const joining = f.runtime.join(ROOM);
      f.signals[0].end('unreachable');
      await expect(joining).rejects.toThrow(SERVICE);
      const retry = f.runtime.roomSocket(ROOM);
      expect(retry.readyState).toBe(0);
      expect(f.signals).toHaveLength(2);
    } finally { f.runtime.destroy(); }
  });

  test('host relay retries keep the room', async () => {
    const f = fixture();
    try {
      const id = await f.host(), signal = f.signals[0];
      signal.state = 'reconnecting'; signal.emit('reconnecting');
      expect(f.runtime.hosting().id).toBe(id);
      signal.ready();
      expect(f.runtime.hosting().id).toBe(id);
      expect(f.signals).toHaveLength(1);
    } finally { f.runtime.destroy(); }
  });

  test('guest names persist and name rooms whose host has no valid name', async () => {
    const storage = new Map(), f = fixture({storage, displayName: ''});
    try {
      const name = f.runtime.guestName();
      expect(name).toMatch(/^Guest_[0-9a-f]{5}$/);
      await f.host();
      expect(f.joined[0].row.name).toBe(`${name}'s room`);
      const next = fixture({storage, displayName: ''});
      expect(next.runtime.guestName()).toBe(name);
      next.runtime.destroy();
    } finally { f.runtime.destroy(); }
    const long = fixture({displayName: 'a'.repeat(60)});
    try { await long.host(); expect(long.joined[0].row.name).toMatch(/^Guest_[0-9a-f]{5}'s room$/); }
    finally { long.runtime.destroy(); }
  });

  test('private measurement bypasses native fetch and uses actual pong time', async () => {
    const f = fixture();
    try {
      expect(f.runtime.measure('official')).toBeNull();
      expect(f.runtime.measure(ROOM)).toBeInstanceOf(Promise);
      expect(await f.runtime.measure(ROOM)).toBeNull();
      await f.join();
      const socket = f.runtime.roomSocket(ROOM); socket.open();
      socket.send('ping'); f.timers.advance(24); socket.message('pong');
      expect(await f.runtime.measure(ROOM)).toBe(24);
      socket.send('ping'); socket.message('pong');
      expect(await f.runtime.measure(ROOM)).toBe(0);
    } finally { f.runtime.destroy(); }
  });

  test('loopback replacement and transient closure keep hosting alive', async () => {
    const f = fixture();
    try {
      const id = await f.host();
      const first = f.runtime.roomSocket(id); await opened(first);
      const replacement = f.runtime.roomSocket(id); await opened(replacement);
      expect(f.runtime.hosting()).toMatchObject({id, players: 1});
      replacement.close();
      await closed(replacement);
      expect(f.runtime.hosting().id).toBe(id);
      f.timers.advance(10000);
      const retry = f.runtime.roomSocket(id); await opened(retry);
      expect(f.runtime.hosting().players).toBe(1);
      f.runtime.leave(id);
      expect(f.runtime.hosting()).toBeNull();
    } finally { f.runtime.destroy(); }
  });

  test('late peer failure cannot reconnect after leave or teardown', async () => {
    for (const action of ['leave', 'destroy']) {
      const f = fixture();
      try {
        await f.join();
        const socket = f.runtime.roomSocket(ROOM); socket.open();
        f.runtime[action]();
        const pending = socket.options.onFailure();
        f.timers.advance(15000);
        await pending;
        expect(f.signals).toHaveLength(1);
        expect(f.timers.pending()).toBe(0);
      } finally { f.runtime.destroy(); }
    }
  });

  test('a lost peer checks whether the host ended the room', async () => {
    const f = fixture();
    try {
      await f.join();
      const socket = f.runtime.roomSocket(ROOM);
      socket.open();
      const pending = socket.options.onFailure();
      const probe = f.signals.at(-1);
      probe.ready();
      probe.end('no-room');
      expect(await pending).toEqual({code: 4004, reason: 'The host closed the private room.'});
      expect(f.runtime.mergeRooms([]).some(value => value.id === ROOM)).toBe(false);
    } finally { f.runtime.destroy(); }
  });

  test('an interrupted live room keeps the relay for renegotiation', async () => {
    const f = fixture();
    try {
      await f.join();
      const socket = f.runtime.roomSocket(ROOM);
      socket.open();
      const pending = socket.options.onFailure();
      const probe = f.signals.at(-1);
      probe.ready();
      probe.message('room-info', row());
      expect(await pending).toBeNull();
      f.runtime.roomSocket(ROOM);
      expect(f.signals).toHaveLength(2);
      expect(probe.state).toBe('open');
    } finally { f.runtime.destroy(); }
  });

  test('host closure shows a notice and stops guest retries', async () => {
    const f = fixture();
    try {
      await f.join();
      const socket = f.runtime.roomSocket(ROOM);
      socket.open();
      socket.close(4004, 'The host closed the private room.');
      expect(f.notices).toEqual(['The host closed the private room.']);
      expect(f.runtime.currentRoom()).toBeNull();
      expect((await closed(f.runtime.roomSocket(ROOM))).code).toBe(4004);
      expect(f.signals).toHaveLength(1);
    } finally { f.runtime.destroy(); }
  });

  test('connection failures show their reason without forgetting the room', async () => {
    for (const [code, reason] of [[1006, "Couldn't connect to the host. Their network or yours may block direct connections."], [4000, SERVICE], [4008, 'This room is full.']]) {
      const f = fixture();
      try {
        await f.join();
        const socket = f.runtime.roomSocket(ROOM);
        socket.close(code, reason);
        expect(f.notices).toEqual([reason]);
        expect(f.rows().some(value => value.id === ROOM)).toBe(true);
      } finally { f.runtime.destroy(); }
    }
  });

  test('pagehide closes host peers and prevents retry', async () => {
    const f = fixture();
    try {
      f.runtime.attach();
      const id = await f.host(), peer = new Socket(); peer.open();
      f.listeners[0].onSocket(peer, {name: 'Visitor', guest: true, appearance: {}});
      f.signals[0].emit('peer-left', 'guest');
      expect(f.runtime.hosting().players).toBe(1);
      f.events.dispatchEvent(new Event('pagehide'));
      expect(peer.closed).toEqual({code: 4004, reason: 'The host closed the private room.'});
      expect(f.signals[0].state).toBe('closed');
      expect(f.ui.destroyed).toBe(true);
      const event = await closed(f.runtime.roomSocket(id));
      expect(event.code).toBe(4004);
    } finally { f.runtime.destroy(); }
  });

  test('upload uses peer byte deltas rather than estimates', async () => {
    const f = fixture();
    try {
      const id = await f.host();
      const peer = new Socket(); peer.open();
      peer.stats.set('transport', {type: 'transport', bytesSent: 1000});
      f.listeners[0].onSocket(peer, {name: 'Visitor', guest: true, appearance: {}});
      f.timers.advance(30000); await flush();
      expect(peer.statsCalls).toBe(0);
      expect(f.timers.pending()).toBe(0);
      f.open(true);
      f.adapter.rooms.selected = () => id;
      f.runtime.showHostDetails(true);
      f.timers.advance(5000); await flush();
      expect(f.runtime.hosting().uploadMbps).toBeNull();
      peer.stats.set('transport', {type: 'transport', bytesSent: 626000});
      f.timers.advance(5000); await flush();
      expect(f.runtime.hosting().uploadMbps).toBe(1);
      f.open(false);
      f.runtime.showHostDetails(false);
      const calls = peer.statsCalls;
      f.timers.advance(30000); await flush();
      expect(peer.statsCalls).toBe(calls);
      expect(f.timers.pending()).toBe(0);
    } finally { f.runtime.destroy(); }
  });

  test('late ICE does not reopen guest relay or address departed guests', async () => {
    const f = fixture();
    try {
      const guest = await f.join(), socket = f.runtime.roomSocket(ROOM);
      socket.open();
      const count = guest.sent.length;
      expect(socket.options.signalling.send({roomId: ROOM, peerId: 'guest', type: 'ice', payload: {}})).toBe(false);
      expect(guest.sent).toHaveLength(count);
      expect(f.signals).toHaveLength(1);
      await f.host();
      const host = f.signals.at(-1), signalling = f.listeners[0].signalling;
      host.emit('peer-joined', 'visitor');
      signalling.send({peerId: 'visitor', type: 'ice', payload: {}});
      expect(host.sent.at(-1)).toEqual({to: 'visitor', type: 'ice', data: {}});
      host.emit('peer-left', 'visitor');
      const sent = host.sent.length;
      expect(signalling.send({peerId: 'visitor', type: 'ice', payload: {}})).toBe(false);
      expect(host.sent).toHaveLength(sent);
    } finally { f.runtime.destroy(); }
  });

  test('native room messages refresh known map and roster after relay teardown', async () => {
    const f = fixture();
    try {
      await f.join();
      const socket = f.runtime.roomSocket(ROOM); socket.open();
      socket.message(JSON.stringify({type: 'state', state: {mapId: 'other', mapTitle: 'Other', epoch: 2}}));
      socket.message(JSON.stringify({type: 'roster', players: [{name: 'Visitor', points: 0}]}));
      expect(f.runtime.mergeRooms([])[0]).toMatchObject({mapId: 'other', epoch: 2, players: 1,
        roster: [{name: 'Visitor', points: 0}]});
      expect(f.signals[0].state).toBe('closed');
    } finally { f.runtime.destroy(); }
  });

  test('overlapping guest retries replace the pending relay', async () => {
    const f = fixture();
    try {
      const first = f.runtime.roomSocket(ROOM), old = f.signals[0];
      const retry = f.runtime.roomSocket(ROOM), signal = f.signals[1];
      expect(old.state).toBe('closed');
      expect(first.readyState).toBe(3);
      signal.ready(); retry.open();
      expect(retry.readyState).toBe(1);
      expect(f.runtime.currentRoom()).toBe(ROOM);
    } finally { f.runtime.destroy(); }
  });

  test('discovery timeout reports service failure and releases the relay', async () => {
    const f = fixture();
    try {
      const joining = f.runtime.join(ROOM);
      f.signals[0].ready();
      f.timers.advance(15000);
      await expect(joining).rejects.toThrow(SERVICE);
      expect(f.signals[0].state).toBe('closed');
      expect(f.joined).toEqual([]);
    } finally { f.runtime.destroy(); }
  });

  test('the hosted row follows membership and map changes', async () => {
    const f = fixture();
    try {
      const id = await f.host();
      const socket = f.runtime.roomSocket(id); await opened(socket);
      expect(f.runtime.mergeRooms([])[0]).toMatchObject({id, players: 1});
      socket.send(JSON.stringify({type: 'change-map', mapId: 'other'}));
      await new Promise(resolve => socket.addEventListener('message', function receive(event) {
        if (typeof event.data !== 'string' || JSON.parse(event.data).type !== 'state') return;
        socket.removeEventListener('message', receive);
        resolve();
      }));
      expect(f.runtime.mergeRooms([])[0]).toMatchObject({mapId: 'other', mapTitle: 'Other', players: 1});
      socket.close(); await closed(socket);
      expect(f.runtime.mergeRooms([])[0].players).toBe(0);
      expect(f.signals[0].sent).toEqual([]);
    } finally { f.runtime.destroy(); }
  });

  test('missing hooks and missing maps fail before signalling', async () => {
    const absent = createPrivateRooms({getAdapter: () => null});
    await expect(absent.host()).rejects.toThrow('unavailable');
    absent.destroy();
    const f = fixture();
    try {
      f.adapter.rooms.currentMap = () => null;
      await expect(f.runtime.host()).rejects.toThrow('Select a map');
      expect(f.signals).toEqual([]);
    } finally { f.runtime.destroy(); }
  });
});
