import {MAX_ROOM_PLAYERS, MAX_SNAPSHOT_BLOCKS, POSE_HEADER_BYTES, POSE_SAMPLE_BYTES, SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_BLOCK_BYTES, SPECTATOR_BYTES} from './protocol.js';

const BATCH_SECONDS = 98 / 1000;
const FRAGMENT_BYTES = 1100, FRAGMENT_OVERHEAD = 20 + 8 + 4 + 37 + 28;
const packetBytes = payload => payload + Math.ceil(payload / FRAGMENT_BYTES) * FRAGMENT_OVERHEAD;

// Host-link Mbps, not provider-billed transfer. Movement assumes all guests'
// 98ms paired batches arrive together and share one snapshot flush. Each remote
// guest receives one complete block for every other player (including the
// host, excluding that guest). Staggered arrivals can split batches across
// flushes and increase framing, so this scenario is not an upper bound.
// Spectator defaults separately budget one 30Hz stream per guest each way.
export function estimateBandwidth(players, {spectatorViewers = Math.max(0, players - 1),
  spectatorSenders = Math.max(0, players - 1)} = {}) {
  if (!Number.isInteger(players) || players < 0 || players > MAX_ROOM_PLAYERS) throw new RangeError('Invalid player count');
  const guests = Math.max(0, players - 1);
  for (const streams of [spectatorViewers, spectatorSenders]) {
    if (!Number.isInteger(streams) || streams < 0 || streams > guests) throw new RangeError('Invalid spectator stream count');
  }
  if (!guests) return {upload: 0, download: 0};

  // Each complete native packet is fragmented into at most 1100 data bytes;
  // every fragment carries 97 bytes of IP/UDP/TURN/DTLS/SCTP headers.
  const poseBytes = POSE_HEADER_BYTES + 2 * POSE_SAMPLE_BYTES;
  const blockBytes = SNAPSHOT_BLOCK_BYTES + 2 * POSE_SAMPLE_BYTES;
  let snapshotBytes = 0;
  for (let remaining = guests; remaining > 0; remaining -= MAX_SNAPSHOT_BLOCKS) {
    const payload = SNAPSHOT_HEADER_BYTES + Math.min(remaining, MAX_SNAPSHOT_BLOCKS) * blockBytes;
    snapshotBytes += packetBytes(payload);
  }
  const spectatorBytesPerSecond = packetBytes(SPECTATOR_BYTES) * 30;
  return {
    upload: (guests * snapshotBytes / BATCH_SECONDS + spectatorViewers * spectatorBytesPerSecond) * 8 / 1e6,
    download: (guests * packetBytes(poseBytes) / BATCH_SECONDS + spectatorSenders * spectatorBytesPerSecond) * 8 / 1e6,
  };
}
