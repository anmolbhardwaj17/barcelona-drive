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

> ✅ **SHIPPED — do not regenerate.** On disk at `frontend/public/textures/road/slab_soffit_albedo.ktx2`. The prompt below is kept for re-bakes.

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

> ✅ **SHIPPED — do not regenerate.** On disk at `frontend/public/textures/wall/compound_render_albedo.ktx2`. The prompt below is kept for re-bakes.

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

> ✅ **SHIPPED — do not regenerate.** On disk at `frontend/public/textures/urban/furniture_atlas_albedo.ktx2`. The prompt below is kept for re-bakes.

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

> ✅ **SHIPPED — do not regenerate.** On disk at `frontend/public/textures/road/sign_back_albedo.ktx2`. The prompt below is kept for re-bakes.

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

---

## R5 · Traffic car models — the fleet is a low-poly kit beside a photoreal hero

**User, 2026-08-31: "my traffic is not like that na its too lowpoly".** Measured, and the gap is
NOT mainly polygons:

| | tris | materials |
|---|---|---|
| `bmw_m3.glb` (hero) | 9,792 | **11** — CarPaint (clearcoat + env), Window, Mirror, Rims, Tires, RearLight, DayLights… |
| traffic kit (9 models) | ~2,189 avg | **1** — `colormap` |

4x the triangles, but **eleven materials against one**. The kit cars have no separate glass, no
chrome, no lights and no paint response — one flat atlas. That single-material flatness is most of
the "toy" read, which is why V-2 (metalness 0.15 / roughness 0.55 / clearcoat 0.25 + the hero's
shared sky env map) was worth doing first and costs nothing.

**What would actually close it** — models with SEPARATE materials, in priority order:
`sedan`, `taxi`, `van`, `suv`, `hatchback`. Barcelona traffic is dominated by small hatchbacks and
the black-and-yellow taxi.

- **Wanted per model:** ~6-12k tris, and at minimum split materials for **body paint / glass /
  tyres / lights**. Glass must be its own material or the car cannot read as a car at any distance.
- **Format:** `.glb`, Y-up, +Z forward, real-world scale (a sedan is ~4.5 m long — the loader
  rescales, but being close avoids surprises).
- **Where:** `frontend/public/models/cars/` — drop-in, `CITY_CARS` in `carModels.js` names them.
- **Budget:** these are GEOMETRY, not the 24 MB texture budget. The nine current models total
  ~1.7 MB; 5 replacements at ~600 KB each is ~3 MB, which is fine.
- **⚠ One constraint that is easy to miss:** `getKitMaterial()` builds ONE shared material for the
  whole fleet and bakes wheels-vs-body into VERTEX COLOUR. Models with real per-part materials will
  need that path relaxed, so this is a code change too, not only an asset drop.

Free sources that fit: Sketchfab CC0/CC-BY (filter Downloadable + 3D-print off), Quaternius'
Ultimate Vehicle pack (CC0, higher-poly than the current kit), Poly Pizza.

### R5 prompts — for a text/image-to-3D generator (Meshy, Tripo, Rodin)

These output `.glb` directly. **Paste the shared constraints with every one of them** — the defaults
of these tools are 100k-triangle single-material blobs, which is worse than the kit we already have.

> **Shared constraints (append to every prompt):**
> Low-poly game asset, 8,000 to 12,000 triangles. Separate materials for body paint, window glass,
> tyres, and light lenses — glass must be its own material. Clean quad topology, no interior, no
> engine bay, no undercarriage detail. Y-up, facing +Z, real-world scale. Neutral studio lighting
> baked into nothing — flat albedo only, no baked shadows. Wheels as separate meshes at the four
> hub positions.

**1 · Compact hatchback (second variant — the fleet is one model today)**
> A modern European 5-door compact hatchback city car, 4.1 metres long, rounded contemporary
> styling, body-coloured bumpers, black window trim, five-spoke alloy wheels, plain silver paint.

**2 · Compact sedan**
> A modern European 4-door compact sedan, 4.6 metres long, three-box profile with a short boot,
> restrained contemporary styling, chrome window surround, plain dark grey paint.

**3 · Barcelona taxi**
> A modern European 4-door sedan taxi in the Barcelona livery: black body with the lower doors and
> front wings painted bright yellow, a small white roof sign, plain unlettered doors. 4.6 metres
> long, restrained contemporary styling.

**4 · Small panel van**
> A modern European small panel van, 4.4 metres long, high roof, blank unglazed side panels behind
> the front doors, sliding side door, plain white paint, black plastic bumpers, steel wheels.

**5 · Compact SUV**
> A modern European compact crossover SUV, 4.3 metres long, raised ride height, black wheel-arch
> cladding and lower body trim, roof rails, plain dark blue paint, five-spoke alloy wheels.

⚠ **Expect to reject most outputs.** These generators produce lumpy silhouettes and merged materials
far more often than they produce usable cars. Judge on two things before anything else: is the glass
a separate material, and does the silhouette read as a car in profile at 30 m. Everything else is
fixable in the loader; those two are not.


---

## R6 · Game-mode card art — five wide banners, full-bleed behind the text

**User, 2026-09-01.** The hub (`ui/mainMenu.js`) draws each mode as a FULL-BLEED card: the art fills
the card and the name + blurb sit on top of it, bottom-left, under a scrim. That changes the
composition brief — the old set was made for a small thumbnail beside text.

- **Goes to:** `frontend/public/modes/mode-{free,dash,taxi,delivery,police}.webp` — **keep these exact
  names.** The hub reads them and the title screen preloads them; swapping the files needs no code.
- **Size:** **1200 × 420** (≈2.9:1). The card renders about 300 × 104 and uses `background-size:
  cover`, so the centre band always survives; the far left and right edges may not.
- **⚠ COMPOSITION IS LOAD-BEARING.** The name and blurb sit **bottom-left**, in white, over a
  bottom-weighted dark gradient. So: **subject in the upper-right two thirds; keep the lower-left
  third quiet** — sky, road, haze, anything without detail. A busy lower-left survives the scrim but
  fights the type.
- **Budget:** UI art, NOT the 24 MB texture cap. ~60-90 KB each as WebP.
- **Missing file:** the card falls back to its per-mode CSS gradient and still reads. Do them one at
  a time if you like.

> **Shared style block — append to every one of the five:**
> Cinematic wide banner key art for a stylised Barcelona driving game, 1200x420, extreme wide
> letterbox composition. Dusk, just after sunset: warm amber street light and headlights against
> deep blue-teal shadow. Stylised realism — clean geometric architecture, smooth surfaces, soft
> volumetric haze, no photographic grain. Low camera near road level. Main subject placed in the
> UPPER RIGHT of the frame; keep the LOWER LEFT third calm and uncluttered for a text overlay.
> No text, no logos, no UI, no watermark, no faces, no borders.

**mode-free** — Free Roam
> A silver coupe cruising away from camera down an empty Barcelona avenue, the Eixample's chamfered
> corners and lit shopfronts receding into evening haze, palm trees along both kerbs.

**mode-dash** — Checkpoint Dash
> A silver coupe hard on the throttle through a wide Barcelona junction, the road surface streaked
> with motion blur, a tall glowing amber checkpoint arch of light standing ahead and to the right.

**mode-taxi** — City Cab
> A black-and-yellow Barcelona taxi waiting at a lit kerb on a narrow Gothic Quarter street, its
> roof sign glowing, warm light spilling from a doorway onto wet stone paving.

**mode-delivery** — Rush Hour
> A small white panel van cornering hard through dense evening traffic on a Barcelona avenue, red
> brake lights streaking across the frame, cardboard parcels visible through its rear glass.

**mode-police** — Heat
> A silver coupe fleeing along the Barcelona seafront, seen from behind and slightly above, with
> blue and red police lights flaring through the haze close behind it and palm trees whipping past.

---

## R7 · Loading-screen artwork — rotating full-bleed stills

**User, 2026-09-01:** "the whole page doesn't have any image, there should be images coming there
rotating and facts on top left". The mode loader (`#dd-modeload`, the bottom-left counter you get
after PLAY) now crossfades a rotating set behind the UI with a slow Ken Burns push.

- **Goes to:** `frontend/public/loading/load-1.webp` … `load-8.webp`
- **Size:** 1920 × 1080 (16:9), full-bleed
- **⚠ COMPOSITION:** facts sit **top-left**, the % counter **bottom-left**, both white over a scrim
  weighted to the top and bottom edges. **Keep the left third calm; put the subject right of
  centre.** A busy left edge survives the scrim but fights both text blocks.
- **Budget:** UI art, NOT the 24 MB texture cap. ~150-250 KB each as WebP.
- **Ship any number.** `index.html` probes 1-8 and rotates only what loads, so two now and six later
  is fine, and a missing slot is skipped rather than flashed as black.

> **Shared style block — append to every one:**
> Cinematic 16:9 wallpaper for a stylised Barcelona driving game. Dusk or blue hour: warm amber
> street light against deep blue-teal shadow. Stylised realism — clean geometric architecture,
> smooth surfaces, soft volumetric haze, no photographic grain. Wide establishing view with strong
> depth. Keep the LEFT THIRD calm and uncluttered — sky, road, water or haze — for text overlays.
> No text, no logos, no UI, no watermark, no faces, no borders.

**load-1** — the Eixample grid
> A high wide view over Barcelona's Eixample at dusk, the chamfered octagonal city blocks receding
> in a lit grid, warm window light and amber street lamps, the Sagrada Família silhouetted on the
> right horizon.

**load-2** — the seafront
> The Barcelona waterfront at blue hour seen along the beach, palm trees and a lit promenade curving
> away to the right, calm sea and open sky filling the left of the frame.

**load-3** — a Gothic Quarter street
> A narrow Gothic Quarter street at night, stone walls and iron balconies, a single warm lantern
> throwing light across wet paving, the alley opening into a lit square on the right.

**load-4** — the ring road
> A Barcelona ring road at dusk from a low bridge, empty carriageways sweeping right, city lights
> and the Collserola hills beyond, an open dark sky over the left half.

**load-5** — Montjuïc overlook
> Barcelona seen from Montjuïc at sunset, the port and the whole lit city spread below and to the
> right, calm hazy sky and sea filling the left of the frame.

**load-6** — Passeig de Gràcia
> A wide Barcelona boulevard at dusk lined with modernista façades and ornate street lamps, tram
> tracks and crossings catching the light, the buildings massed on the right.
