/**
 * Render urban infrastructure features from OSM data baked into tiles:
 *   communication_tower, water_tower, fountain, public_toilet, fuel_station, fire_hydrant
 *
 * Each type → simple procedural geometry via merged meshes (one mesh per type per tile).
 * point = [worldX, worldZ] in tile-local coords.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ─── Shared materials (persist across tiles) ────────────────────────────────

let _matSteel, _matRed, _matWhite, _matBrick, _matConcrete, _matWater,
    _matYellow, _matBlue, _matDarkGray, _matBPBlue, _matBPYellow, _matBPRoof,
    _matBrown, _matBeige, _matBush, _matRock;

function matSteel()    { return _matSteel    || (_matSteel    = shared(new THREE.MeshLambertMaterial({ color: 0x888899 }))); }
function matRed()      { return _matRed      || (_matRed      = shared(new THREE.MeshLambertMaterial({ color: 0xcc3333 }))); }
function matWhite()    { return _matWhite    || (_matWhite    = shared(new THREE.MeshLambertMaterial({ color: 0xeeeeee }))); }
function matBrick()    { return _matBrick    || (_matBrick    = shared(new THREE.MeshLambertMaterial({ color: 0x996644 }))); }
function matConcrete() { return _matConcrete || (_matConcrete = shared(new THREE.MeshLambertMaterial({ color: 0xbbbbbb }))); }
function matWater()    { return _matWater    || (_matWater    = shared(new THREE.MeshPhongMaterial({ color: 0x2277aa, emissive: 0x0a2233, specular: 0x88ccee, shininess: 90, transparent: true, opacity: 0.75 }))); }
function matYellow()   { return _matYellow   || (_matYellow   = shared(new THREE.MeshLambertMaterial({ color: 0xeecc22 }))); }
function matBlue()     { return _matBlue     || (_matBlue     = shared(new THREE.MeshLambertMaterial({ color: 0x3366aa }))); }
function matDarkGray() { return _matDarkGray || (_matDarkGray = shared(new THREE.MeshLambertMaterial({ color: 0x444444 }))); }
function matBrown()    { return _matBrown    || (_matBrown    = shared(new THREE.MeshPhongMaterial({ color: 0x8b6b42, specular: 0x221100, shininess: 8 }))); }
function matBeige()    { return _matBeige    || (_matBeige    = shared(new THREE.MeshLambertMaterial({ color: 0xc8b89a }))); }
function matBush()     { return _matBush     || (_matBush     = shared(new THREE.MeshLambertMaterial({ color: 0x3d7a3d }))); }
function matRock()     { return _matRock     || (_matRock     = shared(new THREE.MeshLambertMaterial({ color: 0x8a8a7a }))); }
// Indian petrol pump colors (Bharat Petroleum style)
function matBPBlue()   { return _matBPBlue   || (_matBPBlue   = shared(new THREE.MeshStandardMaterial({ color: 0x1a5ba8, emissive: 0x1a5ba8, emissiveIntensity: 0, roughness: 0.6 }))); }
function matBPYellow() { return _matBPYellow || (_matBPYellow = shared(new THREE.MeshStandardMaterial({ color: 0xf5c518, emissive: 0xf5c518, emissiveIntensity: 0, roughness: 0.6 }))); }
function matBPRoof()   { return _matBPRoof   || (_matBPRoof   = shared(new THREE.MeshLambertMaterial({ color: 0xd4cfc0 }))); }

function shared(mat) { mat.userData = { sharedMaterial: true }; return mat; }

// ─── Tower beacon light (blinking red) ──────────────────────────────────────
let _beaconMat = null;
let _beaconGeom = null;

function getBeaconMat() {
  if (!_beaconMat) {
    _beaconMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    _beaconMat.userData.sharedMaterial = true;
  }
  return _beaconMat;
}

function getBeaconGeom() {
  if (!_beaconGeom) {
    _beaconGeom = new THREE.SphereGeometry(0.35, 6, 4);
    _beaconGeom.userData.sharedGeometry = true;
  }
  return _beaconGeom;
}

/** Call from animation loop to blink tower beacons. timeSec = elapsed seconds. */
export function updateTowerBeacons(timeSec) {
  if (!_beaconMat) return;
  // 1 second on, 1 second off
  const on = Math.floor(timeSec * 1.0) % 2 === 0;
  _beaconMat.opacity = on ? 1.0 : 0.0;
  _beaconMat.transparent = !on;
  _beaconMat.visible = on;
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

// Sulabh Toilet Complex sign — single shared canvas texture
let _sulabhSignMat = null;
function matSulabhSign() {
  if (!_sulabhSignMat) {
    const w = 256, h = 64;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    // Blue background
    ctx.fillStyle = '#1a3d8f';
    ctx.fillRect(0, 0, w, h);
    // White border
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.strokeRect(2, 2, w - 4, h - 4);
    // Text
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 18px Arial, sans-serif';
    ctx.fillText('SULABH', w / 2, h * 0.32);
    ctx.font = 'bold 14px Arial, sans-serif';
    ctx.fillText('TOILET COMPLEX', w / 2, h * 0.68);
    const tex = new THREE.CanvasTexture(c);
    tex.repeat.x = -1; tex.offset.x = 1; // scene X-mirror fix
    _sulabhSignMat = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0, roughness: 0.5 });
    _sulabhSignMat.userData = { sharedMaterial: true };
  }
  return _sulabhSignMat;
}

/** Toggle fuel station + toilet night illumination. Call from day/night system. */
export function setFuelStationNightMode(isNight) {
  if (_fuelGlowMat) _fuelGlowMat.opacity = isNight ? 3.0 : 0;
  if (_fuelPoolMat) _fuelPoolMat.opacity = isNight ? 0.5 : 0;
  // Illuminate blue/yellow fascia strips on petrol pumps
  const emitI = isNight ? 1.5 : 0;
  if (_matBPBlue) _matBPBlue.emissiveIntensity = emitI;
  if (_matBPYellow) _matBPYellow.emissiveIntensity = emitI;
  // Illuminate Sulabh Toilet Complex sign boards
  if (_sulabhSignMat) _sulabhSignMat.emissiveIntensity = isNight ? 1.2 : 0;
}

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
  const geos = [];
  const nPillars = 6;
  const pillarR = 3.2;       // circle radius for pillars
  const pillarDiam = 0.35;
  const legH = 14;            // pillar height
  const tankR = 4;            // tank radius
  const tankH = 5;            // cylindrical section height
  const coneH = 2.5;          // conical bottom depth
  const domeH = 1.8;          // dome height
  const tankBot = legH;       // bottom of cylindrical section
  const tankTop = tankBot + tankH;
  const walkwayY = tankBot - 0.1;

  // ── 6 round pillars ──
  for (let i = 0; i < nPillars; i++) {
    const a = (i / nPillars) * Math.PI * 2;
    const px = Math.cos(a) * pillarR, pz = Math.sin(a) * pillarR;
    const pillar = new THREE.CylinderGeometry(pillarDiam, pillarDiam, legH, 8);
    pillar.translate(px, legH / 2, pz);
    geos.push({ geo: pillar, mat: 'white' });
  }

  // ── Horizontal ring beams (3 levels) ──
  for (let level = 0; level < 3; level++) {
    const y = 4 + level * 4.5;
    const ring = new THREE.TorusGeometry(pillarR, 0.12, 4, nPillars * 2);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, y, 0);
    geos.push({ geo: ring, mat: 'white' });
  }

  // ── Conical bottom (inverted truncated cone) ──
  const cone = new THREE.CylinderGeometry(0.6, tankR, coneH, 12);
  cone.translate(0, tankBot - coneH / 2, 0);
  geos.push({ geo: cone, mat: 'white' });

  // ── Cylindrical tank body ──
  const tankBody = new THREE.CylinderGeometry(tankR, tankR, tankH, 14);
  tankBody.translate(0, tankBot + tankH / 2, 0);
  geos.push({ geo: tankBody, mat: 'white' });

  // ── Red accent band at bottom of tank ──
  const bandBot = new THREE.CylinderGeometry(tankR + 0.05, tankR + 0.05, 0.3, 14);
  bandBot.translate(0, tankBot + 0.15, 0);
  geos.push({ geo: bandBot, mat: 'red' });

  // ── Red accent band at top of tank ──
  const bandTop = new THREE.CylinderGeometry(tankR + 0.05, tankR + 0.05, 0.3, 14);
  bandTop.translate(0, tankTop - 0.15, 0);
  geos.push({ geo: bandTop, mat: 'red' });

  // ── Dome top (half-sphere sitting on top of tank) ──
  // SphereGeometry with phi 0..0.35π: center is at origin, top ~= R*cos(0)=R, bottom ~= R*cos(0.35π)≈0.31R
  // We need the bottom of the dome to sit at tankTop, so shift up by the bottom offset
  const phiEnd = Math.PI * 0.35;
  const domeBottomY = tankR * Math.cos(phiEnd); // ~0.31 * tankR
  const dome = new THREE.SphereGeometry(tankR, 14, 8, 0, Math.PI * 2, 0, phiEnd);
  dome.translate(0, tankTop - domeBottomY, 0);
  geos.push({ geo: dome, mat: 'white' });

  // ── Small cap on dome ──
  const actualDomeTop = tankTop - domeBottomY + tankR; // top of the sphere
  const capR = 0.5;
  const capCyl = new THREE.CylinderGeometry(capR, capR, 0.6, 6);
  capCyl.translate(0, actualDomeTop + 0.3, 0);
  geos.push({ geo: capCyl, mat: 'red' });

  // Red beacon light on top of cap
  const beaconY = actualDomeTop + 0.6 + 0.35;
  const beaconGeo = new THREE.SphereGeometry(0.35, 6, 4);
  beaconGeo.translate(0, beaconY, 0);
  geos.push({ geo: beaconGeo, mat: 'beacon' });

  // ── Walkway platform (ring at base of tank) ──
  const walkRing = new THREE.TorusGeometry(tankR + 0.6, 0.3, 3, 20);
  walkRing.rotateX(Math.PI / 2);
  walkRing.translate(0, walkwayY, 0);
  geos.push({ geo: walkRing, mat: 'concrete' });

  // ── Railing posts around walkway (16 posts) ──
  const railR = tankR + 0.6;
  const nRailPosts = 16;
  for (let i = 0; i < nRailPosts; i++) {
    const a = (i / nRailPosts) * Math.PI * 2;
    const rx = Math.cos(a) * railR, rz = Math.sin(a) * railR;
    const post = new THREE.CylinderGeometry(0.03, 0.03, 1.0, 4);
    post.translate(rx, walkwayY + 0.5, rz);
    geos.push({ geo: post, mat: 'steel' });
  }

  // ── Railing top rail (torus) ──
  const topRail = new THREE.TorusGeometry(railR, 0.04, 3, 20);
  topRail.rotateX(Math.PI / 2);
  topRail.translate(0, walkwayY + 1.0, 0);
  geos.push({ geo: topRail, mat: 'steel' });

  // ── Staircase (spiral steps from ground to walkway) ──
  const stairR = pillarR + 0.8;
  const nSteps = 24;
  for (let i = 0; i < nSteps; i++) {
    const t = i / nSteps;
    const a = t * Math.PI * 1.5 + Math.PI * 0.25; // 270 degrees spiral
    const sx = Math.cos(a) * stairR, sz = Math.sin(a) * stairR;
    const sy = t * walkwayY;
    const step = new THREE.BoxGeometry(1.0, 0.1, 0.35);
    step.applyMatrix4(new THREE.Matrix4().makeRotationY(-a));
    step.translate(sx, sy, sz);
    geos.push({ geo: step, mat: 'concrete' });

    // Red accent on step front
    if (i % 3 === 0) {
      const accent = new THREE.BoxGeometry(1.0, 0.12, 0.06);
      accent.applyMatrix4(new THREE.Matrix4().makeRotationY(-a));
      accent.translate(sx, sy + 0.05, sz);
      geos.push({ geo: accent, mat: 'red' });
    }
  }

  // ── Stair railing (inner rail = vertical posts along staircase) ──
  const nStairRails = 12;
  for (let i = 0; i < nStairRails; i++) {
    const t = i / nStairRails;
    const a = t * Math.PI * 1.5 + Math.PI * 0.25;
    const sx = Math.cos(a) * (stairR + 0.4), sz = Math.sin(a) * (stairR + 0.4);
    const sy = t * walkwayY;
    const rail = new THREE.CylinderGeometry(0.03, 0.03, 1.0, 4);
    rail.translate(sx, sy + 0.5, sz);
    geos.push({ geo: rail, mat: 'steel' });
  }

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
  geos.push({ geo: poolOuter, mat: 'brown' });

  const poolWater = new THREE.CylinderGeometry(poolR - 0.2, poolR - 0.2, 0.05, segs);
  poolWater.translate(0, poolWallH * 0.6, 0);
  geos.push({ geo: poolWater, mat: 'water' });

  // ── Lower pedestal (tapered column rising from pool center) ──
  const ped1 = new THREE.CylinderGeometry(0.8, 1.1, 1.0, segs);
  ped1.translate(0, poolWallH + 0.5, 0);
  geos.push({ geo: ped1, mat: 'brown' });

  // ── Middle basin (smaller bowl catching water) ──
  const midR = 1.8, midWallH = 0.35;
  const midBasin = new THREE.CylinderGeometry(midR, midR - 0.1, midWallH, segs);
  midBasin.translate(0, poolWallH + 1.0 + midWallH / 2, 0);
  geos.push({ geo: midBasin, mat: 'brown' });

  const midWater = new THREE.CylinderGeometry(midR - 0.15, midR - 0.15, 0.04, segs);
  midWater.translate(0, poolWallH + 1.0 + midWallH * 0.7, 0);
  geos.push({ geo: midWater, mat: 'water' });

  // ── Decorative lip ring on middle basin ──
  const lipRing = new THREE.TorusGeometry(midR, 0.08, 6, segs);
  lipRing.rotateX(Math.PI / 2);
  lipRing.translate(0, poolWallH + 1.0 + midWallH, 0);
  geos.push({ geo: lipRing, mat: 'brown' });

  // ── Upper pedestal ──
  const ped2 = new THREE.CylinderGeometry(0.4, 0.65, 0.8, segs);
  ped2.translate(0, poolWallH + 1.0 + midWallH + 0.4, 0);
  geos.push({ geo: ped2, mat: 'brown' });

  // ── Upper bowl (small top basin) ──
  const topR = 1.0, topH = 0.25;
  const topBowl = new THREE.CylinderGeometry(topR, topR - 0.08, topH, segs);
  topBowl.translate(0, poolWallH + 1.0 + midWallH + 0.8 + topH / 2, 0);
  geos.push({ geo: topBowl, mat: 'brown' });

  const topWater = new THREE.CylinderGeometry(topR - 0.12, topR - 0.12, 0.03, segs);
  topWater.translate(0, poolWallH + 1.0 + midWallH + 0.8 + topH * 0.7, 0);
  geos.push({ geo: topWater, mat: 'water' });

  // ── Finial (small pointed top) ──
  const finial = new THREE.ConeGeometry(0.18, 0.6, 6);
  finial.translate(0, poolWallH + 1.0 + midWallH + 0.8 + topH + 0.3, 0);
  geos.push({ geo: finial, mat: 'brown' });

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
 * Sulabh Toilet Complex (Indian public toilet):
 * Brown/beige stone-clad building, concrete roof overhang, entry steps,
 * steel railing, blue "SULABH TOILET COMPLEX" sign board,
 * surrounded by scattered bushes and stones.
 * Faces +Z (road side). Caller rotates to face nearest road.
 */
function buildPublicToilet() {
  const geos = [];
  const w = 6, d = 5, h = 3.8;

  // Lower wall section (brown stone)
  const lowerH = 1.8;
  const lower = new THREE.BoxGeometry(w, lowerH, d);
  lower.translate(0, lowerH / 2, 0);
  geos.push({ geo: lower, mat: 'brown' });

  // Upper wall section (beige)
  const upperH = h - lowerH;
  const upper = new THREE.BoxGeometry(w, upperH, d);
  upper.translate(0, lowerH + upperH / 2, 0);
  geos.push({ geo: upper, mat: 'beige' });

  // Brown trim band between lower and upper
  const trim = new THREE.BoxGeometry(w + 0.06, 0.12, d + 0.06);
  trim.translate(0, lowerH, 0);
  geos.push({ geo: trim, mat: 'brown' });

  // Roof slab (concrete overhang on front)
  const roofOverhang = 0.8;
  const roof = new THREE.BoxGeometry(w + 0.5, 0.2, d + roofOverhang);
  roof.translate(0, h + 0.1, roofOverhang / 2);
  geos.push({ geo: roof, mat: 'concrete' });

  // Entry opening (dark recess on front face, +Z side)
  const entryW = 1.4, entryH = 2.6;
  for (const side of [-1, 1]) {
    const door = new THREE.BoxGeometry(entryW, entryH, 0.06);
    door.translate(side * 1.2, entryH / 2, d / 2 + 0.03);
    geos.push({ geo: door, mat: 'darkGray' });
  }

  // Steps (3 steps in front)
  for (let i = 0; i < 3; i++) {
    const step = new THREE.BoxGeometry(w + 0.3, 0.15, 0.4);
    step.translate(0, 0.075 + i * 0.15, d / 2 + roofOverhang + 0.2 - i * 0.4);
    geos.push({ geo: step, mat: 'concrete' });
  }

  // Steel railing in front (horizontal bars)
  const railW = w * 0.35;
  for (const side of [-1, 1]) {
    const rx = side * (w / 2 + 0.15 - railW / 2);
    const rz = d / 2 + 0.6;
    for (const end of [-1, 1]) {
      const post = new THREE.CylinderGeometry(0.03, 0.03, 1.1, 4);
      post.translate(rx + end * railW / 2, 0.55, rz);
      geos.push({ geo: post, mat: 'steel' });
    }
    for (let b = 0; b < 4; b++) {
      const bar = new THREE.BoxGeometry(railW, 0.03, 0.03);
      bar.translate(rx, 0.2 + b * 0.25, rz);
      geos.push({ geo: bar, mat: 'steel' });
    }
  }

  // Blue sign board ("SULABH TOILET COMPLEX") above entrance
  const signW = 3.2, signH = 0.8;  // 4:1 ratio to match canvas texture
  const signBoard = new THREE.PlaneGeometry(signW, signH);
  signBoard.translate(0, h - 0.1, d / 2 + 0.04);
  geos.push({ geo: signBoard, mat: 'sulabhSign' });
  const signBack = new THREE.BoxGeometry(signW, signH, 0.04);
  signBack.translate(0, h - 0.1, d / 2 + 0.01);
  geos.push({ geo: signBack, mat: 'blue' });

  // ── Surrounding landscaping: bushes + stones (scattered around sides & back) ──
  // Use deterministic positions relative to building
  const scatterPoints = [
    // Back side bushes
    { x: -2.2, z: -d / 2 - 1.2, type: 'bush' },
    { x:  0.8, z: -d / 2 - 1.5, type: 'bush' },
    { x:  2.5, z: -d / 2 - 0.8, type: 'bush' },
    // Left side
    { x: -w / 2 - 1.0, z: -0.5, type: 'bush' },
    { x: -w / 2 - 1.3, z:  1.2, type: 'bush' },
    // Right side
    { x:  w / 2 + 1.2, z:  0.3, type: 'bush' },
    { x:  w / 2 + 0.9, z: -1.5, type: 'bush' },
    // Stones scattered
    { x: -w / 2 - 0.6, z:  d / 2 + 0.8, type: 'rock' },
    { x:  w / 2 + 0.7, z:  d / 2 + 0.6, type: 'rock' },
    { x: -1.8, z: -d / 2 - 0.5, type: 'rock' },
    { x:  2.0, z: -d / 2 - 1.8, type: 'rock' },
    { x:  w / 2 + 1.5, z: -0.8, type: 'rock' },
    // Front corner bushes (smaller, not blocking entrance)
    { x: -w / 2 - 0.5, z:  d / 2 + 0.4, type: 'bush_small' },
    { x:  w / 2 + 0.5, z:  d / 2 + 0.3, type: 'bush_small' },
  ];

  for (const sp of scatterPoints) {
    if (sp.type === 'bush') {
      // Low-poly bush: flattened icosphere
      const bush = new THREE.IcosahedronGeometry(0.6 + Math.abs(sp.x * 0.1), 1);
      bush.scale(1, 0.6, 1);
      bush.translate(sp.x, 0.35, sp.z);
      geos.push({ geo: bush, mat: 'bush' });
    } else if (sp.type === 'bush_small') {
      const bush = new THREE.IcosahedronGeometry(0.4, 1);
      bush.scale(1, 0.55, 1);
      bush.translate(sp.x, 0.22, sp.z);
      geos.push({ geo: bush, mat: 'bush' });
    } else {
      // Rock: small irregular dodecahedron
      const rock = new THREE.DodecahedronGeometry(0.2 + Math.abs(sp.z * 0.03), 0);
      rock.scale(1.2, 0.5, 0.9);
      rock.translate(sp.x, 0.1, sp.z);
      geos.push({ geo: rock, mat: 'rock' });
    }
  }

  return geos;
}

/**
 * Indian-style fuel station (Bharat Petroleum inspired):
 * Flat canopy with blue fascia band + yellow accent stripe,
 * 6 round pillars, 3 fuel pump islands, concrete ground slab.
 * Built at origin, facing +Z (road side). Caller rotates.
 */
function buildFuelStation() {
  const geos = [];
  const canopyW = 14, canopyD = 10, canopyH = 7;

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
  geos.push({ geo: roof, mat: 'bpRoof' });

  // Blue fascia band on all 4 sides
  const fasciaH = 0.7;
  const fasciaY = canopyH - 0.18 - fasciaH / 2;
  for (const side of [-1, 1]) {
    const fascia = new THREE.BoxGeometry(canopyW + 0.9, fasciaH, 0.15);
    fascia.translate(0, fasciaY, side * (canopyD / 2 + 0.4));
    geos.push({ geo: fascia, mat: 'bpBlue' });
  }
  for (const side of [-1, 1]) {
    const fascia = new THREE.BoxGeometry(0.15, fasciaH, canopyD + 0.9);
    fascia.translate(side * (canopyW / 2 + 0.4), fasciaY, 0);
    geos.push({ geo: fascia, mat: 'bpBlue' });
  }

  // Yellow accent stripe below blue fascia
  const stripeH = 0.3;
  const stripeY = fasciaY - fasciaH / 2 - stripeH / 2;
  for (const side of [-1, 1]) {
    const stripe = new THREE.BoxGeometry(canopyW + 0.9, stripeH, 0.15);
    stripe.translate(0, stripeY, side * (canopyD / 2 + 0.4));
    geos.push({ geo: stripe, mat: 'bpYellow' });
  }
  for (const side of [-1, 1]) {
    const stripe = new THREE.BoxGeometry(0.15, stripeH, canopyD + 0.9);
    stripe.translate(side * (canopyW / 2 + 0.4), stripeY, 0);
    geos.push({ geo: stripe, mat: 'bpYellow' });
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
  geos.push({ geo: offRoof, mat: 'bpYellow' });

  // Office door
  const offDoor = new THREE.BoxGeometry(1.2, 2.4, 0.06);
  offDoor.translate(canopyW / 2 - offW / 2, 1.2, -canopyD / 2 - 0.78);
  geos.push({ geo: offDoor, mat: 'darkGray' });

  return geos;
}

/**
 * Fire hydrant: short red pillar with cap and outlets.
 */
function buildFireHydrant() {
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

// ─── Material lookup ────────────────────────────────────────────────────────

const MAT_MAP = {
  steel: matSteel, red: matRed, white: matWhite, brick: matBrick,
  concrete: matConcrete, water: matWater,
  yellow: matYellow, blue: matBlue, darkGray: matDarkGray,
  bpBlue: matBPBlue, bpYellow: matBPYellow, bpRoof: matBPRoof,
  brown: matBrown, beige: matBeige, sulabhSign: matSulabhSign,
  bush: matBush, rock: matRock, beacon: getBeaconMat,
};

// ─── Builder dispatch ───────────────────────────────────────────────────────

const BUILDERS = {
  communication_tower: buildCommTower,
  water_tower: buildWaterTower,
  fountain: buildFountain,
  public_toilet: buildPublicToilet,
  fuel_station: buildFuelStation,
  fire_hydrant: buildFireHydrant,
};

// Types that should be oriented to face the nearest road
const ROAD_FACING_TYPES = new Set(['fuel_station', 'public_toilet']);

// Exclusion radius per type (metres) — trees won't spawn within this radius
const EXCLUSION_RADIUS = {
  fuel_station: 18,
  communication_tower: 5,
  water_tower: 6,
  fountain: 5,
  public_toilet: 5,
  fire_hydrant: 1.5,
};

// ─── Main export ────────────────────────────────────────────────────────────

/**
 * Build meshes for urban features in a tile.
 * @param {Array} features - [{ type, point: [wx, wz], id, tags }]
 * @param {Array} [roads] - tile roads for orientation (optional)
 * @param {Array} [buildings] - tile buildings for collision avoidance (optional)
 * @returns {THREE.Mesh[]}
 */
export function buildUrbanFeatureMeshes(features, roads, buildings, getGroundY) {
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
    const parts = builder();

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
  }

  _glowTemplate.dispose();
  _poolTemplate.dispose();

  const meshes = [];
  for (const [matName, geos] of byMat) {
    if (geos.length === 0) continue;
    const merged = mergeGeometries(geos);
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
