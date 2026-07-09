/**
 * carPhysicsRapier — the car on Rapier (Rust/WASM) physics, exposing a cannon-es-compatible interface
 * (chassisBody {position,quaternion,velocity,angularVelocity} + vehicle.wheelInfos[].isInContact + the same
 * getters) so carDriver / carModel / carCamera work UNCHANGED. Enabled via ?physics=rapier; cannon stays
 * the default until this matches it.
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
const MAX_STEER = 0.38;            // rad (~22°) at full lock
const BASE_ENGINE_FORCE = 5200;

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
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(CH.x, CH.y, CH.z).setTranslation(0, BOX_OFFSET_Y, 0).setFriction(0.5).setRestitution(0.05),
    chassis,
  );

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
    vc.setWheelFrictionSlip(i, 2.2);
    vc.setWheelSideFrictionStiffness(i, 1.0);
  }

  // ── Cannon-compatible proxy objects (read live from the Rapier body each step) ──
  const _len = function () { return Math.hypot(this.x, this.y, this.z); };  // cannon Vec3.length() parity
  const _pos = { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z, length: _len, set(x, y, z) { chassis.setTranslation({ x, y, z }, true); this.x = x; this.y = y; this.z = z; } };
  const _quat = { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { chassis.setRotation({ x, y, z, w }, true); this.x = x; this.y = y; this.z = z; this.w = w; } };
  const _vel = { x: 0, y: 0, z: 0, length: _len, set(x, y, z) { chassis.setLinvel({ x, y, z }, true); this.x = x; this.y = y; this.z = z; } };
  const _ang = { x: 0, y: 0, z: 0, length: _len, set(x, y, z) { chassis.setAngvel({ x, y, z }, true); this.x = x; this.y = y; this.z = z; } };
  function refresh() {
    const t = chassis.translation(); _pos.x = t.x; _pos.y = t.y; _pos.z = t.z;
    const r = chassis.rotation(); _quat.x = r.x; _quat.y = r.y; _quat.z = r.z; _quat.w = r.w;
    const v = chassis.linvel(); _vel.x = v.x; _vel.y = v.y; _vel.z = v.z;
    const a = chassis.angvel(); _ang.x = a.x; _ang.y = a.y; _ang.z = a.z;
  }
  refresh();
  // collide events aren't wired yet (Rapier uses an event queue) — no-op so carDriver's listener is safe.
  const chassisBody = { position: _pos, quaternion: _quat, velocity: _vel, angularVelocity: _ang, addEventListener() {}, removeEventListener() {} };
  // wheelInfos exposes what carModel reads: isInContact + a worldTransform {position, quaternion} (the wheel's
  // world Y for suspension bounce + orientation carrying the steering angle). carModel applies wheel-spin itself.
  const wheelInfos = wheels.map(() => ({ isInContact: false, worldTransform: { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } } }));
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
  let _currentGear = 1, _currentRpm = IDLE_RPM, _shiftTimer = 0, _reverse = false, _currentSteer = 0, _skidLevel = 0, _isBraking = false;

  function getSpeedKmh() { return vc.currentVehicleSpeed() * 3.6; }

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
    _transmission(absSpeed, throttle, dt);

    // Steering — reduce lock with speed (twitch-free at pace).
    const steerReduction = 1 - Math.min(0.72, absSpeed / 140);
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
    const h = Math.min(dt, 0.035);
    vc.updateVehicle(h);
    world.step();
    refresh();
    for (let i = 0; i < 4; i++) {
      const wi = wheelInfos[i];
      wi.isInContact = vc.wheelIsInContact(i);
      // Wheel world transform: centre = chassis + rotate(local connection − suspensionLength·down);
      // orientation = chassis · steer(about up). carModel uses .position.y (suspension) + .quaternion (steer).
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
    getSkidLevel() { return _skidLevel; },
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
