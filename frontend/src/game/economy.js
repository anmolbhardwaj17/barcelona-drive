/**
 * economy.js — how much money the game gives you, in ONE place.
 *
 * ── WHY ───────────────────────────────────────────────────────────────────────────────────────
 * Three modes each had their own payout formula inlined at the point of payment:
 *
 *   taxi      Math.round(3 + tripDist * 0.02)        then × (1 + tip up to 0.6)
 *   delivery  Math.round(5 + tripDist * 0.03)        then × streak (up to ×2.5) × integrity
 *   police    Math.round(25 + elapsed * 1.6 + peakWanted * 0.8)
 *
 * They pay into the same wallet, so they are one economy whether or not anyone wrote them that way
 * — and "money comes in too fast" is a statement about the SUM, which no single file could answer.
 * Retuning meant finding three literals in three files and hoping they were the only ones.
 *
 * ── THE RETUNE (2026-09-04) ───────────────────────────────────────────────────────────────────
 * Roughly a 55% cut, and weighted toward DISTANCE rather than toward completing anything: the old
 * rates paid a flat opening fee big enough that chaining short hops beat driving anywhere, which is
 * the mechanism that made the balance climb so quickly. A 350 m fare was $10 before tip; it is $5.
 * The multipliers on top were the other half — a ×2.5 streak on an already generous base compounds.
 *
 * `RATE` is the single dial. Halve it and the whole game halves.
 */

/** Global payout dial. 1.0 = the pre-2026-09-04 rates. */
export const RATE = 0.45;

/** City Cab: the fare before tip. `tripDist` in metres. */
export function taxiFare(tripDist) {
  return Math.max(1, Math.round((3 + tripDist * 0.02) * RATE));
}

/** Rush Hour: the base pay before streak and cargo condition. */
export function deliveryBasePay(tripDist) {
  return Math.max(1, Math.round((5 + tripDist * 0.03) * RATE));
}

/**
 * Rush Hour's streak bonus. Capped at ×1.8, not ×2.5: a multiplier on top of a base that already
 * scales with distance compounds, and the streak was the steepest curve in the game.
 */
export function streakMultiplier(streak) {
  return 1 + Math.min(0.8, streak * 0.1);
}

/** Heat: paid on a successful escape. `elapsed` seconds, `peakWanted` 0-100. */
export function pursuitPay(elapsed, peakWanted) {
  return Math.max(1, Math.round((25 + elapsed * 1.6 + peakWanted * 0.8) * RATE));
}
