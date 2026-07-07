/**
 * customMap — a self-drawn vector minimap rendered from the baked v7 tile data (roads, buildings,
 * water, parks), styled to match the 3D game. Replaces the Leaflet/OSM raster minimap so every road on
 * the map is a road you can actually drive, with full colour/label control and zero network dependency.
 *
 * Coordinate frame (same one the car position is given in): point.x = world EAST, point.y = world Z =
 * NORTH. On screen we draw east → +x (right) and north → −y (up), i.e. north-up. The minimap's existing
 * container rotation (heading-up) then applies unchanged.
 *
 * Data flow: tileManager calls ingestTile(key, tileData) when a tile loads and removeTile(key) when it
 * unloads. draw() composites the loaded features around the car each frame (hard-culled by bbox).
 */

// Road class → { width fallback (m), tier }. Thickness uses the real road.width when present.
const ROAD_CLASS = {
  motorway: 'major', motorway_link: 'major', trunk: 'major', trunk_link: 'major',
  primary: 'major', primary_link: 'major', secondary: 'major', secondary_link: 'major',
  tertiary: 'mid', tertiary_link: 'mid',
  residential: 'minor', living_street: 'minor', unclassified: 'minor', service: 'minor',
  pedestrian: 'path', footway: 'path', path: 'path', cycleway: 'path',
};

// Palette pulled toward the 3D world: warm ground, game green parks, game blue water, tan buildings.
const STYLE = {
  day: {
    ground:    '#d7d1c3',
    park:      '#7ea24f',
    water:     '#6d9ac4',
    building:  '#c9c0a8',
    buildingEdge: '#b0a68b',
    casing:    '#b7ad95',
    road: { major: '#ffffff', mid: '#f4efe3', minor: '#ece6d8', path: '#d8c8a8' },
  },
  night: {
    ground:    '#141b2f',
    park:      '#2b472e',
    water:     '#1d3555',
    building:  '#28304a',
    buildingEdge: '#1b2236',
    casing:    '#0e1325',
    road: { major: '#8a94ad', mid: '#69738c', minor: '#4b5468', path: '#3a4260' },
  },
};

// Minimum on-screen road thickness (px) by tier so minor roads don't vanish at small scale.
const MIN_PX = { major: 3.2, mid: 2.6, minor: 2.0, path: 1.4 };

function bboxOf(pts) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of pts) {
    if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
    if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
  }
  return [minx, miny, maxx, maxy];
}

export function createCustomMap() {
  // key -> { roads:[{pts,w,tier,bbox}], water:[{pts,bbox}], parks:[{pts,bbox}], builds:[{pts,bbox}] }
  const store = new Map();

  function ingestTile(key, tileData) {
    if (!tileData || store.has(key)) return;
    const roads = [];
    for (const r of tileData.roads || []) {
      const pts = r.points;
      if (!pts || pts.length < 2) continue;
      const tier = ROAD_CLASS[r.highwayType] || 'minor';
      const w = Number.isFinite(r.width) && r.width > 0 ? r.width : (tier === 'major' ? 12 : tier === 'mid' ? 8 : 5);
      roads.push({ pts, w, tier, bbox: bboxOf(pts) });
    }
    const water = [];
    for (const f of tileData.water || []) { const pts = f.polygon; if (pts && pts.length >= 3) water.push({ pts, bbox: bboxOf(pts) }); }
    const parks = [];
    for (const f of tileData.greens || []) { const pts = f.polygon; if (pts && pts.length >= 3) parks.push({ pts, bbox: bboxOf(pts) }); }
    const builds = [];
    for (const b of tileData.buildings || []) { const pts = b.footprint; if (pts && pts.length >= 3) builds.push({ pts, bbox: bboxOf(pts) }); }
    store.set(key, { roads, water, parks, builds });
    _onChange?.();
  }

  let _onChange = null;
  function setOnChange(cb) { _onChange = cb; }        // fired when tiles are added/removed (→ redraw)

  function removeTile(key) { if (store.delete(key)) _onChange?.(); }
  function clear() { store.clear(); _onChange?.(); }

  let _night = false;
  function setNight(n) { _night = !!n; }

  /**
   * Draw one slippy map tile. `wb` = [wMinX, wMinZ, wMaxX, wMaxZ] world bounds of this tile (world Z
   * north). Linear world→pixel is exact enough within one small tile (Mercator is locally linear), and
   * matches Leaflet's own tile placement so features align with markers/pan. north (max Z) → top.
   */
  function drawTile(ctx, size, wb, marginM = 30) {
    const S = _night ? STYLE.night : STYLE.day;
    const [wMinX, wMinZ, wMaxX, wMaxZ] = wb;
    const spanX = wMaxX - wMinX, spanZ = wMaxZ - wMinZ;
    const kx = size / spanX, kz = size / spanZ;
    const pxPerM = kx;
    const sx = (x) => (x - wMinX) * kx;
    const sy = (y) => (wMaxZ - y) * kz;                 // north at top
    // Feature overlaps this tile (+margin so wide strokes/edges near the seam still draw)
    const hit = (bb) => bb[2] >= wMinX - marginM && bb[0] <= wMaxX + marginM && bb[3] >= wMinZ - marginM && bb[1] <= wMaxZ + marginM;

    ctx.fillStyle = S.ground;
    ctx.fillRect(0, 0, size, size);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const fillPoly = (list, color) => {
      ctx.fillStyle = color;
      for (const f of list) {
        if (!hit(f.bbox)) continue;
        const p = f.pts;
        ctx.beginPath();
        ctx.moveTo(sx(p[0].x), sy(p[0].y));
        for (let i = 1; i < p.length; i++) ctx.lineTo(sx(p[i].x), sy(p[i].y));
        ctx.closePath();
        ctx.fill();
      }
    };

    // 1. parks + water fills (under the roads)
    for (const t of store.values()) fillPoly(t.parks, S.park);
    for (const t of store.values()) fillPoly(t.water, S.water);

    // 2. roads — casing pass then fill pass; thickest (major) drawn last so junctions read cleanly
    const order = ['path', 'minor', 'mid', 'major'];
    const roadPx = (r) => Math.max(MIN_PX[r.tier], r.w * pxPerM);
    const strokeRoads = (widthFn, colorFn) => {
      for (const tier of order) {
        for (const t of store.values()) {
          for (const r of t.roads) {
            if (r.tier !== tier || !hit(r.bbox)) continue;
            ctx.strokeStyle = colorFn(r);
            ctx.lineWidth = widthFn(r);
            ctx.beginPath();
            ctx.moveTo(sx(r.pts[0].x), sy(r.pts[0].y));
            for (let i = 1; i < r.pts.length; i++) ctx.lineTo(sx(r.pts[i].x), sy(r.pts[i].y));
            ctx.stroke();
          }
        }
      }
    };
    strokeRoads((r) => roadPx(r) + 2.0, () => S.casing);        // casing
    strokeRoads((r) => roadPx(r), (r) => S.road[r.tier]);       // fill

    // 3. building footprints on top (light fill + subtle edge)
    ctx.strokeStyle = S.buildingEdge;
    ctx.lineWidth = 0.6;
    ctx.fillStyle = S.building;
    for (const t of store.values()) {
      for (const b of t.builds) {
        if (!hit(b.bbox)) continue;
        ctx.beginPath();
        ctx.moveTo(sx(b.pts[0].x), sy(b.pts[0].y));
        for (let i = 1; i < b.pts.length; i++) ctx.lineTo(sx(b.pts[i].x), sy(b.pts[i].y));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  return { ingestTile, removeTile, clear, setNight, setOnChange, drawTile, get tileCount() { return store.size; } };
}
