/**
 * Car driver — single façade that main.js talks to.
 *
 * Orchestrates: physics (RaycastVehicle) · controls · camera · model.
 * Owns the physics world.step() call each frame.
 *
 * Public API (consumed by main.js):
 *   driver.update(dt)
 *   driver.getLocalPosition()  → { lx, lz }
 *   driver.getSpeedKmh()       → number
 *   driver.getHeadingDeg()     → number
 *   driver.dispose()
 */
import { createCarPhysics } from './carPhysics.js';
import { createCarControls } from './carControls.js';
import { createCarCamera }   from './carCamera.js';
import { createCarModel }    from './carModel.js';
import { createCarEffects }  from './carEffects.js';
import { createCarSound }    from './carSound.js';
import { isInTunnelZone }    from '../tunnelZones.js';
import { isInputBlocked, isTypingTarget } from '../inputGate.js';
import { audio }             from '../audio/audioManager.js';

// Pre-allocated for getHeadingDeg — no alloc in hot path
const _hq = { x: 0, y: 0, z: 0, w: 1 };

export async function createCarDriver(scene, world, groundMesh, camera, spawnLocalPos, _domElement, groundBody, spawnHeading) {

  // ── Sub-systems ───────────────────────────────────────────────────────────
  const physics  = createCarPhysics(world, {
    x: spawnLocalPos.x,
    y: spawnLocalPos.y + 2,    // drop from 2 m above surface; physics settles it
    z: spawnLocalPos.z,
  }, spawnHeading);
  const controls = createCarControls();
  const carCam   = createCarCamera(camera, _domElement);
  const model    = await createCarModel(scene);
  const effects  = createCarEffects(scene, model, physics);

  // Collision sound — the chassis emits a 'collide' event per contact. Play a synth impact scaled by the
  // closing speed along the contact normal; the threshold rejects resting/rolling road contact, and a
  // short debounce collapses the burst of contacts a single hit generates into one sound.
  let _lastImpactT = -1e9;
  physics.chassisBody.addEventListener('collide', (e) => {
    const eq = e && e.contact;
    if (!eq || typeof eq.getImpactVelocityAlongNormal !== 'function') return;
    const cv = Math.abs(eq.getImpactVelocityAlongNormal());
    if (cv < 2.6) return;                                   // ignore gentle taps / driving on the road
    const now = (typeof performance !== 'undefined') ? performance.now() : 0;
    if (now - _lastImpactT < 110) return;                   // one sound per hit, not per contact point
    _lastImpactT = now;
    audio.impact(Math.min(1, (cv - 2.6) / 12));             // ~2.6 m/s = tap, ~15 m/s = full crunch
  });

  // Wire sound toggle button from carModel's color panel (stable id — panel is re-parented into the ESC menu)
  const colorPanel = document.getElementById('dd-car-color-panel');
  if (colorPanel) colorPanel._onSoundToggle = () => sound.setMuted(!sound.isMuted());
  const sound    = createCarSound();

  // Start audio on first user interaction (required by browsers)
  const _startAudio = () => {
    sound.ensureStarted();
    window.removeEventListener('keydown', _startAudio);
    window.removeEventListener('click', _startAudio);
  };
  window.addEventListener('keydown', _startAudio);
  window.addEventListener('click', _startAudio);

  // Horn (H) — plays the horn sample if present (no-op otherwise)
  const _onHorn = (e) => { if (e.code === 'KeyH' && !isInputBlocked() && !isTypingTarget()) sound.horn?.(); };
  window.addEventListener('keydown', _onHorn);

  // ── Diagnostics ───────────────────────────────────────────────────────────
  let _logTimer = 0;
  let _prevGear = 1;

  // ── Recovery (R key) ─────────────────────────────────────────────────────
  // Breadcrumb of the last KNOWN-GOOD pose: upright, ≥3 wheels in contact, sane speed.
  // R teleports back to it (+0.8 m, velocities zeroed) — escape hatch for being wedged
  // against trench walls, flipped, or stuck anywhere (terrain-tunnel rework UX fix).
  const _crumb = {
    x: spawnLocalPos.x, y: spawnLocalPos.y + 1, z: spawnLocalPos.z,
    qx: 0, qy: Math.sin((spawnHeading ?? Math.PI) / 2), qz: 0, qw: Math.cos((spawnHeading ?? Math.PI) / 2),
  };
  let _crumbTimer = 0;
  let _resetCooldown = 0;
  const _onRecoverKey = (e) => {
    if (e.code !== 'KeyR' || _resetCooldown > 0 || isInputBlocked() || isTypingTarget()) return;
    _resetCooldown = 1.0;
    const b = physics.chassisBody;
    b.position.set(_crumb.x, _crumb.y + 0.8, _crumb.z);
    b.quaternion.set(_crumb.qx, _crumb.qy, _crumb.qz, _crumb.qw);
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
  };
  window.addEventListener('keydown', _onRecoverKey);

  // ── Per-frame update ──────────────────────────────────────────────────────
  function update(dt) {
    // 1. Advance physics (fixed 60 Hz, max 3 sub-steps, capped dt to prevent catch-up stutter)
    world.step(1 / 60, Math.min(dt, 0.035), 3);

    // 2. Read inputs → apply to vehicle
    const state = controls.getState();
    physics.applyInputs(state, dt);

    // 3. Sync visual to chassis (pass dt, steer, speed for visual body lean)
    model.update(physics.chassisBody, physics.vehicle, dt, physics.getCurrentSteer(), physics.getSpeedKmh());

    // 4. Visual effects
    effects.update(dt, state);

    // 4b. Engine sound + crackle on downshift
    const curGear = physics.getCurrentGear();
    const downshifted = curGear > 0 && curGear < _prevGear;
    _prevGear = curGear > 0 ? curGear : _prevGear;
    sound.update(physics.getCurrentRpm(), state.throttle, dt, downshifted, state.brake, physics.getSpeedKmh(),
                 physics.getSkidLevel ? physics.getSkidLevel() : 0);

    // 5. Chase camera (pass speed for reverse camera flip)
    carCam.update(physics.chassisBody, dt, physics.getSpeedKmh());

    // 5b. Recovery breadcrumb: record pose when upright + ≥3 wheels grounded (every 2 s)
    _resetCooldown = Math.max(0, _resetCooldown - dt);
    _crumbTimer += dt;
    if (_crumbTimer >= 2) {
      _crumbTimer = 0;
      const wheelsOn = physics.vehicle.wheelInfos.filter((w) => w.isInContact).length;
      const q = physics.chassisBody.quaternion;
      // chassis up-axis Y component: 1 - 2(qx² + qz²) — upright when close to 1
      const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
      if (wheelsOn >= 3 && upY > 0.8) {
        const bp = physics.chassisBody.position;
        _crumb.x = bp.x; _crumb.y = bp.y; _crumb.z = bp.z;
        _crumb.qx = 0; _crumb.qy = q.y; _crumb.qz = 0; _crumb.qw = q.w; // yaw only
        const n = Math.hypot(_crumb.qy, _crumb.qw) || 1;
        _crumb.qy /= n; _crumb.qw /= n;
      }
    }

    // 6. Keep fallback ground plane centred under the car
    const p = physics.chassisBody.position;
    if (groundMesh) {
      groundMesh.position.set(p.x, 0, p.z);
    }

    // 7. (Ground plane removed — per-tile Trimesh terrain colliders handle ground)

  }

  // ── Public API ────────────────────────────────────────────────────────────
  function getLocalPosition() {
    return { lx: physics.chassisBody.position.x, lz: physics.chassisBody.position.z };
  }

  function getSpeedKmh() {
    return physics.getSpeedKmh();
  }

  function getHeadingDeg() {
    const q = physics.chassisBody.quaternion;
    const fwdX = 2 * (q.x * q.z + q.w * q.y);
    const fwdZ = 1 - 2 * (q.x * q.x + q.y * q.y);
    return (Math.atan2(fwdX, fwdZ) * 180) / Math.PI;
  }

  function dispose() {
    physics.dispose();
    controls.dispose();
    model.dispose();
    effects.dispose();
    sound.dispose();
  }

  function getCurrentGear() { return physics.getCurrentGear(); }
  function getCurrentRpm()  { return physics.getCurrentRpm(); }

  function toggleSound() { sound.setMuted(!sound.isMuted()); return !sound.isMuted(); }

  return { update, getLocalPosition, getSpeedKmh, getHeadingDeg, getCurrentGear, getCurrentRpm, getUpDot: () => physics.getUpDot(), dispose, toggleSound, setNight: (n) => { sound.setNight?.(n); model.setNight?.(n); effects.setNight?.(n); }, toggleHeadlights: () => model.toggleHeadlights?.() };
}
