/**
 * Barcelona road system — cross-cutting constants.
 *
 * ⚠ v3 P1-26: colours that describe the CITY rather than the road standard now live in
 * `src/regions/barcelona.js` and are re-exported here so the ~2 existing importers are unchanged.
 * When adding a second city, move values here that would DIFFER (paint colour, kerb stone, surface
 * tints) into the region profile; keep values that are fixed by the road STANDARD (Norma 8.2-IC
 * line widths, crosswalk stripe geometry) — those are law, not art direction.
 * Single source of truth for all colors and dimensions.
 * Standard: Norma 8.2-IC (Instrucción de Carreteras 8.2-IC, Marcas Viales).
 *
 * Import in any renderer that touches road visuals. Do NOT inline magic numbers.
 * See docs/context/barcelona-road-system.md Section 4 for full reference.
 */

import { REGION } from '../regions/index.js';

/** Road and marking colors (hex, Three.js compatible). */
export const BCN_COLORS = {
  PAINT_WHITE:      0xf5f5f5,   // All longitudinal lines (Norma 8.2-IC — Spain uses white only)
  PAINT_YELLOW:     0xf5d000,   // No-parking curb stripe (Phase 4)
  PAINT_BLUE:       0x0066b3,   // Regulated parking stripe (Phase 4)
  PAINT_BIKE_GREEN: 0x3f9f4f,   // Carril bici surface (Phase 3)
  SIDEWALK_PANOT:   REGION.palette.panot,        // v3 P1-26: from the region profile
  CURB_GRANITE:     REGION.palette.graniteKerb,  // v3 P1-26: from the region profile
  ASPHALT_BASE:     REGION.palette.asphalt,      // v3 P1-26: from the region profile
  TRAM_RAIL_STEEL:  0x8a8a8a,   // Embedded tram rail (Phase 4)
};

/** Road marking dimensions in metres (Norma 8.2-IC). */
export const BCN_DIMS = {
  // Longitudinal lines
  LINE_WIDTH_LONGITUDINAL: 0.10,   // All continuous and dashed longitudinal lines
  LINE_WIDTH_STOP:         0.40,   // Transverse stop line

  // Crosswalk (paso de cebra)
  CROSSWALK_STRIPE_WIDTH:  0.50,   // Each white stripe width (road direction)
  CROSSWALK_STRIPE_GAP:    0.50,   // Gap between stripes

  // Dashes — urban (≤50 km/h)
  DASH_LENGTH_URBAN:       2.0,
  DASH_GAP_URBAN:          2.0,

  // Dashes — interurban / highway (>50 km/h)
  DASH_LENGTH_HIGHWAY:     4.0,
  DASH_GAP_HIGHWAY:        12.0,

  // Sidewalk (Phase 3)
  SIDEWALK_WIDTH_EIXAMPLE:  5.0,
  SIDEWALK_WIDTH_NARROW:    2.5,
  SIDEWALK_WIDTH_BOULEVARD: 8.0,

  // Curb (Phase 3)
  CURB_WIDTH:   0.30,
  CURB_HEIGHT:  0.12,

  // Bike lane (Phase 3)
  BIKE_LANE_WIDTH_ONEWAY: 2.0,
  BIKE_LANE_WIDTH_TWOWAY: 4.0,
  BIKE_PICTOGRAM_SPACING: 30.0,

  // Tram (Phase 4)
  TRAM_GAUGE:      1.435,
  TRAM_RAIL_WIDTH: 0.04,

  // Panot sidewalk tile (Phase 3)
  PANOT_TILE_SIZE: 0.20,

  // Chamfered Eixample corner (Phase 4)
  CHAMFER_LENGTH: 20.0,

  // Tunnel approach ramp terrain cut margin (Phase 4 tunnel overhaul)
  // Extra width beyond road half-width excluded from terrain mesh.
  // 2.5m gives clearance for 0.4m retaining walls + geometry margin.
  APPROACH_RAMP_CUT_MARGIN: 2.5,
};
