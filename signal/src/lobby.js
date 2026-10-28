// The directory of public rooms, kept apart from the Workers runtime so it can
// be tested anywhere: worker.js stores entries in the Lobby Durable Object.
// Only a room's host can list it (through its room, which holds the host's
// key), and a listing nobody refreshes disappears after LISTING_TTL_MS.

export const LISTING_TTL_MS = 90000;
export const MAX_LISTINGS = 500;
// So that one client can't fill the directory by itself.
export const MAX_LISTINGS_PER_CLIENT = 3;
export const DIRECTORY_SIZE = 200;
// Matches MAX_ROOM_PLAYERS in src/private-rooms/protocol.js.
export const MAX_ROOM_PLAYERS = 256;
// The extension names a room after its host, under the site's username rules.
const ROOM_NAME = /^[A-Za-z0-9_-]{3,24}'s room$/;
// The game's map ids, such as surf_utopia_njv.
const MAP_ID = /^[a-z0-9_]{1,64}$/;
// Names that could pass for the site's own servers.
export const IMPERSONATION = /surfd|official/i;

// The fields a host may list, or null when they aren't a listing the
// extension would show: anything else would hide in the directory.
export function listingFrom(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const {name, mapId, players} = data;
  return typeof name === 'string' && ROOM_NAME.test(name) && !IMPERSONATION.test(name)
    && typeof mapId === 'string' && MAP_ID.test(mapId)
    && Number.isSafeInteger(players) && players >= 0 && players <= MAX_ROOM_PLAYERS ? {name, mapId, players} : null;
}

// entries: the stored listings by room id, each with the client (limits.js)
// that listed it; save(id, entry) and drop(id) persist one change.
export function createLobby({entries = new Map(), save = () => {}, drop = () => {}, now = Date.now}) {
  function prune() {
    const oldest = now() - LISTING_TTL_MS;
    for (const [id, entry] of entries) if (entry.updatedAt < oldest) { entries.delete(id); drop(id); }
  }
  return {
    // Lists or updates a room; false when the directory is full of other
    // rooms, or the client already lists as many as it may.
    put(id, listing, client = null) {
      prune();
      if (!entries.has(id) && entries.size >= MAX_LISTINGS) return false;
      let listed = 0;
      for (const [other, entry] of entries) if (other !== id && entry.client === client) listed++;
      if (listed >= MAX_LISTINGS_PER_CLIENT) return false;
      const entry = {id, ...listing, client, updatedAt: now()};
      entries.set(id, entry);
      save(id, entry);
      return true;
    },
    remove(id) {
      if (entries.delete(id)) drop(id);
    },
    // Busiest rooms first, without the clients that listed them.
    rooms() {
      prune();
      return [...entries.values()].sort((a, b) => b.players - a.players || b.updatedAt - a.updatedAt).slice(0, DIRECTORY_SIZE)
        .map(({client, ...entry}) => entry);
    },
  };
}
