import {describe, expect, test} from 'bun:test';
import {createCinemaScene, RUN_COLORS, runColors} from '../src/cinema-scene.js';
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
    expect([...geometry.getAttribute('along').array]).toEqual([0, 0, 20, 20, 20, 20, 30, 30, 30, 30, 40, 40, 50, 50]);
    cinema.dispose();
  });

  test('skips stationary spans and keeps usable tangents on both sides of a stop', () => {
    const track = trackAt([0, 5, 10, 10, 10, 10, 10, 15, 20]);
    const rig = rendererRig(), cinema = createCinemaScene(rig.renderer, [{track}]);
    const geometry = rig.lines()[0].geometry;
    expect(spans(geometry)).toEqual([[0, 2], [6, 8]]);
    expect(vertexAt(geometry, 'prev', 4)[0]).toBe(0);
    expect(vertexAt(geometry, 'next', 4)[0]).toBe(20);
    expect([...geometry.getAttribute('along').array]).toEqual([0, 0, 10, 10, 10, 10, 10, 10, 20, 20]);
    for (const attribute of ['position', 'prev', 'next']) {
      expect([...geometry.getAttribute(attribute).array].every(Number.isFinite)).toBe(true);
    }
    cinema.dispose();
  });

  test('does not submit a ribbon for a completely stationary replay', () => {
    const rig = rendererRig(), cinema = createCinemaScene(rig.renderer, [{track: trackAt([1, 1, 1])}]);
    expect(rig.lines().every(mesh => !mesh.visible)).toBe(true);
    expect(spans(rig.lines()[0].geometry)).toEqual([]);
    cinema.dispose();
  });

  test('keeps both ribbon edges on the recorded three-dimensional centreline before projection', () => {
    const track = trackAt([0, 12, 24, 36, 48]);
    track.position.set([24, 30, 40], 6);
    track.position.set([48, 80, 10], 12);
    const rig = rendererRig(), cinema = createCinemaScene(rig.renderer, [{track}]);
    const geometry = rig.lines()[0].geometry;
    const positions = geometry.getAttribute('position').array;
    expect([...positions]).toEqual([
      0, 20, -0, 0, 20, -0,
      24, 60, -30, 24, 60, -30,
      48, 30, -80, 48, 30, -80,
    ]);
    expect([...geometry.getAttribute('side').array]).toEqual([1, -1, 1, -1, 1, -1]);
    expect(spans(geometry)).toEqual([[0, 2], [2, 4]]);
    expect(vertexAt(geometry, 'prev', 2)).toEqual([0, 20, -0]);
    expect(vertexAt(geometry, 'next', 2)).toEqual([48, 30, -80]);
    const materials = rig.lines().map(mesh => mesh.material);
    cinema.update([2], 1280, 720);
    cinema.update([3.75], 640, 360);
    expect(geometry.getAttribute('position').array).toBe(positions);
    expect([...positions]).toEqual([
      0, 20, -0, 0, 20, -0,
      24, 60, -30, 24, 60, -30,
      48, 30, -80, 48, 30, -80,
    ]);
    expect(rig.lines().map(mesh => mesh.material)).toEqual(materials);
    cinema.dispose();
  });
});

describe('cinematic run palette', () => {
  test('preserves the five original identities exactly', () => {
    expect(Array.from({length: 5}, (_, index) => runColors(index))).toEqual([
      {body: '#a66f73', pale: '#fff1ed', rim: '#edc7c5', outline: '#302025', line: '#ebbcba'},
      {body: '#608f99', pale: '#edf6f4', rim: '#b4dce0', outline: '#1c2b30', line: '#9ccfd8'},
      {body: '#ac8654', pale: '#fff3df', rim: '#f3d09c', outline: '#30271d', line: '#f6c177'},
      {body: '#527e73', pale: '#edf4e9', rim: '#a6c8bb', outline: '#1d2c28', line: '#7eaa9e'},
      {body: '#a49e94', pale: '#faf7f0', rim: '#eae5dc', outline: '#2c2a27', line: '#e4ded7'},
    ]);
  });

  test('extends stable, cached identities without white fallbacks or purple hues', () => {
    const channels = hex => hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255);
    const slots = [...Array.from({length: 48}, (_, index) => index), 10000];
    const colors = slots.map(runColors);
    expect(new Set(colors.map(color => color.line)).size).toBe(slots.length);
    for (let index = 5; index < slots.length; index++) {
      const color = colors[index];
      expect(runColors(slots[index])).toBe(color);
      for (const value of Object.values(color)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
      const [r, g, b] = channels(color.line);
      const low = Math.min(r, g, b), high = Math.max(r, g, b), span = high - low;
      const hue = high === r ? ((g - b) / span + 6) % 6 * 60 :
        high === g ? ((b - r) / span + 2) * 60 : ((r - g) / span + 4) * 60;
      expect(hue <= 49 || (hue >= 139 && hue <= 226) || hue >= 339).toBe(true);
      expect(span).toBeGreaterThan(0.18);
      expect(low).toBeLessThan(0.7);
      expect(Math.min(...channels(color.pale))).toBeGreaterThan(high);
      expect(Math.max(...channels(color.outline))).toBeLessThan(low);
    }
  });

  test('colours uncapped and reordered ghosts and paths with the same identity', () => {
    const rig = rendererRig(), track = trackAt([0, 10, 20]);
    const slots = [10000, 5, 13, 8, 0, 42, 6, 2];
    const cinema = createCinemaScene(rig.renderer, slots.map(colorIndex => ({track, colorIndex})));
    cinema.update(slots.map(() => 1.5), 1280, 720);
    for (const [index, slot] of slots.entries()) {
      expect(rig.ghosts[index].body.material.uniforms.deepColor.value.value).toBe(runColors(slot).body);
      for (const mesh of rig.lines().slice(index * 3, index * 3 + 3)) {
        expect(mesh.material.uniforms.color.value.value).toBe(runColors(slot).line);
      }
    }
    cinema.dispose();
    expect(rig.scene.children).toEqual([rig.sentinel]);
    expect(rig.geometries.every(geometry => geometry.disposed === 1)).toBe(true);
    expect(rig.materials.every(material => material.disposed === 1)).toBe(true);
  });

  test.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid identity slot (%s)', index => {
    expect(() => runColors(index)).toThrow(RangeError);
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

  test('freezes the comet at the interpolated player position and restores it when seeking back', () => {
    const rig = rendererRig(), cinema = createCinemaScene(rig.renderer, [{track: trackAt([0, 10, 20, 30, 40])}]);
    const state = () => ({
      clocks: rig.lines().map(mesh => {
        const {head, rate, time} = mesh.material.uniforms;
        return {tick: head.value, seconds: head.value / rate.value, flow: time.value};
      }),
      player: rig.ghosts[0].updates.at(-1).frame.x,
    });
    cinema.update([2.5], 1280, 720);
    const first = state();
    expect(first).toEqual({
      clocks: Array.from({length: 3}, () => ({tick: 2.5, seconds: 0.25, flow: 0.25})),
      player: 25,
    });
    cinema.update([2.5], 1280, 720);
    expect(state()).toEqual(first);
    cinema.update([3.5], 1280, 720);
    expect(state().player).toBe(35);
    expect(state().clocks[0].seconds).toBeCloseTo(0.35);
    cinema.update([2.5], 1280, 720);
    expect(state()).toEqual(first);
    cinema.dispose();
  });

  test('uses each run’s sample rate and clamps comet and player together at either endpoint', () => {
    const fast = trackAt(Array.from({length: 41}, (_, index) => index * 10));
    fast.dt = 0.05;
    const slow = trackAt(Array.from({length: 41}, (_, index) => index * 20));
    const rig = rendererRig(), cinema = createCinemaScene(rig.renderer, [{track: fast}, {track: slow}]);
    const clocks = () => rig.lines().map(mesh => {
      const {head, rate, time} = mesh.material.uniforms;
      expect(time.value).toBeCloseTo(head.value / rate.value);
      return time.value;
    });
    cinema.update([15, 7.5], 1280, 720);
    expect(clocks()).toEqual(Array(6).fill(0.75));
    expect(rig.ghosts.map(ghost => ghost.updates.at(-1).frame.x)).toEqual([150, 150]);
    cinema.update([-10, 80], 1280, 720);
    expect(clocks()).toEqual([0, 0, 0, 4, 4, 4]);
    expect(rig.ghosts.map(ghost => ghost.updates.at(-1).frame.x)).toEqual([0, 800]);
    cinema.update([15, 7.5], 1280, 720);
    expect(clocks()).toEqual(Array(6).fill(0.75));
    expect(rig.ghosts.map(ghost => ghost.updates.at(-1).frame.x)).toEqual([150, 150]);
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

describe('cinematic replay resource reuse', () => {
  test('seeks across teleports without replacing geometry, attributes or materials', () => {
    const track = trackAt([0, 10, 20, 1000, 1010]);
    track.cut[3] = 1;
    const rig = rendererRig(), cinema = createCinemaScene(rig.renderer, [{track}, {track, colorIndex: 7}]);
    cinema.update([2.5, 1.25], 1440, 900);
    const meshes = rig.lines();
    const geometries = rig.geometries.slice(), materials = rig.materials.slice();
    const states = meshes.map(mesh => ({
      geometry: mesh.geometry, material: mesh.material,
      position: mesh.geometry.getAttribute('position').array,
      along: mesh.geometry.getAttribute('along').array,
      head: mesh.material.uniforms.head.value, rate: mesh.material.uniforms.rate.value,
    }));
    cinema.update([4, 3], 1920, 1080);
    cinema.update([2.5, 1.25], 1440, 900);
    expect(rig.lines()).toEqual(meshes);
    expect(rig.geometries).toEqual(geometries);
    expect(rig.materials).toEqual(materials);
    for (const [index, mesh] of meshes.entries()) {
      expect(mesh.geometry).toBe(states[index].geometry);
      expect(mesh.material).toBe(states[index].material);
      expect(mesh.geometry.getAttribute('position').array).toBe(states[index].position);
      expect(mesh.geometry.getAttribute('along').array).toBe(states[index].along);
      expect(mesh.material.uniforms.head.value).toBe(states[index].head);
      expect(mesh.material.uniforms.rate.value).toBe(states[index].rate);
    }
    expect(spans(meshes[0].geometry)).toEqual([[0, 2], [3, 4]]);
    cinema.dispose();
    cinema.dispose();
    expect(rig.scene.children).toEqual([rig.sentinel]);
    expect(rig.geometries.every(geometry => geometry.disposed === 1)).toBe(true);
    expect(rig.materials.every(material => material.disposed === 1)).toBe(true);
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
