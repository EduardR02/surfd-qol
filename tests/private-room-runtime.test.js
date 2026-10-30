import {describe, expect, test} from 'bun:test';
import {createPrivateRooms} from '../src/private-rooms/index.js';
import {createRoomControlReader, encodeControlFrames} from '../src/private-rooms/protocol.js';
import {createRunHistory} from '../src/run-history.js';

const ROOM = 'p-abcdefghjkmn';
const OTHER = 'p-nmkjhgfedcba';
const CLOSED = 'This private room has closed.';
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const SERVICE = "Couldn't reach the room service. Try again in a moment.";
const RELAY = {iceServers: [{urls: ['turn:turn.example:3478?transport=udp'], username: 'user', credential: 'secret'}], ttl: 4 * 60 * 60};
const RELAY_CONFIG = {iceServers: RELAY.iceServers, iceTransportPolicy: 'relay'};
const row = (id = ROOM) => ({id, name: "Guest's room", mapId: 'map', mapTitle: 'Map', players: 2, capacity: 16, epoch: 1, updatedAt: 100});

class Signal {
  state = 'connecting';
  id = null;
  host = null;
  sent = [];
  handlers = new Map();
  // The meeting point's answer to a request for relay credentials; null refuses, 'hold' never answers.
  relay = RELAY;
  relayRequests = 0;
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
    if (type === 'ice-servers') {
      this.relayRequests++;
      const answer = this.relay;
      if (answer !== 'hold') queueMicrotask(() => answer ? this.emit('ice-servers', answer) : this.emit('error', {code: 'no-relay'}));
      return true;
    }
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
  renewals = [];
  relayConfig = RELAY_CONFIG;
  renewRelay(config) { this.renewals.push(config); this.relayConfig = config; }
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
function fixture({storage = new Map(), displayName = 'Surfer', getState = () => null} = {}) {
  const accountListeners = new Set();
  const signals = [], peers = [], listeners = [], notices = [], requests = [], requestOptions = [];
  const events = new EventTarget(), timers = clock();
  let rows = [{id: 'official', name: 'Official', mapId: 'map', serverTime: 123}], open = false, menu = false;
  let response = {ok: true, json: async () => ({rooms: []})};
  let updates = 0;
  const joined = [], ui = {refreshes: 0, destroyed: false, refresh() { this.refreshes++; }, destroy() { this.destroyed = true; }};
  const adapter = {rooms: {notice: value => notices.push(value),
    rows: () => rows, update: value => { updates++; rows = value; },
    maps: () => [{id: 'map', title: 'Map'}, {id: 'other', title: 'Other'}],
    currentMap: () => ({id: 'map'}), displayName: () => displayName,
    appearance: () => ({}), guest: () => !displayName, userId: () => displayName ? ACCOUNT : null,
    onAccountChange: listener => { accountListeners.add(listener); return () => accountListeners.delete(listener); },
    browserOpen: () => open, menuOpen: () => menu, join: id => joined.push({id, row: rows.find(value => value.id === id)})
  }};
  const runtime = createPrivateRooms({getAdapter: () => adapter, getState, events, timers, now: timers.now,
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
    uiFactory: () => ui,
    fetch: async (url, options) => { requests.push(url); requestOptions.push(options); return response; }
  });
  return {runtime, signals, peers, listeners, notices, requests, requestOptions, events, timers, adapter, joined, ui,
    updates: () => updates, accountListeners,
    signOut() { displayName = ''; for (const listener of [...accountListeners]) listener(); },
    rows: () => rows, open: value => { open = value; }, menu: value => { menu = value; }, response: value => { response = value; },
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
// Resolves once the runtime, which listens first, has handled the next room message of this type.
const arrival = (socket, type) => {
  const incoming = createRoomControlReader();
  return new Promise(resolve => socket.addEventListener('message', function receive(event) {
    if (typeof event.data !== 'string') return;
    const text = incoming.read(event.data);
    if (text === null) return;
    const message = JSON.parse(text);
    if (message.type !== type) return;
    socket.removeEventListener('message', receive);
    resolve(message);
  }));
};
const welcomed = socket => arrival(socket, 'welcome');
const closed = socket => new Promise(resolve => socket.addEventListener('close', resolve, {once: true}));
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function finishFixture({best = null, load = null} = {}) {
  const snapshot = {playback: false, spectator: {target: null}};
  const f = fixture({getState: () => snapshot});
  const live = {map: {id: 'map', version: 3}, practice: false,
    state: {tick: 100, velocity: {x: 0, y: 0, z: 0}},
    timer: {state: {phase: 'finished', elapsed: 12.3456784, invalidReason: '', untimed: false}}};
  f.adapter.getSession = () => live;
  const saved = {runs: [], bests: best === null ? [] : [{
    id: 'map:3', name: 'Map', kind: 'CP', at: 1, best: {runId: 'pruned', time: best, at: 1, splits: []},
    splits: [], ramps: {}, start: {}, attempts: 1, finishes: 1
  }]};
  const history = createRunHistory({store: {load: load ?? (async () => saved), put: async () => {},
    putBests: async () => {}, remove: async () => {}}});
  return {...f, snapshot, live, history, saved,
    async guest() {
      await f.join();
      const socket = f.runtime.roomSocket(ROOM);
      socket.open();
      socket.message(JSON.stringify({type: 'welcome', state: {roomId: ROOM, mapId: 'map', epoch: 1}}));
      return socket;
    }};
}

describe('community room finish claims', () => {
  test('guest claims preserve microseconds and browser bests even with history recording off', async () => {
    for (const [best, elapsed, personalBest, previousBestUs] of [
      [null, 12.3456784, true, null],
      [null, 86400, true, null],
      [13.456, 12.3456786, true, 13456000],
      [12.345, 12.346, false, null],
      [12.345, 12.345, false, null],
      [12.345, 12.344999, true, 12345000]
    ]) {
      const f = finishFixture({best});
      try {
        const socket = await f.guest();
        await f.history.ready;
        f.live.timer.state.elapsed = elapsed;
        expect(await f.runtime.observeFinish(f.live, f.history)).toBe(true);
        expect(socket.sent.map(JSON.parse)).toEqual([{type: 'finish', mapId: 'map', epoch: 1,
          timeUs: Math.round(elapsed * 1e6), personalBest, previousBestUs}]);
        expect(f.history.runs()).toEqual([]);
        expect(f.history.bestTime(f.live.map)).toBe(best);
        expect(f.requests).toEqual([]);
        expect(f.timers.pending()).toBe(0);
      } finally { f.runtime.destroy(); }
    }
  });

  test('host sends the identical claim through its tracked loopback socket', async () => {
    const f = finishFixture({best: 20});
    try {
      const id = await f.host();
      const socket = f.runtime.roomSocket(id);
      await welcomed(socket);
      const sent = [], send = socket.send.bind(socket);
      socket.send = data => { sent.push(JSON.parse(data)); return send(data); };
      expect(await f.runtime.observeFinish(f.live, f.history)).toBe(true);
      expect(sent).toEqual([{type: 'finish', mapId: 'map', epoch: 1,
        timeUs: 12345678, personalBest: true, previousBestUs: 20000000}]);
    } finally { f.runtime.destroy(); }
  });

  test('practice, invalid, untimed, replay, spectator, foreign sessions and invalid times never claim', async () => {
    const changes = [
      f => { f.live.practice = true; },
      f => { f.live.timer.state.invalidReason = 'Teleported'; },
      f => { f.live.timer.state.untimed = true; },
      f => { f.live.timer.state.phase = 'running'; },
      f => { f.snapshot.playback = true; },
      f => { f.snapshot.spectator.target = 0; },
      f => { f.adapter.getView = () => ({target: 0}); },
      f => { f.adapter.getSession = () => ({...f.live}); },
      ...[0, -1, NaN, Infinity, 86400.000001, 0.0000001].map(elapsed =>
        f => { f.live.timer.state.elapsed = elapsed; })
    ];
    for (const change of changes) {
      const f = finishFixture();
      try {
        const socket = await f.guest();
        change(f);
        expect(await f.runtime.observeFinish(f.live, f.history)).toBe(false);
        expect(socket.sent).toEqual([]);
      } finally { f.runtime.destroy(); }
    }
  });

  test('outside a room, before welcome and after leaving do not read history or snapshot', async () => {
    const f = fixture({getState: () => { throw new Error('Unexpected snapshot'); }});
    const history = {bestTime: () => { throw new Error('Unexpected history read'); }};
    try {
      expect(await f.runtime.observeFinish({}, history)).toBe(false);
      expect(f.signals).toEqual([]);
      expect(f.timers.pending()).toBe(0);
      await f.join();
      const socket = f.runtime.roomSocket(ROOM);
      expect(await f.runtime.observeFinish({}, history)).toBe(false);
      socket.open();
      expect(await f.runtime.observeFinish({}, history)).toBe(false);
      f.runtime.leave();
      expect(await f.runtime.observeFinish({}, history)).toBe(false);
      expect(socket.sent).toEqual([]);
    } finally { f.runtime.destroy(); }
  });

  test('only accepted current socket map and epoch can label a finish', async () => {
    const f = finishFixture();
    try {
      const old = await f.guest();
      const socket = f.runtime.roomSocket(ROOM);
      socket.open();
      old.message(JSON.stringify({type: 'state', state: {roomId: ROOM, mapId: 'map', epoch: 50}}));
      expect(await f.runtime.observeFinish(f.live, f.history)).toBe(false);
      socket.message(JSON.stringify({type: 'welcome', state: {roomId: OTHER, mapId: 'map', epoch: 1}}));
      expect(await f.runtime.observeFinish(f.live, f.history)).toBe(false);
      socket.message(JSON.stringify({type: 'welcome', state: {roomId: ROOM, mapId: 'other', epoch: 2}}));
      expect(await f.runtime.observeFinish(f.live, f.history)).toBe(false);
      socket.message(JSON.stringify({type: 'state', state: {roomId: ROOM, mapId: 'map', epoch: 3}}));
      socket.message(JSON.stringify({type: 'state', state: {roomId: ROOM, mapId: 'other', epoch: 2}}));
      socket.message(JSON.stringify({type: 'state', state: {roomId: ROOM, mapId: 'other', epoch: 3}}));
      expect(await f.runtime.observeFinish(f.live, f.history)).toBe(true);
      expect(socket.sent.map(JSON.parse)).toEqual([{type: 'finish', mapId: 'map', epoch: 3,
        timeUs: 12345678, personalBest: true, previousBestUs: null}]);
      expect(old.sent).toEqual([]);
    } finally { f.runtime.destroy(); }
  });

  test('a finish waits for saved bests without comparing against its own history entry', async () => {
    let resolve;
    const f = finishFixture({best: 15, load: () => new Promise(done => { resolve = done; })});
    try {
      const socket = await f.guest();
      f.live.timer.state.phase = 'running';
      f.history.observe(f.live, ['start']);
      f.live.timer.state.phase = 'finished';
      const sending = f.runtime.observeFinish(f.live, f.history);
      f.history.observe(f.live, ['finish']);
      expect(socket.sent).toEqual([]);
      resolve(f.saved);
      expect(await sending).toBe(true);
      expect(JSON.parse(socket.sent[0])).toMatchObject({timeUs: 12345678, personalBest: true, previousBestUs: 15000000});
      expect(f.history.bestTime(f.live.map)).toBe(12.346);
    } finally { f.runtime.destroy(); }
  });

  describe('finishes the game sends for verification', () => {
    const RESULT = '00000000-0000-4000-8000-0000000000aa';
    const site = {id: RESULT, userId: ACCOUNT, name: 'Surfer', rank: 'Rookie', mapId: 'map', mapTitle: 'Map', timeUs: 12345678,
      record: false, personalBest: true, previousBestUs: 13000000, pointsDelta: 25, promoted: false,
      leaderboardRank: 5, leaderboardTotal: 80, stageRecords: []};
    const unverified = {type: 'finish', mapId: 'map', epoch: 1, timeUs: 12345678, personalBest: true, previousBestUs: null};
    async function queued(attempt = 'attempt-1') {
      const f = finishFixture(), watch = {listener: null, starts: 0, stops: 0};
      f.adapter.rooms.onVerdict = listener => {
        watch.listener = listener;
        watch.starts++;
        return () => { watch.listener = null; watch.stops++; };
      };
      const socket = await f.guest();
      const sending = f.runtime.observeFinish(f.live, f.history);
      // The game reports the attempt while it handles the finish, after the tick that observed it.
      if (attempt !== 'unreported') f.runtime.finishQueued(attempt);
      expect(await sending).toBe(true);
      return {f, socket, watch, sent: () => socket.sent.map(JSON.parse)};
    }

    test('wait for the verdict, then send the site\u2019s verified fields once', async () => {
      const {f, watch, sent} = await queued();
      try {
        expect(sent()).toEqual([]);
        expect(watch.starts).toBe(1);
        const listener = watch.listener;
        listener('attempt-2', {status: 'verified', result: site});
        listener('attempt-1', {status: 'verifying'});
        expect(sent()).toEqual([]);
        listener('attempt-1', {status: 'verified', result: site});
        listener('attempt-1', {status: 'verified', result: site});
        expect(sent()).toEqual([{type: 'verified', id: RESULT, mapId: 'map', epoch: 1, timeUs: 12345678, personalBest: true,
          previousBestUs: 13000000, record: false, pointsDelta: 25, promoted: false, leaderboardRank: 5, leaderboardTotal: 80}]);
        expect(watch.stops).toBe(1);
        expect(f.requests).toEqual([]);
      } finally { f.runtime.destroy(); }
    });

    test('a promotion carries the new rank; fields the game wouldn\u2019t print are left out', async () => {
      const {f, watch, sent} = await queued();
      try {
        watch.listener('attempt-1', {status: 'verified', result: {...site, id: 'not-a-uuid', promoted: true, rank: 'Surfer',
          personalBest: false, previousBestUs: 13000000, pointsDelta: -5, leaderboardRank: 81}});
        expect(sent()).toEqual([{type: 'verified', mapId: 'map', epoch: 1, timeUs: 12345678, personalBest: false,
          previousBestUs: null, record: false, pointsDelta: 0, promoted: true, rank: 'Surfer'}]);
      } finally { f.runtime.destroy(); }
    });

    test('rejected runs, and verified ones without a usable result, get the unverified announcement', async () => {
      for (const answer of [{status: 'rejected', reason: 'Bad replay'}, {status: 'verified'},
        {status: 'verified', result: {...site, mapId: 'other'}}, {status: 'verified', result: {...site, timeUs: 0}}]) {
        const {f, watch, sent} = await queued();
        try {
          watch.listener('attempt-1', answer);
          expect(sent()).toEqual([unverified]);
        } finally { f.runtime.destroy(); }
      }
    });

    test('finishes the game doesn\u2019t send, or doesn\u2019t report, are announced at once', async () => {
      for (const attempt of [null, 'unreported']) {
        const {f, watch, sent} = await queued(attempt);
        try {
          expect(sent()).toEqual([unverified]);
          expect(watch.starts).toBe(0);
        } finally { f.runtime.destroy(); }
      }
      const f = finishFixture();
      try {
        const socket = await f.guest();
        f.runtime.finishQueued('stale');
        expect(await f.runtime.observeFinish(f.live, f.history)).toBe(true);
        f.runtime.finishQueued('attempt-1');
        expect(socket.sent.map(JSON.parse)).toEqual([unverified]);
      } finally { f.runtime.destroy(); }
    });

    test('leaving the room drops a waiting run and stops watching verdicts', async () => {
      const {f, socket, watch, sent} = await queued();
      try {
        const listener = watch.listener;
        socket.close(1000);
        expect(watch.stops).toBe(1);
        listener('attempt-1', {status: 'verified', result: site});
        expect(sent()).toEqual([]);
      } finally { f.runtime.destroy(); }
    });
  });

  test('loading history never sends an old finish after epoch, map, socket or room changes', async () => {
    for (const change of [
      (f, socket) => socket.message(JSON.stringify({type: 'state', state: {roomId: ROOM, mapId: 'map', epoch: 2}})),
      (f, socket) => socket.message(JSON.stringify({type: 'state', state: {roomId: ROOM, mapId: 'other', epoch: 2}})),
      f => f.runtime.roomSocket(ROOM).open(),
      f => f.runtime.roomSocket(OTHER).open(),
      f => f.runtime.leave(),
      f => { f.adapter.getSession = () => ({...f.live}); }
    ]) {
      let resolve;
      const f = finishFixture({load: () => new Promise(done => { resolve = done; })});
      try {
        const socket = await f.guest();
        const sending = f.runtime.observeFinish(f.live, f.history);
        change(f, socket);
        resolve(f.saved);
        expect(await sending).toBe(false);
        expect(socket.sent).toEqual([]);
      } finally { f.runtime.destroy(); }
    }
  });
});

describe('private room runtime', () => {
  test('closed browser holds no room requests or timers', async () => {
    const f = fixture();
    try {
      f.runtime.attach();
      f.timers.advance(60000);
      await f.runtime.refreshDirectory();
      await f.runtime.measure(ROOM);
      expect(f.requests).toEqual([]);
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

  test('the UI is refreshed on entering and on leaving a room, without timers', async () => {
    const f = fixture();
    try {
      f.runtime.attach();
      await f.join();
      const before = f.ui.refreshes;
      const socket = f.runtime.roomSocket(ROOM);
      expect(f.ui.refreshes).toBeGreaterThan(before);
      expect(f.runtime.currentRoom()).toBe(ROOM);
      socket.open();
      const entered = f.ui.refreshes;
      socket.close(1000, '');
      expect(f.runtime.currentRoom()).toBeNull();
      expect(f.ui.refreshes).toBeGreaterThan(entered);
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
      socket.message(JSON.stringify({type: 'roster', players: [{name: 'Visitor', guest: false}]}));
      expect(f.updates()).toBe(updates);
      expect(f.ui.refreshes).toBe(refreshes);
      f.open(true); f.runtime.browserVisibility(true);
      expect(f.rows().find(value => value.id === ROOM)).toMatchObject({mapId: 'other', players: 1, ping: 24});
    } finally { f.runtime.destroy(); }
  });

  test('invite links join without opening the server browser', async () => {
    const previous = globalThis.location, f = fixture();
    try {
      globalThis.location = {search: `?join=${ROOM}`};
      f.runtime.attach();
      await flush();
      const signal = f.signals[0];
      signal.ready(); signal.message('room-info', row());
      await flush();
      expect(f.joined.map(entry => entry.id)).toEqual([ROOM]);
      expect(f.requests).toEqual([]);
      f.runtime.attach();
      await flush();
      expect(f.signals).toHaveLength(1);
    } finally { globalThis.location = previous; f.runtime.destroy(); }
  });

  test('closed invite shows a notice and never enters native transport', async () => {
    const previous = globalThis.location, f = fixture();
    try {
      globalThis.location = {search: `?join=${ROOM}`};
      f.runtime.attach(); await flush();
      f.signals[0].end('no-room'); await flush();
      expect(f.joined).toEqual([]);
      expect(f.notices).toEqual([CLOSED]);
      expect(f.timers.pending()).toBe(0);
    } finally { globalThis.location = previous; f.runtime.destroy(); }
  });

  test('closing both menus cancels directory work without cancelling an explicit join', async () => {
    const f = fixture();
    let resolve;
    try {
      f.open(true); f.runtime.browserVisibility(true);
      const joining = f.runtime.join(ROOM), signal = f.signals[0];
      f.response(new Promise(yes => { resolve = yes; }));
      const pending = f.runtime.refreshDirectory();
      f.open(false); f.runtime.browserVisibility(false);
      expect(f.requestOptions[0].signal.aborted).toBe(true);
      signal.ready(); signal.message('room-info', row());
      await joining;
      expect(f.joined.map(entry => entry.id)).toEqual([ROOM]);
      resolve({ok: true, json: async () => ({rooms: [row(OTHER)]})});
      await pending;
      expect(f.runtime.mergeRooms([]).map(entry => entry.id)).toEqual([ROOM]);
      expect(f.notices).toEqual([]);
    } finally { f.runtime.destroy(); }
  });

  test('leaving or failing hosting releases its heartbeat and relay renewal', async () => {
    const f = fixture();
    try {
      await f.host({visibility: 'public'});
      expect(f.timers.pending()).toBeGreaterThan(0);
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

  test('hosting registers with a host key and joins the game only once the meeting point is ready', async () => {
    const f = fixture();
    try {
      const pending = f.runtime.host();
      expect(f.joined).toEqual([]);
      expect(f.signals[0].options).toMatchObject({role: 'host', key: expect.stringMatching(/^[0-9a-f]{32}$/)});
      f.signals[0].ready();
      const id = await pending;
      expect(f.joined[0]).toMatchObject({id, row: {id, name: "Surfer's room", visibility: 'private'}});
      expect(f.runtime.hosting()).toEqual({id, visibility: 'private', name: "Surfer's room", mapId: 'map', maxPlayers: 16, players: 0, uploadMbps: null});
      expect(f.signals[0].sent).toEqual([{to: null, type: 'listing', data: null}]);
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

  test('hosting needs relay credentials and fails with the service copy without them', async () => {
    for (const relay of [null, {...RELAY, iceServers: [{urls: ['stun:stun.example:3478']}]}, 'hold']) {
      const f = fixture();
      try {
        const pending = f.runtime.host({visibility: 'public'});
        f.signals[0].relay = relay;
        f.signals[0].ready();
        await flush();
        f.timers.advance(10000);
        await expect(pending).rejects.toThrow(SERVICE);
        expect(f.signals[0].relayRequests).toBe(1);
        expect(f.signals[0].sent.filter(message => message.data !== null)).toEqual([]);
        expect(f.runtime.hosting()).toBeNull();
        expect(f.joined).toEqual([]);
        expect(f.timers.pending()).toBe(0);
      } finally { f.runtime.destroy(); }
    }
  });

  test('guests connect through the host relay credentials, renewed before they expire', async () => {
    const f = fixture();
    try {
      await f.host();
      const signal = f.signals[0], rtcConfig = f.listeners[0].rtcConfig;
      expect(signal.relayRequests).toBe(1);
      expect(rtcConfig()).toEqual(RELAY_CONFIG);
      const peer = new Socket(); peer.open();
      peer.relayConfig = rtcConfig();
      f.listeners[0].onSocket(peer, {name: 'Visitor', guest: true, appearance: {}, browserId: crypto.randomUUID()});
      expect(peer.renewals).toEqual([]);
      const fresh = {...RELAY, iceServers: [{...RELAY.iceServers[0], username: 'fresh'}]};
      signal.relay = null;
      f.timers.advance(RELAY.ttl * 1000 - 15 * 60 * 1000); await flush();
      expect(signal.relayRequests).toBe(2);
      expect(peer.renewals).toEqual([]);
      // A failed renewal is tried again a minute later.
      signal.relay = fresh;
      f.timers.advance(60000); await flush();
      expect(signal.relayRequests).toBe(3);
      expect(peer.renewals).toEqual([{iceServers: fresh.iceServers, iceTransportPolicy: 'relay'}]);
      expect(rtcConfig()).toEqual(peer.renewals[0]);
      // A guest that connected on the old credentials catches up when it opens.
      const late = new Socket(); late.open();
      f.listeners[0].onSocket(late, {name: 'Late', guest: true, appearance: {}, browserId: crypto.randomUUID()});
      expect(late.renewals).toEqual([rtcConfig()]);
      f.runtime.leave();
      expect(f.timers.pending()).toBe(0);
    } finally { f.runtime.destroy(); }
  });

  test('a guest connects only with relay credentials and renews them while in the room', async () => {
    const f = fixture();
    try {
      const session = await f.join();
      const socket = f.runtime.roomSocket(ROOM);
      const config = await socket.options.rtcConfig();
      expect(config).toEqual(RELAY_CONFIG);
      expect(session.relayRequests).toBe(1);
      socket.open();
      expect(session.state).toBe('closed');
      expect(f.timers.pending()).toBe(1);
      f.timers.advance(RELAY.ttl * 1000 - 15 * 60 * 1000);
      // Renewing takes a meeting point connection of the guest's own, closed after.
      const renewal = f.signals.at(-1);
      expect(renewal).not.toBe(session);
      expect(renewal.options).toMatchObject({roomId: ROOM, role: 'guest'});
      renewal.ready(); await flush();
      expect(renewal.relayRequests).toBe(1);
      expect(renewal.state).toBe('closed');
      expect(socket.renewals).toEqual([RELAY_CONFIG]);
      expect(f.timers.pending()).toBe(1);
      socket.close();
      expect(f.timers.pending()).toBe(0);
    } finally { f.runtime.destroy(); }
  });

  test('joining fails with the service copy when the meeting point refuses credentials', async () => {
    const f = fixture();
    try {
      const session = await f.join();
      session.relay = null;
      const socket = f.runtime.roomSocket(ROOM);
      await expect(socket.options.rtcConfig()).rejects.toThrow(SERVICE);
      expect(f.timers.pending()).toBe(0);
    } finally { f.runtime.destroy(); }
  });

  test('the hello carries the real guest status and a signed-in account id', async () => {
    for (const [displayName, expected] of [['Surfer', {name: 'Surfer', guest: false, userId: ACCOUNT}],
      ['', {name: expect.stringMatching(/^Guest_[0-9a-f]{5}$/), guest: true, userId: null}]]) {
      const f = fixture({displayName});
      try {
        await f.join();
        expect(f.runtime.roomSocket(ROOM).options.hello).toMatchObject(expected);
      } finally { f.runtime.destroy(); }
    }
  });

  test('a signed-in hello carries the game profile’s rank and points; a guest’s carries none', async () => {
    for (const [displayName, expected] of [['Surfer', {rank: 'Skilled', points: 4100}], ['', {}]]) {
      const f = fixture({displayName});
      f.adapter.rooms.profile = () => ({rank: 'Skilled', points: 4100});
      try {
        await f.join();
        const {rank, points} = f.runtime.roomSocket(ROOM).options.hello;
        expect(JSON.parse(JSON.stringify({rank, points}))).toEqual(expected);
      } finally { f.runtime.destroy(); }
    }
  });

  test('the host checks each joining account against the site profile, without credentials', async () => {
    const f = fixture();
    f.adapter.rooms.profile = () => ({rank: 'Rookie', points: 150});
    f.response({ok: true, status: 200, json: async () => ({player: {username: 'Surfer', rank: 'Expert', points: 7300}})});
    try {
      const id = await f.host();
      const socket = f.runtime.roomSocket(id);
      expect((await welcomed(socket)).player).toMatchObject({rank: 'Expert', points: 7300});
      const lookup = f.requests.findIndex(url => String(url).startsWith('/api/surf?'));
      expect(new URL(f.requests[lookup], 'https://surfd.net').searchParams.toString()).toBe(`action=progression&userId=${ACCOUNT}`);
      expect(f.requestOptions[lookup]).toEqual({credentials: 'omit', cache: 'no-store'});
      expect(f.requests.filter(url => String(url).startsWith('/api/surf?'))).toHaveLength(1);
    } finally { f.runtime.destroy(); }
  });

  test('the host reads the map\u2019s uncached board once per verified personal best, without credentials', async () => {
    const f = fixture();
    f.adapter.rooms.boardId = mapId => mapId === 'map' ? 'board-1' : null;
    f.response({ok: true, status: 200, json: async () => ({entries: [], total: 0, player: null})});
    const site = url => String(url).startsWith('/api/surf?') && new URL(url, 'https://surfd.net').searchParams.get('action') === 'leaderboard';
    try {
      const id = await f.host();
      const socket = f.runtime.roomSocket(id);
      await welcomed(socket);
      const claim = {type: 'verified', mapId: 'map', epoch: 1, timeUs: 12345678, personalBest: true, previousBestUs: null,
        record: false, pointsDelta: 10, promoted: false};
      socket.send(JSON.stringify(claim));
      socket.send(JSON.stringify({...claim, personalBest: false}));
      for (let wait = 0; wait < 20 && !f.requests.some(site); wait++) await new Promise(resolve => setTimeout(resolve, 5));
      const lookups = f.requests.flatMap((url, index) => site(url) ? [[String(url), f.requestOptions[index]]] : []);
      expect(lookups).toEqual([['/api/surf?action=leaderboard&boardId=board-1', {credentials: 'omit', cache: 'no-store'}]]);
    } finally { f.runtime.destroy(); }
  });

  test('the hello carries a browser id that persists', async () => {
    const storage = new Map(), ids = [];
    for (let run = 0; run < 2; run++) {
      const f = fixture({storage});
      try {
        await f.join();
        ids.push(f.runtime.roomSocket(ROOM).options.hello.browserId);
      } finally { f.runtime.destroy(); }
    }
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ids[1]).toBe(ids[0]);
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

  test('host retries preserve room and force public relisting', async () => {
    const f = fixture();
    try {
      const id = await f.host({visibility: 'public'}), signal = f.signals[0];
      signal.state = 'reconnecting'; signal.emit('reconnecting');
      expect(f.runtime.hosting().id).toBe(id);
      signal.ready();
      expect(signal.sent.filter(message => message.type === 'listing')).toHaveLength(2);
      expect(f.signals).toHaveLength(1);
    } finally { f.runtime.destroy(); }
  });

  test('visibility persists and listing heartbeats renew unchanged rooms', async () => {
    const storage = new Map(), f = fixture({storage});
    try {
      await f.host();
      f.runtime.setVisibility('public');
      const signal = f.signals[0];
      expect(signal.sent.at(-1)).toMatchObject({to: null, type: 'listing', data: {name: "Surfer's room", players: 0}});
      const count = signal.sent.length;
      f.runtime.setVisibility('public');
      expect(signal.sent).toHaveLength(count);
      f.timers.advance(29999);
      expect(signal.sent).toHaveLength(count);
      f.timers.advance(1);
      expect(signal.sent).toHaveLength(count + 1);
      const next = fixture({storage});
      expect(next.runtime.visibility()).toBe('public');
      next.runtime.destroy();
      f.runtime.setVisibility('private');
      expect(signal.sent.at(-1)).toEqual({to: null, type: 'listing', data: null});
      // Only the relay renewal is left.
      expect(f.timers.pending()).toBe(1);
    } finally { f.runtime.destroy(); }
  });

  test('guest names persist and name rooms whose host has no valid name', async () => {
    const storage = new Map(), f = fixture({storage, displayName: ''});
    try {
      const name = f.runtime.guestName();
      expect(name).toMatch(/^Guest_[0-9a-f]{5}$/);
      const next = fixture({storage, displayName: ''});
      expect(next.runtime.guestName()).toBe(name);
      next.runtime.destroy();
    } finally { f.runtime.destroy(); }
    const long = fixture({displayName: 'a'.repeat(60)});
    try { await long.host(); expect(long.joined[0].row.name).toMatch(/^Guest_[0-9a-f]{5}'s room$/); }
    finally { long.runtime.destroy(); }
  });

  test('room rows keep local map titles and refuse invalid room and roster names', async () => {
    const f = fixture();
    try {
      const joining = f.runtime.join(ROOM), signal = f.signals[0];
      signal.ready();
      signal.message('room-info', {...row(), name: 'Surfd EU 2 · Frankfurt'});
      expect(f.runtime.mergeRooms([])).toEqual([]);
      signal.message('room-info', {...row(), name: 'Evening practice', mapTitle: '<b>Spoof</b>',
        roster: [{name: '<i>x</i>', guest: false}, {name: 'Visitor', guest: false, points: 3, rank: 'Admin'}]});
      await joining;
      expect(f.runtime.mergeRooms([])[0]).toMatchObject({name: 'Evening practice', mapTitle: 'Map',
        roster: [{name: 'Visitor', guest: false}]});
    } finally { f.runtime.destroy(); }
  });

  test('directory refresh is menu-gated and throttled', async () => {
    const f = fixture();
    try {
      f.response({ok: true, json: async () => ({rooms: [row()]})});
      await f.runtime.refreshDirectory();
      expect(f.requests).toEqual([]);
      f.open(true);
      await Promise.all([f.runtime.refreshDirectory(), f.runtime.refreshDirectory()]);
      expect(f.requests).toHaveLength(1);
      expect(f.rows().map(value => value.id)).toEqual(['official', ROOM]);
      expect(f.rows()[1]).toMatchObject({visibility: 'public', ping: null});
      f.timers.advance(9999); await f.runtime.refreshDirectory();
      expect(f.requests).toHaveLength(1);
      f.timers.advance(1); await f.runtime.refreshDirectory();
      expect(f.requests).toHaveLength(2);
    } finally { f.runtime.destroy(); }
  });

  test('directory preserves known private rooms and rejects unsolicited rows', async () => {
    const f = fixture();
    try {
      f.open(true);
      const signal = await f.join();
      signal.message('room-info', row(OTHER));
      expect(f.runtime.mergeRooms([]).map(value => value.id)).toEqual([ROOM]);
      f.response({ok: true, json: async () => ({rooms: [row(OTHER)]})});
      await f.runtime.refreshDirectory({open: true});
      expect(f.rows().map(value => value.id)).toEqual(['official', OTHER, ROOM]);
      expect(f.rows().slice(1).map(value => value.capacity)).toEqual([16, 16]);
      f.timers.advance(10000);
      f.response({ok: true, json: async () => ({rooms: []})});
      await f.runtime.refreshDirectory({open: true});
      expect(f.rows().map(value => value.id)).toEqual(['official', ROOM]);
    } finally { f.runtime.destroy(); }
  });

  test('directory errors retain officials and report the service copy', async () => {
    const f = fixture();
    try {
      f.open(true);
      for (const response of [
        {ok: false, json: async () => ({rooms: []})},
        {ok: true, json: async () => [row()]},
        {ok: true, json: async () => { throw new SyntaxError('Unexpected token'); }},
      ]) {
        f.response(response);
        await f.runtime.refreshDirectory({open: true});
        expect(f.notices).toEqual([SERVICE]);
        expect(f.rows().map(value => value.id)).toEqual(['official']);
        f.notices.length = 0;
        f.timers.advance(10000);
      }
    } finally { f.runtime.destroy(); }
  });

  test('directory rows the browser cannot show are skipped and the rest listed', async () => {
    const f = fixture();
    try {
      f.open(true);
      const bad = [null, 'x', {...row('p-aaaaaaaaaaaa'), name: 'x'.repeat(41)}, {...row('p-bbbbbbbbbbbb'), mapId: 'unknown'},
        {...row('p-cccccccccccc'), players: 65}, {...row('p-dddddddddddd'), name: "Surfd's room"},
        {...row('p-eeeeeeeeeeee'), name: "Official_eu's room"}, {...row(), id: 'eu'}];
      f.response({ok: true, json: async () => ({rooms: [...bad, row(OTHER), ...Array.from({length: 200}, () => row())]})});
      await f.runtime.refreshDirectory();
      expect(f.notices).toEqual([]);
      expect(f.rows().map(value => value.id)).toEqual(['official', OTHER, ROOM]);
    } finally { f.runtime.destroy(); }
  });

  test('capacity defaults to 16 and remembers valid settings without starting background work', async () => {
    const storage = new Map(), f = fixture({storage});
    try {
      expect(f.runtime.maxPlayers()).toBe(16);
      for (const value of [2, 64, 23]) {
        await f.runtime.setMaxPlayers(value);
        expect(f.runtime.maxPlayers()).toBe(value);
        const next = fixture({storage});
        expect(next.runtime.maxPlayers()).toBe(value);
        next.runtime.destroy();
      }
      expect(storage.get('surfd-qol-room-max-players')).toBe('23');
      expect(f.signals).toEqual([]);
      expect(f.requests).toEqual([]);
      expect(f.timers.pending()).toBe(0);
      const id = await f.host();
      expect(f.runtime.hosting()).toMatchObject({id, maxPlayers: 23});
      expect(f.runtime.roomInfo(id).capacity).toBe(23);
    } finally { f.runtime.destroy(); }
    for (const saved of ['', 'garbage', '1', '65', '16.5', 'Infinity']) {
      const next = fixture({storage: new Map([['surfd-qol-room-max-players', saved]])});
      try { expect(next.runtime.maxPlayers()).toBe(16); }
      finally { next.runtime.destroy(); }
    }
  });

  test('invalid capacity rejects before storage, signals, timers or an existing host change', async () => {
    const storage = new Map(), f = fixture({storage});
    const invalid = [undefined, null, '16', 1, 65, 2.5, NaN, Infinity];
    try {
      for (const value of invalid) await expect(f.runtime.setMaxPlayers(value)).rejects.toThrow('integer from 2 to 64');
      for (const value of invalid.slice(1)) await expect(f.runtime.host({maxPlayers: value})).rejects.toThrow('integer from 2 to 64');
      expect(storage.size).toBe(0);
      expect(f.signals).toEqual([]);
      expect(f.listeners).toEqual([]);
      expect(f.timers.pending()).toBe(0);
      const id = await f.host({visibility: 'public', maxPlayers: 64});
      const saved = [...storage], sent = f.signals[0].sent.length, timers = f.timers.pending();
      for (const value of invalid.slice(1)) {
        await expect(f.runtime.host({maxPlayers: value})).rejects.toThrow('integer from 2 to 64');
        await expect(f.runtime.setMaxPlayers(value)).rejects.toThrow('integer from 2 to 64');
      }
      expect(f.runtime.hosting()).toMatchObject({id, maxPlayers: 64});
      expect(f.runtime.maxPlayers()).toBe(64);
      expect([...storage]).toEqual(saved);
      expect(f.signals).toHaveLength(1);
      expect(f.signals[0].sent).toHaveLength(sent);
      expect(f.timers.pending()).toBe(timers);
    } finally { f.runtime.destroy(); }
  });

  test('lowering capacity keeps current players and publishes the new limit to peers and listings', async () => {
    const storage = new Map(), f = fixture({storage});
    try {
      const id = await f.host({visibility: 'public', maxPlayers: 64});
      const own = f.runtime.roomSocket(id); await welcomed(own);
      const peers = Array.from({length: 2}, (_, index) => {
        const socket = new Socket(); socket.open();
        f.listeners[0].onSocket(socket, {name: `Player_${index}`, guest: false, appearance: {}, browserId: crypto.randomUUID()});
        return socket;
      });
      await f.runtime.setMaxPlayers(2);
      expect(f.runtime.hosting()).toMatchObject({id, maxPlayers: 2, players: 3});
      expect(f.runtime.roomInfo(id)).toMatchObject({capacity: 2, players: 3});
      expect(f.runtime.maxPlayers()).toBe(2);
      expect(storage.get('surfd-qol-room-max-players')).toBe('2');
      expect(f.signals[0].sent.at(-1).data).toMatchObject({capacity: 2, players: 3});
      for (const peer of peers) {
        expect(peer.readyState).toBe(1);
        const state = peer.sent.map(value => JSON.parse(value)).findLast(message => message.type === 'state').state;
        expect(state).toMatchObject({maxPlayers: 2, epoch: 1});
      }
      const refused = new Socket(); refused.open();
      f.listeners[0].onSocket(refused, {name: 'Visitor', guest: false, appearance: {}, browserId: crypto.randomUUID()});
      expect(refused.closed).toEqual({code: 4008, reason: 'This room is full.'});
      await f.runtime.setMaxPlayers(4);
      expect(f.runtime.roomInfo(id)).toMatchObject({capacity: 4, players: 3});
      const admitted = new Socket(); admitted.open();
      f.listeners[0].onSocket(admitted, {name: 'Visitor', guest: false, appearance: {}, browserId: crypto.randomUUID()});
      expect(admitted.readyState).toBe(1);
      expect(f.runtime.hosting().players).toBe(4);
    } finally { f.runtime.destroy(); }
  });

  test('discovery and directory validate capacity independently of bounded player counts', async () => {
    const invalid = [
      {capacity: undefined}, {capacity: null}, {capacity: 1}, {capacity: 65}, {capacity: 2.5}, {capacity: '16'},
      {players: -1}, {players: 65}, {players: 0.5}, {players: '2'},
    ];
    const f = fixture();
    try {
      const joining = f.runtime.join(ROOM), signal = f.signals[0]; signal.ready();
      for (const fields of invalid) {
        signal.message('room-info', {...row(), ...fields});
        expect(f.runtime.roomInfo(ROOM)).toBeNull();
      }
      signal.message('room-info', {...row(), capacity: 2, players: 64});
      await joining;
      expect(f.runtime.roomInfo(ROOM)).toMatchObject({capacity: 2, players: 64});
      f.open(true);
      f.response({ok: true, json: async () => ({rooms: [
        ...invalid.map(fields => ({...row(OTHER), ...fields})),
        {...row('p-aaaaaaaaaaaa'), capacity: 64, players: 0},
      ]})});
      await f.runtime.refreshDirectory();
      expect(f.runtime.roomInfo(OTHER)).toBeNull();
      expect(f.runtime.roomInfo('p-aaaaaaaaaaaa')).toMatchObject({capacity: 64, players: 0});
      const socket = f.runtime.roomSocket(ROOM); socket.open();
      socket.message(JSON.stringify({type: 'state', state: {maxPlayers: 3}}));
      expect(f.runtime.roomInfo(ROOM)).toMatchObject({capacity: 3, players: 64});
      socket.message(JSON.stringify({type: 'state', state: {maxPlayers: 65}}));
      expect(f.runtime.roomInfo(ROOM).capacity).toBe(3);
    } finally { f.runtime.destroy(); }
  });

  test('previews keep honest guest and account identity and never trust incoming you claims', async () => {
    const f = fixture();
    try {
      const roster = [
        {name: 'Member', guest: false, userId: ACCOUNT, points: 9000, rank: 'Admin', you: true},
        {name: 'Guest_abcde', guest: true, you: true},
        {name: 'NoAccount', guest: false},
        {name: 'NoFlag'}, {name: 'BadFlag', guest: 'false'},
        {name: 'NotGuest', guest: true}, {name: 'Guest_ABCDE', guest: true},
        {name: 'Guest_12345', guest: true, userId: ACCOUNT},
        {name: 'BadAccount', guest: false, userId: 'not-a-uuid'},
      ];
      const expected = [{name: 'Member', guest: false, userId: ACCOUNT},
        {name: 'Guest_abcde', guest: true}, {name: 'NoAccount', guest: false}];
      const joining = f.runtime.join(ROOM), signal = f.signals[0]; signal.ready();
      signal.message('room-info', {...row(), roster});
      await joining;
      expect(f.runtime.roomInfo(ROOM).roster).toEqual(expected);
      f.open(true);
      f.response({ok: true, json: async () => ({rooms: [{...row(OTHER), roster}]})});
      await f.runtime.refreshDirectory();
      expect(f.runtime.roomInfo(OTHER).roster).toEqual(expected);
    } finally { f.runtime.destroy(); }
  });

  test('only the latest socket welcome connection marks your entry, not matching names or accounts', async () => {
    const f = fixture(), ownId = crypto.randomUUID(), otherId = crypto.randomUUID();
    try {
      await f.join();
      const socket = f.runtime.roomSocket(ROOM); socket.open();
      const players = [
        {name: 'Surfer', guest: false, userId: ACCOUNT, connectionId: otherId, you: true},
        {name: 'Surfer', guest: false, userId: ACCOUNT, connectionId: ownId},
      ];
      socket.message(JSON.stringify({type: 'roster', players}));
      expect(f.runtime.roomInfo(ROOM).roster).toEqual(players.map(({name, guest, userId}) => ({name, guest, userId})));
      socket.message(JSON.stringify({type: 'welcome', player: players[1], players, state: {maxPlayers: 2}}));
      expect(f.runtime.roomInfo(ROOM).roster).toEqual([
        {name: 'Surfer', guest: false, userId: ACCOUNT}, {name: 'Surfer', guest: false, userId: ACCOUNT, you: true},
      ]);
      socket.message(JSON.stringify({type: 'state', state: {name: 'Practice now', maxPlayers: 3}}));
      expect(f.runtime.roomInfo(ROOM).roster[1].you).toBe(true);
      socket.message(JSON.stringify({type: 'roster', players: [
        {...players[1], name: 'Renamed'}, {...players[0], name: 'Surfer'},
      ]}));
      expect(f.runtime.roomInfo(ROOM).roster).toEqual([
        {name: 'Renamed', guest: false, userId: ACCOUNT, you: true}, {name: 'Surfer', guest: false, userId: ACCOUNT},
      ]);
      const replacement = f.runtime.roomSocket(ROOM); replacement.open();
      socket.message(JSON.stringify({type: 'welcome', player: players[1], players}));
      replacement.message(JSON.stringify({type: 'roster', players}));
      expect(f.runtime.roomInfo(ROOM).roster.every(player => player.you === undefined)).toBe(true);
      replacement.message(JSON.stringify({type: 'welcome', player: players[0], players}));
      expect(f.runtime.roomInfo(ROOM).roster[0].you).toBe(true);
      expect(f.runtime.roomInfo(ROOM).roster[1].you).toBeUndefined();
    } finally { f.runtime.destroy(); }
  });

  test('chunked welcomes identify the latest guest connection and update room metadata', async () => {
    const f = fixture(), oldId = crypto.randomUUID(), ownId = crypto.randomUUID();
    const players = [oldId, ownId].map(connectionId => ({connectionId, name: 'Surfer', guest: false, userId: ACCOUNT}));
    const frames = own => encodeControlFrames({type: 'welcome', player: players[own], players,
      state: {name: 'Large catalog', maxPlayers: 4}, maps: Array.from({length: 1000}, (_, id) => ({id: 'map_' + id, title: 'A'.repeat(64)}))});
    try {
      await f.join();
      const old = f.runtime.roomSocket(ROOM); old.open();
      for (const frame of frames(0)) old.message(frame);
      expect(f.runtime.roomInfo(ROOM)).toMatchObject({name: 'Large catalog', capacity: 4});
      expect(f.runtime.roomInfo(ROOM).roster.map(player => !!player.you)).toEqual([true, false]);
      const replacement = f.runtime.roomSocket(ROOM); replacement.open();
      const chunks = frames(1);
      replacement.message(chunks[0]);
      for (const frame of frames(0)) old.message(frame);
      for (const frame of chunks.slice(1)) replacement.message(frame);
      expect(f.runtime.roomInfo(ROOM).roster.map(player => !!player.you)).toEqual([false, true]);
    } finally { f.runtime.destroy(); }
  });

  test('a large host catalog preserves Your room identity across host socket replacement', async () => {
    const f = fixture();
    f.adapter.rooms.maps = () => Array.from({length: 1001}, (_, id) => ({id: id ? 'map_' + id : 'map', title: 'A'.repeat(64)}));
    try {
      const id = await f.host();
      for (let attempt = 0; attempt < 2; attempt++) {
        const own = f.runtime.roomSocket(id), welcome = welcomed(own);
        await welcome;
        expect(f.runtime.roomInfo(id).roster).toEqual([{name: 'Surfer', guest: false, userId: ACCOUNT, you: true}]);
        expect(f.runtime.roomInfo(id).players).toBe(1);
      }
    } finally { f.runtime.destroy(); }
  });

  test('host rosters stay current while hidden and public listings never identify your local entry', async () => {
    const f = fixture();
    try {
      const id = await f.host({visibility: 'public'});
      const own = f.runtime.roomSocket(id); await welcomed(own);
      const updates = f.updates();
      expect(f.runtime.roomInfo(id).roster).toEqual([{name: 'Surfer', guest: false, userId: ACCOUNT, you: true}]);
      const peer = new Socket(); peer.open();
      f.listeners[0].onSocket(peer, {name: 'Surfer', guest: false, userId: ACCOUNT, appearance: {}, browserId: crypto.randomUUID()});
      expect(f.runtime.roomInfo(id).roster).toEqual([
        {name: 'Surfer', guest: false, userId: ACCOUNT, you: true}, {name: 'Surfer', guest: false, userId: ACCOUNT},
      ]);
      expect(f.signals[0].sent.at(-1).data.roster).toEqual([
        {name: 'Surfer', guest: false, userId: ACCOUNT}, {name: 'Surfer', guest: false, userId: ACCOUNT},
      ]);
      peer.close();
      expect(f.runtime.roomInfo(id).roster).toEqual([{name: 'Surfer', guest: false, userId: ACCOUNT, you: true}]);
      expect(f.runtime.roomInfo(id).players).toBe(1);
      expect(f.updates()).toBe(updates);
    } finally { f.runtime.destroy(); }
  });

  test('free-text names normalize literal spaces and reject invalid inputs before side effects', async () => {
    const storage = new Map(), f = fixture({storage});
    try {
      const invalid = [
        ['', 'Room names need 3–32 characters.'],
        ['ab', 'Room names need 3–32 characters.'],
        ['a'.repeat(33), 'Room names need 3–32 characters.'],
        ['Snow \u2603', 'Use letters, numbers, spaces and simple punctuation.'],
        ['Night\tpractice', 'Use letters, numbers, spaces and simple punctuation.'],
        ['Night\npractice', 'Use letters, numbers, spaces and simple punctuation.'],
        [null, 'Room names need 3–32 characters.'],
        [42, 'Room names need 3–32 characters.'],
        ['SURFD practice', "Room names can't include Surfd or official."],
        ['oFfIcIaL practice', "Room names can't include Surfd or official."],
      ];
      for (const [name, problem] of invalid) {
        await expect(f.runtime.host({name})).rejects.toThrow(problem);
        await expect(f.runtime.rename(name)).rejects.toThrow(problem);
      }
      expect(storage.size).toBe(0);
      expect(f.signals).toEqual([]);
      expect(f.listeners).toEqual([]);
      expect(f.timers.pending()).toBe(0);
      await f.runtime.rename('  ABC  ');
      expect(f.runtime.roomName()).toBe('ABC');
      const name = "Night -_.!?&#:()' practice";
      const id = await f.host({name: `  ${name.replace(' ', '   ')}  `});
      expect(f.runtime.hosting()).toMatchObject({id, name});
      expect(f.runtime.roomInfo(id).name).toBe(name);
      await f.runtime.rename('a'.repeat(32));
      expect(f.runtime.roomInfo(id).name).toBe('a'.repeat(32));
    } finally { f.runtime.destroy(); }
  });

  test('reserved names cannot host privately or publicly, without replacing an existing room', async () => {
    const f = fixture();
    try {
      const id = await f.host({name: 'Evening practice'});
      const sent = f.signals[0].sent.length;
      for (const visibility of ['public', 'private']) {
        for (const name of ['Surfd fan club', 'Unofficial practice']) {
          await expect(f.runtime.host({visibility, name})).rejects.toThrow("Room names can't include Surfd or official.");
        }
      }
      expect(f.runtime.hosting()).toMatchObject({id, name: 'Evening practice', visibility: 'private'});
      expect(f.signals).toHaveLength(1);
      expect(f.signals[0].sent).toHaveLength(sent);
    } finally { f.runtime.destroy(); }
  });

  test('connected room visibility overrides a cached public listing', async () => {
    const f = fixture();
    try {
      f.open(true);
      f.response({ok: true, json: async () => ({rooms: [row()]})});
      await f.runtime.refreshDirectory();
      await f.join();
      const socket = f.runtime.roomSocket(ROOM);
      socket.open();
      socket.message(JSON.stringify({type: 'state', state: {mapId: 'map', mapTitle: 'Map', epoch: 1, visibility: 'private'}}));
      expect(f.rows().find(value => value.id === ROOM)).toMatchObject({visibility: 'private', region: 'Private'});
      socket.message(JSON.stringify({type: 'state', state: {mapId: 'map', mapTitle: 'Map', epoch: 1, visibility: 'public'}}));
      expect(f.rows().find(value => value.id === ROOM)).toMatchObject({visibility: 'public', region: 'Public'});
      expect(socket.readyState).toBe(1);
    } finally { f.runtime.destroy(); }
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
      expect(f.requests).toEqual([]);
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

  test('a room that keeps dropping the connection stops reconnects for 30 seconds', async () => {
    const f = fixture();
    try {
      await f.join();
      for (let drop = 0; drop < 4; drop++) {
        const socket = f.runtime.roomSocket(ROOM);
        f.signals.at(-1).ready();
        socket.open();
        f.timers.advance(1000);
        socket.close(4000, '');
      }
      const signals = f.signals.length, refused = f.runtime.roomSocket(ROOM);
      expect(await closed(refused)).toMatchObject({code: 4004, reason: CLOSED});
      expect(f.signals).toHaveLength(signals);
      f.timers.advance(27000);
      expect(f.runtime.roomSocket(ROOM).readyState).toBe(0);
      expect(f.signals).toHaveLength(signals + 1);
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
      f.listeners[0].onSocket(peer, {name: 'Visitor', guest: true, appearance: {}, browserId: crypto.randomUUID()});
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

  test('upload is measured from peer byte deltas, and only while Your room is shown', async () => {
    const f = fixture();
    try {
      const id = await f.host();
      const peer = new Socket(); peer.open();
      peer.stats.set('transport', {type: 'transport', bytesSent: 1000});
      f.listeners[0].onSocket(peer, {name: 'Visitor', guest: true, appearance: {}, browserId: crypto.randomUUID()});
      f.timers.advance(30000); await flush();
      expect(peer.statsCalls).toBe(0);
      // Only the relay renewal waits while the room isn't shown.
      expect(f.timers.pending()).toBe(1);
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
      expect(f.timers.pending()).toBe(1);
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
      socket.message(JSON.stringify({type: 'roster', players: [{name: 'Visitor', guest: false}]}));
      expect(f.runtime.mergeRooms([])[0]).toMatchObject({mapId: 'other', epoch: 2, players: 1,
        roster: [{name: 'Visitor', guest: false}]});
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

  test('public listings follow membership and host map changes', async () => {
    const f = fixture();
    try {
      const id = await f.host({visibility: 'public'});
      const socket = f.runtime.roomSocket(id); await opened(socket);
      expect(f.signals[0].sent.at(-1).data.players).toBe(1);
      socket.send(JSON.stringify({type: 'change-map', mapId: 'other'}));
      await new Promise(resolve => socket.addEventListener('message', function receive(event) {
        if (typeof event.data !== 'string' || JSON.parse(event.data).type !== 'state') return;
        socket.removeEventListener('message', receive);
        resolve();
      }));
      expect(f.signals[0].sent.at(-1).data).toEqual({name: "Surfer's room", mapId: 'other', players: 1, capacity: 16,
        roster: [{name: 'Surfer', guest: false, userId: ACCOUNT}]});
      socket.close(); await closed(socket);
      expect(f.signals[0].sent.at(-1).data.players).toBe(0);
    } finally { f.runtime.destroy(); }
  });

  test('End room leaves through the game when the host is in the room', async () => {
    const f = fixture();
    try {
      const left = [];
      f.adapter.rooms.leaveRoom = () => { left.push('game'); f.runtime.leave(f.runtime.hosting()?.id); };
      const id = await f.host({mapId: 'other', name: "Night_owls's room"});
      expect(f.runtime.hosting()).toMatchObject({mapId: 'other', name: "Night_owls's room"});
      expect(f.runtime.ownRoom()).toBe(false);
      const own = f.runtime.roomSocket(id); await opened(own);
      expect(f.runtime.ownRoom()).toBe(true);
      f.runtime.end();
      expect(left).toEqual(['game']);
      expect(f.runtime.hosting()).toBeNull();
      expect(f.runtime.ownRoom()).toBe(false);
      const second = await f.host();
      f.runtime.end();
      expect(left).toEqual(['game']);
      expect(f.runtime.hosting()).toBeNull();
      expect(second).not.toBe(id);
    } finally { f.runtime.destroy(); }
  });

  test('hosting needs an account and signing out ends the room', async () => {
    const guest = fixture({displayName: ''});
    try {
      await expect(guest.runtime.host()).rejects.toThrow('Sign in to host a room.');
      expect(guest.signals).toEqual([]);
    } finally { guest.runtime.destroy(); }
    const f = fixture();
    try {
      const id = await f.host(), peer = new Socket(); peer.open();
      f.listeners[0].onSocket(peer, {name: 'Visitor', guest: false, appearance: {}, browserId: crypto.randomUUID()});
      const own = f.runtime.roomSocket(id); await opened(own);
      expect(f.runtime.hosting().players).toBe(2);
      f.accountListeners.forEach(listener => listener());
      expect(f.runtime.hosting().id).toBe(id);
      f.signOut();
      expect(f.runtime.hosting()).toBeNull();
      expect(peer.closed).toEqual({code: 4004, reason: 'The host closed the private room.'});
      expect(f.signals[0].state).toBe('closed');
      expect(f.accountListeners.size).toBe(0);
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

  test('the main menu discovers public rooms without polling during play', async () => {
    const f = fixture();
    try {
      f.response({ok: true, json: async () => ({rooms: [row()]})});
      f.runtime.attach();
      f.menu(true); f.runtime.menuVisibility(true);
      await f.runtime.refreshDirectory();
      expect(f.rows().map(value => value.id)).toEqual(['official', ROOM]);
      f.open(true); f.runtime.browserVisibility(true);
      f.menu(false); f.runtime.menuVisibility(false);
      await f.runtime.refreshDirectory();
      expect(f.requests).toHaveLength(1);
      f.open(false); f.runtime.browserVisibility(false);
      f.timers.advance(60000);
      await f.runtime.refreshDirectory({open: true});
      expect(f.requests).toHaveLength(1);
      expect(f.timers.pending()).toBe(0);
      f.menu(true); f.runtime.menuVisibility(true);
      await f.runtime.refreshDirectory();
      expect(f.requests).toHaveLength(2);
    } finally { f.runtime.destroy(); }
  });

  test('public previews bound and sanitize rosters before entering native rows', async () => {
    const f = fixture();
    try {
      const roster = Array.from({length: 26}, (_, index) => ({name: `Player_${index}`, guest: false}));
      roster[0] = {name: '<img onerror=x>', guest: false};
      roster[1] = {name: 'InvalidGuest', guest: true};
      f.response({ok: true, json: async () => ({rooms: [{...row(), players: 26, roster}]})});
      f.open(true); await f.runtime.refreshDirectory();
      expect(f.rows()[1].roster).toEqual(roster.slice(2, 24));
      expect(f.runtime.roomInfo(ROOM).players).toBe(26);
    } finally { f.runtime.destroy(); }
  });

  test('room renames reach connected players and public listings without changing the map epoch', async () => {
    const f = fixture();
    try {
      const id = await f.host({visibility: 'public', mapId: 'other', name: "Practice's room"});
      const guest = new Socket(); guest.open();
      f.listeners[0].onSocket(guest, {name: 'Visitor', guest: false, appearance: {}, browserId: crypto.randomUUID()});
      await f.runtime.rename('  Evening   practice  ');
      const state = guest.sent.filter(value => typeof value === 'string').map(value => JSON.parse(value))
        .findLast(message => message.type === 'state').state;
      expect(state).toMatchObject({name: 'Evening practice', mapId: 'other', epoch: 1});
      expect(f.signals[0].sent.at(-1).data).toMatchObject({name: 'Evening practice', mapId: 'other', players: 1});
      await expect(f.runtime.rename("Official's room")).rejects.toThrow("Room names can't include Surfd or official.");
      expect(f.runtime.roomInfo(id).name).toBe('Evening practice');
      f.runtime.setVisibility('private');
      await expect(f.runtime.rename("Official's room")).rejects.toThrow("Room names can't include Surfd or official.");
      expect(f.runtime.visibility()).toBe('private');
      expect(f.signals[0].sent.at(-1).data).toBeNull();
    } finally { f.runtime.destroy(); }
  });

  test('native saves traverse the host loopback, load captured time, clear on map change and detach on leave', async () => {
    const f = fixture();
    const map = {id: 'map', version: 'v1', zones: [], spawn: {position: {x: 0, y: 0, z: 0}, yaw: 0, pitch: 0}};
    const key = JSON.stringify(['map', 'v1', JSON.stringify({dt: 0.015}), 8]);
    const snapshot = {key, state: {position: {x: 1, y: 2, z: 3}, velocity: {x: 40, y: 0, z: 0},
      grounded: false, groundId: null, ducked: false, duckFraction: 0, eyeHeight: 64, jumpHeld: false,
      surfaceFriction: 1, yaw: 0, pitch: 0, tick: 100},
    timer: {state: {phase: 'running', startTick: 1, endTick: null, splits: [], invalidReason: null, elapsed: 1.25}, armed: false, prehops: 0},
    checkpointSpeeds: [], startPosition: null, startJumps: 0, startGroundTime: 0,
    startHopWarned: false, startRegion: '', rawJumpHeld: false, stageStartRecovery: false};
    let handlers = null;
    const notices = [], start = {position: {x: 9, y: 9, z: 9}, yaw: 0, pitch: 0};
    const live = {map, practiceKey: () => key, capturePractice: () => snapshot,
      restorePractice(value) { Object.assign(this, {practice: true, restored: value}); return true; }};
    f.adapter.notice = text => notices.push(text);
    f.adapter.practice = {shared(value) { handlers = value; return () => { handlers = null; }; }, refresh() {},
      destination: () => ({mapId: map.id, mapVersion: map.version, map, key, startPosition: start})};
    try {
      expect(f.timers.pending()).toBe(0);
      const id = await f.host();
      const socket = f.runtime.roomSocket(id), init = arrival(socket, 'saveloc-init');
      await welcomed(socket);
      await init;
      const added = arrival(socket, 'saveloc-add');
      handlers.save(live);
      await added;
      expect(handlers.entries(live)).toEqual([{id: 1, name: 'Surfer', own: true, time: 1.25, stage: 1, checkpoints: 0}]);
      expect(notices).toEqual(['Saved location #1 · 00:01.250.']);
      expect(handlers.restore(live)).toBe(true);
      expect(live.practice).toBe(true);
      expect(live.restored.timer.state.elapsed).toBe(1.25);
      expect(live.restored.startPosition).toEqual(start);
      const changed = arrival(socket, 'saveloc-init');
      socket.send(JSON.stringify({type: 'change-map', mapId: 'other'}));
      await changed;
      expect(handlers.entries({...live, map: {...map, id: 'other'}})).toEqual([]);
      expect(handlers.selected(live)).toBe(null);
      f.runtime.leave(id);
      expect(handlers).toBe(null);
      expect(f.timers.pending()).toBe(0);
    } finally { f.runtime.destroy(); }
  });
});
