/**
 * Simulated 24-hour day/night cycle.
 * 24 game hours = DAY_DURATION_SECONDS real seconds (default 15 min).
 */
import { CONFIG } from './config.js';

let currentTime = 12; // noon

/**
 * Advance game time. Call every frame with deltaTimeSeconds.
 * @param {number} deltaTimeSeconds
 */
export function update(deltaTimeSeconds) {
  if (!CONFIG.ENABLE_DAY_NIGHT) return;
  const dayDurationSeconds = CONFIG.DAY_DURATION_SECONDS ?? 900;
  const timeIncrement = (24 / dayDurationSeconds) * deltaTimeSeconds;
  currentTime += timeIncrement;
  if (currentTime >= 24) currentTime -= 24;
  if (currentTime < 0) currentTime += 24;
}

/**
 * @returns {number} Current time in hours (0–24).
 */
export function getCurrentTime() {
  return currentTime;
}

/** Night: 19:00–05:00 (time >= 19 or time <= 5). Spec said >= 18 or <= 8; using 18–8 for "night" definition. */
export function isNight() {
  return currentTime >= 18 || currentTime <= 8;
}

/** Sunset: 17:00–19:00 */
export function isSunset() {
  return currentTime >= 17 && currentTime < 19;
}

/** Sunrise: 05:00–07:00 */
export function isSunrise() {
  return currentTime >= 5 && currentTime < 7;
}
