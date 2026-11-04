import { buildRampSurfaceData, hasRampSurfaces, installRampSurfaceData, normalizedRampPlane } from './surfaces.js';

export { hasRampSurfaces } from './surfaces.js';

// Jobs retain only their eligible ordinals/counts, not the packed geometry. A
// result can be adopted only by the exact map and threshold that issued it.
const pending = new WeakMap();
let nextRequestId = 0;
const MAX_UINT32 = 0xffffffff;
const MAX_FACES = 0x7fffffff;
const finiteVector = value => value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);

function validMap(map, groundNormal) {
  return map && typeof map === 'object' && Array.isArray(map.brushes) && map.brushes.length &&
    Number.isFinite(groundNormal) && groundNormal > 0 && groundNormal <= 1;
}

// Only the native algorithm's eligible planes and their brushes are copied.
// Malformed geometry on an eligible brush falls back to the native path.
export function packRampPreparation(map, groundNormal) {
  // A later attempt supersedes the previous job even if the current geometry
  // can no longer be encoded. Its result must not install stale surfaces.
  if (map && typeof map === 'object') cancelRampPreparation(map, groundNormal);
  if (!validMap(map, groundNormal)) return null;
  const selected = [];
  let planeCount = 0, vertexCount = 0, faceCount = 0, indexCount = 0, ordinal = 0;
  for (const brush of map.brushes) {
    const brushOrdinal = ordinal++;
    // A custom iterator which no longer corresponds to array ordinals cannot
    // be safely mapped back to the original brush IDs.
    if (brushOrdinal >= map.brushes.length || map.brushes[brushOrdinal] !== brush) return null;
    if (!brush || (typeof brush.id !== 'string' && typeof brush.id !== 'number') ||
      !Array.isArray(brush.vertices) || !Array.isArray(brush.faces) || !Array.isArray(brush.planes)) continue;
    const planes = [];
    for (const plane of brush.planes) {
      if (normalizedRampPlane(plane, groundNormal)) planes.push(plane);
    }
    if (!planes.length) continue;

    // The worker uses dense numerical geometry. Reject cases where encoding
    // an array element would change native indexing or finite-vector checks.
    for (let i = 0; i < brush.vertices.length; i++) {
      if (!(i in brush.vertices) || !finiteVector(brush.vertices[i])) return null;
    }
    const faces = [];
    for (const indices of brush.faces) {
      if (!Array.isArray(indices) || indices.length < 3) continue;
      // Native calls indices.map() and its Array species. Exotic face arrays
      // cannot be reproduced by a plain dense worker array.
      if (Object.getPrototypeOf(indices) !== Array.prototype || indices.map !== Array.prototype.map ||
        indices.constructor !== Array) return null;
      for (let i = 0; i < indices.length; i++) {
        const index = indices[i];
        if (!(i in indices) || !Number.isInteger(index) || index < 0 || index >= brush.vertices.length ||
          index > MAX_UINT32) return null;
      }
      faces.push(indices);
      indexCount += indices.length;
    }
    selected.push({ ordinal: brushOrdinal, brush, planes, faces });
    planeCount += planes.length;
    vertexCount += brush.vertices.length;
    faceCount += faces.length;
    if (planeCount > MAX_UINT32 || vertexCount > MAX_UINT32 || faceCount > MAX_FACES ||
      indexCount > MAX_UINT32) return null;
  }
  if (ordinal !== map.brushes.length || selected.length >= MAX_UINT32) return null;

  let packet, expected;
  try {
    packet = {
      requestId: 0, groundNormal, brushCount: map.brushes.length,
      brushOrdinals: new Uint32Array(selected.length),
      brushPlaneOffsets: new Uint32Array(selected.length + 1),
      brushVertexOffsets: new Uint32Array(selected.length + 1),
      brushFaceOffsets: new Uint32Array(selected.length + 1),
      faceOffsets: new Uint32Array(faceCount + 1),
      faceIndices: new Uint32Array(indexCount),
      planes: new Float64Array(planeCount * 4),
      vertices: new Float64Array(vertexCount * 3),
    };
    expected = new Uint32Array(selected.length * 2);
  } catch {
    return null;
  }
  let planeCursor = 0, vertexCursor = 0, faceCursor = 0, indexCursor = 0;
  for (let i = 0; i < selected.length; i++) {
    const { ordinal: brushOrdinal, brush, planes, faces } = selected[i];
    packet.brushOrdinals[i] = brushOrdinal;
    expected[i * 2] = brushOrdinal;
    expected[i * 2 + 1] = faces.length;
    for (const plane of planes) {
      const offset = planeCursor++ * 4;
      packet.planes[offset] = plane.normal.x;
      packet.planes[offset + 1] = plane.normal.y;
      packet.planes[offset + 2] = plane.normal.z;
      packet.planes[offset + 3] = plane.distance;
    }
    for (let j = 0; j < brush.vertices.length; j++) {
      const vertex = brush.vertices[j];
      const offset = vertexCursor++ * 3;
      packet.vertices[offset] = vertex.x;
      packet.vertices[offset + 1] = vertex.y;
      packet.vertices[offset + 2] = vertex.z;
    }
    for (const indices of faces) {
      for (let j = 0; j < indices.length; j++) packet.faceIndices[indexCursor++] = indices[j];
      packet.faceOffsets[++faceCursor] = indexCursor;
    }
    packet.brushPlaneOffsets[i + 1] = planeCursor;
    packet.brushVertexOffsets[i + 1] = vertexCursor;
    packet.brushFaceOffsets[i + 1] = faceCursor;
  }
  // IDs are local to this module instance and never expose arbitrary map IDs.
  if (nextRequestId === Number.MAX_SAFE_INTEGER) return null;
  packet.requestId = ++nextRequestId;
  let thresholds = pending.get(map);
  if (!thresholds) pending.set(map, thresholds = new Map());
  thresholds.set(groundNormal, { requestId: packet.requestId, brushes: map.brushes, brushCount: map.brushes.length, expected });
  return packet;
}

// An optional request ID prevents an older cancellation from revoking a newer
// preparation for the same map and threshold.
export function cancelRampPreparation(map, groundNormal, requestId) {
  const thresholds = pending.get(map), job = thresholds?.get(groundNormal);
  if (!job || (requestId !== undefined && requestId !== job.requestId)) return false;
  thresholds.delete(groundNormal);
  if (!thresholds.size) pending.delete(map);
  return true;
}

function validOffsets(offsets, length, end) {
  if (!(offsets instanceof Uint32Array) || offsets.length !== length + 1 || offsets[0] !== 0 ||
    offsets[length] !== end) return false;
  for (let i = 1; i < offsets.length; i++) if (offsets[i] < offsets[i - 1]) return false;
  return true;
}

// Reconstitute only selected brushes in the worker and run the very same face
// and connectivity builder used by getRampSurfaces. Original IDs never leave
// the parent; local brush positions are translated back to original ordinals.
export function buildPackedRampPreparation(packet) {
  if (!packet || !Number.isSafeInteger(packet.requestId) || packet.requestId <= 0 ||
    !Number.isFinite(packet.groundNormal) || packet.groundNormal <= 0 || packet.groundNormal > 1 ||
    !Number.isInteger(packet.brushCount) || packet.brushCount <= 0 || packet.brushCount > MAX_UINT32 ||
    !(packet.brushOrdinals instanceof Uint32Array) || !(packet.faceIndices instanceof Uint32Array) ||
    !(packet.planes instanceof Float64Array) || packet.planes.length % 4 ||
    !(packet.vertices instanceof Float64Array) || packet.vertices.length % 3) return null;
  const count = packet.brushOrdinals.length;
  if (!validOffsets(packet.brushPlaneOffsets, count, packet.planes.length / 4) ||
    !validOffsets(packet.brushVertexOffsets, count, packet.vertices.length / 3) ||
    !(packet.faceOffsets instanceof Uint32Array) || !packet.faceOffsets.length ||
    packet.faceOffsets.length - 1 > MAX_FACES ||
    !validOffsets(packet.brushFaceOffsets, count, packet.faceOffsets.length - 1) ||
    !validOffsets(packet.faceOffsets, packet.faceOffsets.length - 1, packet.faceIndices.length)) return null;

  const brushes = new Array(count);
  for (let i = 0; i < count; i++) {
    const ordinal = packet.brushOrdinals[i];
    if (ordinal >= packet.brushCount || (i && ordinal <= packet.brushOrdinals[i - 1])) return null;
    const planes = [];
    for (let j = packet.brushPlaneOffsets[i]; j < packet.brushPlaneOffsets[i + 1]; j++) {
      const offset = j * 4;
      const plane = { normal: { x: packet.planes[offset], y: packet.planes[offset + 1], z: packet.planes[offset + 2] },
        distance: packet.planes[offset + 3] };
      if (!normalizedRampPlane(plane, packet.groundNormal)) return null;
      planes.push(plane);
    }
    if (!planes.length) return null;
    const vertexStart = packet.brushVertexOffsets[i];
    const vertexEnd = packet.brushVertexOffsets[i + 1];
    const vertices = new Array(vertexEnd - vertexStart);
    for (let j = vertexStart; j < vertexEnd; j++) {
      const offset = j * 3;
      const vertex = { x: packet.vertices[offset], y: packet.vertices[offset + 1], z: packet.vertices[offset + 2] };
      if (!finiteVector(vertex)) return null;
      vertices[j - vertexStart] = vertex;
    }
    const faces = [];
    for (let j = packet.brushFaceOffsets[i]; j < packet.brushFaceOffsets[i + 1]; j++) {
      const start = packet.faceOffsets[j], end = packet.faceOffsets[j + 1];
      if (end - start < 3) return null;
      const indices = new Array(end - start);
      for (let k = start; k < end; k++) {
        const index = packet.faceIndices[k];
        if (index >= vertices.length) return null;
        indices[k - start] = index;
      }
      faces.push(indices);
    }
    brushes[i] = { id: i, planes, vertices, faces };
  }
  const { faces, components: labels } = buildRampSurfaceData({ brushes }, packet.groundNormal);
  const brushOrdinals = new Uint32Array(faces.length);
  const components = new Uint32Array(faces.length);
  const normals = new Float64Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i], offset = i * 3;
    brushOrdinals[i] = packet.brushOrdinals[face.brushId];
    components[i] = labels[i];
    normals[offset] = face.normal.x;
    normals[offset + 1] = face.normal.y;
    normals[offset + 2] = face.normal.z;
  }
  return { requestId: packet.requestId, groundNormal: packet.groundNormal, brushOrdinals, components, normals };
}

export function installPreparedRampSurfaces(map, groundNormal, packet) {
  if (!validMap(map, groundNormal) || hasRampSurfaces(map, groundNormal) || !packet ||
    packet.groundNormal !== groundNormal || !(packet.brushOrdinals instanceof Uint32Array) ||
    !(packet.components instanceof Uint32Array) || !(packet.normals instanceof Float64Array)) return false;
  const thresholds = pending.get(map), job = thresholds?.get(groundNormal);
  if (!job || packet.requestId !== job.requestId || map.brushes !== job.brushes ||
    map.brushes.length !== job.brushCount) return false;
  const { brushOrdinals: ordinals, components, normals } = packet;
  if (ordinals.length !== components.length || normals.length !== ordinals.length * 3 ||
    ordinals.length > MAX_FACES) return false;
  let selectedIndex = 0, seen = 0;
  for (let i = 0; i < ordinals.length; i++) {
    const ordinal = ordinals[i];
    while (selectedIndex * 2 < job.expected.length && job.expected[selectedIndex * 2] < ordinal) {
      selectedIndex++;
      seen = 0;
    }
    if (selectedIndex * 2 >= job.expected.length || job.expected[selectedIndex * 2] !== ordinal ||
      ++seen > job.expected[selectedIndex * 2 + 1]) return false;
    const brush = map.brushes[ordinal];
    if (!brush || (typeof brush.id !== 'string' && typeof brush.id !== 'number')) return false;
    const component = components[i], offset = i * 3;
    if (component > i || components[component] !== component ||
      !Number.isFinite(normals[offset]) || !Number.isFinite(normals[offset + 1]) ||
      !Number.isFinite(normals[offset + 2]) || !(normals[offset + 2] > 0 && normals[offset + 2] < groundNormal)) return false;
  }
  if (!installRampSurfaceData(map, groundNormal, ordinals, components, normals)) return false;
  cancelRampPreparation(map, groundNormal, packet.requestId);
  return true;
}
