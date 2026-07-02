# Vehicle System

## Overview

The vehicle system is orchestrated by `carDriver.js`, which is the only car-related object `main.js` holds. Everything else (physics, controls, camera, model, effects, sound) is created inside `createCarDriver()` and accessed only via the driver's public API.

```
carDriver.js (façade)
├─ carPhysics.js    ← RaycastVehicle, forces, transmission
├─ carControls.js   ← Keyboard input
├─ carCamera.js     ← Chase camera
├─ carModel.js      ← GLB + body lean
├─ carEffects.js    ← Skid marks, tire smoke
└─ carSound.js      ← Web Audio engine sound
```

**Driver public API** (consumed by `main.js`):
```js
driver.update(dt)
driver.getLocalPosition()  → { lx, lz }   // physics-space (not world-space!)
driver.getSpeedKmh()       → number
driver.getHeadingDeg()     → number
driver.getCurrentGear()    → number (-1 = reverse)
driver.getCurrentRpm()     → number
driver.dispose()
driver.toggleSound()
```

---

## Physics Model (`carPhysics.js`)

Uses `CANNON.RaycastVehicle` — wheel contact is simulated by downward raycasts from each wheel attachment point, not by actual wheel-shaped geometry. This avoids expensive mesh-mesh collision at the cost of some realism on very rough terrain.

### CRITICAL: carPhysics.js Defines Its Own Constants

**`carPhysics.js` ignores CONFIG for its vehicle parameters.** The file hardcodes its own constants that take precedence over any CONFIG values. `config.js` has `CAR_CHASSIS_MASS`, `MAX_ENGINE_FORCE`, `SUSPENSION_STIFFNESS`, etc. — these are NOT read by carPhysics.js.

If you change a physics value, you must change it in **`carPhysics.js` directly**, not in `config.js`.

The CONFIG car-physics values (`CAR_CHASSIS_MASS: 1200`, `MAX_ENGINE_FORCE: 4000`, etc.) appear to be older tuning that was superseded — they are effectively dead for the active physics. See [config-reference.md](config-reference.md) for which CONFIG flags are live vs dead.

### Chassis

| Parameter | Value | Notes |
|---|---|---|
| Mass | 1600 kg | BMW M3 + driver |
| Shape | CANNON.Box | half-extents 0.70 × 0.20 × 1.55 m |
| Linear damping | 0.12 | light air resistance |
| Angular damping | 0.4 | resists pitch/roll from acceleration |
| Collision group | VEHICLE (2) | |
| Collision mask | WORLD (4) | chassis never touches GROUND — wheel raycasts only |
| `allowSleep` | false | car must always be simulated |

The chassis box is deliberately sized smaller than the visual car (0.75 scale factor) so wheels have clean contact without body-ground interference.

### Wheels

Four wheels: `[FL, FR, RL, RR]`

| Parameter | Value |
|---|---|
| Radius | 0.30 m |
| `directionLocal` | (0, -1, 0) — ray shoots downward |
| `axleLocal` | (-1, 0, 0) |
| Suspension rest length | 0.30 m |
| Suspension stiffness | 60 N/m |
| Damping relaxation | 3.2 (rebound) |
| Damping compression | 4.0 |
| Max suspension force | 120,000 N |
| Max suspension travel | 0.25 m |
| Friction slip | 5.0 (baseline, modulated per frame) |
| Roll influence | 0.08 (low — prevents flipping in turns) |

Connection points (chassis-local):
```
FL: (-0.68,  -0.10,  1.2)   FR: (0.68, -0.10,  1.2)
RL: (-0.68,  -0.10, -1.2)   RR: (0.68, -0.10, -1.2)
```

`indexForwardAxis = 2` (+Z forward), `indexRightAxis = 0` (+X right), `indexUpAxis = 1` (+Y up).

### Drive layout

**Rear-wheel drive.** Engine force applied only to wheels 2 (RL) and 3 (RR):
```js
vehicle.applyEngineForce(0,  0);  // FL — no drive
vehicle.applyEngineForce(0,  1);  // FR — no drive
vehicle.applyEngineForce(ef, 2);  // RL — driven
vehicle.applyEngineForce(ef, 3);  // RR — driven
```

### Transmission

6-speed automatic. Parameters:

```js
GEAR_RATIOS    = [0, 3.2, 2.2, 1.55, 1.18, 0.94, 0.78]  // index 0 unused
GEAR_TOP_SPEEDS = [0, 55, 95, 145, 195, 245, 280]         // km/h per gear
REDLINE_RPM    = 6500
IDLE_RPM       = 850
MAX_RPM        = 7000   // rev limiter
SHIFT_UP:  absSpeed >= gearTopSpeed × 0.82  AND throttle > 0
SHIFT_DOWN: absSpeed < prevGearTopSpeed × 0.70
SHIFT_COOLDOWN = 0.30 s
```

During shift cooldown, torque ramps from 15% to 100% over the first half to simulate a DCT-style torque dip.

### Forces applied each frame (`applyInputs`)

Called from `carDriver.update()` after `world.step()`:

1. **Engine force** to rear wheels:
   ```
   engineForce = BASE_ENGINE_FORCE × gearRatio × torqueCurve
   torqueCurve = 1 - 0.3 × (rpmNorm - 0.5)²   (peaks mid-range)
   rampedForce = engineForce × speedFade × launchRamp × revLimiterFade × shiftMult
   ef = -(throttle × rampedForce)   // negative = forward in cannon-es
   ```

2. **Brakes**: all 4 wheels, `brake × BRAKE_FORCE (250N)`. Handbrake locks rear wheels only (8× force).

3. **Engine braking** (coast): `8 + absSpeed × 0.08` N applied to all wheels when no throttle and no brake.

4. **Downforce**: `F = -0.50 × v²` applied at chassis CoM. Grows with speed squared.

5. **Lateral damping**: `F = -0.6 × lateralSpeed × mass` opposing sideways slide. Reduced during drift (`× (1 - totalDrift × 0.4)`) to allow smooth slides.

6. **Pitch/roll damping**: `angularVelocity.x/z *= 0.005^dt`. Exponential decay (~92% retention per frame at 60fps). Prevents stutter from suspension angular spikes.

7. **Anti-flip torque**: corrective torque when car tilt dot product < 0.9. Strength = `(1 - tiltDot) × 6000`.

### Drift system

Two drift sources add together (capped at 1.0):
- **Handbrake drift**: ramps up via `hbTarget = min(1, absSpeed/20)` at lerp rate 4.0/s
- **Throttle-steer drift**: `min(0.4, (steerNorm) × (absSpeed/80))`

Rear friction slip: `FRICTION_SLIP × (1 - totalDrift × 0.65)`. At full drift, rears have 65% less grip.
Front friction: slight reduction based on steer angle and speed (models understeer limit).

### Steering

Speed-sensitive:
```
maxS = MAX_STEER + (MIN_STEER - MAX_STEER) × min(1, absSpeed/120)
     = 0.38 → 0.10 rad  as speed goes 0 → 120 km/h
```
Progressive smoothing: `_currentSteer += sign(delta) × min(|delta|, STEER_LERP_SPEED × dt)` where `STEER_LERP_SPEED = 3.5`.

Low-speed damping (coasting): steer reduced to 30% at 0 km/h, 100% at 15 km/h — prevents spin-in-place.

---

## Input System (`carControls.js`)

Keyboard only. No gamepad, no touch. `carMouseControls.js` exists but is unused.

| Key | Action |
|---|---|
| W / ArrowUp | Throttle |
| S / ArrowDown | Brake / Reverse |
| A / ArrowLeft | Steer left |
| D / ArrowRight | Steer right |
| Space | Handbrake |

All inputs use progressive ramping (separate rise and fall rates, per-frame lerp):

| Input | Rise rate | Fall rate |
|---|---|---|
| Throttle | 3.5/s | 5.0/s |
| Brake | 4.5/s | 6.0/s |
| Steer | 3.0/s | 4.5/s (centering) |

Arrow keys and Space have `e.preventDefault()` to suppress browser scroll.
Window `blur` clears all keys (prevents stuck inputs when switching windows).

---

## Camera (`carCamera.js`)

Speed-responsive chase camera. Follows chassis position with position lerp, looks ahead with separate lookAt lerp.

### Parameters

| Parameter | Value | Notes |
|---|---|---|
| Base distance | 4.8 m | behind car |
| Speed distance boost | +0.6 m | at 80 km/h |
| Base height | 1.4 m | above car |
| Speed height drop | -0.25 m | at 80 km/h |
| Base look-ahead | 2.5 m | |
| Speed look-ahead boost | +3.0 m | at 80 km/h |
| Lerp position | 0.16 | per-frame; frame-rate independent via `1-(1-α)^(dt×60)` |
| Lerp lookAt | 0.22 | |
| Base FOV | 70° | |
| Max FOV boost | +14° | at 120 km/h |
| Max horizontal distance | 5.2 m | soft clamp with lerp |
| Min Y above car | 0.5 m | hard floor |

### Tunnel mode
When `chassis.position.y < -1` (inside a tunnel): camera height drops to 1.0m, distance fixed at 4.0m.

### Reverse camera
`_reverseBlend` smoothly rotates the "behind" direction 180° when speed < -3 km/h (reversing). Lerp rate: 2.5/s. This swings the camera to the front of the car during reverse.

### Mouse orbit
Mouse orbit code exists (`_orbitYaw`, `_orbitPitch`, `_mouseDown`) but `_onMouseMove` immediately returns without doing anything. The `mousemove` listener attachment is commented out. Mouse orbit is **disabled**.

### FOV update
```js
fovTarget = 70 + 14 × min(1, speed/120)
camera.fov += (fovTarget - camera.fov) × 0.05   // slow lerp
camera.updateProjectionMatrix()
```

---

## Car Model (`carModel.js`)

- Single GLB file: `frontend/src/assets/car.glb`
- Scale: `0.75` (visual model matches physics dimensions after this scale)
- Visual body lean: slight X-axis rotation applied each frame proportional to lateral acceleration
- Wheel meshes extracted from GLB and positioned to match RaycastVehicle wheel transforms
- Color panel UI (fixed-position DOM element) for paint color selection
- Exposes env map generation hook using `window._ddRenderer`

---

## Car Effects (`carEffects.js`)

- **Skid marks**: `InstancedMesh` of decal quads on road surface. Placed at wheel contact points when drifting or hard braking. Fades over time.
- **Tire smoke**: Billboard sprite InstancedMesh. Disabled by default (`ENABLE_TIRE_SMOKE: false`).
- **Headlights**: Two `SpotLight` objects at front of car (if `ENABLE_CAR_LIGHTS`). Brake emissive material on tail lights.

---

## Car Sound (`carSound.js`)

Web Audio API. Engine sound modulated by RPM using oscillator frequency mapping. Crackle effect on downshifts. Requires user gesture to start (browser autoplay policy) — started on first `keydown` or `click`.

---

## Physics World Step

The physics step happens inside `carDriver.update(dt)`:
```js
world.step(1/60, Math.min(dt, 0.035), 3);
```
- Fixed timestep: `1/60` s (60 Hz)
- Max delta: `0.035` s (caps catch-up — prevents death spiral at low FPS)
- Max substeps: `3` (at very low FPS, 3 × 1/60 = 50ms of physics per frame)

This runs synchronously on the main thread. cannon-es has no worker/WASM mode.

---

## Spawn Sequence

1. Load spawn tile, get elevation at spawn lat/lon
2. `setWorldElevationOffset(spawnElev)` — Y=0 at spawn elevation
3. `findRoadSpawn(tileData, spawnCenter)` — scans all non-bridge/non-tunnel road segments, finds nearest preferred road (motorway → tertiary), projects spawn point onto segment, computes heading angle
4. `spawnLocalPos = { x: -(spawnResult.wx - origin.x), z: spawnResult.wz - origin.z, y: 2 }`
   - Note: `y: 2` drops the car 2m above the road surface; physics settles it onto the road
   - Note: X is negated (physics coordinate convention)
5. `createCarDriver(scene, world, groundMesh, camera, spawnLocalPos, ..., spawnHeading)`
6. `createCarPhysics(world, spawnLocalPos, spawnHeading)` → sets chassis position + initial quaternion rotation

Heading angle: `Math.atan2(-dx, dz)` where `dx,dz` is road segment direction. The `-dx` negates X because physics X is mirrored.
