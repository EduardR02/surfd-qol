// The directory of public rooms, kept apart from the Workers runtime so it can
// be tested anywhere: worker.js stores entries in the Lobby Durable Object.
// Only a room's host can list it (through its room, which holds the host's
// key), and a listing nobody refreshes disappears after LISTING_TTL_MS.

export const LISTING_TTL_MS = 90000;
export const MAX_LISTINGS = 500;
// So that one client can't fill the directory by itself.
export const MAX_LISTINGS_PER_CLIENT = 3;
export const DIRECTORY_SIZE = 200;
// Private-room listings cap both capacity and player counts at 64.
export const MAX_ROOM_PLAYERS = 64;
export const MIN_ROOM_CAPACITY = 2;
export const MAX_ROOM_CAPACITY = 64;
// Room names are free text, normalized before this ASCII character check.
const ROOM_NAME = /^[A-Za-z0-9 '\-_.!?&#:()]+$/;
const MAP_ID = /^[a-z0-9_]{1,64}$/;
const normalizeRoomName = value => typeof value === 'string' ? value.trim().replace(/ +/g, ' ') : '';
// Names that could pass for the site's own servers.
export const IMPERSONATION = /surfd|official/i;
export const MAX_LISTING_ROSTER = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLAYER_NAME = /^[A-Za-z0-9_-]{3,24}$/;
const GUEST_NAME = /^Guest_[0-9a-f]{5}$/;

// A roster preview exposes player names and only their guest/account identity.
// Bound the number of source rows before reading or copying any of them.
// Missing rosters from older hosts become empty previews.
function rosterFrom(value) {
  const roster = [];
  if (!Array.isArray(value)) return roster;
  const length = Math.min(value.length, MAX_LISTING_ROSTER);
  for (let i = 0; i < length; i++) {
    const player = value[i];
    if (!player || typeof player !== 'object' || Array.isArray(player)
      || typeof player.name !== 'string' || !PLAYER_NAME.test(player.name)
      || typeof player.guest !== 'boolean'
      || (player.guest ? !GUEST_NAME.test(player.name) || player.userId !== undefined
        : player.userId !== undefined && (typeof player.userId !== 'string' || !UUID.test(player.userId)))) continue;
    const entry = {name: player.name, guest: player.guest};
    if (!player.guest && player.userId !== undefined) entry.userId = player.userId;
    roster.push(entry);
  }
  return roster;
}

// The fields a host may list, or null when they aren't a listing the
// extension would show: anything else would hide in the directory.
export function listingFrom(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const {mapId, players, capacity} = data;
  const name = normalizeRoomName(data.name);
  return name.length >= 3 && name.length <= 32 && ROOM_NAME.test(name) && !IMPERSONATION.test(name)
    && typeof mapId === 'string' && MAP_ID.test(mapId)
    && Number.isSafeInteger(players) && players >= 0 && players <= MAX_ROOM_PLAYERS
    && Number.isSafeInteger(capacity) && capacity >= MIN_ROOM_CAPACITY && capacity <= MAX_ROOM_CAPACITY
    ? {name, mapId, players, capacity, roster: rosterFrom(data.roster)} : null;
}

// entries: the stored listings by room id, each with the client (limits.js)
// that listed it; save(id, entry) and drop(id) persist one change.
export function createLobby({entries = new Map(), save = () => {}, drop = () => {}, now = Date.now}) {
  function prune() {
    const oldest = now() - LISTING_TTL_MS;
    for (const [id, entry] of entries) if (entry?.updatedAt < oldest) { entries.delete(id); drop(id); }
  }
  return {
    // Lists or updates a room; false when the directory is full of other
    // rooms, or the client already lists as many as it may.
    put(id, listing, client = null) {
      prune();
      if (!entries.has(id) && entries.size >= MAX_LISTINGS) return false;
      const normalized = listingFrom(listing);
      if (!normalized) return false;
      let listed = 0;
      for (const [other, entry] of entries) if (other !== id && entry?.client === client) listed++;
      if (listed >= MAX_LISTINGS_PER_CLIENT) return false;
      const entry = {id, ...normalized, client, updatedAt: now()};
      entries.set(id, entry);
      save(id, entry);
      return true;
    },
    remove(id) {
      if (entries.delete(id)) drop(id);
    },
    // Busiest rooms first, without the clients that listed them. Revalidate
    // persisted rows so old or malformed storage cannot break other listings.
    rooms() {
      prune();
      const rooms = [];
      for (const [id, entry] of entries) {
        const listing = listingFrom(entry);
        if (!listing) {
          entries.delete(id);
          drop(id);
          continue;
        }
        rooms.push({id, ...listing, client: entry.client, updatedAt: entry.updatedAt});
      }
      return rooms.sort((a, b) => b.players - a.players || b.updatedAt - a.updatedAt).slice(0, DIRECTORY_SIZE)
        .map(({client, ...entry}) => entry);
    },
  };
}
