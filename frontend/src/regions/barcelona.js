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
    /**
     * v3 D-26: was 0x4A4A4A (luminance 0.290). Real asphalt reflects 0.07-0.12; road paint reflects
     * ~0.75 and ours measures 0.738 — correct. So markings read dull not because the paint is wrong
     * but because there was nothing dark for them to stand against: contrast was 2.5x where reality
     * is 8.3x. ETS2's asphalt is also far darker than ours was.
     *
     * 0x2E2E2E takes contrast to 4.1x — most of the way to real while staying inside the stylised
     * palette. Do NOT chase the remaining gap by brightening paint: it is already at physical
     * reflectance, and pushing it up puts it back over the 0.72 night bloom threshold, which is the
     * bug removed from the lane arrows this session.
     */
    asphalt:       0x2E2E2E,
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
     * radiusM is the CUTOFF, not a falloff distance, and it must account for the 8 m pole: the
     * lamp head is 8 m above the road, so a 26 m radius had already spent a third of itself before
     * touching any ground the driver sees — pools died at ~15 m and lamps only lit when you were
     * nearly under them. 48 m puts the scalloping between 22 m-spaced lamps where the eye expects
     * it. Cost scales with radius^2 on the CPU rebuild (more cells per lamp); per-FRAGMENT cost is
     * unchanged, still bounded by the 4 slots.
     */
    lampRadiusM: 48,
    /**
     * Added directly to reflectedLight.directDiffuse, so it lives on the same scale as the rest of
     * the night rig — where diffuse sits around 0.05–0.2. The spike used 3.0 purely so 32 stub
     * lamps would be unmistakably visible while its COST was measured; that is roughly an order of
     * magnitude past a lit night street, and with real lamp density up to 4 lamps stack in a cell.
     * Tune live with window._lg.set({ intensity }) rather than guessing through rebuilds.
     * Lowered again with the smoothstep falloff: that holds near 1 through the near field where
     * quadratic had collapsed, so the same number now reads far brighter than it did.
     */
    lampIntensity: 0.36,  // Third value chosen on a night drive (0.2 pre-cone -> 0.28 -> 0.36).
                          // The cone costs ~40% at mid-street by design, and the 16-bit index now
                          // lights the full 512 m window, so more of the frame is lit at once and
                          // the eye reads any single pool as dimmer than it did. Under a lamp this
                          // is 0.333, at 15 m 0.117 — still well under the 0.72 night bloom
                          // threshold, which is the ceiling worth watching: past it, road paint and
                          // asphalt start blooming and the night look collapses.
    /** Half-lambert bias. Real streets are full of surfaces facing away from a lamp that are still
     *  visibly lit by bounce, and there is no GI here to supply it. 0 = true lambert, 1 = fully
     *  wrapped. Warmer, hazier cities want more. */
    lampWrap: 0.5,
    /**
     * Downward-cone shape. A street lamp is a shaded, downward-biased luminaire, not a bare bulb:
     * without this a lamp head 8 m up with a 48 m radius washes a six-storey facade warm to the
     * roofline. `lampConeFloor` is the sideways/upward spill kept at the horizon — a real lamp does
     * light the facade beside it, and clamping to zero reads as a stencilled edge partway up the
     * wall. `lampConePower` shapes the falloff from straight-down to level.
     */
    lampConeFloor: 0.12,
    lampConePower: 0.75,
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
