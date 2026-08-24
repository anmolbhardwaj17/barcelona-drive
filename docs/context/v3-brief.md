# v3 Brief — the user's vision, verbatim in spirit

> **Branch: `v3`.** All v3 work lives here. `main` stays clean.
> Stated by Anmol, 2026-08-24. This document is the authority on INTENT. Where any other doc
> conflicts with this one on *what we are trying to build*, this one wins.

---

## The reference

**Euro Truck Simulator 2.** Its textures, its material treatment, its overall feel.

The user's exact calibration — and this is the single most important sentence in the whole project:

> *"those are not too good but definitely better than what we have"*

Read that carefully. It sets the bar in **both** directions:

**It is a CEILING.** ETS2 is not photoreal. It is not archviz. It is not Quixel-photoscan
fidelity. It is honest mid-fidelity game art — moderate-resolution albedo + normal maps, a
cohesive restrained palette, believable wear, correct real-world scale. Roughly 2012–2018
simulation-game art. **Do not over-engineer toward a fidelity the user explicitly said they do
not want.** Effort spent chasing photorealism is effort stolen from coverage.

**It is a FLOOR.** It is still a real bar and we are clearly below it. Normal-mapped surfaces,
textured props, card foliage with correct silhouettes, legible signage, guardrails that read as
metal. Our current flat-shaded, untextured, zero-normal-map look does not reach it.

**The gap between those two lines is exactly where v3 lives.**

---

## Scope — everything the user named

Nothing on this list may be missing from the plan:

| | |
|---|---|
| Boards (billboards, shop signs, street names, traffic signs) | Buildings |
| Roads | Road railings / guardrails |
| Bushes | Grass |
| Trees | Cars |
| Water | Beach |
| Hills / terrain | Clouds |
| Overall atmosphere | HUD / GUI *(later, but planned now)* |
| Game progression map | |

---

## HARD RULE — no slacking

> *"if we have something 60% done but best way to do is something we have to start from scratch,
> we'll start from scratch"*

**Quality of the end result outranks preserving existing work.**

- If a subsystem's architecture cannot reach the ETS2 bar no matter how much is patched →
  **REBUILD**, and cost the rebuild honestly.
- **Sunk cost is not an argument.** Neither is "but it's 5000 lines."
- The inverse is equally binding: **do not rewrite for its own sake.** A rebuild justified by code
  aesthetics rather than a better end result is waste — and waste spends budget another subsystem
  needed. That is also slacking.
- The only test: *which produces the better end result within the binding constraints?*

---

## Binding constraints

1. **IT STAYS A BROWSER GAME.** Zero-install, click-a-link-and-drive. This is the product's best
   feature and no proposal may trade it away. Desktop-first; must **scale down** to mobile, not
   exclude it.
2. **Assets must be FREE.** CC0 (Poly Haven, ambientCG, Kenney, Quaternius, Poly Pizza) +
   AI-generated (Draw Things, tiling mode on) + Blender-authored. **Never NC-licensed** — the site
   is deployed on a custom domain.
3. **City-wide budget caps** (from the v2 hardening; these are per-CITY, not per-subsystem):
   - texture VRAM **≤ 200 MiB** resident
   - art library download **≤ 24 MB** over the wire
   - p95 GPU **≤ 15.0 ms** at 80 km/h **at night** in dense Eixample
   - draws **≤ 450**, triangles **≤ 2.6 M**
4. **Systematic, not brief.** The user asked explicitly that we not compress the work to save
   context: *"everything should be systematic keeping all edges and all scenarios in mind and
   proper binding of those."* Cover the edges. Bind the dependencies. Detail is wanted.

---

## Method

The user asked for this to be settled by **multi-agent debate**, not by one opinion:

> *"proper multi agent debate should happen keeping quality in mind for all the aspects of game"*

v3 planning therefore runs: 12 subsystem audits → 6 hostile cross-examinations whose primary brief
is enforcing the no-slacking rule in both directions → 3 reconciliation judges (rebuild rulings,
one unified budget, art-direction cohesion) → one master plan.

---

## Sequencing note

HUD/GUI comes **later** — the user was explicit. But it is **planned now**, so the art direction
and the progression design bind together instead of being retrofitted.

---

## Related

- [v3-master-plan.md](v3-master-plan.md) — the plan this brief produced (written after the debate)
- [v2-plan-hardened.md](v2-plan-hardened.md) — prior 12-agent output. Its **measurements are
  trustworthy**; its **conservatism is not** — it was written under a "reuse what exists"
  assumption this brief overturns.
- [ets2-target-audit.md](ets2-target-audit.md) — the original feasibility audit (carries a
  correction banner; §0 constraints and §6 free-asset strategy still stand)
