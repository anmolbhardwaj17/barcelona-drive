/**
 * Procedural texture generation for Barcelona road system (Phase 3).
 * Generates textures via Canvas2D at app init — no external PNG assets required.
 *
 * Exports two separate THREE.CanvasTexture objects:
 *   panotTexture      — 256×256 Flor de Barcelona tile, seamlessly repeating every 0.2m
 *   bikePictogramTexture — 128×128 white bicycle pictogram on dark background
 *
 * Call createRoadTextures() once after the renderer is ready and reuse the results.
 */
import * as THREE from 'three';

/** Generate a 256×256 "Flor de Barcelona" panot tile texture (seamlessly repeating). */
function makePanotCanvas() {
  const SIZE = 256;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE; canvas.height = SIZE;
  const ctx = canvas.getContext('2d');

  // Base: pale grey-beige
  ctx.fillStyle = '#C8C2B5';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Grout border: thin darker frame around the whole tile to simulate mortar joint
  ctx.strokeStyle = '#A0988E';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, SIZE - 4, SIZE - 4);

  // 4 petals radiating from tile center, each a filled rotated ellipse
  // Petal: major radius 78px, minor radius 42px, center offset 68px from tile center
  const cx = SIZE / 2, cy = SIZE / 2;
  const PETAL_MAJOR = 78, PETAL_MINOR = 42, PETAL_OFFSET = 68;
  const PETAL_COLOR = '#B0AA9E';

  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2; // 0°, 90°, 180°, 270°
    const px = cx + Math.cos(angle) * PETAL_OFFSET;
    const py = cy + Math.sin(angle) * PETAL_OFFSET;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.ellipse(0, 0, PETAL_MAJOR, PETAL_MINOR, 0, 0, Math.PI * 2);
    ctx.fillStyle = PETAL_COLOR;
    ctx.fill();
    ctx.restore();
  }

  // Central disc
  ctx.beginPath();
  ctx.arc(cx, cy, 22, 0, Math.PI * 2);
  ctx.fillStyle = PETAL_COLOR;
  ctx.fill();

  // Subtle engraving — slightly darker outline on petals for depth
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2;
    const px = cx + Math.cos(angle) * PETAL_OFFSET;
    const py = cy + Math.sin(angle) * PETAL_OFFSET;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.ellipse(0, 0, PETAL_MAJOR, PETAL_MINOR, 0, 0, Math.PI * 2);
    ctx.strokeStyle = '#988E84';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  return canvas;
}

/** Generate a 128×128 bike pictogram (white bicycle on dark translucent background). */
function makeBikePictogramCanvas() {
  const SIZE = 128;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE; canvas.height = SIZE;
  const ctx = canvas.getContext('2d');

  // Transparent background — road colour shows through in game
  ctx.clearRect(0, 0, SIZE, SIZE);

  ctx.strokeStyle = '#FFFFFF';
  ctx.fillStyle = '#FFFFFF';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const cx = SIZE / 2;   // 64
  const WR = 22;         // wheel radius
  const LW = 28;         // axle to axle half-span (horizontal)
  const WY = 88;         // wheel Y (lower portion)
  const SY = 44;         // seat / top Y

  // Rear wheel (left)
  const rxL = cx - LW, ryW = WY;
  ctx.beginPath(); ctx.arc(rxL, ryW, WR, 0, Math.PI * 2);
  ctx.lineWidth = 4; ctx.stroke();

  // Front wheel (right)
  const rxR = cx + LW, ryF = WY;
  ctx.beginPath(); ctx.arc(rxR, ryF, WR, 0, Math.PI * 2);
  ctx.stroke();

  // Frame: seat post up from rear axle to seat, then diagonal to front axle
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(rxL, ryW);              // rear axle
  ctx.lineTo(cx - 8, SY + 6);       // seat base
  ctx.lineTo(cx + 10, SY - 4);      // top tube
  ctx.lineTo(rxR, ryF);             // front axle
  ctx.stroke();

  // Chain stay (rear axle to bottom bracket)
  ctx.beginPath();
  ctx.moveTo(rxL, ryW);
  ctx.lineTo(cx - 8, SY + 6);
  ctx.stroke();

  // Seat tube (bottom bracket to seat)
  ctx.beginPath();
  ctx.moveTo(cx - 8, SY + 6);
  ctx.lineTo(cx - 12, SY - 6);
  ctx.stroke();

  // Handlebar stem
  ctx.beginPath();
  ctx.moveTo(cx + 10, SY - 4);
  ctx.lineTo(cx + 14, SY - 18);
  ctx.stroke();

  // Handlebar (horizontal)
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx + 6, SY - 20);
  ctx.lineTo(cx + 22, SY - 20);
  ctx.stroke();

  // Saddle (small horizontal bar at seat)
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx - 20, SY - 8);
  ctx.lineTo(cx - 4, SY - 8);
  ctx.stroke();

  // Rider silhouette (simplified body — circle for head)
  ctx.beginPath();
  ctx.arc(cx - 8, SY - 22, 9, 0, Math.PI * 2);
  ctx.lineWidth = 3; ctx.stroke();

  return canvas;
}

/**
 * Create road textures for Phase 3 Barcelona renderer.
 * Call once after renderer is ready. Returns cached objects on subsequent calls.
 *
 * @returns {{ panotTexture: THREE.CanvasTexture, bikePictogramTexture: THREE.CanvasTexture }}
 */
let _cached = null;
export function createRoadTextures() {
  if (_cached) return _cached;

  const panotCanvas = makePanotCanvas();
  const panotTexture = new THREE.CanvasTexture(panotCanvas);
  panotTexture.wrapS = THREE.RepeatWrapping;
  panotTexture.wrapT = THREE.RepeatWrapping;
  panotTexture.minFilter = THREE.LinearMipmapLinearFilter;
  panotTexture.magFilter = THREE.LinearFilter;
  panotTexture.generateMipmaps = true;
  panotTexture.colorSpace = THREE.SRGBColorSpace;

  const bikeCanvas = makeBikePictogramCanvas();
  const bikePictogramTexture = new THREE.CanvasTexture(bikeCanvas);
  bikePictogramTexture.colorSpace = THREE.SRGBColorSpace;

  _cached = { panotTexture, bikePictogramTexture };
  return _cached;
}
