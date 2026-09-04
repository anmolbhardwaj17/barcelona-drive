# Pedestrian system — what it is, what is wrong with it, and the plan

Status: **P-1 shipped 2026-09-04. P-2 … P-6 open.**
Code: `frontend/src/car/pedestrians.js`, baked by `frontend/src/car/carModels.js`
(`loadWalkFramesTemplate` / `loadPeopleWalkTemplates`). Wired in `main.js:1133`, ticked at
`main.js:1819`. Flag: `CONFIG.ENABLE_PEDESTRIANS` (default true).

---

## 0. How it works today

Three rigged Poly Pizza GLBs are loaded once, and every character is **baked into static
vertex-coloured geometries** — one per walk-cycle frame, one idle, one collapsed "fall" pose. Each
baked pose becomes its own `InstancedMesh`. Every frame, each pedestrian is routed into the mesh
matching its current flipbook frame, so legs move while the crowd stays instanced.

    3 variants × (FRAMES walk + idle + fall) InstancedMeshes, CAP_PER_CELL = 45 each, PED_CAP = 168

The bake exists because you cannot instance a skinned mesh cheaply. That trade is sound; almost
everything below is about what was built on top of it.

---

## 1. The three complaints, measured

The user's report was *"they are again too low poly and they don't have much to do, also they move
randomly not smooth"*. All three are real, and none of them is mainly a polygon-count problem.

### 1a. "Too low poly" — mostly a SHADING bug, not a budget

Measured from the shipped GLBs (accessor counts, not estimates):

| model | triangles | materials | **textures** | clips |
|---|---|---|---|---|
| `man.glb` | 1,852 | 6 | **0** | 11 |
| `woman-casual.glb` | 2,776 | 8 | **0** | 11 |
| `woman-dress.glb` | 1,786 | 5 | **0** | 11 |

1,800–2,800 triangles is *not* low for a background crowd figure — ETS2-class pedestrians sit in the
same range. The reason they read as origami is that `bakePosedMesh` ended with:

```js
const nono = out.toNonIndexed();
nono.computeVertexNormals();     // ← every triangle gets its own normal = FLAT shading
```

Every character in the game was being lit **faceted on purpose**. ✅ **Fixed in P-1**: the bake now
returns `toCreasedNormals(out, 55°)` — normals average across edges under the crease angle and stay
hard above it, so cheeks and shoulders round off while collars, cuffs and shoe soles stay sharp.
Same triangles, same draw calls, same memory; only the normal attribute changes.

What is *genuinely* thin, and is **not** fixed: **zero textures**. All three GLBs ship with
`images = 0`; the whole crowd is flat vertex colours pushed through an HSL saturation boost in
`bakePosedMesh` because the raw albedos read muddy. And there are **three** bodies for a whole city.

### 1b. "They don't have much to do" — the clips are already on disk, unused

Every one of the three GLBs ships **eleven** animation clips:

    Clapping · Death · Idle · Jump · Punch · Run · RunningJump · Sitting · Standing · SwordSlash · Walk

The game uses **three**: `Walk` (as the flipbook), `Idle` (one frozen pose), `Death` (one frozen
pose, for a knockdown). `Sitting`, `Standing`, `Clapping` and `Run` are paid for in page weight and
never appear. That is the cheapest available answer to "nothing to do" and it costs no new art.

Behaviourally, the old build gave a pedestrian exactly one verb: pace. ✅ **P-1 adds a walk/stand
state machine** so standing is a *state* with a duration (2.5–11 s) rather than a life sentence —
before, `IDLE_FRAC = 0.25` froze a quarter of every crowd as permanent statues, which reads as broken
rather than as people waiting for something.

Still missing, and listed as P-2/P-3 below: crossing the road, waiting at a kerb, sitting, standing
in twos and threes, going anywhere at all.

### 1c. "They move randomly, not smooth" — three separate defects

1. **A person's whole world was one road SUB-SEGMENT.** The old `reassign` made a candidate out of
   every consecutive point pair of every road (4 m minimum) and put a walker on it with `t ∈ [0,1]`,
   flipping `dir` at each end. On Eixample geometry a sub-segment is commonly 10–30 m, so the crowd
   was a field of people pacing back and forth over three car lengths. Nobody was going anywhere,
   which is exactly what "moves randomly" looks like from the driver's seat.
2. **Facing was assigned, never turned.** `yaw = Math.atan2(...)` outright, so reaching the end of a
   segment or catching sight of the car snapped a person through 180° in a single frame.
3. **The flipbook ran at ~7 fps.** The walk cycle is ~1.15 s and `FRAMES` was 8, so `FRAMES` *is*
   the animation frame rate. `cycRate = speed / 1.4` at 0.9–1.6 m/s gives 5.1–9.1 frames per second:
   stop-motion.

---

## 2. P-1 — what shipped (2026-09-04)

All in `pedestrians.js` + the shading line in `carModels.js`. No tile format change, no re-bake.

| | change | why |
|---|---|---|
| **paths, not segments** | A pedestrian now walks a **path**: the full offset polyline of one side of one road, parameterised by **arc length**. `buildPavementPaths()` / `samplePath()` are module-scope and exported so they are testable without a scene. | They traverse whole streets and round the bends instead of pacing 20 m. |
| **mitred offset** | The walk line is offset with an averaged-tangent **mitre** at interior vertices (capped at 2.5×), not per sub-segment. | Per-segment offsetting leaves a lateral step at every bend — the two offset sub-segments do not meet, and a walker crossing it teleports sideways. Pinned by `pedestrianPaths.test.js`. |
| **ground at the offset point** | `getGroundY` is sampled at the *offset* position, not at the centreline. | On a cross-slope, centreline sampling buries the uphill pavement and floats the downhill one. |
| **smoothed yaw** | `p.yaw` eases toward the target at 7/s walking, 20/s panicking. | People turn; they do not teleport their facing. This is the cheapest single thing that makes the crowd read as people. |
| **walk/stand state machine** | `newLeg()` alternates 9–45 s walking with 2.5–11 s standing, with a 30% chance of turning round during a pause. | Kills the permanent statues; gives the street a pulse. |
| **12-frame flipbook** | `FRAMES` 8 → 12 (~10 fps), and cadence is now `speed / STRIDE` so the feet match the ground covered. | Directly attacks the stop-motion read, and stops the skating. |
| **empty cells cost nothing** | `im.visible = im.count > 0` each frame. | 12 frames × 3 variants is 39 meshes but only ~10–14 hold anyone on a given frame; a zero-count `InstancedMesh` was still being submitted. **This is what makes a longer flipbook free** — net draw calls go *down*. |
| **density, not vertex count** | Target crowd = in-range pavement length ÷ 22 m, capped at `PED_CAP`. | The old `candidates × 0.5` counted *geometry vertices*, so a finely-noded street got a mob and a straight one got nobody. |
| **lateral wobble** | ±0.16 m sinusoidal drift along the path normal, per-person phase. | Nobody walks a surveyed line, and a column of people on the identical offset is the other half of "they look fake". |
| **creased normals** | `toCreasedNormals(geo, 55°)` replaces flat `computeVertexNormals()`. | §1a. |
| **yielding bake** | A macrotask between every pair of frame bakes. | 12 frames × 3 variants of re-skin + normal pass in one synchronous loop is a multi-hundred-ms frame during load. Nothing waits on the crowd. |
| **`userData.type`** | Every ped mesh tagged `'pedestrian'`. | Standing hazard N-18: an untagged mesh is invisible to `_ddPick` and every other probe. |

**Not changed, deliberately:** the knockdown/thrown physics, the dodge behaviour, `PED_CAP`, the
collision-thud audio, and the `castShadow = false` ruling (45 shadow-casting instanced meshes took
FPS to 30 once already).

---

## 3. Open plan

### P-2 — crossings and kerbs (the biggest "something to do" per line of code)
The bake **already flags marked crossings**: `buildRegion.js` collects `footway=crossing` /
`crossing=*` into `crossingIds`, and `convertToBinary.js` writes `entry.crossing = true`. The parser
reads it (`tileParserWorker.js:366`).

⚠ **It does not reach the entity systems.** `tileManager.getLoadedRoadSegments()` is a **whitelist
projection** — a field not copied there simply does not exist downstream, silently, as `undefined`.
`crossing` is not in the list. The file's own comment calls this the seventh copy-site and warns
about exactly this; adding `crossing` would be the eighth. **Add the field first, prove it arrives,
then build on it** (D-23: a counter at the point of decision does not prove the decision reached the
output).

With it: a pedestrian whose path passes a crossing can choose to take it — walk to the kerb, pause,
look, cross to the far pavement, and continue on the path on the other side. That single behaviour
is what makes a city street read as populated rather than as two conveyor belts.

### P-3 — use the clips that are already on disk
Bake `Standing`, `Sitting` and `Clapping` as extra static poses and `Run` as a second flipbook.
Immediate wins: panic uses a real run cycle instead of the walk flipbook at 2.6× rate; idlers get
three different standing poses instead of one; groups of two or three standing together read as
conversation. Cost is `InstancedMesh` count, which the `visible` gate in P-1 has already made cheap,
plus bake time — which is why P-4 should probably land first.

### P-4 — vertex-animation texture (the real animation fix)
Bake every frame of every clip into a `DataTexture` (position + normal), one `InstancedMesh` per
variant, and lerp between adjacent frames in a vertex shader with a per-instance phase attribute.

- **Smooth**, not 10 fps — the interpolation is free on the GPU.
- **39 draw calls → 3**, and adding a clip becomes rows in a texture rather than meshes in a scene.
- Roughly 1.6 MB of float texture per variant at 16 frames; half-float halves it.
- ⚠ The one real trap: the frames must share a **stable vertex order**. `toCreasedNormals` is
  order-preserving (`toNonIndexed` only), but `mergeVertices` hashes *positions*, which change per
  frame — weld from the bind pose once and reuse the map, or the frames will not line up.

This is the item that makes P-3 and P-5 affordable, so it should land before either.

### P-5 — the art gap
Three untextured bodies for a city. Wants: an atlas'd texture (the models have none at all), and
more variants — but per the v3 ruling, variety is not the lever until the shading and animation are
right, and P0-11 deliberately deleted two variants for 3.1 MB of page weight. **Do not add art
before P-4.** Engineering first — see `v3-master-plan.md`.

### P-6 — groups and destinations
Spawn in twos and threes with a shared path and a small lateral spread; give a fraction of the crowd
a *destination* (a shop entrance, a bus stop, a crossing) instead of a direction. Needs P-2 and the
shop/POI data that CLAUDE.md notes is **parsed and discarded today** (14,542 shops).

---

## 4. Conflict with the v3 plan — flagged, not resolved

`carModels.js` carries this note against the deleted variants:

> *the v3 plan cuts the pedestrian art pass entirely and drops `PED_CAP` 168→60*

P-1 is deliberately **engineering, not art**: no new assets, no page weight, and it *reduces* draw
calls. It does not spend the art budget the v3 plan reclaimed. But P-3 and P-5 do contradict that
ruling, and **P-5 must not start without the user overturning it** (Golden Rule 4 — never silently
"fix" a `decisions.md` tradeoff).

---

## 5. Verification — what a drive should show

1. **Nobody paces.** Follow one pedestrian for 20 s: they should cover a whole block and round a
   corner, not turn round every few seconds.
2. **Nobody pivots instantly.** At a path end and when you drive at someone, the turn takes about
   half a second.
3. **No statues.** Park and watch one spot for 30 s: standing people should start walking and
   walking people should stop.
4. **No lateral pop at corners.** Watch a walker take a 90° bend — no sideways jump.
5. **Faces and shoulders are rounded**, collars and shoes still sharp.
6. **STATS / F9**: draw calls should be **down**, not up, despite the longer flipbook.
