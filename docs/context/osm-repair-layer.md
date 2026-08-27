# The OSM Repair Layer — design

> **STATUS: DESIGN, not started.** Proposed 2026-08-25. This governs any work that changes what the
> bake does with *defective* source data. Read this before touching `worldBuilder/roads/OsmDataFixer.js`,
> `wayStitcher.js`, `roadTopologyNormalizer.js`, `elevationHarmonizer.js` or `BridgeToBridgeResolver.js`.

---

## 0. The idea, and the correction to it

**The ask:** OSM is crowd-sourced and locally wrong — tunnels vanish mid-run, roads meet without
joining, flyovers cut off, and hills make all of it worse. Put a layer between the raw data and the
bake that *detects* these and *reconstructs* what should have been there, so the city reads as
professional rather than as a data dump.

**The correction, from surveying the code: this layer already half-exists, and it is biased the wrong
way.** Six modules already do pieces of it:

| module | what it repairs today |
|---|---|
| `OsmDataFixer.js` | orphan short bridges, duplicate ways, bridge/layer conflicts, ground roads under bridges |
| `wayStitcher.js` | joins ways that OSM split |
| `roadTopologyNormalizer.js` | normalises the graph |
| `LayerResolver.js` / `RampResolver.js` | layer + ramp inference |
| `BridgeToBridgeResolver.js` | bridge-to-bridge continuity |
| `elevationHarmonizer.js` | smooths elevation along a road |

So this is **not a greenfield subsystem. It is a scattered, unmeasured capability that needs promoting
to a first-class, measured one.** Three specific problems with it as it stands:

1. **The policy is DROP, not REPAIR.** `buildRegion.js:29` — *"Better a clean gap than a mangled
   road"* — deletes ways whose ramp couldn't be resolved. That is exactly the "flyover cuts randomly"
   symptom. The defect is detected today and the response is deletion.
2. **It is explicitly terrain-blind.** `OsmDataFixer.js:11` — *"Pure topology + geometry fixes. No
   DEM. No terrain."* Every hill problem is therefore out of scope by construction, which is why
   hills are the worst case.
3. **Nothing is counted.** No census of how many defects of each class exist, so there is no way to
   know whether a repair rule helped, did nothing, or quietly made things worse.

---

## 1. The one architectural decision that matters

**Repairs are recorded as DATA, in a versioned patch file. They are never applied as opaque inline
code.**

The bake reads `data/regions/<region>/repairs.json`; every entry names the defect, the OSM ids
involved, the action, and its provenance (`rule:<name>` / `ai:<model>` / `human`). The bake applies
patches deterministically and reports which fired.

This is not bureaucracy — it buys four things nothing else does:

- **Reproducible bakes.** Same input + same patch file = same tiles, always. A bake whose output
  depends on a model call is not reproducible, and an unreproducible bake cannot be debugged.
- **Reviewable.** A repair is a diff you can read, not behaviour buried in a 700-line module.
- **Revertible per-repair.** One bad reconstruction gets deleted from the file; it does not require
  reverting a code change and re-baking the region to find out which rule did it.
- **It is the landmark mechanism, free.** "Add the Sagrada Família here", "this junction should be a
  roundabout" is the same file with `provenance: human`. The user's later goal needs no new system.

**Corollary — AI's actual role.** Deterministic rules will resolve the large majority; geometry
defects have geometric signatures. AI earns its place on the *residue*: the cases where the right
answer needs context a rule cannot encode. It runs **offline, as a proposal generator**, writing
entries with `provenance: ai` into the same file, which are then reviewed and frozen. **It never runs
inside the bake.** This keeps determinism while still getting the benefit on hard cases.

---

## 2. Defect taxonomy

Grounded in what has actually been observed, not invented for completeness.

**Horizontal (2D topology)**
- `H1 dangling-end` — a way ends in open space within snapping distance of another way
- `H2 near-miss-junction` — ways cross in 2D at the same layer with no shared node
- `H3 split-not-stitched` — one road as several ways, not joined
- `H4 duplicate` — two ways for one carriageway *(covered today)*

**Vertical (the expensive half)**
- `V1 tunnel-discontinuity` — `tunnel=yes` starts or stops with no portal, so it vanishes
- `V2 bridge-discontinuity` — `bridge=yes` run breaks mid-span *(partly covered)*
- `V3 layer-conflict` — crossing ways whose `layer` tags imply an impossible stack *(covered)*
- `V4 unresolvable-ramp` — **currently DELETED** (`isBrokenRampRoad`); should be reconstructed
- `V5 terrain-conflict` — road elevation disagrees with the DEM surface. **The open buried-road bug
  in `terrain-tunnel-rework-plan.md` is exactly this class**, and it is the reason V-repairs must be
  terrain-aware in a way `OsmDataFixer` is forbidden to be.

**Missing structure**
- `M1 implied-bridge` — a road crosses water/rail/a road below with no bridge tag
- `M2 implied-tunnel` — a road passes under terrain that is above it
- `M3 missing-connector` — a slip road that must exist for the junction to function

---

## 3. Phases

Each phase gates the next. **P-R1 gates everything: no repair rule is written before its defect class
has a count.**

### P-R1 · Census — measure before repairing (1.5 d)
A bake-time pass that detects and **counts** every class in §2, writing
`data/regions/<region>/defect-census.json` plus a console summary. **Detection only — zero repairs.**
Output: how many of each class Barcelona actually has, and where. This decides which rules are worth
writing and which classes are too rare to bother with.
**Done when:** a full-region bake prints a per-class count with example ids, and the numbers are
stable across two runs.

### P-R2 · The patch format + applier (2 d)
`repairs.json` schema, loader, deterministic applier, provenance, and a bake report naming which
patches fired and which did not match (a stale patch must be loud, not silent). **No rules yet.**
**Done when:** a hand-written patch reconstructing ONE known-broken flyover survives a bake and shows
in the report; a deliberately stale patch fails loudly.

### P-R2.5 · The review map — `?debug=defects` (2.5 d)
A 2D map view over `defect-census.json`: every defect as a marker, filterable by class, click to zoom
to it, and for each one a short list of candidate actions (snap these two ends · stitch these ways ·
insert a portal here · leave it). Choosing one writes a `provenance: human` entry into `repairs.json`.

**Why it comes AFTER the census, not before.** The UI is a thin viewer over data the census produces
— its filters, its candidate actions and its very layout are all shaped by which classes turn out to
be common. Built first, it is a guess at a UI for defects nobody has counted.

**Why it is not the primary mechanism.** Hand-review does not scale past a few hundred, and the
census will very likely report more than that. The division of labour: **rules do the bulk, the map
does the residue and the judgement calls.** It is also the natural place to eyeball what the `M`
rules propose (P-R5) and, later, to place landmarks — same file, same provenance field.

**Done when:** a defect can be found, zoomed to, resolved from a candidate list, and the resulting
patch survives a re-bake and shows in the bake report.

### P-R3 · Horizontal rules (3 d)
`H1`-`H3` as rule generators emitting patches. Snapping tolerances derived from the census, not
guessed. **`H4` already works — do not rewrite it.**
**Done when:** census H1-H3 counts drop by a measured amount and a drive over three previously broken
junctions shows connected roads.

### P-R4 · Vertical rules, terrain-aware (5 d, highest risk)
`V1`, `V2`, `V4`, `V5`. **This is where `isBrokenRampRoad`'s DROP becomes a REPAIR**, and it must be
done against the vertical-model spec, not around it. Includes the buried-road fix.
**Done when:** the drop count from `isBrokenRampRoad` falls to near zero with no mangled ramps
replacing them; no floating or buried surface roads on a hill drive.

### P-R5 · Missing structure (4 d)
`M1`-`M3`. Highest false-positive risk — a wrongly-invented bridge is worse than a missing one, so
these rules propose rather than apply, and land as reviewed patches.
**Done when:** every `M`-class patch in `repairs.json` has been eyeballed once.

### P-R6 · AI proposals for the residue (3 d)
Offline tool over whatever the census still reports after P-R3..5. Emits `provenance: ai` patches for
review. **Never in the bake path.**
**Done when:** the tool produces reviewable patches for a sample, and a bake with zero network access
still reproduces the same tiles.

---

## 4. Honest risks

- **This can become a swamp.** The census exists to prevent that: if a class has 11 instances
  region-wide, hand-write 11 patches and skip the rule entirely.
- **A confident wrong repair is worse than a gap.** A missing slip road reads as a missing slip road;
  a hallucinated one reads as a bug. Hence propose-not-apply for `M`, and provenance on everything.
- **Bake time will grow.** Accepted by the user explicitly — it is a one-time offline cost.
- **Re-bake required** at P-R3 and beyond. Golden Rule 5 applies: warn first.
- **Do not let this block v3.** It is orthogonal to P3's art wave and must not be sequenced ahead of
  the minimum-shippable path unless the user re-prioritises.

---

## 5. Recommended sequencing (2026-08-25)

**Do P-R1 (census) now. Stop. Return to v3 P3. Revisit the rest after P3.**

- The census is 1.5 d, ships nothing, and answers the one question that changes the plan's size: are
  there 50 defects region-wide or 5,000? Every later phase is sized off that number, and the review
  map's design depends on it.
- P-R2..P-R6 is ~19 d that does not move the *look*, which is what v3 exists to fix. P3 does.
- Ordering is safe: art is materials and assets, topology repair is geometry. Repairing roads after
  the art wave does not invalidate the art wave.
- **Exception — the buried-road bug (`V5`, `terrain-tunnel-rework-plan.md`) should be fixed on its
  own, now, not held for P-R4.** It is live, visible on an ordinary drive, and it is one bug rather
  than a subsystem.

Revisit if the census reports a defect count high enough that the city cannot read as "professional
and covered" at ship. That is a number, so the decision will be made on evidence rather than feel.


---

## 6. P-R1 PARTIAL — what today's full bake already reports (2026-08-27)

**No new code.** These numbers were already printed by the 2026-08-27 full re-bake and simply never
added up. They are the free half of the census and they change the priority order in §5.

| what the bake says | count | class |
|---|---|---|
| `[BrokenRamp] skipped … not baked` | **332 roads DELETED** | **V4 unresolvable-ramp** |
| `Path-coverage clip … dropped` | **1,809 paths** | (by design — P1 clipping) |
| `Skipped … elevated/underground pedestrian ways` | **1,404** | V1/V2 adjacent |
| `[FloorGap] dropped … terrain through roadway` | **5** | **V5 terrain-conflict** |
| `Rendered ways < parsed ways` | **264 unaccounted** | unclassified |
| `OSM fixer: { rule5: 8748, rule6: 7, rule1: 0, rule4: 0 }` | 8,755 fires | H-class, already covered |
| `[3/8] Skipping way stitching` | **DISABLED** | **H3 split-not-stitched — 0% covered** |

### What this already settles

- **V4 is the big one, and it is a DELETION: 332 roads.** The user reports "a road is missing where
  common sense says one should be there, like a flyover". 332 deleted ramps is the mechanism. These
  are not failures to parse — they are parsed, judged unusable, and dropped by `isBrokenRampRoad`
  (`buildRegion.js:47`). Reconstructing even a fraction is the single highest-value repair rule, and
  it needs no detector work: **the bake already knows exactly which ids it dropped**
  (`droppedRampIds`), it just throws the list away. Writing that Set to the census file is a
  ~5-line change, not 1.5 days.
- **H3 is not merely uncovered, way stitching is switched OFF** (`[3/8] Skipping way stitching`). Any
  H3 count is currently zero because nothing looks. That must be stated as unknown, not as zero.
- **V5 reports only 5**, which contradicts the buried-road measurement of 8.8% of points in
  `terrain-tunnel-rework-plan.md`. `[FloorGap]` counts a narrow hand-listed case, not the class. V5
  genuinely needs the detector P-R1 describes.
- `rule5` firing **8,748** times means the H-class fixer is doing heavy lifting already — so the
  remaining horizontal defects are the ones it cannot see, not the ones it handles.

### Revised P-R1 scope

Split it. **P-R1a (hours, not days):** persist what the bake already knows — dropped ramp ids, floor-gap
ids, the unaccounted-way delta — to `data/regions/barcelona/defect-census.json`. **P-R1b:** write
detectors only for the classes nothing counts today (H1, H2, H3, V5, M1–M3).

---

## 7. P-R1b RESULT — V5 measured, and the detector that was measuring the wrong surface (2026-08-27)

**Attempt 1 — bake-time, against the DEM. Result: 0 conflicts. The detector was wrong.**
It sampled `demSampler`, i.e. the RAW DEM — the very surface roads are fitted to — so of course they
agreed. Its raw output of 564 also refuted itself: every worst deviation was an exact multiple of
`LAYER_STEP` (−6/−12/−18/−24), which a genuinely misplaced road never produces. All 564 were **ramps
descending into tunnels by design**; the scan excluded bridge/tunnel/`layer!=0` but not `isRamp`.

**Attempt 2 — against the terrain that actually SHIPS.** `backend/tools/roadVsTerrain.mjs`, read-only,
no bake: it compares each road vertex to the tile's own **smoothed** elevation grid.

**The bake smooths terrain AFTER fitting roads, and never re-fits them:**
`Selective terrain smoothing: removed-relief RMS=3.31 m max=5.5 m cells>0.5 m=65.2%`.
So a road agrees with a surface that no longer exists and disagrees with the one under the wheels.

| | value |
|---|---|
| road points sampled | 200,030 |
| beyond 0.5 m | **7,862 (3.9%)** |
| floating / buried | **7,862 / 0** |
| p50 deviation | **0.000 m** |
| p99 / max | 6.367 m / 25.11 m |
| **drivable roads only** | 51,439 pts, **2,505 bad (4.9%)**, worst 24.31 m, median-bad 4.72 m |

### What this settles

- **It is purely a FLOATING defect. Nothing is buried** (min −0.17 m, inside tolerance). The
  long-standing "roads buried in terrain" framing in `terrain-tunnel-rework-plan.md` does not survive
  this measurement — it came from a runtime probe measuring the drawn mesh, not the shipped grid.
- **The median road point is perfect (0.000 m).** This is a TAIL, not a systematic offset, which
  matches the user's "in *some* places the road seems floating".
- **p99 sits at 6.37 m ≈ one `LAYER_STEP`.** Ways carrying a layer-step height while tagged
  `layer: 0`, `bridge: false` — untagged elevated structures, mostly footbridges.
- Pedestrian ways dominate the raw count (footway 3,689 + pedestrian 998 = 60%), so the headline
  3.9% overstates what a driver meets. **Drivable-only is 4.9% of points**, worst 24.31 m.

### Three hypotheses tested and DISPROVEN — do not re-run these

Recorded so the next person does not repeat them. Each looked convincing and each failed on evidence.

1. **"Terrain smoothing runs after road fitting."** FALSE. `demLoader.js:187` smooths at DEM *load*,
   so `demSampler` already returns the smoothed surface and roads ARE fitted to it — which is exactly
   why the median deviation is **0.000 m**.
2. **"The water sink lowers the grid under roads."** WEAK. 99% of affected tiles carry water, but the
   **base rate is 64%** — elevated, not causal. And `WATER_SINK_DELTA` is 2.5 m, which cannot produce
   the observed +25 m.
3. **"They are untagged bridges over water (M1)."** FALSE. Point-in-polygon against each tile's closed
   water bodies puts only **68 of 7,862 (1%)** of floating points inside one.

### What is established, and what is not

**Established** (reproducible, read-only, `backend/tools/roadVsTerrain.mjs`): 3.9% of road points and
**4.9% of drivable-road points** float above the shipped terrain; **nothing is buried**; the median is
0.000 m so it is a TAIL; it is concentrated in **72 of 444 tiles**; worst is +25.11 m; p99 is 6.37 m,
suspiciously close to one `LAYER_STEP` (6).

**The class SPLITS IN TWO** (deviation histogram, `roadVsTerrain.mjs`). This is the actionable result:

```
   6 m : 1607   <- LARGEST single bin, and a multiple of LAYER_STEP
   1 m : 1544        2 m : 820     5 m : 778     3 m : 677     4 m : 606
  12 m :  311   <- LAYER_STEP      24 m : 179   <- LAYER_STEP
```

- **~22% (1,734 pts) are QUANTISED to LAYER_STEP** — 6, 12, 24 m. A fitting error cannot do that. A
  road tagged `layer: 0, bridge: false` is being rendered at a layer height, or the height was
  assigned from a neighbour and never cleared. This is a **tagging/propagation defect** (V3-adjacent)
  and it owns the worst outliers, including every point above 12 m.
- **~78% (6,128 pts) are a smooth 1–5 m spread** — a genuine road-vs-terrain fitting mismatch, small,
  and the part that actually decays like an error should.

Two defects, two different repairs. Treating them as one class is why every single-cause hypothesis
above failed: each explained one population and was refuted by the other.

**Not established:** the cause of either half. P-R1's contract is *detection only* and that is now met — the class has
a number, a distribution, a per-tile concentration and a tool to re-measure it. Attributing it belongs
to P-R3/P-R4, with the p99≈LAYER_STEP coincidence as the strongest remaining lead.

⚠ **Do not write a repair yet.** The two fixes previously proposed here both assumed hypothesis 1,
which is disproven; building either now would be fixing a cause that has been ruled out.

### (SUPERSEDED — both premised on the disproven hypothesis 1) The fix is a choice between two

1. **Re-fit roads to the smoothed grid** after smoothing. Correct by construction, but roads are
   already baked by then — an ordering change in the pipeline.
2. **Do not smooth under road corridors.** The smoothing is already "selective"; excluding a corridor
   around each carriageway keeps roads on the surface they were fitted to. Risks a visible ridge
   where a smoothed and unsmoothed region meet.

Both need a re-bake. **(2) is likely cheaper and matches the existing design**, but (1) is the one
that cannot drift. Decide before writing either.
