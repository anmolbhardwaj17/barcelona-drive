/**
 * workerGeometry.js — Pure-math geometry library for Web Workers.
 *
 * No DOM or Three.js dependencies. All functions return plain typed arrays
 * that can be transferred to the main thread and fed directly into
 * THREE.BufferGeometry via setAttribute / setIndex.
 *
 * Coordinate convention:
 *   Y is up.  Footprint points use {x, y} where x = world X, y = world Z.
 */

// ────────────────────────────────────────────────────────────────────────────
// 1. extrudePolygonWalls
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build wall quads for a closed polygon footprint.
 *
 * Each polygon edge produces a quad (4 unique verts, 2 triangles).
 * UV mapping replicates the Three.js ExtrudeGeometry facade UV generator:
 *   u = wallLength / horizontalRepeatUnit
 *   v = height    / verticalRepeatUnit
 *
 * @param {Array<{x:number, y:number}>} footprintPoints - Closed polygon in world XZ.
 *   If the last point equals the first it is treated as the closing edge; otherwise
 *   an implicit closing edge from last→first is added.
 * @param {number} height - Wall height in metres.
 * @param {number} baseY  - Y offset of the wall base.
 * @param {object|function} uvConfig
 *   Object form: { horizontalRepeat: number, verticalRepeat: number }
 *     — applied uniformly to every wall.
 *   Function form: (wallLength: number) => { hRepeat: number, vRepeat: number }
 *     — called per edge so UV density can vary with wall length.
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array }}
 */
/**
 * v3 P3-03 — signed-area winding normalisation for building rings.
 *
 * WHY. `extrudePolygonWalls`/`extrudePolygonWallBands` derive the outward normal from edge
 * direction: for a CW ring in world-XZ, edge (dx,dz) has outward normal (-dz, dx). OSM footprints
 * arrive in BOTH orientations, so half the buildings in the city are extruded inside-out — their
 * "outward" normals point in, and their triangles wind backwards.
 *
 * That is why backface culling could not be switched on. From changelog 2026-07-06:
 *   "building geometry has inconsistent triangle winding, so no single side renders every building
 *    right (FrontSide left some inside-out as a giant flat plane; BackSide made others hollow)."
 * The flag was flipped, it failed, and it was reverted. Normalising HERE is the prerequisite that
 * attempt was missing — one orientation for every ring, decided from the geometry itself.
 *
 * ⚠ HOLES WIND THE OTHER WAY, DELIBERATELY. A courtyard wall must face INTO the courtyard, which is
 * the opposite outward direction to the outer wall. Normalising an inner ring to the same handedness
 * as the outer one turns every courtyard inside-out — a subtle bug, because courtyards are rare
 * enough to miss on a drive and the building still looks solid from the street.
 *
 * ⚠ THIS DOES NOT BY ITSELF LICENSE `FrontSide`. `worldGroup.scale.x = -1` mirrors the scene and
 * INVERTS the handedness of every triangle, which is why the 2026-07-06 note says exterior =
 * BackSide. Consistent winding is necessary, not sufficient — the flag must still be chosen by
 * looking, and `?debug=winding` exists for that.
 */

/** Shoelace signed area in world-XZ. Positive = counter-clockwise when +x is right and +z is up. */
export function signedAreaXZ(points) {
  let a = 0;
  const n = points.length;
  if (n < 3) return 0;
  // Skip a duplicated closing point — it contributes a zero-length edge but breaks the modulo pairing.
  const closed = Math.abs(points[0].x - points[n - 1].x) < 1e-8 && Math.abs(points[0].y - points[n - 1].y) < 1e-8;
  const m = closed ? n - 1 : n;
  for (let i = 0; i < m; i++) {
    const p = points[i], q = points[(i + 1) % m];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Return `points` wound in the requested direction, reversing a COPY when it is not.
 * @param {{x:number,y:number}[]} points
 * @param {boolean} wantCCW  true for counter-clockwise in world-XZ
 * @returns {{points:{x:number,y:number}[], reversed:boolean}}
 */
export function normalizeRingWinding(points, wantCCW) {
  if (!points || points.length < 3) return { points, reversed: false };
  const area = signedAreaXZ(points);
  // A degenerate ring (collinear, zero area) has no meaningful winding — leave it rather than
  // reversing on the sign of floating-point noise.
  if (Math.abs(area) < 1e-9) return { points, reversed: false };
  const isCCW = area > 0;
  if (isCCW === wantCCW) return { points, reversed: false };
  return { points: points.slice().reverse(), reversed: true };
}

/**
 * v3 P3-02 — MODULAR STOREY BANDS. Splits each wall face into up to three UV-independent bands
 * instead of one quad, and is the fix for the mid-air shopfront.
 *
 * THE BUG IT KILLS. `extrudePolygonWalls` below emits ONE quad per face with `v: 0 -> height/
 * FLOOR_HEIGHT`. The facade tile carries its shopfront in the bottom `groundH/FLOOR_HEIGHT` of its
 * height, so every repeat of the tile paints another shopfront: at 10 m, at 20 m, at 30 m. Measured
 * on the region — a shopfront in MID-AIR on 36,122 of 40,828 buildings (88.5%), twice on 30.8%.
 * A quad has no storey structure to texture, so no texture could have fixed it.
 *
 * THE BANDS, bottom to top:
 *   ground  baseY -> baseY+groundH        v 0 -> gFrac         the shopfront, exactly ONCE
 *   body    -> topY-crownH                v gFrac -> 1, xN     windows only, N = storeys
 *   crown   -> topY                       v cFrac -> 1         reads against the sky
 *
 * `gFrac` = groundH / FLOOR_HEIGHT is the same fraction meshMaterializer paints the shopfront into,
 * so the ground band addresses the shopfront rows and the body band CANNOT — the repeat now starts
 * above it. That is why this works against today's texture and does not wait on the array-texture
 * rebuild.
 *
 * ⚠ SHORT BUILDINGS DEGRADE, THEY DO NOT BREAK. Under groundH there is only a ground band (a shop
 * unit is all you can see anyway); under groundH+crownH there is no body. Emitting a zero- or
 * negative-height band would produce degenerate triangles that survive to the depth buffer as
 * z-fighting slivers.
 *
 * ⚠ VERTEX COST IS REAL: up to 12 verts/face against 4. Worst-tile wall verts go ~33,320 ->
 * ~100,000, which is inside GLOBAL_VERTEX_BUDGET (220,000) only because P1-12 raised it. Do not
 * add a fourth band without re-checking that budget.
 *
 * @param {{x:number,y:number}[]} footprintPoints  polygon, CW in world-XZ for outward normals
 * @param {number} height     building height in metres
 * @param {number} baseY      ground level
 * @param {object} opts
 * @param {number} opts.hRepeatM    world metres per horizontal texture repeat
 * @param {number} opts.groundH     ground-floor/shopfront height in metres
 * @param {number} opts.gFrac       fraction of the texture tile the shopfront occupies (v)
 * @param {number} opts.storeyH     body storey height in metres (UV repeat period)
 * @param {number} opts.crownH      crown band height in metres
 * @returns {{positions:Float32Array,normals:Float32Array,uvs:Float32Array,indices:Uint32Array}|null}
 */
export function extrudePolygonWallBands(footprintPoints, height, baseY, opts) {
  const pts = footprintPoints;
  if (!pts || pts.length < 3 || !(height > 0)) return null;
  const n = pts.length;
  const closed = n > 1 && Math.abs(pts[0].x - pts[n - 1].x) < 1e-8 && Math.abs(pts[0].y - pts[n - 1].y) < 1e-8;
  const edgeCount = closed ? n - 1 : n;
  if (edgeCount < 3) return null;

  const hRepeatM = opts.hRepeatM > 0 ? opts.hRepeatM : 12;
  const gFrac = Math.min(0.9, Math.max(0.05, opts.gFrac ?? 0.38));
  const storeyH = opts.storeyH > 0 ? opts.storeyH : 3.5;
  let groundH = opts.groundH > 0 ? opts.groundH : 3.8;
  let crownH = opts.crownH > 0 ? opts.crownH : 1.2;

  // Decide the band split ONCE for the whole building — every face must agree or the bands step
  // around the building instead of ringing it.
  if (groundH >= height) { groundH = height; crownH = 0; }
  else if (groundH + crownH >= height) { crownH = 0; }
  const bodyH = height - groundH - crownH;

  // v-space: the tile is FLOOR-tall; the shopfront sits in 0..gFrac, the windows in gFrac..1.
  // One body repeat covers the window-only slice of the tile and spans ONE storey in world metres.
  const bodyVPerTile = 1 - gFrac;                      // window-only fraction of one tile
  const bodyRepeats = bodyH > 0 ? Math.max(1, bodyH / storeyH) : 0;

  const bands = [];
  if (groundH > 1e-4) bands.push({ kind: 'ground', y0: baseY, y1: baseY + groundH, v0: 0, v1: gFrac });
  // ⚠ THE MID-AIR SHOPFRONT IS NOT FIXED BY GEOMETRY ALONE — measured here, 2026-08-25.
  // Against TODAY'S tile the shopfront occupies v 0..gFrac, so a body band spanning more than one
  // repeat crosses v=1.0, which wraps to the same rows and paints the shopfront again. Verified:
  // a 12 m building gave body v 0.38 -> 1.62, i.e. a shopfront at v 1.0-1.38.
  //
  // The only way to repeat WINDOWS ONLY against that tile is one quad per storey — and that was
  // costed: 8 bands/face on a 25 m mean-height tile = ~266,000 wall verts against a
  // GLOBAL_VERTEX_BUDGET of 220,000. It does not fit. So the fix belongs to P3-04's window-only
  // texture layer, which is exactly what `windowOnlyTile` switches on. Until then bands REDUCE the
  // defect (one wrap instead of one per 10 m) without eliminating it — do not claim otherwise.
  if (bodyH > 1e-4) {
    const bodyV0 = opts.windowOnlyTile ? 0 : gFrac;
    const bodyV1 = opts.windowOnlyTile ? bodyRepeats : gFrac + bodyRepeats * bodyVPerTile;
    bands.push({ kind: 'body', y0: baseY + groundH, y1: baseY + groundH + bodyH, v0: bodyV0, v1: bodyV1 });
  }
  // The crown samples the TOP of the body tile. Under `windowOnlyTile` the whole tile is windows, so
  // gFrac means nothing there and starting at it would crop the crown to the tile's upper 62%.
  if (crownH > 1e-4) {
    const crownV0 = opts.windowOnlyTile ? 0 : gFrac;
    bands.push({ kind: 'crown', y0: baseY + height - crownH, y1: baseY + height, v0: crownV0, v1: 1 });
  }
  if (!bands.length) return null;

  const quadCount = edgeCount * bands.length;
  const positions = new Float32Array(quadCount * 4 * 3);
  const normals   = new Float32Array(quadCount * 4 * 3);
  const uvs       = new Float32Array(quadCount * 4 * 2);
  const indices   = new Uint32Array(quadCount * 2 * 3);
  // v3 P3-04: per-VERTEX array-texture layer. This is why `aLayer` is per-vertex and not per-building
  // — the ground band indexes the GROUND array while body and crown index the BODY array, which is
  // what lets each layer wrap independently and removes the fract() seam the plan warns about.
  const wantLayers = opts.groundLayer != null || opts.bodyLayer != null;
  const layers = wantLayers ? new Float32Array(quadCount * 4) : null;
  const groundLayer = opts.groundLayer ?? 0;
  const bodyLayer = opts.bodyLayer ?? 0;

  let q = 0;
  for (let i = 0; i < edgeCount; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % n];
    const dx = p1.x - p0.x, dz = p1.y - p0.y;
    const wallLen = Math.hypot(dx, dz);
    // Outward normal for CW winding viewed from above — same convention as extrudePolygonWalls.
    const nx = wallLen > 1e-10 ? -dz / wallLen : 0;
    const nz = wallLen > 1e-10 ?  dx / wallLen : 1;
    const uRepeat = wallLen / hRepeatM;

    for (let bIdx = 0; bIdx < bands.length; bIdx++) {
      const bnd = bands[bIdx];
      const base = q * 4, bp = base * 3, bu = base * 2;
      positions[bp]      = p0.x; positions[bp + 1]  = bnd.y0; positions[bp + 2]  = p0.y;
      positions[bp + 3]  = p1.x; positions[bp + 4]  = bnd.y0; positions[bp + 5]  = p1.y;
      positions[bp + 6]  = p1.x; positions[bp + 7]  = bnd.y1; positions[bp + 8]  = p1.y;
      positions[bp + 9]  = p0.x; positions[bp + 10] = bnd.y1; positions[bp + 11] = p0.y;
      for (let v = 0; v < 4; v++) {
        normals[bp + v * 3] = nx; normals[bp + v * 3 + 1] = 0; normals[bp + v * 3 + 2] = nz;
      }
      uvs[bu]     = 0;       uvs[bu + 1] = bnd.v0;
      uvs[bu + 2] = uRepeat; uvs[bu + 3] = bnd.v0;
      uvs[bu + 4] = uRepeat; uvs[bu + 5] = bnd.v1;
      uvs[bu + 6] = 0;       uvs[bu + 7] = bnd.v1;
      if (layers) {
        const L = bnd.kind === 'ground' ? groundLayer : bodyLayer;
        layers[base] = L; layers[base + 1] = L; layers[base + 2] = L; layers[base + 3] = L;
      }
      const bi = q * 6;
      indices[bi] = base; indices[bi + 1] = base + 1; indices[bi + 2] = base + 2;
      indices[bi + 3] = base; indices[bi + 4] = base + 2; indices[bi + 5] = base + 3;
      q++;
    }
  }
  return layers ? { positions, normals, uvs, indices, layers } : { positions, normals, uvs, indices };
}

export function extrudePolygonWalls(footprintPoints, height, baseY, uvConfig) {
  const pts = footprintPoints;
  const n = pts.length;
  // Determine effective edge count (skip duplicate closing point)
  const closed =
    pts.length > 1 &&
    Math.abs(pts[0].x - pts[n - 1].x) < 1e-8 &&
    Math.abs(pts[0].y - pts[n - 1].y) < 1e-8;
  const edgeCount = closed ? n - 1 : n;

  const vertCount = edgeCount * 4;
  const triCount = edgeCount * 2;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint32Array(triCount * 3);

  const isFunc = typeof uvConfig === 'function';
  const topY = baseY + height;

  for (let i = 0; i < edgeCount; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % n];

    const dx = p1.x - p0.x;
    const dz = p1.y - p0.y;
    const wallLen = Math.hypot(dx, dz);

    // Outward normal (right-hand rule for CW winding viewed from above).
    // For a CW polygon the outward normal of edge (dx, dz) is (-dz, dx).
    // Three.js ExtrudeGeometry with rotateX(-PI/2) produces outward normals
    // consistent with the winding from buildPolygonShape (moveTo(p.x-cx, cy-p.y)).
    // The caller should ensure the polygon winds CW in world-XZ for outward normals.
    let nx, nz;
    if (wallLen > 1e-10) {
      nx = -dz / wallLen;
      nz = dx / wallLen;
    } else {
      nx = 0;
      nz = 1;
    }

    // UV repeats
    let uRepeat, vRepeat;
    if (isFunc) {
      const r = uvConfig(wallLen);
      uRepeat = r.hRepeat;
      vRepeat = r.vRepeat;
    } else {
      uRepeat = uvConfig.horizontalRepeat;
      vRepeat = uvConfig.verticalRepeat;
    }

    // 4 vertices per quad:
    //   v0 = bottom-left  (p0, baseY)
    //   v1 = bottom-right (p1, baseY)
    //   v2 = top-right    (p1, topY)
    //   v3 = top-left     (p0, topY)
    const base = i * 4;
    const bp = base * 3;
    const bu = base * 2;

    // positions  (x, y_up, z)
    positions[bp]      = p0.x; positions[bp + 1]  = baseY; positions[bp + 2]  = p0.y;
    positions[bp + 3]  = p1.x; positions[bp + 4]  = baseY; positions[bp + 5]  = p1.y;
    positions[bp + 6]  = p1.x; positions[bp + 7]  = topY;  positions[bp + 8]  = p1.y;
    positions[bp + 9]  = p0.x; positions[bp + 10] = topY;  positions[bp + 11] = p0.y;

    // normals  (all four share the face normal)
    for (let v = 0; v < 4; v++) {
      normals[bp + v * 3]     = nx;
      normals[bp + v * 3 + 1] = 0;
      normals[bp + v * 3 + 2] = nz;
    }

    // uvs
    uvs[bu]     = 0;       uvs[bu + 1] = 0;
    uvs[bu + 2] = uRepeat; uvs[bu + 3] = 0;
    uvs[bu + 4] = uRepeat; uvs[bu + 5] = vRepeat;
    uvs[bu + 6] = 0;       uvs[bu + 7] = vRepeat;

    // indices (two CCW triangles when viewed from outside)
    const bi = i * 6;
    indices[bi]     = base;
    indices[bi + 1] = base + 1;
    indices[bi + 2] = base + 2;
    indices[bi + 3] = base;
    indices[bi + 4] = base + 2;
    indices[bi + 5] = base + 3;
  }

  return { positions, normals, uvs, indices };
}

// ────────────────────────────────────────────────────────────────────────────
// 2. createCylinderWalls
// ────────────────────────────────────────────────────────────────────────────

/**
 * Open-ended cylinder (walls only, no caps).
 *
 * @param {number} cx       - Centre X in world space.
 * @param {number} cz       - Centre Z in world space.
 * @param {number} radius
 * @param {number} height
 * @param {number} baseY
 * @param {number} segments - Number of radial segments.
 * @param {object|function} uvConfig - Same contract as extrudePolygonWalls.
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array }}
 */
export function createCylinderWalls(cx, cz, radius, height, baseY, segments, uvConfig) {
  const vertCount = (segments + 1) * 2; // top + bottom ring, with seam duplication
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint32Array(segments * 6);

  const topY = baseY + height;
  const perimeter = 2 * Math.PI * radius;

  const isFunc = typeof uvConfig === 'function';
  let uTotal, vTotal;
  if (isFunc) {
    const r = uvConfig(perimeter);
    uTotal = r.hRepeat;
    vTotal = r.vRepeat;
  } else {
    uTotal = uvConfig.horizontalRepeat;
    vTotal = uvConfig.verticalRepeat;
  }

  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    const x = cx + radius * cosT;
    const z = cz + radius * sinT;

    // bottom vertex
    const bi = i * 2;
    const bp = bi * 3;
    positions[bp]     = x;    positions[bp + 1] = baseY; positions[bp + 2] = z;
    normals[bp]       = cosT; normals[bp + 1]   = 0;     normals[bp + 2]   = sinT;

    // top vertex
    const tp = (bi + 1) * 3;
    positions[tp]     = x;    positions[tp + 1] = topY;  positions[tp + 2] = z;
    normals[tp]       = cosT; normals[tp + 1]   = 0;     normals[tp + 2]   = sinT;

    // uvs
    const u = (i / segments) * uTotal;
    const buv = bi * 2;
    uvs[buv]     = u; uvs[buv + 1] = 0;
    uvs[buv + 2] = u; uvs[buv + 3] = vTotal;
  }

  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = (i + 1) * 2;
    const d = c + 1;
    const idx = i * 6;
    indices[idx]     = a; indices[idx + 1] = c; indices[idx + 2] = d;
    indices[idx + 3] = a; indices[idx + 4] = d; indices[idx + 5] = b;
  }

  return { positions, normals, uvs, indices };
}

// ────────────────────────────────────────────────────────────────────────────
// 3. triangulatePolygon
// ────────────────────────────────────────────────────────────────────────────

/**
 * Triangulate a flat polygon (with optional holes) for a roof cap.
 *
 * Earcut is NOT bundled here — pass it in as a parameter or pre-compute the
 * triangle indices externally.
 *
 * @param {Array<{x:number, y:number}>} points - Outer ring (world XZ).
 * @param {Array<Array<{x:number, y:number}>>|null} holes - Optional hole rings.
 * @param {number} y - Y coordinate (height) of the cap surface.
 * @param {function} earcutFn - The earcut function: (coords, holeIndices, dim) => triangleIndices
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array }}
 */
export function triangulatePolygon(points, holes, y, earcutFn) {
  // Build flat coordinate array and hole index array for earcut
  const coords = [];
  for (let i = 0; i < points.length; i++) {
    coords.push(points[i].x, points[i].y);
  }

  let holeIndices = null;
  if (holes && holes.length > 0) {
    holeIndices = [];
    for (const hole of holes) {
      holeIndices.push(coords.length / 2);
      for (let i = 0; i < hole.length; i++) {
        coords.push(hole[i].x, hole[i].y);
      }
    }
  }

  const triIndices = earcutFn(coords, holeIndices, 2);

  // Earcut preserves polygon winding. For an up-facing cap (normal 0,1,0),
  // Three.js needs CCW triangles. Detect outer ring winding via signed area
  // and flip indices if the polygon is CW.
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  // area > 0 → CCW, area < 0 → CW. For CW polygons, reverse each triangle.
  if (area < 0) {
    for (let i = 0; i < triIndices.length; i += 3) {
      const tmp = triIndices[i + 1];
      triIndices[i + 1] = triIndices[i + 2];
      triIndices[i + 2] = tmp;
    }
  }

  const vertCount = coords.length / 2;

  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);

  for (let i = 0; i < vertCount; i++) {
    positions[i * 3]     = coords[i * 2];       // x
    positions[i * 3 + 1] = y;                    // y (up)
    positions[i * 3 + 2] = coords[i * 2 + 1];   // z
    normals[i * 3]     = 0;
    normals[i * 3 + 1] = 1;
    normals[i * 3 + 2] = 0;
    uvs[i * 2]     = coords[i * 2];
    uvs[i * 2 + 1] = coords[i * 2 + 1];
  }

  const indices = new Uint32Array(triIndices);

  return { positions, normals, uvs, indices };
}

// ────────────────────────────────────────────────────────────────────────────
// 4. createBox
// ────────────────────────────────────────────────────────────────────────────

/**
 * Axis-aligned box centred at the origin with 6 faces.
 *
 * @param {number} width  - Extent along X.
 * @param {number} height - Extent along Y.
 * @param {number} depth  - Extent along Z.
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array }}
 */
export function createBox(width, height, depth) {
  const hw = width / 2;
  const hh = height / 2;
  const hd = depth / 2;

  // 24 vertices (4 per face, 6 faces) with unique normals / UVs
  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const uvs = new Float32Array(24 * 2);
  const indices = new Uint32Array(36);

  // Face data: [normal, tangent-u, tangent-v, origin-offset]
  // Each face has 4 corners at origin + u*halfU + v*halfV permutations
  const faces = [
    // +Z face
    { n: [0, 0, 1], corners: [[-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]] },
    // -Z face
    { n: [0, 0, -1], corners: [[hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd]] },
    // +Y face (top)
    { n: [0, 1, 0], corners: [[-hw, hh, hd], [hw, hh, hd], [hw, hh, -hd], [-hw, hh, -hd]] },
    // -Y face (bottom)
    { n: [0, -1, 0], corners: [[-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd]] },
    // +X face
    { n: [1, 0, 0], corners: [[hw, -hh, hd], [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd]] },
    // -X face
    { n: [-1, 0, 0], corners: [[-hw, -hh, -hd], [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd]] },
  ];

  const faceUVs = [[0, 0], [1, 0], [1, 1], [0, 1]];

  for (let f = 0; f < 6; f++) {
    const face = faces[f];
    const base = f * 4;
    for (let v = 0; v < 4; v++) {
      const idx3 = (base + v) * 3;
      const idx2 = (base + v) * 2;
      positions[idx3]     = face.corners[v][0];
      positions[idx3 + 1] = face.corners[v][1];
      positions[idx3 + 2] = face.corners[v][2];
      normals[idx3]     = face.n[0];
      normals[idx3 + 1] = face.n[1];
      normals[idx3 + 2] = face.n[2];
      uvs[idx2]     = faceUVs[v][0];
      uvs[idx2 + 1] = faceUVs[v][1];
    }
    const bi = f * 6;
    indices[bi]     = base;
    indices[bi + 1] = base + 1;
    indices[bi + 2] = base + 2;
    indices[bi + 3] = base;
    indices[bi + 4] = base + 2;
    indices[bi + 5] = base + 3;
  }

  return { positions, normals, uvs, indices };
}

// ────────────────────────────────────────────────────────────────────────────
// 5. createCylinderFull
// ────────────────────────────────────────────────────────────────────────────

/**
 * Full cylinder (walls + top cap + bottom cap) centred at origin.
 * Height extends from -height/2 to +height/2 along Y.
 *
 * @param {number} radiusTop
 * @param {number} radiusBottom
 * @param {number} height
 * @param {number} segments
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array }}
 */
export function createCylinderFull(radiusTop, radiusBottom, height, segments) {
  const hh = height / 2;
  const slope = radiusBottom - radiusTop;
  const slopeLen = Math.hypot(slope, height);
  const nY = slope / slopeLen;
  const nScale = height / slopeLen;

  // Wall ring: (segments+1)*2 verts
  // Top cap: 1 centre + segments verts
  // Bottom cap: 1 centre + segments verts
  const wallVerts = (segments + 1) * 2;
  const capVerts = (1 + segments) * 2; // top + bottom
  const totalVerts = wallVerts + capVerts;

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);

  const wallTris = segments * 2;
  const capTris = segments * 2; // top + bottom
  const indices = new Uint32Array((wallTris + capTris) * 3);

  let vi = 0; // vertex write cursor
  let ii = 0; // index write cursor

  // --- Walls ---
  const wallBase = vi;
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const u = i / segments;

    // bottom
    _setVert(positions, normals, uvs, vi,
      radiusBottom * cosT, -hh, radiusBottom * sinT,
      cosT * nScale, nY, sinT * nScale,
      u, 0);
    vi++;
    // top
    _setVert(positions, normals, uvs, vi,
      radiusTop * cosT, hh, radiusTop * sinT,
      cosT * nScale, nY, sinT * nScale,
      u, 1);
    vi++;
  }
  for (let i = 0; i < segments; i++) {
    const a = wallBase + i * 2;
    const b = a + 1;
    const c = wallBase + (i + 1) * 2;
    const d = c + 1;
    indices[ii++] = a; indices[ii++] = c; indices[ii++] = d;
    indices[ii++] = a; indices[ii++] = d; indices[ii++] = b;
  }

  // --- Top cap ---
  const topCentre = vi;
  _setVert(positions, normals, uvs, vi, 0, hh, 0, 0, 1, 0, 0.5, 0.5);
  vi++;
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    _setVert(positions, normals, uvs, vi,
      radiusTop * cosT, hh, radiusTop * sinT,
      0, 1, 0,
      cosT * 0.5 + 0.5, sinT * 0.5 + 0.5);
    vi++;
  }
  for (let i = 0; i < segments; i++) {
    indices[ii++] = topCentre;
    indices[ii++] = topCentre + 1 + i;
    indices[ii++] = topCentre + 1 + (i + 1) % segments;
  }

  // --- Bottom cap ---
  const botCentre = vi;
  _setVert(positions, normals, uvs, vi, 0, -hh, 0, 0, -1, 0, 0.5, 0.5);
  vi++;
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    _setVert(positions, normals, uvs, vi,
      radiusBottom * cosT, -hh, radiusBottom * sinT,
      0, -1, 0,
      cosT * 0.5 + 0.5, sinT * 0.5 + 0.5);
    vi++;
  }
  for (let i = 0; i < segments; i++) {
    indices[ii++] = botCentre;
    indices[ii++] = botCentre + 1 + (i + 1) % segments;
    indices[ii++] = botCentre + 1 + i;
  }

  return {
    positions: positions.subarray(0, vi * 3),
    normals: normals.subarray(0, vi * 3),
    uvs: uvs.subarray(0, vi * 2),
    indices: indices.subarray(0, ii),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 6. createCircle
// ────────────────────────────────────────────────────────────────────────────

/**
 * Flat circle in the XZ plane (Y=0), facing up (normal 0,1,0).
 *
 * @param {number} radius
 * @param {number} segments
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array }}
 */
export function createCircle(radius, segments) {
  const vertCount = 1 + segments;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint32Array(segments * 3);

  // centre vertex
  positions[0] = 0; positions[1] = 0; positions[2] = 0;
  normals[0] = 0; normals[1] = 1; normals[2] = 0;
  uvs[0] = 0.5; uvs[1] = 0.5;

  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const vi = i + 1;
    positions[vi * 3]     = radius * cosT;
    positions[vi * 3 + 1] = 0;
    positions[vi * 3 + 2] = radius * sinT;
    normals[vi * 3]     = 0;
    normals[vi * 3 + 1] = 1;
    normals[vi * 3 + 2] = 0;
    uvs[vi * 2]     = cosT * 0.5 + 0.5;
    uvs[vi * 2 + 1] = sinT * 0.5 + 0.5;
  }

  for (let i = 0; i < segments; i++) {
    const bi = i * 3;
    indices[bi]     = 0;
    indices[bi + 1] = i + 1;
    indices[bi + 2] = (i + 1) % segments + 1;
  }

  return { positions, normals, uvs, indices };
}

// ────────────────────────────────────────────────────────────────────────────
// 7. createTorus
// ────────────────────────────────────────────────────────────────────────────

/**
 * Torus centred at origin, lying in the XZ plane (major ring in XZ, tube cross-section in the radial/Y plane).
 *
 * @param {number} radius          - Major radius (centre of tube to centre of torus).
 * @param {number} tube            - Tube radius.
 * @param {number} radialSegments  - Segments around the tube cross-section.
 * @param {number} tubularSegments - Segments around the torus ring.
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array }}
 */
export function createTorus(radius, tube, radialSegments, tubularSegments) {
  const vertCount = (radialSegments + 1) * (tubularSegments + 1);
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint32Array(radialSegments * tubularSegments * 6);

  let vi = 0;
  for (let j = 0; j <= radialSegments; j++) {
    for (let i = 0; i <= tubularSegments; i++) {
      const u = (i / tubularSegments) * Math.PI * 2;
      const v = (j / radialSegments) * Math.PI * 2;

      const cosU = Math.cos(u);
      const sinU = Math.sin(u);
      const cosV = Math.cos(v);
      const sinV = Math.sin(v);

      const x = (radius + tube * cosV) * cosU;
      const y = tube * sinV;
      const z = (radius + tube * cosV) * sinU;

      // Normal: direction from centre of tube cross-section to surface point
      const cx = radius * cosU;
      const cz = radius * sinU;
      const nx = x - cx;
      const ny = y;
      const nz = z - cz;
      const nl = Math.hypot(nx, ny, nz) || 1;

      const p = vi * 3;
      const uvi = vi * 2;
      positions[p] = x; positions[p + 1] = y; positions[p + 2] = z;
      normals[p] = nx / nl; normals[p + 1] = ny / nl; normals[p + 2] = nz / nl;
      uvs[uvi] = i / tubularSegments; uvs[uvi + 1] = j / radialSegments;
      vi++;
    }
  }

  let ii = 0;
  const stride = tubularSegments + 1;
  for (let j = 0; j < radialSegments; j++) {
    for (let i = 0; i < tubularSegments; i++) {
      const a = j * stride + i;
      const b = a + stride;
      const c = a + stride + 1;
      const d = a + 1;
      indices[ii++] = a; indices[ii++] = b; indices[ii++] = d;
      indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
    }
  }

  return { positions, normals, uvs, indices };
}

// ────────────────────────────────────────────────────────────────────────────
// 8. createSphere
// ────────────────────────────────────────────────────────────────────────────

/**
 * UV sphere centred at origin.
 *
 * @param {number} radius
 * @param {number} widthSegments  - Longitude divisions.
 * @param {number} heightSegments - Latitude divisions.
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array }}
 */
export function createSphere(radius, widthSegments, heightSegments) {
  const vertCount = (widthSegments + 1) * (heightSegments + 1);
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint32Array(widthSegments * heightSegments * 6);

  let vi = 0;
  for (let y = 0; y <= heightSegments; y++) {
    const v = y / heightSegments;
    const phi = v * Math.PI;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    for (let x = 0; x <= widthSegments; x++) {
      const u = x / widthSegments;
      const theta = u * Math.PI * 2;

      const nx = sinPhi * Math.cos(theta);
      const ny = cosPhi;
      const nz = sinPhi * Math.sin(theta);

      const p = vi * 3;
      const uvi = vi * 2;
      positions[p] = radius * nx; positions[p + 1] = radius * ny; positions[p + 2] = radius * nz;
      normals[p] = nx; normals[p + 1] = ny; normals[p + 2] = nz;
      uvs[uvi] = u; uvs[uvi + 1] = 1 - v;
      vi++;
    }
  }

  let ii = 0;
  const stride = widthSegments + 1;
  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < widthSegments; x++) {
      const a = y * stride + x;
      const b = a + stride;
      const c = a + stride + 1;
      const d = a + 1;
      // Skip degenerate triangles at poles
      if (y !== 0) {
        indices[ii++] = a; indices[ii++] = b; indices[ii++] = d;
      }
      if (y !== heightSegments - 1) {
        indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
      }
    }
  }

  return {
    positions,
    normals,
    uvs,
    indices: indices.subarray(0, ii),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 9. mergeBufferSets
// ────────────────────────────────────────────────────────────────────────────

/**
 * Merge an array of geometry buffer sets into one.
 * Replaces Three.js mergeGeometries for transferable buffer data.
 *
 * Each element may contain:
 *   positions  : Float32Array  (required, 3 components)
 *   normals    : Float32Array  (required, 3 components)
 *   uvs        : Float32Array  (optional, 2 components)
 *   indices    : Uint32Array   (optional — if absent, treat as non-indexed)
 *   colors     : Float32Array  (optional, 3 components)
 *
 * @param {Array<object>} geometryArray
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array|null, indices: Uint32Array, colors: Float32Array|null }}
 */
export function mergeBufferSets(geometryArray) {
  if (!geometryArray || geometryArray.length === 0) return null;

  let totalVerts = 0;
  let totalIndices = 0;
  let hasUVs = false;
  let hasColors = false;
  let hasWash = false;
  let hasAo = false;
  let hasLayers = false;   // v3 P3-04

  // First pass: count totals and detect optional attributes
  for (let i = 0; i < geometryArray.length; i++) {
    const g = geometryArray[i];
    if (!g || !g.positions) continue;
    const vCount = g.positions.length / 3;
    totalVerts += vCount;
    if (g.indices) {
      totalIndices += g.indices.length;
    } else {
      totalIndices += vCount; // non-indexed: one index per vertex
    }
    if (g.uvs) hasUVs = true;
    if (g.colors) hasColors = true;
    if (g.wash) hasWash = true;
    if (g.ao) hasAo = true;
    if (g.layers) hasLayers = true;
  }

  if (totalVerts === 0) return null;

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = hasUVs ? new Float32Array(totalVerts * 2) : null;
  const colors = hasColors ? new Float32Array(totalVerts * 3) : null;
  const wash = hasWash ? new Float32Array(totalVerts) : null;   // 1 float/vertex — facade ground-glow factor
  const ao = hasAo ? new Float32Array(totalVerts) : null;       // 1 float/vertex — baked sky-AO darkening (0 = open)
  const layers = hasLayers ? new Float32Array(totalVerts) : null;  // v3 P3-04: 1 float/vertex — array-texture layer index
  const indices = new Uint32Array(totalIndices);

  let vertOffset = 0;
  let idxOffset = 0;

  for (let i = 0; i < geometryArray.length; i++) {
    const g = geometryArray[i];
    if (!g || !g.positions) continue;
    const vCount = g.positions.length / 3;

    positions.set(g.positions, vertOffset * 3);
    normals.set(g.normals, vertOffset * 3);

    if (hasUVs) {
      if (g.uvs) {
        uvs.set(g.uvs, vertOffset * 2);
      }
      // If g.uvs is missing, the region stays zeroed — acceptable default.
    }

    if (hasColors) {
      if (g.colors) {
        colors.set(g.colors, vertOffset * 3);
      }
    }

    if (hasWash && g.wash) {
      wash.set(g.wash, vertOffset);
    }

    if (hasLayers && g.layers) layers.set(g.layers, vertOffset);
    if (hasAo && g.ao) {
      ao.set(g.ao, vertOffset);
    }

    if (g.indices) {
      for (let j = 0; j < g.indices.length; j++) {
        indices[idxOffset + j] = g.indices[j] + vertOffset;
      }
      idxOffset += g.indices.length;
    } else {
      // Non-indexed: generate sequential indices
      for (let j = 0; j < vCount; j++) {
        indices[idxOffset + j] = vertOffset + j;
      }
      idxOffset += vCount;
    }

    vertOffset += vCount;
  }

  const result = { positions, normals, indices };
  if (uvs) result.uvs = uvs;
  if (colors) result.colors = colors;
  if (wash) result.wash = wash;
  if (ao) result.ao = ao;
  if (layers) result.layers = layers;   // v3 P3-04
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// 10. applyTranslation
// ────────────────────────────────────────────────────────────────────────────

/**
 * In-place translate all positions in a buffer set.
 *
 * @param {{ positions: Float32Array }} buffers
 * @param {number} tx
 * @param {number} ty
 * @param {number} tz
 */
export function applyTranslation(buffers, tx, ty, tz) {
  const p = buffers.positions;
  for (let i = 0; i < p.length; i += 3) {
    p[i]     += tx;
    p[i + 1] += ty;
    p[i + 2] += tz;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 11. applyRotationX
// ────────────────────────────────────────────────────────────────────────────

/**
 * In-place rotate positions and normals around the X axis.
 *
 * @param {{ positions: Float32Array, normals: Float32Array }} buffers
 * @param {number} angle - Radians.
 */
export function applyRotationX(buffers, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  _rotateYZ(buffers.positions, c, s);
  _rotateYZ(buffers.normals, c, s);
}

function _rotateYZ(arr, c, s) {
  for (let i = 0; i < arr.length; i += 3) {
    const y = arr[i + 1];
    const z = arr[i + 2];
    arr[i + 1] = y * c - z * s;
    arr[i + 2] = y * s + z * c;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 12. applyRotationY
// ────────────────────────────────────────────────────────────────────────────

/**
 * In-place rotate positions and normals around the Y axis.
 *
 * @param {{ positions: Float32Array, normals: Float32Array }} buffers
 * @param {number} angle - Radians.
 */
export function applyRotationY(buffers, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  _rotateXZ(buffers.positions, c, s);
  _rotateXZ(buffers.normals, c, s);
}

function _rotateXZ(arr, c, s) {
  for (let i = 0; i < arr.length; i += 3) {
    const x = arr[i];
    const z = arr[i + 2];
    arr[i]     = x * c + z * s;
    arr[i + 2] = -x * s + z * c;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 13. makeBoxGeom
// ────────────────────────────────────────────────────────────────────────────

/**
 * Create an 8-vertex box from two edge points, an outward normal, thickness,
 * a base Y, and a height. Exact replica of the buildingRenderer.js version
 * but returns plain typed arrays instead of THREE.BufferGeometry.
 *
 * Vertex layout:
 *   Front face (facing -normal direction): 0=BL, 1=BR, 2=TR, 3=TL
 *   Back face  (offset by normal*thick):  4=BL, 5=BR, 6=TR, 7=TL
 *
 * Index winding and UV tiling match the original exactly.
 *
 * @param {number} ax   - Edge start X.
 * @param {number} az   - Edge start Z.
 * @param {number} bx   - Edge end X.
 * @param {number} bz   - Edge end Z.
 * @param {number} nrx  - Outward normal X (unit or non-unit — scaled by thick).
 * @param {number} nrz  - Outward normal Z.
 * @param {number} thick - Thickness along the normal.
 * @param {number} y0   - Base Y.
 * @param {number} h    - Height.
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array }}
 */
export function makeBoxGeom(ax, az, bx, bz, nrx, nrz, thick, y0, h) {
  const positions = new Float32Array(8 * 3);

  // Front face vertices (inner wall)
  positions[0]  = ax;              positions[1]  = y0;     positions[2]  = az;
  positions[3]  = bx;              positions[4]  = y0;     positions[5]  = bz;
  positions[6]  = bx;              positions[7]  = y0 + h; positions[8]  = bz;
  positions[9]  = ax;              positions[10] = y0 + h; positions[11] = az;

  // Back face vertices (outer wall, offset by normal * thickness)
  positions[12] = ax + nrx * thick;  positions[13] = y0;     positions[14] = az + nrz * thick;
  positions[15] = bx + nrx * thick;  positions[16] = y0;     positions[17] = bz + nrz * thick;
  positions[18] = bx + nrx * thick;  positions[19] = y0 + h; positions[20] = bz + nrz * thick;
  positions[21] = ax + nrx * thick;  positions[22] = y0 + h; positions[23] = az + nrz * thick;

  // Indices: 6 faces * 2 tris * 3 verts = 36
  // Exact winding from the original code:
  //   front: 0,1,2, 0,2,3
  //   back:  4,6,5, 4,7,6
  //   top:   3,2,6, 3,6,7
  //   bottom:0,5,1, 0,4,5
  //   left:  0,3,7, 0,7,4
  //   right: 1,5,6, 1,6,2
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    3, 2, 6, 3, 6, 7,
    0, 5, 1, 0, 4, 5,
    0, 3, 7, 0, 7, 4,
    1, 5, 6, 1, 6, 2,
  ]);

  // UVs: brick-tile pattern based on edge length and height
  const edgeLen = Math.hypot(bx - ax, bz - az);
  const BRICK_TILE = 2.0; // metres per UV repeat
  const uLen = edgeLen / BRICK_TILE;
  const vH = h / BRICK_TILE;
  // const uT = thick / BRICK_TILE;  // available if cap UVs are needed later

  // 8 vertices: front face (0-3), back face (4-7)
  const uvs = new Float32Array([
    0, 0,   uLen, 0,   uLen, vH,   0, vH,       // front face
    uLen, 0,   0, 0,   0, vH,   uLen, vH,       // back face (mirrored)
  ]);

  // Compute normals from the index buffer + positions
  const normals = _computeVertexNormals(positions, indices);

  return { positions, normals, uvs, indices };
}

/**
 * Flat vertical quad (4 verts / 2 tris) facing outward along (nrx, nrz) — a cheap stand-in for a thin
 * box (makeBoxGeom is 8 verts / 12 tris). Used for balcony balusters, which are sub-pixel-thin and read
 * identically face-on from the street; details render DoubleSide so the quad shows from both sides.
 * Spans the edge (ax,az)→(bx,bz) horizontally and y0→y0+h vertically.
 */
export function makeQuadGeom(ax, az, bx, bz, nrx, nrz, y0, h) {
  const positions = new Float32Array([
    ax, y0,     az,
    bx, y0,     bz,
    bx, y0 + h, bz,
    ax, y0 + h, az,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const BRICK_TILE = 2.0;
  const uLen = Math.hypot(bx - ax, bz - az) / BRICK_TILE, vH = h / BRICK_TILE;
  const uvs = new Float32Array([0, 0, uLen, 0, uLen, vH, 0, vH]);
  const normals = new Float32Array([nrx, 0, nrz, nrx, 0, nrz, nrx, 0, nrz, nrx, 0, nrz]);
  return { positions, normals, uvs, indices };
}

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Write a single vertex into pre-allocated typed arrays.
 * @private
 */
function _setVert(positions, normals, uvs, index, px, py, pz, nx, ny, nz, u, v) {
  const p = index * 3;
  const uvi = index * 2;
  positions[p] = px; positions[p + 1] = py; positions[p + 2] = pz;
  normals[p] = nx; normals[p + 1] = ny; normals[p + 2] = nz;
  uvs[uvi] = u; uvs[uvi + 1] = v;
}

/**
 * Compute smooth vertex normals from indexed triangle positions.
 * Replicates THREE.BufferGeometry.computeVertexNormals().
 * @private
 * @param {Float32Array} positions - 3-component vertex positions.
 * @param {Uint32Array}  indices   - Triangle indices.
 * @returns {Float32Array} normals (same length as positions).
 */
function _computeVertexNormals(positions, indices) {
  const normals = new Float32Array(positions.length);

  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i];
    const ib = indices[i + 1];
    const ic = indices[i + 2];

    const ax = positions[ia * 3];
    const ay = positions[ia * 3 + 1];
    const az = positions[ia * 3 + 2];
    const bx = positions[ib * 3];
    const by = positions[ib * 3 + 1];
    const bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3];
    const cy = positions[ic * 3 + 1];
    const cz = positions[ic * 3 + 2];

    // edge vectors
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

    // cross product (face normal, not normalized — area-weighted)
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    normals[ia * 3]     += nx; normals[ia * 3 + 1] += ny; normals[ia * 3 + 2] += nz;
    normals[ib * 3]     += nx; normals[ib * 3 + 1] += ny; normals[ib * 3 + 2] += nz;
    normals[ic * 3]     += nx; normals[ic * 3 + 1] += ny; normals[ic * 3 + 2] += nz;
  }

  // Normalize
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2];
    const len = Math.hypot(x, y, z) || 1;
    normals[i] = x / len;
    normals[i + 1] = y / len;
    normals[i + 2] = z / len;
  }

  return normals;
}
