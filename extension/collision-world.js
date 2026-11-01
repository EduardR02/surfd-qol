// Packet v2 transfers collision data only. Render/import brush fields and the
// unused map importMetadata are deliberately omitted from the worker copy.
// Bounds use [min.x,min.y,min.z,max.x,max.y,max.z]; vertices use triangle-major XYZ.
// nodeData uses [left,right,leafStart,leafCount], with -1 child/range sentinels.
// brushData rows contain plane/leaf offsets, four scalar codes, and leaf state.
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
      count * 6 > 0xffffffff || triangleCount * 9 > 0xffffffff ||
      (brushes.length + 1) * 7 > 0xffffffff || (count ? !tree.root : tree.root !== null)) return null;

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
  function onlyKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    for (const key in value) if (!Object.hasOwn(value, key) || !keys.includes(key)) return false;
    return true;
  }
  const vectorKeys = ['x', 'y', 'z'];
  function isVector(value) {
    return onlyKeys(value, vectorKeys) && Number.isFinite(value.x) &&
      Number.isFinite(value.y) && Number.isFinite(value.z);
  }
  const brushKeys = ['id', 'vertices', 'faces', 'planes', 'min', 'max', 'color', 'friction', 'kind',
    'contents', 'modelIndex', 'sourceBrush', 'broadphaseOnlyVertices', 'surfaceprop', 'propIndex',
    'modelPath', 'collisionModel', 'leafBounds'];
  const planeKeys = ['normal', 'distance', 'friction'], boxKeys = ['min', 'max'];
  const triangleKeys = ['vertices', 'surfaceId', 'triangleId', 'contents', 'tags'];

  // Zero means absent; the next codes represent undefined, null, booleans and
  // negative zero. Remaining codes address shared numeric or UTF-16 pools.
  // In particular, IDs are not coerced or cloned as one string per brush.
  const scalarCodes = new Map(), numbers = [], strings = [];
  let characterCount = 0;
  function scalarCode(value) {
    if (value === undefined) return 1;
    if (value === null) return 2;
    if (value === false) return 3;
    if (value === true) return 4;
    if (typeof value === 'number' && Object.is(value, -0)) return 5;
    const type = typeof value;
    if (type !== 'number' && type !== 'string' && type !== 'bigint') return -1;
    if (scalarCodes.has(value)) return scalarCodes.get(value);
    let code;
    if (type === 'number') {
      if (numbers.length >= 0x3ffffffa) return -1;
      code = 6 + numbers.length;
      numbers.push(value);
    } else {
      const string = type === 'string' ? value : String(value);
      if (strings.length >= 0x40000000 || string.length > 0x3fffffff - characterCount) return -1;
      code = (type === 'string' ? 0x40000000 : 0x80000000) + strings.length;
      strings.push(string);
      characterCount += string.length;
    }
    scalarCodes.set(value, code);
    return code;
  }
  const brushCount = brushes.length, brushData = new Uint32Array((brushCount + 1) * 7);
  const brushScalarKeys = ['id', 'friction', 'kind', 'collisionModel'];
  let planeCount = 0, leafCount = 0;
  for (let i = 0; i < brushCount; i++) {
    const brush = brushes[i], offset = i * 7;
    if (!onlyKeys(brush, brushKeys) || !isVector(brush.min) || !isVector(brush.max) ||
        !Array.isArray(brush.planes)) return null;
    brushData[offset] = planeCount;
    brushData[offset + 1] = leafCount;
    planeCount += brush.planes.length;
    if (planeCount > 0x1fffffff) return null;
    for (let field = 0; field < brushScalarKeys.length; field++) {
      const key = brushScalarKeys[field];
      if (!Object.hasOwn(brush, key)) continue;
      const code = scalarCode(brush[key]);
      if (code < 0) return null;
      brushData[offset + 2 + field] = code;
    }
    if (Object.hasOwn(brush, 'leafBounds')) {
      if (Array.isArray(brush.leafBounds)) {
        brushData[offset + 6] = 1;
        leafCount += brush.leafBounds.length;
        if (leafCount > 0x1fffffff) return null;
      } else if (brush.leafBounds === undefined) brushData[offset + 6] = 2;
      else if (brush.leafBounds === null) brushData[offset + 6] = 3;
      else return null;
    }
    if (shouldYield() && !await pause()) return null;
  }
  brushData[brushCount * 7] = planeCount;
  brushData[brushCount * 7 + 1] = leafCount;
  const planeValues = new Float64Array(planeCount * 4), planeFriction = new Uint32Array(planeCount);
  const leafBounds = new Float64Array(leafCount * 6);
  for (let i = 0; i < brushCount; i++) {
    const brush = brushes[i], offset = i * 7, start = brushData[offset], leafStart = brushData[offset + 1];
    if (brush.planes.length !== brushData[offset + 7] - start ||
        (brushData[offset + 6] === 1 && (!Array.isArray(brush.leafBounds) ||
          brush.leafBounds.length !== brushData[offset + 8] - leafStart))) return null;
    for (let j = 0; j < brush.planes.length; j++) {
      const plane = brush.planes[j], index = start + j, at = index * 4;
      if (!onlyKeys(plane, planeKeys) || !isVector(plane.normal) || !Number.isFinite(plane.distance)) return null;
      planeValues[at] = plane.normal.x; planeValues[at + 1] = plane.normal.y;
      planeValues[at + 2] = plane.normal.z; planeValues[at + 3] = plane.distance;
      if (Object.hasOwn(plane, 'friction')) {
        const code = scalarCode(plane.friction);
        if (code < 0) return null;
        planeFriction[index] = code;
      }
      if (shouldYield() && !await pause()) return null;
    }
    if (brushData[offset + 6] === 1) for (let j = 0; j < brush.leafBounds.length; j++) {
      const leaf = brush.leafBounds[j];
      if (!onlyKeys(leaf, boxKeys) || !isVector(leaf.min) || !isVector(leaf.max) ||
          !writeBounds(leafBounds, (leafStart + j) * 6, leaf)) return null;
      if (shouldYield() && !await pause()) return null;
    }
    if (shouldYield() && !await pause()) return null;
  }
  const scalarNumbers = new Float64Array(numbers.length), scalarOffsets = new Uint32Array(strings.length + 1);
  const scalarChars = new Uint16Array(characterCount);
  for (let i = 0; i < numbers.length; i++) {
    scalarNumbers[i] = numbers[i];
    if (shouldYield() && !await pause()) return null;
  }
  let character = 0;
  for (let i = 0; i < strings.length; i++) {
    scalarOffsets[i] = character;
    const string = strings[i];
    for (let j = 0; j < string.length; j++) {
      scalarChars[character++] = string.charCodeAt(j);
      if (shouldYield() && !await pause()) return null;
    }
    if (shouldYield() && !await pause()) return null;
  }
  scalarOffsets[strings.length] = character;

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
    if (!onlyKeys(triangle, triangleKeys) || !Array.isArray(triangle.vertices) || triangle.vertices.length !== 3) return null;
    for (let vertex = 0; vertex < 3; vertex++) {
      const point = triangle.vertices[vertex], offset = i * 9 + vertex * 3;
      if (!isVector(point)) return null;
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
  const packetMap = {...map, brushes: null, displacementTriangles: null};
  delete packetMap.importMetadata;
  return {version: 2, map: packetMap, brushData, planeValues, planeFriction, leafBounds,
    scalarNumbers, scalarOffsets, scalarChars, vertices, surfaceIds, triangleIds,
    bounds, nodeBounds, nodeData, indices, maxDepth};
}

export function unpackCollisionWorld(packet) {
  if (!packet || packet.version !== 2 || !packet.map || packet.map.brushes !== null ||
      packet.map.displacementTriangles !== null || !(packet.brushData instanceof Uint32Array) ||
      !(packet.planeValues instanceof Float64Array) || !(packet.planeFriction instanceof Uint32Array) ||
      !(packet.leafBounds instanceof Float64Array) || !(packet.scalarNumbers instanceof Float64Array) ||
      !(packet.scalarOffsets instanceof Uint32Array) || !(packet.scalarChars instanceof Uint16Array) ||
      !(packet.vertices instanceof Float64Array) || !(packet.bounds instanceof Float64Array) ||
      !(packet.nodeBounds instanceof Float64Array) || !(packet.nodeData instanceof Int32Array) ||
      !(packet.indices instanceof Uint32Array) ||
      !(packet.surfaceIds instanceof Float64Array || Array.isArray(packet.surfaceIds)) ||
      !(packet.triangleIds instanceof Float64Array || Array.isArray(packet.triangleIds))) return null;
  const {brushData, planeValues, planeFriction, leafBounds, scalarNumbers, scalarOffsets, scalarChars,
    vertices, bounds, nodeBounds, nodeData, indices, surfaceIds, triangleIds, maxDepth} = packet;
  const views = [brushData, planeValues, planeFriction, leafBounds, scalarNumbers, scalarOffsets, scalarChars,
    vertices, bounds, nodeBounds, nodeData, indices];
  if (ArrayBuffer.isView(surfaceIds)) views.push(surfaceIds);
  if (ArrayBuffer.isView(triangleIds)) views.push(triangleIds);
  try {
    for (const view of views) {
      if (!(view.buffer instanceof ArrayBuffer)) return null;
      new Uint8Array(view.buffer, 0, 0);
    }
  } catch { return null; }
  const brushCount = brushData.length / 7 - 1, planeCount = planeValues.length / 4;
  const leafCount = leafBounds.length / 6, stringCount = scalarOffsets.length - 1;
  const triangleCount = vertices.length / 9, count = bounds.length / 6, nodeCount = nodeBounds.length / 6;
  if (!Number.isInteger(brushCount) || brushCount < 0 || !Number.isInteger(planeCount) ||
      !Number.isInteger(leafCount) || stringCount < 0 || planeFriction.length !== planeCount ||
      !Number.isInteger(triangleCount) || !Number.isInteger(count) || !Number.isInteger(nodeCount) ||
      count > 0x3fffffff || count !== brushCount + triangleCount || indices.length !== count ||
      surfaceIds.length !== triangleCount || triangleIds.length !== triangleCount ||
      nodeCount > 0x1fffffff || nodeData.length !== nodeCount * 4 || !Number.isInteger(maxDepth) || maxDepth < 0 ||
      (count ? nodeCount < 1 || nodeCount > count * 2 - 1 || maxDepth >= nodeCount : nodeCount !== 0 || maxDepth !== 0)) return null;
  for (const data of [planeValues, leafBounds, vertices, bounds, nodeBounds]) {
    for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) return null;
  }
  if (scalarOffsets[0] !== 0 || scalarOffsets[stringCount] !== scalarChars.length) return null;
  for (let i = 0; i < stringCount; i++) {
    if (scalarOffsets[i] > scalarOffsets[i + 1] || scalarOffsets[i + 1] > scalarChars.length) return null;
  }
  function validScalar(code) {
    if (code < 6) return true;
    if (code < 0x40000000) return code - 6 < scalarNumbers.length;
    const kind = code >>> 30, index = code & 0x3fffffff;
    if (kind === 3 || index >= stringCount) return false;
    if (kind === 1) return true;
    let at = scalarOffsets[index], end = scalarOffsets[index + 1];
    if (at === end) return false;
    if (scalarChars[at] === 45 && ++at === end) return false;
    for (; at < end; at++) if (scalarChars[at] < 48 || scalarChars[at] > 57) return false;
    return true;
  }
  for (let i = 0; i < brushCount; i++) {
    const offset = i * 7, next = offset + 7, state = brushData[offset + 6];
    if ((i === 0 && (brushData[offset] !== 0 || brushData[offset + 1] !== 0)) ||
        brushData[offset] > brushData[next] || brushData[next] > planeCount ||
        brushData[offset + 1] > brushData[next + 1] || brushData[next + 1] > leafCount ||
        state > 3 || (state !== 1 && brushData[offset + 1] !== brushData[next + 1])) return null;
    for (let j = 2; j <= 5; j++) if (!validScalar(brushData[offset + j])) return null;
  }
  const last = brushCount * 7;
  if (brushData[last] !== planeCount || brushData[last + 1] !== leafCount ||
      brushData[last + 2] || brushData[last + 3] || brushData[last + 4] ||
      brushData[last + 5] || brushData[last + 6]) return null;
  for (let i = 0; i < planeCount; i++) if (!validScalar(planeFriction[i])) return null;

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

  // Preserve normal array mutation semantics without constructing untouched
  // geometry. Reflection materializes the requested entries only when needed.
  function lazyArray(length, materialize) {
    const target = new Array(length), state = new Uint8Array(length);
    function indexOf(key) {
      if (typeof key !== 'string') return -1;
      const index = Number(key);
      return Number.isInteger(index) && index >= 0 && index < length &&
        String(index) === key ? index : -1;
    }
    function realize(index) {
      if (index >= 0 && index < target.length && state[index] === 0) {
        target[index] = materialize(index);
        state[index] = 1;
      }
    }
    function recordLength(previous) {
      for (let i = target.length; i < previous && i < length; i++) state[i] = 2;
    }
    return new Proxy(target, {
      get(_, key, receiver) {
        realize(indexOf(key));
        return Reflect.get(target, key, receiver);
      },
      has(_, key) {
        const index = indexOf(key);
        return index >= 0 && index < target.length && state[index] === 0 || Reflect.has(target, key);
      },
      set(_, key, value) {
        const previous = target.length, result = Reflect.set(target, key, value), index = indexOf(key);
        if (result && key === 'length') recordLength(previous);
        else if (result && index >= 0) state[index] = 1;
        return result;
      },
      deleteProperty(_, key) {
        const result = Reflect.deleteProperty(target, key), index = indexOf(key);
        if (result && index >= 0) state[index] = 2;
        return result;
      },
      defineProperty(_, key, descriptor) {
        const previous = target.length, result = Reflect.defineProperty(target, key, descriptor), index = indexOf(key);
        if (result && key === 'length') recordLength(previous);
        else if (result && index >= 0) state[index] = 1;
        return result;
      },
      getOwnPropertyDescriptor(_, key) {
        realize(indexOf(key));
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys() {
        for (let i = 0; i < length && i < target.length; i++) realize(i);
        return Reflect.ownKeys(target);
      },
    });
  }
  function readBounds(index) {
    const offset = index * 6;
    return {min: {x: bounds[offset], y: bounds[offset + 1], z: bounds[offset + 2]},
      max: {x: bounds[offset + 3], y: bounds[offset + 4], z: bounds[offset + 5]}};
  }
  const scalarStrings = new Array(stringCount);
  function scalarValue(code) {
    if (code === 1) return undefined;
    if (code === 2) return null;
    if (code === 3) return false;
    if (code === 4) return true;
    if (code === 5) return -0;
    if (code < 0x40000000) return scalarNumbers[code - 6];
    const index = code & 0x3fffffff;
    let string = scalarStrings[index];
    if (string === undefined) {
      string = '';
      const end = scalarOffsets[index + 1];
      for (let at = scalarOffsets[index]; at < end; at += 4096) {
        string += String.fromCharCode(...scalarChars.subarray(at, Math.min(at + 4096, end)));
      }
      scalarStrings[index] = string;
    }
    return code < 0x80000000 ? string : BigInt(string);
  }
  const brushScalarKeys = ['id', 'friction', 'kind', 'collisionModel'];
  const brushes = lazyArray(brushCount, index => {
    const offset = index * 7, brush = readBounds(index);
    for (let field = 0; field < brushScalarKeys.length; field++) {
      const code = brushData[offset + 2 + field];
      if (code) brush[brushScalarKeys[field]] = scalarValue(code);
    }
    const state = brushData[offset + 6], leafStart = brushData[offset + 1], leafEnd = brushData[offset + 8];
    if (state === 1) {
      const leaves = new Array(leafEnd - leafStart);
      for (let i = leafStart; i < leafEnd; i++) {
        const at = i * 6;
        leaves[i - leafStart] = {min: {x: leafBounds[at], y: leafBounds[at + 1], z: leafBounds[at + 2]},
          max: {x: leafBounds[at + 3], y: leafBounds[at + 4], z: leafBounds[at + 5]}};
      }
      brush.leafBounds = leaves;
    } else if (state === 2) brush.leafBounds = undefined;
    else if (state === 3) brush.leafBounds = null;
    function setPlanes(value) {
      Object.defineProperty(brush, 'planes', {value, writable: true, configurable: true, enumerable: true});
    }
    Object.defineProperty(brush, 'planes', {
      configurable: true, enumerable: true, set: setPlanes,
      get() {
        const start = brushData[offset], end = brushData[offset + 7], planes = new Array(end - start);
        for (let i = start; i < end; i++) {
          const at = i * 4, plane = {normal: {x: planeValues[at], y: planeValues[at + 1], z: planeValues[at + 2]},
            distance: planeValues[at + 3]};
          if (planeFriction[i]) plane.friction = scalarValue(planeFriction[i]);
          planes[i - start] = plane;
        }
        setPlanes(planes);
        return planes;
      },
    });
    return brush;
  });
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
  return {map: {...packet.map, brushes, displacementTriangles: triangles}, tree, triangleBounds};
}
