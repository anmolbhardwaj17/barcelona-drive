/**
 * Static tile serving: resolve tile path and read from disk.
 * Tiles are produced by worldBuilder/buildRegion.js as binary v6 (.bin).
 * Falls back to JSON v5 (.json) if binary not found.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TILES_DIR = path.join(__dirname, 'tiles');

const DEFAULT_REGION = process.env.REGION || 'delhi';

export function parseTileId(tileId) {
  const parts = String(tileId).split('_');
  if (parts.length < 3) return null;
  const z = parseInt(parts[0], 10);
  const x = parseInt(parts[1], 10);
  const y = parseInt(parts[2], 10);
  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { z, x, y };
}

/**
 * Get path to the tile file (binary .bin or fallback .json).
 */
export function getTilePath(tileId, region = DEFAULT_REGION, ext = '.bin') {
  const p = parseTileId(tileId);
  if (!p) return path.join(TILES_DIR, String(tileId).replace(/[^a-zA-Z0-9_-]/g, '_') + ext);
  return path.join(TILES_DIR, region, String(p.z), String(p.x), String(p.y) + ext);
}

/**
 * Read binary tile from disk. Returns Buffer or null if file missing.
 */
export function readBinaryTile(tileId, region = DEFAULT_REGION) {
  const filePath = getTilePath(tileId, region, '.bin');
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Read tile JSON from disk (legacy fallback). Returns parsed object or null.
 */
export function readTile(tileId, region = DEFAULT_REGION) {
  const filePath = getTilePath(tileId, region, '.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
