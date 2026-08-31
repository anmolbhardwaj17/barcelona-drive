/**
 * Render urban infrastructure features from OSM data baked into tiles:
 *   communication_tower, water_tower, fountain, public_toilet, fuel_station, fire_hydrant
 *
 * Each type → simple procedural geometry via merged meshes (one mesh per type per tile).
 * point = [worldX, worldZ] in tile-local coords.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mergeGeometriesChunked } from './chunkedMerge.js';
import { getKTX2TextureSync } from '../loaders.js';   // P4-17 furniture atlas

// Frame-budgeted merge for the big per-material buckets (the 'p4 urban' residual was this
// sync merge, not the per-feature loop). Chunked path for large sets, sync fallback otherwise.
async function mergeBudgeted(geoms, yieldFn) {
  if (yieldFn && geoms.length > 16) {
    try { const m = await mergeGeometriesChunked(geoms, yieldFn); if (m) return m; } catch {}
  }
  return mergeGeometries(geoms);
}

// ─── Shared materials (persist across tiles) ────────────────────────────────

let _matForecourtBand, _matForecourtTrim, _matForecourtRoof,
    _matCabinShell, _matCabinRoof, _matCabinDoor,
    _matSteel, _matRed, _matWhite, _matConcrete, _matWater, _matStone,
    _matYellow, _matDarkGray,
    _matBrown, _matBeige, _matIronGreen;

// ── AUTHORED FURNITURE ATLAS (2026-08-31) ─────────────────────────────────────────────────────
// 22 materials in this file against 3 map references: benches, bollards, bins and planters were
// all flat colour, which is what makes props read as toys. One 2x2 atlas covers the four materials
// that actually matter, and each material takes its own CLONE of the texture — clones share the
// GPU image and carry their own offset/repeat, so four cells cost one upload.
//
// ⚠ ROW 0 IS THE TOP OF THE IMAGE and three's UV origin is bottom-left, so the top row sits at
// v = 0.5..1.0. Getting that backwards swaps steel for concrete and red for dark metal — visible
// but easy to mis-read as "the atlas is wrong" rather than "the offset is flipped".
const FURNITURE_ATLAS = '/textures/urban/furniture_atlas_albedo.ktx2';
/**
 * One handle per cell. NOT a clone of a shared handle — `getKTX2TextureSync` hands back an EMPTY
 * CompressedTexture and fills it when the fetch lands, so cloning it immediately throws
 * `Cannot read properties of undefined (reading 'slice')` inside `copy()`. That shipped and failed
 * three tile builds before the console showed it.
 *
 * `offset`/`repeat` go through the loader's sampler policy so they are re-applied after the load
 * copies the cached texture over this handle — set here they would simply be overwritten. The four
 * handles still share ONE GPU upload, because `copy` carries `source` across.
 *
 * @param {number} col 0|1 @param {number} row 0 = TOP row of the image
 */
function atlasCell(col, row) {
  return getKTX2TextureSync(FURNITURE_ATLAS, {
    srgb: true,
    tiling: false,                       // a cell must never bleed into its neighbour
    repeat: [0.5, 0.5],
    offset: [col * 0.5, (1 - row) * 0.5],
  });
}

// `color` goes WHITE on every material that gains a map: the cell carries the tone (steel L* 58,
// dark metal L* 34.7 preserved, concrete L* 62, red C* 43 preserved) and leaving the old hex in
// would multiply it. matWhite keeps its flat colour — no cell is white, and inventing one would be
// worse than leaving it.
function matSteel()    { return _matSteel    || (_matSteel    = shared(new THREE.MeshLambertMaterial({ color: 0xffffff, map: atlasCell(0, 0) }))); }
function matRed()      { return _matRed      || (_matRed      = shared(new THREE.MeshLambertMaterial({ color: 0xffffff, map: atlasCell(1, 1) }))); }
function matWhite()    { return _matWhite    || (_matWhite    = shared(new THREE.MeshLambertMaterial({ color: 0xeeeeee }))); }
function matConcrete() { return _matConcrete || (_matConcrete = shared(new THREE.MeshLambertMaterial({ color: 0xffffff, map: atlasCell(0, 1) }))); }
function matWater()    { return _matWater    || (_matWater    = shared(new THREE.MeshPhongMaterial({ color: 0x2277aa, emissive: 0x0a2233, specular: 0x88ccee, shininess: 90, transparent: true, opacity: 0.75 }))); }
function matYellow()   { return _matYellow   || (_matYellow   = shared(new THREE.MeshLambertMaterial({ color: 0xeecc22 }))); }
function matDarkGray() { return _matDarkGray || (_matDarkGray = shared(new THREE.MeshLambertMaterial({ color: 0xffffff, map: atlasCell(1, 0) }))); }
function matBrown()    { return _matBrown    || (_matBrown    = shared(new THREE.MeshPhongMaterial({ color: 0x8b6b42, specular: 0x221100, shininess: 8 }))); }
function matBeige()    { return _matBeige    || (_matBeige    = shared(new THREE.MeshLambertMaterial({ color: 0xc8b89a }))); }
// P4-17a: ornamental fountains were BROWN, which is a north-Indian sandstone. Barcelona's plaza
// fountains are pale grey Montjuïc stone and granite. `matBrown` stays for the water tower, where
// a brick tone is right.
function matStone()    { return _matStone    || (_matStone    = shared(new THREE.MeshLambertMaterial({ color: 0xa9a49b }))); }
/** Municipal cast-iron green — the fountains, and the colour Barcelona actually paints them. */
function matIronGreen() { return _matIronGreen || (_matIronGreen = shared(new THREE.MeshLambertMaterial({ color: 0x2d4034 }))); }
// REMOVED with the Sulabh complex: matBush / matRock / matBlue / matBrick. They existed only to
// landscape it — 14 bushes and boulders per toilet — and had no other caller. Verified orphaned
// before deletion (`grep -c "mat: 'bush'"` etc. = 0).
// P4-17a: the forecourt fascia was BP's blue-and-yellow livery, named for it, on 39 stations.
// A real brand's colours on a real street is impersonation; these are neutral. Kept EMISSIVE so
// the night lift in `setUrbanNightMode` still works — a forecourt is a light source after dark.
function matForecourtBand() { return _matForecourtBand || (_matForecourtBand = shared(new THREE.MeshStandardMaterial({ color: 0xb8352c, emissive: 0xb8352c, emissiveIntensity: 0, roughness: 0.6 }))); }
function matForecourtTrim() { return _matForecourtTrim || (_matForecourtTrim = shared(new THREE.MeshStandardMaterial({ color: 0xe8e4dc, emissive: 0xe8e4dc, emissiveIntensity: 0, roughness: 0.6 }))); }
function matForecourtRoof() { return _matForecourtRoof || (_matForecourtRoof = shared(new THREE.MeshLambertMaterial({ color: 0xd4cfc0 }))); }
// P4-17a: street-toilet cabin — graphite shell, lighter roof, near-black door.
function matCabinShell()    { return _matCabinShell    || (_matCabinShell    = shared(new THREE.MeshLambertMaterial({ color: 0x4a4f52 }))); }
function matCabinRoof()     { return _matCabinRoof     || (_matCabinRoof     = shared(new THREE.MeshLambertMaterial({ color: 0x6e7376 }))); }
function matCabinDoor()     { return _matCabinDoor     || (_matCabinDoor     = shared(new THREE.MeshLambertMaterial({ color: 0x2b2f31 }))); }

function shared(mat) { mat.userData = { sharedMaterial: true }; return mat; }

// ─── Tower beacon light (blinking red) ──────────────────────────────────────
let _beaconMat = null;
let _beaconGeom = null;

export function getBeaconMat() {
  if (!_beaconMat) {
    _beaconMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    _beaconMat.userData.sharedMaterial = true;
  }
  return _beaconMat;
}

export function getBeaconGeom() {
  if (!_beaconGeom) {
    _beaconGeom = new THREE.SphereGeometry(0.35, 6, 4);
    _beaconGeom.userData.sharedGeometry = true;
  }
  return _beaconGeom;
}

/** Call from animation loop to pulse tower beacons. timeSec = elapsed seconds. */
export function updateTowerBeacons(timeSec) {
  if (!_beaconMat) return;
  // Smooth glow-and-dim (user call — the hard 1s on/off read as a fault, not a beacon):
  // never fully dark, ~2.6 s breathing cycle. Shared by comm towers + BOTH water-tower systems.
  const k = 0.22 + 0.78 * (0.5 + 0.5 * Math.sin(timeSec * 2.4));
  _beaconMat.color.setRGB(k, 0.04 * k, 0.04 * k);
}

// ─── Fuel station night illumination (bus-stop style: glow panel + radial ground pool) ──
let _fuelGlowMat = null;
let _fuelPoolMat = null;

let _fuelPoolTex = null;
function createFuelPoolTexture() {
  if (_fuelPoolTex) return _fuelPoolTex;
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255, 220, 160, 0.7)');
  grad.addColorStop(0.5, 'rgba(255, 200, 120, 0.3)');
  grad.addColorStop(1, 'rgba(255, 180, 100, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  _fuelPoolTex = new THREE.CanvasTexture(c);
  return _fuelPoolTex;
}

function getFuelGlowMat() {
  if (!_fuelGlowMat) {
    _fuelGlowMat = new THREE.MeshBasicMaterial({
      color: 0xffd898, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide,
    });
    _fuelGlowMat.userData = { sharedMaterial: true };
  }
  return _fuelGlowMat;
}

function getFuelPoolMat() {
  if (!_fuelPoolMat) {
    _fuelPoolMat = new THREE.MeshBasicMaterial({
      map: createFuelPoolTexture(), transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    _fuelPoolMat.userData = { sharedMaterial: true };
  }
  return _fuelPoolMat;
}

// Fountain blob shadow — soft radial gradient
let _fountainShadowTex = null;
let _fountainShadowMat = null;
function getFountainShadowMat() {
  if (!_fountainShadowMat) {
    if (!_fountainShadowTex) {
      const size = 128;
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0,    'rgba(0,0,0,0.38)');
      grad.addColorStop(0.35, 'rgba(0,0,0,0.30)');
      grad.addColorStop(0.65, 'rgba(0,0,0,0.14)');
      grad.addColorStop(0.9,  'rgba(0,0,0,0.04)');
      grad.addColorStop(1,    'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      _fountainShadowTex = new THREE.CanvasTexture(c);
    }
    _fountainShadowMat = new THREE.MeshBasicMaterial({
      map: _fountainShadowTex, transparent: true, opacity: 1.0,
      depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    _fountainShadowMat.userData = { sharedMaterial: true };
  }
  return _fountainShadowMat;
}

/**
 * P4-17a · generic WC pictogram for the street toilet cabin.
 *
 * REPLACES a canvas that drew "SULABH / TOILET COMPLEX" in a real organisation's blue-and-white
 * livery — reproducing a real brand, on a Barcelona street, for 206 objects. This draws a plain
 * pictogram instead: nothing to attribute to anyone.
 *
 * Kept from the old material, deliberately: the `emissiveMap` + `emissiveIntensity` pair, so the
 * plate still lifts at night (`setUrbanNightMode`). A street toilet you cannot find after dark is
 * worse than an ugly one.
 *
 * ⚠ `tex.repeat.x = -1` is the scene X-mirror workaround and P4-11 is going to forbid it outright
 * in favour of a shader U-flip. Until that lands this must match every other canvas sign in the
 * codebase, so it stays — flagged, not silently different.
 */
let _wcSignMat = null;
function matWcSign() {
  if (!_wcSignMat) {
    const w = 128, h = 88;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#1c4e8a';                 // municipal blue plate
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(3, 3, w - 6, h - 6);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 46px Helvetica, Arial, sans-serif';
    ctx.fillText('WC', w / 2, h / 2 + 2);
    const tex = new THREE.CanvasTexture(c);
    tex.repeat.x = -1; tex.offset.x = 1;       // scene X-mirror fix — see the note above
    _wcSignMat = new THREE.MeshStandardMaterial({
      map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0, roughness: 0.5,
    });
    _wcSignMat.userData = { sharedMaterial: true };
  }
  return _wcSignMat;
}

/**
 * Toggle urban-feature night illumination. Call from the day/night system.
 *
 * Named `setFuelStationNightMode` when it only lit forecourts; it has always also driven the toilet
 * sign, and P4-17a adds the cabin plate. `setUrbanNightMode` is the honest name — the old one is
 * kept as an alias because `ui/envToggle.js` imports it and a rename is not worth a broken import.
 */
export function setUrbanNightMode(isNight) {
  if (_fuelGlowMat) _fuelGlowMat.opacity = isNight ? 3.0 : 0;
  if (_fuelPoolMat) _fuelPoolMat.opacity = isNight ? 0.5 : 0;
  // Forecourt fascia bands (neutral livery — see matForecourtBand).
  const emitI = isNight ? 1.5 : 0;
  if (_matForecourtBand) _matForecourtBand.emissiveIntensity = emitI;
  if (_matForecourtTrim) _matForecourtTrim.emissiveIntensity = emitI;
  // Street-toilet WC plate — findable after dark.
  if (_wcSignMat) _wcSignMat.emissiveIntensity = isNight ? 1.2 : 0;
}
export { setUrbanNightMode as setFuelStationNightMode };

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Find angle to face the nearest road from a point.
 * Returns rotation angle (radians around Y) so local +Z faces the road.
 */
function angleToNearestRoad(wx, wz, roads) {
  if (!roads || roads.length === 0) return 0;
  let bestDist = Infinity, bestAngle = 0;
  for (const road of roads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x, az = pts[i].y;
      const bx = pts[i + 1].x, bz = pts[i + 1].y;
      const dx = bx - ax, dz = bz - az;
      const len2 = dx * dx + dz * dz;
      if (len2 < 0.01) continue;
      const t = Math.max(0, Math.min(1, ((wx - ax) * dx + (wz - az) * dz) / len2));
      const cx = ax + t * dx, cz = az + t * dz;
      const d = Math.hypot(wx - cx, wz - cz);
      if (d < bestDist) {
        bestDist = d;
        // Face toward the road: angle so +Z points from feature toward road
        bestAngle = Math.atan2(cx - wx, cz - wz);
      }
    }
  }
  return bestAngle;
}

/** Minimum distance from point (px,pz) to any road edge (centerline ± halfWidth). */
function minDistToRoadEdge(px, pz, roads) {
  let minD = Infinity;
  for (const road of roads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const hw = (road.width > 0 ? Math.min(30, road.width) : 6) / 2;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x, az = pts[i].y;
      const bx = pts[i + 1].x, bz = pts[i + 1].y;
      const dx = bx - ax, dz = bz - az;
      const len2 = dx * dx + dz * dz;
      if (len2 < 0.01) continue;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
      const cx = ax + t * dx, cz = az + t * dz;
      const d = Math.hypot(px - cx, pz - cz) - hw; // negative = inside road
      if (d < minD) minD = d;
    }
  }
  return minD;
}

/** Get rotated footprint corners for a feature at (cx,cz) with rotation angle. */
function getFootprintCorners(cx, cz, halfW, halfD, angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const corners = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const lx = sx * halfW, lz = sz * halfD;
      corners.push({
        x: cx + lx * cos - lz * sin,
        z: cz + lx * sin + lz * cos,
      });
    }
  }
  return corners;
}

// Footprint half-sizes per type (half-width, half-depth)
const FOOTPRINT = {
  fuel_station: { hw: 9, hd: 7 },   // 14×10 canopy + 2m slab margin
  public_toilet: { hw: 4, hd: 4 },   // 6×5 building + landscaping
};

/**
 * Check if rotated footprint overlaps any road. Returns worst overlap distance (0 = clear).
 */
function footprintRoadOverlap(cx, cz, hw, hd, angle, roads, margin) {
  const corners = getFootprintCorners(cx, cz, hw, hd, angle);
  let worst = 0;
  for (const c of corners) {
    const d = minDistToRoadEdge(c.x, c.z, roads);
    if (d < margin) worst = Math.max(worst, margin - d);
  }
  const cd = minDistToRoadEdge(cx, cz, roads);
  if (cd < margin) worst = Math.max(worst, margin - cd);
  return worst;
}

/**
 * Check if footprint overlaps any building. Simple AABB check against building centers.
 */
function footprintHitsBuilding(cx, cz, hw, hd, buildings) {
  if (!buildings || buildings.length === 0) return false;
  for (const b of buildings) {
    if (!b.center && (!b.footprint || b.footprint.length === 0)) continue;
    const bx = b.center ? b.center.x : b.footprint[0].x;
    const bz = b.center ? b.center.y : b.footprint[0].y;
    // Simple radius check — if building center is inside our footprint + margin
    if (Math.abs(cx - bx) < hw + 3 && Math.abs(cz - bz) < hd + 3) return true;
  }
  return false;
}

/**
 * Smart placement: try shifting left/right/back from nearest road until
 * the full footprint clears all roads. No scaling — full size always.
 * Returns { x, z }.
 */
function adjustPlacement(wx, wz, angle, type, roads, buildings) {
  const fp = FOOTPRINT[type];
  if (!fp) return { x: wx, z: wz };

  const margin = 3.0; // clearance from road edge (was 2.0 — a bit more so features don't kiss the asphalt)

  // If already clear, done
  if (footprintRoadOverlap(wx, wz, fp.hw, fp.hd, angle, roads, margin) <= 0) {
    return { x: wx, z: wz };
  }

  // Find push direction: perpendicular to the nearest road, away from it
  let bestDist = Infinity, nearCx = 0, nearCz = 0, roadDx = 0, roadDz = 0;
  for (const road of roads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x, az = pts[i].y;
      const bx = pts[i + 1].x, bz = pts[i + 1].y;
      const dx = bx - ax, dz = bz - az;
      const len2 = dx * dx + dz * dz;
      if (len2 < 0.01) continue;
      const t = Math.max(0, Math.min(1, ((wx - ax) * dx + (wz - az) * dz) / len2));
      const cx = ax + t * dx, cz = az + t * dz;
      const d = Math.hypot(wx - cx, wz - cz);
      if (d < bestDist) {
        bestDist = d;
        nearCx = cx; nearCz = cz;
        const len = Math.sqrt(len2);
        roadDx = dx / len; roadDz = dz / len;
      }
    }
  }

  // Away direction (from road toward feature)
  let awayX = wx - nearCx, awayZ = wz - nearCz;
  const awayLen = Math.hypot(awayX, awayZ);
  if (awayLen > 0.01) { awayX /= awayLen; awayZ /= awayLen; }
  else { awayX = -roadDz; awayZ = roadDx; } // perpendicular fallback

  // Along-road direction (for lateral shifts)
  const alongX = roadDx, alongZ = roadDz;

  // Try candidate positions: push away, then try lateral shifts
  const candidates = [];
  for (let pushDist = 2; pushDist <= 25; pushDist += 3) {
    // Straight away
    candidates.push({ x: wx + awayX * pushDist, z: wz + awayZ * pushDist });
    // Lateral shifts (left/right along road)
    for (const lateralDist of [5, 10, 15]) {
      for (const sign of [-1, 1]) {
        candidates.push({
          x: wx + awayX * pushDist + alongX * lateralDist * sign,
          z: wz + awayZ * pushDist + alongZ * lateralDist * sign,
        });
      }
    }
  }

  // Also try pure lateral shifts (no push away)
  for (const lateralDist of [5, 10, 15, 20]) {
    for (const sign of [-1, 1]) {
      candidates.push({
        x: wx + alongX * lateralDist * sign,
        z: wz + alongZ * lateralDist * sign,
      });
    }
  }

  // Pick the closest candidate that clears roads (and doesn't hit buildings)
  let bestCandidate = null, bestCandDist = Infinity;
  for (const c of candidates) {
    const overlap = footprintRoadOverlap(c.x, c.z, fp.hw, fp.hd, angle, roads, margin);
    if (overlap > 0) continue;
    if (buildings && footprintHitsBuilding(c.x, c.z, fp.hw, fp.hd, buildings)) continue;
    const d = Math.hypot(c.x - wx, c.z - wz);
    if (d < bestCandDist) {
      bestCandDist = d;
      bestCandidate = c;
    }
  }

  if (bestCandidate) return { x: bestCandidate.x, z: bestCandidate.z };

  // Last resort: just push away until center clears
  const fallbackDist = fp.hw + fp.hd + 5;
  return { x: wx + awayX * fallbackDist, z: wz + awayZ * fallbackDist };
}

// ─── Geometry builders per feature type ─────────────────────────────────────
// All builders create geometry centered at (0, 0, 0). Caller translates+rotates.

/**
 * Communication tower: tall lattice tower with red/white striping and antenna.
 */
function buildCommTower() {
  const geos = [];
  const h = 35;
  const tower = new THREE.CylinderGeometry(0.3, 1.5, h, 6);
  tower.translate(0, h / 2, 0);
  geos.push({ geo: tower, mat: 'steel' });

  for (let i = 0; i < 3; i++) {
    const y = 8 + i * 9;
    const r = 1.5 - (y / h) * 1.2;
    const band = new THREE.CylinderGeometry(r + 0.05, r + 0.05, 2, 6);
    band.translate(0, y, 0);
    geos.push({ geo: band, mat: 'red' });
  }

  const antenna = new THREE.CylinderGeometry(0.05, 0.05, 5, 4);
  antenna.translate(0, h + 2.5, 0);
  geos.push({ geo: antenna, mat: 'steel' });

  const dish = new THREE.SphereGeometry(0.6, 6, 4, 0, Math.PI);
  dish.rotateX(-Math.PI / 4);
  dish.translate(0.8, 20, 0);
  geos.push({ geo: dish, mat: 'white' });

  // Red beacon light at antenna tip
  const beacon = new THREE.SphereGeometry(0.35, 6, 4);
  beacon.translate(0, h + 5, 0);
  geos.push({ geo: beacon, mat: 'beacon' });

  return geos;
}

/**
 * Indian RCC overhead water tank (Delhi Jal Board style):
 * Cylindrical tank with dome top, conical bottom, 6 pillars in a circle,
 * ring beams, red accent bands, walkway railing, staircase.
 */
function buildWaterTower() {
  // Modernista water tower — Torre de les Aigües silhouette (user ref 2026-07-11), matching the
  // building-polygon version in buildingWorker: brick shaft → dark trim ring → overhanging cream
  // colonnade drum → squat truncated terracotta cone + blunt finial. Replaces the Delhi-era
  // American stilt tank ("what is this" — user).
  const geos = [];
  const R = 3.2, H = 30, SEGS = 12;
  const shaftH = H * 0.64;
  const shaft = new THREE.CylinderGeometry(R * 0.80, R * 0.95, shaftH, SEGS);
  shaft.translate(0, shaftH / 2, 0);
  geos.push({ geo: shaft, mat: 'brown' });
  const trim = new THREE.CylinderGeometry(R * 1.30, R * 1.30, 0.6, SEGS);
  trim.translate(0, shaftH + 0.3, 0);
  geos.push({ geo: trim, mat: 'darkGray' });
  const crownH = H * 0.20;
  const crown = new THREE.CylinderGeometry(R * 1.26, R * 1.26, crownH, SEGS);
  crown.translate(0, shaftH + 0.6 + crownH / 2, 0);
  geos.push({ geo: crown, mat: 'beige' });
  // colonnade hint: 8 slim posts recessed into the drum face
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const post = new THREE.CylinderGeometry(0.14, 0.14, crownH * 0.8, 5);
    post.translate(Math.cos(a) * R * 1.30, shaftH + 0.6 + crownH / 2, Math.sin(a) * R * 1.30);
    geos.push({ geo: post, mat: 'concrete' });
  }
  const spireH = H * 0.17;
  const spire = new THREE.CylinderGeometry(R * 0.30, R * 1.16, spireH, SEGS);
  spire.translate(0, shaftH + 0.6 + crownH + spireH / 2, 0);
  geos.push({ geo: spire, mat: 'brown' });
  const finial = new THREE.CylinderGeometry(R * 0.10, R * 0.26, H * 0.05, SEGS);
  finial.translate(0, shaftH + 0.6 + crownH + spireH + H * 0.025, 0);
  geos.push({ geo: finial, mat: 'darkGray' });
  // Pulsing red aviation beacon on the finial (user call — matches the comm towers).
  const beacon = new THREE.SphereGeometry(0.35, 6, 4);
  beacon.translate(0, shaftH + 0.6 + crownH + spireH + H * 0.05 + 0.35, 0);
  geos.push({ geo: beacon, mat: 'beacon' });
  return geos;
}

/**
 * Fountain: India Gate style red sandstone tiered fountain (lowpoly).
 * Wide octagonal base pool → lower basin wall → middle tier → upper bowl → top finial.
 */
function buildFountain() {
  const geos = [];
  const segs = 12; // lowpoly circle segments

  // ── Ground-level pool (wide, shallow) ──
  const poolR = 3.5, poolWallH = 0.45;
  const poolOuter = new THREE.CylinderGeometry(poolR, poolR + 0.15, poolWallH, segs);
  poolOuter.translate(0, poolWallH / 2, 0);
  geos.push({ geo: poolOuter, mat: 'stone' });

  const poolWater = new THREE.CylinderGeometry(poolR - 0.2, poolR - 0.2, 0.05, segs);
  poolWater.translate(0, poolWallH * 0.6, 0);
  geos.push({ geo: poolWater, mat: 'water' });

  // ── Lower pedestal (tapered column rising from pool center) ──
  const ped1 = new THREE.CylinderGeometry(0.8, 1.1, 1.0, segs);
  ped1.translate(0, poolWallH + 0.5, 0);
  geos.push({ geo: ped1, mat: 'stone' });

  // ── Middle basin (smaller bowl catching water) ──
  const midR = 1.8, midWallH = 0.35;
  const midBasin = new THREE.CylinderGeometry(midR, midR - 0.1, midWallH, segs);
  midBasin.translate(0, poolWallH + 1.0 + midWallH / 2, 0);
  geos.push({ geo: midBasin, mat: 'stone' });

  const midWater = new THREE.CylinderGeometry(midR - 0.15, midR - 0.15, 0.04, segs);
  midWater.translate(0, poolWallH + 1.0 + midWallH * 0.7, 0);
  geos.push({ geo: midWater, mat: 'water' });

  // ── Decorative lip ring on middle basin ──
  const lipRing = new THREE.TorusGeometry(midR, 0.08, 6, segs);
  lipRing.rotateX(Math.PI / 2);
  lipRing.translate(0, poolWallH + 1.0 + midWallH, 0);
  geos.push({ geo: lipRing, mat: 'stone' });

  // ── Upper pedestal ──
  const ped2 = new THREE.CylinderGeometry(0.4, 0.65, 0.8, segs);
  ped2.translate(0, poolWallH + 1.0 + midWallH + 0.4, 0);
  geos.push({ geo: ped2, mat: 'stone' });

  // ── Upper bowl (small top basin) ──
  const topR = 1.0, topH = 0.25;
  const topBowl = new THREE.CylinderGeometry(topR, topR - 0.08, topH, segs);
  topBowl.translate(0, poolWallH + 1.0 + midWallH + 0.8 + topH / 2, 0);
  geos.push({ geo: topBowl, mat: 'stone' });

  const topWater = new THREE.CylinderGeometry(topR - 0.12, topR - 0.12, 0.03, segs);
  topWater.translate(0, poolWallH + 1.0 + midWallH + 0.8 + topH * 0.7, 0);
  geos.push({ geo: topWater, mat: 'water' });

  // ── Finial (small pointed top) ──
  const finial = new THREE.ConeGeometry(0.18, 0.6, 6);
  finial.translate(0, poolWallH + 1.0 + midWallH + 0.8 + topH + 0.3, 0);
  geos.push({ geo: finial, mat: 'stone' });

  // ── Water jet from finial tip (taller, tapered) ──
  const jet = new THREE.CylinderGeometry(0.02, 0.07, 1.2, 6);
  jet.translate(0, poolWallH + 1.0 + midWallH + 0.8 + topH + 0.6 + 0.6, 0);
  geos.push({ geo: jet, mat: 'water' });

  // ── Cascading water: thin transparent cylinders between tiers ──
  // Upper bowl → middle basin cascade
  const cascade1 = new THREE.CylinderGeometry(topR - 0.05, midR - 0.3, 0.8, segs, 1, true);
  cascade1.translate(0, poolWallH + 1.0 + midWallH * 0.5 + 0.4, 0);
  geos.push({ geo: cascade1, mat: 'water' });

  // Middle basin → ground pool cascade
  const cascade2 = new THREE.CylinderGeometry(midR - 0.1, poolR - 0.5, 1.0, segs, 1, true);
  cascade2.translate(0, poolWallH + 0.5, 0);
  geos.push({ geo: cascade2, mat: 'water' });

  // ── Splash ring at pool surface (subtle ring of disturbed water) ──
  const splash = new THREE.TorusGeometry(poolR - 0.6, 0.12, 6, segs);
  splash.rotateX(Math.PI / 2);
  splash.translate(0, poolWallH * 0.65, 0);
  geos.push({ geo: splash, mat: 'water' });

  return geos;
}

/**
 * P4-17a · Barcelona automatic street toilet (cabina sanitària).
 *
 * WHAT THIS REPLACES, and why it mattered more than any texture would have. The previous builder
 * was a **Delhi Sulabh toilet complex**: a 6 x 5 x 3.8 m brown-stone building with a two-tone
 * facade, a concrete entrance canopy, three front steps, steel railings, an emissive sign board
 * reading "SULABH TOILET COMPLEX", and fourteen scattered bushes and boulders landscaped around it.
 * OSM tags 206 `amenity=toilets` inside the Barcelona bbox, so the city was carrying 206 Indian
 * toilet complexes with gardens, standing on Eixample pavements 3-4 m wide.
 *
 * A Barcelona street toilet is a single prefabricated cabin: roughly 1.6 x 1.5 m in plan and 2.5 m
 * tall, graphite/dark-grey panelled, flat roof with a small overhang, one recessed door, and a plain
 * pictogram plate. No steps, no railings, no landscaping — it stands directly on the panot.
 *
 * ⚠ NO BRANDING. The sign is a generic WC pictogram drawn in code. The old one reproduced a real
 * organisation's name and livery, which is wrong on a Barcelona street twice over.
 *
 * Footprint went from 30 m² to 2.4 m², so `EXCLUSION_RADIUS.public_toilet` drops 5 -> 1.6 with it,
 * or the cabin would keep clearing a 10 m circle of street trees around itself.
 */
function buildPublicToilet() {
  const geos = [];
  const w = 1.6, d = 1.5, h = 2.5;

  // Plinth — the cabin sits on a shallow kerb-height base, not on steps.
  const plinthH = 0.12;
  const plinth = new THREE.BoxGeometry(w + 0.12, plinthH, d + 0.12);
  plinth.translate(0, plinthH / 2, 0);
  geos.push({ geo: plinth, mat: 'concrete' });

  // Body — one graphite panelled volume.
  const bodyH = h - plinthH;
  const body = new THREE.BoxGeometry(w, bodyH, d);
  body.translate(0, plinthH + bodyH / 2, 0);
  geos.push({ geo: body, mat: 'cabinShell' });

  // Panel seams: two shallow reveals down the sides, which is what reads at driving speed.
  for (const side of [-1, 1]) {
    const seam = new THREE.BoxGeometry(0.03, bodyH * 0.82, 0.04);
    seam.translate(side * (w / 2 + 0.005), plinthH + bodyH / 2, d / 2 - 0.18);
    geos.push({ geo: seam, mat: 'darkGray' });
  }

  // Roof — flat, slight overhang, lighter grey so the silhouette reads against a facade.
  const roof = new THREE.BoxGeometry(w + 0.16, 0.09, d + 0.16);
  roof.translate(0, h + 0.045, 0);
  geos.push({ geo: roof, mat: 'cabinRoof' });

  // Door — recessed on the +Z face, full height, with a thin frame.
  const doorW = w * 0.72, doorH = bodyH * 0.86;
  const door = new THREE.BoxGeometry(doorW, doorH, 0.05);
  door.translate(0, plinthH + doorH / 2, d / 2 + 0.005);
  geos.push({ geo: door, mat: 'cabinDoor' });
  const frame = new THREE.BoxGeometry(doorW + 0.08, doorH + 0.08, 0.03);
  frame.translate(0, plinthH + doorH / 2, d / 2 + 0.001);
  geos.push({ geo: frame, mat: 'darkGray' });

  // Handle — a single vertical bar. Small, but it is the one thing that says "door" up close.
  const handle = new THREE.CylinderGeometry(0.018, 0.018, 0.28, 5);
  handle.translate(doorW * 0.32, plinthH + doorH * 0.52, d / 2 + 0.05);
  geos.push({ geo: handle, mat: 'steel' });

  // Pictogram plate above the door — generic WC, drawn in code, no brand.
  const signW = 0.44, signH = 0.30;
  const sign = new THREE.PlaneGeometry(signW, signH);
  sign.translate(0, plinthH + doorH + 0.20, d / 2 + 0.035);
  geos.push({ geo: sign, mat: 'wcSign' });

  return geos;
}

/**
 * P4-17a · urban fuel forecourt, neutral livery.
 *
 * Was "Indian-style fuel station (Bharat Petroleum inspired)" — a real brand's blue-and-yellow
 * fascia, named for it in the material identifiers, on all 39 stations in the city. Reproducing a
 * real company's livery is not something to ship, and it is not what a Barcelona forecourt looks
 * like either. The band is now a neutral red with a bone-white trim: still reads as a forecourt,
 * attributable to nobody.
 *
 * Also SHRUNK. The canopy was 14 x 10 m at 7 m high, which is a highway service station. Barcelona's
 * are wedged into the street grid, frequently under the building above, so 11 x 7.5 m at 5.4 m is
 * the urban form — and it stops the canopy from swallowing the pavement it stands on.
 * Built at origin, facing +Z (road side). Caller rotates.
 */
function buildFuelStation() {
  const geos = [];
  const canopyW = 11, canopyD = 7.5, canopyH = 5.4;

  // 8 pillars (2 rows of 4)
  for (let row = -1; row <= 1; row += 2) {
    for (let col = -1.5; col <= 1.5; col++) {
      const px = col * (canopyW / 4);
      const pz = row * (canopyD / 2 - 0.8);
      const pillar = new THREE.CylinderGeometry(0.22, 0.22, canopyH - 0.3, 8);
      pillar.translate(px, (canopyH - 0.3) / 2, pz);
      geos.push({ geo: pillar, mat: 'white' });
    }
  }

  // Canopy roof slab (cream/beige)
  const roof = new THREE.BoxGeometry(canopyW + 0.8, 0.35, canopyD + 0.8);
  roof.translate(0, canopyH, 0);
  geos.push({ geo: roof, mat: 'forecourtRoof' });

  // Blue fascia band on all 4 sides
  const fasciaH = 0.7;
  const fasciaY = canopyH - 0.18 - fasciaH / 2;
  for (const side of [-1, 1]) {
    const fascia = new THREE.BoxGeometry(canopyW + 0.9, fasciaH, 0.15);
    fascia.translate(0, fasciaY, side * (canopyD / 2 + 0.4));
    geos.push({ geo: fascia, mat: 'forecourtBand' });
  }
  for (const side of [-1, 1]) {
    const fascia = new THREE.BoxGeometry(0.15, fasciaH, canopyD + 0.9);
    fascia.translate(side * (canopyW / 2 + 0.4), fasciaY, 0);
    geos.push({ geo: fascia, mat: 'forecourtBand' });
  }

  // Yellow accent stripe below blue fascia
  const stripeH = 0.3;
  const stripeY = fasciaY - fasciaH / 2 - stripeH / 2;
  for (const side of [-1, 1]) {
    const stripe = new THREE.BoxGeometry(canopyW + 0.9, stripeH, 0.15);
    stripe.translate(0, stripeY, side * (canopyD / 2 + 0.4));
    geos.push({ geo: stripe, mat: 'forecourtTrim' });
  }
  for (const side of [-1, 1]) {
    const stripe = new THREE.BoxGeometry(0.15, stripeH, canopyD + 0.9);
    stripe.translate(side * (canopyW / 2 + 0.4), stripeY, 0);
    geos.push({ geo: stripe, mat: 'forecourtTrim' });
  }

  // 3 fuel pump islands (parallel to road = along X)
  for (let i = -1; i <= 1; i++) {
    const iz = i * 3;
    const island = new THREE.BoxGeometry(6, 0.18, 0.7);
    island.translate(0, 0.09, iz);
    geos.push({ geo: island, mat: 'yellow' });

    // 3 pump units per island
    for (let col = -1; col <= 1; col++) {
      const px = col * 2;
      const pump = new THREE.BoxGeometry(0.5, 1.8, 0.45);
      pump.translate(px, 1.08, iz);
      geos.push({ geo: pump, mat: 'white' });

      const display = new THREE.BoxGeometry(0.45, 0.3, 0.4);
      display.translate(px, 2.1, iz);
      geos.push({ geo: display, mat: 'darkGray' });

      const hook = new THREE.BoxGeometry(0.08, 0.5, 0.08);
      hook.translate(px + 0.25, 1.5, iz + 0.25);
      geos.push({ geo: hook, mat: 'steel' });
    }
  }

  // Ground slab
  const slab = new THREE.BoxGeometry(canopyW + 4, 0.08, canopyD + 4);
  slab.translate(0, 0.04, 0);
  geos.push({ geo: slab, mat: 'concrete' });

  // Office building at the back
  const offW = 5, offD = 3.5, offH = 4;
  const offBody = new THREE.BoxGeometry(offW, offH, offD);
  offBody.translate(canopyW / 2 - offW / 2, offH / 2, -canopyD / 2 - offD / 2 - 0.8);
  geos.push({ geo: offBody, mat: 'white' });

  const offRoof = new THREE.BoxGeometry(offW + 0.3, 0.25, offD + 0.3);
  offRoof.translate(canopyW / 2 - offW / 2, offH + 0.12, -canopyD / 2 - offD / 2 - 0.8);
  geos.push({ geo: offRoof, mat: 'forecourtTrim' });

  // Office door
  const offDoor = new THREE.BoxGeometry(1.2, 2.4, 0.06);
  offDoor.translate(canopyW / 2 - offW / 2, 1.2, -canopyD / 2 - 0.78);
  geos.push({ geo: offDoor, mat: 'darkGray' });

  return geos;
}

/**
 * Fire hydrant: short red pillar with cap and outlets.
 */
/**
 * N-27 · A hydrant is not one object.
 *
 * `fire_hydrant:type` was parsed and thrown away until N-5 restored the tag whitelist. With it
 * readable, the distribution over the shipped tiles is: **underground 473, untagged 47, pillar 15,
 * wall 2**. So 88% of Barcelona's hydrants were being drawn as a 0.7 m red pillar, and an
 * underground hydrant is a flush cast-iron lid set into the pavement — a thing you drive over, not
 * a thing you hit. That is 473 red posts standing on pavements that have none.
 *
 * Untagged keeps the pillar: OSM's silence is not evidence of absence, and a missing post reads as
 * a gap while a wrong one reads as an error.
 */
function buildFireHydrant(f) {
  const kind = f?.tags?.['fire_hydrant:type'] || f?.tags?.type || '';
  if (kind === 'underground') return buildUndergroundHydrant();
  if (kind === 'wall') return buildWallHydrant();
  return buildPillarHydrant();
}

/** Flush cast-iron lid, ~40 cm across, standing 4 cm proud of the pavement. */
function buildUndergroundHydrant() {
  const geos = [];
  const lid = new THREE.CylinderGeometry(0.21, 0.22, 0.04, 12);
  lid.translate(0, 0.02, 0);
  geos.push({ geo: lid, mat: 'darkGray' });
  // The raised H boss on the lid — the only thing that reads at driving distance.
  const boss = new THREE.BoxGeometry(0.10, 0.012, 0.02);
  boss.translate(0, 0.046, 0);
  geos.push({ geo: boss, mat: 'red' });
  return geos;
}

/** Wall type: a small red plate with two nozzles, low on a facade. Two of them in the whole city. */
function buildWallHydrant() {
  const geos = [];
  const plate = new THREE.BoxGeometry(0.30, 0.34, 0.08);
  plate.translate(0, 0.55, 0);
  geos.push({ geo: plate, mat: 'red' });
  for (const side of [-0.07, 0.07]) {
    const nozzle = new THREE.CylinderGeometry(0.04, 0.04, 0.10, 6);
    nozzle.rotateX(Math.PI / 2);
    nozzle.translate(side, 0.55, 0.08);
    geos.push({ geo: nozzle, mat: 'steel' });
  }
  return geos;
}

function buildPillarHydrant() {
  const geos = [];

  const body = new THREE.CylinderGeometry(0.12, 0.14, 0.7, 8);
  body.translate(0, 0.35, 0);
  geos.push({ geo: body, mat: 'red' });

  const cap = new THREE.SphereGeometry(0.14, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.translate(0, 0.7, 0);
  geos.push({ geo: cap, mat: 'red' });

  for (const side of [-1, 1]) {
    const nozzle = new THREE.CylinderGeometry(0.05, 0.05, 0.15, 6);
    nozzle.rotateZ(Math.PI / 2);
    nozzle.translate(side * 0.18, 0.45, 0);
    geos.push({ geo: nozzle, mat: 'steel' });
  }

  const base = new THREE.CylinderGeometry(0.18, 0.18, 0.05, 8);
  base.translate(0, 0.025, 0);
  geos.push({ geo: base, mat: 'steel' });

  return geos;
}

/**
 * N-28 · The *font de Barcelona* — the cast-iron drinking fountain.
 *
 * 1,041 of them are baked (N-6 imported `amenity=drinking_water`, which nothing had ever parsed)
 * and until now nothing drew a single one. They are not scenery: the municipal fountain is one of
 * the few objects that reads as Barcelona rather than as generic city, it stands on almost every
 * plaza and street corner, and it is the densest piece of street furniture in the data after the
 * hydrants.
 *
 * Modelled on the standard *model Barcelona*: a squat dark-green cast-iron column about 1.1 m tall
 * on a small stone plinth, a collar, a short curved spout on one side, and a domed cap. Colour is
 * the municipal dark green, not black — the art bible's palette work is about not inventing
 * colours, and this one is documented.
 */
function buildDrinkingFountain() {
  const geos = [];

  // Stone plinth it is bolted to.
  const plinth = new THREE.CylinderGeometry(0.26, 0.28, 0.10, 12);
  plinth.translate(0, 0.05, 0);
  geos.push({ geo: plinth, mat: 'stone' });

  // The column: slightly tapered, 8-sided like the real casting rather than round.
  const column = new THREE.CylinderGeometry(0.105, 0.135, 0.86, 8);
  column.translate(0, 0.53, 0);
  geos.push({ geo: column, mat: 'ironGreen' });

  // Collar where the spout housing swells out.
  const collar = new THREE.CylinderGeometry(0.145, 0.145, 0.16, 8);
  collar.translate(0, 0.90, 0);
  geos.push({ geo: collar, mat: 'ironGreen' });

  // Domed cap.
  const cap = new THREE.SphereGeometry(0.145, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.translate(0, 0.98, 0);
  geos.push({ geo: cap, mat: 'ironGreen' });

  // Spout — a short arm angled down, and the brass push-button above it.
  const spout = new THREE.CylinderGeometry(0.022, 0.022, 0.17, 6);
  spout.rotateX(Math.PI / 2.6);
  spout.translate(0, 0.86, 0.14);
  geos.push({ geo: spout, mat: 'steel' });
  const button = new THREE.CylinderGeometry(0.026, 0.026, 0.03, 8);
  button.rotateX(Math.PI / 2);
  button.translate(0, 0.99, 0.13);
  geos.push({ geo: button, mat: 'yellow' });

  return geos;
}

// ─── Material lookup ────────────────────────────────────────────────────────

const MAT_MAP = {
  steel: matSteel, red: matRed, white: matWhite, stone: matStone,
  concrete: matConcrete, water: matWater,
  yellow: matYellow, darkGray: matDarkGray,
  forecourtBand: matForecourtBand, forecourtTrim: matForecourtTrim, forecourtRoof: matForecourtRoof,
  cabinShell: matCabinShell, cabinRoof: matCabinRoof, cabinDoor: matCabinDoor,
  brown: matBrown, beige: matBeige, wcSign: matWcSign, ironGreen: matIronGreen,
  beacon: getBeaconMat,
};

// ─── Builder dispatch ───────────────────────────────────────────────────────

const BUILDERS = {
  communication_tower: buildCommTower,
  water_tower: buildWaterTower,
  fountain: buildFountain,
  public_toilet: buildPublicToilet,
  fuel_station: buildFuelStation,
  fire_hydrant: buildFireHydrant,
  drinking_water: buildDrinkingFountain,
};

// Types that should be oriented to face the nearest road
const ROAD_FACING_TYPES = new Set(['fuel_station', 'public_toilet']);

// Exclusion radius per type (metres) — trees won't spawn within this radius
const EXCLUSION_RADIUS = {
  // P4-17a: these must track the FOOTPRINT, or an object clears street trees it never touches.
  fuel_station: 14,        // canopy 14x10 -> 11x7.5, so the circle comes in with it
  communication_tower: 5,
  water_tower: 6,
  fountain: 5,
  public_toilet: 1.6,      // was 5, sized for a 6x5 m Sulabh complex. The cabin is 1.6x1.5 m —
                           // at 5 m it kept punching a 10 m hole in the street trees around it.
  fire_hydrant: 1.5,
  drinking_water: 1.4,
};

// ─── Main export ────────────────────────────────────────────────────────────

/**
 * Build meshes for urban features in a tile.
 * @param {Array} features - [{ type, point: [wx, wz], id, tags }]
 * @param {Array} [roads] - tile roads for orientation (optional)
 * @param {Array} [buildings] - tile buildings for collision avoidance (optional)
 * @returns {THREE.Mesh[]}
 */
export async function buildUrbanFeatureMeshes(features, roads, buildings, getGroundY, yieldFn) {
  if (!features || features.length === 0) return [];
  const groundYAt = typeof getGroundY === 'function' ? getGroundY : () => 0;

  const byMat = new Map();
  const _rot = new THREE.Matrix4();
  const _trans = new THREE.Matrix4();
  const _combined = new THREE.Matrix4();

  // Fuel station canopy dimensions for glow/pool sizing
  const CANOPY_W = 14, CANOPY_D = 10, CANOPY_H = 7;
  const GLOW_PANEL_W = CANOPY_W - 2, GLOW_PANEL_D = CANOPY_D - 2;
  const POOL_SIZE = CANOPY_W + 2;

  const glowGeoms = [];
  const poolGeoms = [];
  const shadowGeoms = [];

  // Template geometries for glow and pool (cloned per fuel station)
  const _glowTemplate = new THREE.PlaneGeometry(GLOW_PANEL_W, GLOW_PANEL_D);
  _glowTemplate.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2)); // face down
  const _poolTemplate = new THREE.PlaneGeometry(POOL_SIZE, POOL_SIZE);
  _poolTemplate.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2)); // face up

  for (const f of features) {
    const builder = BUILDERS[f.type];
    if (!builder) continue;
    let [wx, wz] = f.point;

    // Compute rotation for road-facing types
    let angle = 0;
    if (ROAD_FACING_TYPES.has(f.type) && roads) {
      angle = angleToNearestRoad(wx, wz, roads);
    }

    // Smart placement: shift position so full footprint clears roads + buildings
    if (FOOTPRINT[f.type] && roads) {
      const adj = adjustPlacement(wx, wz, angle, f.type, roads, buildings);
      wx = adj.x;
      wz = adj.z;
      // Recompute angle to face nearest road from new position
      angle = angleToNearestRoad(wx, wz, roads);
    }

    // Build geometry at origin
    const parts = builder(f);

    // Anchor to terrain ground Y (was hardcoded 0 → floated below-spawn terrain, buried above-spawn)
    const wy = groundYAt(wx, wz);

    // Build transform matrix: rotate → translate
    if (angle !== 0) {
      _rot.makeRotationY(angle);
      _trans.makeTranslation(wx, wy, wz);
      _combined.multiplyMatrices(_trans, _rot);
    } else {
      _combined.makeTranslation(wx, wy, wz);
    }

    for (const { geo, mat: matName } of parts) {
      geo.applyMatrix4(_combined);
      if (!byMat.has(matName)) byMat.set(matName, []);
      byMat.get(matName).push(geo);
    }

    // Fountains: circular blob shadow on ground (using PlaneGeometry like tree shadows)
    if (f.type === 'fountain') {
      const shadowD = (EXCLUSION_RADIUS.fountain || 5) * 2.8;
      const shadow = new THREE.PlaneGeometry(shadowD, shadowD);
      shadow.rotateX(-Math.PI / 2);
      shadow.translate(0, 0.12, 0);
      shadow.applyMatrix4(_combined);
      shadowGeoms.push(shadow);
    }

    // Fuel stations: add glow panel under canopy + ground light pool
    if (f.type === 'fuel_station') {
      const glow = _glowTemplate.clone();
      glow.translate(0, CANOPY_H - 0.1, 0);
      glow.applyMatrix4(_combined);
      glowGeoms.push(glow);

      const pool = _poolTemplate.clone();
      pool.translate(0, 0.1, 0);
      pool.applyMatrix4(_combined);
      poolGeoms.push(pool);
    }
  
    if (yieldFn) await yieldFn();
  }

  _glowTemplate.dispose();
  _poolTemplate.dispose();

  const meshes = [];
  for (const [matName, geos] of byMat) {
    if (geos.length === 0) continue;
    if (yieldFn) await yieldFn();
    const merged = await mergeBudgeted(geos, yieldFn);
    geos.forEach(g => g.dispose());
    if (!merged) continue;

    const matFn = MAT_MAP[matName];
    const mat = matFn ? matFn() : matConcrete();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.userData.sharedMaterial = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    meshes.push(mesh);
  }

  // Glow panel mesh (under canopy, warm color, opacity controlled by night mode)
  if (glowGeoms.length > 0) {
    const merged = mergeGeometries(glowGeoms);
    glowGeoms.forEach(g => g.dispose());
    if (merged) {
      const m = new THREE.Mesh(merged, getFuelGlowMat());
      m.userData.sharedMaterial = true;
      m.castShadow = false;
      m.receiveShadow = false;
      meshes.push(m);
    }
  }

  // Fountain blob shadows
  if (shadowGeoms.length > 0) {
    const merged = mergeGeometries(shadowGeoms);
    shadowGeoms.forEach(g => g.dispose());
    if (merged) {
      const m = new THREE.Mesh(merged, getFountainShadowMat());
      m.userData.sharedMaterial = true;
      m.castShadow = false;
      m.receiveShadow = false;
      m.renderOrder = -1;
      meshes.push(m);
    }
  }

  // Ground pool mesh (radial gradient, opacity controlled by night mode)
  if (poolGeoms.length > 0) {
    const merged = mergeGeometries(poolGeoms);
    poolGeoms.forEach(g => g.dispose());
    if (merged) {
      const m = new THREE.Mesh(merged, getFuelPoolMat());
      m.userData.sharedMaterial = true;
      m.castShadow = false;
      m.receiveShadow = false;
      meshes.push(m);
    }
  }

  return meshes;
}

/**
 * Get exclusion zones for tree placement.
 * @param {Array} features - urbanFeatures from tile data
 * @returns {{ x: number, y: number, r: number }[]} - circles where trees should not spawn
 */
export function getUrbanFeatureExclusionZones(features) {
  if (!features || features.length === 0) return [];
  const zones = [];
  for (const f of features) {
    const r = EXCLUSION_RADIUS[f.type];
    if (!r) continue;
    zones.push({ x: f.point[0], y: f.point[1], r });
  }
  return zones;
}
