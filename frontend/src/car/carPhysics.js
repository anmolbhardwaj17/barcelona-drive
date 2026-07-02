/**
 * Car physics — CANNON.RaycastVehicle chassis + 4 wheels.
 *
 * Coordinate convention: Y-up, +Z forward, +X right (same as Three.js).
 * All positions are in physics-local space (world − originOffset).
 *
 * getCarContactMaterials() is also exported so tileManager can brand
 * new terrain / deck bodies with the matching road material.
 */
import * as CANNON from 'cannon-es';
import { COLLISION_GROUP_GROUND, COLLISION_GROUP_VEHICLE, COLLISION_GROUP_WORLD, COLLISION_GROUP_TERRAIN, assertTerrainVehicleHandshake } from '../collisionGroups.js';

// Real-metre BMW M3 (G80) authored directly on the honest coordinate system (Stage 1 complete:
// 1 world unit = 1 real metre). No CAR_XZ / cos factor — the unit scale is baked into the
// projection, so chassis/wheel dims go in as literal real metres. Targets:
//   length 4.79m · width 1.90m · height 1.43m · wheelbase 2.86m · track ~1.62m.

// ── Shared materials (lazily created once per page load) ─────────────────────
let _roadMat = null;
let _carMat  = null;

export function getCarContactMaterials(world) {
  if (!_roadMat) {
    _roadMat = new CANNON.Material('road');
    _carMat  = new CANNON.Material('car');
    world.addContactMaterial(new CANNON.ContactMaterial(_roadMat, _carMat, {
      friction:                   0.6,
      restitution:                0.0,
      contactEquationStiffness:   1e8,
      contactEquationRelaxation:  4,
      frictionEquationStiffness:  1e8,
      frictionEquationRelaxation: 4,
    }));
  }
  return { roadMaterial: _roadMat, carMaterial: _carMat };
}

// ── PART A: GEOMETRY (real M3 size — not feel; set precisely) ───────────────────
const WHEEL_RADIUS      = 0.34;   // m — 245/35 R19 ≈ 0.68m diameter
const TRACK_HALF        = 0.78;   // m — ±x wheel offset (was ±0.81=1.62m track; pulled in so wheels tuck under 1.90m body)
const WHEELBASE_HALF    = 1.43;   // m — ±z wheel offset (2.86m wheelbase)
// LOW CENTRE OF MASS (anti-wheelie / anti-slide). In cannon-es the body origin IS the CoM.
// We keep the origin LOW (near the wheels) and lift the collision box + visual up to body height,
// so drive force at the contacts has a short lever arm about the CoM → far less nose-lift.
const WHEEL_CONNECT_Y   = 0.20;   // m — suspension attaches ABOVE the (low) origin → origin/CoM settles low (~0.3m)
const CHASSIS_BOX_OFFSET_Y = 0.5; // m — collision box shifted up from the low CoM origin to sit at body height (MUST match carModel)
const SUSP_REST         = 0.32;   // m — rest length; with mass/stiffness sets ride height (see report)
const SUSP_MAX_TRAVEL   = 0.22;   // m — travel headroom for DEM bumps

// ── PART B: FEEL (tune these by driving — starting M3-ish values, NOT final) ────
//   Each line: what it does. Old value in the change-report I handed back.
const CHASSIS_MASS      = 1730;   // kg — real G80 M3 kerb+driver. Heavier = more inertia, planted.
const SUSP_STIFFNESS    = 55;     // spring rate — higher = firmer/less body dive; lower = floaty.
const SUSP_DAMPING_R    = 3.4;    // rebound damping — how fast suspension extends back (bounce control).
const SUSP_DAMPING_C    = 4.5;    // compression damping — bump absorption; high = harsh, low = wallowy.
const SUSP_MAX_FORCE    = 130000; // N — suspension force clamp; raise if the heavier car bottoms out.
const FRICTION_SLIP     = 4.5;    // tyre grip — lower = more slide/oversteer (RWD character); higher = stuck.
const DRIFT_YAW_ASSIST  = 13000;  // N·m·(unit steer) — handbrake yaw torque; higher = tail swings out harder.
const YAW_SPIN_DAMP     = 2600;   // N·m per (rad/s)² — quadratic anti-spin. Negligible in normal turns, firm on a
                                  // fishtail/spin. OFF during handbrake so deliberate drift stays free. Raise to tame oversteer more.
const ROLL_INFLUENCE    = 0.08;   // weight transfer in turns — higher = more lean/flip risk; keep low.
const BASE_ENGINE_FORCE = 6000;   // N — drive force (lowered from 9000: was overpowering → wheelies). Tune for ~4s 0–100.
const BRAKE_FORCE       = 420;    // N — per-wheel braking (was 600: overshot → stoppie/rear-lift). Nose dips, rear stays planted.
const MAX_STEER         = 0.38;   // rad (~22°) — max steer angle at low speed.
const MIN_STEER         = 0.10;   // rad (~6°) — min steer angle at high speed (speed-sensitive).
const MAX_PITCH_ROLL_VEL = 1.5;   // rad/s — clamp pitch/roll rate to prevent wheelies/flips.

// ── Transmission ────────────────────────────────────────────────────────────
// BMW M3 — 6-speed, higher top speed, punchier ratios
const GEAR_RATIOS = [0, 3.2, 2.2, 1.55, 1.18, 0.94, 0.78];
const NUM_GEARS = 6;
const REDLINE_RPM = 6500;          // M3 S58 engine
const IDLE_RPM = 850;
const SHIFT_DOWN_RPM = 2000;       // shift down here
const MAX_RPM = 7000;              // hard rev limiter
const SHIFT_COOLDOWN = 0.30;       // seconds — quick DCT shifts
// Top speed per gear (km/h) — BMW M3, tops ~280 km/h
const GEAR_TOP_SPEEDS = [0, 55, 95, 145, 195, 245, 280];

export function createCarPhysics(world, spawnPos, spawnHeading) {
  const { roadMaterial, carMaterial } = getCarContactMaterials(world);

  // Brand all existing static bodies (terrain, ground plane, ramp boxes)
  for (const b of world.bodies) {
    if (b.mass === 0) b.material = roadMaterial;
  }

  // ── Chassis ───────────────────────────────────────────────────────────────
  // Half-extents scaled to match visual car (CAR_VISUAL_SCALE = 0.75)
  // 0.75 wide, 0.26 tall, 1.65 long  →  1.5 × 0.52 × 3.3 m box
  const chassisBody = new CANNON.Body({
    mass:           CHASSIS_MASS,
    material:       carMaterial,
    linearDamping:  0.12,
    angularDamping: 0.4,    // resist pitch/roll from acceleration torque
    allowSleep:     false,
  });
  // Centered chassis shape — no offset. Clean inertia tensor prevents
  // oscillation between suspension forces and angular response.
  // Chassis doesn't collide with ground (mask excludes GROUND), so no clipping.
  // Real G80 M3 half-extents: 1.90/2 × 1.43/2 × 4.79/2 = 0.95 × 0.715 × 2.395 (full 1.90×1.43×4.79 m).
  // Shifted UP by CHASSIS_BOX_OFFSET_Y so it sits at body height while the body origin (CoM) stays low.
  chassisBody.addShape(new CANNON.Box(new CANNON.Vec3(0.95, 0.715, 2.395)), new CANNON.Vec3(0, CHASSIS_BOX_OFFSET_Y, 0));
  chassisBody.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  const heading = spawnHeading != null ? spawnHeading : Math.PI;
  chassisBody.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), heading);
  chassisBody.collisionFilterGroup = COLLISION_GROUP_VEHICLE;
  // Collide with world objects AND the terrain trimesh — NOT road-deck GROUND boxes.
  // On-road contact is wheel raycasts + suspension on the deck boxes; adding chassis-vs-GROUND
  // makes the two systems fight and stutter on box-edge seams. But TERRAIN must stay in the
  // mask: cannon-es rays cannot hit CANNON.Trimesh, so the chassis-vs-terrain body collision
  // is the ONLY thing holding the car off-road (the G-49 backstop). Dropping TERRAIN here
  // (the D-16 revert did) = car free-falls through terrain off-road.
  chassisBody.collisionFilterMask  = COLLISION_GROUP_WORLD | COLLISION_GROUP_TERRAIN;
  world.addBody(chassisBody);
  assertTerrainVehicleHandshake(world); // G-51: validates the pair if terrain bodies already exist

  // ── RaycastVehicle ────────────────────────────────────────────────────────
  const vehicle = new CANNON.RaycastVehicle({
    chassisBody,
    indexForwardAxis: 2,   // +Z
    indexRightAxis:   0,   // +X
    indexUpAxis:      1,   // +Y
  });

  const baseWheel = {
    radius:                          WHEEL_RADIUS,
    directionLocal:                  new CANNON.Vec3(0, -1, 0),
    axleLocal:                       new CANNON.Vec3(-1, 0, 0),
    suspensionRestLength:            SUSP_REST,
    suspensionStiffness:             SUSP_STIFFNESS,
    dampingRelaxation:               SUSP_DAMPING_R,
    dampingCompression:              SUSP_DAMPING_C,
    maxSuspensionForce:              SUSP_MAX_FORCE,
    maxSuspensionTravel:             SUSP_MAX_TRAVEL,
    frictionSlip:                    FRICTION_SLIP,
    rollInfluence:                   ROLL_INFLUENCE,
    useCustomSlidingRotationalSpeed: true,
    customSlidingRotationalSpeed:    -30,
  };

  // [FL, FR, RL, RR] — connection point in chassis-local space (TRACK_HALF ±x, WHEELBASE_HALF ±z).
  [
    { x: -TRACK_HALF, z:  WHEELBASE_HALF, front: true  },
    { x:  TRACK_HALF, z:  WHEELBASE_HALF, front: true  },
    { x: -TRACK_HALF, z: -WHEELBASE_HALF, front: false },
    { x:  TRACK_HALF, z: -WHEELBASE_HALF, front: false },
  ].forEach(({ x, z, front }) => {
    vehicle.addWheel({
      ...baseWheel,
      chassisConnectionPointLocal: new CANNON.Vec3(x, WHEEL_CONNECT_Y, z),  // axle line below chassis centre
      isFrontWheel: front,
    });
  });

  vehicle.addToWorld(world);
  if (typeof window !== 'undefined') window._debugVehicle = vehicle; // dev: inspect wheelInfos[].raycastResult

  // ── Internal state ────────────────────────────────────────────────────────
  let _reverse = false;
  let _currentSteer = 0;
  let _driftFactor = 0;
  let _isBraking = false;
  let _skidLevel = 0;   // 0..1 tyre-slip for skid marks + smoke: real sideways slide OR handbrake OR hard braking
  let _handbraking = false;
  let _currentGear = 1;
  let _currentRpm = IDLE_RPM;
  let _shiftTimer = 0;  // cooldown after gear change
  const _fwd   = new CANNON.Vec3();
  const _downForce = new CANNON.Vec3();
  const _lateralForce = new CANNON.Vec3();
  const _right = new CANNON.Vec3();
  const _zeroPoint = new CANNON.Vec3();  // COM-relative application point
  const _antiFlipUp = new CANNON.Vec3();
  const _antiFlipCarUp = new CANNON.Vec3();
  const _antiFlipCross = new CANNON.Vec3();
  const STEER_LERP_SPEED = 3.5;
  const DOWNFORCE_COEFF = 0.50;   // strong downforce — prevents flipping in hard turns
  const LATERAL_DAMP = 0.6;       // let the car slide and feel its weight

  // ── Helpers ───────────────────────────────────────────────────────────────
  function getSpeedKmh() {
    _fwd.set(0, 0, 1);
    chassisBody.quaternion.vmult(_fwd, _fwd);
    return _fwd.dot(chassisBody.velocity) * 3.6;
  }

  /**
   * @param {{ throttle: number, brake: number, steer: number }} state
   * @param {number} dt — frame delta in seconds
   */
  function applyInputs({ throttle, brake, steer, handbrake }, dt) {
    const speed = getSpeedKmh();
    const absSpeed = Math.abs(speed);

    // Reverse: hold brake when nearly stopped to start reversing
    if (brake > 0 && absSpeed < 1.0) _reverse = true;
    if (throttle > 0)                _reverse = false;

    // Track braking state for effects
    _isBraking = !_reverse && brake > 0 && absSpeed > 5;

    // ── Transmission & RPM ──────────────────────────────────────────────────
    _shiftTimer = Math.max(0, _shiftTimer - dt);

    // Calculate RPM from speed and current gear
    const gearTopSpeed = GEAR_TOP_SPEEDS[_currentGear];
    const speedRatio = Math.min(absSpeed / gearTopSpeed, 1.0);
    const rawRpm = IDLE_RPM + speedRatio * (REDLINE_RPM - IDLE_RPM);

    // Smooth RPM changes (quick rise, slower fall)
    const rpmTarget = throttle > 0 ? rawRpm : Math.max(IDLE_RPM, rawRpm * 0.9);
    const rpmLerp = _currentRpm < rpmTarget ? 12 : 6; // faster rise, slower fall
    _currentRpm += (rpmTarget - _currentRpm) * Math.min(1, rpmLerp * dt);

    // Auto-shift logic — shift up when speed exceeds 85% of gear's top speed
    const shiftUpSpeed = gearTopSpeed * 0.82;
    // Shift down when speed drops below 70% of previous gear's top speed
    const prevGearTop = _currentGear > 1 ? GEAR_TOP_SPEEDS[_currentGear - 1] : 0;
    const shiftDownSpeed = prevGearTop * 0.7;

    if (_shiftTimer <= 0 && !_reverse) {
      if (absSpeed >= shiftUpSpeed && _currentGear < NUM_GEARS && throttle > 0) {
        // Shift up — RPM drops
        _currentGear++;
        _shiftTimer = SHIFT_COOLDOWN;
        const newTopSpeed = GEAR_TOP_SPEEDS[_currentGear];
        _currentRpm = IDLE_RPM + (absSpeed / newTopSpeed) * (REDLINE_RPM - IDLE_RPM);
      } else if (_currentGear > 1 && absSpeed < shiftDownSpeed && absSpeed > 3) {
        // Shift down — RPM jumps up
        _currentGear--;
        _shiftTimer = SHIFT_COOLDOWN;
        const newTopSpeed = GEAR_TOP_SPEEDS[_currentGear];
        _currentRpm = IDLE_RPM + (absSpeed / newTopSpeed) * (REDLINE_RPM - IDLE_RPM);
      }
    }

    // Reset to gear 1 when stopped
    if (absSpeed < 2 && throttle === 0) _currentGear = 1;

    // Rev limiter — smooth power reduction near max RPM (no hard cut)
    const revLimiterFade = _currentRpm > MAX_RPM * 0.92
      ? Math.max(0, 1.0 - (_currentRpm - MAX_RPM * 0.92) / (MAX_RPM * 0.08))
      : 1.0;

    // Gear shift — smooth torque reduction instead of hard cut
    // Ramp from 100% to 15% over the first half of shift, then back to 100%
    let shiftMult = 1.0;
    if (_shiftTimer > 0) {
      const shiftProgress = 1.0 - (_shiftTimer / SHIFT_COOLDOWN); // 0 → 1 over shift
      if (shiftProgress < 0.5) {
        shiftMult = 0.15 + 0.85 * (shiftProgress * 2); // ramp back up
      }
    }

    // Engine force based on gear ratio and torque curve
    const gearRatio = GEAR_RATIOS[_currentGear];
    // Torque curve — peaks mid-RPM range, falls off at extremes
    const rpmNorm = (_currentRpm - IDLE_RPM) / (MAX_RPM - IDLE_RPM);
    const torqueCurve = 1.0 - 0.3 * Math.pow(rpmNorm - 0.5, 2);
    const engineForce = BASE_ENGINE_FORCE * gearRatio * torqueCurve;

    // Taper force near gear top speed so car doesn't over-accelerate
    const topSpeed = GEAR_TOP_SPEEDS[_currentGear];
    const speedFade = absSpeed > topSpeed * 0.85
      ? Math.max(0, 1.0 - (absSpeed - topSpeed * 0.85) / (topSpeed * 0.15))
      : 1.0;

    // Launch ramp to prevent suspension jolt from standstill
    const launchRamp = Math.min(1, absSpeed / 8);
    const rampedForce = engineForce * (0.4 + 0.6 * launchRamp) * speedFade * revLimiterFade * shiftMult;

    let ef;
    if (_reverse) {
      const revFade = absSpeed > 25 ? Math.max(0, 1 - (absSpeed - 25) / 5) : 1; // cap ~30 km/h
      ef = +(brake * BASE_ENGINE_FORCE * 0.5 * revFade);
    } else {
      ef = -(throttle * rampedForce);
    }

    vehicle.applyEngineForce(0,  0);
    vehicle.applyEngineForce(0,  1);
    vehicle.applyEngineForce(ef, 2);
    vehicle.applyEngineForce(ef, 3);

    // Brakes
    _handbraking = handbrake > 0;
    if (_handbraking) {
      // Handbrake — lock rear wheels, free front for steering
      vehicle.setBrake(0, 0);
      vehicle.setBrake(0, 1);
      vehicle.setBrake(BRAKE_FORCE * 2.2, 2); // break rear traction but DON'T halt the car — keeps drift momentum
      vehicle.setBrake(BRAKE_FORCE * 2.2, 3);
    } else {
      const bf = (_reverse || brake === 0) ? 0 : brake * BRAKE_FORCE;
      for (let i = 0; i < 4; i++) vehicle.setBrake(bf, i);
    }

    // Engine braking / rolling resistance when coasting (no throttle, no brake)
    if (throttle === 0 && brake === 0 && !_reverse && !_handbraking && absSpeed > 1) {
      // Gentle engine braking — enough to slow down but not stutter
      const coastBrake = 8 + absSpeed * 0.08;
      for (let i = 0; i < 4; i++) vehicle.setBrake(coastBrake, i);
    }

    // Speed-sensitive steering — smoothly reduce from MAX_STEER to MIN_STEER
    const steerT = Math.min(1, absSpeed / 120);
    const maxS = MAX_STEER + (MIN_STEER - MAX_STEER) * steerT;

    // At very low speed (coasting / no throttle), reduce steering so the car
    // doesn't pivot on the spot — ramp from 30% at 0 km/h to 100% at 15 km/h
    const lowSpeedDamp = throttle > 0 ? 1.0 : (0.3 + 0.7 * Math.min(1, absSpeed / 15));

    // Steering smoothing
    const targetSteer = steer * maxS * lowSpeedDamp;
    const steerDelta = targetSteer - _currentSteer;
    _currentSteer += Math.sign(steerDelta) * Math.min(Math.abs(steerDelta), STEER_LERP_SPEED * dt);
    vehicle.setSteeringValue(_currentSteer, 0);
    vehicle.setSteeringValue(_currentSteer, 1);

    // Drift — progressive rear grip reduction for smooth handbrake turns
    const absSteering = Math.abs(_currentSteer);

    // Handbrake drift: ramp up smoothly, maintain momentum for smooth sliding
    const hbTarget = _handbraking ? Math.min(1, absSpeed / 20) : 0;
    const driftLerp = _handbraking ? 4.0 : 2.0; // build up faster, release slower
    _driftFactor += (hbTarget - _driftFactor) * Math.min(1, driftLerp * dt);

    // Throttle-steer drift at high speed — kept SMALL so normal cornering stays planted (the car was
    // tail-happy: rear grip dropped too much just from steering). Deliberate slides come from the handbrake.
    const turnDrift = Math.min(0.1, (absSteering / MAX_STEER) * (absSpeed / 130));
    const totalDrift = Math.min(1, _driftFactor + turnDrift);

    // Rear grip — handbrake gives progressive slide, not instant lockup
    const rearSlip = FRICTION_SLIP * (1 - totalDrift * 0.85); // deeper grip loss → a real slide angle
    vehicle.wheelInfos[2].frictionSlip = rearSlip;
    vehicle.wheelInfos[3].frictionSlip = rearSlip;

    // Front tires keep strong grip for confident steering (slight understeer at limit)
    const frontGripLoss = Math.min(0.5, absSteering * absSpeed / 250);
    vehicle.wheelInfos[0].frictionSlip = FRICTION_SLIP - frontGripLoss;
    vehicle.wheelInfos[1].frictionSlip = FRICTION_SLIP - frontGripLoss;

    // Downforce — grows with speed squared for high-speed stability
    const speedMs = absSpeed / 3.6;
    _downForce.set(0, -DOWNFORCE_COEFF * speedMs * speedMs, 0);
    chassisBody.applyForce(_downForce, _zeroPoint);

    // Lateral stabilization — reduced during drift for smooth sliding
    _right.set(1, 0, 0);
    chassisBody.quaternion.vmult(_right, _right);
    const lateralSpeed = _right.dot(chassisBody.velocity);

    // Tyre-slip level for skid marks + smoke. Restores marks on hard turns & braking (not just handbrake):
    // real sideways slide, OR handbrake/steering drift, OR hard braking at speed (wheel lockup).
    const _slideMag = Math.abs(lateralSpeed);
    _skidLevel = Math.max(
      totalDrift,                                    // handbrake + steering-induced drift
      Math.min(1, _slideMag / 3),                    // sideways slide: ≥3 m/s → full
      (brake > 0 && absSpeed > 18) ? Math.min(1, (absSpeed - 18) / 35) : 0 // hard braking lockup
    );
    const coastGrip = throttle === 0 && !_handbraking ? 1.3 : 1.0;
    // During handbrake drift, dramatically reduce lateral damping so car slides freely
    const driftRelease = _handbraking ? 0.15 : (1 - totalDrift * 0.4);
    const dampFactor = LATERAL_DAMP * driftRelease * coastGrip;
    _lateralForce.copy(_right);
    _lateralForce.scale(-lateralSpeed * CHASSIS_MASS * dampFactor, _lateralForce);
    chassisBody.applyForce(_lateralForce, _zeroPoint);

    // ── Arcade drift assist ── while handbraking + moving, add yaw torque toward the steering so the
    // tail swings out and the car holds a controllable slide (flip the sign if it drifts the wrong way).
    if (_handbraking && absSpeed > 4) {
      chassisBody.torque.y += _currentSteer * Math.min(1, absSpeed / 35) * DRIFT_YAW_ASSIST;
    }

    // ── Anti-spin (stability) ── quadratic yaw-rate damping when NOT handbraking. Scales with yaw²,
    // so it's negligible in a normal turn but firmly catches a fishtail/spin before it lets go. This is
    // what tames the tail-happy feel; handbrake drift is exempt so deliberate slides stay controllable.
    if (!_handbraking && absSpeed > 3) {
      const yawRate = chassisBody.angularVelocity.y;
      chassisBody.torque.y -= yawRate * Math.abs(yawRate) * YAW_SPIN_DAMP;
    }

    // Smooth pitch/roll damping — dt-based exponential decay for frame-rate independence.
    // Prevents stutter from hard angular velocity spikes on bumps.
    const av = chassisBody.angularVelocity;
    const pitchRollDamp = Math.pow(0.005, dt);  // ~92% retention at 60fps, firm but smooth
    av.x *= pitchRollDamp;
    av.z *= pitchRollDamp;

    // Anti-flip: gentle corrective torque when car tilts beyond safe range
    _antiFlipUp.set(0, 1, 0);
    chassisBody.quaternion.vmult(_antiFlipUp, _antiFlipCarUp);
    const tiltDot = _antiFlipCarUp.dot(_antiFlipUp);
    if (tiltDot < 0.9) {
      const correctionStrength = (1 - tiltDot) * 6000;
      _antiFlipCarUp.cross(_antiFlipUp, _antiFlipCross);
      _antiFlipCross.scale(correctionStrength, _antiFlipCross);
      chassisBody.torque.vadd(_antiFlipCross, chassisBody.torque);
    }
  }

  function dispose() {
    vehicle.removeFromWorld(world);
    world.removeBody(chassisBody);
  }

  return {
    chassisBody, vehicle, getSpeedKmh, applyInputs, dispose,
    getDriftFactor() { return _driftFactor; },
    getSkidLevel() { return _skidLevel; },
    isBraking() { return _isBraking; },
    isReversing() { return _reverse; },
    getCurrentGear() { return _reverse ? -1 : _currentGear; },
    getCurrentRpm() { return _currentRpm; },
    getCurrentSteer() { return _currentSteer; },
  };
}
