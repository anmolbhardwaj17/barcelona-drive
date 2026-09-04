/**
 * Pedestrians — real low-poly people with a WALK-CYCLE FLIPBOOK, instanced (light crowd).
 *
 * Each character is baked into N static walk-frames + one idle pose (carModels.loadPeopleWalkTemplates).
 * There's one InstancedMesh per (character × frame) and per (character, idle); each frame we route every
 * pedestrian into the InstancedMesh matching its current walk-cycle frame → legs actually move, while the
 * whole crowd stays instanced/cheap.
 *
 * ── P-1 (2026-09-04): people walked ONE ROAD SEGMENT and ping-ponged on it ────────────────────────
 * The old assignment made a candidate out of every *sub-segment* of every road (4 m minimum) and put a
 * pedestrian on it with `t ∈ [0,1]`, flipping `dir` at each end. On Eixample geometry a sub-segment is
 * commonly 10–30 m, so the crowd was a field of people pacing back and forth over three car lengths and
 * snapping through 180° at each end with no turn. That is what "they move randomly" looks like from the
 * driver's seat: nobody is going anywhere.
 *
 * A pedestrian now walks a PATH — the full offset polyline of one side of one road, mitred at the
 * corners and draped on the ground once — parameterised by ARC LENGTH, not by a per-segment 0..1. They
 * traverse the whole street, round its bends, and turn at the end over ~half a second because the yaw
 * is smoothed instead of assigned.
 *
 * Frame: physics frame (added to `scene`). World→physics: px = -(wx - origin.x), pz = wz - origin.z.
 */
import * as THREE from 'three';
import { loadPeopleWalkTemplates } from './carModels.js';
import { kerbOffset, sidewalkWidth } from '../map/roadWidths.js';   // R-W1
import { audio } from '../audio/audioManager.js';

const WALKABLE = new Set([
  'residential', 'living_street', 'unclassified', 'pedestrian', 'footway',
  'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link',
]);
// R-W1: the second HALFW_BY_TYPE is gone with the first. Pedestrians walk on the SIDEWALK, which
// the width model now sizes and places explicitly — its inner edge is the kerb, and it is the same
// kerb the rail and the parking bay hang off, so they cannot drift apart.

// Flipbook rate: a pedestrian's walk cycle is ~1.15 s, so FRAMES is literally the animation's frame
// rate. At 8 it was 7 fps — stop-motion, and the single loudest "not smooth" signal. 12 buys 10-11 fps
// for 12 more InstancedMeshes, which now cost nothing when empty (see the `visible` gate in update).
const FRAMES       = 12;
const PED_CAP      = 168;  // trimmed ~20% for perf (instanced flipbook)
const CAP_PER_CELL = 45;   // per (variant × frame) InstancedMesh
const RANGE        = 150;
const REBUILD_DIST = 40;
const SIDEWALK_PAD = 1.9;
const MIN_PATH_LEN = 8;    // m — below this a pavement line is a stub, not a street worth walking
const WALK_MIN = 0.9, WALK_MAX = 1.6;
const PED_SPACING = 22;    // m of pavement per pedestrian — density, replacing "half the segment count"
const STRIDE = 1.4;        // m of ground covered per walk cycle; ties the flipbook to real speed (no skating)
// P-3: the RUN cycle, which was in every GLB and never baked. A panicking pedestrian used to play the
// WALK flipbook at a flat 2.6 cycles/s, which reads as fast-forward rather than as running — the legs
// keep a walk's stance while the body covers 4 m/s. 8 frames because a run cycle is roughly half a
// walk's duration, so 8 samples the motion at the same rate 12 does for the walk.
const RUN_FRAMES = 8;
const RUN_STRIDE = 2.2;    // m of ground per run cycle (a stride, not a step)
// Clamp before dividing: on a pedestrian's FIRST frame the previous position is (0,0), so the measured
// ground speed is the distance to the world origin. The clamp is what keeps that from spinning the
// flipbook at 4 kHz, and it also stops the dodge's ramp-in from stuttering the cadence.
const RUN_MIN_MPS = 2.0, RUN_MAX_MPS = 5.0;
const IDLE_FRAC = 0.18;    // fraction STANDING at any moment — it is now a STATE, not a life sentence
const PAUSE_MIN = 2.5, PAUSE_MAX = 11;   // s standing before moving off again
const LEG_MIN = 9, LEG_MAX = 45;         // s walking before the next pause
const YAW_LERP = 7;        // rad-ish per s — a person turns, they do not teleport their facing
const YAW_LERP_PANIC = 20; // bolting IS abrupt; keep it that way
const WOBBLE_AMP = 0.16;   // m of lateral drift — nobody walks a surveyed line
const WOBBLE_RATE = 0.55;  // Hz
// P-2 crossing behaviour. A pedestrian who crossed every crossing would spend the day zigzagging,
// so most walk on by; the ones who do cross wait at the kerb first, which is what makes it read as
// a decision rather than as a teleport to the other pavement.
const CROSS_TRIGGER_M = 2.5;   // arc distance to a hook that counts as "arriving at it"
const CROSS_CHANCE = 0.35;     // of the walkers who reach a kerb
const CROSS_COOLDOWN_S = 12;   // before the same person considers another crossing
const KERB_WAIT_MIN = 0.5, KERB_WAIT_MAX = 2.2;
const YAXIS = new THREE.Vector3(0, 1, 0);
const HIT_RADIUS = 2.6;    // m from the car centre that counts as a hit
const HIT_MIN_KMH = 6;     // don't launch people when crawling
const GRAVITY = 20;        // m/s² for thrown bodies
const LIE_TIME = 3.0;      // s a knocked body lies before it's cleared
const DODGE_R = 8;         // m — car this close & moving → ped bolts out of the way
const DODGE_R2 = DODGE_R * DODGE_R;
const DODGE_DIST = 2.6;    // m of lateral shove at closest range (clears the HIT_RADIUS if they react in time)
const DODGE_LERP = 11;     // how fast the shove ramps in (per s) — a real jump-out-of-the-way
const PANIC_TIME = 0.55;   // s the run animation + shove persist after the car has passed

const TWO_PI = Math.PI * 2;
/** Shortest signed angular difference b−a, in (−π, π]. */
function angDelta(a, b) {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI; else if (d < -Math.PI) d += TWO_PI;
  return d;
}

/**
 * ── PAVEMENT PATHS (module scope so they can be tested without a WebGL scene) ──────────────────
 *
 * A path is { p: Float32Array [px, y, pz] × n, cum: Float32Array (arc length at each vertex), len }
 * in PHYSICS space. Pedestrians are parameterised by arc length along it.
 */

/**
 * Both pavement polylines for one road's points, in PHYSICS space, or null if it is not walkable.
 *
 * The offset is MITRED at interior vertices (average of the two adjacent unit tangents, scaled by
 * 1/cos(half-angle)) instead of offsetting each sub-segment on its own. Per-segment offsetting is
 * what put a step in the pavement at every bend in the old build — the two offset sub-segments do
 * not meet, and a walker teleported sideways across the gap.
 *
 * @param {{x:number,y:number}[]} pts  road centreline, WORLD (x = easting, y = northing)
 * @param {number} off                 metres from the centreline to the walk line
 * @param {(wx:number,wy:number)=>number|null} groundAt
 * @param {{x:number,z:number}} origin physics origin
 */
export function buildPavementPaths(pts, off, groundAt, origin, minLen = 8) {
  if (!pts || pts.length < 2) return null;
  const n = pts.length;
  const out = [];
  for (const side of [1, -1]) {
    const P = new Float32Array(n * 3);
    const cum = new Float32Array(n);
    let w = 0;
    for (let i = 0; i < n; i++) {
      let tx, ty, miter = 1;
      if (i === 0) { tx = pts[1].x - pts[0].x; ty = pts[1].y - pts[0].y; }
      else if (i === n - 1) { tx = pts[n - 1].x - pts[n - 2].x; ty = pts[n - 1].y - pts[n - 2].y; }
      else {
        const ax = pts[i].x - pts[i - 1].x, ay = pts[i].y - pts[i - 1].y;
        const bx = pts[i + 1].x - pts[i].x, by = pts[i + 1].y - pts[i].y;
        const al = Math.hypot(ax, ay) || 1, bl = Math.hypot(bx, by) || 1;
        tx = ax / al + bx / bl; ty = ay / al + by / bl;
        const tl0 = Math.hypot(tx, ty) || 1;
        // cos(half-angle) between the averaged tangent and the incoming one; capped so a hairpin
        // does not fling the pavement into the next street.
        miter = Math.min(2.5, 1 / Math.max(0.4, (tx / tl0) * (ax / al) + (ty / tl0) * (ay / al)));
      }
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const wx = pts[i].x + (-ty) * off * side * miter;
      const wy = pts[i].y + (tx) * off * side * miter;
      P[i * 3] = -(wx - origin.x);      // physics X is mirrored — see CLAUDE.md danger note
      P[i * 3 + 1] = groundAt ? (groundAt(wx, wy) ?? 0) : 0;
      P[i * 3 + 2] = wy - origin.z;
      if (i > 0) w += Math.hypot(P[i * 3] - P[i * 3 - 3], P[i * 3 + 2] - P[i * 3 - 1]);
      cum[i] = w;
    }
    if (w < minLen) continue;   // too short to walk — a stub, not a street
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = P[i * 3], z = P[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    out.push({
      p: P, cum, len: w, minX, maxX, minZ, maxZ,
      cx: (P[0] + P[n * 3 - 3]) / 2, cz: (P[2] + P[n * 3 - 1]) / 2,
      hooks: null, hookVer: -1,   // P-2: crossings attached to this pavement, see attachCrossings()
    });
  }
  return out.length ? out : null;
}

/**
 * ── P-2: MARKED CROSSINGS ─────────────────────────────────────────────────────────────────────
 *
 * A crossing is an OSM way ACROSS the carriageway (`footway=crossing`, mostly — 10,011 of 11,325 in
 * the baked tiles, median 14.5 m, which is a road's width). Pedestrians used to be unable to leave
 * the pavement they spawned on, so a street was two conveyor belts facing each other.
 *
 * The expensive part is "is there a crossing near me", and it is answered ONCE PER PAVEMENT rather
 * than per pedestrian per frame: each crossing endpoint that lands near a path is stored as a HOOK
 * at an arc-length position on it. A walker then only compares its own `s` against a few numbers.
 */
const CROSS_SNAP_M = 7;      // how close a crossing end must be to a pavement to belong to it

/** Physics-space polyline for a crossing way (no pavement offset — you walk down its middle). */
export function buildCrossingPath(pts, groundAt, origin) {
  if (!pts || pts.length < 2) return null;
  const n = pts.length;
  const P = new Float32Array(n * 3);
  const cum = new Float32Array(n);
  let w = 0;
  for (let i = 0; i < n; i++) {
    P[i * 3] = -(pts[i].x - origin.x);
    P[i * 3 + 1] = groundAt ? (groundAt(pts[i].x, pts[i].y) ?? 0) : 0;
    P[i * 3 + 2] = pts[i].y - origin.z;
    if (i > 0) w += Math.hypot(P[i * 3] - P[i * 3 - 3], P[i * 3 + 2] - P[i * 3 - 1]);
    cum[i] = w;
  }
  if (w < 2 || w > 60) return null;   // 0.9 m stubs and 100 m "crossings" are not what this is for
  return { p: P, cum, len: w };
}

/**
 * Attach every crossing that touches `path` as a hook at the arc length where it meets.
 *
 * @param {object} path
 * @param {object[]} crossings  {p, cum, len} in physics space
 * @param {number} ver          bumped when the crossing set changes; hooks are cached against it
 */
export function attachCrossings(path, crossings, ver) {
  if (path.hookVer === ver) return path.hooks;
  path.hookVer = ver;
  const hooks = [];
  const n = path.cum.length;
  for (const c of crossings) {
    // Both ends are candidates: a pedestrian may arrive at either side of the road.
    for (const endIdx of [0, c.cum.length - 1]) {
      const ex = c.p[endIdx * 3], ez = c.p[endIdx * 3 + 2];
      if (ex < path.minX - CROSS_SNAP_M || ex > path.maxX + CROSS_SNAP_M
       || ez < path.minZ - CROSS_SNAP_M || ez > path.maxZ + CROSS_SNAP_M) continue;
      // Nearest point on the pavement, by vertex then by the segment either side of it.
      let best = Infinity, bestS = 0;
      for (let i = 0; i < n - 1; i++) {
        const ax = path.p[i * 3], az = path.p[i * 3 + 2];
        const bx = path.p[i * 3 + 3], bz = path.p[i * 3 + 5];
        const dx = bx - ax, dz = bz - az;
        const L2 = dx * dx + dz * dz || 1;
        let t = ((ex - ax) * dx + (ez - az) * dz) / L2;
        t = Math.max(0, Math.min(1, t));
        const px = ax + dx * t, pz = az + dz * t;
        const d2 = (ex - px) ** 2 + (ez - pz) ** 2;
        if (d2 < best) { best = d2; bestS = path.cum[i] + Math.sqrt(L2) * t; }
      }
      if (best > CROSS_SNAP_M * CROSS_SNAP_M) continue;
      hooks.push({ s: bestS, cross: c, fromStart: endIdx === 0 });
    }
  }
  hooks.sort((a, b) => a.s - b.s);
  path.hooks = hooks;
  return hooks;
}

/**
 * Position + unit tangent at arc length `s`. `out.i` is the walker's cached vertex index, so a step
 * costs one compare rather than a search back through the polyline.
 */
/**
 * Nearest point on any of `paths` to (x, z), as {path, s}. Used once, when someone steps off a
 * crossing — a linear scan is fine at that rate and a spatial index would be a structure to keep
 * correct for no measured gain.
 */
export function nearestPathPoint(paths, x, z, maxD = 12) {
  let best = maxD * maxD, hit = null;
  for (const path of paths) {
    if (x < path.minX - maxD || x > path.maxX + maxD || z < path.minZ - maxD || z > path.maxZ + maxD) continue;
    const n = path.cum.length;
    for (let i = 0; i < n - 1; i++) {
      const ax = path.p[i * 3], az = path.p[i * 3 + 2];
      const bx = path.p[i * 3 + 3], bz = path.p[i * 3 + 5];
      const dx = bx - ax, dz = bz - az;
      const L2 = dx * dx + dz * dz || 1;
      let t = ((x - ax) * dx + (z - az) * dz) / L2;
      t = Math.max(0, Math.min(1, t));
      const d2 = (x - (ax + dx * t)) ** 2 + (z - (az + dz * t)) ** 2;
      if (d2 < best) { best = d2; hit = { path, s: path.cum[i] + Math.sqrt(L2) * t }; }
    }
  }
  return hit;
}

export function samplePath(path, s, out) {
  const cum = path.cum, n = cum.length;
  let i = out.i | 0;
  if (i > n - 2) i = n - 2;
  if (i < 0) i = 0;
  while (i > 0 && s < cum[i]) i--;
  while (i < n - 2 && s > cum[i + 1]) i++;
  const span = cum[i + 1] - cum[i] || 1;
  const t = Math.min(1, Math.max(0, (s - cum[i]) / span));
  const a = i * 3, b = a + 3, P = path.p;
  out.x = P[a] + (P[b] - P[a]) * t;
  out.y = P[a + 1] + (P[b + 1] - P[a + 1]) * t;
  out.z = P[a + 2] + (P[b + 2] - P[a + 2]) * t;
  let tx = P[b] - P[a], tz = P[b + 2] - P[a + 2];
  const tl = Math.hypot(tx, tz) || 1;
  out.tx = tx / tl; out.tz = tz / tl;
  out.i = i;
  return out;
}

export function createPedestrians({ scene, getRoadSegments, getGroundY, getOrigin, contactShadows }) {
  let variants = [];   // [{ walk:[IM×FRAMES], run:[IM×RUN_FRAMES], idle:IM, stand:IM|null, fall:IM|null }]
  let nVar = 0;
  let _enabled = true;

  loadPeopleWalkTemplates('/models/people/', 1.8, FRAMES).then((tpls) => {
    if (!tpls.length) { console.warn('[pedestrians] no people templates'); return; }
    variants = tpls.map((t) => {
      const mk = (geo) => {
        const im = new THREE.InstancedMesh(geo, t.material, CAP_PER_CELL);
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // castShadow OFF: 45 shadow-casting instanced meshes tanked the shadow pass (FPS 30). Small
        // objects — grounding comes from the fake contact shadow instead.
        im.frustumCulled = false; im.castShadow = false; im.count = 0;
        im.userData.type = 'pedestrian';   // N-18: an untagged mesh is invisible to every probe
        scene.add(im);
        return im;
      };
      return {
        walk: t.frames.map(mk),
        run: (t.run || []).map(mk),
        idle: mk(t.idle),
        // Second standing pose. Optional by design: a GLB with no Standing clip just gets one idle,
        // and the crowd looks exactly as it did before rather than throwing.
        stand: t.stand ? mk(t.stand) : null,
        fall: t.fall ? mk(t.fall) : null,
      };
    });
    nVar = variants.length;
  }).catch((e) => console.warn('[pedestrians] load error', e?.message || e));

  const peds = [];
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _p = new THREE.Vector3();
  const _hit = { i: 0, x: 0, y: 0, z: 0, tx: 0, tz: 0 };
  let _lastX = Infinity, _lastZ = Infinity, _time = 0;
  let _paths = [];      // in-range pavements — a pedestrian stepping off a crossing re-joins one
  let _crossVer = 0;    // bumped when the crossing set is rebuilt; path hooks cache against it

  function newLeg(p) {
    // Alternate walking and standing. IDLE_FRAC is the share of the crowd standing at any moment,
    // and it is now a rolling state — the old build froze a quarter of every crowd as permanent
    // statues, which reads as broken rather than as people waiting for something.
    if (p.state === 'walk') {
      p.state = 'pause'; p.speed = 0;
      p.stateT = PAUSE_MIN + Math.random() * (PAUSE_MAX - PAUSE_MIN);
    } else {
      p.state = 'walk';
      p.speed = WALK_MIN + Math.random() * (WALK_MAX - WALK_MIN);
      p.stateT = LEG_MIN + Math.random() * (LEG_MAX - LEG_MIN);
      if (Math.random() < 0.3) p.dir = -p.dir;   // turned around while they stood there
    }
  }

  function spawnPed(path, s) {
    const idle = Math.random() < IDLE_FRAC;
    const p = {
      path, s, i: 0,
      dir: Math.random() < 0.5 ? 1 : -1,
      state: idle ? 'pause' : 'walk',
      speed: 0,
      stateT: idle ? PAUSE_MIN + Math.random() * (PAUSE_MAX - PAUSE_MIN)
                   : LEG_MIN + Math.random() * (LEG_MAX - LEG_MIN),
      cyc: Math.random(), yaw: Math.random() * TWO_PI,
      wob: Math.random() * TWO_PI,
      cx: 0, cz: 0,
      variant: (Math.random() * nVar) | 0,
      // Which standing pose this person holds, for their whole life. Re-rolling it per pause would
      // make someone waiting at a kerb snap between two poses every few seconds.
      pose: Math.random() < 0.5 ? 1 : 0,
    };
    if (!idle) p.speed = WALK_MIN + Math.random() * (WALK_MAX - WALK_MIN);
    peds.push(p);
  }

  // Incremental reassignment: keep people who are still in range (so a pedestrian you're driving toward
  // stays put instead of being wiped and replaced), cull only those who've left range, and top up new
  // ones out in the distance. Full wipe-and-respawn was the cause of pedestrians vanishing on approach.
  const NEAR_SPAWN_2 = 30 * 30; // don't spawn newcomers within 30m of the player (avoids pop-in nearby)

  /**
   * The two pavement walk lines for one road segment.
   *
   * Cached against the ORIGIN it was built for: the physics origin is fixed in practice, but a stale
   * path is a crowd standing in the wrong postcode, and that is not a failure anyone would diagnose.
   */
  function computePedPaths(seg, origin) {
    if (!WALKABLE.has(seg.highwayType) || !seg.points || seg.points.length < 2) return null;
    // Walk down the MIDDLE of the sidewalk: kerb + half the sidewalk. Where there is no sidewalk
    // (a shared-surface living_street, a footway that IS the path), fall back to a small pad off
    // the kerb rather than inventing a width.
    const sw = sidewalkWidth(seg);
    const off = sw > 0.5 ? kerbOffset(seg) + sw / 2 : kerbOffset(seg) + SIDEWALK_PAD;
    return buildPavementPaths(seg.points, off, getGroundY, origin, MIN_PATH_LEN);
  }

  function reassign(playerPx, playerPz) {
    const segs = getRoadSegments?.();
    if (!segs || !nVar) return;   // keep existing crowd if road data is momentarily unavailable
    const origin = getOrigin();
    const R2 = RANGE * RANGE;

    // Cull pedestrians who have walked out of range (thrown bodies finish their knockdown first).
    for (let i = peds.length - 1; i >= 0; i--) {
      const p = peds[i];
      if (p.thrown) continue;
      if ((p.cx - playerPx) ** 2 + (p.cz - playerPz) ** 2 > R2) peds.splice(i, 1);
    }

    // ── P-2: the marked crossings in range, rebuilt when the tile set changes ──
    const cross = [];
    for (const seg of segs) {
      if (!seg.crossing || !seg.points || seg.points.length < 2) continue;
      const c0 = seg.points[0];
      if ((-(c0.x - origin.x) - playerPx) ** 2 + ((c0.y - origin.z) - playerPz) ** 2 > R2) continue;
      let cp = seg._pedCross;
      if (cp === undefined || seg._pedCrossOrigin !== origin.x) {
        cp = buildCrossingPath(seg.points, getGroundY, origin);
        seg._pedCross = cp; seg._pedCrossOrigin = origin.x;
      }
      if (cp) cross.push(cp);
    }
    _crossVer++;

    const cand = [];
    let totalLen = 0;
    for (const seg of segs) {
      // Cache the segment's pavement polylines (roads don't move), so a far segment costs one
      // cached-centre test — not a full point-walk + getGroundY calls every 40 m. This was the twin
      // of the parked-car `ent` stutter.
      if (seg._pedPathOrigin !== origin.x || seg._pedPathOriginZ !== origin.z) {
        seg._pedPaths = computePedPaths(seg, origin);
        seg._pedPathOrigin = origin.x; seg._pedPathOriginZ = origin.z;
      }
      const paths = seg._pedPaths;
      if (!paths) continue;
      for (const path of paths) {
        // Centre test with the path's own half-length as slack, so a long road that merely PASSES
        // near the player still qualifies.
        const reach = RANGE + path.len / 2;
        if ((path.cx - playerPx) ** 2 + (path.cz - playerPz) ** 2 > reach * reach) continue;
        attachCrossings(path, cross, _crossVer);
        cand.push(path);
        totalLen += Math.min(path.len, RANGE * 2);
      }
    }
    if (!cand.length) return;
    _paths = cand;

    // Density, not segment count: one pedestrian per PED_SPACING metres of pavement in range. The old
    // `candidates × 0.5` was a count of geometry vertices, so a finely-noded street got a mob and a
    // straight one got nobody.
    const target = Math.min(PED_CAP, Math.round(totalLen / PED_SPACING));
    let guard = 0;
    while (peds.length < target && guard++ < target * 4) {
      const path = cand[(Math.random() * cand.length) | 0];
      const s = Math.random() * path.len;
      samplePath(path, s, _hit);
      // Prefer far spots for newcomers so they appear in the distance, not right next to the car.
      if ((_hit.x - playerPx) ** 2 + (_hit.z - playerPz) ** 2 < NEAR_SPAWN_2 && guard < target * 2) continue;
      spawnPed(path, s);
    }
  }

  function update(playerPx, playerPz, dt, carSpeedKmh = 0) {
    if (!_enabled || !nVar) return;
    const d = Math.min(dt || 0.016, 0.05);
    _time += d;
    if ((playerPx - _lastX) ** 2 + (playerPz - _lastZ) ** 2 > REBUILD_DIST * REBUILD_DIST) {
      _lastX = playerPx; _lastZ = playerPz; reassign(playerPx, playerPz);
    }
    for (const v of variants) {
      for (const im of v.walk) im.count = 0;
      for (const im of v.run) im.count = 0;
      v.idle.count = 0; if (v.stand) v.stand.count = 0; if (v.fall) v.fall.count = 0;
    }

    const canHit = Math.abs(carSpeedKmh) > HIT_MIN_KMH;
    let anyDead = false;
    for (const p of peds) {
      const V = variants[p.variant];

      // ── thrown body: simple projectile + tumble, then lie, then clear ──
      if (p.thrown) {
        p.age += d;
        if (!p.landed) {
          p.vy -= GRAVITY * d;
          p.x += p.vx * d; p.y += p.vy * d; p.z += p.vz * d; p.ang += p.spin * d;
          if (p.y <= p.gy) { p.y = p.gy; p.landed = true; p.landAge = p.age; }
        }
        if (p.landed && p.age - p.landAge > LIE_TIME) { p.dead = true; anyDead = true; continue; }
        const fallMesh = V.fall;
        if (fallMesh) {
          // crumpled pose: tumble limply while airborne, settle flat (own resting yaw) once landed
          if (fallMesh.count < CAP_PER_CELL) {
            if (p.landed) { _q.setFromAxisAngle(YAXIS, p.restYaw); _p.set(p.x, p.gy, p.z); }
            else { _q.setFromAxisAngle(p.axis, p.ang); _p.set(p.x, p.y, p.z); }
            _m.compose(_p, _q, _s);
            fallMesh.setMatrixAt(fallMesh.count++, _m);
          }
        } else {
          const im = V.idle; // fallback: no fall clip for this variant → old flat-plank tumble
          if (im.count < CAP_PER_CELL) {
            _q.setFromAxisAngle(p.axis, p.landed ? Math.PI / 2 : p.ang);
            _p.set(p.x, p.landed ? p.gy + 0.25 : p.y, p.z);
            _m.compose(_p, _q, _s);
            im.setMatrixAt(im.count++, _m);
          }
        }
        if (p.landed) contactShadows?.add(p.x, p.gy, p.z, 1.4, 0.7); // shadow of the body lying down
        continue;
      }

      // ── walk / stand state machine ──
      // 'kerb' and 'crossing' run their own clocks below; newLeg() would yank someone out of the
      // road halfway across.
      if (p.state === 'walk' || p.state === 'pause') {
        p.stateT -= d;
        if (p.stateT <= 0) newLeg(p);
      }

      // ── P-2: crossing the road ────────────────────────────────────────────────────────────
      p.crossCd = Math.max(0, (p.crossCd || 0) - d);

      if (p.state === 'kerb') {
        // Waiting at the kerb. Standing still is the whole point — it is what turns "teleported to
        // the other pavement" into "decided to cross".
        p.stateT -= d;
        if (p.stateT <= 0) { p.state = 'crossing'; p.crossS = p.crossDir > 0 ? 0 : p.cross.len; }
      } else if (p.state === 'crossing') {
        p.crossS += p.crossDir * p.speed * d;
        const done = p.crossDir > 0 ? p.crossS >= p.cross.len : p.crossS <= 0;
        if (done) {
          // Re-join the nearest pavement to where we stepped off. If there is none in range (the
          // far side has not streamed in, or the crossing lands on a plaza) fall back to walking
          // BACK the way we came rather than standing in the road forever.
          _hit.i = 0;
          samplePath(p.cross, p.crossDir > 0 ? p.cross.len : 0, _hit);
          const j = nearestPathPoint(_paths, _hit.x, _hit.z);
          if (j) { p.path = j.path; p.s = j.s; p.i = 0; p.dir = Math.random() < 0.5 ? 1 : -1; }
          else { p.crossDir = -p.crossDir; }
          p.state = 'walk';
          p.crossCd = CROSS_COOLDOWN_S;
          p.cross = null;
        }
      } else if (p.state === 'walk') {
        p.s += p.dir * p.speed * d;
        if (p.s > p.path.len) { p.s = p.path.len; p.dir = -1; }
        else if (p.s < 0) { p.s = 0; p.dir = 1; }
        // Arrived at a crossing? Only a fraction take it, or the street becomes a zigzag.
        if (p.crossCd === 0 && p.path.hooks) {
          for (const h of p.path.hooks) {
            if (Math.abs(h.s - p.s) > CROSS_TRIGGER_M) continue;
            p.crossCd = CROSS_COOLDOWN_S;               // considered it either way
            if (Math.random() > CROSS_CHANCE) break;
            p.cross = h.cross;
            p.crossDir = h.fromStart ? 1 : -1;
            p.crossS = h.fromStart ? 0 : h.cross.len;
            p.state = 'kerb';
            p.stateT = KERB_WAIT_MIN + Math.random() * (KERB_WAIT_MAX - KERB_WAIT_MIN);
            break;
          }
        }
      }

      // Sample from whichever polyline this person is currently on.
      const onCross = p.state === 'crossing' || p.state === 'kerb';
      _hit.i = onCross ? 0 : p.i;
      samplePath(onCross ? p.cross : p.path, onCross ? p.crossS : p.s, _hit);
      if (!onCross) p.i = _hit.i;
      // Lateral wobble along the path normal — nobody walks a surveyed line, and a column of people
      // on the exact same offset is the other half of "they look fake".
      // Only while WALKING — applied to a stander it becomes a 32 cm sway on the spot.
      const wob = (p.state === 'walk' || p.state === 'crossing')
        ? Math.sin(_time * WOBBLE_RATE * TWO_PI + p.wob) * WOBBLE_AMP : 0;
      const onLine_x = _hit.x + (-_hit.tz) * wob;
      const onLine_z = _hit.z + (_hit.tx) * wob;
      const y = _hit.y;
      const moveDir = p.state === 'crossing' ? p.crossDir : p.dir;
      let targetYaw = Math.atan2(_hit.tx * moveDir, _hit.tz * moveDir);

      // ── dodge: bolt out of the way of an approaching car ──
      p.dodgeX = p.dodgeX || 0; p.dodgeZ = p.dodgeZ || 0; p.panic = p.panic || 0;
      const cdx = onLine_x - playerPx, cdz = onLine_z - playerPz;
      const cd2 = cdx * cdx + cdz * cdz;
      let panicking = false;
      if (canHit && cd2 < DODGE_R2) {
        const dl = Math.sqrt(cd2) || 1;
        const want = DODGE_DIST * (1 - dl / DODGE_R); // stronger the closer the car
        const k = Math.min(1, DODGE_LERP * d);
        p.dodgeX += ((cdx / dl) * want - p.dodgeX) * k;
        p.dodgeZ += ((cdz / dl) * want - p.dodgeZ) * k;
        p.panic = PANIC_TIME; panicking = true;
      } else if (p.panic > 0) {
        p.panic -= d; panicking = true;
      } else if (p.dodgeX || p.dodgeZ) { // ease back onto the sidewalk line
        const k = Math.min(1, 2.5 * d);
        p.dodgeX -= p.dodgeX * k; p.dodgeZ -= p.dodgeZ * k;
        if (Math.abs(p.dodgeX) < 0.01) p.dodgeX = 0;
        if (Math.abs(p.dodgeZ) < 0.01) p.dodgeZ = 0;
      }
      if (panicking && (p.dodgeX || p.dodgeZ)) targetYaw = Math.atan2(p.dodgeX, p.dodgeZ);

      // ── facing: TURN, don't teleport ──
      // The old build assigned yaw outright, so reaching the end of a segment or catching sight of the
      // car flipped a person through 180° in one frame. Smoothing this is the cheapest single thing
      // that makes the crowd read as people instead of as sprites being re-parented.
      const rate = panicking ? YAW_LERP_PANIC : YAW_LERP;
      if (p.state === 'walk' || p.state === 'crossing' || panicking) {
        p.yaw += angDelta(p.yaw, targetYaw) * Math.min(1, rate * d);
      }

      const x = onLine_x + p.dodgeX;
      const z = onLine_z + p.dodgeZ;

      let im;
      if (p.state === 'walk' || p.state === 'crossing' || panicking) {
        if (panicking && V.run.length) {
          // Cadence from MEASURED ground speed, which during a dodge is mostly the lateral shove and
          // not p.speed at all — p.speed is the walk along the pavement line and barely changes when
          // someone bolts. Measuring the actual displacement is the only number that matches the feet
          // to the ground; the clamp above covers the first frame and the shove's ramp.
          const mps = Math.min(RUN_MAX_MPS, Math.max(RUN_MIN_MPS, Math.hypot(x - p.cx, z - p.cz) / d));
          p.cyc = (p.cyc + (mps / RUN_STRIDE) * d) % 1;
          im = V.run[Math.min(RUN_FRAMES - 1, (p.cyc * RUN_FRAMES) | 0)];
        } else {
          // Cadence from GROUND SPEED, so the feet match the distance covered instead of drifting.
          // (Also the panic path for a variant whose GLB has no run clip — old behaviour, unchanged.)
          const cycRate = panicking ? 2.6 : Math.max(0.45, p.speed / STRIDE);
          p.cyc = (p.cyc + cycRate * d) % 1;
          im = V.walk[Math.min(FRAMES - 1, (p.cyc * FRAMES) | 0)];
        }
      } else { im = (p.pose && V.stand) ? V.stand : V.idle; }

      p.cx = x; p.cz = z;

      // ── hit by the car? (checked at the DODGED position — a ped who clears in time escapes) ──
      if (canHit && (x - playerPx) ** 2 + (z - playerPz) ** 2 < HIT_RADIUS * HIT_RADIUS) {
        const dx = x - playerPx, dz = z - playerPz, dl = Math.hypot(dx, dz) || 1;
        const mps = Math.min(Math.abs(carSpeedKmh) / 3.6, 22);
        p.thrown = true; p.age = 0; p.landed = false;
        audio.impact(Math.min(1, mps / 11));  // same collision thud as car impacts, scaled by speed (SFX bus)
        p.x = x; p.y = y; p.z = z; p.gy = y;
        p.vx = (dx / dl) * (mps * 0.55 + 2); p.vz = (dz / dl) * (mps * 0.55 + 2); p.vy = 3 + mps * 0.22;
        p.axis = new THREE.Vector3(Math.random() - 0.5, 0.25, Math.random() - 0.5).normalize();
        p.spin = 6 + Math.random() * 7; p.ang = 0; p.restYaw = Math.random() * TWO_PI;
        continue;
      }

      if (im.count >= CAP_PER_CELL) continue;
      _q.setFromAxisAngle(YAXIS, p.yaw);
      _p.set(x, y, z);
      _m.compose(_p, _q, _s);
      im.setMatrixAt(im.count++, _m);
      contactShadows?.add(x, y, z, 0.7, 0.7); // small round contact shadow
    }
    if (anyDead) for (let i = peds.length - 1; i >= 0; i--) if (peds[i].dead) peds.splice(i, 1);

    // An InstancedMesh with count 0 is still submitted by the renderer, and with FRAMES cells per
    // variant most of them are empty on any given frame. Gating on `visible` is what makes a longer
    // flipbook free: 12 frames × 3 variants is 39 meshes but only ~10-14 ever hold anyone.
    for (const v of variants) {
      const flush = (im) => { im.visible = im.count > 0; if (im.count) im.instanceMatrix.needsUpdate = true; };
      for (const im of v.walk) flush(im);
      for (const im of v.run) flush(im);
      flush(v.idle); if (v.stand) flush(v.stand); if (v.fall) flush(v.fall);
    }
  }

  function setEnabled(on) {
    _enabled = on;
    for (const v of variants) {
      for (const im of v.walk) { im.visible = on && im.count > 0; if (!on) im.count = 0; }
      for (const im of v.run) { im.visible = on && im.count > 0; if (!on) im.count = 0; }
      v.idle.visible = on && v.idle.count > 0; if (!on) v.idle.count = 0;
      if (v.stand) { v.stand.visible = on && v.stand.count > 0; if (!on) v.stand.count = 0; }
      if (v.fall) { v.fall.visible = on && v.fall.count > 0; if (!on) v.fall.count = 0; }
    }
    if (!on) peds.length = 0;
  }
  function getCount() {
    let n = 0;
    for (const v of variants) {
      for (const im of v.walk) n += im.count;
      for (const im of v.run) n += im.count;
      n += v.idle.count; if (v.stand) n += v.stand.count; if (v.fall) n += v.fall.count;
    }
    return n;
  }
  function dispose() {
    for (const v of variants) {
      for (const im of v.walk) { scene.remove(im); im.geometry.dispose(); }
      for (const im of v.run) { scene.remove(im); im.geometry.dispose(); }
      scene.remove(v.idle); v.idle.geometry.dispose();
      if (v.stand) { scene.remove(v.stand); v.stand.geometry.dispose(); }
      if (v.fall) { scene.remove(v.fall); v.fall.geometry.dispose(); }
    }
    variants = [];
  }

  return { update, setEnabled, getCount, dispose };
}
