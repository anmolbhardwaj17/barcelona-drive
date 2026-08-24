# v3 subsystem audits — index
Full audits in this directory, one file per subsystem. Produced by 12 parallel specialists.

| File | Subsystem | Verdict | Days | Items | VRAM MiB | DL MB | GPU ms | Draws | Tris |
|---|---|---|---|---|---|---|---|---|---|
| [buildings-detail](buildings-detail.md) | Roofs, shopfronts, awnings, terraces, roofto | **REFACTOR** | 10.5 | 11 | 10 | 2.6 | 1.2 | 40 | 180000 |
| [buildings-facade](buildings-facade.md) | Building geometry + facades (workers/buildin | **REBUILD** | 40.1 | 17 | 28 | 5 | 3.6 | 60 | 550000 |
| [hud-progression](hud-progression.md) | HUD / GUI + game progression & modes | **REFACTOR** | 20.0 | 20 | 6 | 1.2 | 0.6 | 12 | 20000 |
| [pipeline-materials](pipeline-materials.md) | Asset pipeline, material system, LOD archite | **REFACTOR** | 26.85 | 19 | 12 | 0.3 | 0.5 | 24 | 0 |
| [road-furniture](road-furniture.md) | Guardrails, barriers, railings, bollards, re | **REBUILD** | 18.5 | 13 | 6 | 2.2 | 0.8 | 24 | 95000 |
| [road-surface](road-surface.md) | Road surface, markings, curbs, sidewalks (as | **REFACTOR** | 21.75 | 19 | 14 | 3.5 | 5 | 110 | 180000 |
| [signage](signage.md) | Signage — billboards, shop fascias, street-n | **REBUILD** | 23.0 | 13 | 9 | 1.2 | 0.6 | 10 | 8000 |
| [sky-atmosphere](sky-atmosphere.md) | Sky, clouds, fog, weather, time-of-day, ligh | **REFACTOR** | 24.2 | 21 | 42 | 1.5 | 4.6 | 34 | 2000 |
| [terrain-coast](terrain-coast.md) | Terrain, hills, beach, coastline (terrainRen | **REBUILD** | 24.0 | 14 | 14 | 1.8 | 2.2 | 12 | 120000 |
| [vegetation](vegetation.md) | Vegetation — trees, bushes, grass, parks/gre | **REBUILD** | 27.0 | 19 | 14 | 3 | 3.2 | 24 | 340000 |
| [vehicles](vehicles.md) | Player car, traffic, parked cars, pedestrian | **REBUILD** | 40.75 | 19 | 30 | 6.5 | 2.5 | 55 | 420000 |
| [water](water.md) | Water: sea surface, harbour/marina basins, w | **REBUILD** | 18 | 10 | 6 | 2 | 1.5 | 8 | 30000 |
| | **SUM OF ASKS** | | **294.65** | | **191** | **30.8** | **26.3** | **413** | **1,945,000** |
| | **CAP** | | | | **200** | **24** | **15.0** | **450** | **2,600,000** |
| | **OVER BY** | | | | **-9** | **+6.8** | **+11.3** | **-37** | **-655,000** |
