/**
 * v3 P3-07 — asphalt shader v2.
 *
 * The GLSL cannot be executed here, so these test the two things that CAN go wrong silently: the
 * lane/rut maths (ported to JS and checked against real road dimensions) and the shader-injection
 * contract that D-30 caught the facade patch breaking.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LANE_W_M, ROAD_V2_PARS, ROAD_V2_APPLY, ROAD_V2_UNIFORMS, createAsphaltTexture } from '../src/map/roadMaterial.js';

// Faithful JS port of the GLSL rut placement.
const rutAt = (across, halfW = 6) => {
  const lane = Math.floor(across / LANE_W_M + 0.5);
  const laneLocal = across - lane * LANE_W_M;
  const rut = Math.exp(-Math.pow((Math.abs(laneLocal) - 0.9) * 3.2, 2));
  const laneValid = 1 - Math.min(1, Math.max(0, (halfW - 8) / (14 - 8)));
  return rut * laneValid;
};

test('ruts sit at a real car track width either side of the lane centre', () => {
  // A car's wheels are ~1.8 m apart, so ~0.9 m from the lane centre. That is the whole cue.
  assert.ok(rutAt(0.9) > 0.95, 'no rut at +0.9 m from lane centre');
  assert.ok(rutAt(-0.9) > 0.95, 'no rut at -0.9 m from lane centre');
  assert.ok(rutAt(0) < 0.1, 'there must be no rut ON the centreline — cars straddle it');
});

test('the rut pattern REPEATS per lane, so a multi-lane road has ruts in every lane', () => {
  for (const lane of [0, 1, 2, -1, -2]) {
    const centre = lane * LANE_W_M;
    assert.ok(rutAt(centre + 0.9) > 0.95, `lane ${lane} has no rut`);
    assert.ok(rutAt(centre) < 0.1, `lane ${lane} has a rut on its centreline`);
  }
});

test('ruts FADE OUT on wide surfaces where the lane model stops being true', () => {
  // Junction fans and plazas have a huge halfWidth; drawing lane ruts across them reads as stripes
  // sprayed over an open surface.
  assert.ok(rutAt(0.9, 6) > 0.95, 'a normal carriageway must keep its ruts');
  assert.ok(rutAt(0.9, 11) < 0.6, 'ruts must be fading by 11 m half-width');
  assert.equal(rutAt(0.9, 14), 0, 'and gone by 14 m');
});

test('rut strength stays in the SUBTLE band — past this they read as painted stripes', () => {
  assert.ok(ROAD_V2_UNIFORMS.uRoadRut > 0 && ROAD_V2_UNIFORMS.uRoadRut <= 0.15,
    `rut strength ${ROAD_V2_UNIFORMS.uRoadRut} is outside the subtle band`);
});

test('the asphalt repeat is a REAL-WORLD size', () => {
  // The point of the world-metric UV: 4 m must be 4 m on a service street and a trunk road.
  assert.ok(ROAD_V2_UNIFORMS.uAsphaltRepeatM >= 2 && ROAD_V2_UNIFORMS.uAsphaltRepeatM <= 8,
    'a repeat outside 2-8 m reads as either tiling wallpaper or featureless grey');
});

test('uv converts to METRES via halfWidth — not a width-dependent UV space', () => {
  // The point of (a): a 3.5 m lane must be 3.5 m on a service street and on a trunk road.
  const across = (uvY, halfW) => (uvY - 0.5) * 2.0 * halfW;
  assert.equal(across(1.0, 6), 6, 'uv.y=1 must be the road edge in metres');
  assert.equal(across(0.5, 6), 0, 'uv.y=0.5 must be the centreline');
  // Tolerance, not equality: (0.5 + 3.5/12 - 0.5) * 12 lands on 3.500000000000001 in binary float.
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `expected ~${b}, got ${a}`);
  near(across(0.5 + LANE_W_M / (2 * 6), 6), LANE_W_M);
  // The SAME physical offset on a road of a different width — a lane must be a lane either way.
  // Under the old width-relative UV these two would disagree, which is the bug (a) replaces.
  near(across(0.5 + LANE_W_M / (2 * 12), 12), LANE_W_M);
});

test('the injected GLSL declares its OWN varyings — D-30', () => {
  const src = ROAD_V2_PARS + ROAD_V2_APPLY;
  assert.ok(!src.includes('vMapUv'), 'vMapUv exists only under #ifdef USE_MAP; the road binds no map');
  assert.match(ROAD_V2_PARS, /varying float vHalfW/);
  assert.match(ROAD_V2_PARS, /varying vec2 vRoadUv/);
});

test('it MODULATES colour rather than replacing it — road colour is the vertex colour (D-31)', () => {
  assert.match(ROAD_V2_APPLY, /diffuseColor\.rgb \*=/, 'must multiply, not assign');
  assert.ok(!/diffuseColor\.rgb\s*=\s*[^*]/.test(ROAD_V2_APPLY), 'an assignment would drop the palette');
});

test('grain is a TEXTURE FETCH now, not per-fragment noise', () => {
  // The measured reason: ~40 ALU ops per fragment on the largest surface in the frame, and no mip
  // chain so it shimmered at grazing angles. `?roadv2=0` was faster than `?roadv2=1`.
  assert.match(ROAD_V2_APPLY, /texture2D\(uAsphalt/, 'grain must come from a sampler');
  const strip = (g) => g.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/roadNoise2|roadHash/.test(strip(ROAD_V2_PARS) + strip(ROAD_V2_APPLY)),
    'the per-fragment noise functions are back — that is the regression this replaced');
});

test('the baked asphalt texture is NEUTRAL, centred on 1.0 (D-31)', () => {
  // Road colour lives in the VERTEX COLOUR. A texture whose mean is not ~1.0 multiplies against a
  // tone that is already there and shifts every road in the city — the exact failure that turned
  // buildings black when the facade placeholders carried their own tints.
  const px = 64;
  const fakeTHREE = {
    CanvasTexture: class { constructor(c) { this.image = c; } },
    RepeatWrapping: 1000, LinearMipmapLinearFilter: 1008, LinearFilter: 1006, NoColorSpace: '',
  };
  // Minimal 2D-context stand-in: record what the generator writes.
  let written = null;
  global.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() {
      return {
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: (img) => { written = img; },
      };
    }
  };
  createAsphaltTexture(fakeTHREE, px);
  assert.ok(written, 'generator never wrote pixels');
  let sum = 0;
  for (let i = 0; i < px * px; i++) sum += written.data[i * 4];
  const mean = sum / (px * px) / 255;
  assert.ok(Math.abs(mean - 1.0) < 0.02, `texture mean is ${mean.toFixed(3)}, not ~1.0 — every road shifts`);
  delete global.OffscreenCanvas;
});

test('the injection touches NOTHING that is out of scope at <color_fragment>', () => {
  // Measured 2026-08-26: the patch wrote `roughnessFactor`, which three declares in
  // <roughnessmap_fragment> — AFTER the injection point. The road shader failed to compile and the
  // road VANISHED, leaving lane paint and crosswalks drawn over bare terrain.
  //   ERROR: 0:995: 'roughnessFactor' : undeclared identifier   [Material Type: MeshLambertMaterial]
  // The material type matters too: patchRoadAO is shared with Lambert surfaces, which have no
  // roughness at all, so the term could not be written unconditionally even at the right point.
  for (const later of ['roughnessFactor', 'metalnessFactor', 'reflectedLight', 'geometryNormal', 'material.']) {
    assert.ok(!ROAD_V2_APPLY.includes(later),
      `${later} is not in scope at <color_fragment> — this failed to compile and hid every road`);
  }
});

test('no stray backtick can terminate the GLSL template literal', () => {
  // Twice now a backtick used to quote an identifier inside a GLSL comment closed the template
  // string early and broke the build. The literals must contain none at all.
  assert.ok(!ROAD_V2_PARS.includes('`'), 'ROAD_V2_PARS contains a backtick');
  assert.ok(!ROAD_V2_APPLY.includes('`'), 'ROAD_V2_APPLY contains a backtick');
});

test('the shader carries NO transcendental in its hot path', () => {
  // Roads have the largest screen coverage in the game and sit on a MeshStandardMaterial, already
  // the expensive path. The textbook fract(sin(dot(...))) hash costs a transcendental and
  // roadNoise2 calls it FOUR times per fragment — that was felt as frame weight on 2026-08-26.
  // Comments are stripped first: they mention the ops precisely because they explain their removal.
  const strip = (glsl) => glsl.replace(/\/\/[^\n]*/g, '');
  const code = strip(ROAD_V2_PARS) + strip(ROAD_V2_APPLY);
  assert.ok(!/\bsin\s*\(/.test(code), 'sin() in the road fragment path');
  assert.ok(!/\bcos\s*\(/.test(code), 'cos() in the road fragment path');
  assert.ok(!/\bpow\s*\(/.test(code), 'pow() in the road fragment path — use x*x');
  // One exp for the rut falloff is the deliberate exception; more than one needs justifying.
  assert.ok((code.match(/\bexp\s*\(/g) || []).length <= 1, 'more than one exp() per fragment');
});
