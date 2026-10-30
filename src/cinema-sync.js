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
  for (let i = 1; i < pairs.length; i++) warp(a, b, pairs[i - 1][0], pairs[i][0], pairs[i - 1][1], pairs[i][1], out);
  // Before the start and after the finish both runs keep their own clock.
  const ratio = a.dt / b.dt;
  for (let tick = 0; tick < a.start; tick++) out[tick] = Math.max(0, b.start - (a.start - tick) * ratio);
  for (let tick = a.finish + 1; tick < a.count; tick++) out[tick] = Math.min(b.count - 1, b.finish + (tick - a.finish) * ratio);
  return ease(out, Math.max(1, Math.round(EASE_SECONDS / a.dt)), a.start, a.finish);
}

// b's index at the same time since each run's start.
export function alignByTime(a, b) {
  const out = new Float32Array(a.count), ratio = a.dt / b.dt;
  for (let tick = 0; tick < a.count; tick++) out[tick] = Math.max(0, Math.min(b.count - 1, b.start + (tick - a.start) * ratio));
  return out;
}

// A centred moving average inside [from, to], then kept non-decreasing.
function ease(values, radius, from, to) {
  const copy = values.slice();
  for (let i = from; i <= to; i++) {
    let total = 0, n = 0;
    for (let k = Math.max(from, i - radius); k <= Math.min(to, i + radius); k++) { total += copy[k]; n++; }
    values[i] = total / n;
  }
  for (let i = 1; i < values.length; i++) if (values[i] < values[i - 1]) values[i] = values[i - 1];
  return values;
}

// The other run's time to this place minus the played run's, in seconds:
// negative when the other run got here sooner.
export function gapAt(a, b, map, tick) {
  const index = Math.max(0, Math.min(a.count - 1, tick));
  if (index < a.start) return null;
  const low = Math.floor(index), high = Math.min(a.count - 1, low + 1);
  const other = map[low] + (map[high] - map[low]) * (index - low);
  return (Math.min(other, b.finish) - b.start) * b.dt - (Math.min(index, a.finish) - a.start) * a.dt;
}
