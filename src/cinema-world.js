// Camera and physics share the native collision tree, but not brush visibility.
const SOLID = 0x1, SEE_THROUGH = 0x10000000 | 0x8;
export const PROBE = {min: {x: -6, y: -6, z: -6}, max: {x: 6, y: 6, z: 6}};
const cameraWorlds = new WeakMap();

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
    const visible = index => index >= allowed.length || allowed[index];
    const filtered = Object.assign(Object.create(world), {
      brushes: world.brushes, triangles: world.triangles, triangleBounds: world.triangleBounds,
      vphysicsFeatureFix: world.vphysicsFeatureFix, bspCornerFix: world.bspCornerFix, triangleCache: new Map(),
      tree: {query: bounds => tree.query(bounds).filter(visible)},
    });
    let fallback = null;
    filtered.trace = (from, to, probe) => {
      if (fallback) return fallback.trace(from, to, probe);
      try { return trace.call(filtered, from, to, probe); } catch {
        // A future implementation may depend on private instance state.
        fallback = rebuild();
        return fallback.trace(from, to, probe);
      }
    };
    filtered.cameraMayHit = cameraBoundsQuery(filtered.tree.query);
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
