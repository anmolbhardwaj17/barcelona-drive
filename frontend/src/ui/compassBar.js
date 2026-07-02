/**
 * Horizontal compass bar HUD — canvas-based, matching the speedometer design.
 * Dark translucent strip with white ticks, cardinal labels, center needle, and degree readout.
 */

const BAR_WIDTH = 600;
const BAR_HEIGHT = 38;
const PX_PER_DEG = 3.6;
const TOTAL_DEG = 360;
const STRIP_W = TOTAL_DEG * PX_PER_DEG; // 1080px for full 360°

const CARDINALS = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

let _canvas = null;
let _ctx = null;
let _heading = 0;
let _smoothHeading = 0;
let _container = null;

export function createCompassBar() {
  _container = document.createElement('div');
  _container.id = 'compass-bar';
  _container.style.cssText = `
    position: fixed;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 900;
    pointer-events: none;
    filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.4));
  `;

  _canvas = document.createElement('canvas');
  _canvas.width = BAR_WIDTH * 2;  // 2x retina
  _canvas.height = (BAR_HEIGHT + 32) * 2;
  _canvas.style.cssText = `
    width: ${BAR_WIDTH}px;
    height: ${BAR_HEIGHT + 32}px;
  `;
  _ctx = _canvas.getContext('2d');
  _ctx.scale(2, 2);

  _container.appendChild(_canvas);
  document.body.appendChild(_container);

  _drawFrame(0);
  return { update };
}

function update(headingDeg) {
  _heading = headingDeg;
  // Smooth interpolation
  let diff = _heading - _smoothHeading;
  // Wrap around shortest path
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  _smoothHeading += diff * 0.15;
  _drawFrame(_smoothHeading);
}

function _drawFrame(heading) {
  const ctx = _ctx;
  const W = BAR_WIDTH;
  const H = BAR_HEIGHT;
  const totalH = H + 24;

  ctx.clearRect(0, 0, W, totalH);

  // ── Background strip — gradient fading to transparent at edges ──
  const bgGrad = ctx.createLinearGradient(0, 0, W, 0);
  bgGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
  bgGrad.addColorStop(0.15, 'rgba(255, 255, 255, 0.10)');
  bgGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.10)');
  bgGrad.addColorStop(0.85, 'rgba(255, 255, 255, 0.10)');
  bgGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // ── Clip to the bar area ──
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();

  // ── Draw ticks and labels ──
  const centerX = W / 2;
  const h = ((heading % 360) + 360) % 360;
  const fadeZone = W * 0.15; // edge fade zone matches background gradient

  for (let deg = 0; deg < 360; deg += 5) {
    let offset = deg - h;
    if (offset > 180) offset -= 360;
    if (offset < -180) offset += 360;

    const x = centerX + offset * PX_PER_DEG;
    if (x < -20 || x > W + 20) continue;

    // Edge fade multiplier — 0 at edge, 1 past fade zone
    const edgeDist = Math.min(x, W - x);
    const edgeFade = Math.min(1, Math.max(0, edgeDist / fadeZone));

    const isCardinal = CARDINALS[deg] !== undefined;
    const isPrimary = deg % 90 === 0;
    const isMajor = deg % 15 === 0;

    let tickH, tickW, tickOp;
    if (isPrimary) {
      tickH = H * 0.5; tickW = 2; tickOp = 0.9;
    } else if (isCardinal) {
      tickH = H * 0.4; tickW = 1.5; tickOp = 0.7;
    } else if (isMajor) {
      tickH = H * 0.3; tickW = 1; tickOp = 0.5;
    } else {
      tickH = H * 0.18; tickW = 0.7; tickOp = 0.15;
    }

    const isNorth = deg === 0;
    ctx.beginPath();
    ctx.moveTo(x, H);
    ctx.lineTo(x, H - tickH);
    ctx.strokeStyle = isNorth
      ? `rgba(255, 50, 50, ${(tickOp * edgeFade).toFixed(3)})`
      : `rgba(255, 255, 255, ${(tickOp * edgeFade).toFixed(3)})`;
    ctx.lineWidth = tickW;
    ctx.stroke();

    if (isCardinal || isMajor) {
      const text = CARDINALS[deg] || `${deg}`;
      const isN = deg === 0;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      if (isCardinal) {
        ctx.font = `bold ${isPrimary ? 13 : 10}px Futura PT, system-ui, sans-serif`;
        const baseOp = 0.9 * edgeFade;
        ctx.fillStyle = `rgba(255, 255, 255, ${baseOp.toFixed(3)})`;
      } else {
        ctx.font = '9px Futura PT, system-ui, sans-serif';
        ctx.fillStyle = `rgba(255, 255, 255, ${(0.5 * edgeFade).toFixed(3)})`;
      }
      ctx.fillText(text, x, 3);
    }
  }

  ctx.restore(); // unclip

  // ── Center needle indicator — white line extending slightly above and below bar ──
  ctx.beginPath();
  ctx.moveTo(centerX, -2);
  ctx.lineTo(centerX, H + 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // ── Triangle pointer below bar ──
  const triY = H + 2;
  ctx.beginPath();
  ctx.moveTo(centerX, triY);
  ctx.lineTo(centerX - 6, triY + 7);
  ctx.lineTo(centerX + 6, triY + 7);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fill();

  // ── Degree readout — clean text, no background ──
  const labelY = triY + 18;
  const degText = `${Math.round(((heading % 360) + 360) % 360)}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 13px Futura PT, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.fillText(degText, centerX, labelY);

}
