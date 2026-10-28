import {isPrivateRoomId} from './ids.js';

const VOTES = 'There are no map votes here. The host picks the map.';
const LOOKUPS = 'Rank and playtime lookups only work on official servers.';
const REPLIES = new Map([
  ['rtv', VOTES], ['nominate', VOTES], ['extend', VOTES], ['vote', VOTES],
  ['timeleft', 'No time limit in this room.'],
  ['nextmap', 'The host picks the next map.'],
  ['rank', LOOKUPS], ['mrank', LOOKUPS], ['played', LOOKUPS],
]);

export function commandReply(command, roomId) {
  if (!isPrivateRoomId(roomId) || typeof command !== 'string') return null;
  const name = command.trim().split(/\s+/, 1)[0].replace(/^[!/]/, '').toLowerCase();
  return REPLIES.get(name) ?? null;
}
