/**
 * Terrain smoothing: 3x3 box blur and vertical scale.
 * Applied to elevation grid before modifyTileTerrain.
 * Grid: row-major, row 0 = south, col 0 = west.
 */

/**
 * One pass of 3x3 box blur. Uses clamped borders (replicate edge).
 * Mutates grid in place; returns grid for chaining.
 * @param {number[]} grid - row-major elevation data
 * @param {number} rows
 * @param {number} cols
 * @returns {number[]} same grid, mutated
 */
export function boxBlur3x3(grid, rows, cols) {
  const out = grid.slice();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      let count = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = Math.max(0, Math.min(rows - 1, r + dr));
          const cc = Math.max(0, Math.min(cols - 1, c + dc));
          sum += grid[rr * cols + cc];
          count++;
        }
      }
      out[r * cols + c] = sum / count;
    }
  }
  for (let i = 0; i < grid.length; i++) grid[i] = out[i];
  return grid;
}

/**
 * Multiply all elevation values by factor (vertical scale).
 * Mutates grid in place.
 * @param {number[]} grid - row-major elevation data
 * @param {number} factor - e.g. 0.6 to reduce terrain relief
 */
export function applyVerticalScale(grid, factor) {
  for (let i = 0; i < grid.length; i++) {
    grid[i] *= factor;
  }
}

/**
 * Remove micro-spikes: if |height - 8-neighbor mean| < threshold, flatten to neighbor mean.
 * Preserves macro shape, removes roof noise.
 * @param {number[]} grid - row-major elevation data
 * @param {number} rows
 * @param {number} cols
 * @param {number} threshold - default 0.3m
 */
export function removeMicroNoise(grid, rows, cols, threshold = 0.3) {
  const out = grid.slice();
  const offs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0, count = 0;
      for (const [dr, dc] of offs) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) {
          sum += grid[rr * cols + cc];
          count++;
        }
      }
      const neighborMean = count > 0 ? sum / count : grid[r * cols + c];
      const h = grid[r * cols + c];
      if (count > 0 && Math.abs(h - neighborMean) < threshold) {
        out[r * cols + c] = neighborMean;
      }
    }
  }
  for (let i = 0; i < grid.length; i++) grid[i] = out[i];
  return grid;
}

/**
 * Low/high frequency blend: FinalHeight = lerp(original, smoothed, blendFactor).
 * blendFactor 0.6 = 60% smoothed, 40% original. Preserves macro hills, removes micro noise.
 * @param {number[]} original - raw grid (unchanged)
 * @param {number[]} smoothed - smoothed grid (mutated to result)
 * @param {number} blendFactor - 0 = keep original, 1 = full smoothed
 */
export function lowHighFrequencyBlend(original, smoothed, blendFactor) {
  for (let i = 0; i < smoothed.length; i++) {
    smoothed[i] = original[i] * (1 - blendFactor) + smoothed[i] * blendFactor;
  }
  return smoothed;
}

/**
 * Clamp extreme slopes: if slope to any neighbor > threshold (m/cell), flatten toward 8-neighbor mean.
 * @param {number[]} grid - row-major elevation data
 * @param {number} rows
 * @param {number} cols
 * @param {number} slopeThreshold - e.g. 0.3 m/cell
 */
export function clampExtremeSlopes(grid, rows, cols, slopeThreshold = 0.3) {
  const offs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  const out = grid.slice();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const h = grid[i];
      let sum = 0, count = 0, maxSlope = 0;
      for (const [dr, dc] of offs) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) {
          const n = grid[rr * cols + cc];
          if (Number.isFinite(n)) {
            sum += n;
            count++;
            maxSlope = Math.max(maxSlope, Math.abs(h - n));
          }
        }
      }
      if (count > 0 && maxSlope > slopeThreshold) {
        const mean = sum / count;
        out[i] = mean;
      }
    }
  }
  for (let i = 0; i < grid.length; i++) grid[i] = out[i];
  return grid;
}

/**
 * Replace NaN/Infinity in grid with 0 or 8-neighbor mean. Mutates in place.
 * @param {number[]} grid - row-major elevation data
 * @param {number} rows
 * @param {number} cols
 */
export function sanitizeGrid(grid, rows, cols) {
  const offs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      let v = grid[i];
      if (!Number.isFinite(v)) {
        let sum = 0; let count = 0;
        for (const [dr, dc] of offs) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) {
            const n = grid[rr * cols + cc];
            if (Number.isFinite(n)) { sum += n; count++; }
          }
        }
        grid[i] = count > 0 ? sum / count : 0;
      }
    }
  }
}
