/**
 * carPhysicsRapier — the car on Rapier (Rust/WASM) physics, exposing a cannon-es-compatible interface
 * (chassisBody {position,quaternion,velocity,angularVelocity} + vehicle.wheelInfos[].isInContact + the same
 * getters) so carDriver / carModel / carCamera work UNCHANGED. Rapier is the DEFAULT engine;
 * ?physics=cannon is the escape hatch back to cannon-es.
 *
 * This is a FIRST-PASS drive model built on Rapier's DynamicRayCastVehicleController — it drives, but the
 * feel (grip, drift, suspension) still needs a tuning pass against the polished cannon car.
 *
 * Rapier is ~17× faster/step and allocates ~5× less garbage than cannon-es (measured) — the point of the
 * swap is killing the physics-driven GC pauses.
 */

// Transmission (speed→gear→rpm) is engine-agnostic — mirrors carPhysics so the tach reads the same.
const GEAR_TOP_SPEEDS = [0, 34, 60, 84, 100, 106, 110];
const NUM_GEARS = 6;
const REDLINE_RPM = 6500, IDLE_RPM = 850, SHIFT_COOLDOWN = 0.30;

// Geometry MATCHES the cannon car so carModel's visual placement (body at the low-CoM origin, wheels at
// their world Y) lines up — otherwise the body floats above the wheels (monster-truck look).
const CH = { x: 0.95, y: 0.715, z: 2.395 };   // collision box half-extents
const BOX_OFFSET_Y = 0.5;                       // box sits UP from the low CoM origin (cannon CHASSIS_BOX_OFFSET_Y)
const CHASSIS_MASS = 1730;                      // kg — real G80 M3 kerb+driver

// Wheel layout (chassis-local, relative to the low origin). Front = +z, RWD (engine on rear).
const WHEEL_Y = 0.20;              // connection point above the low origin (cannon WHEEL_CONNECT_Y)
const HALF_W = 0.78, FRONT_Z = 1.43, REAR_Z = -1.43, WHEEL_R = 0.34, REST_LEN = 0.32;
const MAX_STEER = 0.64;            // rad — Rapier's wheel steering bites less than cannon's, so more lock
const BASE_ENGINE_FORCE = 5200;
const YAW_SPIN_DAMP = 5200;        // N·m per (rad/s)² — quadratic anti-spin: negligible in normal turns,
                                   // firm on a fishtail so the tail can't snap into a full 180. OFF on handbrake.

export function createCarPhysicsRapier(world, RAPIER, spawnPos, heading) {
  // ── Chassis rigid body + collider ──────────────────────────────────────────
  const chassis = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawnPos.x, spawnPos.y, spawnPos.z)
      .setLinearDamping(0.05)
      .setAngularDamping(0.6)
      .setCanSleep(false)
      // Low centre of mass AT the body-frame origin (like the cannon car) + explicit inertia, so
      // body.translation() reads the low origin the visual expects and the car stays planted (anti-roll).
      .setAdditionalMassProperties(
        CHASSIS_MASS,
        { x: 0, y: 0, z: 0 },              // CoM at the (low) frame origin
        { x: 3600, y: 3820, z: 814 },      // principal inertia ≈ box(1.9×1.43×4.79) @1730kg
        { x: 0, y: 0, z: 0, w: 1 },
      ),
  );
  chassis.setRotation({ x: 0, y: Math.sin((heading ?? Math.PI) / 2), z: 0, w: Math.cos((heading ?? Math.PI) / 2) }, true);
  // Box offset UP from the low origin so it sits at body height (cannon CHASSIS_BOX_OFFSET_Y).
  const chassisCollider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(CH.x, CH.y, CH.z).setTranslation(0, BOX_OFFSET_Y, 0).setFriction(0.5).setRestitution(0.05),
    chassis,
  );
  // Contact-force events feed the crash sound (cannon's 'collide' equivalent). The threshold prefilters
  // in Rapier's solver so quiet frames drain an empty queue — set for ~1.5 m/s closing speed
  // (force ≈ m·Δv/dt); carDriver applies its own 2.6 m/s gameplay cutoff on top.
  chassisCollider.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
  chassisCollider.setContactForceEventThreshold(CHASSIS_MASS * 1.5 * 60);

  // ── Raycast vehicle controller + 4 wheels ──────────────────────────────────
  const vc = world.createVehicleController(chassis);
  const down = { x: 0, y: -1, z: 0 }, axle = { x: -1, y: 0, z: 0 };
  const wheels = [
    { x: HALF_W, z: FRONT_Z, steer: true, drive: false },   // 0 FL
    { x: -HALF_W, z: FRONT_Z, steer: true, drive: false },  // 1 FR
    { x: HALF_W, z: REAR_Z, steer: false, drive: true },    // 2 RL
    { x: -HALF_W, z: REAR_Z, steer: false, drive: true },   // 3 RR
  ];
  for (const w of wheels) vc.addWheel({ x: w.x, y: WHEEL_Y, z: w.z }, down, axle, REST_LEN, WHEEL_R);
  for (let i = 0; i < 4; i++) {
    vc.setWheelSuspensionStiffness(i, 28);
    vc.setWheelSuspensionCompression(i, 0.82);
    vc.setWheelSuspensionRelaxation(i, 0.88);
    vc.setWheelMaxSuspensionTravel(i, 0.3);
    // Front a touch grippier than rear (turn-in) but CLOSE — too big a gap made the tail snap out (spin).
    vc.setWheelFrictionSlip(i, wheels[i].steer ? 3.1 : 2.9);
    vc.setWheelSideFrictionStiffness(i, wheels[i].steer ? 1.2 : 1.1);
  }

  // ── Cannon-compatible proxy objects (read live from the Rapier body each step) ──
  const _len = function () { return Math.hypot(this.x, this.y, this.z); };  // cannon Vec3.length() parity
  const _pos = { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z, length: _len, set(x, y, z) { chassis.setTranslation({ x, y, z }, true); this.x = x; this.y = y; this.z = z; } };
  const _quat = { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { chassis.setRotation({ x, y, z, w }, true); this.x = x; this.y = y; this.z = z; this.w = w; } };
  const _vel = { x: 0, y: 0, z: 0, length: _len, set(x, y, z) { chassis.setLinvel({ x, y, z }, true); this.x = x; this.y = y; this.z = z; } };
  const _ang = { x: 0, y: 0, z: 0, length: _len, set(x, y, z) { chassis.setAngvel({ x, y, z }, true); this.x = x; this.y = y; this.z = z; } };
  // Fixed-timestep + interpolation (like cannon's interpolatedPosition): physics steps at a FIXED 60 Hz for
  // stability, and the pose the game reads is interpolated between the last two steps by the render's
  // leftover time — so the car is smooth regardless of frame pacing (a long frame no longer jumps physics).
  const FIXED = 1 / 60;
  let _accum = 0;
  const _dbg = { uv: 0, ws: 0, n: 0, at: 0 };   // dev step-cost breakdown → window._stepBreakdown
  const _prev = { px: spawnPos.x, py: spawnPos.y, pz: spawnPos.z, qx: 0, qy: 0, qz: 0, qw: 1 };
  const _cur  = { px: spawnPos.x, py: spawnPos.y, pz: spawnPos.z, qx: 0, qy: 0, qz: 0, qw: 1 };
  function _snap(d) {
    const t = chassis.translation(); d.px = t.x; d.py = t.y; d.pz = t.z;
    const r = chassis.rotation();    d.qx = r.x; d.qy = r.y; d.qz = r.z; d.qw = r.w;
  }
  _snap(_prev);
  _cur.px = _prev.px; _cur.py = _prev.py; _cur.pz = _prev.pz;
  _cur.qx = _prev.qx; _cur.qy = _prev.qy; _cur.qz = _prev.qz; _cur.qw = _prev.qw;
  _pos.x = _cur.px; _pos.y = _cur.py; _pos.z = _cur.pz;
  _quat.x = _cur.qx; _quat.y = _cur.qy; _quat.z = _cur.qz; _quat.w = _cur.qw;
  // 'collide' events, cannon-shaped: contact-force events drain from the queue each step and dispatch
  // as {contact:{getImpactVelocityAlongNormal}} so carDriver's crash-sound listener works UNCHANGED.
  // Δv is recovered from Rapier's max contact force: force ≈ m·Δv/dt → Δv = force·dt/m.
  const eventQueue = new RAPIER.EventQueue(true);
  const _collideListeners = [];
  const _collideEvent = { contact: { _dv: 0, getImpactVelocityAlongNormal() { return this._dv; } } };
  const chassisBody = {
    position: _pos, quaternion: _quat, velocity: _vel, angularVelocity: _ang,
    addEventListener(type, fn) { if (type === 'collide') _collideListeners.push(fn); },
    removeEventListener(type, fn) {
      const i = _collideListeners.indexOf(fn);
      if (type === 'collide' && i !== -1) _collideListeners.splice(i, 1);
    },
  };
  // wheelInfos exposes what carModel reads: isInContact + a worldTransform {position, quaternion} (the wheel's
  // world Y for suspension bounce + orientation carrying the steering angle). carModel applies wheel-spin itself.
  // raycastResult.hitPointWorld = wheel ground-contact point (world/physics frame) — carEffects places skid
  // marks + tyre smoke there. Persistent object (updated when in contact) so there's no per-frame allocation.
  const wheelInfos = wheels.map(() => ({ isInContact: false, worldTransform: { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }, raycastResult: { hitPointWorld: { x: 0, y: 0, z: 0 } } }));
  const vehicle = { wheelInfos, updateWheelTransform() {} /* transforms are refreshed in step() */ };

  // Rotate a vector by a quaternion (no THREE dependency in the hot path).
  const _rotQ = (q, vx, vy, vz) => {
    const tx = 2 * (q.y * vz - q.z * vy), ty = 2 * (q.z * vx - q.x * vz), tz = 2 * (q.x * vy - q.y * vx);
    return { x: vx + q.w * tx + (q.y * tz - q.z * ty), y: vy + q.w * ty + (q.z * tx - q.x * tz), z: vz + q.w * tz + (q.x * ty - q.y * tx) };
  };
  // quaternion multiply a*b
  const _mulQ = (a, b) => ({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  });

  // ── State ───────────────────────────────────────────────────────────────────
  let _currentGear = 1, _currentRpm = IDLE_RPM, _shiftTimer = 0, _reverse = false, _currentSteer = 0, _skidLevel = 0, _isBraking = false, _handbrake = false;

  // Signed speed = velocity projected onto the car's forward (local +Z), EXACTLY like the cannon car. Using
  // Rapier's currentVehicleSpeed() risked a sign/axis mismatch that made the chase cam's reverse-swing blend
  // oscillate (camera drifting to the side + jitter). This guarantees the sign matches the model's forward.
  function getSpeedKmh() {
    const f = _rotQ(_quat, 0, 0, 1);
    return (_vel.x * f.x + _vel.y * f.y + _vel.z * f.z) * 3.6;
  }

  function _transmission(absSpeed, throttle, dt) {
    _shiftTimer = Math.max(0, _shiftTimer - dt);
    const gearTop = GEAR_TOP_SPEEDS[_currentGear];
    const ratio = Math.min(absSpeed / gearTop, 1);
    _currentRpm += ((IDLE_RPM + ratio * (REDLINE_RPM - IDLE_RPM)) - _currentRpm) * Math.min(1, (_currentRpm < IDLE_RPM + ratio * (REDLINE_RPM - IDLE_RPM) ? 12 : 6) * dt);
    if (_shiftTimer <= 0 && !_reverse) {
      const shiftUp = gearTop * 0.92;
      const prevTop = _currentGear > 1 ? GEAR_TOP_SPEEDS[_currentGear - 1] : 0;
      if (absSpeed >= shiftUp && _currentGear < NUM_GEARS && throttle > 0) { _currentGear++; _shiftTimer = SHIFT_COOLDOWN; }
      else if (_currentGear > 1 && absSpeed < prevTop * 0.7 && absSpeed > 3) { _currentGear--; _shiftTimer = SHIFT_COOLDOWN; }
    }
    if (absSpeed < 2 && throttle === 0) _currentGear = 1;
  }

  function applyInputs({ throttle, brake, steer, handbrake }, dt) {
    const signed = getSpeedKmh();
    const absSpeed = Math.abs(signed);
    _reverse = signed < -0.5;
    _isBraking = brake > 0.05 && signed > 1;
    _handbrake = !!handbrake;
    _transmission(absSpeed, throttle, dt);

    // Steering — reduce lock with speed (twitch-free at pace), but keep more low-speed authority.
    const steerReduction = 1 - Math.min(0.6, absSpeed / 170);
    const targetSteer = steer * MAX_STEER * steerReduction;
    _currentSteer += (targetSteer - _currentSteer) * Math.min(1, 10 * dt);
    vc.setWheelSteering(0, _currentSteer);
    vc.setWheelSteering(1, _currentSteer);

    // Engine force on the rear wheels; taper near the gear's top speed so it settles at ~110 km/h.
    const gearTop = GEAR_TOP_SPEEDS[_currentGear];
    const fade = absSpeed > gearTop * 0.85 ? Math.max(0, 1 - (absSpeed - gearTop * 0.85) / (gearTop * 0.15)) : 1;
    let ef = 0;
    if (brake > 0.05 && signed > 1) {
      ef = 0; // braking handled below
    } else if (throttle > 0.02) {
      ef = throttle * BASE_ENGINE_FORCE * fade;
    } else if (brake > 0.05) {
      ef = -brake * BASE_ENGINE_FORCE * 0.6; // reverse
    }
    vc.setWheelEngineForce(2, ef);
    vc.setWheelEngineForce(3, ef);

    // Braking on all wheels when braking forward.
    const brakeForce = (brake > 0.05 && signed > 1) ? brake * 90 : 0;
    for (let i = 0; i < 4; i++) vc.setWheelBrake(i, brakeForce);

    // Handbrake → lock rears + drop their grip so the tail steps out (drift).
    if (handbrake) {
      vc.setWheelBrake(2, 60); vc.setWheelBrake(3, 60);
      vc.setWheelFrictionSlip(2, 0.9); vc.setWheelFrictionSlip(3, 0.9);
      _skidLevel = Math.min(1, _skidLevel + dt * 4);
    } else {
      vc.setWheelFrictionSlip(2, 2.2); vc.setWheelFrictionSlip(3, 2.2);
      _skidLevel = Math.max(0, _skidLevel - dt * 3);
    }
  }

  // carDriver calls this instead of cannon's world.step() when a physics.step exists.
  function step(dt) {
    world.timestep = FIXED;
    _accum += Math.min(dt || FIXED, 0.1);   // clamp so a long pause / tab-out doesn't spiral
    while (_accum >= FIXED) {
      _prev.px = _cur.px; _prev.py = _cur.py; _prev.pz = _cur.pz;
      _prev.qx = _cur.qx; _prev.qy = _cur.qy; _prev.qz = _cur.qz; _prev.qw = _cur.qw;
      // Quadratic anti-spin yaw torque — stops a fishtail snapping into a full 180 (OFF on handbrake so a
      // deliberate drift stays free). resetTorques each step so it doesn't accumulate across steps.
      chassis.resetTorques(false);
      if (!_handbrake) {
        const yr = chassis.angvel().y;
        chassis.addTorque({ x: 0, y: -yr * Math.abs(yr) * YAW_SPIN_DAMP, z: 0 }, false);
      }
      // Dev breakdown: split updateVehicle (wheel raycasts) vs world.step (broadphase/narrowphase/solver)
      // so we can see WHERE the step cost lives instead of guessing. Read via window._stepBreakdown.
      const _t0 = performance.now();
      vc.updateVehicle(FIXED);
      const _t1 = performance.now();
      world.step(eventQueue);
      if (_collideListeners.length > 0) {
        eventQueue.drainContactForceEvents((ev) => {
          _collideEvent.contact._dv = (ev.maxForceMagnitude() * FIXED) / CHASSIS_MASS;
          for (const fn of _collideListeners) fn(_collideEvent);
        });
      } else {
        eventQueue.clear();
      }
      const _t2 = performance.now();
      _dbg.uv += _t1 - _t0; _dbg.ws += _t2 - _t1; _dbg.n++;
      if (_t2 - _dbg.at > 1000) {
        if (typeof window !== 'undefined') {
          window._stepBreakdown = {
            updateVehicleMs: +(_dbg.uv / _dbg.n).toFixed(3),
            worldStepMs: +(_dbg.ws / _dbg.n).toFixed(3),
            stepsPerSec: _dbg.n,
            colliders: world.colliders?.len?.() ?? -1,
            bodies: world.bodies?.len?.() ?? -1,
          };
        }
        _dbg.uv = 0; _dbg.ws = 0; _dbg.n = 0; _dbg.at = _t2;
      }
      _snap(_cur);
      _accum -= FIXED;
    }
    // A teleport (recover) makes cur jump far from prev — don't smear across it.
    if (Math.abs(_cur.px - _prev.px) + Math.abs(_cur.pz - _prev.pz) > 5) {
      _prev.px = _cur.px; _prev.py = _cur.py; _prev.pz = _cur.pz;
      _prev.qx = _cur.qx; _prev.qy = _cur.qy; _prev.qz = _cur.qz; _prev.qw = _cur.qw;
    }
    // Interpolate the exposed pose between the last two physics states by the leftover accumulator.
    const a = Math.max(0, Math.min(1, _accum / FIXED));
    _pos.x = _prev.px + (_cur.px - _prev.px) * a;
    _pos.y = _prev.py + (_cur.py - _prev.py) * a;
    _pos.z = _prev.pz + (_cur.pz - _prev.pz) * a;
    const sgn = (_prev.qx * _cur.qx + _prev.qy * _cur.qy + _prev.qz * _cur.qz + _prev.qw * _cur.qw) < 0 ? -1 : 1;
    let qx = _prev.qx + (_cur.qx * sgn - _prev.qx) * a;
    let qy = _prev.qy + (_cur.qy * sgn - _prev.qy) * a;
    let qz = _prev.qz + (_cur.qz * sgn - _prev.qz) * a;
    let qw = _prev.qw + (_cur.qw * sgn - _prev.qw) * a;
    const inv = 1 / (Math.hypot(qx, qy, qz, qw) || 1);
    _quat.x = qx * inv; _quat.y = qy * inv; _quat.z = qz * inv; _quat.w = qw * inv;
    // Velocity/angular read from the live body (used for speed/effects — no interpolation needed).
    const v = chassis.linvel(); _vel.x = v.x; _vel.y = v.y; _vel.z = v.z;
    const av = chassis.angvel(); _ang.x = av.x; _ang.y = av.y; _ang.z = av.z;
    // Wheels follow the interpolated body pose.
    for (let i = 0; i < 4; i++) {
      const wi = wheelInfos[i];
      wi.isInContact = vc.wheelIsInContact(i);
      if (wi.isInContact) {
        const cp = vc.wheelContactPoint(i);
        if (cp) { wi.raycastResult.hitPointWorld.x = cp.x; wi.raycastResult.hitPointWorld.y = cp.y; wi.raycastResult.hitPointWorld.z = cp.z; }
      }
      const suspLen = vc.wheelSuspensionLength(i) ?? REST_LEN;
      const local = _rotQ(_quat, wheels[i].x, WHEEL_Y - suspLen, wheels[i].z);
      wi.worldTransform.position.x = _pos.x + local.x;
      wi.worldTransform.position.y = _pos.y + local.y;
      wi.worldTransform.position.z = _pos.z + local.z;
      const st = wheels[i].steer ? _currentSteer : 0;
      const q = _mulQ(_quat, { x: 0, y: Math.sin(st / 2), z: 0, w: Math.cos(st / 2) });
      wi.worldTransform.quaternion.x = q.x; wi.worldTransform.quaternion.y = q.y;
      wi.worldTransform.quaternion.z = q.z; wi.worldTransform.quaternion.w = q.w;
    }
  }

  function dispose() {
    try { world.removeVehicleController(vc); } catch {}
    try { world.removeRigidBody(chassis); } catch {}
    try { eventQueue.free(); } catch {}
    _collideListeners.length = 0;
  }

  const _fwd = { x: 0, y: 0, z: 0 };
  function getUpDot() {
    // chassis up (local +Y) rotated → world Y component. 1 = upright.
    const q = _quat;
    return 1 - 2 * (q.x * q.x + q.z * q.z);
  }

  // Drift factor 0..1 — how sideways the velocity is vs the car's forward, boosted by handbrake skid.
  function getDriftFactor() {
    const spd = Math.hypot(_vel.x, _vel.z);
    if (spd < 2) return _skidLevel;
    const f = _rotQ(_quat, 0, 0, 1);                    // forward = local +Z in world
    const fdot = (_vel.x * f.x + _vel.z * f.z) / spd;   // cos(slip angle)
    const slip = Math.sqrt(Math.max(0, 1 - fdot * fdot)); // sin(slip angle) = lateral fraction
    return Math.min(1, Math.max(_skidLevel, slip * 1.5));
  }

  return {
    chassisBody, vehicle, step, applyInputs, getSpeedKmh, dispose,
    getSkidLevel() { return getDriftFactor(); },   // real lateral slip + handbrake, so smoke/marks show in slides
    getCurrentSteer() { return _currentSteer; },
    getCurrentGear() { return _reverse ? -1 : _currentGear; },
    getCurrentRpm() { return _currentRpm; },
    getUpDot,
    getDriftFactor,
    isBraking() { return _isBraking; },
    isReversing() { return _reverse; },
    getCurrentForce() { return 0; },
  };
}
