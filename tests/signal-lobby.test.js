import {expect, test} from 'bun:test';
import {DIRECTORY_SIZE, LISTING_TTL_MS, MAX_LISTINGS, createLobby, listingFrom} from '../signal/src/lobby.js';

const listing = (players, name = 'Room') => ({name, mapId: 'surf_utopia', mapTitle: 'Utopia', players});

test('listings are cleaned: control characters and padding go, lengths are capped, bad ones refused', () => {
  expect(listingFrom({name: ' a\nb ', mapId: 'm', players: 0})).toEqual({name: 'ab', mapId: 'm', mapTitle: '', players: 0});
  expect(listingFrom({name: 'x'.repeat(60), mapId: 'y'.repeat(90), mapTitle: 'z'.repeat(90), players: 2}))
    .toEqual({name: 'x'.repeat(40), mapId: 'y'.repeat(64), mapTitle: 'z'.repeat(64), players: 2});
  for (const data of [null, [], 'x', {name: '  ', mapId: 'm', players: 1}, {name: 'a', mapId: '', players: 1}, {name: 'a', mapId: 'm', players: 1.5}, {name: 'a', mapId: 'm', players: -1}, {name: 'a', mapId: 'm'}]) {
    expect(listingFrom(data)).toBeNull();
  }
});

test('the directory lists the busiest rooms first and forgets listings nobody refreshes', () => {
  let time = 0;
  const saved = new Map(), dropped = [];
  const lobby = createLobby({save: (id, entry) => saved.set(id, entry), drop: id => dropped.push(id), now: () => time});
  lobby.put('p-quiet', listing(2));
  time = 1000;
  lobby.put('p-busy', listing(9));
  expect(lobby.rooms().map(room => room.id)).toEqual(['p-busy', 'p-quiet']);
  expect(saved.get('p-busy')).toEqual({id: 'p-busy', ...listing(9), updatedAt: 1000});
  // Refreshing keeps a room; silence lets it go.
  time = LISTING_TTL_MS + 500;
  lobby.put('p-busy', listing(10));
  expect(lobby.rooms().map(room => room.id)).toEqual(['p-busy']);
  expect(dropped).toEqual(['p-quiet']);
  lobby.remove('p-busy');
  expect(lobby.rooms()).toEqual([]);
});

test('the directory refuses new rooms when full, keeps updating listed ones, and returns at most DIRECTORY_SIZE', () => {
  const lobby = createLobby({now: () => 0});
  for (let i = 0; i < MAX_LISTINGS; i++) expect(lobby.put(`p-${i}`, listing(i))).toBe(true);
  expect(lobby.put('p-new', listing(1))).toBe(false);
  expect(lobby.put('p-0', listing(5))).toBe(true);
  expect(lobby.rooms()).toHaveLength(DIRECTORY_SIZE);
});

test('a lobby woken from storage carries on with its stored listings', () => {
  const lobby = createLobby({entries: new Map([['p-a', {id: 'p-a', ...listing(4), updatedAt: 50}]]), now: () => 100});
  expect(lobby.rooms()).toEqual([{id: 'p-a', ...listing(4), updatedAt: 50}]);
});
