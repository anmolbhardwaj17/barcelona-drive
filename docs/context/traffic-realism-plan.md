# Traffic realism — turns and signals

**Status: T-1, T-2, T-3 all SHIPPED 2026-09-01.** Audit done against the running code, not the
comments. What each turned into is recorded under its heading below; the plan text is kept so the
reasoning stays checkable against the result.

## What already exists (audited, not assumed)

| | |
|---|---|
| **Movement** | Kinematic. Cars follow a road centreline offset into the right lane, stepping by arc length. No per-car vehicle physics. |
| **Queueing** | ✅ Works. Cars stop when the lane ahead is blocked by the player or another car; `DEADLOCK_T` despawns any that stay stuck. |
| **Junction chaining** | ✅ **Exists** — `extendPath()` hooks onto a connected road at the end of a path. ⚠ The file header still claims "v1 doesn't chain junctions"; that comment is STALE and was believed for a while. |
| **Speed by class** | ✅ residential 7 m/s → trunk 16 m/s (`SPEED_BY_TYPE`). |
| **Collision** | ✅ Rebuilt 2026-09-01 (V-12/V-13): oriented-box contact test, one bounded impulse. |
| **Signal data** | ✅ **Already baked** — `trafficSignals` per tile: **4,225 across 442 centre tiles, 9.6 average, 88 max**. Parsed and DISCARDED today. |
| **Junction data** | ✅ Baked (`junctions`). |
| **Signal geometry + phase cycle** | ⚠ Written (`generateTrafficLights`, `updateTrafficLights`) and **switched off by the user**: "in daylight the signal box just read as an ugly dark box on a stick sitting in the driving path". |
| **AI obeying signals** | ❌ Zero references to signals in `trafficSystem.js`. |

## Is this affordable in a browser? Yes, and not marginally

- ~**134 signals** resident at 14 tiles.
- Phase state is `(clock % cycle)` per junction group — O(1), no per-frame allocation.
- Each of **28** cars tests one junction ahead → ~160 trivial ops per frame against a 13.75 ms budget.
- Path building is already throttled (`_buildBudget = 4`, `_extendBudget = 2` per frame); signals add
  no new path work.
- Rendering is the only real cost and it is instanced through the existing infra pools.

The expensive parts of this game are terrain, buildings and vegetation (see the load phase report).
Traffic logic does not register next to them.

## Plan

### T-1 · Cars actually turn — ✅ SHIPPED, then ⚠ FIXED 2026-09-02

**The first version could not turn at all in the Eixample, and the weighted choice hid it.** The
U-turn guard `dot <= 0.15` permits turns up to **81 degrees**. Barcelona's Eixample is a
PERPENDICULAR grid, so every cross street is dot ≈ 0.0 and was rejected — the only candidate that
ever survived was straight ahead. Weighting the choice changed nothing because there was never more
than one thing to weight.

It also caused the jams the user photographed: a T-junction whose only exits are 90 degrees left and
right had NO legal continuation, so the car reached its path end, stopped in the carriageway, and
never moved again (the anti-deadlock deliberately spares cars near the player).

Threshold re-derived over all 20,902 directed way-ends in the city:

| reject below | max turn | dead ends |
|---|---|---|
| `0.15` (was) | 81° | **21.3%** |
| `0.0` | 90° | 17.8% |
| **`-0.10`** (now) | **96°** | **16.9%** |
| `-0.30` | 107° | 16.7% |
| `-0.50` | 120° | 16.6% |

`-0.10` takes nearly the whole win; past it the curve is flat and only admits near-U-turns.
Two follow-on fixes: the weight clamps `dot` at 0 before squaring (`dot*dot` is symmetric, so a raw
negative would score a sharp turn like a gentle one), and a car that genuinely runs out of road is
now despawned even in view — out of road is not the same as blocked, and sparing it leaves a
permanent roadblock. `window._ddTrafficStats()` reports the extend fail rate.

### T-1 (original entry)

**Landed as:** weighted continuation choice in `extendPath()`
(`w = 0.35 + dot * dot * 2.4`, so straight stays most likely without always winning) plus a corner
slowdown (`_turnSlow = 0.45 + _turnDot * 0.55` held for `_turnSlowT = 2.4` s). No new `buildPath`
calls — only which result is kept.


`extendPath()` chains junctions correctly but chooses **greedily**:

```js
let best = null, bestDot = 0.15;                    // rejects U-turns
if (dot > bestDot) { bestDot = dot; best = cont; }  // keeps the STRAIGHTEST
```

Turns are permitted (0.15 allows up to ~81°) but a straight option always wins, so at a crossroads
every car goes straight — which is what the city looks like today.

Change: collect ALL valid continuations, then pick by weight instead of by maximum. Straight stays
the most likely, because it is in reality; turns become genuinely possible.
Also needed, or the turn reads as a skid:
- **slow into it** — corner speed scales with how sharp the turn is
- keep the existing per-frame extend budget; this adds no new `buildPath` calls, it only changes
  which result is kept

### T-2 · Signal geometry — ✅ SHIPPED

**Landed as:** `frontend/src/map/trafficSignalRenderer.js`. Slim 4.05 m pole, kerbside, with the
Barcelona two-head arrangement (main head at 3.35 m + repeater at 1.32 m so the front of the queue
can still read it). Heads face oncoming traffic via the nearest-road tangent — lenses edge-on to the
driver was most of why the old ones read as anonymous dark boxes.

⚠ The kerb offset alone put poles in the crossing carriageway at junctions; they now go through
`roadClearance.js` as well (2026-09-01). See `window._ddSignalStats()`.


The logic exists; it was switched off because the geometry read as a dark box on a stick in the
driving path. Barcelona signals are slim poles with a compact head, usually kerbside rather than
overhead. Re-author, then re-enable behind the existing flag.

### T-3 · Signals drive the AI — ✅ SHIPPED

**Landed as:** `isRedFor(axis, time, phase)` against a single shared clock (`signalNow()`), consumed
by `trafficSystem.update` via the metadata the RENDERER returns — not recomputed. Deriving the axis
and phase twice is how a car ends up obeying a different phase from the lamp in front of it. The
player is not forced to obey.


1. Group baked `trafficSignals` by nearest junction.
2. One shared phase clock so every car agrees; opposing approaches get opposite phases.
3. A car approaching a junction whose phase is red for its approach decelerates to the stop line.
   Reuses the queueing that already works — it is the same "something ahead" behaviour with a
   different trigger.
4. The player is not forced to obey. Running a red should be possible; that is a game, not a
   driving test.

## Order and why

T-1 first: unblocked, self-contained, and the biggest realism-per-hour. T-2 gates T-3, because
teaching cars to obey lights nobody can see is untestable and unverifiable.
