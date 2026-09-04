/**
 * Chase camera — speed-responsive, smooth tracking with mouse orbit.
 *
 * - Distance, height, and look-ahead scale with speed.
 * - Camera position smoothly follows (lerp) for cinematic lag.
 * - Mouse movement orbits camera around car; auto-returns when idle.
 * - LookAt is also smoothed for stable horizon.
 * - Minimum Y clamp prevents underground camera.
 */
import * as THREE from 'three';
import { isInTunnelZone } from '../tunnelZones.js';
import { isInputBlocked } from '../inputGate.js';
import { getBodyBounds } from './carModel.js';

// ── WHY 2.5 AND NOT 1.9 ───────────────────────────────────────────────────────────────────────
// At 1.9 the eye sat 0.7 m over a 1.2 m roofline, so the car was seen almost edge-on and became a
// wall across the bottom of the frame. The arithmetic: rear roof edge 4 m away and 0.7 m below eye
// = 10.4 deg down, rear sill = 28.9 deg down, against a 35 deg half-FOV — the car ate 79% of the
// lower half-frame and hid the road directly ahead of it. The complaint reads as "too close" but
// the distance was fine; the ANGLE was flat. At 2.5 m the same car spans 8.6..24.1 deg down = ~22%
// of frame height, with open road visible over the roof. Raise height before pulling back.
//
// ── V-15: THE TWO CHASE RIGS ARE A PARAMETER SET, NOT A SECOND CAMERA ─────────────────────────
// Both chase views run the SAME update path — orbit, reverse flip, shake, soft distance clamp,
// look-ahead, FOV boost — and differ only in the four numbers below. Forking the update is how two
// chase cams drift apart: a fix lands in one and the other quietly keeps the bug.
//
// CLOSE is derived from WIDE by holding the ANGLES, not by scaling the numbers, because the comment
// above is the whole reason WIDE is tuned the way it is. Rear roof edge sits ~1.2 m up and ~2.2 m
// behind the chassis origin, so WIDE depresses it by atan(1.3 / 4.4) = 16.5 deg. At 4.5 m back the
// gap is 2.3 m, and 2.05 m of height gives 20.3 deg — deliberately a shade steeper, so pulling the
// camera in shows MORE road over the roof rather than less. Look-ahead is shortened to match: the
// wide rig pitches 8.6 deg down to its target, and from a 2.05 m eye that is a 3.2 m target, not a
// 4.0 m one. Leaving `look` at 4.0 with a shorter boom is exactly what flattens the view into the
// roofline.
const CHASE_RIGS = {
  // dist/height/look are the at-rest values; the SPEED_* deltas below are shared by both rigs.
  0 /* VIEW_CHASE */:       { dist: 6.6, height: 2.5,  look: 4.0, tunnelDist: 6.0, tunnelHeight: 1.95 },
  1 /* VIEW_CHASE_CLOSE */: { dist: 4.5, height: 2.05, look: 3.2, tunnelDist: 4.1, tunnelHeight: 1.62 },
};
const SPEED_DISTANCE_BOOST = 0.3;  // 0.6→0.3: camera drifted too far back at speed
const SPEED_HEIGHT_DROP   = 0.25;
const SPEED_LOOK_BOOST    = 3.0;
const MIN_CAM_ABOVE_CAR   = 0.5;

// ── V-16: SMOOTH VIEW TRANSITIONS, AND WHY THEY ARC ───────────────────────────────────────────
// Cycling used to re-seat the camera (`_init = false`) — an instant cut. The comment defending it
// was right about the hazard and wrong about the remedy: a straight lerp from a chase position 6.6 m
// behind the car to a point on its bonnet passes THROUGH the bodywork, so for half a second you are
// inside the shell looking at culled backfaces. A cut avoids that; it does not fix it.
//
// The fix is to blend in the car's own YAW-ONLY LOCAL FRAME and lift the path over the roof. Local,
// because the transition then rides with the car — blend in world space and a car doing 90 km/h
// leaves its own camera path behind. Lifted, because that is what clears the shell: the arc height
// is scaled by how close the straight path passes to the car, so chase→bumper gets the full swoop
// over the roof and chase→close (both behind the car, closest approach 4.5 m) gets none — no
// pointless bob on a transition that never goes near the bodywork.
//
// Geometry, for the case that matters: local (0, 2.5, −6.6) → (0, 0.95, +3.05) crosses the car
// centre at t ≈ 0.68, where the straight lerp is 1.44 m up — 24 cm over a 1.2 m roofline. That is
// not clearance, it is a coin toss against wing mirrors and aerials. With the lift it is ~2.1 m.
// 0.6 s, not 0.5: the longest move (wide chase ↔ bumper) is ~9.7 m, and smoothstep peaks at 1.5×
// the mean rate, so 0.5 s puts 0.38 m between consecutive frames — 23 m/s of camera. Readable, but
// it whips. 0.6 s brings the peak to ~0.32 m/frame and still clears in well under a second.
const TRANSITION_TIME    = 0.6;   // s — long enough to read as a move, short enough not to annoy
const TRANSITION_CLEAR_R = 2.6;   // m — car half-length plus margin; inside this the path needs lift
const TRANSITION_LIFT    = 0.8;   // m of arc at the apex, scaled by how close the path passes
const LOOK_ABOVE          = 0.9;   // lifted with the eye so the pitch-down stays ~8-9 deg
const MAX_H_DIST          = 9.3;   // horizontal clamp — MUST stay above BASE_CAM_DISTANCE+SPEED_DISTANCE_BOOST or it caps the pull-back
const LERP_POSITION       = 0.16;
const LERP_LOOK           = 0.22;
const BASE_FOV            = 70;
const MAX_FOV_BOOST       = 21;   // more speed-warp at the top to sell the trimmed 110 km/h top speed
const FOV_PEAK_KMH        = 80;   // speed at which the FOV boost maxes — so 40-90 city speeds actually FEEL fast

// Mouse orbit config
const MOUSE_SENSITIVITY_X = 0.004;  // radians per pixel
const MOUSE_SENSITIVITY_Y = 0.003;
const MAX_PITCH_UP        = 0.6;    // radians
const MAX_PITCH_DOWN      = -0.15;
const RETURN_DELAY         = 1.5;   // seconds idle before auto-return
const RETURN_SPEED         = 2.5;   // lerp speed for returning to default

// ── VIEW MODES (V-14) ─────────────────────────────────────────────────────────────────────────
// CHASE is the original follow camera. HOOD sits on the bonnet at roughly driver eye height and is
// the closest thing to a cockpit view this car can honestly support.
//
// ⚠ WHY THERE IS NO COCKPIT MODE. `bmw_m3.glb` has ELEVEN materials and not one of them is an
// interior — no dashboard, no seats, no steering wheel (verified: CarPaint, RearLight, Transparent,
// Exhaust, Plastic, DayLights, RedPart, Window, Mirror, Rims, Tires). A camera placed inside it
// would face the culled backfaces of the roof and doors and see straight out through the bodywork.
// A cockpit view is a MODEL problem, not a camera one; the enum has room for it, and the day a car
// with an interior is the player's car it is a few lines here. The traffic hatchback already has
// one (2,039 tris, 30% of that model), which is what makes this worth leaving room for.
//
// ORDER IS THE FEATURE: C walks the camera progressively INWARD — wide chase, close chase, bumper —
// so the key has a direction rather than being a bag of views. Adding CLOSE in the middle moves
// HOOD from 1 to 2; nothing outside this file refers to these by value (checked: `carDriver` and
// `main.js` only forward `cycleView`/`getView`), and the sessionStorage restore is range-checked,
// so a stored 1 from an older build now selects CLOSE instead of HOOD. That is a one-time surprise
// on one reload, not a broken state.
export const VIEW_CHASE = 0;
export const VIEW_CHASE_CLOSE = 1;
export const VIEW_HOOD = 2;
const VIEW_COUNT = 3;
/** True for both chase rigs — i.e. "not the bumper cam". */
export function isChaseView(mode) { return mode === VIEW_CHASE || mode === VIEW_CHASE_CLOSE; }

// ── NOSE CAMERA — PLACED AGAINST MEASURED GEOMETRY, NOT AGAINST ARITHMETIC ────────────────────
// This landed inside the bodywork TWICE (1.34 m fwd / 1.06 m up, then 1.05 / 1.46), both times
// because the offsets were reasoned from CHASSIS_BOX_OFFSET_Y and half of M3_TARGET_LENGTH. Both
// premises were wrong for this purpose: the collision box is not the visual shell, and the load
// path recentres the body on Y ONLY — nothing recentres Z — so the nose is NOT at half the car
// length. Nobody had ever read where it actually is.
//
// It now reads `getBodyBounds()`, the post-centring bbox in this same chassis-origin space, and
// sits NOSE_CLEAR ahead of `max.z`. That puts the whole car BEHIND the camera, which is what makes
// this correct by construction rather than by tuning: with no geometry in front of the eye there is
// no interior to see through, no matter what the model turns out to measure.
//
// The trade is honest and worth naming: you get the road, not the bonnet. A view that SHOWS the
// bonnet has to sit behind the windscreen, and that is the cockpit case the enum comment above
// already rules out for a model with no interior. This is a bumper cam wearing the hood cam's slot.
const NOSE_CLEAR   = 0.38;   // m ahead of the measured nose — clear of wipers, badge, licence plate
const NOSE_DROP    = 0.30;   // m below the measured roofline — bonnet-level, not roof-level
// Fallbacks, used only if the model has not loaded yet. Deliberately generous: an over-long guess
// floats the eye in clear air, an under-long one puts it back inside the car.
const HOOD_FORWARD = 3.05;
const HOOD_HEIGHT  = 0.95;
// Rigid, unlike the chase cam. A bonnet camera is BOLTED to the car — lerping it makes the road
// swim under a nose that should be fixed, which reads as motion sickness rather than smoothness.
const HOOD_LERP    = 0.85;

// Pre-allocated
const _euler    = new THREE.Euler();
const _yawOnly  = new THREE.Quaternion();
const _idealPos = new THREE.Vector3();
let _noseLogged = false;
const _lookAt   = new THREE.Vector3();
const _fwdDir   = new THREE.Vector3();
const _smoothLookAt = new THREE.Vector3();
const _shakeOffset = new THREE.Vector3();

export function createCarCamera(camera, domElement) {
  let _init = false;
  let _mode = VIEW_CHASE;

  // Mouse orbit state — moving the mouse / trackpad swings the camera around the car (see it from the
  // front, rear or sides); after a short idle it auto-returns to the default chase position behind it.
  let _orbitYaw = 0;                 // horizontal offset from behind-car (radians)
  let _orbitPitch = 0;               // vertical offset (radians)
  let _idleTime = RETURN_DELAY;      // seconds since last pointer movement (start idle so it begins centred)
  let _mouseActive = false;

  function _onPointerMove(e) {
    if (isInputBlocked()) return;    // ESC menu / dialogs own the pointer — don't swing the camera
    const dxp = e.movementX || 0, dyp = e.movementY || 0;
    if (dxp === 0 && dyp === 0) return;
    _orbitYaw   = Math.max(-Math.PI, Math.min(Math.PI, _orbitYaw + dxp * MOUSE_SENSITIVITY_X));
    _orbitPitch = Math.max(MAX_PITCH_DOWN, Math.min(MAX_PITCH_UP, _orbitPitch - dyp * MOUSE_SENSITIVITY_Y));
    _idleTime = 0;
    _mouseActive = true;
  }

  // Listen on the canvas so hovering the HUD/buttons doesn't hijack the camera. Fall back to document.
  const _target = domElement || (typeof document !== 'undefined' ? document : null);
  if (_target) _target.addEventListener('pointermove', _onPointerMove);

  // Smooth reverse camera flip
  let _reverseBlend = 0; // 0 = behind car (forward), 1 = in front of car (reverse)

  // View-transition state. `_transFrom` is in the car's yaw-only LOCAL frame, so the blend rides
  // with the car. `_transPending` exists because cycleView() is called from a keypress and has no
  // car transform to capture against — the capture happens on the next update.
  let _transPending = false;
  let _transT = 1;                 // 1 = settled
  let _transFromMode = VIEW_CHASE;
  let _transLift = 0;
  const _transFrom = new THREE.Vector3();
  const _transTo = new THREE.Vector3();
  const _invYaw = new THREE.Quaternion();

  // Camera shake state (impact punch decays; high-speed rumble is continuous)
  let _shakeAmp = 0;
  let _prevSpeedKmh = 0;
  let _prevPX = null, _prevPZ = null;   // to distinguish a real deceleration from a recover-teleport

  function update(chassisBody, dt, speedKmh) {
    // Follow the INTERPOLATED transform (see carModel.update) so the chase cam is smooth against the
    // render rate instead of snapping on the fixed 60 Hz physics grid.
    const ip = chassisBody.interpolatedPosition, iq = chassisBody.interpolatedQuaternion;
    const p = (ip && (ip.x !== 0 || ip.y !== 0 || ip.z !== 0)) ? ip : chassisBody.position;
    const q = (iq && (iq.x !== 0 || iq.y !== 0 || iq.z !== 0 || iq.w !== 1)) ? iq : chassisBody.quaternion;

    // Extract yaw only — no pitch/roll
    _yawOnly.set(q.x, q.y, q.z, q.w);
    _euler.setFromQuaternion(_yawOnly, 'YXZ');
    _euler.x = 0;
    _euler.z = 0;
    _yawOnly.setFromEuler(_euler);

    // Forward direction (horizontal only)
    _fwdDir.set(0, 0, 1).applyQuaternion(_yawOnly);

    // Smooth blend for reverse camera: swing to front when reversing
    const isReversing = (speedKmh || 0) < -3;
    const reverseTarget = isReversing ? 1 : 0;
    _reverseBlend += (reverseTarget - _reverseBlend) * Math.min(1, 2.5 * (dt || 0.016));
    // Rotate forward direction by reverseBlend * 180°
    if (_reverseBlend > 0.01) {
      const angle = _reverseBlend * Math.PI;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const fx = _fwdDir.x, fz = _fwdDir.z;
      _fwdDir.x = fx * cos - fz * sin;
      _fwdDir.z = fx * sin + fz * cos;
    }

    // Speed-responsive parameters
    const speed = chassisBody.velocity.length() * 3.6;
    const speedFactor = Math.min(1, speed / 80);

    // Tunnel camera: registered tunnel-corridor XZ zones (physics frame), NOT absolute Y.
    // The old `p.y < -1` test was a G-47 absolute-Y bug — on Montjuïc (car Y ≈ −16 in the
    // spawn frame) the camera was PERMANENTLY in tunnel mode (4 m, low) everywhere.
    // XZ-zone false positives (surface road directly above a tunnel) are brief and mild;
    // Phase 3 authored tunnels will refine this with a terrain-relative depth test.
    const inTunnel = isInTunnelZone(p.x, p.z);
    // HOOD overrides the position outright below, but it still falls through to the shared look
    // target, so it needs a rig — the wide one, which is what it has always effectively used.
    const rig = CHASE_RIGS[_mode] || CHASE_RIGS[VIEW_CHASE];
    const camHeight = inTunnel ? rig.tunnelHeight : rig.height - speedFactor * SPEED_HEIGHT_DROP;
    const camDist = inTunnel ? rig.tunnelDist : rig.dist + speedFactor * SPEED_DISTANCE_BOOST;
    // Look-ahead blends across the transition as well. `_smoothLookAt` would ease a step anyway, but
    // at its own 0.22 rate rather than the transition's — so the frame would arrive before the aim did.
    const fromLook = (CHASE_RIGS[_transFromMode] || CHASE_RIGS[VIEW_CHASE]).look;
    const lookBase = _transT < 1 ? fromLook + (rig.look - fromLook) * _transT : rig.look;
    const lookAhead = lookBase + speedFactor * SPEED_LOOK_BOOST;

    // Auto-return: after RETURN_DELAY of no pointer movement, ease the orbit back to behind the car.
    _idleTime += dt || 0.016;
    if (_idleTime > RETURN_DELAY && (_orbitYaw !== 0 || _orbitPitch !== 0)) {
      const rt = Math.min(1, RETURN_SPEED * (dt || 0.016));
      _orbitYaw   += (0 - _orbitYaw)   * rt;
      _orbitPitch += (0 - _orbitPitch) * rt;
      if (Math.abs(_orbitYaw) < 0.003 && Math.abs(_orbitPitch) < 0.003) { _orbitYaw = 0; _orbitPitch = 0; _mouseActive = false; }
    }

    // Compute camera direction: behind car + orbit offset
    // Start with the "behind" direction (-forward), then rotate by orbit yaw
    const behindX = -_fwdDir.x;
    const behindZ = -_fwdDir.z;
    const cosY = Math.cos(_orbitYaw);
    const sinY = Math.sin(_orbitYaw);
    const orbX = behindX * cosY - behindZ * sinY;
    const orbZ = behindX * sinY + behindZ * cosY;

    // Apply pitch: raise/lower camera height and adjust distance
    const cosPitch = Math.cos(_orbitPitch);
    const sinPitch = Math.sin(_orbitPitch);
    const hDist = camDist * cosPitch;
    const extraHeight = camDist * sinPitch;

    _idealPos.set(
      p.x + orbX * hDist,
      p.y + camHeight + extraHeight,
      p.z + orbZ * hDist,
    );

    // ── HOOD: ride the car instead of following it ──────────────────────────────────────────
    // Built from the SAME yaw-only forward the chase cam uses, so the view does not tip with the
    // car's pitch and roll. Coupling a head-height camera to chassis roll is what makes bonnet
    // views nauseating; the car leaning under you reads fine, the horizon leaning does not.
    if (_mode === VIEW_HOOD) {
      // Measured every frame rather than cached: the bounds are null until the GLB resolves, and
      // this view can be active across that boundary (the mode is restored from sessionStorage
      // before the model exists).
      const _bb = getBodyBounds();
      const fwd = _bb ? _bb.max.z + NOSE_CLEAR : HOOD_FORWARD;
      const eyeY = _bb ? _bb.max.y - NOSE_DROP : HOOD_HEIGHT;
      // One-shot placement census. Two rounds of reasoning put this camera inside the shell and
      // neither was diagnosable from a screenshot; this makes the third round a number, not a guess.
      if (_bb && !_noseLogged) {
        _noseLogged = true;
        console.log('[carCamera] nose cam — body z', _bb.min.z.toFixed(2), '..', _bb.max.z.toFixed(2),
          '· y', _bb.min.y.toFixed(2), '..', _bb.max.y.toFixed(2),
          '→ eye fwd', fwd.toFixed(2), 'up', eyeY.toFixed(2),
          fwd > _bb.max.z ? '(OUTSIDE, correct)' : '(INSIDE THE BODYWORK — wrong)');
      }
      _idealPos.set(
        p.x + _fwdDir.x * fwd,
        p.y + eyeY,
        p.z + _fwdDir.z * fwd,
      );
      // ⚠ NO SEPARATE LOOK TARGET, and that is not an oversight — it is a correction. This block
      // used to build a `_hoodLook` from an orbit-rotated forward and `HOOD_LOOK = 14 m` that
      // **nothing ever read**: the bumper view has always fallen through to the shared chase look
      // target below, and that is what it is actually tuned against. Deleted along with the
      // constant, rather than left in place — dead code that looks live is how the next person
      // concludes this camera aims somewhere it does not, and then "fixes" the wrong number.
    }

    // ── VIEW TRANSITION ───────────────────────────────────────────────────────────────────────
    // Runs after every mode has had its say on `_idealPos`, so it blends toward wherever the ACTIVE
    // view wants to be this frame — the target keeps tracking the moving car mid-transition.
    let transitioning = false;
    if (_init && (_transPending || _transT < 1)) {
      _invYaw.copy(_yawOnly).invert();
      if (_transPending) {
        _transPending = false;
        _transT = 0;
        // Start from where the camera ACTUALLY is (shake removed), not from the old mode's ideal —
        // the chase cam lags its ideal by design, and starting at the ideal would pop on frame one.
        _transFrom.set(
          camera.position.x - _shakeOffset.x - p.x,
          camera.position.y - _shakeOffset.y - p.y,
          camera.position.z - _shakeOffset.z - p.z,
        ).applyQuaternion(_invYaw);
        _transTo.set(_idealPos.x - p.x, _idealPos.y - p.y, _idealPos.z - p.z).applyQuaternion(_invYaw);
        // Closest approach of the straight path to the car centre, in plan. Full lift when it runs
        // over the car, none when it stays outside TRANSITION_CLEAR_R.
        const dx = _transTo.x - _transFrom.x, dz = _transTo.z - _transFrom.z;
        const L2 = dx * dx + dz * dz || 1;
        const tc = Math.max(0, Math.min(1, -(_transFrom.x * dx + _transFrom.z * dz) / L2));
        const closest = Math.hypot(_transFrom.x + dx * tc, _transFrom.z + dz * tc);
        _transLift = Math.max(0, (TRANSITION_CLEAR_R - closest) / TRANSITION_CLEAR_R) * TRANSITION_LIFT;
      }
      _transT = Math.min(1, _transT + (dt || 0.016) / TRANSITION_TIME);
      const te = _transT * _transT * (3 - 2 * _transT);           // smoothstep — no velocity step at either end
      _transTo.set(_idealPos.x - p.x, _idealPos.y - p.y, _idealPos.z - p.z).applyQuaternion(_invYaw);
      _idealPos.set(
        _transFrom.x + (_transTo.x - _transFrom.x) * te,
        _transFrom.y + (_transTo.y - _transFrom.y) * te + _transLift * Math.sin(Math.PI * te),
        _transFrom.z + (_transTo.z - _transFrom.z) * te,
      ).applyQuaternion(_yawOnly);
      _idealPos.x += p.x; _idealPos.y += p.y; _idealPos.z += p.z;
      transitioning = _transT < 1;
    }

    if (!_init) {
      _init = true;
      camera.position.copy(_idealPos);
      _smoothLookAt.set(
        p.x + _fwdDir.x * lookAhead,
        p.y + LOOK_ABOVE,
        p.z + _fwdDir.z * lookAhead,
      );
    }

    // Remove last frame's shake so the smoothed base doesn't accumulate the offset.
    camera.position.sub(_shakeOffset);

    // Smooth camera position — use stronger lerp to prevent lag/stutter
    // During a transition the eased arc IS the smoothing, so follow it exactly. Lerping toward a
    // moving blend point would drag the camera off the arc — and off its clearance over the roof —
    // and the two rigs disagree on the rate anyway (0.85 bolted-on bumper vs 0.16 trailing chase),
    // which is what would put a pop at the far end of an otherwise smooth move.
    const ap = transitioning ? 1
      : 1 - Math.pow(1 - (_mode === VIEW_HOOD ? HOOD_LERP : LERP_POSITION), dt * 60);
    camera.position.lerp(_idealPos, ap);

    // Soft clamp horizontal distance (lerp toward max instead of hard snap)
    const dx = camera.position.x - p.x;
    const dz = camera.position.z - p.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > MAX_H_DIST) {
      const softScale = MAX_H_DIST / dist;
      const clampAlpha = Math.min(1, 6 * (dt || 0.016)); // smooth clamp
      camera.position.x = p.x + dx * (1 - clampAlpha + softScale * clampAlpha);
      camera.position.z = p.z + dz * (1 - clampAlpha + softScale * clampAlpha);
    }

    // Minimum Y
    const minY = p.y + MIN_CAM_ABOVE_CAR;
    if (camera.position.y < minY) camera.position.y = minY;

    // ── Camera shake: impact punch (sharp speed drop) + subtle high-speed rumble ──
    const _absSpd = Math.abs(speedKmh || 0);
    const _drop = _prevSpeedKmh - _absSpd;
    // A recover/teleport zeroes velocity AND jumps position discontinuously — don't punch the camera for it.
    const _jump = (_prevPX == null) ? 0 : Math.hypot(p.x - _prevPX, p.z - _prevPZ);
    // ── V-13: TONED, BECAUSE WHAT IT WAS REACTING TO IS FIXED ─────────────────────────────────
    // This punches on a one-frame speed drop. With traffic collisions resolved against a STATIC,
    // infinite-mass box the drop spiked for several consecutive frames, so the punch re-triggered
    // each one and stacked into the shake the user reported as "a lot of camera or car shake on
    // collision seems weird" — the shake was a SYMPTOM of the collision bug, not a separate effect.
    //
    // Contact is now a single bounded velocity change (V-13), so one clean punch is enough. The old
    // ceiling of 0.45 m was sized for that runaway case: at a ~6 m chase distance it swings the view
    // hard enough to read as a glitch rather than an impact. Threshold raised too, so a kerb scrape
    // or a gentle nudge no longer punches at all.
    if ((dt || 0.016) < 0.06 && _drop > 16 && _jump < 6) _shakeAmp = Math.min(0.20, _drop / 90);
    _shakeAmp *= Math.pow(0.0008, dt || 0.016);                                     // fast decay
    _prevSpeedKmh = _absSpd;
    _prevPX = p.x; _prevPZ = p.z;
    const _rumble = Math.max(0, (_absSpd - 140) / 120) * 0.05;                        // shake ONLY above 140 km/h
    const _shakeMag = _shakeAmp + _rumble;
    if (_shakeMag > 0.0008) {
      const ts = (typeof performance !== 'undefined' ? performance.now() : 0) * 0.001;
      _shakeOffset.set(
        Math.sin(ts * 53.1) * _shakeMag,
        Math.sin(ts * 71.7) * _shakeMag * 0.7,
        Math.sin(ts * 47.3) * _shakeMag,
      );
    } else {
      _shakeOffset.set(0, 0, 0);
    }
    camera.position.add(_shakeOffset);

    // Look target: when orbiting, look at car center; otherwise look ahead
    if (_mouseActive && (Math.abs(_orbitYaw) > 0.05 || Math.abs(_orbitPitch) > 0.05)) {
      _lookAt.set(p.x, p.y + LOOK_ABOVE, p.z);
    } else {
      _lookAt.set(
        p.x + _fwdDir.x * lookAhead,
        p.y + LOOK_ABOVE,
        p.z + _fwdDir.z * lookAhead,
      );
    }

    // Smooth lookAt
    const al = 1 - Math.pow(1 - LERP_LOOK, dt * 60);
    _smoothLookAt.lerp(_lookAt, al);
    camera.lookAt(_smoothLookAt);

    // FOV boost
    const fovTarget = BASE_FOV + MAX_FOV_BOOST * Math.min(1, speed / FOV_PEAK_KMH);
    camera.fov += (fovTarget - camera.fov) * 0.05;
    camera.updateProjectionMatrix();
  }

  /** Cycle CHASE -> CHASE_CLOSE -> HOOD (progressively inward). Lives here, not in controls, so
   *  the modes stay one concept. */
  function cycleView() {
    // V-16: arc across, don't cut. `_transFromMode` is the view we are LEAVING — captured before the
    // increment, and not overwritten if C is pressed again mid-transition, because the arc's start
    // point is re-captured from the live camera position anyway.
    _transFromMode = _mode;
    _mode = (_mode + 1) % VIEW_COUNT;
    _transPending = true;
    try { sessionStorage.setItem('dd_view', String(_mode)); } catch { /* private mode */ }
    return _mode;
  }
  try {
    const v = parseInt(sessionStorage.getItem('dd_view') || '0', 10);
    if (v >= 0 && v < VIEW_COUNT) _mode = v;
  } catch { /* private mode */ }

  return {
    update,
    cycleView,
    getView: () => _mode,
    /** 0..1 across a view change, 1 when settled. */
    getViewBlend: () => _transT,
    dispose() { if (_target) _target.removeEventListener('pointermove', _onPointerMove); },
  };
}
