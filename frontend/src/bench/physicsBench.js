/**
 * physicsBench — head-to-head cannon-es vs Rapier (WASM) on a load representative of our tile world:
 * a grid of static box colliders + a handful of falling dynamic bodies, stepped at 60 Hz.
 *
 * Measures the two things that matter for smoothness:
 *   • ms / step        — raw physics CPU cost
 *   • KB / step alloc  — JS garbage created per step (the feeder of the GC pauses we still see)
 *
 * Dev-only. Run from the console:  await window._benchPhysics()   (or ?bench=physics on load)
 * Nothing here is imported by the game build path unless explicitly invoked.
 */
import * as CANNON from 'cannon-es';

const STATIC_BOXES = 500;   // ~ our resident static collider count (roads/buildings/trees across tiles)
const DYN_BODIES   = 24;    // a few dynamic bodies interacting (the car chassis + margin)
const WARMUP_STEPS = 120;   // let the JIT settle before timing
const MEASURE_STEPS = 900;  // ~15 s of simulated time

const _mem = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);

// Deterministic pseudo-random so both engines get the identical layout (Math.random is blocked here anyway).
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function layout() {
  const rng = makeRng(12345);
  const statics = [];
  for (let i = 0; i < STATIC_BOXES; i++) {
    statics.push({ x: (rng() - 0.5) * 400, y: rng() * 2, z: (rng() - 0.5) * 400, hx: 2 + rng() * 6, hy: 0.5, hz: 2 + rng() * 6 });
  }
  const dyn = [];
  for (let i = 0; i < DYN_BODIES; i++) {
    dyn.push({ x: (rng() - 0.5) * 60, y: 8 + rng() * 20, z: (rng() - 0.5) * 60 });
  }
  return { statics, dyn };
}

// ── cannon-es run ────────────────────────────────────────────────────────────
function runCannon({ statics, dyn }) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.broadphase = new CANNON.NaiveBroadphase(world);   // match the game's broadphase
  world.allowSleep = false;

  for (const b of statics) {
    const body = new CANNON.Body({ mass: 0 });
    body.addShape(new CANNON.Box(new CANNON.Vec3(b.hx, b.hy, b.hz)));
    body.position.set(b.x, b.y, b.z);
    world.addBody(body);
  }
  const dynBodies = [];
  for (const d of dyn) {
    const body = new CANNON.Body({ mass: 1200 });
    body.addShape(new CANNON.Box(new CANNON.Vec3(1, 0.7, 2.4)));
    body.position.set(d.x, d.y, d.z);
    world.addBody(body);
    dynBodies.push(body);
  }

  for (let i = 0; i < WARMUP_STEPS; i++) world.step(1 / 60, 1 / 60, 1);

  let allocSum = 0, h = _mem();
  const t0 = performance.now();
  for (let i = 0; i < MEASURE_STEPS; i++) {
    // Nudge dynamics so they keep interacting (don't all fall asleep on the floor).
    if (i % 90 === 0) for (const b of dynBodies) b.velocity.y += 3;
    world.step(1 / 60, 1 / 60, 1);
    const h2 = _mem(); if (h2 > h) allocSum += h2 - h; h = h2;
  }
  const ms = performance.now() - t0;
  return { msPerStep: ms / MEASURE_STEPS, kbPerStep: allocSum / MEASURE_STEPS / 1024 };
}

// ── Rapier run ───────────────────────────────────────────────────────────────
async function runRapier({ statics, dyn }) {
  const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.82, z: 0 });

  for (const b of statics) {
    const rb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(b.x, b.y, b.z));
    world.createCollider(RAPIER.ColliderDesc.cuboid(b.hx, b.hy, b.hz), rb);
  }
  const dynBodies = [];
  for (const d of dyn) {
    const rb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(d.x, d.y, d.z));
    world.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.7, 2.4).setDensity(200), rb);
    dynBodies.push(rb);
  }

  for (let i = 0; i < WARMUP_STEPS; i++) world.step();

  let allocSum = 0, h = _mem();
  const t0 = performance.now();
  for (let i = 0; i < MEASURE_STEPS; i++) {
    if (i % 90 === 0) for (const b of dynBodies) { const v = b.linvel(); b.setLinvel({ x: v.x, y: v.y + 3, z: v.z }, true); }
    world.step();
    const h2 = _mem(); if (h2 > h) allocSum += h2 - h; h = h2;
  }
  const ms = performance.now() - t0;
  return { msPerStep: ms / MEASURE_STEPS, kbPerStep: allocSum / MEASURE_STEPS / 1024 };
}

export async function benchPhysics() {
  const scene = layout();
  console.log(`[physicsBench] ${STATIC_BOXES} static + ${DYN_BODIES} dynamic bodies · ${MEASURE_STEPS} steps each…`);
  const cannon = runCannon(layout());
  const rapier = await runRapier(scene);
  const row = (name, r) => `${name.padEnd(10)}  ${r.msPerStep.toFixed(3)} ms/step   ${r.kbPerStep.toFixed(1)} KB/step`;
  const speedup = (cannon.msPerStep / rapier.msPerStep);
  const allocCut = rapier.kbPerStep > 0 ? (cannon.kbPerStep / rapier.kbPerStep) : Infinity;
  console.log('%c[physicsBench] RESULTS', 'font-weight:bold');
  console.log(row('cannon-es', cannon));
  console.log(row('rapier', rapier));
  console.log(`→ Rapier is ${speedup.toFixed(1)}× faster/step, allocates ${allocCut === Infinity ? '∞' : allocCut.toFixed(1) + '×'} less (KB/step: ${cannon.kbPerStep.toFixed(1)} → ${rapier.kbPerStep.toFixed(1)})`);
  return { cannon, rapier, speedup, allocCut };
}

if (typeof window !== 'undefined') window._benchPhysics = benchPhysics;
