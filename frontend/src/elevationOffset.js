/**
 * World elevation normalization: subtract spawn elevation so spawn terrain is near Y=0.
 * Set once when spawn tile elevation is available; used by terrain, roads, and car.
 */

let worldElevationOffset = null;
const spawnReadyCallbacks = [];

export function getWorldElevationOffset() {
  return worldElevationOffset;
}

export function setWorldElevationOffset(value) {
  if (worldElevationOffset !== null) return;
  worldElevationOffset = Number.isFinite(value) ? value : 0;
  spawnReadyCallbacks.forEach((cb) => cb(worldElevationOffset));
  spawnReadyCallbacks.length = 0;
}

/**
 * BUILD GATE (Stage-2 co-frame, Path B). Resolves when worldElevationOffset is known.
 * Tile geometry builds (terrain/road/physics/vegetation) MUST await this before reading the
 * offset, so every elevation consumer reads the resolved value the first time — no per-layer
 * self-heal, no frozen absolute frame. The spawn tile's PARSE sets the offset (main.js:106),
 * which is independent of geometry builds, so awaiting here cannot deadlock.
 */
export function whenElevationOffsetReady() {
  if (worldElevationOffset !== null) return Promise.resolve(worldElevationOffset);
  return new Promise((resolve) => { spawnReadyCallbacks.push(resolve); });
}

/**
 * FAIL-FAST guard. Throw loudly if an elevation consumer is reached with the offset still
 * unresolved — i.e. the build gate was bypassed. Production-grade: fail loud, never silently
 * bake the absolute frame (silent-wrong is this codebase's signature failure mode).
 */
export function assertElevationOffsetResolved(where) {
  if (worldElevationOffset === null) {
    const msg = `[elevationOffset] FATAL: elevation consumer "${where}" reached with worldElevationOffset `
      + `unresolved — the build gate (processTileData → whenElevationOffsetReady) was bypassed. `
      + `Refusing to bake the absolute frame.`;
    console.error(msg);
    throw new Error(msg);
  }
  return worldElevationOffset;
}
