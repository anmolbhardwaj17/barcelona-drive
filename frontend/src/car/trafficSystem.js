/**
 * AI traffic — lightweight NPC cars that drive the loaded road network.
 *
 * Cars follow a road's centerline (tileManager.getLoadedRoadSegments) offset into the right lane,
 * kinematically (no per-car vehicle physics). Each carries a STATIC box collider (WORLD/VEHICLE) so
 * the PLAYER collides with it; they also STOP when the lane ahead is blocked (by the player or another
 * car). Pool of MAX_CARS near the player; spawn in a ring, despawn far / at road end. v1 doesn't chain
 * junctions (recorded follow-up).
 *
 * Visual: the Kenney low-poly city cars (via carModels.js) — a random variant per car, geometry+material
 * shared across cars of that variant, so the fleet is cheap. Frame: physics frame (added to `scene`).
 * World→physics: px = -(wx - origin.x), pz = wz - origin.z. Road point = {x:wx, y:wz}.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLLISION_GROUP_WORLD, COLLISION_GROUP_VEHICLE } from '../collisionGroups.js';
import { loadCityCarTemplates } from './carModels.js';
import { audio } from '../audio/audioManager.js';

// Per-car body tint (multiplies the white-based Kenney texture → body takes this colour, while the dark
// window texels + black wheel vertex-colours stay dark). Bright automotive palette — no greys (read dead).
const CAR_TINTS = [
  0xE8433A, 0x2E86DE, 0x27AE60, 0xF39C12, 0xF1C40F,
  0xEcECEC, 0x8E44AD, 0x16A085, 0xD35400, 0x2C3E50,
  0xC0392B, 0x3498DB, 0xffffff, 0x1ABC9C, 0xE67E22,
];
// Liveried models carry their own paint in the texture (taxi=yellow/black, police, delivery) — leave
// them white-based so the authored livery shows through instead of being tint-shifted.
const LIVERIED = new Set(['taxi', 'police', 'delivery']);

const PASS_DIST = 5.5; // m — a traffic car entering this radius fires a pass-by whoosh

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

const MAX_CARS    = 28;   // full-detail clones — modest bump (watch FPS); busier roads
const SPAWN_MIN   = 32;
const SPAWN_MAX   = 185;
const DESPAWN     = 240;
const LANE_OFFSET = 2.2;
const SPAWN_PER_FRAME = 2;
const SPAWN_GAP   = 16;   // m — don't spawn within this of another car (avoids spawn-cluster deadlock)
const STOP_DIST = 7;      // m — brake if something is this close ahead in-lane
const LANE_HALF = 2.0;    // m — lateral tolerance for "in my lane"
const DEADLOCK_T = 5;     // s stuck at ~0 speed before we despawn a jammed car
const HIT_RADIUS  = 3.4;  // m — player this close + moving → shove the car aside
const HIT_MIN_KMH = 4;    // shove kicks in at low speed too (was 12 → cars felt like immovable walls on a bump)
const YAXIS = new CANNON.Vec3(0, 1, 0);

const YAXIS3 = new THREE.Vector3(0, 1, 0);

export function createTrafficSystem({ scene, world, getGroundY, getRoadSegments, getOrigin, contactShadows }) {
  const cars = [];
  let _enabled = true;
  let _templates = [];

  // Use the model's OWN textured material — the Kenney atlas already paints each car. We used to multiply a
  // random tint on top, but the full-detail models aren't white-bodied (that assumption was wrong), so the
  // tint over-tinted the already-coloured bodies into muddy shades. Shared per template (never disposed).
  function getCarMaterial(_tplIdx, tpl) {
    return tpl.material;
  }

  // Head/tail lights as TWO shared InstancedMeshes (was 4 loose child meshes per car ≈ 112 draws → 2).
  // Rebuilt each frame from every car's current pose. Big draw-call cut → less per-frame Three.js churn.
  const LIGHT_CAP = MAX_CARS * 2 + 4;
  let headIM = null, tailIM = null, lightLocals = [];
  const _carM = new THREE.Matrix4(), _carP = new THREE.Vector3(), _carQ = new THREE.Quaternion();
  const _one = new THREE.Vector3(1, 1, 1), _lm = new THREE.Matrix4();

  loadCityCarTemplates('/models/cars/', 3.9)
    .then((t) => {
      _templates = t;
      const lightGeo = new THREE.PlaneGeometry(0.28, 0.14);
      const headMat = new THREE.MeshBasicMaterial({ color: 0xfff4d8, side: THREE.DoubleSide, fog: true });
      const tailMat = new THREE.MeshBasicMaterial({ color: 0xff2a12, side: THREE.DoubleSide, fog: true });
      headIM = new THREE.InstancedMesh(lightGeo, headMat, LIGHT_CAP); headIM.frustumCulled = false; headIM.castShadow = false; headIM.count = 0; scene.add(headIM);
      tailIM = new THREE.InstancedMesh(lightGeo, tailMat, LIGHT_CAP); tailIM.frustumCulled = false; tailIM.castShadow = false; tailIM.count = 0; scene.add(tailIM);
      const _tq = new THREE.Quaternion();
      lightLocals = t.map((tpl) => {
        const w = tpl.dims.w, h = tpl.dims.h, l = tpl.dims.l, y = h * 0.42;
        const mk = (x, z, ry) => { const m = new THREE.Matrix4(); _tq.setFromAxisAngle(YAXIS3, ry); m.compose(new THREE.Vector3(x, y, z), _tq, _one); return m; };
        return { head: [mk(-w * 0.30, l * 0.49, 0), mk(w * 0.30, l * 0.49, 0)], tail: [mk(-w * 0.30, -l * 0.49, Math.PI), mk(w * 0.30, -l * 0.49, Math.PI)] };
      });
    })
    .catch((e) => console.warn('[traffic] car models load failed:', e?.message || e));

  // Rebuild the shared light InstancedMeshes from every car's current pose (called once per update).
  function updateLights() {
    if (!headIM || !tailIM) return;
    let hc = 0, tc = 0;
    for (const car of cars) {
      const L = lightLocals[car.tplIdx];
      if (!L) continue;
      _carQ.setFromAxisAngle(YAXIS3, car.mesh.rotation.y);
      _carM.compose(_carP.copy(car.mesh.position), _carQ, _one);
      for (const lm of L.head) { if (hc < LIGHT_CAP) { _lm.multiplyMatrices(_carM, lm); headIM.setMatrixAt(hc++, _lm); } }
      for (const lm of L.tail) { if (tc < LIGHT_CAP) { _lm.multiplyMatrices(_carM, lm); tailIM.setMatrixAt(tc++, _lm); } }
    }
    headIM.count = hc; tailIM.count = tc;
    headIM.instanceMatrix.needsUpdate = true; tailIM.instanceMatrix.needsUpdate = true;
  }

  function groundY(wx, wz) {
    const y = getGroundY ? getGroundY(wx, wz) : 0;
    return Number.isFinite(y) ? y : 0;
  }

  function buildPath(seg, origin, reverse) {
    const wpts = seg.points;
    if (!wpts || wpts.length < 2) return null;
    if (reverse == null) reverse = Math.random() < 0.5;
    const ordered = reverse ? wpts.slice().reverse() : wpts;
    const cl = ordered.map((p) => ({ px: -(p.x - origin.x), pz: p.y - origin.z, wx: p.x, wz: p.y }));
    const pts = [];
    let len = 0;
    for (let i = 0; i < cl.length; i++) {
      const a = cl[Math.max(0, i - 1)], b = cl[Math.min(cl.length - 1, i + 1)];
      let dx = b.px - a.px, dz = b.pz - a.pz;
      const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
      const rx = dz, rz = -dx;
      const px = cl[i].px + rx * LANE_OFFSET;
      const pz = cl[i].pz + rz * LANE_OFFSET;
      const y = groundY(cl[i].wx, cl[i].wz);
      if (i > 0) len += Math.hypot(px - pts[i - 1].x, pz - pts[i - 1].z);
      pts.push({ x: px, y, z: pz });
    }
    if (len < 8) return null;
    const baseSpeed = SPEED_BY_TYPE[seg.highwayType] ?? 8;
    // startW/endW = world coords of the centreline ends, used to chain onto connecting roads.
    return {
      pts, len, speed: baseSpeed * (0.8 + Math.random() * 0.35),
      startWx: cl[0].wx, startWz: cl[0].wz,
      endWx: cl[cl.length - 1].wx, endWz: cl[cl.length - 1].wz,
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

    let best = null, bestDot = 0.15; // require a roughly-forward continuation (rejects U-turn back)
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
      if (dot > bestDot) { bestDot = dot; best = cont; }
    }
    if (!best) return false;
    for (let i = 1; i < best.pts.length; i++) path.pts.push(best.pts[i]); // skip dup join point
    path.endWx = best.endWx; path.endWz = best.endWz;
    return true;
  }

  function spawnCar(playerPx, playerPz, origin) {
    if (!_templates.length) return false;
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

      const tplIdx = (Math.random() * _templates.length) | 0;
      const tpl = _templates[tplIdx];
      // Shared per-(template,tint) material (no per-car clone). Lights are the shared head/tail IMs,
      // rebuilt each frame in updateLights() — not per-car child meshes.
      const mesh = new THREE.Mesh(tpl.geometry, getCarMaterial(tplIdx, tpl));
      mesh.castShadow = false; // grounded by the fake contact shadow instead
      scene.add(mesh);

      const hw = tpl.dims.w / 2, hh = tpl.dims.h / 2, hl = tpl.dims.l / 2;
      const sw = tpl.dims.w * 1.08, sl = tpl.dims.l * 1.04;
      const body = new CANNON.Body({ mass: 0 });
      body.addShape(new CANNON.Box(new CANNON.Vec3(hw, hh, hl)));
      body.collisionFilterGroup = COLLISION_GROUP_WORLD;
      body.collisionFilterMask = COLLISION_GROUP_VEHICLE;
      world.addBody(body);

      cars.push({ mesh, body, path, idx: startIdx, frac: 0, speed: path.speed, cur: path.speed, hh, sw, sl, tplIdx });
      return true;
    }
    return false;
  }

  function removeCar(car) {
    scene.remove(car.mesh);
    // material is the SHARED template material (tpl.material) — do NOT dispose it (other cars reuse it).
    world.removeBody(car.body);
  }

  function update(playerPx, playerPz, dt, carSpeedKmh = 0) {
    if (!_enabled || !world) return;
    const origin = getOrigin();
    const d = Math.min(dt || 0.016, 0.05);
    // Cap path-extensions per frame. extendPath walks ALL road segments; several cars reaching their
    // path-end in one frame used to stack into a ~12ms spike. Excess cars retry next frame — imperceptible
    // (they're mid-junction on a long path), and the spike is gone.
    let _extendBudget = 2;

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
        car.mesh.position.set(car._sx, car._sy, car._sz);
        car.mesh.rotation.y = car.syaw;
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
      const target = blocked ? 0 : car.speed;
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
      if (Math.abs(carSpeedKmh) > HIT_MIN_KMH && (x - playerPx) ** 2 + (z - playerPz) ** 2 < HIT_RADIUS * HIT_RADIUS) {
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
        continue;
      }

      car.mesh.position.set(x, y, z);
      car.mesh.rotation.y = yaw;
      car.body.position.set(x, y + car.hh, z);
      car.body.quaternion.setFromAxisAngle(YAXIS, yaw);
      contactShadows?.add(x, y, z, car.sw, car.sl, yaw);
    }

    if (cars.length < MAX_CARS) {
      for (let s = 0; s < SPAWN_PER_FRAME && cars.length < MAX_CARS; s++) {
        if (!spawnCar(playerPx, playerPz, origin)) break;
      }
    }

    updateLights(); // rebuild the 2 shared head/tail InstancedMeshes from all cars' current poses
  }

  function setEnabled(on) {
    _enabled = on;
    if (!on) {
      for (const car of cars) removeCar(car); cars.length = 0;
      if (headIM) headIM.count = 0; if (tailIM) tailIM.count = 0; // clear shared lights (no cars left)
    }
  }
  function getCount() { return cars.length; }
  function dispose() { for (const car of cars) removeCar(car); cars.length = 0; }

  return { update, setEnabled, getCount, dispose };
}
