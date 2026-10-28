// The directory of public rooms, kept apart from the Workers runtime so it can
// be tested anywhere: worker.js stores entries in the Lobby Durable Object.
// Only a room's host can list it (through its room, which holds the host's
// key), and a listing nobody refreshes disappears after LISTING_TTL_MS.

export const LISTING_TTL_MS = 90000;
export const MAX_LISTINGS = 500;
export const DIRECTORY_SIZE = 200;
const NAME = 40, MAP = 64;

// The fields a host may list, cleaned, or null when they aren't a listing.
export function listingFrom(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const text = (value, max) => typeof value === 'string'
    // Control characters would break the server list's layout.
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : null;
  const name = text(data.name, NAME), mapId = text(data.mapId, MAP), mapTitle = text(data.mapTitle, MAP) ?? '';
  const players = data.players;
  if (!name || !mapId || !Number.isSafeInteger(players) || players < 0 || players > 100000) return null;
  return {name, mapId, mapTitle, players};
}

// entries: the stored listings by room id; save(id, entry) and drop(id)
// persist one change.
export function createLobby({entries = new Map(), save = () => {}, drop = () => {}, now = Date.now}) {
  function prune() {
    const oldest = now() - LISTING_TTL_MS;
    for (const [id, entry] of entries) if (entry.updatedAt < oldest) { entries.delete(id); drop(id); }
  }
  return {
    // Lists or updates a room; false when the directory is full of other rooms.
    put(id, listing) {
      prune();
      if (!entries.has(id) && entries.size >= MAX_LISTINGS) return false;
      const entry = {id, ...listing, updatedAt: now()};
      entries.set(id, entry);
      save(id, entry);
      return true;
    },
    remove(id) {
      if (entries.delete(id)) drop(id);
    },
    // Busiest rooms first.
    rooms() {
      prune();
      return [...entries.values()].sort((a, b) => b.players - a.players || b.updatedAt - a.updatedAt).slice(0, DIRECTORY_SIZE);
    },
  };
}
