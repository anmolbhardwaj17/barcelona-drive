/**
 * objectiveMarker.js — THE objective halo. One implementation, three modes, day AND night.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────────
 * `dashMode`, `taxiMode` and `deliveryMode` each built their own marker out of the same four
 * primitives — a torus, a flat `RingGeometry`, an additive `CylinderGeometry` beam, and a bloom
 * torus in dash's case only. Three copies, drifting: dash had a halo and a 48-segment ground ring,
 * the other two had neither, and the beam sat at a different opacity in each. A fix to one was a
 * fix to one third of the game.
 *
 * ── WHY THEY LOOKED WRONG, MEASURED RATHER THAN GUESSED ───────────────────────────────────────
 * Every part was a flat-coloured `MeshBasicMaterial` at a FIXED opacity with `fog:false`, and the
 * beam was `AdditiveBlending` at 0.16. That is a night-only recipe, shipped into a day/night game:
 *
 *   · ADDITIVE ADDS TO WHAT IS THERE. Against night asphalt (luminance ~0.05) an additive beam is
 *     the whole signal. Against a sunlit Barcelona street (~0.55) it adds 0.16 to something already
 *     near white — mathematically invisible, and where it did register it blew the sky out.
 *   · A HARD-EDGED COLUMN. The beam is an open-ended cylinder with uniform alpha, so it ends in a
 *     straight line 90 m up. Nothing in this game has a straight edge in the air.
 *   · A RING WITH NO FALLOFF. `RingGeometry(r*0.9, r*1.25)` is a flat annulus at constant alpha —
 *     a decal of a ring, not light pooling on a road.
 *   · NO DISTANCE BEHAVIOUR. The beam is a LOCATOR: it earns its cost at 200 m and actively hides
 *     the thing you are trying to reach at 15 m. It was drawn at full strength at both.
 *
 * So the marker is rebuilt around gradient textures (soft falloff everywhere), a day/night profile
 * that changes BLENDING as well as opacity, and distance response. `setNight()` is driven from
 * `envToggle`, and read once at construction — a marker built after the player has already switched
 * to night must not come up in the day profile.
 *
 * Scene frame. Callers pass SCENE coordinates; the world→physics mirror is the mode's business.
 */
import * as THREE from 'three';
import { onNightModeChange, isNightMode } from '../ui/envToggle.js';

// ── ONE subscription for every marker in the game ───────────────────────────────────────────────
// `onNightModeChange` has no unsubscribe, and dash builds a fresh marker per gate on every run — so
// a per-marker subscription is a leak that grows with how much the player plays. A module-level
// registry keeps exactly one callback alive for the process, and `dispose()` actually removes the
// marker from it.
const _live = new Set();
let _night = false;
let _subscribed = false;
function _ensureSubscribed() {
  if (_subscribed) return;
  _subscribed = true;
  _night = isNightMode();
  onNightModeChange((n) => { _night = !!n; for (const m of _live) m.setNight(_night); });
}

// ── Shared textures. Built once, on first use; every marker in the game shares them. ────────────
let _poolTex = null, _beamTex = null, _ringTex = null;

/** Radial falloff, bright core → nothing. This is what makes it read as light on a road. */
function poolTexture() {
  if (_poolTex) return _poolTex;
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  // Hole in the middle: the objective is a place you look AT, so the brightest band is the rim,
  // not the centre. A solid disc reads as a spotlight pointed down; a ring of light reads as a mark
  // on the ground.
  rg.addColorStop(0.00, 'rgba(255,255,255,0.30)');
  rg.addColorStop(0.42, 'rgba(255,255,255,0.16)');
  rg.addColorStop(0.72, 'rgba(255,255,255,1.00)');
  rg.addColorStop(0.86, 'rgba(255,255,255,0.42)');
  rg.addColorStop(1.00, 'rgba(255,255,255,0.00)');
  g.fillStyle = rg; g.fillRect(0, 0, S, S);
  _poolTex = new THREE.CanvasTexture(c);
  _poolTex.colorSpace = THREE.SRGBColorSpace;
  return _poolTex;
}

/** Vertical alpha ramp for the beam: dense at the road, gone before the top. Kills the straight edge. */
function beamTexture() {
  if (_beamTex) return _beamTex;
  const H = 128, c = document.createElement('canvas'); c.width = 4; c.height = H;
  const g = c.getContext('2d');
  const lg = g.createLinearGradient(0, H, 0, 0);   // v=0 at the bottom of the cylinder
  lg.addColorStop(0.00, 'rgba(255,255,255,1.00)');
  lg.addColorStop(0.10, 'rgba(255,255,255,0.80)');
  lg.addColorStop(0.45, 'rgba(255,255,255,0.24)');
  lg.addColorStop(1.00, 'rgba(255,255,255,0.00)');
  g.fillStyle = lg; g.fillRect(0, 0, 4, H);
  _beamTex = new THREE.CanvasTexture(c);
  _beamTex.colorSpace = THREE.SRGBColorSpace;
  return _beamTex;
}

/** Soft-edged band for the ring itself — a torus with a hard silhouette reads as plastic. */
function ringTexture() {
  if (_ringTex) return _ringTex;
  const S = 64, c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d');
  const lg = g.createLinearGradient(0, 0, 0, S);
  lg.addColorStop(0.00, 'rgba(255,255,255,0.15)');
  lg.addColorStop(0.50, 'rgba(255,255,255,1.00)');
  lg.addColorStop(1.00, 'rgba(255,255,255,0.15)');
  g.fillStyle = lg; g.fillRect(0, 0, S, S);
  _ringTex = new THREE.CanvasTexture(c);
  _ringTex.colorSpace = THREE.SRGBColorSpace;
  return _ringTex;
}

// ── Day / night profiles ────────────────────────────────────────────────────────────────────────
//
// The BLENDING differs, not just the numbers, and that is the whole point. Additive is correct at
// night (there is nothing under it to wash out) and wrong in daylight (it adds to a surface already
// near white). Daylight gets alpha blending and a deeper, more saturated colour so the mark reads
// as paint-and-glow against bright asphalt; night gets additive and a brighter core so it blooms.
const PROFILE = {
  day: {
    poolOpacity: 0.62, poolBlend: THREE.NormalBlending, poolScale: 1.00,
    ringOpacity: 0.95, haloOpacity: 0.30, haloBlend: THREE.NormalBlending,
    beamOpacity: 0.16, beamBlend: THREE.NormalBlending,
    colorMul: 0.88,        // sit the hue DOWN against a bright ground rather than clipping to white
  },
  night: {
    poolOpacity: 0.95, poolBlend: THREE.AdditiveBlending, poolScale: 1.28,
    ringOpacity: 1.00, haloOpacity: 0.55, haloBlend: THREE.AdditiveBlending,
    beamOpacity: 0.30, beamBlend: THREE.AdditiveBlending,
    colorMul: 1.00,
  },
};

// Distance response. The beam is a LOCATOR — it is what tells you the objective is over there,
// behind that block. Close up it is in the way of the thing it is pointing at.
const BEAM_FADE_IN_M = 55;    // fully faded out nearer than this
const BEAM_FULL_M = 150;      // full strength beyond this
const POOL_MIN_PX_M = 30;     // below this distance the pool stops growing (see update)

/**
 * @param {THREE.Scene} scene
 * @param {object}  [opts]
 * @param {number}  [opts.radius=5]      ring radius in metres
 * @param {boolean} [opts.driveThrough]  dash gates are driven THROUGH — the ring stands upright and
 *                                       is oriented by the caller; destination markers lie flatter
 *                                       and spin, because there is no "through" to face.
 */
export function createObjectiveMarker(scene, { radius = 5, driveThrough = false } = {}) {
  _ensureSubscribed();
  const R = radius;
  const group = new THREE.Group();
  group.visible = false;
  group.userData.type = 'objectiveMarker';   // N-18: an untagged mesh is invisible to every probe

  const col = new THREE.Color(0xffffff);
  let night = _night;
  let P = night ? PROFILE.night : PROFILE.day;

  // ── ground pool: a soft disc lying on the road, not an annulus ──
  const poolMat = new THREE.MeshBasicMaterial({
    map: poolTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(R * 3.4, R * 3.4), poolMat);
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.12;
  pool.renderOrder = 3;
  group.add(pool);

  // ── the ring you aim at ──
  const ringMat = new THREE.MeshBasicMaterial({
    map: ringTexture(), transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(R, 0.34, 10, 44), ringMat);
  ring.renderOrder = 5;
  group.add(ring);

  // ── halo: a fatter, softer torus hugging the ring. Dash had one; the other two never did. ──
  const haloMat = new THREE.MeshBasicMaterial({
    map: ringTexture(), transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
  });
  const halo = new THREE.Mesh(new THREE.TorusGeometry(R, 1.15, 8, 40), haloMat);
  halo.renderOrder = 4;
  group.add(halo);

  // ── beam: tapered, vertically faded, no straight edge in the sky ──
  const beamMat = new THREE.MeshBasicMaterial({
    map: beamTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.30, R * 0.86, 70, 20, 1, true), beamMat);
  beam.position.y = 35;
  beam.renderOrder = 2;
  group.add(beam);

  ring.position.y = driveThrough ? R + 0.4 : R * 0.55;
  halo.position.y = ring.position.y;

  scene.add(group);

  function applyProfile() {
    P = night ? PROFILE.night : PROFILE.day;
    poolMat.blending = P.poolBlend; poolMat.needsUpdate = true;
    haloMat.blending = P.haloBlend; haloMat.needsUpdate = true;
    beamMat.blending = P.beamBlend; beamMat.needsUpdate = true;
    pool.scale.setScalar(P.poolScale);
    applyColor();
  }
  function applyColor() {
    // The multiplier is applied to the MATERIAL, not to the caller's colour, so a mode can keep
    // asking for the same hex in both profiles and get something readable in each.
    poolMat.color.copy(col).multiplyScalar(P.colorMul);
    ringMat.color.copy(col).multiplyScalar(P.colorMul);
    haloMat.color.copy(col).multiplyScalar(P.colorMul);
    beamMat.color.copy(col).multiplyScalar(P.colorMul);
  }
  applyProfile();

  let _t = 0;

  const api = {
    group,
    /** Place at a SCENE position, tinted `hex`. `faceRad` orients a drive-through gate. */
    place(x, y, z, hex, faceRad = null) {
      col.setHex(hex);
      applyColor();
      group.position.set(x, y, z);
      if (faceRad !== null) { ring.rotation.y = faceRad; halo.rotation.y = faceRad; }
      group.visible = true;
    },
    hide() { group.visible = false; },
    get visible() { return group.visible; },

    /**
     * @param {number} dt
     * @param {number} distM  metres from the car — drives the beam fade. Pass Infinity if unknown
     *                        and the beam stays at full, which is the old behaviour.
     */
    update(dt, distM = Infinity) {
      if (!group.visible) return;
      _t += dt;

      // Breathing, not spinning-for-the-sake-of-it: a slow scale pulse on the halo and a lazy roll
      // on the ring. A destination marker also yaws, because it has no "through" direction to hold.
      const pulse = 1 + Math.sin(_t * 2.1) * 0.045;
      halo.scale.setScalar(pulse);
      pool.scale.setScalar(P.poolScale * (1 + Math.sin(_t * 1.6) * 0.03));
      if (driveThrough) ring.rotation.z = _t * 0.55;
      else { ring.rotation.y = _t * 0.7; halo.rotation.y = ring.rotation.y; }

      // Beam: off under the bumper, full at range. `smoothstep` so it does not switch on.
      let bf = 0;
      if (Number.isFinite(distM)) {
        const u = Math.min(1, Math.max(0, (distM - BEAM_FADE_IN_M) / (BEAM_FULL_M - BEAM_FADE_IN_M)));
        bf = u * u * (3 - 2 * u);
      } else bf = 1;
      beamMat.opacity = P.beamOpacity * bf;
      beam.visible = bf > 0.01;

      // The pool is the CLOSE-range affordance and does the opposite: it strengthens as you arrive,
      // so the two never leave you without a mark on the ground.
      const near = Number.isFinite(distM) ? Math.min(1, Math.max(0, 1 - (distM - POOL_MIN_PX_M) / 140)) : 0;
      poolMat.opacity = P.poolOpacity * (0.72 + 0.28 * near);
      ringMat.opacity = P.ringOpacity;
      haloMat.opacity = P.haloOpacity * (0.85 + 0.15 * Math.sin(_t * 2.1));
    },

    setNight(on) { night = !!on; applyProfile(); },

    dispose() {
      _live.delete(api);
      scene.remove(group);
      for (const m of [pool, ring, halo, beam]) m.geometry.dispose();
      for (const m of [poolMat, ringMat, haloMat, beamMat]) m.dispose();
    },
  };
  _live.add(api);
  return api;
}
