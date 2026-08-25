/**
 * regions/barcelona.js — the Barcelona region profile (v3 P1-26).
 *
 * Everything the ENVIRONMENT'S LOOK depends on that is true of Barcelona specifically, rather than
 * of the engine. A second city is then a data file, not a refactor.
 *
 * ⚠ This is the ONLY implemented profile, and Barcelona is the only city we build. Do not author a
 * Delhi profile speculatively — the point is that adding one later costs a file, not a rewrite.
 * Delhi-era art removed from this build is archived at `art-src/delhi/` for exactly that day.
 */

export default {
  id: 'barcelona',
  name: 'Barcelona',

  /**
   * PALETTE ANCHORS — every authored asset is normalised toward these (art bible §2.4).
   *
   * ⚠ This is why the region profile had to exist BEFORE asset authoring rather than after. If the
   * palette ships as a global constant and ~100 assets are normalised against it, adding a region
   * axis later means re-normalising the entire library.
   *
   * Warm Mediterranean masonry, sun-bleached render, terracotta roofs, granite kerbs. Deliberately
   * mid-dark and desaturated: the grade multiplies saturation (colorGradePass ×1.15, ×1.52 in rally)
   * and brightens, so anchors are tuned BELOW the intended on-screen value. Authoring to the final
   * look here produces fire-red bases — a recorded mistake, see buildingWorker's roof-palette note.
   */
  palette: {
    masonryWarm:   0xC9B79C,   // Eixample render, sunlit
    masonryShade:  0x9C8B76,   // the same wall in shadow
    stoneCream:    0xD8CFC0,   // Montjuïc sandstone, civic stone
    terracotta:    0xB5673F,   // roof pantile
    graniteKerb:   0x5A5A5A,   // bordillo
    panot:         0xC8C2B5,   // the flower-tile sidewalk
    asphalt:       0x4A4A4A,
    planeFoliage:  0x6E7F4A,   // pollarded plane canopy — olive, never vivid green
    palmFoliage:   0x7C8A55,
    seaMediterranean: 0x2E5F72,
  },

  /** Road-marking standard. Spain is Norma 8.2-IC: WHITE only, no yellow centre lines. */
  roadStandard: 'norma-8.2-IC',

  /**
   * Street trees, with placement weights by context. Barcelona's signature is the POLLARDED London
   * plane (Platanus × acerifolia) — heavily pruned, knobbly club-ended branches. Getting that one
   * silhouette right buys most of the city's character.
   */
  vegetation: {
    species: ['plane', 'palm', 'orange', 'cypress', 'broadleaf'],
    byContext: {
      avenue:    { plane: 0.80, broadleaf: 0.20 },
      seafront:  { palm: 0.85, broadleaf: 0.15 },
      courtyard: { orange: 0.55, broadleaf: 0.30, cypress: 0.15 },
      park:      { broadleaf: 0.45, plane: 0.25, cypress: 0.20, palm: 0.10 },
    },
  },

  /** Sun/sky keys. 41.39°N; the 35° elevation is the late-afternoon key the whole grade assumes. */
  sky: { sunElevationDeg: 35, sunAzimuthDeg: 200, latitude: 41.39 },

  /**
   * Night colour temperature. Barcelona's street lighting is largely warm — this is what the P2
   * light grid keys off, and what makes the warm-vs-cool contrast that sells the night look.
   */
  night: {
    lampColor: 0xFFB25E,
    lampKelvin: 2200,
    /**
     * Light-grid parameters. These are per-CITY on purpose: a Delhi bake wants a different answer
     * (cooler/harsher LED retrofits on much taller poles, with far less regular spacing), and the
     * whole point of the region profile is that swapping the city swaps the look without touching
     * the renderer.
     *
     * radiusM is the cutoff, not a physical falloff distance — cost scales with radius^2 because a
     * bigger radius puts each lamp in more cells and saturates the 4 slots sooner. 26 m is roughly
     * one Eixample carriageway width plus both pavements, which is what a real lamp actually
     * reaches; going wider mostly buys overlap, not visible light.
     */
    lampRadiusM: 26,
    lampIntensity: 3.0,
    /** Half-lambert bias. Real streets are full of surfaces facing away from a lamp that are still
     *  visibly lit by bounce, and there is no GI here to supply it. 0 = true lambert, 1 = fully
     *  wrapped. Warmer, hazier cities want more. */
    lampWrap: 0.5,
  },

  /** Architecture. Cerdà grid, chamfered corners, and flat *terrats* rather than pitched roofs. */
  architecture: {
    roofKind: 'terrat',
    storeyHeightM: 3.5,
    chamferedCorners: true,
    facadeLayers: 8,
  },

  /** Signage. Catalan/Spanish, Spanish regulatory sign set. */
  signage: { languages: ['ca', 'es'], signStandard: 'es-RGC' },
};
