# Building facade textures

Naming: **residential_01**, **residential_02**, **residential_03** and **commercial_01**, **commercial_02**, **commercial_03**. Extension can be **.jpg** or **.png** (loader tries both).

- **residential/** — `residential_01`, `residential_02`, `residential_03` (e.g. residential_01.png, residential_02.jpg). Seamless, 1024×1024 max, windows baked in.
- **commercial/** — `commercial_01`, `commercial_02`, `commercial_03` (e.g. commercial_01.png, commercial_02.jpg). Same specs.

Add more by dropping a file (e.g. residential_04.png) and adding an entry to `FACADE_PRESETS` in `buildingRenderer.js`.
