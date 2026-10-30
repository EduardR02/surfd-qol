// Compare adds the game's own Record Ghost, recoloured, and each run's path.
// Three.js classes come from that ghost rather than the bundle's private names.
import {trackPoint, trackYaw} from './cinema-track.js';

// Keep the line clear of the ramp surface at the player's hips.
const LINE_HEIGHT = 20;
const LINE_STEP = 2;
// The native ghost normally fades near the first-person camera. Cinema needs
// it solid even in tight rooms, so pass a camera farther along the same ray.
const SOLID_FROM = 140;
export const DEFAULT_TRAIL_STYLE = 'comet';
export const TRAIL_STYLES = [
  {id: 'comet', label: 'Comet', description: 'A brilliant pearl head pulling a long, tapered tail of colour.'},
  {id: 'pearl', label: 'Pearl', description: 'A crisp white bead with a fine, luminous thread trailing behind.'},
  {id: 'wake', label: 'Wake', description: 'A soft pool of light flowing into a broad, translucent wake.'},
];
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
varying float vSide;
varying float vBehind;
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
  here.xy+=vec2(-dir.y,dir.x)*side*width/resolution*here.w;
  vSide=side;
  vBehind=(head-tick)/rate;
  gl_Position=here;
}`;
const lineFragment = `
uniform vec3 color;
uniform vec3 pale;
uniform float opacity;
uniform float glow;
uniform float width;
uniform float style;
varying float vSide;
varying float vBehind;
// All cross-sections stay centred on the recorded route. The head/tail
// envelope is evaluated per fragment, not per sample, so its taper stays
// smooth even on a fast, sparsely sampled stretch. Distances are CSS pixels.
float stroke(float x,float radius){
  return 1.0-smoothstep(max(0.0,radius-0.5),radius+0.5,x);
}
void main(){
  float age=max(vBehind,0.0);
  float ahead=max(-vBehind,0.0);
  float decay=1.05;
  float reach=4.5;
  float nose=0.12;
  float breadth=2.8;
  float coreWidth=0.65;
  float haloStrength=0.32;
  if(style>0.5&&style<1.5){
    decay=1.65;reach=6.0;nose=0.085;
    breadth=1.65;coreWidth=0.42;haloStrength=0.18;
  }else if(style>1.5){
    decay=1.4;reach=5.5;nose=0.19;
    breadth=4.3;coreWidth=0.85;haloStrength=0.23;
  }
  // One asymmetric travelling envelope: a short rounded nose, a brilliant
  // head at the player, then an uninterrupted exponential tail behind.
  // No wall clock or periodic phase: pause and seek reproduce the same light.
  float frontDistance=ahead/nose;
  float front=exp(-frontDistance*frontDistance);
  float tail=exp(-age/decay)*(1.0-smoothstep(reach*0.7,reach,age))*front;
  float headDistance=vBehind/nose;
  float head=exp(-headDistance*headDistance);
  float x=abs(vSide)*width*0.5;
  if(glow>0.5){
    float radius=1.8+breadth*2.0*sqrt(tail);
    float haze=exp(-2.8*pow(x/radius,2.0));
    float edge=1.0-smoothstep(0.75,1.0,abs(vSide));
    gl_FragColor=vec4(mix(color,pale,head*0.35),
      haze*edge*(tail*0.65+head*0.35)*haloStrength*opacity);
  }else{
    // A quiet route guide survives before and long after the comet. Keeping
    // it fine, coloured and separate from the light makes travel unmistakable.
    float guide=stroke(x,0.55);
    float history=smoothstep(-0.2,0.2,vBehind);
    float guideAlpha=guide*mix(0.25,0.4,history);
    float radius=0.35+breadth*pow(tail,0.65);
    float body=stroke(x,radius)*tail;
    float core=stroke(x,coreWidth+head*0.5);
    vec3 tint=mix(color*0.68,color,tail);
    float light=core*(tail*0.48+head*0.5)+head*body*0.36;
    float alpha=max(guideAlpha,body*0.9);
    if(style>0.5&&style<1.5){
      // Pearl: a sharply resolved bead, then a long hairline of white light.
      light=core*(tail*0.83+head*0.17);
      alpha=max(guideAlpha,max(body*0.7,core*tail*0.95));
    }else if(style>1.5){
      // Wake: a continuous soft shoulder around a narrower bright centre.
      float velvet=exp(-2.4*pow(x/max(radius,0.35),2.0));
      body=velvet*tail;
      light=core*(tail*0.32+head*0.6);
      alpha=max(guideAlpha,body*0.8);
    }
    tint=mix(tint,pale,clamp(light,0.0,1.0));
    gl_FragColor=vec4(tint,alpha*opacity);
  }
  if(gl_FragColor.a<0.004)discard;
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
  const style = {value: 0};
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
      const line = createLine(three, run.track, colors, style);
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
    setTrailStyle(id) {
      const index = TRAIL_STYLES.findIndex(option => option.id === id);
      if (index >= 0) style.value = index;
    },
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
function createLine(three, track, colors, style) {
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
  const side = new Float32Array(n * 2), tick = new Float32Array(n * 2);
  const indices = [];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 2; k++) {
      const vertex = i * 2 + k;
      for (let axis = 0; axis < 3; axis++) {
        position[vertex * 3 + axis] = world[i * 3 + axis];
        prev[vertex * 3 + axis] = world[before[i] * 3 + axis];
        next[vertex * 3 + axis] = world[after[i] * 3 + axis];
      }
      side[vertex] = k ? -1 : 1;
      tick[vertex] = points[i];
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
    geometry.setIndex(indices);
    const uniforms = {color: {value: new three.Color(colors.line)}, pale: {value: new three.Color(colors.pale)}, style,
      head: {value: 0}, rate: {value: 1 / track.dt}, nearPlane: {value: 0.1},
      resolution: {value: {x: 1, y: 1, isVector2: true}}};
    const material = (opacity, depthTest, width, glow = 0) => {
      const result = new three.Material({
        vertexShader: lineVertex, fragmentShader: lineFragment, transparent: true, depthWrite: false, depthTest,
        uniforms: {...uniforms, opacity: {value: opacity}, width: {value: width}, glow: {value: glow}},
        // Three's AdditiveBlending; only the restrained halo adds light.
        ...glow ? {blending: 2} : {},
      });
      materials.push(result);
      return result;
    };
    const solid = material(1, true, 12), xray = material(0.16, false, 12), halo = material(1, true, 28, 1);
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
