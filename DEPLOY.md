# Deploying Barcelona Drive

The whole app is **static**: a Vite-built frontend plus pre-baked binary map tiles. There is **no database and no
per-user server state** — the "backend" only hands out static files. That makes hosting cheap and simple.

## What ships

| Artifact | Size | Where it comes from |
|---|---|---|
| Frontend bundle (`frontend/dist/`) | ~55 MB (incl. models/textures/audio) | `npm run build` |
| Baked tiles (`backend/tiles/<region>/16/**.bin`) | ~525 MB | the bake pipeline (gitignored) |
| Citymap (`backend/tiles/<region>/citymap.bin`) | ~3.7 MB (0.57 MB gzipped) | `node backend/tools/buildCityMap.js` |

> **Bandwidth note:** the minimap loads the whole city from the single `citymap.bin` (~0.6 MB gzipped), **not**
> from the 525 MB tile set. Gameplay tiles stream only around the player. Egress is the only real cost.

## Build steps

```bash
# 1. Frontend
cd frontend
#   set VITE_MAP_API to where the tiles are served from (see .env.example)
VITE_MAP_API=https://tiles.your-host.example VITE_TILE_REGION=barcelona npm run build   # → frontend/dist/

# 2. Citymap (regenerate whenever tiles are re-baked)
cd ../backend
node tools/buildCityMap.js barcelona 16                                                 # → tiles/barcelona/citymap.bin
```

---

## Option A — Pure static CDN (recommended, cheapest)

No server runs. Serve the frontend and the tiles as plain files. Build the frontend with:

```bash
VITE_MAP_API=https://tiles.your-host.example VITE_TILE_REGION=barcelona VITE_STATIC_TILES=1 npm run build
```

`VITE_STATIC_TILES=1` makes the client fetch `/<region>/<z>/<x>/<y>.bin` and `/citymap.bin` directly.

Upload:
- `frontend/dist/` → your static host (Cloudflare Pages, Netlify, S3, …)
- `backend/tiles/<region>/` → an object store at `VITE_MAP_API` (so `.../tiles/barcelona/16/…/….bin` resolves)

**Why Cloudflare:** R2 has **zero egress fees**, so even with the 525 MB tile set the monthly cost is ~pennies of
storage. Set the object store / CDN to serve `.bin` with a long, immutable `Cache-Control` and gzip/brotli on.
**Purge the CDN cache after any re-bake** (tiles are cached as immutable).

## Option B — Node server (`backend/server.js`)

Runs the Express static-file server. Set env (see `backend/.env.example`):

```bash
NODE_ENV=production \
ALLOWED_ORIGINS=https://your-frontend.example \
REGION=barcelona \
PORT=4041 \
node server.js
```

Build the frontend **without** `VITE_STATIC_TILES` (uses the `/api/tiles` + `/api/citymap` routes). In production
mode the server sets immutable cache headers and gzips the citymap. Put a CDN in front for egress/caching.

---

## Production checklist

- [x] **CORS** is env-driven (`ALLOWED_ORIGINS`); no wildcard by default, disallowed origins get no CORS header.
- [x] **Immutable caching** on tiles/citymap when `NODE_ENV=production` (returning players re-download nothing).
- [x] **Security headers**: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `x-powered-by` off.
- [x] **Path traversal** blocked — tile/region params are strictly validated (`^[a-zA-Z0-9_-]+$`).
- [x] **No secrets / PII** in the repo or client bundle; `.env*` is gitignored.
- [x] **No source maps** shipped in the prod build; `console.log/info/debug` stripped.
- [x] **0 dependency vulnerabilities** (frontend + backend).
- [ ] **Set `VITE_MAP_API`** at build time — otherwise the site falls back to `localhost:4041` (broken/mixed-content).
- [ ] **Purge CDN cache** after a re-bake (immutable tiles) and re-run `buildCityMap.js`.
- [ ] Third-party calls to review for your privacy policy: Nominatim (spawn search) + Google Fonts. Self-host/proxy if desired.
