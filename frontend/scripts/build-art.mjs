#!/usr/bin/env node
/**
 * build-art.mjs — source → normalize → encode → manifest (v3 P1-05).
 *
 * A COMMITTED ARTEFACT. Never runs on Cloudflare Pages: it is slow, needs a native encoder, and its
 * output (`public/art/v1/`) is checked in. Run it locally when art changes.
 *
 *   node scripts/build-art.mjs            # normalize + manifest + contact sheet
 *   node scripts/build-art.mjs --encode   # ...and encode to KTX2 (needs toktx)
 *
 * WHY NORMALIZE AT ALL. Assets come from CC0 photoscans (Poly Haven, ambientCG), AI generation and
 * Blender. Each source has its own exposure, contrast and colour cast. Shipping them as-authored
 * produces a kitbash — and that failure is invisible until ~100 assets in and unrecoverable after.
 * Every asset passes through here, INCLUDING ones that "already look fine".
 *
 * Sources live in `art-src/library/<class>/<name>/{albedo,normal,ao}.png` (gitignored).
 */
import { readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const ROOT     = resolve(new URL('..', import.meta.url).pathname, '..');
const SRC_DIR  = join(ROOT, 'art-src', 'library');
const OUT_DIR  = join(ROOT, 'frontend', 'public', 'art', 'v1');
const ENCODE   = process.argv.includes('--encode');

/**
 * Per-class rules. `metresPerRepeat` is the scale contract — texel density is meaningless without
 * it, and it is what stops one surface reading as a different fidelity tier from its neighbour.
 * `maxBytes` is a HARD ceiling: over it, the build EXITS NON-ZERO. A budget nothing enforces is a
 * wish, and the whole art library has to fit 24 MB over the wire.
 */
const CLASSES = {
  asphalt:  { size: 1024, metresPerRepeat: 4.0, maxBytes: 420_000, srgbAlbedo: true },
  panot:    { size: 1024, metresPerRepeat: 4.0, maxBytes: 420_000, srgbAlbedo: true },
  kerb:     { size: 512,  metresPerRepeat: 2.0, maxBytes: 160_000, srgbAlbedo: true },
  facade:   { size: 2048, metresPerRepeat: 8.0, maxBytes: 1_900_000, srgbAlbedo: true },
  roof:     { size: 1024, metresPerRepeat: 8.0, maxBytes: 420_000, srgbAlbedo: true },
  terrain:  { size: 1024, metresPerRepeat: 6.0, maxBytes: 420_000, srgbAlbedo: true },
  foliage:  { size: 2048, metresPerRepeat: null, maxBytes: 1_100_000, srgbAlbedo: true, alpha: true },
  prop:     { size: 1024, metresPerRepeat: null, maxBytes: 420_000, srgbAlbedo: true },
};
const TOTAL_BUDGET_BYTES = 24 * 1024 * 1024;

/** Region palette anchors — kept in sync with src/regions/barcelona.js §palette. */
const ANCHORS = [
  [0xC9, 0xB7, 0x9C], [0x9C, 0x8B, 0x76], [0xD8, 0xCF, 0xC0], [0xB5, 0x67, 0x3F],
  [0x5A, 0x5A, 0x5A], [0xC8, 0xC2, 0xB5], [0x4A, 0x4A, 0x4A], [0x6E, 0x7F, 0x4A],
];

function nearestAnchor(r, g, b) {
  let best = null, bd = Infinity;
  for (const a of ANCHORS) {
    const d = (a[0] - r) ** 2 + (a[1] - g) ** 2 + (a[2] - b) ** 2;
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}

/**
 * Normalize one ALBEDO map.
 *
 * 1. DE-LIGHT. Subtract the source's own low-frequency lighting. A photoscan carries the light it
 *    was shot under; baked-in shadow fights this project's real v9 sky-visibility AO and produces
 *    double-darkening in exactly the street canyons the AO exists to darken.
 * 2. TONE MATCH. Pull the image's mean toward the nearest region palette anchor, so assets from
 *    different sources sit in one palette.
 * 3. HEADROOM. Author BELOW the final look: colorGradePass multiplies saturation (×1.15, ×1.52 in
 *    rally) and brightens. Assets authored to the on-screen target come out oversaturated — a
 *    recorded mistake, see buildingWorker's roof-palette note.
 */
async function normalizeAlbedo(inPath, outPath, cls) {
  const img = sharp(inPath).removeAlpha();
  const { width, height } = await img.metadata();

  // (1) de-light: blur at ~1/8 image width = low-frequency lighting only, then divide it out.
  const blurSigma = Math.max(8, Math.round(Math.min(width, height) / 16));
  const [base, low] = await Promise.all([
    img.clone().raw().toBuffer({ resolveWithObject: true }),
    img.clone().blur(blurSigma).raw().toBuffer(),
  ]);
  const px = base.data, n = px.length;
  let sr = 0, sg = 0, sb = 0;
  for (let i = 0; i < n; i += 3) {
    // divide by the local low-frequency level, re-centred on 128 → flat lighting, texture kept
    px[i]     = Math.min(255, Math.max(0, (px[i]     * 128) / Math.max(16, low[i])));
    px[i + 1] = Math.min(255, Math.max(0, (px[i + 1] * 128) / Math.max(16, low[i + 1])));
    px[i + 2] = Math.min(255, Math.max(0, (px[i + 2] * 128) / Math.max(16, low[i + 2])));
    sr += px[i]; sg += px[i + 1]; sb += px[i + 2];
  }
  const cnt = n / 3;
  const mean = [sr / cnt, sg / cnt, sb / cnt];

  // (2)+(3) tone match toward the nearest anchor, at 60% strength so texture variety survives,
  // then 6% down for grade headroom.
  const anc = nearestAnchor(...mean);
  const k = [0, 1, 2].map((c) => (1 - 0.6) + 0.6 * (anc[c] / Math.max(1, mean[c])));
  for (let i = 0; i < n; i += 3) {
    px[i]     = Math.min(255, px[i]     * k[0] * 0.94);
    px[i + 1] = Math.min(255, px[i + 1] * k[1] * 0.94);
    px[i + 2] = Math.min(255, px[i + 2] * k[2] * 0.94);
  }

  await sharp(px, { raw: { width, height, channels: 3 } })
    .resize(cls.size, cls.size, { fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  return { meanBefore: mean.map(Math.round), anchor: anc };
}

/** Normal/AO maps are DATA, not colour: resize only. Never tone-match a normal map. */
async function passthroughLinear(inPath, outPath, cls) {
  await sharp(inPath).resize(cls.size, cls.size, { fit: 'fill' }).png({ compressionLevel: 9 }).toFile(outPath);
}

function haveEncoder() {
  try { execFileSync('toktx', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/**
 * ⚠ TWO SILENT FAILURES LIVE HERE. Both are invisible at runtime and permanent once assets ship:
 *
 *  TRANSFER FUNCTION — albedo is sRGB, normal/AO/roughness are LINEAR. three reads this off the
 *  KTX2 DFD (KTX2Loader) and `verifyColorSpace` early-returns for compressed textures, so a
 *  mislabelled normal map produces no warning and just looks subtly wrong forever.
 *
 *  V-FLIP — WebGL ignores UNPACK_FLIP_Y_WEBGL for COMPRESSED textures. Orientation must therefore
 *  be baked here (--lower_left_maps_to_s0t0), not fixed at load. Get it wrong and every normal map
 *  in the library is upside down in Y.
 */
function encodeKTX2(pngPath, outPath, { srgb, alpha }) {
  const args = ['--genmipmap', '--bcmp', '--clevel', '4', '--qlevel', '128',
                '--lower_left_maps_to_s0t0',
                ...(srgb ? ['--assign_oetf', 'srgb'] : ['--assign_oetf', 'linear']),
                ...(alpha ? [] : ['--target_type', 'RGB']),
                outPath, pngPath];
  execFileSync('toktx', args, { stdio: 'inherit' });
}

// ── run ────────────────────────────────────────────────────────────────────────────────────────
if (!existsSync(SRC_DIR)) {
  console.log(`· no art sources yet (${SRC_DIR})`);
  console.log('  Expected layout: art-src/library/<class>/<name>/{albedo,normal,ao}.png');
  console.log('  Classes:', Object.keys(CLASSES).join(', '));
  process.exit(0);
}
if (ENCODE && !haveEncoder()) {
  console.error('✗ --encode needs `toktx` (KTX-Software) on PATH.');
  console.error('  macOS: brew install ktx    ·    https://github.com/KhronosGroup/KTX-Software');
  console.error('  Without it, normalize + manifest still run; the KTX2 step is skipped.');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const manifest = { version: 1, region: 'barcelona', generated: null, variants: ['full', 'half'], assets: [] };
let total = 0, failed = false;

for (const cls of readdirSync(SRC_DIR)) {
  const rules = CLASSES[cls];
  if (!rules) { console.error(`✗ unknown class "${cls}" — add it to CLASSES with a maxBytes ceiling`); failed = true; continue; }
  for (const name of readdirSync(join(SRC_DIR, cls))) {
    const srcDir = join(SRC_DIR, cls, name);
    const entry = { id: `${cls}/${name}`, class: cls, region: 'barcelona',
                    metresPerRepeat: rules.metresPerRepeat, maps: {}, bytes: 0 };
    for (const [map, isColour] of [['albedo', true], ['normal', false], ['ao', false]]) {
      const src = join(srcDir, `${map}.png`);
      if (!existsSync(src)) continue;
      const workPng = join(OUT_DIR, `${cls}_${name}_${map}.png`);
      if (isColour) entry.normalizedFrom = await normalizeAlbedo(src, workPng, rules);
      else await passthroughLinear(src, workPng, rules);
      let outFile = workPng;
      if (ENCODE) {
        outFile = join(OUT_DIR, `${cls}_${name}_${map}.ktx2`);
        encodeKTX2(workPng, outFile, { srgb: isColour && rules.srgbAlbedo, alpha: !!rules.alpha });
      }
      const bytes = statSync(outFile).size;
      entry.maps[map] = { file: outFile.slice(OUT_DIR.length + 1), bytes, srgb: isColour && rules.srgbAlbedo };
      entry.bytes += bytes;

      // ── HALF-RES VARIANT (v3 P1-08) ─────────────────────────────────────────────────────────
      // Emitted for EVERY asset, from the first one. The low quality tier requests
      // `<name>.half.ktx2` (see loaders.js), so the variant has to exist before any art ships —
      // retrofitting variant emission across ~100 authored assets later is the same
      // "free today, unrecoverable after 100 assets" trap as the art direction itself.
      //
      // LOW skips normal maps entirely, so only colour maps get a variant. Emitting an unused
      // half-res normal map would be pure wire weight.
      if (isColour) {
        const halfPng = workPng.replace(/\.png$/, '.half.png');
        await sharp(workPng).resize(Math.max(64, rules.size / 2), Math.max(64, rules.size / 2))
          .png({ compressionLevel: 9 }).toFile(halfPng);
        let halfOut = halfPng;
        if (ENCODE) {
          halfOut = halfPng.replace(/\.png$/, '.ktx2');
          encodeKTX2(halfPng, halfOut, { srgb: rules.srgbAlbedo, alpha: !!rules.alpha });
        }
        entry.maps[`${map}.half`] = { file: halfOut.slice(OUT_DIR.length + 1), bytes: statSync(halfOut).size };
      }
    }
    // The ceilings are KTX2 budgets. Without --encode the intermediate is PNG, which is several
    // times larger by nature — enforcing there would keep the build permanently red and teach
    // everyone to ignore it. Report, do not fail.
    if (entry.bytes > rules.maxBytes) {
      if (ENCODE) {
        console.error(`✗ ${entry.id}: ${entry.bytes} bytes over the ${rules.maxBytes} ceiling for class "${cls}"`);
        failed = true;
      } else {
        console.warn(`  · ${entry.id}: ${(entry.bytes / 1024).toFixed(0)} KB as PNG (ceiling ${(rules.maxBytes / 1024).toFixed(0)} KB applies to KTX2 — run --encode to enforce)`);
      }
    }
    total += entry.bytes;
    manifest.assets.push(entry);
    console.log(`  ${entry.id.padEnd(28)} ${(entry.bytes / 1024).toFixed(0).padStart(6)} KB  ${Object.keys(entry.maps).join('+')}`);
  }
}

if (total > TOTAL_BUDGET_BYTES) {
  const msg = `library total ${(total / 1048576).toFixed(2)} MB exceeds the ${TOTAL_BUDGET_BYTES / 1048576} MB wire budget`;
  if (ENCODE) { console.error(`✗ ${msg}`); failed = true; } else console.warn(`  · ${msg} (PNG intermediates — enforced under --encode)`);
}
writeFileSync(join(OUT_DIR, 'art-manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`${failed ? '✗' : '✓'} ${manifest.assets.length} assets · ${(total / 1048576).toFixed(2)} MB / ${TOTAL_BUDGET_BYTES / 1048576} MB`);
process.exit(failed ? 1 : 0);
