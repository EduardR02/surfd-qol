// Exact captured native BSP shaders. Unknown revisions use conservative texture traversal.
export function nativeBspShaderSignature() {
  return {vertexShader: `
attribute vec2 uvLight;
attribute float blendAlpha;
attribute float lightIndex;
#ifdef PROP_LIGHT
attribute float lightOffset;
#endif
#ifdef PROP_FADE
attribute vec2 fadeRange;
varying float vFade;
#endif
varying vec2 vUv;
varying vec2 vLightUv;
varying float vBlend;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLighting;
varying float vDepth;
uniform sampler2D propLight;
uniform vec2 propLightSize;
void main(){
  vUv=uv;vLightUv=uvLight;vBlend=blendAlpha;
  vec4 p=vec4(position,1.0);vec3 n=normal;
  #ifdef USE_INSTANCING
    p=instanceMatrix*p;n=mat3(instanceMatrix)*n;
  #endif
  vec4 world=modelMatrix*p;vWorld=world.xyz;vNormal=normalize(mat3(modelMatrix)*n);
  #ifdef PROP_FADE
    vec3 origin=(modelMatrix*instanceMatrix*vec4(0.0,0.0,0.0,1.0)).xyz;
    vFade=clamp((fadeRange.y-distance(cameraPosition,origin))/(fadeRange.y-fadeRange.x),0.0,1.0);
  #endif
  vDepth=-(viewMatrix*world).z;
  vLighting=vec3(1.0);
  #ifdef PROP_LIGHT
    float index=max(lightOffset,0.0)+lightIndex;
    vec2 coord=vec2(mod(index,propLightSize.x),floor(index/propLightSize.x));
    vLighting=mix(vec3(1.0),texture2D(propLight,(coord+0.5)/propLightSize).rgb,step(0.0,lightOffset));
  #endif
  gl_Position=projectionMatrix*viewMatrix*world;
}`, fragmentShader: `
uniform sampler2D baseMap;
uniform sampler2D secondMap;
uniform sampler2D normalMap;
uniform sampler2D detailMap;
uniform vec2 detailScale;
uniform float detailFactor;
uniform sampler2D lightMap;
uniform samplerCube environment;
uniform vec2 lightSize;
uniform vec3 tint;
uniform vec3 envTint;
uniform sampler2D envMask;
uniform vec3 envShaping;
uniform vec2 lightingResponse;
uniform float viewBrightness;
#ifdef PROP_FADE
varying float vFade;
#endif
uniform vec3 fogColor;
uniform float opacity;
uniform float alphaCut;
uniform float fogStart;
uniform float fogEnd;
uniform float fogMax;
uniform float seamlessScale;
uniform vec3 seamlessOffset;
varying vec2 vUv;
varying vec2 vLightUv;
varying float vBlend;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLighting;
varying float vDepth;
vec3 decodeLuxel(vec2 uv){
  vec4 l=texture2D(lightMap,uv);
  return l.rgb*exp2(floor(l.a*255.0+0.5)-128.0);
}
vec3 luxel(){
  vec2 p=vLightUv*lightSize-0.5;vec2 f=fract(p);vec2 b=(floor(p)+0.5)/lightSize;
  vec2 d=1.0/lightSize;
  return mix(mix(decodeLuxel(b),decodeLuxel(b+vec2(d.x,0.0)),f.x),mix(decodeLuxel(b+vec2(0.0,d.y)),decodeLuxel(b+d),f.x),f.y);
}
vec4 baseTexture(sampler2D tex){
  #ifdef SEAMLESS
    // Source seamless materials use triplanar world coordinates. Sky geometry
    // is expanded around sky_camera, so reconstruct its authored coordinates.
    vec3 source=vec3(vWorld.x,-vWorld.z,vWorld.y)*seamlessScale+seamlessOffset;
    vec3 n=abs(vec3(vNormal.x,-vNormal.z,vNormal.y));n=pow(n,vec3(4.0));n/=max(dot(n,vec3(1.0)),0.00001);
    return texture2D(tex,source.yz)*n.x+texture2D(tex,source.xz)*n.y+texture2D(tex,source.xy)*n.z;
  #else
    return texture2D(tex,vUv);
  #endif
}
void main(){
  vec4 base=baseTexture(baseMap);
  #ifdef SECOND_MAP
    base=mix(base,baseTexture(secondMap),clamp(vBlend,0.0,1.0));
  #endif
  #ifdef DETAIL_MAP
    base.rgb*=mix(vec3(1.0),2.0*texture2D(detailMap,vUv*detailScale).rgb,detailFactor);
  #endif
  float alpha=base.a*opacity;
  #ifdef VERTEX_ALPHA
    alpha*=vBlend;
  #endif
  #ifdef ALPHA_TEST
    // Only where it can fire: a discard anywhere in a shader disables hidden-surface removal on
    // tile-based GPUs and early depth writes elsewhere, for every pixel the shader draws.
    if(alpha<alphaCut)discard;
  #endif
  #ifdef PROP_FADE
    alpha*=vFade;
    if(alpha<=0.0039215686)discard;
  #endif
  #ifndef TRANSLUCENT
    alpha=1.0;
  #endif
  vec3 lighting=vec3(1.0);
  #ifdef WORLD_LIGHT
    lighting=luxel();
  #endif
  #ifdef PROP_LIGHT
    lighting=vLighting;
  #endif
  #ifdef UNLIT
    lighting=vec3(1.0);
  #elif defined(LIGHTING_RESPONSE)
    float brightest=max(max(lighting.r,lighting.g),lighting.b);
    vec3 shadowColor=vec3(1.0);
    #ifdef COLORED_SHADOW_LIFT
      // Preserve the authored warm/cool light hue when opening dark interiors.
      // Truly black baked samples remain black, rather than inventing lights.
      shadowColor=lighting/max(brightest,0.001);
    #endif
    lighting=lighting*lightingResponse.x+shadowColor*lightingResponse.y*(1.0-clamp(brightest,0.0,1.0));
  #endif
  vec3 result=base.rgb*tint*lighting;
  #ifdef REFLECTION_ONLY
    result=vec3(0.0);
  #endif
  #ifdef ENVIRONMENT
    vec3 n=normalize(vNormal);
    vec4 bump=texture2D(normalMap,vUv);
    #ifdef NORMAL_MAP
      vec3 q0=dFdx(vWorld),q1=dFdy(vWorld);vec2 st0=dFdx(vUv),st1=dFdy(vUv);
      vec3 q1perp=cross(q1,n),q0perp=cross(n,q0);
      vec3 T=q1perp*st0.x+q0perp*st1.x;vec3 B=q1perp*st0.y+q0perp*st1.y;
      float invmax=inversesqrt(max(max(dot(T,T),dot(B,B)),0.00001));
      n=normalize(mat3(T*invmax,B*invmax,n)*(bump.xyz*2.0-1.0));
    #endif
    vec3 reflected=reflect(normalize(vWorld-cameraPosition),n);
    float mask=1.0;
    #ifdef NORMAL_ALPHA_MASK
      mask=bump.a;
    #endif
    vec3 specular=textureCube(environment,reflected).rgb*envTint*mask;
    #ifdef ENV_MASK
      specular*=texture2D(envMask,vUv).rgb;
    #endif
    #ifdef ENV_SHAPING
      specular=mix(specular,specular*specular,envShaping.x);
      specular=mix(vec3(dot(specular,vec3(0.299,0.587,0.114))),specular,envShaping.y);
      float fresnel=pow(1.0-clamp(dot(n,normalize(cameraPosition-vWorld)),0.0,1.0),5.0);
      specular*=mix(fresnel,1.0,envShaping.z);
    #endif
    result+=specular;
  #endif
  #ifdef VIEW_BRIGHTNESS
    // The player's brightness setting, before fog so fog and sky keep their authored colour. Slope k at black and
    // exactly 1 at white: above 100% dark areas gain the most and nothing clips that was not already white.
    if(viewBrightness!=1.0){
      vec3 lit=min(result,vec3(1.0));
      result=viewBrightness*lit/(1.0+(viewBrightness-1.0)*lit);
    }
  #endif
  #ifndef NO_FOG
    float fog=clamp((vDepth-fogStart)/(fogEnd-fogStart),0.0,fogMax);
    result=mix(result,fogColor,fog);
  #endif
  gl_FragColor=vec4(result,alpha);
  #include <colorspace_fragment>
}`};
}
