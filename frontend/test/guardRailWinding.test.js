/**
 * GUARD-RAIL WINDING — the gate on FrontSide.
 *
 * Both rail materials are `DoubleSide`. Every piece is thin, so the back faces are pure fragment
 * waste — but flipping to FrontSide is only safe if every quad's winding faces the way you look at
 * it from. The wall is an OPEN shell: inner face, outer face, top face, and NO bottom or end caps.
 * A single back-facing quad there does not shade oddly, it becomes a HOLE you can see the road
 * through, and only from certain angles — which is exactly the kind of thing a drive misses.
 *
 * So this asserts the three faces point where they must: inner toward the carriageway, outer away
 * from it, top upward.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { emitGuardRailRun } from '../src/map/roadRenderer.js';

/** A straight run along +X. inner at z=+2 (road side is z=0), outer at z=+2.25. */
function straightRun(n = 6) {
  const inner = [], outer = [];
  for (let i = 0; i < n; i++) {
    inner.push({ x: i * 4, y: 0, z: 2.0 });
    outer.push({ x: i * 4, y: 0, z: 2.25 });
  }
  return { inner, outer };
}

/** Per-triangle geometric normal, from the index buffer (NOT computeVertexNormals, which averages). */
function faceNormals(geo) {
  const p = geo.getAttribute('position'), idx = geo.getIndex();
  const out = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(p, idx.getX(i));
    b.fromBufferAttribute(p, idx.getX(i + 1));
    c.fromBufferAttribute(p, idx.getX(i + 2));
    ab.subVectors(b, a); ac.subVectors(c, a);
    const n = new THREE.Vector3().crossVectors(ab, ac).normalize();
    // centroid, so each face can be classified as inner / outer / top
    out.push({ n, cz: (a.z + b.z + c.z) / 3, cy: (a.y + b.y + c.y) / 3 });
  }
  return out;
}

test('the wall is an open shell — 3 quads per span, no bottom and no caps', () => {
  const { inner, outer } = straightRun(6);
  const rail = [], posts = [], beams = [];
  emitGuardRailRun(inner, outer, inner.map(() => 5), 5, rail, posts, beams);
  assert.equal(rail.length, 1, 'one wall geometry per run');
  const idx = rail[0].getIndex();
  // 5 spans x 3 quads x 2 triangles
  assert.equal(idx.count / 3, 5 * 3 * 2, 'exactly inner + outer + top; a bottom or caps would add more');
});

test('every wall face points outward — the precondition for FrontSide', () => {
  const { inner, outer } = straightRun(6);
  const rail = [], posts = [], beams = [];
  emitGuardRailRun(inner, outer, inner.map(() => 5), 5, rail, posts, beams);
  const faces = faceNormals(rail[0]);
  assert.ok(faces.length > 0);

  let innerFaces = 0, outerFaces = 0, topFaces = 0;
  for (const f of faces) {
    if (Math.abs(f.n.y) > 0.7) {
      // top face — must point UP, never down
      topFaces++;
      assert.ok(f.n.y > 0.7, `top face normal points down (y=${f.n.y.toFixed(2)}) — a hole from above`);
    } else {
      // a side face. inner sits at z~2.0 (road at z=0) so it must face -z; outer at z~2.25 faces +z
      const towardRoad = f.n.z < 0;
      if (f.cz < 2.125) { innerFaces++; assert.ok(towardRoad, `inner wall faces AWAY from the road (nz=${f.n.z.toFixed(2)})`); }
      else { outerFaces++; assert.ok(!towardRoad, `outer wall faces INTO the road (nz=${f.n.z.toFixed(2)})`); }
    }
  }
  assert.ok(innerFaces > 0 && outerFaces > 0 && topFaces > 0,
    `expected all three face groups, got inner=${innerFaces} outer=${outerFaces} top=${topFaces}`);
});

test('winding is consistent when the run reverses direction', () => {
  // A rail is emitted along whichever way the road runs. If winding depends on direction, half the
  // rails in the city are inside-out and FrontSide would hole them.
  const { inner, outer } = straightRun(6);
  const rail = [], posts = [], beams = [];
  emitGuardRailRun(inner.slice().reverse(), outer.slice().reverse(), inner.map(() => 5), 5, rail, posts, beams);
  const faces = faceNormals(rail[0]);
  for (const f of faces) {
    if (Math.abs(f.n.y) > 0.7) assert.ok(f.n.y > 0.7, 'top still points up when reversed');
  }
});

test('the MIRROR side winds correctly too — the case a constant order cannot serve', () => {
  // Right-hand rail: road at z=0, rail at z=-2, its outer face at z=-2.25. So `inner -> outer` now
  // points -z where the left rail's pointed +z. A fixed index order is right for exactly one of
  // these; deriving the sign per run is what makes both work.
  const inner = [], outer = [];
  for (let i = 0; i < 6; i++) {
    inner.push({ x: i * 4, y: 0, z: -2.0 });
    outer.push({ x: i * 4, y: 0, z: -2.25 });
  }
  const rail = [], posts = [], beams = [];
  emitGuardRailRun(inner, outer, inner.map(() => 5), 5, rail, posts, beams);
  const faces = faceNormals(rail[0]);
  let inn = 0, out = 0, top = 0;
  for (const f of faces) {
    if (Math.abs(f.n.y) > 0.7) { top++; assert.ok(f.n.y > 0.7, `top points down (y=${f.n.y.toFixed(2)})`); continue; }
    if (f.cz > -2.125) { inn++; assert.ok(f.n.z > 0, `inner faces away from the road (nz=${f.n.z.toFixed(2)})`); }
    else { out++; assert.ok(f.n.z < 0, `outer faces into the road (nz=${f.n.z.toFixed(2)})`); }
  }
  assert.ok(inn > 0 && out > 0 && top > 0, `inner=${inn} outer=${out} top=${top}`);
});

test('a curved run keeps every top face pointing up', () => {
  // Real rails bend. If the derived sign were taken per-triangle it could flip mid-curve and stripe
  // the rail with holes; taken per run, a bend must not change it.
  const inner = [], outer = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 11) * Math.PI * 0.5, r = 40;
    inner.push({ x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r });
    outer.push({ x: Math.cos(a) * (r + 0.25), y: 0, z: Math.sin(a) * (r + 0.25) });
  }
  const rail = [], posts = [], beams = [];
  emitGuardRailRun(inner, outer, inner.map(() => 5), 5, rail, posts, beams);
  const tops = faceNormals(rail[0]).filter((f) => Math.abs(f.n.y) > 0.7);
  assert.ok(tops.length > 0, 'the curve has top faces');
  for (const f of tops) assert.ok(f.n.y > 0.7, `a top face points down mid-curve (y=${f.n.y.toFixed(2)})`);
});
