/**
 * envPresets.js — the DAY and NIGHT lighting presets.
 *
 * Split out of `envToggle.js` so they can be UNIT TESTED. envToggle imports scene.js and sixteen
 * renderer modules, so nothing in a node test can load it; these are plain data and now import
 * nothing at all.
 *
 * ⚠ These are the values that actually ship. The AmbientLight/HemisphereLight/DirectionalLight
 * constructed in `scene.js` carry different numbers, and those are DEAD ON ARRIVAL — `applyMode`
 * overwrites all of them at init from the saved mode (defaulting to day). Tuning scene.js does
 * nothing. Tune here.
 */
export const DAY = {
  // L1 golden-hour split: the hemi (now a REAL light — cool sky fill + warm ground bounce) carries the
  // colour separation; ambient drops to a neutral base so the fill isn't doubled. Sun warmed slightly.
  ambientColor:     0xd4e2ec,
  ambientIntensity: 0.30,
  hemiSkyColor:     0xa3c0e4, // cool blue sky-light → shadows read cool
  hemiGroundColor:  0xc4966a, // warm ground bounce, eased (0xd08a4e washed facades too golden)
  hemiIntensity:    0.55,
  dirIntensity:     2.7,
  dirColor:         0xffe3c2, // warm key, one notch whiter (0xffdcae read too yellow on cream walls)
  fogColor:         0xc4dcea,  // brighter sky-matched haze (less grey)
  fogDensity:       0.0032,     // thinned (was 0.0052) — day haze was reading as a grey wash over the frame
  skyVisible:       true,
  bgColor:          null,
  toneMappingExposure: 1.6,   // pulled from 1.9 — the scene was overexposed, washing every surface colour pale
  lampEmissive:     0.25,   // subtle glow in daylight
  bloomStrength:    0.5,    // subtle bloom by day (only the sun/bright highlights)
  bloomThreshold:   1.1,    // high threshold → daytime scene doesn't bloom
  lightsOn:         false,
};

export const NIGHT = {
  // Reference-matched night (low-poly cinematic renders): the WHOLE albedo palette collapses into a
  // narrow dark blue-charcoal band — day colours must NOT survive (no vivid greens / bright cream
  // facades after dark). Fill light is deep desaturated blue at LOW intensity; the warm emissives
  // (windows, streetlamps, signs) carry all the contrast and pop against it via bloom.
  ambientColor:     0x6b7a9e,  // desaturated blue fill — the blue TINT (not darkness) is what sells night
  // ⚠ THE FLOOR MUST STAY BELOW THE DAY FLOOR. This was 1.0 against DAY's 0.30 — night was lit
  // FLATTER than day, by 3.3x, and ambient is directionless by definition. Two consequences, both
  // visible from the driver's seat:
  //   1. THE PURPLE ROAD. The street lamps are sodium-warm (0xFFB25E) with a 26 m radius at ~22 m
  //      spacing, i.e. >100% overlapping coverage of the carriageway. A warm wash and a blue wash of
  //      COMPARABLE strength average to lavender everywhere. The lamps were never the problem and
  //      neither was the grade — it was that the blue fill could compete with them.
  //   2. NO LAMP POOLS AND NO HEADLIGHTS. Both are real and live (the light grid is fed actual lamp
  //      positions; the headlights are real SpotLights). A 1.0 floor means a surface beside a lamp
  //      and one 40 m away start at near-identical brightness, so nothing local can read.
  // The floor was set before the light grid existed, when it genuinely was all that stood between
  // the player and a void. The grid is what carries readability now.
  ambientIntensity: 0.32,      // was 1.0 — see above. MUST stay < DAY (asserted in envPresets.test.js)
  hemiSkyColor:     0x46567e,  // dark blue sky dome light
  hemiGroundColor:  0x232a3a,  // dark ground bounce
  hemiIntensity:    0.38,      // was 0.6 — same flat-fill problem, smaller dose
  dirIntensity:     0.85,      // was 0.7 — moon RAISED as the floor drops: form should come from a
                               // direction, not from an omnidirectional wash
  dirColor:         0x8fa6d8,  // cool moonlight
  fogColor:         0x101a2e,  // deep navy haze
  fogDensity:       0.0045,    // thin night haze so the distance keeps depth, not grey murk
  // v3 P3-11: the dome is VISIBLE at night now. It was hidden behind a flat bgColor because it
  // carried day colours only — and a hidden dome cannot hold clouds, cannot carry dawn/dusk and
  // cannot take a horizon glow, so the night sky was a solid navy rectangle. It has a night key now
  // (NIGHT_SKY_* in scene.js), so bgColor is no longer needed: the gradient's zenith 0x080e1e sits
  // where the flat 0x0a1224 was, as the TOP of a gradient rather than the whole sky.
  skyVisible:       true,
  bgColor:          null,
  // Night must actually be DARKER, not just bluer. At 1.5 against DAY's 1.6 the exposure barely
  // moved, so "night" was carried almost entirely by hue — which is the other half of why the frame
  // read as a flat lavender wash rather than a dark street with warm lamps in it.
  toneMappingExposure: 1.15,   // was 1.5
  lampEmissive:     9.0,       // hotter streetlamp glow → warm pops punch through the deep blue
  bloomStrength:    0.55,      // soft halo only — 1.0 turned every window into a fuzzy ball
  bloomThreshold:   0.72,      // just the truly bright emissives bloom (lamps, window cores)
  lightsOn:         true,
};
