/**
 * Express server: GET /api/tiles/:tileId (static tile JSON from disk).
 * Tiles are produced by worldBuilder/buildRegion.js.
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readTile, getTilePath, readBinaryTile } from './tileBake.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4041;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:4040');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function safeTileId(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 64) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) return null;
  return s;
}

/**
 * GET /api/tiles/:tileId
 * Optional query: region (default from env REGION or "delhi").
 * Returns static tile JSON from tiles/{region}/{z}/{x}/{y}.json. 404 if tile not built.
 */
app.get('/api/tiles/:tileId', (req, res) => {
  const tileId = safeTileId(req.params.tileId);
  if (!tileId) {
    return res.status(400).json({ error: 'Invalid tileId (use z_x_y e.g. 16_12345_9876)' });
  }
  const region = (req.query.region && safeTileId(req.query.region)) || process.env.REGION || 'delhi';

  // Prefer binary v6 tile if available
  const binData = readBinaryTile(tileId, region);
  if (binData) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.send(binData);
  }

  // Fallback to JSON v5
  const data = readTile(tileId, region);
  if (!data) {
    const resolvedPath = getTilePath(tileId, region);
    console.warn('[Tiles] Tile not found — tileId:', tileId, 'region:', region, 'path:', resolvedPath);
    return res.status(404).json({ error: 'Tile not found', tileId, region });
  }
  return res.json(data);
});

/**
 * GET /api/tile-manifest?region=barcelona&zoom=16
 * Lists every baked tile id (z_x_y) for the region — used by the custom minimap to background-load the
 * whole city's 2D data. Reads tiles/{region}/{zoom}/{x}/{y}.bin off disk.
 */
app.get('/api/tile-manifest', (req, res) => {
  const region = (req.query.region && safeTileId(req.query.region)) || process.env.REGION || 'delhi';
  const zoom = safeTileId(String(req.query.zoom || '16')) || '16';
  const base = path.join(__dirname, 'tiles', region, zoom);
  try {
    const tiles = [];
    for (const xdir of fs.readdirSync(base)) {
      const xpath = path.join(base, xdir);
      let st; try { st = fs.statSync(xpath); } catch { continue; }
      if (!st.isDirectory()) continue;
      for (const yfile of fs.readdirSync(xpath)) {
        const m = yfile.match(/^(\d+)\.bin$/);
        if (m) tiles.push(`${zoom}_${xdir}_${m[1]}`);
      }
    }
    res.setHeader('Cache-Control', 'no-cache');
    return res.json({ region, zoom, count: tiles.length, tiles });
  } catch (e) {
    return res.status(404).json({ error: 'No tiles for region', region, zoom });
  }
});

app.listen(PORT, () => {
  console.log(`Map server listening on http://localhost:${PORT}`);
});
