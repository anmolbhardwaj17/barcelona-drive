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

import { latLonToWorld } from '../projection.js';

// Barcelona neighbourhoods/districts → bold overview labels (GTA-style), shown when zoomed out. Approx
// centres; drawn wherever they fall, even over not-yet-loaded tiles, so the overview map reads as a city.
const DISTRICTS = [
  ['EIXAMPLE', 41.3916, 2.1649], ['GRÀCIA', 41.4035, 2.1560], ['CIUTAT VELLA', 41.3810, 2.1740],
  ['LA BARCELONETA', 41.3800, 2.1900], ['SANT ANTONI', 41.3775, 2.1560], ['POBLE-SEC', 41.3705, 2.1600],
  ['SANTS', 41.3750, 2.1370], ['LES CORTS', 41.3870, 2.1300], ['SARRIÀ', 41.3990, 2.1200],
  ['SANT GERVASI', 41.4010, 2.1400], ['POBLENOU', 41.4030, 2.2000], ['EL CLOT', 41.4110, 2.1870],
  ['SAGRADA FAMÍLIA', 41.4036, 2.1744], ['HORTA', 41.4290, 2.1620], ['NOU BARRIS', 41.4420, 2.1770],
  ['SANT ANDREU', 41.4360, 2.1900], ['MONTJUÏC', 41.3630, 2.1650],
];
// Lazily projected to world coords ({name, x, y}) on first draw (projection origin is ready by then).
let _districts = null;
function districts() {
  if (_districts) return _districts;
  _districts = DISTRICTS.map(([name, lat, lon]) => { const w = latLonToWorld(lat, lon); return { name, x: w.x, y: w.z }; });
  return _districts;
}

// Mediterranean coastline (NE→SW, [lat,lon]). The baked data only has port/marina water polygons — no
// open sea — so we fill the sea ourselves: trace the shore, then extend far offshore (SE) to close a big
// polygon. Canvas clips it per tile, so it only paints the seaward side of the coast.
const SEA_COAST = [
  [41.4210, 2.2300], [41.3960, 2.2050], [41.3860, 2.1955], [41.3775, 2.1918],
  [41.3700, 2.1810], [41.3540, 2.1640], [41.3350, 2.1470], [41.3180, 2.1320],
];
// Sea name label, placed out in the open water (SE of the city).
const SEA_LABEL = { text: 'MAR MEDITERRÀNIA', lat: 41.352, lon: 2.212 };
let _seaLabelPos = null;
function seaLabelPos() {
  if (!_seaLabelPos) { const w = latLonToWorld(SEA_LABEL.lat, SEA_LABEL.lon); _seaLabelPos = { x: w.x, y: w.z }; }
  return _seaLabelPos;
}

let _sea = null, _seaBbox = null;
function seaPolygon() {
  if (_sea) return _sea;
  const pts = SEA_COAST.map(([lat, lon]) => { const w = latLonToWorld(lat, lon); return { x: w.x, y: w.z }; });
  const OFF = 30000; // metres far offshore (east +X, south −Z) so the fill covers the whole visible sea
  const sw = pts[pts.length - 1], ne = pts[0];
  _sea = [...pts, { x: sw.x + OFF, y: sw.y - OFF }, { x: ne.x + OFF, y: ne.y - OFF }];
  _seaBbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of _sea) { if (p.x < _seaBbox[0]) _seaBbox[0] = p.x; if (p.y < _seaBbox[1]) _seaBbox[1] = p.y; if (p.x > _seaBbox[2]) _seaBbox[2] = p.x; if (p.y > _seaBbox[3]) _seaBbox[3] = p.y; }
  return _sea;
}

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
  // GTA-V-style day map: light beige land, green parks, blue water, subtle grey blocks; roads read as
  // pale surfaces DEFINED by a medium-grey casing (the casing is the "darker" edge, not a dark fill).
  // Watch Dogs 2 reference: cool grey urban blocks, muted green nature, bright blue water, white streets
  // and YELLOW highways.
  day: {
    ground:    '#edefeb',   // very light grey urban base
    park:      '#aacd90',   // muted green
    water:     '#66b3e6',   // lighter bright blue
    building:  '#f7f8f5',   // near-white blocks
    buildingEdge: '#e1e3de',
    casing:    '#d7d9d4',   // light casing — just enough to define the white roads on the light land
    road: { major: '#ffd21f', mid: '#ffffff', minor: '#f8f8f6', path: '#ececea' },  // brighter gold highways, white streets
    label:     '#43494a', labelHalo: 'rgba(226,228,227,0.92)',
    street:    '#565c5d', streetHalo: 'rgba(255,255,255,0.9)',
    seaLabel:  '#eef5fb', seaHalo: 'rgba(20,70,110,0.55)',
  },
  night: {
    ground:    '#212a40',   // lighter night land (was #141b2f — too dark)
    park:      '#33543a',
    water:     '#2b5378',   // lighter night sea (was #1d3555)
    seaLabel:  '#9fc4e4', seaHalo: 'rgba(10,20,38,0.85)',
    building:  '#28304a',
    buildingEdge: '#1b2236',
    casing:    '#0e1325',
    road: { major: '#8a94ad', mid: '#69738c', minor: '#4b5468', path: '#3a4260' },
    label:     '#cdd6ec', labelHalo: 'rgba(10,15,32,0.85)',
    street:    '#aeb6cc', streetHalo: 'rgba(10,15,32,0.8)',
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

  // lite=true → skip building footprints (used by the city-wide background load to save memory; far
  // buildings never render anyway). A full ingest (near the car) UPGRADES an existing lite entry.
  function ingestTile(key, tileData, lite = false) {
    if (!tileData) return;
    const existing = store.get(key);
    if (existing && !(existing.lite && !lite)) return;   // skip unless upgrading lite → full
    const roads = [];
    for (const r of tileData.roads || []) {
      const pts = r.points;
      if (!pts || pts.length < 2) continue;
      const tier = ROAD_CLASS[r.highwayType] || 'minor';
      const w = Number.isFinite(r.width) && r.width > 0 ? r.width : (tier === 'major' ? 12 : tier === 'mid' ? 8 : 5);
      roads.push({ pts, w, tier, name: r.name || '', bbox: bboxOf(pts) });
    }
    const water = [];
    for (const f of tileData.water || []) { const pts = f.polygon; if (pts && pts.length >= 3) water.push({ pts, bbox: bboxOf(pts) }); }
    const parks = [];
    for (const f of tileData.greens || []) { const pts = f.polygon; if (pts && pts.length >= 3) parks.push({ pts, bbox: bboxOf(pts) }); }
    const builds = [];
    if (!lite) for (const b of tileData.buildings || []) { const pts = b.footprint; if (pts && pts.length >= 3) builds.push({ pts, bbox: bboxOf(pts) }); }
    // Tile-level bbox (union of everything) → drawTile can skip a whole tile in one check instead of
    // testing every feature. Critical once the entire city (426 tiles) is loaded.
    const tbb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const f of [...roads, ...water, ...parks, ...builds]) {
      if (f.bbox[0] < tbb[0]) tbb[0] = f.bbox[0]; if (f.bbox[1] < tbb[1]) tbb[1] = f.bbox[1];
      if (f.bbox[2] > tbb[2]) tbb[2] = f.bbox[2]; if (f.bbox[3] > tbb[3]) tbb[3] = f.bbox[3];
    }
    store.set(key, { roads, water, parks, builds, lite, tbb });
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
   * north). `z` = slippy zoom → level-of-detail: zoomed OUT shows a broad idea (major roads + district
   * names); zoomed IN adds minor roads, buildings, then street names. Linear world→pixel is exact enough
   * within one small tile (Mercator is locally linear) and matches Leaflet's placement. north (max Z) → top.
   */
  function drawTile(ctx, size, wb, z = 17, marginM = 30) {
    const S = _night ? STYLE.night : STYLE.day;
    const [wMinX, wMinZ, wMaxX, wMaxZ] = wb;
    const spanX = wMaxX - wMinX, spanZ = wMaxZ - wMinZ;
    const kx = size / spanX, kz = size / spanZ;
    const pxPerM = kx;
    const sx = (x) => (x - wMinX) * kx;
    const sy = (y) => (wMaxZ - y) * kz;                 // north at top
    const hit = (bb) => bb[2] >= wMinX - marginM && bb[0] <= wMaxX + marginM && bb[3] >= wMinZ - marginM && bb[1] <= wMaxZ + marginM;
    const inTile = (x, y) => x >= wMinX && x < wMaxX && y >= wMinZ && y < wMaxZ;

    // Level-of-detail gates by zoom
    const showMid = z >= 15, showMinor = z >= 16, showPath = z >= 17;
    const showBuildings = z >= 16;
    const showDistricts = z <= 16;      // broad overview
    const showStreets = z >= 18;        // street names once zoomed in (keeps the small z17 circle clean)

    ctx.fillStyle = S.ground;
    ctx.fillRect(0, 0, size, size);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Only iterate store tiles whose overall bbox overlaps THIS map tile. With the whole city (426 tiles)
    // loaded, this is the difference between a few tiles and thousands of feature checks per draw → the
    // real fix for laggy zoom.
    const vis = [];
    for (const t of store.values()) if (t.tbb && hit(t.tbb)) vis.push(t);

    const tierOn = { major: true, mid: showMid, minor: showMinor, path: showPath };

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

    // 0. sea — fill the Mediterranean ourselves (baked data only has port polygons). Under everything.
    const sea = seaPolygon();
    if (hit(_seaBbox)) {
      ctx.fillStyle = S.water;
      ctx.beginPath();
      ctx.moveTo(sx(sea[0].x), sy(sea[0].y));
      for (let i = 1; i < sea.length; i++) ctx.lineTo(sx(sea[i].x), sy(sea[i].y));
      ctx.closePath();
      ctx.fill();
    }

    // 1. parks + water fills (under the roads)
    for (const t of vis) fillPoly(t.parks, S.park);
    for (const t of vis) fillPoly(t.water, S.water);

    // 2. roads — casing pass then fill pass; thickest (major) drawn last so junctions read cleanly
    const order = ['path', 'minor', 'mid', 'major'];
    const roadPx = (r) => Math.max(MIN_PX[r.tier], r.w * pxPerM);
    const strokeRoads = (widthFn, colorFn) => {
      for (const tier of order) {
        if (!tierOn[tier]) continue;
        for (const t of vis) {
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

    // 3. building footprints (only when zoomed in enough to matter)
    if (showBuildings) {
      ctx.strokeStyle = S.buildingEdge;
      ctx.lineWidth = 0.6;
      ctx.fillStyle = S.building;
      for (const t of vis) {
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

    // 4. labels — halo'd text. Only one copy per label: draw it in the tile that contains its anchor.
    const text = (str, x, y, font, color, halo) => {
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = halo; ctx.lineWidth = 3;
      ctx.strokeText(str, x, y);
      ctx.fillStyle = color;
      ctx.fillText(str, x, y);
    };

    // A label must render in EVERY tile it overlaps (not just its anchor tile) or long names get clipped
    // at the tile seam. Text is centred on the same world anchor in each tile, so the halves line up.
    const spans = (ax, ay, halfWm, halfHm) =>
      ax + halfWm >= wMinX && ax - halfWm <= wMaxX && ay + halfHm >= wMinZ && ay - halfHm <= wMaxZ;

    // 4a. district names — broad overview (drawn even where tiles aren't loaded)
    if (showDistricts) {
      const fs = z <= 14 ? 13 : 15;
      const font = `700 ${fs}px system-ui, sans-serif`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = '1.5px';   // GTA-style tracking
      ctx.font = font;
      const halfHm = (fs * 0.8) / kz;
      for (const d of districts()) {
        const halfWm = (ctx.measureText(d.name).width / 2 + 6) / kx;
        if (!spans(d.x, d.y, halfWm, halfHm)) continue;
        text(d.name, sx(d.x), sy(d.y), font, S.label, S.labelHalo);
      }
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

      // Sea name — italic label out in the open water
      const sp = seaLabelPos();
      const fsS = z <= 14 ? 15 : 17;
      const fontS = `italic 600 ${fsS}px Georgia, serif`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
      ctx.font = fontS;
      const hwS = (ctx.measureText(SEA_LABEL.text).width / 2 + 6) / kx;
      if (spans(sp.x, sp.y, hwS, (fsS * 0.8) / kz)) text(SEA_LABEL.text, sx(sp.x), sy(sp.y), fontS, S.seaLabel, S.seaHalo);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }

    // 4b. street names — written ALONG the road (rotated to the road angle), major+mid at z17, minor at z18+.
    if (showStreets) {
      const allowMinor = z >= 19;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      const seen = new Set();
      for (const t of vis) {
        for (const r of t.roads) {
          if (!r.name || r.tier === 'path' || seen.has(r.name)) continue;
          if (r.tier === 'minor' && !allowMinor) continue;
          const n = r.pts.length, mi = n >> 1;
          const a = r.pts[Math.max(0, mi - 1)], b = r.pts[Math.min(n - 1, mi + 1)];
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          if (!inTile(mx, my)) continue;   // label once, in the tile holding the road's midpoint
          seen.add(r.name);
          // Road angle in SCREEN space (sy flips Z). Keep text upright (never upside-down).
          let ang = Math.atan2(-(b.y - a.y) * kz, (b.x - a.x) * kx);
          if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
          const fs = r.tier === 'major' ? 12 : 11;
          ctx.save();
          ctx.translate(sx(mx), sy(my));
          ctx.rotate(ang);
          ctx.font = `600 ${fs}px system-ui, sans-serif`;
          ctx.strokeStyle = S.streetHalo; ctx.lineWidth = 3; ctx.strokeText(r.name, 0, 0);
          ctx.fillStyle = S.street; ctx.fillText(r.name, 0, 0);
          ctx.restore();
        }
      }
    }
  }

  function hasTile(key) { return store.has(key); }

  return { ingestTile, removeTile, hasTile, clear, setNight, setOnChange, drawTile, get tileCount() { return store.size; } };
}
