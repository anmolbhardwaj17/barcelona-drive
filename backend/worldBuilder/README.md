# World Builder

OSM PBF + DEM → static slippy tiles (tile format v5). Output: `tiles/{regionName}/{z}/{x}/{y}.json`.

## Pipeline (geometry-aware bake)

1. **Parse PBF** — Highways (roads) from OSM; filter to drivable types.
2. **Load DEM** — GeoTIFF tiles; sample elevation at (lat, lon).
3. **Attach elevation (raw)** — For each road point: sample DEM → store `[x, yUp, z, terrainHeight]`. Bridge/tunnel get initial offset; final ramps applied later.
4. **Simplify** — Douglas–Peucker in (x, z) plane; preserves elevation on kept vertices.
5. **Resample** — Uniform spacing along each road (default 2 m) for consistent segment density; interpolate all components.
6. **ElevationProcessor** — Smooth DEM noise along road; bridge ramp in/out over configurable distance; tunnel smooth descent/ascent. Output: final road centerline elevations.
7. **Split by tile** — Clip roads to tile bounds (mercator); preserve 4th component for elevation array in tile JSON.
8. **Buildings / Greens** — Parse and split by tile (unchanged).
9. **Per-tile write** — For each tile: (a) Sample DEM to 128×128 grid; (b) **TerrainModifier**: flatten under layer=0 roads, carve tunnels; (c) Build payload (elevation = modified grid, roads, buildings, greens); (d) Write JSON.

Terrain modification is done in a separate step before building the payload; the write loop only reads the precomputed grid.

## Config (REGION_CONFIG + bake options)

- **Paths / region:** `name`, `pbfPath`, `demPaths`, `bbox`, `zoom`
- **Roads:** `simplifyTolerance`, `resampleSpacing` (default 2), `bridgeHeightPerLayer`, `tunnelDepth`
- **ElevationProcessor:** `elevationSmoothWindow`, `bridgeRampDistance`, `tunnelRampDistance`
- **TerrainModifier:** `flattenInfluenceRadius`, `shoulderWidth`, `tunnelCarveWidth`, `tunnelCarveFalloff`

## Modules

- **roads/roadResampler.js** — Resample polyline at fixed spacing; interpolate x, yUp, z, terrainHeight.
- **roads/elevationProcessor.js** — Smooth elevation; bridge/tunnel ramp transitions (smoothstep/cubic).
- **terrain/terrainModifier.js** — Per-tile: flatten under ground roads (layer 0), carve tunnels; returns modified 128×128 grid.

Buildings and greens are not modified by the geometry pipeline.
