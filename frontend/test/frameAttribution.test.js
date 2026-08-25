/**
 * The attribution ring is only useful if it answers correctly for the one question it exists for:
 * "which async chunks stole time from THIS frame?" These pin the window semantics, because getting
 * them subtly wrong produces plausible-looking output that blames the wrong subsystem — worse than
 * no output, since it would be acted on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordChunk, chunksIn, formatChunks, recordLongFrame, getLongFrames, longFrameBlame }
  from '../src/ui/frameAttribution.js';

test('chunks are returned largest-first and only inside the window', () => {
  recordChunk('build:roads', 40, 1000);
  recordChunk('build:veg', 12, 1010);
  recordChunk('build:old', 99, 500);     // before the window — must not appear
  recordChunk('build:later', 77, 2000);  // after the window — must not appear
  const got = chunksIn(900, 1100);
  assert.deepEqual(got.map((c) => c.label), ['build:roads', 'build:veg']);
  assert.equal(formatChunks(got), 'build:roads 40 · build:veg 12');
});

test('a chunk that STARTED before the window but ended inside it still counts', () => {
  // Deliberate: a long chunk is exactly the one that spans a frame boundary, and it did steal that
  // frame's time. Filtering on start time would drop precisely the worst offenders.
  recordChunk('spanner', 60, 1500);
  const got = chunksIn(1490, 1510);
  assert.ok(got.some((c) => c.label === 'spanner'));
});

test('zero and negative durations are ignored', () => {
  const before = chunksIn(0, 1e9).length;
  recordChunk('noop', 0, 3000);
  recordChunk('bad', -5, 3000);
  assert.equal(chunksIn(0, 1e9).length, before);
});

test('formatChunks returns empty string for no chunks, so the caller can skip the suffix', () => {
  assert.equal(formatChunks([]), '');
});

test('long-frame blame totals each section across frames, sorted', () => {
  recordLongFrame(60, { tiles: 30, rend: 10 }, 'build:roads 20');
  recordLongFrame(80, { tiles: 50, other: 20 }, null);
  const blame = longFrameBlame();
  assert.equal(blame.tiles, 80);
  assert.equal(Object.keys(blame)[0], 'tiles', 'largest blame must sort first');
  assert.equal(getLongFrames()[0].ms, 80, 'longest frame first');
});

test('getLongFrames is non-destructive', () => {
  const a = getLongFrames().length;
  assert.equal(getLongFrames().length, a, 'reading must not consume — the panel may still need it');
});
