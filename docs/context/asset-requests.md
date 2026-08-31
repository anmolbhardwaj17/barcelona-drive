# Asset requests — ready-to-paste generation prompts

Standing arrangement (2026-08-31): when work needs an image I cannot generate, the request lands
here instead of interrupting. Generate in batches whenever convenient and drop the files in
`docs/context/incoming-assets/`; each entry names where it goes and what it unblocks.

## ⚠ READ FIRST — THE ART BUDGET IS FULL

Measured 2026-08-31, `frontend/public/textures/`:

| pack | size |
|---|---|
| vegetation | ~~12.0~~ → 10.0 MB |
| road | 5.5 MB |
| roof | ~~2.8~~ → 0.55 MB |
| sky | 1.9 MB |
| terrain | 1.8 MB |
| railway, wall, water | 0.3 MB |
| **total** | **~~24 MB~~ → 20 MB against a 24 MB cap (§0, ets2-target-audit)** |

~~**Nothing new can ship until something is freed.**~~ **~4 MB freed on 2026-08-31** — the pack is
now 20 MB, enough for all four requests below. Both sources are closed out:

1. ~~Roof plates → KTX2 array~~ **DONE 2026-08-31.** 2.83 MB → 0.44 MB (**6.5:1**), plus a
   0.11 MB `.half` for the LOW tier, and VRAM 12 MB → ~3 MB. The pack is now 22 MB, so **there is
   ~2 MB of headroom** — enough for R1 and R2 below, not for all four.
2. ~~vegetation/ has never been audited~~ **AUDITED 2026-08-31.** `rock_atlas` (albedo + normal +
   both `.half` variants, **1.23 MB**) is referenced in **zero** source files. It was wired by
   `43f05c5 Wire bush cards and stone rocks` and orphaned when the decorative rock/bush/small-tree
   scatter was deleted on 2026-08-28 — the texture outlived its only consumer. Archived to
   `art-src/rocks-v1/unshipped/`. Trees and bushes are both genuinely sampled, normals included
   (`treeCards.js:124`, `bushCards.js:55`), so the remaining 10 MB is earning its place.

Every request below states its cost so the trade is explicit.

---

## R1 · Bridge / viaduct deck underside — concrete soffit

**Priority: highest.** Evidence, not taste: this surface is drawn under every elevated road in the
city, it now runs alongside every N-54 embankment, and it ships as an **unlit
`MeshBasicMaterial 0xa9a49d`** (`roadRenderer.js` `getSlabMaterial`). Being unlit is why it read as
"white" when the user photographed the embankment z-fighting — it does not respond to light at all,
so it never matches the concrete beside it. A plate plus a move to Lambert fixes both.

- **Goes to:** `frontend/public/textures/road/slab_soffit_albedo.png` → KTX2 (ETC1S, opaque)
- **Size / span:** 1024², declared span **4.0 m** (256 texels/m)
- **Budget:** ~0.35 MB as ETC1S
- **Unblocks:** replacing the unlit slab material; the last untextured large surface on the road stack

> **Prompt:** Seamless tileable texture of the underside of a concrete highway bridge deck,
> photographed straight on, flat even overcast lighting with no shadows and no directional light.
> Precast concrete soffit panels with fine horizontal form lines, subtle grey tonal variation
> between panels, faint darker streaks of water staining running in one direction, small air-bubble
> pitting. Muted warm-neutral grey, desaturated, near-uniform brightness across the whole frame.
> No text, no signage, no pipes, no cables, no vegetation, no sky, no perspective, no vignetting.
> Square, top-down orthographic, tiles seamlessly on all four edges.

---

## R2 · Compound / boundary wall — painted render

**Priority: high.** `barrierRenderer.js` draws these as flat `0xC8B89A` with one map reference
across seven materials. They are tall vertical surfaces running along streets, so they occupy real
screen area at driving eye height — the same argument that justified the panot pavement.

- **Goes to:** `frontend/public/textures/wall/compound_render_albedo.png` (the `wall/` pack is 32 KB)
- **Size / span:** 1024², declared span **3.0 m**
- **Budget:** ~0.35 MB as ETC1S
- **Unblocks:** `barrierRenderer` compound_wall

> **Prompt:** Seamless tileable texture of a Barcelona boundary wall finished in painted cement
> render, flat overcast lighting, no shadows, no directional light. Warm off-white sand-coloured
> render with gentle mottling, hairline cracks, faint horizontal trowel marks, a subtle band of
> grey-green damp staining low in the frame, small patches where paint has thinned to show render
> beneath. Desaturated and even in brightness. No graffiti, no text, no posters, no windows, no
> pipework, no plants, no sky. Square, straight-on orthographic, tiles seamlessly on all four edges.

---

## R3 · Street-furniture atlas — steel, painted metal, concrete

**Priority: medium.** `urbanFeatureRenderer.js` carries **22 materials against 3 map references** —
benches, bollards, bins, planters, all flat colour (`0x888899` steel, `0xbbbbbb` concrete,
`0xcc3333` red, `0xeecc22` yellow). Individually small, collectively everywhere, and flat colour is
what makes props read as toys.

- **Goes to:** `frontend/public/textures/urban/furniture_atlas_albedo.png`, 2×2 cells
- **Size / span:** 1024² total (512² per cell), each cell ~1.0 m
- **Budget:** ~0.35 MB as ETC1S
- **Unblocks:** the flat-colour prop materials

> **Prompt:** Texture atlas, 2x2 grid of four seamless material swatches, flat overcast lighting,
> no shadows, no directional light, each cell filled edge to edge with only its material.
> Top-left: brushed galvanised steel, fine directional grain, faint mottling.
> Top-right: dark grey powder-coated metal with a slightly granular finish and small chips showing
> lighter metal beneath.
> Bottom-left: smooth precast concrete, pale warm grey, fine air-bubble pitting.
> Bottom-right: weathered painted steel in deep signal red, subtle brush texture, light scuffing.
> All four desaturated and even in brightness. No text, no logos, no rust streaks, no objects, no
> perspective. Square, orthographic.

---

## R4 · Traffic-sign backing plate — aluminium reverse

**Priority: low.** `roadInfraRenderer.js` draws sign backs as flat `0x888888`. Only seen from behind
and mostly at distance, so it is genuinely low value — listed for completeness, not to be generated
before R1–R3.

- **Goes to:** `frontend/public/textures/road/sign_back_albedo.png`
- **Size / span:** 512², span **0.8 m**
- **Budget:** ~0.1 MB as ETC1S

> **Prompt:** Seamless tileable texture of the unpainted reverse face of an aluminium road sign,
> flat overcast lighting, no shadows. Pale grey brushed aluminium with a faint directional grain,
> light oxidation mottling, very subtle darker streaks. Desaturated, even brightness. No text, no
> bolts, no brackets, no perspective. Square, orthographic, tiles seamlessly on all four edges.

---

## ⚠ How to check whether a texture is actually used

`rock_atlas` was found dead by grepping its filename across `frontend/src/`. **That method also
flags six textures that are very much alive** — `panot_*`, `asphalt_worn_*`, `asphalt_fresh_*` —
because `roadTexturePack.js:39` composes the filename at the call site:

```js
albedo: load(`${BASE}/${name}_albedo.ktx2`, true),
```

Those are the highest-screen-coverage surfaces in the game. Trusting the grep would have archived
the road. **Always find the loader and check whether the name is a literal or composed** before
concluding anything is orphaned; when it is composed, trace what gets passed in.

## Notes for whoever processes these

- Everything goes through `tools/artNormalize.py` before shipping — de-light, Lab rescale, palette
  snap, tiling repair ladder, grain check. A plate that fails a gate is rejected, not tuned by eye.
- **The span is a physical claim and it gets MEASURED, not assumed** (`measure_grain_mm`). The kerb
  granite and the asphalt both shipped at guessed spans and both read as gravel.
- **D-31: plates must be near-WHITE, not merely desaturated.** Roof and facade colour lives in
  VERTEX COLOUR against a white material, so a mid-grey plate multiplies the tint and darkens
  everything. The roof plates shipped at 0.43–0.55 mean and halved every roof to dark maroon.
