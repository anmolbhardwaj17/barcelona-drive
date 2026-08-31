# Traffic realism — turns and signals

**Status: T-1 in progress.** Audit done 2026-09-01 against the running code, not the comments.

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

### T-1 · Cars actually turn *(no assets, self-contained)*

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

### T-2 · Signal geometry *(needs a look from the user — this is why it was disabled)*

The logic exists; it was switched off because the geometry read as a dark box on a stick in the
driving path. Barcelona signals are slim poles with a compact head, usually kerbside rather than
overhead. Re-author, then re-enable behind the existing flag.

### T-3 · Signals drive the AI *(gated on T-2 — no point obeying invisible lights)*

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
