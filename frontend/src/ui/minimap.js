/**
 * Circular mini map (Leaflet) synced to viewer position.
 * Map rotates to match camera heading; pointer icon stays fixed pointing forward.
 * Cartoony grey border frame. Click to expand modal.
 */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { worldToLatLon, tileToBBox, latLonToWorld } from '../projection.js';
import { uiSound } from './uiSound.js';

const MINIMAP_SIZE = 170;
const MINIMAP_ZOOM = 17;
const UPDATE_INTERVAL_MS = 200;
const ROTATION_LERP = 0.15;
const BORDER_WIDTH = 4;
const COMPASS_RING_WIDTH = 20; // width of the compass band around the minimap

// OSM standard is colourful + detailed (green parks, blue water, coloured roads). Light touch: punch it
// a little by day, flip to a deep navy by night. (CARTO CDN proved unreliable on some networks.)
// The custom map tiles bake their own day/night palette, so no CSS filter tinting is needed.
const FILTER_DAY = 'none';
const FILTER_NIGHT = 'none';
let _isNight = false;

let map = null;
let mapInner = null;
let markerEl = null;
let compassRing = null;
let lastUpdateTime = 0;
let currentRotationDeg = 0;
let expanded = false;
let lastCarLatLon = null;
let backdropEl = null;
let locationMarker = null;      // Leaflet marker shown in expanded mode
let locationMarkerArrow = null; // inner SVG element — updated each frame for rotation

/**
 * Create circular mini map DOM and Leaflet map. Call once on init.
 * @param {{ x: number, z: number }} spawnCenter
 * @returns {{ update: (worldX: number, worldZ: number, headingDeg: number) => void }}
 */
export function createMinimap(spawnCenter = { x: 0, z: 0 }, customMap = null) {
  const TOTAL_SIZE = MINIMAP_SIZE + BORDER_WIDTH * 2 + COMPASS_RING_WIDTH * 2;
  const INNER_OFFSET = COMPASS_RING_WIDTH + BORDER_WIDTH;

  // Outer frame — holds compass ring + minimap
  const frame = document.createElement('div');
  frame.id = 'minimap-frame';
  frame.style.cssText = `
    position: fixed;
    bottom: 12px;
    left: 12px;
    width: ${TOTAL_SIZE}px;
    height: ${TOTAL_SIZE}px;
    border-radius: 50%;
    z-index: 10;
    pointer-events: none;
  `;

  // Compass ring — SVG circle with N/E/S/W and tick marks, rotates with heading
  const compassSize = TOTAL_SIZE;
  const compassCenter = compassSize / 2;
  const tickR = compassCenter - 4;  // outer tick radius
  const tickRInner = tickR - 6;     // inner tick radius (major)
  const tickRMinor = tickR - 4;     // inner tick radius (minor)
  const labelR = compassCenter - 18; // label radius

  let ticksSvg = '';
  for (let deg = 0; deg < 360; deg += 5) {
    const isMajor = deg % 90 === 0;
    const isMid = deg % 45 === 0 && !isMajor;
    if (!isMajor && !isMid && deg % 5 !== 0) continue;
    const rad = deg * Math.PI / 180;
    const cos = Math.cos(rad - Math.PI / 2);  // -90 so 0deg = top
    const sin = Math.sin(rad - Math.PI / 2);
    const outerX = compassCenter + cos * tickR;
    const outerY = compassCenter + sin * tickR;
    const innerR = isMajor ? tickRInner - 2 : isMid ? tickRInner : tickRMinor;
    const innerX = compassCenter + cos * innerR;
    const innerY = compassCenter + sin * innerR;
    const sw = isMajor ? 2 : isMid ? 1.5 : 0.8;
    const op = isMajor ? 0.9 : isMid ? 0.7 : 0.4;
    ticksSvg += `<line x1="${outerX}" y1="${outerY}" x2="${innerX}" y2="${innerY}" stroke="white" stroke-width="${sw}" opacity="${op}"/>`;
  }

  // Cardinal labels
  const cardinals = [
    { label: 'N', deg: 0, color: '#ff4444', bold: true },
    { label: 'E', deg: 90, color: '#ffffff', bold: false },
    { label: 'S', deg: 180, color: '#ffffff', bold: false },
    { label: 'W', deg: 270, color: '#ffffff', bold: false },
  ];
  let labelsSvg = '';
  for (const c of cardinals) {
    const rad = c.deg * Math.PI / 180 - Math.PI / 2;
    const lx = compassCenter + Math.cos(rad) * labelR;
    const ly = compassCenter + Math.sin(rad) * labelR;
    const fw = c.bold ? 'bold' : '600';
    const fs = c.bold ? 14 : 12;
    labelsSvg += `<text x="${lx}" y="${ly}" fill="${c.color}" font-size="${fs}" font-weight="${fw}" font-family="Futura PT,system-ui,sans-serif" text-anchor="middle" dominant-baseline="central">${c.label}</text>`;
  }

  // Red heading indicator dot at top (fixed, doesn't rotate)
  const dotR = 4;

  compassRing = document.createElement('div');
  compassRing.id = 'compass-ring';
  compassRing.style.cssText = `
    position: absolute;
    top: 0; left: 0;
    width: ${compassSize}px;
    height: ${compassSize}px;
    pointer-events: none;
  `;
  compassRing.innerHTML = `
    <svg width="${compassSize}" height="${compassSize}" viewBox="0 0 ${compassSize} ${compassSize}" style="position:absolute;top:0;left:0;">
      <g class="compass-rotate">
        ${ticksSvg}
        ${labelsSvg}
      </g>
      <circle cx="${compassCenter}" cy="${dotR + 2}" r="${dotR}" fill="#ff4444" stroke="#fff" stroke-width="1.5"/>
    </svg>
  `;
  frame.appendChild(compassRing);

  // White border ring for minimap
  const borderRing = document.createElement('div');
  borderRing.style.cssText = `
    position: absolute;
    top: ${COMPASS_RING_WIDTH}px;
    left: ${COMPASS_RING_WIDTH}px;
    width: ${MINIMAP_SIZE + BORDER_WIDTH * 2}px;
    height: ${MINIMAP_SIZE + BORDER_WIDTH * 2}px;
    border-radius: 50%;
    background: #ffffff;
    pointer-events: none;
  `;
  frame.appendChild(borderRing);

  // Inner clip — holds the map, clipped to circle
  const wrapper = document.createElement('div');
  wrapper.id = 'minimap-wrapper';
  wrapper.style.cssText = `
    position: absolute;
    top: ${INNER_OFFSET}px;
    left: ${INNER_OFFSET}px;
    width: ${MINIMAP_SIZE}px;
    height: ${MINIMAP_SIZE}px;
    border-radius: 50%;
    overflow: hidden;
    pointer-events: auto;
    cursor: pointer;
  `;

  const mapInnerSize = MINIMAP_SIZE * 1.5;
  mapInner = document.createElement('div');
  mapInner.id = 'minimap-inner';
  mapInner.style.cssText = `
    position: absolute;
    left: 50%;
    top: 50%;
    width: ${mapInnerSize}px;
    height: ${mapInnerSize}px;
    transform: translate(-50%, -50%) rotate(0deg);
    transform-origin: center center;
    filter: ${(_isNight ? FILTER_NIGHT : FILTER_DAY)};
  `;

  const mapDiv = document.createElement('div');
  mapDiv.id = 'minimap-map';
  mapDiv.style.cssText = `
    width: 100%;
    height: 100%;
  `;
  mapInner.appendChild(mapDiv);
  wrapper.appendChild(mapInner);

  // Soft dark vignette over the map edges (expanded mode only). Keeps the map fully OPAQUE — a spotlit-map
  // look — instead of fading it to transparent over the 3D scene (which ghosted / looked fake).
  const vignetteEl = document.createElement('div');
  vignetteEl.style.cssText = 'position:absolute; inset:0; pointer-events:none; z-index:6; display:none;' +
    'border-radius:inherit; box-shadow: inset 0 0 140px 46px rgba(12,12,18,0.85);';
  wrapper.appendChild(vignetteEl);

  // Kept as references for expand/collapse logic
  const innerShadow = { style: { display: '' } };
  const highlight = { style: { display: '' } };

  // Player marker — swaps between blue dot (car) and bat silhouette (camera)
  const markerSize = 60;
  const playerDotR = 7;
  markerEl = document.createElement('div');
  markerEl.style.cssText = `
    position: absolute;
    left: 50%;
    top: 50%;
    width: ${markerSize}px;
    height: ${markerSize}px;
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: 1000;
  `;
  const mc = markerSize / 2;
  // Blue "you-are-here" pin with a heading wedge (matches the expanded-map marker). Points UP =
  // forward, since the map itself rotates heading-up.
  const CAR_MARKER_SVG = `
    <svg viewBox="0 0 ${markerSize} ${markerSize}" width="${markerSize}" height="${markerSize}">
      <circle cx="${mc}" cy="${mc}" r="24" fill="#2a7fff" opacity="0.14"/>
      <polygon points="${mc},3 ${mc + 10},${mc - 4} ${mc},${mc - 9} ${mc - 10},${mc - 4}"
               fill="#2a7fff" stroke="#ffffff" stroke-width="1.5"/>
      <circle cx="${mc}" cy="${mc}" r="10.5" fill="#2a7fff" stroke="#ffffff" stroke-width="3.5"/>
      <circle cx="${mc}" cy="${mc}" r="4.3" fill="#ffffff" opacity="0.9"/>
    </svg>
  `;
  // Low-poly Batman flying top-down — arms forward, cape flowing, dark colours
  // Only shown in camera mode + night
  const BAT_MARKER_SVG = `
    <svg viewBox="0 0 70 90" width="70" height="90">
      <defs>
        <radialGradient id="bat-aura" cx="50%" cy="40%" r="50%">
          <stop offset="0%" stop-color="#66aaff" stop-opacity="0.45"/>
          <stop offset="50%" stop-color="#3366cc" stop-opacity="0.20"/>
          <stop offset="100%" stop-color="#000033" stop-opacity="0"/>
        </radialGradient>
        <filter id="bat-glow">
          <feGaussianBlur stdDeviation="2" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <!-- Glow aura below figure -->
      <ellipse cx="35" cy="42" rx="30" ry="38" fill="url(#bat-aura)"/>

      <!-- FOV cone — yellow, pointing up (forward direction) -->
      <path d="M35,42 L17,14 A25,25 0 0,1 53,14 Z" fill="#f5c842" opacity="0.25"/>
      <path d="M35,42 L22,18 A20,20 0 0,1 48,18 Z" fill="#f5c842" opacity="0.15"/>

      <g transform="translate(35,42)" filter="url(#bat-glow)">
        <!-- Cape — wide, flowing behind (bottom = behind in top-down flight) -->
        <polygon points="-6,4 -10,10 -16,20 -20,30 -14,26 -8,20 -4,14 0,34 4,14 8,20 14,26 20,30 16,20 10,10 6,4" fill="#12122a"/>
        <polygon points="-4,14 -10,24 -6,20 0,34 6,20 10,24 4,14 0,28" fill="#0a0a1e" opacity="0.5"/>
        <!-- Cape scallops at bottom -->
        <polygon points="-20,30 -22,34 -16,31 -12,34 -8,30" fill="#12122a"/>
        <polygon points="20,30 22,34 16,31 12,34 8,30" fill="#12122a"/>
        <polygon points="-4,32 0,38 4,32 0,34" fill="#12122a"/>

        <!-- Torso — broad shoulders, tapered waist -->
        <polygon points="-7,-4 -8,0 -6,5 0,7 6,5 8,0 7,-4" fill="#1c1c30"/>
        <!-- Chest armour plates -->
        <polygon points="-5,-2 -6,2 0,5 6,2 5,-2" fill="#22223a" opacity="0.6"/>

        <!-- Belt — yellow utility belt -->
        <polygon points="-6,4 -6,6 6,6 6,4" fill="#c8a832"/>
        <rect x="-2" y="4" width="4" height="2" rx="0.4" fill="#e0be3a"/>
        <rect x="-5.5" y="4.3" width="2" height="1.4" rx="0.3" fill="#b89828"/>
        <rect x="3.5" y="4.3" width="2" height="1.4" rx="0.3" fill="#b89828"/>

        <!-- Arms reaching forward (up in top-down) — muscular, angular -->
        <polygon points="-7,-4 -10,-10 -11,-18 -9,-24 -7,-24 -8,-18 -7,-10 -5,-4" fill="#1c1c30"/>
        <polygon points="7,-4 10,-10 11,-18 9,-24 7,-24 8,-18 7,-10 5,-4" fill="#1c1c30"/>

        <!-- Gauntlet fins — 3 pointed blades each side -->
        <polygon points="-9,-12 -12,-14 -9,-14" fill="#0e0e20"/>
        <polygon points="-9,-15 -13,-17 -9,-17" fill="#0e0e20"/>
        <polygon points="-10,-18 -14,-20 -10,-20" fill="#0e0e20"/>
        <polygon points="9,-12 12,-14 9,-14" fill="#0e0e20"/>
        <polygon points="9,-15 13,-17 9,-17" fill="#0e0e20"/>
        <polygon points="10,-18 14,-20 10,-20" fill="#0e0e20"/>

        <!-- Fists — clenched -->
        <polygon points="-10,-24 -10,-27 -7,-27 -7,-24" fill="#d4b896"/>
        <polygon points="10,-24 10,-27 7,-27 7,-24" fill="#d4b896"/>

        <!-- Head / cowl — angular Batman shape -->
        <polygon points="-5,-4 -6,-8 -5,-14 -3,-16 0,-17 3,-16 5,-14 6,-8 5,-4" fill="#0e0e1c"/>
        <!-- Cowl ear points -->
        <polygon points="-3,-16 -5,-22 -2,-17" fill="#0e0e1c"/>
        <polygon points="3,-16 5,-22 2,-17" fill="#0e0e1c"/>

        <!-- Eyes — angular white slits -->
        <polygon points="-4,-10 -2,-11 -1.5,-9.5 -3.5,-9" fill="white"/>
        <polygon points="4,-10 2,-11 1.5,-9.5 3.5,-9" fill="white"/>

        <!-- Bat symbol on chest -->
        <path d="M0,-1 L-1.5,-2.5 L-3.5,-1.5 L-2.5,0 L-1,0.5 L0,0 L1,0.5 L2.5,0 L3.5,-1.5 L1.5,-2.5 Z" fill="#0a0a0a"/>
      </g>
    </svg>
  `;
  let _markerMode = 'car';
  let _markerNight = false;
  markerEl.innerHTML = CAR_MARKER_SVG;
  wrapper.appendChild(markerEl);

  // Dash objective marker — a cyan dot pointing to the next checkpoint (heading-up, clamped to the rim)
  let _objTarget = null;   // { lat, lon } | null
  const gateMarkerEl = document.createElement('div');
  gateMarkerEl.style.cssText = 'position:absolute;width:13px;height:13px;border-radius:50%;background:#35e0ff;' +
    'border:2px solid #fff;box-shadow:0 0 8px #35e0ff;transform:translate(-50%,-50%);display:none;z-index:5;pointer-events:none;';
  wrapper.appendChild(gateMarkerEl);

  frame.appendChild(wrapper);

  // Zoom +/- buttons — shown only on the expanded map (top-left, like a real map). Easy one-click zoom.
  const zoomBtns = document.createElement('div');
  zoomBtns.style.cssText = 'position:absolute; top:18px; left:18px; z-index:13; display:none; flex-direction:column; gap:8px; pointer-events:auto;';
  const _mkZoom = (label, delta) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'width:42px; height:42px; border:none; border-radius:10px; background:rgba(255,255,255,0.94); color:#2a2f2a; font:700 24px system-ui,sans-serif; line-height:1; cursor:pointer; box-shadow:0 3px 10px rgba(0,0,0,0.35); pointer-events:auto;';
    b.addEventListener('click', (e) => { e.stopPropagation(); if (map) map.setZoom(map.getZoom() + delta, { animate: true }); });
    zoomBtns.appendChild(b);
  };
  _mkZoom('+', 1);
  _mkZoom('−', -1);   // minus sign
  frame.appendChild(zoomBtns);

  document.body.appendChild(frame);

  map = L.map('minimap-map', {
    zoomControl: false,
    dragging: false,
    doubleClickZoom: false,
    scrollWheelZoom: false,
    touchZoom: false,
    boxZoom: false,
    keyboard: false,
    attributionControl: false,
    // Don't let the expanded map zoom out past where the city fills the frame (we only have Barcelona's
    // data — zooming further just shows a tiny city island in blank beige). 19 = close street detail.
    minZoom: 13,
    maxZoom: 19,
    // Smooth, continuous zoom (no integer-step snapping) but FAST — low wheelPx = less scrolling per level.
    zoomSnap: 0,
    zoomDelta: 1,
    wheelPxPerZoomLevel: 16,   // very responsive wheel (was 30 — too much scrolling to zoom out)
    wheelDebounceTime: 5,
    zoomAnimation: true,
  });

  // Custom vector tiles drawn from the baked v7 world data (roads/buildings/water/parks) — no OSM, no
  // network. One canvas per slippy tile; each tile's world bounds come from its lat/lon corners so the
  // features line up with Leaflet's own tile placement (both Web Mercator). Falls back to a blank ground
  // fill if no customMap was provided.
  let customLayer = null;
  const _wbOf = (coords) => {
    const bb = tileToBBox(coords.x, coords.y, coords.z);
    const sw = latLonToWorld(bb.south, bb.west);
    const ne = latLonToWorld(bb.north, bb.east);
    return [Math.min(sw.x, ne.x), Math.min(sw.z, ne.z), Math.max(sw.x, ne.x), Math.max(sw.z, ne.z)];
  };
  if (customMap) {
    const CustomTiles = L.GridLayer.extend({
      createTile(coords) {
        const c = document.createElement('canvas');
        const size = this.getTileSize();
        c.width = size.x; c.height = size.y;
        try { customMap.drawTile(c.getContext('2d'), size.x, _wbOf(coords), coords.z); } catch (e) { /* blank */ }
        return c;
      },
    });
    // fade:false → tiles don't animate in (no flash); keepBuffer keeps neighbours ready while driving.
    customLayer = new CustomTiles({ tileSize: 256, updateWhenZooming: false, keepBuffer: 4, fade: false });
    customLayer.addTo(map);
    // Repaint IN PLACE (no tile recreate → no blink) when new baked data arrives. redraw() would destroy
    // and re-fade every tile, which flickered while driving.
    let _redrawTimer = null;
    const refreshInPlace = () => {
      const tiles = customLayer._tiles || {};
      for (const k in tiles) {
        const t = tiles[k]; const el = t && t.el; const co = t && t.coords;
        if (!el || !co || !el.getContext) continue;
        try { customMap.drawTile(el.getContext('2d'), el.width, _wbOf(co), co.z); } catch (e) { /* skip */ }
      }
    };
    const scheduleRedraw = () => {
      if (_redrawTimer) return;
      _redrawTimer = setTimeout(() => { _redrawTimer = null; refreshInPlace(); }, 300);
    };
    customMap.setOnChange(scheduleRedraw);
    customLayer._ddRefresh = refreshInPlace;   // used on night-toggle / expand
  }

  const { lat, lon } = worldToLatLon(spawnCenter.x, spawnCenter.z);
  lastCarLatLon = [lat, lon];
  map.setView([lat, lon], MINIMAP_ZOOM, { animate: false });

  function setExpanded(isExpanded) {
    if (expanded === isExpanded) return;
    expanded = isExpanded;
    (isExpanded ? uiSound.open : uiSound.back)();   // map open/close blip
    if (expanded) {
      if (!backdropEl) {
        backdropEl = document.createElement('div');
        backdropEl.id = 'minimap-modal-backdrop';
        backdropEl.style.cssText = `
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.4);
          z-index: 9;
          pointer-events: auto;
        `;
        backdropEl.addEventListener('click', () => setExpanded(false));
      }
      document.body.appendChild(backdropEl);
      frame.style.top = '50%';
      frame.style.left = '50%';
      frame.style.right = 'auto';
      frame.style.bottom = 'auto';
      frame.style.width = '88vw';
      frame.style.height = '86vh';
      frame.style.maxWidth = '1200px';
      frame.style.maxHeight = '1000px';
      frame.style.borderRadius = '0';
      frame.style.transform = 'translate(-50%, -50%)';
      frame.style.zIndex = '11';
      frame.style.background = 'transparent';
      frame.style.border = 'none';
      frame.style.boxShadow = 'none';
      compassRing.style.display = 'none';
      borderRing.style.display = 'none';
      wrapper.style.top = '0';
      wrapper.style.left = '0';
      wrapper.style.right = '0';
      wrapper.style.bottom = '0';
      wrapper.style.width = 'auto';
      wrapper.style.height = 'auto';
      wrapper.style.borderRadius = '14px';
      wrapper.style.cursor = 'default';
      // Opaque map + soft dark vignette edge (no transparent fade → no scene ghosting). Natural spotlit look.
      wrapper.style.webkitMaskImage = 'none'; wrapper.style.maskImage = 'none';
      wrapper.style.boxShadow = '0 24px 80px rgba(0,0,0,0.6)';
      vignetteEl.style.display = 'block';
      zoomBtns.style.display = 'flex';
      wrapper.classList.add('minimap-expanded');
      mapInner.style.width = '100%';
      mapInner.style.height = '100%';
      mapInner.style.transform = 'none';
      mapInner.style.left = '0';
      mapInner.style.top = '0';
      mapInner.style.filter = _isNight ? FILTER_NIGHT : FILTER_DAY;   // keep the game tint in the big map too
      innerShadow.style.display = 'none';
      highlight.style.display = 'none';
      markerEl.style.display = 'none';
      map.dragging.enable();
      map.scrollWheelZoom.enable();
      map.doubleClickZoom.enable();
      map.invalidateSize();
      if (customLayer) customLayer._ddRefresh?.();   // repaint existing tiles into the resized viewport
      // Place a Leaflet marker at the player's current position with heading arrow
      if (lastCarLatLon) {
        const deg = currentRotationDeg;
        const markerHtml = `
          <div id="loc-marker-inner" style="
            position:relative; width:0; height:0;
            transform-origin:0 0;
          ">
            <svg id="loc-marker-svg" width="56" height="56" viewBox="0 0 56 56"
              style="position:absolute;transform:translate(-28px,-28px) rotate(${deg}deg);transform-origin:28px 28px;overflow:visible;">
              <!-- accuracy halo -->
              <circle cx="28" cy="28" r="24" fill="#2a7fff" opacity="0.14"/>
              <!-- heading wedge (points where you're facing) -->
              <polygon points="28,1 37,22 28,17 19,22" fill="#2a7fff" stroke="#ffffff" stroke-width="1.5"/>
              <!-- you-are-here dot -->
              <circle cx="28" cy="28" r="11" fill="#2a7fff" stroke="#ffffff" stroke-width="3.5"/>
              <circle cx="28" cy="28" r="4.5" fill="#ffffff" opacity="0.85"/>
            </svg>
          </div>`;
        if (!locationMarker) {
          const icon = L.divIcon({ className: '', html: markerHtml, iconSize: [0, 0] });
          locationMarker = L.marker(lastCarLatLon, { icon, interactive: false }).addTo(map);
        } else {
          locationMarker.setLatLng(lastCarLatLon);
          if (!map.hasLayer(locationMarker)) locationMarker.addTo(map);
        }
        // Grab the SVG element so we can rotate it live each frame
        locationMarkerArrow = locationMarker.getElement()?.querySelector('#loc-marker-svg') || null;
        map.setView(lastCarLatLon, map.getZoom(), { animate: true });
      }
    } else {
      if (backdropEl && backdropEl.parentNode) backdropEl.parentNode.removeChild(backdropEl);
      frame.style.top = 'auto';
      frame.style.left = '12px';
      frame.style.right = 'auto';
      frame.style.bottom = '12px';
      frame.style.width = `${TOTAL_SIZE}px`;
      frame.style.height = `${TOTAL_SIZE}px`;
      frame.style.maxWidth = 'none';
      frame.style.maxHeight = 'none';
      frame.style.borderRadius = '50%';
      frame.style.transform = 'none';
      frame.style.zIndex = '10';
      frame.style.background = 'none';
      frame.style.border = 'none';
      frame.style.boxShadow = 'none';
      wrapper.style.webkitMaskImage = 'none'; wrapper.style.maskImage = 'none';
      compassRing.style.display = '';
      borderRing.style.display = '';
      wrapper.style.top = `${INNER_OFFSET}px`;
      wrapper.style.left = `${INNER_OFFSET}px`;
      wrapper.style.right = 'auto';
      wrapper.style.bottom = 'auto';
      wrapper.style.width = `${MINIMAP_SIZE}px`;
      wrapper.style.height = `${MINIMAP_SIZE}px`;
      wrapper.style.borderRadius = '50%';
      wrapper.style.boxShadow = 'none';
      vignetteEl.style.display = 'none';
      zoomBtns.style.display = 'none';
      wrapper.style.cursor = 'pointer';
      wrapper.classList.remove('minimap-expanded');
      const innerSize = MINIMAP_SIZE * 1.5;
      mapInner.style.width = `${innerSize}px`;
      mapInner.style.height = `${innerSize}px`;
      mapInner.style.left = '50%';
      mapInner.style.top = '50%';
      mapInner.style.transform = `translate(-50%, -50%) rotate(${-currentRotationDeg}deg)`;
      mapInner.style.filter = (_isNight ? FILTER_NIGHT : FILTER_DAY);
      innerShadow.style.display = '';
      highlight.style.display = '';
      markerEl.style.display = '';
      // Remove the expanded Leaflet location marker
      if (locationMarker && map.hasLayer(locationMarker)) map.removeLayer(locationMarker);
      locationMarkerArrow = null;
      map.dragging.disable();
      map.scrollWheelZoom.disable();
      map.doubleClickZoom.disable();
      map.invalidateSize();
      if (lastCarLatLon) map.setView(lastCarLatLon, MINIMAP_ZOOM, { animate: false });
    }
  }

  wrapper.addEventListener('click', (e) => {
    if (expanded) return;
    e.stopPropagation();
    setExpanded(true);
  });

  const _typing = () => { const a = document.activeElement; return a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
  document.addEventListener('keydown', (e) => {
    // When the expanded minimap is up, Escape collapses it and must NOT also open the settings menu.
    if (e.key === 'Escape' && expanded) { setExpanded(false); e.stopImmediatePropagation(); return; }
    // M toggles the big map (but not while typing in a text field, e.g. the settings search).
    if ((e.key === 'm' || e.key === 'M') && !_typing()) { setExpanded(!expanded); e.stopImmediatePropagation(); }
  }, { capture: true });

  // Cache the SVG rotate group for per-frame updates
  const _compassRotateGroup = compassRing.querySelector('.compass-rotate');
  const _compassCx = compassSize / 2;

  function update(worldX, worldZ, headingDeg) {
    // Rotation updates every frame (smooth compass + map rotation)
    const targetDeg = Number.isFinite(headingDeg) ? headingDeg : 0;
    currentRotationDeg += (targetDeg - currentRotationDeg) * ROTATION_LERP;

    if (!expanded) {
      mapInner.style.transform = `translate(-50%, -50%) rotate(${-currentRotationDeg}deg)`;
      if (_compassRotateGroup) {
        _compassRotateGroup.setAttribute('transform', `rotate(${-currentRotationDeg} ${_compassCx} ${_compassCx})`);
      }
    } else if (locationMarkerArrow) {
      // Update arrow rotation in expanded (north-up) map every frame
      locationMarkerArrow.style.transform = `translate(-28px,-28px) rotate(${currentRotationDeg}deg)`;
    }

    // Dash objective dot — heading-up bearing to the next checkpoint, clamped to the minimap rim.
    if (_objTarget && !expanded && lastCarLatLon) {
      const plat = lastCarLatLon[0], plon = lastCarLatLon[1];
      const north = (_objTarget.lat - plat) * 111320;
      const east = (_objTarget.lon - plon) * 111320 * Math.cos(plat * Math.PI / 180);
      const a = Math.atan2(east, north) - currentRotationDeg * Math.PI / 180;   // 0 = up (heading-up)
      const res = 156543.03392 * Math.cos(plat * Math.PI / 180) / Math.pow(2, MINIMAP_ZOOM); // m/px
      const r = Math.min(MINIMAP_SIZE / 2 - 9, Math.hypot(north, east) / res);
      const c = MINIMAP_SIZE / 2;
      gateMarkerEl.style.left = `${c + Math.sin(a) * r}px`;
      gateMarkerEl.style.top = `${c - Math.cos(a) * r}px`;
      gateMarkerEl.style.display = 'block';
    } else if (gateMarkerEl.style.display !== 'none') {
      gateMarkerEl.style.display = 'none';
    }

    // Map tile panning is throttled (expensive Leaflet operation)
    const now = Date.now();
    if (now - lastUpdateTime < UPDATE_INTERVAL_MS) return;
    lastUpdateTime = now;

    if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) return;
    const { lat, lon } = worldToLatLon(worldX, worldZ);
    lastCarLatLon = [lat, lon];
    if (!expanded) {
      map.setView([lat, lon], MINIMAP_ZOOM, { animate: false });
    } else if (locationMarker) {
      // Keep marker at current position while expanded (map view stays where user panned)
      locationMarker.setLatLng([lat, lon]);
    }
  }

  function updateMarker() {
    const showBat = _markerMode === 'camera' && _markerNight;
    markerEl.innerHTML = showBat ? BAT_MARKER_SVG : CAR_MARKER_SVG;
    markerEl.style.width = showBat ? '70px' : `${markerSize}px`;
    markerEl.style.height = showBat ? '90px' : `${markerSize}px`;
  }

  function setMarkerMode(isCar) {
    const newMode = isCar ? 'car' : 'camera';
    if (newMode === _markerMode) return;
    _markerMode = newMode;
    updateMarker();
  }

  function setNightMode(isNight) {
    _isNight = isNight;
    _markerNight = isNight;
    if (customMap) { customMap.setNight(isNight); if (customLayer) customLayer._ddRefresh?.(); }
    borderRing.style.background = _isNight ? '#2a2a2a' : '#ffffff';
    updateMarker();
  }

  /** Dash: show a marker to a checkpoint at world (wx, wz), or null to clear. */
  function setObjectiveMarker(wx, wz) {
    if (wx == null || wz == null) { _objTarget = null; gateMarkerEl.style.display = 'none'; return; }
    _objTarget = worldToLatLon(wx, wz);
  }

  return { update, setNightMode, setMarkerMode, setObjectiveMarker };
}
