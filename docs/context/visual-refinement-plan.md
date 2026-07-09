# Visual Refinement Plan (v2)

> **STATUS: COMPLETE (2026-07-10).** All phases landed on `v2`. V1/V2 = ACES filmic tone mapping +
> day/night lighting rebalance (`f6c280c`); V3 = grade dial-in / un-fade (`3a9958a`); V4 = baked
> building base-AO (`3a9958a`) + per-building facade tint variation (`1b58a13`); V5 = vegetation
> warmed toward Mediterranean olive for palette cohesion (`3ef62d1`). GTAO (original V1) was NOT used —
> it tripled triangle count and tanked FPS on the 4M-tri scene; replaced with perf-safe baked vertex AO.
> Ready for `v2 → main` merge + deploy on Anmol's confirmation.

**Goal:** take the game from "functional stylized" to *refined* — a cohesive, art-directed look that reads as
polished — **without switching engines or rewriting.** Everything here builds on the existing Three.js
pipeline. Reference direction: **stylized realism, art-of-rally-adjacent** (cohesion > realism).

**Method:** impact-first ordering, so the big visible jumps (AO, lighting) land early and refinement follows.
Each phase is done on `v2`, gated behind a CONFIG flag where sensible, verified by a screenshot from Anmol,
and committed separately so any phase can be reverted independently.

**Current pipeline (baseline):** `RenderPass → UnrealBloom → RadialBlur → ColorGrade → OutputPass`;
PCFShadowMap (1024); `FogExp2`; LinearToneMapping, exposure 1.25 (1.5 rally); sky palette drives fog+ambient+
car-env. **No ambient occlusion yet** — the single biggest missing "grounding" cue.

---

## Phase V1 — Ambient Occlusion  ★★★★★  (biggest single win)
Add a **GTAO** pass to the composer (before bloom). AO darkens where surfaces meet — building bases, street
junctions, under awnings/cars — so nothing reads as a "floating box" and the whole city gains depth.
- Add `GTAOPass` (three r150+), tune radius/intensity/thickness for city scale; optionally half-res for perf.
- Gate behind `CONFIG.ENABLE_AO`; blend so it enriches shadows, doesn't muddy the stylized flats.
- **Perf:** the heaviest pass, but there's GPU headroom (~128 fps). Fall back to SAO or half-res if needed.
- **Risk:** low (additive pass, flag-gated).

## Phase V2 — Lighting & sky  ★★★★★
The fastest route to an "AAA feel" is light, not geometry.
- Rebalance **key sun / fill / ambient** — warmer, more directional daylight; stronger sculpting of forms.
- **Environment map (IBL)** — a small env for subtle reflections on car paint + glass (you already have a car
  env sphere; extend it scene-wide for grounded reflections).
- **Sky + horizon** polish (gradient, sun disc/halo), and softer, better-biased shadows (contact, no acne).
- **Risk:** low-medium — touches scene lighting; verify both day and night.

## Phase V3 — Post-processing dial-in (cohesion)  ★★★★  (cheap, high payoff)
- **Bloom:** pull it back to a tasteful glow (not blown-out); threshold tuned to only catch lights/highlights.
- **Color grade:** push toward one cohesive filmic palette (warm daylight / cool night), lift blacks slightly,
  gentle S-curve contrast.
- Add a subtle **vignette** + optional very-light **film grain / chromatic aberration** for a cinematic frame.
- **Fog:** re-tune `FogExp2` as *atmospheric depth* (distant haze that fades the skyline), not a hard wall.
- **Risk:** low — post-only, fully tunable, revertible.

## Phase V4 — Material & surface polish  ★★★★
Stop procedural surfaces from reading flat.
- **Buildings:** per-instance subtle variation (tint / roughness / baked AO), window-emissive variation at
  night, a touch of roof/facade break-up so blocks differ.
- **Roads / sidewalks:** subtle normal + spec, curb/edge wear, so asphalt isn't a flat colour.
- **Vegetation / props:** slight colour + scale variance for a hand-placed feel.
- **Risk:** medium — touches the procedural renderers; do incrementally, one surface type at a time.

## Phase V5 — Cohesion & signature grade  ★★★★
Tie it all together into one look.
- Harmonize the palette across buildings / roads / cars / vegetation / sky.
- A final LUT-style grade for a consistent **signature look** (the thing that makes it feel authored).
- Balance overall contrast/saturation so day and night both feel intentional.
- **Risk:** low.

---

## Order & cadence
V1 → V2 → V3 → V4 → V5. Start with **V1 (AO)** — it's the most dramatic single change and everything else layers
on top of a better-grounded scene. Each phase: implement on `v2`, screenshot check, commit; move on only when
it looks right. When the set feels good, merge `v2 → main` and deploy (same flow as the optimization pass).
