/**
 * Create Three.js scene, camera, renderer, lights, and cannon-es ground.
 * When CONFIG.ENABLE_DAY_NIGHT is true, ambient and sun are created by dayNight.js.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { latLonToWorld } from './projection.js';
import { START_LAT, START_LON } from './spawnConfig.js';
import { CONFIG } from './config.js';
import { isRallyStyle } from './rallyStyle.js';

// ---------------------------------------------------------------------------
// Shared sky palette — single source of truth for sky, fog, ambient, and car env.
// carModel.js imports these so all four systems stay in sync.
// If you change these, fog color, ambient tint, and car paint reflection update automatically.
// ---------------------------------------------------------------------------
export const SKY_HORIZON = new THREE.Color(0xBFD7EE); // #BFD7EE — warm haze near ground
export const SKY_MID     = new THREE.Color(0x94C2E6); // #94C2E6 — mid-sky blue
export const SKY_ZENITH  = new THREE.Color(0x6FAEDB); // #6FAEDB — deep zenith blue

// ---------------------------------------------------------------------------
// Stylized cloud system — soft billboarded blob sprites grouped into fluffy clouds
// ---------------------------------------------------------------------------

/**
 * Create a crisp cartoon cloud with shaded underside for 3D depth.
 * Solid white top, soft grey bottom — stylized driving game look.
 */
function createCloudTexture(seed) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Deterministic random from seed
  let s = seed;
  const r = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };

  const cx = size / 2, cy = size * 0.52;

  // --- Collect all circle shapes first (for re-use in shading) ---
  const circles = [];

  // Flat bottom ellipse — wide and squat
  circles.push({ x: cx, y: cy, rx: size * 0.40, ry: size * 0.15, isEllipse: true });

  // Bumpy top — 3-6 overlapping circles
  const bumps = 3 + Math.floor(r() * 4);
  for (let i = 0; i < bumps; i++) {
    const t = (i + 0.5) / bumps;
    const bx = cx + (t - 0.5) * size * 0.65;
    const by = cy - size * (0.08 + r() * 0.16);
    const br = size * (0.11 + r() * 0.1);
    circles.push({ x: bx, y: by, r: br });
  }

  // One large central bump for classic puffy top
  const mainR = size * (0.15 + r() * 0.07);
  circles.push({ x: cx + (r() - 0.5) * size * 0.12, y: cy - size * 0.2, r: mainR });

  // --- Draw white base shape ---
  ctx.fillStyle = '#ffffff';
  for (const c of circles) {
    ctx.beginPath();
    if (c.isEllipse) {
      ctx.ellipse(c.x, c.y, c.rx, c.ry, 0, 0, Math.PI * 2);
    } else {
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  // --- Add shading: grey gradient on lower portion for 3D depth ---
  // Use a clipping path of the cloud shape, then paint a gradient over it
  ctx.save();
  ctx.beginPath();
  for (const c of circles) {
    if (c.isEllipse) {
      ctx.moveTo(c.x + c.rx, c.y);
      ctx.ellipse(c.x, c.y, c.rx, c.ry, 0, 0, Math.PI * 2);
    } else {
      ctx.moveTo(c.x + c.r, c.y);
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    }
  }
  ctx.clip();

  // Vertical gradient: transparent top → grey bottom
  const shade = ctx.createLinearGradient(0, cy - size * 0.15, 0, cy + size * 0.18);
  const darkness = 0.12 + r() * 0.15; // vary shade intensity per cloud
  shade.addColorStop(0, 'rgba(0,0,0,0)');
  shade.addColorStop(0.5, `rgba(100,110,130,${darkness * 0.5})`);
  shade.addColorStop(1, `rgba(80,90,110,${darkness})`);
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, size, size);

  // Add some random darker patches on the underside for extra depth
  const patches = 2 + Math.floor(r() * 3);
  for (let i = 0; i < patches; i++) {
    const px = cx + (r() - 0.5) * size * 0.5;
    const py = cy + r() * size * 0.08;
    const pr = size * (0.06 + r() * 0.08);
    const pAlpha = 0.06 + r() * 0.1;
    const grad = ctx.createRadialGradient(px, py, 0, px, py, pr);
    grad.addColorStop(0, `rgba(70,80,100,${pAlpha})`);
    grad.addColorStop(1, 'rgba(70,80,100,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Minimal edge softening — 2px
  const imageData = ctx.getImageData(0, 0, size, size);
  ctx.clearRect(0, 0, size, size);
  const tmp = document.createElement('canvas');
  tmp.width = size; tmp.height = size;
  tmp.getContext('2d').putImageData(imageData, 0, 0);
  ctx.shadowColor = 'rgba(255,255,255,1)';
  ctx.shadowBlur = 2;
  ctx.drawImage(tmp, 0, 0);
  ctx.shadowBlur = 0;
  ctx.drawImage(tmp, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** All cloud sprite materials — used by setCloudNightMode() to tint at night. */
let _cloudMaterials = [];

// ---------------------------------------------------------------------------
// Moon — warm glowing disc near horizon, visible only at night
// ---------------------------------------------------------------------------
let _moonSprite = null;
let _moonGlowSprite = null;

function createMoonTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2, cy = size / 2, r = size * 0.42;

  // Deterministic random
  let _s = 42;
  const rng = () => { _s = (_s * 16807) % 2147483647; return (_s - 1) / 2147483646; };

  // Base moon disc — solid warm white with subtle limb darkening
  const base = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  base.addColorStop(0, '#FFF8E8');
  base.addColorStop(0.6, '#FFF3DC');
  base.addColorStop(0.85, '#F0E4C8');
  base.addColorStop(1, '#D8CCAE');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = base;
  ctx.fill();

  // Clip to moon disc for craters
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  // Maria (dark patches) — large darker areas like the real moon
  const maria = [
    { x: 0.35, y: 0.38, rx: 0.18, ry: 0.12, alpha: 0.12 },  // Mare top-left
    { x: 0.55, y: 0.45, rx: 0.22, ry: 0.16, alpha: 0.10 },  // Mare center
    { x: 0.42, y: 0.62, rx: 0.15, ry: 0.10, alpha: 0.08 },   // Mare bottom
    { x: 0.65, y: 0.35, rx: 0.10, ry: 0.08, alpha: 0.09 },   // small mare right
  ];
  for (const m of maria) {
    ctx.fillStyle = `rgba(140,130,110,${m.alpha})`;
    ctx.beginPath();
    ctx.ellipse(cx + (m.x - 0.5) * r * 2, cy + (m.y - 0.5) * r * 2,
                m.rx * r, m.ry * r, rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  // Craters — circles with darker rim and lighter center
  const craters = [
    // Large craters
    { x: 0.30, y: 0.35, r: 0.08 },
    { x: 0.58, y: 0.30, r: 0.06 },
    { x: 0.45, y: 0.55, r: 0.07 },
    { x: 0.65, y: 0.58, r: 0.05 },
    { x: 0.38, y: 0.70, r: 0.04 },
    // Medium craters
    { x: 0.25, y: 0.55, r: 0.035 },
    { x: 0.55, y: 0.68, r: 0.03 },
    { x: 0.70, y: 0.42, r: 0.03 },
    { x: 0.48, y: 0.38, r: 0.025 },
    // Small craters
    { x: 0.33, y: 0.48, r: 0.02 },
    { x: 0.62, y: 0.50, r: 0.018 },
    { x: 0.40, y: 0.28, r: 0.015 },
    { x: 0.52, y: 0.75, r: 0.02 },
    { x: 0.72, y: 0.52, r: 0.015 },
  ];

  for (const c of craters) {
    const crx = cx + (c.x - 0.5) * r * 2;
    const cry = cy + (c.y - 0.5) * r * 2;
    const cr = c.r * r * 2;

    // Dark rim/shadow (top-left bias for 3D look)
    ctx.fillStyle = `rgba(120,110,90,${0.15 + c.r * 0.5})`;
    ctx.beginPath();
    ctx.arc(crx - cr * 0.1, cry - cr * 0.1, cr, 0, Math.PI * 2);
    ctx.fill();

    // Lighter crater floor
    ctx.fillStyle = `rgba(240,232,210,${0.3 + c.r * 0.8})`;
    ctx.beginPath();
    ctx.arc(crx + cr * 0.1, cry + cr * 0.1, cr * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();

  // Crisp edge — redraw the outline to ensure clean circle boundary
  // Fade just the outer 2px for anti-aliasing
  const edgeGrad = ctx.createRadialGradient(cx, cy, r - 2, cx, cy, r + 1);
  edgeGrad.addColorStop(0, 'rgba(0,0,0,0)');
  edgeGrad.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = edgeGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createMoonGlowTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2, cy = size / 2, r = size * 0.48;

  // Soft warm glow halo
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0, 'rgba(255,220,160,0.3)');
  grad.addColorStop(0.4, 'rgba(255,200,130,0.12)');
  grad.addColorStop(1, 'rgba(255,180,100,0.0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function addMoon(scene, spawnX, spawnZ) {
  // Position: low on horizon, SE direction (azimuth ~135°)
  const azimuth = Math.PI * 0.75; // SE
  const dist = 8000;
  const height = 800; // low near horizon

  const dx = Math.cos(azimuth) * dist;
  const dz = Math.sin(azimuth) * dist;

  // Moon disc
  const moonMat = new THREE.SpriteMaterial({
    map: createMoonTexture(),
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: false,
    opacity: 0,
  });
  _moonSprite = new THREE.Sprite(moonMat);
  _moonSprite.position.set(spawnX + dx, height, spawnZ + dz);
  _moonSprite.scale.set(300, 300, 1);
  _moonSprite.frustumCulled = false;
  _moonSprite.renderOrder = 0;
  scene.add(_moonSprite);

  // Glow halo (larger, softer)
  const glowMat = new THREE.SpriteMaterial({
    map: createMoonGlowTexture(),
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: false,
    opacity: 0,
  });
  _moonGlowSprite = new THREE.Sprite(glowMat);
  _moonGlowSprite.position.set(spawnX + dx, height, spawnZ + dz);
  _moonGlowSprite.scale.set(900, 900, 1);
  _moonGlowSprite.frustumCulled = false;
  _moonGlowSprite.renderOrder = 0;
  scene.add(_moonGlowSprite);
}

/** Show/hide moon for day/night toggle. */
export function setMoonNightMode(isNight) {
  // Toggle .visible too so these sprites are skipped entirely in daylight (were drawn every frame at opacity 0).
  if (_moonSprite) { _moonSprite.material.opacity = isNight ? 1.0 : 0; _moonSprite.visible = isNight; }
  if (_moonGlowSprite) { _moonGlowSprite.material.opacity = isNight ? 0.6 : 0; _moonGlowSprite.visible = isNight; }
}

/** Move moon to follow camera (parallax — barely moves). */
export function updateMoon(camX, camZ) {
  if (!_moonSprite) return;
  const azimuth = Math.PI * 0.75;
  const dist = 8000;
  const dx = Math.cos(azimuth) * dist;
  const dz = Math.sin(azimuth) * dist;
  // Very slow parallax — moon barely moves
  const follow = 0.02;
  const mx = camX * follow + dx;
  const mz = camZ * follow + dz;
  _moonSprite.position.x = mx;
  _moonSprite.position.z = mz;
  _moonGlowSprite.position.x = mx;
  _moonGlowSprite.position.z = mz;
}

// ---------------------------------------------------------------------------
// Stars — scattered point field on a large sphere, visible only at night
// ---------------------------------------------------------------------------
let _starsMesh = null;

function addStars(scene) {
  const COUNT = 1500;
  const RADIUS = 20000;
  const positions = new Float32Array(COUNT * 3);
  const sizes = new Float32Array(COUNT);

  let s = 77;
  const rng = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };

  for (let i = 0; i < COUNT; i++) {
    // Distribute on upper hemisphere (above horizon)
    const theta = rng() * Math.PI * 2;
    const phi = Math.acos(rng() * 0.85 + 0.15); // bias upward, avoid horizon
    const r = RADIUS;
    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi); // Y up
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    sizes[i] = 1.5 + rng() * 3.5; // varying star sizes
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1));

  const mat = new THREE.PointsMaterial({
    color: 0xFFEEDD,
    size: 30,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });

  _starsMesh = new THREE.Points(geo, mat);
  _starsMesh.frustumCulled = false;
  _starsMesh.renderOrder = -1;
  scene.add(_starsMesh);
}

/** Show/hide stars for day/night toggle. */
export function setStarsNightMode(isNight) {
  if (_starsMesh) { _starsMesh.material.opacity = isNight ? 0.8 : 0; _starsMesh.visible = isNight; }
}

/** Move stars to follow camera so they stay overhead. */
export function updateStars(camX, camZ) {
  if (_starsMesh) {
    _starsMesh.position.x = camX;
    _starsMesh.position.z = camZ;
  }
}

/** Darken / lighten clouds for day/night toggle. */
export function setCloudNightMode(isNight) {
  const color = isNight ? 0x4a5570 : 0xffffff;
  const opacity = isNight ? 0.8 : 1.0;
  for (const mat of _cloudMaterials) {
    mat.color.set(color);
    mat.opacity = opacity;
  }
}

/** Cloud sprites + their relative offsets so we can re-center around camera. */
let _cloudSprites = [];  // { sprite, dx, y, dz }

function addClouds(scene, spawnX, spawnZ) {
  // Generate several unique cloud textures
  const NUM_TEXTURES = 8;
  const materials = [];
  for (let i = 0; i < NUM_TEXTURES; i++) {
    const tex = createCloudTexture(100 + i * 77);
    materials.push(new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
      opacity: 0.85,
      color: 0xd8dce0,  // slightly grey — stays below bloom threshold
    }));
  }
  _cloudMaterials = materials;
  _cloudSprites = [];

  // Fuller sky — several populated rings from near-mid out to high wisps (sprites are cheap, so we can afford
  // a lot). Each ring wraps 360° with jitter; large distVar staggers them so they don't read as tidy rings.
  const rings = [
    { count: 14, dist: 1100, distVar: 900,  y: 300,  yVar: 130,  w: 230, wVar: 150 },   // near-mid, plentiful
    { count: 12, dist: 1900, distVar: 1100, y: 470,  yVar: 190,  w: 320, wVar: 190 },   // mid, big
    { count: 11, dist: 2900, distVar: 1300, y: 700,  yVar: 260,  w: 380, wVar: 210 },   // upper, big
    { count: 16, dist: 4200, distVar: 1900, y: 1020, yVar: 460,  w: 210, wVar: 130 },   // high, many small wisps
  ];

  for (const ring of rings) {
    for (let i = 0; i < ring.count; i++) {
      const mat = materials[(Math.random() * materials.length) | 0];   // random texture per cloud → less repetition
      const sprite = new THREE.Sprite(mat);

      // Even 360° spacing + jitter that grows with count so denser rings still look scattered, not gridded.
      const angle = (i / ring.count) * Math.PI * 2 + (Math.random() - 0.5) * (Math.PI * 2 / ring.count) * 0.9;
      const dist = ring.dist + (Math.random() - 0.5) * ring.distVar;
      const dx = Math.cos(angle) * dist;
      const y = ring.y + Math.random() * ring.yVar;
      const dz = Math.sin(angle) * dist;

      const w = ring.w + Math.random() * ring.wVar;
      const h = w * (0.4 + Math.random() * 0.2);  // slightly taller ratio for cartoon look

      sprite.frustumCulled = false;
      sprite.renderOrder = 1;
      sprite.position.set(spawnX + dx, y, spawnZ + dz);
      sprite.scale.set(w, h, 1);

      scene.add(sprite);
      _cloudSprites.push({ sprite, dx, y, dz });
    }
  }
}

/** Re-center clouds around camera with parallax — higher clouds track slower. */
export function updateClouds(camX, camZ) {
  for (const c of _cloudSprites) {
    // Parallax: clouds follow camera slowly (0.05–0.15) based on height.
    // Low clouds drift a bit more, high clouds barely move — feels natural.
    const t = Math.min(1, c.y / 2000);           // 0 at ground, 1 at 2000m
    const follow = 0.15 - t * 0.10;              // low=0.15, high=0.05
    c.sprite.position.x = camX * follow + c.dx;
    c.sprite.position.z = camZ * follow + c.dz;
  }
}

export function createScene(container) {
  const scene = new THREE.Scene();
  // Background is handled by Sky shader below — no solid color needed

  const { x: spawnX, z: spawnZ } = latLonToWorld(START_LAT, START_LON);

  const width = container.clientWidth || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;
  const camera = new THREE.PerspectiveCamera(60, width / height, 1, 50000);
  camera.position.set(spawnX, 60, spawnZ + 120);
  camera.lookAt(spawnX, 0, spawnZ);

  // antialias:false — the scene renders into the EffectComposer's non-MSAA HalfFloat targets, so the
  // MSAA backbuffer AA never applied anyway; asking for it just wasted a VRAM/bandwidth backbuffer.
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // cap: DPR 2 = 4× the fragments everywhere
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Filmic tone mapping (ACES) instead of flat Linear — cinematic highlight rolloff + richer contrast across
  // the whole frame (bright skies/lights no longer clip to flat white). Exposure bumped to preserve the airy
  // high-key look. Tunable: swap to THREE.NeutralToneMapping for a gentler, more colour-preserving curve.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = isRallyStyle() ? 1.6 : 1.45;
  renderer.shadowMap.enabled = CONFIG.ENABLE_SHADOWS;
  // PCFShadowMap: three r183 deprecated PCFSoftShadowMap and auto-swaps it to this on first render anyway —
  // set it directly so output is identical but without the console deprecation warning.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.tabIndex = 0;
  container.appendChild(canvas);

  // ---------------------------------------------------------------------------
  // Gradient sky dome — stylized driving game look
  // Sky colors are exported so fog, ambient, and car env sphere stay in sync.
  // If you change these values, fog + ambient + car env update automatically.
  // ---------------------------------------------------------------------------
  const skyGeo = new THREE.IcosahedronGeometry(40000, 2); // detail 2 not 4 (~5,120→~320 tris) — gradient is per-fragment, vertex density is irrelevant
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uHorizon: { value: new THREE.Color(SKY_HORIZON) },
      uMid:     { value: new THREE.Color(SKY_MID)     },
      uZenith:  { value: new THREE.Color(SKY_ZENITH)  },
      // Rally-only warm sun scatter (set from sunDir below) — the art-of-rally golden horizon glow.
      uSunDir:  { value: new THREE.Vector3(0, 0.5, 1) },
      uSunGlow: { value: new THREE.Color(0xffcf9e)    },
      uRally:   { value: isRallyStyle() ? 1.0 : 0.0   },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPos.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uHorizon;
      uniform vec3 uMid;
      uniform vec3 uZenith;
      uniform vec3 uSunDir;
      uniform vec3 uSunGlow;
      uniform float uRally;
      varying vec3 vWorldPosition;
      void main() {
        vec3 dir = normalize(vWorldPosition);
        float h = dir.y;
        // Smooth gradient: horizon band extends below eye level for seamless ground blend
        float t = smoothstep(-0.05, 0.45, h);
        // Two-stage blend: horizon→mid then mid→zenith
        vec3 color = mix(uHorizon, uMid, smoothstep(0.0, 0.3, t));
        color = mix(color, uZenith, smoothstep(0.25, 1.0, t));
        // Art-of-rally warm sun scatter: a tight glow around the sun + a broad wash along the horizon
        // near the sun azimuth. Fades out above the horizon so the zenith stays clean blue.
        float sun = max(dot(dir, normalize(uSunDir)), 0.0);
        float horizonFade = 1.0 - smoothstep(0.0, 0.5, h);
        vec3 glow = uSunGlow * (pow(sun, 9.0) * 0.55 + pow(sun, 2.5) * 0.22 * horizonFade) * uRally;
        gl_FragColor = vec4(color + glow, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  scene.add(sky);

  // Sun direction — still needed for directional light positioning
  const sunDir = new THREE.Vector3();
  const phi   = THREE.MathUtils.degToRad(90 - 35); // elevation 35° (late afternoon)
  const theta = THREE.MathUtils.degToRad(200);       // azimuth SW
  sunDir.setFromSphericalCoords(1, phi, theta);
  skyMat.uniforms.uSunDir.value.copy(sunDir); // feed the sun scatter glow (rally sky)

  // Stylized cloud layer — billboarded sprite blobs
  addClouds(scene, spawnX, spawnZ);

  // Moon — warm glow near horizon, only visible at night
  addMoon(scene, spawnX, spawnZ);

  // Stars — point field, only visible at night
  addStars(scene);

  // Base ambient — warm amber lerped 25% toward sky horizon for atmospheric cohesion.
  // Rally style: COOL sky-bounce fill (blue) so shadows read cool against the warm sun — that
  // warm-key / cool-shadow separation is what makes flat low-poly facets pop (the art-of-rally look).
  const _rally = isRallyStyle();
  const ambColor = _rally
    ? new THREE.Color(0xdfeaf7).lerp(SKY_HORIZON, 0.16)  // BRIGHT, faintly cool sky-bounce (airy high-key)
    : new THREE.Color(0xffe8c8).lerp(SKY_HORIZON, 0.25);
  const ambientLight = new THREE.AmbientLight(ambColor, _rally ? 0.92 : 0.55);
  scene.add(ambientLight);

  // Hemisphere light (L1 golden-hour fill): cool sky-blue from above + warm ground bounce from below —
  // the warm-key/cool-shadow colour separation that GI gives for free offline. Actual colours/intensity
  // are owned by the envToggle DAY/NIGHT presets; these are just sane creation defaults.
  const hemiLight = new THREE.HemisphereLight(0xa3c0e4, 0xd08a4e, 0.5);
  scene.add(hemiLight);

  // Directional sun light — always created so the env toggle can control it. Rally: warmer + stronger
  // key for crisp light/shade on flat facets.
  const dirLight = new THREE.DirectionalLight(_rally ? 0xffcb84 : 0xffd9a0, _rally ? 1.75 : 1.2);
  dirLight.position.copy(sunDir.clone().multiplyScalar(1000));
  dirLight.castShadow = CONFIG.ENABLE_SHADOWS;
  const shadowSize = CONFIG.SHADOW_MAP_SIZE ?? 2048; // honor config (1024) — was forced to 2048 (4× fragments)
  dirLight.shadow.mapSize.width  = shadowSize;
  dirLight.shadow.mapSize.height = shadowSize;
  dirLight.shadow.radius         = _rally ? 6 : 3; // softer, painterly shadows in rally style
  // Tight shadow frustum — only casters near the car → cheap depth pass every frame (was 240m wide/far
  // 3000, which drew far too many buildings into the shadow map). Also gives sharper nearby shadows.
  dirLight.shadow.camera.near   = 1;
  dirLight.shadow.camera.far    = 600;
  dirLight.shadow.camera.left   = -85;
  dirLight.shadow.camera.right  = 85;
  dirLight.shadow.camera.top    = 85;
  dirLight.shadow.camera.bottom = -85;
  dirLight.shadow.bias       = -0.0002;
  dirLight.shadow.normalBias = 0.03;
  scene.add(dirLight.target);  // target must be in scene for shadow camera to follow
  if (!CONFIG.ENABLE_DAY_NIGHT) scene.add(dirLight);

  if (CONFIG.ENABLE_FOG || isRallyStyle()) {
    // Exponential fog — color matches sky horizon so terrain fades into sky seamlessly.
    // Density 0.005: reads as atmosphere without aggressively culling near tiles.
    // Rally style: a touch denser (0.0075) so distance melts into a soft haze — the diorama depth.
    scene.fog = new THREE.FogExp2(SKY_HORIZON.getHex(), isRallyStyle() ? 0.0025 : 0.005);

    // ── L2: AERIAL PERSPECTIVE (visual-target-analysis §5.4) ─────────────────
    // Globally patch the fog shader chunks (compiles lazily on first render, so patching here catches every
    // fogged material, including worker-built/shared singletons). Replaces the flat single-colour veil with
    // real atmosphere: distance progressively DESATURATES the scene, the haze BLUE-SHIFTS far away, warms
    // into a golden wedge toward the sun azimuth, and THINS with fragment altitude (rooftops/aerial shots
    // sit above the haze layer). All colours derive from fogColor, so day/night/title tints keep working.
    THREE.ShaderChunk.fog_pars_vertex = /* glsl */`
      #ifdef USE_FOG
        varying float vFogDepth;
        varying vec3 vDdFogWorldPos;
      #endif`;
    THREE.ShaderChunk.fog_vertex = /* glsl */`
      #ifdef USE_FOG
        vFogDepth = - mvPosition.z;
        // World position reconstructed from mvPosition (rigid inverse of viewMatrix) — works for EVERY
        // material including sprites/points, which have no 'transformed' or instanceMatrix in scope.
        vDdFogWorldPos = transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );
      #endif`;
    THREE.ShaderChunk.fog_pars_fragment = /* glsl */`
      #ifdef USE_FOG
        uniform vec3 fogColor;
        varying float vFogDepth;
        varying vec3 vDdFogWorldPos;
        #ifdef FOG_EXP2
          uniform float fogDensity;
        #else
          uniform float fogNear;
          uniform float fogFar;
        #endif
      #endif`;
    THREE.ShaderChunk.fog_fragment = /* glsl */`
      #ifdef USE_FOG
        #ifdef FOG_EXP2
          float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
        #else
          float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
        #endif
        // altitude thinning — high fragments rise above the haze layer
        fogFactor *= exp( - max( vDdFogWorldPos.y, 0.0 ) * 0.0045 );
        // aerial desaturation before the tint (distance greys colour long before it hides shape)
        float ddLum = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
        gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( ddLum ), fogFactor * 0.4 );
        // haze colour: blue-shifts with distance; warms toward the sun near the horizon (day only —
        // the warm wedge scales with the haze brightness so night stays clean)
        vec3 ddViewDir = normalize( vDdFogWorldPos - cameraPosition );
        const vec3 ddSunDir = vec3( -0.2802, 0.5736, -0.7698 );  // az 200°, elev 35° — matches scene.js sun
        float ddSun = pow( max( dot( ddViewDir, ddSunDir ), 0.0 ), 6.0 );
        float ddDay = smoothstep( 0.15, 0.4, dot( fogColor, vec3( 0.333 ) ) );
        vec3 ddFog = mix( fogColor, fogColor * vec3( 0.88, 0.97, 1.14 ), smoothstep( 0.25, 1.0, fogFactor ) );
        ddFog = mix( ddFog, fogColor * vec3( 1.22, 1.03, 0.82 ), ddSun * ddDay * 0.6 );
        gl_FragColor.rgb = mix( gl_FragColor.rgb, ddFog, fogFactor );
      #endif`;
  }

  // Physics world (cannon-es)
  const world = new CANNON.World();
  world.gravity.set(0, -9.82, 0);
  // NaiveBroadphase: Heightfield bodies have infinite AABBs in cannon-es which
  // corrupts SAP axis sorting, causing tree/scenery collisions to be missed.
  world.broadphase = new CANNON.NaiveBroadphase(world);
  world.allowSleep = true;
  world.defaultContactMaterial.friction = 0.12;
  // Car-vs-building/wall collisions use THIS default material (building bodies have no material of
  // their own). LOW friction (0.3→0.12) so the chassis SLIDES along a wall instead of gripping it and
  // stopping dead — friction 0.3 made glancing hits feel "stuck"/glued. restitution gives a little recoil
  // so head-on hits recoil slightly instead of slamming (velocity-dependent → eases fast frontal hits far
  // more than slow side scrapes). Wheels use RaycastVehicle frictionSlip, not this — so driving grip is
  // unaffected; this only governs how the body scrapes against walls/props.
  world.defaultContactMaterial.restitution = 0.18;
  world.defaultContactMaterial.contactEquationStiffness = 6e6;   // was default 1e7 — a touch of squish
  world.defaultContactMaterial.contactEquationRelaxation = 3.5;

  // No infinite ground plane — per-tile Trimesh colliders follow the terrain.
  // groundBody kept as reference (null) for API compatibility.
  const groundBody = null;

  // Fallback floor at Y=-50: catches the car if it falls between tiles
  const fallbackFloor = new CANNON.Body({ mass: 0 });
  fallbackFloor.addShape(new CANNON.Plane());
  fallbackFloor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  fallbackFloor.position.y = -50;
  world.addBody(fallbackFloor);

  // Stage 2 (DEM-on): the visible flat ground plane (was a 2000×2000 plane pinned to Y=0) is REMOVED.
  // A single flat plane cannot conform to a height field — any Y either slices up through higher
  // terrain or hides lower terrain on down-slopes — and it had no physics role (per-tile Trimesh
  // terrain colliders + the Y=−50 fallback floor handle ground). The per-tile terrain meshes now
  // render the real DEM relief. groundMesh is null; main.js / carDriver guard on it.
  const groundMesh = null;

  const worldGroup = new THREE.Group();
  worldGroup.scale.x = -1;
  scene.add(worldGroup);

  return {
    scene, camera, renderer, world, groundBody, groundMesh, worldGroup,
    spawnCenter: { x: spawnX, z: spawnZ },
    ambientLight, hemiLight, dirLight, sky, sunDir,
  };
}
