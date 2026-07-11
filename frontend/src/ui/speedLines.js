/**
 * Dynamic radial speed lines — lines spawn, streak outward, and fade.
 * Each line has its own lifetime creating constant motion.
 * Only visible edges/corners, not center — like tunnel vision.
 */

const POOL_SIZE = 80;
const MIN_SPEED = 32;    // lines start appearing here
const FULL_SPEED = 98;   // full intensity by ~98 km/h (top speed is 110) — recalibrated from 140 so the
                         // trimmed top end still streaks convincingly. See carPhysics GEAR_TOP_SPEEDS.

export function createSpeedLines() {
  const canvas = document.createElement('canvas');
  const W = 800;
  const H = 800;
  canvas.width = W;
  canvas.height = H;
  canvas.style.cssText = `
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    z-index: 5;
  `;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const cx = W / 2;
  const cy = H / 2;
  const maxR = Math.sqrt(cx * cx + cy * cy);

  // Line pool — each line has angle, life, speed, width
  const pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    pool.push({
      angle: 0,
      r: 0,         // current radius position
      len: 0,       // streak length
      life: 0,      // 0 = dead, ready to respawn
      maxLife: 0,
      width: 0,
      alpha: 0,
    });
  }

  let _intensity = 0;
  let _lastTime = performance.now();

  function _spawnLine(line) {
    // Bias angles toward corners (45°, 135°, 225°, 315°) for edge-only feel
    const corner = (Math.floor(Math.random() * 4) * 0.5 + 0.25) * Math.PI;
    const spread = 0.6; // how much to spread from corner
    line.angle = corner + (Math.random() - 0.5) * spread;

    line.r = 0.45 + Math.random() * 0.15; // start from outer half
    line.len = 0.08 + Math.random() * 0.12; // streak length (ratio of maxR)
    line.maxLife = 0.3 + Math.random() * 0.5; // 0.3–0.8 seconds
    line.life = line.maxLife;
    line.width = 0.8 + Math.random() * 2.0;
    line.alpha = 0.3 + Math.random() * 0.5;
  }

  function update(speedKmh) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - _lastTime) / 1000);
    _lastTime = now;

    const speed = Math.abs(speedKmh);
    _intensity = Math.max(0, Math.min(1, (speed - MIN_SPEED) / (FULL_SPEED - MIN_SPEED)));

    ctx.clearRect(0, 0, W, H);

    if (_intensity <= 0) return;

    // How many lines should be active
    const targetActive = Math.floor(_intensity * POOL_SIZE * 0.7);
    let activeCount = 0;

    // Speed of radial movement — faster at higher speed
    const moveSpeed = 0.4 + _intensity * 0.8;

    for (const line of pool) {
      if (line.life > 0) {
        // Animate: move outward
        line.r += moveSpeed * dt;
        line.life -= dt;

        // Fade based on life remaining
        const lifeFrac = line.life / line.maxLife;
        const fade = lifeFrac < 0.3 ? lifeFrac / 0.3 : lifeFrac > 0.7 ? (1 - lifeFrac) / 0.3 : 1;
        const a = line.alpha * fade * _intensity;

        if (a > 0.01 && line.r < 1.2) {
          const innerR = line.r * maxR;
          const outerR = (line.r + line.len * _intensity) * maxR;
          const cos = Math.cos(line.angle);
          const sin = Math.sin(line.angle);

          ctx.beginPath();
          ctx.moveTo(cx + cos * innerR, cy + sin * innerR);
          ctx.lineTo(cx + cos * outerR, cy + sin * outerR);
          ctx.strokeStyle = `rgba(255, 255, 255, ${a.toFixed(2)})`;
          ctx.lineWidth = line.width * _intensity;
          ctx.lineCap = 'round';
          ctx.stroke();
        }

        activeCount++;
      } else if (activeCount < targetActive) {
        // Respawn dead line
        _spawnLine(line);
        activeCount++;
      }
    }
  }

  function dispose() {
    canvas.remove();
  }

  return { update, dispose };
}
