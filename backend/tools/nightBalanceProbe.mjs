/**
 * nightBalanceProbe.mjs — what brightness does the night road ACTUALLY land on? (v3 P-L1)
 *
 * WHY THIS EXISTS. P-L1 cut the night ambient floor from 1.0 to 0.32 and the exposure from 1.5 to
 * 1.15. The obvious risk of that change is the exact concern the old comment defended — "geometry
 * must survive as blue-charcoal masses, not voids" — and the only way that gets checked is a drive
 * at night, which is slow and subjective. This computes the number instead.
 *
 * It uses the REAL `lampContribution` from lightGrid.js and the REAL presets from envPresets.js, so
 * it cannot drift from what ships. What it models is one horizontal patch of carriageway lit by
 * ambient + hemisphere + moon + the nearest street lamps, through three's ACES curve at the
 * preset's exposure.
 *
 * WHAT IT CANNOT TELL YOU: bloom, the colour grade, AO, and every other surface in the frame. It
 * answers one question — "is the road between lamps black, and is the pool actually brighter than
 * the gap?" — which is the question P-L1 turns on.
 *
 * Usage:  node backend/tools/nightBalanceProbe.mjs
 */
import { lampContribution } from '../../frontend/src/map/lightGrid.js';
import { DAY, NIGHT } from '../../frontend/src/ui/envPresets.js';
import BCN from '../../frontend/src/regions/barcelona.js';

// ── scene constants, all read from the shipping code or the region config ────────────────────
const ASPHALT = 0x4a4a4a;        // roadRenderer.js:5989 BCN_COLORS.ASPHALT_BASE
// ⚠ READ FROM THE REGION CONFIG, NEVER HARDCODED. rebuildLightGrid() resolves these as
// `REGION.night?.lampRadiusM ?? 26` — and the first version of this probe used those `??` FALLBACKS
// (26 m / 1.1), which never apply. It produced a confident, fully self-consistent tune for a lamp
// configuration the game does not have. The real values are 48 m / 0.36.
const LAMP_COLOR = BCN.night.lampColor;
const LAMP_RADIUS = Number(process.env.LAMP_RADIUS ?? BCN.night.lampRadiusM);
const LAMP_INTENSITY = Number(process.env.LAMP_INTENSITY ?? BCN.night.lampIntensity);
const LAMP_SPACING = 22;         // Gran Via, metres
const LAMP_HEIGHT = 8;           // metres above the carriageway
const MOON_NDL = 0.707;          // moon at ~45 deg
const UP = { x: 0, y: 1, z: 0 };

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const hexToLinear = (h) => [16, 8, 0].map((s) => srgbToLinear(((h >> s) & 255) / 255));

/** three's ACESFilmicToneMapping, including its 1/0.6 pre-scale. */
const ACES_IN = [[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]];
const ACES_OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
const mul = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
function aces(rgb, exposure) {
  let v = rgb.map((c) => (c * exposure) / 0.6);
  v = mul(ACES_IN, v);
  v = v.map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081));
  v = mul(ACES_OUT, v);
  return v.map((x) => Math.min(1, Math.max(0, x)));
}

/** Irradiance on an up-facing road patch, `offset` metres along the street from a lamp. */
function irradiance(preset, offset) {
  const amb = hexToLinear(preset.ambientColor).map((c) => c * preset.ambientIntensity);
  const hemi = hexToLinear(preset.hemiSkyColor).map((c) => c * preset.hemiIntensity);
  const moon = hexToLinear(preset.dirColor).map((c) => c * preset.dirIntensity * MOON_NDL);
  const lampLin = hexToLinear(LAMP_COLOR);
  const lamp = [0, 0, 0];
  // Every lamp within reach along the street, both directions.
  for (let k = -3; k <= 3; k++) {
    const along = k * LAMP_SPACING - offset;
    const c = lampContribution(along, LAMP_HEIGHT, 0, UP, { radius: LAMP_RADIUS, intensity: LAMP_INTENSITY });
    for (let i = 0; i < 3; i++) lamp[i] += lampLin[i] * c;
  }
  return [0, 1, 2].map((i) => amb[i] + hemi[i] + moon[i] + lamp[i]);
}

function sample(preset, offset) {
  const alb = hexToLinear(ASPHALT);
  const rad = irradiance(preset, offset).map((c, i) => c * alb[i]);
  const px = aces(rad, preset.toneMappingExposure).map((c) => Math.round(linearToSrgb(c) * 255));
  const luma = 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2];
  // Hue read: >0 means warmer than neutral (sodium winning), <0 bluer (ambient winning).
  const warmth = (px[0] - px[2]) / Math.max(1, luma);
  return { px, luma, warmth };
}

const OLD_NIGHT = { ...NIGHT, ambientIntensity: 1.0, hemiIntensity: 0.6, dirIntensity: 0.7, toneMappingExposure: 1.5 };

console.log('\nNight carriageway, sRGB 0-255 — asphalt 0x4a4a4a under ambient+hemi+moon+lamps\n');
const rows = [
  ['BEFORE P-L1', OLD_NIGHT],
  ['AFTER  P-L1', NIGHT],
];
for (const [label, preset] of rows) {
  const under = sample(preset, 0);                    // directly beneath a lamp
  const between = sample(preset, LAMP_SPACING / 2);   // midway between two
  const contrast = under.luma / Math.max(0.01, between.luma);
  console.log(`${label}`);
  console.log(`  under lamp   rgb(${under.px.join(', ')})   luma ${under.luma.toFixed(1).padStart(5)}   warmth ${under.warmth >= 0 ? '+' : ''}${under.warmth.toFixed(2)}`);
  console.log(`  between      rgb(${between.px.join(', ')})   luma ${between.luma.toFixed(1).padStart(5)}   warmth ${between.warmth >= 0 ? '+' : ''}${between.warmth.toFixed(2)}`);
  console.log(`  pool contrast (under / between)  ${contrast.toFixed(2)}x`);
  console.log('');
}

const d = sample(DAY, 999);
console.log(`DAY reference (no lamps)   rgb(${d.px.join(', ')})   luma ${d.luma.toFixed(1)}\n`);

// ── what this is allowed to conclude ─────────────────────────────────────────────────────────
// The pass/fail here is deliberately narrow. This model has no bloom, no colour grade, no AO, no
// headlights and no sky, so it can rule things OUT but must not be used to declare the night frame
// good. Two checks only, both about failures that are unambiguous at this level.
const between = sample(NIGHT, LAMP_SPACING / 2);
const under = sample(NIGHT, 0);
const swing = under.warmth - between.warmth;
const problems = [];
if (between.luma < 6) problems.push(`road between lamps is effectively BLACK (luma ${between.luma.toFixed(1)}) — the void the old 1.0 floor defended against`);
// The G deficit is REPORTED, not failed on. It shrinks with P-L1 (10 -> 7) but does not vanish,
// because hemi and moon are blue too, not just the ambient — and sweeping the ambient hue moves it
// by 1. What this model cannot see is the colour grade, whose night branch clamps saturation to
// 1.05 once a pixel is dark (`colorGradePass.js:49`). That clamp could not engage at the old
// brightness and can at the new one, so the visible result should improve by more than these
// numbers show. That is a prediction, and the drive is what settles it.
const gDef = Math.min(between.px[0], between.px[2]) - between.px[1];
console.log(`green deficit between lamps: ${gDef} (magenta signature: sodium supplies R, the sky rig supplies B, neither supplies G)`);
console.log(`warm/cool swing under->between: ${swing >= 0 ? '+' : ''}${swing.toFixed(2)}  (bigger = the street reads as lamps in the dark rather than one flat wash)\n`);
if (problems.length) { console.log('PROBLEMS:'); problems.forEach((p) => console.log('  x ' + p)); process.exit(1); }
console.log('OK: road between lamps is dark but not black. The green deficit above is a measurement, not a pass — see the note in the source.\n');
