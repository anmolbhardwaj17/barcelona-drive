/**
 * Express server: GET /api/tiles/:tileId (static tile JSON from disk).
 * Tiles are produced by worldBuilder/buildRegion.js.
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { readTile, getTilePath, readBinaryTile } from './tileBake.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4041;
const IS_PROD = process.env.NODE_ENV === 'production';
const DEFAULT_REGION = process.env.REGION || 'barcelona';

// CORS: allowlist from ALLOWED_ORIGINS (comma-separated), or "*" for a fully public API. Defaults to both
// local frontends so local dev keeps working: 4040 is `npm run dev`, 4044 is `npm run preview` (the
// production build used for perf drives). Set ALLOWED_ORIGINS to your deployed origin(s) in production.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:4040,http://localhost:4044').split(',').map((s) => s.trim()).filter(Boolean);
const ALLOW_ANY = ALLOWED_ORIGINS.includes('*');

// Tiles/citymap are immutable per bake → cache hard in production (returning players re-download nothing);
// stay uncached in dev so a re-bake shows up immediately. Purge the CDN/edge cache after a re-bake.
const STATIC_CACHE = IS_PROD ? 'public, max-age=31536000, immutable' : 'no-cache';

app.disable('x-powered-by');   // don't advertise Express version
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOW_ANY) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && ALLOWED_ORIGINS.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');   // no MIME sniffing
  res.setHeader('Referrer-Policy', 'no-referrer');
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
  const region = (req.query.region && safeTileId(req.query.region)) || DEFAULT_REGION;

  // Prefer binary v6 tile if available
  const binData = readBinaryTile(tileId, region);
  if (binData) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', STATIC_CACHE);
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
  const region = (req.query.region && safeTileId(req.query.region)) || DEFAULT_REGION;
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

/**
 * GET /api/citymap?region=barcelona
 * The whole city's 2D vector map (roads/water/parks) as ONE compact file — replaces streaming all ~426 full
 * tiles just to draw the minimap (~525 MB → ~0.5 MB gzipped). Immutable (regenerate with tools/buildCityMap.js
 * after a re-bake). Served gzipped + cached-forever; the CDN/browser caches it so returning players re-fetch 0.
 */
const _cityMapGz = new Map();   // region -> pre-gzipped buffer (built once, reused)
app.get('/api/citymap', (req, res) => {
  const region = (req.query.region && safeTileId(req.query.region)) || DEFAULT_REGION;
  const file = path.join(__dirname, 'tiles', region, 'citymap.bin');
  let gz = _cityMapGz.get(region);
  if (!gz) {
    let data; try { data = fs.readFileSync(file); } catch { return res.status(404).json({ error: 'No citymap — run tools/buildCityMap.js', region }); }
    gz = zlib.gzipSync(data, { level: 9 });
    _cityMapGz.set(region, gz);
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', STATIC_CACHE);
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.setHeader('Content-Encoding', 'gzip');
    return res.end(gz);
  }
  return res.end(zlib.gunzipSync(gz));
});

app.listen(PORT, () => {
  console.log(`Map server listening on http://localhost:${PORT}`);
});
