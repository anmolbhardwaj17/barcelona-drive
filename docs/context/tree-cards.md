# Tree Cards — v3 P3-10

Photographic crossed-quad street trees replacing the icosahedron blobs, plus the first
implementation of the art bible's §4.4 normalization procedure.

**Switch:** `?treecards=0` reverts to the legacy blobs (`CONFIG.TREE_CARDS`). Attribution switch,
not a preference — see CLAUDE.md.

---

## 1. What a card is

Two quads crossed at 90°, 8 verts / 4 triangles, standing on `y=0`, centred on the trunk. Replaces
a trunk cylinder + 2–3 icosahedron lobes (~80 tris) carrying a flat green. **Cost moves from vertex
to fill**, which is why the switch exists: whether that is a net win at Eixample tree density is a
question to measure, not to argue.

Six species, one 3072×2048 atlas + one normal atlas:

| # | Species | Height | Where it belongs |
|---|---|---|---|
| 0 | `plane_pollarded` | 12 m | The Barcelona avenue tree — Gran Via, Diagonal |
| 1 | `tipuana` | 12 m | Broad flat crown, second most common |
| 2 | `celtis` | 12 m | Side streets |
| 3 | `washingtonia` | 15 m | Coast, Passeig Marítim |
| 4 | `jacaranda` | 10 m | Seasonal accent; common only in parks |
| 5 | `orange_bitter` | 5 m | Plaças, courtyards, narrow streets |

### Three things that make or break a card

1. **Size.** The quad's UV is the **opaque sub-rect** of its atlas cell (`contentUV`), not the whole
   cell. Map the whole cell and the transparent packing margin scales into the quad, so a 15 m
   Washingtonia draws visibly shorter than 15 m. Width is `heightM × aspect` — the image's own
   proportions. `canopyM` is advisory (spacing/collision), never card sizing.
2. **Lighting.** Normals are a **dome** radiating from the canopy centre, which is what makes a flat
   quad shade like a volume. three then negates the normal on back faces (`DOUBLE_SIDED`), which
   points the dome *into* the tree and turns the card black from behind — so the card material
   rewrites `faceDirection` to `1.0`. `treeCards.test.js` asserts that three chunk still exists.
3. **Sorting.** `alphaTest`, never `transparent: true`. Blending tens of thousands of quads means a
   per-frame depth sort of the whole set and no early-z.

---

## 2. The normalize pipeline — `tools/artNormalize.py`

**This is the half that makes cards belong in the scene.** Shipped without it, the six plates each
carried their own baked sun and their own exposure, the scene lit them a second time, and they read
as stickers pasted onto a desaturated low-poly city. Art-bible rule **N-5**: every asset passes
normalize, *including "it already looked fine."*

Implements §4.4 steps **2** (de-light), **3** (Lab L\*/C\* rescale), **4** (normal calibration),
**5** (palette snap), **6** (pre-grade compensation), plus the gate-4 ΔE2000 assertion and the
rally-clip check. Steps 0/1/7/8 stay with the calling tool.

> **Relationship to BLK-2.** The bible specifies this as `scripts/build-art.mjs`, one implementation
> for the whole library ("No domain runs its own version"). That does not exist yet. `artNormalize.py`
> is deliberately a **shared, importable** module rather than a copy pasted into the tree tool, so
> that when build-art.mjs lands there is one procedure to port and not several that have drifted.

Configuration for this asset class: source `ai` (k=0.35) · class `foliage_leaf` (L\* 45/σ13, C\* 24)
· anchors **P9 Platanus Green + P10 Mediterrani Blue** · α 0.35 · normal band `foliage` (0.20–0.35).

### Two landmines this pipeline already hit

- **`step5_palette_snap` must snap to the NEAREST allowed anchor, per pixel.** Snapping everything
  to one anchor rotated the jacaranda's genuine violet blossom (hue ~315°) toward P9 green
  (hue ~121°) — a ~180° arc whose *shorter* side runs through red. It landed on hot pink. The plate
  was never wrong; the code was. Nearest-anchor snapping is always a short, inward rotation.
- **Statistics must be computed over OPAQUE pixels only.** Including the transparent margin drags
  every mean toward the background and silently wrecks the rescale.

Two anchors are allowed for foliage because a violet-flowering street tree has no green-anchor-legal
representation. **§4.1 assigns P10 to water/haze, so this is a proposed amendment to the bible's
allowed-set for foliage, not something it already sanctions.**

### Open gate items

| Gate | Status |
|---|---|
| 4 — mean colour ΔE2000 ≤ 15 of an anchor | **jacaranda 17.01** vs P10. Five species pass (4.9–7.1). The bible's own note calls the threshold tunable to 18 after the first 10 assets; not silently widened. |
| 6 — no channel clips at rally saturation ×1.52 | **washingtonia 8.3%** of opaque pixels. Rally-mode only; the other five are 0–2.9%. |

---

## 3. Species-by-context classifier — TIER 3 ONLY

Replaces `bakedVariantIndices[i] % NUM_TREE_VARIANTS`, which was species-**blind**: it spread six
species uniformly over every context, so palms grew in courtyards and bitter oranges lined Gran Via.

The design is three-tier. **Only tier 3 is implemented**, and deliberately:

| Tier | Rule | Status |
|---|---|---|
| 1 | OSM-tagged species within 4 m | **Blocked** — needs the P1 species pipe |
| 2 | Per-tile species histogram | **Blocked** — same |
| 3 | Context: avenue / street / coast / park / plaza | **Done** |

The bake *does* extract a per-tree `species` string (`pbfPointFeatures.js:189`) but it stops at the
tile format — the worker receives only positions and an index array. Tier 3 stands alone by design:
species coverage is 13.8%, so graceful degradation was always going to carry ~86% of the city.

Context is assigned where trees are generated (`collectAllPositions`), because that is the only
place it is known: roadside trees carry their road class, building-perimeter and courtyard trees are
`plaza`, greens-polygon trees are `park`, and a tile that touches beach/sea makes everything `coast`.

**The classifier returns the legacy modulo untouched whenever `NUM_TREE_VARIANTS !== 6`** — handing
a 6-species index to the 4-variant blob path would not throw, it would silently draw the wrong
geometry.

---

## 4. Billboard collapse (P3-10c)

Was: one material **and** one pool set per variant, each with a `bbUvOff` uniform shifting a shared
quad into its atlas cell. Now: the cell is baked into each variant's **geometry UVs**, the pools
select it with `setGeometryIdAt`, and every impostor in the city draws from **one material and one
pool**.

Also in this pass:
- Impostors draw from the **same photographic atlas as the near cards**, so a tree no longer changes
  species as it crosses the LOD band. (The old atlas was hand-drawn ellipses derived from
  `FOLIAGE_COLORS` — it only ever matched the blobs, and had exactly 4 cells against 6 species.)
- Impostor quads are **sized per species**. One shared 5×7 quad made a 15 m palm and a 5 m orange
  the same height, so trees jumped as they crossed the band.
- `transparent: true` **dropped** — `alphaTest 0.05` already does the cutout, and blending forced
  every distant tree through the sorted pass with no Z-rejection.
- Mips + `LinearMipmapLinear` (the ellipse canvas had neither — distant impostor rows shimmered).
- **`bbEnd` clamped to `FOG_FULL_DIST`.** The fade ran to `treeMaxDist + 300` (~470 m) while
  everything past 280 m is fog-culled outright, so impostors never reached full count in the only
  band they were visible in.

---

## 5. Roadside decimation (P3-10b)

`ROADSIDE_SPACING_MIN/MAX` 2–5 m → **6–8 m**. A 2 m stride plants trees closer together than their
own canopies are wide, which reads as a hedge rather than a street planting. Also removes ~35–40% of
the city's tree instances — the largest vegetation saving available without changing what a tree
costs to draw.

---

## 6. Files

| File | Role |
|---|---|
| `tools/build-tree-atlas.py` | Key → repair → **normalize** → normal → pack → manifest → contact sheet |
| `tools/artNormalize.py` | The §4.4 procedure (shared; see BLK-2 note above) |
| `frontend/src/map/treeCards.js` | Card geometry, card material, atlas load |
| `frontend/src/map/treeAtlas.js` | **GENERATED** manifest — do not edit by hand |
| `frontend/src/map/treeWind.js` | Shared sway, so blob and card paths cannot drift |
| `frontend/src/map/vegetationRenderer.js` | `getTreeGeometries()` / `getTreeMaterial()` — **THE SEAM** |
| `frontend/src/workers/vegetationWorker.js` | Context tagging + `classifySpecies()` |

### The seam

`getTreeGeometries()` and `getTreeMaterial()` **must be used as a pair**. The pools hand BatchedMesh
a geometry list and one material, and per-instance `geoIndex` indexes that list — card geometry with
the blob material does not throw, it draws garbage. Every consumer (global pools, per-tile fallback,
`environmentClusterRenderer`, the boot shader warm-up) routes through them.

`CONFIG.NUM_TREE_VARIANTS` is shipped to the vegetation worker because the worker cannot see the
geometry it is bucketing for, and `meshMaterializer` **drops** any `variantIndex` past the end of the
geometry list. An over-count deletes trees with no warning.
