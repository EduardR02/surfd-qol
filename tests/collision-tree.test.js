import {expect, test} from 'bun:test';
import {buildCollisionTree} from '../extension/collision-tree.js';
import {packCollisionWorld, unpackCollisionWorld} from '../extension/collision-world.js';

const axes = ['x', 'y', 'z'];
const point = (x, y, z) => ({x, y, z});
const box = (x, y, z, X = x, Y = y, Z = z) => ({min: point(x, y, z), max: point(X, Y, Z)});
const overlap = (a, b) => axes.every(axis => a.min[axis] <= b.max[axis] && a.max[axis] >= b.min[axis]);

// Deliberately independent of partitioning, axis selection and traversal order.
function bruteForce(bounds, query) {
  const result = [];
  for (let i = 0; i < bounds.length; i++) if (overlap(bounds[i], query)) result.push(i);
  return result;
}

// Native-style consumer: prune by inclusive node bounds, then test the actual item.
function queryTree(root, bounds, query) {
  const result = [];
  function visit(node) {
    if (!overlap(node, query)) return;
    if (node.items) {
      for (const index of node.items) if (overlap(bounds[index], query)) result.push(index);
    } else {
      visit(node.left);
      visit(node.right);
    }
  }
  if (root) visit(root);
  return result.sort((a, b) => a - b);
}

function expectQueries(root, bounds, queries) {
  for (const query of queries) expect(queryTree(root, bounds, query)).toEqual(bruteForce(bounds, query));
}

function expectTree(root, bounds, leafSize) {
  if (!bounds.length) {
    expect(root).toBeNull();
    return;
  }
  const nodes = new Set(), seen = new Set();
  const livePoints = new Set(bounds.flatMap(bound => [bound.min, bound.max]));
  function visit(node) {
    expect(node !== null && typeof node === 'object').toBe(true);
    expect(nodes.has(node)).toBe(false);
    nodes.add(node);
    expect(livePoints.has(node.min)).toBe(false);
    expect(livePoints.has(node.max)).toBe(false);
    let items;
    if (node.items !== undefined) {
      expect(Array.isArray(node.items)).toBe(true);
      expect(node.items.length).toBeGreaterThan(0);
      if (leafSize !== undefined) expect(node.items.length).toBeLessThanOrEqual(leafSize);
      expect(node.left == null && node.right == null).toBe(true);
      items = node.items;
      for (const index of items) {
        expect(Number.isInteger(index) && index >= 0 && index < bounds.length).toBe(true);
        expect(seen.has(index)).toBe(false);
        seen.add(index);
      }
    } else {
      expect(node.left != null && node.right != null).toBe(true);
      items = [...visit(node.left), ...visit(node.right)];
    }
    for (const axis of axes) {
      let min = Infinity, max = -Infinity;
      for (const index of items) {
        min = Math.min(min, bounds[index].min[axis]);
        max = Math.max(max, bounds[index].max[axis]);
      }
      expect(Object.is(node.min[axis], min)).toBe(true);
      expect(Object.is(node.max[axis], max)).toBe(true);
    }
    return items;
  }
  visit(root);
  expect([...seen].sort((a, b) => a - b)).toEqual(bounds.map((_, index) => index));
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randomFixture(seed, count) {
  const random = seededRandom(seed);
  const coordinate = () => Math.floor(random() * 401) - 200;
  const makeBox = index => {
    const min = point(coordinate(), coordinate(), coordinate());
    return {min, max: point(min.x + (index % 5 ? Math.floor(random() * 31) : 0),
      min.y + (index % 7 ? Math.floor(random() * 31) : 0),
      min.z + (index % 3 ? Math.floor(random() * 31) : 0))};
  };
  const bounds = Array.from({length: count}, (_, i) => makeBox(i));
  const queries = [box(-1000, -1000, -1000, 1000, 1000, 1000), box(1000, 1000, 1000),
    ...Array.from({length: 48}, (_, i) => makeBox(i))];
  for (let i = 0; i < bounds.length; i += 17) {
    queries.push(bounds[i], {min: {...bounds[i].min}, max: {...bounds[i].min}},
      {min: {...bounds[i].max}, max: {...bounds[i].max}});
  }
  return {bounds, queries};
}

const builders = [
  ['module', buildCollisionTree],
  ['standalone injected function', Function(`return (${buildCollisionTree.toString()})`)()],
];

for (const [name, build] of builders) {
  test(`${name}: empty and singleton bounds support default and custom leaf sizes`, () => {
    for (const leafSize of [undefined, 1, 2, 7, 32, Number.MAX_SAFE_INTEGER]) {
      expectTree(build([], leafSize), [], leafSize);
      const bounds = [box(-2, -1, 0, 3, 4, 5)];
      const root = build(bounds, leafSize);
      expectTree(root, bounds, leafSize);
      expectQueries(root, bounds, [box(-2, -1, 0), box(3, 4, 5), box(0, 0, 0), box(4, 4, 5)]);
      expect(queryTree(root, bounds, bounds[0])).toEqual([0]);
    }
  });

  test(`${name}: faces, edges, corners, planes, lines and duplicate boxes are inclusive`, () => {
    const bounds = [box(0, 0, 0, 1, 1, 1), box(1, 0, 0, 2, 1, 1),
      box(1, 1, 0, 2, 2, 1), box(1, 1, 1, 2, 2, 2), box(1, 1, 1),
      box(1, -2, -2, 1, 2, 2), box(-2, 1, 1, 2, 1, 1), box(0, 0, 0, 1, 1, 1),
      box(3, 3, 3, 4, 4, 4)];
    const cases = [
      [box(1, .5, .5), [0, 1, 5, 7]],
      [box(1, 1, .5), [0, 1, 2, 5, 7]],
      [box(1, 1, 1), [0, 1, 2, 3, 4, 5, 6, 7]],
      [box(1 + Number.EPSILON, .5, .5), [1]],
      [box(-10, -10, -10), []],
    ];
    for (const leafSize of [undefined, 1, 2, 4, 64]) {
      const root = build(bounds, leafSize);
      expectTree(root, bounds, leafSize);
      for (const [query, expected] of cases) {
        expect(queryTree(root, bounds, query)).toEqual(expected);
        expect(bruteForce(bounds, query)).toEqual(expected);
      }
    }
  });

  test(`${name}: signed zeros survive aggregation and remain inclusive at every leaf size`, () => {
    const bounds = Array.from({length: 37}, (_, i) => box(
      i % 2 ? -0 : 0, i % 3 ? 0 : -0, i % 5 ? -0 : 0,
      i % 2 ? 0 : -0, i % 3 ? -0 : 0, i % 5 ? 0 : -0));
    const before = structuredClone(bounds);
    for (const leafSize of [1, 3, 12, 100]) {
      const root = build(bounds, leafSize);
      expectTree(root, bounds, leafSize);
      expectQueries(root, bounds, [box(-0, -0, -0), box(0, 0, 0),
        box(-Number.MIN_VALUE, -Number.MIN_VALUE, -Number.MIN_VALUE, 0, 0, 0),
        box(Number.MIN_VALUE, 0, 0)]);
    }
    for (let i = 0; i < bounds.length; i++) for (const side of ['min', 'max']) for (const axis of axes) {
      expect(Object.is(bounds[i][side][axis], before[i][side][axis])).toBe(true);
    }
  });

  test(`${name}: finite reversed, slender, subnormal and large bounds retain native overlaps`, () => {
    const bounds = [box(5, 4, 3, -5, -4, -3),
      box(-8e307, -Number.MIN_VALUE, -1, 8e307, Number.MIN_VALUE, 1),
      box(2 ** 52, 0, 0, 2 ** 52 + 1, 0, 0),
      box(-Number.MIN_VALUE, -Number.MIN_VALUE, -Number.MIN_VALUE,
        Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE), box(7, 0, 0)];
    const queries = [box(-9e307, -10, -10, 9e307, 10, 10), box(-10, -10, -10, 10, 10, 10),
      box(0, 0, 0), box(5, 4, 3), box(-6, -6, -6, 6, 6, 6), box(7, 0, 0),
      box(2 ** 52 + 1, 0, 0)];
    for (const leafSize of [1, 2, 10]) {
      const root = build(bounds, leafSize);
      expectTree(root, bounds, leafSize);
      expectQueries(root, bounds, queries);
    }
  });

  test(`${name}: randomized boxes retain every candidate in original ID order`, () => {
    for (const seed of [1, 0x12345678, 0xffffffff]) {
      const {bounds, queries} = randomFixture(seed, 257);
      const before = structuredClone(bounds);
      const originals = bounds.map(bound => ({bound, min: bound.min, max: bound.max}));
      for (const leafSize of [undefined, 1, 3, 7, 31, 1000]) {
        const root = build(bounds, leafSize);
        expectTree(root, bounds, leafSize);
        expectQueries(root, bounds, queries);
      }
      expect(bounds).toEqual(before);
      for (let i = 0; i < bounds.length; i++) {
        expect(bounds[i]).toBe(originals[i].bound);
        expect(bounds[i].min).toBe(originals[i].min);
        expect(bounds[i].max).toBe(originals[i].max);
      }
    }
  });

  test(`${name}: ordered, reverse, alternating and equal-center distributions lose no IDs`, () => {
    const count = 513;
    const distributions = [
      Array.from({length: count}, (_, i) => box(i * 3, -1, 0, i * 3 + 1, 1, 0)),
      Array.from({length: count}, (_, i) => box(0, i * 3, -1, 0, i * 3 + 1, 1)).reverse(),
      Array.from({length: count}, (_, i) => {
        const z = (i % 2 ? -i : i) * 3;
        return box(-1, 0, z, 1, 0, z + 1);
      }),
      Array.from({length: count}, (_, i) => {
        const radius = (i * 197) % count;
        return box(-radius, -radius / 2, -radius / 4, radius, radius / 2, radius / 4);
      }),
      Array.from({length: count}, () => box(-1, -1, -1, 1, 1, 1)),
    ];
    for (const bounds of distributions) {
      const queries = [box(-10000, -10000, -10000, 10000, 10000, 10000), box(0, 0, 0),
        box(-20, -20, -20, 20, 20, 20), box(10000, 10000, 10000)];
      for (let i = 0; i < count; i += 53) queries.push(bounds[i]);
      for (const leafSize of [1, 7, 32]) {
        const root = build(bounds, leafSize);
        expectTree(root, bounds, leafSize);
        expectQueries(root, bounds, queries);
      }
    }
  });

  test(`${name}: construction does not mutate frozen live bounds or share trees between calls`, () => {
    const {bounds, queries} = randomFixture(71, 67);
    for (const bound of bounds) {
      Object.freeze(bound.min);
      Object.freeze(bound.max);
      Object.freeze(bound);
    }
    Object.freeze(bounds);
    const before = structuredClone(bounds), originals = [...bounds];
    const first = build(bounds, 3), second = build(bounds, 3);
    expectTree(first, bounds, 3);
    expectTree(second, bounds, 3);
    const owned = new Set();
    function remember(node) {
      for (const value of [node, node.min, node.max, node.items]) if (value) owned.add(value);
      if (!node.items) { remember(node.left); remember(node.right); }
    }
    function expectIndependent(node) {
      for (const value of [node, node.min, node.max, node.items]) if (value) expect(owned.has(value)).toBe(false);
      if (!node.items) { expectIndependent(node.left); expectIndependent(node.right); }
    }
    remember(first);
    expectIndependent(second);
    build([box(-1000, -1000, -1000, 1000, 1000, 1000)], 1);
    expectQueries(first, bounds, queries);
    expectQueries(second, bounds, queries);
    expect(bounds).toEqual(before);
    for (let i = 0; i < bounds.length; i++) expect(bounds[i]).toBe(originals[i]);
  });

  test(`${name}: leaf arrays work with collision-world packing and transfer`, async () => {
    const {bounds, queries} = randomFixture(109, 79);
    for (const brush of bounds) brush.planes = [];
    const tree = {bounds, root: build(bounds, 5)};
    const map = {brushes: bounds, displacementTriangles: []};
    const world = {brushes: bounds, triangles: map.displacementTriangles, triangleBounds: [], tree};
    const packet = await packCollisionWorld(map, world, {yieldTask: async () => {}});
    expect(packet).not.toBeNull();
    const transfer = [...new Set(Object.values(packet).filter(ArrayBuffer.isView).map(view => view.buffer))];
    const received = structuredClone(packet, {transfer});
    const snapshot = unpackCollisionWorld(received);
    expect(snapshot).not.toBeNull();
    for (const query of queries) expect(snapshot.tree.query(query)).toEqual(bruteForce(bounds, query));
    expectTree(tree.root, bounds, 5);
    expectQueries(tree.root, bounds, queries);
  });

  test(`${name}: unsupported thresholds and malformed input request native fallback`, () => {
    const valid = [box(0, 0, 0, 1, 1, 1)];
    for (const leafSize of [null, false, true, 0, -0, -1, .5, 1.5, NaN, Infinity, -Infinity,
      '1', {}, 1n, Number.MAX_SAFE_INTEGER + 1]) {
      expect(build(valid, leafSize)).toBeUndefined();
      expect(build([], leafSize)).toBeUndefined();
    }
    const invalid = [undefined, null, false, 1, 'bounds', {}, {0: valid[0], length: 1},
      new Float64Array(6), new Array(1), [undefined], [null], [{}], [{min: point(0, 0, 0)}],
      [{max: point(1, 1, 1)}], [{min: null, max: point(1, 1, 1)}],
      [{min: point(0, 0, 0), max: {x: 1, y: 1}}]];
    for (const bounds of invalid) expect(build(bounds)).toBeUndefined();
    for (const side of ['min', 'max']) for (const axis of axes) {
      for (const value of [NaN, Infinity, -Infinity, undefined, null, '0', false, 0n]) {
        const bad = box(0, 0, 0, 1, 1, 1);
        bad[side][axis] = value;
        expect(build([valid[0], bad])).toBeUndefined();
      }
    }
    expect(valid).toEqual([box(0, 0, 0, 1, 1, 1)]);
  });

  test(`${name}: overflowing center sums request native fallback rather than change comparisons`, () => {
    for (const axis of axes) for (const sign of [-1, 1]) {
      const bound = box(0, 0, 0, 1, 1, 1);
      bound.min[axis] = sign * Number.MAX_VALUE;
      bound.max[axis] = sign * Number.MAX_VALUE;
      expect(build([bound], 1)).toBeUndefined();
      expect(build([box(0, 0, 0), bound], 1)).toBeUndefined();
    }
  });
}
