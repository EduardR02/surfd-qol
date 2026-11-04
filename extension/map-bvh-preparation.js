import {buildCollisionTree} from './collision-tree.js';

// The guarded native loader supplies ordinary parsed JSON. Other callers retain
// accessor/prototype checks; owned numeric buffers never alias live geometry.
export function packMapBounds(map, trustedJson = false) {
  try {
    const getter = Object.prototype.__lookupGetter__;
    const own = Object.hasOwn;
    const ordinaryObject = value => value !== null && typeof value === 'object' &&
      Object.getPrototypeOf(value) === Object.prototype;
    const data = (value, key) => own(value, key) && !getter.call(value, key);
    function ordinaryArray(value) {
      return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype &&
        !own(value, 'map') && !own(value, 'constructor') && !own(value, Symbol.iterator);
    }
    function point(value) {
      return ordinaryObject(value) && data(value, 'x') && data(value, 'y') && data(value, 'z');
    }
    if (!ordinaryObject(map)) return null;
    const brushProperty = Object.getOwnPropertyDescriptor(map, 'brushes');
    const triangleProperty = Object.getOwnPropertyDescriptor(map, 'displacementTriangles');
    if (!brushProperty || !('value' in brushProperty) ||
        triangleProperty && !('value' in triangleProperty) ||
        !triangleProperty && 'displacementTriangles' in map) return null;
    const brushes = brushProperty.value, triangles = triangleProperty?.value;
    if (!ordinaryArray(brushes) || triangles !== undefined && !ordinaryArray(triangles)) return null;
    const triangleCount = triangles === undefined ? 0 : triangles.length;
    const itemCount = brushes.length + triangleCount;
    if (itemCount > 0x3fffffff || itemCount * 6 > 0xffffffff) return null;
    const packedBounds = new Float64Array(itemCount * 6);
    const triangleBounds = new Array(triangleCount);
    for (let index = 0; index < brushes.length; index++) {
      if (!trustedJson && !data(brushes, index)) return null;
      const brush = brushes[index];
      if (!trustedJson && (!ordinaryObject(brush) || !data(brush, 'min') || !data(brush, 'max'))) return null;
      const min = brush.min, max = brush.max;
      if (!trustedJson && (!point(min) || !point(max))) return null;
      const minX = min.x, minY = min.y, minZ = min.z;
      const maxX = max.x, maxY = max.y, maxZ = max.z;
      if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ) ||
          !Number.isFinite(maxX) || !Number.isFinite(maxY) || !Number.isFinite(maxZ)) return null;
      const offset = index * 6;
      packedBounds[offset] = minX; packedBounds[offset + 1] = minY; packedBounds[offset + 2] = minZ;
      packedBounds[offset + 3] = maxX; packedBounds[offset + 4] = maxY; packedBounds[offset + 5] = maxZ;
    }
    for (let index = 0; index < triangleCount; index++) {
      if (!trustedJson && !data(triangles, index)) return null;
      const triangle = triangles[index];
      if (!trustedJson && (!ordinaryObject(triangle) || !data(triangle, 'vertices'))) return null;
      const vertices = triangle.vertices;
      if (!Array.isArray(vertices) || vertices.length !== 3 ||
          !trustedJson && (!ordinaryArray(vertices) || !data(vertices, 0) || !data(vertices, 1) || !data(vertices, 2))) return null;
      const a = vertices[0], b = vertices[1], c = vertices[2];
      if (!trustedJson && (!point(a) || !point(b) || !point(c))) return null;
      const ax = a.x, ay = a.y, az = a.z, bx = b.x, by = b.y, bz = b.z, cx = c.x, cy = c.y, cz = c.z;
      if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az) ||
          !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz) ||
          !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) return null;
      const minX = Math.min(ax, bx, cx), minY = Math.min(ay, by, cy), minZ = Math.min(az, bz, cz);
      const maxX = Math.max(ax, bx, cx), maxY = Math.max(ay, by, cy), maxZ = Math.max(az, bz, cz);
      triangleBounds[index] = {min: {x: minX, y: minY, z: minZ}, max: {x: maxX, y: maxY, z: maxZ}};
      const offset = (brushes.length + index) * 6;
      packedBounds[offset] = minX; packedBounds[offset + 1] = minY; packedBounds[offset + 2] = minZ;
      packedBounds[offset + 3] = maxX; packedBounds[offset + 4] = maxY; packedBounds[offset + 5] = maxZ;
    }
    return {brushes, triangles, triangleBounds, packedBounds, itemCount};
  } catch {
    // Exotic objects or allocation failures leave the native path untouched.
    return null;
  }
}

// Worker-only: numeric input and output use the native builder's exact splits
// and leaf order, without constructing intermediate geometry or a native tree.
export function buildMapBoundsTree(packedBounds) {
  if (!(packedBounds instanceof Float64Array) || !(packedBounds.buffer instanceof ArrayBuffer)) return undefined;
  try { new Uint8Array(packedBounds.buffer, 0, 0); } catch { return undefined; }
  const tree = buildCollisionTree(packedBounds, 12, true);
  if (tree !== undefined) tree.sourceBounds = packedBounds;
  return tree;
}

// Decodes only the compact worker result. Preorder, balanced native splits,
// bounds, unique item IDs and the twelve-item leaves are checked against the
// transferred source bounds. Undefined means unusable; null is the valid
// empty tree.
export function unpackMapBoundsTree(packet, itemCount) {
  let nodeBounds, nodeData, indices, sourceBounds, nodeCount;
  try {
    if (!packet || !Number.isSafeInteger(itemCount) || itemCount < 0 || itemCount > 0x3fffffff ||
        packet.itemCount !== itemCount || !(packet.nodeBounds instanceof Float64Array) ||
        !(packet.nodeData instanceof Int32Array) || !(packet.indices instanceof Uint32Array) ||
        !(packet.sourceBounds instanceof Float64Array)) return undefined;
    ({nodeBounds, nodeData, indices, sourceBounds} = packet);
    for (const view of [nodeBounds, nodeData, indices, sourceBounds]) {
      if (!(view.buffer instanceof ArrayBuffer)) return undefined;
      new Uint8Array(view.buffer, 0, 0);
    }
    nodeCount = nodeBounds.length / 6;
    if (!Number.isInteger(nodeCount) || nodeCount > 0x7fffffff || nodeData.length !== nodeCount * 4 ||
        indices.length !== itemCount || sourceBounds.length !== itemCount * 6 ||
        (itemCount ? nodeCount < 1 || nodeCount > itemCount * 2 - 1 : nodeCount !== 0)) {
      return undefined;
    }
  } catch { return undefined; }
  if (!itemCount) return null;
  const seen = new Uint8Array(itemCount);
  let nextNode = 0, nextItem = 0;
  function decode(size) {
    const id = nextNode++;
    if (id >= nodeCount) return undefined;
    const offset = id * 6, dataOffset = id * 4;
    const minX = nodeBounds[offset], minY = nodeBounds[offset + 1], minZ = nodeBounds[offset + 2];
    const maxX = nodeBounds[offset + 3], maxY = nodeBounds[offset + 4], maxZ = nodeBounds[offset + 5];
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ) ||
        !Number.isFinite(maxX) || !Number.isFinite(maxY) || !Number.isFinite(maxZ)) return undefined;
    const min = {x: minX, y: minY, z: minZ}, max = {x: maxX, y: maxY, z: maxZ};
    const left = nodeData[dataOffset], right = nodeData[dataOffset + 1];
    const start = nodeData[dataOffset + 2], length = nodeData[dataOffset + 3];
    if (size <= 12) {
      if (left !== -1 || right !== -1 || start !== nextItem || length !== size || length > itemCount - nextItem) {
        return undefined;
      }
      const items = new Array(length);
      let leafMinX = Infinity, leafMinY = Infinity, leafMinZ = Infinity;
      let leafMaxX = -Infinity, leafMaxY = -Infinity, leafMaxZ = -Infinity;
      for (let i = 0; i < length; i++) {
        const index = indices[nextItem++];
        if (index >= itemCount || seen[index]) return undefined;
        seen[index] = 1;
        items[i] = index;
        const bound = index * 6;
        const x = sourceBounds[bound], y = sourceBounds[bound + 1], z = sourceBounds[bound + 2];
        const X = sourceBounds[bound + 3], Y = sourceBounds[bound + 4], Z = sourceBounds[bound + 5];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) ||
            !Number.isFinite(X) || !Number.isFinite(Y) || !Number.isFinite(Z)) return undefined;
        leafMinX = Math.min(leafMinX, x); leafMinY = Math.min(leafMinY, y); leafMinZ = Math.min(leafMinZ, z);
        leafMaxX = Math.max(leafMaxX, X); leafMaxY = Math.max(leafMaxY, Y); leafMaxZ = Math.max(leafMaxZ, Z);
      }
      if (!Object.is(minX, leafMinX) || !Object.is(minY, leafMinY) || !Object.is(minZ, leafMinZ) ||
          !Object.is(maxX, leafMaxX) || !Object.is(maxY, leafMaxY) || !Object.is(maxZ, leafMaxZ)) return undefined;
      return {min, max, items};
    }
    if (left !== nextNode || right <= left || right >= nodeCount || start !== -1 || length !== 0) return undefined;
    const leftNode = decode(size >> 1);
    if (!leftNode || right !== nextNode) return undefined;
    const rightNode = decode(size - (size >> 1));
    if (!rightNode || !Object.is(minX, Math.min(leftNode.min.x, rightNode.min.x)) ||
        !Object.is(minY, Math.min(leftNode.min.y, rightNode.min.y)) ||
        !Object.is(minZ, Math.min(leftNode.min.z, rightNode.min.z)) ||
        !Object.is(maxX, Math.max(leftNode.max.x, rightNode.max.x)) ||
        !Object.is(maxY, Math.max(leftNode.max.y, rightNode.max.y)) ||
        !Object.is(maxZ, Math.max(leftNode.max.z, rightNode.max.z))) return undefined;
    return {min, max, left: leftNode, right: rightNode};
  }
  const root = decode(itemCount);
  return root && nextNode === nodeCount && nextItem === itemCount ? root : undefined;
}

// The parent installs this only in a verified native constructor. Records are
// keyed by the original brushes; never share a result with different triangles.
export function adoptPreparedMapWorld(world, brushes, triangles, feature, corner, Tree, preparedMaps) {
  if (!world || !Array.isArray(brushes) || !preparedMaps || typeof preparedMaps.get !== 'function') return false;
  const record = preparedMaps.get(brushes);
  if (!record || record.consumed || record.brushes !== brushes ||
      record.triangles !== triangles &&
        !(record.triangles === undefined && Array.isArray(triangles) && triangles.length === 0 &&
          Object.getPrototypeOf(triangles) === Array.prototype &&
          !Object.hasOwn(triangles, 'map') && !Object.hasOwn(triangles, 'constructor') &&
          !Object.hasOwn(triangles, Symbol.iterator)) ||
      !Array.isArray(record.triangleBounds) ||
      record.triangleBounds.length !== (triangles === undefined ? 0 : triangles?.length) ||
      record.itemCount !== brushes.length + record.triangleBounds.length) return false;
  record.consumed = true;
  if (typeof record.consume === 'function') {
    try { record.consume(); } catch { /* Preparation must not disrupt the native world. */ }
  }
  const bounds = [...brushes, ...record.triangleBounds];
  let tree;
  if (record.root === null && !record.itemCount || record.root && typeof record.root === 'object' && record.itemCount) {
    tree = Object.create(Tree.prototype);
    tree.bounds = bounds;
    tree.root = record.root;
  } else {
    tree = new Tree(bounds);
  }
  world.brushes = brushes;
  world.triangles = triangles === undefined ? [] : triangles;
  world.vphysicsFeatureFix = feature === undefined ? false : feature;
  world.bspCornerFix = corner === undefined ? false : corner;
  world.triangleBounds = record.triangleBounds;
  world.tree = tree;
  if (!(world.triangleCache instanceof Map) || world.triangleCache.size) world.triangleCache = new Map();
  return true;
}
