# Baked tiles

Tiles are served by the backend. GET /api/tiles/:tileId (tileId = z_tx_ty, e.g. 0_-952_-2326).

**Bake a tile (CLI):** `npm run bake <tileId>` or `npm run bake <tx> <ty>` — writes to backend/tiles/<tileId>.json.

**Frontend:** Uses START_LAT, START_LON (projection.js); requests `GET ${API_BASE}/api/tiles/<tileId>`. Backend bakes on demand if missing.
