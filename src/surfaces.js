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

function convexBoundary(points, plane) {
  // Project once onto the collision plane, and keep the sortable coordinates
  // on those same points instead of copying them into a second wrapper array.
  const normal = plane.normal;
  const axis = Math.abs(normal.x) >= Math.abs(normal.y) && Math.abs(normal.x) >= Math.abs(normal.z) ? 'x' :
    Math.abs(normal.y) >= Math.abs(normal.z) ? 'y' : 'z';
  const projected = points.map(point => {
    const error = dot(normal, point) - plane.distance;
    const x = point.x - normal.x * error;
    const y = point.y - normal.y * error;
    const z = point.z - normal.z * error;
    return { x, y, z, u: axis === 'x' ? y : x, v: axis === 'z' ? y : z };
  }).sort((a, b) => a.u - b.u || a.v - b.v);
  // Imported faces can repeat vertices, contain collinear points, or have
  // noisy ordering. Compact exact duplicates before recovering the boundary.
  let count = 0;
  for (const point of projected) {
    if (!count || point.u !== projected[count - 1].u || point.v !== projected[count - 1].v) {
      projected[count++] = point;
    }
  }
  if (count < 3) return [];
  projected.length = count;
  const turn = (a, b, c) => (b.u - a.u) * (c.v - a.v) - (b.v - a.v) * (c.u - a.u);
  const hull = [];
  for (const point of projected) {
    while (hull.length >= 2 && turn(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) hull.pop();
    hull.push(point);
  }
  const lowerLength = hull.length;
  for (let i = projected.length - 2; i >= 0; i--) {
    const point = projected[i];
    while (hull.length > lowerLength && turn(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) hull.pop();
    hull.push(point);
  }
  hull.pop();
  return hull;
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
  const values = new Float64Array(items.length * 9);
  const indices = new Uint32Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const offset = i * 9;
    values[offset] = item.minX;
    values[offset + 1] = item.minY;
    values[offset + 2] = item.minZ;
    values[offset + 3] = item.maxX;
    values[offset + 4] = item.maxY;
    values[offset + 5] = item.maxZ;
    // Keep the original doubled centres, including their floating-point rounding.
    values[offset + 6] = item.minX + item.maxX;
    values[offset + 7] = item.minY + item.maxY;
    values[offset + 8] = item.minZ + item.maxZ;
    indices[i] = i;
  }
  function compare(a, b, axis) {
    return values[a * 9 + 6 + axis] - values[b * 9 + 6 + axis] || items[a].id - items[b].id;
  }
  function select(start, end, median, axis) {
    let low = start, high = end - 1;
    // Match the collision BVH's bounded median-of-three selection. Sorting
    // only the unresolved range prevents adversarial pivots from going quadratic.
    let budget = 2 * Math.ceil(Math.log2(end - start)) + 1;
    while (low < high) {
      if (--budget < 0) {
        indices.subarray(low, high + 1).sort((a, b) => compare(a, b, axis));
        return;
      }
      let first = indices[low], middle = indices[low + ((high - low) >> 1)];
      const last = indices[high];
      if (compare(first, middle, axis) > 0) {
        const item = first;
        first = middle;
        middle = item;
      }
      if (compare(middle, last, axis) > 0) middle = last;
      if (compare(first, middle, axis) > 0) middle = first;
      const pivot = middle;
      let left = low, right = high;
      while (left <= right) {
        while (compare(indices[left], pivot, axis) < 0) left++;
        while (compare(indices[right], pivot, axis) > 0) right--;
        if (left <= right) {
          const item = indices[left];
          indices[left++] = indices[right];
          indices[right--] = item;
        }
      }
      if (median <= right) high = right;
      else if (median >= left) low = left;
      else return;
    }
  }
  function build(start, end, parentAxis) {
    const node = { count: end - start, minX: Infinity, minY: Infinity, minZ: Infinity,
      maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
    for (let i = start; i < end; i++) {
      const offset = indices[i] * 9;
      node.minX = Math.min(node.minX, values[offset]);
      node.minY = Math.min(node.minY, values[offset + 1]);
      node.minZ = Math.min(node.minZ, values[offset + 2]);
      node.maxX = Math.max(node.maxX, values[offset + 3]);
      node.maxY = Math.max(node.maxY, values[offset + 4]);
      node.maxZ = Math.max(node.maxZ, values[offset + 5]);
    }
    if (end - start <= 8) {
      // Old leaves inherit their parent's complete sort; the root leaf keeps
      // input order. Restore that tiny ordering without copying leaf arrays.
      if (parentAxis >= 0) for (let i = start + 1; i < end; i++) {
        const item = indices[i];
        let position = i;
        while (position > start && compare(indices[position - 1], item, parentAxis) > 0) {
          indices[position] = indices[position - 1];
          position--;
        }
        indices[position] = item;
      }
      node.start = start;
      node.end = end;
      return node;
    }
    const x = node.maxX - node.minX;
    const y = node.maxY - node.minY;
    const z = node.maxZ - node.minZ;
    const axis = x >= y && x >= z ? 0 : y >= z ? 1 : 2;
    const middle = start + ((end - start) >> 1);
    select(start, end, middle, axis);
    node.left = build(start, middle, axis);
    node.right = build(middle, end, axis);
    return node;
  }
  return { root: items.length ? build(0, items.length, -1) : null, indices };
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
  // Bevel intersections can drift off their plane; the projected convex hull
  // remains authoritative even for unordered or repeated imported vertices.
  const boundary = convexBoundary(points, plane);
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

// Shared by the synchronous index and the compact worker input filter.
export function normalizedRampPlane(plane, groundNormal) {
  if (!finiteVector(plane?.normal) || !Number.isFinite(plane.distance)) return null;
  const length = Math.hypot(plane.normal.x, plane.normal.y, plane.normal.z);
  if (!length) return null;
  const normal = { x: plane.normal.x / length, y: plane.normal.y / length, z: plane.normal.z / length };
  return normal.z > 0 && normal.z < groundNormal ? { normal, distance: plane.distance / length } : null;
}

// The temporary faces retain their original order and minimum-face component
// labels, so the worker and synchronous path use precisely the same algorithm.
export function buildRampSurfaceData(map, groundNormal) {
  const faces = [];
  for (const brush of map.brushes) {
    if (!brush || (typeof brush.id !== 'string' && typeof brush.id !== 'number') ||
      !Array.isArray(brush.vertices) || !Array.isArray(brush.faces) || !Array.isArray(brush.planes)) continue;
    const planes = [];
    for (const plane of brush.planes) {
      const normalized = normalizedRampPlane(plane, groundNormal);
      if (normalized) planes.push(normalized);
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
  const { root: tree, indices } = boundsTree(faces);
  function connect(a, b) {
    if (a === b) {
      if (a.left) {
        connect(a.left, a.left);
        connect(a.left, a.right);
        connect(a.right, a.right);
        return;
      }
    } else {
      if (!nearby(a, b)) return;
      // Visit each unordered subtree pair once, rather than searching the
      // entire tree separately for every face in the same neighborhood.
      if (a.left && (!b.left || a.count >= b.count)) {
        connect(a.left, b);
        connect(a.right, b);
        return;
      }
      if (b.left) {
        connect(a, b.left);
        connect(a, b.right);
        return;
      }
    }
    for (let i = a.start; i < a.end; i++) {
      for (let j = a === b ? i + 1 : b.start; j < b.end; j++) {
        let face = faces[indices[i]];
        let other = faces[indices[j]];
        // Preserve the original predicate orientation, including rounding in
        // clipping and seam tests, independently of the tree traversal order.
        if (face.id > other.id) {
          const swap = face;
          face = other;
          other = swap;
        }
        if (!nearby(face, other)) continue;
        const first = root(face.id);
        const second = root(other.id);
        // Omitting an edge inside a component cannot alter connectivity.
        // Always retaining its minimum face ID makes the final labels
        // independent of which qualifying pair the traversal visits first.
        if (first === second || !connectedFaces(face, other)) continue;
        parents[Math.max(first, second)] = Math.min(first, second);
      }
    }
  }
  if (tree) connect(tree, tree);
  for (let i = 0; i < faces.length; i++) parents[i] = root(i);
  return { faces, components: parents };
}

function addBrushFace(byBrush, brushId, normal, component) {
  let brushFaces = byBrush.get(brushId);
  if (!brushFaces) byBrush.set(brushId, brushFaces = []);
  brushFaces.push({ normal, component });
}

function makeIndex(byBrush, groundNormal) {
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

function buildIndex(map, groundNormal) {
  const byBrush = new Map();
  const { faces, components } = buildRampSurfaceData(map, groundNormal);
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    addBrushFace(byBrush, face.brushId, face.normal, components[i]);
  }
  return makeIndex(byBrush, groundNormal);
}

function validRampMap(map, groundNormal) {
  return map && typeof map === 'object' && Array.isArray(map.brushes) && map.brushes.length &&
    Number.isFinite(groundNormal) && groundNormal > 0 && groundNormal <= 1;
}

export function hasRampSurfaces(map, groundNormal) {
  return !!(validRampMap(map, groundNormal) && cache.get(map)?.has(groundNormal));
}

// The caller validates that these worker results belong to this map and
// threshold before entering the existing map-local cache.
export function installRampSurfaceData(map, groundNormal, ordinals, components, normals) {
  if (!validRampMap(map, groundNormal) || hasRampSurfaces(map, groundNormal)) return false;
  const byBrush = new Map();
  for (let i = 0; i < ordinals.length; i++) {
    const offset = i * 3;
    addBrushFace(byBrush, map.brushes[ordinals[i]].id,
      { x: normals[offset], y: normals[offset + 1], z: normals[offset + 2] }, components[i]);
  }
  let thresholds = cache.get(map);
  if (!thresholds) cache.set(map, thresholds = new Map());
  thresholds.set(groundNormal, makeIndex(byBrush, groundNormal));
  return true;
}

export function getRampSurfaces(map, groundNormal) {
  if (!validRampMap(map, groundNormal)) return null;
  let thresholds = cache.get(map);
  if (!thresholds) cache.set(map, thresholds = new Map());
  let index = thresholds.get(groundNormal);
  if (!index) {
    index = buildIndex(map, groundNormal);
    thresholds.set(groundNormal, index);
  }
  return index;
}
