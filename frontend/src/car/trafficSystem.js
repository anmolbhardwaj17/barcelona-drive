/**
 * AI traffic — lightweight NPC cars that drive the loaded road network.
 *
 * Cars follow a road's centerline (tileManager.getLoadedRoadSegments) offset into the right lane,
 * kinematically (no per-car vehicle physics). Each carries a STATIC box collider (WORLD/VEHICLE) so
 * the PLAYER collides with it; they also STOP when the lane ahead is blocked (by the player or another
 * cars). Pool of MAX_CARS near the player; spawn in a ring, despawn far / at road end.
 *
 * ⚠ This used to read "v1 doesn't chain junctions", and that had been FALSE for a while:
 * `extendPath()` chains onto a connected road at the end of a path. The stale comment was
 * believed during an audit and cost time. What was actually missing was TURNING — extendPath
 * chose the straightest continuation greedily, so a car went straight whenever straight
 * existed. See docs/context/traffic-realism-plan.md.
 *
 * Visual: the Kenney low-poly city cars, drawn through the SHARED car pool (carFleet.js) — every
 * NPC car in the world is one instance in one BatchedMesh, alongside the parked cars. v3 P4-15a
 * replaced 28 loose Meshes (allocated and spliced into `scene` as cars spawned and despawned, ~2 of
 * each per frame at cruise) with 28 pre-allocated pool slots that are shown and hidden instead.
 * Frame: physics frame. World→physics: px = -(wx - origin.x), pz = wz - origin.z. Road point = {x:wx, y:wz}.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLLISION_GROUP_WORLD, COLLISION_GROUP_VEHICLE } from '../collisionGroups.js';
import { getCarPool, createLightPool, makeLightLocals, LIGHT_HEAD, LIGHT_TAIL } from './carFleet.js';
import { CANON_LENGTH } from './carModels.js';
import { audio } from '../audio/audioManager.js';
import { isRedFor, signalNow } from '../map/trafficSignalRenderer.js';   // T-3 — obey the phase
import { fleetHasRealLights } from './carModels.js';   // V-6 — skip fake lamp quads

/** Evaluated once: CITY_CARS does not change at runtime. */
const _realLights = fleetHasRealLights();
import { bodyColorFor } from './carFleet.js';   // V-5 — per-car body colour

const PASS_DIST = 5.5; // m — a traffic car entering this radius fires a pass-by whoosh

// ── T-3 · STOPPING AT A RED ───────────────────────────────────────────────────────────────────
// A car looks a short way down its own heading for a signal governing ITS axis. The window has a
// near edge on purpose: once a car is level with or past the signal it is IN the junction, and
// stopping there is worse than continuing — it would block the crossing traffic that just went
// green. Real drivers do the same thing.
const SIGNAL_LOOK_M = 22;   // start braking this far out — comfortable at trunk speed (16 m/s)
const SIGNAL_NEAR_M = 3.0;  // past this, committed: do not stop in the junction
const SIGNAL_LAT_M  = 5.0;  // lateral tolerance — the signal is kerbside, not on the centreline

const DRIVABLE = new Set([
  'residential', 'living_street', 'unclassified',
  'tertiary', 'tertiary_link', 'secondary', 'secondary_link',
  'primary', 'primary_link', 'trunk', 'trunk_link',
]);
const SPEED_BY_TYPE = {
  residential: 7, living_street: 5, unclassified: 8,
  tertiary: 9, tertiary_link: 8, secondary: 12, secondary_link: 10,
  primary: 14, primary_link: 11, trunk: 16, trunk_link: 12,
};

const MAX_CARS    = 28;
let _colorSeed = 1;   // advances per spawn so consecutive cars differ   // pool slots reserved in the shared car fleet
const CAR_LENGTH  = 4.30; // m — see the note in parkedCars.js; was 3.9 and read as toy-sized
const SPAWN_MIN   = 32;
const SPAWN_MAX   = 185;
const DESPAWN     = 240;
const LANE_OFFSET = 2.2;
const SPAWN_PER_FRAME = 2;
const SPAWN_GAP   = 16;   // m — don't spawn within this of another car (avoids spawn-cluster deadlock)
const STOP_DIST = 7;      // m — brake if something is this close ahead in-lane
const LANE_HALF = 2.0;    // m — lateral tolerance for "in my lane"
const DEADLOCK_T = 5;     // s stuck at ~0 speed before we despawn a jammed car
// ── CONTACT IS A BOX TEST, NOT A CIRCLE (V-12) ────────────────────────────────────────────────
// This was `HIT_RADIUS = 3.4 m`, a circle around the player's CENTRE, while the thing it predicts
// is two 4.5 m boxes touching. The numbers do not work at all:
//
//   player M3   4.79 x 2.18   half-extents 2.40 x 1.09
//   hatchback   4.30 x 2.12   half-extents 2.15 x 1.06
//   head-on contact happens at 4.55 m between centres; the shove waited for 3.4 m
//
// So on a head-on the player drove more than a METRE into a static, infinite-mass box before the
// shove fired, and the solver resolving that penetration every step is the stutter. On a glancing
// pass the centres often never reach 3.4 m at all, so the shove never fired: the player was
// deflected by a wall and the traffic car sailed on untouched. Both symptoms, one cause — a circle
// cannot describe two long boxes.
//
// Replaced with a 2D separating-axis test on the two ORIENTED boxes: correct head-on, side-on, and
// at every angle between. CONTACT_MARGIN fires it just BEFORE the hulls touch, so the shove starts
// as they meet rather than after the solver has already produced an impulse.
const CONTACT_MARGIN = 0.28;   // m of lead, so the shove precedes hard contact
/** Player chassis half-extents, metres — carModel.js: 1.90 W x 4.79 L. */
const PLAYER_HALF_W = 0.95, PLAYER_HALF_L = 2.395;

/**
 * Do two oriented boxes overlap in plan? Standard 2D SAT — if any of the four face normals
 * separates them they are apart. No allocation: this runs per car per frame.
 */
export function obbOverlap(dx, dz, yawA, halfWA, halfLA, yawB, halfWB, halfLB, margin) {
  const ca = Math.cos(yawA), sa = Math.sin(yawA);
  const cb = Math.cos(yawB), sb = Math.sin(yawB);
  // Forward is (sin yaw, cos yaw): a rotation about +Y maps +Z there, which is how both the traffic
  // cars and getHeadingDeg() define heading.
  const axes = [ca, -sa, sa, ca, cb, -sb, sb, cb];   // (right.x, right.z, fwd.x, fwd.z) per box
  for (let i = 0; i < 8; i += 2) {
    const nx = axes[i], nz = axes[i + 1];
    const dist = Math.abs(dx * nx + dz * nz);
    const ra = halfWA * Math.abs(ca * nx - sa * nz) + halfLA * Math.abs(sa * nx + ca * nz);
    const rb = halfWB * Math.abs(cb * nx - sb * nz) + halfLB * Math.abs(sb * nx + cb * nz);
    if (dist > ra + rb + margin) return false;
  }
  return true;
}
const HIT_MIN_KMH = 4;    // shove kicks in at low speed too (was 12 → cars felt like immovable walls on a bump)
const YAXIS = new CANNON.Vec3(0, 1, 0);

const YAXIS3 = new THREE.Vector3(0, 1, 0);

export function createTrafficSystem({ scene, world, getGroundY, getRoadSegments, getOrigin, contactShadows,
                                     onPlayerHit, getTrafficSignals }) {
  const cars = [];
  let _enabled = true;
  let _signals = null;
  let _signalTime = 0;

  // ── Shared fleet resources (resolved once the car kit has loaded) ──
  // `_pool` is the world-wide car BatchedMesh; traffic reserves MAX_CARS slots in it up front and
  // recycles them, so a spawn is a matrix write and a setVisibleAt — no allocation, no scene churn.
  let _pool = null;
  let _dims = [];        // per-variant dims at CAR_LENGTH (pool templates are canonical)
  let _lightLocals = []; // per-variant head/tail quad transforms, in the car's own space
  let _freeSlots = [];
  const CAR_SCALE = CAR_LENGTH / CANON_LENGTH;
  const _scaleV = new THREE.Vector3(CAR_SCALE, CAR_SCALE, CAR_SCALE);

  // ONE light InstancedMesh: head and tail differ by instance colour, not by being two meshes.
  const lights = createLightPool({ scene, capacity: MAX_CARS * 4 + 8, width: 0.28, height: 0.14 });

  const _carM = new THREE.Matrix4(), _carP = new THREE.Vector3(), _carQ = new THREE.Quaternion();
  const _one = new THREE.Vector3(1, 1, 1), _lightBase = new THREE.Matrix4(), _lm = new THREE.Matrix4();

  getCarPool(scene).then((pool) => {
    if (!pool) return;
    _pool = pool;
    const s = CAR_SCALE;
    _dims = pool.templates.map((t) => ({ w: t.dims.w * s, h: t.dims.h * s, l: t.dims.l * s }));
    _lightLocals = _dims.map((d) => makeLightLocals(d));
    for (let i = 0; i < MAX_CARS; i++) {
      const id = pool.alloc();
      if (id < 0) break;   // fleet full — traffic simply runs with fewer cars, it does not throw
      _freeSlots.push(id);
    }
  });

  /**
   * Publish one car's pose: its instance in the shared BatchedMesh, and its four light quads.
   *
   * The car matrix carries CAR_SCALE (the geometry is canonical); the light matrix must NOT, since
   * the light offsets are already in CAR_LENGTH units — see makeLightLocals.
   */
  function placeCar(car, x, y, z, yaw) {
    if (!_pool) return;
    _carQ.setFromAxisAngle(YAXIS3, yaw);
    _carP.set(x, y, z);
    _carM.compose(_carP, _carQ, _scaleV);
    _pool.place(car.slot, car.tplIdx, _carM, car.bodyColor);
    const L = _lightLocals[car.tplIdx];
    if (!L) return;
    _lightBase.compose(_carP, _carQ, _one);
    // V-6: the authored body carries modelled lamps; the quads would sit on top of them.
    if (!_realLights) {
      for (const lm of L.head) { _lm.multiplyMatrices(_lightBase, lm); lights.put(_lm, LIGHT_HEAD); }
      for (const lm of L.tail) { _lm.multiplyMatrices(_lightBase, lm); lights.put(_lm, LIGHT_TAIL); }
    }
  }

  function groundY(wx, wz) {
    const y = getGroundY ? getGroundY(wx, wz) : 0;
    return Number.isFinite(y) ? y : 0;
  }

  // Shared per-frame budget: buildPath is the expensive traffic op (groundY sampling per point + allocs),
  // called by BOTH path-extension and every spawn attempt (up to 8×/spawn). A burst of spawns/extends in
  // one frame stacked into the ~14ms `traffic` spike. Cap total builds/frame (reset in update); excess
  // spawns/extends just retry next frame — traffic fills a hair slower, spike gone.
  let _buildBudget = 0;
  function buildPath(seg, origin, reverse) {
    if (_buildBudget <= 0) return null;
    _buildBudget--;
    const wpts = seg.points;
    const N = wpts && wpts.length;
    if (!N || N < 2) return null;
    if (reverse == null) reverse = Math.random() < 0.5;
    // Ordered world point at index k WITHOUT the slice().reverse()/map() throwaway arrays (buildPath runs
    // hot in busy areas — those two allocations per call were the traffic GC feeder).
    const ox = origin.x, oz = origin.z;
    const wp = (k) => wpts[reverse ? N - 1 - k : k];
    const pts = [];
    let len = 0;
    for (let i = 0; i < N; i++) {
      const pa = wp(i > 0 ? i - 1 : 0), pb = wp(i < N - 1 ? i + 1 : N - 1), pc = wp(i);
      let dx = -(pb.x - pa.x), dz = pb.y - pa.y;        // physics frame: X negated, world.y → z
      const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
      const rx = dz, rz = -dx;
      const px = -(pc.x - ox) + rx * LANE_OFFSET;
      const pz = (pc.y - oz) + rz * LANE_OFFSET;
      const y = groundY(pc.x, pc.y);
      if (i > 0) len += Math.hypot(px - pts[i - 1].x, pz - pts[i - 1].z);
      pts.push({ x: px, y, z: pz });
    }
    if (len < 8) return null;
    const baseSpeed = SPEED_BY_TYPE[seg.highwayType] ?? 8;
    const first = wp(0), last = wp(N - 1);
    // startW/endW = world coords of the centreline ends, used to chain onto connecting roads.
    return {
      pts, len, speed: baseSpeed * (0.8 + Math.random() * 0.35),
      startWx: first.x, startWz: first.y,
      endWx: last.x, endWz: last.y,
    };
  }

  // Chain the car onto a connected road at its current path end, so it drives through intersections
  // instead of vanishing at the segment end. Appends the best forward-continuation to car.path.pts.
  const CONNECT_DIST = 9;    // m (world) — endpoints this close count as connected
  const MAX_PATH_PTS = 320;  // cap runaway path growth
  function extendPath(car, origin) {
    const path = car.path;
    if (path.endWx == null || path.pts.length > MAX_PATH_PTS) return false;
    const segs = getRoadSegments?.();
    if (!segs || !segs.length) return false;
    const ex = path.endWx, ez = path.endWz;
    const pts = path.pts, n = pts.length;
    // current heading at the end (physics frame)
    let hx = pts[n - 1].x - pts[n - 2].x, hz = pts[n - 1].z - pts[n - 2].z;
    const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;

    // ── T-1 · CHOOSE A TURN, DO NOT ALWAYS TAKE THE STRAIGHTEST ────────────────────────────────
    // This used to keep whichever continuation had the highest dot with the current heading, so at
    // every crossroads a car went straight whenever straight existed. Turns were permitted — the
    // 0.15 floor allows up to ~81° — but could never WIN. User: "all cars just move stright no
    // turns and all", and that greedy max is the whole reason.
    //
    // Now every valid continuation is collected and one is chosen by WEIGHT. Straight stays the
    // most likely because it is in reality, but a turn is genuinely possible, which is what makes a
    // grid read as a city rather than a set of parallel conveyor belts.
    //
    // The per-frame `_extendBudget` is untouched: this changes which candidate is kept, not how
    // many `buildPath` calls happen.
    const cands = [];
    for (const seg of segs) {
      if (!DRIVABLE.has(seg.highwayType) || !seg.points || seg.points.length < 2) continue;
      const p0 = seg.points[0], pL = seg.points[seg.points.length - 1];
      let reverse;
      if (Math.hypot(p0.x - ex, p0.y - ez) < CONNECT_DIST) reverse = false;      // start connects → forward
      else if (Math.hypot(pL.x - ex, pL.y - ez) < CONNECT_DIST) reverse = true;  // end connects → reversed
      else continue;
      const cont = buildPath(seg, origin, reverse);
      if (!cont || cont.pts.length < 2) continue;
      let cdx = cont.pts[1].x - cont.pts[0].x, cdz = cont.pts[1].z - cont.pts[0].z;
      const cl2 = Math.hypot(cdx, cdz) || 1; cdx /= cl2; cdz /= cl2;
      const dot = cdx * hx + cdz * hz;
      if (dot <= 0.15) continue;                      // still no U-turns
      // Weight by how straight it is, but never to zero: straight ~3x a sharp turn rather than
      // always winning. `cross` tells left from right, kept so the turn can be signalled later.
      const cross = hx * cdz - hz * cdx;
      cands.push({ cont, dot, cross, w: 0.35 + dot * dot * 2.4 });
    }
    if (!cands.length) return false;
    let best = null;
    if (cands.length === 1) {
      best = cands[0].cont;
    } else {
      let total = 0;
      for (const c of cands) total += c.w;
      let r = Math.random() * total;
      for (const c of cands) { r -= c.w; if (r <= 0) { best = c.cont; car._turnDot = c.dot; break; } }
      if (!best) { best = cands[cands.length - 1].cont; car._turnDot = cands[cands.length - 1].dot; }
    }
    if (!best) return false;
    for (let i = 1; i < best.pts.length; i++) path.pts.push(best.pts[i]); // skip dup join point
    path.endWx = best.endWx; path.endWz = best.endWz;
    return true;
  }

  function spawnCar(playerPx, playerPz, origin) {
    if (!_pool || !_freeSlots.length) return false;
    const segs = getRoadSegments();
    if (!segs || !segs.length) return false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const seg = segs[(Math.random() * segs.length) | 0];
      if (!DRIVABLE.has(seg.highwayType) || !seg.points || seg.points.length < 2) continue;
      const path = buildPath(seg, origin);
      if (!path) continue;
      const order = path.pts.map((_, i) => i);
      for (let k = order.length - 1; k > 0; k--) { const j = (Math.random() * (k + 1)) | 0; [order[k], order[j]] = [order[j], order[k]]; }
      let startIdx = -1;
      for (const i of order) {
        const sp = path.pts[i];
        const dist = Math.hypot(sp.x - playerPx, sp.z - playerPz);
        if (dist < SPAWN_MIN || dist > SPAWN_MAX) continue;
        // don't spawn on top of an existing car (that's what deadlocks the whole fleet)
        let tooClose = false;
        for (const o of cars) { if ((o._x - sp.x) ** 2 + (o._z - sp.z) ** 2 < SPAWN_GAP * SPAWN_GAP) { tooClose = true; break; } }
        if (tooClose) continue;
        startIdx = i; break;
      }
      if (startIdx < 0 || startIdx >= path.pts.length - 1) continue;

      const tplIdx = (Math.random() * _dims.length) | 0;
      const dims = _dims[tplIdx];
      // No mesh, no material, no scene.add: the car takes one of the pool slots reserved at load
      // and is published by placeCar(). Despawning hands the slot straight back.
      const slot = _freeSlots.pop();

      const hw = dims.w / 2, hh = dims.h / 2, hl = dims.l / 2;
      const sw = dims.w * 1.08, sl = dims.l * 1.04;
      const body = new CANNON.Body({ mass: 0 });
      body.addShape(new CANNON.Box(new CANNON.Vec3(hw, hh, hl)));
      body.collisionFilterGroup = COLLISION_GROUP_WORLD;
      body.collisionFilterMask = COLLISION_GROUP_VEHICLE;
      world.addBody(body);

      // Colour is chosen ONCE at spawn and carried on the car. Deriving it per frame from the slot
      // id would repaint a car every time a slot was recycled, which reads as flickering traffic.
      cars.push({ slot, body, path, idx: startIdx, frac: 0, speed: path.speed, cur: path.speed, hh, sw, sl, tplIdx,
                  hw, hl,   // V-12: the contact test needs real half-extents, not a radius
                  bodyColor: bodyColorFor(_colorSeed++) });
      return true;
    }
    return false;
  }

  function removeCar(car) {
    // Nothing is disposed here on purpose: geometry, material and the pool slot are all SHARED and
    // outlive the car. The slot is hidden and returned so the next spawn reuses it.
    if (_pool) { _pool.hide(car.slot); _freeSlots.push(car.slot); }
    world.removeBody(car.body);
  }

  function update(playerPx, playerPz, dt, carSpeedKmh = 0, playerYaw = 0) {
    if (!_enabled || !world) return;
    const origin = getOrigin();
    const d = Math.min(dt || 0.016, 0.05);
    // Per-frame budgets: cap path-extensions AND total path builds so a burst of spawns/extends can't spike.
    // Cached per frame, not per car: the getter is epoch-cached in tileManager but the physics-frame
    // conversion is not, and doing it 28 times over would be pointless.
    _signals = getTrafficSignals?.() || null;
    _signalTime = signalNow();   // the clock the LAMPS show — never a second one, see signalNow()
    let _extendBudget = 2;
    _buildBudget = 4;   // total buildPath() calls allowed this frame (shared by spawn + extend)
    // The light buffer is rewritten wholesale every frame from the cars that survive this update.
    lights.begin();

    // Pass 1: current position + heading of every car
    for (const car of cars) {
      if (car.shoved) { car._x = car._sx; car._z = car._sz; car._dx = 0; car._dz = 0; continue; }
      const pts = car.path.pts;
      const i = Math.max(0, Math.min(car.idx, pts.length - 2));
      const a = pts[i], b = pts[i + 1];
      car._x = a.x + (b.x - a.x) * car.frac;
      car._z = a.z + (b.z - a.z) * car.frac;
      let dx = b.x - a.x, dz = b.z - a.z; const l = Math.hypot(dx, dz) || 1;
      car._dx = dx / l; car._dz = dz / l;
    }

    for (let c = cars.length - 1; c >= 0; c--) {
      const car = cars[c];

      // ── shoved car: slide with friction + spin, then despawn (no longer follows the road) ──
      if (car.shoved) {
        car.shoveT += d;
        const fr = Math.pow(0.12, d);
        car.svx *= fr; car.svz *= fr;
        car._sx += car.svx * d; car._sz += car.svz * d; car.syaw += car.sspin * d;
        placeCar(car, car._sx, car._sy, car._sz, car.syaw);
        car.body.position.set(car._sx, car._sy + car.hh, car._sz);
        car.body.quaternion.setFromAxisAngle(YAXIS, car.syaw);
        contactShadows?.add(car._sx, car._sy, car._sz, car.sw, car.sl, car.syaw);
        if (car.shoveT > 4 || Math.hypot(car._sx - playerPx, car._sz - playerPz) > DESPAWN) { removeCar(car); cars.splice(c, 1); }
        continue;
      }

      const pts = car.path.pts;
      const cx = car._x, cz = car._z, fdx = car._dx, fdz = car._dz;

      // Pass-by whoosh: fire once as a car enters the pass radius, panned by side, louder the faster the pass.
      {
        const pdx = cx - playerPx, pdz = cz - playerPz;
        const pdist = Math.hypot(pdx, pdz);
        car._passCd = (car._passCd || 0) - d;
        if (pdist < PASS_DIST && (car._prevDist || 99) >= PASS_DIST && car._passCd <= 0 && (Math.abs(carSpeedKmh) > 8 || car.cur > 2)) {
          audio.whoosh(pdx / PASS_DIST, 0.45 + Math.min(0.65, (Math.abs(carSpeedKmh) + car.cur * 3.6) / 110));
          car._passCd = 1.2;
        }
        car._prevDist = pdist;
      }

      // stop if the lane ahead is blocked (player or another car)
      let blocked = false;
      {
        const tx = playerPx - cx, tz = playerPz - cz;
        const ahead = tx * fdx + tz * fdz;
        if (ahead > 0.5 && ahead < STOP_DIST && Math.abs(-tx * fdz + tz * fdx) < LANE_HALF) blocked = true;
      }
      if (!blocked) {
        for (const o of cars) {
          if (o === car || o.shoved) continue;
          const tx = o._x - cx, tz = o._z - cz;
          const ahead = tx * fdx + tz * fdz;
          if (ahead <= 0.5 || ahead > STOP_DIST) continue;
          if (Math.abs(-tx * fdz + tz * fdx) < LANE_HALF) { blocked = true; break; }
        }
      }
      // ── T-1b · SLOW INTO THE CORNER ─────────────────────────────────────────────────────────
      // Without this a car takes a 75° turn at trunk speed and the kinematic stepper simply
      // teleports it round the corner — it reads as a skid, or worse, as the car clipping through
      // the junction. `_turnDot` is set by extendPath when it picks a continuation: 1 is dead
      // straight, ~0.2 is a hard turn.
      //
      // Decays over `_turnSlowT` rather than ending at the corner, so the car accelerates OUT of
      // the turn instead of snapping back to cruise the instant the geometry straightens.
      if (car._turnDot != null && car._turnDot < 0.86) {
        car._turnSlow = 0.45 + car._turnDot * 0.55;   // hard turn ~0.56x, gentle bend ~0.92x
        car._turnSlowT = 2.4;
        car._turnDot = null;
      }
      let cornerCap = 1;
      if (car._turnSlowT > 0) {
        car._turnSlowT -= d;
        cornerCap = car._turnSlow;
        if (car._turnSlowT <= 0) car._turnSlow = 1;
      }
      // ── T-3 · red light ────────────────────────────────────────────────────────────────────
      // Same cheap shape as the blocked-ahead test: project the signal into the car's heading and
      // take the nearest one in the window. ~134 signals x 28 cars is a few thousand adds a frame,
      // which does not register beside terrain and buildings (see traffic-realism-plan.md).
      let atRed = false;
      if (_signals && _signals.length) {
        for (let si = 0; si < _signals.length; si++) {
          const sg = _signals[si];
          // Signals are published in WORLD coords; cars run in the physics frame.
          const sx = -(sg.x - origin.x), sz = sg.z - origin.z;
          const ax = sx - cx, az = sz - cz;
          const ahead = ax * fdx + az * fdz;
          if (ahead < SIGNAL_NEAR_M || ahead > SIGNAL_LOOK_M) continue;
          if (Math.abs(-ax * fdz + az * fdx) > SIGNAL_LAT_M) continue;
          if (isRedFor(sg.axis, _signalTime)) { atRed = true; break; }
        }
      }
      const target = (blocked || atRed) ? 0 : car.speed * cornerCap;
      car.cur += (target - car.cur) * Math.min(1, 5 * d);
      // anti-deadlock: clear a car stuck at ~0 too long — but ONLY if it's far from the player, so a
      // car you're blocking (stopped right in front of you) never vanishes in view.
      if (car.cur < 0.6) {
        car.stopT = (car.stopT || 0) + d;
        const farFromPlayer = (cx - playerPx) ** 2 + (cz - playerPz) ** 2 > 45 * 45;
        if (car.stopT > DEADLOCK_T && farFromPlayer) { removeCar(car); cars.splice(c, 1); continue; }
      } else car.stopT = 0;

      // Near the path end → chain onto a connected road so the car drives through the intersection
      // instead of vanishing. Cooldown so a dead-end car doesn't rescan every frame.
      if (car.idx >= pts.length - 2) {
        car.extendCd = (car.extendCd || 0) - d;
        if (car.extendCd <= 0 && _extendBudget > 0) {
          _extendBudget--;
          if (!extendPath(car, origin)) car.extendCd = 0.5;
        }
      }

      let remaining = car.cur * d;
      while (remaining > 0 && car.idx < pts.length - 1) {
        const a = pts[car.idx], b = pts[car.idx + 1];
        const segLen = Math.hypot(b.x - a.x, b.z - a.z) || 0.001;
        const stepLeft = segLen * (1 - car.frac);
        if (remaining < stepLeft) { car.frac += remaining / segLen; remaining = 0; }
        else { remaining -= stepLeft; car.idx++; car.frac = 0; }
      }
      if (car.idx >= pts.length - 1) {
        // Reached the end with no continuation. Despawn only if far; near the player, U-turn so it
        // never vanishes in view (rare — only true dead-ends / unconnected ends).
        const far = (cx - playerPx) ** 2 + (cz - playerPz) ** 2 > 45 * 45;
        if (far) { removeCar(car); cars.splice(c, 1); continue; }
        pts.reverse();
        const sWx = car.path.startWx, sWz = car.path.startWz;
        car.path.startWx = car.path.endWx; car.path.startWz = car.path.endWz;
        car.path.endWx = sWx; car.path.endWz = sWz;
        car.idx = 0; car.frac = 0;
      }

      const a = pts[car.idx], b = pts[car.idx + 1];
      const x = a.x + (b.x - a.x) * car.frac;
      const y = a.y + (b.y - a.y) * car.frac;
      const z = a.z + (b.z - a.z) * car.frac;
      if (Math.hypot(x - playerPx, z - playerPz) > DESPAWN) { removeCar(car); cars.splice(c, 1); continue; }

      const yaw = Math.atan2(b.x - a.x, b.z - a.z);

      // ── hit by the player (fast + close)? shove it aside + stop being an immovable wall ──
      // Either car moving is enough. Gating on the PLAYER's speed alone let a traffic car drive
      // into a parked player and pass clean through — the same "it glides" defect from the other side.
      const approachKmh = Math.max(Math.abs(carSpeedKmh), Math.abs(car.cur) * 3.6);
      if (approachKmh > HIT_MIN_KMH
          && obbOverlap(x - playerPx, z - playerPz, yaw, car.hw, car.hl,
                        playerYaw, PLAYER_HALF_W, PLAYER_HALF_L, CONTACT_MARGIN)) {
        const dx = x - playerPx, dz = z - playerPz, dl = Math.hypot(dx, dz) || 1;
        const mps = Math.min(Math.abs(carSpeedKmh) / 3.6, 25);
        car.shoved = true; car.shoveT = 0;
        car._sx = x; car._sy = y; car._sz = z; car.syaw = yaw;
        // Shove scales with impact speed (gentle bump → gentle nudge, fast hit → big shove) instead of a
        // fixed kick, so low-speed contact pushes the car a little rather than dead-stopping the player.
        const push = mps * 0.8 + 1.3;
        car.svx = (dx / dl) * push; car.svz = (dz / dl) * push;
        car.sspin = (Math.random() - 0.5) * Math.min(4, mps * 0.9);
        car.body.collisionResponse = false; // player plows through it rather than dead-stopping
        // The collider is off from here, so the player would feel NOTHING without this. Reported
        // once, at contact, rather than left to the solver — letting the solver do it is what
        // produced the stutter and the repeated camera punches.
        onPlayerHit?.(-dx / dl, -dz / dl, approachKmh);
        continue;
      }

      placeCar(car, x, y, z, yaw);
      car.body.position.set(x, y + car.hh, z);
      car.body.quaternion.setFromAxisAngle(YAXIS, yaw);
      contactShadows?.add(x, y, z, car.sw, car.sl, yaw);
    }

    if (cars.length < MAX_CARS) {
      for (let s = 0; s < SPAWN_PER_FRAME && cars.length < MAX_CARS; s++) {
        if (!spawnCar(playerPx, playerPz, origin)) break;
      }
    }

    lights.commit();   // publish the head/tail quads gathered by placeCar() above
  }

  function setEnabled(on) {
    _enabled = on;
    if (!on) {
      for (const car of cars) removeCar(car); cars.length = 0;
      lights.begin(); lights.commit();   // no cars left → no light quads
    }
  }
  function getCount() { return cars.length; }
  function dispose() {
    for (const car of cars) removeCar(car);
    cars.length = 0;
    // Hand the reserved slots back to the SHARED fleet — this system is going away, the pool is not.
    // release() uses the pool's own free list; BatchedMesh.deleteInstance is never called (H3).
    if (_pool) for (const id of _freeSlots) _pool.release(id);
    _freeSlots = [];
    lights.dispose();
  }

  return { update, setEnabled, getCount, dispose };
}
