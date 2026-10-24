// Map-local connected collision surfaces, not mapper-authored logical ramps.
// Immutable maps are indexed once per ground threshold; contacts do no geometry work.
const cache = new WeakMap();
const GEOMETRY_TOLERANCE = 0.05;
const NORMAL_TOLERANCE = 1e-4;
const MIN_OVERLAP = 1e-6;
const finiteVector = value => value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);

function faceNormal(points) {
  // Vertex order is not guaranteed by imported BSP data. A triangle fan can
  // cancel itself for a shuffled polygon, even when the face is nondegenerate.
  const origin = points[0];
  let farthest = origin;
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    const point = points[i];
    const squared = (point.x - origin.x) ** 2 + (point.y - origin.y) ** 2 + (point.z - origin.z) ** 2;
    if (squared > distance) {
      farthest = point;
      distance = squared;
    }
  }
  const ax = farthest.x - origin.x;
  const ay = farthest.y - origin.y;
  const az = farthest.z - origin.z;
  let x = 0;
  let y = 0;
  let z = 0;
  let area = 0;
  for (let i = 1; i < points.length; i++) {
    const bx = points[i].x - origin.x;
    const by = points[i].y - origin.y;
    const bz = points[i].z - origin.z;
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const squared = nx * nx + ny * ny + nz * nz;
    if (squared > area) {
      x = nx;
      y = ny;
      z = nz;
      area = squared;
    }
  }
  const length = Math.sqrt(area);
  return length > MIN_OVERLAP ? { x: x / length, y: y / length, z: z / length } : null;
}

function matchingPlane(points, normal, planes) {
  let best = null;
  let error = Infinity;
  for (const plane of planes) {
    const n = plane.normal;
    if (1 - Math.abs(n.x * normal.x + n.y * normal.y + n.z * normal.z) > 1e-6) continue;
    let residual = 0;
    for (const point of points) {
      residual = Math.max(residual, Math.abs(n.x * point.x + n.y * point.y + n.z * point.z - plane.distance));
      if (residual > GEOMETRY_TOLERANCE) break;
    }
    if (residual <= GEOMETRY_TOLERANCE && residual < error) {
      best = plane;
      error = residual;
    }
  }
  return best;
}

function convexBoundary(points, normal) {
  // Imported convex BSP faces can repeat vertices, contain collinear points,
  // or have noisy angular ordering. Recover their boundary, not interior chords.
  const axis = Math.abs(normal.x) >= Math.abs(normal.y) && Math.abs(normal.x) >= Math.abs(normal.z) ? 'x' :
    Math.abs(normal.y) >= Math.abs(normal.z) ? 'y' : 'z';
  const projected = points.map(point => ({ point,
    u: axis === 'x' ? point.y : point.x,
    v: axis === 'z' ? point.y : point.z,
  })).sort((a, b) => a.u - b.u || a.v - b.v);
  const unique = projected.filter((point, i) => !i || point.u !== projected[i - 1].u || point.v !== projected[i - 1].v);
  if (unique.length < 3) return [];
  const turn = (a, b, c) => (b.u - a.u) * (c.v - a.v) - (b.v - a.v) * (c.u - a.u);
  const hull = [];
  for (const point of unique) {
    while (hull.length >= 2 && turn(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) hull.pop();
    hull.push(point);
  }
  const lowerLength = hull.length;
  for (let i = unique.length - 2; i >= 0; i--) {
    const point = unique[i];
    while (hull.length > lowerLength && turn(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) hull.pop();
    hull.push(point);
  }
  hull.pop();
  return hull.map(value => value.point);
}

function makeEdge(a, b) {
  const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  if (length <= MIN_OVERLAP) return null;
  return { a, b, length,
    x: (b.x - a.x) / length, y: (b.y - a.y) / length, z: (b.z - a.z) / length,
    minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
    minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z),
  };
}

function boundsTree(items) {
  if (!items.length) return null;
  const node = { minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const item of items) {
    node.minX = Math.min(node.minX, item.minX);
    node.minY = Math.min(node.minY, item.minY);
    node.minZ = Math.min(node.minZ, item.minZ);
    node.maxX = Math.max(node.maxX, item.maxX);
    node.maxY = Math.max(node.maxY, item.maxY);
    node.maxZ = Math.max(node.maxZ, item.maxZ);
  }
  if (items.length <= 8) {
    node.items = items;
    return node;
  }
  const x = node.maxX - node.minX;
  const y = node.maxY - node.minY;
  const z = node.maxZ - node.minZ;
  const axis = x >= y && x >= z ? 'X' : y >= z ? 'Y' : 'Z';
  const min = `min${axis}`;
  const max = `max${axis}`;
  items.sort((a, b) => (a[min] + a[max]) - (b[min] + b[max]) || a.id - b.id);
  const middle = items.length >> 1;
  node.left = boundsTree(items.slice(0, middle));
  node.right = boundsTree(items.slice(middle));
  return node;
}

function nearby(a, b) {
  return a.minX <= b.maxX + GEOMETRY_TOLERANCE && a.maxX + GEOMETRY_TOLERANCE >= b.minX &&
    a.minY <= b.maxY + GEOMETRY_TOLERANCE && a.maxY + GEOMETRY_TOLERANCE >= b.minY &&
    a.minZ <= b.maxZ + GEOMETRY_TOLERANCE && a.maxZ + GEOMETRY_TOLERANCE >= b.minZ;
}

function sharedEdge(a, b) {
  const direction = a.x * b.x + a.y * b.y + a.z * b.z;
  // Crossing segments are not a seam, even if their bounding boxes intersect.
  if (1 - Math.abs(direction) > 5e-7) return false;
  const dx = b.a.x - a.a.x;
  const dy = b.a.y - a.a.y;
  const dz = b.a.z - a.a.z;
  const start = dx * a.x + dy * a.y + dz * a.z;
  const end = start + b.length * direction;
  const low = Math.max(0, Math.min(start, end));
  const high = Math.min(a.length, Math.max(start, end));
  // No tolerance expansion along the edge: a point or a gap is not overlap.
  if (high - low <= MIN_OVERLAP) return false;
  for (const position of [low, high]) {
    const t = (position - start) / direction;
    if (Math.hypot(dx + b.x * t - a.x * position,
      dy + b.y * t - a.y * position, dz + b.z * t - a.z * position) > GEOMETRY_TOLERANCE) return false;
  }
  return true;
}

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

function makeFace(points, plane, id) {
  // Imported render vertices include redundant bevel intersections and can
  // drift slightly off their collision plane. Work on that exact plane.
  const projected = points.map(point => {
    const error = dot(plane.normal, point) - plane.distance;
    return { x: point.x - plane.normal.x * error, y: point.y - plane.normal.y * error,
      z: point.z - plane.normal.z * error };
  });
  const boundary = convexBoundary(projected, plane.normal);
  if (boundary.length < 3) return null;
  const face = { id, normal: plane.normal, distance: plane.distance, boundary,
    edges: [], inward: [], minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  const center = { x: 0, y: 0, z: 0 };
  for (const point of boundary) {
    center.x += point.x / boundary.length;
    center.y += point.y / boundary.length;
    center.z += point.z / boundary.length;
    face.minX = Math.min(face.minX, point.x);
    face.minY = Math.min(face.minY, point.y);
    face.minZ = Math.min(face.minZ, point.z);
    face.maxX = Math.max(face.maxX, point.x);
    face.maxY = Math.max(face.maxY, point.y);
    face.maxZ = Math.max(face.maxZ, point.z);
  }
  for (let i = 0; i < boundary.length; i++) {
    const edge = makeEdge(boundary[i], boundary[(i + 1) % boundary.length]);
    if (!edge) continue;
    face.edges.push(edge);
    const axis = cross(face.normal, edge);
    const sign = dot(axis, center) >= dot(axis, edge.a) ? 1 : -1;
    axis.x *= sign;
    axis.y *= sign;
    axis.z *= sign;
    axis.distance = dot(axis, edge.a);
    face.inward.push(axis);
  }
  return face;
}

function positiveAreaOverlap(a, b) {
  // Separating axes in the common plane. Bounds alone cannot establish an
  // overlap; requiring positive width on every axis excludes isolated points.
  for (const face of [a, b]) {
    for (const axis of face.inward) {
      let aMin = Infinity;
      let aMax = -Infinity;
      let bMin = Infinity;
      let bMax = -Infinity;
      for (const point of a.boundary) {
        const value = dot(axis, point);
        aMin = Math.min(aMin, value);
        aMax = Math.max(aMax, value);
      }
      for (const point of b.boundary) {
        const value = dot(axis, point);
        bMin = Math.min(bMin, value);
        bMax = Math.max(bMax, value);
      }
      if (Math.min(aMax, bMax) - Math.max(aMin, bMin) <= MIN_OVERLAP) return false;
    }
  }
  return true;
}

function clipIntersection(face, point, direction, interval) {
  for (const axis of face.inward) {
    const distance = dot(axis, point) - axis.distance;
    const rate = dot(axis, direction);
    if (Math.abs(rate) < 1e-10) {
      // Only transverse error is tolerated. Never extend interval endpoints:
      // touching at one point must not become a positive shared segment.
      if (distance < -GEOMETRY_TOLERANCE) return false;
      continue;
    }
    const end = -distance / rate;
    if (rate > 0) interval.low = Math.max(interval.low, end);
    else interval.high = Math.min(interval.high, end);
    if (interval.high - interval.low <= MIN_OVERLAP) return false;
  }
  return true;
}

function intersectingFaces(a, b) {
  const direction = cross(a.normal, b.normal);
  const squared = dot(direction, direction);
  if (squared <= 1e-12) {
    for (const point of a.boundary) {
      if (Math.abs(dot(b.normal, point) - b.distance) > GEOMETRY_TOLERANCE) return false;
    }
    for (const point of b.boundary) {
      if (Math.abs(dot(a.normal, point) - a.distance) > GEOMETRY_TOLERANCE) return false;
    }
    return positiveAreaOverlap(a, b);
  }
  // Adjacent rotated BSP brushes overlap at their ends. The real seam is
  // inside both faces, not necessarily on either imported polygon boundary.
  const first = cross(b.normal, direction);
  const second = cross(direction, a.normal);
  const point = { x: (a.distance * first.x + b.distance * second.x) / squared,
    y: (a.distance * first.y + b.distance * second.y) / squared,
    z: (a.distance * first.z + b.distance * second.z) / squared };
  const length = Math.sqrt(squared);
  direction.x /= length;
  direction.y /= length;
  direction.z /= length;
  const interval = { low: -Infinity, high: Infinity };
  return clipIntersection(a, point, direction, interval) &&
    clipIntersection(b, point, direction, interval) && interval.high - interval.low > MIN_OVERLAP;
}

function connectedFaces(a, b) {
  if (intersectingFaces(a, b)) return true;
  for (const edge of a.edges) {
    for (const other of b.edges) {
      if (nearby(edge, other) && sharedEdge(edge, other)) return true;
    }
  }
  return false;
}

function buildIndex(map, groundNormal) {
  const faces = [];
  const byBrush = new Map();
  for (const brush of map.brushes) {
    if (!brush || (typeof brush.id !== 'string' && typeof brush.id !== 'number') ||
      !Array.isArray(brush.vertices) || !Array.isArray(brush.faces) || !Array.isArray(brush.planes)) continue;
    const planes = [];
    for (const plane of brush.planes) {
      if (!finiteVector(plane?.normal) || !Number.isFinite(plane.distance)) continue;
      const length = Math.hypot(plane.normal.x, plane.normal.y, plane.normal.z);
      if (!length) continue;
      const normal = { x: plane.normal.x / length, y: plane.normal.y / length, z: plane.normal.z / length };
      if (normal.z > 0 && normal.z < groundNormal) planes.push({ normal, distance: plane.distance / length });
    }
    if (!planes.length) continue;
    for (const indices of brush.faces) {
      if (!Array.isArray(indices) || indices.length < 3) continue;
      const points = indices.map(index => Number.isInteger(index) ? brush.vertices[index] : null);
      if (!points.every(finiteVector)) continue;
      const normal = faceNormal(points);
      const plane = normal && matchingPlane(points, normal, planes);
      if (!plane) continue;
      const face = makeFace(points, plane, faces.length);
      if (!face) continue;
      faces.push(face);
      face.brushId = brush.id;
    }
  }
  const parents = Int32Array.from(faces, (_, i) => i);
  function root(id) {
    while (parents[id] !== id) {
      parents[id] = parents[parents[id]];
      id = parents[id];
    }
    return id;
  }
  const tree = boundsTree(faces.slice());
  function connect(face, node) {
    if (!node || !nearby(face, node)) return;
    if (!node.items) {
      connect(face, node.left);
      connect(face, node.right);
      return;
    }
    for (const other of node.items) {
      if (other.id <= face.id || !nearby(face, other)) continue;
      const a = root(face.id);
      const b = root(other.id);
      if (a === b || !connectedFaces(face, other)) continue;
      parents[Math.max(a, b)] = Math.min(a, b);
    }
  }
  for (const face of faces) connect(face, tree);
  // Retain only contact lookup data, not the temporary hulls and spatial tree.
  for (const face of faces) {
    let brushFaces = byBrush.get(face.brushId);
    if (!brushFaces) byBrush.set(face.brushId, brushFaces = []);
    brushFaces.push({ normal: face.normal, component: root(face.id) });
  }
  return Object.freeze({
    find(brushId, normal) {
      const candidates = byBrush.get(brushId);
      if (!candidates || !finiteVector(normal)) return null;
      const length = Math.hypot(normal.x, normal.y, normal.z);
      if (!length) return null;
      const x = normal.x / length;
      const y = normal.y / length;
      const z = normal.z / length;
      if (!(z > 0 && z < groundNormal)) return null;
      let component = null;
      for (const face of candidates) {
        const n = face.normal;
        if (Math.abs(n.x - x) > NORMAL_TOLERANCE || Math.abs(n.y - y) > NORMAL_TOLERANCE ||
          Math.abs(n.z - z) > NORMAL_TOLERANCE) continue;
        // A normal alone cannot disambiguate disconnected faces of one brush ID.
        if (component !== null && component !== face.component) return null;
        component = face.component;
      }
      return component;
    },
  });
}

export function getRampSurfaces(map, groundNormal) {
  if (!map || typeof map !== 'object' || !Array.isArray(map.brushes) || !map.brushes.length ||
    !Number.isFinite(groundNormal) || groundNormal <= 0 || groundNormal > 1) return null;
  let thresholds = cache.get(map);
  if (!thresholds) cache.set(map, thresholds = new Map());
  let index = thresholds.get(groundNormal);
  if (!index) {
    index = buildIndex(map, groundNormal);
    thresholds.set(groundNormal, index);
  }
  return index;
}
