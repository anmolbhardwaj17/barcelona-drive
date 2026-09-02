# Audio — car sound & ambience TODO

Requested 2026-09-03. **Not started.** Written against a survey of what is actually wired, so the
items below are gaps in the existing system rather than a wish list.

## What exists today

| | state |
|---|---|
| `audio/audioManager.js` | master + **car bus** + **sfx bus**, tab-blur pause, sample registry |
| `car/carSound.js` | synth engine (osc → AM → waveshaper → filter), silenced when samples load |
| assets | `engine_idle.wav`, `engine_mid.wav`, `engine_high.wav`, `skid.ogg`, `horn.ogg`, `ambience.ogg`, `ambience_night.ogg` |
| day/night | ambience beds **crossfade** on the night toggle (1.2 s) — works |
| traffic | a `whoosh` on close pass (`trafficSystem.js:518`) and nothing else |

## The gaps, ranked

### A1 — Three engine samples are on disk and only ONE is ever used
`carSound.js:66` reads `audio.get('engine_mid') || audio.get('engine_idle') || audio.get('engine_high')`
— a **fallback chain, not a blend**. It picks whichever loads and plays that single loop, so
`engine_idle` and `engine_high` are shipped, downloaded, and never heard. The engine therefore has
one timbre at every RPM, with only playback-rate shifting it.

Fix: crossfade all three by RPM (idle → mid → high) with overlapping gain ramps, keeping
playback-rate pitch within each band. **Highest value in this list and it needs no new assets.**

### A2 — Everything is flat stereo
No `PositionalAudio`, `PannerNode` or `createPanner` anywhere. Nothing in the world has a location:
not the traffic, not the street, not the sea. The whoosh is a gain envelope, not a pass-by.

Fix: route world sources through panners tied to the listener (camera). Start with traffic and the
player's own exhaust; the ambience bed should stay non-positional.

### A3 — Traffic is silent apart from the whoosh
Passing cars have no engine at all, so a busy junction is as quiet as an empty one. Needs a cheap
pooled loop per visible car — a handful of shared voices assigned to the nearest N, not one per car.

### A4 — No sense of space; a tunnel sounds like an open street
No `Convolver` or any reverb. Driving into the Ronda trench or a covered tunnel does not change the
sound, which is one of the strongest "you are somewhere" cues a driving game has.
Pairs with `?debug=tunnel` and the existing tunnel classification, which already knows when the car
is enclosed.

### A5 — One city bed for the whole of Barcelona
`ambience.ogg` plays everywhere. No variation for the coast (Barceloneta), a park (Collserola,
Ciutadella), a motorway, or a quiet residential street — even though the tile data already
distinguishes all of them and the light grid proves per-location data reaches the frontend fine.

### A6 — No tyre/surface noise
Nothing ties a rolling sound to speed or to what is under the wheels, though the road data carries
surface class and the game already has panot, asphalt v2 and cobbles as distinct materials.

### A7 — Other cars never use the horn
`horn.ogg` is player-only. Traffic that has been sitting behind a stopped car should eventually use
it — cheap, and it makes a jam feel like a jam.

## Constraints

- Budget: audio has no line in the v3 budget yet. Sample count and voice count both need one before
  A3 ships — pooled voices exist precisely so this cannot scale with car count.
- The tab-blur pause in `audioManager` must keep working for every new source.
- Any new sample goes in `frontend/public/audio/` **with an ATTRIBUTION.md entry** — that file
  already exists and is the standing rule for this directory.
