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
import { REGION } from '../regions/index.js';

export const GRID_DIM = 64;        // texels per axis
export const CELL_M = 8;           // world metres per cell → 512 m window
// v3 P2: 1023, not 255.
//
// The index texture is RGBA8 — one BYTE per slot — so light ids were capped at 255. A dense
// Eixample night puts ~370+ lamps inside the 512 m window, so the nearest-255 cull left everything
// past roughly 120-150 m unlit, and the lit zone travelled with the camera. That is the "lamps only
// light up when I get there" report: not a falloff problem, an ADDRESS SPACE problem.
//
// The index is now 16-bit, split across two RGBA8 textures (low byte + high byte) rather than an
// integer sampler, which keeps the shader on plain texture2D and works without a GLSL3 opt-in. That
// affords 65535 ids; the practical cap is CPU rebuild cost, which is O(lights x cells-per-lamp), so
// it is set at 1023 — comfortably more than a 512 m window holds.
export const MAX_LIGHTS = 1023;    // index 0 = "empty", so 1..1023 are real lights
const SLOTS = 4;                   // lights per cell (RGBA) — the per-fragment cost bound

let _indexTex = null, _indexHiTex = null, _dataTex = null;
let _indexData = null, _indexHiData = null, _lightData = null;
let _lights = [];                  // {x,y,z,r, cr,cg,cb, i}
let _originX = 0, _originZ = 0;    // world XZ of grid texel (0,0)
let _enabled = false;

/** Shared uniforms — every patched material binds THESE OBJECTS, so one write updates all of them. */
export const lightGridUniforms = {
  uLGIndex:   { value: null },   // low byte of each slot's light id
  uLGIndexHi: { value: null },   // high byte — together they address 65535 lights
  uLGData:    { value: null },
  uLGOrigin:  { value: new THREE.Vector2() },
  uLGEnabled: { value: 0 },
  // Half-lambert bias, per city. See regions/<city>.js night.lampWrap.
  uLGWrap:    { value: REGION.night?.lampWrap ?? 0.5 },
  // Downward-cone shape, per city — see regions/<city>.js night.lampConeFloor / lampConePower.
  uLGConeFloor: { value: REGION.night?.lampConeFloor ?? 0.12 },
  uLGConePower: { value: REGION.night?.lampConePower ?? 0.75 },
};

/** Per-cell distance² of each occupied slot, so a nearer light can evict a farther one. */
let _slotDist = null;

export function isLightGridEnabled() { return _enabled; }

export function initLightGrid() {
  if (_indexTex) return;
  _indexData = new Uint8Array(GRID_DIM * GRID_DIM * 4);
  _indexTex = new THREE.DataTexture(_indexData, GRID_DIM, GRID_DIM, THREE.RGBAFormat);
  _indexTex.magFilter = _indexTex.minFilter = THREE.NearestFilter;   // indices must NOT interpolate
  _indexTex.needsUpdate = true;

  _indexHiData = new Uint8Array(GRID_DIM * GRID_DIM * 4);
  _indexHiTex = new THREE.DataTexture(_indexHiData, GRID_DIM, GRID_DIM, THREE.RGBAFormat);
  _indexHiTex.magFilter = _indexHiTex.minFilter = THREE.NearestFilter;
  _indexHiTex.needsUpdate = true;

  _slotDist = new Float32Array(GRID_DIM * GRID_DIM * SLOTS);
  _lightData = new Float32Array((MAX_LIGHTS + 1) * 2 * 4);
  _dataTex = new THREE.DataTexture(_lightData, 2, MAX_LIGHTS + 1, THREE.RGBAFormat, THREE.FloatType);
  _dataTex.magFilter = _dataTex.minFilter = THREE.NearestFilter;
  _dataTex.needsUpdate = true;

  lightGridUniforms.uLGIndex.value = _indexTex;
  lightGridUniforms.uLGIndexHi.value = _indexHiTex;
  lightGridUniforms.uLGData.value = _dataTex;
  _enabled = true;
  lightGridUniforms.uLGEnabled.value = 1;
}

/**
 * Replace the light set. `lights` = [{x, y, z, radius, color:THREE.Color, intensity}].
 * Called on tile load/unload and on cell crossing, NOT per frame.
 *
 * `nearTo` (world XZ) picks WHICH lights survive when there are more than MAX_LIGHTS. A dense
 * Eixample night easily exceeds 255 lamps inside the 512 m window, and `.slice(0, 255)` would keep
 * whichever tiles happened to load first — so the lit area would wander with load order rather than
 * follow the camera, and lamps near the car could silently go dark while lamps 400 m away stayed
 * lit. Sorting by distance makes the truncation a range cutoff instead of an arbitrary one.
 */
export function setLights(lights, nearTo = null) {
  if (!_indexTex) initLightGrid();
  if (lights.length > MAX_LIGHTS && nearTo) {
    const { x: cx, z: cz } = nearTo;
    // Partial-select would be cheaper, but this runs on cell crossing (~2/s), not per frame, and
    // a full sort of a few hundred entries is well under the cost of being wrong here.
    lights = lights.slice().sort((a, b) =>
      ((a.x - cx) ** 2 + (a.z - cz) ** 2) - ((b.x - cx) ** 2 + (b.z - cz) ** 2));
  }
  lightGridStats.lightsOffered = lights.length;
  lightGridStats.truncated = lights.length > MAX_LIGHTS;
  _lights = lights.length > MAX_LIGHTS ? lights.slice(0, MAX_LIGHTS) : lights;
  lightGridStats.lightCount = _lights.length;
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
export const lightGridStats = {
  cellsOccupied: 0, cellsTotal: 0, slotsUsed: 0, meanOccupancy: 0,
  lightCount: 0,      // lights actually uploaded
  lightsOffered: 0,   // lights handed to setLights before truncation
  truncated: false,   // offered > MAX_LIGHTS — the lit area is a range cutoff, and lamps beyond it
                      // go dark. Visible as light appearing to switch off as the car moves.
};

export function updateLightGrid(camWorldX, camWorldZ) {
  if (!_indexTex) return;
  _originX = Math.floor(camWorldX / CELL_M) * CELL_M - (GRID_DIM / 2) * CELL_M;
  _originZ = Math.floor(camWorldZ / CELL_M) * CELL_M - (GRID_DIM / 2) * CELL_M;
  lightGridUniforms.uLGOrigin.value.set(_originX, _originZ);
  _indexData.fill(0);
  _indexHiData.fill(0);

  _slotDist.fill(0);

  for (let i = 0; i < _lights.length; i++) {
    const L = _lights[i];
    const r2 = L.radius * L.radius;
    // Cell range this light can possibly reach.
    const c0x = Math.max(0, Math.floor((L.x - L.radius - _originX) / CELL_M));
    const c1x = Math.min(GRID_DIM - 1, Math.floor((L.x + L.radius - _originX) / CELL_M));
    const c0z = Math.max(0, Math.floor((L.z - L.radius - _originZ) / CELL_M));
    const c1z = Math.min(GRID_DIM - 1, Math.floor((L.z + L.radius - _originZ) / CELL_M));
    for (let cz = c0z; cz <= c1z; cz++) {
      const cellCz = _originZ + (cz + 0.5) * CELL_M;
      const dz = cellCz - L.z;
      for (let cx = c0x; cx <= c1x; cx++) {
        const cellCx = _originX + (cx + 0.5) * CELL_M;
        const dx = cellCx - L.x;
        const d2 = dx * dx + dz * dz;
        // Circle, not the bounding square: the corners of that square are outside the lamp's reach
        // and would burn slots that a genuinely closer lamp needs.
        if (d2 > r2) continue;

        const t = (cz * GRID_DIM + cx) * SLOTS;
        // NEAREST-FIRST. First-free assignment lets whichever light is iterated first squat a slot,
        // so in a dense block the four lights kept for a cell were an accident of array order and
        // the visibly nearest lamp could be the one dropped. Overflow still gets dropped — the
        // 4-slot cap is what bounds per-fragment cost — but now the DROPPED ones are the farthest.
        let placed = false, worstS = -1, worstD = -1;
        for (let sl = 0; sl < SLOTS; sl++) {
          if (_indexData[t + sl] === 0 && _indexHiData[t + sl] === 0) {
            _indexData[t + sl] = (i + 1) & 255; _indexHiData[t + sl] = (i + 1) >> 8;
            _slotDist[t + sl] = d2; placed = true; break;
          }
          if (_slotDist[t + sl] > worstD) { worstD = _slotDist[t + sl]; worstS = sl; }
        }
        if (!placed && d2 < worstD) {
          _indexData[t + worstS] = (i + 1) & 255; _indexHiData[t + worstS] = (i + 1) >> 8;
          _slotDist[t + worstS] = d2;
        }
      }
    }
  }

  // Proof-of-work stat. A cost measurement is only meaningful if the shader actually had lights to
  // evaluate; without this, an empty grid reports a confident PASS and nobody can tell.
  let occ = 0, slots = 0;
  for (let c = 0; c < GRID_DIM * GRID_DIM; c++) {
    const t = c * SLOTS;
    const n = (_indexData[t] ? 1 : 0) + (_indexData[t + 1] ? 1 : 0) + (_indexData[t + 2] ? 1 : 0) + (_indexData[t + 3] ? 1 : 0);
    if (n) { occ++; slots += n; }
  }
  lightGridStats.cellsOccupied = occ;
  lightGridStats.cellsTotal = GRID_DIM * GRID_DIM;
  lightGridStats.slotsUsed = slots;
  lightGridStats.meanOccupancy = occ ? slots / occ : 0;

  _indexTex.needsUpdate = true;
  _indexHiTex.needsUpdate = true;
}

/**
 * The four light indices affecting the cell containing a world XZ, nearest-first, 0 = empty.
 * Mirrors exactly what the fragment shader reads, so it answers "why is this spot lit like that?"
 * without a GPU debugger — and lets the slot-assignment rules be tested, since every failure mode
 * here is silent (the scene renders fine, just lit by the wrong lamps).
 */
export function getCellSlots(worldX, worldZ) {
  if (!_indexData) return [0, 0, 0, 0];
  const cx = Math.floor((worldX - _originX) / CELL_M);
  const cz = Math.floor((worldZ - _originZ) / CELL_M);
  if (cx < 0 || cz < 0 || cx >= GRID_DIM || cz >= GRID_DIM) return [0, 0, 0, 0];
  const t = (cz * GRID_DIM + cx) * SLOTS;
  // Must recombine BOTH planes. Reading only the low byte silently reports id 300 as 44, which
  // makes a working grid look broken and a broken one look fine.
  return [0, 1, 2, 3].map((k) => _indexData[t + k] + (_indexHiData[t + k] << 8));
}

/** GLSL injected into a material's fragment shader. Adds accumulated punctual light to the diffuse. */
export const LIGHT_GRID_PARS = /* glsl */`
uniform sampler2D uLGIndex;
uniform sampler2D uLGIndexHi;
uniform sampler2D uLGData;
uniform vec2 uLGOrigin;
uniform float uLGEnabled;
uniform float uLGWrap;
uniform float uLGConeFloor;
uniform float uLGConePower;
varying vec3 vLGWorldPos;

vec3 lightGridContribution(vec3 wpos, vec3 normal) {
  if (uLGEnabled < 0.5) return vec3(0.0);
  vec2 cell = (wpos.xz - uLGOrigin) / ${CELL_M}.0;
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= ${GRID_DIM}.0 || cell.y >= ${GRID_DIM}.0) return vec3(0.0);
  vec2 uv = (floor(cell) + 0.5) / ${GRID_DIM}.0;
  // 16-bit light id split across two RGBA8 planes. One byte per slot capped ids at 255, which is
  // fewer lamps than a dense 512 m window holds — so the far half of the street had no lights to
  // reference and stayed dark until the camera brought it inside the nearest-255 set.
  vec4 idxLo = texture2D(uLGIndex, uv) * 255.0;
  vec4 idxHi = texture2D(uLGIndexHi, uv) * 255.0;
  vec3 acc = vec3(0.0);
  for (int s = 0; s < 4; s++) {
    float lo = s == 0 ? idxLo.r : s == 1 ? idxLo.g : s == 2 ? idxLo.b : idxLo.a;
    float hi = s == 0 ? idxHi.r : s == 1 ? idxHi.g : s == 2 ? idxHi.b : idxHi.a;
    float id = lo + hi * 256.0;
    if (id < 0.5) continue;
    float v = (id + 0.5) / ${MAX_LIGHTS + 1}.0;
    vec4 P = texture2D(uLGData, vec2(0.25, v));   // xyz = position, w = radius
    vec4 C = texture2D(uLGData, vec2(0.75, v));   // rgb = colour,   w = intensity
    vec3 d = P.xyz - wpos;
    float dist = length(d);
    if (dist > P.w) continue;

    // DOWNWARD CONE. A street lamp is a downward-biased luminaire behind a shade, not a bare bulb
    // radiating in a sphere. Without this, a lamp head at 8 m with a 48 m radius lights a
    // six-storey facade uniformly to the roofline — every building washed warm to the top, which
    // is what "building lighting from road reflection" was. The ground and the lower facade should
    // take nearly all of it.
    //
    // d points FROM the surface TO the lamp (the same vector N.L uses above), so for road under a
    // lamp d.y is POSITIVE: normalize(d).y is +1 directly below the lamp, 0 level with it, and
    // negative for anything above it. No minus sign — negating it inverted the cone, sent every
    // road surface to the spill floor, and put the street out entirely.
    // The floor keeps a little sideways spill: a real lamp does throw some light onto the facade
    // beside it, and clamping hard to zero reads as a stencilled edge partway up the wall.
    float down = clamp(normalize(d).y, 0.0, 1.0);
    float cone = mix(uLGConeFloor, 1.0, pow(down, uLGConePower));
    // Inverse-square with a smooth cutoff at the radius, so a lamp entering the grid fades in
    // instead of popping. NdotL is half-lambert-biased: a real street is full of surfaces facing
    // away from the lamp that are still visibly lit by bounce, and there is no GI here to supply it.
    // Smoothstep, not quadratic. A lamp head sits POLE_HEIGHT (8 m) above the road, so the light
    // has already spent that much of its radius before reaching any ground the driver sees:
    // quadratic falloff gave 0.31 directly BENEATH the lamp and 0.03 twenty metres along the
    // street, so pools died at ~15 m and lamps only lit up when you were nearly under them.
    // Smoothstep holds near 1 through the near field and still reaches exactly 0 at the radius,
    // so pools overlap into a continuously lit road with visible scalloping at 22 m spacing.
    float t = clamp(1.0 - dist / P.w, 0.0, 1.0);
    float atten = t * t * (3.0 - 2.0 * t);
    // mix(dot, 1, wrap): wrap=0 is true lambert, wrap=0.5 reproduces the classic dot*0.5+0.5
    // half-lambert the spike was measured with, wrap=1 is fully omnidirectional.
    float ndl = clamp(mix(dot(normalize(normal), normalize(d)), 1.0, uLGWrap), 0.0, 1.0);
    acc += C.rgb * C.w * atten * ndl * cone;
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
const _warnedKinds = new Set();   // warn once per material kind, not once per material

export function patchLightGrid(mat) {
  return patchMaterial(mat, (shader) => {
    Object.assign(shader.uniforms, lightGridUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + LIGHT_GRID_VERT_PARS)
      .replace('#include <project_vertex>', LIGHT_GRID_VERT_BODY + '\n#include <project_vertex>');
    // ⚠ SILENT NO-OP GUARD. The injection point only exists in materials that go through three's
    // lighting chain (Lambert / Standard / Phong). On an unlit material — MeshBasic, and anything
    // that builds its own fragment shader — String.replace finds nothing, returns the source
    // UNCHANGED, and the grid quietly does not light that surface. Nothing throws; the material
    // just stays dark at night while everything around it lifts, which reads as an art problem.
    const before = shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + LIGHT_GRID_PARS)
      // After <lights_fragment_end> so it ADDS to the existing rig rather than being overwritten by it.
      .replace('#include <lights_fragment_end>',
        '#include <lights_fragment_end>\n' +
        'reflectedLight.directDiffuse += lightGridContribution(vLGWorldPos, normal) * diffuseColor.rgb;');
    if (!shader.fragmentShader.includes('lightGridContribution(vLGWorldPos')) {
      const kind = mat.userData?._kind || mat.type;
      if (!_warnedKinds.has(kind)) {
        _warnedKinds.add(kind);
        console.warn('[lightgrid] "%s" has no <lights_fragment_end> — it will NOT be lit by street ' +
          'lamps. Unlit material type, or one with a hand-built fragment shader.', kind);
      }
      shader.fragmentShader = before;   // do not leave the unused pars/varying behind
    }
  }, 'lightGrid');
}

/**
 * DEV ONLY — 32 lamps around a point, so the cost can be measured before committing to the build.
 *
 * ⚠ These must be RE-PLACED as the camera moves. The grid window follows the camera; the lights do
 * not follow it by themselves. Place them once at spawn and after ~200 m of driving every cell in
 * view is empty, every slot fails `id < 0.5`, and the shader costs one texture fetch — which
 * measures nothing and reports a confident PASS. That is exactly the false pass this comment exists
 * to prevent.
 *
 * Laid out 8x4 at 22 m with radius 26, centred on the camera: the near field that actually fills the
 * screen sits inside several overlapping radii, so its cells saturate all 4 slots. That is the
 * worst case for fill cost, which is the honest thing for a gate to measure.
 */
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

/**
 * SPIKE A/B HARNESS — measures the grid's real cost without a human comparing two drives.
 *
 * Two separate 90 s runs are a bad instrument here: different route, different tiles in view,
 * different traffic, so a 1–2 ms difference is indistinguishable from having driven differently.
 * This flips `uLGEnabled` every INTERVAL_MS within ONE drive and compares the means. Same frame,
 * same geometry, same everything — the only variable is the grid.
 *
 * Discards the first sample after each flip: the frame that toggles also pays for whatever the
 * driver was doing at that instant, and a state change is exactly when a stall is most likely.
 */
const AB = { on: [], off: [], t0: 0, phase: 0, last: 0, done: false, skip: 0, occ: [], slots: [] };
const AB_INTERVAL_MS = 2500;
const AB_CYCLES = 8;            // 8 flips ≈ 20 s of driving

export function lightGridABTick(gpuMs) {
  if (AB.done || !_indexTex) return;
  const now = performance.now();
  if (AB.t0 === 0) { AB.t0 = now; AB.last = now; AB.skip = 2; return; }

  if (now - AB.last >= AB_INTERVAL_MS) {
    AB.last = now;
    AB.phase++;
    lightGridUniforms.uLGEnabled.value = AB.phase % 2 === 0 ? 1 : 0;
    AB.skip = 2;                                   // ignore the two frames straddling the flip
    if (AB.phase >= AB_CYCLES * 2) {
      AB.done = true;
      lightGridUniforms.uLGEnabled.value = 1;
      const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
      const p95 = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.95)]; };
      const mOn = mean(AB.on), mOff = mean(AB.off), d = mOn - mOff;
      const occ = mean(AB.occ), slots = mean(AB.slots);
      // A near-empty grid makes the shader early-out and the cost vanish. That is not a pass, it is
      // a failed experiment, and it must not be reported as a green light to spend a week.
      const valid = occ >= 40 && slots >= 1.5;
      // Template literal, not printf: the previous version drifted out of sync when args were
      // added (a stale header plus two new args shifted every value, printing "NaN off"), and its
      // escaped newlines rendered as literal \n in the console. Interpolation cannot desynchronise.
      const trunc = lightGridStats.truncated
        ? ` (TRUNCATED from ${lightGridStats.lightsOffered}, cap ${MAX_LIGHTS} — lamps beyond the nearest ${MAX_LIGHTS} are DARK)`
        : '';
      console.warn(
        `[lightgrid] RESULT — ${lightGridStats.lightCount} lamps${trunc}, ${AB.on.length} on / ${AB.off.length} off
  GPU mean   OFF ${mOff.toFixed(2)} ms   ON ${mOn.toFixed(2)} ms   DELTA ${d.toFixed(2)} ms
  GPU p95    OFF ${p95(AB.off).toFixed(2)} ms   ON ${p95(AB.on).toFixed(2)} ms   DELTA ${(p95(AB.on) - p95(AB.off)).toFixed(2)} ms
  WORK       ${occ.toFixed(0)} cells lit of ${GRID_DIM * GRID_DIM}, ${slots.toFixed(2)} lamps per lit cell  ->  ${valid ? 'grid was doing real work' : 'GRID WAS EMPTY — measurement is void'}
  GATE K-N: delta must be <= 3.0 ms  ->  ${!valid ? 'VOID — re-run, this measured nothing' : d <= 3.0 ? 'PASS' : 'FAIL — the approach is wrong'}`);
      window._ddLightGridAB = { meanOn: mOn, meanOff: mOff, delta: d,
                                p95On: p95(AB.on), p95Off: p95(AB.off), samples: AB.on.length + AB.off.length };
      return;
    }
  }
  AB.occ.push(lightGridStats.cellsOccupied);
  AB.slots.push(lightGridStats.meanOccupancy);
  if (AB.skip > 0) { AB.skip--; return; }
  if (!(gpuMs > 0)) return;
  (lightGridUniforms.uLGEnabled.value > 0.5 ? AB.on : AB.off).push(gpuMs);
}

/**
 * JS mirror of the GLSL falloff, for ONE fragment.
 *
 * ⚠ THIS DUPLICATES SHADER MATH AND MUST BE UPDATED WITH IT. That cost is accepted deliberately:
 * "the street is silently unlit" has now shipped twice — once from a grid with no lights in it,
 * once from an inverted cone sign — and in both cases the only symptom was a dark road, which is
 * indistinguishable from an art decision. Nothing throws, nothing is slow, nothing looks broken.
 * A canonical sample checked on the CPU turns that into a console line.
 *
 * @param dx,dy,dz  surface -> lamp, metres (dy > 0 means the lamp is ABOVE the surface)
 * @param normal    surface normal, unit
 */
export function lampContribution(dx, dy, dz, normal, opts = {}) {
  const radius = opts.radius ?? 48, intensity = opts.intensity ?? 0.2;
  const wrap = opts.wrap ?? 0.5, coneFloor = opts.coneFloor ?? 0.12, conePower = opts.conePower ?? 0.75;
  const dist = Math.hypot(dx, dy, dz);
  if (dist > radius) return 0;
  const t = Math.min(1, Math.max(0, 1 - dist / radius));
  const atten = t * t * (3 - 2 * t);                       // smoothstep
  const ux = dx / dist, uy = dy / dist, uz = dz / dist;
  const ndl = Math.min(1, Math.max(0,
    (normal.x * ux + normal.y * uy + normal.z * uz) * (1 - wrap) + wrap));
  const down = Math.min(1, Math.max(0, uy));               // +1 directly below the lamp
  const cone = coneFloor + (1 - coneFloor) * Math.pow(down, conePower);
  return intensity * atten * ndl * cone;
}

/**
 * One-time smoke test of the CONFIGURED parameters: does a lamp actually light the road beneath it?
 * Warns rather than throws — a dim street is a look bug, not a reason to stop the game.
 */
export function assertLightingVisible(opts) {
  const road = { x: 0, y: 1, z: 0 };
  const under = lampContribution(0, 8, 0, road, opts);      // road directly below an 8 m lamp head
  const mid = lampContribution(0, 8, 15, road, opts);       // 15 m along the street
  if (under < 0.02) {
    console.warn('[lightgrid] the configured lamp lights the road beneath it at %s — effectively ' +
      'DARK. Check intensity, radius, and the cone sign before assuming this is an art choice.',
      under.toFixed(4));
  }
  return { under, mid };
}
