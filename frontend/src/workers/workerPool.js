/**
 * workerPool.js — Main-thread Web Worker pool manager.
 *
 * Manages a pool of long-lived Workers that handle heavy tile geometry
 * computation off the main thread (buildings, vegetation, grass).
 *
 * - Pool size matches MAX_CONCURRENT_TILE_LOADS (2).
 * - Round-robin load balancing across workers.
 * - Transferable ArrayBuffer support in both directions.
 * - Per-tile cancellation of pending requests.
 * - Request/response matching via unique numeric IDs.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POOL_SIZE = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {Worker[]} */
let workers = [];

/** Next worker index for round-robin assignment. */
let nextWorkerIdx = 0;

/** Monotonically increasing request ID. */
let nextRequestId = 1;

/**
 * Pending requests keyed by request ID.
 * @type {Map<number, { resolve: Function, reject: Function, tileKey: string }>}
 */
const pending = new Map();

/**
 * Maps tileKey -> Set of request IDs, so we can cancel all work for a tile.
 * @type {Map<string, Set<number>>}
 */
const tileRequests = new Map();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Collect every ArrayBuffer reachable from `obj` (one level deep into arrays
 * and plain-object values). Used to build the Transferable list.
 * @param {*} obj
 * @returns {ArrayBuffer[]}
 */
function collectTransferables(obj) {
  const buffers = [];
  if (!obj || typeof obj !== 'object') return buffers;

  const seen = new Set();

  function visit(val) {
    if (!val || typeof val !== 'object') return;
    if (val instanceof ArrayBuffer) {
      if (!seen.has(val)) { seen.add(val); buffers.push(val); }
      return;
    }
    if (ArrayBuffer.isView(val)) {
      const buf = val.buffer;
      if (!seen.has(buf)) { seen.add(buf); buffers.push(buf); }
      return;
    }
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) visit(val[i]);
      return;
    }
    // Plain object — recurse one more level.
    const keys = Object.keys(val);
    for (let i = 0; i < keys.length; i++) visit(val[keys[i]]);
  }

  visit(obj);
  return buffers;
}

/**
 * Clone an elevation object, creating a copy of its `elevations` typed array
 * so we can safely transfer the copy without neutering the original.
 * Returns the cloned data and the ArrayBuffer to add to the transfer list.
 */
function cloneElevation(elevation) {
  if (!elevation) return { cloned: elevation, transferable: null };

  const cloned = { ...elevation };

  if (elevation.elevations) {
    // Copy into a Float32Array for transfer. Source may be a plain Array (from JSON)
    // or a typed array (Float32Array/Float64Array).
    const src = elevation.elevations;
    const copy = ArrayBuffer.isView(src)
      ? new src.constructor(src)
      : new Float32Array(src);
    cloned.elevations = copy;
    return { cloned, transferable: copy.buffer };
  }

  return { cloned, transferable: null };
}

/**
 * Handle a message coming back from a Worker.
 * @param {MessageEvent} event
 */
function onWorkerMessage(event) {
  const { type, id, result, error } = event.data;

  if (type === 'RESULT') {
    const entry = pending.get(id);
    if (!entry) return; // already cancelled

    pending.delete(id);
    removeTileRequest(entry.tileKey, id);
    entry.resolve(result);
  } else if (type === 'ERROR') {
    const entry = pending.get(id);
    if (!entry) return;

    pending.delete(id);
    removeTileRequest(entry.tileKey, id);
    entry.reject(new Error(error || 'Worker error'));
  }
}

/**
 * Handle a Worker-level error (e.g. script load failure, uncaught throw).
 * @param {number} workerIndex
 * @param {ErrorEvent} event
 */
function onWorkerError(workerIndex, event) {
  console.error(`[WorkerPool] Worker ${workerIndex} error:`, event.message || event);

  // Reject every pending request assigned to this worker.
  // Since we don't track which worker got which request (round-robin is
  // fire-and-forget), reject ALL pending — safer than guessing.
  // In practice a full Worker crash is rare and usually fatal.
  for (const [id, entry] of pending) {
    entry.reject(new Error(`Worker crash: ${event.message || 'unknown error'}`));
  }
  pending.clear();
  tileRequests.clear();
}

/**
 * Remove a request ID from the tileRequests map and clean up empty sets.
 */
function removeTileRequest(tileKey, id) {
  const ids = tileRequests.get(tileKey);
  if (!ids) return;
  ids.delete(id);
  if (ids.size === 0) tileRequests.delete(tileKey);
}

/**
 * Pick the next Worker (round-robin) and return it.
 * @returns {Worker}
 */
function pickWorker() {
  const w = workers[nextWorkerIdx];
  nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
  return w;
}

/**
 * Post a message to a Worker with Transferable support.
 * @param {Worker} worker
 * @param {object} message
 * @param {ArrayBuffer[]} transferables
 */
function postToWorker(worker, message, transferables) {
  if (transferables && transferables.length > 0) {
    worker.postMessage(message, transferables);
  } else {
    worker.postMessage(message);
  }
}

/**
 * Send a typed request to the pool and return a Promise for the result.
 * @param {string} type    Message type (PROCESS_BUILDINGS, etc.)
 * @param {string} tileKey
 * @param {object} data    Payload to send.
 * @param {object} config  CONFIG snapshot.
 * @param {ArrayBuffer[]} transferables  Buffers to transfer.
 * @returns {Promise<object>}
 */
function enqueue(type, tileKey, data, config, transferables) {
  return new Promise((resolve, reject) => {
    if (workers.length === 0) {
      reject(new Error('[WorkerPool] Pool not initialized. Call initWorkerPool() first.'));
      return;
    }

    const id = nextRequestId++;
    pending.set(id, { resolve, reject, tileKey });

    // Track per-tile so cancelTile() works.
    let ids = tileRequests.get(tileKey);
    if (!ids) {
      ids = new Set();
      tileRequests.set(tileKey, ids);
    }
    ids.add(id);

    const worker = pickWorker();
    const msg = { type, id, tileKey, data, config };
    postToWorker(worker, msg, transferables);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the worker pool. Call once at startup.
 */
export function initWorkerPool() {
  if (workers.length > 0) {
    console.warn('[WorkerPool] Already initialized.');
    return;
  }

  for (let i = 0; i < POOL_SIZE; i++) {
    const w = new Worker(
      new URL('./tileWorker.js', import.meta.url),
      { type: 'module' }
    );
    w.onmessage = onWorkerMessage;
    w.onerror = (e) => onWorkerError(i, e);
    workers.push(w);
  }

  nextWorkerIdx = 0;
  console.log(`[WorkerPool] Initialized ${POOL_SIZE} workers.`);
}

/**
 * Terminate all Workers and clear pending requests.
 */
export function disposeWorkerPool() {
  for (const w of workers) {
    w.terminate();
  }
  workers = [];
  nextWorkerIdx = 0;

  // Reject any still-pending requests.
  for (const [, entry] of pending) {
    entry.reject(new Error('[WorkerPool] Pool disposed.'));
  }
  pending.clear();
  tileRequests.clear();

  console.log('[WorkerPool] Disposed.');
}

/**
 * Process a tile's buildings off the main thread.
 *
 * @param {string} tileKey
 * @param {{ buildings: object[], roads: object[] }} tileData
 * @param {object} elevation  Elevation grid object (with .elevations typed array).
 * @param {number} elevationOffset  World elevation offset to subtract.
 * @param {object} config  Relevant CONFIG snapshot.
 * @returns {Promise<{ buildingGroups: *, roofGroups: *, detailGroups: *, tankInstances: *, pipeInstances: * }>}
 */
export function processBuildings(tileKey, { buildings, roads }, elevation, elevationOffset, config) {
  const { cloned: elevClone, transferable: elevBuf } = cloneElevation(elevation);
  const transferables = elevBuf ? [elevBuf] : [];

  return enqueue(
    'PROCESS_BUILDINGS',
    tileKey,
    { buildings, roads, elevation: elevClone, elevationOffset },
    config,
    transferables,
  );
}

/**
 * Process a tile's vegetation (trees + zone vegetation) off the main thread.
 *
 * @param {string} tileKey
 * @param {object} tileData  Full tile data object.
 * @param {object} elevation  Elevation grid object.
 * @param {number} elevationOffset
 * @param {object} config
 * @param {{ minX: number, maxX: number, minZ: number, maxZ: number }} tileBounds
 * @param {object[]} neighborRoads  Roads from neighboring tiles for edge trees.
 * @param {{ x: number, z: number }} sortCenter  Player position for LOD sorting.
 * @returns {Promise<{ treeVariants: *, shadowInstances: *, bushInstances: *, treePositions: *, zoneTreeVariants: *, zoneShadowInstances: *, zoneBushInstances: * }>}
 */
export function processVegetation(tileKey, tileData, elevation, elevationOffset, config, tileBounds, neighborRoads, sortCenter) {
  const { cloned: elevClone, transferable: elevBuf } = cloneElevation(elevation);
  const transferables = elevBuf ? [elevBuf] : [];

  return enqueue(
    'PROCESS_VEGETATION',
    tileKey,
    { tileData, tileKey, elevation: elevClone, elevationOffset, tileBounds, neighborRoads, sortCenter },
    config,
    transferables,
  );
}

/**
 * Process a tile's grass off the main thread.
 *
 * @param {string} tileKey
 * @param {object} tileData
 * @param {object} elevation
 * @param {number} elevationOffset
 * @param {object} config
 * @param {Array} treePositions  Positions of placed trees (to avoid overlap).
 * @param {{ minX: number, maxX: number, minZ: number, maxZ: number }} tileBounds
 * @returns {Promise<{ grassInstances: * }>}
 */
export function processGrass(tileKey, tileData, elevation, elevationOffset, config, treePositions, tileBounds, neighborRoads) {
  const { cloned: elevClone, transferable: elevBuf } = cloneElevation(elevation);
  const transferables = elevBuf ? [elevBuf] : [];

  return enqueue(
    'PROCESS_GRASS',
    tileKey,
    { tileData, tileKey, elevation: elevClone, elevationOffset, treePositions, tileBounds, neighborRoads },
    config,
    transferables,
  );
}

/**
 * Cancel all pending work for the given tile. Workers that are mid-computation
 * will receive a CANCEL message so they can bail out early if possible.
 *
 * @param {string} tileKey
 */
export function cancelTile(tileKey) {
  const ids = tileRequests.get(tileKey);
  if (!ids || ids.size === 0) return;

  for (const id of ids) {
    const entry = pending.get(id);
    if (entry) {
      // Reject the Promise so callers don't hang.
      entry.reject(new Error(`[WorkerPool] Tile ${tileKey} cancelled.`));
      pending.delete(id);
    }

    // Broadcast CANCEL to every worker (we don't track assignment).
    for (const w of workers) {
      w.postMessage({ type: 'CANCEL', id, tileKey });
    }
  }

  tileRequests.delete(tileKey);
}
