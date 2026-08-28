/**
 * N-13 — the missing street trees.
 *
 * Barcelona's avenues came back sparse: measured across the whole baked city, street trees sat
 * **27.2 m apart per side** where the baker intends ~4 m and the real city plants at ~8 m.
 *
 * The cause was junction detection, not tree placement. `getRoadsideTreePositions` books a no-tree
 * disc wherever a way ENDPOINT lies within 8 m of a road segment. Under `noClipTileStrategy` a
 * single street is several way RECORDS, so every record's endpoint sits exactly on its own
 * continuation and each one was booked as a T-junction.
 *
 * Measured by replaying the real logic against the spawn tile (16_33161_24477, 282 road records):
 *
 *     junction discs 501  (endpoint-cluster 148, T-junction 353)   cap of 500 HIT
 *     45.0% of every roadside tree slot rejected as "near a junction"
 *
 * With the two rules below — not its own way, and not collinear — the same tile rejects 31.0%,
 * and that residue is legitimate: an Eixample corner every 113 m clears its own chamfer.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isWayContinuation, junctionTreeClearance } from
  '../../backend/worldBuilder/vegetationBaker.js';

test('a way running straight on is a CONTINUATION, not a junction', () => {
  // The exact case that produced 353 phantom discs on one tile.
  assert.equal(isWayContinuation(1, 0, 5, 0), true);
  assert.equal(isWayContinuation(0, 1, 0, 12), true);
});

test('direction is undirected — a record digitised the other way is still a continuation', () => {
  // Way A ends heading east; way B is stored west-to-east or east-to-west. Same street either way,
  // which is why the test takes |cos| and not cos.
  assert.equal(isWayContinuation(1, 0, -5, 0), true);
});

test('a perpendicular street IS a junction', () => {
  assert.equal(isWayContinuation(1, 0, 0, 5), false);
  assert.equal(isWayContinuation(0, 1, 7, 0), false);
});

test('the boundary sits at ~25 degrees', () => {
  const at = (deg) => {
    const r = (deg * Math.PI) / 180;
    return isWayContinuation(1, 0, Math.cos(r), Math.sin(r));
  };
  assert.equal(at(20), true, '20 deg is the same street bending');
  assert.equal(at(40), false, '40 deg is a fork');
  // Eixample chamfers meet at 45 deg — they must read as junctions, or the corner grows trees.
  assert.equal(at(45), false, 'a 45 deg chamfer is a junction');
});

test('a degenerate zero-length segment is not a continuation', () => {
  assert.equal(isWayContinuation(1, 0, 0, 0), false);
});

test('junction discs are 5-9 m, never the old 10-18 m', () => {
  // 10-18 m cleared up to a third of a 113 m Eixample block at every corner.
  assert.equal(junctionTreeClearance(0), 5);
  assert.equal(junctionTreeClearance(13), 7.6);   // an Eixample secondary
  assert.equal(junctionTreeClearance(16), 8.2);   // a trunk
  assert.equal(junctionTreeClearance(100), 9, 'clamped');
});
