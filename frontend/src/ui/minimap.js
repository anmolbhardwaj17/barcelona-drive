/**
 * Circular mini map synced to viewer position — rendered by our own canvas (NO Leaflet).
 * Map rotates to match camera heading; pointer icon stays fixed pointing forward. Click / M to expand.
 *
 * The map image is drawn straight from the baked v7 vector data via customMap.drawTile(ctx, px, worldBounds,
 * zoom) — one canvas, centred on the car, north-up; heading-up is the existing CSS rotation on mapInner.
 * Expanded mode adds pointer-drag pan + wheel/button zoom. Leaflet (and its DOM-tile setView spike + GC
 * churn) is gone entirely.
 */
import { worldToLatLon } from '../projection.js';
import { uiSound } from './uiSound.js';

const MINIMAP_SIZE = 170;

// ── Compact HUD on touch devices ─────────────────────────────────────────────
// Phones/tablets: shrink the circular map and raise it above the left touch-control
// cluster (accel/brake). Uses transform scale so the canvas pipeline is untouched.
// Cluster metrics mirror touchControls.js: button = clamp(56px, 12vmin, 92px),
// bottom inset 14px, vertical gap ~12px.
const MM_IS_TOUCH = typeof window !== 'undefined' &&
  (window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 1);
const MM_SCALE = MM_IS_TOUCH ? 0.62 : 1;
const MM_LEFT = 12;
const MM_BOTTOM = MM_IS_TOUCH
  ? Math.round(14 + 2 * Math.max(56, Math.min(92, 0.12 * Math.min(window.innerWidth, window.innerHeight))) + 12 + 10)
  : 12;
const MINIMAP_ZOOM = 17;
const UPDATE_INTERVAL_MS = 350;   // Leaflet setView (tile re-center) is a DOM spike + GC churn; pan less
                                  // often. Rotation + the car arrow still update every frame (cheap CSS),
                                  // so the map stays lively — only the tile re-centre steps a touch larger.
const ROTATION_LERP = 0.15;

// ── DRONE VIEW (M-1) ──────────────────────────────────────────────────────────────────────────
// The map was dead top-down, which tells you where you ARE and almost nothing about where you are
// GOING. Every navigation view solves this the same way: tilt the plane, sit the vehicle low in the
// frame, and pull back as speed rises so the driver sees further ahead the faster they travel.
//
// Done with a CSS 3D transform on the existing rotated div — the canvas pipeline, the tile drawing
// and the expanded (north-up) mode are all untouched. A tilted DIV costs the compositor nothing;
// re-projecting the canvas per frame would cost a redraw.
const MM_TILT_DEG = 62;          // plane tilt — user asked for more; Google sits around 60-65
const MM_TILT_SPEED_DEG = 6;     // a little flatter at speed, so the far distance stays legible
const MM_SHIFT_REST = 0.16;      // car sits this far below centre at a standstill (fraction of size)
const MM_SHIFT_FAST = 0.30;      // and this far at speed — more road ahead when you need it
const MM_PULLBACK = 0.14;        // how much the map shrinks at speed, showing more ground
const MM_SPEED_FULL = 90;        // km/h at which the look-ahead is fully extended
const MM_PERSPECTIVE = 395;      // px — lower is a stronger, more dramatic tilt
const MM_LOOK_LERP = 0.06;       // the look-ahead EASES; snapping it with throttle reads as a lurch
// ⚠ ONE constant, because there are TWO places that size this div — creation, and the collapse out
// of expanded mode. 1.5x was right for a flat top-down square; a tilted plane reaches much further
// at its far edge and anything past the drawn area shows as empty backing, the "map ran out" look.
// The collapse path had its own hardcoded 1.5, so expanding and closing the map silently undid the
// drone view's coverage.
// Grew with the tilt: at 62° the far edge reaches further, and short-changing this is what
// leaves empty backing at the top of the circle.
const MM_INNER_SIZE = MINIMAP_SIZE * 2.45;
const BORDER_WIDTH = 4;
const COMPASS_RING_WIDTH = 20; // width of the compass band around the minimap

// OSM standard is colourful + detailed (green parks, blue water, coloured roads). Light touch: punch it
// a little by day, flip to a deep navy by night. (CARTO CDN proved unreliable on some networks.)
// The custom map tiles bake their own day/night palette, so no CSS filter tinting is needed.
// ── THE PLANE HAS AN EDGE, AND THE TILT PUT IT ON SCREEN ──────────────────────────────────────
// The drone tilt makes the map recede, so you see further than the drawn canvas reaches — and
// beyond it the wrapper showed through as a BLACK wedge at the far side. Enlarging the canvas is
// the obvious fix and the wrong one: a redraw already costs up to ~10 ms at speed and the cost
// scales with drawn area, so covering the tilt would nearly double it for ground you can barely
// resolve at that distance.
//
// Instead the wrapper carries the map's own ground tone, so past the edge reads as unresolved
// ground rather than a hole, and a screen-space haze band sits over the far side to dissolve the
// edge itself. Screen-space matters: the plane ROTATES with heading, so a fade painted on the map
// would spin with it and the far side is always the top of the SCREEN.
const MM_VOID_DAY   = '#e4e7e2';   // just under STYLE.day.ground (#edefeb) so it reads as distance
const MM_VOID_NIGHT = '#12161d';   // ditto against the night ground
const FILTER_DAY = 'none';
const FILTER_NIGHT = 'none';
let _isNight = false;

let mapInner = null;
let markerEl = null;
let compassRing = null;
let lastUpdateTime = 0;
let currentRotationDeg = 0;
let expanded = false;
let lastCarLatLon = null;
let backdropEl = null;
let locationMarkerArrow = null; // expanded you-are-here SVG — updated each frame for rotation

/**
 * Create circular mini map DOM + canvas renderer. Call once on init.
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
    bottom: ${MM_BOTTOM}px;
    left: ${MM_LEFT}px;
    width: ${TOTAL_SIZE}px;
    height: ${TOTAL_SIZE}px;
    border-radius: 50%;
    z-index: 10;
    pointer-events: none;
    transform: scale(${MM_SCALE});
    transform-origin: bottom left;
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
    labelsSvg += `<text x="${lx}" y="${ly}" fill="${c.color}" font-size="${fs}" font-weight="${fw}" font-family="Inter,system-ui,sans-serif" text-anchor="middle" dominant-baseline="central">${c.label}</text>`;
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
    background: ${_isNight ? MM_VOID_NIGHT : MM_VOID_DAY};
  `;

  const mapInnerSize = MM_INNER_SIZE;
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

  // Far-edge haze. Sits above the plane and below the marker, in SCREEN space, so it always covers
  // the receding top of the tilted view regardless of heading.
  const mapHaze = document.createElement('div');
  mapHaze.id = 'minimap-haze';
  mapHaze.style.cssText = `
    position: absolute; inset: 0; pointer-events: none; border-radius: 50%;
    background: linear-gradient(180deg, ${_isNight ? MM_VOID_NIGHT : MM_VOID_DAY} 0%,
      ${_isNight ? MM_VOID_NIGHT : MM_VOID_DAY}00 26%, transparent 34%);
  `;
  wrapper.appendChild(mapHaze);

  /** Re-tint the beyond-the-plane fill and its haze for the current day/night key. */
  function _paintVoid() {
    const c = _isNight ? MM_VOID_NIGHT : MM_VOID_DAY;
    wrapper.style.background = c;
    // Expanded mode fills the screen and never exposes the plane's edge, so the haze would only be
    // a band across the top of a full-screen map.
    mapHaze.style.opacity = expanded ? '0' : '1';
    mapHaze.style.background = `linear-gradient(180deg, ${c} 0%, ${c}00 26%, transparent 34%)`;
  }

  // Soft dark vignette over the map edges (expanded mode only). Keeps the map fully OPAQUE — a spotlit-map
  // look — instead of fading it to transparent over the 3D scene (which ghosted / looked fake).
  const vignetteEl = document.createElement('div');
  vignetteEl.style.cssText = 'position:absolute; inset:0; pointer-events:none; z-index:6; display:none;' +
    'border-radius:50%; box-shadow: inset 0 0 120px 24px rgba(46,50,58,0.55);';
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
  // ⚠ The marker is NOT part of mapInner, so the drone-view shift has to be applied to it too —
  // the map is drawn centred on the car, so pushing the map down moves the car's actual position
  // down with it. Leaving the icon at the container centre would draw it somewhere the car is not,
  // which is the one thing a "you are here" marker must never do. Updated in update() below.
  const mc = markerSize / 2;
  // ── NAVIGATION CHEVRON (M-2) ─────────────────────────────────────────────────────────────────
  // The old marker was a top-down PIN — a dot with a wedge, correct for a flat map and wrong the
  // moment the plane tilted, where it read as a sticker floating above the ground rather than a
  // vehicle on it. User: "this cursor needs to chnage as well have like google maps only this seems
  // topdown".
  //
  // A navigation arrow instead: a chevron with a notched tail, which is what makes it read as
  // pointing rather than as a triangle. Two details do the work — the darker underside gives it a
  // thickness so it is a solid object catching light, and the soft ellipse beneath is a contact
  // shadow, which is what actually plants it ON the road instead of above it.
  //
  // The tilt itself is applied in update(): the marker sits outside the transformed map div, so it
  // has to be laid onto the same plane by hand or it stands upright while the world leans away.
  const CAR_MARKER_SVG = `
    <svg viewBox="0 0 ${markerSize} ${markerSize}" width="${markerSize}" height="${markerSize}">
      <defs>
        <linearGradient id="mm-nav-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#5fa8ff"/>
          <stop offset="100%" stop-color="#1a6fe8"/>
        </linearGradient>
        <!-- A soft drop shadow, not a drawn ellipse. The first version stacked a hard shadow
             ellipse AND an offset darker copy to fake thickness; at 44 px both read as a grey
             smudge sitting behind the arrow rather than as depth. One blurred shadow does the whole
             job and keeps the silhouette clean. -->
        <filter id="mm-nav-drop" x="-60%" y="-60%" width="220%" height="220%">
          <feDropShadow dx="0" dy="1.6" stdDeviation="1.9"
                        flood-color="#0a1830" flood-opacity="0.42"/>
        </filter>
      </defs>
      <polygon points="${mc},${mc - 13} ${mc + 11},${mc + 11} ${mc},${mc + 4.5} ${mc - 11},${mc + 11}"
               fill="url(#mm-nav-face)" stroke="#ffffff" stroke-width="2.2"
               stroke-linejoin="round" filter="url(#mm-nav-drop)"/>
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

  // Expanded-map "you are here" marker — own DOM element (no Leaflet). Positioned at the car's pixel and
  // rotated to heading each frame while expanded; hidden in circular mode (the centre markerEl serves there).
  const locMarkerEl = document.createElement('div');
  locMarkerEl.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:1000;pointer-events:none;display:none;';
  locMarkerEl.innerHTML = `<svg width="56" height="56" viewBox="0 0 56 56" style="position:absolute;transform:translate(-28px,-28px);transform-origin:28px 28px;overflow:visible;">
      <circle cx="28" cy="28" r="24" fill="#2a7fff" opacity="0.14"/>
      <polygon points="28,1 37,22 28,17 19,22" fill="#2a7fff" stroke="#ffffff" stroke-width="1.5"/>
      <circle cx="28" cy="28" r="11" fill="#2a7fff" stroke="#ffffff" stroke-width="3.5"/>
      <circle cx="28" cy="28" r="4.5" fill="#ffffff" opacity="0.85"/>
    </svg>`;
  const _locSvg = locMarkerEl.firstElementChild;
  wrapper.appendChild(locMarkerEl);

  // Dynamic blips (e.g. police cars in Heat mode) — pooled dots, world coords, heading-up in the circle.
  let _blips = [];
  const _blipEls = [];
  function setBlips(list) { _blips = list || []; }

  frame.appendChild(wrapper);

  // Zoom +/- — a clean segmented pill (top-left of the expanded map) with crisp icons + hover states.
  const zoomBtns = document.createElement('div');
  zoomBtns.style.cssText = 'position:absolute; top:20px; left:20px; z-index:13; display:none; flex-direction:column;' +
    'background:rgba(255,255,255,0.96); border-radius:13px; box-shadow:0 6px 20px rgba(0,0,0,0.22); overflow:hidden; pointer-events:auto;';
  const _icon = (kind) => kind === 'plus'
    ? '<svg width="17" height="17" viewBox="0 0 17 17"><path d="M8.5 2.5v11M2.5 8.5h11" stroke="#333" stroke-width="1.9" stroke-linecap="round"/></svg>'
    : '<svg width="17" height="17" viewBox="0 0 17 17"><path d="M2.5 8.5h11" stroke="#333" stroke-width="1.9" stroke-linecap="round"/></svg>';
  const _mkZoom = (kind, delta, divider) => {
    const b = document.createElement('button');
    b.innerHTML = _icon(kind);
    b.style.cssText = 'width:44px; height:44px; border:none; background:transparent; cursor:pointer; padding:0;' +
      'display:flex; align-items:center; justify-content:center; transition:background .12s;' +
      (divider ? 'border-bottom:1px solid rgba(0,0,0,0.09);' : '');
    b.addEventListener('mouseenter', () => { b.style.background = 'rgba(0,0,0,0.06)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    b.addEventListener('click', (e) => { e.stopPropagation(); zoomBy(delta); });
    zoomBtns.appendChild(b);
  };
  _mkZoom('plus', 1, true);
  _mkZoom('minus', -1, false);
  frame.appendChild(zoomBtns);

  // Zoom slider along the bottom of the expanded map — easy zoom for trackpads.
  document.body.appendChild(frame);

  // ── Canvas renderer (replaces Leaflet) ─────────────────────────────────────
  // One canvas, drawn straight from the baked vector data. No tile grid, no setView, no DOM churn.
  const mapCanvas = document.createElement('canvas');
  mapCanvas.style.cssText = 'width:100%;height:100%;display:block;';
  mapDiv.appendChild(mapCanvas);
  const _mctx = mapCanvas.getContext('2d');

  let _zoom = MINIMAP_ZOOM;                                   // LOD + scale (13..19)
  let _lastCarWX = spawnCenter.x, _lastCarWZ = spawnCenter.z; // car world pos → circular map centre
  let _viewX = spawnCenter.x, _viewZ = spawnCenter.z;         // expanded pan centre (world)
  let _drawX = Infinity, _drawZ = Infinity, _drawZoom = -1, _drawPx = 0;

  // Web-Mercator metres-per-CSS-pixel at a given latitude + zoom (matches the old Leaflet scale).
  const _mPerPx = (lat, zoom) => 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);

  let _lastRedrawT = 0;
  function redrawMap(force = false) {
    if (!customMap || !_mctx) return;
    const cssPx = Math.max(2, Math.round(mapDiv.clientWidth || MINIMAP_SIZE));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.round(cssPx * dpr);                 // retina backing resolution
    if (mapCanvas.width !== bw) { mapCanvas.width = bw; mapCanvas.height = bw; force = true; }
    const cx = expanded ? _viewX : _lastCarWX;
    const cz = expanded ? _viewZ : _lastCarWZ;
    if (!force) {
      const moved = (cx - _drawX) ** 2 + (cz - _drawZ) ** 2;
      if (moved < 25 && _zoom === _drawZoom && bw === _drawPx) return;  // <5 m moved, unchanged → skip
    }
    // Time throttle: at speed the 5m-move gate fires ~5x/s and each vector redraw costs up to
    // ~10ms (worst ui 10.1 in STATS at 99km/h) — cap redraw rate; the CSS rotation stays smooth.
    const nowT = performance.now();
    if (!force && nowT - (_lastRedrawT || 0) < 180) return;
    _lastRedrawT = nowT;
    _drawX = cx; _drawZ = cz; _drawZoom = _zoom; _drawPx = bw;
    const ll = worldToLatLon(cx, cz);
    const span = cssPx * _mPerPx(ll.lat, _zoom);        // world metres across the canvas
    const wb = [cx - span / 2, cz - span / 2, cx + span / 2, cz + span / 2];
    // Small circular map: skip building footprints only (hundreds of tiny polys, invisible at
    // 180px) — roads/names keep full LOD; the expanded fullscreen map keeps everything.
    try { customMap.drawTile(_mctx, bw, wb, Math.round(_zoom), 30, !expanded); } catch (e) { /* blank */ }
  }

  function zoomBy(delta) { _zoom = Math.max(13, Math.min(19, _zoom + delta)); redrawMap(true); }

  // Expanded-mode pan (pointer drag moves the world view centre) + wheel zoom.
  let _dragging = false, _dragPX = 0, _dragPY = 0;
  wrapper.addEventListener('pointerdown', (e) => {
    if (!expanded) return;
    _dragging = true; _dragPX = e.clientX; _dragPY = e.clientY; wrapper.setPointerCapture?.(e.pointerId);
  });
  wrapper.addEventListener('pointermove', (e) => {
    if (!_dragging || !expanded) return;
    const ll = worldToLatLon(_viewX, _viewZ);
    const mpp = _mPerPx(ll.lat, _zoom);                 // world metres per CSS pixel
    _viewX -= (e.clientX - _dragPX) * mpp;              // content follows the finger
    _viewZ += (e.clientY - _dragPY) * mpp;              // screen-down = south (north-up map)
    _dragPX = e.clientX; _dragPY = e.clientY;
    redrawMap(true);
  });
  const _endDrag = () => { _dragging = false; };
  wrapper.addEventListener('pointerup', _endDrag);
  wrapper.addEventListener('pointercancel', _endDrag);
  wrapper.addEventListener('wheel', (e) => { if (!expanded) return; e.preventDefault(); zoomBy(e.deltaY < 0 ? 1 : -1); }, { passive: false });

  if (customMap) {
    // Repaint (throttled) as new baked tiles stream in while driving.
    let _rdT = null;
    customMap.setOnChange(() => { if (_rdT) return; _rdT = setTimeout(() => { _rdT = null; redrawMap(true); }, 300); });
  }

  const { lat, lon } = worldToLatLon(spawnCenter.x, spawnCenter.z);
  lastCarLatLon = [lat, lon];
  redrawMap(true);

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
          background: rgba(0,0,0,0.12);
          backdrop-filter: blur(15px);
          -webkit-backdrop-filter: blur(15px);
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
      frame.style.width = 'min(88vw, 88vh)';
      frame.style.height = 'min(88vw, 88vh)';
      frame.style.maxWidth = '1080px';
      frame.style.maxHeight = '1080px';
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
      wrapper.style.borderRadius = '0';
      wrapper.style.overflow = 'visible';   // let the radial mask feather softly (overflow:hidden hard-clips it)
      wrapper.style.cursor = 'default';
      wrapper.style.boxShadow = 'none';
      // Circular map whose edge is a smooth RADIAL feather — dissolves evenly into the frosted (backdrop-
      // blurred) scene behind. closest-side sizes the circle to the square; opaque to 78%, then feathers out.
      const _radial = 'radial-gradient(circle closest-side at center, #000 66%, rgba(0,0,0,0.4) 85%, transparent 100%)';
      wrapper.style.webkitMaskImage = _radial; wrapper.style.maskImage = _radial;
      wrapper.style.webkitMaskComposite = ''; wrapper.style.maskComposite = '';
      // Soft dark edge UNDER the feather → the light map dissolves through a dim ring into the blurred
      // scene, instead of glowing white (which read as fake).
      vignetteEl.style.display = 'block';
      zoomBtns.style.display = 'flex';
      wrapper.classList.add('minimap-expanded');
      mapInner.style.width = '100%';
      mapInner.style.height = '100%';
      mapInner.style.transform = 'none';
      mapInner.style.left = '0';
      mapInner.style.top = '0';
      mapInner.style.filter = _isNight ? FILTER_NIGHT : FILTER_DAY;   // keep the game tint in the big map too
      _paintVoid();
      innerShadow.style.display = 'none';
      highlight.style.display = 'none';
      markerEl.style.display = 'none';
      // Centre the expanded view on the car and show the you-are-here marker (positioned each frame).
      _viewX = _lastCarWX; _viewZ = _lastCarWZ;
      locationMarkerArrow = _locSvg;
      locMarkerEl.style.display = 'block';
      redrawMap(true);
    } else {
      if (backdropEl && backdropEl.parentNode) backdropEl.parentNode.removeChild(backdropEl);
      frame.style.top = 'auto';
      frame.style.left = `${MM_LEFT}px`;
      frame.style.right = 'auto';
      frame.style.bottom = `${MM_BOTTOM}px`;
      frame.style.width = `${TOTAL_SIZE}px`;
      frame.style.height = `${TOTAL_SIZE}px`;
      frame.style.maxWidth = 'none';
      frame.style.maxHeight = 'none';
      frame.style.borderRadius = '50%';
      frame.style.transform = MM_SCALE !== 1 ? `scale(${MM_SCALE})` : 'none';
      frame.style.transformOrigin = 'bottom left';
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
      wrapper.style.overflow = 'hidden';   // crisp circular clip for the small minimap
      wrapper.style.boxShadow = 'none';
      vignetteEl.style.display = 'none';
      zoomBtns.style.display = 'none';
      wrapper.style.cursor = 'pointer';
      wrapper.classList.remove('minimap-expanded');
      mapInner.style.width = `${MM_INNER_SIZE}px`;
      mapInner.style.height = `${MM_INNER_SIZE}px`;
      mapInner.style.left = '50%';
      mapInner.style.top = '50%';
      // Flat for this frame only; update() reapplies the drone tilt on the very next one.
      mapInner.style.transform = `translate(-50%, -50%) rotate(${-currentRotationDeg}deg)`;
      mapInner.style.filter = (_isNight ? FILTER_NIGHT : FILTER_DAY);
      _paintVoid();
      innerShadow.style.display = '';
      highlight.style.display = '';
      markerEl.style.display = '';
      // Hide the expanded you-are-here marker; back to circular zoom + car-centred redraw.
      locMarkerEl.style.display = 'none';
      locationMarkerArrow = null;
      _zoom = MINIMAP_ZOOM;
      redrawMap(true);
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

  let _lookAhead = 0;   // eased 0..1 speed factor driving tilt, shift and pull-back

  function update(worldX, worldZ, headingDeg, speedKmh = 0) {
    // Rotation updates every frame (smooth compass + map rotation)
    const targetDeg = Number.isFinite(headingDeg) ? headingDeg : 0;
    currentRotationDeg += (targetDeg - currentRotationDeg) * ROTATION_LERP;

    // Speed shapes the view: eased, never snapped — the map lunging on every throttle blip is
    // worse than a map that lags slightly behind the car.
    const _spd = Math.min(1, Math.abs(speedKmh || 0) / MM_SPEED_FULL);
    _lookAhead += (_spd - _lookAhead) * MM_LOOK_LERP;

    if (!expanded) {
      const tilt = MM_TILT_DEG - MM_TILT_SPEED_DEG * _lookAhead;
      const shift = MINIMAP_SIZE * (MM_SHIFT_REST + (MM_SHIFT_FAST - MM_SHIFT_REST) * _lookAhead);
      const zoom = 1 - MM_PULLBACK * _lookAhead;
      // Order matters: centre the element FIRST, then establish the tilted space, then push the map
      // down and spin it to heading. Putting the translate after rotateX would move it along the
      // tilted plane instead of down the screen.
      mapInner.style.transform =
        `translate(-50%, -50%) perspective(${MM_PERSPECTIVE}px) rotateX(${tilt.toFixed(1)}deg) `
        + `translateY(${shift.toFixed(1)}px) scale(${zoom.toFixed(3)}) rotate(${-currentRotationDeg}deg)`;
      // Keep the marker on the car. The map's own shift is in TILTED space, so its on-screen drop is
      // shift * cos(tilt) — using the raw shift would place the icon below where the car actually is.
      if (markerEl) {
        const screenDrop = shift * Math.cos(tilt * Math.PI / 180) * zoom;
        // LAY IT ON THE PLANE. The marker lives outside the transformed map div, so without the
        // same rotateX it stands bolt upright while the world leans away — which is precisely what
        // made the old pin read as top-down. Slightly less tilt than the map (0.82) so the arrow
        // stays readable instead of foreshortening into a line at speed.
        markerEl.style.transform =
          `translate(-50%, calc(-50% + ${screenDrop.toFixed(1)}px)) `
          + `perspective(${MM_PERSPECTIVE}px) rotateX(${(tilt * 0.82).toFixed(1)}deg)`;
      }
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

    // Dynamic blips (police etc.) — same heading-up bearing math as the objective dot.
    if (!expanded && lastCarLatLon && _blips.length) {
      const plat = lastCarLatLon[0], plon = lastCarLatLon[1];
      const res = 156543.03392 * Math.cos(plat * Math.PI / 180) / Math.pow(2, MINIMAP_ZOOM);
      const c = MINIMAP_SIZE / 2;
      for (let i = 0; i < _blips.length; i++) {
        let el = _blipEls[i];
        if (!el) {
          el = document.createElement('div');
          el.style.cssText = 'position:absolute;width:11px;height:11px;border-radius:50%;border:2px solid #fff;transform:translate(-50%,-50%);z-index:5;pointer-events:none;box-shadow:0 0 6px rgba(0,0,0,.55)';
          wrapper.appendChild(el); _blipEls[i] = el;
        }
        const ll = worldToLatLon(_blips[i].wx, _blips[i].wz);
        const north = (ll.lat - plat) * 111320, east = (ll.lon - plon) * 111320 * Math.cos(plat * Math.PI / 180);
        const a = Math.atan2(east, north) - currentRotationDeg * Math.PI / 180;
        const r = Math.min(MINIMAP_SIZE / 2 - 8, Math.hypot(north, east) / res);
        el.style.left = `${c + Math.sin(a) * r}px`; el.style.top = `${c - Math.cos(a) * r}px`;
        el.style.background = _blips[i].color || '#ff3b3b';
        el.style.display = 'block';
      }
      for (let i = _blips.length; i < _blipEls.length; i++) _blipEls[i].style.display = 'none';
    } else {
      for (const el of _blipEls) el.style.display = 'none';
    }

    // Track the car's world position (for the car-centred redraw + expanded marker); refresh its lat/lon
    // (used by the blip/objective bearing math) on a light throttle to avoid a per-frame allocation.
    if (Number.isFinite(worldX) && Number.isFinite(worldZ)) {
      _lastCarWX = worldX; _lastCarWZ = worldZ;
      const now = Date.now();
      if (now - lastUpdateTime >= UPDATE_INTERVAL_MS) {
        lastUpdateTime = now;
        const { lat, lon } = worldToLatLon(worldX, worldZ);
        lastCarLatLon = [lat, lon];
      }
    }

    // Redraw: circular is car-centred + self-throttled by movement; expanded only redraws on pan/zoom, and
    // keeps the you-are-here marker glued to the car's pixel every frame.
    redrawMap();
    if (expanded && locMarkerEl.style.display !== 'none') {
      const cssPx = mapDiv.clientWidth || MINIMAP_SIZE;
      const ll = worldToLatLon(_viewX, _viewZ);
      const mpp = _mPerPx(ll.lat, _zoom);
      locMarkerEl.style.left = `${cssPx / 2 + (_lastCarWX - _viewX) / mpp}px`;
      locMarkerEl.style.top = `${cssPx / 2 - (_lastCarWZ - _viewZ) / mpp}px`;
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
    if (customMap) { customMap.setNight(isNight); redrawMap(true); }
    // ⚠ THE VOID AND ITS HAZE ARE NOT REDRAWN BY redrawMap. They are wrapper/overlay CSS, painted
    // once at construction from `_isNight` — which is false then — so without this the beyond-the-
    // plane fill kept the DAY tone (#e4e7e2) after dark: the map body went navy while its far edge
    // stayed a pale, whitish band. _paintVoid already existed and was simply never called here.
    _paintVoid();
    borderRing.style.background = _isNight ? '#2a2a2a' : '#ffffff';
    updateMarker();
  }

  /** Dash: show a marker to a checkpoint at world (wx, wz), or null to clear. */
  function setObjectiveMarker(wx, wz) {
    if (wx == null || wz == null) { _objTarget = null; gateMarkerEl.style.display = 'none'; return; }
    _objTarget = worldToLatLon(wx, wz);
  }

  return { update, setNightMode, setMarkerMode, setObjectiveMarker, setBlips };
}
