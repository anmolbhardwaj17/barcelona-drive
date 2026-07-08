#!/usr/bin/env bash
# One-command Cloudflare deploy for Barcelona Drive — tiles on R2 (zero egress), app on Pages.
#
# ── One-time setup (things only YOU can do — they involve your account/credentials) ──
#   1. A Cloudflare account, with a domain added to it.
#   2. Create an R2 bucket (Cloudflare dashboard → R2), and attach a custom domain to it
#      (e.g. tiles.yourgame.com — the free r2.dev URL is rate-limited, don't use it in prod).
#   3. R2 → "Manage R2 API Tokens" → create a token → note the Access Key ID + Secret.
#   4. Create a Pages project once (dashboard → Workers & Pages → Create → Pages), name it below.
#   5. Install the CLIs:   npm i -g wrangler   +   the AWS CLI (used only for the R2 S3 upload)
#   6. Authorize wrangler in YOUR browser (your credentials never leave your machine):
#          wrangler login
#   7. Export your R2 token so the AWS CLI can reach R2:
#          export AWS_ACCESS_KEY_ID=<your R2 access key>
#          export AWS_SECRET_ACCESS_KEY=<your R2 secret>
#
# Then just run:  ./deploy-cloudflare.sh
set -euo pipefail

# ─────────── CONFIG — fill these in ───────────
REGION=barcelona
TILES_DOMAIN=https://tiles.yourgame.com          # your R2 bucket's custom domain
R2_BUCKET=barcelona-drive-tiles                  # your R2 bucket name
R2_ACCOUNT_ID=your_cloudflare_account_id         # Cloudflare → account id (right sidebar)
PAGES_PROJECT=barcelona-drive                    # your Pages project name
# ──────────────────────────────────────────────

R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

echo "→ [1/4] Building the frontend (static; tiles served from $TILES_DOMAIN)…"
( cd frontend && VITE_MAP_API="$TILES_DOMAIN" VITE_TILE_REGION="$REGION" VITE_STATIC_TILES=1 npm run build )

echo "→ [2/4] Regenerating + gzipping the citymap…"
( cd backend && node tools/buildCityMap.js "$REGION" 16 )
gzip -9 -c "backend/tiles/$REGION/citymap.bin" > /tmp/citymap.bin.gz

echo "→ [3/4] Uploading tiles + citymap to R2 (immutable cache)…"
aws s3 sync "backend/tiles/$REGION/16/" "s3://$R2_BUCKET/tiles/$REGION/16/" --endpoint-url "$R2_ENDPOINT" \
  --content-type application/octet-stream --cache-control "public,max-age=31536000,immutable"
aws s3 cp /tmp/citymap.bin.gz "s3://$R2_BUCKET/tiles/$REGION/citymap.bin" --endpoint-url "$R2_ENDPOINT" \
  --content-type application/octet-stream --content-encoding gzip \
  --cache-control "public,max-age=31536000,immutable"

echo "→ [4/4] Deploying the app to Cloudflare Pages…"
npx wrangler pages deploy frontend/dist --project-name="$PAGES_PROJECT"

echo ""
echo "✓ Deployed. App on Pages, tiles on R2 ($TILES_DOMAIN)."
echo "  Once, in the R2 bucket CORS policy, allow your Pages origin:"
echo '    [{ "AllowedOrigins": ["https://yourgame.com"], "AllowedMethods": ["GET"] }]'
echo "  After a future re-bake: re-run this script, then purge the R2 cache for the changed tiles."
