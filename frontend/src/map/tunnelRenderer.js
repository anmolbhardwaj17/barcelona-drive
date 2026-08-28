/**
 * Barcelona tunnel renderer.
 *
 * Interior: cream ceramic tile walls, LED ceiling strips, yellow safety stripe.
 * Approach: retaining walls for urban box cuts (default);
 *           terrain carving for genuine hillside approaches (motorway/trunk >60m only).
 * Pedestrian tunnels: portal-frame only, no interior geometry.
 * No Delhi-era chevron curbs, guardrails, or arched canopies.
 */
import * as THREE from 'three';
import { getLiningTextures, getConcreteTextures } from './tunnelTextures.js';   // v3 P4-18
import { getRoadSurface } from './roadTexturePack.js';     // v3 P4-18 — reuse the resident asphalt
import { getKTX2TextureSync } from '../loaders.js';        // v3 P4-18 — trench rock face
import { kerbOffset } from './roadWidths.js';   // R-W1: a tunnel's paved width is kerb-to-kerb
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { getWorldElevationOffset } from '../elevationOffset.js';
import { latLonToWorld } from '../projection.js';

/**
 * Normalize a raw road-point elevation (absolute DEM, post road-drape) into the spawn-anchored
 * render frame: (rawDEM − worldElevationOffset) × vertExag. Tunnel structures are anchored to road
 * points, so their elevation reads must be normalized (like roadRenderer / roadInfraRenderer) or they
 * float +offset. Surface-level constants (terrain top) are anchored via the getGroundY callback
 * instead. See gotchas G-45. Note: deep tunnel-enclosure depth/skip logic is the Stage-3 rework.
 */
function _normTunnelElev(rawElev) {
  if (rawElev == null || !Number.isFinite(rawElev)) return null;
  const off = getWorldElevationOffset() ?? 0;
  const vEx = (CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null
    && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)) ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;
  return (rawElev - off) * vEx;
}
const _gy = (fn, x, z) => (typeof fn === 'function' ? fn(x, z) : 0);

const WALL_EXTRA_WIDTH  = 1;      // extra width beyond road half for walls/ceiling
const TUNNEL_CLEARANCE  = 4.5;   // metres from road floor to ceiling (constant clearance)

// ── Dimensions ───────────────────────────────────────────────────────────────
const SAFETY_STRIPE_W   = 0.15;  // yellow safety stripe width along road edge
const SAFETY_STRIPE_H   = 0.05;  // height above road floor
const LED_STRIP_W       = 0.10;  // LED strip width at ceiling-wall junction
const LED_STRIP_H       = 0.05;  // LED strip depth

// ── Portal (tunnel mouth) ────────────────────────────────────────────────────
const PORTAL_THICKNESS = 1.2;     // depth of the concrete portal wall
const PORTAL_HEIGHT    = 0;       // portal top at ground level (Y=0)
const PORTAL_WING      = 3;       // extra width on each side beyond tunnel walls
const SIGN_HEIGHT      = 1.2;     // sign board height

// ── Colors (Barcelona style) ─────────────────────────────────────────────────
const WALL_COLOR              = 0xEFE8DB; // cream/off-white ceramic tile
const CEILING_COLOR           = 0x7a7a78; // medium grey concrete ceiling
const FLOOR_COLOR             = 0x4a4a4a; // dark asphalt
const LED_COLOR               = 0xFFF8E8; // warm white LED (MeshBasicMaterial — self-lit)
const PORTAL_COLOR            = 0xB0ADA8; // concrete portal
const SAFETY_COLOR            = 0xF5D000; // yellow safety stripe
const RETAINING_COLOR         = 0x8a8a85; // light grey concrete retaining wall
const PEDESTRIAN_PORTAL_COLOR = 0x3a3a3a; // dark charcoal pedestrian portal frame

// ── Geometry helper ───────────────────────────────────────────────────────────

/**
 * A quad, with UVs IN METRES.
 *
 * ── P4-18 · WHY THIS HAD NO UVs, AND WHY THAT WAS THE WHOLE BLOCKER ──────────────────────────
 * Every tunnel surface — lining, portal faces, retaining walls, the in-tunnel road — was a flat
 * MeshLambert colour with no map. It was not that nobody chose a texture; it is that the geometry
 * could not carry one: this function emitted `position` only, so a textured material had nothing to
 * sample with. Hence "nobody owned tunnel lining".
 *
 * ── THE CORNER CONVENTION, WHICH IS WHAT MAKES ONE RULE WORK FOR ALL 32 CALL SITES ──────────
 * Every caller passes a and b on the NEAR cross-section and c and d on the FAR one:
 *
 *     floor:  a = near-left,  b = near-right,  c = far-left,  d = far-right
 *     wall:   a = near-top,   b = near-bottom, c = far-top,   d = far-bottom
 *
 * so in both cases **a→c runs ALONG the tunnel** and **a→b runs ACROSS it** (width, or height).
 * U therefore follows the tunnel and V goes across, measured in real metres off the actual edge
 * lengths — no call site has to know anything. A material states its span in metres and sets
 * `map.repeat = 1 / span`, the same "span is declared, not assumed" contract roadTexturePack uses.
 *
 * `uOffset` is the running distance along the tunnel. Without it U restarts at 0 every segment and
 * the lining visibly resets at each one; the main loop accumulates it. Callers that build a single
 * standalone quad (portal frames, cliff faces) can leave it at 0.
 */
function buildQuad(a, b, c, d, uOffset = 0, nearL = 1, farL = 1) {
  const positions = new Float32Array([
    a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z,
    c.x, c.y, c.z, b.x, b.y, b.z, d.x, d.y, d.z,
  ]);
  const dist = (p, q) => Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
  const vA = 0,            uA = uOffset;
  const vB = dist(a, b),   uB = uOffset;
  const vC = 0,            uC = uOffset + dist(a, c);
  const vD = dist(c, d),   uD = uOffset + dist(b, d);
  const uvs = new Float32Array([
    uA, vA,  uB, vB,  uC, vC,
    uC, vC,  uB, vB,  uD, vD,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  // P4-18: per-end brightness as vertex colour. `nearL` applies to the a/b edge and `farL` to c/d,
  // so a segment can fade along the tunnel — see `portalFalloff`.
  //
  // ⚠ EMITTED ALWAYS, defaulting to 1. Two reasons, both bugs that were already latent here:
  //   · `mergeGeometries` needs every geometry in a group to carry the SAME attributes, and these
  //     arrays are filled from more than one place.
  //   · The `floor` material is shared between `buildTunnelMeshes` and `buildTunnelFloor`. Once it
  //     declares `vertexColors: true`, geometry without the attribute renders undefined.
  // Making it unconditional costs 72 bytes a quad and removes the whole class.
  const cols = new Float32Array([
    nearL, nearL, nearL,  nearL, nearL, nearL,  farL, farL, farL,
    farL,  farL,  farL,   nearL, nearL, nearL,  farL, farL, farL,
  ]);
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * How lit is a point `d` metres into the tunnel from the nearest mouth?
 *
 * ── WHY THIS IS GEOMETRY AND NOT A LIGHT ──────────────────────────────────────────────────────
 * The obvious way to light a portal mouth is punctual lights through `lightGrid`. It does not work
 * here: `lightGrid` sets `uLGEnabled = (_enabled && _isNight)`, so **the whole grid is off during
 * the day** — and a tunnel is dark at noon. Lighting the portal that way would deliver the effect
 * only at night, which is the one time it is least needed, and making the grid day-capable means
 * surgery on a working night system for a corridor-local problem.
 *
 * So the falloff is baked into vertex colour instead: full daylight spill at the mouth, decaying to
 * `DEEP` a few tens of metres in, where the LED strip is the only source. Costs one vertex
 * attribute, no lights, no uniforms, and it is correct in BOTH day and night because it describes
 * how much of the outside gets in — which does not depend on the time of day being simulated.
 */
const PORTAL_LIT_M = 38;    // metres over which daylight spill decays to nothing
const DEEP_LIT     = 0.30;  // floor brightness deep inside, lit only by the strip
function portalFalloff(d) {
  const t = Math.max(0, Math.min(1, d / PORTAL_LIT_M));
  // smoothstep, so the mouth does not end in a visible band
  const s = t * t * (3 - 2 * t);
  return 1 - (1 - DEEP_LIT) * s;
}


/**
 * Give a geometry a white vertex-colour attribute if it has none.
 *
 * ⚠ Needed because `retwall` and `portal` now declare `vertexColors: true`, and not every producer
 * routes through `buildQuad`: the pedestrian portal builds its posts and lintel from
 * `THREE.BoxGeometry`, which carries position/normal/uv and NO colour. A material with
 * `vertexColors` on and geometry without the attribute renders undefined, and `mergeGeometries`
 * refuses a group whose members disagree. Both failures are silent at build and test time — the
 * file compiles, the suite passes, and the portal is simply wrong on screen.
 */
function ensureVertexColor(geo) {
  if (geo.getAttribute('color')) return geo;
  const n = geo.getAttribute('position').count;
  const cols = new Float32Array(n * 3).fill(1);
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return geo;
}

function perpDir(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  return { x: -dz / len, z: dx / len };
}

// ── Cached materials ─────────────────────────────────────────────────────────

const _mats = {};
function _mat(key, factory) {
  if (_mats[key]) return _mats[key];
  const m = factory();
  m.userData = { sharedMaterial: true };
  _mats[key] = m;
  return m;
}

/**
 * P4-18 — a shared road plate, re-scaled for metre UVs without disturbing the road renderer.
 *
 * `getRoadSurface` hands back the SAME texture objects the carriageway draws with. Setting
 * `.repeat` on those would change the road too, so this clones them: a three.js clone shares
 * `.source`, i.e. the same GPU image and the same mip chain, and owns only its sampler state. Zero
 * additional VRAM, no coupling. Returns null if the pack is unavailable so the caller can fall back
 * to flat colour rather than throw inside a tile build (H16 — a throw here empties the tile).
 */
function _roadPlate(name) {
  try {
    const pack = getRoadSurface(name);
    const span = pack.spanM || 2.0;
    const mk = (t) => {
      const c = t.clone();
      c.wrapS = c.wrapT = THREE.RepeatWrapping;
      c.repeat.set(1 / span, 1 / span);   // UVs are in METRES — see buildQuad
      c.needsUpdate = true;
      return c;
    };
    return { map: mk(pack.albedo), normalMap: mk(pack.normal) };
  } catch (e) {
    console.warn('[tunnel] road plate unavailable, falling back to flat colour:', e.message);
    return null;
  }
}

const getMat = {
  // The tunnel carriageway is asphalt, and the asphalt plate is already resident and preloaded —
  // so this is a free correction of a surface that was a flat grey fill.
  floor:     () => _mat('floor', () => {
    const p = _roadPlate('asphalt_worn');
    return new THREE.MeshLambertMaterial({
      color: p ? 0xffffff : FLOOR_COLOR, ...(p || {}), side: THREE.DoubleSide,
      vertexColors: true,   // P4-18 portal falloff — silently ignored if this is off
    });
  }),
  // Lining: ceramic tile on a 0.2 m grid. Wall and ceiling share one texture pair and differ only
  // by tint — the ceiling of a road tunnel is the same tile, just never cleaned and never lit.
  wall:      () => _mat('wall', () => new THREE.MeshLambertMaterial({
    color: 0xffffff, ...getLiningTextures(), side: THREE.DoubleSide, vertexColors: true,
  })),
  ceiling:   () => _mat('ceiling', () => new THREE.MeshLambertMaterial({
    color: CEILING_COLOR, ...getLiningTextures(), side: THREE.DoubleSide, vertexColors: true,
  })),
  led:       () => _mat('led',       () => new THREE.MeshBasicMaterial  ({ color: LED_COLOR,     side: THREE.DoubleSide })),
  safety:    () => _mat('safety',    () => new THREE.MeshLambertMaterial({ color: SAFETY_COLOR,  side: THREE.DoubleSide })),
  // Portal faces and trench retaining walls are the same board-formed concrete, tinted apart only
  // so the portal frame still reads as a distinct element against the wall behind it.
  portal:    () => _mat('portal', () => new THREE.MeshLambertMaterial({
    color: PORTAL_COLOR, ...getConcreteTextures(), side: THREE.DoubleSide, vertexColors: true,
  })),
  retwall:   () => _mat('retwall', () => new THREE.MeshLambertMaterial({
    color: RETAINING_COLOR, ...getConcreteTextures(), side: THREE.DoubleSide, vertexColors: true,
  })),
  pedportal: () => _mat('pedportal', () => new THREE.MeshLambertMaterial({ color: PEDESTRIAN_PORTAL_COLOR, side: THREE.DoubleSide })),
};

// Per-name sign texture cache (road name → "TÚNEL DE RONDA LITORAL")
const _signTexCache = new Map();
function getSignTexture(roadName) {
  const label = roadName ? `TÚNEL DE ${roadName.toUpperCase()}` : 'TÚNEL';
  if (_signTexCache.has(label)) return _signTexCache.get(label);
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#003d7a';
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${label.length > 12 ? 44 : 56}px sans-serif`;
  ctx.fillText(label, 256, 64, 490);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  _signTexCache.set(label, tex);
  return tex;
}
function getSignMat(roadName) {
  const key = `sign_${roadName || ''}`;
  return _mat(key, () => new THREE.MeshBasicMaterial({ map: getSignTexture(roadName), side: THREE.DoubleSide }));
}

// ── Main interior export ──────────────────────────────────────────────────────
// Barcelona style: cream tile walls, LED ceiling strips, yellow safety stripe,
// relative ceiling height, no chevron curbs, no guardrails, no discrete spotlights.

export function buildTunnelMeshes(tunnelRoads, getGroundY) {
  const group = new THREE.Group();
  if (!tunnelRoads?.length) return group;

  const ceilingGeos = [];
  const wallGeos    = [];
  const floorGeos   = [];
  const ledGeos     = [];    // continuous LED strips at ceiling-wall junction
  const safetyGeos  = [];   // yellow safety stripe at road edge
  const portalGeos  = [];
  const signGeosMap = new Map(); // roadName → geo[]

  const mergeAndAdd = (geos, mat, name) => {
    if (!geos.length) return;
    const merged = mergeGeometries(geos, false);
    if (merged) {
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = name;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    geos.forEach(g => g.dispose());
  };

  for (const road of tunnelRoads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;

    const roadHalf = kerbOffset(road);
    const halfW    = roadHalf + WALL_EXTRA_WIDTH;
    const roadName = road.name || null;
    if (!signGeosMap.has(roadName)) signGeosMap.set(roadName, []);

    // P4-18: running distance along this tunnel, in metres, fed to buildQuad as the U origin so
    // the lining reads as one continuous surface instead of restarting at every segment joint.
    let runU = 0;
    // Total centreline length, needed BEFORE the loop so each segment knows its distance from the
    // NEARER mouth — that is what makes both ends of the tunnel bright instead of just the first.
    let totalLen = 0;
    for (let k = 0; k < pts.length - 1; k++) {
      totalLen += Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].y - pts[k].y);
    }
    const litAt = (d) => portalFalloff(Math.min(d, totalLen - d));
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      // Normalize absolute DEM road elevation into the spawn frame (was raw → floated +offset).
      const eA = _normTunnelElev(a.elevation);
      const eB = _normTunnelElev(b.elevation);
      if (eA == null || eB == null) { runU += segLen; continue; }
      const gA = _gy(getGroundY, a.x, a.y), gB = _gy(getGroundY, b.x, b.y);

      // Skip segments at/above LOCAL terrain (terrain-relative; was absolute > -0.5, which assumed
      // tunnels live near Y=0). Ramp-fixed portals reach the surface — no enclosure there.
      if (eA > gA - 0.5 || eB > gB - 0.5) { runU += segLen; continue; }

      // Ceiling: constant clearance above road floor
      const ceilA = eA + TUNNEL_CLEARANCE;
      const ceilB = eB + TUNNEL_CLEARANCE;

      const perp = perpDir(a.x, a.y, b.x, b.y);
      const oX = perp.x * halfW, oZ = perp.z * halfW;
      const litA = litAt(runU), litB = litAt(runU + segLen);

      // ── Floor ──
      floorGeos.push(buildQuad(
        { x: a.x - oX, y: eA, z: a.y - oZ }, { x: a.x + oX, y: eA, z: a.y + oZ },
        { x: b.x - oX, y: eB, z: b.y - oZ }, { x: b.x + oX, y: eB, z: b.y + oZ },
        runU, litA, litB,
      ));

      // ── Ceiling ──
      ceilingGeos.push(buildQuad(
        { x: a.x - oX, y: ceilA, z: a.y - oZ }, { x: a.x + oX, y: ceilA, z: a.y + oZ },
        { x: b.x - oX, y: ceilB, z: b.y - oZ }, { x: b.x + oX, y: ceilB, z: b.y + oZ },
        runU, litA, litB,
      ));

      // ── Walls + LED strips + safety stripes on both sides ──
      for (const sign of [-1, 1]) {
        const wx = sign * oX, wz = sign * oZ;

        // Wall: floor → ceiling
        wallGeos.push(buildQuad(
          { x: a.x + wx, y: ceilA, z: a.y + wz }, { x: a.x + wx, y: eA, z: a.y + wz },
          { x: b.x + wx, y: ceilB, z: b.y + wz }, { x: b.x + wx, y: eB, z: b.y + wz },
          runU, litA, litB,
        ));

        // LED strip at ceiling-wall junction (MeshBasicMaterial → self-illuminating)
        const lOff = sign * (halfW - LED_STRIP_W * 0.5);
        const lX = perp.x * lOff, lZ = perp.z * lOff;
        ledGeos.push(buildQuad(
          { x: a.x + lX, y: ceilA,              z: a.y + lZ },
          { x: a.x + lX, y: ceilA - LED_STRIP_H, z: a.y + lZ },
          { x: b.x + lX, y: ceilB,              z: b.y + lZ },
          { x: b.x + lX, y: ceilB - LED_STRIP_H, z: b.y + lZ },
        ));

        // Yellow safety stripe at road edge
        const sOff  = sign * (roadHalf - SAFETY_STRIPE_W * 0.5);
        const sOff2 = sign * (roadHalf + SAFETY_STRIPE_W * 0.5);
        safetyGeos.push(buildQuad(
          { x: a.x + perp.x * sOff,  y: eA + SAFETY_STRIPE_H, z: a.y + perp.z * sOff },
          { x: a.x + perp.x * sOff2, y: eA + SAFETY_STRIPE_H, z: a.y + perp.z * sOff2 },
          { x: b.x + perp.x * sOff,  y: eB + SAFETY_STRIPE_H, z: b.y + perp.z * sOff },
          { x: b.x + perp.x * sOff2, y: eB + SAFETY_STRIPE_H, z: b.y + perp.z * sOff2 },
        ));
      }
      runU += segLen;   // P4-18: advance AFTER the segment is emitted, so its quads share one origin
    }

    // ── Portal at each tunnel mouth ──
    // Only build portal frames at surface-facing portals (elevation near 0).
    // Endpoints deep underground (eM < -0.5) are mid-tunnel junctions whose portal
    // frames would be visible through terrain mouth holes — suppressing them prevents
    // "random gate" artifacts visible from inside the tunnel.
    const buildPortal = (mouthPt, nextPt) => {
      const eM    = mouthPt.elevation != null ? mouthPt.elevation : -6;
      // Skip portal frames at interior junctions (elevation well below surface)
      if (eM < -0.5) return;
      // For surface portals (eM≈0), the original formula gives ceilM=4.5m ABOVE road and
      // portalTop=0 AT road, so frame spans 0→4.5m above ground — a visible concrete arch.
      // For underground portals (eM=-6), frame spans -6→-1.5m, visible only at portal face.
      const ceilM = eM + TUNNEL_CLEARANCE;
      const dx = nextPt.x - mouthPt.x, dz = nextPt.y - mouthPt.y;
      const len = Math.hypot(dx, dz) || 1;
      const dirX = dx / len, dirZ = dz / len;
      const pX = -dirZ, pZ = dirX;
      const totalHalfW = halfW + PORTAL_WING;
      const portalTop  = Math.min(PORTAL_HEIGHT, 0);
      const thick      = PORTAL_THICKNESS;
      const fx = mouthPt.x - dirX * thick * 0.5, fz = mouthPt.y - dirZ * thick * 0.5;
      const bx = mouthPt.x + dirX * thick * 0.5, bz = mouthPt.y + dirZ * thick * 0.5;
      const fPt = (lat, y) => ({ x: fx + pX * lat, y, z: fz + pZ * lat });
      const bPt = (lat, y) => ({ x: bx + pX * lat, y, z: bz + pZ * lat });

      // Left pillar — for surface portals (eM≈0): spans eM=0 (road) to ceilM=4.5m (above road).
      // For underground portals (eM=-6): spans portalTop=0 (terrain) to eM=-6 (tunnel floor).
      // Surface portals use ceilM as top and eM as bottom (arch above ground).
      // Underground portals use portalTop as top and eM as bottom (frame at terrain face).
      const frameTop = eM > -0.5 ? ceilM : portalTop;
      const frameBot = eM;
      portalGeos.push(buildQuad(fPt(-totalHalfW, frameTop), fPt(-totalHalfW, frameBot), fPt(-halfW, frameTop), fPt(-halfW, frameBot)));
      portalGeos.push(buildQuad(bPt(-halfW, frameTop), bPt(-halfW, frameBot), bPt(-totalHalfW, frameTop), bPt(-totalHalfW, frameBot)));
      portalGeos.push(buildQuad(bPt(-totalHalfW, frameTop), bPt(-totalHalfW, frameBot), fPt(-totalHalfW, frameTop), fPt(-totalHalfW, frameBot)));
      // Right pillar
      portalGeos.push(buildQuad(fPt(halfW, frameTop), fPt(halfW, frameBot), fPt(totalHalfW, frameTop), fPt(totalHalfW, frameBot)));
      portalGeos.push(buildQuad(bPt(totalHalfW, frameTop), bPt(totalHalfW, frameBot), bPt(halfW, frameTop), bPt(halfW, frameBot)));
      portalGeos.push(buildQuad(fPt(totalHalfW, frameTop), fPt(totalHalfW, frameBot), bPt(totalHalfW, frameTop), bPt(totalHalfW, frameBot)));
      // Top beam at frameTop, bottom face at frameBot across the opening
      portalGeos.push(buildQuad(fPt(-totalHalfW, frameTop), fPt(-halfW, frameTop), fPt(totalHalfW, frameTop), fPt(halfW, frameTop)));
      portalGeos.push(buildQuad(bPt(totalHalfW, frameTop), bPt(halfW, frameTop), bPt(-totalHalfW, frameTop), bPt(-halfW, frameTop)));
      portalGeos.push(buildQuad(fPt(-totalHalfW, frameBot), fPt(totalHalfW, frameBot), bPt(-totalHalfW, frameBot), bPt(totalHalfW, frameBot)));

      // Sign board above tunnel opening
      const signHalfW = Math.min(halfW * 0.7, SIGN_HEIGHT * 2.5);
      const signTop   = ceilM + 0.1, signBot = signTop - SIGN_HEIGHT;
      const nudge = 0.02;
      const sp = (lat, y) => ({ x: fx + pX * lat - dirX * nudge, y, z: fz + pZ * lat - dirZ * nudge });
      const sPos = new Float32Array([
        sp(signHalfW, signTop).x,  sp(signHalfW, signTop).y,  sp(signHalfW, signTop).z,
        sp(signHalfW, signBot).x,  sp(signHalfW, signBot).y,  sp(signHalfW, signBot).z,
        sp(-signHalfW, signTop).x, sp(-signHalfW, signTop).y, sp(-signHalfW, signTop).z,
        sp(-signHalfW, signTop).x, sp(-signHalfW, signTop).y, sp(-signHalfW, signTop).z,
        sp(signHalfW, signBot).x,  sp(signHalfW, signBot).y,  sp(signHalfW, signBot).z,
        sp(-signHalfW, signBot).x, sp(-signHalfW, signBot).y, sp(-signHalfW, signBot).z,
      ]);
      const sUV = new Float32Array([0,1, 0,0, 1,1, 1,1, 0,0, 1,0]);
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
      sg.setAttribute('uv', new THREE.Float32BufferAttribute(sUV, 2));
      sg.computeVertexNormals();
      signGeosMap.get(roadName).push(sg);
    };

    buildPortal(pts[0], pts[1]);
    buildPortal(pts[pts.length - 1], pts[pts.length - 2]);
  }

  mergeAndAdd(floorGeos,   getMat.floor(),   'tunnelFloor');
  mergeAndAdd(ceilingGeos, getMat.ceiling(), 'tunnelCeiling');
  mergeAndAdd(wallGeos,    getMat.wall(),    'tunnelWall');
  mergeAndAdd(ledGeos,     getMat.led(),     'tunnelLED');
  mergeAndAdd(safetyGeos,  getMat.safety(),  'tunnelSafety');
  mergeAndAdd(portalGeos,  getMat.portal(),  'tunnelPortal');

  // Signs: one mesh per unique road name
  for (const [rn, geos] of signGeosMap) {
    if (!geos.length) continue;
    const merged = mergeGeometries(geos, false);
    if (merged) {
      const mesh = new THREE.Mesh(merged, getSignMat(rn));
      mesh.name = 'tunnelSign';
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    geos.forEach(g => g.dispose());
  }

  return group;
}

/**
 * Simple-tunnel mode: render ONLY the descending road deck (floor) — no ceiling, walls,
 * LED, safety stripe, portal frames or signs. The car drives down the carved terrain
 * opening onto this deck, then under the (uncarved) terrain roof for the deep section.
 * Mirrors buildTunnelMeshes' floor quads exactly so it lines up with the physics ramp.
 */
export function buildTunnelFloor(tunnelRoads, getGroundY) {
  const group = new THREE.Group();
  if (!tunnelRoads?.length) return group;
  const floorGeos = [];
  const LIFT = 0.05; // sit just above the deck plane (matches ramp body botY offset)

  for (const road of tunnelRoads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    // Daylighted corridors (layer < 0) get the full painted road ribbon from roadRenderer
    // (same condition as its tunnel-paint guard) — there this dark Lambert deck only showed
    // as a 1m dark band proud of the road on each side. Covered tunnels still need the deck.
    if (road.layer != null && road.layer < 0) continue;
    const halfW = kerbOffset(road) + WALL_EXTRA_WIDTH;

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const eA = _normTunnelElev(a.elevation);
      const eB = _normTunnelElev(b.elevation);
      if (eA == null || eB == null) continue;
      const gA = _gy(getGroundY, a.x, a.y), gB = _gy(getGroundY, b.x, b.y);
      // Render the deck wherever the road is below local terrain (the dive + the covered run).
      // Skip only segments fully at/above grade — those are surface approach roads' job.
      if (eA >= gA - 0.05 && eB >= gB - 0.05) continue;

      const perp = perpDir(a.x, a.y, b.x, b.y);
      const oX = perp.x * halfW, oZ = perp.z * halfW;
      floorGeos.push(buildQuad(
        { x: a.x - oX, y: eA + LIFT, z: a.y - oZ }, { x: a.x + oX, y: eA + LIFT, z: a.y + oZ },
        { x: b.x - oX, y: eB + LIFT, z: b.y - oZ }, { x: b.x + oX, y: eB + LIFT, z: b.y + oZ },
      ));
    }
  }

  if (floorGeos.length) {
    const merged = mergeGeometries(floorGeos, false);
    if (merged) {
      const mesh = new THREE.Mesh(merged, getMat.floor());
      mesh.name = 'tunnelFloorSimple';
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    floorGeos.forEach(g => g.dispose());
  }
  return group;
}

// ── Portal approach geometry (game-design approach) ──────────────────────────
// Instead of carving the DEM terrain grid (which fights surface road protection,
// grid resolution, and multi-segment tunnels), we ADD concrete geometry that
// covers and replaces terrain at each portal mouth.
//
// For each tunnel endpoint:
//   1. Sloped ramp floor: dark asphalt quad from Y=0 (30m out) down to tunnel depth
//   2. Left cut wall: triangular concrete face (terrain-height at portal, tapering to 0)
//   3. Right cut wall: same
//
// This is the GTA V / Forza pattern — static mesh, zero terrain mutation.

const APPROACH_RAMP_LEN = 30; // metres of approach visible before portal
const APPROACH_Y_BIAS   = 0.06; // above terrain so ramp surface wins z-fight

let _rampMat = null, _cutWallMat = null;
function _getRampMat() {
  if (_rampMat) return _rampMat;
  _rampMat = new THREE.MeshLambertMaterial({ color: FLOOR_COLOR, side: THREE.FrontSide });
  _rampMat.userData.sharedMaterial = true;
  return _rampMat;
}
function _getCutWallMat() {
  if (_cutWallMat) return _cutWallMat;
  // P4-18: the trench CUT FACE is exposed rock, not concrete — it is the earth the trench was cut
  // through, and the spawn sits at a trench portal so it is in frame on the first drive. Span is
  // 3.0 m, MEASURED from the plate's own grain rather than taken from the art-bible table: at the
  // table's 8 m its pebbles would be 14 cm, and a conglomerate's clasts run 2-6 cm. See
  // tools/build-trench-rock.py and terrain/terrain_textures.json.
  const ROCK_SPAN_M = 3.0;
  const rockTex = (url, srgb) => {
    const t = getKTX2TextureSync(url, { srgb, tiling: true, aniso: 8 });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / ROCK_SPAN_M, 1 / ROCK_SPAN_M);   // UVs are in METRES — see buildQuad
    return t;
  };
  _cutWallMat = new THREE.MeshLambertMaterial({
    color: 0xffffff, side: THREE.DoubleSide,
    map: rockTex('/textures/terrain/rock_face_albedo.ktx2', true),
    normalMap: rockTex('/textures/terrain/rock_face_normal.ktx2', false),
  });
  _cutWallMat.userData.sharedMaterial = true;
  return _cutWallMat;
}

function _buildApproachAtPortal(portalPt, nextPt, roadHalfW, geomRamp) {
  // Flat masking plane at road-surface level.
  // Covers terrain in the 30m approach zone so the road is always visible.
  // No slope — Barcelona coastal tunnels enter at grade (descent is inside the tunnel).
  // The portal frame handles the visual "cut" appearance at the portal face.
  const sY = APPROACH_Y_BIAS; // just above terrain so it wins z-fight

  const dx = portalPt.x - nextPt.x, dz = portalPt.y - nextPt.y;
  const len = Math.hypot(dx, dz) || 1;
  const outX = dx / len, outZ = dz / len;
  const perpX = -outZ, perpZ = outX;

  const L = APPROACH_RAMP_LEN, hw = roadHalfW;

  // Flat quad: surface end → portal face, all at Y=sY
  const SL = { x: portalPt.x + outX*L + perpX*hw, y: sY, z: portalPt.y + outZ*L + perpZ*hw };
  const SR = { x: portalPt.x + outX*L - perpX*hw, y: sY, z: portalPt.y + outZ*L - perpZ*hw };
  const PL = { x: portalPt.x + perpX*hw,           y: sY, z: portalPt.y + perpZ*hw };
  const PR = { x: portalPt.x - perpX*hw,           y: sY, z: portalPt.y - perpZ*hw };

  geomRamp.push(buildQuad(SL, SR, PL, PR));
}

/**
 * Build static approach geometry at each tunnel portal mouth.
 * Replaces terrain carving for portals — a sloped ramp + cut walls placed directly,
 * covering terrain rather than modifying it. Works for all tunnel types regardless
 * of whether an OSM approach road exists.
 */
/**
 * Rectangular box-cut walls at each tunnel portal.
 * Terrain stays flat. At the road edge, a vertical concrete wall drops straight down
 * to road depth, extending outward 20m from the portal face.
 * Like a rectangular trench cut into the ground for the road.
 *
 * Two walls per portal (left + right), rectangle shape:
 *   TOP:    terrain level (Y=0)
 *   BOTTOM: tunnel road depth
 *   LENGTH: 20m outward from portal face
 *   WIDTH:  zero (flat plane, DoubleSide material)
 */
const TRENCH_LEN   = 90;  // metres of trench — 80 (terrain cut) + ~9.5m (capsule halfW cap) to align edges
const WALL_THICK   = 0.6; // wall thickness (visible as a proper slab, not a thin plane)

export function buildPortalApproaches(tunnelRoads, getGroundY) {
  if (!CONFIG.ENABLE_TUNNELS || !tunnelRoads?.length) return null;

  const wallGeoms  = [];  // side concrete walls
  const floorGeoms = [];  // road asphalt floor

  for (const road of tunnelRoads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const roadHalfW = kerbOffset(road);

    const buildTrench = (portalPt, nextPt) => {
      const dx = portalPt.x - nextPt.x, dz = portalPt.y - nextPt.y;
      const len = Math.hypot(dx, dz) || 1;
      const outX = dx / len, outZ = dz / len;
      const perpX = -outZ, perpZ = outX;
      const farX = portalPt.x + outX * TRENCH_LEN;
      const farZ = portalPt.y + outZ * TRENCH_LEN;

      // Anchor the trench to LOCAL terrain (was constant 0.15 / 0.05 / -5.95 = flat-world Y≈0).
      const gP = _gy(getGroundY, portalPt.x, portalPt.y);   // terrain at portal mouth
      const gF = _gy(getGroundY, farX, farZ);               // terrain at far (ramp top) end
      const tPortal = gP + 0.15;   // wall top at portal (just above terrain)
      const tFar    = gF + 0.15;   // wall top at far end
      const surfY   = gF + 0.05;   // ramp surface at far end (≈ terrain)
      const botY    = gP - 5.95;   // tunnel depth (-6m) below the portal's terrain

      const liI = roadHalfW, liO = roadHalfW + WALL_THICK;  // left inner/outer
      const riI = roadHalfW, riO = roadHalfW + WALL_THICK;  // right inner/outer

      // ── Left wall: tapers from full height at portal face to zero at far end ──
      wallGeoms.push(buildQuad(   // inner face
        { x: portalPt.x + perpX*liI, y: tPortal, z: portalPt.y + perpZ*liI },
        { x: farX       + perpX*liI, y: tFar, z: farZ       + perpZ*liI },
        { x: portalPt.x + perpX*liI, y: botY, z: portalPt.y + perpZ*liI },
        { x: farX       + perpX*liI, y: surfY, z: farZ      + perpZ*liI },
      ));
      wallGeoms.push(buildQuad(   // outer face
        { x: farX       + perpX*liO, y: tFar,  z: farZ       + perpZ*liO },
        { x: portalPt.x + perpX*liO, y: tPortal,  z: portalPt.y + perpZ*liO },
        { x: farX       + perpX*liO, y: surfY, z: farZ       + perpZ*liO },
        { x: portalPt.x + perpX*liO, y: botY,  z: portalPt.y + perpZ*liO },
      ));
      wallGeoms.push(buildQuad(   // top cap
        { x: portalPt.x + perpX*liI, y: tPortal, z: portalPt.y + perpZ*liI },
        { x: portalPt.x + perpX*liO, y: tPortal, z: portalPt.y + perpZ*liO },
        { x: farX       + perpX*liI, y: tFar, z: farZ       + perpZ*liI },
        { x: farX       + perpX*liO, y: tFar, z: farZ       + perpZ*liO },
      ));

      // ── Right wall: tapers from full height at portal face to zero at far end ──
      wallGeoms.push(buildQuad(   // inner face
        { x: farX       - perpX*riI, y: tFar,  z: farZ       - perpZ*riI },
        { x: portalPt.x - perpX*riI, y: tPortal,  z: portalPt.y - perpZ*riI },
        { x: farX       - perpX*riI, y: surfY, z: farZ       - perpZ*riI },
        { x: portalPt.x - perpX*riI, y: botY,  z: portalPt.y - perpZ*riI },
      ));
      wallGeoms.push(buildQuad(   // outer face
        { x: portalPt.x - perpX*riO, y: tPortal,  z: portalPt.y - perpZ*riO },
        { x: farX       - perpX*riO, y: tFar,  z: farZ       - perpZ*riO },
        { x: portalPt.x - perpX*riO, y: botY,  z: portalPt.y - perpZ*riO },
        { x: farX       - perpX*riO, y: surfY, z: farZ       - perpZ*riO },
      ));
      wallGeoms.push(buildQuad(   // top cap
        { x: portalPt.x - perpX*riO, y: tPortal, z: portalPt.y - perpZ*riO },
        { x: portalPt.x - perpX*riI, y: tPortal, z: portalPt.y - perpZ*riI },
        { x: farX       - perpX*riO, y: tFar, z: farZ       - perpZ*riO },
        { x: farX       - perpX*riI, y: tFar, z: farZ       - perpZ*riI },
      ));

      // ── Sloped ramp floor: surface level at far end → tunnel depth at portal face ──
      floorGeoms.push(buildQuad(
        { x: portalPt.x + perpX*roadHalfW, y: botY,  z: portalPt.y + perpZ*roadHalfW },
        { x: portalPt.x - perpX*roadHalfW, y: botY,  z: portalPt.y - perpZ*roadHalfW },
        { x: farX       + perpX*roadHalfW, y: surfY, z: farZ       + perpZ*roadHalfW },
        { x: farX       - perpX*roadHalfW, y: surfY, z: farZ       - perpZ*roadHalfW },
      ));
    };

    buildTrench(pts[0], pts[1]);
    buildTrench(pts[pts.length - 1], pts[pts.length - 2]);
  }

  if (!wallGeoms.length && !floorGeoms.length) return null;

  const group = new THREE.Group();
  const addMerged = (geos, mat, name) => {
    if (!geos.length) return;
    const m = mergeGeometries(geos, false);
    geos.forEach(g => g.dispose());
    if (!m) return;
    const mesh = new THREE.Mesh(m, mat);
    mesh.name = name; mesh.frustumCulled = false;
    mesh.userData.sharedMaterial = true;
    group.add(mesh);
  };
  addMerged(wallGeoms,  getMat.retwall(), 'trenchWalls');
  addMerged(floorGeoms, getMat.floor(),   'trenchFloor');
  return group.children.length ? group : null;
}

// ── Approach canopy — DISABLED for Barcelona ──────────────────────────────────
// Barcelona uses retaining walls (buildRetainingWalls), not arched canopy sheds.
// Function kept for interface compatibility; always returns empty group.

export function buildApproachCanopy(_approachRoads) {
  return new THREE.Group(); // no-op
}

// ── Retaining walls for urban tunnel approaches (Task 1) ──────────────────────
// Vertical concrete walls on each side of the descent ramp.
// Used for all approach roads that are NOT genuine hillside approaches
// (i.e., not motorway/trunk with >60m horizontal approach span).

/**
 * Vertical concrete retaining walls along tunnel approach ramps.
 * Runs on each side of the road for every segment where road elevation < -0.2m.
 * Wall goes from road edge vertically up to terrain level (Y=0).
 * This closes the open sides of the approach ramp — no terrain gap visible.
 *
 * Called for both tunnelRoads AND approachRoads in tileManager.
 */
export function buildRetainingWalls(wallApproachRoads, getGroundY) {
  if (!CONFIG.ENABLE_RETAINING_WALLS || !wallApproachRoads?.length) return null;
  const geoms = [];

  for (const road of wallApproachRoads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const half = kerbOffset(road);

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      // Normalize road elevation (absolute DEM → spawn frame) for the wall bottom.
      const eA = _normTunnelElev(a.elevation) ?? 0, eB = _normTunnelElev(b.elevation) ?? 0;
      // Terrain surface at each end (was constant Y=0.05 → floated/buried on slopes).
      const gA = _gy(getGroundY, a.x, a.y), gB = _gy(getGroundY, b.x, b.y);
      // Build walls wherever the road dips below LOCAL terrain (terrain-relative, was vs absolute 0).
      if (eA >= gA - 0.05 && eB >= gB - 0.05) continue;

      const perp = perpDir(a.x, a.y, b.x, b.y);

      for (const sign of [-1, 1]) {
        const ax = a.x + sign * perp.x * half, az = a.y + sign * perp.z * half;
        const bx = b.x + sign * perp.x * half, bz = b.y + sign * perp.z * half;
        // Wall: road edge bottom (normalized elev) → terrain top (ground Y at that end)
        geoms.push(buildQuad(
          { x: ax, y: gA + 0.05, z: az }, { x: ax, y: eA, z: az },
          { x: bx, y: gB + 0.05, z: bz }, { x: bx, y: eB, z: bz },
        ));
      }
    }
  }

  if (!geoms.length) return null;
  const merged = mergeGeometries(geoms, false);
  geoms.forEach(g => g.dispose());
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, getMat.retwall());
  mesh.frustumCulled = false;
  mesh.userData = { type: 'retainingWall', sharedMaterial: true };
  return mesh;
}

// ── Option-L open-trench retaining walls ──────────────────────────────────────
// buildRetainingWalls (above) is for ramp approaches where the road dips below
// UNTOUCHED terrain — it measures the drop at the centerline. In an Option-L open
// trench the grid is carved down TO the road floor, so the centerline ground ≈ deck
// and that function would build nothing. Here we instead probe the NATURAL terrain a
// few metres BEYOND the carved cut (the cut cells read low, natural reads high → take
// the max), then stand a clean vertical concrete wall at the road edge from the deck
// up to that bank-top height. This hides the stepped, grid-quantized earth bank behind
// a flat face — the realistic dressing for trenches like Ronda de Dalt, no re-bake.
const TRENCH_WALL_PROBES = [6, 10, 14, 18]; // m beyond the road EDGE to find the natural bank top
const TRENCH_WALL_MIN_RISE = 0.4;           // m — skip near-at-grade segments (nothing to retain)
const TRENCH_WALL_MAX_RISE = 7;             // m — CAP the wall height. The probed bank top on a steep
                                            // hillside cut is the hilltop (20 m+), which made the wall a
                                            // giant flat slab. Real retaining walls are bounded; above
                                            // the cap the natural slope shows (correct for a hill cut,
                                            // and the deep-trench upper bank is far above the road anyway).
const MEDIAN_LOOK = 22;                      // m — if another carriageway is within this on a side,
                                            // that side faces the MEDIAN → skip its wall (no overlap).

/** Flat seg list of all trench roads: [ax,az,bx,bz,half, roadRef, ...] for median proximity tests. */
function buildTrenchSegList(roads) {
  const segs = [];
  for (const road of roads || []) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const hw = kerbOffset(road);
    for (let i = 0; i < pts.length - 1; i++) segs.push(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, hw, road);
  }
  return segs;
}
/** True if (x,z) lies within MEDIAN_LOOK of ANOTHER trench road's carriageway (not selfRoad). */
function facesMedian(x, z, selfRoad, segs) {
  for (let k = 0; k < segs.length; k += 6) {
    if (segs[k + 5] === selfRoad) continue;
    const ax = segs[k], az = segs[k + 1], bx = segs[k + 2], bz = segs[k + 3], hw = segs[k + 4];
    const dx = bx - ax, dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    if (lenSq < 1e-9) continue;
    let t = ((x - ax) * dx + (z - az) * dz) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, pz = az + t * dz;
    if (Math.hypot(x - px, z - pz) < hw + MEDIAN_LOOK) return true;
  }
  return false;
}

// SMOOTH, MEDIAN-AWARE trench walls. Smooth because it follows the road edge (not the grid, which
// gave the sawtooth); median-aware because a side facing a parallel carriageway is skipped, so the
// inner walls that used to overlap into a grey mass are never built. The wall stands a clean vertical
// concrete face at the road edge from deck up to the natural bank, IN FRONT of the jagged carved
// earth — occluding the sawtooth for a driver in the trench.
export function buildTrenchRetainingWalls(trenchRoads, getGroundY) {
  if (!CONFIG.ENABLE_RETAINING_WALLS || !trenchRoads?.length || typeof getGroundY !== 'function') return null;
  const segs = buildTrenchSegList(trenchRoads);
  const geoms = [];
  for (const road of trenchRoads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const half = kerbOffset(road);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const eA = _normTunnelElev(a.elevation) ?? 0;
      const eB = _normTunnelElev(b.elevation) ?? 0;
      const perp = perpDir(a.x, a.y, b.x, b.y);
      const mx = (a.x + b.x) / 2, mz = (a.y + b.y) / 2;
      for (const sign of [-1, 1]) {
        // Skip the side that faces the median (a parallel carriageway is there → no outer bank).
        if (facesMedian(mx + sign * perp.x * (half + 2), mz + sign * perp.z * (half + 2), road, segs)) continue;
        // Sustained-bank check: a REAL outer bank stays high further out, but a thin median/gore
        // ridge (the sliver between two diverging carriageways) rises to a crest then drops back to
        // the other roadway. Probe far out — if the ground there is well below the near bank, this is
        // a sliver, not a bank to retain → skip (kills the thin triangular fins in the median/gore).
        const nearG = Math.max(
          getGroundY(mx + sign * perp.x * (half + 8), mz + sign * perp.z * (half + 8)),
          eA, eB);
        const farG = getGroundY(mx + sign * perp.x * (half + 30), mz + sign * perp.z * (half + 30));
        if (Number.isFinite(farG) && Number.isFinite(nearG) && farG < nearG - 3) continue;
        // Bank top = max natural terrain over outward probes (carved cells read at the floor).
        let topA = eA, topB = eB;
        for (const r of TRENCH_WALL_PROBES) {
          const gA = getGroundY(a.x + sign * perp.x * (half + r), a.y + sign * perp.z * (half + r));
          const gB = getGroundY(b.x + sign * perp.x * (half + r), b.y + sign * perp.z * (half + r));
          if (Number.isFinite(gA) && gA > topA) topA = gA;
          if (Number.isFinite(gB) && gB > topB) topB = gB;
        }
        if (topA - eA < TRENCH_WALL_MIN_RISE && topB - eB < TRENCH_WALL_MIN_RISE) continue;
        // Cap the wall height to a realistic retaining-wall scale (no giant hillside slabs),
        // with a small +0.4 m so the wall top is the silhouette, not poking earth.
        topA = Math.min(topA + 0.4, eA + TRENCH_WALL_MAX_RISE);
        topB = Math.min(topB + 0.4, eB + TRENCH_WALL_MAX_RISE);
        const ax = a.x + sign * perp.x * half, az = a.y + sign * perp.z * half;
        const bx = b.x + sign * perp.x * half, bz = b.y + sign * perp.z * half;
        // Vertical wall: road-edge deck level (eA/eB) → bank top (topA/topB).
        geoms.push(buildQuad(
          { x: ax, y: topA, z: az }, { x: ax, y: eA, z: az },
          { x: bx, y: topB, z: bz }, { x: bx, y: eB, z: bz },
        ));
      }
    }
  }
  if (!geoms.length) return null;
  const merged = mergeGeometries(geoms, false);
  geoms.forEach(g => g.dispose());
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, getMat.retwall());
  mesh.frustumCulled = false;
  mesh.userData = { type: 'trenchRetainingWall', sharedMaterial: true };
  return mesh;
}

// ── Grid cliff dressing (the polished trench-wall fix) ────────────────────────
// The previous per-road retaining walls built a wall on BOTH sides of EVERY tunnel road,
// so on stacked carriageways (Ronda de Dalt) the inner walls overlapped into a grey mess,
// and they never matched the jagged carved edge. This pass instead dresses the carved
// TERRAIN GRID itself: wherever two adjacent grid cells differ in height by more than
// CLIFF_MIN_STEP, it stands a vertical concrete face on that grid edge. Properties that
// make it the right fix:
//   • Median-aware by construction — a flat median between carriageways has no step → no
//     wall; only genuine cliffs (trench perimeter + carve faces) get dressed.
//   • Occludes the sawtooth — the jagged earth step IS replaced by a clean vertical panel
//     sitting exactly on the grid edge (same source the heightfield/getGroundY use, so it's
//     co-framed with physics and the rendered terrain).
//   • Caps the exposed cliff under crossing streets so the trench reads as a walled cut.
// Visual-only, under worldGroup (auto X-mirrored like the terrain mesh — uses latLonToWorld
// world coords, no manual negation). No physics, no re-bake.
const CLIFF_MIN_STEP = 2.0;   // m — only dress steps taller than this (skip gentle slopes)
const CLIFF_MAX_STEP = 40;    // m — guard against absurd spikes (bad data) producing giant panels

export function buildTrenchCliffWalls(elevation) {
  if (!CONFIG.ENABLE_RETAINING_WALLS) return null;
  if (!elevation || !Array.isArray(elevation.elevations)) return null;
  const { south, west, north, east, gridRows: rows, gridCols: cols, elevations } = elevation;
  if (!(rows > 1) || !(cols > 1)) return null;
  const offset = getWorldElevationOffset() ?? 0;
  const vertExag = CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION) ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;

  // World mapping identical to buildTerrainMesh: x linear in lon, z per-row (nonlinear in lat).
  const { x: xWest } = latLonToWorld(south, west);
  const { x: xEast } = latLonToWorld(south, east);
  const xStep = (xEast - xWest) / (cols - 1);
  const zPerRow = new Float64Array(rows);
  for (let r = 0; r < rows; r++) {
    const lat = south + (north - south) * (r / (rows - 1));
    zPerRow[r] = latLonToWorld(lat, west).z;
  }
  const yAt = (r, c) => {
    const v = elevations[r * cols + c];
    const raw = (v != null && Number.isFinite(v)) ? v : 0;
    return (raw - offset) * vertExag;
  };

  const geoms = [];
  for (let r = 0; r < rows; r++) {
    const z = zPerRow[r];
    for (let c = 0; c < cols; c++) {
      const y = yAt(r, c);
      const x = xWest + c * xStep;
      // East–west neighbour (same row): vertical panel in the z-plane spanning x..x2.
      if (c + 1 < cols) {
        const y2 = yAt(r, c + 1);
        const d = Math.abs(y2 - y);
        if (d >= CLIFF_MIN_STEP && d <= CLIFF_MAX_STEP) {
          const x2 = xWest + (c + 1) * xStep;
          const lo = Math.min(y, y2), hi = Math.max(y, y2);
          geoms.push(buildQuad(
            { x, y: hi, z }, { x, y: lo, z },
            { x: x2, y: hi, z }, { x: x2, y: lo, z },
          ));
        }
      }
      // North–south neighbour (same col): vertical panel in the x-plane spanning z..z2.
      if (r + 1 < rows) {
        const y2 = yAt(r + 1, c);
        const d = Math.abs(y2 - y);
        if (d >= CLIFF_MIN_STEP && d <= CLIFF_MAX_STEP) {
          const z2 = zPerRow[r + 1];
          const lo = Math.min(y, y2), hi = Math.max(y, y2);
          geoms.push(buildQuad(
            { x, y: hi, z }, { x, y: lo, z },
            { x, y: hi, z: z2 }, { x, y: lo, z: z2 },
          ));
        }
      }
    }
  }
  if (!geoms.length) return null;
  const merged = mergeGeometries(geoms, false);
  geoms.forEach(g => g.dispose());
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, getMat.retwall());
  mesh.frustumCulled = false;
  mesh.userData = { type: 'trenchCliffWall', sharedMaterial: true };
  return mesh;
}

// ── Option-L trench portal headwalls ──────────────────────────────────────────
// In the daylighted (Option-L) design the corridor is an open cut end-to-end, so there
// is no covered tunnel mouth. To still give the user a DEFINED entrance (not roads just
// fanning into a hole), we frame the spot where the road first drops meaningfully below
// grade with a concrete headwall + portal lintel spanning the carriageway — the cut-and-
// cover portal look. Terrain-relative (depth measured vs the probed natural bank, no
// absolute-Y constant — G-47 clean), gated with the trench walls under ENABLE_RETAINING_WALLS.
const PORTAL_ENTER_DEPTH = 3.0;   // m the road must sit below the natural bank to warrant a portal
const PORTAL_CLEARANCE   = 5.2;   // m lintel underside above the deck (legal underpass headroom)
const PORTAL_LINTEL_H    = 1.6;   // m lintel beam height
const PORTAL_POST_W      = 1.2;   // m side-post width
const PORTAL_OVERHANG    = 1.0;   // m posts sit this far outside the road edge

/** Probe the natural bank top beside a road point (max over both sides, outward probes). */
function _bankTopBeside(x, z, perp, half, getGroundY) {
  let top = -Infinity;
  for (const sign of [-1, 1]) {
    for (const r of TRENCH_WALL_PROBES) {
      const g = getGroundY(x + sign * perp.x * (half + r), z + sign * perp.z * (half + r));
      if (Number.isFinite(g) && g > top) top = g;
    }
  }
  return top;
}

export function buildTrenchPortals(trenchRoads, getGroundY) {
  if (!CONFIG.ENABLE_RETAINING_WALLS || !trenchRoads?.length || typeof getGroundY !== 'function') return null;
  const geoms = [];
  for (const road of trenchRoads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const half = kerbOffset(road);
    // Per-point depth below the natural bank.
    const depth = pts.map((p, i) => {
      const j = Math.min(i + 1, pts.length - 1);
      const perp = perpDir(p.x, p.y, pts[j].x, pts[j].y);
      const deck = _normTunnelElev(p.elevation) ?? 0;
      const bank = _bankTopBeside(p.x, p.y, perp, half, getGroundY);
      return Number.isFinite(bank) ? bank - deck : 0;
    });
    // Find transitions across PORTAL_ENTER_DEPTH (shallow→deep = enter, deep→shallow = exit).
    // Place at most one portal per transition; cap at the two outermost so we frame the mouths,
    // not every wobble.
    const marks = [];
    for (let i = 1; i < depth.length; i++) {
      const crossedIn  = depth[i - 1] < PORTAL_ENTER_DEPTH && depth[i] >= PORTAL_ENTER_DEPTH;
      const crossedOut = depth[i - 1] >= PORTAL_ENTER_DEPTH && depth[i] < PORTAL_ENTER_DEPTH;
      if (crossedIn || crossedOut) marks.push(i);
    }
    if (!marks.length) continue;
    const chosen = marks.length <= 2 ? marks : [marks[0], marks[marks.length - 1]];
    for (const i of chosen) {
      const p = pts[i];
      const q = pts[Math.min(i + 1, pts.length - 1)];
      const perp = perpDir(p.x, p.y, q.x, q.y);
      const deck = _normTunnelElev(p.elevation) ?? 0;
      const lintelBot = deck + PORTAL_CLEARANCE;
      const lintelTop = lintelBot + PORTAL_LINTEL_H;
      const edge = half + PORTAL_OVERHANG;
      // Two side posts (deck → lintel top) as boxes spanning PORTAL_POST_W across the road dir.
      for (const sign of [-1, 1]) {
        const cx = p.x + sign * perp.x * edge;
        const cz = p.y + sign * perp.z * edge;
        const post = new THREE.BoxGeometry(PORTAL_POST_W, lintelTop - deck, PORTAL_POST_W);
        post.translate(cx, (deck + lintelTop) / 2, cz);
        geoms.push(ensureVertexColor(post));
      }
      // Lintel beam across the opening (full width + posts).
      const span = 2 * edge + PORTAL_POST_W;
      const lintel = new THREE.BoxGeometry(span, PORTAL_LINTEL_H, PORTAL_POST_W);
      // Orient the lintel along the perpendicular (road-cross) direction.
      const ang = Math.atan2(perp.z, perp.x);
      lintel.rotateY(-ang);
      lintel.translate(p.x, (lintelBot + lintelTop) / 2, p.y);
      geoms.push(ensureVertexColor(lintel));
    }
  }
  if (!geoms.length) return null;
  const merged = mergeGeometries(geoms, false);
  geoms.forEach(g => g.dispose());
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, getMat.retwall());
  mesh.frustumCulled = false;
  mesh.userData = { type: 'trenchPortal', sharedMaterial: true };
  return mesh;
}

// ── Pedestrian tunnel portals (Task 2) ────────────────────────────────────────
// Small rectangular frame at each end of pedestrian/footway tunnel ways.
// Gives a visual hint of "underground passage here" without full interior geometry.

const PED_PORTAL_W  = 3.0;  // portal opening width (m)
const PED_PORTAL_H  = 2.8;  // portal opening height (m)
const PED_PORTAL_T  = 0.4;  // portal frame thickness (m)
const PED_PORTAL_DEPTH = 0.5; // dark inner face depth (m)

export function buildPedestrianPortals(pedestrianPortalRoads, getGroundY) {
  if (!CONFIG.ENABLE_PEDESTRIAN_PORTALS || !pedestrianPortalRoads?.length) return null;
  const geoms = [];

  const buildFrame = (mouthPt, nextPt) => {
    const dx = nextPt.x - mouthPt.x, dz = nextPt.y - mouthPt.y;
    const len = Math.hypot(dx, dz) || 1;
    const dirX = dx / len, dirZ = dz / len;
    const pX = -dirZ, pZ = dirX;
    const mx = mouthPt.x, mz = mouthPt.y;
    // Gate sits on the terrain surface at the mouth (was raw absolute elevation → floated +offset).
    const baseY = _gy(getGroundY, mx, mz);
    const hw = PED_PORTAL_W / 2, fh = PED_PORTAL_H, ft = PED_PORTAL_T;

    const p = (lat, y, depth = 0) => ({
      x: mx + pX * lat + dirX * depth,
      y,
      z: mz + pZ * lat + dirZ * depth,
    });

    // Left pillar (front face)
    geoms.push(buildQuad(p(-hw - ft, baseY + fh), p(-hw - ft, baseY), p(-hw, baseY + fh), p(-hw, baseY)));
    // Right pillar (front face)
    geoms.push(buildQuad(p(hw, baseY + fh), p(hw, baseY), p(hw + ft, baseY + fh), p(hw + ft, baseY)));
    // Top beam (front face)
    geoms.push(buildQuad(p(-hw - ft, baseY + fh + ft), p(-hw - ft, baseY + fh), p(hw + ft, baseY + fh + ft), p(hw + ft, baseY + fh)));
    // Dark inner face (back of opening — suggests depth)
    const darkY = baseY + fh;
    geoms.push(buildQuad(
      p(-hw, baseY, PED_PORTAL_DEPTH), p(hw, baseY, PED_PORTAL_DEPTH),
      p(-hw, darkY, PED_PORTAL_DEPTH), p(hw, darkY, PED_PORTAL_DEPTH),
    ));
  };

  for (const road of pedestrianPortalRoads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    buildFrame(pts[0], pts[1]);
    buildFrame(pts[pts.length - 1], pts[pts.length - 2]);
  }

  if (!geoms.length) return null;
  const merged = mergeGeometries(geoms, false);
  geoms.forEach(g => g.dispose());
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, getMat.pedportal());
  mesh.frustumCulled = false;
  mesh.userData = { type: 'pedestrianPortal', sharedMaterial: true };
  return mesh;
}

/** Exported for tests only — see frontend/test/tunnelLining.test.js (v3 P4-18). */
export const __test__ = { portalFalloff, PORTAL_LIT_M, DEEP_LIT };
