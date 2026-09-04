# Ground-surface Z-layering — the audit, and what is left

Status: **Z-1 shipped 2026-09-04.** Code: `frontend/src/map/groundLayers.js`.
Tests: `frontend/test/groundStack.test.js` (16).

---

## 0. The TODO was stale — the scheme already exists

`TODO.md` asked for a research pass on "ad-hoc Y-offsets… half of them collide at factor -2", and
for a single layering scheme to be designed. **That scheme was built and is `groundLayers.js`**: a
`GROUND_LAYERS` depth-bias table, a `GROUND_LIFT` physical-height table, `applyGroundLayer()`, and a
dev guard `assertGroundLayers()` wired into `tileManager.js:150` so it sees every mesh.

Adoption, measured rather than assumed:

| | result |
|---|---|
| `polygonOffset` set outside `applyGroundLayer()` | **7 sites — all legitimately exempt.** Every one is a transparent `depthWrite:false` decal (car shadow, pole shadows, bus-stop and fuel pools, fountain shadow, bridge shadow), which the module's own RULES order by `renderOrder`. Zero violations. |
| `applyGroundLayer()` call sites | 19, across greens, area features, bus stops, road infra and the road renderer |
| the dev guard | live on every mesh |

So the **depth-bias half is done**. The findings below are all in the other half.

---

## 1. Finding Z-1a — the two tables encoded OPPOSITE orders

`groundLayers.js` carried a note flagging *one* disagreement: parking stripes geometrically above
lane lines while their depth bias put them under, "shipped and audited… a candidate for the next
paint pass". Measured across all 21 pairs of the seven road-based classes, it was not one straggler.

    bottom → top by DEPTH BIAS :  gore < drain < bikeLane < parkingZone < marking < crossing < stencil
    bottom → top by HEIGHT     :  gore < drain < bikeLane < crossing < stencil < marking < parkingZone
                                                            └──────────── fully inverted ───────────┘

**5 inverted pairs of 21 — every one of them paint.** The three non-paint classes agreed.

### Why nobody ever chased it

Both tables were internally consistent, and each is *right* in a different regime, so the artefact
is not a flicker — **the order swaps as the camera moves**:

- `polygonOffset` = `factor × m + units × r`, where `m` is the depth gradient of the fragment.
- Road is viewed at a **grazing angle** from a chase camera, so `m` is large and the `factor` term
  dominates → the **bias** order is what you see down the street.
- Close under the bumper the surface is nearly face-on, `m` collapses, and the 5 mm of real
  separation decides → the **height** order wins.

With `near = 1, far = 50000` (`scene.js:549`) and a 24-bit buffer, world-space depth resolution is
`≈ z² / 16.8e6` — 0.6 mm at 100 m, 5.4 mm at 300 m. A 2-unit bias difference is worth ~1.2 mm at
100 m and ~11 mm at 300 m, so even the constant term crosses the 5 mm geometric gap inside the drawn
road distance. There is no camera position from which the whole street is consistent.

### Resolved in the direction of the BIAS

Two reasons, and they agree:

1. The bias order encodes the **art intent** the table was written with ("stencil = topmost paint").
2. It is **physically right for the pair that actually overlaps**: a zebra is painted *across* the
   lane lines, so `crossing` belongs over `marking`. The height table had that backwards.
3. It is the order visible at the angles road is mostly seen at, so matching the geometry to it is
   the change that moves **least** on screen.

The paint ladder is now a 5 mm step in bias order, held one step above the old floor so the lowest
paint class keeps 2.1 cm of clearance over the drawn asphalt rather than the 1.6 cm a tighter ladder
would have left it — `MIN_PAINT_CLEARANCE` is 1.5 cm and burial is this module's documented failure
mode, so 1 mm of margin is not margin.

| class | bias | lift | absolute | clearance over asphalt | was |
|---|---|---|---|---|---|
| gore | −5 | 0.005 | base+0.055 | (embedded, exempt) | — |
| drain | −7 | 0.020 | base+0.070 | (embedded, exempt) | — |
| bikeLane | −8 | 0.040 | base+0.090 | 1.1 cm (a surface, exempt) | unchanged |
| parkingZone | −12 | 0.050 | base+0.100 | 2.1 cm | base+0.105 |
| marking | −14 | 0.055 | base+0.105 | 2.6 cm | base+0.100 |
| crossing | −16 | 0.060 | base+0.110 | 3.1 cm | base+0.095 |
| stencil | −18 | 0.065 | base+0.115 | 3.6 cm | base+0.095 |

Nothing moves by more than 2 cm. **Inverted pairs: 5 → 0.**

`groundStack.test.js` now asserts the agreement for every pair sharing a base — that assertion is
the deliverable, not the numbers. `ROAD_BASED_LIFTS` names the comparable set; `tactile` is excluded
because its 0.005 is measured from the **sidewalk**, and ranking it against a paint lift compares two
numbers that are not in the same coordinate.

---

## 2. Finding Z-1b — four paint constants duplicated the table

`roadRenderer.js` restated `GROUND_LIFT`'s values as its own constants, with the arithmetic spelled
out in a comment:

```js
const MARKING_Y_ABOVE_ROAD = 0.03;   // +0.05(heights)+0.02(ribbon) = base+0.10
const STRIPE_Y_ABOVE       = 0.035;  // +0.05+0.02(ribbon) = base+0.105
const BIKE_Y_ABOVE         = 0.02;   // slight raise above asphalt
const ARROW_Y_ABOVE        = 0.045;  // custom quads (no ribbon +0.02)
```

All four **agreed with the table at the time of the audit** — which is exactly what makes it the
"two references for one height, kept in sync by hand until it isn't" failure the module exists to
end, sitting inside its biggest client. Four other classes (`crossing`, `stencil` ×2, `tactile`)
already derived correctly, so the file was half-converted.

All four now derive. The subtlety they encode is real and is kept:
`buildFlatRibbonGeometry` adds a **hidden `+ROAD_ZFIGHT_OFFSET` (0.02)** to every vertex, so
ribbon-built paint is handed `groundLift(cls) − ROAD_ZFIGHT_OFFSET` while custom-quad paint (lane
arrows) takes the full lift. Verified at each call site rather than taken from the comments —
marking, stripes and bike lanes all reach `buildFlatRibbonGeometry`; arrows build their own quads.

---

## 3. Finding Z-1c — one ladder, three copies, one of them a comment

    greensRenderer.js       const GREEN_OFFSET_Y = 0.01;
    vegetationRenderer.js   const GREEN_OFFSET_Y = 0.01;          ← identical, second declaration
    areaFeaturesRenderer.js const AREA_OFFSET_Y  = 0.02;  // "above greens' 0.01"
                                                            ↑ a numeric dependency it cannot see change

Now `TERRAIN_LIFT` in `groundLayers.js`, values unchanged. ⚠ `vegetationRenderer`'s green-mesh path
is the **dead twin** (N-12): `vegetationWorker` skips runtime placement whenever a tile carries baked
vegetation, which every v10 tile does. Unified anyway — a dormant copy of a shared height is still a
copy, and this one wakes up on the fallback path.

---

## 4. What is NOT done

### Z-2 — ground surfaces still outside the scheme

**Z-2a `parkingRenderer` ✅ done 2026-09-05.** It had **no depth class at all** — no `polygonOffset`,
no `applyGroundLayer` — and two hand-rolled offsets. The apron at terrain+0.04 was fine (below the
road deck at +0.05), but its stall **markings at +0.06 sat ABOVE the road deck** while their absent
bias put them below it: height said the car park's paint wins where a street crosses it, bias said
the street does, and which you saw depended on the angle. The Z-1 inversion, in a renderer nobody had
enrolled. Now `parkingLot` (−3.6, lift 0.020) and `parkingPaint` (−3.8, lift 0.030) — both under
`road` by **bias and height**.

⚠ **Two things that came with it and are worth knowing.** First, `applyGroundLayer` also *registers*
the material, and `patchLightGrid` only reaches registered materials — so a car park had been lit by
the ambient rig **alone** at night, the same defect the module records for road markings reading blue
under a warm lamp. Second, the bias/height agreement assertion only ever covered `ROAD_BASED_LIFTS`,
which is precisely why this could sit outside it undetected; there is now a `TERRAIN_BASED_LIFTS` set
and the same check runs over both.

**Still outside the scheme** — each is a possible visible change, so one class per pass with its own
drive test:

| file | constant | value | note |
|---|---|---|---|
| `busStopRenderer.js` | `POOL_Y_OFFSET` / `MARKING_Y_OFFSET` | 0.10 / 0.15 | the marking one is 15 cm — far above every paint class |
| `railwayRenderer.js` | `TRAM_RAIL_Y_ABOVE` | 0.005 | tram rail in the carriageway |
| `tunnelRenderer.js` | `APPROACH_Y_BIAS` | 0.06 | "above terrain so ramp surface wins z-fight" — a hand-rolled tie-break of exactly the kind the bias table exists to replace |
| `roadRenderer.js` | `BLEND_STRIP_Y_OFFSET` | 0.10 | above terrain AND greens |
| `vegetationRenderer.js` | `SHADOW_Y_OFFSET` | 0.02 | decal, likely exempt — check `depthWrite` |

### Z-3 — building-wall z-fighting on overlapping OSM footprints
The original TODO's last line. **Untouched, and it does not belong in this module**: `groundLayers`
is explicitly for flat co-planar ground, and 3D geometry "wins by having real height". Overlapping
building footprints are a *data* problem (two OSM ways describing one block) and belong with the
OSM repair layer — see `osm-repair-layer.md`, whose `rule5_duplicateRoadRemover` solves the same
shape of problem for roads.

### Z-4 — the `gore` and `drain` clearance exemption
Both sit *below* the top of the drawn asphalt (−2.4 cm and −0.9 cm) and are exempted from the
clearance assertion as "embedded, not painted on". That is plausible for a drain cover and doubtful
for a junction gore fill, which is paint. Nobody has looked at one on screen at close range.

---

## 5. Verification — what a drive should show

1. **A zebra crossing a lane line**: the zebra is on top, and it stays on top as you drive onto it.
   Before Z-1 the lane line won up close and the zebra won at distance.
2. **A lane arrow near a stop line**: the arrow is on top at every distance.
3. **A blue-zone bay line meeting a lane line**: the lane line is on top now, at every distance.
4. No paint anywhere flickers or disappears as the camera approaches — that is the failure mode the
   two orders produced between them.


## Z-2b — what was left outside the scheme, and what it actually was (2026-09-05)

The Z-2b list was written from a grep for hand-rolled Y constants. Three of its four entries did not
survive contact with the code, which is worth recording because the same grep will find them again:

| listed | reality |
|---|---|
| `busStopRenderer` 0.15 | **Real defect, fixed.** Enrolled in the *depth* table since v3 P1, never in the *height* table: `MARKING_Y_OFFSET = 0.15` off **raw terrain**, against lane paint's `roadDeckY(y) + groundLift('marking')` ≈ terrain + 9.7 cm. The bay outline floated ~5 cm over the lines it is coplanar with. |
| `busStopRenderer` 0.10 | **Out of scope by the scheme's own rules.** Transparent, `depthWrite:false` light pool — ordered by `renderOrder`; `assertGroundLayers()` skips it, and the file said so. |
| `tunnelRenderer` `APPROACH_Y_BIAS` 0.06 | **Dead code, deleted.** `_buildApproachAtPortal()` was never called. It was also an **absolute** Y, not terrain-relative, so on a real DEM its quad sat at sea level. |
| `roadRenderer` `BLEND_STRIP_Y_OFFSET` 0.10 | **Dead code, deleted.** v3 P1-15 removed `buildRoadsideBlendStrip()` and left the constants behind. |

**The transferable lesson** is the bus stop, not the deletions. A renderer can be half-enrolled —
depth bias applied, height left hand-rolled — and it will look *more* correct than an unenrolled one
while still being wrong, because the loud symptom (flicker) is gone and the quiet one (a 5 cm float,
visible only up close or at a grazing angle) is not. `assertGroundLayers()` checks the bias. Nothing
checks that a class's *height* is taken from `GROUND_LIFT` rather than typed in, so grep for a bare
float next to `applyGroundLayer` when auditing a renderer.

Still open: **Z-2c**, tram rails at road surface + 5 mm on a material with no bias. The rules say 3D
geometry wins by height and a rail has height; 5 mm may not be enough height. Needs a drive down
Diagonal, not a guess.
