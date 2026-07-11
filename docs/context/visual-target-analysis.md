# Visual Target Analysis — the "animated Barcelona" reference vs our renderer

**Question (Anmol, 2026-07-10):** why doesn't the game look like the cinematic aerial Barcelona renders
(golden light, refined, dense)? What are we missing, what's achievable in a browser, what isn't?

## 1. What the reference actually is

The reference images are **offline-render-grade stills** (AI-generated in the style of path-traced
archviz). They have: full global illumination, unlimited per-pixel detail, no 60fps budget, no
consistency-in-motion requirement, and a single hero framing. **No browser engine — and no shipped game,
console included — produces that per-frame at runtime.** Games that market such shots use photo modes and
offline touch-ups. So the honest frame for this work: we are not chasing pixel parity; we are chasing
**vibe parity** — the light, atmosphere, colour and density *impression*. That is substantially achievable.

## 2. The gap, decomposed (ranked by contribution to the "refined" feel)

| # | Component | ~Share | Reference | Ours today |
|---|---|---|---|---|
| A | **Light transport (GI)** | ~50% | Sky light + bounce fills every shadow with COLOUR (blue sky fill, warm ground bounce); street canyons and courtyards self-darken; facades carry soft gradients | One sun + uniform ambient/hemi → every shadow equally flat; only a 6m baked base band grounds buildings; no occlusion between buildings |
| B | **Atmosphere** | ~20% | Aerial perspective: progressive desaturation + blue-shift with distance, warm horizon toward the sun, crisp near / soft far | Uniform single-colour FogExp2 — a grey veil, not depth |
| C | **Content density & coherence** | ~20% | Real roof forms, Eixample courtyard gardens, balconies/cornices everywhere, rooftop clutter, varied tree crowns, marina boats, beach life | Extruded OSM footprints (flat roofs), some balconies/shopfronts, boxy tree archetypes, empty water/beaches |
| D | **Material response** | ~10% | Spec/roughness variation, water sun-glints, glass reflections | ~150 materials, overwhelmingly Lambert/Basic (diffuse only); water flat |

Audit facts (2026-07-10): 91 MeshLambert + 58 MeshBasic + 37 MeshStandard + 8 Phong; **no offline light
baking of any kind**; 1×2048 shadow map; FogExp2.

## 3. Genuinely out of reach (browser, streamed ~6km city, 60fps)

- **Real-time path tracing / true GI.** Screen-space GI libraries exist for three.js but need a full
  depth/normal prepass — the exact trap that killed GTAO here (tripled triangle throughput → 33fps).
- **Offline-AA, render-farm crispness.** Per-pixel detail density of an archviz still.
- **Photoreal materials across a whole city** — texture memory + authoring cost, independent of perf.

Target statement: **a beautiful stylized miniature city with cinematic light** — the reference's mood at
60fps, honestly ~70% of its vibe, 0% of its photorealism.

## 4. Our unfair advantage: we OWN an offline bake pipeline

GI is expensive at runtime but **free at bake time** — and unlike most three.js projects, we already have
an offline tile baker. This is how real games get the GI look (lightmaps/vertex bakes):

- **Bake hemispheric sky-visibility AO per vertex** (occlusion of the sky dome by surrounding building
  geometry) into the tile data for buildings, roads and terrain. Narrow streets darken, courtyards go
  moody, roofs and plazas stay bright — the single biggest step toward the reference's light, at ZERO
  runtime cost. Requires: bake-pipeline pass + tile-format bump + renderer reads the attribute.
- Optional second scalar: warm **ground-bounce** on street-facing facades.

⚠ Both require a re-bake (golden rule: warn first) and a tile format version bump.

## 5. Runtime roadmap (effort × impact)

**Tier 1 — Light (attacks the 50%)**
1. Golden-hour lighting contrast: cooler sky-fill in shadows vs warmer sun (hemi colours), tuned exposure. *(hours)*
2. Shadow quality: tighter frustum or 2-cascade CSM; contact-shadow strengthening near camera. *(~day)*
3. **THE BAKE: hemispheric AO** (see §4). *(the big one — days incl. re-bake + format bump)*

**Tier 2 — Atmosphere (the 20%)**
4. Aerial-perspective fog shader replacing FogExp2: distance+height → desaturate → blue-shift, warm wedge
   toward the sun azimuth. Injected via the shared materials' fog chunk (onBeforeCompile). *(1–2 days, huge mood payoff — this is what makes aerial/title shots sing)*

**Tier 3 — Content (the other 20%)** — all bake-side, we control the data
5. Eixample courtyard gardens: detect interior holes of block polygons at bake → trees/green inside blocks. *(medium)*
6. Roof forms + parapets + rooftop clutter instancing (AC units, tanks) via heuristics + OSM roof tags. *(medium-large)*
7. Marina boats (marina polys exist in v7), beach umbrellas/towels on beach polys, denser street furniture. *(medium, high charm)*
8. Tree-crown variation pass (2–3 silhouettes, subtle shading). *(medium)*

**Tier 4 — Materials & post (the 10%)**
9. Water: sun-glint specular + shore gradient. *(~day)*
10. Selective MeshStandard + one small shared envmap for glass/roofs. *(~day)*
11. AA polish: FXAA/TAA-lite + sharpen on top of adaptive res. *(~day)*

## 6. Recommended sequence

L1 lighting contrast → L2 aerial perspective (mood transformed, no re-bake yet) → L3 the AO bake (flag the
re-bake, biggest single jump) → L4 content passes (courtyards → water/beach → roofs/clutter) → L5 material
polish. Each phase is independently shippable and screenshot-verifiable.
