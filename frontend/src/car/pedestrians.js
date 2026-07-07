/**
 * Pedestrians — real low-poly people with a WALK-CYCLE FLIPBOOK, instanced (light crowd).
 *
 * Each character is baked into N static walk-frames + one idle pose (carModels.loadPeopleWalkTemplates).
 * There's one InstancedMesh per (character × frame) and per (character, idle); each frame we route every
 * pedestrian into the InstancedMesh matching its current walk-cycle frame → legs actually move, while the
 * whole crowd stays instanced/cheap. A pool is assigned to sidewalk lines near the player and slides along.
 *
 * Frame: physics frame (added to `scene`). World→physics: px = -(wx - origin.x), pz = wz - origin.z.
 */
import * as THREE from 'three';
import { loadPeopleWalkTemplates } from './carModels.js';
import { audio } from '../audio/audioManager.js';

const WALKABLE = new Set([
  'residential', 'living_street', 'unclassified', 'pedestrian', 'footway',
  'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link',
]);
const HALFW_BY_TYPE = {
  residential: 4, living_street: 3.5, unclassified: 4, pedestrian: 2, footway: 1.5,
  tertiary: 4.5, tertiary_link: 4, secondary: 5.5, secondary_link: 4.5, primary: 6.5, primary_link: 5,
};

const FRAMES       = 8;
const PED_CAP      = 168;  // trimmed ~20% for perf (instanced flipbook)
const CAP_PER_CELL = 45;   // per (variant × frame) InstancedMesh
const RANGE        = 150;
const REBUILD_DIST = 40;
const SIDEWALK_PAD = 1.9;
const WALK_MIN = 0.9, WALK_MAX = 1.6;
const IDLE_FRAC = 0.25;
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

export function createPedestrians({ scene, getRoadSegments, getGroundY, getOrigin, contactShadows }) {
  let variants = [];   // [{ walk:[InstancedMesh×FRAMES], idle:InstancedMesh }]
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
        scene.add(im);
        return im;
      };
      return { walk: t.frames.map(mk), idle: mk(t.idle), fall: t.fall ? mk(t.fall) : null };
    });
    nVar = variants.length;
  }).catch((e) => console.warn('[pedestrians] load error', e?.message || e));

  const peds = [];
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _p = new THREE.Vector3();
  let _lastX = Infinity, _lastZ = Infinity, _time = 0;

  function spawnPed(c) {
    const idle = Math.random() < IDLE_FRAC;
    peds.push({
      ax: c.ax, az: c.az, bx: c.bx, bz: c.bz, len: c.len, y0: c.y0, y1: c.y1,
      t: Math.random(), dir: Math.random() < 0.5 ? 1 : -1,
      speed: idle ? 0 : WALK_MIN + Math.random() * (WALK_MAX - WALK_MIN),
      cyc: Math.random(), yaw: Math.random() * Math.PI * 2,
      variant: (Math.random() * nVar) | 0,
    });
  }

  // Incremental reassignment: keep people who are still in range (so a pedestrian you're driving toward
  // stays put instead of being wiped and replaced), cull only those who've left range, and top up new
  // ones out in the distance. Full wipe-and-respawn was the cause of pedestrians vanishing on approach.
  const NEAR_SPAWN_2 = 30 * 30; // don't spawn newcomers within 30m of the player (avoids pop-in nearby)
  function reassign(playerPx, playerPz) {
    const segs = getRoadSegments?.();
    if (!segs || !nVar) return;   // keep existing crowd if road data is momentarily unavailable
    const origin = getOrigin();
    const R2 = RANGE * RANGE;

    // Cull pedestrians who have walked out of range (thrown bodies finish their knockdown first).
    for (let i = peds.length - 1; i >= 0; i--) {
      const p = peds[i];
      if (p.thrown) continue;
      const cx = p.ax + (p.bx - p.ax) * p.t;
      const cz = p.az + (p.bz - p.az) * p.t;
      if ((cx - playerPx) ** 2 + (cz - playerPz) ** 2 > R2) peds.splice(i, 1);
    }

    const cand = [];
    for (const seg of segs) {
      if (!WALKABLE.has(seg.highwayType) || !seg.points || seg.points.length < 2) continue;
      const halfW = (seg.width && seg.width > 1) ? seg.width / 2 : (HALFW_BY_TYPE[seg.highwayType] ?? 4);
      const off = halfW + SIDEWALK_PAD;
      // Whole-segment bbox cull (physics frame) — skip far roads before the inner walk + getGroundY calls.
      let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;
      for (const p of seg.points) { const x = -(p.x - origin.x), z = p.y - origin.z; if (x < mnX) mnX = x; if (x > mxX) mxX = x; if (z < mnZ) mnZ = z; if (z > mxZ) mxZ = z; }
      const cddx = Math.max(mnX - playerPx, 0, playerPx - mxX), cddz = Math.max(mnZ - playerPz, 0, playerPz - mxZ);
      if (cddx * cddx + cddz * cddz > R2) continue;
      for (let s = 0; s < seg.points.length - 1; s++) {
        const ax = -(seg.points[s].x - origin.x), az = seg.points[s].y - origin.z;
        const bx = -(seg.points[s + 1].x - origin.x), bz = seg.points[s + 1].y - origin.z;
        if (((ax + bx) / 2 - playerPx) ** 2 + ((az + bz) / 2 - playerPz) ** 2 > R2) continue;
        let dx = bx - ax, dz = bz - az; const len = Math.hypot(dx, dz);
        if (len < 4) continue;
        dx /= len; dz /= len;
        const rx = dz, rz = -dx;
        const cy0 = getGroundY ? (getGroundY(seg.points[s].x, seg.points[s].y) ?? 0) : 0;
        const cy1 = getGroundY ? (getGroundY(seg.points[s + 1].x, seg.points[s + 1].y) ?? 0) : 0;
        cand.push({ ax: ax + rx * off, az: az + rz * off, bx: bx + rx * off, bz: bz + rz * off, len, y0: cy0, y1: cy1 });
        cand.push({ ax: ax - rx * off, az: az - rz * off, bx: bx - rx * off, bz: bz - rz * off, len, y0: cy0, y1: cy1 });
      }
    }
    if (!cand.length) return;

    // Prefer far candidates for newcomers so they appear in the distance, not right next to the car.
    const farCand = cand.filter((c) => ((c.ax + c.bx) / 2 - playerPx) ** 2 + ((c.az + c.bz) / 2 - playerPz) ** 2 > NEAR_SPAWN_2);
    const pool = farCand.length ? farCand : cand;

    const target = Math.min(PED_CAP, Math.max(0, Math.round(cand.length * 0.5)));
    let guard = 0;
    while (peds.length < target && guard++ < target * 3) {
      spawnPed(pool[(Math.random() * pool.length) | 0]);
    }
  }

  function update(playerPx, playerPz, dt, carSpeedKmh = 0) {
    if (!_enabled || !nVar) return;
    const d = Math.min(dt || 0.016, 0.05);
    _time += d;
    if ((playerPx - _lastX) ** 2 + (playerPz - _lastZ) ** 2 > REBUILD_DIST * REBUILD_DIST) {
      _lastX = playerPx; _lastZ = playerPz; reassign(playerPx, playerPz);
    }
    for (const v of variants) { for (const im of v.walk) im.count = 0; v.idle.count = 0; if (v.fall) v.fall.count = 0; }

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

      // ── walking / idle ──
      let yaw = p.yaw, im;
      const onLine_x = p.ax + (p.bx - p.ax) * p.t;
      const onLine_z = p.az + (p.bz - p.az) * p.t;
      const y = p.y0 + (p.y1 - p.y0) * p.t;

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

      if (p.speed > 0 || panicking) {
        if (!panicking) {
          p.t += (p.dir * p.speed * d) / p.len;
          if (p.t > 1) { p.t = 1; p.dir = -1; } else if (p.t < 0) { p.t = 0; p.dir = 1; }
          yaw = Math.atan2((p.bx - p.ax) * p.dir, (p.bz - p.az) * p.dir);
        } else if (p.dodgeX || p.dodgeZ) {
          yaw = Math.atan2(p.dodgeX, p.dodgeZ); // face the way they're bolting
        }
        const cycRate = panicking ? 2.6 : (p.speed / 1.4); // run-cadence flipbook while panicking
        p.cyc = (p.cyc + cycRate * d) % 1;
        im = V.walk[Math.min(FRAMES - 1, (p.cyc * FRAMES) | 0)];
      } else { im = V.idle; }

      const x = onLine_x + p.dodgeX;
      const z = onLine_z + p.dodgeZ;

      // ── hit by the car? (checked at the DODGED position — a ped who clears in time escapes) ──
      if (canHit && (x - playerPx) ** 2 + (z - playerPz) ** 2 < HIT_RADIUS * HIT_RADIUS) {
        const dx = x - playerPx, dz = z - playerPz, dl = Math.hypot(dx, dz) || 1;
        const mps = Math.min(Math.abs(carSpeedKmh) / 3.6, 22);
        p.thrown = true; p.age = 0; p.landed = false;
        if (Math.random() < 0.45) audio.shout();  // only some yelp — random so it isn't every hit (also self-throttled)
        p.x = x; p.y = y; p.z = z; p.gy = y;
        p.vx = (dx / dl) * (mps * 0.55 + 2); p.vz = (dz / dl) * (mps * 0.55 + 2); p.vy = 3 + mps * 0.22;
        p.axis = new THREE.Vector3(Math.random() - 0.5, 0.25, Math.random() - 0.5).normalize();
        p.spin = 6 + Math.random() * 7; p.ang = 0; p.restYaw = Math.random() * Math.PI * 2;
        continue;
      }

      if (im.count >= CAP_PER_CELL) continue;
      _q.setFromAxisAngle(YAXIS, yaw);
      _p.set(x, y, z);
      _m.compose(_p, _q, _s);
      im.setMatrixAt(im.count++, _m);
      contactShadows?.add(x, y, z, 0.7, 0.7); // small round contact shadow
    }
    if (anyDead) for (let i = peds.length - 1; i >= 0; i--) if (peds[i].dead) peds.splice(i, 1);

    for (const v of variants) {
      for (const im of v.walk) if (im.count) im.instanceMatrix.needsUpdate = true;
      if (v.idle.count) v.idle.instanceMatrix.needsUpdate = true;
      if (v.fall && v.fall.count) v.fall.instanceMatrix.needsUpdate = true;
    }
  }

  function setEnabled(on) {
    _enabled = on;
    for (const v of variants) {
      for (const im of v.walk) { im.visible = on; if (!on) im.count = 0; }
      v.idle.visible = on; if (!on) v.idle.count = 0;
      if (v.fall) { v.fall.visible = on; if (!on) v.fall.count = 0; }
    }
    if (!on) peds.length = 0;
  }
  function getCount() { let n = 0; for (const v of variants) { for (const im of v.walk) n += im.count; n += v.idle.count; if (v.fall) n += v.fall.count; } return n; }
  function dispose() {
    for (const v of variants) {
      for (const im of v.walk) { scene.remove(im); im.geometry.dispose(); }
      scene.remove(v.idle); v.idle.geometry.dispose();
      if (v.fall) { scene.remove(v.fall); v.fall.geometry.dispose(); }
    }
    variants = [];
  }

  return { update, setEnabled, getCount, dispose };
}
