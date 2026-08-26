/**
 * The KTX2 library (v3 P3-GATE-01). Every failure mode here is silent at build time and only shows
 * up as a 404 plus an untextured surface mid-drive, so it has to be a test.
 *
 * Background: P3's exit gate caps resident texture VRAM at 200 MiB. Only the facade arrays were
 * ever encoded; the rest of the world shipped as PNG and decoded to full RGBA8 — 153.3 MiB of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'src';
const PUB = 'public';

/** Every `/textures/...ktx2` literal the source asks for, including template-built ones. */
function requestedTextures() {
  const out = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/['"`](\/textures\/[^'"`$]+\.ktx2)['"`]/g)) out.add(m[1]);
      // template form: `${BASE}/${name}_albedo.ktx2` with BASE = '/textures/road'
      for (const m of src.matchAll(/\$\{BASE\}\/\$\{name\}_(albedo|normal)\.ktx2/g)) {
        const base = src.match(/const BASE = '([^']+)'/)?.[1];
        const manifest = 'src/map/roadTextures.js';
        if (base && fs.existsSync(manifest)) {
          // roadTextures.js is generated JSON-ish, so the key is quoted: "name": "asphalt_worn"
          for (const n of fs.readFileSync(manifest, 'utf8').matchAll(/"name":\s*"([^"]+)"/g)) {
            out.add(`${base}/${n[1]}_${m[1]}.ktx2`);
          }
        }
      }
      // template form: `/textures/sky/${file}.ktx2`
      for (const m of src.matchAll(/\/textures\/(\w+)\/\$\{file\}\.ktx2/g)) {
        for (const f of src.matchAll(/\['u\w+',\s*'([^']+)'\]/g)) out.add(`/textures/${m[1]}/${f[1]}.ktx2`);
      }
    }
  };
  walk(SRC);
  return [...out];
}

test('every KTX2 the source requests exists on disk', () => {
  const req = requestedTextures();
  assert.ok(req.length >= 15, `expected the whole library, found ${req.length}`);
  const missing = req.filter((u) => !fs.existsSync(path.join(PUB, u.replace(/^\//, ''))));
  assert.deepEqual(missing, [], 'missing encodes — run tools/build-ktx2-library.py');
});

test('every KTX2 has the .half variant the LOW tier requests', () => {
  // QUALITY.textureVariant === 'half' rewrites the URL. Nothing ever emitted these, so LOW-tier
  // devices were requesting name.half.ktx2 and getting a 404 on every world surface.
  const missing = requestedTextures()
    .map((u) => path.join(PUB, u.replace(/^\//, '').replace(/\.ktx2$/, '.half.ktx2')))
    .filter((f) => !fs.existsSync(f));
  assert.deepEqual(missing, [], 'missing half variants — run tools/build-ktx2-library.py');
});

test('no live source still loads a converted texture as PNG/JPG', () => {
  const converted = /(tree_atlas|bush_atlas|rock_atlas|asphalt_\w+|panot|kerb_granite|sky_clouds|railway_01|wall_01)_?\w*\.(png|jpg)/;
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        // comments may still name the old file when explaining the change
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (converted.test(line)) offenders.push(`${p}: ${line.trim().slice(0, 90)}`);
      }
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], 'these still load uncompressed — they decode to full RGBA8');
});

test('the encoded library fits the VRAM the gate allows', () => {
  // BC7 (uastc) 1 B/texel, BC1 (etc1s) 0.5 B/texel, +1/3 for the mip chain. The PNG set this
  // replaced measured 153.3 MiB; the gate caps the WHOLE resident set at 200 MiB and the facade
  // arrays plus render targets already claim ~89 of it.
  let bytes = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ktx2') && !e.name.endsWith('.half.ktx2')) bytes += fs.statSync(p).size;
    }
  };
  walk(path.join(PUB, 'textures'));
  const diskMiB = bytes / 1048576;
  assert.ok(diskMiB < 20, `world-texture KTX2 is ${diskMiB.toFixed(1)} MB on disk — expected < 20`);
});
