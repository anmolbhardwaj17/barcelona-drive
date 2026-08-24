# Canvas-texture retirement register (v3 P1-06)

40 `new THREE.CanvasTexture` sites across 18 files. Each is a texture drawn procedurally at runtime
that the v3 art library is meant to replace with an authored KTX2 map.

**Why a register and not a to-do:** every subsystem audit assumed "the foundation" owned these, and
the foundation budgeted zero days for them. Left alone they survive by default, and each one is a
canvas backing store plus an RGBA8 upload that never appears in any art budget — the night window
atlases alone measured **55.9 MiB**.

`npm run lint:canvas` enforces a per-file budget (`frontend/scripts/lint-canvas.mjs`). Adding one to
a file at its cap fails. **Retiring one means lowering the number in the same commit** — the ratchet
only turns one way.

| Owner file | Count | What it draws | Retired by |
|---|---|---|---|
| `workers/meshMaterializer.js` | 6 | facade window textures + night emissive atlases | **P3** facade array texture |
| `map/roadRenderer.js` | 5 | markings / paint atlases | **P3** road material |
| `map/buildingRenderer.js` | 5 | LOD + night window atlas | **P3/P4** |
| `scene.js` | 4 | cloud, moon, moon glow, stars | **P4** sky (2 KTX2 keys) |
| `map/urbanFeatureRenderer.js` | 3 | fountain / hydrant / misc props | **P4** prop atlas |
| `map/roadInfraRenderer.js` | 3 | signs, boards, lane arrows | **P4** sign atlas |
| `map/vegetationRenderer.js` | 2 | tree billboard atlas | **P4** foliage atlas |
| `map/generate-road-atlas.js` | 2 | build-time tool | exempt — not shipped |
| `map/shopSignRenderer.js` | 1 | shop fascia text | **P4** bounded text page |
| `map/streetlightRenderer.js` | 1 | ground-pool glow | **P2/P4** (see `lightPoolDecal.js`) |
| `map/tunnelRenderer.js`, `map/busStopRenderer.js`, `map/barrierRenderer.js` | 1 each | surface detail | **P4** |
| `car/carModel.js`, `car/carEffects.js`, `car/contactShadows.js`, `ui/carShowcase.js` | 1 each | car paint / effects / blob shadow | **P4** vehicle atlas; the blob shadow may legitimately stay |
| `tunnelDebugOverlay.js` | 1 | debug only | exempt |

## Rules

1. **Never add one to a file at its budget.** The lint fails the build.
2. **Retire = lower the number,** in the same commit as the replacement.
3. A new file needs a BUDGET entry naming the phase that retires it — no silent additions.
4. Debug-only and build-time sites are exempt but still counted, so the total stays honest.
