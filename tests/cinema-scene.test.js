import {describe, expect, test} from 'bun:test';
import {createCinemaScene, RUN_COLORS} from '../src/cinema-scene.js';
import {createTrack} from '../src/cinema-track.js';

function trackAt(xs) {
  const track = createTrack(xs.length, 0.1);
  for (let i = 0; i < xs.length; i++) track.position.set([xs[i], 0, 0], i * 3);
  return track;
}

// Exercise scene ownership and the geometry handed to Three, without replacing
// the production scene factory. Shader appearance is covered by native smoke.
function rendererRig({badGhost = -1, failMaterial = -1, failLineAdd = -1} = {}) {
  const ghosts = [], geometries = [], materials = [];
  let lineAdds = 0;
  class Vector {
    constructor() { this.set(0, 0, 0); }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    project(camera) { return this.set(...camera.projected); }
  }
  class Color {
    constructor(value) { this.set(value); }
    set(value) { this.value = value; }
  }
  class Attribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; }
  }
  class Geometry {
    constructor() { this.attributes = {}; this.disposed = 0; geometries.push(this); }
    setAttribute(name, attribute) { this.attributes[name] = attribute; }
    getAttribute(name) { return this.attributes[name]; }
    setIndex(indices) { this.indices = indices; }
    dispose() { this.disposed++; }
  }
  class Material {
    constructor(options) {
      if (options.vertexShader && materials.filter(item => item.vertexShader).length === failMaterial) throw new Error('material failed');
      Object.assign(this, options);
      this.disposed = 0;
      materials.push(this);
    }
    dispose() { this.disposed++; }
  }
  class Mesh {
    constructor(geometry, material) { this.geometry = geometry; this.material = material; this.position = new Vector(); }
  }
  const sentinel = {name: 'map'};
  const scene = {
    children: [sentinel],
    add(mesh) {
      this.children.push(mesh);
      if (mesh.name === 'surfd-qol-compare-line' && ++lineAdds === failLineAdd) throw new Error('attach failed');
    },
    remove(mesh) { const index = this.children.indexOf(mesh); if (index >= 0) this.children.splice(index, 1); },
  };
  const camera = {position: new Vector(), projectionMatrix: {}, near: 0.5, projected: [0, 0, 0], updateMatrixWorld() {}};
  const renderer = {
    qolScene: scene, qolCamera: camera,
    qolGhost() {
      const geometry = new Geometry();
      geometry.setAttribute('position', new Attribute(new Float32Array(3), 3));
      const uniforms = Object.fromEntries(['deepColor', 'paleColor', 'rimColor'].map(name => [name, {value: new Color('#000000')}]));
      const body = new Mesh(geometry, new Material({uniforms}));
      const outline = {material: {uniforms: {outlineColor: {value: new Color('#000000')}}}};
      const label = {isSprite: true, visible: true};
      const trail = {material: {uniforms: {bandColor: {}}}, visible: true};
      const objects = ghosts.length === badGhost ? [label] : [body, outline, label, trail];
      const group = {name: 'record-ghost', traverse(visit) { for (const object of objects) visit(object); }};
      scene.add(group);
      const ghost = {
        body, label, trail, disposed: 0, updates: [],
        update(frame, far) { this.updates.push({frame: {...frame}, eye: {...far.position}}); },
        dispose() { this.disposed++; scene.remove(group); geometry.dispose(); body.material.dispose(); },
      };
      ghosts.push(ghost);
      return ghost;
    },
  };
  return {renderer, camera, scene, sentinel, ghosts, geometries, materials,
    lines: () => scene.children.filter(mesh => mesh.name === 'surfd-qol-compare-line')};
}

function spans(geometry) {
  const ticks = geometry.getAttribute('tick').array;
  const result = [];
  for (let i = 0; i < geometry.indices.length; i += 6) {
    result.push([ticks[geometry.indices[i]], ticks[geometry.indices[i + 2]]]);
  }
  return result;
}

function vertexAt(geometry, attribute, tick) {
  const index = [...geometry.getAttribute('tick').array].indexOf(tick);
  return [...geometry.getAttribute(attribute).array.slice(index * 3, index * 3 + 3)];
}

describe('cinematic path geometry', () => {
  test('retains both teleport boundaries without connecting or aiming across them', () => {
    const track = trackAt([0, 10, 20, 1000, 1010, 2000, 2010, 2020]);
    track.cut[3] = 1; track.cut[5] = 1;
    const rig = rendererRig(), cinema = createCinemaScene(rig.renderer, [{track}]);
    const geometry = rig.lines()[0].geometry;
    expect(spans(geometry)).toEqual([[0, 2], [3, 4], [5, 6], [6, 7]]);
    expect(vertexAt(geometry, 'next', 2)).toEqual(vertexAt(geometry, 'position', 2));
    expect(vertexAt(geometry, 'prev', 3)).toEqual(vertexAt(geometry, 'position', 3));
    expect(vertexAt(geometry, 'next', 4)).toEqual(vertexAt(geometry, 'position', 4));
    expect(vertexAt(geometry, 'prev', 5)).toEqual(vertexAt(geometry, 'position', 5));
    cinema.dispose();
  });

  test('skips stationary spans and keeps usable tangents on both sides of a stop', () => {
    const track = trackAt([0, 5, 10, 10, 10, 10, 10, 15, 20]);
    const rig = rendererRig(), cinema = createCinemaScene(rig.renderer, [{track}]);
    const geometry = rig.lines()[0].geometry;
    expect(spans(geometry)).toEqual([[0, 2], [6, 8]]);
    expect(vertexAt(geometry, 'prev', 4)[0]).toBe(0);
    expect(vertexAt(geometry, 'next', 4)[0]).toBe(20);
    expect([...geometry.getAttribute('along').array].every(Number.isFinite)).toBe(true);
    cinema.dispose();
  });

  test('does not submit a ribbon for a completely stationary replay', () => {
    const rig = rendererRig(), cinema = createCinemaScene(rig.renderer, [{track: trackAt([1, 1, 1])}]);
    expect(rig.lines().every(mesh => !mesh.visible)).toBe(true);
    expect(spans(rig.lines()[0].geometry)).toEqual([]);
    cinema.dispose();
  });
});

describe('cinematic scene playback', () => {
  test('keeps body and path identities in their stable colour slots after reordering', () => {
    const rig = rendererRig(), track = trackAt([0, 10, 20]);
    const cinema = createCinemaScene(rig.renderer, [{track, colorIndex: 0}, {track, colorIndex: 4}, {track, colorIndex: 2}]);
    for (const [index, slot] of [0, 4, 2].entries()) {
      expect(rig.ghosts[index].body.material.uniforms.deepColor.value.value).toBe(RUN_COLORS[slot].body);
      expect(rig.lines()[index * 3].material.uniforms.color.value.value).toBe(RUN_COLORS[slot].line);
    }
    cinema.dispose();
    const reordered = createCinemaScene(rig.renderer, [{track, colorIndex: 2}, {track, colorIndex: 4}]);
    expect(rig.lines()[0].material.uniforms.color.value.value).toBe(RUN_COLORS[2].line);
    expect(rig.lines()[3].material.uniforms.color.value.value).toBe(RUN_COLORS[4].line);
    reordered.dispose();
  });

  test('freezes paused streaks and restores their phase when seeking back', () => {
    const rig = rendererRig(), cinema = createCinemaScene(rig.renderer, [{track: trackAt([0, 10, 20, 30, 40])}]);
    const phase = () => rig.lines().map(mesh => mesh.material.uniforms.time.value);
    cinema.update([2.5], 1280, 720);
    const first = phase();
    expect(first).toEqual([0.25, 0.25, 0.25]);
    cinema.update([2.5], 1280, 720);
    expect(phase()).toEqual(first);
    cinema.update([3.5], 1280, 720);
    expect(phase()[0]).toBeCloseTo(0.35);
    cinema.update([2.5], 1280, 720);
    expect(phase()).toEqual(first);
    cinema.dispose();
  });

  test('keeps a ghost solid when the camera is exactly at its centre and hides native duplicates', () => {
    const rig = rendererRig(), cinema = createCinemaScene(rig.renderer, [{track: trackAt([0, 0, 0])}]);
    rig.camera.position.set(0, 36, 0);
    cinema.update([1], 1280, 720);
    const eye = rig.ghosts[0].updates[0].eye;
    expect(Math.hypot(eye.x, eye.y - 36, eye.z)).toBeGreaterThanOrEqual(140);
    expect(rig.ghosts[0].label.visible).toBe(false);
    expect(rig.ghosts[0].trail.visible).toBe(false);
    rig.camera.projected = [NaN, Infinity, 0];
    expect(cinema.labels(1280, 720)).toEqual([null]);
    cinema.dispose();
  });
});

describe('cinematic scene resource ownership', () => {
  test.each([
    [{badGhost: 1}, 'The game’s ghost changed shape.'],
    [{failMaterial: 4}, 'material failed'],
    [{failLineAdd: 5}, 'attach failed'],
  ])('releases earlier and partially-created parts after a creation failure (%j)', (options, message) => {
    const rig = rendererRig(options), track = trackAt([0, 10, 20]);
    expect(() => createCinemaScene(rig.renderer, [{track}, {track}])).toThrow(message);
    expect(rig.scene.children).toEqual([rig.sentinel]);
    expect(rig.ghosts.every(ghost => ghost.disposed === 1)).toBe(true);
    expect(rig.geometries.every(geometry => geometry.disposed === 1)).toBe(true);
    expect(rig.materials.every(material => material.disposed === 1)).toBe(true);
  });

  test('disposal releases shared ribbon geometry once and is safe to repeat', () => {
    const rig = rendererRig(), cinema = createCinemaScene(rig.renderer, [{track: trackAt([0, 10, 20])}]);
    cinema.dispose();
    cinema.dispose();
    expect(rig.scene.children).toEqual([rig.sentinel]);
    expect(rig.geometries.every(geometry => geometry.disposed === 1)).toBe(true);
    expect(rig.materials.every(material => material.disposed === 1)).toBe(true);
    expect(rig.ghosts[0].disposed).toBe(1);
  });
});
