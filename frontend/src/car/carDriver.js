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
import { createCarPhysicsRapier } from './carPhysicsRapier.js';
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

export async function createCarDriver(scene, world, groundMesh, camera, spawnLocalPos, _domElement, groundBody, spawnHeading, opts = {}) {

  // ── Sub-systems ───────────────────────────────────────────────────────────
  const _spawn = { x: spawnLocalPos.x, y: spawnLocalPos.y + 2, z: spawnLocalPos.z }; // drop 2 m; settles
  // Physics engine: Rapier (WASM) when opts.rapier is the RAPIER module (?physics=rapier), else cannon-es.
  const physics  = opts.rapier
    ? createCarPhysicsRapier(world, opts.rapier, _spawn, spawnHeading)
    : createCarPhysics(world, _spawn, spawnHeading);
  const _ct = opts.cpuTimer || null;   // optional: splits the STATS 'phys' lap into step (pure physics) + phys (car visuals)
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

  // Start audio on first user interaction (required by browsers) — but NOT while the title screen is up
  // (clicking PLAY was arming the engine idle under the menu). The first interaction in-game starts it.
  const _startAudio = () => {
    const t = document.getElementById('dd-title');
    if (t && !t.classList.contains('hide')) return;   // still on the title — stay silent, keep listening
    sound.ensureStarted();
    window.removeEventListener('keydown', _startAudio);
    window.removeEventListener('click', _startAudio);
  };
  window.addEventListener('keydown', _startAudio);
  window.addEventListener('click', _startAudio);

  // Horn (H) — press-and-HOLD: start on first press (ignore key auto-repeat), stop on release.
  const _onHornDown = (e) => { if (e.code === 'KeyH' && !e.repeat && !isInputBlocked() && !isTypingTarget()) sound.hornStart?.(); };
  const _onHornUp = (e) => { if (e.code === 'KeyH') sound.hornStop?.(); };
  const _hornBlur = () => sound.hornStop?.();   // window lost focus mid-honk → don't stick on
  window.addEventListener('keydown', _onHornDown);
  window.addEventListener('keyup', _onHornUp);
  window.addEventListener('blur', _hornBlur);

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
  // Shared teleport used by both the R key and the freefall auto-recovery below.
  const _recoverToCrumb = () => {
    const b = physics.chassisBody;
    b.position.set(_crumb.x, _crumb.y + 0.8, _crumb.z);
    b.quaternion.set(_crumb.qx, _crumb.qy, _crumb.qz, _crumb.qw);
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
  };
  const _onRecoverKey = (e) => {
    if (e.code !== 'KeyR' || _resetCooldown > 0 || isInputBlocked() || isTypingTarget()) return;
    _resetCooldown = 1.0;
    _recoverToCrumb();
  };
  window.addEventListener('keydown', _onRecoverKey);

  // ── Freefall auto-recovery ───────────────────────────────────────────────
  // If terrain tiles fail to stream in, the car can drop through the void. We ONLY want to fire on that
  // genuine plunge — never on normal driving, bumps, jumps or slopes (an earlier version false-fired and
  // yanked the car back to spawn). So we require ALL THREE at once, measured from the instant the wheels
  // left the ground: airborne a while, dropped a long way, and STILL falling fast. Real driving never
  // satisfies all three; a void-fall always does.
  const VOID_MIN_AIR_S  = 1.2;    // must have been airborne at least this long
  const VOID_MIN_DROP_M = 30;     // ...and dropped at least this far below where the wheels left ground
  const VOID_MIN_FALL_V = 14;     // ...and still be falling faster than this (m/s downward)
  const FALL_FLOOR_Y    = spawnLocalPos.y - 400;  // last-resort sentinel, far below any real terrain
  const HOLD_MAX_S      = 2.0;    // hard cap on the hover-hold so the car can NEVER get stuck floating
  let _airTime    = 0;            // seconds since wheels last touched ground
  let _airStartY  = spawnLocalPos.y; // chassis Y at the moment we last became airborne
  let _wasGrounded = true;
  let _holdGround = false;
  let _holdTimer  = 0;

  // DEV-only: force a void-fall from the console to verify auto-recovery. Stripped from prod builds.
  if (import.meta.env.DEV) {
    window._testFreefall = (depth = 60) => {
      physics.chassisBody.position.y -= depth;
      physics.chassisBody.velocity.set(0, -8, 0);
      console.log(`[test] dropped car ${depth}m — freefall auto-recovery should fire within ~0.6s`);
    };
  }

  // ── Per-frame update ──────────────────────────────────────────────────────
  function update(dt, cinematic = false) {
    // 1. Advance physics (fixed 60 Hz, max 3 sub-steps, capped dt to prevent catch-up stutter)
    if (physics.step) physics.step(dt); else world.step(1 / 60, Math.min(dt, 0.035), 3);
    _ct?.lap('step');   // pure physics-step cost; the remainder of this update lands in main's 'phys' lap

    // 2. Read inputs → apply to vehicle. During a game-mode cinematic, ignore input and pin the car in
    //    place (zero velocities) so it can't creep while the b-roll plays. (state stays function-scoped —
    //    it's used by effects.update below.)
    const state = controls.getState();
    if (cinematic) {
      physics.chassisBody.velocity.set(0, 0, 0);
      physics.chassisBody.angularVelocity.set(0, 0, 0);
    } else {
      physics.applyInputs(state, dt);
    }

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

    // 5. Chase camera (pass speed for reverse camera flip). Skipped while a game mode drives a cinematic.
    if (!cinematic) carCam.update(physics.chassisBody, dt, physics.getSpeedKmh());

    // 5b. Recovery breadcrumb + freefall auto-recovery.
    _resetCooldown = Math.max(0, _resetCooldown - dt);
    {
      const cb = physics.chassisBody;
      // Count grounded wheels without allocating a filtered array every frame (this runs at 60 Hz).
      let wheelsOn = 0;
      const _wi = physics.vehicle.wheelInfos;
      for (let wj = 0; wj < _wi.length; wj++) if (_wi[wj].isInContact) wheelsOn++;
      const q = cb.quaternion;
      const upY = 1 - 2 * (q.x * q.x + q.z * q.z); // chassis up-axis Y: ~1 when upright

      // Breadcrumb: keep it FRESH. Record the last upright, grounded pose continuously (throttled to
      // ~3/s) whenever ≥2 wheels touch and we're roughly upright — so "recover" never sends us all the
      // way back to spawn (the earlier bug: a strict ≥3-wheel/2s gate rarely fired → stale crumb).
      _crumbTimer += dt;
      if (wheelsOn >= 2 && upY > 0.6 && _crumbTimer >= 0.3) {
        _crumbTimer = 0;
        const bp = cb.position;
        _crumb.x = bp.x; _crumb.y = bp.y; _crumb.z = bp.z;
        _crumb.qx = 0; _crumb.qy = q.y; _crumb.qz = 0; _crumb.qw = q.w; // yaw only
        const n = Math.hypot(_crumb.qy, _crumb.qw) || 1;
        _crumb.qy /= n; _crumb.qw /= n;
      }

      if (!cinematic) {
        // Track airborne time + how far we've dropped since the wheels left the ground.
        if (wheelsOn > 0) {
          _airTime = 0; _wasGrounded = true; _holdGround = false; _holdTimer = 0;
        } else {
          if (_wasGrounded) { _airStartY = cb.position.y; _wasGrounded = false; }
          _airTime += dt;
        }
        const fellDist  = _airStartY - cb.position.y;     // metres dropped since going airborne
        const fallingV  = -cb.velocity.y;                 // downward speed (m/s), positive = falling
        // Genuine void-fall = airborne long enough AND dropped far AND still plummeting. All three.
        const voidFall  = !_wasGrounded && _airTime >= VOID_MIN_AIR_S &&
                          fellDist >= VOID_MIN_DROP_M && fallingV >= VOID_MIN_FALL_V;

        if ((voidFall || cb.position.y < FALL_FLOOR_Y) && !_holdGround) {
          _recoverToCrumb();
          _holdGround = true;   // brief hover-hold until terrain is confirmed underfoot
          _holdTimer = 0;
        }

        // Hover-hold: pin at the recover point until a wheel touches — but NEVER longer than HOLD_MAX_S,
        // so a bad crumb can't leave the car floating forever (release and let physics take over).
        if (_holdGround) {
          _holdTimer += dt;
          if (wheelsOn > 0 || _holdTimer >= HOLD_MAX_S) {
            _holdGround = false;
          } else {
            cb.velocity.set(0, 0, 0);
            cb.angularVelocity.set(0, 0, 0);
            const restY = _crumb.y + 0.8;
            if (cb.position.y < restY) cb.position.y = restY;
          }
        }
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
    window.removeEventListener('keydown', _onHornDown);
    window.removeEventListener('keyup', _onHornUp);
    window.removeEventListener('blur', _hornBlur);
    sound.hornStop?.();
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
