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
