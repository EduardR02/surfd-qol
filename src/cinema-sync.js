// Where the other run is while the played run is at a given tick. Side by
// side matches places along the route, so the faster run is slowed down and
// both stay together and the gap reads as time; Real time matches the clock.
import {trackPoint} from './cinema-track.js';

// Each stretch between shared checkpoints is matched on at most this many
// samples per run: about 360k cells, a few milliseconds.
const MAX_SAMPLES = 600;
// The match is eased over this long, so the slowed run never stutters.
const EASE_SECONDS = 0.35;

// Dynamic time warping between run a's [a0, a1] and run b's [b0, b1]: the
// monotonic pairing of their positions with the least total distance. Returns
// b's fractional index for each of a's ticks in the stretch.
function warp(a, b, a0, a1, b0, b1, out) {
  const na = Math.max(2, Math.min(MAX_SAMPLES, a1 - a0 + 1)), nb = Math.max(2, Math.min(MAX_SAMPLES, b1 - b0 + 1));
  const at = (from, to, n, k) => from + (to - from) * k / (n - 1);
  const pa = new Float32Array(na * 3), pb = new Float32Array(nb * 3), point = {x: 0, y: 0, z: 0};
  for (let i = 0; i < na; i++) { trackPoint(a, at(a0, a1, na, i), point); pa.set([point.x, point.y, point.z], i * 3); }
  for (let j = 0; j < nb; j++) { trackPoint(b, at(b0, b1, nb, j), point); pb.set([point.x, point.y, point.z], j * 3); }
  const cost = new Float32Array(na * nb);
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < nb; j++) {
      const dx = pa[i * 3] - pb[j * 3], dy = pa[i * 3 + 1] - pb[j * 3 + 1], dz = pa[i * 3 + 2] - pb[j * 3 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const up = i ? cost[(i - 1) * nb + j] : Infinity, left = j ? cost[i * nb + j - 1] : Infinity;
      const diagonal = i && j ? cost[(i - 1) * nb + j - 1] : i || j ? Infinity : 0;
      cost[i * nb + j] = d + Math.min(up, left, diagonal);
    }
  }
  // Walk back from the end; each of a's samples takes the mean of the b samples it pairs with.
  const sum = new Float64Array(na), count = new Uint16Array(na);
  for (let i = na - 1, j = nb - 1; ;) {
    sum[i] += j; count[i]++;
    if (!i && !j) break;
    if (!i) j--;
    else if (!j) i--;
    else {
      const diagonal = cost[(i - 1) * nb + j - 1], up = cost[(i - 1) * nb + j], left = cost[i * nb + j - 1];
      if (diagonal <= up && diagonal <= left) { i--; j--; } else if (up <= left) i--; else j--;
    }
  }
  for (let tick = a0; tick <= a1; tick++) {
    const k = a1 === a0 ? 0 : (tick - a0) * (na - 1) / (a1 - a0), low = Math.floor(k), high = Math.min(na - 1, low + 1);
    const mean = index => sum[index] / count[index];
    const sample = mean(low) + (mean(high) - mean(low)) * (k - low);
    out[tick] = at(b0, b1, nb, sample);
  }
}

// Shared anchors: the start, each checkpoint both runs crossed in order, and
// the finish. Runs on different routes still share the start and finish.
function anchors(a, b) {
  const list = [[a.start, b.start]];
  if (a.splits.length === b.splits.length) for (let i = 0; i < a.splits.length; i++) list.push([a.splits[i], b.splits[i]]);
  list.push([a.finish, b.finish]);
  return list.filter(([ta, tb], i) => i === 0 || ta > list[i - 1][0] && tb > list[i - 1][1]);
}

// b's fractional index for each of a's ticks, by place along the route.
export function alignByPlace(a, b) {
  const out = new Float32Array(a.count);
  const pairs = anchors(a, b);
  const radius = Math.max(1, Math.round(EASE_SECONDS / a.dt));
  for (let i = 1; i < pairs.length; i++) {
    const [from, otherFrom] = pairs[i - 1], [to, otherTo] = pairs[i];
    warp(a, b, from, to, otherFrom, otherTo, out);
    // DTW may average several samples at a boundary. Timer anchors are exact.
    out[from] = otherFrom;
    out[to] = otherTo;
    ease(out, radius, from, to);
  }
  // Before the start and after the finish both runs keep their own clock.
  const ratio = a.dt / b.dt;
  for (let tick = 0; tick < a.start; tick++) out[tick] = Math.max(0, b.start - (a.start - tick) * ratio);
  for (let tick = a.finish + 1; tick < a.count; tick++) out[tick] = Math.min(b.count - 1, b.finish + (tick - a.finish) * ratio);
  return out;
}

// b's index at the same time since each run's start.
export function alignByTime(a, b) {
  const out = new Float32Array(a.count), ratio = a.dt / b.dt;
  const startA = a.startTick ?? a.start, startB = b.startTick ?? b.start;
  for (let tick = 0; tick < a.count; tick++) out[tick] = Math.max(0, Math.min(b.count - 1, startB + (tick - startA) * ratio));
  return out;
}

// A centred moving average within one checkpoint stretch. Shrinking its
// window at either end preserves exact anchors instead of inventing a gap.
function ease(values, radius, from, to) {
  const copy = values.slice(from, to + 1);
  let total = 0, left = from, right = from - 1;
  for (let i = from; i <= to; i++) {
    const reach = Math.min(radius, i - from, to - i);
    const low = i - reach, high = i + reach;
    while (right < high) total += copy[++right - from];
    while (left < low) total -= copy[left++ - from];
    values[i] = total / (right - left + 1);
  }
}

// Each run's clock where it is, as the game's timer read it.
function clock(track, at) {
  const index = Math.max(0, Math.min(track.finish, at)), low = Math.floor(index), high = Math.min(track.count - 1, low + 1);
  if (track.phase && (track.startTick === null || index < track.startTick || !track.phase[low] && !track.phase[high])) return null;
  // The first running sample includes only the remainder of its start tick.
  // Interpolating it from zero would incorrectly stretch that fraction.
  if (track.startTick !== null && index >= track.startTick) {
    return Math.min(track.time ?? Infinity, (index - track.startTick) * track.dt);
  }
  return track.elapsed[low] + (track.elapsed[high] - track.elapsed[low]) * (index - low);
}
// The other run's time to this place minus the played run's, in seconds:
// negative when the other run got here sooner.
export function gapAt(a, b, map, tick) {
  const index = Math.max(0, Math.min(a.count - 1, tick));
  if (index < (a.startTick ?? a.start)) return null;
  const low = Math.floor(index), high = Math.min(a.count - 1, low + 1);
  const other = clock(b, map[low] + (map[high] - map[low]) * (index - low)), played = clock(a, index);
  return played === null || other === null ? null : other - played;
}
