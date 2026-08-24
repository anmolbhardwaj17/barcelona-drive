/**
 * tileWorker.js — Web Worker entry point for off-thread tile geometry computation.
 *
 * Receives messages from workerPool.js, dispatches to the appropriate
 * computation module (buildings, vegetation, grass), and returns raw
 * typed-array buffers via Transferable objects.
 */

import { processBuildingsInWorker } from './buildingWorker.js';
import { processVegetationInWorker } from './vegetationWorker.js';

// ---------------------------------------------------------------------------
// Cancellation tracking
// ---------------------------------------------------------------------------

/** Set of request IDs that have been cancelled. Checked between phases. */
const cancelledIds = new Set();

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = function (event) {
  const msg = event.data;

  if (msg.type === 'CANCEL') {
    cancelledIds.add(msg.id);
    return;
  }

  // All processing messages share { type, id, tileKey, data, config }
  const { type, id, data, config } = msg;

  // Check if already cancelled before starting
  if (cancelledIds.has(id)) {
    cancelledIds.delete(id);
    return;
  }

  try {
    let result;

    switch (type) {
      case 'PROCESS_BUILDINGS':
        result = processBuildingsInWorker(data, config);
        break;

      case 'PROCESS_VEGETATION':
        result = processVegetationInWorker(data, config);
        break;

      default:
        throw new Error(`Unknown message type: ${type}`);
    }

    // Check cancellation after computation (worker may have been cancelled mid-work)
    if (cancelledIds.has(id)) {
      cancelledIds.delete(id);
      return;
    }

    // Collect all ArrayBuffers from the result for zero-copy transfer
    const transferables = collectTransferables(result);

    self.postMessage({ type: 'RESULT', id, result }, transferables);

  } catch (err) {
    // Don't send error for cancelled requests
    if (cancelledIds.has(id)) {
      cancelledIds.delete(id);
      return;
    }
    self.postMessage({ type: 'ERROR', id, error: err.message || String(err) });
  }
};

// ---------------------------------------------------------------------------
// Transferable collection
// ---------------------------------------------------------------------------

/**
 * Recursively collect all ArrayBuffer instances from a result object.
 * These are passed as the transfer list to postMessage for zero-copy.
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
    const keys = Object.keys(val);
    for (let i = 0; i < keys.length; i++) visit(val[keys[i]]);
  }

  visit(obj);
  return buffers;
}
