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

const BASE_CAM_DISTANCE   = 6.2;   // follow distance behind car (8.2→7.3→6.2: still felt too far at spawn on Mac fullscreen)
const SPEED_DISTANCE_BOOST = 0.3;  // 0.6→0.3: camera drifted too far back at speed
const BASE_CAM_HEIGHT     = 1.9;   // camera height above car (dropped with the pull-in to keep a natural, not top-down, angle)
const SPEED_HEIGHT_DROP   = 0.25;
const BASE_LOOK_AHEAD     = 2.5;
const SPEED_LOOK_BOOST    = 3.0;
const TUNNEL_CAM_HEIGHT   = 1.2;
const TUNNEL_CAM_DISTANCE = 5.5;   // follow distance in tunnel zones (was hardcoded 4.0 — too tight per user)
const MIN_CAM_ABOVE_CAR   = 0.5;
const LOOK_ABOVE          = 0.5;
const MAX_H_DIST          = 9.3;   // horizontal clamp — MUST stay above BASE_CAM_DISTANCE+SPEED_DISTANCE_BOOST or it caps the pull-back
const LERP_POSITION       = 0.16;
const LERP_LOOK           = 0.22;
const BASE_FOV            = 70;
const MAX_FOV_BOOST       = 17;   // was 14 — a bit more speed-warp at the top
const FOV_PEAK_KMH        = 85;   // speed at which the FOV boost maxes (was 120) — so 40-90 city speeds actually FEEL fast

// Mouse orbit config
const MOUSE_SENSITIVITY_X = 0.004;  // radians per pixel
const MOUSE_SENSITIVITY_Y = 0.003;
const MAX_PITCH_UP        = 0.6;    // radians
const MAX_PITCH_DOWN      = -0.15;
const RETURN_DELAY         = 1.5;   // seconds idle before auto-return
const RETURN_SPEED         = 2.5;   // lerp speed for returning to default

// Pre-allocated
const _euler    = new THREE.Euler();
const _yawOnly  = new THREE.Quaternion();
const _idealPos = new THREE.Vector3();
const _lookAt   = new THREE.Vector3();
const _fwdDir   = new THREE.Vector3();
const _smoothLookAt = new THREE.Vector3();
const _shakeOffset = new THREE.Vector3();

export function createCarCamera(camera, domElement) {
  let _init = false;

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
    const camHeight = inTunnel ? TUNNEL_CAM_HEIGHT : BASE_CAM_HEIGHT - speedFactor * SPEED_HEIGHT_DROP;
    const camDist = inTunnel ? TUNNEL_CAM_DISTANCE : BASE_CAM_DISTANCE + speedFactor * SPEED_DISTANCE_BOOST;
    const lookAhead = BASE_LOOK_AHEAD + speedFactor * SPEED_LOOK_BOOST;

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
    const ap = 1 - Math.pow(1 - LERP_POSITION, dt * 60);
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
    if ((dt || 0.016) < 0.06 && _drop > 12 && _jump < 6) _shakeAmp = Math.min(0.45, _drop / 55); // collision punch
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

  return {
    update,
    dispose() { if (_target) _target.removeEventListener('pointermove', _onPointerMove); },
  };
}
