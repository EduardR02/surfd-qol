import {createTrack, trackPoint, trackYaw} from './cinema-track.js';

// A run resampled at each of the watched run's ticks.
export function onClock(track, map, clock) {
  const out = createTrack(clock.count, clock.dt), point = {x: 0, y: 0, z: 0};
  for (let tick = 0; tick < clock.count; tick++) {
    const at = map[tick], nearest = Math.round(Math.max(0, Math.min(track.count - 1, at)));
    trackPoint(track, at, point);
    out.position[tick * 3] = point.x; out.position[tick * 3 + 1] = point.y; out.position[tick * 3 + 2] = point.z;
    out.yaw[tick] = trackYaw(track, at);
    out.ducked[tick] = track.ducked[nearest];
    const source = nearest * 3, target = tick * 3;
    out.normal[target] = track.normal[source]; out.normal[target + 1] = track.normal[source + 1]; out.normal[target + 2] = track.normal[source + 2];
    if (tick) for (let k = Math.floor(map[tick - 1]) + 1; k <= Math.floor(at) && !out.cut[tick]; k++) out.cut[tick] = track.cut[k] ?? 0;
  }
  // Its start and finish on the watched clock, which the camera's shots follow.
  const reached = tick => { let at = 0; while (at < clock.count - 1 && map[at] < tick) at++; return at; };
  if (track.start > 0) out.start = reached(track.start);
  if (track.finish < track.count - 1) out.finish = reached(track.finish);
  return out;
}
