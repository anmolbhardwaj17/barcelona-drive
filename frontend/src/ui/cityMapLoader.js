/**
 * cityMapLoader — one-time load of the WHOLE city's 2D map into the custom minimap from a SINGLE compact
 * file (backend/tiles/<region>/citymap.bin, ~0.5 MB gzipped), instead of streaming all ~426 full tiles
 * (~525 MB). Generated offline by backend/tools/buildCityMap.js. Immutable + cached-forever, so returning
 * players re-download nothing — and it works on weak connections.
 *
 * The file is grouped by source tile; we ingest each under the same `${tx}_${ty}` key the near-car streamer
 * uses, so a full tile (with buildings) cleanly upgrades the lite entry. Parsing is idle-paced so it never
 * steals a gameplay frame.
 */
const API_BASE = import.meta.env.VITE_MAP_API || 'http://localhost:4041';
const REGION = import.meta.env.VITE_TILE_REGION || 'barcelona';

let _started = false;

const idle = (timeout = 300) => new Promise((r) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => r(), { timeout });
  else setTimeout(r, 16);
});

export async function loadCityMap(customMap, { onProgress } = {}) {
  if (_started || !customMap) return;
  _started = true;

  let buf;
  try {
    const res = await fetch(`${API_BASE}/api/citymap?region=${REGION}`);
    if (!res.ok) throw new Error(`citymap ${res.status}`);
    buf = await res.arrayBuffer();
  } catch (e) {
    console.warn('[cityMap] citymap fetch failed — map will only show driven areas:', e?.message || e);
    return;
  }

  const dv = new DataView(buf);
  let o = 0;
  const hlen = dv.getUint32(o, true); o += 4;
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, o, hlen))); o += hlen;
  const { quant, baseX, baseY, roadTypes, roadNames, tileCount } = header;

  const rx = () => { const q = dv.getUint16(o, true); o += 2; return baseX + q * quant; };
  const ry = () => { const q = dv.getUint16(o, true); o += 2; return baseY + q * quant; };
  const readPts = (n) => { const pts = new Array(n); for (let i = 0; i < n; i++) pts[i] = { x: rx(), y: ry() }; return pts; };

  let done = 0;
  const CHUNK = 24;   // tiles per idle slice
  for (let t = 0; t < tileCount; t++) {
    const tx = dv.getUint32(o, true); o += 4;
    const ty = dv.getUint32(o, true); o += 4;
    const roadCount = dv.getUint16(o, true); o += 2;
    const waterCount = dv.getUint16(o, true); o += 2;
    const greenCount = dv.getUint16(o, true); o += 2;

    const roads = new Array(roadCount);
    for (let i = 0; i < roadCount; i++) {
      const typeIdx = dv.getUint16(o, true); o += 2;
      const nameIdx = dv.getUint32(o, true); o += 4;
      const width = dv.getFloat32(o, true); o += 4;
      const ptCount = dv.getUint16(o, true); o += 2;
      roads[i] = { points: readPts(ptCount), highwayType: roadTypes[typeIdx] || '', width, name: roadNames[nameIdx] || '' };
    }
    const water = new Array(waterCount);
    for (let i = 0; i < waterCount; i++) { const n = dv.getUint16(o, true); o += 2; water[i] = { polygon: readPts(n) }; }
    const greens = new Array(greenCount);
    for (let i = 0; i < greenCount; i++) { const n = dv.getUint16(o, true); o += 2; greens[i] = { polygon: readPts(n) }; }

    customMap.ingestTile(`${tx}_${ty}`, { roads, water, greens }, true, /* quiet */ true);

    if ((++done % CHUNK) === 0) { customMap.refresh(); onProgress?.(done, tileCount); await idle(); }
  }
  customMap.refresh();
  onProgress?.(done, tileCount);
  console.log(`[cityMap] full city loaded from citymap.bin (${done} tiles)`);
}
