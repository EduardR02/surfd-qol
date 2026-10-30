// What Compare adds to the game's world scene: two ghosts and each run's
// line through the map. The ghosts are the game's own Record Ghost, recoloured,
// so they look like the ghosts players already know. Three.js classes are
// taken from that ghost's objects rather than from the bundle's private names.
import {trackPoint, trackYaw} from './cinema-track.js';

// Lines run at hip height, clear of the ramp surface the player slides on.
const LINE_HEIGHT = 20;
const LINE_STEP = 2;
// The path ahead of a ghost stays faintly visible this far; behind it is solid.
const AHEAD_SECONDS = 6;

const lineVertex = `
uniform vec2 resolution;
uniform float width;
uniform float head;
attribute vec3 prev;
attribute vec3 next;
attribute float side;
attribute float tick;
varying float vSide;
varying float vAhead;
void main(){
  vec4 here=projectionMatrix*modelViewMatrix*vec4(position,1.0);
  vec4 a=projectionMatrix*modelViewMatrix*vec4(prev,1.0);
  vec4 b=projectionMatrix*modelViewMatrix*vec4(next,1.0);
  vec2 dir=(b.xy/max(b.w,1e-3)-a.xy/max(a.w,1e-3))*resolution;
  dir=length(dir)>1e-5?normalize(dir):vec2(1.0,0.0);
  float w=width*(tick<=head?1.0:0.62);
  here.xy+=vec2(-dir.y,dir.x)*side*w/resolution*here.w;
  vSide=side;vAhead=tick-head;
  gl_Position=here;
}`;
const lineFragment = `
uniform vec3 color;
uniform float opacity;
uniform float ahead;
varying float vSide;
varying float vAhead;
void main(){
  float edge=1.0-smoothstep(0.45,1.0,abs(vSide));
  float soon=1.0-smoothstep(0.0,ahead,vAhead);
  float alpha=vAhead<=0.0?0.92:0.16+0.3*soon;
  vec3 tint=color*mix(1.0,1.35,(1.0-abs(vSide))*step(vAhead,0.0));
  gl_FragColor=vec4(tint,alpha*edge*opacity);
  if(gl_FragColor.a<.004)discard;
  #include <colorspace_fragment>
}`;

// colors: {body, pale, rim, outline, line} as #rrggbb.
export const RUN_COLORS = [
  {body: '#b9781f', pale: '#fff3de', rim: '#ffcf7a', outline: '#2a1704', line: '#f6c177'},
  {body: '#2f9bbd', pale: '#effdff', rim: '#9ff3ff', outline: '#03222d', line: '#5fd3f3'},
];

function find(group, test) {
  let found = null;
  group.traverse(object => { if (!found && test(object)) found = object; });
  return found;
}

// renderer is the game's map renderer (with qolScene, qolCamera, qolGhost);
// runs is [{track}, {track}] in RUN_COLORS order.
export function createCinemaScene(renderer, runs) {
  const scene = renderer.qolScene, camera = renderer.qolCamera;
  const parts = [], disposers = [];
  let three = null;
  for (const [index, run] of runs.entries()) {
    const before = new Set(scene.children);
    const ghost = renderer.qolGhost();
    const group = scene.children.find(child => !before.has(child) && child.name === 'record-ghost');
    if (!group) { ghost.dispose(); throw new Error('The game’s ghost changed shape.'); }
    const colors = RUN_COLORS[index];
    const body = find(group, object => object.material?.uniforms?.deepColor);
    const outline = find(group, object => object.material?.uniforms?.outlineColor);
    const label = find(group, object => object.isSprite);
    const trail = find(group, object => object.material?.uniforms?.bandColor);
    if (!body || !outline) { ghost.dispose(); throw new Error('The game’s ghost changed shape.'); }
    body.material.uniforms.deepColor.value.set(colors.body);
    body.material.uniforms.paleColor.value.set(colors.pale);
    body.material.uniforms.rimColor.value.set(colors.rim);
    outline.material.uniforms.outlineColor.value.set(colors.outline);
    three ??= {Mesh: body.constructor, Geometry: body.geometry.constructor, Attribute: body.geometry.getAttribute('position').constructor,
      Material: body.material.constructor, Color: body.material.uniforms.deepColor.value.constructor, Vector: body.position.constructor};
    const line = createLine(three, run.track, colors.line);
    for (const mesh of line.meshes) scene.add(mesh);
    parts.push({run, ghost, label, trail, line, frame: {x: 0, y: 0, z: 0, yaw: 0, ducked: false, opacity: 1, trail: new Float32Array(0), trailCount: 0, label: ''}, point: {x: 0, y: 0, z: 0}});
    disposers.push(() => { ghost.dispose(); for (const mesh of line.meshes) scene.remove(mesh); line.dispose(); });
  }
  const projected = new three.Vector();
  return {
    // at: each run's fractional track index; height: the canvas's CSS height.
    update(at, width, height) {
      for (const [index, part] of parts.entries()) {
        const track = part.run.track, tick = at[index];
        trackPoint(track, tick, part.point);
        Object.assign(part.frame, part.point);
        part.frame.yaw = trackYaw(track, tick);
        part.frame.ducked = track.ducked[Math.round(Math.max(0, Math.min(track.count - 1, tick)))] === 1;
        part.ghost.update(part.frame, camera, height);
        // Names are drawn by the extension's overlay instead, in each run's colour.
        if (part.label) part.label.visible = false;
        if (part.trail) part.trail.visible = false;
        part.line.set(tick, width, height);
      }
    },
    // Where each ghost's head is on screen in CSS pixels, null when off screen.
    labels(width, height) {
      camera.updateMatrixWorld();
      return parts.map(part => {
        projected.set(part.point.x, part.point.z + 82, -part.point.y).project(camera);
        if (projected.z > 1 || projected.z < -1 || Math.abs(projected.x) > 1.05 || Math.abs(projected.y) > 1.05) return null;
        return {x: (projected.x + 1) / 2 * width, y: (1 - projected.y) / 2 * height};
      });
    },
    dispose() { for (const dispose of disposers.splice(0)) dispose(); },
  };
}

// One run's path as a ribbon a fixed number of pixels wide, drawn twice: once
// depth-tested, and once faintly through walls so a line behind a ramp is
// still there to follow.
function createLine(three, track, color) {
  const points = [];
  for (let tick = 0; tick < track.count; tick += LINE_STEP) points.push(tick);
  if (points.at(-1) !== track.count - 1) points.push(track.count - 1);
  const n = points.length, point = {x: 0, y: 0, z: 0};
  const position = new Float32Array(n * 6), prev = new Float32Array(n * 6), next = new Float32Array(n * 6);
  const side = new Float32Array(n * 2), tick = new Float32Array(n * 2);
  const at = i => { trackPoint(track, points[i], point); return [point.x, point.z + LINE_HEIGHT, -point.y]; };
  const world = points.map((_, i) => at(i));
  for (let i = 0; i < n; i++) {
    const before = world[Math.max(0, i - 1)], after = world[Math.min(n - 1, i + 1)];
    for (let k = 0; k < 2; k++) {
      position.set(world[i], (i * 2 + k) * 3);
      prev.set(before, (i * 2 + k) * 3);
      next.set(after, (i * 2 + k) * 3);
      side[i * 2 + k] = k ? -1 : 1;
      tick[i * 2 + k] = points[i];
    }
  }
  // A teleport breaks the line instead of drawing straight across the map.
  const indices = [];
  for (let i = 0; i + 1 < n; i++) {
    let cut = false;
    for (let k = points[i] + 1; k <= points[i + 1] && !cut; k++) cut = track.cut[k] === 1;
    if (cut) continue;
    const v = i * 2;
    indices.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
  }
  const geometry = new three.Geometry();
  geometry.setAttribute('position', new three.Attribute(position, 3));
  geometry.setAttribute('prev', new three.Attribute(prev, 3));
  geometry.setAttribute('next', new three.Attribute(next, 3));
  geometry.setAttribute('side', new three.Attribute(side, 1));
  geometry.setAttribute('tick', new three.Attribute(tick, 1));
  geometry.setIndex(indices);
  const material = (opacity, depthTest, width) => new three.Material({
    vertexShader: lineVertex, fragmentShader: lineFragment, transparent: true, depthWrite: false, depthTest,
    uniforms: {color: {value: new three.Color(color)}, opacity: {value: opacity}, width: {value: width}, head: {value: 0},
      ahead: {value: AHEAD_SECONDS / track.dt}, resolution: {value: {x: 1, y: 1, isVector2: true}}},
  });
  const solid = material(1, true, 3.4), xray = material(0.2, false, 2.4);
  const meshes = [new three.Mesh(geometry, xray), new three.Mesh(geometry, solid)];
  meshes[0].renderOrder = 30; meshes[1].renderOrder = 31;
  for (const mesh of meshes) { mesh.frustumCulled = false; mesh.name = 'surfd-qol-compare-line'; }
  return {
    meshes,
    set(head, width, height) {
      for (const {material: m} of meshes) {
        m.uniforms.head.value = head;
        m.uniforms.resolution.value.x = width;
        m.uniforms.resolution.value.y = height;
      }
    },
    dispose() { geometry.dispose(); solid.dispose(); xray.dispose(); },
  };
}
