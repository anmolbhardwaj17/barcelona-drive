/**
 * rapier-step-experiment — reproduce the in-game 8.3ms world.step() in Node and isolate WHAT drives it.
 * In-game observation: 32,242 colliders on 245 static bodies + 1 dynamic car → worldStepMs ≈ 8.3.
 * Variants isolate: box count, heightfield presence, giant-AABB pairing, and collision-group filtering.
 *
 * Run: node scripts/rapier-step-experiment.mjs
 */
import RAPIER from '@dimforge/rapier3d-compat';

await RAPIER.init();

const STEPS = 300;

function measure(label, build) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  build(world);
  // one dynamic body (the "car") driving around the middle
  const rb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0).setCanSleep(false));
  world.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.7, 2.4).setDensity(200), rb);
  for (let i = 0; i < 60; i++) world.step(); // warmup
  const t0 = performance.now();
  for (let i = 0; i < STEPS; i++) {
    if (i % 30 === 0) rb.setLinvel({ x: 3, y: 0, z: 3 }, true); // keep it awake/moving
    world.step();
  }
  const ms = (performance.now() - t0) / STEPS;
  console.log(`${label.padEnd(58)} ${ms.toFixed(3)} ms/step   (${world.colliders.len()} colliders)`);
  world.free();
}

// Deterministic layout helpers
function addBoxes(world, n, groups = null) {
  // ~2k boxes per 500m tile over a 4x4 tile area, many shapes per body like the game (compound bodies)
  const perBody = 130;
  let made = 0;
  while (made < n) {
    const bx = (made % 2000) * 1.7 % 2000 - 1000;
    const bz = ((made * 7) % 2000) - 1000;
    const rb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(bx, 0, bz));
    for (let s = 0; s < perBody && made < n; s++, made++) {
      const d = RAPIER.ColliderDesc.cuboid(2, 0.5, 4).setTranslation((s % 12) * 5, 0, ((s / 12) | 0) * 5);
      if (groups != null) d.setCollisionGroups(groups);
      world.createCollider(d, rb);
    }
  }
}

function addHeightfields(world, n, res = 128, groups = null) {
  for (let i = 0; i < n; i++) {
    const pts = res + 1;
    const heights = new Float32Array(pts * pts); // flat is fine — AABB/pairing is what we're probing
    const rb = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation((i % 4) * 500 - 750, -0.5, ((i / 4) | 0) * 500 - 750),
    );
    const d = RAPIER.ColliderDesc.heightfield(res, res, heights, { x: 500, y: 1, z: 500 });
    if (groups != null) d.setCollisionGroups(groups);
    world.createCollider(d, rb);
  }
}

// Collision groups: statics in group 2, only interact with group 1 (the car). Car defaults to all groups.
const STATIC_GROUPS = (0b10 << 16) | 0b01;

console.log(`rapier ${RAPIER.version()} — ${STEPS} steps per variant\n`);
measure('A  500 boxes (the original bench scale)', (w) => addBoxes(w, 500));
measure('B  32k boxes', (w) => addBoxes(w, 32000));
measure('C  16 full-res heightfields only', (w) => addHeightfields(w, 16));
measure('D  32k boxes + 16 heightfields (the in-game shape)', (w) => { addBoxes(w, 32000); addHeightfields(w, 16); });
measure('E  D but statics collision-grouped (no static-static)', (w) => { addBoxes(w, 32000, STATIC_GROUPS); addHeightfields(w, 16, STATIC_GROUPS); });
measure('F  8k boxes + 16 heightfields (3x3-tile mirror radius)', (w) => { addBoxes(w, 8000); addHeightfields(w, 16); });
