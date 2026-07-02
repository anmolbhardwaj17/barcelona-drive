# Delhi 3D Driving Simulator

Browser-based 3D driving simulator using real OpenStreetMap data for Delhi. Roads and building footprints are streamed by tile; you drive with WASD and see the current street name and speed.

## Tech stack

- **Frontend:** Three.js, cannon-es (physics), Vite
- **Backend:** Node.js (Express)
- **Map data:** OpenStreetMap via Overpass API
- **Projection:** Web Mercator (EPSG:3857)

## Run locally

### 1. Backend (map API)

```bash
cd backend
npm install
npm start
```

Server runs at `http://localhost:3001`. Endpoint: `GET /map?bbox=south,west,north,east` (WGS84 degrees).

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

App runs at `http://localhost:5173`. Ensure the backend is running so map tiles can load.

### 3. Play

- **W** – accelerate  
- **S** – brake / reverse  
- **A / D** – steer  
- Camera follows the car. Street name and speed are shown at the bottom of the screen.

The car spawns near Delhi center (Connaught Place area). Tiles load in a 3×3 grid (500 m per tile) around the car and unload when you drive away.

## Project structure

```
backend/           # Express + Overpass + OSM parsing, building shapes
frontend/
  src/
    main.js        # Entry, loop, car + tile + UI wiring
    scene.js       # Three.js scene, camera, renderer, physics world
    projection.js  # Web Mercator, world origin (Delhi), tile bbox
    car/           # RaycastVehicle, WASD, camera follow
    map/           # Tile manager, map loader, road/building renderers, spatial index
    ui/            # Street name and speed DOM overlays
```

## Configuration

- **Backend:** `PORT` (default 3001), `OVERPASS_URL` (default `https://overpass.private.coffee/api/interpreter`), `OVERPASS_REQUEST_TIMEOUT_MS` (default 45000). Overpass usage follows the [Overpass API wiki](https://wiki.openstreetmap.org/wiki/Overpass_API). To use the main instance: `OVERPASS_URL=https://overpass-api.de/api/interpreter`.
- **Frontend:** `VITE_MAP_API` (default `http://localhost:3001`) for the map API base URL.

## Test Overpass from terminal (one tile, 500 m bbox)

Same request the backend makes. Replace the bbox with any `south,west,north,east` in WGS84 degrees.

```bash
curl -s -X POST "https://overpass.private.coffee/api/interpreter" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "User-Agent: curl/7.68.0" \
  -d 'data=[out:json][timeout:15][bbox:28.6139,77.209,28.6184,77.214];(way["highway"];way["building"];);out geom;' \
  | head -c 500
```

To test your **backend** (after `npm start`):

```bash
curl -s "http://localhost:3001/map?bbox=28.6139,77.209,28.6184,77.214" | head -c 500
```

## Why backend / Overpass can be slow or not respond

- **Overpass is external:** The backend only proxies; every `/map` request triggers a live Overpass API call. If the Overpass instance is overloaded or rate-limiting (429), you get slow responses or XML error bodies instead of JSON.
- **Instance choice:** Default is `overpass.private.coffee`. Set `OVERPASS_URL` to another instance (e.g. `https://overpass-api.de/api/interpreter`) if one is faster for you; public instances often throttle.
- **Timeouts:** Request timeout is 45 s (`OVERPASS_REQUEST_TIMEOUT_MS`). Overpass query timeout is 15 s. If the bbox is large or the server is busy, you may hit timeouts and see no JSON (or an XML error in logs).
- **Network / Node:** We use IPv4-first DNS, keep-alive, and a curl-like User-Agent to avoid slow or broken paths. If responses still don’t arrive, check firewall/proxy and try the same query with `curl` (see above) to compare.

When Overpass returns an error (timeout, 429, etc.) it often sends **XML**. The backend now detects XML and rejects with a short snippet in the error message so logs show the real cause instead of “invalid JSON”.

## Performance

- Tiles are 500 m; only a 3×3 set around the car is kept (~2.25 km² visible).
- Road geometry uses low-segment tubes; buildings use extrusion or cylinders.
- A warning is logged if a tile exceeds 100k vertices (see `tileManager.js`).

## Extending buildings

The building renderer is built so you can later add roof types, balconies, windows, LOD, or replace simple extrusion with GLTF. Each building mesh has `userData: { id, tags, height }`; geometry is created in `buildingRenderer.js` from the backend payload without server-side triangulation.
