import {describe, expect, test} from 'bun:test';
import {cameraBoundsQuery} from '../src/cinema.js';
import {planCamera} from '../src/cinema-camera.js';
import {createTrack} from '../src/cinema-track.js';

const axes = ['x', 'y', 'z'];
function boundsQuery(solids) {
  return bounds => solids.filter(solid => axes.every(axis => bounds.max[axis] >= solid.min[axis] && bounds.min[axis] <= solid.max[axis]));
}
const solid = (x, y, z, radius = 0.1) => ({min: {x: x - radius, y: y - radius, z: z - radius}, max: {x: x + radius, y: y + radius, z: z + radius}});

describe('camera swept-region empty certificates', () => {
  test('includes the interior of diagonal sightline motion, not only its eye chord', () => {
    const mayHit = cameraBoundsQuery(boundsQuery([solid(50, 50, 40)]));
    // Eye chord lies at y=100; bodies move along y=0. Their ruled surface
    // crosses the solid even though neither the eye nor body chord does.
    expect(mayHit([{x: 0, y: 100, z: 40}, {x: 100, y: 100, z: 40}, {x: 0, y: 0, z: 40}, {x: 100, y: 0, z: 40}])).toBe(true);
    expect(mayHit([{x: 0, y: 100, z: 40}, {x: 100, y: 100, z: 40}])).toBe(false);
  });

  test('includes another group member and probe/epsilon boundary contact', () => {
    const mayHit = cameraBoundsQuery(boundsQuery([solid(50, 106.03125, 40, 0)]));
    // The opaque surface is beyond the probe alone, but within the native
    // trace's .03125-unit tolerance. It must not be certified empty.
    expect(mayHit([{x: 0, y: 100, z: 40}, {x: 100, y: 100, z: 40}])).toBe(true);
    const group = cameraBoundsQuery(boundsQuery([solid(50, 200, 40)]));
    expect(group([{x: 0, y: 100, z: 40}, {x: 100, y: 100, z: 40}, {x: 0, y: 200, z: 40}, {x: 100, y: 200, z: 40}])).toBe(true);
  });

  test('treats invalid coordinates and unknown query failures conservatively', () => {
    const empty = cameraBoundsQuery(boundsQuery([]));
    for (const points of [[], [{x: NaN, y: 0, z: 0}], [{x: 0, y: Infinity, z: 0}], [{x: 1e20, y: 0, z: 0}]]) expect(empty(points)).toBe(true);
    expect(cameraBoundsQuery(() => { throw new Error('Unavailable native query'); })([{x: 0, y: 0, z: 40}])).toBe(true);
    expect(empty([{x: 0, y: 0, z: 40}, {x: 100, y: 0, z: 40}])).toBe(false);
  });

  test('does not change the public clear-shot plan when empty bounds certify it', async () => {
    const a = createTrack(81, 0.015);
    for (let tick = 0; tick < a.count; tick++) a.position[tick * 3] = tick * 20;
    for (const style of ['cinematic', 'steady']) {
      const expected = await planCamera({a, style, trace: () => 1});
      const trace = Object.assign(() => 1, {mayHit: cameraBoundsQuery(boundsQuery([]))});
      const actual = await planCamera({a, style, trace});
      for (const key of ['eye', 'target', 'fov', 'segment', 'cutTick']) expect(actual[key]).toEqual(expected[key]);
    }
  });
});
