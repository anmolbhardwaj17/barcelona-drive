/**
 * Spawn pool + payout rates.
 *
 * The spawn pool is asserted rather than eyeballed because a coordinate outside the baked extent
 * boots the player into a blank world with no tiles — a failure that looks like "the game is broken"
 * and reads, in the console, like nothing at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPAWN_POOL, isSpawnInBounds, DEFAULT_SPAWN, getActiveSpawn } from '../src/spawnConfig.js';
import { RATE, taxiFare, deliveryBasePay, streakMultiplier, pursuitPay } from '../src/game/economy.js';

test('every spawn in the pool is inside the baked map extent', () => {
  assert.ok(SPAWN_POOL.length >= 8, 'a pool this small is not really random');
  for (const p of SPAWN_POOL) {
    assert.ok(isSpawnInBounds(p.lat, p.lon), `${p.name} (${p.lat}, ${p.lon}) is outside the baked area`);
    assert.ok(p.name && typeof p.name === 'string', 'the hub place-picker renders these names');
  }
});

test('the pool has no duplicate coordinates — a repeat is a spawn that comes up twice as often', () => {
  const seen = new Set();
  for (const p of SPAWN_POOL) {
    const k = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
    assert.ok(!seen.has(k), `${p.name} duplicates another entry`);
    seen.add(k);
  }
});

test('the default spawn is in the pool, so ?spawn=fixed lands somewhere the pool also offers', () => {
  const hit = SPAWN_POOL.some(
    (p) => Math.abs(p.lat - DEFAULT_SPAWN.lat) < 1e-4 && Math.abs(p.lon - DEFAULT_SPAWN.lon) < 1e-4);
  assert.ok(hit, 'DEFAULT_SPAWN is not in SPAWN_POOL');
});

test('a spawn resolves at module load and is in bounds', () => {
  const a = getActiveSpawn();
  assert.ok(isSpawnInBounds(a.lat, a.lon), `resolved spawn ${a.lat},${a.lon} is out of bounds`);
});

// ── economy ────────────────────────────────────────────────────────────────────────────────────

test('payouts scale with DISTANCE, not with completing things', () => {
  // The old rates paid a flat opening fee big enough that chaining short hops beat driving anywhere.
  const short = taxiFare(150), long = taxiFare(600);
  assert.ok(long > short * 2, `600 m pays ${long}, 150 m pays ${short} — the flat part still dominates`);
  const dShort = deliveryBasePay(150), dLong = deliveryBasePay(600);
  assert.ok(dLong > dShort * 2, `${dLong} vs ${dShort}`);
});

test('the retune actually cut the rates it says it cut', () => {
  // Pinned against the pre-2026-09-04 formulas, which are the numbers the "money comes in too fast"
  // report was made against. If RATE is raised these fail, which is the point.
  const oldTaxi = (d) => Math.round(3 + d * 0.02);
  const oldDelivery = (d) => Math.round(5 + d * 0.03);
  const oldPursuit = (t, w) => Math.round(25 + t * 1.6 + w * 0.8);
  assert.ok(taxiFare(350) <= oldTaxi(350) * 0.6, `${taxiFare(350)} vs ${oldTaxi(350)}`);
  assert.ok(deliveryBasePay(350) <= oldDelivery(350) * 0.6);
  assert.ok(pursuitPay(60, 80) <= oldPursuit(60, 80) * 0.6);
  assert.ok(RATE < 1);
});

test('no payout can ever be zero — a completed job that pays nothing reads as a bug', () => {
  assert.ok(taxiFare(0) >= 1);
  assert.ok(deliveryBasePay(0) >= 1);
  assert.ok(pursuitPay(0, 0) >= 1);
});

test('the streak multiplier is capped, because it compounds on a base that already scales', () => {
  assert.equal(streakMultiplier(0), 1);
  assert.ok(streakMultiplier(3) > 1);
  assert.ok(streakMultiplier(99) <= 1.8, `uncapped at ${streakMultiplier(99)}`);
  // Monotonic: a longer streak must never pay less.
  for (let i = 1; i < 30; i++) assert.ok(streakMultiplier(i) >= streakMultiplier(i - 1));
});
