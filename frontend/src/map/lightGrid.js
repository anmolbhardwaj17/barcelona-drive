/**
 * lightGrid.js — world-space 2.5D clustered street lighting (v3 P2).
 *
 * THE PROBLEM IT SOLVES. `main.js:192` removed the dynamic PointLights, so the entire night rig is
 * 1 Ambient + 1 Hemisphere + 1 Directional + the car's 2 headlight SpotLights. **There are zero
 * punctual lights in the world.** Six separate fakes stand in for them — lamp emissive × bloom,
 * 16 m additive ground-pool decals at 22 m lamp spacing (>100% road coverage), hero-building spill
 * decals, road night wash, vegetation night wash, decal colour lift — and none of them light
 * anything. A wall next to a lamp post is lit exactly the same as a wall 40 m away.
 *
 * That is why the v3 audit caps night at ~50% of the ETS2 target, and why it caps it regardless of
 * how good the art gets: ETS2's night look IS wet asphalt and facades under sodium lamps.
 *
 * THE APPROACH. three's forward renderer compiles a fixed light count into every shader, so N real
 * PointLights means recompiling the world every time N changes — unusable for streamed lamps. So
 * the lights live in TEXTURES instead and materials sample them:
 *
 *   - INDEX texture  64×64 RGBA8. One texel per 8 m cell = a 512 m window centred on the camera.
 *     Each texel holds up to FOUR light indices (one per channel), nearest-first.
 *   - DATA texture   RGBA32F, 2 texels per light: (x, y, z, radius) and (r, g, b, intensity).
 *
 * A fragment computes its cell from world XZ, reads ≤4 indices, and accumulates. Cost is bounded by
 * the 4-slot limit, NOT by how many lamps are loaded — 2,000 street lamps cost the same per pixel
 * as 40. That bound is the whole point.
 *
 * ⚠ SPIKE STATUS. Gated behind `?lightgrid` and stubbed with hand-placed lights so its cost can be
 * measured BEFORE the 8 days of work behind it. Kill criterion K-N: if 32 lights cost more than
 * 3.0 ms, this approach is wrong and the plan stops here rather than spending the 8 days.
 */
import * as THREE from 'three';
import { patchMaterial } from './materialRegistry.js';

export const GRID_DIM = 64;        // texels per axis
export const CELL_M = 8;           // world metres per cell → 512 m window
export const MAX_LIGHTS = 255;     // index 0 = "empty", so 1..255 are real lights
const SLOTS = 4;                   // lights per cell (RGBA) — the per-fragment cost bound

let _indexTex = null, _dataTex = null;
let _indexData = null, _lightData = null;
let _lights = [];                  // {x,y,z,r, cr,cg,cb, i}
let _originX = 0, _originZ = 0;    // world XZ of grid texel (0,0)
let _enabled = false;

/** Shared uniforms — every patched material binds THESE OBJECTS, so one write updates all of them. */
export const lightGridUniforms = {
  uLGIndex:   { value: null },
  uLGData:    { value: null },
  uLGOrigin:  { value: new THREE.Vector2() },
  uLGEnabled: { value: 0 },
};

export function isLightGridEnabled() { return _enabled; }

export function initLightGrid() {
  if (_indexTex) return;
  _indexData = new Uint8Array(GRID_DIM * GRID_DIM * 4);
  _indexTex = new THREE.DataTexture(_indexData, GRID_DIM, GRID_DIM, THREE.RGBAFormat);
  _indexTex.magFilter = _indexTex.minFilter = THREE.NearestFilter;   // indices must NOT interpolate
  _indexTex.needsUpdate = true;

  _lightData = new Float32Array((MAX_LIGHTS + 1) * 2 * 4);
  _dataTex = new THREE.DataTexture(_lightData, 2, MAX_LIGHTS + 1, THREE.RGBAFormat, THREE.FloatType);
  _dataTex.magFilter = _dataTex.minFilter = THREE.NearestFilter;
  _dataTex.needsUpdate = true;

  lightGridUniforms.uLGIndex.value = _indexTex;
  lightGridUniforms.uLGData.value = _dataTex;
  _enabled = true;
  lightGridUniforms.uLGEnabled.value = 1;
}

/**
 * Replace the light set. `lights` = [{x, y, z, radius, color:THREE.Color, intensity}].
 * Called on tile load/unload, NOT per frame.
 */
export function setLights(lights) {
  if (!_indexTex) initLightGrid();
  _lights = lights.slice(0, MAX_LIGHTS);
  for (let i = 0; i < _lights.length; i++) {
    const L = _lights[i], o = (i + 1) * 8;   // +1: slot 0 is the "empty" sentinel
    _lightData[o] = L.x; _lightData[o + 1] = L.y; _lightData[o + 2] = L.z; _lightData[o + 3] = L.radius;
    _lightData[o + 4] = L.color.r; _lightData[o + 5] = L.color.g; _lightData[o + 6] = L.color.b;
    _lightData[o + 7] = L.intensity;
  }
  _dataTex.needsUpdate = true;
}

/**
 * Rebuild the index grid around a world position. **Only call when the camera crosses a cell** —
 * this is O(lights × cells-in-radius) and has no business running every frame.
 */
export function updateLightGrid(camWorldX, camWorldZ) {
  if (!_indexTex) return;
  _originX = Math.floor(camWorldX / CELL_M) * CELL_M - (GRID_DIM / 2) * CELL_M;
  _originZ = Math.floor(camWorldZ / CELL_M) * CELL_M - (GRID_DIM / 2) * CELL_M;
  lightGridUniforms.uLGOrigin.value.set(_originX, _originZ);
  _indexData.fill(0);

  for (let i = 0; i < _lights.length; i++) {
    const L = _lights[i];
    // Cell range this light can possibly reach.
    const c0x = Math.max(0, Math.floor((L.x - L.radius - _originX) / CELL_M));
    const c1x = Math.min(GRID_DIM - 1, Math.floor((L.x + L.radius - _originX) / CELL_M));
    const c0z = Math.max(0, Math.floor((L.z - L.radius - _originZ) / CELL_M));
    const c1z = Math.min(GRID_DIM - 1, Math.floor((L.z + L.radius - _originZ) / CELL_M));
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const t = (cz * GRID_DIM + cx) * 4;
        // First free slot. Overflow is DROPPED on purpose: the 4-slot cap is what bounds the
        // per-fragment cost, and a 5th lamp reaching one 8 m cell is imperceptible.
        for (let s = 0; s < SLOTS; s++) {
          if (_indexData[t + s] === 0) { _indexData[t + s] = i + 1; break; }
        }
      }
    }
  }
  _indexTex.needsUpdate = true;
}

/** GLSL injected into a material's fragment shader. Adds accumulated punctual light to the diffuse. */
export const LIGHT_GRID_PARS = /* glsl */`
uniform sampler2D uLGIndex;
uniform sampler2D uLGData;
uniform vec2 uLGOrigin;
uniform float uLGEnabled;
varying vec3 vLGWorldPos;

vec3 lightGridContribution(vec3 wpos, vec3 normal) {
  if (uLGEnabled < 0.5) return vec3(0.0);
  vec2 cell = (wpos.xz - uLGOrigin) / ${CELL_M}.0;
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= ${GRID_DIM}.0 || cell.y >= ${GRID_DIM}.0) return vec3(0.0);
  vec4 idx = texture2D(uLGIndex, (floor(cell) + 0.5) / ${GRID_DIM}.0) * 255.0;
  vec3 acc = vec3(0.0);
  for (int s = 0; s < 4; s++) {
    float id = s == 0 ? idx.r : s == 1 ? idx.g : s == 2 ? idx.b : idx.a;
    if (id < 0.5) continue;
    float v = (id + 0.5) / ${MAX_LIGHTS + 1}.0;
    vec4 P = texture2D(uLGData, vec2(0.25, v));   // xyz = position, w = radius
    vec4 C = texture2D(uLGData, vec2(0.75, v));   // rgb = colour,   w = intensity
    vec3 d = P.xyz - wpos;
    float dist = length(d);
    if (dist > P.w) continue;
    // Inverse-square with a smooth cutoff at the radius, so a lamp entering the grid fades in
    // instead of popping. NdotL is half-lambert-biased: a real street is full of surfaces facing
    // away from the lamp that are still visibly lit by bounce, and there is no GI here to supply it.
    float atten = pow(clamp(1.0 - dist / P.w, 0.0, 1.0), 2.0);
    float ndl = clamp(dot(normalize(normal), normalize(d)) * 0.5 + 0.5, 0.0, 1.0);
    acc += C.rgb * C.w * atten * ndl;
  }
  return acc;
}`;

export const LIGHT_GRID_VERT_PARS = 'varying vec3 vLGWorldPos;';
export const LIGHT_GRID_VERT_BODY = 'vLGWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;';

/**
 * Make a material receive clustered light. Goes through the registry, so it composes with the
 * patches the material already carries (roadAO, roadNightWash, terrain, facade…) instead of
 * clobbering them — which is exactly why P1-03 had to land before this.
 *
 * ⚠ COORDINATE FRAME. vLGWorldPos comes from `modelMatrix * transformed`, i.e. the MIRRORED
 * worldGroup frame (worldGroup.scale.x = -1). Light positions handed to setLights() must be in the
 * SAME frame — use the positions the renderer already uses, never the physics frame. Getting this
 * wrong puts every lamp's pool on the wrong side of the street, symmetrically, which reads as
 * "the lighting is subtly off" rather than as an obvious bug.
 */
export function patchLightGrid(mat) {
  return patchMaterial(mat, (shader) => {
    Object.assign(shader.uniforms, lightGridUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + LIGHT_GRID_VERT_PARS)
      .replace('#include <project_vertex>', LIGHT_GRID_VERT_BODY + '\n#include <project_vertex>');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + LIGHT_GRID_PARS)
      // After <lights_fragment_end> so it ADDS to the existing rig rather than being overwritten by it.
      .replace('#include <lights_fragment_end>',
        '#include <lights_fragment_end>\n' +
        'reflectedLight.directDiffuse += lightGridContribution(vLGWorldPos, normal) * diffuseColor.rgb;');
  }, 'lightGrid');
}

/** SPIKE ONLY — 32 lamps in a grid around a point, so the cost can be measured before the build. */
export function stubSpikeLights(cx, cz, y = 6) {
  const col = new THREE.Color(0xFFB25E);   // Barcelona sodium-warm (regions/barcelona.js night.lampColor)
  const out = [];
  for (let i = 0; i < 32; i++) {
    const row = Math.floor(i / 8), coln = i % 8;
    out.push({ x: cx + (coln - 4) * 22, y, z: cz + (row - 2) * 22,
               radius: 26, color: col, intensity: 3.0 });
  }
  return out;
}
