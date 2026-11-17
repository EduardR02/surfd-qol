// The Cinematic camera's flight: the searched take, flown.
//
// The search gives a path that is right about the map but made of straight
// legs. The camera flies it with momentum: of all paths, the one with the
// least jerk that stays near the searched one. It rounds the corners and
// starts turning before a leg ends. Every sample of the result is then
// held to the same rules as the search (the run in sight, in front of its
// ramp, clear of the lens and of terrain); where one fails, the flight is
// held nearer the searched path there and flown again. Nothing is moved
// after the fact.
import {barred, SKIM} from './cinema-viewpoints.js';

// What the flight rounds off: of a movement in the searched path that comes
// and goes within ROUND seconds, half is flown; slower ones are followed and
// quicker ones (a corner, a step from one viewpoint to the next) smoothed away.
const ROUND = 1.1;
// Where a sample fails, the pull to the searched path there is multiplied by
// FIRMER and the flight flown again, up to HELD, where it all but follows
// the searched path; after ROUNDS it is left as it is. The firmer pull fades
// over FADE seconds either side.
const FIRMER = 12, ROUNDS = 8, HELD = 2e4, FADE = 0.3;
// A firmer pull changes the flight this many seconds either side; only that is looked at again.
const FELT = 1.2;

// Solves (W + k D'D) x = W p over samples lo..hi for each axis, D the third
// difference: the path of least jerk that stays near p.
async function solve(path, weight, lo, hi, stiffness, eye, work, due, pause) {
  const n = hi - lo + 1, {a0, a1, a2, a3, d, l1, l2, l3, y} = work, c = [1, -3, 3, -1];
  a0.fill(0, 0, n); a1.fill(0, 0, n); a2.fill(0, 0, n); a3.fill(0, 0, n);
  for (let i = 0; i + 3 < n; i++) {
    if ((i & 255) === 0 && due()) await pause();
    for (let p = 0; p < 4; p++) {
      a0[i + p] += c[p] * c[p];
      if (p < 3) a1[i + p] += c[p] * c[p + 1];
      if (p < 2) a2[i + p] += c[p] * c[p + 2];
      if (p < 1) a3[i + p] += c[p] * c[p + 3];
    }
  }
  for (let i = 0; i < n; i++) {
    if ((i & 255) === 0 && due()) await pause();
    a0[i] = a0[i] * stiffness + weight[lo + i]; a1[i] *= stiffness; a2[i] *= stiffness; a3[i] *= stiffness;
  }
  for (let i = 0; i < n; i++) {
    if ((i & 255) === 0 && due()) await pause();
    l3[i] = i >= 3 ? a3[i - 3] / d[i - 3] : 0;
    l2[i] = i >= 2 ? (a2[i - 2] - (i >= 3 ? l3[i] * d[i - 3] * l1[i - 2] : 0)) / d[i - 2] : 0;
    l1[i] = i >= 1 ? (a1[i - 1] - (i >= 3 ? l3[i] * d[i - 3] * l2[i - 1] : 0) - (i >= 2 ? l2[i] * d[i - 2] * l1[i - 1] : 0)) / d[i - 1] : 0;
    d[i] = a0[i] - (i >= 1 ? l1[i] * l1[i] * d[i - 1] : 0) - (i >= 2 ? l2[i] * l2[i] * d[i - 2] : 0) - (i >= 3 ? l3[i] * l3[i] * d[i - 3] : 0);
  }
  for (let axis = 0; axis < 3; axis++) {
    for (let i = 0; i < n; i++) {
      if ((i & 255) === 0 && due()) await pause();
      y[i] = weight[lo + i] * path[(lo + i) * 3 + axis] - (i >= 1 ? l1[i] * y[i - 1] : 0) - (i >= 2 ? l2[i] * y[i - 2] : 0) - (i >= 3 ? l3[i] * y[i - 3] : 0);
    }
    for (let i = n - 1; i >= 0; i--) {
      if (((n - 1 - i) & 255) === 0 && due()) await pause();
      y[i] = y[i] / d[i] - (i + 1 < n ? l1[i + 1] * y[i + 1] : 0) - (i + 2 < n ? l2[i + 2] * y[i + 2] : 0) - (i + 3 < n ? l3[i + 3] * y[i + 3] : 0);
      eye[(lo + i) * 3 + axis] = y[i];
    }
  }
}

// path, crossing: from searchTake. Returns the eye, one point a sample, or null if a hard rule remains broken.
export async function fly({route, scene, path, crossing, due, pause, debug = false}) {
  const {count, dt, segTo} = route, eye = new Float32Array(count * 3), weight = new Float64Array(count).fill(1);
  const stiffness = (ROUND / (2 * Math.PI * dt)) ** 6, fade = Math.max(1, Math.round(FADE / dt)), felt = Math.round(FELT / dt);
  const stats = {firmer: 0, held: 0, failed: 0, near: 0, face: 0, hidden: 0, solid: 0, checks: 0};
  // Terrain is let through for as long as the flight may take to make a crossing the search planned.
  const through = new Uint8Array(count);
  for (let s = 0; s < count; s++) {
    if ((s & 255) === 0 && due()) await pause();
    if (crossing[s]) for (let k = Math.max(0, s - fade); k <= Math.min(count - 1, s + fade); k++) through[k] = 1;
  }
  const stale = new Uint8Array(count), bad = new Uint8Array(count), why = debug ? new Uint8Array(count) : null;
  // Repairs solve the whole segment, but often leave distant Float32 eyes
  // unchanged. Reuse their clearance only for the exact same coordinates.
  const checkedEye = new Float32Array(count * 3), clearance = new Uint8Array(count), pathSight = new Uint8Array(count);
  let longest = 0;
  for (let s = 0; s < count; s = segTo[s] + 1) longest = Math.max(longest, segTo[s] - s + 1);
  const work = Object.fromEntries(['a0', 'a1', 'a2', 'a3', 'd', 'l1', 'l2', 'l3', 'y'].map(name => [name, new Float64Array(longest)]));
  // 0 where a sample holds; else which rule it breaks. Even when sight is
  // already lost on the searched path, the flown eye must still fit.
  const hard = s => {
    const x = eye[s * 3], y = eye[s * 3 + 1], z = eye[s * 3 + 2];
    const rule = barred(route, s, x, y, z);
    if (rule) return rule;
    if (through[s]) return 0;
    const o = s * 3;
    if (!clearance[s] || !Object.is(checkedEye[o], x) || !Object.is(checkedEye[o + 1], y) || !Object.is(checkedEye[o + 2], z)) {
      checkedEye[o] = x; checkedEye[o + 1] = y; checkedEye[o + 2] = z;
      clearance[s] = scene.free(x, y, z, SKIM) ? 1 : 2;
    }
    return clearance[s] === 1 ? 0 : 4;
  };
  const broken = s => {
    stats.checks++;
    const rule = hard(s);
    if (rule) return rule;
    const x = eye[s * 3], y = eye[s * 3 + 1], z = eye[s * 3 + 2];
    if (scene.sees(x, y, z, s)) return 0;
    if (!pathSight[s]) pathSight[s] = scene.sees(path[s * 3], path[s * 3 + 1], path[s * 3 + 2], s) ? 1 : 2;
    return pathSight[s] === 1 ? 3 : 0;
  };
  for (let lo = 0; lo < count; lo = segTo[lo] + 1) {
    const hi = segTo[lo];
    if (hi - lo < 3) {
      eye.set(path.subarray(lo * 3, (hi + 1) * 3), lo * 3);
      for (let s = lo; s <= hi; s++) if (hard(s)) return null;
      continue;
    }
    stale.fill(1, lo, hi + 1);
    for (let round = 0; round <= ROUNDS; round++) {
      await pause();
      await solve(path, weight, lo, hi, stiffness, eye, work, due, pause);
      let failing = 0;
      for (let s = lo; s <= hi; s++) {
        if (!stale[s]) continue;
        if (due()) await pause();
        bad[s] = broken(s);
        if (bad[s]) failing++;
      }
      // Solving is global even when the repair window is local. Before
      // finishing, check that rounding has not broken a hard rule elsewhere.
      if (!failing && round) for (let s = lo; s <= hi; s++) {
        if (stale[s]) continue;
        if ((s & 255) === 0 && due()) await pause();
        bad[s] = hard(s);
        if (bad[s]) { stale[s] = 1; failing++; }
      }
      if (!failing) break;
      if (round === ROUNDS) {
        stats.failed += failing;
        for (let s = lo; s <= hi; s++) {
          if ((s & 255) === 0 && due()) await pause();
          const rule = stale[s] ? bad[s] : hard(s);
          if (rule && rule !== 3) return null;
        }
        break;
      }
      stale.fill(0, lo, hi + 1);
      const level = Math.min(HELD, FIRMER ** (round + 1));
      for (let s = lo; s <= hi; s++) {
        if (((s - lo) & 63) === 0 && due()) await pause();
        if (!bad[s]) continue;
        if (why && !why[s]) why[s] = bad[s];
        if (!round) { stats.firmer++; stats[['', 'near', 'face', 'hidden', 'solid'][bad[s]]]++; }
        if (level === HELD && weight[s] < HELD) stats.held++;
        for (let k = Math.max(lo, s - felt); k <= Math.min(hi, s + felt); k++) {
          stale[k] = 1;
          const near = Math.abs(k - s);
          if (near > fade) continue;
          const t = 1 - near / (fade + 1), wanted = 1 + (level - 1) * t * t * (3 - 2 * t);
          if (wanted > weight[k]) weight[k] = wanted;
        }
      }
    }
  }
  return debug ? {eye, flight: stats, weight, why} : {eye};
}
