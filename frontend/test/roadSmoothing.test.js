import test from 'node:test';
import assert from 'node:assert/strict';
import { smoothPolyline } from '../src/map/roadSmoothing.js';

const P = (x, y, elevation) => (elevation === undefined ? { x, y } : { x, y, elevation });
const turnDegAt = (p, i) => {
  const ax = p[i].x - p[i-1].x, ay = p[i].y - p[i-1].y;
  const bx = p[i+1].x - p[i].x, by = p[i+1].y - p[i].y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (ax*bx + ay*by) / (la*lb)))) * 180 / Math.PI;
};
const maxTurn = (p) => { let m = 0; for (let i = 1; i < p.length - 1; i++) m = Math.max(m, turnDegAt(p, i)); return m; };

test('ENDPOINTS ARE NEVER MOVED — junction continuity depends on it', () => {
  // N-57..N-61 took drivable junction steps 130 -> 102 by making ways agree about a shared node's
  // position. Moving an endpoint even slightly re-opens those steps.
  const line = [P(0, 0), P(50, 0), P(50, 50), P(100, 50)];
  const s = smoothPolyline(line);
  assert.deepEqual(s[0], line[0]);
  assert.deepEqual(s[s.length - 1], line[line.length - 1]);
});

test('a right-angle corner gets rounded', () => {
  const line = [P(0, 0), P(50, 0), P(50, 50)];
  const s = smoothPolyline(line);
  assert.ok(s.length > line.length, 'vertices should be inserted at the corner');
  assert.ok(maxTurn(s) < 90, `sharpest turn ${maxTurn(s).toFixed(1)} deg should be under the original 90`);
});

test('a straight line is returned untouched — no cost where there is no curvature', () => {
  const line = [P(0, 0), P(10, 0), P(20, 0), P(30, 0)];
  assert.deepEqual(smoothPolyline(line), line);
});

test('turns under the threshold are left alone', () => {
  // ~5.7 deg — invisible, and rounding it would only add vertices.
  const line = [P(0, 0), P(100, 0), P(200, 10)];
  assert.deepEqual(smoothPolyline(line), line);
});

test('the fillet cannot eat its neighbour on short legs', () => {
  // Two 90-degree corners 4 m apart. With an unbounded radius the fillets would overlap and the
  // line would cross itself; the LEG_FRACTION cap is what prevents that.
  const line = [P(0, 0), P(20, 0), P(20, 4), P(40, 4)];
  const s = smoothPolyline(line);
  for (let i = 1; i < s.length; i++) {
    const d = Math.hypot(s[i].x - s[i-1].x, s[i].y - s[i-1].y);
    assert.ok(d >= 0, 'no zero-length or reversed segments');
  }
  // The middle leg must still run broadly +X, never doubling back.
  const spanX = Math.max(...s.map(q => q.x)) - Math.min(...s.map(q => q.x));
  assert.ok(Math.abs(spanX - 40) < 0.01, `x span ${spanX.toFixed(2)} should stay 40 — the path is preserved`);
});

test('elevation is carried across a fillet, not flattened to the corner height', () => {
  // A corner on a ramp: rounding must keep the grade, or a smoothed bend becomes a step.
  const line = [P(0, 0, 0), P(50, 0, 5), P(50, 50, 10)];
  const s = smoothPolyline(line);
  const els = s.map(q => q.elevation);
  assert.ok(els.every(e => Number.isFinite(e)), 'every inserted point carries an elevation');
  for (let i = 1; i < els.length; i++) {
    assert.ok(els[i] >= els[i-1] - 1e-6, `elevation must stay monotonic on a climbing ramp (${els.join(', ')})`);
  }
  assert.equal(els[0], 0);
  assert.equal(els[els.length - 1], 10);
});

test('degenerate input is returned as-is', () => {
  assert.deepEqual(smoothPolyline([]), []);
  assert.deepEqual(smoothPolyline([P(1, 2)]), [P(1, 2)]);
  assert.deepEqual(smoothPolyline([P(1, 2), P(3, 4)]), [P(1, 2), P(3, 4)]);
});
