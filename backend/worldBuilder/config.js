/**
 * Region-based config for world builder.
 * Paths are resolved relative to this file (backend/worldBuilder/).
 * Expected layout (matches Delhi convention — flat, no subfolder):
 *   data/regions/barcelona/region.osm.pbf
 *   data/regions/barcelona/N41E002_DEM.tif   ← SRTM GL1 from OpenTopography
 */
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGION_ROOT = path.join(__dirname, '..', '..', 'data', 'regions', 'barcelona');

export const REGION_CONFIG = {
  name: 'barcelona',
  pbfPath: path.join(REGION_ROOT, 'region.osm.pbf'),

  // ── Bounding box ─────────────────────────────────────────────────────────
  // Covers: Montjuïc (elevation), Eixample grid, Sagrada Família, Barceloneta
  // coastline, Port Olímpic, Ronda Litoral, Diagonal Mar / Forum, Camp Nou.
  // Approximately 8.6 km × 6.1 km ≈ 250 tiles at zoom 16.
  bbox: {
    minLon: 2.1198,
    minLat: 41.3580,
    maxLon: 2.2230,
    maxLat: 41.4130,
  },

  zoom: 16,

  // ── DEM (real elevation) ──────────────────────────────────────────────────
  // SRTM GL1 (1 arc-second, ~23m×31m at Barcelona latitude) from OpenTopography.
  // Flat layout: same directory as region.osm.pbf — matches Delhi convention.
  // Coverage: lon 2.083→2.269, lat 41.330→41.467 — fully covers the bbox.
  // Elevation range in file: −12 m (sea) to 515 m (Tibidabo slopes).
  // NoData value: −32768 (standard SRTM; demLoader.js handles this correctly).
  demPaths: [
    path.join(REGION_ROOT, 'N41E002_DEM.tif'),
  ],

  // ── Pipeline flags ────────────────────────────────────────────────────────
  simplifyTolerance: 1.2,
  /** Real DEM terrain — requires demPaths to point at a valid GeoTIFF. */
  phase1Pure2D: false,
  cleanRoadPipeline: true,
  roadOnlyDebugMode: false,
  skipGreens: false,
  skipWater: false,
  includeAllHighways: true,
  stabilizeBaseSystem: false,

  // ── Road topology ─────────────────────────────────────────────────────────
  topologySnapTolerance: 0.5,
  nodeSnapDistance: 1,
  resampleSpacing: 2,
  noClipTileStrategy: true,
  roadGraphLayerMode: true,

  // ── Elevation ─────────────────────────────────────────────────────────────
  /** Bridge: height per layer unit (metres). Barcelona bridges use layer=+N. */
  bridgeHeightPerLayer: 6,
  /** Tunnel: depth below ground (metres). Montjuïc tunnel uses layer=-1. */
  tunnelDepth: 12,
  /** Bridge/tunnel ramp transition distances (metres). */
  bridgeRampDistance: 25,
  tunnelRampDistance: 35,

  /** Tile boundary margin (m) for road clipping seams. */
  tileBoundaryMargin: 0.5,

  // ── v7 feature extraction flags (bake-time kill switches, all default true) ──
  // Set any to false to skip that feature type from the bake entirely.
  // Useful for debugging a parser issue without re-baking everything else.
  bakeBeaches:          true,   // natural=beach|sand, landuse=beach
  bakePedestrianAreas:  true,   // highway=pedestrian|footway area=yes (closed rings)
  bakeMarinas:          true,   // leisure=marina, waterway=dock, man_made=pier
  bakeTrafficSignals:   true,   // highway=traffic_signals nodes
  bakeStreetLamps:      true,   // highway=street_lamp nodes
  bakeTrees:            true,   // natural=tree nodes
  bakeTourismPois:      true,   // tourism=*, historic=* nodes + way centroids
  bakeMetroStations:    true,   // railway=station + station=subway nodes
  bakeHealthcare:       true,   // amenity=hospital|clinic|doctors|dentist|pharmacy
  bakeShops:            true,   // shop=*, amenity=restaurant|cafe|bar|fast_food|pub

  // ── Quick-bake presets ────────────────────────────────────────────────────
  // Usage: node worldBuilder/buildRegion.js --area eixample
  testAreaPresets: {
    // Central Eixample around Sagrada Família — fast iteration target
    eixample: { minLon: 2.158, maxLon: 2.180, minLat: 41.386, maxLat: 41.406 },
    // Montjuïc + port — tests real elevation and coastline water
    montjuic: { minLon: 2.148, maxLon: 2.172, minLat: 41.352, maxLat: 41.385 },
    // Old Delhi preset preserved for reference (requires delhi PBF)
    // aiims: { minLon: 77.2, maxLon: 77.22, minLat: 28.56, maxLat: 28.58 },
  },
};
