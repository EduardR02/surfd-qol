// Each run in a cinematic replay is the game's own Record Ghost, recoloured, with its path.
// Three.js classes come from that ghost rather than the bundle's private names.
import {trackPoint, trackYaw} from './cinema-track.js';

// Keep the line clear of the ramp surface at the player's hips.
const LINE_HEIGHT = 20;
const LINE_STEP = 2;
// The native ghost normally fades near the first-person camera. Cinema needs
// it solid even in tight rooms, so pass a camera farther along the same ray.
const SOLID_FROM = 140;
// Behind each ghost, six seconds of light: a pale core in a coloured band with
// a soft glow, hot at the head and cooling as it tapers, with smooth pulses
// travelling back along it and embers shed near the head that drift off and
// fade. Older history stays a quiet thin line. Ahead, the route not yet
// travelled is a slim line of light that brightens just ahead of the ghost.
const TAIL_SECONDS = 6;
const AHEAD_SECONDS = 4;
// World units between ember slots; about half of them shed an ember.
const EMBER_SPACING = 64;
// The three meshes of a path: band and core, additive glow, x-ray thread.
const BAND = 0, GLOW = 1, XRAY = 2;
// Through walls only the path near each ghost shows (seconds behind and
// ahead), fading out with distance from the camera (units): the whole route
// would draw a maze over the map.
const XRAY_BEHIND = 2.5, XRAY_AHEAD = 1.5, XRAY_NEAR = 700, XRAY_FAR = 1800;
// GLSL float literals.
const float = value => value.toFixed(2);
// Ages are in seconds behind the ghost, negative ahead of it.
const lineShape = `
uniform float mode;
float lifeAt(float behind){
  return 1.0-smoothstep(0.0,${float(TAIL_SECONDS)},max(behind,0.0));
}
// Embers live for about a second after the ghost passes.
float emberZone(float behind){
  return behind<0.0?0.0:1.0-smoothstep(1.0,1.4,behind);
}
// The band's radius in pixels.
float bandRadius(float behind){
  if(behind<0.0)return mix(1.8,1.1,smoothstep(0.0,${float(AHEAD_SECONDS)},-behind));
  return mix(1.2,4.2,lifeAt(behind));
}
// Half-width in pixels of the ribbon each mode draws into.
float spanFor(float behind){
  float life=lifeAt(behind);
  if(mode<0.5)return max(bandRadius(behind)+1.0,14.0*emberZone(behind));
  if(mode<1.5)return behind<0.0?8.0*(1.0-smoothstep(0.0,0.8,-behind)):max(14.0*life,18.0*emberZone(behind));
  return behind<0.0?1.0:mix(0.8,2.5,life);
}`;
const lineVertex = `
uniform vec2 resolution;
uniform float head;
uniform float rate;
uniform float nearPlane;
attribute vec3 prev;
attribute vec3 next;
attribute float side;
attribute float tick;
attribute float along;
varying float vSide;
varying float vBehind;
varying float vAlong;
varying float vSpan;
varying float vDepth;
${lineShape}
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
  float span=spanFor(behind);
  here.xy+=vec2(-dir.y,dir.x)*side*2.0*span/resolution*here.w;
  vSide=side;vBehind=behind;vAlong=along;vSpan=span;vDepth=here.w;
  gl_Position=here;
}`;
const lineFragment = `
uniform vec3 color;
uniform vec3 pale;
uniform vec3 body;
uniform float opacity;
uniform float time;
varying float vSide;
varying float vBehind;
varying float vAlong;
varying float vSpan;
varying float vDepth;
${lineShape}
float hash(float n){
  n=fract(n*0.1031);n*=n+33.33;n*=n+n;return fract(n);
}
// 0 is the body colour, 0.5 the line colour and 1 the pale highlight.
vec3 heat(float t){
  return mix(mix(body,color,clamp(t*2.0,0.0,1.0)),pale,clamp(t*2.0-1.0,0.0,1.0));
}
void main(){
  float x=vSide*vSpan,ax=abs(x);
  float behind=vBehind,age=max(behind,0.0),ahead=max(-behind,0.0);
  // Pulses leave the head at two thirds of the ghost's speed and slow to a stop
  // in the world, so they stream back from it. Only replay time moves them, and
  // fract keeps the phase precise late in long runs.
  float phase=2.4*(age+1.6*(1.0-exp(-age/0.8)))-fract(2.4*time);
  // Derivatives need uniform control flow, so take them before branching.
  float density=length(vec2(dFdx(phase),dFdy(phase)));
  float unit=max(length(vec2(dFdx(vAlong),dFdy(vAlong))),1e-4);
  if(behind<0.0){
    float near=1.0-smoothstep(0.0,${float(AHEAD_SECONDS)},ahead);
    float nose=exp(-ahead/0.3);
    if(mode>1.5){
      gl_FragColor=vec4(color,(1.0-smoothstep(0.0,vSpan,ax))*0.6*opacity);
    }else if(mode>0.5){
      gl_FragColor=vec4(mix(color,pale,0.5),exp(-3.0*ax*ax/(vSpan*vSpan+1e-3))*0.22*nose*opacity);
    }else{
      float r=bandRadius(behind);
      float edge=1.0-smoothstep(r-0.7,r+0.7,ax);
      float core=1.0-smoothstep(0.0,r*0.6+0.4,ax);
      gl_FragColor=vec4(mix(color,pale,core*(0.35+0.45*near)),edge*mix(0.22,0.85,near*near)*opacity);
    }
  }else{
    float life=lifeAt(age);
    float hot=exp(-age/0.25);
    // Smooth packets that narrow with age; where they crowd on screen, their
    // average, so distant tails do not shimmer.
    float sharp=mix(3.0,8.0,1.0-life);
    float crowd=smoothstep(0.06,0.2,density);
    float envelope=life*smoothstep(0.0,0.25,age);
    float wave=pow(0.5+0.5*cos(6.2831853*phase),sharp)*envelope;
    float pulse=mix(wave,inversesqrt(3.14159*sharp)*envelope,crowd);
    // Each slot along the path may hold an ember, born as the ghost passes. It
    // drifts a few pixels to one side, shrinks and fades within a second. Check
    // the neighbouring slots too, so embers near a slot's end are not cut off.
    float er=mix(2.0,1.0,smoothstep(0.0,0.9,age));
    // Embers crowded closer than a few pixels apart would only shimmer.
    float ember=smoothstep(3.0,6.0,${float(EMBER_SPACING)}/unit)*smoothstep(0.0,0.04,age)*exp(-age/0.45)*emberZone(age);
    float d=1e3;
    if(ember>0.0){
      float slot=floor(vAlong/${float(EMBER_SPACING)});
      for(int k=-1;k<=1;k++){
        float s=slot+float(k);
        float centre=(s+0.2+0.6*hash(s+0.37))*${float(EMBER_SPACING)};
        float drift=(hash(s+0.71)<0.5?-1.0:1.0)*(6.0+6.0*hash(s+0.13))*(1.0-exp(-age/0.18));
        if(hash(s)<0.45)d=min(d,length(vec2((vAlong-centre)/unit,x-drift)));
      }
    }
    vec3 spark=mix(color,pale,0.1+0.6*exp(-age/0.12));
    float r=bandRadius(age);
    if(mode>1.5){
      gl_FragColor=vec4(heat(0.6),(1.0-smoothstep(0.0,vSpan,ax))*mix(0.5,1.0,life)*opacity);
    }else if(mode>0.5){
      float s=14.0*life+1e-3;
      float halo=exp(-2.5*ax*ax/(s*s))*life*(0.12+0.3*hot+0.3*wave*(1.0-crowd));
      float flare=exp(-d*d/(9.0*er*er))*ember*0.35;
      gl_FragColor=vec4(heat(0.55+0.4*hot),(halo+flare)*opacity);
    }else{
      float edge=1.0-smoothstep(r-0.7,r+0.7,ax);
      float cr=r*(0.3+0.25*hot+0.3*pulse)+0.3;
      float core=1.0-smoothstep(cr*0.4,cr+0.6,ax);
      vec3 band=heat(mix(0.28,0.55,life));
      vec3 tint=mix(band,pale,clamp(core*(0.3+0.4*life+0.5*pulse+0.6*hot),0.0,1.0))*(1.0+0.25*pulse);
      float alpha=edge*mix(0.4,0.95,life);
      float glint=exp(-d*d/(er*er))*ember;
      gl_FragColor=vec4(mix(tint,spark,glint/max(glint+alpha*(1.0-glint),1e-4)),(alpha+glint*(1.0-alpha))*opacity);
    }
  }
  if(mode>1.5)gl_FragColor.a*=(1.0-smoothstep(${float(XRAY_BEHIND * 0.6)},${float(XRAY_BEHIND)},age))*(1.0-smoothstep(${float(XRAY_AHEAD * 0.5)},${float(XRAY_AHEAD)},ahead))
    *(1.0-smoothstep(${float(XRAY_NEAR)},${float(XRAY_FAR)},vDepth));
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
  let preparing = null, prepared = false, disposed = false;
  const compilation = new AbortController();
  const release = () => {
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
      const line = createLine(three, run.track, colors);
      disposers.push(() => {
        for (const mesh of line.meshes) scene.remove(mesh);
        line.dispose();
      });
      for (const mesh of line.meshes) scene.add(mesh);
      parts.push({run, ghost, group, label, trail, line, shown: true, drawn: line.meshes.map(mesh => mesh.visible),
        frame: {x: 0, y: 0, z: 0, yaw: 0, ducked: false, opacity: 1, trail: new Float32Array(0), trailCount: 0, label: ''}});
    }
    if (three) {
      projected = new three.Vector();
      far = {position: new three.Vector(), projectionMatrix: camera.projectionMatrix};
    }
  } catch (error) {
    try { release(); } catch { /* Preserve the creation failure after cleaning every part. */ }
    throw error;
  }
  const objects = () => parts.flatMap(part => [part.group, ...part.line.meshes]);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    compilation.abort();
    for (const object of objects()) scene.remove(object);
    // Let preparation stop reading its materials before releasing them.
    if (!preparing) release();
  };
  return {
    prepare() {
      if (disposed || prepared || !renderer.qolCompile || !parts.length) return preparing;
      prepared = true;
      const root = new parts[0].group.constructor(), staged = objects();
      // Keep these objects out of the live map until their shaders are ready.
      // The compiler uses the map as its lighting/environment scene.
      for (const object of staged) { scene.remove(object); root.add(object); }
      const restore = () => {
        for (const object of staged) root.remove(object);
        if (disposed) release();
        else for (const object of staged) scene.add(object);
      };
      try {
        preparing = Promise.resolve(renderer.qolCompile(root, compilation.signal)).catch(() => {
          // Prewarming is an optimization, not a requirement for playback.
        }).finally(() => { preparing = null; restore(); });
      } catch {
        restore();
      }
      return preparing;
    },
    // at: each run's fractional track index; width/height: canvas CSS pixels.
    update(at, width, height) {
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index], track = part.run.track;
        if (!part.shown) continue;
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
    // Hides or shows a run's ghost and path, as first person does for the watched run.
    show(index, shown) {
      const part = parts[index];
      if (!part || part.shown === !!shown) return;
      part.shown = !!shown;
      part.group.visible = part.shown;
      part.line.meshes.forEach((mesh, k) => { mesh.visible = part.shown && part.drawn[k]; });
    },
    // Where each ghost's head is on screen in CSS pixels, null when off screen or hidden.
    labels(width, height) {
      camera.updateMatrixWorld();
      return parts.map(({frame, shown}) => {
        if (!shown) return null;
        projected.set(frame.x, frame.z + (frame.ducked ? 56 : 74), -frame.y).project(camera);
        if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || !Number.isFinite(projected.z) ||
            projected.z > 1 || projected.z < -1 || Math.abs(projected.x) > 1.05 || Math.abs(projected.y) > 1.05) return null;
        return {x: (projected.x + 1) / 2 * width, y: (1 - projected.y) / 2 * height};
      });
    },
    dispose,
  };
}

// A fixed-pixel ribbon drawn three ways from one geometry: a faint through-wall
// thread, an additive glow and the depth-tested band, all on the same
// replay-time uniforms.
function createLine(three, track, colors) {
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
    const uniforms = {color: {value: new three.Color(colors.line)}, pale: {value: new three.Color(colors.pale)},
      body: {value: new three.Color(colors.body)},
      head: {value: 0}, rate: {value: 1 / track.dt}, time: {value: 0}, nearPlane: {value: 0.1},
      resolution: {value: {x: 1, y: 1, isVector2: true}}};
    const material = (opacity, depthTest, mode) => {
      const result = new three.Material({
        vertexShader: lineVertex, fragmentShader: lineFragment, transparent: true, depthWrite: false, depthTest,
        uniforms: {...uniforms, opacity: {value: opacity}, mode: {value: mode}},
        // Three's AdditiveBlending: the halo brightens without hiding the map.
        ...mode === GLOW ? {blending: 2} : {},
      });
      materials.push(result);
      return result;
    };
    const xray = material(0.18, false, XRAY), halo = material(1, true, GLOW), band = material(1, true, BAND);
    const meshes = [new three.Mesh(geometry, xray), new three.Mesh(geometry, halo), new three.Mesh(geometry, band)];
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
