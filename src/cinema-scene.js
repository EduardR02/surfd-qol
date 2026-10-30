// Compare adds the game's own Record Ghost, recoloured, and each run's path.
// Three.js classes come from that ghost rather than the bundle's private names.
import {trackPoint, trackYaw} from './cinema-track.js';

// Keep the line clear of the ramp surface at the player's hips.
const LINE_HEIGHT = 20;
const LINE_STEP = 2;
// The native ghost normally fades near the first-person camera. Cinema needs
// it solid even in tight rooms, so pass a camera farther along the same ray.
const SOLID_FROM = 140;
// Six seconds of tapering light, with a pale core, coloured glow and moving
// streaks; the rest stays faint, with a transparent preview ahead of the ghost.
const TAIL_SECONDS = 6;
const lineVertex = `
uniform vec2 resolution;
uniform float width;
uniform float head;
uniform float rate;
uniform float nearPlane;
attribute vec3 prev;
attribute vec3 next;
attribute float side;
attribute float tick;
attribute float along;
varying float vSide;
varying float vAhead;
varying float vAlong;
void main(){
  vec4 here=projectionMatrix*modelViewMatrix*vec4(position,1.0);
  vec3 a=(modelViewMatrix*vec4(prev,1.0)).xyz;
  vec3 b=(modelViewMatrix*vec4(next,1.0)).xyz;
  // Clip the tangent before perspective division. Clamping a negative clip-w
  // flips it and produces enormous ribbons when the path crosses the camera.
  float plane=-nearPlane;
  if(a.z>plane&&b.z<=plane)a=mix(a,b,(plane-a.z)/(b.z-a.z));
  else if(b.z>plane&&a.z<=plane)b=mix(b,a,(plane-b.z)/(a.z-b.z));
  a.z=min(a.z,plane);b.z=min(b.z,plane);
  vec4 pa=projectionMatrix*vec4(a,1.0);
  vec4 pb=projectionMatrix*vec4(b,1.0);
  vec2 dir=(pb.xy/pb.w-pa.xy/pa.w)*resolution;
  float magnitude=length(dir);
  dir=magnitude>1e-5?dir/magnitude:vec2(1.0,0.0);
  float behind=(head-tick)/rate;
  float taper=behind<0.0?0.28:mix(1.0,0.22,smoothstep(0.0,${TAIL_SECONDS.toFixed(1)},behind));
  here.xy+=vec2(-dir.y,dir.x)*side*width*taper/resolution*here.w;
  vSide=side;vAhead=tick-head;vAlong=along;
  gl_Position=here;
}`;
const lineFragment = `
uniform vec3 color;
uniform float opacity;
uniform float rate;
uniform float time;
uniform float glow;
varying float vSide;
varying float vAhead;
varying float vAlong;
void main(){
  float d=abs(vSide);
  float soft=1.0-smoothstep(0.25,1.0,d);
  if(vAhead>0.0){
    if(glow>0.5)discard;
    float ahead=vAhead/rate;
    gl_FragColor=vec4(color,(0.3-0.2*smoothstep(0.0,6.0,ahead))*soft*opacity);
  }else{
    float behind=-vAhead/rate;
    float tail=1.0-smoothstep(0.0,${TAIL_SECONDS.toFixed(1)},behind);
    float flow=fract(vAlong/260.0-time*1.4);
    float streak=smoothstep(0.0,0.08,flow)*(1.0-smoothstep(0.08,0.55,flow))*tail;
    if(glow>0.5){
      gl_FragColor=vec4(color,pow(1.0-d,2.2)*tail*(0.22+0.2*streak)*opacity);
    }else{
      float core=1.0-smoothstep(0.0,0.4,d);
      vec3 tint=mix(color,vec3(1.0),core*(0.25+0.5*tail+0.25*streak));
      gl_FragColor=vec4(tint*(1.0+0.45*streak),soft*mix(0.26,0.95,tail)*opacity);
    }
  }
  if(gl_FragColor.a<.004)discard;
  #include <colorspace_fragment>
}`;

// Rose, foam, gold, muted pine and paper: the HUD's palette, without purple.
export const RUN_COLORS = [
  {body: '#a66f73', pale: '#fff1ed', rim: '#edc7c5', outline: '#302025', line: '#ebbcba'},
  {body: '#608f99', pale: '#edf6f4', rim: '#b4dce0', outline: '#1c2b30', line: '#9ccfd8'},
  {body: '#ac8654', pale: '#fff3df', rim: '#f3d09c', outline: '#30271d', line: '#f6c177'},
  {body: '#527e73', pale: '#edf4e9', rim: '#a6c8bb', outline: '#1d2c28', line: '#7eaa9e'},
  {body: '#a49e94', pale: '#faf7f0', rim: '#eae5dc', outline: '#2c2a27', line: '#e4ded7'},
];

const extraColors = new Map();

function hslHex(hue, saturation, lightness) {
  const amplitude = saturation * Math.min(lightness, 1 - lightness);
  const channel = offset => {
    const k = (offset + hue / 30) % 12;
    const value = lightness - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

// Stable identity slots, not a run-count limit. Generate only at scene/status
// boundaries; all ghosts, paths and UI chips reuse the same cached swatches.
export function runColors(index) {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('Invalid run colour index.');
  if (index < RUN_COLORS.length) return RUN_COLORS[index];
  let colors = extraColors.get(index);
  if (!colors) {
    // Golden-angle spacing across terracotta/gold, sage/foam/blue and rose.
    // Skip both purple and acid yellow-green rather than desaturating to white.
    const slot = index - RUN_COLORS.length;
    const arc = ((slot * 0.618033988749895 + 0.12) % 1) * 153;
    const hue = arc < 48 ? arc : arc < 133 ? arc + 92 : arc + 207;
    const shade = (slot * 0.754877666246693) % 1;
    const saturation = 0.36 + 0.08 * ((slot * 0.381966011250105) % 1);
    colors = {
      body: hslHex(hue, saturation * 0.72, 0.42 + shade * 0.035),
      pale: hslHex(hue, 0.24, 0.93),
      rim: hslHex(hue, saturation * 0.8, 0.79),
      outline: hslHex(hue, 0.22, 0.145),
      line: hslHex(hue, saturation, 0.64 + shade * 0.08),
    };
    extraColors.set(index, colors);
  }
  return colors;
}

function find(group, test) {
  let found = null;
  group.traverse(object => { if (!found && test(object)) found = object; });
  return found;
}

// renderer is the game's map renderer (with qolScene, qolCamera, qolGhost).
// colorIndex is an optional stable palette slot, independent of array order.
export function createCinemaScene(renderer, runs) {
  const scene = renderer.qolScene, camera = renderer.qolCamera;
  const parts = [], disposers = [];
  const dispose = () => {
    let failure;
    while (disposers.length) {
      try { disposers.pop()(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  };
  let three = null, projected, far;
  try {
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index], colors = runColors(run.colorIndex ?? index);
      const before = new Set(scene.children);
      const ghost = renderer.qolGhost();
      // Register ownership immediately: later ghosts or line creation can fail.
      disposers.push(() => ghost.dispose());
      const group = scene.children.find(child => !before.has(child) && child.name === 'record-ghost');
      if (!group) throw new Error('The game’s ghost changed shape.');
      const body = find(group, object => object.material?.uniforms?.deepColor);
      const outline = find(group, object => object.material?.uniforms?.outlineColor);
      const label = find(group, object => object.isSprite);
      const trail = find(group, object => object.material?.uniforms?.bandColor);
      if (!body || !outline) throw new Error('The game’s ghost changed shape.');
      body.material.uniforms.deepColor.value.set(colors.body);
      body.material.uniforms.paleColor.value.set(colors.pale);
      body.material.uniforms.rimColor.value.set(colors.rim);
      outline.material.uniforms.outlineColor.value.set(colors.outline);
      three ??= {Mesh: body.constructor, Geometry: body.geometry.constructor, Attribute: body.geometry.getAttribute('position').constructor,
        Material: body.material.constructor, Color: body.material.uniforms.deepColor.value.constructor, Vector: body.position.constructor};
      const line = createLine(three, run.track, colors.line);
      disposers.push(() => {
        for (const mesh of line.meshes) scene.remove(mesh);
        line.dispose();
      });
      for (const mesh of line.meshes) scene.add(mesh);
      parts.push({run, ghost, label, trail, line,
        frame: {x: 0, y: 0, z: 0, yaw: 0, ducked: false, opacity: 1, trail: new Float32Array(0), trailCount: 0, label: ''}});
    }
    if (three) {
      projected = new three.Vector();
      far = {position: new three.Vector(), projectionMatrix: camera.projectionMatrix};
    }
  } catch (error) {
    try { dispose(); } catch { /* Preserve the creation failure after cleaning every part. */ }
    throw error;
  }
  return {
    // at: each run's fractional track index; width/height: canvas CSS pixels.
    update(at, width, height) {
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index], track = part.run.track;
        const tick = Math.max(0, Math.min(track.count - 1, at[index]));
        const frame = trackPoint(track, tick, part.frame);
        frame.yaw = trackYaw(track, tick);
        frame.ducked = track.ducked[Math.round(tick)] === 1;
        const eye = camera.position, gx = frame.x, gy = frame.z + 36, gz = -frame.y;
        const dx = eye.x - gx, dy = eye.y - gy, dz = eye.z - gz;
        const distance = Math.hypot(dx, dy, dz);
        const away = Math.max(1, SOLID_FROM / (distance || 1));
        // At exactly the ghost's centre there is no ray to scale.
        far.position.set(gx + (distance ? dx * away : SOLID_FROM), gy + dy * away, gz + dz * away);
        part.ghost.update(frame, far, height);
        // Names come from the overlay; the native trail would duplicate ours.
        if (part.label) part.label.visible = false;
        if (part.trail) part.trail.visible = false;
        part.line.set(tick, width, height, camera.near);
      }
    },
    // Where each ghost's head is on screen in CSS pixels, null when off screen.
    labels(width, height) {
      camera.updateMatrixWorld();
      return parts.map(({frame}) => {
        projected.set(frame.x, frame.z + (frame.ducked ? 56 : 74), -frame.y).project(camera);
        if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || !Number.isFinite(projected.z) ||
            projected.z > 1 || projected.z < -1 || Math.abs(projected.x) > 1.05 || Math.abs(projected.y) > 1.05) return null;
        return {x: (projected.x + 1) / 2 * width, y: (1 - projected.y) / 2 * height};
      });
    },
    dispose,
  };
}

// A fixed-pixel ribbon: depth-tested colour, subtle additive glow, and a faint
// through-wall thread. All three share geometry and the replay-time uniforms.
function createLine(three, track, color) {
  const points = [];
  for (let tick = 0; tick < track.count; tick++) {
    // Include both sides of every cut, even between the regular samples.
    if (tick % LINE_STEP === 0 || tick === track.count - 1 || track.cut[tick] || track.cut[tick + 1]) points.push(tick);
  }
  const n = points.length;
  const world = new Float32Array(n * 3), distance = new Float32Array(n), linked = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const source = points[i] * 3, target = i * 3;
    world[target] = track.position[source];
    world[target + 1] = track.position[source + 2] + LINE_HEIGHT;
    world[target + 2] = -track.position[source + 1];
    if (i && !track.cut[points[i]]) {
      linked[i] = 1;
      distance[i] = Math.hypot(world[target] - world[target - 3], world[target + 1] - world[target - 2], world[target + 2] - world[target - 1]);
    }
  }
  // Tangents stop at teleports and skip stationary samples, in linear time.
  const before = new Uint32Array(n), after = new Uint32Array(n);
  let neighbor = 0;
  for (let i = 0; i < n; i++) {
    if (!linked[i]) neighbor = i;
    else if (distance[i] > 1e-5) neighbor = i - 1;
    before[i] = neighbor;
  }
  neighbor = n - 1;
  for (let i = n - 1; i >= 0; i--) {
    if (i === n - 1 || !linked[i + 1]) neighbor = i;
    else if (distance[i + 1] > 1e-5) neighbor = i + 1;
    after[i] = neighbor;
  }
  const position = new Float32Array(n * 6), prev = new Float32Array(n * 6), next = new Float32Array(n * 6);
  const side = new Float32Array(n * 2), tick = new Float32Array(n * 2), along = new Float32Array(n * 2);
  const indices = [];
  let travelled = 0;
  for (let i = 0; i < n; i++) {
    travelled += distance[i];
    for (let k = 0; k < 2; k++) {
      const vertex = i * 2 + k;
      for (let axis = 0; axis < 3; axis++) {
        position[vertex * 3 + axis] = world[i * 3 + axis];
        prev[vertex * 3 + axis] = world[before[i] * 3 + axis];
        next[vertex * 3 + axis] = world[after[i] * 3 + axis];
      }
      side[vertex] = k ? -1 : 1;
      tick[vertex] = points[i];
      along[vertex] = travelled;
    }
    // Zero-length spans draw no pixels, and must not form degenerate joins.
    if (linked[i] && distance[i] > 1e-5) {
      const v = (i - 1) * 2;
      indices.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
  }
  const geometry = new three.Geometry(), materials = [];
  const dispose = () => { geometry.dispose(); for (const material of materials) material.dispose(); };
  try {
    geometry.setAttribute('position', new three.Attribute(position, 3));
    geometry.setAttribute('prev', new three.Attribute(prev, 3));
    geometry.setAttribute('next', new three.Attribute(next, 3));
    geometry.setAttribute('side', new three.Attribute(side, 1));
    geometry.setAttribute('tick', new three.Attribute(tick, 1));
    geometry.setAttribute('along', new three.Attribute(along, 1));
    geometry.setIndex(indices);
    const uniforms = {color: {value: new three.Color(color)},
      head: {value: 0}, rate: {value: 1 / track.dt}, time: {value: 0}, nearPlane: {value: 0.1},
      resolution: {value: {x: 1, y: 1, isVector2: true}}};
    const material = (opacity, depthTest, width, glow = 0) => {
      const result = new three.Material({
        vertexShader: lineVertex, fragmentShader: lineFragment, transparent: true, depthWrite: false, depthTest,
        uniforms: {...uniforms, opacity: {value: opacity}, width: {value: width}, glow: {value: glow}},
        // Three's AdditiveBlending: the halo brightens without hiding the map.
        ...glow ? {blending: 2} : {},
      });
      materials.push(result);
      return result;
    };
    const solid = material(1, true, 8), xray = material(0.18, false, 5), halo = material(1, true, 26, 1);
    const meshes = [new three.Mesh(geometry, xray), new three.Mesh(geometry, halo), new three.Mesh(geometry, solid)];
    for (let i = 0; i < meshes.length; i++) {
      meshes[i].renderOrder = 30 + i;
      meshes[i].frustumCulled = false;
      meshes[i].visible = indices.length > 0;
      meshes[i].name = 'surfd-qol-compare-line';
    }
    return {
      meshes,
      set(head, width, height, near = 0.1) {
        uniforms.head.value = head;
        uniforms.time.value = head * track.dt;
        uniforms.nearPlane.value = near;
        uniforms.resolution.value.x = Math.max(1, width);
        uniforms.resolution.value.y = Math.max(1, height);
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
