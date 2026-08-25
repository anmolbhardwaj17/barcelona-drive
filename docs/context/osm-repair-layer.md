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
