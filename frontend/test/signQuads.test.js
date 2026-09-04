/**
 * P4-11 · sign quad geometry and UV packing.
 *
 * All of this is arithmetic that produces no error when it is wrong — a flipped V draws the wrong
 * sign, a mis-packed offset draws a slice of two signs, and both look like art problems. Hence
 * tests rather than a drive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellQuad, packUvOffset, applyUvOffset, indexCells } from '../src/map/signage/signQuads.js';
import manifest from '../src/map/signage/signAtlasCells.js';

const cells = indexCells(manifest);

test('a quad sits ON the ground, not centred on it', () => {
  // Origin at bottom centre: a sign is positioned where its post meets the ground. Centre-origin
  // would bury half of every sign in the pavement and read as a height bug.
  const q = cellQuad(cells.get('stop'), 0.8, 0.8);
  // Float32Array, so compare with a tolerance — 0.8 stores as 0.800000011920929.
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);
  const ys = [q.position[1], q.position[4], q.position[7], q.position[10]];
  near(Math.min(...ys), 0, 'quad must start at y=0');
  near(Math.max(...ys), 0.8, 'quad must reach its full height');
  const xs = [q.position[0], q.position[3], q.position[6], q.position[9]];
  near(Math.min(...xs), -0.4, 'left edge');
  near(Math.max(...xs), 0.4, 'right edge — and centred horizontally');
});

test('the quad UVs match the cell, with V rising as Y rises', () => {
  const cell = cells.get('speed_30');
  const [u0, v0, u1, v1] = cell.uv;
  const q = cellQuad(cell, 1, 1);
  // vertex 0 is bottom-left (y=0) and must take the cell's BOTTOM v.
  assert.equal(q.uv[0], u0);
  assert.equal(q.uv[1], v0);
  // vertex 2 is top-right (y=h) and must take the cell's TOP v.
  assert.equal(q.uv[4], u1);
  assert.equal(q.uv[5], v1);
  assert.ok(v1 > v0, 'manifest V should be bottom-up');
});

test('the winding is counter-clockwise so the face is not backwards', () => {
  // A back-facing sign is invisible with FrontSide, which reads as "the sign did not spawn".
  const q = cellQuad(cells.get('yield'), 2, 2);
  const [ax, ay] = [q.position[0], q.position[1]];
  const [bx, by] = [q.position[3], q.position[4]];
  const [cx, cy] = [q.position[6], q.position[7]];
  const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  assert.ok(cross > 0, `winding is clockwise (cross ${cross}) — the quad faces away`);
});

test('a packed UV offset round-trips the unit square onto the cell', () => {
  const rect = { u0: 0.25, v0: 0.5, u1: 0.375, v1: 0.5625 };
  const packed = packUvOffset(rect, new Float32Array(4), 0);
  // The shader maps (0,0) → the cell's bottom-left and (1,1) → its top-right.
  const bl = applyUvOffset(packed, 0, 0, 0);
  const tr = applyUvOffset(packed, 0, 1, 1);
  assert.ok(Math.abs(bl[0] - rect.u0) < 1e-6 && Math.abs(bl[1] - rect.v0) < 1e-6);
  assert.ok(Math.abs(tr[0] - rect.u1) < 1e-6 && Math.abs(tr[1] - rect.v1) < 1e-6);
});

test('packing writes to the right slot and disturbs no other instance', () => {
  const out = new Float32Array(12);
  packUvOffset({ u0: 0.1, v0: 0.2, u1: 0.3, v1: 0.4 }, out, 1);
  assert.deepEqual([...out.slice(0, 4)], [0, 0, 0, 0], 'instance 0 was touched');
  assert.deepEqual([...out.slice(8, 12)], [0, 0, 0, 0], 'instance 2 was touched');
  assert.ok(Math.abs(out[6] - 0.1) < 1e-6 && Math.abs(out[7] - 0.2) < 1e-6,
    `instance 1 offset wrong: ${out[6]}, ${out[7]}`);
});

test('an unknown cell name THROWS instead of silently drawing the wrong sign', () => {
  // Returning undefined would sample UV (0,0) — the first cell — and draw a blank plate where a
  // stop sign should be, with no error anywhere. That is an atlas bug wearing an art bug's clothes.
  assert.throws(() => cells.get('speed_999'), /no cell named/);
  assert.equal(cells.has('speed_30'), true);
});

test('every manifest cell can build a quad', () => {
  for (const c of manifest.cells) {
    const q = cellQuad(c, 1, 1);
    assert.equal(q.position.length, 12, `${c.name}`);
    assert.equal(q.uv.length, 8, `${c.name}`);
    assert.equal(q.index.length, 6, `${c.name}`);
    for (const v of q.uv) assert.ok(v >= 0 && v <= 1, `${c.name} UV out of range`);
  }
  assert.equal(cells.size, manifest.cells.length);
});
