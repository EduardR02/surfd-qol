// Camera and physics share the native collision tree, but not brush visibility.
const SOLID = 0x1, SEE_THROUGH = 0x10000000 | 0x8;
export const PROBE = {min: {x: -6, y: -6, z: -6}, max: {x: 6, y: 6, z: 6}};
// A sightline is a thin ray. Looking through solid it crosses at most LAYERS
// touching brushes, each entered SKIN units past its face.
const RAY = {min: {x: -1, y: -1, z: -1}, max: {x: 1, y: 1, z: 1}}, LAYERS = 12, SKIN = 2;
// How far overhead terrain is looked for above a camera position.
const OVERHEAD = 8192;
const cameraWorlds = new WeakMap();

const AXES = ['x', 'y', 'z'];
// Keep malformed or extreme geometry in the native candidate set. For
// ordinary coordinates, a one-unit margin exceeds the native trace epsilon.
function prepareSweep(from, to, hull, sweep) {
  if (!from || !to || !hull?.min || !hull?.max) return false;
  for (let i = 0; i < 3; i++) {
    const axis = AXES[i], start = from[axis], end = to[axis], min = hull.min[axis], max = hull.max[axis];
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(min) || !Number.isFinite(max) ||
        Math.max(Math.abs(start), Math.abs(end), Math.abs(min), Math.abs(max)) > 1e7 || min > max) return false;
    const delta = end - start, inverse = delta ? 1 / delta : 0;
    if (!Number.isFinite(inverse)) return false;
    sweep.start[i] = start; sweep.delta[i] = delta; sweep.inverse[i] = inverse;
    sweep.min[i] = min; sweep.max[i] = max;
    sweep.boundsMin[i] = Math.min(start, end) + min;
    sweep.boundsMax[i] = Math.max(start, end) + max;
  }
  sweep.hullSpan = sweep.max[0] - sweep.min[0] + sweep.max[1] - sweep.min[1] + sweep.max[2] - sweep.min[2];
  return true;
}

// Only substitute the broadphase for the native trace's own swept hull query.
function sweepBounds(bounds, sweep) {
  if (!bounds?.min || !bounds?.max) return false;
  for (let i = 0; i < 3; i++) {
    const axis = AXES[i], min = bounds.min[axis], max = bounds.max[axis];
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > sweep.boundsMin[i] || min < sweep.boundsMin[i] - 1 ||
        max < sweep.boundsMax[i] || max > sweep.boundsMax[i] + 1) return false;
  }
  return true;
}

// A convex brush or triangle cannot intersect a swept hull if the hull's
// reference point never enters its expanded AABB. Keep all uncertain cases.
function sweepMayHit(box, sweep) {
  const min = box?.min, max = box?.max;
  if (!min || !max || !Number.isFinite(min.x) || !Number.isFinite(min.y) || !Number.isFinite(min.z) ||
      !Number.isFinite(max.x) || !Number.isFinite(max.y) || !Number.isFinite(max.z) ||
      min.x > max.x || min.y > max.y || min.z > max.z ||
      Math.max(Math.abs(min.x), Math.abs(min.y), Math.abs(min.z), Math.abs(max.x), Math.abs(max.y), Math.abs(max.z)) > 1e7) return true;
  // This is the hot candidate path. Keep the same conservative slab bounds
  // in native XYZ order without per-candidate axis/property dispatch.
  let first = 0, last = 1, low, high, enter, leave, swap;
  const x = sweep.start[0], dx = sweep.delta[0];
  low = min.x - sweep.max[0] - 1; high = max.x - sweep.min[0] + 1;
  if (dx === 0) { if (x < low || x > high) return false; }
  else {
    enter = (low - x) * sweep.inverse[0]; leave = (high - x) * sweep.inverse[0];
    if (enter > leave) { swap = enter; enter = leave; leave = swap; }
    first = Math.max(first, enter); last = Math.min(last, leave);
    if (first > last + 1e-12) return false;
  }
  const y = sweep.start[1], dy = sweep.delta[1];
  low = min.y - sweep.max[1] - 1; high = max.y - sweep.min[1] + 1;
  if (dy === 0) { if (y < low || y > high) return false; }
  else {
    enter = (low - y) * sweep.inverse[1]; leave = (high - y) * sweep.inverse[1];
    if (enter > leave) { swap = enter; enter = leave; leave = swap; }
    first = Math.max(first, enter); last = Math.min(last, leave);
    if (first > last + 1e-12) return false;
  }
  const z = sweep.start[2], dz = sweep.delta[2];
  low = min.z - sweep.max[2] - 1; high = max.z - sweep.min[2] + 1;
  if (dz === 0) { if (z < low || z > high) return false; }
  else {
    enter = (low - z) * sweep.inverse[2]; leave = (high - z) * sweep.inverse[2];
    if (enter > leave) { swap = enter; enter = leave; leave = swap; }
    first = Math.max(first, enter); last = Math.min(last, leave);
    if (first > last + 1e-12) return false;
  }
  return true;
}

// An arbitrary convex brush can have sharp corners whose plane epsilon
// extends far past its vertex AABB. Cull only when all six axis support
// planes independently bound the expanded hull within the one-unit margin.
function boundedBrush(brush) {
  if (!Array.isArray(brush?.planes) || !brush.planes.length) return false;
  let axes = 0;
  for (const plane of brush.planes) {
    const n = plane?.normal, distance = plane?.distance;
    if (!n || !Number.isFinite(distance)) continue;
    let axis, bit, value;
    if (n.y === 0 && n.z === 0) { axis = 'x'; bit = 0; value = n.x; }
    else if (n.x === 0 && n.z === 0) { axis = 'y'; bit = 2; value = n.y; }
    else if (n.x === 0 && n.y === 0) { axis = 'z'; bit = 4; value = n.z; }
    else continue;
    if (!Number.isFinite(value) || Math.abs(value) < 0.1) continue;
    const boundary = distance / value;
    if (value > 0 && boundary <= brush.max[axis] + 0.5) axes |= 1 << bit;
    if (value < 0 && boundary >= brush.min[axis] - 0.5) axes |= 2 << bit;
    if (axes === 63) return true;
  }
  return false;
}

// The native triangle convex includes axis support planes, but may merge one
// with a nearly parallel face normal (dot > 1 - 1e-9). This span bound keeps
// that angular deviation, including the hull, well inside the one-unit pad.
function boundedTriangle(box, sweep) {
  return box.max.x - box.min.x + box.max.y - box.min.y + box.max.z - box.min.z + sweep.hullSpan <= 8192;
}

export function cameraWorld(session) {
  const world = session?.movement?.world, map = session?.map;
  if (!world || !map) return null;
  const cached = cameraWorlds.get(world);
  if (cached?.map === map && cached.brushes === map.brushes && cached.triangles === map.displacementTriangles &&
      cached.tree === world.tree && cached.feature === world.vphysicsFeatureFix && cached.corner === world.bspCornerFix) return cached.value;
  const value = buildCameraWorld(session);
  cameraWorlds.set(world, {map, brushes: map.brushes, triangles: map.displacementTriangles, tree: world.tree,
    feature: world.vphysicsFeatureFix, corner: world.bspCornerFix, value});
  return value;
}

// What the camera planners trace with. trace(from, to) is the probe's clear
// fraction of the way, 0 from inside a solid, as physics has it.
// trace.view(eye, to) is the fraction of the way from the eye to the first
// surface it would be shown. The game draws map faces from their front only,
// so an eye inside a brush looks straight out of it and terrain is not there
// from below: neither is in the way. view.inside tells whether the last eye
// was within a brush.
export function cameraTrace(world) {
  if (!world) return null;
  const trace = (from, to) => {
    const hit = world.trace(from, to, PROBE);
    // Escaping an initial overlap can still hit a different brush later.
    // Native fractions already preserve that hit and allow a clear escape.
    return hit.allSolid ? 0 : Math.max(0, Math.min(1, hit.fraction));
  };
  const start = {x: 0, y: 0, z: 0}, near = {x: 0, y: 0, z: 0};
  const view = (eye, to) => {
    let done = 0;
    start.x = eye.x; start.y = eye.y; start.z = eye.z;
    view.inside = false;
    for (let pass = 0; pass < LAYERS; pass++) {
      const hit = world.trace(start, to, RAY);
      if (!pass) view.inside = !!hit.startSolid;
      // Both ends within one brush: none of it is drawn between them.
      if (hit.allSolid || hit.fraction >= 1) return 1;
      const dx = to.x - start.x, dy = to.y - start.y, dz = to.z - start.z, length = Math.hypot(dx, dy, dz) || 1;
      const fraction = Math.max(0, hit.fraction), reached = fraction * length;
      let through = false;
      // A terrain triangle met from behind is not drawn.
      const corners = hit.brush?.faces?.length === 1 && hit.brush.vertices?.length === 3 ? hit.brush.vertices : null;
      if (corners) {
        const [a, b, c] = corners, ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
        through = dx * (uy * vz - uz * vy) + dy * (uz * vx - ux * vz) + dz * (ux * vy - uy * vx) > 0;
      }
      // Nor is the face between two solids that touch: walls are built of
      // many brushes, and from inside one the next is the same mass.
      if (!through) {
        if (reached <= SKIN) through = !!hit.startSolid;
        // Native traces report an initial overlap with any brush and the
        // earliest subsequent entry. With no initial overlap, a point two
        // units before that entry cannot already be inside another brush.
        // Arbitrary trace implementations retain the explicit point probe.
        else if (!world.cameraFirstEntry || hit.startSolid !== false) {
          const k = (reached - SKIN) / length;
          near.x = start.x + dx * k; near.y = start.y + dy * k; near.z = start.z + dz * k;
          through = !!world.trace(near, near, RAY).startSolid;
        }
      }
      if (!through) return done + (1 - done) * fraction;
      const step = Math.min(1, fraction + SKIN / length);
      start.x += dx * step; start.y += dy * step; start.z += dz * step;
      done += (1 - done) * step;
      if (done >= 1) return 1;
    }
    return done;
  };
  trace.view = view;
  // Whether a camera can be at a point: nothing solid within `room` units of
  // it, and no terrain overhead that it would be looking at from underneath.
  const hulls = new Map(), above = {x: 0, y: 0, z: 0};
  trace.free = (point, room) => {
    let hull = hulls.get(room);
    if (!hull) hulls.set(room, hull = {min: {x: -room, y: -room, z: -room}, max: {x: room, y: room, z: room}});
    if (world.trace(point, point, hull).startSolid) return false;
    above.x = point.x; above.y = point.y; above.z = point.z + OVERHEAD;
    const hit = world.trace(point, above, RAY), corners = hit.fraction < 1 && hit.brush?.faces?.length === 1 && hit.brush.vertices?.length === 3 ? hit.brush.vertices : null;
    if (!corners) return true;
    const [a, b, c] = corners;
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) <= 0;
  };
  if (world.cameraMayHit) trace.mayHit = world.cameraMayHit;
  return trace;
}

// The game's collision world without what the camera sees through.
function buildCameraWorld(session) {
  const world = session?.movement?.world, map = session?.map;
  if (!world || typeof world.trace !== 'function' || !Array.isArray(map?.brushes)) return null;
  const blocksCamera = brush => brush.contents == null || (brush.contents & SOLID) !== 0 && (brush.contents & SEE_THROUGH) === 0;
  const rebuild = () => {
    try {
      const filtered = new world.constructor(map.brushes.filter(blocksCamera), map.displacementTriangles ?? [], world.vphysicsFeatureFix, world.bspCornerFix);
      return typeof filtered.trace === 'function' ? filtered : world;
    } catch { return world; }
  };
  // Keep the native BVH's original indexing and order, excluding only brushes
  // the camera sees through. Rebuilding its triangle index can take seconds.
  if (world.brushes === map.brushes && world.triangles === map.displacementTriangles &&
      Array.isArray(world.triangleBounds) && world.triangleCache instanceof Map &&
      typeof world.triangleBrush === 'function' && typeof world.tree?.query === 'function') {
    const allowed = map.brushes.map(blocksCamera), tree = world.tree, trace = world.trace;
    const packedBounds = tree.cameraTriangleBounds;
    const visible = index => index >= allowed.length || allowed[index];
    let active = null, depth = 0;
    const sweeps = [];
    const query = bounds => {
      const candidates = tree.query(bounds);
      if (!active || !sweepBounds(bounds, active)) return candidates.filter(visible);
      const boundsAt = typeof packedBounds === 'function' && packedBounds.array === world.triangleBounds ? packedBounds : null;
      const result = [];
      for (const index of candidates) {
        if (!visible(index)) continue;
        const box = index < allowed.length ? world.brushes[index]
          : boundsAt ? boundsAt(index - allowed.length) : world.triangleBounds[index - allowed.length];
        if (sweepMayHit(box, active) || (index < allowed.length ? !boundedBrush(box) : !boundedTriangle(box, active))) result.push(index);
      }
      return result;
    };
    const filtered = Object.assign(Object.create(world), {
      brushes: world.brushes, triangles: world.triangles, triangleBounds: world.triangleBounds,
      // Native triangle convexes depend only on these shared vertices/bounds,
      // not on the probe hull or the camera's brush visibility filter.
      vphysicsFeatureFix: world.vphysicsFeatureFix, bspCornerFix: world.bspCornerFix, triangleCache: world.triangleCache,
      cameraFirstEntry: true,
      tree: {query},
    });
    let fallback = null;
    filtered.trace = (from, to, probe) => {
      if (fallback) return fallback.trace(from, to, probe);
      const previous = active, level = depth++;
      try {
        const sweep = sweeps[level] ??= {start: [0, 0, 0], delta: [0, 0, 0], inverse: [0, 0, 0], min: [0, 0, 0], max: [0, 0, 0], boundsMin: [0, 0, 0], boundsMax: [0, 0, 0]};
        active = prepareSweep(from, to, probe, sweep) ? sweep : null;
        return trace.call(filtered, from, to, probe);
      } catch {
        // A future implementation may depend on private instance state.
        filtered.cameraFirstEntry = false;
        fallback = rebuild();
        return fallback.trace(from, to, probe);
      } finally { active = previous; depth--; }
    };
    filtered.cameraMayHit = cameraBoundsQuery(bounds => tree.query(bounds).filter(visible));
    return filtered;
  }
  return rebuild();
}

// The caller supplies the same conservative BVH query as the camera trace.
// Only the recognized native world above exposes this certificate; an
// arbitrary world's tree may not cover all geometry its trace can hit.
export function cameraBoundsQuery(query) {
  const bounds = {min: {x: 0, y: 0, z: 0}, max: {x: 0, y: 0, z: 0}};
  return points => {
    if (!points.length) return true;
    bounds.min.x = bounds.min.y = bounds.min.z = Infinity;
    bounds.max.x = bounds.max.y = bounds.max.z = -Infinity;
    for (const point of points) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z) ||
        Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z)) > 1e7) return true;
      bounds.min.x = Math.min(bounds.min.x, point.x); bounds.max.x = Math.max(bounds.max.x, point.x);
      bounds.min.y = Math.min(bounds.min.y, point.y); bounds.max.y = Math.max(bounds.max.y, point.y);
      bounds.min.z = Math.min(bounds.min.z, point.z); bounds.max.z = Math.max(bounds.max.z, point.z);
    }
    // Include the probe and more than the native plane/BVH epsilon. Equality
    // at a brush boundary is a possible hit, never an empty certificate.
    bounds.min.x += PROBE.min.x - 1; bounds.max.x += PROBE.max.x + 1;
    bounds.min.y += PROBE.min.y - 1; bounds.max.y += PROBE.max.y + 1;
    bounds.min.z += PROBE.min.z - 1; bounds.max.z += PROBE.max.z + 1;
    try { return query(bounds).length !== 0; } catch { return true; }
  };
}
