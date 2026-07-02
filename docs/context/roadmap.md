# Roadmap — Backlog Features

Features that have been deliberately deferred. Do NOT bake, do NOT add parsers yet. Each item notes why it's deferred and what decision needs to be made before implementing.

---

## Barcelona Enrichment Backlog

### Water Rendering Quality (needs re-bake)

| Item | What to fix | Files | Notes |
|---|---|---|---|
| **Fix bufferPolyline self-intersections** | Replace `bufferPolyline()` in `waterNormalize.js` with a proper offset-polygon algorithm. Current implementation uses simple per-vertex normal averaging; at sharp bends the left/right ribbon sides cross each other, filling unexpected triangular areas. Correct approach: round join (arc between offset rays at convex vertices) and miter-limit join at concave vertices. Can use `jsts` (Java Topology Suite JS port) `BufferOp`, or hand-roll a Minkowski sum offset. After fix, remove the `RENDER_OPEN_WATER_AS_POLYGONS: false` workaround. | `backend/worldBuilder/waterNormalize.js` | Re-bake required. Low priority until a scheduled re-bake. |
| **OSM coastline assembly** | Implement proper coastline polygon using the right-hand rule (water on right of travel direction). Current hack: coastline features filtered entirely. Correct: trace all coastline ways in a tile, close via tile boundary on seaward side, produce a closed sea polygon. | `backend/worldBuilder/waterNormalize.js` or new `coastlineAssembler.js` | Re-bake required. Restores open-ocean rendering. |

---

### In-Tiles (needs parser + binary section + renderer)

| Feature | OSM Tags | Notes |
|---|---|---|
| Bicycle infrastructure | `cycleway:*`, `bicycle_road=yes`, `cycleway=lane` on highway ways | Needs renderer decision: overlay on road mesh or separate geometry? |
| Cable car / aerial tramway | `aerialway=cable_car`, `aerialway=gondola` | Montjuïc Transbordador Aeri crosses the bbox. Needs new geometry type (line + poles + cabin). |
| Superblocks | `traffic_calming=island`, `traffic_calming=table` | Barcelona-specific urban design. Needs renderer + physics for raised surfaces. |
| Speed bumps | `traffic_calming=bump`, `traffic_calming=hump` | Needs physics integration — not just visual. Coordinate with physics team before baking. |

### Runtime-State (do NOT bake — data changes every few seconds)

| Feature | Notes |
|---|---|
| Working traffic signal cycles | Signal timing is runtime state (red/yellow/green cycle). The baked `trafficSignals` gives positions; the cycle logic runs in the game loop. See `roadInfraRenderer.js` for the existing cycle system. |
| Real-time transit positions | Bus/metro positions require live API. Not bake-able. |

### Deferred Rendering (data is baked in v7 tiles, renderer not yet built)

These feature types are **already in the v7 tile binary** and available in `tileParserWorker` output. They just have no renderer yet.

| Feature | Tile field | Priority |
|---|---|---|
| Beaches | `tile.beaches[]` | High — visual impact, coastline identity |
| Pedestrian areas | `tile.pedestrianAreas[]` | Medium — La Rambla, Gothic Quarter plazas |
| Marinas / docks | `tile.marinas[]` | Medium — Port Olímpic |
| Traffic signals | `tile.trafficSignals[]` | Low (existing procedural system covers most) |
| Street lamps | `tile.streetLamps[]` | Low (existing procedural system covers most) |
| Individual trees | `tile.trees[]` | Medium — supplement procedural trees in Eixample |
| Tourism POIs | `tile.tourismPois[]` | High — landmark markers, UI map |
| Metro stations | `tile.metroStations[]` | High — UI map, underground entrances |
| Healthcare | `tile.healthcare[]` | Low |
| Shops | `tile.shops[]` | Medium — storefront coloring, UI map |
| Roundabouts | `road.isRoundabout` (bool on roads) | Medium — circular road surface rendering |

---

## Architecture Decisions Needed Before Implementation

**Bicycle lanes**: Should they render as painted road markings (overlay on existing road mesh) or as separate geometry with their own collision? Collision matters for physics-based gameplay.

**Cable car**: Requires animating a cabin along a Bezier path between poles. No animation system exists yet.

**Speed bumps**: Would need terrain modifier logic (raise DEM elevation in a small zone) or physics-side trigger volumes. Confirm approach before baking.

**Individual trees vs procedural trees**: When both OSM-explicit (`tile.trees[]`) and procedural trees (from `bakeVegetation`) exist for a tile, should the renderer show both (density doubled), only OSM, or use OSM as a mask? Decide before building the tree renderer.

**Shops UI**: 2000+ shops per dense Eixample tile is a lot for 3D geometry. Recommended approach: billboards at render time + minimap markers. No 3D models needed for all shops.
