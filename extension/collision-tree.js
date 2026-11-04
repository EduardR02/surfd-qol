// Temporary numeric storage belongs only to this build. Ordinary output keeps
// native ID-array leaves; compact output writes the transferable numeric tree.
export function buildCollisionTree(bounds, leafSize = 12, compact = false) {
  if (!(compact ? bounds instanceof Float64Array : Array.isArray(bounds)) ||
      !Number.isSafeInteger(leafSize) || leafSize < 1) return undefined;
  if (!compact && (Object.getPrototypeOf(bounds) !== Array.prototype ||
      Object.hasOwn(bounds, 'map') || Object.hasOwn(bounds, 'constructor') ||
      Object.hasOwn(bounds, Symbol.iterator))) return undefined;
  const count = compact ? bounds.length / 6 : bounds.length;
  if (!Number.isInteger(count) || count > 0x7fffffff) return undefined;
  if (!count) return compact ? {itemCount: 0, nodeBounds: new Float64Array(0),
    nodeData: new Int32Array(0), indices: new Uint32Array(0)} : null;

  const values = new Float64Array(count * 9);
  const indices = new Uint32Array(count);
  // Native construction can read geometry repeatedly and in a different
  // order. Never probe or cache accessors, custom array species or inherited
  // coordinates; let the original constructor handle those layouts.
  const ordinary = object => object && typeof object === 'object' && Object.getPrototypeOf(object) === Object.prototype;
  const getter = Object.prototype.__lookupGetter__;
  const data = (object, key) => Object.hasOwn(object, key) && !getter.call(object, key);
  for (let index = 0; index < count; index++) {
    const source = index * 6;
    let minX, minY, minZ, maxX, maxY, maxZ;
    if (compact) {
      minX = bounds[source]; minY = bounds[source + 1]; minZ = bounds[source + 2];
      maxX = bounds[source + 3]; maxY = bounds[source + 4]; maxZ = bounds[source + 5];
    } else {
      if (!data(bounds, index)) return undefined;
      const box = bounds[index];
      if (!ordinary(box) || !data(box, 'min') || !data(box, 'max')) return undefined;
      const min = box.min, max = box.max;
      if (!ordinary(min) || !ordinary(max) || !data(min, 'x') || !data(min, 'y') || !data(min, 'z') ||
          !data(max, 'x') || !data(max, 'y') || !data(max, 'z')) return undefined;
      minX = min.x; minY = min.y; minZ = min.z;
      maxX = max.x; maxY = max.y; maxZ = max.z;
    }
    const offset = index * 9;
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ) ||
        !Number.isFinite(maxX) || !Number.isFinite(maxY) || !Number.isFinite(maxZ)) return undefined;
    const centerX = minX + maxX, centerY = minY + maxY, centerZ = minZ + maxZ;
    if (!Number.isFinite(centerX) || !Number.isFinite(centerY) || !Number.isFinite(centerZ)) return undefined;
    values[offset] = minX;
    values[offset + 1] = minY;
    values[offset + 2] = minZ;
    values[offset + 3] = maxX;
    values[offset + 4] = maxY;
    values[offset + 5] = maxZ;
    values[offset + 6] = centerX;
    values[offset + 7] = centerY;
    values[offset + 8] = centerZ;
    indices[index] = index;
  }
  // Compact output shares the exact partition/leaf-order implementation. It
  // never constructs a temporary object tree merely to flatten it for transfer.
  function nodes(size) { return size <= leafSize ? 1 : 1 + nodes(size >> 1) + nodes(size - (size >> 1)); }
  const nodeCount = compact ? nodes(count) : 0;
  const nodeBounds = compact ? new Float64Array(nodeCount * 6) : null;
  const nodeData = compact ? new Int32Array(nodeCount * 4) : null;
  let nextNode = 0;

  function compare(left, right, axis) {
    return values[left * 9 + 6 + axis] - values[right * 9 + 6 + axis] || left - right;
  }

  function select(start, end, median, axis) {
    let low = start, high = end - 1;
    // Bound bad pivot sequences before falling back to the engine's sort. All
    // already-discarded ranges remain on the correct side of the median.
    let budget = 2 * Math.ceil(Math.log2(end - start)) + 1;
    while (low < high) {
      if (--budget < 0) {
        indices.subarray(low, high + 1).sort((left, right) => compare(left, right, axis));
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
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let index = start; index < end; index++) {
      const offset = indices[index] * 9;
      // Math.min/max, rather than comparisons, preserve native signed zeros.
      minX = Math.min(minX, values[offset]);
      minY = Math.min(minY, values[offset + 1]);
      minZ = Math.min(minZ, values[offset + 2]);
      maxX = Math.max(maxX, values[offset + 3]);
      maxY = Math.max(maxY, values[offset + 4]);
      maxZ = Math.max(maxZ, values[offset + 5]);
    }
    const node = compact ? nextNode++ : -1;
    if (compact) {
      const offset = node * 6;
      nodeBounds[offset] = minX; nodeBounds[offset + 1] = minY; nodeBounds[offset + 2] = minZ;
      nodeBounds[offset + 3] = maxX; nodeBounds[offset + 4] = maxY; nodeBounds[offset + 5] = maxZ;
    }
    if (end - start <= leafSize) {
      // Native leaves inherit the parent's full sort; a root leaf is unsorted.
      if (parentAxis >= 0) for (let index = start + 1; index < end; index++) {
        const item = indices[index];
        let position = index;
        while (position > start && compare(indices[position - 1], item, parentAxis) > 0) {
          indices[position] = indices[position - 1];
          position--;
        }
        indices[position] = item;
      }
      if (compact) {
        const offset = node * 4;
        nodeData[offset] = -1; nodeData[offset + 1] = -1;
        nodeData[offset + 2] = start; nodeData[offset + 3] = end - start;
        return node;
      }
      const items = new Array(end - start);
      for (let index = start; index < end; index++) items[index - start] = indices[index];
      return {min: {x: minX, y: minY, z: minZ}, max: {x: maxX, y: maxY, z: maxZ}, items};
    }
    let axis = 0, extent = maxX - minX;
    if (maxY - minY > extent) {
      axis = 1;
      extent = maxY - minY;
    }
    if (maxZ - minZ > extent) axis = 2;
    const middle = start + ((end - start) >> 1);
    select(start, end, middle, axis);
    const left = build(start, middle, axis), right = build(middle, end, axis);
    if (!compact) return {min: {x: minX, y: minY, z: minZ}, max: {x: maxX, y: maxY, z: maxZ}, left, right};
    const offset = node * 4;
    nodeData[offset] = left; nodeData[offset + 1] = right; nodeData[offset + 2] = -1;
    return node;
  }

  const root = build(0, count, -1);
  return compact ? {itemCount: count, nodeBounds, nodeData, indices} : root;
}

// Optional and atomic: recognize the complete native constructor/query layout,
// then prepend a fast path. The original constructor body and query stay intact.
export function nativeCollisionTreeHooks(source) {
  if (source.includes('__qolCollisionTree')) return source;
  const pattern = /class (?<name>[\w$]+)\{constructor\((?<bounds>[\w$]+),(?<threshold>[\w$]+)=12\)\{this\.bounds=\k<bounds>;const (?<build>[\w$]+)=(?<items>[\w$]+)=>\{const (?<min>[\w$]+)=\{x:1\/0,y:1\/0,z:1\/0\},(?<max>[\w$]+)=\{x:-1\/0,y:-1\/0,z:-1\/0\};for\(const (?<item>[\w$]+) of \k<items>\)for\(const (?<coordinate>[\w$]+) of (?<axes>[\w$]+)\)\k<min>\[\k<coordinate>\]=Math\.min\(\k<min>\[\k<coordinate>\],\k<bounds>\[\k<item>\]\.min\[\k<coordinate>\]\),\k<max>\[\k<coordinate>\]=Math\.max\(\k<max>\[\k<coordinate>\],\k<bounds>\[\k<item>\]\.max\[\k<coordinate>\]\);if\(\k<items>\.length<=\k<threshold>\)return\{min:\k<min>,max:\k<max>,items:\k<items>\};const (?<axis>[\w$]+)=\k<axes>\.reduce\(\((?<best>[\w$]+),(?<candidate>[\w$]+)\)=>\k<max>\[\k<candidate>\]-\k<min>\[\k<candidate>\]>\k<max>\[\k<best>\]-\k<min>\[\k<best>\]\?\k<candidate>:\k<best>\);\k<items>\.sort\(\((?<left>[\w$]+),(?<right>[\w$]+)\)=>\k<bounds>\[\k<left>\]\.min\[\k<axis>\]\+\k<bounds>\[\k<left>\]\.max\[\k<axis>\]-\(\k<bounds>\[\k<right>\]\.min\[\k<axis>\]\+\k<bounds>\[\k<right>\]\.max\[\k<axis>\]\)\|\|\k<left>-\k<right>\);const (?<middle>[\w$]+)=\k<items>\.length>>1;return\{min:\k<min>,max:\k<max>,left:\k<build>\(\k<items>\.slice\(0,\k<middle>\)\),right:\k<build>\(\k<items>\.slice\(\k<middle>\)\)\}\};this\.root=\k<bounds>\.length\?\k<build>\(\k<bounds>\.map\(\((?<value>[\w$]+),(?<index>[\w$]+)\)=>\k<index>\)\):null\}bounds;root;query\((?<query>[\w$]+)\)\{const (?<results>[\w$]+)=\[\],(?<visit>[\w$]+)=(?<node>[\w$]+)=>\{if\((?<overlap>[\w$]+)\(\k<node>,\k<query>\)\)if\(\k<node>\.items\)for\(const (?<id>[\w$]+) of \k<node>\.items\)\k<overlap>\(this\.bounds\[\k<id>\],\k<query>\)&&\k<results>\.push\(\k<id>\);else \k<visit>\(\k<node>\.left\),\k<visit>\(\k<node>\.right\)\};return this\.root&&\k<visit>\(this\.root\),\k<results>\.sort\(\((?<resultLeft>[\w$]+),(?<resultRight>[\w$]+)\)=>\k<resultLeft>-\k<resultRight>\)\}\}/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return source;
  const match = matches[0], {name, bounds, threshold, axes, overlap} = match.groups;
  const escapedAxes = axes.replace(/\$/g, () => '\\$');
  const escapedOverlap = overlap.replace(/\$/g, () => '\\$');
  // A namesake XYZ array elsewhere in the bundle does not identify the
  // constructor's binding. Require the adjacent axes/overlap declaration and
  // reject constructor-local variables that shadow it.
  const adjacent = new RegExp(`(?:^|[^\\w$])${escapedAxes}=\\["x","y","z"\\],${escapedOverlap}=\\([^()]*\\)=>[^;]*;$`);
  if (!adjacent.test(source.slice(0, match.index)) ||
      ['bounds', 'threshold', 'build', 'items', 'min', 'max', 'item', 'coordinate', 'axis',
        'best', 'candidate', 'left', 'right', 'middle'].some(key => match.groups[key] === axes)) return source;
  const header = `class ${name}{constructor(${bounds},${threshold}=12){`;
  const replacement = `${header}const __qolCollisionTree=(${buildCollisionTree.toString()})(${bounds},${threshold});if(__qolCollisionTree!==void 0){this.bounds=${bounds};this.root=__qolCollisionTree;return}${match[0].slice(header.length)}`;
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}
