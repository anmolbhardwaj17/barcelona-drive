#!/usr/bin/env node
/**
 * Texture optimization pipeline for Delhi Drive.
 *
 * Rules (first match wins):
 *   buildings/**          → 1024×1024  JPG  q82
 *   wall/** / walls/**    →  512×512   JPG  q82
 *   roads/**              → 1024×1024  JPG  q82
 *   terrain/**            → 1024×1024  JPG  q82
 *   railway/**            → 1024×1024  PNG  lossless
 *   sidewalks/**          →  512×512   PNG  lossless
 *   water/**              →  512×512   PNG  lossless
 *   decals/paan_stain_*   →  256×256   PNG  lossless
 *   decals/wall_notice_*  →  256×256   PNG  lossless
 *   decals/**             →  512×512   PNG  lossless
 *
 * Only image files are processed (.jpg .jpeg .png .webp).
 * Files in "new textures/" and "trees/" are intentionally skipped
 * (asset packs / pre-optimised webp atlases).
 *
 * Run via:  npm run optimize:textures
 */

import sharp from 'sharp';
import { readdir, stat, rename } from 'node:fs/promises';
import { join, relative, extname, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const TEXTURES    = join(__dirname, '..', 'public', 'textures');

// ─── Skip folders (non-texture asset packs, pre-optimised atlases) ────────────
const SKIP_DIRS = new Set(['new textures', 'trees']);

// ─── Rule table ───────────────────────────────────────────────────────────────
// Each rule: { prefix, namePrefix?, width, height, format, quality? }
// `prefix`     — folder path relative to TEXTURES root (forward slashes)
// `namePrefix` — optional basename prefix filter
// First rule whose prefix and optional namePrefix both match is applied.
const RULES = [
  // Decals — per-name-prefix variants first so they override the catch-all
  { prefix: 'decals', namePrefix: 'paan_stain_',  width: 256,  height: 256,  format: 'png' },
  { prefix: 'decals', namePrefix: 'wall_notice_', width: 256,  height: 256,  format: 'png' },
  { prefix: 'decals',                              width: 512,  height: 512,  format: 'png' },

  // Buildings
  { prefix: 'buildings', width: 1024, height: 1024, format: 'jpg', quality: 82 },

  // Walls (both spellings: wall/ singular used in project, walls/ for future)
  { prefix: 'wall',  width: 512, height: 512, format: 'jpg', quality: 82 },
  { prefix: 'walls', width: 512, height: 512, format: 'jpg', quality: 82 },

  // Roads
  { prefix: 'roads',   width: 1024, height: 1024, format: 'jpg', quality: 82 },

  // Terrain
  { prefix: 'terrain', width: 1024, height: 1024, format: 'jpg', quality: 82 },

  // PNG-preserving types
  { prefix: 'railway',   width: 1024, height: 1024, format: 'png' },
  { prefix: 'sidewalks', width: 512,  height: 512,  format: 'png' },
  { prefix: 'water',     width: 512,  height: 512,  format: 'png' },
];

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtBytes(n) {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)}MB`;
  return `${(n / 1024).toFixed(0)}KB`;
}

function fmtPct(before, after) {
  const pct = Math.round((1 - after / before) * 100);
  return `${pct}%`;
}

/** Find the first matching rule for a relative path like "buildings/residential/foo.jpg". */
function matchRule(relPath, name) {
  const fwd = relPath.replace(/\\/g, '/');
  for (const rule of RULES) {
    // prefix check: relPath must start with the rule prefix (handles sub-folders)
    if (!fwd.startsWith(rule.prefix + '/') && fwd !== rule.prefix) continue;
    // optional name prefix check
    if (rule.namePrefix && !name.startsWith(rule.namePrefix)) continue;
    return rule;
  }
  return null;
}

/** Recursively collect all image files under dir, skipping SKIP_DIRS. */
async function collectImages(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      results.push(...await collectImages(join(dir, e.name)));
    } else if (e.isFile()) {
      const ext = extname(e.name).toLowerCase();
      if (IMAGE_EXTS.has(ext)) results.push(join(dir, e.name));
    }
  }
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const files  = await collectImages(TEXTURES);
  let processed = 0, skipped = 0;
  let totalBefore = 0, totalAfter = 0;

  console.log(`\nDelhi Drive — texture optimizer`);
  console.log(`Scanning ${files.length} image files in ${TEXTURES}\n`);

  for (const file of files) {
    const rel   = relative(TEXTURES, file);
    const name  = basename(file);
    const ext   = extname(name).toLowerCase();
    const rule  = matchRule(rel, name);

    if (!rule) {
      console.log(`  SKIP  ${rel}  (no rule matched)`);
      skipped++;
      continue;
    }

    const { before } = await stat(file).then(s => ({ before: s.size }));

    // Determine output path (may change extension)
    const targetExt = rule.format === 'jpg' ? '.jpg' : '.png';
    const outFile   = ext === targetExt ? file : join(dirname(file), basename(name, ext) + targetExt);
    const tmpFile   = outFile + '.tmp';

    try {
      let pipeline = sharp(file).resize(rule.width, rule.height, {
        fit: 'cover',         // maintain aspect ratio, fill target dimensions
        withoutEnlargement: false, // always resize to exact target
      });

      if (rule.format === 'jpg') {
        pipeline = pipeline.jpeg({ quality: rule.quality ?? 82, mozjpeg: true });
      } else {
        pipeline = pipeline.png({ compressionLevel: 9, effort: 10 });
      }

      await pipeline.toFile(tmpFile);
      const after = (await stat(tmpFile)).size;

      // Overwrite source (handles extension change: remove old, rename tmp to new name)
      if (outFile !== file) {
        // Extension changed — remove original, rename tmp to new name
        const { unlink } = await import('node:fs/promises');
        await rename(tmpFile, outFile);
        await unlink(file);
      } else {
        await rename(tmpFile, outFile);
      }

      totalBefore += before;
      totalAfter  += after;
      processed++;

      const tag = after < before ? '✓' : '~';
      const relOut = relative(TEXTURES, outFile);
      console.log(`  ${tag}  ${relOut}`);
      console.log(`     ${fmtBytes(before)} → ${fmtBytes(after)}  (${fmtPct(before, after)} reduction)  [${rule.width}×${rule.height} ${rule.format.toUpperCase()}]`);

    } catch (err) {
      // Clean up tmp if it exists
      try { const { unlink } = await import('node:fs/promises'); await unlink(tmpFile); } catch {}
      console.error(`  ✗  ${rel}  ERROR: ${err.message}`);
      skipped++;
    }
  }

  console.log('\n─────────────────────────────────────────────');
  console.log(`Processed : ${processed} files`);
  console.log(`Skipped   : ${skipped} files`);
  if (processed > 0) {
    console.log(`Total     : ${fmtBytes(totalBefore)} → ${fmtBytes(totalAfter)}  (${fmtPct(totalBefore, totalAfter)} reduction)`);
  }
  console.log('─────────────────────────────────────────────\n');
}

main().catch(err => { console.error(err); process.exit(1); });
