# ETS2 Target Audit — can a browser build reach a Euro Truck Simulator 2 look?

**Question (Anmol, 2026-08-24):** treat what we have as v1. Can v2 reach an ETS2-adjacent
aesthetic — their trees instead of our polygon blobs, their building treatment, a cleaner and
more refined look — in a browser, on desktop, if we optimise properly? Not pixel parity; the
*way* they use assets.

> **Companion doc:** [visual-target-analysis.md](visual-target-analysis.md) answered the same
> shape of question against offline archviz renders and concluded "vibe parity, ~70%". This doc
> answers it against a *shipped real-time game*, which is a much more useful target — and reaches
> a different conclusion about **what** the gap is.


> ## ⚠ SUPERSEDED IN PART — read [v2-plan-hardened.md](v2-plan-hardened.md) first
>
> A 12-agent adversarial cross-examination (2026-08-24) **refuted or corrected 5 of the 7
> load-bearing claims below.** What still stands: §0 (binding browser-only constraints), §6 (the
> free CC0 + AI asset strategy), and the core finding that lighting/atmosphere is already the
> sophisticated part. What changed:
>
> | Claim | Status | Corrected |
> |---|---|---|
> | C1 70% art / 30% engineering | **corrected** | ~50/50, and **the engineering must go FIRST** — art on an ungated LOD + a broken resolution controller is invisible |
> | C2 65–75% of the vibe | **corrected** | **65% day / 50% night.** Night is structurally capped: there are **zero punctual street lights** (`main.js:192`), and PBR's whole advantage is specular response to them |
> | C3 25–30 MB / 15–20 MB VRAM | **download confirmed, VRAM refuted 8–15×** | Real VRAM is **153 MiB (ETC2) / 299 MiB (BC7)**. `.ktx2` file size ≠ resident size. **VRAM is a third binding constraint this audit omitted** |
> | C4 draw calls binding at 790 | **refuted** | Real is **261–289**. The 790 was copied from a `perf-audit.md` that is 261 commits stale. Binding constraints are VRAM, fragment/overdraw at night+speed, CPU stream-in, and per-tile LOD granularity |
> | C5 SSAO re-attemptable | **corrected → don't** | **Rejected.** Extend the baked v9 sky-AO instead (zero per-frame cost). A foliage-only prepass is worth it once cards land; a whole-scene prepass stays dead |
> | C6 ~150 m near-field bubble | **refuted as-implemented** | The bubble **does not exist** — buildings render to ~700 m (`tileManager.js:2909`). Correct as a *target*; per-instance LOD is the prerequisite the whole budget rests on |
> | C7 build trees in Blender | **corrected** | **The assets already exist, unused, in `public/textures/trees/`** — 8 card models + alpha atlas + an authored foliage normal map. Measure before opening Blender |
>
> Also dropped: **MeshStandard is out of v2 entirely.** v2 is Lambert + scene IBL + authored
> albedo/normal/AO — IBL works on the existing Lambert materials with no migration, and that one
> decision takes download 33.7 → 23.3 MB and night GPU from over-budget to under.

---

## 0. Non-negotiable constraints (Anmol, 2026-08-24) — READ BEFORE PROPOSING ANYTHING

**This stays a web browser game.** That is a product decision, not a technical default, and it is
the frame every item in this document sits inside. It is the product's best feature: someone clicks
a link and is driving Barcelona in seconds, no install, no store, no download bar.

Consequences that are therefore **binding on every v2 proposal**:

1. **No proposal may trade away zero-install browser delivery for fidelity.** If an idea only works
   as a native build, it does not belong in this plan — it belongs in the Unity repo (§9).
2. **The art library stays inside a ~30 MB budget** (§6d). Not "it compresses eventually" —
   budgeted, measured per asset, enforced.
3. **Everything atlases and instances.** The draw-call ceiling (~1000–2000) is a hard browser limit
   we are already 790 into. Variety is never bought with draws.
4. **Never 4K textures.** 1K tiling surfaces, 2K only for foliage atlases and hero facades.
5. **Desktop-first, but must not hard-break mobile.** Touch controls, compact HUD and the
   `max-height: 560px` layouts already shipped; a v2 quality tier should *scale down*, not exclude.
6. **Target is the near-field bubble** (§5), not uniform city-wide fidelity — that is what makes
   the whole thing fit.

**"It's a browser game" is the design constraint that makes v2 interesting, not the excuse for it
looking worse.** ETS2 runs on integrated graphics (§1); the look is authored, not brute-forced.
That is precisely why this target is reachable here.

---

## 1. What ETS2's look actually is, technically

Easy to misattribute, so be precise:

1. **Hand-authored modular assets.** Every building, tree, guardrail, sign is a modelled +
   UV-unwrapped + textured prop from an artist library. Roads are hand-built by level designers
   with a prefab/spline system — not generated from map data.
2. **Textured PBR-ish materials on everything** — albedo + normal + spec/gloss. Their asphalt has
   a normal map. Their facades are photo-derived with modelled window insets and cornices.
3. **Vegetation = cross-plane card models** with alpha-tested photo-scanned foliage atlases,
   billboard LOD, vertex wind. Not solid geometry.
4. Cascaded shadow maps, SSAO, HDR + eye adaptation, time-of-day + weather, wet-road reflections.

**The critical fact: ETS2 is not an expensive game.** It runs on integrated graphics. Its look is
an *art-authoring* achievement, not a horsepower one. That is the whole reason this target is
tractable in a browser when photoreal archviz is not.

## 2. v1 measured — the honest baseline

| | Ours today |
|---|---|
| Normal / roughness / metalness maps in the environment | **Zero.** Only exception is the car GLB (`carModel.js`) |
| Materials | 94 Lambert + 78 Basic + 37 Standard + 8 Phong + 1 Physical — **172 of 218 are diffuse-only, no specular response at all** |
| Trees | `CylinderGeometry(3 radial segments)` trunk + `IcosahedronGeometry(detail 0)` foliage = 20-tri solid blobs, ×~128k |
| Buildings | Extruded OSM footprints, flat roofs, **canvas-drawn window textures** (`CanvasTexture` from a 2D ctx in `meshMaterializer.js`) |
| Environment texture library | `grass.png`, a grass/bush GLB set, one tall-grass PNG. That is the entire library |
| Asset loading | Bare `GLTFLoader` (`loaders.js`) — **no KTX2, no Draco, no Meshopt** |
| Frame | ~790 draws, ~4M tris, ~1.14 GB heap, GPU-bound |

## 3. The finding: this is an asset gap, not a tech gap

Our **lighting and atmosphere are already the sophisticated part** — aerial-perspective fog
(patched `ShaderChunk`), baked sky-visibility AO (tile v9), ACES, warm-key/cool-shadow rig,
day/night preset system. That work is done and it is good.

**You cannot grade or light your way to ETS2 from here.** Their look lives in texels and modelled
detail we do not have. The distance between v1 and the target is roughly:

- **~70% art sourcing** — trees, facade material sets, road surfaces, street furniture.
- **~30% engineering** — PBR pipeline, KTX2, CSM, SSAO, instanced prop placement.

Every plan below follows from that ratio. **v2 is an art project with a rendering-tech component,
not the reverse.**

## 4. Browser ceilings — real vs imagined

**Fine in WebGL2, just work:** PBR materials, normal/roughness maps, KTX2/Basis compressed
textures, instancing (already used in 20+ files), cascaded shadow maps, alpha-tested foliage +
wind, scene-wide IBL (we already PMREM the car env), SMAA/TAA + sharpen.

**SSAO is NOT off the table** — despite the GTAO failure recorded in `rendering.md`. That failure
was structural: it bolted a full depth+normal prepass onto a *forward* pipeline drawing 4M tris.
A depth prepass that also provides early-Z rejection largely pays for itself. Re-attempting AO is
a pipeline redesign, not an impossibility. ⚠ Do not re-add it without doing the prepass properly —
the existing warning in `rendering.md` stands for the naive approach.

**Genuine hard ceilings:**

- **Download budget.** ETS2 is ~15 GB installed. Tiles are already 547 MB; dist is 577 MB. A new
  art library must fit in *tens* of MB. See §6 — with KTX2 this is far more comfortable than it sounds.
- **Heap / VRAM.** Already 1.14 GB; tabs get unstable past ~2–4 GB.
- **Draw calls.** WebGL2 per-draw overhead is much higher than native. ~1000–2000 is the practical
  60fps ceiling and we are at 790. **Variety can never be bought with draws** — everything atlases
  and instances or it does not ship.
- **Shader compile stalls** — already a known pain (materials are boot-warmed). A large PBR
  material library makes this worse and needs managed variant warm-up.

**WebGPU is the wildcard.** Shipping in Chrome/Edge desktop; Three.js has `WebGPURenderer`. Much
cheaper draw submission plus compute (GPU culling, GPU-driven vegetation). Worth a spike for a
desktop-first v2, but **not a prerequisite** — do not block v2 on it.

## 5. The structural constraint nobody can optimise away

**Our world is 1:1 real Barcelona from OSM. ETS2's is ~1:19 hand-curated.**

They get four buildings in view at 8k tris each because a designer chose exactly what is in that
frame. We stream a real Eixample grid at true scale, procedurally. The per-frame content budgets
are not comparable, and no amount of optimisation makes them comparable.

**Therefore v2 is explicitly NOT "ETS2 fidelity everywhere."** It is *ETS2 fidelity in a ~150 m
bubble around the car, degrading hard past it.* Which is exactly what the existing LOD + fog
architecture already does — the bones are right for this target.

### Verdict

**~65–75% of the ETS2 vibe is reachable on desktop browser.** What is not reachable is texel
density and prop variety across a whole 1:1 city — and that is a *download-budget* limit, not a
GPU one.

---

## 6. Asset strategy — free, and good

**Decision (Anmol, 2026-08-24): assets must be free. AI-generating our own is acceptable.**

The right answer is a **hybrid**, because AI is excellent at some of this and bad at other parts.
The governing rule: **do not AI-generate what already exists free as a real photoscan.**

### 6a. Source free (CC0) — all tiling surfaces

These are photoscanned, ship with true normal/roughness/AO maps, and beat anything a diffusion
model will produce for surfaces:

| Source | License | Use for |
|---|---|---|
| **Poly Haven** (polyhaven.com) | CC0, no attribution | Asphalt, concrete, plaster, brick, stone — full PBR map sets |
| **ambientCG** (ambientcg.com) | CC0 | Same, much larger catalogue |
| **Kenney** (kenney.nl) | CC0 | Low-poly props/vehicles — we already use these (`sedan.glb`, `adventurer.glb` are Kenney) |
| **Quaternius** | CC0 | Low-poly nature/props |
| **Poly Pizza** | CC0 / CC-BY | Street furniture |

**License hygiene (load-bearing — the site is deployed at drive.anmolbhardwaj.com):** prefer CC0
so no attribution is required. CC-BY is usable but needs a credits screen. **Never take NC
(non-commercial)** — a deployed site on a custom domain should not carry it. Record the source +
license of every asset in a manifest as it lands (see §6e).

### 6b. AI-generate — the Barcelona-specific things no free library has

This is where AI genuinely wins, because these do not exist as CC0 photoscans:

- **Eixample facade sheets** — orthographic building fronts with balconies, shutters, cornices.
  Very in-distribution for image models.
- **Panot tile pattern** (the Barcelona 20 cm flower-tile sidewalk) — we currently draw this
  procedurally at 0.2 m world-space UV; a real texture is a big upgrade.
- **Shopfront signage / awning fabric / shutter textures.**
- **Foliage cluster cutouts** (see §6c for the better alternative).

**Mac-friendly free toolchain:**
- **Draw Things** (free Mac app, Apple Silicon) or ComfyUI — and **enable tiling mode**. This
  matters: diffusion with tiling enabled produces genuinely seamless textures. Untiled AI output
  is not usable as a tiling surface and fixing it by hand is miserable.
- **Blender** (free) for geometry, baking, and normal derivation.
- **NormalMap-Online** (cpetry.github.io/NormalMap-Online) or **GIMP** for quick map derivation.

**⚠ The important caveat: AI does not generate true normal maps.** It generates albedo. Normals
get *derived* from albedo luminance, which is physically fake — it reads brightness as height.
For asphalt, plaster and brick at driving speed this is honestly fine. For anything with a strong
albedo pattern that is NOT height (painted lines, posters, signage) derived normals look wrong —
author those flat, or paint the height by hand.

### 6c. Trees — the highest-value item, and it deserves its own pipeline

You named trees specifically and they are correct to name: they are the single most
ETS2-defining change, and our 20-tri icosahedron blobs are the most obviously "web demo" thing in
the frame.

**Barcelona's street tree is the London plane** (*Platanus × acerifolia*) — mottled cream/olive
flaking bark, large maple-ish leaves, and in Barcelona **heavily pollarded**, giving knobbly
club-ended branches. That pollarded silhouette is extremely distinctive; getting one species
right buys most of the impact.

**Recommended free pipeline (all Blender, no AI needed for the best result):**
1. **Branch/trunk geometry** — Blender's built-in **Sapling Tree Gen** add-on (ships free) or the
   **Modular Tree** add-on. Tune to the pollarded plane silhouette.
2. **Foliage atlas** — model ONE high-detail leaf cluster, render it orthographically to a
   transparent PNG, and **bake its normal map from the high-poly cluster**. This is the pro
   workflow and it is fully free — and unlike AI it gives *correct* normals, which is exactly
   where derived-from-albedo falls down worst (foliage is all silhouette and depth).
3. **Assemble as cross-plane cards** — 2–3 crossed alpha-tested quads per branch cluster.
4. **LOD** — 3D cards near → single billboard far. **The billboard machinery already exists**
   (`vegetationRenderer.js` billboard path, `setTreeBillboardNightMode`), so this slots into
   existing LOD plumbing rather than needing new streaming work.

AI is the *fast path* for step 2 if the Blender bake proves slow, but the bake gives a better
result. Target 3–5 species: plane (dominant), palm (seafront/Barceloneta), orange tree
(courtyards/plazas), cypress, generic broadleaf.

### 6d. Texture budget — the encouraging maths

The download wall in §4 is much further away than the raw MB numbers suggest, **provided two
things are done**:

1. **KTX2/Basis supercompression** (ETC1S for most, UASTC for hero/foliage).
2. **ORM packing** — occlusion + roughness + metalness packed into one RGB texture, the standard
   glTF convention. Halves the map count.

Rough figures: a 1K ETC1S map transmits at ~100–200 KB. A material = albedo + normal + ORM ≈
**~450 KB at 1K**.

| Item | Count | Budget |
|---|---|---|
| Tiling surface materials (asphalt, panot, masonry, render, brick, glass, …) | ~20 @ 1K | ~9 MB |
| Foliage atlases (albedo + normal) | 4 species @ 2K | ~4 MB |
| Facade sheets | ~8 @ 2K | ~8 MB |
| Props / street furniture | — | ~5 MB |
| **Total added art library** | | **~25–30 MB** |

VRAM for that set is ~15–20 MB. **Both are comfortable.** The binding constraint therefore returns
to **draw calls, triangles, and 1:1 city scale** — not download size.

**Resolution discipline:** 1K for tiling surfaces (they tile, so effective texel density is high),
2K only for foliage atlases and hero facades, **never 4K in a browser.**

### 6e. Asset manifest (do this from asset #1, not later)

Every asset lands with a row in a manifest: `name, source, license, author, date, where used`.
CC0 needs no attribution but we still need to *prove* provenance, and AI-generated assets should
record the tool + prompt so the set can be regenerated consistently later.

---

## 7. The v2 roadmap

Ordered by impact-per-effort. Each tier is independently shippable and screenshot-verifiable, per
the house convention in `visual-refinement-plan.md`.

### Tier 0 — Pipeline prerequisites *(nothing looks better yet; everything depends on these)*
1. **KTX2/Basis + Meshopt in `loaders.js`** (currently a bare `GLTFLoader`). This is what makes a
   texture budget possible at all. Small, contained change.
2. **Shared PBR material library** keyed by surface class (asphalt, panot, masonry, render, brick,
   glass, foliage), atlased, boot-warmed alongside the existing `warmAllBuildingMaterials`.
3. **Migrate the environment off Lambert/Basic** onto that library. This is where "cleaner and more
   refined" actually comes from — real specular response on wet asphalt and glass.
   ⚠ Watch the draw-call ceiling: consolidate materials as they convert, do not add variants.

### Tier 1 — The big visible jumps
4. **Trees** (§6c). The single most ETS2-defining change.
5. **Road surface materials** — normal-mapped asphalt, detail tiling, edge wear, wet variant.
   Roads are ~40% of every frame in a driving game and ours are flat colour.
6. **Facade texture sets** — keep the procedural extrusion (it is how we get a real city) but skin
   it with authored Eixample material sets instead of canvas-drawn windows.
   ⚠ Buildings are **worker-generated** — the real path is `workers/buildingWorker.js` +
   `workers/meshMaterializer.js`, NOT `map/buildingRenderer.js`. See project memory; this has cost
   a full session of confusion before.

### Tier 2 — Lighting/pipeline catch-up
7. **Cascaded shadow maps.** A single 1024 map with an ±85 m frustum is the thing that most reads
   "web demo" in comparison shots.
8. **Depth-prepass + SSAO**, with early-Z paying for the prepass (§4).
9. **Scene-wide IBL env map** — we already PMREM the car env, extending it is cheap.
10. **SMAA/TAA-lite + sharpen** on top of the existing adaptive resolution.

### Tier 3 — Density and life
11. Street furniture prop library, real roof forms, rooftop clutter.
12. Wet-road / weather variant — half of ETS2's charm is its rain look.

---

## 8. Go/no-go: the one-block vertical slice

**Do this before committing to any of the above.**

Pick a single Eixample block. Wire KTX2. Source ~6 assets (2 plane-tree variants, 1 asphalt
material set, 2 facade sets, 1 street-furniture set). Convert that block to PBR. Then measure:

- FPS (day **and night** — night is the benchmark per project doctrine, day is a subset)
- Draw calls, triangles, heap
- **Total MB downloaded** for the art library
- Shader compile stalls at first entry

**One week.** It replaces every estimate in this document with real numbers. If the block holds
60 fps at a sane texture budget, v2 is real and the work becomes scaling the asset library. If it
does not, the cost was a week rather than a quarter.

## 9. Relationship to the Unity port

A 2026-07-12 decision recorded a Unity 6 / URP port in a separate repo
(`~/Desktop/barcelona-drive-unity`) for exactly this reason — "better visuals than the browser
ceiling allows."

Honest comparison:

- **Browser v2** → ~70% of the ETS2 look, and keeps the click-a-link-and-drive distribution, which
  is genuinely the product's best feature. Reuses the bake pipeline, streaming, Rapier physics.
- **Unity** → ~90–95%, but the runtime is rebuilt and the distribution advantage is lost.

**The tiebreaker: the asset library is the expensive part, and it is engine-portable.** Trees,
facade textures and road materials authored as glTF/PNG work in both. So browser v2 is not a
detour from Unity — it front-loads the transferable 70% of the work and answers empirically
whether the browser ceiling actually binds, before giving up zero-install distribution.

**Current standing (2026-08-24): the browser is the target.** Per §0 this is settled for v2, and
the Unity repo is not the fallback plan for any item in this document. Author every v2 asset in
portable formats (glTF + PNG/KTX2, no engine-specific material graphs) so the library transfers
for free if that decision is ever revisited — but do not design v2 around that possibility.
