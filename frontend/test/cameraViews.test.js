/**
 * Camera view modes (V-15) — C cycles wide chase → close chase → bumper.
 *
 * These drive the REAL `update()` against a stub chassis rather than pinning the rig constants, so
 * they fail if the close rig is wired but never reaches the camera — which is the failure mode a
 * constants test cannot see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCarCamera, VIEW_CHASE, VIEW_CHASE_CLOSE, VIEW_HOOD, isChaseView } from '../src/car/carCamera.js';

/** Car-local position of the camera, yaw-only frame. Car faces +Z at the origin, so this is trivial. */
const local = (camera) => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z });

/** Car at the origin, stationary, facing +Z. */
function stubBody() {
  return {
    position: new THREE.Vector3(0, 0, 0),
    quaternion: new THREE.Quaternion(),
    interpolatedPosition: new THREE.Vector3(0, 0, 0),
    interpolatedQuaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(0, 0, 0),
  };
}

/** Settle the camera in `mode` and report where it ends up relative to the car. */
function settle(mode) {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
  const cam = createCarCamera(camera, null);
  while (cam.getView() !== mode) cam.cycleView();
  const body = stubBody();
  for (let i = 0; i < 400; i++) cam.update(body, 1 / 60, 0);
  cam.dispose();
  return {
    horizontal: Math.hypot(camera.position.x, camera.position.z),
    height: camera.position.y,
  };
}

test('C cycles three views, inward, and wraps', () => {
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
  const cam = createCarCamera(camera, null);
  const seen = [cam.getView()];
  for (let i = 0; i < 3; i++) seen.push(cam.cycleView());
  cam.dispose();
  assert.deepEqual(seen, [VIEW_CHASE, VIEW_CHASE_CLOSE, VIEW_HOOD, VIEW_CHASE]);
});

test('the close chase cam is genuinely CLOSER to the car than the wide one', () => {
  const wide = settle(VIEW_CHASE);
  const close = settle(VIEW_CHASE_CLOSE);
  assert.ok(close.horizontal < wide.horizontal - 1.0,
    `close ${close.horizontal.toFixed(2)} m vs wide ${wide.horizontal.toFixed(2)} m`);
  // Closer AND lower, per the derivation in carCamera.js — but never below the min-above-car clamp.
  assert.ok(close.height < wide.height, `close ${close.height.toFixed(2)} vs wide ${wide.height.toFixed(2)}`);
  assert.ok(close.height > 0.5, 'close chase must clear MIN_CAM_ABOVE_CAR');
});

test('the close rig holds the over-the-roof angle instead of flattening into it', () => {
  // The whole point of the derivation: pulling in must not lay the camera down behind the car.
  // Rear roof edge ~1.2 m up, ~2.2 m behind the chassis origin.
  const ang = ({ horizontal, height }) => Math.atan2(height - 1.2, horizontal - 2.2) * 180 / Math.PI;
  const wide = ang(settle(VIEW_CHASE));
  const close = ang(settle(VIEW_CHASE_CLOSE));
  assert.ok(close >= wide - 0.5, `close depresses the roofline by ${close.toFixed(1)}°, wide by ${wide.toFixed(1)}°`);
  assert.ok(close < 45, `close is ${close.toFixed(1)}° — that is a top-down view, not a chase cam`);
});

test('the bumper cam still sits ahead of the car, not behind it', () => {
  const hood = settle(VIEW_HOOD);
  const close = settle(VIEW_CHASE_CLOSE);
  assert.ok(hood.horizontal < close.horizontal, 'bumper must be the innermost view');
  assert.ok(hood.height < close.height);
});

test('isChaseView covers both chase rigs and excludes the bumper', () => {
  assert.ok(isChaseView(VIEW_CHASE));
  assert.ok(isChaseView(VIEW_CHASE_CLOSE));
  assert.ok(!isChaseView(VIEW_HOOD));
});

test('every cycled mode produces a finite camera position — no rig is missing from the table', () => {
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
  const cam = createCarCamera(camera, null);
  const body = stubBody();
  for (let m = 0; m < 3; m++) {
    for (let i = 0; i < 60; i++) cam.update(body, 1 / 60, 0);
    assert.ok(Number.isFinite(camera.position.x) && Number.isFinite(camera.position.y) && Number.isFinite(camera.position.z),
      `mode ${cam.getView()} produced ${camera.position.toArray()}`);
    cam.cycleView();
  }
  cam.dispose();
});


// ── V-16: view transitions ─────────────────────────────────────────────────────────────────────
// Cycling used to CUT. It now arcs, in the car's local frame, lifted over the roof. These pin the
// two things a cut cannot fail at and a blend can: passing through the bodywork, and jumping.

/** Cycle from `from` to the next view and record the camera path, frame by frame. */
function transitionPath(from, frames = 60) {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
  const cam = createCarCamera(camera, null);
  while (cam.getView() !== from) cam.cycleView();
  const body = stubBody();
  for (let i = 0; i < 400; i++) cam.update(body, 1 / 60, 0);   // settle in `from`
  const path = [local(camera)];
  cam.cycleView();
  for (let i = 0; i < frames; i++) { cam.update(body, 1 / 60, 0); path.push(local(camera)); }
  const to = cam.getView();
  cam.dispose();
  return { path, to };
}

// Approximate shell of the M3: half-length 2.2 m, half-width 1.0 m, roof 1.2 m over chassis origin.
const insideShell = (q) => Math.abs(q.z) < 2.2 && Math.abs(q.x) < 1.0 && q.y < 1.2;

test('EVERY view change is continuous — the path has no step, only a rate', () => {
  // Ratio, not an absolute distance: a smoothstep peaks at exactly 1.5× its own mean rate, while a
  // CUT puts the entire move in frame one and ~0 in the rest — a ratio of order N. This holds
  // whatever TRANSITION_TIME is set to, which an absolute threshold in metres does not.
  for (const from of [VIEW_CHASE, VIEW_CHASE_CLOSE, VIEW_HOOD]) {
    const { path, to } = transitionPath(from, 36);
    const steps = [];
    for (let i = 1; i < path.length; i++) {
      steps.push(Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y, path[i].z - path[i - 1].z));
    }
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    const worst = Math.max(...steps);
    assert.ok(worst / mean < 2.0, `${from}→${to}: worst step ${worst.toFixed(3)} m is ${(worst / mean).toFixed(1)}× the mean`);
    assert.ok(worst < 0.45, `${from}→${to}: ${worst.toFixed(2)} m in one frame`);
  }
});

test('THE POINT OF THE ARC: no transition puts the camera inside the bodywork', () => {
  for (const from of [VIEW_CHASE, VIEW_CHASE_CLOSE, VIEW_HOOD]) {
    const { path, to } = transitionPath(from);
    const bad = path.filter(insideShell);
    assert.equal(bad.length, 0,
      `${from}→${to}: ${bad.length} frames inside the shell, worst ${JSON.stringify(bad[0])}`);
  }
});

test('the lift is spent only where it is needed — chase→close does not bob', () => {
  // Both rigs sit behind the car, so the straight path never approaches the shell and the arc
  // height must stay zero. A blanket lift would hop the camera for no reason on every C press.
  const { path } = transitionPath(VIEW_CHASE);      // → CHASE_CLOSE
  const startY = path[0].y, endY = path[path.length - 1].y;
  const peak = Math.max(...path.map((q) => q.y));
  assert.ok(peak <= Math.max(startY, endY) + 0.02, `bobbed to ${peak.toFixed(2)} m (ends ${startY.toFixed(2)}→${endY.toFixed(2)})`);
});

test('chase→bumper DOES lift, and clears the roofline with real margin', () => {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
  const cam = createCarCamera(camera, null);
  while (cam.getView() !== VIEW_CHASE_CLOSE) cam.cycleView();
  const body = stubBody();
  for (let i = 0; i < 400; i++) cam.update(body, 1 / 60, 0);
  cam.cycleView();                                   // → VIEW_HOOD
  // Measured over the CABIN (|z| < 1.2), not the whole 4.4 m box: past the windscreen the bodywork
  // drops to the bonnet, and the bumper cam's whole job is to end up down there at the nose. Judging
  // the arc against a 1.2 m roofline that extends over the bonnet fails a camera doing its job.
  let minClearance = Infinity;
  for (let i = 0; i < 60; i++) {
    cam.update(body, 1 / 60, 0);
    const q = local(camera);
    if (Math.abs(q.z) < 1.2) minClearance = Math.min(minClearance, q.y - 1.2);
  }
  cam.dispose();
  assert.ok(minClearance > 0.4, `passed ${minClearance.toFixed(2)} m over a 1.2 m roofline`);
});

test('the blend reports 0..1 and settles at 1', () => {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
  const cam = createCarCamera(camera, null);
  const body = stubBody();
  for (let i = 0; i < 60; i++) cam.update(body, 1 / 60, 0);
  assert.equal(cam.getViewBlend(), 1);
  cam.cycleView();
  cam.update(body, 1 / 60, 0);
  const mid = cam.getViewBlend();
  assert.ok(mid > 0 && mid < 1, `blend ${mid}`);
  for (let i = 0; i < 60; i++) cam.update(body, 1 / 60, 0);
  assert.equal(cam.getViewBlend(), 1);
  cam.dispose();
});

test('pressing C again mid-transition re-aims from the live position, still without a jump', () => {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
  const cam = createCarCamera(camera, null);
  const body = stubBody();
  for (let i = 0; i < 400; i++) cam.update(body, 1 / 60, 0);
  let prev = local(camera), worst = 0;
  cam.cycleView();
  for (let i = 0; i < 90; i++) {
    if (i === 10 || i === 22) cam.cycleView();       // spam it part-way through
    cam.update(body, 1 / 60, 0);
    const q = local(camera);
    worst = Math.max(worst, Math.hypot(q.x - prev.x, q.y - prev.y, q.z - prev.z));
    assert.ok(!insideShell(q), `frame ${i} inside the shell: ${JSON.stringify(q)}`);
    prev = q;
  }
  cam.dispose();
  // Longest possible re-aim is wide chase ↔ bumper, ~9.7 m; at smoothstep's 1.5× peak over
  // TRANSITION_TIME that is ~0.40 m per 1/60 s frame. A cut would be the whole 9.7 m at once.
  assert.ok(worst < 0.45, `${worst.toFixed(2)} m jump while cycling mid-transition`);
});
