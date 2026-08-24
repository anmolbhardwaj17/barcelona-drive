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

### Cloudflare (R2 + Pages) — concrete steps  ⭐ recommended

Zero egress fees, so it stays free even at scale — the best fit for a bandwidth-heavy static app.

1. **App → Cloudflare Pages.** Connect the GitHub repo. Build command `npm run build`, output dir
   `frontend/dist`, and set build env vars: `VITE_TILE_REGION=barcelona`, `VITE_STATIC_TILES=1`, and
   `VITE_MAP_API=https://tiles.yourgame.com` (your R2 custom domain from step 2). Pages gives you HTTPS + CDN.

2. **Tiles → R2.** Create a bucket, attach a **custom domain** (e.g. `tiles.yourgame.com` — R2's `r2.dev` URL is
   rate-limited, don't use it in prod), and upload with the S3-compatible API (R2 works with the `aws` CLI):

   ```bash
   R2=https://<account_id>.r2.cloudflarestorage.com     # your R2 S3 endpoint
   B=barcelona-drive-tiles ; REGION=barcelona
   cd backend && node tools/buildCityMap.js $REGION 16
   gzip -9 -c tiles/$REGION/citymap.bin > /tmp/citymap.bin.gz

   aws s3 sync tiles/$REGION/16/ s3://$B/tiles/$REGION/16/ --endpoint-url $R2 \
     --content-type application/octet-stream --cache-control "public,max-age=31536000,immutable"
   aws s3 cp /tmp/citymap.bin.gz s3://$B/tiles/$REGION/citymap.bin --endpoint-url $R2 \
     --content-type application/octet-stream --content-encoding gzip \
     --cache-control "public,max-age=31536000,immutable"
   ```

3. **R2 CORS** — allow the Pages origin so the browser can fetch tiles cross-subdomain. In the bucket's CORS
   policy: `AllowedOrigins: ["https://yourgame.com"]`, `AllowedMethods: ["GET"]`. (Or serve app + tiles from the
   same domain via a Pages Function with an R2 binding for zero CORS.) **Purge the cache after any re-bake.**

Cost: R2 storage for ~580 MB is well under the 10 GB free tier; egress is free; Pages bandwidth is free. So
this is effectively **$0/month** at any realistic scale.

### AWS (S3 + CloudFront) — concrete steps

Everything lives in **one S3 bucket** behind **one CloudFront distribution**, so the app and tiles are
same-origin (no CORS). CloudFront's free tier is **1 TB egress + 10 M requests / month** — with the citymap
fix, a player pulls ~60–100 MB, so that's ~10k+ players/month free.

```bash
BUCKET=barcelona-drive           # your bucket name
REGION=barcelona

# 1. Build for same-origin static (VITE_MAP_API="" → relative URLs)
cd frontend
VITE_MAP_API= VITE_TILE_REGION=$REGION VITE_STATIC_TILES=1 npm run build

# 2. Regenerate the citymap, then gzip it (CloudFront won't auto-compress octet-stream)
cd ../backend && node tools/buildCityMap.js $REGION 16
gzip -9 -c tiles/$REGION/citymap.bin > /tmp/citymap.bin.gz

# 3. Upload the app — hashed assets immutable, index.html always-revalidate
cd ../frontend
aws s3 sync dist/ s3://$BUCKET/ --exclude index.html --cache-control "public,max-age=31536000,immutable"
aws s3 cp dist/index.html s3://$BUCKET/index.html --cache-control "no-cache"

# 4. Upload tiles (immutable) + the pre-gzipped citymap
aws s3 sync ../backend/tiles/$REGION/16/ s3://$BUCKET/tiles/$REGION/16/ \
  --content-type application/octet-stream --cache-control "public,max-age=31536000,immutable"
aws s3 cp /tmp/citymap.bin.gz s3://$BUCKET/tiles/$REGION/citymap.bin \
  --content-type application/octet-stream --content-encoding gzip \
  --cache-control "public,max-age=31536000,immutable"
```

CloudFront distribution settings:
- **Origin:** the S3 bucket, locked down with **Origin Access Control** (keep the bucket private).
- **Default root object:** `index.html`; **Viewer protocol policy:** redirect HTTP→HTTPS.
- **Compress objects automatically:** on (compresses the JS/CSS; the pre-gzipped citymap already carries
  `Content-Encoding: gzip`).
- **HTTPS:** free ACM certificate (request it in **us-east-1** for CloudFront); point Route 53 at the distribution.
- **After a redeploy or re-bake:** `aws cloudfront create-invalidation --distribution-id <ID> --paths "/index.html" "/tiles/*"`.

> **Cost watch:** unlike Cloudflare, CloudFront egress isn't free past the 1 TB tier (~$0.085/GB after). The
> citymap fix keeps per-player transfer small, so this only matters at real scale. S3 storage for ~580 MB is
> ~$0.013/month.

### Run the server on AWS instead (Option B)

If you'd rather run `backend/server.js`: **AWS App Runner** or **Elastic Beanstalk** (Node) is simplest —
push the `backend/` folder, set `NODE_ENV=production` + `ALLOWED_ORIGINS`, and bake the tiles into the image
or mount them from EFS/S3. This costs more (always-on compute) and buys you nothing over the static path for a
static app, so prefer S3 + CloudFront unless you specifically need the `/api` routes.

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

## ⚠ v3 build-order trap (P1-02)

`vite build` **empties `frontend/dist`**, including the 547 MB of tiles copied in for the static
bundle. So the copy step must run **after** the build and **before** `wrangler pages deploy` —
`deploy-cloudflare.sh` already orders it that way, but if you ever run the steps by hand, that is
the one that bites.

`frontend/public/_headers` sets `immutable` on `/assets/*`, `/basis/*` and `/art/v1/*`.

**The art library is served from a VERSIONED path (`/art/v1/`) on purpose.** Files under `public/`
keep their own names — Vite does not content-hash them — so an immutable header on a mutable
filename would pin a stale texture in players' caches for a year. To change art, bump the version
directory; never edit a file in place under an immutable path.

Benchmark runs (`?bench`) need the preview origin allowed by the tile server:
```
ALLOWED_ORIGINS="http://localhost:4040,http://localhost:4044" npm start   # in backend/
```

