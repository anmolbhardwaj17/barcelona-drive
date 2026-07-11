# Rapier Physics (opt-in) — WASM physics engine behind `?physics=rapier`

**Status (2026-07-10):** complete and measured faster than cannon-es (step ~1.0ms vs ~2.3ms, alloc
~0.12MB/frame vs ~0.32, worst frame 12ms, min FPS 56). Cannon-es remains the DEFAULT engine; Rapier is
opt-in via the URL flag until it has soak time. Cannon also remains the *collider description language* —
tileManager keeps building `CANNON.Body` objects unchanged in both modes.

## Architecture

- **`frontend/src/car/carPhysicsRapier.js`** — the car on Rapier's `DynamicRayCastVehicleController`,
  exposing a cannon-compatible interface (`chassisBody` {position/quaternion/velocity/angularVelocity with
  `.set()`/`.length()`}, `vehicle.wheelInfos[]` with `isInContact`/`worldTransform`/`raycastResult.hitPointWorld`,
  and the same getters) so carDriver/carModel/carCamera/carEffects run unchanged. Fixed 60Hz stepping with
  pose interpolation (cannon's `interpolatedPosition` equivalent); geometry mirrors the cannon car (low CoM
  at origin, collision box offset up); quadratic anti-spin yaw torque (off on handbrake).
- **`frontend/src/physics/rapierWorldAdapter.js`** — presents a cannon-World surface (`addBody`/`removeBody`/
  `bodies`) to tileManager but materializes Rapier colliders. Key design points:
  - **Per-shape streaming working set**: step cost scales with resident collider count (measured: 32k → 8.3ms,
    2.2k → 0.96ms), and tile compounds span whole regions from position (0,0,0) — so individual SHAPES are
    materialized only within R_IN=220m of the car (dropped past 290m, creations budgeted 700/frame).
    `adapter.tick(carX, carZ)` runs once per frame from `main.js` animate.
  - **Pose sync**: materialized bodies whose cannon source moved (traffic cars) are re-synced each tick.
  - **Terrain = native Rapier heightfield** built from the cannon `Heightfield` shape. The heights-matrix
    index direction is **probed at runtime** (raycasts against a known-tilt 1-cell field at init) rather than
    assumed; probe failure falls back to a trimesh conversion with a loud console warning. The field is built
    in Rapier's frame and mapped onto cannon's HF local frame via a collider-local Rx(+90°) + centre offset,
    so the cannon body transform lands it exactly.
  - Shape conversions: Box→cuboid, Trimesh→trimesh, ConvexPolyhedron→convexHull, Cylinder→cylinder(Y-axis).
    Collider descs compose cannon shape offsets with desc-local transforms (don't overwrite).
- **`frontend/src/main.js`** boot: inits Rapier (async WASM), creates the Rapier world + deep safety
  backstop (−60m), wraps the cannon world's addBody/removeBody to register bodies with the adapter. The
  cannon world is never stepped in Rapier mode (inert bookkeeping only).

## Diagnostics

- `window._stepBreakdown` — per-second `{ updateVehicleMs, worldStepMs, stepsPerSec, colliders, bodies }`.
- `window._rapierWorld` — live Rapier world (`.colliders.len()` = current working set).
- `frontend/scripts/rapier-step-experiment.mjs` — Node repro that isolates step-cost drivers (collider
  count × heightfield AABB pairing). `?bench=physics` — in-browser cannon-vs-Rapier micro-bench.

## Flip-to-default checklist (when ready)

1. Soak test `?physics=rapier` across modes (taxi/delivery/police, tunnels, Montjuïc slopes, recover key).
2. Wire collision sound events (chassis `addEventListener('collide')` is currently a no-op in Rapier mode —
   Rapier uses an EventQueue instead; see carDriver's collide listener).
3. Default the flag, keep `?physics=cannon` as escape hatch for a release, then delete the cannon step path.
