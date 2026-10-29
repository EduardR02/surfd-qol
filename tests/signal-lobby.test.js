import {expect, test} from 'bun:test';
import {DIRECTORY_SIZE, LISTING_TTL_MS, MAX_LISTINGS, MAX_LISTINGS_PER_CLIENT, MAX_LISTING_ROSTER, MAX_ROOM_CAPACITY, MAX_ROOM_PLAYERS, MIN_ROOM_CAPACITY, createLobby, listingFrom} from '../signal/src/lobby.js';
import {isPlayerName, MAX_ROOM_PLAYERS as CLIENT_MAX_ROOM_PLAYERS} from '../src/private-rooms/protocol.js';
import {createPrivateRooms} from '../src/private-rooms/index.js';

const listing = (players, name = "Host's room") => ({name, mapId: 'surf_utopia', players, capacity: 16});

test('listings validate and normalize their names, capacity, map and player count', () => {
  expect(MAX_ROOM_PLAYERS).toBe(CLIENT_MAX_ROOM_PLAYERS);
  expect(listingFrom({...listing(64, '  My   room#1: (Main)!  '), mapId: 'surf_utopia_njv', mapTitle: '<b>x</b>', extra: 1}))
    .toEqual({name: 'My room#1: (Main)!', mapId: 'surf_utopia_njv', players: 64, capacity: 16, roster: []});
  expect(listingFrom({...listing(0), capacity: MIN_ROOM_CAPACITY})).not.toBeNull();
  expect(listingFrom({...listing(MAX_ROOM_PLAYERS), capacity: MAX_ROOM_CAPACITY})).not.toBeNull();
  for (const data of [null, [], 'x', listing(MAX_ROOM_PLAYERS + 1), listing(100000), listing(-1), listing(1.5), listing('2'),
    {...listing(1), capacity: MIN_ROOM_CAPACITY - 1}, {...listing(1), capacity: MAX_ROOM_CAPACITY + 1},
    {...listing(1), capacity: 2.5}, {...listing(1), capacity: undefined},
    {name: "Host's room", mapId: 'surf_utopia', players: 1},
    {...listing(1), mapId: 'not-a-map'}, {...listing(1), mapId: 'Surf_Utopia'},
    {...listing(1), mapId: 'x'.repeat(65)}, {...listing(1), mapId: ['surf_utopia']},
    listing(1, 'ab'), listing(1, 'Room\tName'), listing(1, 'Room;Name'), listing(1, 'Room<Name>'),
    listing(1, 'x'.repeat(33)), listing(1, ['Host room'])]) {
    expect(listingFrom(data)).toBeNull();
  }
});

test('roster previews are bounded and contain only extension-safe player details', () => {
  for (const name of ['Host_1', 'Player-2', 'Guest_abcde', 'ab', 'x'.repeat(25), 'Name.1', 'Name one', 'ééé']) {
    expect(listingFrom({...listing(1), roster: [{name, points: 0}]}).roster.length).toBe(isPlayerName(name) ? 1 : 0);
  }
  const data = {...listing(3), roster: [
    {name: 'Host_1', points: 0, private: 'not listed'},
    {name: 'ab', points: 2},
    {name: 'Host-3', points: 1.5},
    {name: 'Host_4', points: Number.MAX_SAFE_INTEGER + 1},
    {name: 'Host_5', points: Number.MAX_SAFE_INTEGER},
    {name: 'Guest_abcde', points: Number.MIN_SAFE_INTEGER},
    null,
    ['Host_6', 6],
    {name: '<b>x</b>', points: 0},
  ]};
  expect(listingFrom(data)).toEqual({...listing(3), roster: [
    {name: 'Host_1', points: 0},
    {name: 'Host_5', points: Number.MAX_SAFE_INTEGER},
    {name: 'Guest_abcde', points: Number.MIN_SAFE_INTEGER},
  ]});

  const oversized = Array.from({length: MAX_LISTING_ROSTER + 1}, (_, i) => ({name: `Player_${i}`, points: i}));
  expect(listingFrom({...listing(25), roster: oversized}).roster)
    .toEqual(oversized.slice(0, MAX_LISTING_ROSTER).map(({name, points}) => ({name, points})));
  expect(listingFrom(listing(1)).roster).toEqual([]);
  expect(listingFrom({...listing(1), roster: {}}).roster).toEqual([]);
});

test('names that could pass for the site are not listed', () => {
  for (const name of ["Surfd's room", "SURFD_EU's room", "xsurfdx's room", "Official's room", "the_OFFICIAL's room"]) {
    expect(listingFrom(listing(1, name))).toBeNull();
  }
  expect(listingFrom(listing(1, "Surfer's room"))).not.toBeNull();
});

test('a listing the extension would refuse is never listed, and a bad row hides only itself', async () => {
  expect(listingFrom({name: 'Surfd EU 2 · Frankfurt', mapId: 'not-a-map', mapTitle: '', players: 100000})).toBeNull();
  // A row that got into the directory some other way.
  const lobby = createLobby({});
  expect(lobby.put('p-zzzzzzzzzzzz', {name: 'poison', mapId: 'nope', players: 100000}, 'a')).toBe(false);
  lobby.put('p-abcdefghjkmn', {name: "Legit's room", mapId: 'map', players: 3, capacity: 16}, 'b');
  const body = {rooms: [
    {id: 'p-zzzzzzzzzzzz', name: 'poison', mapId: 'nope', players: 100000, roster: [{name: '<bad>', points: 'x'}]},
    ...lobby.rooms(),
  ]};
  let rows = [];
  const notices = [];
  const adapter = {rooms: {notice: text => notices.push(text), rows: () => rows, update: value => { rows = value; },
    maps: () => [{id: 'map', title: 'Map'}], currentMap: () => ({id: 'map'}), displayName: () => 'x', appearance: () => null,
    guest: () => true, browserOpen: () => true}};
  const runtime = createPrivateRooms({getAdapter: () => adapter, uiFactory: () => ({refresh() {}, destroy() {}}),
    fetch: async () => ({ok: true, json: async () => body}), storage: {getItem: () => null, setItem() {}}});
  try {
    await runtime.refreshDirectory({open: true});
    expect(notices).toEqual([]);
    expect(runtime.mergeRooms([]).map(row => row.id)).toEqual(['p-abcdefghjkmn']);
  } finally { runtime.destroy(); }
});

test('the directory lists the busiest rooms first and forgets listings nobody refreshes', () => {
  let time = 0;
  const saved = new Map(), dropped = [];
  const lobby = createLobby({save: (id, entry) => saved.set(id, entry), drop: id => dropped.push(id), now: () => time});
  lobby.put('p-quiet', listing(2), 'a');
  time = 1000;
  lobby.put('p-busy', listing(9), 'b');
  expect(lobby.rooms().map(room => room.id)).toEqual(['p-busy', 'p-quiet']);
  expect(saved.get('p-busy')).toEqual({id: 'p-busy', ...listing(9), roster: [], client: 'b', updatedAt: 1000});
  // Refreshing keeps a room; silence lets it go.
  time = LISTING_TTL_MS + 500;
  lobby.put('p-busy', listing(10), 'b');
  expect(lobby.rooms().map(room => room.id)).toEqual(['p-busy']);
  expect(dropped).toEqual(['p-quiet']);
  lobby.remove('p-busy');
  expect(lobby.rooms()).toEqual([]);
});

test('the directory never shows who listed a room', () => {
  const lobby = createLobby({now: () => 5});
  lobby.put('p-a', listing(1), '203.0.113.7');
  expect(lobby.rooms()).toEqual([{id: 'p-a', ...listing(1), roster: [], updatedAt: 5}]);
});

test('one client lists at most MAX_LISTINGS_PER_CLIENT rooms, and may keep updating them', () => {
  let time = 0;
  const lobby = createLobby({now: () => time});
  for (let i = 0; i < MAX_LISTINGS_PER_CLIENT; i++) expect(lobby.put(`p-home${i}`, listing(i), 'home')).toBe(true);
  expect(lobby.put('p-home9', listing(1), 'home')).toBe(false);
  expect(lobby.put('p-home0', listing(7), 'home')).toBe(true);
  expect(lobby.put('p-away', listing(1), 'away')).toBe(true);
  lobby.remove('p-home1');
  expect(lobby.put('p-home9', listing(1), 'home')).toBe(true);
  // Listings that expire free their places too.
  time = LISTING_TTL_MS + 1;
  expect(lobby.put('p-home8', listing(1), 'home')).toBe(true);
});

test('the directory refuses new rooms when full, keeps updating listed ones, and returns at most DIRECTORY_SIZE', () => {
  const lobby = createLobby({now: () => 0});
  for (let i = 0; i < MAX_LISTINGS; i++) expect(lobby.put(`p-${i}`, listing(i % MAX_ROOM_PLAYERS), `client-${i}`)).toBe(true);
  expect(lobby.put('p-new', listing(1), 'new')).toBe(false);
  expect(lobby.put('p-0', listing(5), 'client-0')).toBe(true);
  expect(lobby.rooms()).toHaveLength(DIRECTORY_SIZE);
});

test('a lobby woken from storage carries on with its stored listings', () => {
  const lobby = createLobby({entries: new Map([['p-a', {id: 'p-a', ...listing(4), client: 'a', updatedAt: 50}]]), now: () => 100});
  expect(lobby.rooms()).toEqual([{id: 'p-a', ...listing(4), roster: [], updatedAt: 50}]);
});

test('malformed stored rows and roster entries do not poison other public rooms', () => {
  const entries = new Map([
    ['p-bad', {id: 'p-bad', name: 'Bad', mapId: 'map', players: 1, client: 'a', updatedAt: 50}],
    ['p-good', {id: 'p-good', name: "Good's room", mapId: 'map', players: 2, capacity: 16,
      roster: [{name: '<bad>', points: 1}, {name: 'Visitor_1', points: 5}], client: 'b', updatedAt: 51}],
  ]);
  const lobby = createLobby({entries, now: () => 100});
  expect(lobby.rooms()).toEqual([{id: 'p-good', name: "Good's room", mapId: 'map', players: 2, capacity: 16,
    roster: [{name: 'Visitor_1', points: 5}], updatedAt: 51}]);
  expect(entries.has('p-bad')).toBe(false);
});
