<!-- ART DIRECTION JUDGE output, v3 multi-agent run 2026-08-24. Reproduced in full inside
     v3-master-plan.md §2 — this is the unabridged source. -->

## THE v3 ART BIBLE
**Binding on all 12 domains. Where a domain audit's art choice conflicts with this document, this wins. Where it conflicts on engineering, the domain audit wins.**

---

# 1. THE LOOK STATEMENT

> **Barcelona at 35° golden hour and under sodium light, built as honest 2015-era simulation art: one tiling albedo + one tiling normal on every surface, a warm-masonry palette that never goes vivid, texel density measured in real metres, and wear painted into the albedo rather than simulated.**

### It is explicitly NOT — five bans, each with the failure it prevents

| # | NOT | The failure it prevents | Hard test |
|---|---|---|---|
| **N-1** | **NOT photoreal / photoscan-fidelity.** No world surface above 1024². No parallax/POM, no SSR, no GI, no screen-space terrain AO, no virtual texturing. 2048² exists only for: sign atlas, tree atlas, vehicle atlas, cloud atlas, roof atlas, dynamic text page — six pages, no more. | Chasing fidelity the user said he does not want, stealing budget from coverage. `ets2-target-audit` §0, `v3-brief.md:19-23` | Any map >1024² requires a named exemption from this list. |
| **N-2** | **NOT flat-shaded low-poly / palette-UV "Kenney" art.** No untextured primitive geometry in the shipped world. No 59-unique-UV palette atlases. | The toy-vs-world clash of §2. `vehicles.md:34-81` | Zero shipped meshes whose UV set collapses to <32 distinct texels. |
| **N-3** | **NOT vivid or saturated.** `colorGradePass.js:49` multiplies saturation ×1.15 default and ×1.52 in rally mode. **Rally is a MODE, not the art target.** The library is authored for ×1.15 and must survive ×1.52 without going fire-red. | Three recorded overshoots already in `buildingWorker.js:363-366` ("saturated bases go fire-red"), `vegetationRenderer.js:62-70` (three re-grades), `vegetationWorker.js:1616-1623`. | Step 6 of the normalize pipeline (§4). |
| **N-4** | **NOT stylized-illustrative.** No cel shading, no gradient-mapped stylisation, no painted outlines, no hand-painted fake AO strokes in corners, no toon ramps. | Fake AO in an albedo fights the v9 baked sky-visibility grid, which is real and directional. | De-light step (§4 Step 2) is mandatory and non-optional. |
| **N-5** | **NOT a kitbash of visibly different source fidelities.** No asset ships at its source's native grade. Every asset passes normalize, no exceptions, including "it already looked fine." | The exact failure this bible exists to prevent: invisible until ~100 assets, unrecoverable after. | The contact sheet (§7 gate 1). |
| **N-6** | *(bonus, non-negotiable)* **NOT a Delhi holdover.** | `streetlightRenderer.js:96,124,626-628` still renders **Indian tricolour bridge poles at night** in Barcelona. Delete. Also `ENABLE_DELHI_DETAILS` (buildingWorker.js:97) stays false forever. | grep for `tricolor`, `BRIDGE_NIGHT_COLORS`, `shikhara` returns zero hits in shipped paths. |

---

# 2. THE PHOTOSCAN-vs-STYLIZED FAULT LINE — RULED

## RULE AD-1 (binding, no hedge)

> **TEXTURED-REALIST, NORMALIZED, SPECULAR-GLOSS ERA.
> Photoscan is a permitted SOURCE and a forbidden SHIPMENT.
> Flat-palette-UV geometry is banned from the shipped world entirely.**

### Why this direction and not the other

The Kenney fleet is 2,032–2,476 tris with **59 unique UVs snapped to a 1/32 palette grid** on a **3,110-byte** 512² WebP, `metallicFactor 0` (`vehicles.md:34-81`). The tempting reading is "keep the world stylized so the cars fit." That is wrong on the brief's own test — *which produces the better end result* — for three measured reasons:

1. **The cars are already ruled REBUILD and DELETED.** `vehicles.md:176`: `DELETE frontend/public/models/cars/*.glb (9 Kenney GLBs, 1.72 MB — palette UVs, unfixable)`, plus `Textures/colormap.png` (already dead), `adventurer.glb`, `punk.glb`. The mismatch is not a standing constraint — it is a **temporary window** during Tier 0→2.
2. **Stylizing the world downward fails the brief's floor.** `v3-brief.md:25-27` — "normal-mapped surfaces, textured props, card foliage, legible signage." A palette-UV world has no normal map by construction. Lowering the world to meet the cars puts us *below* the ETS2 floor to preserve 1.72 MB of assets we are deleting. That is textbook sunk-cost, banned by `v3-brief.md:59`.
3. **The fault line is a false binary anyway.** ETS2 is neither. Prism3D pre-2019 is **specular-gloss with a greyscale spec mask packed into albedo alpha, and no roughness map, no AO map, no parallax** (`pipeline-materials.md:26`). Its asphalt is not photoscanned — it is a hand-graded 512–1024 tiling diffuse+normal. **That is the exact midpoint we are aiming at, and it is a real named target, not a compromise.**

### The three enforcement clauses

- **AD-1a — SOURCE vs SHIPMENT.** ambientCG / Poly Haven photoscans are the *preferred* base for asphalt, concrete, gravel, rock, metal, tyre rubber — they are the only free sources that ship **true normal maps** rather than luminance-derived fakes. But **no photoscan ships at its native grade.** It enters through §4 Steps 2→6 (de-light k=0.85, Lab rescale, normal calibration, palette snap, pre-grade divide). A photoscan that survives normalize is a stylized-PBR texture with correct micro-detail. A photoscan that does not is rejected, not shipped "because it looked good in isolation."
- **AD-1b — PALETTE-UV BAN.** Any mesh whose UV set collapses to fewer than 32 distinct texels is banned from the shipped world. This kills the Kenney fleet, the Kenney colormap, and pre-empts the same trap in Quaternius/Poly Pizza props (both ship palette-atlas variants — check before use, retopo/re-UV or reject).
- **AD-1c — THE MISMATCH WINDOW IS A SEQUENCING CONSTRAINT, NOT AN ART CONSTRAINT.** See **SEQ-1** below. Art direction does not bend to cover a scheduling gap.

### SEQ-1 (hand to the synthesis step — this is a real dependency, not a note)

The window between *"normalized asphalt ships"* and *"vehicle kit Tier 0 ships"* is a visible-mismatch window. It is the single most likely place the project ships something that looks worse than today. Three options, ranked:

| | Option | Cost | Verdict |
|---|---|---|---|
| **A** | Vehicle kit Tier 0 (6 bodies at LOD1 + shared 2048² atlas + 1024² normal) lands in the **same tier** as the first normalized ground material. | Front-loads ~8–10 of vehicles' 40.75 days. | **PREFERRED.** |
| **B** | Traffic + parked cars are **disabled** (`ENABLE_TRAFFIC=false`) from the first textured ground material until the kit lands. | 0 days. Costs a populated street for one tier. | **ACCEPTABLE FALLBACK.** |
| **C** | Keep Kenney visible but cull to >60 m so only the silhouette reads. | ~0.5 day. | **REJECTED** — at 60 m in a 500 m-visible city they are still the nearest moving objects and the palette flatness reads at any distance under headlights. |

Pick A or B. Not C.

---

# 3. TEXTURE SPECIFICATION

## 3.1 The map set — closed list

**ETS2 pre-2019 is specular-gloss, not metal-rough** (`pipeline-materials.md:26`). Mirror it. Six map types exist in this library and no seventh may be added without amending this document:

| Map | Channels | Transfer | Compression | Who gets it |
|---|---|---|---|---|
| **ALBEDO** | RGB (+A where cutout) | **sRGB** | ETC1S q128 (opaque) / q192 (alpha or high-contrast) | Everything. |
| **NORMAL** | RGB tangent-space | **LINEAR** | ETC1S q192 (grain) / **UASTC** (shape) — see 3.4 | Surfaces where N·L modulation reads: asphalt, kerb, panot, cobble, brick, plaster, roof, coping, terrain layers, guardrail, foliage, vehicle panels, fabric, droplets. **NOT** flat printed surfaces. |
| **MASK (R8)** | single channel | **LINEAR** | ETC1S q192, **never channel-packed** | Paint wear, puddle mask, macro grunge, emissive mask, window light mask, headlight cookie. |
| **ORM** | R=AO G=rough B=metal | **LINEAR** | ETC1S q128 | **Vehicles only** (`vehicles.md:165`). The world does not get ORM — it gets Lambert + a per-material roughness *uniform*. |
| **EMISSIVE MASK** | R8, shared page | **LINEAR** | ETC1S q192 | One city-wide 1024² R8 page. Per-instance scalar × mask. Never a per-asset emissive texture. |
| **IMPOSTOR** | RGBA (albedo+alpha) | **sRGB** | ETC1S q192 | Tree LOD2 only, rendered offline from LOD0. |

**Explicitly absent, and this is deliberate:** no roughness *map* on world surfaces, no per-texture AO map (the v9 baked sky-AO grid is the AO), no height map, no parallax, no metalness map outside vehicles, no separate specular map (spec is a greyscale mask in albedo alpha where needed, ETS2's own trick).

## 3.2 Resolution by surface class — the ceiling table

| Class | Ceiling | Rationale |
|---|---|---|
| Road / sidewalk / cobble / kerb tiling | **1024²** albedo+normal; **512²** detail normal | `road-surface.md:141-147` |
| Facade sheet layers (array texture, 8 layers) | **1024²** albedo + **1024²** normal + **512²** window mask | `buildings-facade.md:109` |
| Roof atlas | **2048²** (3× 1024 cells) | `buildings-detail.md:120` |
| Terrain ground array (4 layers) | **1024²** per layer, albedo+normal | `terrain-coast.md:58` |
| Foliage atlas | **2048×1024** albedo(RGBA)+normal; cells 512² | `vegetation.md:21,78` |
| Sign atlas | **2048²** albedo+alpha, **NO NORMAL** (deliberate — a 0.7 m flat printed disc gains nothing) | `signage.md:24,83` |
| Dynamic text page | **2048×1024 R8** | `signage.md:72` |
| Vehicle shared atlas | **2048²** albedo, **1024²** normal, **1024²** ORM | `vehicles.md:163-165` |
| Hero car | albedo **1024²**, normal **2048²** (the one 2K normal in the project), ORM **1024²** | `vehicles.md:170` — see budget guard 3.4 |
| Road furniture / props / rooftop / terrace | **1024²** albedo+normal per material family (metal / concrete / plastic) | `road-furniture.md:14`, `buildings-detail.md:120` |
| Water | **2× 512²** normal only | `water.md:15-24` |
| Sky / clouds | **2048×1024** RGBA, albedo+alpha only | `sky-atmosphere.md:113` |
| Fabric (toldo), foam, kerb, grate, cookie, corona | **512²** or below | |

**Nothing is 4096. Nothing.** Six 2048² pages exist total (roof, foliage, signs, text, vehicle, cloud). A seventh requires an amendment.

## 3.3 VRAM arithmetic — the formula every domain prices with

```
resident MiB = W × H × (bpp / 8) × 1.333 / 1048576      // ×1.333 is the mip chain
```

| Format path | bpp | 512² | 1024² | 2048² | 2048×1024 |
|---|---|---|---|---|---|
| ETC1S opaque → **BC1 / ETC1** | 4 | 0.171 | **0.683** | 2.73 | 1.37 |
| ETC1S+alpha → **RGBA_ETC2_EAC / BC7** | 8 | 0.341 | **1.365** | 5.46 | 2.73 |
| UASTC → **BC7 / ASTC** | 8 | 0.341 | **1.365** | 5.46 | 2.73 |
| **Uncompressed RGBA8 (BANNED)** | 32 | 1.365 | 5.46 | 21.8 | 10.9 |

**BLOCKER for every number above:** three r183 ranks BC7 **above** BC1 for ETC1S (`KTX2Loader.js:786-805` — bptc `priorityETC1S:3` vs dxt `priorityETC1S:4`). Without the FORMAT_OPTIONS patch, **every opaque ETC1S map doubles on Windows**: road-surface 8.19→16.4 MiB, terrain 6.72→13.4 MiB, buildings 28→46 MiB. This patch is a **P0 blocker for the entire library**, cited independently by 7 of 12 audits.

**HARD BAN — no exceptions, no waivers:** `new THREE.CanvasTexture` for any world-render surface. Today there are **48 sites across 22 files** (`pipeline-materials.md` F8) and the night-window atlas alone is **55.9–85.3 MiB resident** (F9). Buildings returning 58.6 MiB is what pays for everyone else's textures (`buildings-facade.md:52`). Canvas is permitted **only** for: the dynamic street-name text page (LRU, sub-region upload, `signage.md:72`), the sky TOD LUT (256×8, generated at boot), procedural moon/stars (`sky-atmosphere.md:121`), and HUD DOM. That is the whole exemption list.

## 3.4 Compression — the grain-vs-shape rule

> **RULE AD-2: If the normal map's detail is GRAIN, use ETC1S q192. If it is SHAPE, use UASTC.**

ETC1S shares chroma endpoints per 4×4 block. On a normal map the chroma *is* the XY of the normal. Where the map is high-frequency isotropic noise, the block error reads as more grain and is invisible. Where the map carries a coherent directional feature, the block error reads as a wrong shape and is fatal.

| GRAIN → **ETC1S q192** | SHAPE → **UASTC** |
|---|---|
| asphalt, plaster, terrain grass/dirt/gravel/sand, roof surface, foliage leaf cards, fabric weave, tyre rubber, rock | guardrail W-profile corrugation, kerb chamfer, roof coping band, drain grate, brick mortar courses, panot flower relief, windshield droplets, vehicle panel shutlines, hero car |

**Budget guard AD-2a:** UASTC is ~3.3× ETC1S transmission (measured, `vegetation.md:109`: 2048×512 albedo — ETC1S q192 **252.3 KB**, UASTC-RDO **836.0 KB`). **Total UASTC across the whole library ≤ 4.0 MB of the 24 MB.** The hero car's 2048² UASTC normal alone is ~3.2 MB at default RDO — it must ship at **RDO λ≥1.0 targeting ≤1.6 MB, or drop to 1024²**. Flagging: this is the single line most likely to blow the download cap.

**Measured transmission reference rates** (use these, do not re-estimate): 1K albedo ETC1S q128 **159 KB**; 1K normal ETC1S q128 **179 KB**; 2048×512 RGBA albedo q192 **252.3 KB**; 2048×512 normal q192 **282.8 KB**; conifer albedo q128 95.5 KB. Basis transcoder over the wire: **217 KB brotli, not 584 KB** (`pipeline-materials.md` F10).

## 3.5 THE sRGB-vs-LINEAR RULE

> **RULE AD-3: albedo, emissive and impostor pages carry the sRGB transfer function in the KTX2 DFD. Normal, ORM, mask, and every single-channel map carry LINEAR. The encode script ASSERTS this per asset and exits non-zero on mismatch.**

**This is the #1 silent-failure mode in the whole pipeline.** three reads the transfer function straight off the KTX2 DFD (`KTX2Loader.js:1232`) and **`verifyColorSpace` early-returns for compressed textures** — there is no warning, no console error, nothing. An sRGB-flagged normal map on the largest surface in the scene (asphalt) will look "subtly, unfixably wrong" forever (`road-surface.md:154`, `terrain-coast.md:136`, `signage.md:109` — three independent audits flagged the same trap).

Enforcement: the manifest carries `transfer: "srgb" | "linear"` per map, the encode script sets it from the manifest and **re-reads the written DFD to verify**, and CI fails the build on any mismatch. Never let the author set it at the call site.

## 3.6 THE V-FLIP RULE

**The mechanism:** WebGL ignores `UNPACK_FLIP_Y_WEBGL` for compressed uploads. `KTX2Loader` therefore yields `flipY = false`. Every UV set in this project that was authored against a `flipY = true` `CanvasTexture` will render **upside down** the moment it is fed a `.ktx2` — and it fails **silently**, because a 4-fold-symmetric pattern like panot looks fine while an asymmetric one (kerb chamfer, coping, brick courses, a sign) is wrong forever.

> **RULE AD-4: ONE convention, library-wide — glTF convention. `flipY = false`, first image row = TOP of the surface. Every consumer is patched to that convention. Textures are NEVER pre-flipped at encode time to accommodate an old UV set.**

Rationale for a single rule rather than a split: glTF-embedded KTX2 (vehicle, prop, foliage GLBs) **must** be top-down. A split rule ("world surfaces bottom-up, models top-down") guarantees that some domain gets it backwards, and the failure is silent.

**Known offenders to fix at the UV, one line each:**
- `roadRenderer.js:1690-1694` — panot UVs authored against a flipY canvas.
- Baked sidewalk UVs (v8 tile format) — same origin.
- Any of the 48 CanvasTexture sites converted to KTX2.

**Enforcement — the orientation test card:** every atlas page carries an **asymmetric glyph (`⌐`) in the top-left 32×32 texel block**, and a debug key renders every library page as a flat quad. A flipped page is then a one-glance catch instead of a six-week-later discovery. Mandatory on every 2048² page.

## 3.7 Normal-strength calibration

> **RULE AD-5: The normal map is authored so that `normalScale = 1.0` is correct. The runtime `normalScale` knob is reserved for LOD fade, never for taste.**

Calibrate at encode by measuring mean `|N.xy|` over the map and rescaling XY (then renormalising Z) into the class band:

| Surface class | mean \|N.xy\| band | ≈ mean slope |
|---|---|---|
| asphalt, plaster, terrain grass/dirt, roof surface | **0.10 – 0.22** | 6°–13° |
| kerb, coping, panot, brick, cobble, concrete barrier | **0.18 – 0.32** | 10°–19° |
| metal (guardrail, posts), fabric, props, vehicle panels | **0.15 – 0.30** | 9°–17° |
| foliage cards, windshield droplets | **0.20 – 0.35** | 12°–20° |

Out of band = fail, rescale, re-encode. This one rule is what prevents "every domain dials its own normal until its surface pops," which is the classic route to a scene where nothing recedes.

## 3.8 Two shared assets that are mandatory library-wide

**AD-6 — THE ONE GRUNGE TEXTURE.** ETS2's highest-leverage single trick: one low-frequency detail/grunge texture multiplied over every tiling surface at a second, much larger UV scale, breaking the repeat city-wide for **one 512² single-channel texture** (`pipeline-materials.md:26`).

> **Every tiling world material with a base repeat ≥ 2 m MUST sample the shared `grunge_macro_512` R8 at a class-specific macro scale of ≥ 16× the base repeat, multiplied into albedo.** Cost: **0.35 MiB VRAM, ~45 KB download, one texture fetch.** This is the best MiB-per-quality line in the entire library and no domain authors its own.

**AD-7 — ANISOTROPY IS A CENTRAL POLICY, NOT A CALL SITE.** Today anisotropy is set on **3 textures out of ~48** (`terrainRenderer.js:31`=4, `roadInfraRenderer.js:700`=4, `roadRenderer.js:196,209`=max); `setRendererAnisotropy` reaches **exactly one texture** (panot). The other ~45 sample at 1 — the reason tilted tiling surfaces read mushy at speed.

> **The material registry sets anisotropy for every texture it hands out. No renderer sets it at a call site.** Policy: tiling world surfaces `min(8, maxAnisotropy)`; foliage/sign/prop atlases `4`; UI/sky `1`. **Mips mandatory on every texture except the dynamic text page's sub-regions.** Unmipped foliage is the classic shimmer failure (`vegetation.md:21`).

---

# 4. THE BARCELONA PALETTE

## 4.1 The ten world anchors

Derived from the palettes already tuned in-code against real Barcelona aerials — these were arrived at over three grading passes and are *correct*; the failure is that they are colours on untextured geometry, not that they are wrong colours.

| # | Name | Hex | Governs | Provenance |
|---|---|---|---|---|
| **P1** | **Eixample Cream** | `#E7DECB` | Residential / office / school / hospital facade plaster. **The dominant value of the city.** | `buildingWorker.js:68` |
| **P2** | **Ochre Sand** | `#D3C5A8` | Facade mid-tone, commercial plaster, sandstone church, stucco | `buildingWorker.js:69,79,86` |
| **P3** | **Modernisme Rose** | `#C89A78` | Warm facade accent, terracotta render — **sparse, ~1 in 8 buildings** | `buildingWorker.js:71,86` |
| **P4** | **Teula Clay** | `#A76A5C` | Roof tile. **The aerial signature of Barcelona.** | `buildingWorker.js:367` |
| **P5** | **Poblenou Brick** | `#9E5A3E` | Industrial brick, chimney stacks, warehouse | `buildingWorker.js:81` |
| **P6** | **Panot Grey** | `#B4B0A6` | Sidewalk paving, precast concrete, parapet coping, roof terrat | *new — no code anchor exists; sidewalks are currently untextured* |
| **P7** | **Bordillo Granite** | `#7C7A76` | Kerb face, bollards, stone plinths, sea walls, guardrail post concrete | *new — replaces the flat `0x5a5a5a` at `roadRenderer.js:219-228`* |
| **P8** | **Carriageway Grey** | `#4F4E4C` | Asphalt, tarmac, sett grout, tyre rubber | *new — replaces the per-vertex sine `roadNoise` at `roadRenderer.js:317`* |
| **P9** | **Platanus Green** | `#6E7A55` | Foliage, verge grass, park ground. **Dusty olive — never emerald, never lime.** | *new — replaces `vegetationRenderer.js:62-70`* |
| **P10** | **Mediterrani Blue** | `#2F5C77` | Deep sea, water body base, distant haze anchor | *new — sits between day fog `0xc4dcea` (`envToggle.js:37`) and night bg `0x0a1224` (`:64`)* |

## 4.2 The six night emissives — a CLOSED set

Night is a warm-vs-cool contrast problem (`colorGradePass.js:60`). Emissive hue variety destroys it faster than anything else.

| # | Name | Hex | Use | Provenance |
|---|---|---|---|---|
| **N1** | Sodium Amber | `#F0B95A` | Street lamps | `streetlightRenderer.js:204` (`0xff8800`, lightened) |
| **N2** | Warm LED | `#FFE9C4` | Modern lamps, headlights, vehicle DRL | `carModel.js:279` (`0xFFF0CC`), `:265` |
| **N3** | Window Warm | `#FFDFA8` | Lit residential/office windows | replaces the night canvas atlases |
| **N4** | Farmàcia Green | `#35C878` | The pharmacy cross — the single most recognisable Barcelona night sign | `signage.md:88` |
| **N5** | Signal Red | `#E2413A` | Tail lights, traffic signals, metro roundel | `carModel.js:242,366` |
| **N6** | Cool Sign | `#6FB4E8` | Backlit commercial boxes, parking blue, hospital | `signage.md:88` |

**Nothing else in the world emits.** A seventh emissive requires amending this document.

## 4.3 The UI reservation

`theme.js` is already a correct token system (`hud-progression.md:3`). Its accents are **reserved**:

> **RULE AD-8: `coral #d76a4f`, `sky #7ea6b0`, `sage #8fa77e` (`theme.js:39,41,42`) are UI-ONLY and must never appear as a world albedo anchor.** This reservation is what keeps the HUD legible over the world without a scrim. World greens go to P9 Platanus (olive), not sage. World warm accents go to P3/P4 (rose/clay), not coral.

## 4.4 THE NORMALIZATION PROCEDURE — mandatory, eight steps, scripted

Implemented once as `scripts/build-art.mjs` (committed artefact, **never run on Cloudflare Pages** — ~10 min for a full library rebuild). No domain runs its own version.

**STEP 0 — INGEST.** Record `{name, surfaceClass, source, license, url, sha256, srcRes, shipsTrueNormals, normalSource, aiModel, aiModelLicense}`. Build **fails hard** on a missing or non-CC0 licence field.

**STEP 1 — TILE VERIFY** *(tiling maps only)*. Offset 50% in both axes; the max local gradient at the seam must be ≤ 1.5× the image median gradient. AI output fails this constantly when tiling mode was off. Fail = fix or reject, never ship.

**STEP 2 — DE-LIGHT.** In Lab: `L' = L − k·(GaussianBlur(L, σ=W/8) − mean)`, clamp [0,100].
`k` = **0.85** photoscan · **0.35** AI-generated · **1.00** Blender-baked-with-AO · **0.00** flat-authored.
*Rationale — this is the step most likely to be skipped and it is the one that matters most:* the game supplies its **own** occlusion from the **v9 baked sky-visibility AO grid** (`aoSampler.js`). A photoscan's baked AO is a different occlusion from a different geometry. Ship it and every surface double-darkens in crevices that do not correspond to our geometry, and fights a directional grid that is correct. **`terrain-coast.md:114` records that the existing slope-scaled AO hack was itself a workaround for exactly this class of mismatch.**

**STEP 3 — Lab L*/C* RESCALE** to the surface-class target: `L'' = μ_t + (L' − μ_s)·(σ_t/σ_s)`, same for C*.

| Surface class | L* mean | L* σ | C* mean | ← these are **pre-grade** targets |
|---|---|---|---|---|
| Asphalt / carriageway | 38 | 8 | 4 |
| Sidewalk panot / concrete | 62 | 9 | 6 |
| Kerb / granite / stone | 51 | 10 | 5 |
| Facade plaster / render | 74 | 10 | 14 |
| Brick | 45 | 11 | 26 |
| Roof clay | 48 | 10 | 28 |
| Roof terrat / gravel | 58 | 9 | 8 |
| Terrain grass / verge | 47 | 12 | 20 |
| Terrain dirt / sand | 63 | 10 | 18 |
| Rock / cliff | 55 | 13 | 8 |
| Metal (guardrail, posts) | 58 | 14 | 3 |
| Foliage leaf | 45 | 13 | 24 |
| Bark | 42 | 12 | 12 |
| Fabric (toldo) | 60 | 15 | 30 |
| Water base | 36 | 7 | 16 |
| **Signage, regulatory plates, emissive, vehicle paint** | **EXEMPT** | | | *legal / product colours must stay exact* |

**STEP 4 — NORMAL CALIBRATION.** §3.7 bands. Rescale XY, renormalise Z, assert.

**STEP 5 — PALETTE SNAP.** In Lab, rotate hue toward the nearest allowed anchor(s) for the class by α:
**α = 0.60** large continuous surfaces (road, sidewalk, facade, terrain, roof) · **0.35** props, furniture, foliage, fabric · **0.00** signage, regulatory, emissive, vehicle paint.
Then assert: **mean colour within ΔE2000 ≤ 15 of at least one §4.1 anchor** (exempt classes excluded). *Flagged as tunable after the first 10 assets — if variety collapses, raise to 18; if a kitbash appears, drop to 12. Set it once, on evidence, and then freeze it.*

**STEP 6 — PRE-GRADE COMPENSATION.** Divide final C* by **1.15** — the shipping `colorGradePass` saturation at `uRally=0` (`colorGradePass.js:49`, `satAmt = mix(1.15, 1.52, uRally)`). Also verify against the rally path: re-render at ×1.52 + the S-curve (`:53`) and assert no channel clips. **Never author against the rally path.**
*This is the step whose absence caused every recorded overshoot: `buildingWorker.js:363-366` ("the rally grade multiplies saturation ×1.52 … saturated bases go fire-red"), three vegetation re-grades, a night ×1.55 restore, and a billboard tint "annotated as having overshot twice."*

**STEP 7 — ENCODE.** Format per §3.4. Mips always. Transfer per §3.5, **written then re-read and verified**. `flipY=false` per §3.6. Orientation glyph on every 2048² page.

**STEP 8 — MANIFEST + CONTACT SHEET.** Append to `art-manifest.json`; regenerate `art-contact-sheet.png` — every library asset rendered at identical fixed lighting on identical geometry, labelled. **This sheet is the kitbash detector and no automated check substitutes for it.** A human eye scanning one sheet catches a mismatched grade in two seconds; nothing else in this pipeline does.

## 4.5 Licensing — the manifest is a gate, not documentation

**BANLIST — build fails on any of these:** CraftPix (all tiers — "free" forbids redistribution and a public web build redistributes verbatim); any NC licence; "free for personal use"; Sketchfab non-CC0; TurboSquid free; Unity/Unreal marketplace free tiers; any real trademark, logo, brand livery, or real vehicle registration format that identifies a real plate.

**Live violations to remediate before the library grows** (this is not hypothetical — it is already in the repo):
- `frontend/public/models/vegetation/*` + `frontend/public/textures/trees/*` — sourced from `craftpix-781618-free-tree-3d-low-poly-pack` and `craftpix-561109-free-bush-3d-low-poly-models` (`convert.py:18-19`). **The 2.9 MB of "unused assets already on disk" the brief cites as a free win is CraftPix-licensed and cannot ship.** `vegetation.md:64`, `VEG-5`. It is also the wrong biome (`T_Trees_temp_climate.png`; object names `01_ash, 03_birch, 04_beech, 07_larch` — northern temperate, zero palms, against a real OSM census of **Tipuana tipu 691, Platanus × hispanica 624, Arecaceae 316**).
- `frontend/public/textures/new textures/craftpix-*` — now empty but for `.DS_Store`; delete the directories.

**AI-generation clause:** the manifest records `aiModel` + `aiModelLicense`. Only models whose licence permits commercial use **and imposes no downstream restriction on outputs**. Draw Things running SD1.5 (CreativeML OpenRAIL-M) or SDXL qualifies; record which. *This is an edge every domain will otherwise skip.*

**AI normal clause (AD-9):** AI produces **albedo only**; a luminance-derived normal is physically fake. Derivation is permitted **only** where albedo and height genuinely correlate — plaster stipple, grime, gravel, grain, fabric weave, asphalt aggregate. It is **forbidden** where they decorrelate: printed lettering, painted signage, flat coloured tile, droplets, corrugated metal, mortar joints on painted render. Those come from **Blender bakes** or **ambientCG** (which ships true normals). Enforced by `normalSource: "baked"|"ambientcg"|"derived"` with `derived` whitelisted per surface class.

---

# 5. SCALE DISCIPLINE — real metres per repeat

> **RULE AD-10: Every world texture UV is WORLD-METRIC. A 20 m carriageway gets 5 repeats across; a 6 m street gets 1.5. A normalised 0..1 stretch on a world surface is a build failure.**

The infrastructure already exists: `roadBaker.js:400-401` bakes world-metric arclength U **and per-vertex `halfWidth`** — correct world-metric asphalt UVs at any carriageway width are recoverable **in the vertex shader with no re-bake and no geometry change** (`road-surface.md:3-9`).

| Surface | Map | Covers (real m) | **texels/m** | Repeat visible at |
|---|---|---|---|---|
| Asphalt base | 1024² | 4.0 × 4.0 | 256 | 4 m |
| Asphalt **detail normal** | 512² | 0.5 × 0.5 | 1024 | 0.5 m (8× base — kills the near repeat) |
| Panot sidewalk | 1024² | 4.0 × 4.0 (20×20 units of 0.20 m) | 256 | 4 m |
| Cobble / sett | 1024² | 2.0 × 2.0 | 512 | 2 m |
| Kerb strip | 512×128 | 2.0 along × 0.5 tall | 256 | 2 m |
| **Facade sheet layer** | 1024² | **8.0 × 8.0 = 2 storeys of 4.0 m** | **128** | 8 m |
| Shopfront strip | 1024×512 | 8.0 × 4.0 | 128 | 8 m |
| Crown / cornice strip | 1024×256 | 8.0 × 2.0 | 128 | 8 m |
| Roof surface (atlas cell) | 1024 cell | 8.0 × 8.0 | 128 | 8 m |
| Roof coping band | 1024×256 | 8.0 × 2.0 | 128 | 8 m |
| Terrain grass/dirt/gravel/sand layer | 1024² | 6.0 × 6.0 | 171 | 6 m |
| Terrain rock layer | 1024² | 8.0 × 8.0 | 128 | 8 m |
| **Shared grunge macro (AD-6)** | 512² R8 | **64 × 64** (roads/props) / **128 × 128** (terrain) | 8 / 4 | 64 / 128 m |
| Water swell normal | 512² | 24 × 24 | 21 | 24 m |
| Water chop normal | 512² | 6.0 × 6.0 | 85 | 6 m |
| Shore foam strip | 512×128 | 8.0 along × 2.0 | 64 | 8 m |
| Guardrail / metal kit | 1024² | unwrapped kit, target density | 256 | n/a |
| Jersey barrier | 1024² | 4.0 × 4.0 module | 256 | 4 m |
| Foliage atlas cell | 512² cell | ~2.4 m leaf cluster | 213 | n/a |
| Bark strip (bottom band of cell) | 512×128 | 0.5 wide × 2.0 tall | ~1024 / 256 | n/a |
| Verge grass card | 512² / 4 cells | 0.6 × 0.5 per card | 426 | n/a |
| Toldo fabric | 512² | 2.0 × 2.0 | 256 | 2 m |
| Sign — regulatory disc cell | 128² | 0.70 m disc | 183 | n/a |
| Sign — direction plate cell | 256×128 | 2.4 × 1.2 | 107 | n/a |
| Dynamic street-name cell | 256×64 | 2.4 × 0.6 | 107 | n/a |
| Shop fascia backplate cell | 256×64 | 3.2 × 0.8 | 80 | n/a |
| Rooftop / terrace prop atlas | 1024² / 512² | unwrapped kit | 128 target | n/a |
| Vehicle body region | of 2048² | body ~4.2 m long | ~350 | n/a |
| Pedestrian | 1024² | 1.75 m figure | ~340 | n/a |

### Scale rulings that resolve open questions in the audits

- **AD-11 — Facade texel density is fixed at 128 texels/m.** Today it is **21.3 × 25.6 texels/m** (256² canvas over `WALL_REPEAT_HORIZONTAL_M=12` / `FLOOR_HEIGHT=10`, `buildings-facade.md:30`) — **4–7× below** the ETS2 band of 85–150. The fix is `1024² over 8.0 m × 8.0 m`, containing **2 storeys at 4.0 m** (Eixample principal floors genuinely run 4.0–4.5 m). Power-of-two ratio, mid-band, and it makes `FLOOR_HEIGHT=10` obsolete — a wrong number that has been quietly setting the density.
- **AD-12 — Panot ships as a 20×20 grid over 4.0 m, not as a single 0.20 m tile.** A 1024² map over a 0.20 m repeat is 5,120 texels/m: an absurd density that wastes the map and produces a visible 0.2 m checkerboard. A 20×20 grid in one map at 256 texels/m carries per-unit value jitter, grout wear and chip variation, which is what actually reads. Requires the existing `1/0.2 m` UV at `roadRenderer.js:1690-1694` to become `1/4.0 m` — **and that same line is a §3.6 v-flip offender, so both changes land together.**
- **AD-13 — Sign lettering is authored at ~2× regulation cap-height.** Spanish motorway lettering is 200–350 mm, which at 100 m subtends **1.9–3.3 px at 1080p/60° FOV** — unreadable. ETS2 runs ~2× so the sign reads at 80–150 m (`signage.md:5`). Game-feel beats regulation. **Scale discipline has exactly this one deliberate exception, and it is named here so nobody "fixes" it later.**
- **AD-14 — Vehicle proportions are measured, never squashed.** `carModels.js:75` non-uniformly squashes a model to make it "read as a car." Banned. `vehicles.md:20-33`.
- **AD-15 — Tree LOD2 impostors are RENDERS of LOD0, never hand-drawn.** That is why ETS2's distance treeline reads correctly (`vegetation.md:21`).

---

# 6. NIGHT ART RULES

**The governing fact:** `main.js:192` removed the dynamic PointLights. The night rig is **1 Ambient + 1 Hemisphere + 1 Directional + 2 car headlight SpotLights** — `scene.js:623,629,634,652`, `carModel.js:279`. **There are zero punctual lights in the world.** `SKY-1`, `decisions.md` D-08. This structurally caps night at ~50% of ETS2 and is the #1 unsolved problem in the project.

Clustered street lighting is *proposed* at 1.2–2.0 ms (`SKY-21`) with its data feed already built and unused (`tileManager.js:3482-3490`, zero callers). **The art library must not depend on it landing.**

| Rule | Statement |
|---|---|
| **NIGHT-1** | **Every asset must READ at night with no punctual light on it.** Acceptance requires a screenshot under the NIGHT preset (`envToggle.js:53-66`) with headlights **off**. An asset that only works under the headlight cone fails. |
| **NIGHT-2 (the load-bearing one)** | **Night value separation comes from ALBEDO VALUE SPREAD, not from lights.** Under ambient `0x6b7a9e @1.0` + hemi `0x46567e @0.6`, two materials at the same L* are indistinguishable — the fill is nearly directionless. **Maintain ΔL* ≥ 12 between any two adjacent large surface classes.** The §4.4 targets already satisfy this (asphalt 38 → panot 62 → facade 74) — **do not let a domain "harmonise" them.** |
| **NIGHT-3** | **NORMAL MAPS DO ALMOST NOTHING AT NIGHT.** With hemispheric fill and no punctual light, N·L variation is tiny. **No domain may justify a normal map on night grounds.** Normal maps are a DAY investment and must be priced as one. *Stated loudly because otherwise 12 domains each budget normals "for the night look" and buy nothing.* |
| **NIGHT-4** | **Emissive = a per-instance SCALAR × a MASK CHANNEL in ONE shared city-wide 1024² R8 page** (1.365 MiB). Never a per-asset emissive texture, never a per-material emissive colour. Colours restricted to the §4.2 closed set of six. |
| **NIGHT-5** | **No asset may rely on bloom to be visible.** Bloom is `threshold 1.1 @ exposure 1.6` day (`envToggle.js:44-45`), and the sky audit proposes **skipping the bloom pass entirely** below strength 0.05 and dropping 5 mips to 4 (`sky-atmosphere.md:108`). Anything visible only through bloom vanishes there and on the mobile tier. Bloom is a bonus on top of an already-readable emissive. |
| **NIGHT-6** | **The four things that actually buy night quality, in order:** (a) albedo value spread [NIGHT-2]; (b) the **v9 baked sky-visibility AO grid** — free, already baked, and the only real occlusion at night, so **de-lighting [Step 2] matters more at night than in day**; (c) emissive masks; (d) the headlight cookie. Budget night effort against this list, not against normal maps. |
| **NIGHT-7** | **Wet-road is the cheapest night win available** (`water.md:15-24`): albedo ×0.72, one injected Blinn lobe (~8 ALU/light, on existing Lambert — `SKY-22`, no MeshStandard needed), one low-frequency puddle mask weighted to the camber gutters. **Therefore every ground albedo ships authored DRY, with L* mean high enough that ×0.72 does not crush it below L* 25.** Asphalt at L* 38 → 27 wet. Holds, with 2 to spare. Do not let asphalt drift darker than L* 36. |
| **NIGHT-8** | **HARD BAN: no boot-time canvas atlas, ever again.** The night-window atlases are 55.9–85.3 MiB resident (`F9`, `buildings-facade.md:52`) — the single largest VRAM object in the project, built unconditionally at boot for **16 variants** (`meshMaterializer.js:971-984`). **Their death is what funds every other domain's textures.** Night windows become a 512² mask layer inside the facade array. |
| **NIGHT-9** | **Warm-vs-cool IS the night look** (`colorGradePass.js:60`). Emissives are warm (N1–N3), the ambient rig is cool (`0x6b7a9e`, `0x46567e`, bg `0x0a1224`). **No domain adds a cool emissive to a residential/street context** — N6 Cool Sign is for commercial backlit boxes and institutional blue only. Break this and the night collapses to monochrome. |
| **NIGHT-10** | **The night sky is currently one flat navy field** — the shader dome is hidden at night and replaced with a solid `bgColor 0x0a1224` (`envToggle.js:63-64`, `SKY-5`). Any asset silhouetted against sky at night — parapets, treelines, guardrail posts, sign gantries — is being judged against a flat field and will read as a cutout. **Silhouette assets must be evaluated only after the night dome + horizon light-pollution band lands.** Flagging as a cross-domain sequencing dependency. |
| **NIGHT-11** | **Delete the fake-light stack as real lights arrive, do not accumulate both.** The night look is six independent fakes (`SKY-9`): lamp emissive×bloom, 16 m ground-pool decals (one per lamp at 22 m spacing = >100% road coverage, est. **0.6–1.1 ms**, `SKY-10`), hero-building spill decals, and three more. **Real lights make five of six redundant — clustered lighting is closer to a SWAP than an addition.** Any domain adding a new night fake must name which existing fake it replaces. |

---

# 7. ACCEPTANCE CHECKLIST

**An asset enters the library only after passing all 14 gates. `M` = machine-checked in `build-art.mjs`, build fails. `H` = human, recorded in the manifest with a reviewer initial. No waivers — an asset that cannot pass is rejected, not exempted.**

| # | Gate | Type | Fail condition |
|---|---|---|---|
| **1** | **CONTACT SHEET.** Asset appears on `art-contact-sheet.png` at fixed lighting on standard geometry, and a human confirms it does not read as a different fidelity tier from its neighbours. | **H** | Reads as from another game. *This is the only gate that catches a kitbash. It is #1 for that reason.* |
| **2** | **LICENCE.** Manifest carries `source`, `license`, `url`, `sha256`; licence ∈ {CC0, public-domain, OFL (fonts), AI-with-recorded-model-licence, Blender-authored-original}. No banlist hit. No trademark, real logo, real livery, or real plate. | **M** | Missing field, non-CC0, or banlist match. |
| **3** | **NORMALIZE PROVENANCE.** `normalizeVersion` matches the current pipeline; all 8 steps ran; `k` (de-light) matches the declared source type. | **M** | Any step skipped, or a photoscan shipped at `k=0`. |
| **4** | **PALETTE.** Post-normalize mean colour within **ΔE2000 ≤ 15** of a §4.1 anchor. Signage/emissive/vehicle-paint on the declared exempt list. | **M** | Out of range and not exempt. |
| **5** | **Lab TARGETS.** L* mean within ±4 and L* σ within ±3 of the §4.4 surface-class row; C* mean within ±5. | **M** | Out of band. |
| **6** | **PRE-GRADE.** Renders correctly at `uRally=0` (×1.15) **and** does not clip any channel at `uRally=1` (×1.52) + the S-curve. | **M** | Any channel clips in rally. |
| **7** | **NORMAL STRENGTH.** mean \|N.xy\| inside the §3.7 class band; Z renormalised; `normalScale=1.0` at the call site. | **M** | Out of band, or a runtime `normalScale ≠ 1.0` used for taste. |
| **8** | **NORMAL PROVENANCE.** `normalSource ∈ {baked, ambientcg, derived}`; `derived` only on a whitelisted surface class (AD-9). | **M** | Derived normal on lettering, tile, droplets, corrugation, or mortar. |
| **9** | **TRANSFER FUNCTION.** sRGB on albedo/emissive/impostor; LINEAR on normal/ORM/mask. Written **and re-read from the KTX2 DFD** to verify. | **M** | Any mismatch. *Fails silently at runtime — `verifyColorSpace` early-returns for compressed textures.* |
| **10** | **ORIENTATION.** `flipY = false`; every 2048² page carries the `⌐` glyph in its top-left 32×32 block; consumer UVs authored to glTF convention. | **M** + **H** | Glyph absent, or renders flipped in the library debug view. |
| **11** | **SCALE.** World-metric UV. Declared metres-per-repeat matches its §5 row within ±10%. No 0..1 stretch on a world surface. | **M** | Any normalised world UV, or off-table density. |
| **12** | **TILING** *(tiling maps only)*. Passes the 50%-offset seam test at ≤1.5× median gradient. Base repeat ≥2 m samples `grunge_macro_512` at ≥16× base scale (AD-6). | **M** | Visible seam, or macro breakup absent. |
| **13** | **COMPRESSION + SAMPLER.** Format matches the AD-2 grain-vs-shape rule. Mips present. Anisotropy assigned by the central registry policy (AD-7), never 1. Resolution at or under the §3.2 ceiling. VRAM + download logged against the domain's declared share. | **M** | Wrong format class, no mips, anisotropy 1, over ceiling, or over the domain's declared budget line. |
| **14** | **NIGHT.** Screenshot under the NIGHT preset with **headlights off**, asset legible. Emissive (if any) uses only the §4.2 six and a shared mask page. Ground albedo survives ×0.72 wet without falling below L* 25. No reliance on bloom. | **H** + **M** | Invisible at night, off-palette emissive, own emissive texture, or crushes when wet. |

### Two standing rejections, stated so nobody re-litigates them

- **An asset that "looks great in isolation" and fails gate 1 is rejected.** Isolation is not the shipping condition. The shipping condition is a street with eleven other domains' assets in it.
- **An asset that fails only gate 5 or gate 4 is re-graded, not exempted.** Grading is cheap and scripted. Exemptions compound: the first one makes the second one arguable, and by asset ~100 the palette is advisory. That is precisely the invisible-then-unrecoverable failure this document exists to prevent.

---

# 8. CROSS-DOMAIN BLOCKERS THIS BIBLE CREATES

Hand these to the synthesis step — they are dependencies, not commentary.

| ID | Blocker | Blocks | Cited by |
|---|---|---|---|
| **BLK-1** | **KTX2Loader singleton + `/basis/` transcoder + the FORMAT_OPTIONS BC1-over-BC7 patch** (`KTX2Loader.js:786-805`). Without the patch, every opaque map doubles on Windows. | **Every textured asset in all 12 domains.** | road-surface, buildings-facade, buildings-detail, signage, vegetation, road-furniture, water, terrain-coast |
| **BLK-2** | **`scripts/build-art.mjs`** — the 8-step normalize + encode + manifest + contact sheet. | Every asset. This bible is unenforceable without it. | pipeline-materials:148 |
| **BLK-3** | **Central material registry with the sampler policy** (anisotropy, mips, wrap, transfer) and the `userData.sharedMaterial` tag on all **13** untagged disposal sites — not 2. Under a shared library each untagged site disposes a **city-wide compressed texture** on every tile unload. | Every shared texture. | `F6` — roadRenderer.js:2088,2198,2744,2963,4325,4879; crashBarrierRenderer.js:401,406; reflectorRenderer.js:312,321; waterRenderer.js:236,309; vegetationRenderer.js:1124 |
| **BLK-4** | **Warm-list extension must land BEFORE or WITH the first textured material.** Adding `map`/`normalMap` changes the define set and invalidates the whole 125-program cache in one commit; first-appearance compiles were measured at ~100 ms frames. | The first textured material anywhere. | `F14`, `F15` |
| **BLK-5** | **`GLOBAL_VERTEX_BUDGET = 100000` per tile drops ENTIRE BUILDINGS** rather than degrading them (`buildingWorker.js:873,1098-1101,980,1148`). Any geometry the art pass adds **silently deletes buildings** in dense Eixample. | Every geometry-adding item in buildings, detail, furniture, signage. | `F18` |
| **BLK-6** | **Pin three to `0.183.1` exactly** — `package.json:22` still carries a caret while five planned items depend on r183 private internals (`FORMAT_OPTIONS` ordering, `bm._visibilityChanged`, `painterSortStable` field order, `BatchedMesh._reserveRange`, the DOUBLE_SIDED derivative-TBN flip). | Silent breakage on any patch bump. | `F22` |
| **BLK-7** | **Replace the CraftPix vegetation set** (models + textures) before any foliage work. It is the "free win already on disk" the brief cites, and it is **not licensable, and the wrong biome**. Real target from the OSM census already in the tiles: Tipuana tipu 691, Platanus × hispanica 624, palms 316, Celtis australis 311. | Vegetation entirely. | `VEG-5`, convert.py:18-19 |
| **BLK-8** | **SEQ-1** — vehicle kit Tier 0 lands with, or traffic is disabled before, the first normalized ground material. | §2 AD-1c. | vehicles.md, this document |
| **BLK-9** | **NIGHT-10** — silhouette assets (parapets, treelines, guardrail posts, gantries) cannot be art-judged until the night sky dome + horizon band lands; today night sky is one flat navy field. | buildings-detail parapets, vegetation treeline, road-furniture, signage. | `SKY-5` |

**Free wins to bank immediately, independent of all art work:** `renderer.shadowMap.autoUpdate` is **never assigned anywhere** — the only hit is a *comment* at `main.js:969` describing a state the code never establishes; three defaults it to `true`, so the shadow map re-renders every frame (**~1.2–1.5 ms**, `F7`). And **9.0 MB of shipped waste** is still live: `public/modes/*.png` 7.90 MB, `title-bg.png` 1.5 MB (referenced only as og:image for the placeholder domain `barcelona-drive.example` — the live site is drive.anmolbhardwaj.com), `logo-barcelona-drive.png` 924 KB (`F20`). That 9 MB is **37% of the entire 24 MB art-library budget**, currently spent on nothing.