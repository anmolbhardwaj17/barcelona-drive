# Day / Night lighting audit — 2026-09-02

Triggered by two frames at the Gran Via spawn (day + night, same camera). The complaint was
"doesn't feel natural". The two frames fail for **completely different reasons**, so they need
separate fixes and should not be tuned together.

---

## 1. What the frames actually show

**Day.** A plane-tree avenue at high sun with **zero cast shadows** — not soft ones, none. Flat
cyan sky, one cloud, no horizon variation. Road washes to white at distance.

**Night.** The carriageway reads **purple/magenta**. Lane markings read **blue**, not white.
Everything is uniformly visible to the horizon: no lamp pools, no headlight throw, no falloff.
Trees are the same saturated green they are at noon, just darker.

---

## 2. DAY — the shadows are not dimmed, they are absent

`CONFIG.ENABLE_SHADOWS` is true, the renderer's shadow map is on, and the sun casts. The day frame
still has no shadows because **the only shadow casters in frame opted out**:

```
vegetationRenderer.js:706,1131,1327   mesh.castShadow = false;
  // "trees do NOT cast shadows — 150k+ trees in the shadow pass tanked FPS (33→)"
```

On a tree-lined avenue that removes every shadow there was. Buildings and cars still cast, but on
Gran Via at this camera there are none in frame.

⚠ **The perf number that justified this does not justify it any more.** The shadow camera is
`±85 m` with `far 600` (`scene.js:747-753`). Only trees inside that box can cast into the map —
on the order of 10², not 150,000. The measured 33 fps came from putting *every* tree in the depth
pass, which happens because the BatchedMesh pools set both `frustumCulled = false` and
`perObjectFrustumCulled = false`. So the finding was "all trees are unaffordable", and it was
generalised to "trees cannot cast". A bounded near-camera caster set is a different proposition and
was never measured.

Secondary, smaller: no sun disc or horizon gradient in the sky dome; the car's grounding is a blob
decal rather than a contact shadow.

**The day rig itself is fine.** Effective values are the envToggle DAY preset — ambient **0.30**,
hemi 0.55, sun 2.7 — a healthy ~1:3 fill-to-key. (The `0.92` ambient in `scene.js:729` is only a
creation default; `applyMode` overwrites it at init from the saved mode, defaulting to day. Do not
tune `scene.js` values — they are dead on arrival.)

---

## 3. NIGHT — three separate causes stack into the magenta

### N1. The grade pass manufactures magenta (`ui/colorGradePass.js`)

At night the pass applies, in order:

| step | factor | effect |
|---|---|---|
| global night cool (l.69) | `× (0.90, 0.95, 1.10)` | B up, R down |
| split-tone warm (l.61) | `× (1.14, 1.02, 0.85)` | R up, G barely, B down |
| saturation (l.48) | `× 1.52` | amplifies whatever imbalance survives |

The two tints push **R and B up and leave G behind**, and the saturation multiplier then exaggerates
exactly that residual. R↑ B↑ G↓ *is* magenta. Neutral `0x4a4a4a` asphalt has no purple in it — the
purple is added here.

The `1.52` is not a night value: `uRally` is set to `1.0` **unconditionally** (l.120), so a constant
tuned for the high-key DAY look is applied unchanged after dark.

⚠ This is not a challenge to **D-20** (the rally look is the game's look, and the grade/fog/exposure
were tuned against it). D-20 was tuned on day frames. The defect is that a day-tuned saturation
leaks into night and lands on a colour nobody chose.

### N2. Night is FLATTER than day, and that is what kills every light

| | ambient | hemi | dir | exposure |
|---|---|---|---|---|
| DAY | 0.30 | 0.55 | 2.7 | 1.6 |
| **NIGHT** | **1.00** | 0.60 | 0.7 | **1.5** |

Night ambient is **3.3× the day value**, and exposure barely moves (1.6 → 1.5). Ambient is
directionless by definition, so the night scene is a uniform wash with a weak moon on top.

This is the root of "no lamp pools, no headlights". The light grid **is** live and **is** fed real
lamps (`main.js:734`, `_lgLampCount` — it is on by default, not the `?lightgrid` spike the file
header still describes), and the car has real headlight SpotLights. They are not missing; they are
**drowned**. A 1.0 ambient floor means a surface beside a lamp and a surface 40 m away are already
at near-identical brightness before the lamp contributes anything.

The comment defends the floor as "geometry must survive as blue-charcoal masses, not voids" — a real
concern, but the answer to that is the light grid and the headlights, which now exist. The floor was
set when they did not.

### N3. White markings read blue

Every light source at night is blue-tinted (ambient `0x6b7a9e`, hemi `0x46567e`, moon `0x8fa6d8`).
White paint returns whatever hits it, so markings can only be blue. Real markings read white because
they are lit by warm lamps and headlights — which is N2 again.

Compounding: `lampEmissive 9.0` against `bloomThreshold 0.72` throws a hot warm bloom across a blue
frame, and warm-over-blue is more magenta.

---

## 4. Plan, in dependency order

**P-L1 — night colour balance.** Uniform/preset changes only: no bake, no new geometry, no perf
risk, all reversible in one file each.
- `NIGHT.ambientIntensity` 1.0 → ~0.30; lean on the light grid for readability.
- `NIGHT.toneMappingExposure` 1.5 → ~1.15.
- Gate the grade's saturation on night (`mix(1.52, ~1.10, uNight)`), and pick **one** night tint —
  the cool cast or the warm split — not both.
- Re-check `lampEmissive`/`bloomThreshold` only AFTER the floor drops; they were tuned to punch
  through a 1.0 ambient and will be too hot without it.

Do P-L1 first and alone: it is likely that the lamp pools and headlights the night frame is missing
appear for free, which changes what is left to fix.

**P-L2 — day shadows.** A bounded near-camera tree shadow-caster set inside the existing ±85 m
frustum, measured with the F9 drive report against the standing budget (p95 night GPU ≤ 15.0 ms).
Kill it if the depth pass costs more than ~1.5 ms. This is the single biggest day win.

**P-L3 — sky and grounding.** Horizon gradient + sun disc; real contact shadow under the car.

**P-L4 — night ground truth.** Wet-asphalt specular response under lamps. Only meaningful after
P-L1, because nothing specular can read against a flat ambient wash.

---

## 5. Not verified

- No on-screen measurement of the proposed values — every number above is read from source, and the
  two frames are the only observed evidence. **P-L1 needs a drive to confirm**, per
  [[verification-drives-are-the-users-job]].
- The 33 fps tree-shadow figure is quoted from the code comment; it was not re-measured here, and
  the claim that a bounded caster set is affordable is an argument, not a measurement.
- Whether any of this is already tracked in `v3-execution-tracker.md` was not cross-checked.
