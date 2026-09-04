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

Speed-responsive chase camera with mouse orbit. Follows the chassis' **interpolated** transform (so it
is smooth against the render rate rather than snapping on the 60 Hz physics grid), with a separate
lookAt lerp for a stable horizon.

### View modes — C cycles three (V-15, 2026-09-04)

`main.js` binds **C** → `carDriver.cycleView()` → `carCamera.cycleView()`. The order walks the camera
progressively **inward**, and the mode persists in `sessionStorage['dd_view']` (range-checked on read).

| # | Export | What it is |
|---|---|---|
| 0 | `VIEW_CHASE` | Wide chase — the default, and the rig every other number here was tuned against |
| 1 | `VIEW_CHASE_CLOSE` | Close chase — same camera, closer boom |
| 2 | `VIEW_HOOD` | Bumper cam — rides the car, sits ahead of the measured nose |

### View transitions (V-16) — the arc

**C blends; it does not cut.** The blend runs in the car's **yaw-only local frame**, so it rides with
the car — blend in world space and a car at 90 km/h leaves its own camera path behind. The path is
**lifted over the roof** by `TRANSITION_LIFT × sin(πt)`, scaled by how close the straight path passes
to the car centre in plan, so the lift is spent only where it is needed.

| | duration | worst step | apex | cabin clearance |
|---|---|---|---|---|
| wide → close | 0.6 s | 0.089 m | 2.50 m (no lift) | never crosses the cabin |
| close → bumper | 0.6 s | 0.319 m | 2.38 m | 0.62 m |
| bumper → wide | 0.6 s | 0.408 m | 2.68 m | 0.61 m |

- **Why it arcs at all:** the old code re-seated (`_init = false`) with a comment saying a straight
  lerp from 6.6 m behind to a point on the bonnet sends the camera **through the bodywork**. That
  diagnosis was right and the remedy was not — a cut avoids the problem rather than solving it. The
  straight path crosses the car centre 24 cm above a 1.2 m roofline, which is a coin toss against
  mirrors and aerials; the arc makes it ~0.6 m.
- **Why the lift is scaled, not blanket:** wide → close keeps both rigs behind the car (closest
  approach 4.5 m), so a fixed lift would hop the camera for nothing on every press.
- **Why it starts from the live camera position, not the old rig's ideal:** the chase cam lags its
  ideal by design (`LERP_POSITION = 0.16`), so starting at the ideal pops on frame one.
- **Why `ap = 1` while transitioning:** the eased arc *is* the smoothing. Lerping toward a moving
  blend point drags the camera off the arc and off its clearance, and the two rigs disagree on the
  rate anyway (0.85 bolted-on bumper vs 0.16 trailing chase) — which is what would put a pop at the
  far end of an otherwise smooth move.
- **Duration is 0.6 s, not 0.5:** smoothstep peaks at 1.5× its mean rate, so the ~9.7 m wide↔bumper
  move at 0.5 s puts 0.38 m between frames — 23 m/s of camera. It reads, but it whips.
- Look-ahead blends across the transition too; leaving it to `_smoothLookAt` would ease at 0.22 —
  its own rate, not the transition's — so the frame would arrive before the aim did.
- Pressing C mid-transition re-captures the arc's start from the live position; `getViewBlend()`
  reports 0…1 and settles at 1.

`isChaseView(mode)` is exported for "either chase rig". ⚠ **The two chase views are a PARAMETER SET,
not a second camera** — they share the whole update path (orbit, reverse flip, shake, soft clamp,
look-ahead, FOV) and differ only in the rig table. Forking that path is how two chase cams drift apart.

⚠ There is **no cockpit mode** and that is a MODEL problem, not a camera one: `bmw_m3.glb` has eleven
materials and not one is an interior, so a camera inside it faces culled backfaces. The enum has room.

### Chase rig table (`CHASE_RIGS`)

At-rest values; the speed deltas below are shared by both rigs.

| | wide (`VIEW_CHASE`) | close (`VIEW_CHASE_CLOSE`) |
|---|---|---|
| distance behind car | 6.6 m | 4.5 m |
| height above chassis origin | 2.5 m | 2.05 m |
| look-ahead | 4.0 m | 3.2 m |
| tunnel distance | 6.0 m | 4.1 m |
| tunnel height | 1.95 m | 1.62 m |
| **settled roofline depression** | **16.5°** | **20.3°** |

**CLOSE was derived by holding the ANGLES, not by scaling the numbers.** The rear roof edge sits
~1.2 m up and ~2.2 m behind the chassis origin, so the wide rig depresses it by `atan(1.3/4.4)` =
16.5°. At 4.5 m back the gap is 2.3 m and 2.05 m of height gives 20.3° — deliberately a shade
steeper, so pulling in shows **more** road over the roof rather than less. Look-ahead shortens to
match: the wide rig pitches 8.6° down to its target, and from a 2.05 m eye that is a 3.2 m target.
**Leaving `look` at 4.0 with a shorter boom is exactly what flattens the view into the roofline** —
the same mistake the `BASE_CAM_HEIGHT` comment records from the 1.9 m era.

### Shared parameters

| Parameter | Value | Notes |
|---|---|---|
| Speed distance boost | +0.3 m | at 80 km/h (`speedFactor = min(1, kmh/80)`) |
| Speed height drop | −0.25 m | at 80 km/h |
| Speed look-ahead boost | +3.0 m | at 80 km/h |
| Look target height | +0.9 m | above chassis origin |
| Lerp position | 0.16 | frame-rate independent via `1-(1-α)^(dt×60)`; **0.85 in bumper view** — a bonnet camera is bolted to the car, and lerping it makes the road swim |
| Lerp lookAt | 0.22 | |
| Base FOV | 70° | |
| Max FOV boost | +21° | peaks at **80 km/h**, so 40–90 city speeds actually feel fast |
| Max horizontal distance | 9.3 m | soft clamp; MUST stay above the widest rig's `dist + boost` or it caps the pull-back |
| Min Y above car | 0.5 m | hard floor |

### Bumper cam placement

Read from `getBodyBounds()` — the post-centring bbox — every frame, not cached (bounds are null until
the GLB resolves, and the mode can be restored from `sessionStorage` before the model exists). The eye
sits `NOSE_CLEAR = 0.38 m` ahead of `max.z` and `NOSE_DROP = 0.30 m` below `max.y`, which puts the
whole car **behind** the camera — correct by construction rather than by tuning. Fallbacks 3.05 m /
0.95 m are used pre-load. A one-shot `[carCamera] nose cam —` census prints the measured placement and
says `(OUTSIDE, correct)` or `(INSIDE THE BODYWORK — wrong)`; this camera landed inside the shell twice
when the offsets were reasoned from `CHASSIS_BOX_OFFSET_Y` instead of measured.

⚠ The bumper view has **no look target of its own** — it falls through to the shared chase look
target, and that is what it is tuned against. A `_hoodLook` built from a 14 m `HOOD_LOOK` used to be
computed here and read by nothing; both were deleted in V-15.

### Tunnel mode
Driven by `isInTunnelZone(p.x, p.z)` — registered tunnel-corridor **XZ zones in the physics frame**,
per-rig height/distance from the table above. ⚠ It is **NOT** an absolute-Y test: the old
`p.y < -1` was a G-47 bug that put the camera permanently in tunnel mode on Montjuïc, where the car
sits at Y ≈ −16 in the spawn frame.

### Reverse camera
`_reverseBlend` rotates the "behind" direction 180° when reversing (lerp 2.5/s), swinging the camera
to the front of the car.

### Mouse orbit — **enabled**
`pointermove` on the **canvas** (not `document`, so hovering the HUD does not hijack the camera), gated
by `isInputBlocked()` for the ESC menu. Sensitivity 0.004 rad/px horizontal, 0.003 vertical; pitch
clamped to −0.15…0.6 rad. After `RETURN_DELAY = 1.5 s` idle it eases back behind the car at 2.5/s.
Orbit applies in every view, including the bumper cam.

### Camera shake
An impact punch on a sharp one-frame speed drop (`> 16 km/h`, capped at 0.20 m, guarded against
recover-teleports by a position-jump test) plus a continuous rumble above 140 km/h. The punch was
toned down once the underlying V-13 collision bug was fixed — the stacked shake users reported was a
*symptom* of that, not a separate effect.

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
