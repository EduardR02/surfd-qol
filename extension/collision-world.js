// Packet v1: five geometry buffers, plus transferable Float64 numeric ID columns.
// Bounds use [min.x,min.y,min.z,max.x,max.y,max.z]; vertices use triangle-major XYZ.
// nodeData uses [left,right,leafStart,leafCount], with -1 child/range sentinels.
// Mixed ID columns use ordinary arrays without coercion. Map fields stay intact.
export async function packCollisionWorld(map, world, {
  isCurrent = () => true,
  yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)),
} = {}) {
  if (typeof isCurrent !== 'function' || typeof yieldTask !== 'function' || !isCurrent()) return null;
  const brushes = map?.brushes, triangles = world?.triangles, tree = world?.tree;
  if (!Array.isArray(brushes) || world?.brushes !== brushes || !Array.isArray(triangles) ||
      !(triangles === map.displacementTriangles || (!triangles.length && (map.displacementTriangles == null ||
        Array.isArray(map.displacementTriangles) && !map.displacementTriangles.length))) ||
      !Array.isArray(world.triangleBounds) || world.triangleBounds.length !== triangles.length ||
      !Array.isArray(tree?.bounds)) return null;
  const triangleCount = triangles.length, count = tree.bounds.length;
  if (count !== brushes.length + triangleCount || count > 0x3fffffff ||
      (count ? !tree.root : tree.root !== null)) return null;

  let deadline = performance.now() + 4, work = 0;
  function shouldYield() { return (++work & 255) === 0 && performance.now() >= deadline; }
  async function pause() {
    if (!isCurrent()) return false;
    await yieldTask();
    deadline = performance.now() + 4;
    return isCurrent();
  }
  function writeBounds(target, offset, box) {
    const min = box?.min, max = box?.max;
    if (!min || !max) return false;
    const ax = min.x, ay = min.y, az = min.z, bx = max.x, by = max.y, bz = max.z;
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az) ||
        !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz)) return false;
    target[offset] = ax; target[offset + 1] = ay; target[offset + 2] = az;
    target[offset + 3] = bx; target[offset + 4] = by; target[offset + 5] = bz;
    return true;
  }

  // First traversal counts and validates without allocating a frame per node.
  // A nonempty binary tree has at most 2*N-1 nodes; this also bounds cycles.
  const stack = [], depths = [], seen = new Uint8Array(count);
  let top = 0, nodeCount = 0, itemCount = 0, maxDepth = 0;
  if (count) { stack[top] = tree.root; depths[top++] = 0; }
  while (top) {
    const node = stack[--top], depth = depths[top];
    if (!node || typeof node !== 'object' || ++nodeCount > count * 2 - 1) return null;
    if (depth > maxDepth) maxDepth = depth;
    if (Array.isArray(node.items)) {
      if (!node.items.length || node.left != null || node.right != null) return null;
      for (const index of node.items) {
        if (!Number.isInteger(index) || index < 0 || index >= count || seen[index]) return null;
        seen[index] = 1;
        itemCount++;
        if (shouldYield() && !await pause()) return null;
      }
    } else {
      if (node.items !== undefined || !node.left || !node.right) return null;
      stack[top] = node.right; depths[top++] = depth + 1;
      stack[top] = node.left; depths[top++] = depth + 1;
    }
    if (shouldYield() && !await pause()) return null;
  }
  if (itemCount !== count || nodeCount > 0x1fffffff || !isCurrent()) return null;

  const vertices = new Float64Array(triangleCount * 9);
  let surfaceIds = new Float64Array(triangleCount), triangleIds = new Float64Array(triangleCount);
  async function copyIds(column, end) {
    const values = new Array(triangleCount);
    for (let i = 0; i < end; i++) {
      values[i] = column[i];
      if (shouldYield() && !await pause()) return null;
    }
    return values;
  }
  for (let i = 0; i < triangleCount; i++) {
    const triangle = triangles[i];
    if (!triangle || !Array.isArray(triangle.vertices) || triangle.vertices.length !== 3) return null;
    for (let vertex = 0; vertex < 3; vertex++) {
      const point = triangle.vertices[vertex], offset = i * 9 + vertex * 3;
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return null;
      vertices[offset] = point.x; vertices[offset + 1] = point.y; vertices[offset + 2] = point.z;
    }
    const surfaceId = triangle.surfaceId, triangleId = triangle.triangleId;
    if (typeof surfaceId !== 'number' && surfaceIds instanceof Float64Array) {
      surfaceIds = await copyIds(surfaceIds, i);
      if (!surfaceIds) return null;
    }
    if (typeof triangleId !== 'number' && triangleIds instanceof Float64Array) {
      triangleIds = await copyIds(triangleIds, i);
      if (!triangleIds) return null;
    }
    surfaceIds[i] = surfaceId;
    triangleIds[i] = triangleId;
    if (shouldYield() && !await pause()) return null;
  }
  const bounds = new Float64Array(count * 6);
  for (let i = 0; i < count; i++) {
    const original = i < brushes.length ? brushes[i] : world.triangleBounds[i - brushes.length];
    if (tree.bounds[i] !== original || !writeBounds(bounds, i * 6, original)) return null;
    if (shouldYield() && !await pause()) return null;
  }

  const nodeBounds = new Float64Array(nodeCount * 6), nodeData = new Int32Array(nodeCount * 4);
  const indices = new Uint32Array(count), links = new Int32Array(maxDepth + 1);
  let nodeIndex = 0, itemIndex = 0;
  if (count) { stack[top] = tree.root; links[top++] = -1; }
  while (top) {
    const node = stack[--top], link = links[top], id = nodeIndex++, offset = id * 4;
    if (link >= 0) nodeData[link] = id;
    if (!writeBounds(nodeBounds, id * 6, node)) return null;
    if (node.items) {
      nodeData[offset] = -1; nodeData[offset + 1] = -1;
      nodeData[offset + 2] = itemIndex; nodeData[offset + 3] = node.items.length;
      for (const index of node.items) {
        indices[itemIndex++] = index;
        if (shouldYield() && !await pause()) return null;
      }
    } else {
      nodeData[offset + 2] = -1;
      stack[top] = node.right; links[top++] = offset + 1;
      stack[top] = node.left; links[top++] = offset;
    }
    if (shouldYield() && !await pause()) return null;
  }
  if (!isCurrent()) return null;
  return {version: 1, map: {...map, displacementTriangles: null}, vertices, surfaceIds, triangleIds,
    bounds, nodeBounds, nodeData, indices, maxDepth};
}

export function unpackCollisionWorld(packet) {
  if (!packet || packet.version !== 1 || !packet.map || !Array.isArray(packet.map.brushes) ||
      packet.map.displacementTriangles !== null || !(packet.vertices instanceof Float64Array) ||
      !(packet.bounds instanceof Float64Array) || !(packet.nodeBounds instanceof Float64Array) ||
      !(packet.nodeData instanceof Int32Array) || !(packet.indices instanceof Uint32Array) ||
      !(packet.surfaceIds instanceof Float64Array || Array.isArray(packet.surfaceIds)) ||
      !(packet.triangleIds instanceof Float64Array || Array.isArray(packet.triangleIds))) return null;
  const {vertices, bounds, nodeBounds, nodeData, indices, surfaceIds, triangleIds, maxDepth} = packet;
  const triangleCount = vertices.length / 9, count = bounds.length / 6, nodeCount = nodeBounds.length / 6;
  const brushCount = packet.map.brushes.length;
  if (!Number.isInteger(triangleCount) || !Number.isInteger(count) || !Number.isInteger(nodeCount) ||
      count > 0x3fffffff || count !== brushCount + triangleCount || indices.length !== count ||
      surfaceIds.length !== triangleCount || triangleIds.length !== triangleCount ||
      nodeCount > 0x1fffffff || nodeData.length !== nodeCount * 4 || !Number.isInteger(maxDepth) || maxDepth < 0 ||
      (count ? nodeCount < 1 || nodeCount > count * 2 - 1 || maxDepth >= nodeCount : nodeCount !== 0 || maxDepth !== 0)) return null;
  for (const data of [vertices, bounds, nodeBounds]) {
    for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) return null;
  }

  const stack = new Int32Array(maxDepth + 1), depths = new Int32Array(maxDepth + 1), seen = new Uint8Array(count);
  let top = count ? 1 : 0, visited = 0, itemCount = 0, actualDepth = 0;
  while (top) {
    const id = stack[--top], depth = depths[top], offset = id * 4;
    if (id !== visited++ || id >= nodeCount) return null;
    if (depth > actualDepth) actualDepth = depth;
    const left = nodeData[offset], right = nodeData[offset + 1], start = nodeData[offset + 2], length = nodeData[offset + 3];
    if (left === -1 && right === -1) {
      if (start !== itemCount || length < 1 || length > count - itemCount) return null;
      for (let i = start; i < start + length; i++) {
        const index = indices[i];
        if (index >= count || seen[index]) return null;
        seen[index] = 1;
      }
      itemCount += length;
    } else {
      if (left !== id + 1 || right <= left || right >= nodeCount || start !== -1 || length !== 0 ||
          depth >= maxDepth || top + 2 > stack.length) return null;
      stack[top] = right; depths[top++] = depth + 1;
      stack[top] = left; depths[top++] = depth + 1;
    }
  }
  if (visited !== nodeCount || itemCount !== count || actualDepth !== maxDepth) return null;

  // An Array target keeps Array.isArray/length and normal methods. Indexed
  // reads cache just the contacted objects; symbols/properties use Reflect.
  function lazyArray(length, materialize) {
    const target = new Array(length);
    function indexOf(key) {
      if (typeof key !== 'string') return -1;
      const index = Number(key);
      return Number.isInteger(index) && index >= 0 && index < length &&
        String(index) === key ? index : -1;
    }
    return new Proxy(target, {
      get(_, key, receiver) {
        const index = indexOf(key);
        if (index >= 0 && !Object.hasOwn(target, key)) target[key] = materialize(index);
        return Reflect.get(target, key, receiver);
      },
      has: (_, key) => indexOf(key) >= 0 || Reflect.has(target, key),
    });
  }
  function readBounds(index) {
    const offset = index * 6;
    return {min: {x: bounds[offset], y: bounds[offset + 1], z: bounds[offset + 2]},
      max: {x: bounds[offset + 3], y: bounds[offset + 4], z: bounds[offset + 5]}};
  }
  const triangles = lazyArray(triangleCount, index => {
    const offset = index * 9;
    return {surfaceId: surfaceIds[index], triangleId: triangleIds[index], vertices: [
      {x: vertices[offset], y: vertices[offset + 1], z: vertices[offset + 2]},
      {x: vertices[offset + 3], y: vertices[offset + 4], z: vertices[offset + 5]},
      {x: vertices[offset + 6], y: vertices[offset + 7], z: vertices[offset + 8]},
    ]};
  });
  const triangleBounds = lazyArray(triangleCount, index => readBounds(brushCount + index));
  function numericOrder(a, b) { return a - b; }
  const tree = {
    query(query) {
      const result = [];
      if (!nodeCount) return result;
      const minX = query.min.x, minY = query.min.y, minZ = query.min.z;
      const maxX = query.max.x, maxY = query.max.y, maxZ = query.max.z;
      let top = 1;
      stack[0] = 0;
      while (top) {
        const id = stack[--top], offset = id * 6;
        if (!(nodeBounds[offset] <= maxX && nodeBounds[offset + 3] >= minX &&
            nodeBounds[offset + 1] <= maxY && nodeBounds[offset + 4] >= minY &&
            nodeBounds[offset + 2] <= maxZ && nodeBounds[offset + 5] >= minZ)) continue;
        const dataOffset = id * 4, left = nodeData[dataOffset];
        if (left >= 0) {
          stack[top++] = nodeData[dataOffset + 1];
          stack[top++] = left;
        } else {
          const start = nodeData[dataOffset + 2], end = start + nodeData[dataOffset + 3];
          for (let i = start; i < end; i++) {
            const index = indices[i], boxOffset = index * 6;
            if (bounds[boxOffset] <= maxX && bounds[boxOffset + 3] >= minX &&
                bounds[boxOffset + 1] <= maxY && bounds[boxOffset + 4] >= minY &&
                bounds[boxOffset + 2] <= maxZ && bounds[boxOffset + 5] >= minZ) result.push(index);
          }
        }
      }
      return result.sort(numericOrder);
    },
  };
  return {map: {...packet.map, displacementTriangles: triangles}, tree, triangleBounds};
}
