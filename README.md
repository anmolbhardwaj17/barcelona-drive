# Barcelona Drive

A browser-based, open-world **3D driving simulator of Barcelona**, built on real OpenStreetMap data and a real elevation model. Drive an M-series coupe through a streamed, procedurally-detailed city — the Eixample grid, chamfered corners, Montjuïc's slopes, the waterfront — with traffic, pedestrians, and physics-driven handling.

Built with **vanilla JavaScript + Three.js** (no framework) and **cannon-es** physics. The world is pre-baked offline from an OSM PBF extract and a Copernicus DEM into a compact binary tile format, then streamed to the browser as you drive.

> Migrated from an earlier Delhi build — hence the `delhi-drive` working directory. The active region is Barcelona.

---

## Features

- **Real city geometry** — roads, buildings, sidewalks, curbs, crosswalks, tram/rail, water, piers, and beaches derived from OpenStreetMap.
- **Real terrain** — elevation draped from a Copernicus GLO-30 DEM; hills, slopes, and grade you can feel.
- **Vehicle physics** — `CANNON.RaycastVehicle` with transmission, weight transfer, downforce, an anti-spin stability assist, and an arcade **handbrake drift** on Space.
- **Living city** — AI traffic that follows lanes and chains through intersections, instanced pedestrians that walk, dodge oncoming cars, and get knocked down, plus parked cars and contact shadows.
- **Streaming world** — 500 m × 500 m slippy tiles at zoom 16, loaded in a ring around you and unloaded behind you, with per-frame build budgeting to keep the frame rate smooth.
- **Detail systems** — street furniture, traffic lights, Spanish-style road signs, streetlights, skid marks, tree LOD (3D → billboard), and a day/night toggle.
- **Free-fly camera** for exploring the map without the car.

---

## Tech stack

| Layer | Tech |
|---|---|
| Rendering | [Three.js](https://threejs.org/) (vanilla, no framework) |
| Physics | [cannon-es](https://github.com/pmndrs/cannon-es) — `RaycastVehicle`, heightfield terrain |
| Geometry offload | Web Workers (buildings, vegetation, grass, mesh materialization) |
| Build/dev | [Vite](https://vitejs.dev/) |
| Backend | Node.js + [Express](https://expressjs.com/) — static binary-tile server |
| Bake pipeline | `osm-pbf-parser`, `geotiff`, `rbush` — OSM PBF + DEM → binary v7 tiles |
| Projection | Web Mercator (EPSG:3857) |

---

## How it works

```
 OSM PBF extract ─┐
                  ├─►  bake pipeline  ─►  binary v7 tiles  ─►  Express  ─►  browser
 Copernicus DEM ──┘   (worldBuilder/)     (backend/tiles/)     (:4041)      (Three.js @ :4040)
```

The heavy work happens **offline**: `backend/worldBuilder/buildRegion.js` reads the PBF + DEM and bakes each tile into a compact binary format (`v7`). At runtime the Express server just serves those files statically, and the frontend streams, decodes, and builds them into meshes + physics colliders on the fly (with geometry offloaded to a worker pool).

> **Coordinate note:** the scene is X-mirrored (`worldGroup.scale.x = -1`) and physics negates X at the renderer↔physics boundary. If you touch geometry/physics conversions, read [`docs/context/coordinate-systems.md`](docs/context/coordinate-systems.md) first.

---

## Getting started

### Prerequisites

- Node.js 20+ (Vite 7)
- **Map tiles.** The baked tiles (`backend/tiles/`, ~12 GB) and the region source data (`data/regions/` — OSM PBF + DEM, ~2 GB) are **git-ignored**, so a fresh clone has no map to drive on. You must either bake the tiles yourself (see [Baking the world](#baking-the-world)) or drop in a pre-baked `backend/tiles/barcelona/` directory.

### Install

```bash
# from the repo root
cd backend  && npm install
cd ../frontend && npm install
```

### Run

```bash
# 1. Tile server  → http://localhost:4041
cd backend && npm start

# 2. Frontend dev → http://localhost:4040
cd frontend && npm run dev
```

Open **http://localhost:4040**.

> **Port note:** the backend hard-codes `Access-Control-Allow-Origin: http://localhost:4040`, and Vite is configured to serve on `4040`. If you change one, change both (`backend/server.js` and `frontend/vite.config.js`).

---

## Controls

| Key | Action |
|---|---|
| **W** / ↑ | Accelerate |
| **S** / ↓ | Brake / reverse |
| **A** / ← , **D** / → | Steer |
| **Space** | Handbrake — hold while turning to drift |

### URL toggles

Append to the URL and reload:

| Param | Effect |
|---|---|
| `?mode=car` (or `?car`) | Drive the car |
| `?mode=fly` (or `?fly`) | Free-fly camera, no car |
| `?debug=tunnel` | Tunnel/collider debug overlay |

Combine freely, e.g. `http://localhost:4040/?mode=car&debug=tunnel`.

---

## Baking the world

Baking reads the region source data in `data/regions/barcelona/` (an OSM `.pbf` extract + a DEM GeoTIFF — both git-ignored) and writes binary tiles to `backend/tiles/barcelona/`.

```bash
cd backend

# Full Barcelona region (slow — minutes)
npm run build:region

# Faster partial bakes (need the PBF + DEM in data/regions/barcelona/)
node worldBuilder/buildRegion.js --area eixample    # ~20 tiles around the Eixample
node worldBuilder/buildRegion.js --area montjuic     # port + Montjuïc elevation

# Single-tile dry run (prints v7 feature counts, writes one tile)
BAKE_SINGLE_TILE=16_33143_24488 node worldBuilder/buildRegion.js --area eixample
```

After re-baking, clear the browser tile cache: run `window._clearTileCache()` in the dev console and hard-reload, or stale tiles will be served.

> Re-baking is expensive and can invalidate runtime assumptions about baked elevation. See [`docs/context/bake-pipeline.md`](docs/context/bake-pipeline.md) before changing the pipeline.

---

## Project structure

```
backend/
  server.js               # Express static tile server (:4041)
  worldBuilder/           # OSM PBF + DEM → binary v7 tile bake pipeline
  osmParser.js, roadProcessor.js, buildingShapes.js, ...
  tiles/                  # baked tiles (git-ignored, ~12 GB)

data/regions/             # OSM PBF + DEM source data (git-ignored, ~2 GB)

frontend/src/
  main.js                 # game loop, init, spawn, subsystem wiring
  config.js               # feature toggles + tuning constants
  car/                    # vehicle physics, controls, camera, effects, traffic, pedestrians
  map/                    # tile streaming, road/building/vegetation renderers, colliders
  workers/                # geometry + mesh-materialization Web Workers
  ui/                     # minimap, HUD, day/night toggle

docs/context/             # deep-dive architecture docs (see CLAUDE.md for the index)
```

For a full map of the codebase, invariants, and design decisions, start at [`CLAUDE.md`](CLAUDE.md), which indexes the docs in [`docs/context/`](docs/context/).

---

## Configuration

- **Feature flags & tuning** live in [`frontend/src/config.js`](frontend/src/config.js) — enable/disable traffic, pedestrians, trees, bushes, skid marks, day/night, adjust tree LOD distances, physics constants, etc.
- **Backend port** via `PORT` env (default `4041`).

---

## Deploying

Because the baked tiles are git-ignored, a deployed instance needs the map data supplied separately. Options:

1. Run the bake pipeline on the server and serve `backend/tiles/` from Express.
2. Host the baked tiles on object storage / a CDN and point the frontend at that base URL.
3. Ship a small subset of tiles for a limited playable area.

The frontend is a static Vite build (`npm run build` in `frontend/`); the backend is a small Express app whose only job is serving tile files.

---

## Credits

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL).
- Elevation from the [Copernicus GLO-30](https://spacedata.copernicus.eu/) global DEM.
- 3D models from Kenney and Poly Pizza (check individual asset licenses before redistribution).

Built with [Claude Code](https://claude.com/claude-code).
