import {MAX_SNAPSHOT_BLOCKS, POSE_HEADER_BYTES, POSE_SAMPLE_BYTES, SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_BLOCK_BYTES, SNAPSHOT_INTERVAL_MS, SPECTATOR_BYTES} from './protocol.js';

export function estimateBandwidth(players) {
  if (!Number.isInteger(players) || players < 0 || players > 65536) throw new RangeError('Invalid player count');
  const guests = Math.max(0, players - 1);
  if (!guests) return {upload: 0, download: 0};
  // Two samples every 98ms, 50ms snapshots, 93B IP/UDP/DTLS/SCTP overhead per 1100B fragment,
  // and one 20Hz spectator stream per guest in each direction; host loopback uses no network.
  const batchSeconds = 2 * 49 / 1000, tickSeconds = SNAPSHOT_INTERVAL_MS / 1000;
  const overhead = 28 + 37 + 28, fragmentBytes = 1100;
  const poseBytes = POSE_HEADER_BYTES + 2 * POSE_SAMPLE_BYTES;
  const blockBytes = SNAPSHOT_BLOCK_BYTES + 2 * POSE_SAMPLE_BYTES;
  const blocksPerTick = guests * tickSeconds / batchSeconds;
  let snapshotBytes = 0;
  for (let remaining = blocksPerTick; remaining > 0; remaining -= MAX_SNAPSHOT_BLOCKS) {
    const payload = SNAPSHOT_HEADER_BYTES + Math.min(remaining, MAX_SNAPSHOT_BLOCKS) * blockBytes;
    snapshotBytes += payload + Math.ceil(payload / fragmentBytes) * overhead;
  }
  const spectatorBytes = (SPECTATOR_BYTES + overhead) / tickSeconds;
  return {
    upload: guests * (snapshotBytes / tickSeconds + spectatorBytes) * 8 / 1e6,
    download: guests * ((poseBytes + overhead) / batchSeconds + spectatorBytes) * 8 / 1e6,
  };
}
