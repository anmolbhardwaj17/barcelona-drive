# Direction signage — deriving destinations from OUR graph

**Status: DESIGN. Feasibility PROVEN with numbers (see §2). No renderer written yet.**

User ask (2026-09-02): real Barcelona-style direction boards at intersections, with directions that
are **accurate and derived from our own understanding of the map — not from OSM destination tags**.
Density is fine ("a lot of them") provided it does not read as congested.

Read [v3-audits/signage.md](v3-audits/signage.md) first. It already ruled REBUILD on the rendering
layer and its numbers are not repeated here.

---

## 1. What is already true (from the audit — do not re-derive)

- **~450 lines of placement logic are correct and stay verbatim**: `findIntersections`,
  `walkPolyline`, `isOnAnyRoad`, `groundInstances`, `generateDirectionBoards`, `generateGantries`,
  `toCatalanTitleCase` in `roadInfraRenderer.js`.
- **Boards are hard-disabled** with `boardInstances = []` (:1477) — a literal, not a CONFIG flag.
  The reason they were killed (floating poles, 05231ae) **is already fixed**: `groundInstances`
  (:1360) terrain-snaps every non-bridge instance and drops unknown-terrain ones.
- **Three walls stop a plain re-enable** — all rendering, none content:
  1. `new THREE.MeshBasicMaterial` per board (:1098) → ~300 draws against a **450-draw city budget**
  2. a 512×384 RGBA texture **per unique street name**, caches with no eviction (:579, :456, :260)
     → 8,966 named roads = 6.7 GiB worst case
  3. those materials never set `userData.sharedMaterial`, so tile unload disposes a texture other
     tiles still hold
- **The fix is known and half-built**: shared atlas + bounded LRU text page + pooled instances.
  `shopSignRenderer.js` already does exactly this in miniature (one atlas, one InstancedMesh,
  per-instance `aUvOffset`, one draw per tile) and is the template.
- **Budget approved**: 9 MiB VRAM · 1.2 MB download · 0.6 GPU ms · 10 draws · 8,000 tris.

## 2. The new part — destination derivation, and it works

The shipped logic signs *"unique names of OTHER roads branching off at this junction"*
(`roadInfraRenderer.js:1028`). That yields a street NAME, not a destination. A Spanish sign says
where the road **leads**.

`backend/tools/destinationProbe.mjs` builds the drivable graph from baked tiles (10,451 ways,
10,209 nodes, **2,966 junctions**, 1,117 of them touching a primary-or-better road) and, from each
exit, runs a **direction-committed best-first walk**: prefer higher road class, must make radial
progress away from the junction, must stay inside a **62° cone** around the exit bearing.

Measured over 400 junctions / 1,387 exits:

| | |
|---|---|
| exit resolves to a named destination | **1,369 (98.7%)** |
| …and it is primary-or-better | **1,262 (91.0%)** |

⚠ **The cone is load-bearing, and its absence is invisible in the headline number.** Without it the
walk fans out, finds the most important road anywhere within reach, and reports **100%** — while
every exit at a junction returns the *same* answer (all 8 samples came back "Via Augusta"). The
percentage looked better and the feature was broken. Always dump per-junction samples and check the
exits DISAGREE.

### Three refinements still owed (visible in the sample dump)

1. **Exclude the road you are on, and require distance.** Many exits resolve to themselves
   (`Travessera de les Corts → Travessera de les Corts @ 0.0 km`). A destination needs a minimum
   run (~300 m) and a name different from the approach.
2. **Normalise names.** OSM carries `Avinguda Diagonal (lateral muntanya)`; a sign says `Diagonal`.
   Strip parenthetical laterals, drop the article, keep the Catalan casing `toCatalanTitleCase`
   already produces.
3. **Rank by more than road class.** A `primary_link` outranking a named avenue is an artefact of
   class ranking alone; length and continuity should weigh in.

### The genuinely local layer — and it needs no tags at all

Barcelona navigates by **mar / muntanya / Llobregat / Besòs** (sea, hills, and the two rivers), not
by compass. That is derivable from geometry alone — the exit bearing plus the coastline `coastline.js`
already carries — and it is both authentically local and immune to missing data. It is the natural
FALLBACK for the 1.3% of exits with no named destination, and a legitimate second line on any board.

## 3. Spanish sign conventions — VERIFY BEFORE ART

What I am confident of: blue backgrounds for autopista/autovía (`A-`, `AP-`, and Barcelona's
`B-10` Ronda Litoral / `B-20` Ronda de Dalt), white with black text for urban/local direction
panels. Barcelona street-name plaques are a separate blue-and-white wall-mounted item, not a
direction board. **Anything beyond that — exact green usage, arrow conventions, lane-assignment
panels — should be checked against reference photography before it is drawn**, not asserted from
memory.

## 4. Phasing

- **P-D1 · destination derivation, offline.** Finish the three refinements above, run over every
  junction, emit a per-junction destination table into the bake. Testable with zero rendering.
- **P-D2 · the rendering rebuild** — the audit's job: shared atlas, bounded LRU text page, pooled
  instances. Blocked on nothing but effort; `shopSignRenderer.js` is the template.
- **P-D3 · re-enable placement** (delete the `[]` literals) and feed it P-D1's table.
- **P-D4 · density tuning.** `MAX_PER_TILE = 20` today. The user accepts many boards but not
  congestion; tune against a drive, not a guess.
