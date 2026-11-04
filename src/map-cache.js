// Warm loads read collision geometry, its broadphase tree and ramp index from
// one record written after an earlier load, keyed by the geometry's SHA-256.
// The record is a single digested buffer; any mismatch falls back to the
// native download and parse.
import {packMapBounds, buildMapBoundsTree, unpackMapBoundsTree} from '../extension/map-bvh-preparation.js';
import {packRampPreparation, buildPackedRampPreparation} from './map-ramp-preparation.js';

/* global __QOL_MAP_CACHE__ */
export const MAP_CACHE_VERSION = typeof __QOL_MAP_CACHE__ === 'string' ? __QOL_MAP_CACHE__ : 'development';
const DB_NAME = 'surfd-qol-maps', DB_VERSION = 1;
const MAX_ENTRIES = 6, MAX_BYTES = 384 * 1024 * 1024;
const MAGIC = 0x51434d31;

const NULL = 0, FALSE = 1, TRUE = 2, INT = 3, STRING = 4, ARRAY = 5, OBJECT = 6, FLOAT = 7, DOUBLE = 8;

const done = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const committed = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Map cache write failed'));
});

export function openMapCache(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) return Promise.resolve(null);
  let request;
  try { request = indexedDB.open(DB_NAME, DB_VERSION); } catch { return Promise.resolve(null); }
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', {keyPath: 'key'});
    if (!db.objectStoreNames.contains('index')) db.createObjectStore('index', {keyPath: 'key'});
  };
  return done(request).then(db => {
    db.onversionchange = () => db.close();
    return db;
  }, () => null);
}

// Exact JSON values in typed streams. Objects record their key order once
// per shape; numbers keep the narrowest exact representation, including -0.
export function encodeMapValue(root) {
  const tags = [], ints = [], int32 = [], float32 = [], float64 = [];
  const strings = [], stringIds = new Map(), shapes = [], shapeIds = new Map();
  function visit(value) {
    if (value === null) { tags.push(NULL); return; }
    switch (typeof value) {
      case 'boolean': tags.push(value ? TRUE : FALSE); return;
      case 'number':
        if (!Number.isFinite(value)) throw new Error('Unsupported map value');
        if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff && !Object.is(value, -0)) {
          tags.push(INT); int32.push(value);
        } else if (Object.is(Math.fround(value), value)) {
          tags.push(FLOAT); float32.push(value);
        } else {
          tags.push(DOUBLE); float64.push(value);
        }
        return;
      case 'string': {
        let id = stringIds.get(value);
        if (id === undefined) { id = strings.length; stringIds.set(value, id); strings.push(value); }
        tags.push(STRING); ints.push(id);
        return;
      }
      case 'object':
        if (Array.isArray(value)) {
          tags.push(ARRAY); ints.push(value.length);
          for (let i = 0; i < value.length; i++) visit(value[i]);
          return;
        }
        if (Object.getPrototypeOf(value) !== Object.prototype) break;
        {
          const keys = Object.keys(value), signature = JSON.stringify(keys);
          let id = shapeIds.get(signature);
          if (id === undefined) { id = shapes.length; shapeIds.set(signature, id); shapes.push(keys); }
          tags.push(OBJECT); ints.push(id);
          for (const key of keys) visit(value[key]);
          return;
        }
    }
    throw new Error('Unsupported map value');
  }
  visit(root);
  return {
    strings, shapes,
    streams: {float64: Float64Array.from(float64), float32: Float32Array.from(float32), int32: Int32Array.from(int32),
      ints: Uint32Array.from(ints), tags: Uint8Array.from(tags)},
  };
}

function objectBuilder(keys) {
  // Literal construction gives each shape its own fixed layout. A __proto__
  // key is an own data property in parsed JSON, so it takes the generic path.
  if (keys.includes('__proto__')) return null;
  return new Function('read', `return{${keys.map(key => `${JSON.stringify(key)}:read()`).join(',')}}`);
}

export function decodeMapValue({strings, shapes, streams}) {
  const {float64, float32, int32, ints, tags} = streams;
  let builders = null;
  try { builders = shapes.map(objectBuilder); } catch { builders = null; }
  let t = 0, i = 0, n32 = 0, f32 = 0, f64 = 0;
  function generic(keys) {
    const object = {};
    for (const key of keys) {
      const value = read();
      if (key === '__proto__') Object.defineProperty(object, key, {value, writable: true, enumerable: true, configurable: true});
      else object[key] = value;
    }
    return object;
  }
  function read() {
    switch (tags[t++]) {
      case INT: return int32[n32++];
      case FLOAT: return float32[f32++];
      case DOUBLE: return float64[f64++];
      case STRING: {
        const id = ints[i++];
        if (id >= strings.length) throw new Error('Invalid cached map');
        return strings[id];
      }
      case ARRAY: {
        const length = ints[i++];
        if (length > tags.length - t) throw new Error('Invalid cached map');
        const array = [];
        for (let index = 0; index < length; index++) array.push(read());
        return array;
      }
      case OBJECT: {
        const id = ints[i++];
        if (id >= shapes.length) throw new Error('Invalid cached map');
        const build = builders?.[id];
        return build ? build(read) : generic(shapes[id]);
      }
      case NULL: return null;
      case FALSE: return false;
      case TRUE: return true;
    }
    throw new Error('Invalid cached map');
  }
  const value = read();
  if (t !== tags.length || i !== ints.length || n32 !== int32.length || f32 !== float32.length || f64 !== float64.length) {
    throw new Error('Invalid cached map');
  }
  return value;
}

// Key order, array density and Object.is equality, as JSON.parse produced them.
export function sameMapValue(left, right) {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) if (!sameMapValue(left[i], right[i])) return false;
    return true;
  }
  if (Array.isArray(right)) return false;
  const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let i = 0; i < leftKeys.length; i++) {
    if (leftKeys[i] !== rightKeys[i] || !sameMapValue(left[leftKeys[i]], right[rightKeys[i]])) return false;
  }
  return true;
}

const ARRAY_TYPES = {Float64Array, Float32Array, Int32Array, Uint32Array, Uint8Array};

// Header JSON followed by 8-byte aligned typed sections, all in one buffer.
function packRecord(header, sections) {
  const layout = [];
  let offset = 0;
  for (const [name, array] of Object.entries(sections)) {
    offset = Math.ceil(offset / 8) * 8;
    layout.push({name, type: array.constructor.name, offset, length: array.length});
    offset += array.byteLength;
  }
  const text = new TextEncoder().encode(JSON.stringify({...header, layout}));
  const start = Math.ceil((8 + text.length) / 8) * 8;
  const buffer = new ArrayBuffer(start + offset);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC);
  view.setUint32(4, text.length);
  new Uint8Array(buffer, 8, text.length).set(text);
  layout.forEach((entry, index) => {
    const array = Object.values(sections)[index];
    new Uint8Array(buffer, start + entry.offset, array.byteLength).set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  });
  return buffer;
}

function unpackRecord(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 8 || view.getUint32(0) !== MAGIC) throw new Error('Invalid cached map');
  const length = view.getUint32(4);
  if (8 + length > buffer.byteLength) throw new Error('Invalid cached map');
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, length)));
  const start = Math.ceil((8 + length) / 8) * 8, sections = {};
  for (const {name, type, offset, length: count} of header.layout) {
    const Type = ARRAY_TYPES[type];
    if (!Type || offset % 8 || start + offset + count * Type.BYTES_PER_ELEMENT > buffer.byteLength) throw new Error('Invalid cached map');
    sections[name] = new Type(buffer, start + offset, count);
  }
  return {header, sections};
}

async function digest(buffer) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

// The geometry file's own SHA-256 is the key, so only the exact bytes the
// game parses can produce a record. Decoding is checked before storing.
export async function buildMapCacheRecord(raw, {key, groundNormal, mapId}) {
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key) || await digest(raw) !== key) return null;
  const map = JSON.parse(new TextDecoder().decode(raw));
  if (map?.id !== mapId) return null;
  const encoded = encodeMapValue(map);
  if (!sameMapValue(decodeMapValue(encoded), map)) return null;
  const sections = {...encoded.streams};
  const header = {version: MAP_CACHE_VERSION, key, mapId, strings: encoded.strings, shapes: encoded.shapes,
    itemCount: null, groundNormal: null};
  const bounds = packMapBounds(map, true);
  const tree = bounds && buildMapBoundsTree(bounds.packedBounds);
  if (tree) {
    header.itemCount = tree.itemCount;
    Object.assign(sections, {nodeBounds: tree.nodeBounds, nodeData: tree.nodeData, indices: tree.indices, sourceBounds: tree.sourceBounds});
  }
  if (Number.isFinite(groundNormal)) {
    const packet = packRampPreparation(map, groundNormal);
    const ramps = packet && buildPackedRampPreparation(packet);
    if (ramps) {
      header.groundNormal = groundNormal;
      Object.assign(sections, {rampOrdinals: ramps.brushOrdinals, rampComponents: ramps.components, rampNormals: ramps.normals});
    }
  }
  const buffer = packRecord(header, sections);
  return {key, version: MAP_CACHE_VERSION, digest: await digest(buffer), buffer};
}

// Worker job: rebuild the record from the HTTP-cached geometry after entry.
export async function writeMapCache({key, url, groundNormal, mapId}, fetcher = fetch, indexedDB = globalThis.indexedDB) {
  if (typeof url !== 'string') return {stored: false};
  const response = await fetcher(url, {credentials: 'omit'});
  if (!response.ok || !response.body) return {stored: false};
  const compressed = new Uint8Array(await response.arrayBuffer());
  const raw = compressed[0] === 31 && compressed[1] === 139
    ? new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
    : compressed;
  const record = await buildMapCacheRecord(raw, {key, groundNormal, mapId});
  if (!record) return {stored: false};
  const buffer = record.buffer;
  const db = await openMapCache(indexedDB);
  if (!db) return {stored: false};
  try {
    const transaction = db.transaction(['records', 'index'], 'readwrite');
    transaction.objectStore('records').put(record);
    transaction.objectStore('index').put({key, size: buffer.byteLength, usedAt: Date.now()});
    await committed(transaction);
    await evictMapCache(db);
    return {stored: true, size: buffer.byteLength};
  } finally { db.close(); }
}

async function evictMapCache(db) {
  const entries = await done(db.transaction('index').objectStore('index').getAll());
  entries.sort((left, right) => right.usedAt - left.usedAt);
  let total = 0;
  const stale = [];
  entries.forEach((entry, index) => {
    total += entry.size;
    if (index >= MAX_ENTRIES || total > MAX_BYTES) stale.push(entry.key);
  });
  if (!stale.length) return;
  const transaction = db.transaction(['records', 'index'], 'readwrite');
  for (const key of stale) {
    transaction.objectStore('records').delete(key);
    transaction.objectStore('index').delete(key);
  }
  await committed(transaction);
}

// Page side: the decoded map plus the prepared tree and ramp data, or null.
export async function readMapCache(db, key) {
  if (!db || typeof key !== 'string') return null;
  let record;
  try { record = await done(db.transaction('records').objectStore('records').get(key)); } catch { return null; }
  const decoded = await decodeMapCacheRecord(record, key);
  if (decoded) {
    try {
      const transaction = db.transaction('index', 'readwrite');
      transaction.objectStore('index').put({key, size: record.buffer.byteLength, usedAt: Date.now()});
    } catch { /* Recency is advisory. */ }
  }
  return decoded;
}

export async function decodeMapCacheRecord(record, key) {
  if (!record || record.key !== key || record.version !== MAP_CACHE_VERSION || !(record.buffer instanceof ArrayBuffer)) return null;
  const verified = digest(record.buffer).then(value => value === record.digest, () => false);
  const decoded = decodeVerifiedMapCache(record.buffer, key);
  return decoded && await verified ? decoded : null;
}

// Worker job: read and verify the record off the page thread, which then
// only decodes it.
export async function readVerifiedMapCache({key}, indexedDB = globalThis.indexedDB) {
  if (typeof key !== 'string') return null;
  const db = await openMapCache(indexedDB);
  if (!db) return null;
  try {
    const record = await done(db.transaction('records').objectStore('records').get(key));
    if (!record || record.key !== key || record.version !== MAP_CACHE_VERSION || !(record.buffer instanceof ArrayBuffer) ||
        await digest(record.buffer) !== record.digest) return null;
    const transaction = db.transaction('index', 'readwrite');
    transaction.objectStore('index').put({key, size: record.buffer.byteLength, usedAt: Date.now()});
    await committed(transaction).catch(() => {});
    return {bytes: new Uint8Array(record.buffer)};
  } catch { return null; } finally { db.close(); }
}

export function decodeVerifiedMapCache(buffer, key) {
  try {
    const {header, sections} = unpackRecord(buffer);
    if (header.version !== MAP_CACHE_VERSION || header.key !== key) return null;
    const map = decodeMapValue({strings: header.strings, shapes: header.shapes, streams: sections});
    return {map, header, sections};
  } catch { return null; }
}

// Prepared world inputs for one decoded map: exact triangle bounds and the
// validated tree, or null when the record carries none for these arrays.
export function cachedWorld(cached, map) {
  const {header, sections} = cached;
  const triangles = map.displacementTriangles, brushes = map.brushes;
  if (!Array.isArray(brushes) || !Number.isSafeInteger(header.itemCount) || !(sections.sourceBounds instanceof Float64Array)) return null;
  const triangleCount = triangles === undefined ? 0 : Array.isArray(triangles) ? triangles.length : -1;
  if (triangleCount < 0 || header.itemCount !== brushes.length + triangleCount) return null;
  const source = sections.sourceBounds, triangleBounds = new Array(triangleCount);
  for (let index = 0; index < triangleCount; index++) {
    const offset = (brushes.length + index) * 6;
    triangleBounds[index] = {min: {x: source[offset], y: source[offset + 1], z: source[offset + 2]},
      max: {x: source[offset + 3], y: source[offset + 4], z: source[offset + 5]}};
  }
  const root = unpackMapBoundsTree({itemCount: header.itemCount, nodeBounds: sections.nodeBounds, nodeData: sections.nodeData,
    indices: sections.indices, sourceBounds: source}, header.itemCount);
  if (root === undefined) return null;
  return {triangleBounds, root, itemCount: header.itemCount};
}
