import {MAX_ROOM_PLAYERS, POSE_HEADER_BYTES, POSE_SAMPLE_BYTES, SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_BLOCK_BYTES, SPECTATOR_BYTES} from './protocol.js';

const BATCH_SECONDS = 98 / 1000;
const FRAGMENT_BYTES = 1100, FRAGMENT_OVERHEAD = 20 + 8 + 4 + 37 + 28;
const packetBytes = payload => payload + Math.ceil(payload / FRAGMENT_BYTES) * FRAGMENT_OVERHEAD;

// Host-link Mbps, not provider-billed transfer. Movement assumes all guests' 98ms
// paired batches arrive together and share one snapshot flush, so each guest gets
// one block per other player (host included). Staggered arrivals split batches
// across flushes and add framing, so this is not an upper bound. Spectator
// defaults budget one 30Hz stream per guest each way.
export function estimateBandwidth(players, {spectatorViewers = Math.max(0, players - 1),
  spectatorSenders = Math.max(0, players - 1)} = {}) {
  if (!Number.isInteger(players) || players < 0 || players > MAX_ROOM_PLAYERS) throw new RangeError('Invalid player count');
  const guests = Math.max(0, players - 1);
  for (const streams of [spectatorViewers, spectatorSenders]) {
    if (!Number.isInteger(streams) || streams < 0 || streams > guests) throw new RangeError('Invalid spectator stream count');
  }
  if (!guests) return {upload: 0, download: 0};

  // A room's at most 63 guests fit in one native snapshot, fragmented into 1100 data bytes;
  // every fragment carries 97 bytes of IP/UDP/TURN/DTLS/SCTP headers.
  const poseBytes = POSE_HEADER_BYTES + 2 * POSE_SAMPLE_BYTES;
  const blockBytes = SNAPSHOT_BLOCK_BYTES + 2 * POSE_SAMPLE_BYTES;
  const snapshotBytes = packetBytes(SNAPSHOT_HEADER_BYTES + guests * blockBytes);
  const spectatorBytesPerSecond = packetBytes(SPECTATOR_BYTES) * 30;
  return {
    upload: (guests * snapshotBytes / BATCH_SECONDS + spectatorViewers * spectatorBytesPerSecond) * 8 / 1e6,
    download: (guests * packetBytes(poseBytes) / BATCH_SECONDS + spectatorSenders * spectatorBytesPerSecond) * 8 / 1e6,
  };
}
