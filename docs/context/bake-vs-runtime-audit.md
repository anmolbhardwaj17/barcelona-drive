# Bake-vs-runtime audit — 2026-09-02

**Question:** what does the frontend compute at load/run time that the bake could compute once?

**Baseline is measured, not estimated** — from a real drive at the Gran Via spawn:

```
[perf] initial tile load COMPLETE after 19 polls (~2850 ms), 14 tiles resident
[perf] initial load, main-thread time by build phase (2489 ms total):
  p1 phys:terrain 941ms/46 · p2 buildings 356ms/49 · p1 rg:markings 306ms/46
  p3 vegetation 254ms/10 · p1 rg:crosswalks 125ms/27 · p1 phys:terrain-mesh 84ms/20
  p4 infra 82ms/10 · p1 rg:guardrail 63ms/7
[perf] time-to-drive 5237 ms
```

This is the largest single cost in the game and it is **async**, so it never appears as a frame
section: the loop's `tiles` lap reads 0.9-2.5 ms while the same work lands in `other`.

---

## 1. The architectural finding

**The bake emits VECTOR data. The frontend builds every triangle.** v10 tiles carry roads as
polylines, buildings as footprints, trees as points. Everything that becomes geometry — road
ribbons, lane dashes, crosswalk bars, building extrusions, kerbs, guard rails — is generated on the
player's machine, on every load, in every session, identically every time.

That is the right default for a streamed world (vector data is small and LOD-flexible), and it is
why the load costs 2.5 s of main thread.

### The thesis: bake the DECISIONS, not the vertices

The naive fix — bake vertex/index buffers — trades 2.5 s of CPU for a tile-size explosion. Tiles
are ~340 KB today (149 MB for 444). Baked geometry would be several MB each, and the game already
ships 202 MB.

The expensive part is almost never the triangle emission. It is the **deciding**: clipping lines
against junctions, resolving lane offsets, rasterising masks, rejecting placements that land in a
carriageway. Those outputs are small — a dash is a position, an angle and a length — and they are
what the bake should carry. Estimated cost: **+50-80 KB/tile (~15-25%)**, against several MB for
vertex buffers.

---

## 2. Per-phase verdict

| phase | ms | verdict | why |
|---|---|---|---|
| `p1 phys:terrain` | **941** | ❌ **NOT bakeable** | see §3 — this is the headline correction |
| `p2 buildings` | 356 | 🟡 partly | extrusion is cheap; the **vegetation mask** inside it is the cost and is bakeable |
| `p1 rg:markings` | 306 | ✅ **bake** | best single candidate |
| `p3 vegetation` | 254 | ✅ **bake** | hash-placed, so deterministic |
| `p1 rg:crosswalks` | 125 | ✅ bake | same shape as markings |
| `p1 phys:terrain-mesh` | 84 | ❌ not | mesh construction, same reason as phys:terrain |
| `p4 infra` | 82 | 🟡 partly done | `junctionSigns` already baked (P-D3); placement clearance is not |
| `p1 rg:guardrail` | 63 | ✅ bake | mask is deterministic |

**Bakeable total: ~750-900 ms of the 2489 ms (30-36%).**

---

## 3. The biggest phase is NOT bakeable — and that matters most

`p1 phys:terrain` is 38% of the load, so it looks like the prize. It is not, for two independent
reasons, and both were checked in source rather than assumed:

**It is allocation, not computation.** `buildTerrainHeightfield` (`terrainRenderer.js:828`) turns
the flat baked elevation array into `data[c][r]` — a **nested JS array**, 128 arrays of 128 numbers
per tile — because that is the shape cannon's Heightfield wants. The arithmetic per cell is a
subtract, a multiply and a clamp. You cannot bake an allocation.

**Its normalisation depends on runtime state.** The heights are `(raw - offset) * vertExag` where
`offset` is `getWorldElevationOffset()` — the **spawn-anchored** baseline (D-12). It is not known at
bake time, and it changes with `?spawn=`. Baking normalised heights would hard-code one spawn.

*Optimisation, not bake:* the per-cell arithmetic could collapse into a straight copy if the bake
stored the grid pre-reversed in heightfield orientation (the loop also flips rows and reverses
columns). That removes the maths but not the 16k allocations. Worth a measurement, not a rewrite.

---

## 4. Ranked plan

**B1 — lane markings + crosswalks (~430 ms).** `roadRenderer.js:1637` says it plainly: *"per road it
clips every line against all junctions, offsets per lane, and builds a geometry PER DASH. Densest
Eixample tile measured 70.9 ms."* Junction topology and road geometry both exist at bake time; the
result is a flat list of `(x, z, angle, length, class)`. The runtime keeps the merge, loses the
deciding. **Best value in the audit.**

**B2 — the vegetation mask (inside `p2 buildings`).** Built from roads + buildings + water + a 3×3
neighbourhood of *other tiles' roads*. Cross-tile work is exactly what the runtime does badly and
the bake does trivially — and the runtime version has already shipped one silent bug here (the
neighbour cache key was 3-part against 2-part keys, so it *never matched*). Bake it as a bitmask.

**B3 — vegetation placement (254 ms).** `vegetationWorker` places by `hash2` — deterministic, so
the bake produces byte-identical output. Ship positions + species; drop the scatter at runtime.

**B4 — infra placement clearance (82 ms, partly done).** `roadClearance` pushes lamps and signals
out of carriageways at runtime; the answer is fixed per tile. P-D3 already proved the pattern by
baking junction destinations.

**B5 — road corner smoothing (unmeasured, runs on every tile load).** `roadSmoothing.js` runs in
`readRoads` and costs +26.8% drivable vertices and +632 collider boxes at 18 resident tiles. It is a
pure function of the polyline. Bake the smoothed points and it becomes free.

---

## 5. What NOT to bake

- **Anything spawn-relative.** Elevation normalisation (§3) is the example. `?spawn=` changes it.
- **Anything LOD-dependent.** Geometry is built per LOD; baking one LOD's vertices forfeits that.
- **Vertex buffers generally.** See §1 — the size trade is bad and the CPU saving is the small half.
- **Physics bodies.** Colliders are engine objects; only their *descriptors* could be baked, and
  those are already cheap to derive.

---

## 6. Not yet done

- **No re-bake has been run to validate any of this.** Every figure above is source-read plus the
  user's measured console output. B1 needs a prototype and an A/B before the format bump.
- The **assets/material audit** (the user's second half) is not started: 218 materials, 48
  `CanvasTexture` sites the art bible bans, VRAM against the 200 MiB budget, and which materials
  silently skip the light grid — the family that produced four visible night bugs on 2026-09-02.
