/**
 * THE ROAD-FIELD PIPELINE GUARD.
 *
 * ═══ WHY THIS EXISTS ════════════════════════════════════════════════════════════════════════════
 *
 * A road record is copied FIELD BY FIELD at SEVEN points between the PBF and the entity systems:
 *
 *   1. buildRegion.deepCloneRoad
 *   2. RoadGeometryBuilder — the `result.push({...})` in buildRoadGeometry
 *   3. tileSplit.clipRoadsForTile        (x3 copy sites in one file)
 *   4. buildRegion — the tile-record map that becomes the tile JSON
 *   5. convertToBinary — the binary header entry
 *   6. tileParserWorker.readRoads        (frontend side)
 *   7. tileManager.getLoadedRoadSegments (runtime projection → traffic, parked cars, pedestrians)
 *
 * Every one is a WHITELIST. A field absent from any single one ceases to exist from that point on —
 * silently, as `undefined`, with no error, no warning and no failing test. This has now bitten three
 * times, all with the same signature:
 *
 *   · D-42: `getLoadedRoadSegments` dropped bridge/isRamp/layer/crossesTrench, so the "no street
 *     parking against a guard rail" gate read `undefined` on every term and did nothing for its
 *     entire life. It shipped, was reviewed, and was believed to work.
 *   · R-W1, first bake: the width section was added to five of the six and still arrived at the
 *     tiles empty in ALL 2,148 road records — `deepCloneRoad` had it not.
 *   · R-W1, second look: `RoadGeometryBuilder` had it not either.
 *   · R-W1, third look: `getLoadedRoadSegments` — the very function D-42 is about, carrying a
 *     comment I had just written warning that it is a whitelist — dropped the width section, so
 *     parked cars and pedestrians silently ran on the fallback table. Writing the warning is not
 *     the same as reading it, which is the argument for a test over a comment in one line.
 *
 * Unit tests cannot catch this. The width model was 19/19 green while the pipeline emitted nothing
 * — exactly D-29 ("a suite that only unit-tests the parts of a pipeline can be 100% green while the
 * pipeline produces nothing"). The only thing that catches it is checking the copies against each
 * other, which is what this file does, by READING THE SOURCE.
 *
 * ═══ IF THIS FAILS ══════════════════════════════════════════════════════════════════════════════
 *
 * Add the field to the copy site the failure names. Do not delete it from the others.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * The per-road fields that must survive the whole pipeline.
 *
 * `width` is in here as the canary: it is the oldest per-road field, every copy site has always had
 * it, so if a site is missing `width` the test is pointed at the wrong function rather than having
 * found a real defect.
 */
const REQUIRED = [
  'width',
  'carriagewayW', 'parkingLeftW', 'parkingRightW',
  'shoulderW', 'kerbToKerbW', 'sidewalkW', 'corridorW',
];

/** Each copy site: the file, and a slice of it that contains the object literal(s) in question. */
function slice(src, startMarker, endMarker, occurrence = 0) {
  let from = -1;
  for (let i = 0; i <= occurrence; i++) from = src.indexOf(startMarker, from + 1);
  assert.ok(from >= 0, `marker not found: ${startMarker}`);
  const to = src.indexOf(endMarker, from);
  assert.ok(to > from, `end marker not found after ${startMarker}`);
  return src.slice(from, to);
}

const SITES = [
  {
    name: 'buildRegion.deepCloneRoad',
    get: () => slice(read('backend/worldBuilder/buildRegion.js'),
      'function deepCloneRoad(road)', '\n}'),
  },
  {
    name: 'RoadGeometryBuilder.buildRoadGeometry',
    get: () => slice(read('backend/worldBuilder/roads/RoadGeometryBuilder.js'),
      'result.push({', '});'),
  },
  {
    name: 'convertToBinary road entry',
    get: () => slice(read('backend/worldBuilder/convertToBinary.js'),
      'const entry = {', 'header.roads.push(entry)'),
  },
  {
    name: 'tileParserWorker.readRoads',
    get: () => slice(read('frontend/src/map/tileParserWorker.js'),
      'function readRoads(', '\n}'),
  },
  {
    // The SEVENTH copy site, and the one D-42 was written about. It is a RUNTIME projection rather
    // than a bake step, which is why it was not in this list to begin with — and it promptly dropped
    // the width section, leaving parked cars and pedestrians on the fallback table.
    name: 'tileManager.getLoadedRoadSegments',
    get: () => slice(read('frontend/src/map/tileManager.js'),
      'function getLoadedRoadSegments(', '_segCache = segments'),
  },
];

for (const site of SITES) {
  test(`every road field survives ${site.name}`, () => {
    const src = site.get();
    for (const field of REQUIRED) {
      assert.ok(new RegExp(`\\b${field}\\b`).test(src),
        `${site.name} does not copy \`${field}\`.\n\n` +
        `This is a FIELD-BY-FIELD COPY, i.e. a whitelist: anything not named there becomes ` +
        `\`undefined\` downstream, silently, in every road in the city. Add the field to that copy ` +
        `site — do not remove it from the others. See this file's header for the three times this ` +
        `has already shipped.`);
    }
  });
}

test('every copy site inside tileSplit carries the fields (there are three)', () => {
  // tileSplit has THREE separate `out.push({...})` sites for three clipping strategies, and only
  // one of them runs for a given tile depending on `noClipTileStrategy`. Patching the one you
  // happened to read leaves the other two dropping fields for whichever config uses them.
  const src = read('backend/worldBuilder/tileSplit.js');
  const copies = src.split(/width:\s*road\.width/).length - 1;
  assert.ok(copies >= 3, `expected at least 3 road copy sites in tileSplit, found ${copies}`);
  for (const field of REQUIRED) {
    const n = src.split(new RegExp(`\\b${field}\\b`)).length - 1;
    assert.ok(n >= copies,
      `tileSplit copies \`width\` at ${copies} sites but \`${field}\` only ${n} times — ` +
      `at least one copy site is dropping it.`);
  }
});

test('the tile-record map that becomes the tile JSON carries the fields', () => {
  // This one is matched by content rather than by function name: it is an inline `.map((r) => {...})`
  // deep inside the tile loop, identified by the comment that sits above it.
  const src = read('backend/worldBuilder/buildRegion.js');
  const marker = 'Phase 2: join pre-extracted tag data';
  const from = src.indexOf(marker);
  assert.ok(from > 0, 'the tile-record map moved — re-anchor this test rather than deleting it');
  const region = src.slice(from, from + 4000);
  for (const field of REQUIRED) {
    assert.ok(new RegExp(`\\b${field}\\b`).test(region),
      `the tile-record map does not carry \`${field}\``);
  }
});

test('the binary tile version and the parser agree', () => {
  // These two must move together or a re-bake either fails to invalidate the browser cache (stale
  // city, silently) or invalidates every tile forever (nothing renders from cache, ever).
  const baked = read('backend/worldBuilder/convertToBinary.js').match(/version:\s*(\d+)/);
  const parsed = read('frontend/src/map/tileParserWorker.js').match(/BINARY_TILE_VERSION\s*=\s*(\d+)/);
  assert.ok(baked, 'convertToBinary no longer declares a version');
  assert.ok(parsed, 'tileParserWorker no longer declares BINARY_TILE_VERSION');
  assert.equal(baked[1], parsed[1],
    `convertToBinary bakes v${baked[1]} but tileParserWorker expects v${parsed[1]} — ` +
    `bump them together.`);
});
