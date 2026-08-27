# Barcelona Road System — Implementation Reference

**Status:** Active reference document. Read this in full before any road-related code change.
**Owner:** Anmol (creative direction) + Claude Code (implementation)
**Last updated:** 2026-05-29
**Companion docs:** /CLAUDE.md, /docs/context/architecture.md, /docs/context/map-system.md, /docs/context/gotchas.md

This document captures the full design and roadmap for converting the road system from its current Delhi/IRC 35 conventions to Barcelona/Norma 8.2-IC conventions. It is split into baseline (current state), target (Barcelona reality), and roadmap (phased implementation).

---

## 1. Baseline — current state of the road system

### Data pipeline
- **Single OSM entry point:** `backend/worldBuilder/pbfHighways.js:161` (`parsePbfHighways()`)
- **Tags currently kept** (`pbfHighways.js:17` KEEP_TAGS): `highway, bridge, tunnel, layer, lanes, surface, incline, name, service, junction`
- **Road payload emitted to tile** (`buildRegion.js:1025-1038`): `id, nodeIds, points, elevation, width, bridge, tunnel, layer, highwayType, serviceSubtype, name, isRamp, isRoundabout`
- **Binary tile format** (`convertToBinary.js:160-188`) supports additional fields (oneway, lanes, surface, lit, maxspeed, divider, sidewalk, cycleway) but `buildRegion.js` does NOT emit them — they are discarded after parsing.

### Critical gap — data discarded after parse
The following OSM tags are parsed but thrown away before tile emission:
- `oneway` — needed for one-way arrows, traffic flow direction
- `lanes` — needed for accurate lane divider count (Barcelona has 94.7% lane tagging coverage)
- `surface` — asphalt vs cobble vs concrete
- `lit` — streetlight density hint
- `maxspeed` — speed limit signage
- `sidewalk` — sidewalk presence (left/right/both/none)
- `cycleway` — bike lane presence and type

Phase 2 fixes this in `buildRegion.js:1025-1038` by adding these fields to the payload map.

### Rendering
- **Main renderer:** `frontend/src/map/roadRenderer.js` (3205 lines, entire road stack)
- **Width function:** `getRoadWidth()` at `roadRenderer.js:451` — clamps OSM width to [4, 30] meters or falls back to `WIDTH_BY_TYPE` lookup
- **Geometry:** flat ribbon with miter joins, 2 verts per centerline point, ~140-180 verts per 100m of road
- **Markings:** `buildRoadMarkings()` at `roadRenderer.js:925` — geometry-based, not textures or decals. All clipped at junction circles via `clipPolylineNearJunctions()` at line 606.
- **Junction handling:** gore meshes (pre-computed in bake), width tapering (interpolated in renderer, line 522)

### Current visual elements (per Delhi convention)

| Element | Method | Notes |
|---|---|---|
| Asphalt ribbon | Geometry + vertex color | Procedural oil stain via UV noise |
| Center line | Geometry, 0.15m wide | Color `0xe8e4dc` "dusty off-white" (Indian roads) |
| Lane dividers | Geometry, 0.12m wide, dashed | Only motorway/trunk, only when totalLanes > 2 |
| Edge lines | Geometry, 0.15m wide | Both sides, all types |
| Sidewalks | Geometry, fixed widths | **Currently disabled** (`CONFIG.ENABLE_SIDEWALKS: false`) |
| Edge strip | Geometry, 0.1m | Small kerb-like strip |
| Bridge pillars/slab/guard | Geometry | Procedural |
| Gore polygons | Geometry, pre-baked | Triangular fills at merges |

### What is NOT rendered today
- Crosswalks (no `highway=crossing` data, no zebra stripes)
- Stop lines / yield lines / turn arrows
- Bus lane markings
- Bike lane paint (cycleway features rendered as narrow road ribbons, not as overlays)
- Tram tracks on road surface (railway=tram handled separately by `railwayRenderer.js`, not integrated with road geometry)
- One-way arrows
- Painted curbs (yellow no-parking, blue regulated parking)
- Chamfered intersection plazas

### Existing CONFIG flags

| Flag | Default | Status |
|---|---|---|
| `ENABLE_SIDEWALKS` | false | Code exists but produces fixed-width procedural sidewalks, not OSM-driven |
| `ENABLE_ROAD_EDGE_DETAIL` | true | 0.1m edge strip at road boundary |
| `ENABLE_ROAD_SHOULDERS` | false | Blend strip |
| `ENABLE_BARRIERS` | true | OSM barrier walls |
| `ENABLE_CRASH_BARRIERS` | true | Bridge edges |
| `ENABLE_DIVIDERS` | true | **Dead** — import commented out |
| `ENABLE_ROAD_INFRA` | true | Signs, gantries, signals |
| `ROAD_ONLY_DEBUG` | false | Live debug |

### Vertex budget
- Soft warning: **150,000 vertices per tile** (`tileManager.js:50`)
- Combined: roads + railways + buildings
- Dense Eixample tiles already at 170k-230k (already over). Phase 3 sidewalks will push further — must address budget before Phase 3 or accept the overage.

### Delhi/IRC-specific assumptions to remove
1. `roadRenderer.js:3` docstring + `roadRenderer.js:71` constants explicitly reference "IRC 35"
2. White paint color `0xe8e4dc` is dusty Indian off-white (Spain uses near-pure white)
3. No left/right driving convention enforcement — neutral for both Delhi and Barcelona, leave as-is
4. `LANES_BY_TYPE` hardcoded defaults — currently used because real `lanes` data is discarded

---

## 2. Target — Barcelona reality

### Standard: Norma 8.2-IC (Spanish national road markings standard)

All longitudinal lines in Spain are **WHITE** (no yellow center lines like US/IRC). Yellow indicates parking restrictions only. Blue indicates regulated parking zones.

### Dimensions (per Norma 8.2-IC)

| Marking | Width | Color | Hex |
|---|---|---|---|
| Continuous longitudinal | 0.10m | Bright white | `#F5F5F5` |
| Dashed longitudinal (urban) | 0.10m | Bright white | `#F5F5F5`, dash 2m / gap 2m |
| Dashed longitudinal (highway) | 0.10m | Bright white | `#F5F5F5`, dash 4m / gap 12m |
| Stop line (transverse) | 0.40m | White | `#F5F5F5` |
| Crosswalk stripe | 0.50m wide, 0.50m gap | White | `#F5F5F5` |
| Bus lane "BUS" letters | varies | White | `#F5F5F5` |
| No-parking curb stripe | 0.10m | Yellow | `#F5D000` |
| Regulated parking stripe | 0.10m | Blue | `#0066B3` |
| Bike lane edge | 0.10m | White | `#F5F5F5` |
| Bike lane surface | full lane | Green | `#3F9F4F` |

### Barcelona archetypes (target sections)

#### Eixample standard (residential grid, 20m total)
- Sidewalk: 5m each side (panot tile)
- Roadway: 10m total (typically 2 lanes one-way + parking strips ~2m each)
- One-way: ~80% of Eixample streets
- Markings: edge lines + dashed lane divider if 2+ lanes
- No bike lane on standard streets (they run on parallel axial streets)

#### Eixample axial (with carril bici)
- Same 20m profile + green bike lane 1.5-2m
- Bike pictogram every ~30m
- Examples: Carrer de Consell de Cent, Carrer de la Diputació, Aragó

#### Gran Via de les Corts Catalanes (50m boulevard)
- Sidewalks: 8m each side
- Service lanes: 5m each side (parking + local access)
- Central median: 4m with trees
- Main roadway: 10m each direction (3 lanes)
- Bus lanes common

#### Diagonal (modern, ~50m)
- Sidewalks: 7.5m each side
- Outer roadway: 5.2m each side (2 lanes/direction)
- Tree rows between roadway and central
- Central tram platform: ~6m (two tracks, modern Trambesòs ground-level current rails)
- Central bike lane: 4m bidirectional
- Parterre (landscaped strip) separates everything

#### Passeig de Gràcia (60m, signature Gaudí district)
- Hexagonal Gaudí panot sidewalks (different from Flor de Barcelona)
- Wide sidewalks with cafe terraces
- Central tree-lined median
- 2 lanes each direction + service lanes + bike lane

#### Gracia narrow (8-12m, pre-Cerdà)
- Single-platform (no curb, shared space)
- 20 km/h zone
- Stone/cobble texture
- No lane lines
- Pedestrian priority

#### Barceloneta (~12m seaside grid)
- Narrow sidewalks 2-3m
- Often one-way
- Beach-adjacent ones get palm trees (Phase 4 polish)

### Chamfered intersections (THE iconic feature)
Every Eixample block has its corners cut at 45° for 20m. This creates an octagonal small plaza at every intersection (113m × 113m blocks → 20m chamfers → octagonal junction space). No other city has this at scale. Building/sidewalk geometry handles the chamfer; road geometry widens to fill.

### Sidewalk material — panot
- 20cm × 20cm hydraulic cement tiles
- "Flor de Barcelona" — 4-petal flower, most common Eixample design
- Hexagonal Gaudí — only on Passeig de Gràcia
- Color: pale grey-beige `#C8C2B5`
- Texture repeat: 0.2m × 0.2m
- ~5 million m² in Barcelona alone

### Curbs (bordillo)
- Granite, 30cm wide, 12cm above asphalt
- Color: dark grey `#5A5A5A`
- Curb cuts at corners

### Tram (Tramvia Barcelona)
- Standard gauge 1.435m
- Embedded in asphalt (no ballast) — rails flush with road surface
- Or in grass-strip median (modern Diagonal style)
- Catenary poles every ~30m on grass median sections
- Trambesòs new sections: ground-level current rails (no overhead wires)

### Bike lanes (carril bici)
- 2m one-way, 4m two-way
- Most painted full green for visibility
- Color `#3F9F4F` (bright)
- Separated by: plastic bollards (post every 2-3m), or curb-separated, or paint-only
- Bike pictogram every ~30m

### Crosswalks (paso de cebra)
- White stripes parallel to road direction
- 0.50m stripe, 0.50m gap
- Full lane width
- At every urban intersection
- "ZONA 30" or "ZONA 20" stencils common

---

## 3. Roadmap — phased implementation

### Phase 1: Paint + colors (NO re-bake, quick win)
**Goal:** Roads stop looking Indian and start looking Spanish, with no bake pipeline changes.

**Changes:**
- Paint color: `0xe8e4dc` → `0xf5f5f5` in marking material (`roadRenderer.js:777`)
- Line widths: 0.15m → 0.10m for continuous and edge lines
- `MARKING_RULES` updated for Spanish conventions
- Update file docstring (`roadRenderer.js:3`) and constants comment (`roadRenderer.js:71`): "IRC 35" → "Norma 8.2-IC"
- Add crosswalk geometry at intersections using `getJunctionPoints()` data — generate zebra stripe quads runtime, no OSM data needed

**Files touched:**
- `roadRenderer.js` (color constants, MARKING_RULES, buildRoadMarkings, new buildCrosswalks function)
- `gotchas.md` (add entry: "Color migration from IRC 35 to Norma 8.2-IC")
- `changelog.md`

**Verification:**
- Visual: drive around, paint is bright white not dusty
- Crosswalks visible at every intersection
- No console errors

**Time:** 1 session

---

### Phase 2: Emit OSM data (re-bake required) — unlocks Phases 3 & 4
**Goal:** Stop discarding parsed OSM tags. Highest-leverage change in the roadmap.

**Changes:**
- `buildRegion.js:1025-1038` road payload map gets new fields:
```js
  roads: tileRoadsFinal.map((r) => ({
    // ... existing ...
    oneway: r.tags?.oneway === 'yes' || r.tags?.oneway === '-1' || null,
    lanes: r.tags?.lanes ? parseInt(r.tags.lanes, 10) : null,
    sidewalk: r.tags?.sidewalk || null,  // 'both', 'left', 'right', 'no', 'none'
    cycleway: r.tags?.cycleway || null,
    surface: r.tags?.surface || null,
    maxspeed: r.tags?.maxspeed ? parseInt(r.tags.maxspeed, 10) : null,
  }))
```
- Verify binary format already handles these (`convertToBinary.js:179-186`) — should be no changes needed
- Verify tile parser already reads them — no changes needed
- Update `roadRenderer.js` to USE `road.lanes` instead of `LANES_BY_TYPE` fallback (when present)
- Add one-way arrow geometry rendered from `road.oneway` (small painted arrow every 30m in lane center)
- Re-bake Barcelona

**Files touched:**
- `buildRegion.js` (payload map)
- `roadRenderer.js` (use road.lanes, add one-way arrows)
- `bake-pipeline.md`, `map-system.md` (docs)
- `changelog.md`

**Verification:**
- Console log shows lane counts match OSM (not LANES_BY_TYPE fallback)
- One-way streets render with arrows pointing correct direction
- Spot-check: Carrer de Provença (one-way SW) and Carrer del Consell de Cent (was one-way before Superilla — now check what OSM says)

**Time:** 1 session including re-bake

---

### Phase 3: Sidewalks (panot) + curbs + bike lanes
**Goal:** The big visual leap. Eixample suddenly looks like Eixample.

**Pre-requisite:** Phase 2 must be complete (need `road.sidewalk` and `road.cycleway`).

**Changes:**
- Procedural sidewalk geometry from `road.sidewalk` data ('both' / 'left' / 'right' / 'no')
- Panot tile texture: create 256×256 PNG with 4-petal flower pattern repeating, place in `frontend/public/textures/panot-flor.png`
- Sidewalk material: `MeshStandardMaterial` with panot texture, color tint `#C8C2B5`, UV scale matching 0.2m tile in world space
- Granite curb between road edge and sidewalk: thin ribbon, 0.3m wide × 0.12m high, color `#5A5A5A`
- Bike lane rendering from `road.cycleway` data:
  - `cycleway=lane` → 2m painted strip on right side of roadway, color `#3F9F4F`
  - `cycleway=opposite_lane` → same on left
  - `cycleway=track` → separated, full bike lane structure
- Bike pictogram: simple texture/SVG decal, placed every 30m along bike lane
- Re-enable `CONFIG.ENABLE_SIDEWALKS = true`
- Address vertex budget: increase soft warning from 150k to 220k, OR reduce sidewalk geometry resolution

**Files touched:**
- `roadRenderer.js` (buildSidewalkAndEdgeMeshes overhaul, new buildBikeLaneMeshes)
- New asset: `frontend/public/textures/panot-flor.png`
- `tileManager.js:50` (vertex budget threshold)
- `CONFIG.ENABLE_SIDEWALKS` default
- `rendering.md`, `gotchas.md`, `changelog.md`

**Verification:**
- Drive Eixample: panot pattern visible on sidewalks
- Drive Carrer de Consell de Cent or Aragó: green bike lane visible
- Drive Gracia narrow streets: NO sidewalk (correct — those are shared platforms)
- No vertex budget warnings (or expected warnings stay within tolerated range)

**Time:** 1-2 sessions

---

### Phase 4: Tram + chamfered corners + polish
**Goal:** The iconic Barcelona moves. Diagonal feels like Diagonal.

**Changes:**
- Tram track on road surface: extend `railwayRenderer.js` to detect `railway=tram` and render flush-embedded rails (no ballast, no sleepers visible). Two narrow steel-grey strips (rail width 60mm).
- Tram in grass median: separate visual treatment for sections where tram is on grass (Diagonal modern). Detect via OSM `railway=tram` + adjacent landuse polygon, or by `tram=yes` tag on parallel `highway=service` strip.
- **Chamfered intersections:** at every junction with `getJunctionPoints()` radius ≥ 18m (i.e. likely Eixample-scale), extend road surface polygon to fill the chamfered corner space. This requires generating triangle fan geometry from junction center to chamfer endpoints. Use `tileData.junctions[]` if it has the chamfer data, or detect chamfers from building polygon corners at intersection.
- Crosswalk style improvements: tactile paving dots (yellow-orange) at curb edge before crosswalks
- Yellow no-parking stripes along curbs (use `road.parking:both` OSM tag if present)
- Blue regulated parking zones (same)
- Optional: "ZONA 30" stencils on residential streets where `road.maxspeed === 30`

**Files touched:**
- `railwayRenderer.js` (tram surface treatment)
- `roadRenderer.js` (chamfer geometry, parking stripes, ZONA stencils)
- `pbfHighways.js` or `pbfRailways.js` (extract `tram=yes`, `parking:lane:*` tags if not already)
- `convertToBinary.js` (if new fields)
- `architecture.md`, `gotchas.md`, `changelog.md`

**Verification:**
- Drive Diagonal: tram tracks visible in central median, bike lane on each side, looks like a postcard
- Every Eixample intersection has the chamfered octagonal plaza
- ZONA 30 stencils visible on Carrer de Verdi or other residential Gracia streets
- Blue parking visible on standard Eixample streets

**Time:** 1-2 sessions

---

## 4. Cross-cutting constants

Reference these values in every phase. Anything that wants a color/width/dimension must use these.

```js
// Colors (use these everywhere)
export const BCN_COLORS = {
  PAINT_WHITE:        0xf5f5f5,   // All longitudinal lines
  PAINT_YELLOW:       0xf5d000,   // No-parking curb
  PAINT_BLUE:         0x0066b3,   // Regulated parking
  PAINT_BIKE_GREEN:   0x3f9f4f,   // Carril bici surface
  SIDEWALK_PANOT:     0xc8c2b5,   // Panot tile base color
  CURB_GRANITE:       0x5a5a5a,   // Bordillo
  ASPHALT_BASE:       0x4a4a4a,   // Existing asphalt color, unchanged
  TRAM_RAIL_STEEL:    0x8a8a8a,   // Embedded tram rail
};

// Dimensions (meters, per Norma 8.2-IC)
export const BCN_DIMS = {
  LINE_WIDTH_LONGITUDINAL:  0.10,
  LINE_WIDTH_STOP:          0.40,
  CROSSWALK_STRIPE_WIDTH:   0.50,
  CROSSWALK_STRIPE_GAP:     0.50,
  DASH_LENGTH_URBAN:        2.0,
  DASH_GAP_URBAN:           2.0,
  DASH_LENGTH_HIGHWAY:      4.0,
  DASH_GAP_HIGHWAY:         12.0,

  SIDEWALK_WIDTH_EIXAMPLE:  5.0,
  SIDEWALK_WIDTH_NARROW:    2.5,
  SIDEWALK_WIDTH_BOULEVARD: 8.0,

  CURB_WIDTH:               0.30,
  CURB_HEIGHT:              0.12,

  BIKE_LANE_WIDTH_ONEWAY:   2.0,
  BIKE_LANE_WIDTH_TWOWAY:   4.0,
  BIKE_PICTOGRAM_SPACING:   30.0,

  TRAM_GAUGE:               1.435,
  TRAM_RAIL_WIDTH:          0.06,

  PANOT_TILE_SIZE:          0.20,

  CHAMFER_LENGTH:           20.0,  // Eixample standard
};
```

---

## 5. Glossary

- **Eixample** — Barcelona's main 19th-century grid district designed by Ildefons Cerdà. 113m × 113m blocks, chamfered corners.
- **Cerdà / Pla Cerdà** — Ildefons Cerdà, civil engineer who designed the Eixample plan (1859).
- **Chaflán / xamfrà** — chamfered corner (45° cut) at every Eixample block.
- **Panot** — 20×20cm cement sidewalk tile. The 4-petal flower is the iconic Eixample design.
- **Carril bici** — bike lane.
- **Bordillo** — curb (granite).
- **Cebra / paso de cebra** — zebra crossing / crosswalk.
- **Calzada** — roadway (motor vehicle portion).
- **Acera** — sidewalk.
- **Norma 8.2-IC** — Spanish national standard for road markings (Instrucción de Carreteras 8.2-IC, Marcas Viales).
- **Superilla / Superblock** — Barcelona's pedestrianized neighborhood concept; 3×3 block groups with car traffic restricted to perimeter.
- **Carrer** — street (Catalan).
- **Avinguda** — avenue (Catalan).
- **Passeig** — promenade (Catalan).
- **Ronda** — ring road.
- **Trambaix** / **Trambesòs** — Barcelona's two tram networks (west and east; currently being connected through Diagonal).

---

## 6. Decisions log

Append decisions made during implementation here, with date and one-line rationale.

- **2026-05-29** — Line width 0.10m for all longitudinal lines (center, edge, lane divider). Norma 8.2-IC specifies 0.10m for all; no distinction between line types at this width.
- **2026-05-29** — Crosswalk Y offset 0.04m above road surface. Markings sit at 0.03m; crosswalks at 0.04m avoids z-fighting while remaining visually flush.
- **2026-05-29** — MARKING_RULES trunk=solid kept as-is. Trunk roads in Spain are often undivided at urban scale; solid center line is conservative and can be revisited in Phase 4 with `road.oneway` data.
- **2026-05-29** — Crosswalk setback = max(junction.radius, INTERSECTION_RADIUS) + 1.5m. `junction.radius` = max road width at junction = clip-zone depth on each approach. 1.5m gap between clip zone edge and first crosswalk stripe. Short-road guard: skip endpoint if setback × 2 > road length.
- **2026-05-29** — Crosswalk mesh LOD-culled at 80m (same `detailDist` as barriers/bus stops). Vertex cost ~40 verts per approach; dense Eixample tiles add ~24k verts but only rendered when player is within 80m of tile edge.
- **2026-05-29** — LOD altitude multiplier curve: ground 1.25×, cap 5×, denominator 35 (was: ground 1.0×, cap 4×, denominator 50). Reason: car driving felt weak, drone buildings arrived late.
- **2026-05-29** — Phase 3: Runtime Canvas2D textures (not static PNG) for panot and bike pictogram — no asset pipeline needed. World-space UV for panot (constant physical size regardless of sidewalk width). OSM sidewalk data trusted 100% with no fallbacks. Curb L-profile: two quads per segment (top face + outer vertical face) so no floating slab at street level. `bcn`-prefixed mesh names to avoid collision with legacy sidewalkMesh slot. Vertex budget bumped 150k→250k soft / 300k hard.
- **2026-05-29** — Phase 2: 4 tags added to pbfHighways.js KEEP_TAGS (oneway, sidewalk, cycleway, maxspeed). All 6 fields now emitted from buildRegion.js payload. Gates 3+4 (convertToBinary, tileParserWorker) were pre-built. One-way arrows: skip motorway/trunk (implied by divider), skip bridge/tunnel. maxspeed: parseInt only, units stripped, mph normalization deferred.
- **2026-05-30** — Tunnel terrain cut (Option X): bake-side portal corridor strips. Fixed Mercator-vs-world coordinate bug in terrainBaker (tunnel mouth circles were never actually cutting terrain). Added bidirectional ±80m corridors from portal endpoints. BCN_DIMS.APPROACH_RAMP_CUT_MARGIN=2.5m. Re-bake required and completed. See G-42/G-43.
- **2026-05-30** — Tunnel overhaul (Option B — retaining walls): replaced terrain carving as default with vertical concrete retaining walls for all urban box-cut approaches. isHillsideApproach() preserves carving for motorway/trunk ≥60m only (none in current tile extent). Pedestrian/footway tunnels reclassified to portal-frame-only (no interior, no carving, no holes). Interior: cream tile walls, LED ceiling strips, yellow safety stripe, per-name "TÚNEL" sign, relative ceiling height (road+4.5m). Delhi-era chevron curbs, guardrails, discrete spotlights removed. Approach canopy disabled (returns empty group). See G-37/G-38/G-39.
- **2026-05-30** — Phase 4D loose ends: Direction board signs — removed Hindi transliteration and "Pin Code 110001". Tunnel signs changed from "सुरंग / TUNNEL" to "TÚNEL". Ghost-wall filter added to barrierRenderer (5m centroid proximity, configurable). These were Delhi leftover artifacts.
- **2026-05-30** — Phase 4C-B parking: OUTCOME A (Barcelona uses :restriction + :condition + :fee schemas). 12 new KEEP_TAGS. Three-schema priority chain in buildRegion. Re-bake. Blue stripe (Zona Blava): parkingPaidLeft/Right='paid'. Yellow stripes now populated from :restriction schema.
- **2026-05-30** — Phase 4C-A: ZONA 30 InstancedMesh every 100m on maxspeed=30 residential/tertiary. Tactile paving strip at crosswalk-sidewalk interface (beige dots, Canvas2D texture). LOD 50m/60m × altMult.
- **2026-05-30** — Phase 4B-2: Triangular panot sidewalk corner fills at chamfer junctions. Diagonal L-profile granite curb along chamfer edge. Both derived from junction.radius + junction.approaches. V3=outer corner formula: junction + outOff_B*dir_A + outOff_A*dir_B.
- **2026-05-30** — Phase 4B-1 chamfer fill: Option 2 chosen (bake-side junction enrichment vs frontend spatial matching). `radius = max(approach.width)` full road width to match `getJunctionPoints()` convention. 20° orthogonality tolerance. Fan triangulation over ShapeUtils. Eligibility threshold `radius ≥ 8m` targets secondary/tertiary Eixample streets, excludes 4m service roads. 8% of junctions qualify. Phase 4B-2 (sidewalk/curb diagonals) deferred.
- **2026-05-29** — Phase 4A tram: `createTramMeshes()` added to `railwayRenderer.js`. Two parallel 0.06m rails at ±0.7175m from centerline. `MeshLambertMaterial`, `BCN_COLORS.TRAM_RAIL_STEEL`. Tunnel segments skipped. `CONFIG.ENABLE_TRAM_TRACKS: true`. LOD: 200m × altMult. Tram data confirmed in 8 tiles (Trambesòs route, tiles 33166–33173). Diagonal tram not in OSM extent.
- **2026-05-29** — Phase 4A parking stripes: `parking:lane:left/right/both` added to pbfHighways.js KEEP_TAGS. Pipeline plumbed through buildRegion→convertToBinary→tileParserWorker→roadRenderer. `buildNoParkingStripes()`: continuous (no_stopping) or dashed 2m/2m (no_parking). `MeshLambertMaterial`, `BCN_COLORS.PAINT_YELLOW`, Y +0.04m, LOD 80m × altMult. OSM has 355 restriction ways but all outside current tile extent (Eixample has metered/parallel parking, not restriction zones). Will appear when coverage expands.
- **2026-05-29** — Panot material: `MeshStandardMaterial` → `MeshLambertMaterial`. Removed `roughness`/`metalness`. Lambert renders identically for flat-lit ground surfaces; saves ~30–60MB shader overhead (G-28).
- **2026-05-29** — barrier=wall: `BARRIER_CONFIGS.wall.minHeight` 3.5→1.0m, `compound_wall.minHeight` 3.5→1.5m. Removed `'wall'` from `PRECAST_WALL_TYPES` (was getting Indian pillar+panel geometry); added `'wall'` to `TEXTURED_WALL_TYPES` (UV-mapped stone). No re-bake: `BARRIER_DEFAULT_HEIGHTS.wall=2.0m`, `Math.max(2.0,1.0)=2.0m` — default height unchanged. Explicit OSM heights and retaining_wall heights both preserved (retaining_wall has no minHeight; sound barriers with height=4m+ floor at 1.0m → pass through unchanged). Ghost-wall filtering deferred (see Section 7).
- **2026-05-29** — Sidewalk inference: 3-layer hybrid system. Layer 1: OSM `sidewalk=both/left/right` wins (209 roads, 1.4% of all, 6.3% of drivable). Layer 2: `sidewalk=no` explicit skip. Layer 3: road-type fallback — infer `'both'` for all drivable types not in skip set (`motorway`, `trunk`, both `_link` variants, `service`, `track`, `path`, `cycleway`, `footway`, `steps`, `pedestrian`, `living_street`). `pedestrian`/`living_street` skip because they ARE the walkable surface.
- **2026-05-29** — Building proximity gate (30m): applied on top of inference. Roads with no building centroid within 30m of any road point get no sidewalk. Eliminates open-field and coastal roads. Threshold calibrated to Eixample geometry (~23m from road center to building centroid for a 20m-wide street). `buildings` array passed into `options` at `tileManager.js:1052`, available synchronously before `createRoadMeshes` is called at line 1061 — no race condition.
- **2026-05-29** — Junction clip radius fix: sidewalk offset polylines clipped with `base_radius + offsetFromCenter` (per-road) instead of fixed 3m. Previous 3m clip never reached the offset sidewalk polyline (minimum distance to junction = offsetFromCenter ≥ 6m), so all corners overlapped. New radius scales correctly with road width.

---

## 7. Open questions

> **See also:** [`barcelona-remediation-roadmap.md`](barcelona-remediation-roadmap.md) — the post-road-overhaul structural improvement plan (Phase A visual polish, Phase B cross-tile architecture, Phase C Mercator scale fix). That document is the single source of truth for all improvement sessions following the road overhaul completion.

- [x] **Vertex budget headroom for Phase 3** — RESOLVED. Soft limit bumped 150k→250k, hard limit added at 300k. Dense Eixample tiles expected at 185-250k with Phase 3 sidewalks/curbs/bike lanes. LOD culling keeps render cost low at distance.
- [ ] **Sidewalk side accuracy** — trusting OSM 100%. Watch for streets where sidewalk renders on wrong side due to OSM digitization direction. Collect problem streets during Phase 3 verification; fix in Phase 4 polish.
- [ ] Panot texture — generate procedurally or ship a PNG? PNG is simpler; procedural is sharper at distance.
- [ ] Chamfer geometry — do we have building corner data per junction, or detect from `tileData.junctions[]` radii?
- [ ] Tram median grass strip — Diagonal modern style. Is the OSM data sufficient to know "this is a grass median" vs "this is an asphalt embedded tram"?
- [ ] Superilla stencils — render "Zona 30" stencils where present? Detect via OSM `maxspeed=30` + residential combo, or by `traffic_calming=*`?
- [ ] **Ghost-wall filtering (3f, deferred)** — `barrier=wall` features double-tagged with building footprints produce floating walls inside/through building meshes. Fix requires a spatial pre-pass: skip any wall whose midpoint is within 2m of a building polygon edge. Needs `buildings` passed to `buildBarrierMeshes` (currently only receives `roads`). Deferred to Phase 4 polish.

---

## 4. OPEN TICKETS — road realism programme (filed 2026-08-27, user-requested)

Four tickets, filed together because they share one root cause: **the road system draws what OSM
happens to tag, and infers almost nothing.** OSM is a topological map, not an engineering drawing —
it says a way is `highway=primary` with `bridge=yes`, not how wide it is, where its edges need
protecting, or what the protection is made of. Everything below is inference the game must do for
itself. None is started; each states what exists today so the work is not re-discovered.

### R-W1 · Road width and scale consistency — ✅ **DONE 2026-08-27**

**What was actually wrong, measured before anything was written:**
1. `getWidth()` read `tags.width` first — but `pbfHighways.js` KEEP_TAGS never included `width`, so
   the tag was stripped before the bake could see it. **That branch had never once fired.** (4.41%
   of drivable ways carry it, median 5.5 m.)
2. Its `WIDTH_BY_TYPE` fallback was unreachable too — it fires only when `lanes` is null, and
   `getLanes()` always returns ≥ 1.
3. So every width in the city was `clamp(lanes × 3.5, 4, 20)`. Read off the shipped tiles: **73% of
   residential, 99% of living_street, 97% of service and 100% of footway/pedestrian/steps sat at
   exactly 4 m** — the MIN_WIDTH clamp, applied to things that are not carriageways. Against an
   Eixample archetype of a 10 m roadway in a 20 m corridor. **The road never "seemed short" — it
   was a third of its width.**

**What shipped:** `backend/worldBuilder/roads/roadWidthModel.js` — ONE model, derived from lane count
and class per Norma 8.2-IC, with the OSM tag as a **bound** rather than a source (a tagged 5.5 m
Gràcia street caps the section; a tagged 25 m one is inert). It emits a named SECTION, baked into the
v10 tile, so nothing downstream re-derives anything:

    |<------------------------- corridorW ------------------------->|
    |         |<------------- kerbToKerbW ------------->|           |
    |         |      |<----- carriagewayW ----->|       |           |
    | sidewalk | park |  lane  |  lane  |  lane | park  | sidewalk  |

**Ten width tables deleted** (nine, plus a fourth "mirror of roadRenderer" copy found inside
`vegetationWorker.js`). The frontend reads `map/roadWidths.js`, which reads baked fields and falls
back to a table that `test/roadWidths.test.js` re-derives from the model — the anti-drift guard that
three "mirror of roadRenderer" comments failed to be. It caught a hand-typed error on its first run.

**Measured result, baked (Eixample, 1,512 roads, 0 missing the section):**

| type | old paved | new paved | new corridor |
|---|---|---|---|
| residential | 4 m | **10.4 m** | 16.4 m |
| tertiary | 7 m | **10.4 m** | 16.4 m |
| secondary | 10.5 m | **14.15 m** | 21.15 m |
| footway | 4 m | **2 m** | — |
| steps | 4 m | **1.5 m** | — |
| living_street | 4 m | 4 m (correct — shared surface) | — |

⚠ **The drawn ribbon is `kerbToKerbW`, not `carriagewayW`.** A parking bay is asphalt. Drawing the
carriageway leaves a strip of bare terrain where every street's parking lane should be.

### R-J1 · Junction and merge geometry — ✅ **DONE 2026-08-27**

**The ticket's premise was stale, and measuring it first is what found the real bug.** R-J1 said
"carriageways are drawn independently, so merges and forks overlap rather than blending". All three
of its wanted items were already built. This is the third ticket in two days to die on
re-measurement (M1, R-P1, R-B2's framing) — and, like R-B1, it had a working implementation nobody
had checked for.

**What was already there, measured on the shipped v10 tiles:**

| wanted | state | measured |
|---|---|---|
| tapers where a slip road joins | **built, and TWICE** | gore geometry runs bake → binary → parser → `buildGoreMeshes`. 492 of 486 distinct merge nodes carry one; only **12 drivable nodes** city-wide have none |
| Eixample chamfer | **built** | `isChamferEligibleJunction` + `chamferPolygonVertices`, plus chamfer sidewalks and kerbs. 2,233 junctions eligible |
| no step where widths differ | **built** | a 20 m smoothstep width taper. 2,956 in-tile endpoint clusters step in width; every one of them tapers |

**The real defect, which the premise hid.** Junction enrichment in `buildRegion.js` built its
`wayId → width` lookup from `subset` — the spatial query for the CURRENT tile. But a junction is
kept if it lands within 30 m of the tile, so its arms routinely belong to ways whose bbox never
intersects that tile. Every one of those hit a `?? 6` fallback:

| | before | after |
|---|---|---|
| approach widths fabricated at 6 m | **5,454 / 35,386 (15.4%)** | **~0** (region-wide lookup) |
| junctions with a wrong `radius` | **2,278 / 11,101 (20.5%)** | — |
| ↳ of those, exactly the 6 m fallback | 2,226 (97.7%) | — |
| worst single error | baked r=6 against a true 22 m (residential/residential/primary) | — |

`radius` and `approaches` are the *only* thing the baked junction record is read for, and all four
consumers take both: the chamfer fill, its sidewalk, its kerb, and gore eligibility. Effect on
screen: **33 chamfers missing entirely** (radius fell under the ≥ 8 m gate) and **327 drawn with the
wrong polygon** — median vertex error 2.2 m, worst 12.2 m. The same per-tile lookup also explains
48 of the 83 missing gores.

**Fix:** one region-wide `wayWidthById` built before the tile loop, from `simplified`. A width is a
property of the WAY, not of the tile that happens to be looking at it. The bake now prints
`[Junctions] approach widths: N/M resolved …` (D-23 proof-of-work) so a silent regression is
visible; a non-zero residual means a way the junction graph knows about but the road pipeline
dropped.

**Second finding — the taper exists twice.** `roadBaker.js` (bake, 260 of 433 tiles) and
`roadRenderer.js` (runtime, the other 173) each carry their own copy of `buildJunctionWidthMap` +
`computeTaperedWidths`. They agree today; nothing made them. That is exactly the R-W1 situation —
and note the split is by TILE, so the same street tapers through one path or the other depending
only on where the tile grid fell. Guarded by `frontend/test/widthTaper.test.js`, which runs both
against the real Barcelona width steps and fails on any divergence.

**Left open, deliberately — a judgement call, not a defect.** The taper flares the NARROW arm up to
the wider neighbour over 20 m. R-W1 took residential from 4 m to 10.4 m, which created **219 nodes
where a 4 m `living_street` now balloons 2.6× at its mouth**. A real kerb flare is ~5 m, not 20.
Nothing is broken and it has not been looked at on screen; if alley mouths read as funnels, the
fix is a per-class taper length, not a change to the widths.

### R-J3 · The junction clip was eating the pavement — ✅ **FIXED 2026-08-27**

**Reported from the driver's seat:** bare green terrain along kerb lines and around corners, and
pavement appearing "where it shouldn't". Both are the same bug seen from two sides — the pavement
was being clipped so far back from every junction that what survived read as stranded fragments,
and the strip between the asphalt and the buildings had nothing drawn in it at all.

**TWO COMPOUNDING GEOMETRY ERRORS**, in `buildSidewalks`/`buildCurbs` and their bake twin:

1. **Full width where a half was meant.** `junctionClipRadius` returns the widest paved width at the
   node as the along-road clip depth. The kerb the pavement must stop at is **half** a width from
   the node. R-J2 had already worked this out for tees (`teeWidth / 2 + 1.5`) and fixed only that
   branch; the crossroads branch kept the doubled value.
2. **A sum where a hypotenuse was meant.** `clipPolylineNearJunctions` measures distance to the
   node, so the clip is a **circle**. The pavement runs `offset` to the side of the centreline, and
   a circle of radius `R` meets it at `√(R² − offset²)`, not at `R`. Both call sites used
   `depth + offset`, which cuts at `√(depth² + 2·depth·offset)` — always further out than intended.

For an Eixample crossroads (14.15 m secondaries, 3.5 m pavements) the two together cut **21.3 m**
of pavement per arm where **8.6 m** is correct.

**Measured over the shipped v10 tiles, 10,713 roads that should carry a pavement:**

| | before | after |
|---|---|---|
| pavement cut per road (both ends), median | **21.4 m** | **9.7 m** |
| roads whose pavement is clipped away **entirely** | **1,669 (15.6%)** | **578 (5.4%)** |
| kerb line restored city-wide | — | **≈138 km** |

**Fix:** `junctionApronDepth()` (half the paved width + the 1.5 m kerb allowance, for tee and
crossroads alike) and `offsetClipRadius(depth, offset)` = `hypot(depth, offset)`, replacing
`junctionClipRadius(...) + offset` at both the pavement and the kerb call sites.

**This is a THIRD copy-pair.** The logic lives in `roadRenderer.js` (runtime ribbon path, 173 of
433 tiles) and `sidewalkBaker.js` (bake path, the other 260) — and **the bake half had never
received R-J2's tee fix at all**, so it over-clipped every tee in the city for a whole session while
the runtime did not. `frontend/test/sidewalkClip.test.js` (7 tests) now pins the two together.

> ⚠ **This supersedes a decisions-log entry.** 2026-05-29 recorded "`junction.radius` = max road
> width at junction = clip-zone depth on each approach". That was calibrated when a residential road
> was **4 m** wide, so the rule cost ~4 m of pavement; R-W1 made the same road **10.4 m** and the
> identical rule started costing ~21 m. The decision was not wrong when written — its units moved
> under it. **Lane paint deliberately keeps the old rule**: over-clipping paint shortens a line, it
> does not expose terrain.

### R-J4 · A pavement may not lie ON a carriageway — ✅ **FIXED 2026-08-27**

**Reported:** "some roads got sidewalks which looks bad, on the left it's covering the road almost."

**Cause.** Every road with a pavement emits a ribbon at `half + curb + swW/2` to each side, and
nothing ever checked whether that lands on a **different** road. On a boulevard with lateral service
roads — Gran Via is the canonical case — the lateral's pavement lands squarely on the main
carriageway. It then draws **on top of it**, because `GROUND_LAYERS.sidewalk` (-6) deliberately beats
`road` (-4): the asphalt loses the depth test to a pavement that should not be there at all.

| measured on the shipped v10 tiles | |
|---|---|
| pavement vertices inside a live carriageway | **14.3%** |
| ↳ deeper than 0.5 m | **4.0%** |
| ↳ deeper than 1 m | 2.4% |
| worst penetration | **5.55 m** |

**Why the existing clamp did not do it.** `clampSidewalkVerticesOutsideRoads` pushes offending
VERTICES sideways to the kerb line, and it is the wrong tool twice: it moves vertices only, so a
triangle EDGE still crosses the asphalt; and where a pavement genuinely runs down the middle of an
avenue, shoving its vertices to the edge yields a **squashed, distorted ribbon** rather than removing
something that does not exist in the real street. That distortion is itself what reads as a
"z-index" artifact. It is kept as the final centimetre-level tidy.

**Fix.** `buildCarriagewayGrid()` + `clipRunOutsideCarriageways()` — the same rule
`roads/pathCoverageClipper.js` already applies to footpaths at bake Phase 1, one level out. Two
details that are load-bearing:

- **`selfId` exempts the pavement's own road.** A pavement is *supposed* to abut its own kerb;
  without the exemption, inflating the test would delete every legitimate pavement in the city. It
  earns its keep on curves, where the inside-of-bend offset swings toward its own centreline.
- **`extra` inflates by half the ribbon's width**, because the test runs on the CENTRELINE while the
  surface reaches either side of it. Centreline-only still left the inner edge on the asphalt.

**Result (tile 16_33161_24477):** vertices >0.5 m inside a carriageway **4.0% → 1.65%**, worst
**5.55 m → 1.19 m**. The residual is miter overshoot at sharp bends.

> ⚠ **The clip must REMOVE, never densify.** The obvious implementation — resample at a fixed step,
> keep the uncovered samples — took the baked pavement from **1,968 to 20,670** position floats on
> one tile, a 10× geometry cost for a clip. Sampling is used to FIND transitions; the run is rebuilt
> from the source vertices plus the boundary points.

**This is the third copy-pair** (`sidewalkBaker.js` bakes 207 of 433 tiles, `roadRenderer.js`
generates the rest). Pinned by `frontend/test/sidewalkClip.test.js`, which caught a real divergence
on its first run: the two `buildCarriagewayGrid`s returned different SHAPES (object vs function).

### R-J5 · Every road near a tile edge was drawn TWICE — ✅ **FIXED 2026-08-27**

**The unified cause of three separate user reports**: "roads look darker in places", "z-index issues
on roads", and "sidewalks coming too wide". Found with `window._ddPick()`, which returned
**`sidewalk` twice and the road twice at identical world coordinates**.

**Cause.** The bake runs `noClipTileStrategy: true` — *"write full way geometry for each road. No
clipping, no splitting. Ways may exist in multiple tiles when bbox intersects. Guarantees continuous
roads."* That is the right call for the DATA (topology, physics, the road graph) and the wrong one
for the PICTURE, because every tile then draws its neighbours' roads on top of theirs.

| measured over the shipped v10 tiles | |
|---|---|
| ways written into more than one tile | **5,308 of 38,813 (13.7%)** |
| road centreline DRAWN across all tiles | **4,146 km** |
| road centreline if each way were drawn once | **2,578 km** |
| **duplicate geometry** | **37.8% of everything drawn** |

**Why the duplicates are VISIBLE and not merely wasteful.** Two identical coplanar copies would
show nothing. These differ: `createAoSampler` **clamps** its lookup to its own grid, and **24.6% of
road vertices are drawn outside their own tile's AO grid** (median 24.4%, p90 43%). Those vertices
take the AO of the tile EDGE, while the neighbouring tile that properly contains them computes the
true value. Two coplanar surfaces carrying different AO fight for the depth test — which copy wins
varies per pixel and per camera angle. The pavement compounds it: each tile generates its own from
its own road subset, with its own tapers and its own junction set, so two near-identical pavements
read as one wider, messier band.

**Fix.** `payload.renderRoads` — the tile's roads clipped to its own bounds, used ONLY by
`bakeRoadSurfaces` and `bakeSidewalks`. `payload.roads` stays whole, so the continuity guarantee
`noClipTileStrategy` exists for is untouched. **Rendering needs COVERAGE, not duplication.** The
clip is `clipRoadsForTile` — the same routine the non-no-clip path already used, so this is reuse,
not a new clipper. `renderRoads` is never written to the binary. The bake prints
`[RenderClip] road records: N rendered / M carried …` (D-23 proof-of-work): a ratio of 1.00 means
the clip has stopped firing and every tile is drawing its neighbours again.

> **This did not require reverting `noClipTileStrategy`.** The strategy's stated goal is continuous
> road DATA; it was only ever the RENDER that needed clipping. Both are now true at once.

### R-B1 · Edge protection by RULE, not by tag
**Today:** `pbfBarriers.js` parses `barrier=guard_rail|wall|fence|hedge|retaining_wall` and
`barrierRenderer.js` draws them — but ONLY where OSM tagged them. `crashBarrierRenderer` was deleted
in v3 P1-16. So an elevated ramp with no OSM barrier tag has no edge at all, which is why some
flyovers have railings and some do not.
**Wanted:** infer protection from the road's own state — `bridge=yes`, a ramp, or any carriageway
whose deck sits more than ~1 m above the terrain beside it needs an edge. The elevation data to
decide this already exists per-vertex; nothing consults it.
**Note:** this is the same "drivable surface implies a floor" reasoning as the tunnel validator, one
level up: **a drivable surface above ground implies an edge**.

> **R-B1 PROGRESS 2026-08-27 — the DEM inference is a NO-OP, and the real work is elsewhere.**
> First bake of the rule: `47 bridge decks, 0 elevated runs, 0 ramps -> 203 vertices need an edge`.
>
> The height-based half cannot fire, for a reason the P-R1b work had already established and this
> design missed: **road height is DERIVED from the layer tag, not measured.** `pbfHighways` sets
> `bridge = bridgeTag || layer > 0`, so any road whose deck sits above the terrain already carries
> `bridge: true` and is caught by the tag branch before the DEM test runs. And surface roads are
> fitted to the DEM, so `deck − terrain ≈ 0` by construction — which is exactly why the V5 detector
> found zero conflicts against `demSampler`. There is no independent height signal to infer from.
>
> **So the ticket was mis-scoped: the hard part is not deciding WHERE, it is DRAWING.** The user's
> report — "some flyovers have railings and some don't" — is fully explained by
> `barrierRenderer.js` only drawing OSM-tagged `barrier=*` ways. The classification needed to fix it
> already exists and is trivial: **47 bridge decks, plus ramps.** Rendering an edge on all of them
> closes the complaint without any inference at all.
>
> A genuine inference case does remain, but it is **M1_implied_bridge** from the §2 taxonomy, and it
> is TOPOLOGICAL not vertical: a road crossing over water, rail or another way at a different layer
> with no bridge tag. That needs 2D crossing tests, not a DEM comparison. Re-file as its own ticket
> rather than smuggling it into R-B1.

> **R-B1 CLOSED 2026-08-27 — ALREADY IMPLEMENTED. The real defect is upstream classification.**
>
> `roadRenderer.js:isElevatedGuardRailRoad` already gates railings on
> `bridge || isRamp || layer > 0 || crossesTrench || (link && elevated)` — precisely the inference
> this ticket proposed to build. Railings have never been OSM-barrier-driven. Writing R-B1 would
> have duplicated a working system.
>
> The gaps the user sees have a different cause, and it is measurable:
>
> | | segments | share |
> |---|---|---|
> | tunnel | 1,044 | 1.94% |
> | isRamp | 842 | 1.56% |
> | **bridge** | **63** | **0.12%** |
> | layer > 0 | 63 | (the same set — `bridge = bridgeTag \|\| layer > 0`) |
>
> **63 bridge segments in the whole of Barcelona**, against 1,044 tunnel segments. The city has the
> Ronda de Dalt, the Ronda Litoral and the Glòries interchange. Elevated structure is not
> under-*rendered*, it is under-**classified** — the gate cannot fire on a road nobody knows is
> elevated, and that same road also gets no layer offset, so it sits flat on the ground.
>
> **This is `M1_implied_bridge`** from the defect taxonomy (`osm-repair-layer.md` §2), and it now has
> two independent symptoms pointing at it: missing railings, and part of the measured 4.9% of drivable
> road points floating. Detection is TOPOLOGICAL — a way crossing water, rail or another way at a
> different layer with no bridge tag — so it belongs with the repair layer, not here.
>
> **Do not re-open R-B1.** Re-file the work as M1 detection.

### R-B2 · Barrier TYPE selection
**Today:** nothing selects a type; the deleted renderer drew one style.
**Wanted:** the right object for the context — concrete (New Jersey) barrier on fast dual
carriageways and central reservations, metal guardrail on rural/elevated single carriageways, a solid
parapet on a bridge deck, kerb-only in a 30 km/h zone. Barcelona uses all four and the difference is
legible at driving speed.
**Measured 2026-08-27, before any of this is built:**
- Both rail materials were **`MeshBasicMaterial` — unlit**, the same fault the shop signs had. Fixed
  to Lambert (no extra draw call; still one merged mesh per tile). Galvanized steel in particular is
  a material whose entire read is a sheen changing along its length; unlit it is a grey stick.
- **Cost:** posts every `RAILING_POST_SPACING` = 3.0 m, each a full box, both sides. That is ~1,656
  triangles per 100 m of guarded road. Across 658 guarded segments it is not free, and posts are the
  whole of it — the wall is one box.
- **Both materials are `DoubleSide`.** Every piece is a closed box, so the back faces are pure waste,
  but flipping to FrontSide needs the winding verified first (P3-03 did this for buildings). Cheap
  win, not free to assume.
- **The obvious LOD is missing:** posts are drawn individually at every distance. Past ~80 m the
  posts are sub-pixel and only the beam line reads — dropping to beam-only there would remove most
  of the triangle count with no visible change. Nothing currently varies with distance.

**Depends:** R-B1 places them; this decides what they are. Art-bible palette applies — the recorded
mistake to avoid is eyeballed hex, which failed gate 4 on six of eight shop-sign colours.

### R-0 · THE DECISION THAT GOVERNS ALL FOUR — synthesise, deterministically, before the tile split

**This data does not exist in OSM and never will.** OSM will not tell us that a particular ramp needs
a guardrail, that this carriageway is 7.0 m kerb-to-kerb, or that a central reservation wants concrete
rather than steel. A handful of ways are tagged; the rest never will be, because mapping that is not
what OSM is for. So the game must **understand the road and decide for itself** — the tags are an
override, not the source.

Two properties are non-negotiable, and they are what make this hard rather than tedious:

**1. It must be CONSISTENT.** The same road must get the same treatment on every bake and every load,
and two roads that look alike to a driver must be treated alike. That rules out anything random or
order-dependent: every rule seeds from stable inputs (way id, position, class, geometry) so it is
reproducible. A guardrail that exists on Tuesday and not on Wednesday is worse than no guardrail,
because it cannot be reasoned about or tested.

**2. It must be decided BEFORE the tile split, on the whole way.** ⚠ This is the trap. `tileSplit.js`
cuts each way into per-tile segments, and a long viaduct crosses several tiles. Decide "does this need
a railing" per tile and the two halves can disagree — the railing stops dead at a tile seam, or
changes from steel to concrete mid-span. The way is the unit of meaning; the tile is only a delivery
container. **Anything inferred about a road must be attached to the WAY, before it is cut up.**

The same reasoning applies to width (a carriageway that changes width at a seam is a visible step) and
to junctions (a merge whose two arms land in different tiles).

**Bake or runtime?** Bake, for these four. It is deterministic by construction, it is where the whole
way still exists, and it can be inspected offline — the defect census proved how much that is worth.
The costs are honest: it adds tile payload and every rule change needs a re-bake. Runtime inference is
the right home only for things that depend on state the bake cannot know (time of day, the player),
and none of these do.

> **Precedent, from this repo, on 2026-08-27.** Three vegetation bugs shipped that were all this exact
> class of failure: zone trees ordered per-polygon while the renderer assumed nearest-first; an
> impostor ramp that disagreed with the 3D fade it was supposed to complement; and an LOD invalidation
> that ran before the data it governed existed. None threw an error. Each produced something that
> looked almost right and behaved inconsistently as the viewer moved. Inference rules fail the same
> way, and only determinism plus a test makes them safe.

### R-P1 · FALL-THROUGH — generalise drivable-surface-implies-floor beyond tunnels · ✅ MEASURED 2026-08-27

**Symptom (user):** "there are roads in some places from where I fall."

**The invariant already exists and is commit-blocking — but only for tunnels.**
`backend/worldBuilder/terrain/validateTunnelFloors.js` asserts that every drivable **tunnel** road
(`layer < 0` whitelist), sampled at 2 m, has carved grid within tolerance of `roadY − 0.15`. It
throws and fails the bake. Nothing applies the same test to a **surface or elevated** road.

**⚠ MEASURED 2026-08-27 — THE PREMISE NO LONGER HOLDS. The surface half of the validator shipped in
report mode and the census says the floating roads are gone.**

The ticket was written on P-R1b's figure of **4.9% of drivable road points above the shipped terrain,
worst 24 m**, and explicitly anticipated this: *"Fixing the heights may close most of this on its own,
so measure before writing repair logic."* It did. Full-region bake, **357,178 samples at 2 m spacing,
drop range −3.22 … 2.21 m**:

| drop above the collider | samples | roads | share |
|---|---|---|---|
| > 0.5 m | 1,720 | 147 | 0.48% |
| > 1 m | 339 | 33 | 0.09% |
| > 2 m | 4 | **1** | 0.00% |
| > 5 m | **0** | 0 | — |

The worst road in the city is **2.2 m**, on `34099200` — which this validator's own header already
names as one of the two known pre-existing native-dip roads. **Nothing is 24 m in the air any more,
and 2.2 m is a bump, not a fall-through.** The terrain rework (Phases 0–2) closed it.

So the render symptom is fixed and the physics symptom has no systemic cause left in this data. If
the car still falls somewhere, it is a LOCAL defect — a missing collider at a tile seam, or a trench
deck — and it needs a location: **note the `?spawn=lat,lon` where it happens.** The census stays in
the bake as the regression guard, with the table above as the baseline.

**Scope:** extend the validator from `layer < 0` to **every drivable road**, and make its tolerance
the thing the wheels actually rest on — the Heightfield sample, not the DEM. Then the bake cannot
ship a drivable surface with nothing under it, in either direction. It is the same reasoning as
R-B1's "a drivable surface above the ground implies an EDGE", one step further: *a drivable surface
implies a FLOOR, wherever it is.*

**Depends:** the P-R1b floating-road cause. Fixing the heights may close most of this on its own, so
**measure before writing repair logic** — the count of drivable points with no collider within
tolerance is the number that says whether this is a handful of spots or systemic.

⚠ Do NOT widen the tunnel validator's whitelist casually: it is commit-blocking, so a
false positive fails the whole bake. Land it as `TRENCH_VALIDATOR=report` first and read the count.

### R-V1 · Parked cars, road width, and who owns the kerb line — NEW TICKET 2026-08-27

**Symptom the user reported:** cars parked ON the guard rails, and the road "seeming short".

**Cause, and it is R-W1 wearing a different hat.** Both systems derive their offset from
`road.width` and disagree about what it means:
- `guardRailWidth()` puts the rail at `halfW` — width as the **carriageway edge**
- `parkedCars.computeSegMeta()` puts cars at `halfW - 0.2` — width as **including the parking lane**

Twenty centimetres apart, so the cars land on the barrier. Neither is wrong in isolation; the width
model is ambiguous and nothing arbitrates it. **Fixed for the physical case only** — no street
parking on a bridge, ramp, or `layer > 0` carriageway, gated on the same booleans the rail gate
leads with so the two can never disagree about a road they both act on.

**Resolved 2026-08-27 by R-W1.** The bake now emits a parking BAY (a width and a side) and puts the
kerb outside it by construction; `test/roadWidths.test.js` asserts the bay's outer edge never passes
`kerbOffset()`, for every road class, so this specific bug cannot return silently. The physical gate
(no parking on a bridge/ramp/elevated deck/tunnel) stays and is now load-bearing for the first time —
it had been reading four fields that `getLoadedRoadSegments` never copied (D-42).

**Also in scope (user, 2026-08-27):** traffic and parked-car *density and placement* should follow
road class. See `v3-execution-tracker.md` **P4-15a** for the engineering half of vehicles.

> **Sequencing:** ~~R-W1 →~~ ~~R-J1~~ both DONE 2026-08-27. ~~R-B1~~ closed as already-implemented;
> its real content re-filed as **M1_implied_bridge** (topological, belongs with the OSM repair
> layer — see `osm-repair-layer.md` §2). **R-B2 is all that is left of this programme**, and its own
> row warns it is a FEATURE, not a defect: there are currently zero sharp-bend barriers and nothing
> is wrong on screen. Read that row before scheduling it.
>
> **Three of this programme's four tickets died on re-measurement.** R-W1 was the only one whose
> premise survived contact with the shipped tiles. The pattern is consistent enough to plan around:
> these tickets were written from reading the code, and the code had moved.
